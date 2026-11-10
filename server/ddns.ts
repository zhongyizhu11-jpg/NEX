import crypto from "crypto";
import { domainToASCII } from "node:url";
import * as db from "./db";
import { withKeyedTaskLock } from "./keyedTaskLock";

export type DdnsProvider = "disabled" | "cloudflare" | "webhook" | "huaweicloud" | "aliyun" | "tencentcloud";

export interface DdnsSettings {
  provider: DdnsProvider;
  enabled: boolean;
  ttl: number;
  cloudflareZoneId: string;
  cloudflareApiToken: string;
  webhookUrl: string;
  webhookMethod: "POST" | "PUT" | "GET";
  webhookHeaders: string;
  huaweicloudAccessKeyId: string;
  huaweicloudSecretKey: string;
  huaweicloudRegion: string;
  huaweicloudEndpoint: string;
  huaweicloudZoneId: string;
  huaweicloudTtl: number;
  huaweicloudLine: string;
  aliyunAccessKeyId: string;
  aliyunAccessKeySecret: string;
  aliyunDomainName: string;
  aliyunEndpoint: string;
  aliyunTtl: number;
  aliyunLine: string;
  tencentcloudSecretId: string;
  tencentcloudSecretKey: string;
  tencentcloudDomainName: string;
  tencentcloudTtl: number;
  tencentcloudRecordLine: string;
  tencentcloudRecordLineId: string;
}

export type DdnsRecordInput = {
  domain: string;
  recordType: string;
  value: string;
  groupId: number;
  ttl?: number;
  lineId?: string;
  lineName?: string;
};

export type DdnsRecordValuesInput = Omit<DdnsRecordInput, "value"> & {
  values: string[];
};

/** 单次 DNS 服务商 API 请求最长等多久。 */
export const DDNS_REQUEST_TIMEOUT_MS = 15_000;

/**
 * 所有 DNS 服务商 API 请求都走这里：带超时。
 *
 * 原来的 fetch 一个都没设超时。DDNS 更新是在转发组故障切换的按组加锁里做的，
 * 服务商 API 半路卡住（TCP 建上了但一直不回），这把锁就一直不放：这个组之后的
 * 健康检查、切换、恢复全排在它后面，故障切换恰恰在最需要它的时候停摆。
 * 超时覆盖到读完响应体为止（signal 对 resp.json()/text() 同样生效）。
 */
export async function ddnsFetch(url: string, init: RequestInit = {}, timeoutMs = DDNS_REQUEST_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "TimeoutError") {
      let host = url;
      try { host = new URL(url).host; } catch { /* 保留原样 */ }
      throw new Error(`DDNS 请求超时（${Math.ceil(timeoutMs / 1000)} 秒无响应）：${host}`);
    }
    throw error;
  }
}

export function maskSecret(value: string | null | undefined) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.length <= 8) return `${v.slice(0, 2)}${"*".repeat(Math.max(4, v.length - 2))}`;
  return `${v.slice(0, 4)}${"*".repeat(Math.max(6, v.length - 8))}${v.slice(-4)}`;
}

function normalizeProvider(value: string): DdnsProvider {
  if (
    value === "cloudflare" ||
    value === "webhook" ||
    value === "huaweicloud" ||
    value === "aliyun" ||
    value === "tencentcloud"
  ) {
    return value;
  }
  return "disabled";
}

// 默认 TTL 60 秒：入口组 / 主机 DDNS 用 DNS 做故障切换，TTL 就是客户端看到切换
// 的最长延迟，原来的 600 秒意味着最多 10 分钟才生效。
export const DEFAULT_DDNS_TTL = 60;
export const MIN_DDNS_TTL = 60;
export const MAX_DDNS_TTL = 86400;

// 阿里云 / 腾讯云 DNSPod 免费版（以及部分个人版）的记录 TTL 下限是 600 秒，低于
// 下限会被 API 直接拒绝。套餐无法从配置里得知，所以先按设置的 TTL 提交，被以
// TTL 为由拒绝时再按这个下限重试，并记住该域名的下限，后续不再白白失败一次。
const PROVIDER_FREE_TIER_MIN_TTL: Partial<Record<DdnsProvider, number>> = {
  aliyun: 600,
  tencentcloud: 600,
};
const learnedProviderMinTtl = new Map<string, number>();

function parseTtl(value: unknown, fallback = DEFAULT_DDNS_TTL) {
  const ttl = Math.floor(Number(value || fallback));
  if (!Number.isFinite(ttl)) return fallback;
  return Math.min(MAX_DDNS_TTL, Math.max(MIN_DDNS_TTL, ttl));
}

/** 服务商明确答复了「不行」（带错误码）。没拿到答复的（超时、断线）不是这个类。 */
export class DdnsProviderError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "DdnsProviderError";
  }
}

function isTtlRejection(error: unknown) {
  if (!(error instanceof DdnsProviderError)) return false;
  return /ttl/i.test(`${error.code} ${error.message}`);
}

/**
 * 按 provider 的 TTL 下限提交记录：先用设置的 TTL（套餐允许就能 60 秒生效），
 * 被以 TTL 为由拒绝时抬到免费版下限重试，而不是让整次 DDNS 更新失败。
 * run 内的变更都使用同一个 TTL，第一次写入就会被拒，因此整体重跑是安全的。
 */
async function withProviderMinTtl<T>(
  provider: DdnsProvider,
  zone: string,
  ttl: number,
  run: (ttl: number) => Promise<T>,
): Promise<T> {
  const floor = PROVIDER_FREE_TIER_MIN_TTL[provider];
  const key = `${provider}:${normalizeDomain(zone)}`;
  const learned = learnedProviderMinTtl.get(key);
  const effective = learned ? Math.max(ttl, learned) : ttl;
  try {
    return await run(effective);
  } catch (error) {
    if (!floor || effective >= floor || !isTtlRejection(error)) throw error;
    learnedProviderMinTtl.set(key, floor);
    return run(floor);
  }
}

export function resetDdnsProviderMinTtlCacheForTests() {
  learnedProviderMinTtl.clear();
}

export async function getDdnsSettings(): Promise<DdnsSettings> {
  const all = await db.getAllSettings();
  const method = String(all.ddnsWebhookMethod || "POST").toUpperCase();
  const ttl = parseTtl(
    all.ddnsTtl,
    parseTtl(all.ddnsHuaweiCloudTtl || all.ddnsAliyunTtl || all.ddnsTencentCloudTtl, DEFAULT_DDNS_TTL),
  );
  return {
    provider: normalizeProvider(String(all.ddnsProvider || "disabled")),
    enabled: all.ddnsEnabled === "true",
    ttl,
    cloudflareZoneId: String(all.ddnsCloudflareZoneId || ""),
    cloudflareApiToken: String(all.ddnsCloudflareApiToken || ""),
    webhookUrl: String(all.ddnsWebhookUrl || ""),
    webhookMethod: method === "PUT" || method === "GET" ? method : "POST",
    webhookHeaders: String(all.ddnsWebhookHeaders || ""),
    huaweicloudAccessKeyId: String(all.ddnsHuaweiCloudAccessKeyId || ""),
    huaweicloudSecretKey: String(all.ddnsHuaweiCloudSecretKey || ""),
    huaweicloudRegion: String(all.ddnsHuaweiCloudRegion || "cn-north-4"),
    huaweicloudEndpoint: String(all.ddnsHuaweiCloudEndpoint || ""),
    huaweicloudZoneId: String(all.ddnsHuaweiCloudZoneId || ""),
    huaweicloudTtl: ttl,
    huaweicloudLine: String(all.ddnsHuaweiCloudLine || "default_view"),
    aliyunAccessKeyId: String(all.ddnsAliyunAccessKeyId || ""),
    aliyunAccessKeySecret: String(all.ddnsAliyunAccessKeySecret || ""),
    aliyunDomainName: String(all.ddnsAliyunDomainName || ""),
    aliyunEndpoint: String(all.ddnsAliyunEndpoint || "https://alidns.aliyuncs.com"),
    aliyunTtl: ttl,
    aliyunLine: String(all.ddnsAliyunLine || "default"),
    tencentcloudSecretId: String(all.ddnsTencentCloudSecretId || ""),
    tencentcloudSecretKey: String(all.ddnsTencentCloudSecretKey || ""),
    tencentcloudDomainName: String(all.ddnsTencentCloudDomainName || ""),
    tencentcloudTtl: ttl,
    tencentcloudRecordLine: String(all.ddnsTencentCloudRecordLine || "默认"),
    tencentcloudRecordLineId: String(all.ddnsTencentCloudRecordLineId || ""),
  };
}

function parseHeaders(raw: string) {
  const out: Record<string, string> = {};
  const value = raw.trim();
  if (!value) return out;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      for (const [key, val] of Object.entries(parsed)) {
        if (key && val != null) out[key] = String(val);
      }
    }
  } catch {
    for (const line of value.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return out;
}

function normalizeDomain(value: string) {
  return String(value || "").trim().replace(/\.+$/, "").toLowerCase();
}

function normalizeDnsName(value: string) {
  const normalized = normalizeDomain(value);
  return domainToASCII(normalized) || normalized;
}

function cloudflareZoneCandidates(domain: string) {
  const labels = normalizeDnsName(domain).split(".").filter(Boolean);
  const candidates: string[] = [];
  for (let index = 0; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join(".");
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

function fqdn(value: string) {
  const normalized = normalizeDomain(value);
  return normalized ? `${normalized}.` : "";
}

function splitDnsName(fullDomain: string, rootDomain: string, providerLabel: string) {
  const full = normalizeDomain(fullDomain);
  const root = normalizeDomain(rootDomain);
  if (!root) throw new Error(`${providerLabel} DDNS 主域名未配置`);
  if (full === root) return { root, rr: "@", subDomain: "@" };
  const suffix = `.${root}`;
  if (!full.endsWith(suffix)) {
    throw new Error(`${providerLabel} DDNS 域名 ${fullDomain} 不在主域名 ${rootDomain} 下`);
  }
  const rr = full.slice(0, -suffix.length);
  return { root, rr, subDomain: rr };
}

function normalizeEndpoint(value: string, fallback: string) {
  const raw = String(value || fallback || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: crypto.BinaryLike | crypto.KeyObject, value: string, encoding?: crypto.BinaryToTextEncoding) {
  const digest = crypto.createHmac("sha256", key).update(value, "utf8").digest();
  return encoding ? digest.toString(encoding) : digest;
}

function encodeRfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function compareByteOrder(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalQuery(params: Record<string, string | number | undefined>) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([a], [b]) => compareByteOrder(a, b))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(String(value))}`)
    .join("&");
}

function canonicalUri(path: string) {
  const raw = String(path || "/").startsWith("/") ? String(path || "/") : `/${path}`;
  const uri = raw
    .split("/")
    .map((part) => encodeRfc3986(part))
    .join("/");
  return uri.endsWith("/") ? uri : `${uri}/`;
}

function extractJsonError(body: any, fallback: string) {
  return (
    body?.message ||
    body?.Message ||
    body?.error_msg ||
    body?.Error?.Message ||
    body?.Response?.Error?.Message ||
    body?.errors?.[0]?.message ||
    fallback
  );
}

async function readJsonBody(resp: Response) {
  const text = await resp.text().catch(() => "");
  let body: any = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  return body;
}

async function readJson(resp: Response, fallback: string) {
  const body = await readJsonBody(resp);
  if (!resp.ok) {
    throw new Error(extractJsonError(body, `${fallback} ${resp.status}`));
  }
  return body;
}

async function resolveCloudflareZoneId(input: {
  zoneId?: string;
  apiToken: string;
  domain: string;
}) {
  const configuredZoneId = String(input.zoneId || "").trim();
  if (configuredZoneId) return configuredZoneId;

  const headers = {
    Authorization: `Bearer ${input.apiToken}`,
    "Content-Type": "application/json",
  };
  const candidates = cloudflareZoneCandidates(input.domain);
  for (const candidate of candidates) {
    const query = new URLSearchParams({ name: candidate, status: "active", per_page: "50" });
    const resp = await ddnsFetch(`https://api.cloudflare.com/client/v4/zones?${query.toString()}`, { headers });
    const body = await readJson(resp, "Cloudflare 查询 Zone 失败");
    if (body?.success === false) {
      throw new Error(extractJsonError(body, "Cloudflare 查询 Zone 失败"));
    }
    const zones = Array.isArray(body?.result) ? body.result : [];
    const zone = zones.find((item: any) => normalizeDnsName(String(item?.name || "")) === candidate) || zones[0];
    if (zone?.id) return String(zone.id);
  }

  throw new Error("Cloudflare 未找到匹配的 Zone；请确认 API Token 有 Zone:Read + DNS:Edit 权限，或手动填写 Zone ID");
}

async function updateCloudflare(input: {
  zoneId?: string;
  apiToken: string;
  domain: string;
  recordType: string;
  value: string;
  ttl?: number;
}) {
  const headers = {
    Authorization: `Bearer ${input.apiToken}`,
    "Content-Type": "application/json",
  };
  const zoneId = await resolveCloudflareZoneId(input);
  const base = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records`;
  const recordName = normalizeDnsName(input.domain);
  const query = new URLSearchParams({ type: input.recordType, name: recordName, per_page: "50" });
  const findResp = await ddnsFetch(`${base}?${query.toString()}`, { headers });
  const findBody = await readJson(findResp, "Cloudflare 查询记录失败");
  if (findBody?.success === false) {
    throw new Error(extractJsonError(findBody, "Cloudflare 查询记录失败"));
  }
  const records = Array.isArray(findBody?.result) ? findBody.result : [];
  const record = records.find((item: any) => (
    normalizeDnsName(String(item?.name || "")) === recordName &&
    String(item?.type || "").toUpperCase() === input.recordType
  )) || records[0] || null;
  const payload: Record<string, unknown> = {
    type: input.recordType,
    name: recordName,
    content: input.value,
    ttl: parseTtl(input.ttl, DEFAULT_DDNS_TTL),
    proxied: !!record?.proxied,
  };
  if (typeof record?.comment === "string" && record.comment) payload.comment = record.comment;
  const resp = await ddnsFetch(record?.id ? `${base}/${encodeURIComponent(String(record.id))}` : base, {
    method: record?.id ? "PUT" : "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = await readJson(resp, "Cloudflare 更新记录失败");
  if (body?.success === false) {
    throw new Error(extractJsonError(body, "Cloudflare 更新记录失败"));
  }
}

function applyTemplate(input: string, vars: Record<string, string>) {
  let out = input;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

async function updateWebhook(input: {
  url: string;
  method: "POST" | "PUT" | "GET";
  headers: string;
  domain: string;
  recordType: string;
  value: string;
  groupId: number;
  ttl?: number;
  lineId?: string;
  lineName?: string;
}) {
  const ttl = parseTtl(input.ttl, DEFAULT_DDNS_TTL);
  const vars = {
    domain: input.domain,
    type: input.recordType,
    value: input.value,
    groupId: String(input.groupId),
    ttl: String(ttl),
    lineId: input.lineId || "",
    lineName: input.lineName || "",
  };
  const url = applyTemplate(input.url, vars);
  const headers = parseHeaders(input.headers);
  const body = JSON.stringify({
    domain: input.domain,
    recordType: input.recordType,
    value: input.value,
    groupId: input.groupId,
    ttl,
    lineId: input.lineId || undefined,
    lineName: input.lineName || undefined,
  });
  const resp = await ddnsFetch(url, {
    method: input.method,
    headers: input.method === "GET" ? headers : { "Content-Type": "application/json", ...headers },
    body: input.method === "GET" ? undefined : body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `Webhook 更新失败 ${resp.status}`);
  }
}

function huaweicloudEndpoint(settings: DdnsSettings) {
  return normalizeEndpoint(settings.huaweicloudEndpoint, "https://dns.myhuaweicloud.com");
}

function huaweicloudDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function huaweicloudRequest(settings: DdnsSettings, method: string, path: string, query: Record<string, string | number | undefined>, payload?: any) {
  const endpoint = huaweicloudEndpoint(settings);
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const queryString = canonicalQuery(query);
  const sdkDate = huaweicloudDate();
  const signedHeaders = "x-sdk-date";
  const canonicalHeaders = `x-sdk-date:${sdkDate}\n`;
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(path),
    queryString,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join("\n");
  const stringToSign = ["SDK-HMAC-SHA256", sdkDate, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(settings.huaweicloudSecretKey, stringToSign, "hex");
  const authorization = `SDK-HMAC-SHA256 Access=${settings.huaweicloudAccessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const resp = await ddnsFetch(`${endpoint}${path}${queryString ? `?${queryString}` : ""}`, {
    method,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      "X-Sdk-Date": sdkDate,
    },
    body: method.toUpperCase() === "GET" ? undefined : body,
  });
  return readJson(resp, "华为云 DNS 请求失败");
}

function ensureHuaweiCloudCredentials(settings: DdnsSettings) {
  if (!settings.huaweicloudAccessKeyId || !settings.huaweicloudSecretKey) {
    throw new Error("华为云 DDNS 配置不完整");
  }
}

function huaweiCloudLineMatches(record: any, line: string) {
  if (!line) return true;
  const recordLine = String(record?.line || record?.line_id || record?.lineId || "").trim();
  return !recordLine || recordLine === line;
}

async function resolveHuaweiCloudZoneId(settings: DdnsSettings, domain: string) {
  const configuredZoneId = String(settings.huaweicloudZoneId || "").trim();
  if (configuredZoneId) return configuredZoneId;
  const candidates = cloudflareZoneCandidates(domain);
  for (const candidate of candidates) {
    const body = await huaweicloudRequest(settings, "GET", "/v2/zones", { name: fqdn(candidate), limit: 100 });
    const zones = Array.isArray(body?.zones) ? body.zones : [];
    const exact = zones.find((zone: any) => String(zone?.name || "").toLowerCase() === fqdn(candidate).toLowerCase());
    const zone = exact || zones[0];
    if (zone?.id) return String(zone.id);
  }
  throw new Error(`华为云未找到域名 ${domain} 对应的公网 Zone，请确认域名已托管或手动填写 Zone ID`);
}

async function findHuaweiCloudRecord(settings: DdnsSettings, input: { domain: string; recordType: string; lineId?: string }) {
  const name = fqdn(input.domain);
  const line = String(input.lineId || settings.huaweicloudLine || "default_view").trim();
  const query: Record<string, string | number | undefined> = {
    name,
    type: input.recordType,
    limit: 100,
    search_mode: "equal",
  };
  if (line) query.line_id = line;
  if (settings.huaweicloudZoneId.trim()) query.zone_id = settings.huaweicloudZoneId.trim();
  const list = await huaweicloudRequest(settings, "GET", "/v2.1/recordsets", query);
  const recordsets = Array.isArray(list?.recordsets) ? list.recordsets : [];
  return recordsets.find((item: any) => (
    String(item?.name || "").toLowerCase() === name.toLowerCase() &&
    String(item?.type || "").toUpperCase() === input.recordType &&
    huaweiCloudLineMatches(item, line)
  )) || null;
}

function huaweiCloudCreatePayload(input: { name: string; recordType: string; ttl: number; records: string[]; line: string }) {
  return {
    name: input.name,
    type: input.recordType,
    ttl: input.ttl,
    records: input.records,
    ...(input.line ? { line: input.line } : {}),
  };
}

async function updateHuaweiCloud(settings: DdnsSettings, input: DdnsRecordInput) {
  ensureHuaweiCloudCredentials(settings);
  const name = fqdn(input.domain);
  const recordType = (input.recordType || "A").toUpperCase();
  const line = (input.lineId || settings.huaweicloudLine || "default_view").trim();
  const ttl = parseTtl(input.ttl, settings.huaweicloudTtl);
  const record = await findHuaweiCloudRecord(settings, { domain: input.domain, recordType, lineId: line });
  const resolvedZoneId = String(record?.zone_id || record?.zoneId || await resolveHuaweiCloudZoneId(settings, input.domain));
  const zoneId = encodeURIComponent(resolvedZoneId);
  const basePath = `/v2.1/zones/${zoneId}/recordsets`;
  const payload = {
    name,
    type: recordType,
    ttl,
    records: [input.value],
  };
  if (record?.id) {
    await huaweicloudRequest(settings, "PUT", `${basePath}/${encodeURIComponent(String(record.id))}`, {}, payload);
    return;
  }
  await huaweicloudRequest(settings, "POST", basePath, {}, huaweiCloudCreatePayload({ name, recordType, ttl, records: [input.value], line }));
}

function aliyunEncode(value: string) {
  return encodeURIComponent(value)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~")
    .replace(/[!'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function aliyunRequest(settings: DdnsSettings, action: string, params: Record<string, string | number | undefined>) {
  const endpoint = normalizeEndpoint(settings.aliyunEndpoint, "https://alidns.aliyuncs.com");
  const common: Record<string, string | number> = {
    Action: action,
    Version: "2015-01-09",
    Format: "JSON",
    AccessKeyId: settings.aliyunAccessKeyId,
    SignatureMethod: "HMAC-SHA1",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    SignatureVersion: "1.0",
    SignatureNonce: crypto.randomUUID(),
  };
  const all: Record<string, string | number> = { ...common };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") all[key] = value;
  }
  const canonical = Object.entries(all)
    .sort(([a], [b]) => compareByteOrder(a, b))
    .map(([key, value]) => `${aliyunEncode(key)}=${aliyunEncode(String(value))}`)
    .join("&");
  const stringToSign = `GET&${aliyunEncode("/")}&${aliyunEncode(canonical)}`;
  const signature = crypto
    .createHmac("sha1", `${settings.aliyunAccessKeySecret}&`)
    .update(stringToSign, "utf8")
    .digest("base64");
  const resp = await ddnsFetch(`${endpoint}/?Signature=${aliyunEncode(signature)}&${canonical}`);
  // 阿里云出错时返回 4xx + {Code, Message}，先按 Code 抛出，保留错误码给 TTL 下限判断。
  const body = await readJsonBody(resp);
  if (body?.Code) throw new DdnsProviderError(body?.Message || `阿里云 DNS 请求失败: ${body.Code}`, String(body.Code));
  if (!resp.ok) throw new Error(extractJsonError(body, `阿里云 DNS 请求失败 ${resp.status}`));
  return body;
}

async function updateAliyun(settings: DdnsSettings, input: DdnsRecordInput) {
  if (!settings.aliyunAccessKeyId || !settings.aliyunAccessKeySecret || !settings.aliyunDomainName) {
    throw new Error("阿里云 DDNS 配置不完整");
  }
  const { root, rr } = splitDnsName(input.domain, settings.aliyunDomainName, "阿里云");
  const domain = normalizeDomain(input.domain);
  const recordType = (input.recordType || "A").toUpperCase();
  const line = (input.lineId || settings.aliyunLine || "default").trim();
  const ttl = parseTtl(input.ttl, settings.aliyunTtl);
  const list = await aliyunRequest(settings, "DescribeSubDomainRecords", {
    DomainName: root,
    SubDomain: domain,
    Type: recordType,
    Line: line,
    PageNumber: 1,
    PageSize: 100,
  });
  const records = list?.DomainRecords?.Record;
  const candidates = Array.isArray(records) ? records : records ? [records] : [];
  const record = candidates.find((item: any) => (
    String(item?.RR || "") === rr &&
    String(item?.Type || "").toUpperCase() === recordType &&
    (!line || String(item?.Line || "") === line)
  ));
  await withProviderMinTtl("aliyun", root, ttl, async (effectiveTtl) => {
    const payload = {
      RR: rr,
      Type: recordType,
      Value: input.value,
      Line: line,
      TTL: effectiveTtl,
    };
    if (record?.RecordId) {
      await aliyunRequest(settings, "UpdateDomainRecord", { RecordId: String(record.RecordId), ...payload });
      return;
    }
    await aliyunRequest(settings, "AddDomainRecord", { DomainName: root, ...payload });
  });
}

function tencentDate(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

/** 腾讯云 API 3.0（TC3-HMAC-SHA256）签名后调一次 DNSPod。DNSPod 解析记录管理（server/dnspodRecords.ts）也走这里。 */
export async function tencentCloudRequest(settings: DdnsSettings, action: string, payload: Record<string, any>) {
  const host = "dnspod.tencentcloudapi.com";
  const service = "dnspod";
  const version = "2021-03-23";
  const algorithm = "TC3-HMAC-SHA256";
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const hashedRequestPayload = sha256Hex(body);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload,
  ].join("\n");
  const date = tencentDate(timestamp);
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    algorithm,
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const secretDate = hmac(`TC3${settings.tencentcloudSecretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign, "hex");
  const authorization = `${algorithm} Credential=${settings.tencentcloudSecretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const resp = await ddnsFetch(`https://${host}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": version,
      "X-TC-Language": "zh-CN",
    },
    body,
  });
  const result = await readJson(resp, "腾讯云 DNSPod 请求失败");
  if (result?.Response?.Error) {
    const error = result.Response.Error;
    throw new DdnsProviderError(error.Message || `腾讯云 DNSPod 请求失败: ${error.Code}`, String(error.Code || ""));
  }
  return result?.Response || {};
}

async function updateTencentCloud(settings: DdnsSettings, input: DdnsRecordInput) {
  if (!settings.tencentcloudSecretId || !settings.tencentcloudSecretKey || !settings.tencentcloudDomainName) {
    throw new Error("腾讯云 DNSPod DDNS 配置不完整");
  }
  const { root, subDomain } = splitDnsName(input.domain, settings.tencentcloudDomainName, "腾讯云 DNSPod");
  const recordType = (input.recordType || "A").toUpperCase();
  const recordLine = (input.lineName || settings.tencentcloudRecordLine || "默认").trim();
  const recordLineId = (input.lineId || settings.tencentcloudRecordLineId || "").trim();
  const ttl = parseTtl(input.ttl, settings.tencentcloudTtl);
  const listPayload: Record<string, any> = {
    Domain: root,
    Subdomain: subDomain,
    RecordType: recordType,
    RecordLine: recordLine,
    Limit: 3000,
    ErrorOnEmpty: "no",
  };
  if (recordLineId) listPayload.RecordLineId = recordLineId;
  const list = await tencentCloudRequest(settings, "DescribeRecordList", listPayload);
  const records = Array.isArray(list?.RecordList) ? list.RecordList : [];
  const record = records.find((item: any) => (
    String(item?.Name || "") === subDomain &&
    String(item?.Type || "").toUpperCase() === recordType &&
    (recordLineId ? String(item?.LineId || "") === recordLineId : String(item?.Line || "") === recordLine)
  ));
  await withProviderMinTtl("tencentcloud", root, ttl, async (effectiveTtl) => {
    const payload: Record<string, any> = {
      Domain: root,
      SubDomain: subDomain,
      RecordType: recordType,
      RecordLine: recordLine,
      Value: input.value,
      TTL: effectiveTtl,
    };
    if (recordLineId) payload.RecordLineId = recordLineId;
    if (record?.RecordId) {
      await tencentCloudRequest(settings, "ModifyRecord", { ...payload, RecordId: Number(record.RecordId) });
      return;
    }
    await tencentCloudRequest(settings, "CreateRecord", payload);
  });
}

function uniqueDdnsValues(values: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function planDdnsValueChanges<T>(records: T[], desiredValues: string[], valueOf: (record: T) => unknown) {
  const desired = uniqueDdnsValues(desiredValues);
  const desiredSet = new Set(desired);
  const covered = new Set<string>();
  const reusable: T[] = [];

  for (const record of records) {
    const value = String(valueOf(record) || "").trim();
    if (desiredSet.has(value) && !covered.has(value)) {
      covered.add(value);
    } else {
      reusable.push(record);
    }
  }

  const missing = desired.filter((value) => !covered.has(value));
  const updates: Array<{ record: T; value: string }> = [];
  while (missing.length > 0 && reusable.length > 0) {
    updates.push({ record: reusable.shift()!, value: missing.shift()! });
  }
  return {
    updates,
    creates: missing,
    removals: reusable,
  };
}

function ddnsRecordLockKey(settings: DdnsSettings, input: Pick<DdnsRecordInput, "domain" | "recordType">) {
  return [
    "ddns-record",
    settings.provider,
    normalizeDnsName(input.domain),
    String(input.recordType || "A").trim().toUpperCase(),
  ].join(":");
}

async function updateCloudflareValues(input: {
  zoneId?: string;
  apiToken: string;
  domain: string;
  recordType: string;
  values: string[];
  ttl?: number;
}) {
  const headers = {
    Authorization: "Bearer " + input.apiToken,
    "Content-Type": "application/json",
  };
  const zoneId = await resolveCloudflareZoneId(input);
  const base = "https://api.cloudflare.com/client/v4/zones/" + encodeURIComponent(zoneId) + "/dns_records";
  const recordName = normalizeDnsName(input.domain);
  const recordType = input.recordType.toUpperCase();
  const query = new URLSearchParams({ type: recordType, name: recordName, per_page: "100" });
  const findResp = await ddnsFetch(base + "?" + query.toString(), { headers });
  const findBody = await readJson(findResp, "Cloudflare 查询记录失败");
  if (findBody?.success === false) throw new Error(extractJsonError(findBody, "Cloudflare 查询记录失败"));

  const records = (Array.isArray(findBody?.result) ? findBody.result : []).filter((item: any) => (
    normalizeDnsName(String(item?.name || "")) === recordName &&
    String(item?.type || "").toUpperCase() === recordType
  ));
  const desired = uniqueDdnsValues(input.values);
  const managedRecords = records.filter((record: any) => String(record?.id || ""));
  const template = managedRecords[0] || records[0] || null;
  const plan = planDdnsValueChanges(managedRecords, desired, (record: any) => record?.content);
  const payloadFor = (value: string, record: any = template) => {
    const payload: Record<string, unknown> = {
      type: recordType,
      name: recordName,
      content: value,
      ttl: parseTtl(input.ttl, DEFAULT_DDNS_TTL),
      proxied: !!record?.proxied,
    };
    if (typeof record?.comment === "string" && record.comment) payload.comment = record.comment;
    return payload;
  };

  for (const change of plan.updates) {
    const id = String((change.record as any)?.id || "");
    const resp = await ddnsFetch(base + "/" + encodeURIComponent(id), {
      method: "PUT",
      headers,
      body: JSON.stringify(payloadFor(change.value, change.record)),
    });
    const body = await readJson(resp, "Cloudflare 更新记录失败");
    if (body?.success === false) throw new Error(extractJsonError(body, "Cloudflare 更新记录失败"));
  }

  for (const value of plan.creates) {
    const payload = payloadFor(value);
    const resp = await ddnsFetch(base, { method: "POST", headers, body: JSON.stringify(payload) });
    const body = await readJson(resp, "Cloudflare 创建记录失败");
    if (body?.success === false) throw new Error(extractJsonError(body, "Cloudflare 创建记录失败"));
  }

  for (const record of plan.removals) {
    const id = String((record as any)?.id || "");
    const resp = await ddnsFetch(base + "/" + encodeURIComponent(id), { method: "DELETE", headers });
    const body = await readJson(resp, "Cloudflare 删除记录失败");
    if (body?.success === false) throw new Error(extractJsonError(body, "Cloudflare 删除记录失败"));
  }
}

async function updateWebhookValues(settings: DdnsSettings, input: DdnsRecordValuesInput, values: string[]) {
  if (!settings.webhookUrl) throw new Error("Webhook DDNS 地址未配置");
  const value = values.join(",");
  const ttl = parseTtl(input.ttl, settings.ttl);
  const vars = {
    action: values.length > 0 ? "replace" : "delete",
    domain: input.domain,
    type: input.recordType,
    value,
    values: value,
    groupId: String(input.groupId),
    ttl: String(ttl),
    lineId: input.lineId || "",
    lineName: input.lineName || "",
  };
  const url = applyTemplate(settings.webhookUrl, vars);
  const headers = parseHeaders(settings.webhookHeaders);
  const body = JSON.stringify({
    action: values.length > 0 ? "replace" : "delete",
    domain: input.domain,
    recordType: input.recordType,
    value,
    values,
    groupId: input.groupId,
    ttl,
    lineId: input.lineId || undefined,
    lineName: input.lineName || undefined,
  });
  const resp = await ddnsFetch(url, {
    method: settings.webhookMethod,
    headers: settings.webhookMethod === "GET" ? headers : { "Content-Type": "application/json", ...headers },
    body: settings.webhookMethod === "GET" ? undefined : body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `Webhook 更新失败 ${resp.status}`);
  }
}

async function updateHuaweiCloudValues(settings: DdnsSettings, input: DdnsRecordValuesInput, values: string[]) {
  ensureHuaweiCloudCredentials(settings);
  const name = fqdn(input.domain);
  const recordType = (input.recordType || "A").toUpperCase();
  const line = (input.lineId || settings.huaweicloudLine || "default_view").trim();
  const ttl = parseTtl(input.ttl, settings.huaweicloudTtl);
  const record = await findHuaweiCloudRecord(settings, { domain: input.domain, recordType, lineId: line });
  const resolvedZoneId = String(record?.zone_id || record?.zoneId || await resolveHuaweiCloudZoneId(settings, input.domain));
  const zoneId = encodeURIComponent(resolvedZoneId);
  const basePath = `/v2.1/zones/${zoneId}/recordsets`;
  if (values.length === 0) {
    if (record?.id) {
      await huaweicloudRequest(settings, "DELETE", `${basePath}/${encodeURIComponent(String(record.id))}`, {});
    }
    return;
  }
  const payload = { name, type: recordType, ttl, records: values };
  if (record?.id) {
    await huaweicloudRequest(settings, "PUT", `${basePath}/${encodeURIComponent(String(record.id))}`, {}, payload);
    return;
  }
  await huaweicloudRequest(settings, "POST", basePath, {}, huaweiCloudCreatePayload({ name, recordType, ttl, records: values, line }));
}

async function updateAliyunValues(settings: DdnsSettings, input: DdnsRecordValuesInput, values: string[]) {
  if (!settings.aliyunAccessKeyId || !settings.aliyunAccessKeySecret || !settings.aliyunDomainName) {
    throw new Error("阿里云 DDNS 配置不完整");
  }
  const { root, rr } = splitDnsName(input.domain, settings.aliyunDomainName, "阿里云");
  const domain = normalizeDomain(input.domain);
  const recordType = (input.recordType || "A").toUpperCase();
  const line = (input.lineId || settings.aliyunLine || "default").trim();
  const ttl = parseTtl(input.ttl, settings.aliyunTtl);
  const list = await aliyunRequest(settings, "DescribeSubDomainRecords", {
    DomainName: root,
    SubDomain: domain,
    Type: recordType,
    Line: line,
    PageNumber: 1,
    PageSize: 100,
  });
  const records = list?.DomainRecords?.Record;
  const candidates = (Array.isArray(records) ? records : records ? [records] : []).filter((item: any) => (
    String(item?.RR || "") === rr &&
    String(item?.Type || "").toUpperCase() === recordType &&
    (!line || String(item?.Line || "") === line)
  ));
  const managedRecords = candidates.filter((record: any) => String(record?.RecordId || ""));
  const plan = planDdnsValueChanges(managedRecords, values, (record: any) => record?.Value);
  await withProviderMinTtl("aliyun", root, ttl, async (effectiveTtl) => {
    const payloadFor = (value: string) => ({ RR: rr, Type: recordType, Value: value, Line: line, TTL: effectiveTtl });
    for (const change of plan.updates) {
      await aliyunRequest(settings, "UpdateDomainRecord", {
        RecordId: String((change.record as any).RecordId),
        ...payloadFor(change.value),
      });
    }
    for (const value of plan.creates) {
      await aliyunRequest(settings, "AddDomainRecord", { DomainName: root, ...payloadFor(value) });
    }
  });
  for (const record of plan.removals) {
    await aliyunRequest(settings, "DeleteDomainRecord", { RecordId: String((record as any).RecordId) });
  }
}

async function updateTencentCloudValues(settings: DdnsSettings, input: DdnsRecordValuesInput, values: string[]) {
  if (!settings.tencentcloudSecretId || !settings.tencentcloudSecretKey || !settings.tencentcloudDomainName) {
    throw new Error("腾讯云 DNSPod DDNS 配置不完整");
  }
  const { root, subDomain } = splitDnsName(input.domain, settings.tencentcloudDomainName, "腾讯云 DNSPod");
  const recordType = (input.recordType || "A").toUpperCase();
  const recordLine = (input.lineName || settings.tencentcloudRecordLine || "默认").trim();
  const recordLineId = (input.lineId || settings.tencentcloudRecordLineId || "").trim();
  const ttl = parseTtl(input.ttl, settings.tencentcloudTtl);
  const listPayload: Record<string, any> = {
    Domain: root,
    Subdomain: subDomain,
    RecordType: recordType,
    RecordLine: recordLine,
    Limit: 3000,
    ErrorOnEmpty: "no",
  };
  if (recordLineId) listPayload.RecordLineId = recordLineId;
  const list = await tencentCloudRequest(settings, "DescribeRecordList", listPayload);
  const candidates = (Array.isArray(list?.RecordList) ? list.RecordList : []).filter((item: any) => (
    String(item?.Name || "") === subDomain &&
    String(item?.Type || "").toUpperCase() === recordType &&
    (recordLineId ? String(item?.LineId || "") === recordLineId : String(item?.Line || "") === recordLine)
  ));
  const managedRecords = candidates.filter((record: any) => String(record?.RecordId || ""));
  const plan = planDdnsValueChanges(managedRecords, values, (record: any) => record?.Value);
  await withProviderMinTtl("tencentcloud", root, ttl, async (effectiveTtl) => {
    const payloadFor = (value: string) => {
      const payload: Record<string, any> = {
        Domain: root,
        SubDomain: subDomain,
        RecordType: recordType,
        RecordLine: recordLine,
        Value: value,
        TTL: effectiveTtl,
      };
      if (recordLineId) payload.RecordLineId = recordLineId;
      return payload;
    };
    for (const change of plan.updates) {
      await tencentCloudRequest(settings, "ModifyRecord", {
        ...payloadFor(change.value),
        RecordId: Number((change.record as any).RecordId),
      });
    }
    for (const value of plan.creates) {
      await tencentCloudRequest(settings, "CreateRecord", payloadFor(value));
    }
  });
  for (const record of plan.removals) {
    await tencentCloudRequest(settings, "DeleteRecord", {
      Domain: root,
      RecordId: Number((record as any).RecordId),
    });
  }
}

export async function updateDdnsRecordValues(input: DdnsRecordValuesInput) {
  const settings = await getDdnsSettings();
  if (!settings.enabled || settings.provider === "disabled") {
    throw new Error("DDNS 未启用");
  }
  const normalizedInput = {
    ...input,
    domain: input.domain.trim(),
    recordType: (input.recordType || "A").trim().toUpperCase(),
    lineId: input.lineId?.trim() || undefined,
    lineName: input.lineName?.trim() || undefined,
  };
  if (!normalizedInput.domain) throw new Error("入口组未配置 DDNS 域名");
  const values = uniqueDdnsValues(input.values);
  if (normalizedInput.recordType === "CNAME" && values.length > 1) throw new Error("CNAME 记录只能指向一个值");

  return withKeyedTaskLock(ddnsRecordLockKey(settings, normalizedInput), async () => {
    if (settings.provider === "cloudflare") {
      if (!settings.cloudflareApiToken) throw new Error("Cloudflare DDNS 未配置 API Token");
      await updateCloudflareValues({
        zoneId: settings.cloudflareZoneId,
        apiToken: settings.cloudflareApiToken,
        domain: normalizedInput.domain,
        recordType: normalizedInput.recordType,
        values,
        ttl: normalizedInput.ttl ?? settings.ttl,
      });
      return;
    }

    if (settings.provider === "webhook") {
      await updateWebhookValues(settings, { ...normalizedInput, ttl: normalizedInput.ttl ?? settings.ttl }, values);
      return;
    }

    if (settings.provider === "huaweicloud") {
      await updateHuaweiCloudValues(settings, normalizedInput, values);
      return;
    }

    if (settings.provider === "aliyun") {
      await updateAliyunValues(settings, normalizedInput, values);
      return;
    }

    if (settings.provider === "tencentcloud") {
      await updateTencentCloudValues(settings, normalizedInput, values);
    }
  });
}
export async function updateDdnsRecord(input: DdnsRecordInput) {
  const settings = await getDdnsSettings();
  if (!settings.enabled || settings.provider === "disabled") {
    throw new Error("DDNS 未启用");
  }
  if (!input.domain.trim()) throw new Error("转发组未配置域名");
  if (!input.value.trim()) throw new Error("没有可用入口地址");

  const normalizedInput = {
    ...input,
    domain: input.domain.trim(),
    recordType: (input.recordType || "A").trim().toUpperCase(),
    value: input.value.trim(),
    lineId: input.lineId?.trim() || undefined,
    lineName: input.lineName?.trim() || undefined,
  };

  return withKeyedTaskLock(ddnsRecordLockKey(settings, normalizedInput), async () => {
    if (settings.provider === "cloudflare") {
      if (!settings.cloudflareApiToken) {
        throw new Error("Cloudflare DDNS 未配置 API Token");
      }
      await updateCloudflare({
        zoneId: settings.cloudflareZoneId,
        apiToken: settings.cloudflareApiToken,
        domain: normalizedInput.domain,
        recordType: normalizedInput.recordType,
        value: normalizedInput.value,
        ttl: normalizedInput.ttl ?? settings.ttl,
      });
      return;
    }

    if (settings.provider === "webhook") {
      if (!settings.webhookUrl) throw new Error("Webhook DDNS 地址未配置");
      await updateWebhook({
        url: settings.webhookUrl,
        method: settings.webhookMethod,
        headers: settings.webhookHeaders,
        domain: normalizedInput.domain,
        recordType: normalizedInput.recordType,
        value: normalizedInput.value,
        groupId: normalizedInput.groupId,
        ttl: normalizedInput.ttl ?? settings.ttl,
        lineId: normalizedInput.lineId,
        lineName: normalizedInput.lineName,
      });
      return;
    }

    if (settings.provider === "huaweicloud") {
      await updateHuaweiCloud(settings, normalizedInput);
      return;
    }

    if (settings.provider === "aliyun") {
      await updateAliyun(settings, normalizedInput);
      return;
    }

    if (settings.provider === "tencentcloud") {
      await updateTencentCloud(settings, normalizedInput);
    }
  });
}

/**
 * DDNS 服务商管着的主域名（落地池「自动」起直连域名用，2.3.501）：阿里云、腾讯云设置里就有；Cloudflare、华为云
 * 按 Zone ID 去问（没填 Zone ID 时，账号下只有一个域名就用它）；Webhook 不知道主域名。拿不到时 reason 说为什么。
 */
export async function ddnsRootDomain(): Promise<{ root: string | null; reason: string | null }> {
  const settings = await getDdnsSettings();
  if (!settings.enabled || settings.provider === "disabled") {
    return { root: null, reason: "先到 系统设置 → DDNS 配好并启用 DNS 服务商" };
  }
  const done = (value: unknown) => {
    const root = normalizeDomain(String(value || ""));
    return root ? { root, reason: null } : { root: null, reason: "DDNS 设置里没有主域名：填一个完整域名" };
  };
  try {
    switch (settings.provider) {
      case "aliyun":
        return done(settings.aliyunDomainName);
      case "tencentcloud":
        return done(settings.tencentcloudDomainName);
      case "cloudflare": {
        if (!settings.cloudflareApiToken) return { root: null, reason: "Cloudflare 的 API Token 没填" };
        const headers = { Authorization: `Bearer ${settings.cloudflareApiToken}`, "Content-Type": "application/json" };
        const zoneId = settings.cloudflareZoneId.trim();
        if (zoneId) {
          const body = await readJson(await ddnsFetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}`, { headers }), "Cloudflare 查询 Zone 失败");
          return done(body?.result?.name);
        }
        const body = await readJson(await ddnsFetch("https://api.cloudflare.com/client/v4/zones?status=active&per_page=50", { headers }), "Cloudflare 查询 Zone 失败");
        const zones = Array.isArray(body?.result) ? body.result : [];
        if (zones.length === 1) return done(zones[0]?.name);
        return { root: null, reason: zones.length === 0 ? "Cloudflare 账号下没有能用的域名" : "Cloudflare 账号下有好几个域名：在 DDNS 设置里填 Zone ID，或者填一个完整域名" };
      }
      case "huaweicloud": {
        ensureHuaweiCloudCredentials(settings);
        const zoneId = settings.huaweicloudZoneId.trim();
        if (zoneId) return done(String((await huaweicloudRequest(settings, "GET", `/v2/zones/${zoneId}`, {}))?.name || ""));
        const body = await huaweicloudRequest(settings, "GET", "/v2/zones", { limit: 100 });
        const zones = Array.isArray(body?.zones) ? body.zones : [];
        if (zones.length === 1) return done(zones[0]?.name);
        return { root: null, reason: zones.length === 0 ? "华为云账号下没有能用的域名" : "华为云账号下有好几个域名：在 DDNS 设置里填 Zone ID，或者填一个完整域名" };
      }
      default:
        return { root: null, reason: "Webhook 方式不知道主域名：填一个完整域名" };
    }
  } catch (error) {
    return { root: null, reason: error instanceof Error ? error.message : String(error) };
  }
}
