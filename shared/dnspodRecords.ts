/**
 * DNSPod 解析记录管理（系统设置 → DNSPod 解析记录）的共用部分：记录草稿的校验、
 * 暂存变更的类型，以及「统一保存」之后哪些变更还要留着。
 *
 * 浏览器和服务端用同一份校验：浏览器在暂存时就把明显填错的拦下来，服务端照样再校验
 * 一遍 —— 浏览器那一份只是为了少走一趟服务商。
 */

import { expandIpv6 } from "./ipAddress";

/** 这一页能写的记录类型。别的类型（NS、MX、TXT……）只显示、不让改。 */
export const DNSPOD_WRITABLE_RECORD_TYPES = ["A", "AAAA", "CNAME"] as const;
export type DnspodWritableRecordType = (typeof DNSPOD_WRITABLE_RECORD_TYPES)[number];

export const DNSPOD_DEFAULT_RECORD_TTL = 600;
export const DNSPOD_MIN_RECORD_TTL = 1;
export const DNSPOD_MAX_RECORD_TTL = 604_800;
/** 一次统一保存最多带多少条变更：再多就分几次存，免得一次请求在服务商那边耗太久。 */
export const DNSPOD_MAX_CHANGES_PER_SAVE = 50;

export function isDnspodWritableRecordType(value: unknown): value is DnspodWritableRecordType {
  return (DNSPOD_WRITABLE_RECORD_TYPES as readonly string[]).includes(String(value || "").toUpperCase());
}

export type DnspodRecordDraft = {
  /** 主机记录：@ 表示主域名本身，其余是去掉主域名后的前缀，例如 www、a.b、*。 */
  subdomain: string;
  type: DnspodWritableRecordType;
  /** 线路 ID（DescribeRecordLineList 给的，例如 默认 = 0、电信 = 10=0）。 */
  lineId: string;
  /** 线路名称，只用来显示；服务端按 lineId 从线路列表里重新取名字。 */
  lineName?: string;
  value: string;
  ttl: number;
};

export type DnspodRecordChange =
  | { key: string; kind: "create"; record: DnspodRecordDraft }
  | { key: string; kind: "update"; recordId: string; revision: string; record: DnspodRecordDraft }
  | { key: string; kind: "delete"; recordId: string; revision: string };

/**
 * 一条变更保存的结果：
 * - done：服务商已经确认写入；
 * - failed：服务商明确拒绝了（或面板自己拦下了），没写进去；
 * - skipped：前面那条失败了，这条没有去试 —— 变更之间可能有先后关系（先删 CNAME 再加 A），
 *   前一条没成就接着写，后面的多半也会被服务商拒，还可能留下一半的状态。
 * failed 且 uncertain：请求发出去了但没拿到明确答复（超时、断线），服务商那边可能已经写了。
 */
export type DnspodRecordChangeResult = {
  key: string;
  status: "done" | "failed" | "skipped";
  error?: string;
  uncertain?: boolean;
};

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/**
 * 规整主机记录。返回 null 表示不合法。
 * 允许下划线（_acme-challenge、证书验证用的 CNAME 都带）和第一段写 *（泛解析）。
 */
export function normalizeDnspodSubdomain(value: unknown): string | null {
  const text = String(value ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (!text || text === "@") return "@";
  if (text.length > 253) return null;
  const labels = text.split(".");
  for (const [index, label] of labels.entries()) {
    if (index === 0 && label === "*") continue;
    if (!LABEL.test(label)) return null;
  }
  return text;
}

function isIpv4(value: string) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && (part === "0" || !part.startsWith("0")));
}

function isIpv6(value: string) {
  if (!value.includes(":") || /[[\]%\s]/.test(value)) return false;
  return expandIpv6(value) !== null;
}

/** CNAME 的目标：一个完整域名，去掉结尾的点、转小写。不合法返回 null。 */
export function normalizeDnspodCnameTarget(value: unknown): string | null {
  const text = String(value ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (!text || text.length > 253) return null;
  const labels = text.split(".");
  if (labels.length < 2) return null;
  return labels.every((label) => LABEL.test(label)) ? text : null;
}

/** 把草稿规整成要提交的样子；有错时返回中文原因。 */
export function validateDnspodRecordDraft(input: Partial<DnspodRecordDraft> | null | undefined):
  | { ok: true; record: DnspodRecordDraft }
  | { ok: false; error: string } {
  const subdomain = normalizeDnspodSubdomain(input?.subdomain);
  if (!subdomain) return { ok: false, error: "主机记录格式不正确：只能用字母、数字、短横线、下划线，泛解析写 *，主域名本身写 @" };
  const type = String(input?.type || "").toUpperCase();
  if (!isDnspodWritableRecordType(type)) return { ok: false, error: "这里只能管理 A、AAAA、CNAME 记录" };
  const lineId = String(input?.lineId ?? "").trim();
  if (!lineId || lineId.length > 64 || /[\u0000-\u001f\u007f]/.test(lineId)) return { ok: false, error: "请选择解析线路" };
  const rawValue = String(input?.value ?? "").trim();
  let value = rawValue;
  if (type === "A" && !isIpv4(rawValue)) return { ok: false, error: "A 记录的值要填 IPv4 地址" };
  if (type === "AAAA" && !isIpv6(rawValue)) return { ok: false, error: "AAAA 记录的值要填 IPv6 地址" };
  if (type === "CNAME") {
    const target = normalizeDnspodCnameTarget(rawValue);
    if (!target) return { ok: false, error: "CNAME 记录的值要填一个完整域名，例如 edge.example.net" };
    value = target;
  }
  const ttl = Math.floor(Number(input?.ttl ?? DNSPOD_DEFAULT_RECORD_TTL));
  if (!Number.isFinite(ttl) || ttl < DNSPOD_MIN_RECORD_TTL || ttl > DNSPOD_MAX_RECORD_TTL) {
    return { ok: false, error: `TTL 要在 ${DNSPOD_MIN_RECORD_TTL}-${DNSPOD_MAX_RECORD_TTL} 秒之间` };
  }
  const lineName = String(input?.lineName ?? "").trim().slice(0, 64) || undefined;
  return { ok: true, record: { subdomain, type, lineId, lineName, value, ttl } };
}

/** 主机记录 + 主域名 → 完整域名（@ 就是主域名本身）。 */
export function dnspodRecordFqdn(subdomain: string, domain: string) {
  const zone = String(domain || "").trim().toLowerCase().replace(/\.+$/, "");
  const name = String(subdomain || "").trim().toLowerCase();
  return !name || name === "@" ? zone : `${name}.${zone}`;
}

/**
 * 统一保存之后还要留在暂存区里的变更：没成功的（failed / skipped）原样留着，
 * 结果里没提到的（比如请求整个失败了）也留着；只有 done 的拿掉 —— 再点一次保存时
 * 不会把已经写进去的那几条又提交一遍。
 */
export function remainingDnspodChanges<T extends { key: string }>(
  staged: readonly T[],
  results: readonly DnspodRecordChangeResult[] | null | undefined,
): T[] {
  const done = new Set((results || []).filter((result) => result.status === "done").map((result) => result.key));
  return staged.filter((change) => !done.has(change.key));
}
