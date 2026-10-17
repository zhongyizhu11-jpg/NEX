import crypto, { type KeyObject } from "node:crypto";

/*
  支付宝 / 微信支付的 RSA 密钥导入（照上游 poouo/Forwardx 的 paymentCrypto 移植）。

  以前一律给没有头尾的密钥套上「PRIVATE KEY」（PKCS#8）头：支付宝后台导出的不带头的 PKCS#1
  私钥就解析失败，下单报一串 OpenSSL 错误；从环境变量 / JSON 里粘进来的「\n」转义也不认。
  现在：去掉转义、带头的按头解析，不带头的按 DER 分别试 PKCS#8 / PKCS#1（公钥试 SPKI / PKCS#1），
  只收 RSA；把私钥误填进公钥栏会被拒（OpenSSL 能从私钥里推出公钥，不拦就会存下私钥）。
  解析失败抛出给人看的说明，不把 OpenSSL 的原始错误码交给用户。
*/

export type PaymentSigningProvider = "alipay" | "wxpay";

export const PAYMENT_KEY_ERRORS = {
  alipayPrivateKey: "支付宝应用私钥无效，请填写 RSA 私钥（PKCS#1 或 PKCS#8），不要填写公钥或证书。",
  alipayPublicKey: "支付宝公钥无效，请填写 RSA 公钥，不要填写应用私钥。",
  wxpayPrivateKey: "微信支付商户私钥无效，请填写未加密的 RSA 私钥（PKCS#1 或 PKCS#8）。",
  wxpayPublicKey: "微信支付公钥或证书无效，请检查平台公钥或平台证书。",
} as const;

export class PaymentKeyConfigurationError extends Error {
  constructor(provider: PaymentSigningProvider, kind: "PrivateKey" | "PublicKey", cause?: unknown) {
    super(PAYMENT_KEY_ERRORS[`${provider}${kind}`], { cause });
    this.name = "PaymentKeyConfigurationError";
  }
}

function normalizeKey(value: string) {
  return String(value ?? "").replace(/\\r\\n|\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function decodeDer(value: string) {
  const base64 = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("Invalid key encoding");
  return Buffer.from(base64, "base64");
}

function requireRsa(key: KeyObject) {
  // RSA2 是 RSA/SHA-256：EC 或只能做 PSS 的 RSA 密钥都不行。
  if (key.asymmetricKeyType !== "rsa") throw new Error("An RSA key is required");
  return key;
}

export function importPaymentPrivateKey(value: string, provider: PaymentSigningProvider) {
  try {
    const key = normalizeKey(value);
    if (key.startsWith("-----")) {
      if (!/^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----\n[\s\S]+\n-----END \1-----$/.test(key)) {
        throw new Error("Expected one unencrypted private key");
      }
      return requireRsa(crypto.createPrivateKey(key));
    }
    const der = decodeDer(key);
    // 不带头的私钥可能是 PKCS#8 也可能是 PKCS#1：按 DER 分别试，不去猜 PEM 头。
    try { return requireRsa(crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" })); }
    catch { return requireRsa(crypto.createPrivateKey({ key: der, format: "der", type: "pkcs1" })); }
  } catch (cause) {
    throw new PaymentKeyConfigurationError(provider, "PrivateKey", cause);
  }
}

export function importPaymentPublicKey(value: string, provider: PaymentSigningProvider) {
  try {
    const key = normalizeKey(value);
    if (key.startsWith("-----")) {
      // createPublicKey 也收私钥：这里明确拒掉，免得把应用私钥当公钥存下来。
      if (!/^-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY|CERTIFICATE)-----\n[\s\S]+\n-----END \1-----$/.test(key)) {
        throw new Error("Expected one public key or certificate");
      }
      return requireRsa(crypto.createPublicKey(key));
    }
    const der = decodeDer(key);
    const readPublicDer = (type: "spki" | "pkcs1") => {
      const result = requireRsa(crypto.createPublicKey({ key: der, format: "der", type }));
      // OpenSSL 能从 DER 私钥推出公钥：要求原始数据本身就是公钥编码。
      if (!result.export({ format: "der", type }).equals(der)) throw new Error("Expected public-key DER");
      return result;
    };
    try { return readPublicDer("spki"); }
    catch { return readPublicDer("pkcs1"); }
  } catch (cause) {
    throw new PaymentKeyConfigurationError(provider, "PublicKey", cause);
  }
}
