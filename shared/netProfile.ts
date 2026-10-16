/*
  主机网络画像（Agent 2.2.226 起）：双栈出站、25 端口出站、DNSBL 黑名单。

  Agent 那头见 agent/ext_netprofile.go（扩展通道模块 "netprofile"），面板这头见
  server/ops/netProfile.ts。这里放两头都要用的东西：报告的形状、DNSBL 应答怎么解读、
  把 Agent 上报的东西收敛成干净的结构（界面只认这里出来的数据）。
*/

/** 支持主机侧网络画像的最低 Agent 版本。 */
export const NETPROFILE_MIN_AGENT_VERSION = "2.2.226";
/** 定期检测间隔：6 小时。这些东西一天里基本不会变，测得太勤只会被对方限流。 */
export const NETPROFILE_INTERVAL_SECONDS = 6 * 60 * 60;
/** 历史只留最近 30 次的摘要。 */
export const NETPROFILE_HISTORY_LIMIT = 30;

/*
  DNSBL 列表。dnsbl.sorbs.net 不在里面：SORBS 2024 年 6 月已经关停，这个区现在查什么都是
  「查不到」，留着只会给出一个假的「未列入」。cbl.abuseat.org 已并入 Spamhaus XBL，但区还在答。
*/
export const DNSBL_LISTS: ReadonlyArray<{ zone: string; name: string }> = [
  { zone: "zen.spamhaus.org", name: "Spamhaus ZEN" },
  { zone: "bl.spamcop.net", name: "SpamCop" },
  { zone: "b.barracudacentral.org", name: "Barracuda" },
  { zone: "cbl.abuseat.org", name: "CBL" },
];

/** 25 端口检测连的几台大邮箱的 MX（只读欢迎语然后 QUIT，不发任何邮件命令）。 */
export const SMTP25_TARGETS: ReadonlyArray<string> = [
  "gmail-smtp-in.l.google.com:25",
  "mx1.mail.icloud.com:25",
  "alt1.aspmx.l.google.com:25",
];

export const NETPROFILE_IPV4_URLS: ReadonlyArray<string> = ["https://ipv4.icanhazip.com", "https://api.ipify.org"];
export const NETPROFILE_IPV6_URLS: ReadonlyArray<string> = ["https://ipv6.icanhazip.com", "https://api6.ipify.org"];

export const DNSBL_QUERY_REFUSED = "无法查询（公共解析器被拒绝）";
export const DNSBL_UNEXPECTED_ANSWER = "解析器返回了异常结果（可能被劫持）";

export type NetProfileFamilyCheck = {
  ok: boolean;
  address: string | null;
  latencyMs: number | null;
  error: string | null;
};

export type NetProfileIpv6Check = NetProfileFamilyCheck & {
  /** 本机网卡上有没有全局单播 IPv6（不含 fe80::/10、fc00::/7）。null = 没测。 */
  configured: boolean | null;
};

export type Smtp25Status = "open" | "blocked" | "timeout";

export type Smtp25TargetResult = {
  target: string;
  status: "open" | "refused" | "timeout" | "error";
  detail: string | null;
};

export type NetProfileSmtp25 = {
  status: Smtp25Status;
  detail: string | null;
  targets: Smtp25TargetResult[];
};

export type DnsblEntry = {
  list: string;
  listed: boolean;
  /** 被列入时的应答，例如 127.0.0.2（多个用逗号隔开）。 */
  code: string | null;
  /** 查不了（超时、解析器被拒、应答异常）。有 error 时 listed 没有意义。 */
  error: string | null;
};

export type NetProfileSource = "agent" | "panel";

export type NetProfileReport = {
  /** 最近一次检测时间（Unix 秒）。 */
  checkedAt: number;
  ipv4: NetProfileFamilyCheck | null;
  ipv6: NetProfileIpv6Check | null;
  smtp25: NetProfileSmtp25 | null;
  dnsbl: DnsblEntry[];
  /** DNSBL 查的是哪个 IPv4。 */
  dnsblAddress: string | null;
  /** DNSBL 那部分是谁查的：Agent 用主机的系统解析器，面板用面板服务器的解析器（旧 Agent 的兜底）。 */
  dnsblSource: NetProfileSource | null;
  dnsblCheckedAt: number | null;
  /** 主机侧检测（双栈、25 端口）最近一次的时间；只有面板兜底查过 DNSBL 时为 null。 */
  agentCheckedAt: number | null;
};

export type NetProfileHistoryItem = {
  checkedAt: number;
  ipv4Ok: boolean | null;
  ipv6Ok: boolean | null;
  smtp25: Smtp25Status | null;
  listed: number;
};

// ---------------------------------------------------------------- DNSBL

/** 1.2.3.4 → 4.3.2.1；不是 IPv4 就是 null。 */
export function reverseIpv4(address: string | null | undefined): string | null {
  const value = String(address || "").trim();
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
  }
  return parts.reverse().join(".");
}

export function dnsblQueryName(address: string, zone: string): string | null {
  const reversed = reverseIpv4(address);
  const cleanZone = String(zone || "").trim().replace(/\.$/, "").toLowerCase();
  if (!reversed || !/^[a-z0-9.-]+$/.test(cleanZone)) return null;
  return `${reversed}.${cleanZone}`;
}

const NOT_FOUND_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "NOTFOUND", "NODATA"]);

/**
 * 一条 DNSBL 查询的结果怎么读：
 *   查不到（NXDOMAIN / 没有 A 记录）            → 未列入
 *   127.255.255.252 / 254 / 255（Spamhaus）       → 查询被拒（多半是公共解析器），不是列入
 *   其他 127.x.x.x                               → 列入，code 就是那个地址
 *   不是 127 开头的地址                           → 解析器在劫持 NXDOMAIN，结果不可信
 *   其他错误（超时、SERVFAIL）                    → 查询失败
 */
export function interpretDnsblAnswer(
  list: string,
  result: { addresses?: readonly string[] | null; notFound?: boolean; error?: string | null },
): DnsblEntry {
  const base = { list: String(list || "").slice(0, 128), listed: false, code: null, error: null } satisfies DnsblEntry;
  if (result.notFound) return base;
  const errorText = String(result.error || "").trim();
  if (errorText) {
    if (NOT_FOUND_CODES.has(errorText.toUpperCase())) return base;
    return { ...base, error: `查询失败：${errorText.slice(0, 160)}` };
  }
  const addresses = (result.addresses || []).map((value) => String(value || "").trim()).filter(Boolean);
  const v4 = addresses.filter((value) => reverseIpv4(value) !== null);
  if (v4.length === 0) return base;
  if (v4.some((value) => value.startsWith("127.255.255."))) return { ...base, error: DNSBL_QUERY_REFUSED };
  if (v4.some((value) => !value.startsWith("127."))) return { ...base, error: DNSBL_UNEXPECTED_ANSWER };
  return { ...base, listed: true, code: Array.from(new Set(v4)).sort().join(",").slice(0, 128) };
}

/** Spamhaus ZEN 的返回码是什么意思（别的列表只有「列入 / 没列入」）。 */
export function dnsblCodeLabel(list: string, code: string | null): string | null {
  if (!code) return null;
  if (!/spamhaus/i.test(list)) return null;
  const labels = code.split(",").map((value) => {
    const last = Number(value.split(".")[3]);
    if (last === 2) return "SBL";
    if (last === 3) return "SBL CSS";
    if (last >= 4 && last <= 7) return "XBL";
    if (last === 9) return "DROP";
    if (last === 10 || last === 11) return "PBL";
    return null;
  }).filter(Boolean);
  return labels.length > 0 ? Array.from(new Set(labels)).join(" / ") : null;
}

export type DnsblSummary = {
  state: "clean" | "listed" | "unknown" | "none";
  listed: string[];
  failed: string[];
  checked: number;
};

export function summarizeDnsbl(entries: readonly DnsblEntry[] | null | undefined): DnsblSummary {
  const items = entries || [];
  const listed = items.filter((item) => !item.error && item.listed).map((item) => item.list);
  const failed = items.filter((item) => !!item.error).map((item) => item.list);
  const checked = items.length - failed.length;
  let state: DnsblSummary["state"] = "none";
  if (items.length > 0) state = listed.length > 0 ? "listed" : checked > 0 ? "clean" : "unknown";
  return { state, listed, failed, checked };
}

export function dnsblListName(zone: string) {
  return DNSBL_LISTS.find((item) => item.zone === zone)?.name || zone;
}

// ---------------------------------------------------------------- 收敛 Agent 上报

function str(value: unknown, max = 200): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

function latency(value: unknown): number | null {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= 120_000 ? n : null;
}

function ipLiteral(value: unknown, family: 4 | 6): string | null {
  const text = str(value, 64);
  if (!text) return null;
  if (family === 4) return reverseIpv4(text) ? text : null;
  return /^[0-9a-f:.]+$/i.test(text) && text.includes(":") ? text.toLowerCase() : null;
}

function normalizeFamily(raw: unknown, family: 4 | 6): NetProfileFamilyCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const address = ipLiteral(item.address, family);
  const ok = bool(item.ok) && !!address;
  return {
    ok,
    address,
    latencyMs: ok ? latency(item.latencyMs) : null,
    error: ok ? null : str(item.error) || (bool(item.ok) ? "返回的不是有效地址" : "检测失败"),
  };
}

const SMTP_TARGET_STATUSES = new Set(["open", "refused", "timeout", "error"]);

function normalizeSmtp(raw: unknown): NetProfileSmtp25 | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const targets: Smtp25TargetResult[] = (Array.isArray(item.targets) ? item.targets : []).slice(0, 8).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const target = str((entry as any).target, 128);
    const status = String((entry as any).status || "");
    if (!target || !SMTP_TARGET_STATUSES.has(status)) return [];
    return [{ target, status: status as Smtp25TargetResult["status"], detail: str((entry as any).detail) }];
  });
  let status = String(item.status || "");
  if (status !== "open" && status !== "blocked" && status !== "timeout") {
    if (targets.length === 0) return null;
    status = targets.some((t) => t.status === "open") ? "open" : targets.every((t) => t.status === "timeout") ? "timeout" : "blocked";
  }
  return { status: status as Smtp25Status, detail: str(item.detail, 300), targets };
}

export function normalizeDnsblEntries(raw: unknown): DnsblEntry[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 16).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const list = str(item.list, 128);
    if (!list) return [];
    // 有原始应答就按面板这边的规则重新解读一遍（规则改了不用等 Agent 升级）。
    if (Array.isArray(item.answers) || item.notFound !== undefined) {
      return [interpretDnsblAnswer(list, {
        addresses: Array.isArray(item.answers) ? item.answers.slice(0, 16).map((value) => String(value)) : [],
        notFound: bool(item.notFound),
        error: str(item.error),
      })];
    }
    const error = str(item.error);
    return [{ list, listed: !error && bool(item.listed), code: !error && bool(item.listed) ? str(item.code, 128) : null, error }];
  });
}

function epochSeconds(value: unknown, fallback: number, nowSec: number): number {
  const n = Math.floor(Number(value));
  // 主机时钟偏得离谱就用面板时间
  if (!Number.isFinite(n) || n < nowSec - 7 * 24 * 3600 || n > nowSec + 300) return fallback;
  return n;
}

/**
 * 把 Agent 上报的一次检测收敛成 NetProfileReport。不是对象就 null；字段缺了的那项就是 null，
 * 不编造。时间偏得离谱（超过 7 天或在未来 5 分钟后）按面板时间记。
 */
export function normalizeNetProfileReport(raw: unknown, nowSec = Math.floor(Date.now() / 1000)): NetProfileReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const checkedAt = epochSeconds(item.checkedAt, nowSec, nowSec);
  const ipv4 = normalizeFamily(item.ipv4, 4);
  const ipv6Base = normalizeFamily(item.ipv6, 6);
  const ipv6Raw = item.ipv6 && typeof item.ipv6 === "object" ? item.ipv6 as Record<string, unknown> : null;
  const ipv6: NetProfileIpv6Check | null = ipv6Base
    ? { ...ipv6Base, configured: ipv6Raw && typeof ipv6Raw.configured === "boolean" ? ipv6Raw.configured : null }
    : null;
  const dnsbl = normalizeDnsblEntries(item.dnsbl);
  const dnsblAddress = ipLiteral(item.dnsblAddress, 4) || (dnsbl.length > 0 ? ipv4?.address || null : null);
  return {
    checkedAt,
    ipv4,
    ipv6,
    smtp25: normalizeSmtp(item.smtp25),
    dnsbl,
    dnsblAddress,
    dnsblSource: dnsbl.length > 0 ? "agent" : null,
    dnsblCheckedAt: dnsbl.length > 0 ? checkedAt : null,
    agentCheckedAt: checkedAt,
  };
}

/** 数据库里那份 JSON 读回来（形状不对的字段丢掉）。 */
export function parseStoredNetProfile(raw: unknown): NetProfileReport | null {
  if (!raw) return null;
  let value: any = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const base = normalizeNetProfileReport({ ...value, checkedAt: value.checkedAt }, Number(value.checkedAt) || nowSec);
  if (!base) return null;
  const source = value.dnsblSource === "panel" || value.dnsblSource === "agent" ? value.dnsblSource : base.dnsblSource;
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);
  return {
    ...base,
    checkedAt: num(value.checkedAt) || base.checkedAt,
    dnsblSource: base.dnsbl.length > 0 ? source : null,
    dnsblCheckedAt: base.dnsbl.length > 0 ? num(value.dnsblCheckedAt) || base.checkedAt : null,
    agentCheckedAt: num(value.agentCheckedAt),
  };
}

export function netProfileHistoryItem(report: NetProfileReport): NetProfileHistoryItem {
  return {
    checkedAt: report.checkedAt,
    ipv4Ok: report.ipv4 ? report.ipv4.ok : null,
    ipv6Ok: report.ipv6 ? report.ipv6.ok : null,
    smtp25: report.smtp25?.status ?? null,
    listed: summarizeDnsbl(report.dnsbl).listed.length,
  };
}

/** 双栈状态一句话。 */
export function dualStackState(report: Pick<NetProfileReport, "ipv4" | "ipv6"> | null | undefined): "dual" | "ipv4" | "ipv6" | "none" | "unknown" {
  if (!report || (!report.ipv4 && !report.ipv6)) return "unknown";
  const v4 = !!report.ipv4?.ok;
  const v6 = !!report.ipv6?.ok;
  if (v4 && v6) return "dual";
  if (v4) return "ipv4";
  if (v6) return "ipv6";
  return "none";
}

export const DUAL_STACK_LABELS: Record<ReturnType<typeof dualStackState>, string> = {
  dual: "双栈",
  ipv4: "仅 IPv4",
  ipv6: "仅 IPv6",
  none: "都不通",
  unknown: "未检测",
};

export const SMTP25_LABELS: Record<Smtp25Status, string> = {
  open: "可出站",
  blocked: "被拦截",
  timeout: "超时（多半被封）",
};
