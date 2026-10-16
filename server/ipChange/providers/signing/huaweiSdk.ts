/*
  华为云 API 网关 AK/SK 签名（SDK-HMAC-SHA256），由 server/ddns.ts 的 huaweicloudRequest 参数化而来。

  参考：https://support.huaweicloud.com/devg-apisign/api-sign-algorithm-002.html （逐步示例）
        https://support.huaweicloud.com/devg-apisign/api-sign-algorithm-003.html
  要点：规范 URI 每段 RFC3986 编码、末尾必须补 "/"；查询参数按名字排序；签名头至少
  content-type;host;x-sdk-date；StringToSign 只有三行（算法、时间、规范请求哈希），没有 scope；
  签名 = HexEncode(HMAC-SHA256(SK, StringToSign))。文档示例的 SK 打了码，单测核对规范请求哈希。
*/
import { createHash, createHmac } from "node:crypto";

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function huaweiEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function huaweiCanonicalUri(path: string): string {
  const raw = path.startsWith("/") ? path : `/${path}`;
  const uri = raw
    .split("/")
    .map((part) => huaweiEncode(decodeURIComponent(part)))
    .join("/");
  return uri.endsWith("/") ? uri : `${uri}/`;
}

export function huaweiCanonicalQuery(query: Array<[string, string]>): string {
  return query
    .map(([key, value]) => [huaweiEncode(key), huaweiEncode(value)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export type HuaweiSignInput = {
  method: string;
  /** 未编码的路径，如 /v1/{project}/publicips */
  path: string;
  query: Array<[string, string]>;
  /** 参与签名的头：至少 host、x-sdk-date，有 body 时加 content-type */
  headers: Record<string, string>;
  body: string;
  accessKey: string;
  secretKey: string;
  /** YYYYMMDDTHHMMSSZ，与 X-Sdk-Date 头一致 */
  sdkDate: string;
};

export function huaweiSign(input: HuaweiSignInput) {
  const headerEntries = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase().trim(), String(value).trim()] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = headerEntries.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = headerEntries.map(([name]) => name).join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    huaweiCanonicalUri(input.path),
    huaweiCanonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body),
  ].join("\n");
  const stringToSign = ["SDK-HMAC-SHA256", input.sdkDate, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", input.secretKey).update(stringToSign, "utf8").digest("hex");
  return {
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
    authorization: `SDK-HMAC-SHA256 Access=${input.accessKey}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
