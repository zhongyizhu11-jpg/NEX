/*
  流媒体 / AI 解锁检测（Agent 2.2.226 起）—— 面板和界面共用的那一份：服务表、状态、校验、摘要。

  检测在 Agent 上跑（agent/unlock_check.go，服务表 unlockServices 的 ID 和这里一一对应），
  结果经扩展模块 "unlock" 回到面板（server/ops/unlockAgent.ts，逻辑在 unlock.ts），存在 host_unlock_checks。
  每一项只有四种结论：ok 可用 / partial 部分可用 / blocked 不可用 / unknown 无法判断。
  这些都是按页面标记猜的，服务改了页面就可能不准（见 docs/guide/hosts.md）。
*/

export const UNLOCK_MIN_AGENT_VERSION = "2.2.226";

export const UNLOCK_STATUSES = ["ok", "partial", "blocked", "unknown"] as const;
export type UnlockStatus = (typeof UNLOCK_STATUSES)[number];

export const UNLOCK_FAMILIES = ["auto", "ipv4", "ipv6"] as const;
export type UnlockFamily = (typeof UNLOCK_FAMILIES)[number];

export const UNLOCK_FAMILY_LABELS: Record<UnlockFamily, string> = { auto: "自动", ipv4: "IPv4", ipv6: "IPv6" };

export const UNLOCK_SCHEDULES = ["off", "daily", "weekly"] as const;
export type UnlockSchedule = (typeof UNLOCK_SCHEDULES)[number];
export const UNLOCK_SCHEDULE_LABELS: Record<UnlockSchedule, string> = { off: "关闭", daily: "每天", weekly: "每周" };

export type UnlockServiceDef = {
  id: string;
  name: string;
  /** 主机卡上那一小条摘要用的短名。 */
  short: string;
  kind: "media" | "ai";
  /** 在主机卡摘要里出现（只挑最常被问的几个，卡片放不下全部）。 */
  chip?: boolean;
};

export const UNLOCK_SERVICES: readonly UnlockServiceDef[] = [
  { id: "netflix", name: "Netflix", short: "NF", kind: "media", chip: true },
  { id: "disney", name: "Disney+", short: "D+", kind: "media" },
  { id: "youtube_premium", name: "YouTube Premium", short: "YT", kind: "media" },
  { id: "tiktok", name: "TikTok", short: "TikTok", kind: "media" },
  { id: "chatgpt", name: "ChatGPT", short: "GPT", kind: "ai", chip: true },
  { id: "claude", name: "Claude", short: "Claude", kind: "ai", chip: true },
  { id: "gemini", name: "Gemini", short: "Gemini", kind: "ai", chip: true },
  { id: "grok", name: "Grok", short: "Grok", kind: "ai" },
  { id: "perplexity", name: "Perplexity", short: "PPLX", kind: "ai" },
];

const SERVICE_BY_ID = new Map(UNLOCK_SERVICES.map((service) => [service.id, service]));

export function unlockServiceDef(id: string): UnlockServiceDef | undefined {
  return SERVICE_BY_ID.get(id);
}

export const UNLOCK_STATUS_LABELS: Record<UnlockStatus, string> = {
  ok: "可用",
  partial: "部分可用",
  blocked: "不可用",
  unknown: "无法判断",
};

export type UnlockServiceResult = {
  service: string;
  status: UnlockStatus;
  region: string | null;
  detail: string;
  ms: number | null;
};

export type UnlockRunView = {
  family: UnlockFamily;
  checkedAt: number;
  results: UnlockServiceResult[];
};

export function normalizeUnlockFamily(value: unknown): UnlockFamily {
  return (UNLOCK_FAMILIES as readonly string[]).includes(String(value)) ? (value as UnlockFamily) : "auto";
}

export function normalizeUnlockSchedule(value: unknown): UnlockSchedule {
  return (UNLOCK_SCHEDULES as readonly string[]).includes(String(value)) ? (value as UnlockSchedule) : "off";
}

/** 计划检测的周期（秒）；关着是 null。 */
export function unlockScheduleIntervalSeconds(schedule: UnlockSchedule): number | null {
  if (schedule === "daily") return 24 * 3600;
  if (schedule === "weekly") return 7 * 24 * 3600;
  return null;
}

function cleanText(value: unknown, max: number) {
  // 控制字符一律去掉（结果直接上界面，也进日志）。
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

/**
 * 校验 Agent 报上来的一组结果：只认服务表里有的服务、四种状态、2~3 位大写地区码；
 * 同一个服务报了多次取第一次；顺序按服务表排。不合格的条目直接丢掉，整组不是数组就返回 null。
 */
export function normalizeUnlockResults(raw: unknown): UnlockServiceResult[] | null {
  if (!Array.isArray(raw)) return null;
  const byService = new Map<string, UnlockServiceResult>();
  for (const item of raw.slice(0, 64)) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const service = String(entry.service || "");
    if (!SERVICE_BY_ID.has(service) || byService.has(service)) continue;
    const status = (UNLOCK_STATUSES as readonly string[]).includes(String(entry.status)) ? (entry.status as UnlockStatus) : "unknown";
    const regionText = String(entry.region || "").trim().toUpperCase();
    const region = /^[A-Z]{2,3}$/.test(regionText) ? regionText : null;
    const msValue = Number(entry.ms);
    byService.set(service, {
      service,
      status,
      region,
      detail: cleanText(entry.detail, 160),
      ms: Number.isFinite(msValue) && msValue >= 0 ? Math.min(Math.round(msValue), 600_000) : null,
    });
  }
  return UNLOCK_SERVICES.map((def) => byService.get(def.id)).filter((value): value is UnlockServiceResult => !!value);
}

function chipMark(service: string, status: UnlockStatus) {
  if (service === "netflix") {
    if (status === "ok") return "全解";
    if (status === "partial") return "自制";
  }
  if (status === "ok") return "✓";
  if (status === "partial") return "半";
  if (status === "blocked") return "✗";
  return "?";
}

export type UnlockChipItem = { service: string; text: string; status: UnlockStatus };

/** 主机卡上的摘要条目：「NF 全解」「GPT ✓」「Claude ✗」…… 只取 chip 标记过的服务。 */
export function unlockChipItems(results: readonly Pick<UnlockServiceResult, "service" | "status">[]): UnlockChipItem[] {
  const byService = new Map(results.map((item) => [item.service, item.status]));
  const items: UnlockChipItem[] = [];
  for (const def of UNLOCK_SERVICES) {
    if (!def.chip) continue;
    const status = byService.get(def.id);
    if (!status) continue;
    items.push({ service: def.id, status, text: `${def.short} ${chipMark(def.id, status)}` });
  }
  return items;
}

export function unlockChipText(results: readonly Pick<UnlockServiceResult, "service" | "status">[]) {
  return unlockChipItems(results).map((item) => item.text).join(" · ");
}
