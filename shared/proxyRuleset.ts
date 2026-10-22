/**
 * 订阅里的分流规则。
 *
 * 只有节点的订阅导进客户端后还得自己配分流，否则所有流量都走代理，国内网站
 * 也绕一圈。这里内置一份分类目录，按预设生成规则集引用和对应的策略组。
 *
 * 规则文件本身不由面板托管，而是引用两家上游的现成规则集：mihomo 用
 * MetaCubeX/meta-rules-dat 的 .mrs，sing-box 用 SagerNet 的 .srs。两边的键名
 * 大体一致，但 URL 结构完全不同，所以分开拼。
 */

export const PROXY_RULE_PRESETS = ["off", "minimal", "balanced", "comprehensive"] as const;

export type ProxyRulePreset = (typeof PROXY_RULE_PRESETS)[number];

export const PROXY_RULE_PRESET_LABELS: Record<ProxyRulePreset, string> = {
  off: "不带规则",
  minimal: "精简",
  balanced: "均衡",
  comprehensive: "完整",
};

export const PROXY_RULE_PRESET_HINTS: Record<ProxyRulePreset, string> = {
  off: "只给节点，分流规则你自己在客户端里配。",
  minimal: "只处理广告拦截、局域网和国内直连，其余全走代理。规则少，加载快。",
  balanced: "在精简的基础上，为 AI、油管、谷歌、电报、GitHub、奈飞各建一个策略组。",
  comprehensive: "再加上微软、苹果、Spotify、Disney+、Steam、Twitter、TikTok、PayPal、哔哩哔哩。",
};

export function normalizeProxyRulePreset(value: unknown): ProxyRulePreset {
  const raw = String(value ?? "").trim().toLowerCase();
  return (PROXY_RULE_PRESETS as readonly string[]).includes(raw) ? raw as ProxyRulePreset : "off";
}

/** 分类命中后默认去向。proxy 表示交给主选择器。 */
export type ProxyRuleOutbound = "proxy" | "direct" | "reject";

export type ProxyRuleCategory = {
  /** 内部标识，同时用作规则集名称前缀，必须是安全标识符 */
  key: string;
  label: string;
  emoji: string;
  presets: readonly ProxyRulePreset[];
  outbound: ProxyRuleOutbound;
  /** 上游 geosite 键 */
  siteKeys: readonly string[];
  /** 上游 geoip 键 */
  ipKeys?: readonly string[];
  /** IP 规则是否加 no-resolve，见 ProxyRouteRule 的说明 */
  ipNoResolve?: boolean;
  /** 用两家的原生私有网段判断，而不是外部 geoip 规则集 */
  privateIp?: boolean;
};

/**
 * 分类目录。顺序即规则顺序，命中即止，所以局域网和广告必须排在最前，
 * 国内直连必须排在各服务之后 —— 否则 youtube.com 会先被国内规则截走。
 */
export const PROXY_RULE_CATEGORIES: readonly ProxyRuleCategory[] = [
  {
    key: "private",
    label: "局域网",
    emoji: "🏠",
    presets: ["minimal", "balanced", "comprehensive"],
    outbound: "direct",
    siteKeys: ["private"],
    privateIp: true,
  },
  {
    key: "ads",
    label: "广告拦截",
    emoji: "🛑",
    presets: ["minimal", "balanced", "comprehensive"],
    outbound: "reject",
    siteKeys: ["category-ads-all"],
  },
  {
    key: "ai",
    label: "AI 服务",
    emoji: "🤖",
    presets: ["balanced", "comprehensive"],
    outbound: "proxy",
    siteKeys: ["category-ai-!cn", "openai"],
  },
  {
    key: "youtube",
    label: "油管视频",
    emoji: "📹",
    presets: ["balanced", "comprehensive"],
    outbound: "proxy",
    siteKeys: ["youtube"],
  },
  {
    key: "google",
    label: "谷歌服务",
    emoji: "🔍",
    presets: ["balanced", "comprehensive"],
    outbound: "proxy",
    siteKeys: ["google"],
  },
  {
    key: "telegram",
    label: "电报消息",
    emoji: "✈️",
    presets: ["balanced", "comprehensive"],
    outbound: "proxy",
    siteKeys: ["telegram"],
    ipKeys: ["telegram"],
    ipNoResolve: true,
  },
  {
    key: "github",
    label: "GitHub",
    emoji: "🐱",
    presets: ["balanced", "comprehensive"],
    outbound: "proxy",
    siteKeys: ["github"],
  },
  {
    key: "netflix",
    label: "奈飞视频",
    emoji: "🎥",
    presets: ["balanced", "comprehensive"],
    outbound: "proxy",
    siteKeys: ["netflix"],
    ipKeys: ["netflix"],
  },
  {
    key: "microsoft",
    label: "微软服务",
    emoji: "Ⓜ️",
    presets: ["comprehensive"],
    outbound: "proxy",
    siteKeys: ["microsoft"],
  },
  {
    key: "apple",
    label: "苹果服务",
    emoji: "🍎",
    presets: ["comprehensive"],
    outbound: "proxy",
    siteKeys: ["apple"],
  },
  {
    key: "spotify",
    label: "音乐流媒体",
    emoji: "🎵",
    presets: ["comprehensive"],
    outbound: "proxy",
    siteKeys: ["spotify"],
  },
  {
    key: "disney",
    label: "迪士尼",
    emoji: "🏰",
    presets: ["comprehensive"],
    outbound: "proxy",
    siteKeys: ["disney"],
  },
  {
    key: "steam",
    label: "游戏平台",
    emoji: "🎮",
    presets: ["comprehensive"],
    outbound: "proxy",
    siteKeys: ["steam"],
  },
  {
    key: "twitter",
    label: "推特",
    emoji: "🐦",
    presets: ["comprehensive"],
    outbound: "proxy",
    siteKeys: ["twitter"],
  },
  {
    key: "tiktok",
    label: "TikTok",
    emoji: "🎬",
    presets: ["comprehensive"],
    outbound: "proxy",
    siteKeys: ["tiktok"],
  },
  {
    key: "paypal",
    label: "PayPal",
    emoji: "💰",
    presets: ["comprehensive"],
    outbound: "proxy",
    siteKeys: ["paypal"],
  },
  {
    key: "bilibili",
    label: "哔哩哔哩",
    emoji: "📺",
    presets: ["comprehensive"],
    outbound: "direct",
    siteKeys: ["bilibili", "biliintl"],
  },
  {
    // 必须排在所有服务分类之后：命中即止，放前面会把 youtube.com 之类一并截走。
    key: "cn",
    label: "国内直连",
    emoji: "🎯",
    presets: ["minimal", "balanced", "comprehensive"],
    outbound: "direct",
    siteKeys: ["cn"],
    ipKeys: ["cn"],
  },
];

export function proxyRuleCategoriesForPreset(preset: ProxyRulePreset): ProxyRuleCategory[] {
  if (preset === "off") return [];
  return PROXY_RULE_CATEGORIES.filter((category) => category.presets.includes(preset));
}

/** 分类对应的策略组名，与节点名风格一致，方便在客户端里辨认。 */
export function proxyRuleCategoryGroupName(category: ProxyRuleCategory): string {
  return `${category.emoji} ${category.label}`;
}

// ==================== 规则集引用 ====================

export type ProxyRuleSetBehavior = "domain" | "ipcidr";

export type ProxyRuleSetRef = {
  /** 规则集名称，Clash 的 rule-provider 名与 sing-box 的 tag 共用 */
  name: string;
  behavior: ProxyRuleSetBehavior;
  /** 上游 geosite / geoip 键 */
  geoKey: string;
  /**
   * 仅 mihomo 可用。SagerNet 的 sing-geoip 只按国家代码发布，像 telegram、
   * netflix 这种非国家的 IP 集在那边根本不存在，照发会让 sing-box 拿到 404
   * 的规则集而启动失败。渲染 sing-box 时这类引用连同其规则一起跳过，域名
   * 规则仍然覆盖绝大部分流量。
   */
  mihomoOnly?: boolean;
};

export type ProxyRouteRule =
  | {
    type: "rule-set";
    ruleSet: string;
    target: string;
    /**
     * IP 类规则若不加 no-resolve，客户端为了判断目标 IP 会先把域名解析一遍，
     * 等于在规则命中前就发生了 DNS 查询。局域网这类靠前的 IP 规则必须加，
     * 而收尾的国内 IP 规则本就指望解析后再判断，不能加。
     */
    noResolve?: boolean;
  }
  /**
   * 局域网 IP。两家都有原生表达，不必依赖外部规则集：Clash 直接列私有网段，
   * sing-box 用内置的 ip_is_private。少一个下载依赖，也少一个 404 的可能。
   */
  | { type: "ip-private"; target: string }
  /**
   * 下面四种来自自定义规则（shared/proxySubCustomRules.ts）。预设规则只用上面几种；
   * 这几种各家都有原生写法：Clash 的 DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / IP-CIDR /
   * GEOIP / GEOSITE，sing-box 的 domain / domain_suffix / domain_keyword / ip_cidr /
   * rule_set（geoip-xx / geosite-xx 远程规则集），iOS 四家的 DOMAIN… / IP-CIDR / GEOIP。
   */
  | { type: "domain"; match: "exact" | "suffix" | "keyword"; value: string; target: string }
  | { type: "ip-cidr"; value: string; v6: boolean; target: string; noResolve?: boolean }
  | { type: "geoip"; code: string; target: string; noResolve?: boolean }
  | { type: "geosite"; key: string; target: string }
  | { type: "match"; target: string };

export const PROXY_RULE_TARGET_DIRECT = "DIRECT";
export const PROXY_RULE_TARGET_REJECT = "REJECT";

/** 上游规则集地址。分开定义是因为两家的仓库和文件格式都不一样。 */
export const MIHOMO_RULESET_BASE = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo";
export const SINGBOX_GEOSITE_BASE = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set";
export const SINGBOX_GEOIP_BASE = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set";

export function mihomoRuleSetUrl(ref: ProxyRuleSetRef): string {
  const folder = ref.behavior === "ipcidr" ? "geoip" : "geosite";
  return `${MIHOMO_RULESET_BASE}/${folder}/${ref.geoKey}.mrs`;
}

export function singboxRuleSetUrl(ref: ProxyRuleSetRef): string {
  return ref.behavior === "ipcidr"
    ? `${SINGBOX_GEOIP_BASE}/geoip-${ref.geoKey}.srs`
    : `${SINGBOX_GEOSITE_BASE}/geosite-${ref.geoKey}.srs`;
}

/**
 * Surge / Loon / Quantumult X / Shadowrocket 的完整配置用的规则列表。
 *
 * 这四家读不了 mihomo 的 .mrs，也读不了 sing-box 的 .srs，要各自格式的文本列表。
 * blackmatrix7/ios_rule_script 为四家各出一份同名文件，2026-09-27 逐个
 * HEAD 过（名字 × 四家全部 200）。新增分类时同样要逐个核对再加进来。
 *
 * 空数组表示跳过：telegram / netflix 的 IP 已经在各自域名列表里带着；
 * biliintl 由 BiliBili 覆盖；国内 IP 用四家都原生支持的 GEOIP,CN（见
 * iosRuleUsesNativeGeoipCn），不必再下一份列表。
 */
export type IosRuleClient = "Surge" | "Loon" | "QuantumultX" | "Shadowrocket";

export const IOS_RULE_SCRIPT_BASE = "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule";

const IOS_RULE_LIST_NAMES: Record<string, readonly string[]> = {
  "domain:private": ["Lan"],
  "domain:category-ads-all": ["AdvertisingLite"],
  // Anthropic / BardAI / Copilot 2026-10-17 四家逐个 HEAD 过（全部 200）。
  "domain:category-ai-!cn": ["Claude", "Anthropic", "Gemini", "BardAI", "Copilot"],
  "domain:openai": ["OpenAI"],
  "domain:youtube": ["YouTube"],
  "domain:google": ["Google"],
  "domain:telegram": ["Telegram"],
  "domain:github": ["GitHub"],
  "domain:netflix": ["Netflix"],
  "domain:microsoft": ["Microsoft"],
  "domain:apple": ["Apple"],
  "domain:spotify": ["Spotify"],
  "domain:disney": ["Disney"],
  "domain:steam": ["Steam"],
  "domain:twitter": ["Twitter"],
  "domain:tiktok": ["TikTok"],
  "domain:paypal": ["PayPal"],
  "domain:bilibili": ["BiliBili"],
  "domain:cn": ["China"],
};

export function iosRuleListNames(ref: Pick<ProxyRuleSetRef, "behavior" | "geoKey">): readonly string[] {
  return IOS_RULE_LIST_NAMES[`${ref.behavior}:${ref.geoKey}`] || [];
}

export type IosInlineDomainRule = { match: "suffix" | "exact"; domain: string };

/**
 * blackmatrix7 的列表跟不上的域名，直接写进配置（和远程列表同一个去向）。
 *
 * AI 这一类：mihomo / sing-box 用的 v2fly category-ai-!cn 覆盖了这些服务，iOS 四家的列表
 * （Claude / Gemini / OpenAI …）却很旧：Claude 新域名、AI Studio、NotebookLM 缺，Perplexity、
 * Grok、Cursor 这些干脆没有现成列表。漏掉的会落到「谷歌服务」或兜底组，AI 组单独指向美国出口时
 * 就白指了。新增时只放常见、确实需要非大陆出口的服务。
 */
const IOS_INLINE_DOMAIN_RULES: Record<string, readonly IosInlineDomainRule[]> = {
  "domain:category-ai-!cn": [
    ...[
      // Anthropic / Claude
      "claude.com", "claudeusercontent.com", "clau.de", "claude.dev",
      // Google Gemini / AI Studio / NotebookLM
      "gemini.google", "aistudio.google.com", "notebooklm.google", "notebooklm.google.com", "labs.google", "jules.google",
      "generativelanguage.googleapis.com",
      // OpenAI
      "sora.com",
      // 其它常见 AI 服务
      "perplexity.ai", "pplx.ai", "grok.com", "x.ai", "meta.ai", "mistral.ai", "poe.com",
      "cursor.com", "cursor.sh", "cursorapi.com", "githubcopilot.com", "huggingface.co", "groq.com", "cohere.com",
      "elevenlabs.io", "midjourney.com",
    ].map((domain) => ({ match: "suffix" as const, domain })),
    { match: "exact", domain: "copilot-proxy.githubusercontent.com" },
  ],
};

export function iosInlineDomainRules(ref: Pick<ProxyRuleSetRef, "behavior" | "geoKey">): readonly IosInlineDomainRule[] {
  return IOS_INLINE_DOMAIN_RULES[`${ref.behavior}:${ref.geoKey}`] || [];
}

/** 国内 IP 走各家内置的 GEOIP，不用下载列表。 */
export function iosRuleUsesNativeGeoipCn(ref: Pick<ProxyRuleSetRef, "behavior" | "geoKey">): boolean {
  return ref.behavior === "ipcidr" && ref.geoKey === "cn";
}

export function iosRuleListUrl(client: IosRuleClient, name: string): string {
  return `${IOS_RULE_SCRIPT_BASE}/${client}/${name}/${name}.list`;
}

export type ProxyRulePlan = {
  ruleSets: ProxyRuleSetRef[];
  /** 分类策略组，需要用户能改去向的分类才有 */
  categoryGroups: { name: string; members: string[] }[];
  rules: ProxyRouteRule[];
};

/**
 * 规则集名称取分类键，同一分类有多个上游键时加序号。
 * 直接用 geosite 键会带进 `!` 这种字符，做标识符不安全。
 */
/**
 * SagerNet 的 sing-geosite 里没有的上游键。逐个实拉验证得出，不是猜的；
 * 新增分类时同样要拉一遍，漏一个就会让 sing-box 拿到 404 的规则集而启动失败。
 */
const SINGBOX_MISSING_GEOSITE_KEYS = new Set(["biliintl"]);

/** sing-geoip 只按 ISO 国家代码发布，telegram、netflix 这类非国家 IP 集那边没有。 */
function isCountryCode(geoKey: string): boolean {
  return /^[a-z]{2}$/.test(geoKey);
}

export function geoKeyIsMihomoOnly(behavior: ProxyRuleSetBehavior, geoKey: string): boolean {
  return behavior === "ipcidr" ? !isCountryCode(geoKey) : SINGBOX_MISSING_GEOSITE_KEYS.has(geoKey);
}

function ruleSetName(category: ProxyRuleCategory, kind: ProxyRuleSetBehavior, index: number, total: number): string {
  const suffix = kind === "ipcidr" ? "-ip" : "";
  return total > 1 ? `${category.key}${suffix}-${index + 1}` : `${category.key}${suffix}`;
}

export type BuildProxyRulePlanOptions = {
  preset: ProxyRulePreset;
  /** 主选择器名，proxy 类分类默认指向它 */
  mainGroupName: string;
  /** 可供分类组选择的其他成员：自动选路组和各节点 */
  selectableMembers: readonly string[];
  /**
   * 分类去向覆盖（按令牌）：分类 key → DIRECT / REJECT / PROXY / 某个可选成员名。
   * 覆盖的是「默认去向」—— 组还是建，用户在客户端里照样能改；REJECT 则不建组。
   */
  categoryTargets?: Record<string, string>;
};

/**
 * 生成分流计划。
 *
 * 每个 proxy / direct 分类都建一个策略组，而不是让规则直接指向 DIRECT 或主
 * 选择器 —— 这样用户在客户端里能单独改某一类的去向（比如让 AI 走某条中转，
 * 哔哩哔哩强制直连），不用回面板改订阅。广告是例外，拦截没有可选项。
 */
export function buildProxyRulePlan(options: BuildProxyRulePlanOptions): ProxyRulePlan {
  const categories = proxyRuleCategoriesForPreset(options.preset);
  const ruleSets: ProxyRuleSetRef[] = [];
  const categoryGroups: { name: string; members: string[] }[] = [];
  const rules: ProxyRouteRule[] = [];

  const selectable = new Set(options.selectableMembers);
  for (const category of categories) {
    const groupName = proxyRuleCategoryGroupName(category);
    let target: string;
    // 令牌上的覆盖：认 DIRECT / REJECT / PROXY 和可选成员名，别的当没写。
    const overrideRaw = String(options.categoryTargets?.[category.key] || "").trim();
    const override = overrideRaw.toUpperCase() === "DIRECT" || overrideRaw.toUpperCase() === "REJECT" || overrideRaw.toUpperCase() === "PROXY"
      ? overrideRaw.toUpperCase()
      : selectable.has(overrideRaw) ? overrideRaw : "";
    const outbound: ProxyRuleOutbound = override === "DIRECT" ? "direct" : override === "REJECT" ? "reject" : override ? "proxy" : category.outbound;
    if (outbound === "reject") {
      target = PROXY_RULE_TARGET_REJECT;
    } else {
      target = groupName;
      // 首选项即默认去向，用户在客户端里可以随时改成别的。
      const preferred = override && override !== "DIRECT" && override !== "PROXY"
        ? [override, options.mainGroupName, PROXY_RULE_TARGET_DIRECT]
        : outbound === "direct"
          ? [PROXY_RULE_TARGET_DIRECT, options.mainGroupName]
          : [options.mainGroupName, PROXY_RULE_TARGET_DIRECT];
      categoryGroups.push({
        name: groupName,
        members: [...preferred, ...options.selectableMembers.filter((member) => !preferred.includes(member))],
      });
    }

    const siteKeys = category.siteKeys;
    siteKeys.forEach((geoKey, index) => {
      const name = ruleSetName(category, "domain", index, siteKeys.length);
      ruleSets.push({
        name,
        behavior: "domain",
        geoKey,
        ...(geoKeyIsMihomoOnly("domain", geoKey) ? { mihomoOnly: true } : {}),
      });
      rules.push({ type: "rule-set", ruleSet: name, target });
    });

    if (category.privateIp) rules.push({ type: "ip-private", target });

    const ipKeys = category.ipKeys || [];
    ipKeys.forEach((geoKey, index) => {
      const name = ruleSetName(category, "ipcidr", index, ipKeys.length);
      ruleSets.push({
        name,
        behavior: "ipcidr",
        geoKey,
        ...(geoKeyIsMihomoOnly("ipcidr", geoKey) ? { mihomoOnly: true } : {}),
      });
      rules.push({
        type: "rule-set",
        ruleSet: name,
        target,
        ...(category.ipNoResolve ? { noResolve: true } : {}),
      });
    });
  }

  rules.push({ type: "match", target: options.mainGroupName });
  return { ruleSets, categoryGroups, rules };
}

/** Clash 侧展开用的私有网段，与 sing-box 的 ip_is_private 等价。 */
export const PROXY_PRIVATE_IP_CIDRS: readonly string[] = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
];

export const PROXY_PRIVATE_IP6_CIDRS: readonly string[] = ["::1/128", "fc00::/7", "fe80::/10"];
