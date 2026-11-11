/**
 * 订阅模板：每种目标格式一份「开头部分」加一组自定义策略组。
 *
 * 为什么不是整份配置文件当模板（Xboard 的 resources/rules/*.yaml 那种）：那要求面板
 * 带一个 YAML 解析 / 序列化器去把节点塞进现成的树里，而面板到现在都没依赖 YAML 库。
 * 这里的分工是 —— 模板只管「节点之外」的部分（端口、DNS、TUN、日志……），节点、
 * 策略组、规则集、分流规则照旧由面板生成并接在后面。能改的东西覆盖了绝大多数需求
 * （「订阅导进去 DNS 不对」「想要 tun 模式」「要加个 🇭🇰 香港组」），又不会因为
 * 模板写坏一个缩进让整份订阅 500。
 *
 * 三种开头部分：
 *   - Clash：放在 proxies: 前面的 YAML 文本，不能含 proxies / proxy-groups / rule-providers / rules。
 *   - sing-box：一个 JSON 对象（log / dns / inbounds / experimental / route.rules……），面板把
 *     outbounds 和 route 并进去。
 *   - Surge / Loon / Quantumult X / Shadowrocket：整段 [General]（含那一行表头）。
 *   - Egern：放在 proxies: 前面的 YAML 文本（和 Clash 同理），不能含 proxies / policy_groups / rules / modules。
 *   - Base64 / Xray JSON 没有模板（前者没有位置，后者的 DNS / 入站由客户端自己管）。
 *
 * 占位符：{{app_name}} {{panel_url}} {{sub_url}} {{username}} {{expire_date}} {{data_left}} {{test_url}}。
 *
 * 另外两样（都只进规则订阅）：
 *   - 分流规则：和全局 / 用户 / 令牌的自定义规则同一种文本（shared/proxySubCustomRules.ts），
 *     排在全局前置之后。停用的规则存成注释行（`# DOMAIN,…`），文本里看得见、渲染时跳过。
 *   - 模块 / 插件：Loon 的 [Plugin]、Egern 的 modules（shared/proxySubModules.ts）。
 *
 * 管理员界面上有可视化编辑（client/src/components/proxy/ProxySubTemplateVisualEditor.tsx），
 * 存的还是这几样原始数据：可视化只是换个方式改它们，不另存一份。
 */

import type { ProxySubCustomGroup } from "./proxySubscriptionPlan";
import { normalizeProxySubGroupMatch, validateProxySubGroupFilter } from "./proxySubGroupFilter";
import { PROXY_SUBSCRIPTION_GROUP_NAME, type ProxySubscriptionFormat } from "./proxySubscription";
import { parseProxyCustomRules } from "./proxySubCustomRules";
import { proxySubModuleProblem, PROXY_SUB_TEMPLATE_MODULE_LIMITS, type ProxySubModuleFlavor, type ProxySubTemplateModule } from "./proxySubModules";

export const PROXY_SUB_TEMPLATE_TARGETS = ["clash", "singbox", "surge", "loon", "quantumultx", "shadowrocket", "egern"] as const;

export type ProxySubTemplateTarget = (typeof PROXY_SUB_TEMPLATE_TARGETS)[number];

export const PROXY_SUB_TEMPLATE_TARGET_LABELS: Record<ProxySubTemplateTarget, string> = {
  clash: "Clash / mihomo / Stash",
  singbox: "sing-box",
  surge: "Surge / Surfboard",
  loon: "Loon",
  quantumultx: "Quantumult X",
  shadowrocket: "Shadowrocket",
  egern: "Egern",
};

export function proxySubTemplateTargetForFormat(format: ProxySubscriptionFormat): ProxySubTemplateTarget | null {
  return (PROXY_SUB_TEMPLATE_TARGETS as readonly string[]).includes(format) ? format as ProxySubTemplateTarget : null;
}

export type ProxySubTemplate = {
  id?: number;
  name: string;
  target: ProxySubTemplateTarget;
  prelude: string;
  customGroups: ProxySubCustomGroup[];
  /** 模板里的分流规则文本；空串 = 没有。 */
  customRules: string;
  /** 模块 / 插件引用；Loon 和 Egern 模板用得上。 */
  modules: ProxySubTemplateModule[];
  isDefault?: boolean;
};

/** 哪些目标格式的模板能挂模块 / 插件（界面据此显示那一块，保存时据此校验）。 */
export const PROXY_SUB_TEMPLATE_MODULE_TARGETS: readonly ProxySubTemplateTarget[] = ["loon", "egern"];

/** 界面和报错里怎么叫它：Loon 叫插件（[Plugin]），Egern 叫模块（modules）。参数的写法也跟着不同。 */
export function proxySubTemplateModuleFlavor(target: ProxySubTemplateTarget): ProxySubModuleFlavor {
  return target === "egern" ? "egern" : "loon";
}

export const PROXY_SUB_TEMPLATE_MODULE_NOUNS: Record<ProxySubModuleFlavor, string> = { loon: "插件", egern: "模块" };

/** 模板分流规则文本的长度上限（条数上限和别处的自定义规则一样，见 parseProxyCustomRules）。 */
export const PROXY_SUB_TEMPLATE_RULES_MAX_LENGTH = 60_000;

/** 自定义组点名成员的上限。 */
export const PROXY_SUB_CUSTOM_GROUP_MAX_MEMBERS = 50;

/** 内置的开头部分。改这里等于改所有没自定义模板的用户的订阅，要慎重。 */
export const PROXY_SUB_BUILTIN_PRELUDES: Record<ProxySubTemplateTarget, string> = {
  clash: [
    "# {{app_name}} 订阅 · {{username}}",
    "mixed-port: 7890",
    "allow-lan: false",
    "mode: rule",
    "log-level: info",
    "ipv6: true",
    "unified-delay: true",
    "tcp-concurrent: true",
    "dns:",
    "  enable: true",
    "  listen: 0.0.0.0:1053",
    "  ipv6: true",
    "  enhanced-mode: fake-ip",
    "  fake-ip-range: 198.18.0.1/16",
    "  fake-ip-filter:",
    "    - \"*.lan\"",
    "    - \"*.local\"",
    "    - \"localhost.ptlogin2.qq.com\"",
    "  default-nameserver:",
    "    - 223.5.5.5",
    "    - 119.29.29.29",
    "  nameserver:",
    "    - https://dns.alidns.com/dns-query",
    "    - https://doh.pub/dns-query",
    "  proxy-server-nameserver:",
    "    - https://dns.alidns.com/dns-query",
    "sniffer:",
    "  enable: true",
    "  sniff:",
    "    HTTP:",
    "      ports: [80, 8080-8880]",
    "    TLS:",
    "      ports: [443, 8443]",
    "",
  ].join("\n"),
  singbox: JSON.stringify({
    log: { level: "info", timestamp: true },
    dns: {
      servers: [
        { tag: "dns-remote", address: "https://1.1.1.1/dns-query", detour: "{{main_group}}" },
        { tag: "dns-direct", address: "https://223.5.5.5/dns-query", detour: "direct" },
        { tag: "dns-local", address: "local", detour: "direct" },
      ],
      rules: [
        { outbound: "any", server: "dns-local" },
        { rule_set: ["geosite-cn"], server: "dns-direct" },
      ],
      final: "dns-remote",
      strategy: "prefer_ipv4",
    },
    inbounds: [
      { type: "tun", tag: "tun-in", address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"], auto_route: true, strict_route: true, stack: "mixed", sniff: true },
      { type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080, sniff: true },
    ],
    route: {
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
      ],
      rule_set: [
        { type: "remote", tag: "geosite-cn", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs", download_detour: "direct" },
      ],
      auto_detect_interface: true,
    },
    experimental: {
      cache_file: { enabled: true, store_fakeip: false },
      clash_api: { external_controller: "127.0.0.1:9090" },
    },
  }, null, 2),
  surge: [
    "[General]",
    "loglevel = notify",
    "skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local",
    "dns-server = system, 223.5.5.5, 119.29.29.29",
    "internet-test-url = {{test_url}}",
    "proxy-test-url = {{test_url}}",
  ].join("\n"),
  loon: [
    "[General]",
    "skip-proxy = 127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,100.64.0.0/10,localhost,*.local",
    "dns-server = system,223.5.5.5,119.29.29.29",
    "proxy-test-url = {{test_url}}",
    "internet-test-url = {{test_url}}",
  ].join("\n"),
  quantumultx: [
    "[general]",
    "server_check_url={{test_url}}",
  ].join("\n"),
  shadowrocket: [
    "[General]",
    "bypass-system = true",
    "skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local",
    "dns-server = system",
  ].join("\n"),
  /*
    Egern 只放一个全局测速地址：DNS、TUN 这些 Egern 自己的默认就能用，内置模板不替用户改；
    要定制的管理员自己建 Egern 模板。组上的测速地址面板另外写（见 proxySubEgern.ts）。
  */
  egern: [
    "# {{app_name}} 订阅 · {{username}}",
    "proxy_latency_test_url: \"{{test_url}}\"",
  ].join("\n"),
};

export type ProxySubTemplateVariables = {
  appName: string;
  panelUrl: string;
  subUrl: string;
  username: string;
  expireDate: string;
  dataLeft: string;
  testUrl: string;
  mainGroup: string;
};

/** 占位符替换。sing-box 的模板是 JSON，值里的引号和反斜杠要转义，否则一个用户名带引号就把 JSON 打坏。 */
export function renderProxySubTemplatePrelude(prelude: string, vars: ProxySubTemplateVariables, target: ProxySubTemplateTarget): string {
  const escape = (value: string) => (target === "singbox" ? JSON.stringify(value).slice(1, -1) : value);
  const map: Record<string, string> = {
    app_name: vars.appName,
    panel_url: vars.panelUrl,
    sub_url: vars.subUrl,
    username: vars.username,
    expire_date: vars.expireDate,
    data_left: vars.dataLeft,
    test_url: vars.testUrl,
    main_group: vars.mainGroup,
  };
  return String(prelude || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => (key in map ? escape(map[key]) : whole));
}

/** Clash 的开头部分不能带这几个键 —— 带了就和面板生成的部分撞车，客户端读到两份 proxies。 */
const CLASH_RESERVED_KEYS = /^(proxies|proxy-groups|rule-providers|rules|proxy-providers)\s*:/m;

/** Egern 同理；modules 也由面板写（模板的「模块」一栏），两份 modules 键同样会撞车。 */
const EGERN_RESERVED_KEYS = /^(proxies|policy_groups|rules|modules)\s*:/m;

export type ProxySubTemplateValidation = { ok: true } | { ok: false; error: string };

export function validateProxySubTemplate(template: Pick<ProxySubTemplate, "target" | "prelude" | "customGroups"> & Partial<Pick<ProxySubTemplate, "customRules" | "modules">>): ProxySubTemplateValidation {
  const prelude = String(template.prelude || "");
  if (prelude.length > 60_000) return { ok: false, error: "模板太长（上限 60000 字符）" };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(prelude)) return { ok: false, error: "模板里有控制字符" };
  if (template.target === "clash" && CLASH_RESERVED_KEYS.test(prelude)) {
    return { ok: false, error: "Clash 模板不能含 proxies / proxy-groups / rule-providers / rules，这几段由面板生成" };
  }
  if (template.target === "egern" && EGERN_RESERVED_KEYS.test(prelude)) {
    return { ok: false, error: "Egern 模板不能含 proxies / policy_groups / rules / modules，这几段由面板生成（模块写在下面的「Egern 模块」里）" };
  }
  if (template.target === "singbox" && prelude.trim()) {
    try {
      // 占位符先换成占位值再校验 JSON，否则 {{x}} 本身就不是合法 JSON。
      const probe = prelude.replace(/\{\{\s*[a-z_]+\s*\}\}/g, "x");
      const parsed = JSON.parse(probe);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "sing-box 模板必须是一个 JSON 对象" };
      if (Array.isArray((parsed as any).outbounds) && (parsed as any).outbounds.some((item: any) => item?.tag === "direct")) {
        return { ok: false, error: "sing-box 模板里不用写 direct 出站，面板会生成" };
      }
    } catch (error) {
      return { ok: false, error: `sing-box 模板不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if ((template.target === "surge" || template.target === "loon" || template.target === "shadowrocket") && prelude.trim() && !/^\s*\[General\]/i.test(prelude)) {
    return { ok: false, error: "这种模板要以 [General] 开头" };
  }
  if (template.target === "quantumultx" && prelude.trim() && !/^\s*\[general\]/i.test(prelude)) {
    return { ok: false, error: "Quantumult X 模板要以 [general] 开头" };
  }
  const groups = template.customGroups || [];
  for (const group of groups) {
    const name = String(group.name || "").trim();
    if (!name) return { ok: false, error: "自定义策略组要有名字" };
    if (name.length > 64 || /[,=\u0000-\u001f]/.test(name)) return { ok: false, error: `策略组名「${name}」不合法（不能含逗号、等号）` };
    if (!["select", "url-test", "fallback", "load-balance"].includes(group.type)) return { ok: false, error: `策略组「${name}」的类型不认识` };
    if (String(group.filter || "").length > 200) return { ok: false, error: `策略组「${name}」的筛选表达式太长` };
    const problem = validateProxySubGroupFilter(String(group.filter || ""), normalizeProxySubGroupMatch(group.match));
    if (problem) return { ok: false, error: `策略组「${name}」的筛选表达式有问题：${problem}` };
    const members = Array.isArray(group.members) ? group.members : [];
    if (members.length > PROXY_SUB_CUSTOM_GROUP_MAX_MEMBERS) return { ok: false, error: `策略组「${name}」点名的成员太多（上限 ${PROXY_SUB_CUSTOM_GROUP_MAX_MEMBERS} 个）` };
    for (const raw of members) {
      const member = String(raw || "").trim();
      if (!member || member.length > 64 || /[,=\u0000-\u001f]/.test(member)) return { ok: false, error: `策略组「${name}」的成员「${member}」不合法（不能含逗号、等号）` };
      if (member === name) return { ok: false, error: `策略组「${name}」不能把自己列成成员` };
      if (member === "REJECT") return { ok: false, error: `策略组「${name}」不能放 REJECT（sing-box 里没有这个出站），要拦截请写分流规则` };
      if (member === PROXY_SUBSCRIPTION_GROUP_NAME || member.toUpperCase() === "PROXY") {
        return { ok: false, error: `策略组「${name}」不能引用主选择器「${PROXY_SUBSCRIPTION_GROUP_NAME}」：主选择器本来就列着它，会成环` };
      }
    }
    if (group.includeNodes === false && members.length === 0 && !group.includeGroups) {
      return { ok: false, error: `策略组「${name}」既不挑节点、也没点名成员，会是个空组` };
    }
  }
  const cycle = findProxySubCustomGroupCycle(groups);
  if (cycle) return { ok: false, error: `策略组互相引用成了环：${cycle.join(" → ")}` };

  const rulesText = String(template.customRules || "");
  if (rulesText.length > PROXY_SUB_TEMPLATE_RULES_MAX_LENGTH) return { ok: false, error: `分流规则太长（上限 ${PROXY_SUB_TEMPLATE_RULES_MAX_LENGTH} 字符）` };
  if (rulesText.trim()) {
    const parsed = parseProxyCustomRules(rulesText);
    if (parsed.errors.length > 0) return { ok: false, error: `分流规则第 ${parsed.errors[0].line} 行：${parsed.errors[0].message}` };
  }

  const modules = template.modules || [];
  if (modules.length > 0 && !PROXY_SUB_TEMPLATE_MODULE_TARGETS.includes(template.target)) {
    return { ok: false, error: "只有 Loon 和 Egern 模板能挂插件 / 模块" };
  }
  const flavor = proxySubTemplateModuleFlavor(template.target);
  if (modules.length > PROXY_SUB_TEMPLATE_MODULE_LIMITS.count) return { ok: false, error: `${PROXY_SUB_TEMPLATE_MODULE_NOUNS[flavor]}最多 ${PROXY_SUB_TEMPLATE_MODULE_LIMITS.count} 个` };
  for (const [index, module] of modules.entries()) {
    const problem = proxySubModuleProblem(module, index, flavor);
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true };
}

/** 自定义组之间的引用有没有成环；有就返回环上的组名（首尾相同），没有返回 null。 */
export function findProxySubCustomGroupCycle(groups: readonly Pick<ProxySubCustomGroup, "name" | "members">[]): string[] | null {
  const names = groups.map((group) => String(group.name || "").trim());
  const byName = new Map<string, number>();
  names.forEach((name, index) => { if (name && !byName.has(name)) byName.set(name, index); });
  const state = names.map(() => 0);
  const stack: number[] = [];
  const visit = (index: number): string[] | null => {
    state[index] = 1;
    stack.push(index);
    for (const raw of groups[index].members || []) {
      const target = byName.get(String(raw || "").trim());
      if (target === undefined || target === index) continue;
      if (state[target] === 1) return [...stack.slice(stack.indexOf(target)).map((item) => names[item]), names[target]];
      if (state[target] === 0) {
        const found = visit(target);
        if (found) return found;
      }
    }
    stack.pop();
    state[index] = 2;
    return null;
  };
  for (let index = 0; index < names.length; index += 1) {
    if (state[index] !== 0 || !names[index]) continue;
    const found = visit(index);
    if (found) return found;
  }
  return null;
}

const KNOWN_GROUP_KEYS = new Set(["name", "type", "filter", "match", "includeGroups", "members", "includeNodes"]);

/**
 * 认不出的字段原样留下（见 ProxySubCustomGroup 的说明），但要有个度：键名像个标识符、最多 20 个、
 * 序列化后不超过 2000 字符，超了就一个都不留 —— 这是给「别处来的几个附加字段」留的位置，不是存储桶。
 */
function preservedExtras(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(item)) {
    if (KNOWN_GROUP_KEYS.has(key) || !/^[A-Za-z_][\w-]{0,40}$/.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") continue;
    out[key] = value;
    count += 1;
    if (count >= 20) break;
  }
  if (count === 0) return {};
  try {
    const json = JSON.stringify(out);
    return json.length <= 2000 ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

export function normalizeProxySubCustomGroups(input: unknown): ProxySubCustomGroup[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item: any): ProxySubCustomGroup => {
      const members = Array.isArray(item?.members)
        ? Array.from(new Set((item.members as unknown[]).map((member) => String(member ?? "").trim().slice(0, 64)).filter(Boolean))).slice(0, PROXY_SUB_CUSTOM_GROUP_MAX_MEMBERS)
        : [];
      return {
        ...(item && typeof item === "object" ? preservedExtras(item) : {}),
        name: String(item?.name || "").trim().slice(0, 64),
        type: (["select", "url-test", "fallback", "load-balance"].includes(item?.type) ? item.type : "select") as ProxySubCustomGroup["type"],
        filter: String(item?.filter || "").trim().slice(0, 200),
        match: normalizeProxySubGroupMatch(item?.match),
        includeGroups: item?.includeGroups === true,
        // 两个新字段只在用到时才写：老模板存回去和原来一个字都不差。
        ...(members.length > 0 ? { members } : {}),
        ...(item?.includeNodes === false ? { includeNodes: false } : {}),
      };
    })
    .filter((item) => item.name)
    .slice(0, 30);
}

export function parseProxySubCustomGroupsJson(json: unknown): ProxySubCustomGroup[] {
  if (!json || typeof json !== "string") return [];
  try {
    return normalizeProxySubCustomGroups(JSON.parse(json));
  } catch {
    return [];
  }
}
