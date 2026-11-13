import {
  normalizeDdnsLineRef,
  type DdnsLineProvider,
  type DdnsLineRef,
} from "@shared/ddnsLines";
import {
  DdnsProviderError,
  aliyunRequest,
  ddnsFqdn,
  ddnsRecordLockKey,
  getDdnsSettings,
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
import { listDnspodRecordLines, type DnspodRecordLine } from "./dnspodRecords";
import { normalizeManagedDnsName } from "./dnsManagedNames";
import { withKeyedTaskLock } from "./keyedTaskLock";

/*
  分线路解析在服务商那边的读写：某个名字、某种记录类型、某条线路上的一组记录。

  支持三家（2.3.529 起）：
  - 腾讯云 DNSPod：线路列表按域名套餐实时读（DescribeRecordLineList），一个值一条记录，
    写的时候带 RecordLine + RecordLineId。行为和 2.3.529 之前完全一样；
  - 阿里云 DNS：线路列表 DescribeSupportLines（LineCode / LineDisplayName，默认线路 default），
    一个值一条记录，AddDomainRecord / UpdateDomainRecord 带 Line，按 DescribeSubDomainRecords
    （SubDomain + Type + Line）列这条线路上的记录，DeleteDomainRecord 按 RecordId 删；
  - 华为云 DNS：没有列内置线路的接口，用官方「解析线路列表」里的运营商线路（default_view 全网默认、
    Dianxin 电信……，见 HUAWEI_LINES）。一个「记录集」装这条线路上的全部值（records[]），
    所以每个名字 / 类型 / 线路只有一个记录集；建的时候带 line（建好后线路改不了），
    按 /v2.1/zones/{zone_id}/recordsets?line_id= 列，按记录集 ID 删。
  Cloudflare 没有运营商线路，Webhook 面板不知道接收端怎么写，都不支持；选了它们时界面上的线路
  选择是灰的，服务端也完全不看成员上的线路配置（等于没分线路）。

  和默认线路的区别（默认线路的写法见 server/ddns.ts 的 update*Values）：
  - 每次写都返回这条线路上面板管着的记录 ID，存进组的 ddnsLineState（带上是哪个服务商的）；
  - 删一条线路（不再有成员 / 按设置回落）时只删存下来的那些 ID，并且先列一遍这条线路确认这些 ID
    还在、还是这个名字、类型和线路 —— 别人在同一条线路上手加的记录不动；
  - 发布时和默认线路一样，同名同类型同线路的记录按值对账（这个名字归面板管，见 dnsManagedNames）。

  每家服务商一个 LineAdapter：线路列表、默认线路、怎么列 / 建 / 改 / 删一条线路上的记录。发布、删除
  的对账逻辑只有一份（下面的 publishDdnsLineRecords / deleteDdnsLineRecords）。
*/

export type DdnsLineTransport = (action: string, payload: Record<string, unknown>) => Promise<unknown>;
export type AliyunLineTransport = (action: string, params: Record<string, string | number | undefined>) => Promise<unknown>;
export type HuaweiLineTransport = (
  method: string,
  path: string,
  query: Record<string, string | number | undefined>,
  body?: unknown,
) => Promise<unknown>;

type Deps = {
  /** 拿一个能调 DNSPod 的函数；测试里换成假的。 */
  transport: (settings: DdnsSettings) => DdnsLineTransport;
  listLines: (rootDomain: string) => Promise<DnspodRecordLine[]>;
  /** 阿里云 DNS（签好名的 RPC 请求）。 */
  aliyun: (settings: DdnsSettings) => AliyunLineTransport;
  /** 华为云 DNS（签好名的 REST 请求）。 */
  huawei: (settings: DdnsSettings) => HuaweiLineTransport;
};

const defaultDeps: Deps = {
  transport: (settings) => (action, payload) => tencentCloudRequest(settings, action, payload),
  listLines: (rootDomain) => listDnspodRecordLines(rootDomain),
  aliyun: (settings) => (action, params) => aliyunRequest(settings, action, params),
  huawei: (settings) => (method, path, query, body) => huaweicloudRequest(settings, method, path, query, body),
};
let deps: Deps = defaultDeps;

/** 测试用：换掉服务商请求。传 null 恢复默认。 */
export function configureDdnsLineRecordsForTests(overrides: Partial<Deps> | null) {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
  huaweiZoneCache.clear();
}

export type DdnsLineSupport = {
  supported: boolean;
  /** 不支持时给人看的原因。 */
  reason: string | null;
  /** 能分线路时是哪家服务商。 */
  provider: DdnsLineProvider | null;
  /** 主域名（判断组域名在不在它下面用）。华为云按 Zone 走，设置里没有主域名，这里是 null。 */
  rootDomain: string | null;
};

const PROVIDER_LABELS: Record<string, string> = {
  cloudflare: "Cloudflare",
  webhook: "Webhook",
  huaweicloud: "华为云 DNS",
  aliyun: "阿里云 DNS",
  tencentcloud: "腾讯云 DNSPod",
};

export function ddnsLineProviderLabel(provider: string) {
  return PROVIDER_LABELS[provider] || provider;
}

const SUPPORTED_TEXT = "腾讯云 DNSPod、阿里云 DNS、华为云 DNS";

type LineRecordRow = { id: string; values: string[] };

type LineRecordSession = {
  /** 免费套餐 TTL 下限按这个记（同 server/ddns.ts 的 withProviderMinTtl）。 */
  zone: string;
  /** 这个名字、类型、线路上现在的记录（严格核对过名字 / 类型 / 线路、ID 格式对的）。 */
  list(): Promise<LineRecordRow[]>;
  /** 新建：逐值的服务商一次一个值；记录集的服务商一次全部值。返回新记录 ID（没回就是 null）。 */
  create(values: string[], ttl: number): Promise<string | null>;
  update(row: LineRecordRow, values: string[], ttl: number): Promise<void>;
  remove(row: LineRecordRow): Promise<void>;
};

type LineTarget = { domain: string; recordType: string; line: DdnsLineRef };

type LineAdapter = {
  provider: DdnsLineProvider;
  /** true：一个记录集装全部值（华为云）；false：一个值一条记录（DNSPod、阿里云）。 */
  recordSet: boolean;
  /** 已经判断过启用 / 服务商对得上，这里只看凭据填没填全。 */
  support(settings: DdnsSettings): DdnsLineSupport;
  defaultLine(settings: DdnsSettings): DdnsLineRef;
  listLines(settings: DdnsSettings, support: DdnsLineSupport): Promise<DdnsLineRef[]>;
  /** 组编辑框提示「入口域名不在主域名下」用；拿不到就是 null（不提示）。 */
  rootDomain(settings: DdnsSettings, support: DdnsLineSupport): Promise<string | null>;
  validRecordId(id: string): boolean;
  open(settings: DdnsSettings, target: LineTarget): Promise<LineRecordSession>;
  /** 把服务商的错误码翻成人话（记录条数上限、线路不支持……）；认不出的原样返回。 */
  explain(error: unknown, target: LineTarget): unknown;
};

function normalizeRecordValue(recordType: string, value: unknown) {
  const text = String(value ?? "").trim();
  return recordType === "CNAME" ? text.toLowerCase().replace(/\.+$/, "") : text;
}

function sameValues(recordType: string, left: readonly string[], right: readonly string[]) {
  const key = (values: readonly string[]) => Array.from(new Set(values.map((value) => normalizeRecordValue(recordType, value)).filter(Boolean))).sort().join(",");
  return key(left) === key(right);
}

function arrayOf(value: unknown): Array<Record<string, unknown> | null> {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
}

function providerCode(error: unknown) {
  return error instanceof DdnsProviderError ? error.code : "";
}

// ===== 腾讯云 DNSPod =====

const NUMERIC_RECORD_ID = /^\d{1,20}$/;

const dnspodAdapter: LineAdapter = {
  provider: "tencentcloud",
  recordSet: false,
  support(settings) {
    const rootDomain = normalizeManagedDnsName(settings.tencentcloudDomainName);
    if (!settings.tencentcloudSecretId.trim() || !settings.tencentcloudSecretKey.trim() || !rootDomain) {
      return { supported: false, reason: "腾讯云 DNSPod 的 SecretId / SecretKey 或主域名没有填全", provider: null, rootDomain: null };
    }
    return { supported: true, reason: null, provider: "tencentcloud", rootDomain };
  },
  /** DDNS 设置里填的线路（没填就是 DNSPod 的「默认」，线路 ID 0）。 */
  defaultLine(settings) {
    const name = settings.tencentcloudRecordLine.trim() || "默认";
    const id = settings.tencentcloudRecordLineId.trim() || (name === "默认" ? "0" : "");
    return { id, name };
  },
  async listLines(_settings, support) {
    return deps.listLines(String(support.rootDomain));
  },
  async rootDomain(_settings, support) {
    return support.rootDomain;
  },
  validRecordId: (id) => NUMERIC_RECORD_ID.test(id) && Number(id) > 0,
  async open(settings, target) {
    const { root, subDomain } = splitDdnsName(target.domain, settings.tencentcloudDomainName, "腾讯云 DNSPod");
    const transport = deps.transport(settings);
    const { recordType, line } = target;
    const payloadFor = (value: string, ttl: number) => {
      const payload: Record<string, unknown> = {
        Domain: root,
        SubDomain: subDomain,
        RecordType: recordType,
        RecordLine: line.name,
        Value: value,
        TTL: ttl,
      };
      if (line.id) payload.RecordLineId = line.id;
      return payload;
    };
    return {
      zone: root,
      async list() {
        const payload: Record<string, unknown> = {
          Domain: root,
          Subdomain: subDomain,
          RecordType: recordType,
          RecordLine: line.name,
          Limit: 3000,
          ErrorOnEmpty: "no",
        };
        if (line.id) payload.RecordLineId = line.id;
        const list = await transport("DescribeRecordList", payload) as { RecordList?: unknown } | null;
        return arrayOf(list?.RecordList)
          .filter((item) => (
            String(item?.Name || "") === subDomain
            && String(item?.Type || "").toUpperCase() === recordType
            // DNSPod 按 RecordLineId 过滤过了，这里再核对一遍：宁可漏改，不能动到别的线路。
            && (line.id ? String(item?.LineId ?? "") === line.id : String(item?.Line || "") === line.name)
          ))
          .map((item) => ({ id: String(item?.RecordId ?? "").trim(), values: [String(item?.Value ?? "")] }))
          .filter((row) => dnspodAdapter.validRecordId(row.id));
      },
      async create(values, ttl) {
        const response = await transport("CreateRecord", payloadFor(values[0], ttl));
        const id = String((response as { RecordId?: unknown } | null)?.RecordId ?? "").trim();
        return id || null;
      },
      async update(row, values, ttl) {
        await transport("ModifyRecord", { ...payloadFor(values[0], ttl), RecordId: Number(row.id) });
      },
      async remove(row) {
        await transport("DeleteRecord", { Domain: root, RecordId: Number(row.id) });
      },
    };
  },
  explain: (error) => error,
};

// ===== 阿里云 DNS =====

const ALIYUN_DEFAULT_LINE = "default";

/** 阿里云几条常用线路的中文名（默认线路的名字只给人看；线路列表以 DescribeSupportLines 为准）。 */
const ALIYUN_LINE_NAMES: Record<string, string> = {
  default: "默认",
  telecom: "中国电信",
  unicom: "中国联通",
  mobile: "中国移动",
  edu: "中国教育网",
  oversea: "境外",
  drpeng: "鹏博士",
  btvn: "广电网",
};

const aliyunAdapter: LineAdapter = {
  provider: "aliyun",
  recordSet: false,
  support(settings) {
    const rootDomain = normalizeManagedDnsName(settings.aliyunDomainName);
    if (!settings.aliyunAccessKeyId.trim() || !settings.aliyunAccessKeySecret.trim() || !rootDomain) {
      return { supported: false, reason: "阿里云 DNS 的 AccessKey ID / AccessKey Secret 或主域名没有填全", provider: null, rootDomain: null };
    }
    return { supported: true, reason: null, provider: "aliyun", rootDomain };
  },
  /** DDNS 设置里的「默认线路」（没填是 default），组原来那条记录就写在这里。 */
  defaultLine(settings) {
    const id = settings.aliyunLine.trim() || ALIYUN_DEFAULT_LINE;
    return { id, name: ALIYUN_LINE_NAMES[id] || id };
  },
  async listLines(settings, support) {
    const response = await deps.aliyun(settings)("DescribeSupportLines", { DomainName: String(support.rootDomain) }) as
      { RecordLines?: { RecordLine?: unknown } } | null;
    const lines = new Map<string, DdnsLineRef>();
    for (const raw of arrayOf(response?.RecordLines?.RecordLine)) {
      const line = normalizeDdnsLineRef({
        id: raw?.LineCode,
        name: raw?.LineDisplayName || raw?.LineName || ALIYUN_LINE_NAMES[String(raw?.LineCode || "")] || raw?.LineCode,
      });
      if (line && !lines.has(line.id)) lines.set(line.id, line);
    }
    // 任何套餐都有默认线路；一条都没有说明响应不对，不能让人以为什么线路都选不了。
    if (lines.size === 0) throw new DdnsProviderError("阿里云 DNS 没有返回线路列表（DescribeSupportLines），请稍后重试或检查 AccessKey 权限", "InvalidResponse");
    const fallback = aliyunAdapter.defaultLine(settings);
    if (!lines.has(fallback.id)) lines.set(fallback.id, fallback);
    return [...lines.values()];
  },
  async rootDomain(_settings, support) {
    return support.rootDomain;
  },
  validRecordId: (id) => NUMERIC_RECORD_ID.test(id) && Number(id) > 0,
  async open(settings, target) {
    const { root, rr } = splitDdnsName(target.domain, settings.aliyunDomainName, "阿里云");
    const subDomain = normalizeDdnsName(target.domain);
    const transport = deps.aliyun(settings);
    const { recordType, line } = target;
    const payloadFor = (value: string, ttl: number) => ({ RR: rr, Type: recordType, Value: value, Line: line.id, TTL: ttl });
    return {
      zone: root,
      async list() {
        const list = await transport("DescribeSubDomainRecords", {
          DomainName: root,
          SubDomain: subDomain,
          Type: recordType,
          Line: line.id,
          PageNumber: 1,
          PageSize: 100,
        }) as { DomainRecords?: { Record?: unknown } } | null;
        return arrayOf(list?.DomainRecords?.Record)
          .filter((item) => (
            String(item?.RR || "").toLowerCase() === rr
            && String(item?.Type || "").toUpperCase() === recordType
            // 请求里带了 Line，这里再核对一遍：别的线路的记录一条都不能碰。
            && String(item?.Line || "") === line.id
          ))
          .map((item) => ({ id: String(item?.RecordId ?? "").trim(), values: [String(item?.Value ?? "")] }))
          .filter((row) => aliyunAdapter.validRecordId(row.id));
      },
      async create(values, ttl) {
        const response = await transport("AddDomainRecord", { DomainName: root, ...payloadFor(values[0], ttl) });
        const id = String((response as { RecordId?: unknown } | null)?.RecordId ?? "").trim();
        return id || null;
      },
      async update(row, values, ttl) {
        await transport("UpdateDomainRecord", { RecordId: row.id, ...payloadFor(values[0], ttl) });
      },
      async remove(row) {
        await transport("DeleteDomainRecord", { RecordId: row.id });
      },
    };
  },
  explain(error, target) {
    const code = providerCode(error);
    if (!code) return error;
    const detail = `${code}：${(error as Error).message}`;
    if (/throttl/i.test(code)) return error;
    if (/quota|limit|exceed/i.test(code)) {
      return new DdnsProviderError(
        `阿里云 DNS 拒绝写入：${target.domain} 在线路「${target.line.name}」上的 ${target.recordType} 记录条数超出了套餐上限（${detail}）。减少这条线路上的成员，或者升级阿里云解析的套餐`,
        code,
      );
    }
    if (/line/i.test(code)) {
      return new DdnsProviderError(
        `阿里云 DNS 不接受线路「${target.line.name}」（${target.line.id}）：可能当前套餐不包含这条线路（${detail}）。换一条线路，或者升级阿里云解析的套餐`,
        code,
      );
    }
    return error;
  },
};

// ===== 华为云 DNS =====

const HUAWEI_DEFAULT_LINE = "default_view";

/*
  华为云没有列内置线路的 API（ListCustomLine / ListLineGroups 只列自定义线路和线路分组），这里是官方
  「解析线路列表」（support.huaweicloud.com/api-dns/zh-cn_topic_0085546214.html）里运营商一级线路和
  三大运营商的大区线路。省级线路、地域线路、自定义线路不在这里（要用的话可以在 DDNS 设置里把它填成默认线路）。
*/
const HUAWEI_REGIONS: Array<[string, string]> = [
  ["Huabei", "华北地区"],
  ["Dongbei", "东北地区"],
  ["Huadong", "华东地区"],
  ["Huazhong", "华中地区"],
  ["Huanan", "华南地区"],
  ["Xinan", "西南地区"],
  ["Xibei", "西北地区"],
];
const HUAWEI_LINES: DdnsLineRef[] = [
  { id: "default_view", name: "全网默认" },
  { id: "Dianxin", name: "电信" },
  { id: "Liantong", name: "联通" },
  { id: "Yidong", name: "移动" },
  { id: "Jiaoyuwang", name: "教育网" },
  { id: "Tietong", name: "铁通" },
  { id: "Pengboshi", name: "鹏博士" },
  { id: "CN", name: "中国大陆" },
  { id: "Abroad", name: "境外" },
  ...[["Dianxin", "电信"], ["Liantong", "联通"], ["Yidong", "移动"]].flatMap(([id, name]) => (
    HUAWEI_REGIONS.map(([region, regionName]) => ({ id: `${id}_${region}`, name: `${name}_${regionName}` }))
  )),
];

const HUAWEI_RECORD_SET_ID = /^[0-9A-Za-z_-]{1,64}$/;
const HUAWEI_ZONE_CACHE_MS = 10 * 60_000;
const huaweiZoneCache = new Map<string, { id: string; name: string; at: number }>();

function dnsCandidates(domain: string) {
  const labels = normalizeDdnsName(domain).split(".").filter(Boolean);
  const out: string[] = [];
  for (let index = 0; index < labels.length - 1; index += 1) out.push(labels.slice(index).join("."));
  return out;
}

function stripDot(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\.+$/, "");
}

/** 记录所在的公网 Zone（ID + 名字）。设置里填了 Zone ID 就按 ID 问名字，没填按域名往上找。缓存 10 分钟。 */
async function huaweiZone(settings: DdnsSettings, domain: string) {
  const configured = settings.huaweicloudZoneId.trim();
  const key = `${settings.huaweicloudAccessKeyId}|${settings.huaweicloudEndpoint}|${configured || `@${normalizeDdnsName(domain)}`}`;
  const cached = huaweiZoneCache.get(key);
  if (cached && Date.now() - cached.at < HUAWEI_ZONE_CACHE_MS) return cached;
  const transport = deps.huawei(settings);
  let zone: { id: string; name: string } | null = null;
  if (configured) {
    const body = await transport("GET", `/v2/zones/${encodeURIComponent(configured)}`, {}) as { id?: unknown; name?: unknown } | null;
    const name = stripDot(body?.name);
    if (!name) throw new DdnsProviderError(`华为云 DNS 没有返回 Zone ${configured} 的域名，请检查 DDNS 设置里的 Zone ID`, "InvalidResponse");
    zone = { id: configured, name };
  } else {
    for (const candidate of dnsCandidates(domain)) {
      const body = await transport("GET", "/v2/zones", { name: `${candidate}.`, limit: 100 }) as { zones?: unknown } | null;
      const match = arrayOf(body?.zones).find((item) => stripDot(item?.name) === candidate);
      if (match?.id) {
        zone = { id: String(match.id), name: candidate };
        break;
      }
    }
    if (!zone) throw new Error(`华为云 DNS 域名 ${domain} 不在主域名下：账号里没找到它所在的公网 Zone，请确认域名已托管或在 DDNS 设置里填写 Zone ID`);
  }
  const entry = { ...zone, at: Date.now() };
  if (huaweiZoneCache.size >= 256) huaweiZoneCache.clear();
  huaweiZoneCache.set(key, entry);
  return entry;
}

const huaweiAdapter: LineAdapter = {
  provider: "huaweicloud",
  recordSet: true,
  support(settings) {
    if (!settings.huaweicloudAccessKeyId.trim() || !settings.huaweicloudSecretKey.trim()) {
      return { supported: false, reason: "华为云 DNS 的 Access Key ID / Secret Access Key 没有填全", provider: null, rootDomain: null };
    }
    return { supported: true, reason: null, provider: "huaweicloud", rootDomain: null };
  },
  /** DDNS 设置里的「默认线路」（没填是 default_view 全网默认）。 */
  defaultLine(settings) {
    const id = settings.huaweicloudLine.trim() || HUAWEI_DEFAULT_LINE;
    return { id, name: HUAWEI_LINES.find((line) => line.id === id)?.name || id };
  },
  async listLines(settings) {
    const fallback = huaweiAdapter.defaultLine(settings);
    const lines = HUAWEI_LINES.map((line) => ({ ...line }));
    return lines.some((line) => line.id === fallback.id) ? lines : [fallback, ...lines];
  },
  async rootDomain(settings) {
    // 只有填了 Zone ID 才知道主域名；没填时每个名字各找各的 Zone，不提示。
    if (!settings.huaweicloudZoneId.trim()) return null;
    try {
      return (await huaweiZone(settings, "")).name;
    } catch {
      return null;
    }
  },
  validRecordId: (id) => HUAWEI_RECORD_SET_ID.test(id),
  async open(settings, target) {
    const zone = await huaweiZone(settings, target.domain);
    const domain = normalizeDdnsName(target.domain);
    if (domain !== zone.name && !domain.endsWith(`.${zone.name}`)) {
      throw new Error(`华为云 DNS 域名 ${target.domain} 不在主域名 ${zone.name} 下`);
    }
    const transport = deps.huawei(settings);
    const name = ddnsFqdn(target.domain);
    const { recordType, line } = target;
    const base = `/v2.1/zones/${encodeURIComponent(zone.id)}/recordsets`;
    return {
      zone: zone.name,
      async list() {
        const body = await transport("GET", base, {
          name,
          type: recordType,
          line_id: line.id,
          search_mode: "equal",
          limit: 500,
        }) as { recordsets?: unknown } | null;
        return arrayOf(body?.recordsets)
          .filter((item) => (
            stripDot(item?.name) === domain
            && String(item?.type || "").toUpperCase() === recordType
            // 请求里按 line_id 过滤过了，这里再严格核对一遍（没写线路的记录集也不算）。
            && String(item?.line ?? "") === line.id
          ))
          .map((item) => ({
            id: String(item?.id ?? "").trim(),
            values: (Array.isArray(item?.records) ? item.records : []).map((value: unknown) => String(value ?? "")),
          }))
          .filter((row) => huaweiAdapter.validRecordId(row.id));
      },
      async create(values, ttl) {
        const response = await transport("POST", base, {}, { name, type: recordType, ttl, records: values, line: line.id }) as { id?: unknown } | null;
        const id = String(response?.id ?? "").trim();
        return id || null;
      },
      async update(row, values, ttl) {
        // 华为云记录集建好后线路改不了，PUT 里不带 line。
        await transport("PUT", `${base}/${encodeURIComponent(row.id)}`, {}, { name, type: recordType, ttl, records: values });
      },
      async remove(row) {
        await transport("DELETE", `${base}/${encodeURIComponent(row.id)}`, {});
      },
    };
  },
  explain(error, target) {
    const code = providerCode(error);
    const detail = `${code}：${(error as Error)?.message}`;
    if (code === "DNS.0403") {
      return new DdnsProviderError(`华为云 DNS 记录集配额不足，没法在线路「${target.line.name}」上为 ${target.domain} 新建 ${target.recordType} 记录集（${detail}）。删掉不用的记录集或申请提高配额`, code);
    }
    if (code === "DNS.0806" || code === "DNS.0325") {
      return new DdnsProviderError(`华为云 DNS 这个域名不支持按线路解析，或这种记录只能用默认线路（${detail}）`, code);
    }
    if (code === "DNS.0312" || code === "DNS.0335" || code === "DNS.0016") {
      return new DdnsProviderError(`华为云 DNS 线路「${target.line.name}」上已经有 ${target.domain} 的同类型记录集（${detail}）。如果是刚建好还在生效中，下一轮会自动重新对账`, code);
    }
    return error;
  },
};

const ADAPTERS: Record<DdnsLineProvider, LineAdapter> = {
  tencentcloud: dnspodAdapter,
  aliyun: aliyunAdapter,
  huaweicloud: huaweiAdapter,
};

function adapterOf(provider: string): LineAdapter | null {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, provider) ? ADAPTERS[provider as DdnsLineProvider] : null;
}

/** 现在的 DDNS 设置能不能按线路解析。纯判断，不发请求。 */
export function ddnsLineSupport(settings: DdnsSettings): DdnsLineSupport {
  if (!settings.enabled || settings.provider === "disabled") {
    return { supported: false, reason: `系统 DDNS 没有启用：分线路解析需要先在 系统设置 → DDNS 里配好并启用其中一家：${SUPPORTED_TEXT}`, provider: null, rootDomain: null };
  }
  const adapter = adapterOf(settings.provider);
  if (!adapter) {
    return {
      supported: false,
      reason: `当前 DDNS 服务商（${ddnsLineProviderLabel(settings.provider)}）不支持按运营商线路解析；分线路解析支持${SUPPORTED_TEXT}`,
      provider: null,
      rootDomain: null,
    };
  }
  return adapter.support(settings);
}

/**
 * 组的「默认线路」：DDNS 设置里填的线路（没填就是各家的默认：DNSPod「默认」/ 线路 ID 0、
 * 阿里云 default、华为云 default_view）。组原来那条记录就写在这条线路上，分线路解析不改它。
 */
export function ddnsDefaultLine(settings: DdnsSettings): DdnsLineRef {
  return (adapterOf(settings.provider) || dnspodAdapter).defaultLine(settings);
}

/** 线路列表 / 默认线路带上服务商（DNSPod 不带，和老数据一个形状）。 */
function tagLine(line: DdnsLineRef, provider: DdnsLineProvider): DdnsLineRef {
  return normalizeDdnsLineRef({ ...line, provider }) || { id: line.id, name: line.name };
}

/** 给组编辑框用：能不能分线路、能选哪些线路。 */
export async function listDdnsLinesForGroups(domainValue?: string | null) {
  return listDdnsLinesForSettings(await getDdnsSettings(), domainValue);
}

export async function listDdnsLinesForSettings(settings: DdnsSettings, domainValue?: string | null) {
  const support = ddnsLineSupport(settings);
  const adapter = support.supported && support.provider ? ADAPTERS[support.provider] : null;
  const providerLabel = ddnsLineProviderLabel(settings.provider);
  if (!adapter || !support.provider) {
    return {
      supported: false as const,
      reason: support.reason,
      provider: null,
      providerLabel,
      rootDomain: null,
      defaultLine: ddnsDefaultLine(settings),
      lines: [] as DdnsLineRef[],
      domainWarning: null,
    };
  }
  const provider = support.provider;
  const rootDomain = await adapter.rootDomain(settings, support);
  const domain = normalizeManagedDnsName(domainValue);
  const domainWarning = rootDomain && domain && domain !== rootDomain && !domain.endsWith(`.${rootDomain}`)
    ? `入口域名 ${domain} 不在 ${providerLabel} 的主域名 ${rootDomain} 下，面板写不了它的记录`
    : null;
  const lines = (await adapter.listLines(settings, support)).map((line) => tagLine(line, provider));
  return {
    supported: true as const,
    reason: null,
    provider,
    providerLabel,
    rootDomain,
    defaultLine: tagLine(adapter.defaultLine(settings), provider),
    lines,
    domainWarning,
  };
}

export type DdnsLineRecordTarget = {
  domain: string;
  recordType: string;
  line: DdnsLineRef;
};

function assertSupported(settings: DdnsSettings): LineAdapter {
  const support = ddnsLineSupport(settings);
  if (!support.supported || !support.provider) throw new Error(support.reason || "当前 DDNS 服务商不支持分线路解析");
  return ADAPTERS[support.provider];
}

/** 每条线路一把锁：不同线路的记录互不相干，同一条线路的对账不能交错。 */
function lockKey(settings: DdnsSettings, target: DdnsLineRecordTarget) {
  return `${ddnsRecordLockKey(settings, target)}:line:${target.line.id || target.line.name}`;
}

function ttlFallback(settings: DdnsSettings, provider: DdnsLineProvider) {
  if (provider === "aliyun") return settings.aliyunTtl;
  if (provider === "huaweicloud") return settings.huaweicloudTtl;
  return settings.tencentcloudTtl;
}

/**
 * 把一条线路上的记录改成 values（非空）。返回之后这条线路上面板管着的记录 ID。
 */
export async function publishDdnsLineRecords(
  settings: DdnsSettings,
  target: DdnsLineRecordTarget & { values: string[]; ttl?: number },
): Promise<{ recordIds: string[]; writes: number }> {
  const adapter = assertSupported(settings);
  const recordType = String(target.recordType || "A").trim().toUpperCase();
  const values = uniqueDdnsValues(target.values.map((value) => normalizeRecordValue(recordType, value)));
  if (values.length === 0) throw new Error("线路记录不能为空：要删掉请走删除");
  if (recordType === "CNAME" && values.length > 1) throw new Error("CNAME 记录只能指向一个值");
  const lineTarget: LineTarget = { domain: target.domain, recordType, line: target.line };
  const session = await adapter.open(settings, lineTarget);
  const ttl = parseDdnsTtl(target.ttl, ttlFallback(settings, adapter.provider));
  return withKeyedTaskLock(lockKey(settings, lineTarget), async () => {
    try {
      return adapter.recordSet
        ? await publishRecordSet(adapter, session, recordType, values, ttl)
        : await publishPerValue(adapter, session, recordType, values, ttl);
    } catch (error) {
      throw adapter.explain(error, lineTarget);
    }
  });
}

/** DNSPod、阿里云：一个值一条记录，按值对账（改值复用原来的记录 ID）。 */
async function publishPerValue(adapter: LineAdapter, session: LineRecordSession, recordType: string, values: string[], ttl: number) {
  const existing = await session.list();
  const plan = planDdnsValueChanges(existing, values, (record) => normalizeRecordValue(recordType, record.values[0]));
  const kept = existing
    .filter((record) => !plan.removals.includes(record) && !plan.updates.some((change) => change.record === record))
    .map((record) => record.id);
  let writes = 0;
  let created: string[] = [];
  await withProviderMinTtl(adapter.provider, session.zone, ttl, async (effectiveTtl) => {
    created = [];
    for (const change of plan.updates) {
      await session.update(change.record, [change.value], effectiveTtl);
      writes += 1;
    }
    for (const value of plan.creates) {
      const id = await session.create([value], effectiveTtl);
      writes += 1;
      if (id && adapter.validRecordId(id)) created.push(id);
    }
  });
  for (const record of plan.removals) {
    await session.remove(record);
    writes += 1;
  }
  let recordIds = [...kept, ...plan.updates.map((change) => change.record.id), ...created];
  if (created.length < plan.creates.length) {
    // 新建没回记录 ID（不该发生）：重新列一遍拿 ID，不然以后删不到它。
    recordIds = (await session.list()).map((record) => record.id);
  }
  return { recordIds: Array.from(new Set(recordIds)), writes };
}

/**
 * 华为云：一个名字 / 类型 / 线路一个记录集，值全在 records[] 里。值一样的记录集留着（不写），
 * 否则改第一个；同一线路上多出来的同名同类型记录集（这个名字归面板管）删掉，和逐值对账时删多余记录一致。
 */
async function publishRecordSet(adapter: LineAdapter, session: LineRecordSession, recordType: string, values: string[], ttl: number) {
  const existing = await session.list();
  const keeper = existing.find((row) => sameValues(recordType, row.values, values)) || existing[0] || null;
  let writes = 0;
  let createdId: string | null = null;
  await withProviderMinTtl(adapter.provider, session.zone, ttl, async (effectiveTtl) => {
    if (!keeper) {
      createdId = await session.create(values, effectiveTtl);
      writes += 1;
    } else if (!sameValues(recordType, keeper.values, values)) {
      await session.update(keeper, values, effectiveTtl);
      writes += 1;
    }
  });
  for (const row of existing) {
    if (row === keeper) continue;
    await session.remove(row);
    writes += 1;
  }
  if (keeper) return { recordIds: [keeper.id], writes };
  const id = createdId as string | null;
  if (id && adapter.validRecordId(id)) return { recordIds: [id], writes };
  return { recordIds: (await session.list()).map((row) => row.id), writes };
}

/**
 * 删掉一条线路上面板写过的记录：只删 recordIds 里、此刻仍在这个名字 / 类型 / 线路上的。
 * 返回删掉的 ID 和没删的（不是面板写的）记录数。
 */
export async function deleteDdnsLineRecords(
  settings: DdnsSettings,
  target: DdnsLineRecordTarget & { recordIds: string[] },
): Promise<{ deleted: string[]; untouched: number }> {
  const adapter = assertSupported(settings);
  const tracked = new Set(target.recordIds.map((id) => String(id).trim()).filter((id) => adapter.validRecordId(id)));
  if (tracked.size === 0) return { deleted: [], untouched: 0 };
  const recordType = String(target.recordType || "A").trim().toUpperCase();
  const lineTarget: LineTarget = { domain: target.domain, recordType, line: target.line };
  const session = await adapter.open(settings, lineTarget);
  return withKeyedTaskLock(lockKey(settings, lineTarget), async () => {
    const existing = await session.list();
    const deleted: string[] = [];
    for (const record of existing) {
      if (!tracked.has(record.id)) continue;
      await session.remove(record);
      deleted.push(record.id);
    }
    return { deleted, untouched: existing.length - deleted.length };
  });
}
