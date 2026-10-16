/*
  AWS Signature Version 4 及其同构变体（火山引擎 OpenAPI 签名）。

  两者的规范请求（CanonicalRequest）、StringToSign 结构完全一致，差别只有三处：
  - 算法名：AWS4-HMAC-SHA256 / HMAC-SHA256
  - 派生密钥的前缀：kDate = HMAC("AWS4" + secret, date) / HMAC(secret, date)
  - scope 结尾：aws4_request / request

  参考：
  - https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
  - AWS SigV4 测试套件（get-vanilla / post-x-www-form-urlencoded 等）
  - https://www.volcengine.com/docs/6369/67269 （火山引擎「签名方法」，含逐步示例与期望值）
*/
import { createHash, createHmac } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986：只保留 A-Z a-z 0-9 - _ . ~，其余按 UTF-8 字节 %XX（大写）。 */
export function rfc3986(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function canonicalQueryString(query: Array<[string, string]>): string {
  return query
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export type HmacV4Flavor = {
  algorithm: string;
  secretPrefix: string;
  terminator: string;
};

export const AWS_SIGV4: HmacV4Flavor = { algorithm: "AWS4-HMAC-SHA256", secretPrefix: "AWS4", terminator: "aws4_request" };
export const VOLCENGINE_V4: HmacV4Flavor = { algorithm: "HMAC-SHA256", secretPrefix: "", terminator: "request" };

export type HmacV4Input = {
  method: string;
  /** 已编码好的路径，默认 "/" */
  canonicalUri?: string;
  query: Array<[string, string]>;
  /** 参与签名的请求头（名字大小写不限）；必须包含 host 和日期头 */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** YYYYMMDDTHHMMSSZ */
  requestDate: string;
};

export function signHmacV4(flavor: HmacV4Flavor, input: HmacV4Input) {
  const headerEntries = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase().trim(), String(value).trim().replace(/\s+/g, " ")] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = headerEntries.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = headerEntries.map(([name]) => name).join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalUri || "/",
    canonicalQueryString(input.query),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const dateStamp = input.requestDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/${flavor.terminator}`;
  const stringToSign = [flavor.algorithm, input.requestDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`${flavor.secretPrefix}${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, flavor.terminator);
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
    signingKeyHex: kSigning.toString("hex"),
    authorization: `${flavor.algorithm} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Date → YYYYMMDDTHHMMSSZ */
export function compactIsoDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}
