/*
  腾讯云 API 3.0 签名 v3（TC3-HMAC-SHA256），由 server/ddns.ts 的 tencentCloudRequest 参数化而来。

  参考：https://cloud.tencent.com/document/api/213/30654
        https://www.tencentcloud.com/document/api/213/33224
  文档示例：cvm DescribeInstances，时间戳 1551113065，content-type "application/json; charset=utf-8"，
  SignedHeaders=content-type;host。文档里的 SecretKey 打了码，所以单测只能核对规范请求哈希与
  payload 哈希；最后一步 HMAC 链与 SigV4 同构（TC3 + key → date → service → tc3_request）。
*/
import { createHash, createHmac } from "node:crypto";

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export type Tc3Input = {
  secretId: string;
  secretKey: string;
  service: string;
  host: string;
  action: string;
  payload: string;
  /** Unix 秒 */
  timestamp: number;
  contentType?: string;
  /** 是否把 x-tc-action 也纳入签名（推荐；文档示例未纳入） */
  signAction?: boolean;
};

export function tc3Sign(input: Tc3Input) {
  const algorithm = "TC3-HMAC-SHA256";
  const contentType = input.contentType ?? "application/json; charset=utf-8";
  const headers: Array<[string, string]> = [
    ["content-type", contentType],
    ["host", input.host],
  ];
  if (input.signAction !== false) headers.push(["x-tc-action", input.action.toLowerCase()]);
  const canonicalHeaders = headers.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = headers.map(([name]) => name).join(";");
  const hashedPayload = sha256Hex(input.payload);
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, hashedPayload].join("\n");
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const credentialScope = `${date}/${input.service}/tc3_request`;
  const stringToSign = [algorithm, String(input.timestamp), credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const secretDate = hmac(`TC3${input.secretKey}`, date);
  const secretService = hmac(secretDate, input.service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning).update(stringToSign, "utf8").digest("hex");
  return {
    hashedPayload,
    canonicalRequest,
    stringToSign,
    signature,
    contentType,
    authorization: `${algorithm} Credential=${input.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
