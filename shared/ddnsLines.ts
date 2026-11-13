/*
  入口组 / 转发组成员的「运营商线路」（分线路解析）。

  一个组只有一个入口域名；DNS 服务商（腾讯云 DNSPod、阿里云 DNS、华为云 DNS）可以按解析来源的运营商给同一个
  名字返回不同的记录：电信用户拿到 A、联通用户拿到 B、其余（默认线路）拿到 C。这里是两边共用的
  数据形状和规整函数，规划在 server/ddnsLinePlanner.ts，写服务商在 server/ddnsLineRecords.ts。

  存法：
  - 成员上的 ddnsLines：JSON 数组 [{ id, name, provider? }]，id 是服务商的线路 ID（DNSPod「电信」= "10=0"、
    阿里云 = "telecom"、华为云 = "Dianxin"），name 只给人看、也给 DNSPod 当 RecordLine 名字用。
    provider 是这条线路属于哪个服务商：没有 = 腾讯云 DNSPod（2.3.529 之前只有 DNSPod，老数据一个字节不变，
    DNSPod 的线路也照旧不写 provider）。换了服务商，别家的线路自动不算（成员等于只在默认线路），
    界面上标「已不可用」让人取消勾选。空 / null = 没分线路，和以前一样只在默认线路；
  - 组上的 ddnsLineFallback：某条线路的成员全挂了怎么办（见 DDNS_LINE_FALLBACK_MODES）；
  - 组上的 ddnsLineState：面板此刻在每条非默认线路上发布了什么、服务商记录 ID 是哪些
    （删线路时只按这些 ID 删，不碰别人加的记录），以及这些 ID 是哪个服务商的（provider，老数据没有 =
    DNSPod）。换了服务商时旧 ID 绝不拿去新服务商那边删。运行状态，不是配置。
*/

/** 能分线路的 DDNS 服务商。 */
export const DDNS_LINE_PROVIDERS = ["tencentcloud", "aliyun", "huaweicloud"] as const;
export type DdnsLineProvider = (typeof DDNS_LINE_PROVIDERS)[number];

/** 老数据没写 provider 的线路 / 线路状态都是 DNSPod 的（2.3.529 之前只有它能分线路）。 */
const LEGACY_DDNS_LINE_PROVIDER: DdnsLineProvider = "tencentcloud";

function normalizeDdnsLineProvider(value: unknown): DdnsLineProvider | null {
  return (DDNS_LINE_PROVIDERS as readonly string[]).includes(String(value ?? "")) ? value as DdnsLineProvider : null;
}

export type DdnsLineRef = {
  id: string;
  name: string;
  /** 这条线路属于哪个服务商；没有 = 腾讯云 DNSPod。只在成员的线路配置和线路列表上有。 */
  provider?: DdnsLineProvider;
};

/** 线路实际所属的服务商（没写 = DNSPod）。 */
export function ddnsLineProviderOf(line: Pick<DdnsLineRef, "provider">): DdnsLineProvider {
  return line.provider || LEGACY_DDNS_LINE_PROVIDER;
}

/** 线路的唯一键：服务商 + 线路 ID（不同服务商的线路 ID 互不相干）。 */
export function ddnsLineKey(line: Pick<DdnsLineRef, "id" | "provider">) {
  return `${ddnsLineProviderOf(line)}:${line.id}`;
}

/** 成员的线路配置里属于 provider 的那几条（去掉 provider 字段，给规划和写服务商用）。 */
export function ddnsLinesForProvider(value: unknown, provider: string): DdnsLineRef[] {
  return parseDdnsLines(value)
    .filter((line) => ddnsLineProviderOf(line) === provider)
    .map((line) => ({ id: line.id, name: line.name }));
}

/** 一个成员最多分几条线路。免费套餐的线路本来就不多，再多基本是误操作。 */
export const MAX_MEMBER_DDNS_LINES = 8;

/**
 * 线路成员全挂了：
 * - default（默认，推荐）：这条线路改成默认线路的健康成员 —— 记录一直在，恢复时只是改值；
 * - remove：删掉这条线路的记录，让服务商把这条线路的用户回落到默认线路。依赖服务商的回落行为，
 *   而且恢复时要重新建记录，切换期间会多一次删除 / 新建。
 */
export const DDNS_LINE_FALLBACK_MODES = ["default", "remove"] as const;
export type DdnsLineFallbackMode = (typeof DDNS_LINE_FALLBACK_MODES)[number];

export const DDNS_LINE_FALLBACK_LABELS: Record<DdnsLineFallbackMode, string> = {
  default: "改用默认线路的健康成员",
  remove: "删掉这条线路的记录（回落到默认线路）",
};

export function normalizeDdnsLineFallback(value: unknown): DdnsLineFallbackMode {
  return value === "remove" ? "remove" : "default";
}

const LINE_ID_PATTERN = /^[0-9A-Za-z=_.:-]{1,64}$/;
const RECORD_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;

function cleanText(value: unknown, max: number) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

/** 规整一条线路；认不出来的返回 null。provider 是 DNSPod（或认不出）时不写，和老数据同一个形状。 */
export function normalizeDdnsLineRef(value: unknown): DdnsLineRef | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = cleanText(raw.id, 64);
  const name = cleanText(raw.name, 64);
  if (!id || !LINE_ID_PATTERN.test(id)) return null;
  const provider = normalizeDdnsLineProvider(raw.provider);
  return provider && provider !== LEGACY_DDNS_LINE_PROVIDER ? { id, name: name || id, provider } : { id, name: name || id };
}

/** 库里的 ddnsLines（JSON 文本、数组、null）→ 去重后的线路列表。坏数据当成没分线路。 */
export function parseDdnsLines(value: unknown): DdnsLineRef[] {
  let raw: unknown = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      raw = JSON.parse(text);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: DdnsLineRef[] = [];
  for (const item of raw) {
    const line = normalizeDdnsLineRef(item);
    if (!line || out.some((existing) => ddnsLineKey(existing) === ddnsLineKey(line))) continue;
    out.push(line);
    if (out.length >= MAX_MEMBER_DDNS_LINES) break;
  }
  return out;
}

/** 存库用：没分线路存 null（和老数据一样），有就按 id 排好存，签名比较时不受勾选顺序影响。 */
export function serializeDdnsLines(value: unknown): string | null {
  const order = (line: DdnsLineRef) => `${line.id}\u0000${line.provider || ""}`;
  const lines = parseDdnsLines(value).sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  return lines.length > 0 ? JSON.stringify(lines) : null;
}

/** 某条线路此刻在服务商那边是怎么来的。 */
export type DdnsLineSource =
  /** 线路自己的健康成员。 */
  | "members"
  /** 线路成员全挂了，用的是默认线路的健康成员。 */
  | "fallback"
  /** 线路和默认线路都没有健康成员，保留上一次的记录。 */
  | "hold";

export type DdnsLineStateEntry = {
  id: string;
  name: string;
  values: string[];
  /** 面板写过的服务商记录 ID。删这条线路时只删这些。 */
  recordIds: string[];
  memberIds: number[];
  source: DdnsLineSource;
  at: string;
};

export type DdnsLineState = {
  v: 1;
  /** 这些记录 ID 是哪个服务商的。老数据没有这个字段 = DNSPod；认不出的是 unknown（谁都对不上）。 */
  provider: DdnsLineProvider | "unknown";
  /** 这些记录写在哪个名字、哪种记录类型下（组改了域名 / 记录类型时按这里清掉旧的）。 */
  domain: string;
  recordType: string;
  lines: Record<string, DdnsLineStateEntry>;
};

function stringList(value: unknown, max = 64) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, 2048)).filter(Boolean).slice(0, max);
}

/** 库里的 ddnsLineState → 结构；坏数据当成空（null）。 */
export function parseDdnsLineState(value: unknown): DdnsLineState | null {
  let raw: unknown = value;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const linesRaw = record.lines;
  if (!linesRaw || typeof linesRaw !== "object" || Array.isArray(linesRaw)) return null;
  const lines: Record<string, DdnsLineStateEntry> = {};
  for (const [key, entryRaw] of Object.entries(linesRaw as Record<string, unknown>)) {
    const line = normalizeDdnsLineRef(entryRaw);
    if (!line || line.id !== key) continue;
    const entry = entryRaw as Record<string, unknown>;
    const source = entry.source === "fallback" || entry.source === "hold" ? entry.source : "members";
    lines[key] = {
      ...line,
      values: stringList(entry.values),
      // DNSPod / 阿里云是数字，华为云记录集 ID 是 32 位十六进制。写服务商前各家还会按自己的格式再核对一遍。
      recordIds: stringList(entry.recordIds).filter((id) => RECORD_ID_PATTERN.test(id)),
      memberIds: Array.isArray(entry.memberIds)
        ? entry.memberIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
        : [],
      source,
      at: cleanText(entry.at, 40),
    };
  }
  return {
    v: 1,
    provider: record.provider === undefined || record.provider === null || record.provider === ""
      ? LEGACY_DDNS_LINE_PROVIDER
      // 认不出的服务商：当成一个谁都对不上的值，后面会当作「换了服务商」处理，绝不拿它的 ID 去删。
      : normalizeDdnsLineProvider(record.provider) || "unknown",
    domain: cleanText(record.domain, 253).toLowerCase(),
    recordType: cleanText(record.recordType, 16).toUpperCase(),
    lines,
  };
}

/** 组里有没有成员分了线路。 */
export function groupHasDdnsLineAssignments(members: Array<{ ddnsLines?: unknown; isEnabled?: unknown }> | null | undefined) {
  return (members || []).some((member) => parseDdnsLines(member?.ddnsLines).length > 0);
}

export const DDNS_LINE_SOURCE_LABELS: Record<DdnsLineSource, string> = {
  members: "线路成员",
  fallback: "线路成员全不可用，暂用默认线路",
  hold: "都不可用，保留上一次解析",
};
