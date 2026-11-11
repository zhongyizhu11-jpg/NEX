/*
  流媒体 / AI 解锁检测（Agent 2.2.226 起）—— 面板和界面共用的那一份：服务表、状态、校验、摘要。

  检测在 Agent 上跑（agent/unlock_check.go，服务表 unlockServices 的 ID 和这里一一对应），
  结果经扩展模块 "unlock" 回到面板（server/ops/unlockAgent.ts，逻辑在 unlock.ts），存在 host_unlock_checks。
  每一项只有四种结论：ok 可用 / partial 部分可用 / blocked 不可用 / unknown 无法判断。
  这些都是按页面标记猜的，服务改了页面就可能不准（见 docs/guide/hosts.md）。
*/


export const UNLOCK_STATUSES = ["ok", "partial", "blocked", "unknown"] as const;
export type UnlockStatus = (typeof UNLOCK_STATUSES)[number];

export const UNLOCK_FAMILIES = ["auto", "ipv4", "ipv6"] as const;
export type UnlockFamily = (typeof UNLOCK_FAMILIES)[number];

/**
 * Prime Video、Spotify、Steam、Bilibili 港澳台这四项是 Agent 2.2.253 起才有的检测
 * （agent/unlock_check.go）。更旧的 Agent 交上来的结果里没有它们，界面提示升级，不当成「检测失败」。
 */
export const UNLOCK_EXTENDED_AGENT_VERSION = "2.2.253";

export const UNLOCK_SCHEDULES = ["off", "daily", "weekly"] as const;
export type UnlockSchedule = (typeof UNLOCK_SCHEDULES)[number];

export type UnlockServiceDef = {
  id: string;
  name: string;
  /** 主机卡上那一小条摘要用的短名。 */
  short: string;
  kind: "media" | "ai";
  /** 在主机卡摘要里出现（只挑最常被问的几个，卡片放不下全部）。 */
  chip?: boolean;
  /** 地区字段是什么：国家码（默认）还是商店币种（Steam 只给得出币种）。 */
  regionKind?: "country" | "currency";
  /** 从哪个版本的 Agent 起才有这一项。 */
  sinceAgent?: string;
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
  { id: "prime_video", name: "Prime Video", short: "PV", kind: "media", sinceAgent: UNLOCK_EXTENDED_AGENT_VERSION },
  { id: "spotify", name: "Spotify 注册", short: "Spotify", kind: "media", sinceAgent: UNLOCK_EXTENDED_AGENT_VERSION },
  { id: "steam", name: "Steam 商店", short: "Steam", kind: "media", regionKind: "currency", sinceAgent: UNLOCK_EXTENDED_AGENT_VERSION },
  { id: "bilibili_hmt", name: "Bilibili 港澳台", short: "B站", kind: "media", sinceAgent: UNLOCK_EXTENDED_AGENT_VERSION },
];

const SERVICE_BY_ID = new Map(UNLOCK_SERVICES.map((service) => [service.id, service]));

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

// ---------------------------------------------------------------- 带地区的显示

/**
 * 详情里每一项的说法：解锁 / 仅自制 / 部分解锁 / 屏蔽 / 检测失败。
 * 和上面四种存库状态一一对应，只是换成看流媒体的人习惯的叫法（Netflix 的 partial 就是「仅自制剧」）。
 * unknown 叫「检测失败」：页面认不出来、被人机验证挡住、请求失败 —— 都是没测成，不是结论。
 */
export function unlockDisplayLabel(service: string, status: UnlockStatus): string {
  if (status === "ok") return "解锁";
  if (status === "partial") return service === "netflix" ? "仅自制" : "部分解锁";
  if (status === "blocked") return "屏蔽";
  return "检测失败";
}

/** 地区字段怎么写：国家码原样，Steam 写成「币种 USD」。 */
export function unlockRegionText(service: string, region: string | null | undefined): string | null {
  const code = String(region || "").trim().toUpperCase();
  if (!code) return null;
  return SERVICE_BY_ID.get(service)?.regionKind === "currency" ? `币种 ${code}` : code;
}

/** Gemini 给三位国家码，常见的几个折成两位，好和主机所在地比。 */
const ALPHA3_TO_ALPHA2: Record<string, string> = {
  USA: "US", CAN: "CA", MEX: "MX", BRA: "BR", ARG: "AR", CHL: "CL", GBR: "GB", DEU: "DE", FRA: "FR", NLD: "NL",
  ITA: "IT", ESP: "ES", PRT: "PT", CHE: "CH", AUT: "AT", BEL: "BE", SWE: "SE", NOR: "NO", DNK: "DK", FIN: "FI",
  POL: "PL", IRL: "IE", RUS: "RU", UKR: "UA", TUR: "TR", ARE: "AE", SAU: "SA", ISR: "IL", IND: "IN", PAK: "PK",
  CHN: "CN", HKG: "HK", MAC: "MO", TWN: "TW", JPN: "JP", KOR: "KR", SGP: "SG", MYS: "MY", THA: "TH", VNM: "VN",
  PHL: "PH", IDN: "ID", AUS: "AU", NZL: "NZ", ZAF: "ZA", EGY: "EG", NGA: "NG", KEN: "KE", ROU: "RO", CZE: "CZ",
  HUN: "HU", GRC: "GR", BGR: "BG", SRB: "RS", HRV: "HR", LUX: "LU", ISL: "IS", KAZ: "KZ",
};

/** Steam 的币种对应哪些国家（欧元区算一组）。USD 只算美国：Steam 在不少地区也标美元，那种情况会显示成跨区。 */
const CURRENCY_COUNTRIES: Record<string, readonly string[]> = {
  USD: ["US"], CNY: ["CN"], HKD: ["HK"], TWD: ["TW"], JPY: ["JP"], KRW: ["KR"], SGD: ["SG"], GBP: ["GB"],
  AUD: ["AU"], NZD: ["NZ"], CAD: ["CA"], RUB: ["RU"], UAH: ["UA"], INR: ["IN"], BRL: ["BR"], MXN: ["MX"],
  TRY: ["TR"], MYR: ["MY"], THB: ["TH"], IDR: ["ID"], PHP: ["PH"], VND: ["VN"], CHF: ["CH", "LI"], NOK: ["NO"],
  PLN: ["PL"], ZAR: ["ZA"], AED: ["AE"], SAR: ["SA"], ILS: ["IL"], KZT: ["KZ"], CLP: ["CL"], COP: ["CO"], PEN: ["PE"],
  EUR: ["DE", "FR", "NL", "IT", "ES", "PT", "AT", "BE", "FI", "IE", "LU", "GR", "SK", "SI", "EE", "LV", "LT", "MT", "CY", "HR"],
};

export type UnlockRegionTone = "match" | "mismatch" | "china" | "none";

/**
 * 地区和主机所在地比一比：一致绿、跨区橙、不在中国的机器却被认成 CN 红（多半是回国线路的出口），
 * 不知道主机在哪或者服务没给地区就不上色。
 */
export function unlockRegionTone(service: string, region: string | null | undefined, hostCountry: string | null | undefined): UnlockRegionTone {
  const code = String(region || "").trim().toUpperCase();
  const host = String(hostCountry || "").trim().toUpperCase();
  if (!code || !/^[A-Z]{2}$/.test(host)) return "none";
  if (SERVICE_BY_ID.get(service)?.regionKind === "currency") {
    const countries = CURRENCY_COUNTRIES[code];
    if (!countries) return "none";
    if (code === "CNY" && host !== "CN") return "china";
    return countries.includes(host) ? "match" : "mismatch";
  }
  const country = code.length === 3 ? ALPHA3_TO_ALPHA2[code] : code;
  if (!country) return "none";
  if (country === host) return "match";
  if (country === "CN") return "china";
  return "mismatch";
}

/** 这台 Agent 测得了这一项吗（新加的几项要 2.2.253）。版本号比较放这里，免得界面再引一份 version.ts。 */
export function unlockServiceSupported(def: Pick<UnlockServiceDef, "sinceAgent">, agentVersion: string | null | undefined) {
  if (!def.sinceAgent) return true;
  const parse = (value: string | null | undefined) => String(value || "").replace(/^v/i, "").split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const have = parse(agentVersion);
  const need = parse(def.sinceAgent);
  if (!agentVersion) return false;
  for (let index = 0; index < 3; index += 1) {
    if ((have[index] || 0) !== (need[index] || 0)) return (have[index] || 0) > (need[index] || 0);
  }
  return true;
}
