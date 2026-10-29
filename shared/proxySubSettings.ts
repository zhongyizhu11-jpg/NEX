/**
 * 订阅系统的全局设置：键名、默认值、从 system_settings 的字符串记录里解析出来。
 *
 * 放在 shared 是为了前端设置页和服务端用同一份默认值、同一份键名 —— 两边各写一份
 * 迟早对不上，表现是界面上显示着一个值、服务端用着另一个。
 *
 * 所有默认值都等于升级前的行为（更新间隔 12 小时、gstatic 测速、不加旗帜、不插信息
 * 节点、不限设备、不限流……），升级后什么都不改就和原来一样。
 */

export const PROXY_SUB_SETTING_PREFIX = "proxySub.";

export type ProxySubSettings = {
  /** Profile-Update-Interval 响应头（小时），Surge MANAGED-CONFIG 的 interval 也按它算。 */
  updateIntervalHours: number;
  /** 自动选路组的测速地址、间隔、容差。 */
  testUrl: string;
  testIntervalSec: number;
  toleranceMs: number;
  /** 规则集更新间隔（秒）。 */
  rulesetIntervalSec: number;
  /**
   * 规则集镜像前缀：非空时把 https://raw.githubusercontent.com 换成它（比如
   * https://ghproxy.example.com/https://raw.githubusercontent.com）。
   * 填 "panel" 表示由面板自己托管（/api/sub/ruleset/…，见 server/proxySubRulesetMirror.ts）。
   */
  rulesetMirror: string;
  /** 公告：写进 announce 响应头（base64），信息节点开着时也插一条。 */
  announce: string;
  /** support-url 响应头。 */
  supportUrl: string;
  /** 备用的面板地址（完整 origin），一键导入面板上每个客户端都会列出全部。 */
  domains: string[];
  /** 每条令牌每分钟最多拉几次；0 = 不限。 */
  rateLimitPerMinute: number;
  /** 每个 IP 每分钟最多拉几次；0 = 不限。 */
  ipRateLimitPerMinute: number;
  /** 渲染结果缓存秒数；0 = 不缓存。 */
  cacheTtlSec: number;
  /** 设备数限制总开关。 */
  deviceLimitEnabled: boolean;
  /** 严格模式：不带 x-hwid 的客户端一律拒绝（Remnawave 的做法）；关着时按 IP 退化统计。 */
  deviceLimitStrict: boolean;
  /** 用户和令牌都没设时的设备数上限；0 = 不限。 */
  deviceLimitFallback: number;
  /** 按 IP 退化统计时，多久没来的 IP 不再算一台设备（小时）。 */
  deviceIpWindowHours: number;
  /** 信息节点（剩余流量 / 到期 / 公告）默认开不开；令牌上可以单独改。 */
  infoNodesDefault: boolean;
  /** 默认的节点命名模板。 */
  nameTemplateDefault: string;
  /** 节点名默认加不加国旗。 */
  flagEmojiDefault: boolean;
  /** 默认生不生成地区组。 */
  regionGroupsDefault: boolean;
  /** 节点名默认加不加协议前缀。 */
  protocolPrefixDefault: boolean;
  /** 访问日志保留天数；0 = 不记日志。 */
  accessLogRetentionDays: number;
  /** 允许用户添加外部订阅。 */
  externalSourcesEnabled: boolean;
  /** 每个用户最多几个外部订阅。 */
  externalSourceMaxPerUser: number;
  /** 浏览器打开订阅地址时给落地页。 */
  landingPageEnabled: boolean;
  /**
   * Xboard / V2Board 兼容接口（/api/v1/passport/auth/login、/api/v1/user/getSubscribe 等）：
   * 支持「用 Xboard 账号登录」的客户端可以直接填面板地址 + 邮箱密码拉订阅。默认关。
   */
  xboardCompatEnabled: boolean;
  /** 通知：首次拉取 / 新设备 / 超设备数 / 连续失败。 */
  notifyFirstAccess: boolean;
  notifyNewDevice: boolean;
  notifyDeviceLimit: boolean;
  notifyFailures: boolean;
  /** 全局自定义规则：前置（命中即止，排在预设规则前）与后置（排在 MATCH 前）。每行一条。 */
  customRulesPrepend: string;
  customRulesAppend: string;
};

export const PROXY_SUB_DEFAULT_SETTINGS: ProxySubSettings = {
  updateIntervalHours: 12,
  testUrl: "http://www.gstatic.com/generate_204",
  testIntervalSec: 300,
  toleranceMs: 50,
  rulesetIntervalSec: 86400,
  rulesetMirror: "",
  announce: "",
  supportUrl: "",
  domains: [],
  rateLimitPerMinute: 30,
  ipRateLimitPerMinute: 120,
  cacheTtlSec: 60,
  deviceLimitEnabled: false,
  deviceLimitStrict: false,
  deviceLimitFallback: 0,
  deviceIpWindowHours: 24,
  infoNodesDefault: false,
  nameTemplateDefault: "{host} → {node}",
  flagEmojiDefault: false,
  regionGroupsDefault: false,
  protocolPrefixDefault: false,
  accessLogRetentionDays: 30,
  externalSourcesEnabled: false,
  externalSourceMaxPerUser: 5,
  landingPageEnabled: true,
  xboardCompatEnabled: false,
  notifyFirstAccess: false,
  notifyNewDevice: false,
  notifyDeviceLimit: true,
  notifyFailures: false,
  customRulesPrepend: "",
  customRulesAppend: "",
};

type Kind = "int" | "bool" | "text" | "lines";

const FIELD_KINDS: Record<keyof ProxySubSettings, Kind> = {
  updateIntervalHours: "int",
  testUrl: "text",
  testIntervalSec: "int",
  toleranceMs: "int",
  rulesetIntervalSec: "int",
  rulesetMirror: "text",
  announce: "text",
  supportUrl: "text",
  domains: "lines",
  rateLimitPerMinute: "int",
  ipRateLimitPerMinute: "int",
  cacheTtlSec: "int",
  deviceLimitEnabled: "bool",
  deviceLimitStrict: "bool",
  deviceLimitFallback: "int",
  deviceIpWindowHours: "int",
  infoNodesDefault: "bool",
  nameTemplateDefault: "text",
  flagEmojiDefault: "bool",
  regionGroupsDefault: "bool",
  protocolPrefixDefault: "bool",
  accessLogRetentionDays: "int",
  externalSourcesEnabled: "bool",
  externalSourceMaxPerUser: "int",
  landingPageEnabled: "bool",
  xboardCompatEnabled: "bool",
  notifyFirstAccess: "bool",
  notifyNewDevice: "bool",
  notifyDeviceLimit: "bool",
  notifyFailures: "bool",
  customRulesPrepend: "text",
  customRulesAppend: "text",
};

/** 数值字段的合理区间，越界夹回去而不是报错 —— 设置页上填错一个数不该让订阅整个失效。 */
const INT_RANGES: Partial<Record<keyof ProxySubSettings, [number, number]>> = {
  updateIntervalHours: [1, 24 * 30],
  testIntervalSec: [30, 86400],
  toleranceMs: [0, 5000],
  rulesetIntervalSec: [3600, 86400 * 30],
  rateLimitPerMinute: [0, 100000],
  ipRateLimitPerMinute: [0, 100000],
  cacheTtlSec: [0, 3600],
  deviceLimitFallback: [0, 1000],
  deviceIpWindowHours: [1, 24 * 30],
  accessLogRetentionDays: [0, 365],
  externalSourceMaxPerUser: [0, 100],
};

export const PROXY_SUB_SETTING_KEYS: readonly (keyof ProxySubSettings)[] = Object.keys(FIELD_KINDS) as (keyof ProxySubSettings)[];

export function proxySubSettingKey(field: keyof ProxySubSettings): string {
  return `${PROXY_SUB_SETTING_PREFIX}${field}`;
}

function clampInt(field: keyof ProxySubSettings, value: number): number {
  const range = INT_RANGES[field];
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return PROXY_SUB_DEFAULT_SETTINGS[field] as number;
  if (!range) return Math.max(0, n);
  return Math.min(range[1], Math.max(range[0], n));
}

/** 从 system_settings 的键值记录里解析；缺的键用默认值。 */
export function parseProxySubSettings(record: Record<string, string | null | undefined>): ProxySubSettings {
  const out: any = { ...PROXY_SUB_DEFAULT_SETTINGS, domains: [...PROXY_SUB_DEFAULT_SETTINGS.domains] };
  for (const field of PROXY_SUB_SETTING_KEYS) {
    const raw = record[proxySubSettingKey(field)];
    if (raw === undefined || raw === null) continue;
    const kind = FIELD_KINDS[field];
    if (kind === "int") out[field] = clampInt(field, Number(raw));
    else if (kind === "bool") out[field] = raw === "true";
    else if (kind === "lines") out[field] = normalizeDomains(String(raw).split(/\r?\n/));
    else out[field] = String(raw);
  }
  return normalizeProxySubSettings(out);
}

/** 把一份（可能只改了几项的）设置序列化成要写进 system_settings 的键值。 */
export function serializeProxySubSettings(settings: Partial<ProxySubSettings>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of PROXY_SUB_SETTING_KEYS) {
    const value = settings[field];
    if (value === undefined) continue;
    const kind = FIELD_KINDS[field];
    if (kind === "int") out[proxySubSettingKey(field)] = String(clampInt(field, Number(value)));
    else if (kind === "bool") out[proxySubSettingKey(field)] = value ? "true" : "false";
    else if (kind === "lines") out[proxySubSettingKey(field)] = normalizeDomains(value as string[]).join("\n");
    else out[proxySubSettingKey(field)] = String(value ?? "");
  }
  return out;
}

/** 备用域名：只收 http(s) 的 origin，去掉路径和末尾斜杠，去重。 */
export function normalizeDomains(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    const raw = String(item ?? "").trim();
    if (!raw) continue;
    let origin = "";
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      origin = `${url.protocol}//${url.host}`;
    } catch {
      continue;
    }
    if (!out.includes(origin)) out.push(origin);
  }
  return out.slice(0, 10);
}

export function normalizeProxySubSettings(input: Partial<ProxySubSettings>): ProxySubSettings {
  const out: any = { ...PROXY_SUB_DEFAULT_SETTINGS, ...input };
  for (const field of PROXY_SUB_SETTING_KEYS) {
    const kind = FIELD_KINDS[field];
    if (kind === "int") out[field] = clampInt(field, Number(out[field]));
    else if (kind === "bool") out[field] = !!out[field];
    else if (kind === "lines") out[field] = normalizeDomains(Array.isArray(out[field]) ? out[field] : []);
    else out[field] = String(out[field] ?? "").slice(0, field === "customRulesPrepend" || field === "customRulesAppend" ? 20000 : 1000);
  }
  // 测速地址只认 http(s)，否则客户端会把整份配置拒掉。
  if (!/^https?:\/\//i.test(out.testUrl)) out.testUrl = PROXY_SUB_DEFAULT_SETTINGS.testUrl;
  if (out.supportUrl && !/^https?:\/\//i.test(out.supportUrl)) out.supportUrl = "";
  if (out.rulesetMirror && out.rulesetMirror !== "panel" && !/^https?:\/\//i.test(out.rulesetMirror)) out.rulesetMirror = "";
  out.rulesetMirror = String(out.rulesetMirror).replace(/\/+$/, "");
  return out as ProxySubSettings;
}

/**
 * 把上游规则集地址按镜像设置改写。
 *
 * mirror 为空：原样；为 "panel"：交给调用方换成面板自己的地址（这里原样返回，
 * 服务端在知道面板地址时再换）；否则把 raw.githubusercontent.com 的前缀换成镜像。
 */
export function applyRulesetMirror(url: string, mirror: string): string {
  const prefix = "https://raw.githubusercontent.com";
  if (!mirror || mirror === "panel" || !url.startsWith(prefix)) return url;
  /*
    两种常见写法：
      - 替换式镜像（https://raw.fastgit.org 或 https://mirror.example/raw.githubusercontent.com）：
        把前缀换掉。认法是镜像地址自己以 raw.githubusercontent.com 结尾、或者根本不含 github。
      - ghproxy 式（https://ghproxy.example.com）：整条原地址接在后面。
    只有一个 host 的镜像分不出是哪种，按替换式算 —— raw.fastgit.org 这类更常见。
  */
  if (/\/https?:\/\/?$/.test(mirror) || /ghproxy|gh-proxy|ghfast|mirror\.ghproxy/i.test(mirror)) {
    return `${mirror.replace(/\/+$/, "")}/${url}`;
  }
  return `${mirror}${url.slice(prefix.length)}`;
}
