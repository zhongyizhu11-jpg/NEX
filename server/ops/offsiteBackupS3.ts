/*
  S3 兼容存储（AWS S3 / MinIO / Cloudflare R2 / 阿里云 OSS 等），自己实现 AWS Signature V4。

  不引 SDK：只用到 PUT / GET / DELETE / ListObjectsV2 四个调用，签名算法本身几十行，
  SDK 却要拖进来几十个包。签名按 AWS 文档的规范请求（canonical request）写，单测里用 AWS
  官方文档的示例请求核对过签名值。

  默认路径风格（https://endpoint/bucket/key）：MinIO、R2、大部分自建兼容服务都要这种；
  阿里云 OSS 只认虚拟主机风格（https://bucket.endpoint/key），设置里可以切。
*/
import { createHash, createHmac } from "node:crypto";

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** true（默认）= 路径风格 */
  pathStyle: boolean;
};

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 编码：只留 A-Z a-z 0-9 - _ . ~，其余一律 %XX（大写）。 */
export function uriEncode(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export type SigV4Input = {
  method: string;
  /** 已按 S3 规则编码好的路径（每段 uriEncode，斜杠保留） */
  canonicalPath: string;
  query: Array<[string, string]>;
  /** 参与签名的请求头（名字大小写无所谓）；必须含 host 和 x-amz-date */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** YYYYMMDDTHHMMSSZ */
  amzDate: string;
};

export function signV4(input: SigV4Input) {
  const headerEntries = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase().trim(), String(value).trim().replace(/\s+/g, " ")] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = headerEntries.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = headerEntries.map(([name]) => name).join(";");
  const canonicalQuery = input.query
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalPath || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function amzDateOf(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function xmlDecode(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? xmlDecode(match[1]) : null;
}

/** ListObjectsV2 的响应：对象列表 + 是否还有下一页。 */
export function parseListObjectsV2(xml: string) {
  const objects: Array<{ key: string; size: number; lastModified: number | null }> = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const key = tag(match[1], "Key");
    if (!key) continue;
    const modified = Date.parse(tag(match[1], "LastModified") || "");
    objects.push({ key, size: Number(tag(match[1], "Size") || 0), lastModified: Number.isFinite(modified) ? modified : null });
  }
  return {
    objects,
    isTruncated: tag(xml, "IsTruncated") === "true",
    nextToken: tag(xml, "NextContinuationToken"),
  };
}

/** S3 出错时回的 <Error><Code>…</Code><Message>…</Message></Error>。 */
export function parseS3Error(xml: string): string {
  const code = tag(xml, "Code");
  const message = tag(xml, "Message");
  return [code, message].filter(Boolean).join("：");
}

export function normalizeS3Prefix(prefix: string): string {
  const trimmed = String(prefix || "").trim().replace(/^\/+/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/** 拼出请求地址与参与签名的路径。key 为空表示桶本身（列目录）。 */
export function s3RequestTarget(config: Pick<S3Config, "endpoint" | "bucket" | "pathStyle">, key: string) {
  const endpoint = new URL(config.endpoint);
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  const encodedKey = key ? uriEncode(key, true) : "";
  if (config.pathStyle) {
    const canonicalPath = `${basePath}/${uriEncode(config.bucket)}${key ? `/${encodedKey}` : "/"}`;
    return { host: endpoint.host, origin: `${endpoint.protocol}//${endpoint.host}`, canonicalPath };
  }
  const host = `${config.bucket}.${endpoint.host}`;
  return { host, origin: `${endpoint.protocol}//${host}`, canonicalPath: `${basePath}/${encodedKey}` };
}

export type S3Request = {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  key: string;
  query?: Array<[string, string]>;
  body?: Buffer;
  contentType?: string;
};

/** 签好名的 fetch 参数。真正发请求的地方在 offsiteBackupDestinations.ts（过 SSRF 检查、带超时）。 */
export function buildSignedS3Request(config: S3Config, request: S3Request, now = new Date()) {
  const target = s3RequestTarget(config, request.key);
  const payloadHash = sha256Hex(request.body || "");
  const amzDate = amzDateOf(now);
  const headers: Record<string, string> = {
    host: target.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (request.contentType) headers["content-type"] = request.contentType;
  const query = request.query || [];
  const signed = signV4({
    method: request.method,
    canonicalPath: target.canonicalPath,
    query,
    headers,
    payloadHash,
    region: config.region || "us-east-1",
    service: "s3",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    amzDate,
  });
  const queryString = query.map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`).join("&");
  const url = `${target.origin}${target.canonicalPath}${queryString ? `?${queryString}` : ""}`;
  const { host: _host, ...sendHeaders } = headers;
  const finalHeaders: Record<string, string> = { ...sendHeaders, authorization: signed.authorization };
  return { url, headers: finalHeaders };
}
