import crypto from "node:crypto";
import { appendPanelLog } from "./_core/panelLogger";
import { DdnsProviderError, getDdnsSettings, tencentCloudRequest } from "./ddns";
import { dnsManagedOwnersOf, loadDnsManagedIndex, normalizeManagedDnsName, type DnsManagedIndex, type DnsManagedOwner } from "./dnsManagedNames";
import { withKeyedTaskLock } from "./keyedTaskLock";
import {
  DNSPOD_MAX_CHANGES_PER_SAVE,
  dnspodRecordFqdn,
  isDnspodWritableRecordType,
  validateDnspodRecordDraft,
  type DnspodRecordChange,
  type DnspodRecordChangeResult,
  type DnspodRecordDraft,
} from "@shared/dnspodRecords";

/*
  DNSPod 解析记录管理（系统设置 → DNSPod 解析记录）。

  凭据就是 DDNS 服务商里填的腾讯云 SecretId / SecretKey，签名和带超时的请求也直接用
  server/ddns.ts 的 tencentCloudRequest —— 不另起一套凭据和签名：两边各存一份，改了一边
  另一边还在用旧密钥，排查起来只会更乱。

  读的原则：列表要么完整、要么报错。
  - DNSPod 分页给 TotalCount，每一页都核对：总数中途变了、同一个 RecordId 出现两次、
    没到总数就给了半页，都说明翻页期间记录在变 —— 整份丢掉重读，读几次还对不上就报错；
  - 只有服务商明确说「0 条」（TotalCount = 0，或 NoDataOfRecord）才是空；字段缺失、
    类型不对一律报「返回格式异常」，绝不把认不出来的响应当成空列表 —— 空列表在页面上
    看起来就是「这个域名下什么都没有」，管理员可能据此去重建一遍。
  - 页数有上限（maxPages），超过就报错说记录太多，而不是悄悄只给前几页。

  写的原则：
  - 面板自己维护的名字（server/dnsManagedNames.ts）一律拒绝，判断用的是服务商那边记录
    此刻的名字（DescribeRecord），不信浏览器传来的名字；
  - 改、删之前核对记录的版本（revision）：别处（DNSPod 控制台、DDNS）改过就拒绝，免得
    拿旧值覆盖新值；
  - 统一保存按顺序一条一条写，一条失败后面的都不再试（标 skipped），浏览器只把 done 的
    从暂存区拿掉，再点保存不会重复提交已经成功的。

  日志只记动作和错误码，不记记录值、不记凭据，也不原样记服务商的错误文案（里面可能带记录值）。
*/

export type DnspodTransport = (action: string, payload: Record<string, unknown>) => Promise<unknown>;

export type DnspodRecordsErrorCode =
  | "NOT_CONFIGURED"
  | "INVALID_INPUT"
  | "INVALID_RESPONSE"
  | "TOO_MANY"
  | "PROVIDER"
  | "UNAVAILABLE"
  | "MANAGED"
  | "UNSUPPORTED_TYPE"
  | "CHANGED"
  | "NOT_FOUND";

export class DnspodRecordsError extends Error {
  constructor(
    message: string,
    readonly code: DnspodRecordsErrorCode,
    /** 写请求发出去了却没拿到明确答复：服务商那边可能已经生效。 */
    readonly uncertain = false,
    /** 服务商的错误码（只在 PROVIDER 时有）。 */
    readonly providerCode = "",
  ) {
    super(message);
    this.name = "DnspodRecordsError";
  }
}

export type DnspodDomain = {
  id: string;
  name: string;
  grade: string;
  status: string | null;
  recordCount: number | null;
};

export type DnspodRecordLine = { id: string; name: string };

export type DnspodRecord = {
  id: string;
  /** 主机记录（@ / www / a.b / *）。 */
  subdomain: string;
  fqdn: string;
  type: string;
  line: string;
  lineId: string;
  value: string;
  ttl: number;
  status: "ENABLE" | "DISABLE" | null;
  weight: number | null;
  remark: string;
  /** 改、删时原样带回来，服务端据此判断记录有没有在别处被改过。 */
  revision: string;
  /** 面板里谁在管这个名字；空 = 不归面板管。 */
  managedBy: string[];
  editable: boolean;
  readOnlyReason: string | null;
};

export type DnspodRecordGroup = {
  subdomain: string;
  fqdn: string;
  managedBy: string[];
  records: DnspodRecord[];
};

type Deps = {
  /** 拿一个能调 DNSPod 的函数（凭据没配时抛 NOT_CONFIGURED）。 */
  transport: () => Promise<DnspodTransport>;
  managedIndex: () => Promise<DnsManagedIndex>;
  pageSize: number;
  maxPages: number;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 100;
const SNAPSHOT_ATTEMPTS = 3;

async function defaultTransport(): Promise<DnspodTransport> {
  const settings = await getDdnsSettings();
  if (!settings.tencentcloudSecretId.trim() || !settings.tencentcloudSecretKey.trim()) {
    throw new DnspodRecordsError("还没有填腾讯云 DNSPod 的 SecretId / SecretKey：先在上面「DDNS 服务商」里选腾讯云 DNSPod 填好并保存", "NOT_CONFIGURED");
  }
  return (action, payload) => tencentCloudRequest(settings, action, payload);
}

const defaultDeps: Deps = {
  transport: defaultTransport,
  managedIndex: loadDnsManagedIndex,
  pageSize: DEFAULT_PAGE_SIZE,
  maxPages: DEFAULT_MAX_PAGES,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
let deps: Deps = defaultDeps;

/** 测试用：换掉 DNSPod 请求、面板托管名字的来源、分页大小。传 null 恢复默认。 */
export function configureDnspodRecordsForTests(overrides: Partial<Deps> | null) {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/** 腾讯云 DDNS 里填的主域名，记录管理页默认选它。 */
export async function dnspodDefaultDomain() {
  const settings = await getDdnsSettings();
  return normalizeManagedDnsName(settings.tencentcloudDomainName) || null;
}

// ===== 请求与响应校验 =====

function invalidResponse(what: string): never {
  throw new DnspodRecordsError(`腾讯云 DNSPod 返回的${what}格式异常，没法确认结果，请稍后重试`, "INVALID_RESPONSE");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorName(error: unknown) {
  return (error as { name?: string } | null)?.name || "Error";
}

/** 不信任服务商文案的长度和内容：截短、去掉控制字符，只给页面看，不进日志。 */
function providerMessage(error: DdnsProviderError) {
  const text = String(error.message || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  return `腾讯云 DNSPod：${text || "请求被拒绝"}${error.code ? `（${error.code.slice(0, 64)}）` : ""}`;
}

async function call(transport: DnspodTransport, action: string, payload: Record<string, unknown>, options: { write?: boolean } = {}) {
  let response: unknown;
  try {
    response = await transport(action, payload);
  } catch (error) {
    if (error instanceof DnspodRecordsError) throw error;
    if (error instanceof DdnsProviderError) {
      appendPanelLog("warn", `[DNSPod] 记录管理 ${action} 被拒绝 code=${error.code.slice(0, 64) || "-"}`);
      throw new DnspodRecordsError(providerMessage(error), "PROVIDER", false, error.code);
    }
    // 没拿到服务商的明确答复（超时、断线、网关错误）：读可以直接报错，写则可能已经生效。
    appendPanelLog("warn", `[DNSPod] 记录管理 ${action} 没有明确答复 error=${errorName(error)}`);
    throw new DnspodRecordsError(
      options.write
        ? "腾讯云 DNSPod 没有给出明确答复（超时或网络中断），这条变更可能已经生效：请刷新列表核对后再决定要不要重试"
        : "连接腾讯云 DNSPod 失败（超时或网络中断），请稍后重试",
      "UNAVAILABLE",
      !!options.write,
    );
  }
  if (!isObject(response)) invalidResponse("响应");
  return response;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requiredString(value: unknown, what: string, maxLength = 2048) {
  if (typeof value !== "string" || !value || value.length > maxLength) invalidResponse(what);
  return value;
}

function recordIdOf(value: unknown, what: string) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,20}$/.test(text) || Number(text) <= 0) invalidResponse(what);
  return text;
}

function lineIdOf(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length <= 64) return value;
  return invalidResponse("线路 ID");
}

function positiveTtl(value: unknown) {
  const ttl = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) invalidResponse("TTL");
  return ttl;
}

type PageResult = { total: number; items: unknown[] };

/**
 * 翻完所有页。返回 null 表示这一轮翻页期间数据在变（总数变了、重复、短页），调用方重来。
 */
async function readSnapshot<T extends { id: string }>(
  fetchPage: (offset: number, limit: number) => Promise<PageResult>,
  mapItem: (raw: unknown) => T,
  what: string,
): Promise<T[] | null> {
  const items = new Map<string, T>();
  let offset = 0;
  let expectedTotal: number | null = null;
  for (let page = 0; page < deps.maxPages; page += 1) {
    const { total, items: batch } = await fetchPage(offset, deps.pageSize);
    if (batch.length > deps.pageSize) invalidResponse(what);
    if (expectedTotal !== null && total !== expectedTotal) return null;
    expectedTotal = total;
    for (const raw of batch) {
      const item = mapItem(raw);
      if (items.has(item.id)) return null;
      items.set(item.id, item);
    }
    offset += batch.length;
    if (offset === total) return [...items.values()];
    if (offset > total || batch.length < deps.pageSize) return null;
  }
  throw new DnspodRecordsError(
    `${what}太多：超过 ${deps.maxPages * deps.pageSize} 条，这里一次读不完。请到 DNSPod 控制台管理`,
    "TOO_MANY",
  );
}

async function readAllPages<T extends { id: string }>(
  fetchPage: (offset: number, limit: number) => Promise<PageResult>,
  mapItem: (raw: unknown) => T,
  what: string,
): Promise<T[]> {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    const snapshot = await readSnapshot(fetchPage, mapItem, what);
    if (snapshot) return snapshot;
    // 只记阶段，不记域名和内容。
    appendPanelLog("warn", `[DNSPod] 记录管理 ${what}翻页前后对不上，重读 attempt=${attempt + 1}`);
    if (attempt < SNAPSHOT_ATTEMPTS - 1) await deps.sleep(300 * (attempt + 1));
  }
  throw new DnspodRecordsError(`腾讯云 DNSPod 的${what}在翻页过程中一直在变，没能读到完整的一份，请稍后重试`, "INVALID_RESPONSE");
}

function normalizeDomainInput(value: unknown) {
  const domain = normalizeManagedDnsName(value);
  if (!domain || domain.length > 253 || !/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(domain)) {
    throw new DnspodRecordsError("域名格式不正确", "INVALID_INPUT");
  }
  return domain;
}

// ===== 域名、线路、记录 =====

function mapDomain(raw: unknown): DnspodDomain {
  if (!isObject(raw)) invalidResponse("域名列表");
  const name = normalizeManagedDnsName(requiredString(raw.Punycode || raw.Name, "域名", 253));
  return {
    id: recordIdOf(raw.DomainId, "域名 ID"),
    name,
    grade: typeof raw.Grade === "string" ? raw.Grade : "",
    status: typeof raw.Status === "string" ? raw.Status : null,
    recordCount: nonNegativeInteger(raw.RecordCount) ? (raw.RecordCount as number) : null,
  };
}

export async function listDnspodDomains(): Promise<DnspodDomain[]> {
  const transport = await deps.transport();
  const domains = await readAllPages(async (offset, limit) => {
    const response = await call(transport, "DescribeDomainList", { Type: "ALL", Offset: offset, Limit: limit });
    const info = response.DomainCountInfo;
    if (!isObject(info)) invalidResponse("域名总数");
    const total = nonNegativeInteger(info.AllTotal) ? info.AllTotal as number : nonNegativeInteger(info.DomainTotal) ? info.DomainTotal as number : null;
    if (total === null) invalidResponse("域名总数");
    const list = response.DomainList;
    if ((list === null || list === undefined) && total === 0) return { total, items: [] };
    if (!Array.isArray(list)) invalidResponse("域名列表");
    return { total, items: list };
  }, mapDomain, "域名列表");
  return domains.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** 这个域名的套餐能用哪些线路（默认、电信、联通、移动、境外……）。 */
export async function listDnspodRecordLines(domainValue: unknown, transportValue?: DnspodTransport): Promise<DnspodRecordLine[]> {
  const domain = normalizeDomainInput(domainValue);
  const transport = transportValue || await deps.transport();
  const info = await call(transport, "DescribeDomain", { Domain: domain });
  if (!isObject(info.DomainInfo)) invalidResponse("域名信息");
  const grade = requiredString(info.DomainInfo.Grade, "域名套餐", 64);
  const response = await call(transport, "DescribeRecordLineList", { Domain: domain, DomainGrade: grade });
  if (!Array.isArray(response.LineList)) invalidResponse("线路列表");
  const groups = response.LineGroupList;
  if (groups !== undefined && groups !== null && !Array.isArray(groups)) invalidResponse("线路分组");
  const lines = new Map<string, DnspodRecordLine>();
  for (const raw of [...response.LineList, ...(Array.isArray(groups) ? groups : [])]) {
    if (!isObject(raw)) invalidResponse("线路列表");
    const id = lineIdOf(raw.LineId);
    const name = requiredString(raw.Name, "线路名称", 64);
    if (!lines.has(id)) lines.set(id, { id, name });
  }
  // 任何套餐都有「默认」线路；一条都没有说明响应不对，不能让页面以为什么线路都选不了。
  if (lines.size === 0) invalidResponse("线路列表");
  return [...lines.values()];
}

function normalizedRecordValue(type: string, value: string) {
  const text = value.trim();
  return type === "CNAME" ? text.toLowerCase().replace(/\.+$/, "") : text;
}

/**
 * 记录的版本：只取会被这页改到的几样（名字、类型、线路、值、TTL）。
 * 列表（DescribeRecordList）和单条（DescribeRecord）字段名不一样，这里先规整再算，两边对得上。
 */
function recordRevision(record: { id: string; subdomain: string; type: string; lineId: string; value: string; ttl: number }) {
  return crypto.createHash("sha256").update(JSON.stringify([
    "dnspod-record:v1",
    record.id,
    record.subdomain.toLowerCase(),
    record.type.toUpperCase(),
    record.lineId,
    normalizedRecordValue(record.type.toUpperCase(), record.value),
    record.ttl,
  ]), "utf8").digest("hex").slice(0, 32);
}

type RawRecord = Omit<DnspodRecord, "fqdn" | "revision" | "managedBy" | "editable" | "readOnlyReason">;

function statusOf(value: unknown): RawRecord["status"] {
  const text = String(value ?? "").toUpperCase();
  return text === "ENABLE" ? "ENABLE" : text === "DISABLE" ? "DISABLE" : null;
}

function mapListedRecord(raw: unknown): RawRecord {
  if (!isObject(raw)) invalidResponse("记录列表");
  return {
    id: recordIdOf(raw.RecordId, "记录 ID"),
    subdomain: requiredString(raw.Name, "主机记录", 253).toLowerCase(),
    type: requiredString(raw.Type, "记录类型", 16).toUpperCase(),
    line: requiredString(raw.Line, "线路", 64),
    lineId: lineIdOf(raw.LineId ?? ""),
    value: requiredString(raw.Value, "记录值"),
    ttl: positiveTtl(raw.TTL),
    status: statusOf(raw.Status),
    weight: typeof raw.Weight === "number" ? raw.Weight : null,
    remark: typeof raw.Remark === "string" ? raw.Remark.slice(0, 200) : "",
  };
}

function mapRecordInfo(raw: unknown): RawRecord {
  if (!isObject(raw)) invalidResponse("记录详情");
  return {
    id: recordIdOf(raw.Id, "记录 ID"),
    subdomain: requiredString(raw.SubDomain, "主机记录", 253).toLowerCase(),
    type: requiredString(raw.RecordType, "记录类型", 16).toUpperCase(),
    line: requiredString(raw.RecordLine, "线路", 64),
    lineId: lineIdOf(raw.RecordLineId ?? ""),
    value: requiredString(raw.Value, "记录值"),
    ttl: positiveTtl(raw.TTL),
    status: raw.Enabled === 1 ? "ENABLE" : raw.Enabled === 0 ? "DISABLE" : null,
    weight: typeof raw.Weight === "number" ? raw.Weight : null,
    remark: typeof raw.Remark === "string" ? raw.Remark.slice(0, 200) : "",
  };
}

function managedMessage(fqdn: string, owners: DnsManagedOwner[]) {
  return `${fqdn} 由面板管理（${owners.map((owner) => owner.label).join("；")}），这里不能改；请到对应的主机、入口组 / 转发组、规则或落地池里改`;
}

function decorate(record: RawRecord, domain: string, index: DnsManagedIndex): DnspodRecord {
  const fqdn = dnspodRecordFqdn(record.subdomain, domain);
  const owners = dnsManagedOwnersOf(index, fqdn);
  const writable = isDnspodWritableRecordType(record.type);
  const readOnlyReason = owners.length > 0
    ? `由面板管理：${owners.map((owner) => owner.label).join("；")}`
    : writable ? null : `这里只管理 A / AAAA / CNAME，${record.type} 记录请到 DNSPod 控制台修改`;
  return {
    ...record,
    fqdn,
    revision: recordRevision(record),
    managedBy: owners.map((owner) => owner.label),
    editable: readOnlyReason === null,
    readOnlyReason,
  };
}

const NO_DATA_CODES = new Set(["ResourceNotFound.NoDataOfRecord"]);

async function fetchAllRecords(transport: DnspodTransport, domain: string) {
  return readAllPages(async (offset, limit) => {
    let response: Record<string, unknown>;
    try {
      response = await call(transport, "DescribeRecordList", { Domain: domain, Offset: offset, Limit: limit, ErrorOnEmpty: "no" });
    } catch (error) {
      // 服务商明确说「没有记录」也是一种明确的空：按 0 条算。翻到后面几页才这么说时，
      // 总数和第一页对不上，会走「翻页期间在变」重读，不会把前几页悄悄丢掉。
      if (error instanceof DnspodRecordsError && NO_DATA_CODES.has(error.providerCode)) return { total: 0, items: [] };
      throw error;
    }
    const info = response.RecordCountInfo;
    if (!isObject(info) || !nonNegativeInteger(info.TotalCount)) invalidResponse("记录总数");
    const total = info.TotalCount as number;
    const list = response.RecordList;
    if ((list === null || list === undefined) && total === 0) return { total, items: [] };
    if (!Array.isArray(list)) invalidResponse("记录列表");
    return { total, items: list };
  }, mapListedRecord, "解析记录");
}

function groupSortKey(subdomain: string) {
  return subdomain === "@" ? "" : subdomain;
}

export async function listDnspodRecords(domainValue: unknown): Promise<{
  domain: string;
  total: number;
  groups: DnspodRecordGroup[];
}> {
  const domain = normalizeDomainInput(domainValue);
  const transport = await deps.transport();
  const [records, index] = await Promise.all([fetchAllRecords(transport, domain), deps.managedIndex()]);
  const groups = new Map<string, DnspodRecordGroup>();
  for (const raw of records) {
    const record = decorate(raw, domain, index);
    let group = groups.get(record.subdomain);
    if (!group) {
      group = { subdomain: record.subdomain, fqdn: record.fqdn, managedBy: record.managedBy, records: [] };
      groups.set(record.subdomain, group);
    }
    group.records.push(record);
  }
  const sorted = [...groups.values()].sort((a, b) => groupSortKey(a.subdomain).localeCompare(groupSortKey(b.subdomain), "en"));
  for (const group of sorted) {
    group.records.sort((a, b) => a.type.localeCompare(b.type, "en") || a.lineId.localeCompare(b.lineId, "en") || Number(a.id) - Number(b.id));
  }
  return { domain, total: records.length, groups: sorted };
}

// ===== 统一保存 =====

async function currentRecord(transport: DnspodTransport, domain: string, recordId: string) {
  try {
    const response = await call(transport, "DescribeRecord", { Domain: domain, RecordId: Number(recordId) });
    return mapRecordInfo(response.RecordInfo);
  } catch (error) {
    if (error instanceof DnspodRecordsError && (NO_DATA_CODES.has(error.providerCode) || error.providerCode === "InvalidParameter.RecordIdInvalid")) {
      throw new DnspodRecordsError("这条记录已经不存在了（可能在别处被删了），请刷新列表", "NOT_FOUND");
    }
    throw error;
  }
}

function recordIdInput(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,20}$/.test(text) || Number(text) <= 0) throw new DnspodRecordsError("记录 ID 不正确", "INVALID_INPUT");
  return text;
}

function validDraft(input: DnspodRecordDraft) {
  const checked = validateDnspodRecordDraft(input);
  if (!checked.ok) throw new DnspodRecordsError(checked.error, "INVALID_INPUT");
  return checked.record;
}

type ApplyContext = {
  domain: string;
  transport: DnspodTransport;
  index: DnsManagedIndex;
  lines: () => Promise<DnspodRecordLine[]>;
};

function assertNotManaged(context: ApplyContext, subdomain: string) {
  const fqdn = dnspodRecordFqdn(subdomain, context.domain);
  const owners = dnsManagedOwnersOf(context.index, fqdn);
  if (owners.length > 0) throw new DnspodRecordsError(managedMessage(fqdn, owners), "MANAGED");
}

async function lineFor(context: ApplyContext, lineId: string) {
  const line = (await context.lines()).find((item) => item.id === lineId);
  if (!line) throw new DnspodRecordsError("选的线路不在这个域名套餐可用的线路里，请刷新线路后重选", "INVALID_INPUT");
  return line;
}

/** 改、删之前：服务商那边这条记录此刻的样子必须还是浏览器看到的那样，而且不归面板管。 */
async function guardExisting(context: ApplyContext, recordId: string, revision: string) {
  const current = await currentRecord(context.transport, context.domain, recordId);
  if (!isDnspodWritableRecordType(current.type)) {
    throw new DnspodRecordsError(`这里只管理 A / AAAA / CNAME，${current.type} 记录请到 DNSPod 控制台修改`, "UNSUPPORTED_TYPE");
  }
  assertNotManaged(context, current.subdomain);
  if (recordRevision(current) !== String(revision || "")) {
    throw new DnspodRecordsError("这条记录在别处被改过了（DNSPod 控制台或 DDNS），请刷新列表后重新编辑", "CHANGED");
  }
  return current;
}

async function applyOne(context: ApplyContext, change: DnspodRecordChange) {
  if (change.kind === "create") {
    const record = validDraft(change.record);
    assertNotManaged(context, record.subdomain);
    const line = await lineFor(context, record.lineId);
    await call(context.transport, "CreateRecord", {
      Domain: context.domain,
      SubDomain: record.subdomain,
      RecordType: record.type,
      RecordLine: line.name,
      RecordLineId: line.id,
      Value: record.value,
      TTL: record.ttl,
    }, { write: true });
    return;
  }
  const recordId = recordIdInput(change.recordId);
  if (change.kind === "update") {
    const record = validDraft(change.record);
    // 改名时新名字同样不能是面板的：不然先建一条无主记录、再改名成托管名字就绕过去了。
    assertNotManaged(context, record.subdomain);
    const current = await guardExisting(context, recordId, change.revision);
    const line = await lineFor(context, record.lineId);
    const payload: Record<string, unknown> = {
      Domain: context.domain,
      RecordId: Number(recordId),
      SubDomain: record.subdomain,
      RecordType: record.type,
      RecordLine: line.name,
      RecordLineId: line.id,
      Value: record.value,
      TTL: record.ttl,
    };
    // ModifyRecord 不带这两个时会按默认值重置（暂停的记录被启用、权重被清掉），原样带上。
    if (current.status) payload.Status = current.status;
    if (current.weight !== null) payload.Weight = current.weight;
    await call(context.transport, "ModifyRecord", payload, { write: true });
    return;
  }
  if (change.kind === "delete") {
    await guardExisting(context, recordId, change.revision);
    await call(context.transport, "DeleteRecord", { Domain: context.domain, RecordId: Number(recordId) }, { write: true });
    return;
  }
  throw new DnspodRecordsError("认不出来的变更", "INVALID_INPUT");
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 统一保存：按顺序一条一条写。一条失败，后面的标 skipped 不再试。
 * 凭据没配、读不出面板托管名字这类「整批都做不了」的错误直接抛出（一条都没写）。
 */
export async function applyDnspodRecordChanges(domainValue: unknown, changes: readonly DnspodRecordChange[]): Promise<{
  domain: string;
  results: DnspodRecordChangeResult[];
}> {
  const domain = normalizeDomainInput(domainValue);
  if (!changes || changes.length === 0) throw new DnspodRecordsError("没有要保存的变更", "INVALID_INPUT");
  if (changes.length > DNSPOD_MAX_CHANGES_PER_SAVE) {
    throw new DnspodRecordsError(`一次最多保存 ${DNSPOD_MAX_CHANGES_PER_SAVE} 条变更，请分几次保存`, "INVALID_INPUT");
  }
  const keys = new Set<string>();
  for (const change of changes) {
    const key = String(change?.key || "");
    if (!key || keys.has(key)) throw new DnspodRecordsError("变更编号重复或为空", "INVALID_INPUT");
    keys.add(key);
  }

  return withKeyedTaskLock(`dnspod-records:${domain}`, async () => {
    const transport = await deps.transport();
    // 托管名字在锁里、写之前现读一遍：刚在别处给主机开了 DDNS，这里马上就挡。
    const index = await deps.managedIndex();
    let linesPromise: Promise<DnspodRecordLine[]> | null = null;
    const context: ApplyContext = {
      domain,
      transport,
      index,
      lines: () => {
        linesPromise ??= listDnspodRecordLines(domain, transport);
        // 读线路失败不缓存：下一条变更再试一次。
        return linesPromise.catch((error) => {
          linesPromise = null;
          throw error;
        });
      },
    };

    const results: DnspodRecordChangeResult[] = [];
    let blocked = false;
    const counts = { create: 0, update: 0, delete: 0 };
    for (const change of changes) {
      if (blocked) {
        results.push({ key: change.key, status: "skipped" });
        continue;
      }
      try {
        await applyOne(context, change);
        results.push({ key: change.key, status: "done" });
        counts[change.kind] += 1;
      } catch (error) {
        blocked = true;
        const uncertain = error instanceof DnspodRecordsError && error.uncertain;
        results.push({ key: change.key, status: "failed", error: errorText(error), ...(uncertain ? { uncertain: true } : {}) });
      }
    }
    const failed = results.filter((result) => result.status !== "done").length;
    appendPanelLog(failed ? "warn" : "info", `[DNSPod] 记录管理 domain=${domain} 新增 ${counts.create} 修改 ${counts.update} 删除 ${counts.delete}${failed ? ` 未完成 ${failed}` : ""}`);
    return { domain, results };
  });
}
