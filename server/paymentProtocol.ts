import crypto from "node:crypto";
import { importPaymentPublicKey } from "./paymentCrypto";

/*
  支付网关请求的几处协议细节（照上游 poouo/Forwardx 2.3.285 的 paymentProtocol 移植）。
*/

/** 网关请求的超时要一直管到响应体读完：网关回了头、正文卡住，也不能把下单请求挂死。 */
export async function fetchPaymentText(url: string, options: RequestInit = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** 支付宝要的 timestamp 是北京时间，跟面板所在服务器的时区无关（以前发的是 UTC，跨零点会被拒）。 */
export function alipayTimestamp(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * 易支付 mapi 返回的支付链接有的是以「/」开头的站内路径，要接上网关地址才能打开。
 * 二维码内容可能是 weixin:// 之类的 URI 或一段不透明的串，不是网址就原样保留。
 */
export function normalizePaymentLink(value: unknown, gateway: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const link = value.trim();
  return link.startsWith("/") ? new URL(link, `${gateway}/`).href : link;
}

/**
 * 从原始 JSON 文本里截出某个成员的原样字节。支付宝对响应签名签的是这段原文，
 * 不能先 JSON.parse 再序列化（空白、转义、键序一变签名就对不上）。重复的键直接拒绝。
 */
export function rawJsonMember(raw: string, member: string): string | undefined {
  JSON.parse(raw); // 先确认是完整合法的 JSON，再逐字扫描。
  let i = raw.search(/\S/);
  if (raw[i++] !== "{") throw new Error("Expected a JSON object");
  const seen = new Set<string>();
  let result: string | undefined;
  const skipSpace = () => { while (/\s/.test(raw[i] || "") && i < raw.length) i++; };
  const stringEnd = (start: number) => {
    let cursor = start + 1;
    while (cursor < raw.length) {
      if (raw[cursor] === "\\") cursor += 2;
      else if (raw[cursor++] === '"') return cursor;
    }
    throw new Error("Unterminated JSON string");
  };
  for (;;) {
    skipSpace();
    if (raw[i] === "}") break;
    const endKey = stringEnd(i);
    const key = JSON.parse(raw.slice(i, endKey)) as string;
    if (seen.has(key)) throw new Error("Duplicate JSON response member");
    seen.add(key);
    i = endKey;
    skipSpace();
    i++; // 冒号（上面已经整体校验过）
    skipSpace();
    const start = i;
    let depth = 0;
    for (; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"') { i = stringEnd(i) - 1; continue; }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
    }
    if (key === member) result = raw.slice(start, i).trimEnd();
    if (raw[i] === "}") break;
    i++; // 逗号
  }
  return result;
}

/** 校验支付宝网关响应的签名（xxx_response 那一段原文 + 同级的 sign）。 */
export function verifyAlipayResponse(raw: string, responseKey: string, publicKey: string) {
  const data = JSON.parse(raw);
  const content = rawJsonMember(raw, responseKey);
  return !!content && typeof data.sign === "string" && crypto.verify(
    "RSA-SHA256", Buffer.from(content), importPaymentPublicKey(publicKey, "alipay"), Buffer.from(data.sign, "base64"),
  );
}
