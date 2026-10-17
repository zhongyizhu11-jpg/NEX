import { PAYMENT_ERRORS, isPaymentCryptoError } from "../shared/paymentErrors";

/*
  下单失败 → 顾客看到的那句话（照上游 poouo/Forwardx server/paymentCrypto.ts 的
  paymentOrderFailureMessage 移植）。

  网关报错原文可能是一页 HTML、带密钥片段的 Stripe 报错、OpenSSL 错误码或「fetch failed」，
  都不能交给顾客：这里只归成「密钥 / 配置 / 超时 / 网络 / 暂不可用」几类。原文由调用方写进
  面板日志（[Payment] order create failed …），管理员照样能查。

  支付密钥解析失败（PaymentKeyConfigurationError，见 server/paymentCrypto.ts）按名字认，
  它的 message 本来就是写给人看的说明；即便如此也只放行 PAYMENT_ERRORS 里的固定文案。
*/

const SAFE_MESSAGES = new Set<string>(Object.values(PAYMENT_ERRORS));

type FailureLike = {
  message?: unknown;
  code?: unknown;
  name?: unknown;
  cause?: { code?: unknown; name?: unknown } | null;
} | null | undefined;

export function paymentOrderFailureMessage(error: unknown): string {
  const failure = (error && typeof error === "object" ? error : null) as FailureLike;
  const message = String(failure?.message || "");
  const name = String(failure?.name || "");
  const code = String(failure?.code || failure?.cause?.code || "");
  if (name === "PaymentKeyConfigurationError") {
    return SAFE_MESSAGES.has(message) ? message : PAYMENT_ERRORS.keyConfiguration;
  }
  if (isPaymentCryptoError(message) || isPaymentCryptoError(code)) return PAYMENT_ERRORS.keyConfiguration;
  if (/配置不完整|密钥必须为/.test(message)) return PAYMENT_ERRORS.configuration;
  const causeName = String(failure?.cause?.name || "");
  if (name === "TimeoutError" || name === "AbortError" || causeName === "TimeoutError"
    || message === "GM Pay 请求超时"
    || /^(?:ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(code)) {
    return PAYMENT_ERRORS.timeout;
  }
  if (/^(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET)$/.test(code)
    || message === "fetch failed") {
    return PAYMENT_ERRORS.network;
  }
  return PAYMENT_ERRORS.unavailable;
}
