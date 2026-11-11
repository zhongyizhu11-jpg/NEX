/*
  主机网络画像的「IP 信息」部分（Agent 2.2.253 起）：IP 的基础信息（ASN、组织、国家 / 城市）、
  使用地 vs 注册地 → 原生 IP / 广播 IP、IP 类型（家宽 / 机房 / 商业 / 移动……）、风险分。

  数据从几家公开数据库来，每家各管各的、各自缓存（host_ip_intel，每台主机 × 每个协议族 × 每家一行）：

    ipapi.is     不要 Key 也能查（每天约 1000 次）；配了 Key 改由面板带 Key 去查
    IPinfo       不要 Token 也能查基础信息；配了 Token 由面板带 Token 去查（字段多一些）
    proxycheck   不要 Key（每天约 100 次，按查询方 IP 算）：风险分 0~100、代理 / VPN、网络类型
    AbuseIPDB    必须配 Key 才查（滥用置信度、使用类型）
    RIPEstat     面板查，不要 Key：RIR 分配记录里的国家 = 注册地

  谁去查：不要 Key 的三家由 Agent 从这台机器自己的出口去查（免费额度按「谁在查」算，从各台主机查
  不会互相挤占；IPv6 也只有主机自己出得去）；要 Key 的由面板带着主机的 IP 去查，Key 不下发给 Agent。
  Agent 低于 2.2.253 时，不要 Key 的那几家也由面板代查（服务端 safeHttpGet，有超时和大小上限）。

  原则：哪一家没查到就显示「暂不可用（原因）」，绝不拿别家的数顶上，也不把「查不到」当成结论；
  原生 / 广播的判断把用到的证据一条条列出来，证据不够或互相矛盾就是「待确认」。

  这里只放纯函数：各家响应怎么读、类型标签怎么归一、原生 / 广播怎么判。面板侧见
  server/ops/ipIntel.ts，Agent 侧见 agent/ext_netprofile.go 的 intel 部分。
*/

/** Agent 从自己出口查 IP 信息的最低版本（之前的 Agent 由面板代查不要 Key 的几家）。 */
export const NETPROFILE_INTEL_AGENT_VERSION = "2.2.253";

/** 每家结果缓存多久：一天。IP 的归属、类型一天里基本不会变，测勤了只会被限流。 */
export const IP_INTEL_TTL_SECONDS = 24 * 60 * 60;
/** 失败的结果多久后可以重试（不然一次限流就要等一整天）。 */
export const IP_INTEL_FAILURE_RETRY_SECONDS = 30 * 60;

export const IP_INTEL_PROVIDERS = ["ipapi_is", "ipinfo", "proxycheck", "abuseipdb", "ripestat"] as const;
export type IpIntelProvider = (typeof IP_INTEL_PROVIDERS)[number];

export type IpIntelFamily = 4 | 6;
export type IpIntelVia = "agent" | "panel";

export const IP_INTEL_PROVIDER_LABELS: Record<IpIntelProvider, string> = {
  ipapi_is: "ipapi.is",
  ipinfo: "IPinfo",
  proxycheck: "proxycheck.io",
  abuseipdb: "AbuseIPDB",
  ripestat: "RIPEstat",
};

/** 可选 Key 存在系统设置里（加密落库，见 server/settingsSecretKeys.ts）。 */
export const IP_INTEL_KEY_SETTINGS = {
  ipapi_is: "ops.netProfile.ipapiIsKey",
  abuseipdb: "ops.netProfile.abuseIpdbKey",
  ipinfo: "ops.netProfile.ipinfoToken",
} as const satisfies Partial<Record<IpIntelProvider, string>>;
export type IpIntelKeyProvider = keyof typeof IP_INTEL_KEY_SETTINGS;
export const IP_INTEL_KEY_PROVIDERS = Object.keys(IP_INTEL_KEY_SETTINGS) as IpIntelKeyProvider[];

/**
 * Agent 从自己出口去查的地址（不要 Key 的几家）。{ip} 由 Agent 换成这个协议族检测到的出口地址。
 * ipapi.is / IPinfo 用「查我自己」的地址：查的一定是出口本身，不会被面板传错 IP。
 * Agent 那头另有一份域名白名单（agent/ext_netprofile.go netProfileIntelAllowedHosts），这里加了新域名那边也要加。
 */
export const IP_INTEL_AGENT_SOURCES: ReadonlyArray<{ id: IpIntelProvider; url: string }> = [
  { id: "ipapi_is", url: "https://api.ipapi.is/" },
  { id: "ipinfo", url: "https://ipinfo.io/json" },
  { id: "proxycheck", url: "https://proxycheck.io/v2/{ip}?vpn=1&asn=1&risk=1" },
];

export const IP_TYPES = ["residential", "datacenter", "business", "mobile", "education", "government", "cdn", "other"] as const;
export type IpType = (typeof IP_TYPES)[number];

export const IP_TYPE_LABELS: Record<IpType, string> = {
  residential: "家宽",
  datacenter: "机房",
  business: "商业",
  mobile: "移动",
  education: "教育",
  government: "政府",
  cdn: "CDN",
  other: "其他",
};

export type IpRiskLevel = "low" | "medium" | "high";
export const IP_RISK_LABELS: Record<IpRiskLevel, string> = { low: "低风险", medium: "中风险", high: "高风险" };

/** 一家数据库对一个 IP 说了什么。字段对方没给就是 null，不猜。 */
export type IpIntelInfo = {
  ip: string | null;
  asn: string | null;
  org: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  /** 注册地（RIR 分配国家 / ASN 注册国家）。 */
  regCountryCode: string | null;
  /** 注册地是哪一级的证据：ip = 这段地址的分配记录；asn = 整个 ASN 的注册国家（弱一些）。 */
  regLevel: "ip" | "asn" | null;
  ipType: IpType | null;
  /** 对方原样给的类型，界面悬浮提示里看。 */
  ipTypeRaw: string | null;
  /** 0~100 的风险分（proxycheck risk、AbuseIPDB 置信度、ipapi.is 滥用分折算）。 */
  riskScore: number | null;
  riskRaw: string | null;
  flags: { proxy: boolean | null; vpn: boolean | null; tor: boolean | null; hosting: boolean | null; abuser: boolean | null; mobile: boolean | null };
};

export type IpIntelProviderResult = {
  provider: IpIntelProvider;
  family: IpIntelFamily;
  via: IpIntelVia;
  /** 查的是哪个地址（Agent「查我自己」时是对方回的地址）。 */
  address: string | null;
  checkedAt: number;
  ok: boolean;
  /** 失败原因，界面显示成「暂不可用（原因）」。ok 时为 null。 */
  reason: string | null;
  info: IpIntelInfo | null;
};

export function emptyIpIntelInfo(): IpIntelInfo {
  return {
    ip: null, asn: null, org: null, countryCode: null, region: null, city: null, timezone: null,
    regCountryCode: null, regLevel: null, ipType: null, ipTypeRaw: null, riskScore: null, riskRaw: null,
    flags: { proxy: null, vpn: null, tor: null, hosting: null, abuser: null, mobile: null },
  };
}

// ---------------------------------------------------------------- 小工具

function text(value: unknown, max = 160): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return null;
  const out = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return out ? out.slice(0, max) : null;
}

function country(value: unknown): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== "ZZ" && code !== "EU" ? code : null;
}

function flag(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const t = String(value ?? "").trim().toLowerCase();
  if (t === "yes" || t === "true") return true;
  if (t === "no" || t === "false") return false;
  return null;
}

function score(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function normalizeIntelAsn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const match = String(value).trim().match(/^(?:AS)?\s*(\d{1,10})\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 && n < 4294967296 ? `AS${n}` : null;
}

function ipText(value: unknown): string | null {
  const t = text(value, 64);
  return t && /^[0-9a-f:.]+$/i.test(t) && (t.includes(".") || t.includes(":")) ? t.toLowerCase() : null;
}

/*
  第三方接口的 JSON 形状各家不一、随时会变，这里按「随便取、取到的每个字段都再过一遍 text() / country() /
  flag() / score() 校验」的方式读，所以用一个宽松类型，不给每家写一套接口定义。
*/
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseJson = Record<string, any>;

function asObject(raw: unknown): LooseJson | null {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as LooseJson) : null;
}

/**
 * 各家对「类型」的写法归成一套。认不出来是 other（原值另外保留），没给是 null。
 * ipapi.is：isp / hosting / business / education / government / banking；
 * proxycheck：Residential / Business / Hosting / Wireless / VPN …；
 * AbuseIPDB：Fixed Line ISP / Mobile ISP / Data Center/Web Hosting/Transit / Commercial …；
 * IPinfo（付费字段）：isp / hosting / business / education。
 */
export function normalizeIpType(raw: unknown): IpType | null {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/mobile|cellular|wireless|\bmob\b/.test(t)) return "mobile";
  if (/content delivery|\bcdn\b/.test(t)) return "cdn";
  if (/data ?cent|hosting|transit|\bdch\b|server|\bvpn\b|\btor\b|socks|proxy/.test(t)) return "datacenter";
  if (/residential|fixed line|\bisp\b|consumer|broadband/.test(t)) return "residential";
  if (/education|university|college|school|\bedu\b|library/.test(t)) return "education";
  if (/government|military|\bgov\b|\bmil\b/.test(t)) return "government";
  if (/business|commercial|corporate|organi[sz]ation|banking|\bcom\b|\borg\b/.test(t)) return "business";
  return "other";
}

/** 风险分 → 档位：0~33 低，34~66 中，67~100 高（proxycheck 文档的分档）。 */
export function ipRiskLevel(value: number | null | undefined): IpRiskLevel | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (value >= 67) return "high";
  if (value >= 34) return "medium";
  return "low";
}

// ---------------------------------------------------------------- 各家响应

export type IpIntelParseResult = { ok: true; info: IpIntelInfo } | { ok: false; reason: string };

function failure(reason: string): IpIntelParseResult {
  return { ok: false, reason: reason.slice(0, 160) };
}

/** HTTP 状态码的统一说法（限流、Key 不对之类），给「暂不可用（原因）」用。 */
export function ipIntelHttpReason(status: number): string | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429) return "被限流（HTTP 429）";
  if (status === 401 || status === 403) return `被拒绝（HTTP ${status}，Key 不对或额度用完）`;
  if (status === 402) return "额度用完（HTTP 402）";
  if (status >= 500) return `对方服务出错（HTTP ${status}）`;
  return `HTTP ${status}`;
}

/** ipapi.is：https://api.ipapi.is/?q=IP（或不带 q 查自己）。 */
export function parseIpapiIs(raw: unknown): IpIntelParseResult {
  const data = asObject(raw);
  if (!data) return failure("返回的不是 JSON");
  if (data.error) return failure(`对方报错：${text(data.error, 120) || "未知错误"}`);
  if (!data.ip && !data.location && !data.asn) return failure("返回里没有 IP 信息");
  const info = emptyIpIntelInfo();
  info.ip = ipText(data.ip);
  info.asn = normalizeIntelAsn(data.asn?.asn);
  info.org = text(data.asn?.org) || text(data.company?.name);
  info.countryCode = country(data.location?.country_code);
  info.region = text(data.location?.state, 80);
  info.city = text(data.location?.city, 80);
  info.timezone = text(data.location?.timezone, 64);
  // asn.country 是整个 ASN 注册在哪（小写两位码），不是这一段 IP 的分配记录，证据弱一档
  info.regCountryCode = country(data.asn?.country);
  info.regLevel = info.regCountryCode ? "asn" : null;
  const typeRaw = text(data.company?.type, 40) || text(data.asn?.type, 40);
  info.ipTypeRaw = data.is_mobile === true ? [typeRaw, "mobile"].filter(Boolean).join(" / ") : typeRaw;
  info.ipType = data.is_mobile === true ? "mobile" : normalizeIpType(typeRaw);
  // abuser_score 形如 "0.0039 (Low)"：0~1 的比例，折成 0~100
  const abuserRaw = text(data.company?.abuser_score, 40) || text(data.asn?.abuser_score, 40);
  const abuserValue = abuserRaw ? Number(abuserRaw.split(/\s+/)[0]) : NaN;
  info.riskRaw = abuserRaw;
  info.riskScore = Number.isFinite(abuserValue) ? score(abuserValue * 100) : null;
  info.flags = {
    proxy: flag(data.is_proxy),
    vpn: flag(data.is_vpn),
    tor: flag(data.is_tor),
    hosting: flag(data.is_datacenter),
    abuser: flag(data.is_abuser),
    mobile: flag(data.is_mobile),
  };
  return { ok: true, info };
}

/** IPinfo：https://ipinfo.io/json（查自己）或 /IP/json；带 Token 时可能多出 asn / company / privacy。 */
export function parseIpinfo(raw: unknown): IpIntelParseResult {
  const data = asObject(raw);
  if (!data) return failure("返回的不是 JSON");
  if (data.error) {
    const message = typeof data.error === "object" ? text(data.error.message) || text(data.error.title) : text(data.error);
    return failure(`对方报错：${message || "未知错误"}`);
  }
  if (data.bogon === true) return failure("这是保留地址（bogon），查不了");
  if (!data.ip && !data.country) return failure("返回里没有 IP 信息");
  const info = emptyIpIntelInfo();
  info.ip = ipText(data.ip);
  // 免费版只有 org："AS13335 Cloudflare, Inc."；付费版另有 asn 对象
  const orgText = text(data.org);
  info.asn = normalizeIntelAsn(data.asn?.asn) || normalizeIntelAsn(orgText) || normalizeIntelAsn(data.asn);
  info.org = text(data.asn?.name) || (orgText ? orgText.replace(/^AS\d+\s*/i, "") || null : null) || text(data.as_name);
  info.countryCode = country(data.country) || country(data.country_code);
  info.region = text(data.region, 80);
  info.city = text(data.city, 80);
  info.timezone = text(data.timezone, 64);
  const typeRaw = text(data.company?.type, 40) || text(data.asn?.type, 40);
  info.ipTypeRaw = typeRaw;
  info.ipType = normalizeIpType(typeRaw);
  if (data.privacy && typeof data.privacy === "object") {
    info.flags.proxy = flag(data.privacy.proxy);
    info.flags.vpn = flag(data.privacy.vpn);
    info.flags.tor = flag(data.privacy.tor);
    info.flags.hosting = flag(data.privacy.hosting);
  }
  return { ok: true, info };
}

/** proxycheck.io v2：https://proxycheck.io/v2/IP?vpn=1&asn=1&risk=1，结果挂在以 IP 为键的对象下。 */
export function parseProxycheck(raw: unknown, address?: string | null): IpIntelParseResult {
  const data = asObject(raw);
  if (!data) return failure("返回的不是 JSON");
  const status = String(data.status || "").toLowerCase();
  if (status === "denied" || status === "error") return failure(`对方拒绝：${text(data.message, 120) || status}`);
  const key = address && data[address] ? address : Object.keys(data).find((k) => k !== "status" && k !== "message" && k !== "query time" && data[k] && typeof data[k] === "object");
  const item = key ? data[key] : null;
  if (!item || typeof item !== "object") return failure("返回里没有这个 IP 的结果");
  const info = emptyIpIntelInfo();
  info.ip = ipText(key);
  info.asn = normalizeIntelAsn(item.asn);
  info.org = text(item.organisation) || text(item.provider);
  info.countryCode = country(item.isocode);
  info.region = text(item.region, 80);
  info.city = text(item.city, 80);
  info.timezone = text(item.timezone, 64);
  info.ipTypeRaw = text(item.type, 40);
  info.ipType = normalizeIpType(item.type);
  info.riskScore = score(item.risk);
  info.riskRaw = item.risk === undefined ? null : String(item.risk);
  const proxy = flag(item.proxy);
  const type = String(item.type || "").toLowerCase();
  info.flags.proxy = proxy;
  info.flags.vpn = type === "vpn" ? true : proxy === false ? false : null;
  info.flags.tor = type === "tor" ? true : proxy === false ? false : null;
  info.flags.hosting = info.ipType === "datacenter" ? true : info.ipType ? false : null;
  return { ok: true, info };
}

/** AbuseIPDB v2 check：{ data: { abuseConfidenceScore, usageType, isp, countryCode, isTor … } }。 */
export function parseAbuseIpdb(raw: unknown): IpIntelParseResult {
  const body = asObject(raw);
  if (!body) return failure("返回的不是 JSON");
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return failure(`对方报错：${text(body.errors[0]?.detail, 120) || "未知错误"}`);
  }
  const data = body.data;
  if (!data || typeof data !== "object") return failure("返回里没有结果");
  const info = emptyIpIntelInfo();
  info.ip = ipText(data.ipAddress);
  info.org = text(data.isp);
  info.countryCode = country(data.countryCode);
  info.ipTypeRaw = text(data.usageType, 60);
  info.ipType = normalizeIpType(data.usageType);
  info.riskScore = score(data.abuseConfidenceScore);
  info.riskRaw = data.totalReports === undefined ? null : `${Number(data.totalReports) || 0} 次举报`;
  info.flags.tor = flag(data.isTor);
  info.flags.abuser = info.riskScore === null ? null : info.riskScore >= 25;
  return { ok: true, info };
}

/** RIPEstat rir-stats-country：这段地址在 RIR 分配记录里登记的国家 = 注册地。 */
export function parseRipestatCountry(raw: unknown): IpIntelParseResult {
  const body = asObject(raw);
  if (!body) return failure("返回的不是 JSON");
  if (String(body.status || "ok").toLowerCase() !== "ok") return failure(`对方报错：${text(body.message, 120) || body.status}`);
  const located = Array.isArray(body.data?.located_resources) ? body.data.located_resources : [];
  const code = located.map((item: LooseJson | null) => country(item?.location)).find(Boolean) || null;
  if (!code) return failure("分配记录里没有国家");
  const info = emptyIpIntelInfo();
  info.ip = ipText(body.data?.resource);
  info.regCountryCode = code;
  info.regLevel = "ip";
  return { ok: true, info };
}

export function parseIpIntelResponse(provider: IpIntelProvider, raw: unknown, address?: string | null): IpIntelParseResult {
  switch (provider) {
    case "ipapi_is": return parseIpapiIs(raw);
    case "ipinfo": return parseIpinfo(raw);
    case "proxycheck": return parseProxycheck(raw, address);
    case "abuseipdb": return parseAbuseIpdb(raw);
    case "ripestat": return parseRipestatCountry(raw);
  }
  return failure("未知数据源");
}

// ---------------------------------------------------------------- 汇总

export type IpIntelEvidence = {
  provider: IpIntelProvider;
  kind: "usage" | "registration";
  countryCode: string;
  /** registration 时：ip = 地址分配记录，asn = ASN 注册国家。 */
  level?: "ip" | "asn";
};

export type NativeIpVerdict = "native" | "broadcast" | "unknown";
export const NATIVE_IP_LABELS: Record<NativeIpVerdict, string> = { native: "原生 IP", broadcast: "广播 IP", unknown: "待确认" };

export type NativeIpJudgement = {
  verdict: NativeIpVerdict;
  usageCountry: string | null;
  registrationCountry: string | null;
  evidence: IpIntelEvidence[];
  /** 一句话说明为什么是这个结论。 */
  reason: string;
};

/** 使用地按这个顺序取（ipapi.is、IPinfo 的地理库最常被流媒体等服务参考）。 */
const USAGE_ORDER: IpIntelProvider[] = ["ipapi_is", "ipinfo", "proxycheck", "abuseipdb"];

/**
 * 原生 / 广播：比较「这个 IP 被认成在哪用」和「它登记在哪」。
 *   使用地：各家地理库的国家；几家互相矛盾 → 待确认。
 *   注册地：优先 RIPEstat 的地址分配记录（ip 级），没有再用 ipapi.is 的 ASN 注册国家（asn 级）。
 *   两边一致 → 原生；不一致 → 广播；缺任何一边 → 待确认。
 */
export function judgeNativeIp(results: readonly Pick<IpIntelProviderResult, "provider" | "ok" | "info">[]): NativeIpJudgement {
  const evidence: IpIntelEvidence[] = [];
  const usable = results.filter((item) => item.ok && item.info);
  for (const provider of USAGE_ORDER) {
    const code = usable.find((item) => item.provider === provider)?.info?.countryCode;
    if (code) evidence.push({ provider, kind: "usage", countryCode: code });
  }
  const ripe = usable.find((item) => item.provider === "ripestat")?.info;
  if (ripe?.regCountryCode) evidence.push({ provider: "ripestat", kind: "registration", countryCode: ripe.regCountryCode, level: "ip" });
  const asnReg = usable.find((item) => item.provider === "ipapi_is")?.info;
  if (asnReg?.regCountryCode) evidence.push({ provider: "ipapi_is", kind: "registration", countryCode: asnReg.regCountryCode, level: "asn" });

  const usageCodes = evidence.filter((item) => item.kind === "usage").map((item) => item.countryCode);
  const distinctUsage = Array.from(new Set(usageCodes));
  const registration = evidence.find((item) => item.kind === "registration" && item.level === "ip")
    || evidence.find((item) => item.kind === "registration");
  const usageCountry = distinctUsage.length === 1 ? distinctUsage[0] : null;
  const registrationCountry = registration?.countryCode || null;

  if (distinctUsage.length === 0) {
    return { verdict: "unknown", usageCountry: null, registrationCountry, evidence, reason: "没有拿到使用地" };
  }
  if (distinctUsage.length > 1) {
    return { verdict: "unknown", usageCountry: null, registrationCountry, evidence, reason: `几家数据库的使用地不一致（${distinctUsage.join(" / ")}）` };
  }
  if (!registrationCountry) {
    return { verdict: "unknown", usageCountry, registrationCountry: null, evidence, reason: "没有拿到注册地" };
  }
  if (usageCountry === registrationCountry) {
    return { verdict: "native", usageCountry, registrationCountry, evidence, reason: `使用地和注册地都是 ${usageCountry}` };
  }
  const weak = registration?.level === "asn" ? "（注册地取自 ASN 注册国家，证据较弱）" : "";
  return { verdict: "broadcast", usageCountry, registrationCountry, evidence, reason: `使用地 ${usageCountry}，注册地 ${registrationCountry}${weak}` };
}

export type IpIntelBasic = {
  ip: string | null;
  asn: string | null;
  org: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  /** 基础信息取自哪一家。 */
  source: IpIntelProvider | null;
};

/** 基础信息：按 ipapi.is → IPinfo → proxycheck → AbuseIPDB 的顺序，每个字段取第一家给了的。 */
export function pickIpIntelBasic(results: readonly Pick<IpIntelProviderResult, "provider" | "ok" | "info">[]): IpIntelBasic {
  const usable = USAGE_ORDER.map((provider) => results.find((item) => item.provider === provider && item.ok && item.info)).filter(Boolean) as IpIntelProviderResult[];
  const pick = <K extends keyof IpIntelInfo>(key: K) => (usable.find((item) => item.info?.[key])?.info?.[key] ?? null) as IpIntelInfo[K] | null;
  return {
    ip: pick("ip") as string | null,
    asn: pick("asn") as string | null,
    org: pick("org") as string | null,
    countryCode: pick("countryCode") as string | null,
    region: pick("region") as string | null,
    city: pick("city") as string | null,
    timezone: pick("timezone") as string | null,
    source: usable[0]?.provider ?? null,
  };
}

export type IpIntelFamilyView = {
  family: IpIntelFamily;
  address: string | null;
  providers: IpIntelProviderResult[];
  basic: IpIntelBasic;
  native: NativeIpJudgement;
  checkedAt: number | null;
};

const PROVIDER_ORDER = new Map(IP_INTEL_PROVIDERS.map((provider, index) => [provider, index]));

export function buildIpIntelFamilyView(family: IpIntelFamily, address: string | null, results: readonly IpIntelProviderResult[]): IpIntelFamilyView {
  const providers = results
    .filter((item) => item.family === family)
    .slice()
    .sort((a, b) => (PROVIDER_ORDER.get(a.provider) ?? 99) - (PROVIDER_ORDER.get(b.provider) ?? 99));
  const checkedAt = providers.reduce<number | null>((max, item) => (item.checkedAt > (max ?? 0) ? item.checkedAt : max), null);
  return { family, address, providers, basic: pickIpIntelBasic(providers), native: judgeNativeIp(providers), checkedAt };
}

/** 存库的那份读回来（形状不对的丢掉）。 */
export function normalizeStoredIpIntelInfo(raw: unknown): IpIntelInfo | null {
  const data = asObject(raw);
  if (!data) return null;
  const base = emptyIpIntelInfo();
  const flags = data.flags && typeof data.flags === "object" ? data.flags : {};
  const ipType = (IP_TYPES as readonly string[]).includes(String(data.ipType)) ? (data.ipType as IpType) : null;
  return {
    ...base,
    ip: ipText(data.ip),
    asn: normalizeIntelAsn(data.asn),
    org: text(data.org),
    countryCode: country(data.countryCode),
    region: text(data.region, 80),
    city: text(data.city, 80),
    timezone: text(data.timezone, 64),
    regCountryCode: country(data.regCountryCode),
    regLevel: data.regLevel === "ip" || data.regLevel === "asn" ? data.regLevel : null,
    ipType,
    ipTypeRaw: text(data.ipTypeRaw, 60),
    riskScore: score(data.riskScore),
    riskRaw: text(data.riskRaw, 60),
    flags: {
      proxy: flag(flags.proxy), vpn: flag(flags.vpn), tor: flag(flags.tor),
      hosting: flag(flags.hosting), abuser: flag(flags.abuser), mobile: flag(flags.mobile),
    },
  };
}

export function isIpIntelProvider(value: unknown): value is IpIntelProvider {
  return (IP_INTEL_PROVIDERS as readonly string[]).includes(String(value));
}

/** Key 在设置页只显示是否配置 + 末四位。 */
export function maskIntelKey(value: string | null | undefined): string | null {
  const key = String(value || "").trim();
  if (!key) return null;
  return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
}
