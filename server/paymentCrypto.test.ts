import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { importPaymentPrivateKey, importPaymentPublicKey, PaymentKeyConfigurationError } from "./paymentCrypto";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const body = (pem: string) => pem.split("\n").filter((line) => line && !line.startsWith("-----")).join("");
const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
const pkcs1 = privateKey.export({ format: "pem", type: "pkcs1" }) as string;
const spki = publicKey.export({ format: "pem", type: "spki" }) as string;
const pubPkcs1 = publicKey.export({ format: "pem", type: "pkcs1" }) as string;

function signsAndVerifies(priv: crypto.KeyObject, pub: crypto.KeyObject) {
  const signature = crypto.sign("RSA-SHA256", Buffer.from("hello"), priv);
  return crypto.verify("RSA-SHA256", Buffer.from("hello"), pub, signature);
}

test("私钥：带头 / 不带头的 PKCS#8 和 PKCS#1、粘进来的 \\n 转义都认", () => {
  const pub = importPaymentPublicKey(spki, "alipay");
  for (const value of [pkcs8, pkcs1, body(pkcs8), body(pkcs1), pkcs1.replace(/\n/g, "\\n")]) {
    assert.ok(signsAndVerifies(importPaymentPrivateKey(value, "alipay"), pub));
  }
});

test("公钥：SPKI / PKCS#1、带头不带头都认；把私钥填进公钥栏会被拒", () => {
  const priv = importPaymentPrivateKey(pkcs8, "wxpay");
  for (const value of [spki, pubPkcs1, body(spki), body(pubPkcs1)]) {
    assert.ok(signsAndVerifies(priv, importPaymentPublicKey(value, "wxpay")));
  }
  for (const wrong of [pkcs8, body(pkcs8), body(pkcs1)]) {
    assert.throws(() => importPaymentPublicKey(wrong, "alipay"), (error: unknown) => error instanceof PaymentKeyConfigurationError && /不要填写应用私钥/.test((error as Error).message));
  }
});

test("非 RSA、乱码给出说明，不把 OpenSSL 错误码交给用户", () => {
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  assert.throws(() => importPaymentPrivateKey(ec.privateKey.export({ format: "pem", type: "pkcs8" }) as string, "wxpay"), /微信支付商户私钥无效/);
  assert.throws(() => importPaymentPrivateKey("not a key", "alipay"), /支付宝应用私钥无效/);
  assert.throws(() => importPaymentPublicKey(spki, "alipay") && importPaymentPrivateKey(spki, "alipay"), /支付宝应用私钥无效/);
});
