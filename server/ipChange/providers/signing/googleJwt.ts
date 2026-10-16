/*
  Google 服务账号 → OAuth2 JWT Bearer 断言（RS256）。

  参考：https://developers.google.com/identity/protocols/oauth2/service-account#httprest
  - Header：{"alg":"RS256","typ":"JWT"}（有 private_key_id 时带 kid）
  - Claim：iss = client_email，scope，aud = https://oauth2.googleapis.com/token，iat，exp = iat + 3600
  - 用 grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<JWT> POST 到 token 端点
*/
import { createPrivateKey, createSign } from "node:crypto";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export type GoogleServiceAccount = {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
  projectId?: string;
};

/** 解析服务账号 JSON 密钥；格式不对抛普通 Error（消息不含密钥内容）。 */
export function parseServiceAccountKey(json: string): GoogleServiceAccount {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("服务账号密钥不是合法的 JSON，请粘贴从控制台下载的完整 JSON 文件内容");
  }
  if (parsed?.type && parsed.type !== "service_account") throw new Error("密钥类型不是 service_account");
  const clientEmail = String(parsed?.client_email || "").trim();
  const privateKey = String(parsed?.private_key || "");
  if (!clientEmail || !/@/.test(clientEmail)) throw new Error("服务账号密钥缺少 client_email");
  if (!privateKey.includes("PRIVATE KEY")) throw new Error("服务账号密钥缺少 private_key");
  try {
    createPrivateKey(privateKey);
  } catch {
    throw new Error("服务账号密钥里的 private_key 无法解析");
  }
  return {
    clientEmail,
    privateKey,
    privateKeyId: parsed?.private_key_id ? String(parsed.private_key_id) : undefined,
    projectId: parsed?.project_id ? String(parsed.project_id) : undefined,
  };
}

function base64Url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function createJwtAssertion(account: GoogleServiceAccount, scope: string, now: Date, audience = GOOGLE_TOKEN_URL): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
  if (account.privateKeyId) header.kid = account.privateKeyId;
  const claims = { iss: account.clientEmail, scope, aud: audience, iat, exp: iat + 3600 };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(unsigned, "utf8").sign(account.privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}
