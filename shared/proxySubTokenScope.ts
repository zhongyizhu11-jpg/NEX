/**
 * 订阅令牌自己的东西：作用域（这条地址只给哪些节点）和外观选项（命名、旗帜、信息节点……）。
 *
 * 原来一个用户的所有令牌内容完全一样，令牌只决定名字、默认格式和分流预设。商家
 * 想给客户一条「只有香港」的地址、给路由器一条「不带信息节点」的地址，都做不到。
 *
 * 两份都存成 JSON 文本列（scopeJson / optionsJson），这里负责解析、校验、序列化。
 * 解析一律宽松：坏掉的 JSON 当作「没设」，而不是让整条订阅 500。
 */

import { PROXY_NODE_PROTOCOLS, type ProxyNodeProtocol } from "./proxyNode";

export type ProxySubTokenScope = {
  /** 只要这些节点模板（proxy_nodes.id）；空 = 全部。 */
  templateIds: number[];
  /** 排除这些节点模板。 */
  excludeTemplateIds: number[];
  /** 节点名正则（不区分大小写）；非法正则按字面量子串匹配。 */
  include: string;
  exclude: string;
  /** 只要这些协议；空 = 全部。 */
  protocols: ProxyNodeProtocol[];
  /** 只要这些地区（ISO 国家码）；空 = 全部。 */
  regions: string[];
  /** 不要直连条目 / 不要中转条目。 */
  excludeDirect: boolean;
  excludeRelay: boolean;
};

export const PROXY_SUB_EMPTY_SCOPE: ProxySubTokenScope = {
  templateIds: [],
  excludeTemplateIds: [],
  include: "",
  exclude: "",
  protocols: [],
  regions: [],
  excludeDirect: false,
  excludeRelay: false,
};

export const PROXY_SUB_SORT_MODES = ["manual", "name", "region", "protocol", "latency"] as const;
export type ProxySubSortMode = (typeof PROXY_SUB_SORT_MODES)[number];
export const PROXY_SUB_SORT_MODE_LABELS: Record<ProxySubSortMode, string> = {
  manual: "按面板里的顺序",
  name: "按名字",
  region: "按地区",
  protocol: "按协议",
  latency: "按延迟（面板探测）",
};

/** 三态：跟随全局 / 开 / 关。 */
export type TriState = "default" | "on" | "off";

export type ProxySubRenameRule = { from: string; to: string };

export type ProxySubTokenOptions = {
  /** 命名模板；空 = 跟随全局。变量见 PROXY_SUB_NAME_TEMPLATE_VARIABLES。 */
  nameTemplate: string;
  /** 节点名前缀 / 后缀（在模板之外再加）。 */
  prefix: string;
  suffix: string;
  flagEmoji: TriState;
  protocolPrefix: TriState;
  infoNodes: TriState;
  regionGroups: TriState;
  sortMode: ProxySubSortMode;
  /** 正则改名：按顺序应用。 */
  renames: ProxySubRenameRule[];
  /** 去掉重复节点（地址:端口:协议:凭据一样的）。 */
  dedupe: boolean;
  /** 覆盖节点的 udp / skip-cert-verify。 */
  udp: TriState;
  skipCertVerify: TriState;
  /** 分类去向覆盖：分类 key → 目标（DIRECT / REJECT / PROXY / 某个组名）。 */
  categoryTargets: Record<string, string>;
  /** 这条令牌自己的自定义规则（前置）。 */
  customRules: string;
};

export const PROXY_SUB_DEFAULT_TOKEN_OPTIONS: ProxySubTokenOptions = {
  nameTemplate: "",
  prefix: "",
  suffix: "",
  flagEmoji: "default",
  protocolPrefix: "default",
  infoNodes: "default",
  regionGroups: "default",
  sortMode: "manual",
  renames: [],
  dedupe: false,
  udp: "default",
  skipCertVerify: "default",
  categoryTargets: {},
  customRules: "",
};

export const PROXY_SUB_NAME_TEMPLATE_VARIABLES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "{flag}", label: "国旗（认得出地区时）" },
  { key: "{country}", label: "地区中文名" },
  { key: "{code}", label: "地区代码" },
  { key: "{host}", label: "入口主机名" },
  { key: "{node}", label: "节点模板名" },
  { key: "{rule}", label: "转发规则名" },
  { key: "{protocol}", label: "协议" },
  { key: "{index}", label: "序号" },
];

function ids(value: unknown, limit = 500): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))).slice(0, limit);
}

function textOf(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function triState(value: unknown): TriState {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "on" || raw === "true") return "on";
  if (raw === "off" || raw === "false") return "off";
  return "default";
}

const PROTOCOL_SET = new Set<string>(PROXY_NODE_PROTOCOLS);

export function normalizeProxySubTokenScope(input: unknown): ProxySubTokenScope {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    templateIds: ids(raw.templateIds),
    excludeTemplateIds: ids(raw.excludeTemplateIds),
    include: textOf(raw.include, 200),
    exclude: textOf(raw.exclude, 200),
    protocols: Array.isArray(raw.protocols)
      ? Array.from(new Set(raw.protocols.map((item) => String(item).toLowerCase()).filter((item) => PROTOCOL_SET.has(item)))) as ProxyNodeProtocol[]
      : [],
    regions: Array.isArray(raw.regions)
      ? Array.from(new Set(raw.regions.map((item) => String(item).trim().toUpperCase()).filter((item) => /^[A-Z]{2}$/.test(item)))).slice(0, 50)
      : [],
    excludeDirect: raw.excludeDirect === true,
    excludeRelay: raw.excludeRelay === true,
  };
}

export function parseProxySubTokenScope(json: unknown): ProxySubTokenScope {
  if (!json || typeof json !== "string") return { ...PROXY_SUB_EMPTY_SCOPE };
  try {
    return normalizeProxySubTokenScope(JSON.parse(json));
  } catch {
    return { ...PROXY_SUB_EMPTY_SCOPE };
  }
}

export function proxySubTokenScopeIsEmpty(scope: ProxySubTokenScope): boolean {
  return scope.templateIds.length === 0
    && scope.excludeTemplateIds.length === 0
    && !scope.include
    && !scope.exclude
    && scope.protocols.length === 0
    && scope.regions.length === 0
    && !scope.excludeDirect
    && !scope.excludeRelay;
}

/** 空作用域存 null，省得每条令牌都挂一段 `{}`。 */
export function serializeProxySubTokenScope(scope: ProxySubTokenScope): string | null {
  const normalized = normalizeProxySubTokenScope(scope);
  return proxySubTokenScopeIsEmpty(normalized) ? null : JSON.stringify(normalized);
}

export function normalizeProxySubTokenOptions(input: unknown): ProxySubTokenOptions {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const sortMode = String(raw.sortMode ?? "").trim().toLowerCase();
  const renames: ProxySubRenameRule[] = Array.isArray(raw.renames)
    ? raw.renames
      .map((item: any) => ({ from: textOf(item?.from, 200), to: textOf(item?.to, 200) }))
      .filter((item: ProxySubRenameRule) => item.from)
      .slice(0, 50)
    : [];
  const categoryTargets: Record<string, string> = {};
  if (raw.categoryTargets && typeof raw.categoryTargets === "object") {
    for (const [key, value] of Object.entries(raw.categoryTargets as Record<string, unknown>)) {
      const k = textOf(key, 32);
      const v = textOf(value, 64);
      if (/^[a-z0-9-]+$/.test(k) && v) categoryTargets[k] = v;
    }
  }
  return {
    nameTemplate: textOf(raw.nameTemplate, 120),
    prefix: textOf(raw.prefix, 32),
    suffix: textOf(raw.suffix, 32),
    flagEmoji: triState(raw.flagEmoji),
    protocolPrefix: triState(raw.protocolPrefix),
    infoNodes: triState(raw.infoNodes),
    regionGroups: triState(raw.regionGroups),
    sortMode: (PROXY_SUB_SORT_MODES as readonly string[]).includes(sortMode) ? sortMode as ProxySubSortMode : "manual",
    renames,
    dedupe: raw.dedupe === true,
    udp: triState(raw.udp),
    skipCertVerify: triState(raw.skipCertVerify),
    categoryTargets,
    customRules: textOf(raw.customRules, 10000),
  };
}

export function parseProxySubTokenOptions(json: unknown): ProxySubTokenOptions {
  if (!json || typeof json !== "string") return { ...PROXY_SUB_DEFAULT_TOKEN_OPTIONS };
  try {
    return normalizeProxySubTokenOptions(JSON.parse(json));
  } catch {
    return { ...PROXY_SUB_DEFAULT_TOKEN_OPTIONS };
  }
}

export function proxySubTokenOptionsAreDefault(options: ProxySubTokenOptions): boolean {
  return JSON.stringify(normalizeProxySubTokenOptions(options)) === JSON.stringify(PROXY_SUB_DEFAULT_TOKEN_OPTIONS);
}

export function serializeProxySubTokenOptions(options: ProxySubTokenOptions): string | null {
  const normalized = normalizeProxySubTokenOptions(options);
  return proxySubTokenOptionsAreDefault(normalized) ? null : JSON.stringify(normalized);
}

/** 三态落成布尔：令牌上没设就看全局默认。 */
export function resolveTriState(value: TriState, fallback: boolean): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  return fallback;
}

/**
 * 短链别名：4–32 位小写字母、数字、连字符。大写一律转小写，别的字符拒掉。
 * 返回空串表示不合法。
 */
export function normalizeProxySubAlias(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  return /^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(raw) ? raw : "";
}

/**
 * 正则匹配的宽松版：非法正则退化成不区分大小写的子串匹配，不让一个写坏的表达式
 * 把整条订阅弄成 500。
 */
export function makeLooseMatcher(pattern: string): ((text: string) => boolean) | null {
  const source = String(pattern || "").trim();
  if (!source) return null;
  try {
    const regex = new RegExp(source, "i");
    return (text) => regex.test(text);
  } catch {
    const lower = source.toLowerCase();
    return (text) => text.toLowerCase().includes(lower);
  }
}
