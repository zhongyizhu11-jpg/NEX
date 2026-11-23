import { withKeyedTaskLock } from "./keyedTaskLock";
import {
  DdnsProviderError,
  aliyunRequest,
  ddnsFqdn,
  ddnsRecordLockKey,
  huaweicloudRequest,
  normalizeDdnsName,
  parseDdnsTtl,
  planDdnsValueChanges,
  splitDdnsName,
  tencentCloudRequest,
  uniqueDdnsValues,
  withProviderMinTtl,
  type DdnsSettings,
} from "./ddns";
import {
  DDNS_WEIGHT_MAX,
  DDNS_WEIGHT_MIN,
  ddnsWeightSupportForProvider,
  type DdnsWeightSupport,
  type DdnsWeights,
} from "../shared/ddnsWeights";

/*
  入口组「按权重解析」在三家服务商上的写法（哪家支持、为什么，见 shared/ddnsWeights.ts）。

  只有开了按权重解析的组走这里；没开的组照旧走 server/ddns.ts 的 updateDdnsRecordValues，一个请求都不多。
  记录归属的规矩和那边一样：只动这个名字、这个类型、默认线路上的记录，按值对账（多的删、少的建、错的改）。

  各家接口（参数名按官方文档核对过，见每段开头的注释；标「未核对」的是文档没写清、按常理处理的地方）：

  · 腾讯云 DNSPod —— CreateRecord / ModifyRecord 带 Weight（0～100 的整数，0 表示关闭，不传表示不设置）。
    记录列表（DescribeRecordList）里每条带 Weight，权重没变的记录不重写。
    不按权重了：每条记录 ModifyRecord 带 Weight = 0（文档原话「0 表示关闭」；未核对的是关闭后服务端
    是否恢复成等权轮询 —— 按文档字面理解是）。

  · 阿里云 DNS —— 先照常对账记录，再 SetDNSSLBStatus（SubDomain、Open、DomainName、Type = A / AAAA、Line）
    打开这个子域名的权重配置，然后每条记录 UpdateDNSSLBWeight（RecordId、Weight 1～100）。
    不按权重了：SetDNSSLBStatus Open = false。
    未核对：DescribeSubDomainRecords 返回的记录里是否带 Weight（带就用来跳过没变的，不带就每条都设一次）；
    只有一条记录时 SetDNSSLBStatus 是否报错（这里不足两条时不调用）。

  · 华为云 DNS —— v2.1 记录集的 weight（0～1000，公网默认 1）。没开权重时面板是「一个记录集装全部值」；
    按权重时改成「一个值一个记录集、各带各的 weight」（同名同类型同线路的记录集最多 20 个，和组的成员上限一样）。
    不按权重了：合回一个记录集（weight 设回 1）。
*/

type WeightedTencentTransport = (action: string, payload: Record<string, unknown>) => Promise<unknown>;
type WeightedAliyunTransport = (action: string, params: Record<string, string | number | undefined>) => Promise<unknown>;
type WeightedHuaweiTransport = (
  method: string,
  path: string,
  query: Record<string, string | number | undefined>,
  body?: unknown,
) => Promise<unknown>;

type Deps = {
  tencent: (settings: DdnsSettings) => WeightedTencentTransport;
  aliyun: (settings: DdnsSettings) => WeightedAliyunTransport;
  huawei: (settings: DdnsSettings) => WeightedHuaweiTransport;
};

const defaultDeps: Deps = {
  tencent: (settings) => (action, payload) => tencentCloudRequest(settings, action, payload),
  aliyun: (settings) => (action, params) => aliyunRequest(settings, action, params),
  huawei: (settings) => (method, path, query, body) => huaweicloudRequest(settings, method, path, query, body),
};
let deps: Deps = defaultDeps;

/** 测试用：换掉服务商请求。传 null 恢复默认。 */
export function configureDdnsWeightedRecordsForTests(overrides: Partial<Deps> | null) {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/** 现在的 DDNS 设置能不能按权重发布：服务商支持，而且凭据填全了。 */
export function ddnsWeightSupport(settings: DdnsSettings): DdnsWeightSupport {
  const support = ddnsWeightSupportForProvider(settings.provider, settings.enabled);
  if (!support.supported) return support;
  const incomplete = (reason: string): DdnsWeightSupport => ({ supported: false, provider: null, reason });
  if (support.provider === "tencentcloud" && (!settings.tencentcloudSecretId.trim() || !settings.tencentcloudSecretKey.trim() || !settings.tencentcloudDomainName.trim())) {
    return incomplete("腾讯云 DNSPod 的 SecretId / SecretKey 或主域名没有填全");
  }
  if (support.provider === "aliyun" && (!settings.aliyunAccessKeyId.trim() || !settings.aliyunAccessKeySecret.trim() || !settings.aliyunDomainName.trim())) {
    return incomplete("阿里云 DNS 的 AccessKey ID / AccessKey Secret 或主域名没有填全");
  }
  if (support.provider === "huaweicloud" && (!settings.huaweicloudAccessKeyId.trim() || !settings.huaweicloudSecretKey.trim())) {
    return incomplete("华为云 DNS 的 Access Key ID / Secret Access Key 没有填全");
  }
  return support;
}

export type WeightedRecordInput = {
  domain: string;
  recordType: string;
  values: string[];
  weights: DdnsWeights;
  ttl?: number;
};

export type WeightedRecordResult = {
  /** 实际发出去的写请求数（0 = 服务商那边已经是这样）。 */
  writes: number;
};

function arrayOf(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
}

function clampWeight(value: unknown) {
  const weight = Math.round(Number(value));
  if (!Number.isFinite(weight)) return DDNS_WEIGHT_MIN;
  return Math.min(DDNS_WEIGHT_MAX, Math.max(DDNS_WEIGHT_MIN, weight));
}

function normalizedInput(input: WeightedRecordInput) {
  const recordType = String(input.recordType || "A").trim().toUpperCase();
  if (recordType !== "A" && recordType !== "AAAA") throw new Error("按权重解析只支持 A / AAAA 记录");
  const domain = String(input.domain || "").trim();
  if (!domain) throw new Error("入口组未配置 DDNS 域名");
  const values = uniqueDdnsValues(input.values);
  if (values.length === 0) throw new Error("按权重解析至少要有一个入口地址");
  const weightOf = (value: string) => clampWeight(input.weights[value]);
  return { domain, recordType, values, weightOf };
}

/** 服务商返回的权重：没有 / 不是数字算「不知道」（null），和任何想要的权重都不相等。 */
function currentWeight(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const weight = Number(value);
  return Number.isFinite(weight) ? weight : null;
}

// ===== 腾讯云 DNSPod =====

function tencentTarget(settings: DdnsSettings, domain: string, recordType: string) {
  const { root, subDomain } = splitDdnsName(domain, settings.tencentcloudDomainName, "腾讯云 DNSPod");
  const recordLine = (settings.tencentcloudRecordLine || "默认").trim();
  const recordLineId = (settings.tencentcloudRecordLineId || "").trim();
  const listPayload: Record<string, unknown> = {
    Domain: root,
    Subdomain: subDomain,
    RecordType: recordType,
    RecordLine: recordLine,
    Limit: 3000,
    ErrorOnEmpty: "no",
  };
  if (recordLineId) listPayload.RecordLineId = recordLineId;
  const matches = (item: Record<string, unknown>) => (
    String(item?.Name || "") === subDomain
    && String(item?.Type || "").toUpperCase() === recordType
    && (recordLineId ? String(item?.LineId || "") === recordLineId : String(item?.Line || "") === recordLine)
    && !!String(item?.RecordId || "")
  );
  const payloadFor = (value: string, ttl: number) => {
    const payload: Record<string, unknown> = { Domain: root, SubDomain: subDomain, RecordType: recordType, RecordLine: recordLine, Value: value, TTL: ttl };
    if (recordLineId) payload.RecordLineId = recordLineId;
    return payload;
  };
  return { root, listPayload, matches, payloadFor };
}

async function publishTencentWeighted(settings: DdnsSettings, input: WeightedRecordInput): Promise<WeightedRecordResult> {
  const { domain, recordType, values, weightOf } = normalizedInput(input);
  const transport = deps.tencent(settings);
  const target = tencentTarget(settings, domain, recordType);
  const ttl = parseDdnsTtl(input.ttl, settings.tencentcloudTtl);
  const list = await transport("DescribeRecordList", target.listPayload) as { RecordList?: unknown } | null;
  const records = arrayOf(list?.RecordList).filter(target.matches);
  const plan = planDdnsValueChanges(records, values, (record) => record?.Value);
  const touched = new Set<Record<string, unknown>>([...plan.updates.map((change) => change.record), ...plan.removals]);
  let writes = 0;
  await withProviderMinTtl("tencentcloud", target.root, ttl, async (effectiveTtl) => {
    for (const change of plan.updates) {
      await transport("ModifyRecord", { ...target.payloadFor(change.value, effectiveTtl), RecordId: Number(change.record.RecordId), Weight: weightOf(change.value) });
      writes += 1;
    }
    for (const value of plan.creates) {
      await transport("CreateRecord", { ...target.payloadFor(value, effectiveTtl), Weight: weightOf(value) });
      writes += 1;
    }
    // 值没变的记录：权重不一样才改（ModifyRecord 要带全记录的值和线路）。
    for (const record of records) {
      if (touched.has(record)) continue;
      const value = String(record.Value || "").trim();
      if (currentWeight(record.Weight) === weightOf(value)) continue;
      await transport("ModifyRecord", { ...target.payloadFor(value, effectiveTtl), RecordId: Number(record.RecordId), Weight: weightOf(value) });
      writes += 1;
    }
  });
  for (const record of plan.removals) {
    await transport("DeleteRecord", { Domain: target.root, RecordId: Number(record.RecordId) });
    writes += 1;
  }
  return { writes };
}

async function clearTencentWeights(settings: DdnsSettings, input: Omit<WeightedRecordInput, "weights">): Promise<WeightedRecordResult> {
  const recordType = String(input.recordType || "A").trim().toUpperCase();
  const transport = deps.tencent(settings);
  const target = tencentTarget(settings, input.domain.trim(), recordType);
  const ttl = parseDdnsTtl(input.ttl, settings.tencentcloudTtl);
  const list = await transport("DescribeRecordList", target.listPayload) as { RecordList?: unknown } | null;
  const published = new Set(uniqueDdnsValues(input.values));
  let writes = 0;
  for (const record of arrayOf(list?.RecordList).filter(target.matches)) {
    // 只收面板这次要发布的值上的权重；别的值（之后的发布会按值对账）不去改。
    if (!published.has(String(record.Value || "").trim())) continue;
    const weight = currentWeight(record.Weight);
    if (weight === null || weight === 0) continue;
    // 权重设回 0（关闭）；TTL 用记录现在的，别顺手改了别的东西。
    await transport("ModifyRecord", { ...target.payloadFor(String(record.Value || "").trim(), Number(record.TTL) || ttl), RecordId: Number(record.RecordId), Weight: 0 });
    writes += 1;
  }
  return { writes };
}

/** 删组：只删值在 values 里的记录（面板发布过的），别的记录、别的记录的权重都不碰。 */
async function deleteTencentPublished(settings: DdnsSettings, recordType: string, domain: string, published: Set<string>): Promise<WeightedRecordResult> {
  const transport = deps.tencent(settings);
  const target = tencentTarget(settings, domain, recordType);
  const list = await transport("DescribeRecordList", target.listPayload) as { RecordList?: unknown } | null;
  let writes = 0;
  for (const record of arrayOf(list?.RecordList).filter(target.matches)) {
    if (!published.has(String(record.Value || "").trim())) continue;
    await transport("DeleteRecord", { Domain: target.root, RecordId: Number(record.RecordId) });
    writes += 1;
  }
  return { writes };
}

// ===== 阿里云 DNS =====

function aliyunTarget(settings: DdnsSettings, domain: string, recordType: string) {
  const { root, rr } = splitDdnsName(domain, settings.aliyunDomainName, "阿里云");
  const subDomain = normalizeDdnsName(domain);
  const line = (settings.aliyunLine || "default").trim();
  const listParams = { DomainName: root, SubDomain: subDomain, Type: recordType, Line: line, PageNumber: 1, PageSize: 100 };
  const matches = (item: Record<string, unknown>) => (
    String(item?.RR || "") === rr
    && String(item?.Type || "").toUpperCase() === recordType
    && (!line || String(item?.Line || "") === line)
    && !!String(item?.RecordId || "")
  );
  const payloadFor = (value: string, ttl: number) => ({ RR: rr, Type: recordType, Value: value, Line: line, TTL: ttl });
  const slbParams = (open: boolean) => ({ DomainName: root, SubDomain: subDomain, Type: recordType, Line: line, Open: open ? "true" : "false" });
  return { root, listParams, matches, payloadFor, slbParams };
}

async function publishAliyunWeighted(settings: DdnsSettings, input: WeightedRecordInput): Promise<WeightedRecordResult> {
  const { domain, recordType, values, weightOf } = normalizedInput(input);
  const transport = deps.aliyun(settings);
  const target = aliyunTarget(settings, domain, recordType);
  const ttl = parseDdnsTtl(input.ttl, settings.aliyunTtl);
  const list = await transport("DescribeSubDomainRecords", target.listParams) as { DomainRecords?: { Record?: unknown } } | null;
  const records = arrayOf(list?.DomainRecords?.Record).filter(target.matches);
  const plan = planDdnsValueChanges(records, values, (record) => record?.Value);
  const touched = new Set<Record<string, unknown>>([...plan.updates.map((change) => change.record), ...plan.removals]);
  let writes = 0;
  // 每个值现在落在哪条记录上、那条记录的权重（刚建 / 刚改的不知道，下面一定会设）。
  const recordByValue = new Map<string, { id: string; weight: number | null }>();
  for (const record of records) {
    if (touched.has(record)) continue;
    recordByValue.set(String(record.Value || "").trim(), { id: String(record.RecordId), weight: currentWeight(record.Weight) });
  }
  await withProviderMinTtl("aliyun", target.root, ttl, async (effectiveTtl) => {
    for (const change of plan.updates) {
      await transport("UpdateDomainRecord", { RecordId: String(change.record.RecordId), ...target.payloadFor(change.value, effectiveTtl) });
      recordByValue.set(change.value, { id: String(change.record.RecordId), weight: null });
      writes += 1;
    }
    for (const value of plan.creates) {
      const created = await transport("AddDomainRecord", { DomainName: target.root, ...target.payloadFor(value, effectiveTtl) }) as { RecordId?: unknown } | null;
      const id = String(created?.RecordId ?? "").trim();
      if (id) recordByValue.set(value, { id, weight: null });
      writes += 1;
    }
  });
  for (const record of plan.removals) {
    await transport("DeleteDomainRecord", { RecordId: String(record.RecordId) });
    writes += 1;
  }
  // 权重配置要这个子域名下至少两条同类型记录才有意义；不足两条时不碰。
  if (values.length < 2) return { writes };
  if (values.some((value) => !recordByValue.has(value))) {
    // 新建的记录没回 ID：重新列一遍按值找。
    const relisted = await transport("DescribeSubDomainRecords", target.listParams) as { DomainRecords?: { Record?: unknown } } | null;
    for (const record of arrayOf(relisted?.DomainRecords?.Record).filter(target.matches)) {
      const value = String(record.Value || "").trim();
      if (!recordByValue.has(value)) recordByValue.set(value, { id: String(record.RecordId), weight: null });
    }
  }
  const pending = values
    .map((value) => ({ value, record: recordByValue.get(value) }))
    .filter((entry): entry is { value: string; record: { id: string; weight: number | null } } => !!entry.record && entry.record.weight !== weightOf(entry.value));
  if (pending.length === 0) return { writes };
  // 打开是幂等的：已经开着再开一次不改任何权重。只在确实有权重要设时才调。
  await transport("SetDNSSLBStatus", target.slbParams(true));
  writes += 1;
  for (const entry of pending) {
    await transport("UpdateDNSSLBWeight", { RecordId: entry.record.id, Weight: weightOf(entry.value) });
    writes += 1;
  }
  return { writes };
}

async function clearAliyunWeights(settings: DdnsSettings, input: Omit<WeightedRecordInput, "weights">): Promise<WeightedRecordResult> {
  const recordType = String(input.recordType || "A").trim().toUpperCase();
  const target = aliyunTarget(settings, input.domain.trim(), recordType);
  await deps.aliyun(settings)("SetDNSSLBStatus", target.slbParams(false));
  return { writes: 1 };
}

/**
 * 删组：只删值在 values 里的记录。权重配置是整个子域名的开关：删完还剩别人的记录就不动它
 * （关掉会改别人记录的解析方式），一条都不剩了才关。
 */
async function deleteAliyunPublished(settings: DdnsSettings, recordType: string, domain: string, published: Set<string>): Promise<WeightedRecordResult> {
  const transport = deps.aliyun(settings);
  const target = aliyunTarget(settings, domain, recordType);
  const list = await transport("DescribeSubDomainRecords", target.listParams) as { DomainRecords?: { Record?: unknown } } | null;
  const records = arrayOf(list?.DomainRecords?.Record).filter(target.matches);
  let writes = 0;
  let remaining = 0;
  for (const record of records) {
    if (!published.has(String(record.Value || "").trim())) {
      remaining += 1;
      continue;
    }
    await transport("DeleteDomainRecord", { RecordId: String(record.RecordId) });
    writes += 1;
  }
  if (remaining === 0 && writes > 0) {
    try {
      await transport("SetDNSSLBStatus", target.slbParams(false));
      writes += 1;
    } catch (error) {
      // 本来就没开 / 记录已经没了：没有可关的。
      if (!(error instanceof DdnsProviderError)) throw error;
    }
  }
  return { writes };
}

// ===== 华为云 DNS =====

function stripDot(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\.+$/, "");
}

async function huaweiRecordSets(settings: DdnsSettings, domain: string, recordType: string) {
  const transport = deps.huawei(settings);
  const name = ddnsFqdn(domain);
  const line = (settings.huaweicloudLine || "default_view").trim();
  const query: Record<string, string | number | undefined> = { name, type: recordType, limit: 100, search_mode: "equal" };
  if (line) query.line_id = line;
  if (settings.huaweicloudZoneId.trim()) query.zone_id = settings.huaweicloudZoneId.trim();
  const list = await transport("GET", "/v2.1/recordsets", query) as { recordsets?: unknown } | null;
  const sets = arrayOf(list?.recordsets).filter((item) => {
    const itemLine = String(item?.line || item?.line_id || item?.lineId || "").trim();
    return String(item?.name || "").toLowerCase() === name.toLowerCase()
      && String(item?.type || "").toUpperCase() === recordType
      && (!line || !itemLine || itemLine === line)
      && !!String(item?.id || "");
  });
  let zoneId = String(sets[0]?.zone_id || sets[0]?.zoneId || settings.huaweicloudZoneId || "").trim();
  if (!zoneId) {
    const labels = normalizeDdnsName(domain).split(".").filter(Boolean);
    for (let index = 0; index < labels.length - 1 && !zoneId; index += 1) {
      const candidate = labels.slice(index).join(".");
      const body = await transport("GET", "/v2/zones", { name: `${candidate}.`, limit: 100 }) as { zones?: unknown } | null;
      const match = arrayOf(body?.zones).find((zone) => stripDot(zone?.name) === candidate);
      if (match?.id) zoneId = String(match.id);
    }
    if (!zoneId) throw new Error(`华为云未找到域名 ${domain} 对应的公网 Zone，请确认域名已托管或手动填写 Zone ID`);
  }
  return { transport, name, line, sets, base: `/v2.1/zones/${encodeURIComponent(zoneId)}/recordsets` };
}

function huaweiSetValues(set: Record<string, unknown>) {
  return (Array.isArray(set.records) ? set.records : []).map((value) => String(value).trim());
}

async function publishHuaweiWeighted(settings: DdnsSettings, input: WeightedRecordInput): Promise<WeightedRecordResult> {
  const { domain, recordType, values, weightOf } = normalizedInput(input);
  const ttl = parseDdnsTtl(input.ttl, settings.huaweicloudTtl);
  const { transport, name, line, sets, base } = await huaweiRecordSets(settings, domain, recordType);
  const wanted = new Set(values);
  const covered = new Map<string, Record<string, unknown>>();
  const reusable: Array<Record<string, unknown>> = [];
  for (const set of sets) {
    const setValues = huaweiSetValues(set);
    // 正好一个值、是要的、还没被别的记录集占着：留着。其余的（装了几个值的老记录集、多余的）拿来改或者删。
    if (setValues.length === 1 && wanted.has(setValues[0]) && !covered.has(setValues[0])) covered.set(setValues[0], set);
    else reusable.push(set);
  }
  const missing = values.filter((value) => !covered.has(value));
  const pathOf = (set: Record<string, unknown>) => `${base}/${encodeURIComponent(String(set.id))}`;
  let writes = 0;
  // 先改（把老记录集变成其中一个值），再删多余的，最后建缺的：任何时刻同一个值都只在一个记录集里。
  while (missing.length > 0 && reusable.length > 0) {
    const value = missing.shift()!;
    await transport("PUT", pathOf(reusable.shift()!), {}, { name, type: recordType, ttl, records: [value], weight: weightOf(value) });
    writes += 1;
  }
  for (const set of reusable) {
    await transport("DELETE", pathOf(set), {});
    writes += 1;
  }
  for (const value of missing) {
    await transport("POST", base, {}, { name, type: recordType, ttl, records: [value], weight: weightOf(value), ...(line ? { line } : {}) });
    writes += 1;
  }
  for (const [value, set] of covered) {
    if (currentWeight(set.weight) === weightOf(value)) continue;
    await transport("PUT", pathOf(set), {}, { name, type: recordType, ttl: Number(set.ttl) || ttl, records: [value], weight: weightOf(value) });
    writes += 1;
  }
  return { writes };
}

/** 合回「一个记录集装全部值」（面板没开权重时的写法），权重设回默认的 1。 */
async function clearHuaweiWeights(settings: DdnsSettings, input: Omit<WeightedRecordInput, "weights">): Promise<WeightedRecordResult> {
  const recordType = String(input.recordType || "A").trim().toUpperCase();
  const values = uniqueDdnsValues(input.values);
  const ttl = parseDdnsTtl(input.ttl, settings.huaweicloudTtl);
  const { transport, name, sets, base } = await huaweiRecordSets(settings, input.domain.trim(), recordType);
  if (sets.length === 0) return { writes: 0 };
  const [keep, ...extras] = sets;
  const pathOf = (set: Record<string, unknown>) => `${base}/${encodeURIComponent(String(set.id))}`;
  let writes = 0;
  // 先删多余的再把留下的那个改成全部值：反过来的话同一个值会同时出现在两个记录集里。
  for (const set of extras) {
    await transport("DELETE", pathOf(set), {});
    writes += 1;
  }
  // 要清空记录时只收到剩一个记录集，剩下那个由默认的发布路径删。
  if (values.length === 0) return { writes };
  const keepValues = huaweiSetValues(keep);
  const same = keepValues.length === values.length && values.every((value) => keepValues.includes(value));
  if (!same || currentWeight(keep.weight) !== 1) {
    await transport("PUT", pathOf(keep), {}, { name, type: recordType, ttl: Number(keep.ttl) || ttl, records: values, weight: 1 });
    writes += 1;
  }
  return { writes };
}

/**
 * 删组：一个值一个记录集（按权重）或一个记录集装全部值（不按权重）两种写法都认。
 * 值全是面板发布过的记录集删掉；混着别人的值的只拿掉面板的值（权重不动）；全是别人的不碰。
 */
async function deleteHuaweiPublished(settings: DdnsSettings, recordType: string, domain: string, published: Set<string>): Promise<WeightedRecordResult> {
  const ttl = parseDdnsTtl(undefined, settings.huaweicloudTtl);
  const { transport, name, sets, base } = await huaweiRecordSets(settings, domain, recordType);
  let writes = 0;
  for (const set of sets) {
    const setValues = huaweiSetValues(set);
    const remaining = setValues.filter((value) => !published.has(value));
    if (remaining.length === setValues.length) continue;
    const pathOf = `${base}/${encodeURIComponent(String(set.id))}`;
    if (remaining.length === 0) await transport("DELETE", pathOf, {});
    else await transport("PUT", pathOf, {}, { name, type: recordType, ttl: Number(set.ttl) || ttl, records: remaining });
    writes += 1;
  }
  return { writes };
}

// ===== 对外 =====

function lockFor(settings: DdnsSettings, input: { domain: string; recordType: string }) {
  return ddnsRecordLockKey(settings, { domain: input.domain.trim(), recordType: String(input.recordType || "A").trim().toUpperCase() });
}

function assertWeightSupport(settings: DdnsSettings) {
  if (!settings.enabled || settings.provider === "disabled") throw new Error("DDNS 未启用");
  const support = ddnsWeightSupport(settings);
  if (!support.supported || !support.provider) throw new Error(support.reason || "当前 DDNS 服务商不支持按权重解析");
  return support.provider;
}

/**
 * 按权重发布一个名字的 A / AAAA 记录：值的集合对账成 input.values，每条记录的权重设成 input.weights。
 * 和默认发布用同一把「名字 + 类型」的锁，不会和别的写同时进行。
 */
export async function publishWeightedDdnsRecords(settings: DdnsSettings, input: WeightedRecordInput): Promise<WeightedRecordResult> {
  const provider = assertWeightSupport(settings);
  return withKeyedTaskLock(lockFor(settings, input), () => {
    if (provider === "tencentcloud") return publishTencentWeighted(settings, input);
    if (provider === "aliyun") return publishAliyunWeighted(settings, input);
    return publishHuaweiWeighted(settings, input);
  });
}

/**
 * 之前按权重发布过、现在不按了（关了开关、聚合不满足条件）：把服务商那边的权重设置收掉。
 * 之后调用方照常走 updateDdnsRecordValues。服务商明确拒绝（权重配置本来就没开之类）不算失败：
 * 那一步没有可收的东西；网络错误照常抛出，下一轮重试。
 */
export async function clearDdnsRecordWeights(settings: DdnsSettings, input: Omit<WeightedRecordInput, "weights">): Promise<WeightedRecordResult> {
  const provider = assertWeightSupport(settings);
  return withKeyedTaskLock(lockFor(settings, input), async () => {
    try {
      if (provider === "tencentcloud") return await clearTencentWeights(settings, input);
      if (provider === "aliyun") return await clearAliyunWeights(settings, input);
      return await clearHuaweiWeights(settings, input);
    } catch (error) {
      if (error instanceof DdnsProviderError && provider === "aliyun") {
        console.warn(`[DDNS] clearing record weights was rejected by ${provider} (${error.code}): ${error.message}`);
        return { writes: 0 };
      }
      throw error;
    }
  });
}

/**
 * 删组时清掉面板发布过的记录（按权重发布过的组走这里，不先「收权重」—— 收权重会合并 / 改动这个名字上
 * 所有的记录，包括别人加的）。只碰值在 input.values 里的记录。
 */
export async function deleteWeightedDdnsRecords(settings: DdnsSettings, input: Omit<WeightedRecordInput, "weights">): Promise<WeightedRecordResult> {
  const provider = assertWeightSupport(settings);
  const recordType = String(input.recordType || "A").trim().toUpperCase();
  const domain = String(input.domain || "").trim();
  const published = new Set(uniqueDdnsValues(input.values));
  if (!domain || published.size === 0) return { writes: 0 };
  return withKeyedTaskLock(lockFor(settings, input), () => {
    if (provider === "tencentcloud") return deleteTencentPublished(settings, recordType, domain, published);
    if (provider === "aliyun") return deleteAliyunPublished(settings, recordType, domain, published);
    return deleteHuaweiPublished(settings, recordType, domain, published);
  });
}
