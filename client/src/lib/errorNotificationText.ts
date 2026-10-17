import { isPaymentCryptoError } from "@shared/paymentErrors";

/*
  报错通知的兜底改写（照上游 poouo/Forwardx client/src/i18n/messages.ts 的
  translateErrorNotificationText 移植）。

  服务端已经把支付下单的失败归了类（server/paymentFailureMessage.ts），但别的接口、旧版本面板
  或者浏览器自己的网络错误仍可能把「error:1E08010C:DECODER routines::unsupported」
  「fetch failed」「Failed to fetch」这种底层报错原样塞进通知。这里只认这几种完整的底层报错，
  换成一句人话；其它报错（含前端要解析的错误码、Agent / 插件的输出）一个字都不动。
*/

export const ERROR_NOTIFICATION_TEXT = {
  crypto: "密钥或证书无法解析，请检查格式或联系管理员查看日志。",
  network: "网络请求失败，请检查连接后重试。",
  internal: "操作失败，请稍后重试或联系管理员查看日志。",
} as const;

export function friendlyErrorNotificationText(message: string): string {
  const text = message.trim();
  if (isPaymentCryptoError(text)) return ERROR_NOTIFICATION_TEXT.crypto;
  if (/^(?:fetch failed|Failed to fetch|NetworkError when attempting to fetch resource\.|Load failed)$/.test(text)) {
    return ERROR_NOTIFICATION_TEXT.network;
  }
  if (/^(?:Unknown error|Internal server error|INTERNAL_SERVER_ERROR)$/i.test(text)) {
    return ERROR_NOTIFICATION_TEXT.internal;
  }
  return message;
}
