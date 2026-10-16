/*
  阿里云 RPC 风格 API 签名（SignatureVersion 1.0，HMAC-SHA1），由 server/ddns.ts 的 aliyunRequest 参数化而来。

  参考：https://help.aliyun.com/zh/sdk/product-overview/rpc-mechanism
  文档给了固定参数示例（testid / testsecret / DescribeDedicatedHosts / 2023-03-13T08:34:30Z），
  期望签名 9NaGiOspFP5UPcwX8Iwt2YJXXuk=，单测逐字复现。
*/
import { createHmac } from "node:crypto";

/** 阿里云 percentEncode：RFC 3986，空格 %20，* → %2A，~ 不编码。 */
export function aliyunPercentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~")
    .replace(/[!'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export type AliyunRpcSignInput = {
  method: "GET" | "POST";
  /** 全部参数（公共参数 + 业务参数），不含 Signature */
  params: Record<string, string>;
  accessKeySecret: string;
};

export function aliyunRpcSign(input: AliyunRpcSignInput) {
  const canonicalizedQueryString = Object.entries(input.params)
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${aliyunPercentEncode(key)}=${aliyunPercentEncode(String(value))}`)
    .join("&");
  const stringToSign = `${input.method}&${aliyunPercentEncode("/")}&${aliyunPercentEncode(canonicalizedQueryString)}`;
  const signature = createHmac("sha1", `${input.accessKeySecret}&`).update(stringToSign, "utf8").digest("base64");
  return {
    canonicalizedQueryString,
    stringToSign,
    signature,
    /** 完整查询串（含 Signature） */
    query: `Signature=${aliyunPercentEncode(signature)}&${canonicalizedQueryString}`,
  };
}

/** 阿里云要求的 ISO8601 UTC 时间：YYYY-MM-DDThh:mm:ssZ */
export function aliyunTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
