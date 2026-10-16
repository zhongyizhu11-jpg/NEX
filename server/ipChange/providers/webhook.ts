/*
  自定义 Webhook：把换 IP 交给用户自己的脚本 / 服务。

  请求：POST <url>，Content-Type: application/json，超时 120 秒。
  - 换 IP：{"action":"change_ip","target":{…},"releaseOldIp":true,"requestedAt":"ISO 时间"}
    期望响应 2xx + {"newIp":"1.2.3.4","oldIp"?:"…","ipRole"?:"primary"|"entry","releasedOldIp"?:bool,"notes"?:string[]}
  - 查 IP：{"action":"get_ip","target":{…}}，期望 {"ip":"1.2.3.4"}（没有公网 IP 时 ip 为 null）
  设置了密钥时带 X-Forwardx-Signature: sha256=<HMAC-SHA256(密钥, 原始请求体) 的十六进制>，
  接收方用同一个密钥对收到的原始 body 计算并做常量时间比较即可验签。
  自定义请求头：每行一个「Name: value」。
*/
import { createHmac } from "node:crypto";

import { assertIp, defineProvider, httpRequest, httpStatusError, invalidInput, ipOrNull, readField, requireField, truncate } from "./common";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";

const LABEL = "Webhook";
const TIMEOUT_MS = 120_000;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADERS = new Set(["content-length", "host", "x-forwardx-signature", "transfer-encoding", "connection"]);

export function webhookSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = String(text || "").split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const colon = line.indexOf(":");
    if (colon <= 0) throw invalidInput(`自定义请求头第 ${index + 1} 行格式不对，应为「Name: value」`);
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!TOKEN.test(name)) throw invalidInput(`自定义请求头第 ${index + 1} 行的名字不合法`);
    if (RESERVED_HEADERS.has(name.toLowerCase())) throw invalidInput(`自定义请求头不能设置 ${name}`);
    if (/[\r\n\0]/.test(value)) throw invalidInput(`自定义请求头第 ${index + 1} 行的值含非法字符`);
    out[name] = value;
  });
  return out;
}

type Config = { url: string; secret: string; headers: Record<string, string> };

function readConfig(credentials: IpChangeCredentials): Config {
  const raw = requireField(credentials, "url", "Webhook 地址");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidInput("「Webhook 地址」不是合法的 URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalidInput("「Webhook 地址」只支持 http / https");
  return { url: url.href, secret: readField(credentials, "secret"), headers: parseHeaderLines(credentials.headers || "") };
}

async function post(ctx: IpChangeContext, config: Config, payload: Record<string, unknown>, mutating: boolean) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { ...config.headers, "Content-Type": "application/json" };
  if (config.secret) headers["X-Forwardx-Signature"] = webhookSignature(config.secret, body);
  const resp = await httpRequest(ctx, { label: `${LABEL} ${payload.action}`, method: "POST", url: config.url, headers, body, timeoutMs: TIMEOUT_MS, mutating });
  if (resp.status < 200 || resp.status >= 300) {
    const detail = String(resp.json?.error || resp.json?.message || "") || truncate(resp.text, 200);
    throw httpStatusError(`${LABEL} ${payload.action}`, resp.status, detail, { mutating });
  }
  if (!resp.json || typeof resp.json !== "object") {
    throw new IpChangeProviderError(`${LABEL}：响应不是 JSON 对象（${truncate(resp.text, 120) || "空响应"}）`, { retryable: false, ambiguous: mutating });
  }
  return resp.json;
}

function targetPayload(target: IpChangeTarget): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(target || {})) if (value !== undefined && value !== null) out[key] = String(value);
  return out;
}

async function getIp(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext) {
  const json = await post(ctx, readConfig(credentials), { action: "get_ip", target: targetPayload(target) }, false);
  if (json.ip === null || json.ip === undefined || json.ip === "") return null;
  return assertIp(json.ip, `${LABEL} get_ip `);
}

export const webhookProvider = defineProvider({
  id: "webhook",
  label: "自定义 Webhook",
  docsHint:
    "填一个能接收 POST JSON 的地址：action=change_ip 时换 IP 并返回 {newIp, oldIp?, ipRole?}，action=get_ip 时返回 {ip}；设置密钥后请求带 X-Forwardx-Signature: sha256=HMAC-SHA256(密钥, 原始请求体)。",
  credentialFields: [
    { key: "url", label: "Webhook 地址", type: "text", required: true, placeholder: "https://example.com/hooks/change-ip" },
    { key: "secret", label: "签名密钥", type: "password", help: "留空则不签名" },
    { key: "headers", label: "自定义请求头", type: "textarea", placeholder: "Authorization: Bearer xxx", help: "每行一个「Name: value」" },
  ],
  targetFields: [{ key: "instanceId", label: "实例标识", type: "text", help: "原样放进请求的 target 里，供你的脚本区分主机" }],
  requiresDowntime: false,

  async testCredentials(credentials, target, ctx) {
    return { currentIp: await getIp(credentials, target, ctx) };
  },

  async getCurrentIp(credentials, target, ctx) {
    return getIp(credentials, target, ctx);
  },

  async changeIp(credentials, target, ctx, options) {
    const config = readConfig(credentials);
    const json = await post(
      ctx,
      config,
      { action: "change_ip", target: targetPayload(target), releaseOldIp: options.releaseOldIp, requestedAt: ctx.now().toISOString() },
      true,
    );
    const newIp = assertIp(json.newIp, `${LABEL} change_ip `);
    const ipRole = json.ipRole === "entry" ? "entry" : "primary";
    if (json.ipRole !== undefined && json.ipRole !== "entry" && json.ipRole !== "primary") {
      throw new IpChangeProviderError(`${LABEL}：ipRole 只能是 primary 或 entry`, { retryable: false, ambiguous: true });
    }
    const notes = Array.isArray(json.notes) ? json.notes.filter((item: unknown) => typeof item === "string").map((item: string) => truncate(item, 500)) : [];
    return { oldIp: ipOrNull(json.oldIp), newIp, ipRole, releasedOldIp: json.releasedOldIp === true, notes };
  },
});
