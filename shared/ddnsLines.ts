/*
  入口组 / 转发组成员的「运营商线路」（分线路解析）。

  一个组只有一个入口域名；DNS 服务商（目前只有腾讯云 DNSPod）可以按解析来源的运营商给同一个
  名字返回不同的记录：电信用户拿到 A、联通用户拿到 B、其余（默认线路）拿到 C。这里是两边共用的
  数据形状和规整函数，规划在 server/ddnsLinePlanner.ts，写服务商在 server/ddnsLineRecords.ts。

  存法：
  - 成员上的 ddnsLines：JSON 数组 [{ id, name }]，id 是服务商的线路 ID（DNSPod「电信」= "10=0"），
    name 只给人看、也给服务商当 RecordLine 名字用。空 / null = 没分线路，和以前一样只在默认线路；
  - 组上的 ddnsLineFallback：某条线路的成员全挂了怎么办（见 DDNS_LINE_FALLBACK_MODES）；
  - 组上的 ddnsLineState：面板此刻在每条非默认线路上发布了什么、服务商记录 ID 是哪些
    （删线路时只按这些 ID 删，不碰别人加的记录）。运行状态，不是配置。
*/

export type DdnsLineRef = { id: string; name: string };

/** 一个成员最多分几条线路。DNSPod 免费套餐的线路本来就不多，再多基本是误操作。 */
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

function cleanText(value: unknown, max: number) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

/** 规整一条线路；认不出来的返回 null。 */
export function normalizeDdnsLineRef(value: unknown): DdnsLineRef | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = cleanText(raw.id, 64);
  const name = cleanText(raw.name, 64);
  if (!id || !LINE_ID_PATTERN.test(id)) return null;
  return { id, name: name || id };
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
    if (!line || out.some((existing) => existing.id === line.id)) continue;
    out.push(line);
    if (out.length >= MAX_MEMBER_DDNS_LINES) break;
  }
  return out;
}

/** 存库用：没分线路存 null（和老数据一样），有就按 id 排好存，签名比较时不受勾选顺序影响。 */
export function serializeDdnsLines(value: unknown): string | null {
  const lines = parseDdnsLines(value).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
      recordIds: stringList(entry.recordIds).filter((id) => /^\d{1,20}$/.test(id)),
      memberIds: Array.isArray(entry.memberIds)
        ? entry.memberIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
        : [],
      source,
      at: cleanText(entry.at, 40),
    };
  }
  return {
    v: 1,
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
