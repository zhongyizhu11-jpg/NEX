/*
  API 令牌「能碰哪几块」（批次 1 · 第 6 项）。

  原来令牌只有 只读 / 完全 两档：一枚给备份脚本用的令牌，照样能翻用户列表、改计费。现在可以再勾
  几个模块，令牌就只能调这些模块下面的 tRPC 过程。一个都不勾（老令牌全是这样）= 所有模块，和以前一样。

  模块按 tRPC 路由路径的前缀划分（appRouter 的键，见 server/routers.ts）。一个过程属于前缀最长的
  那一条：ops.events. 归「监控」，ops.webhooks. 归「系统」，不会因为都在 ops. 下面就算成一块。
  没列在表里的路由（setup.、googleAuth.、ops.apiTokens. 之类）在令牌勾了模块时一律不放行 ——
  勾模块就是「只给这些」，漏列的东西默认不给，比默认全给安全。

  auth. 永远放行：令牌要能调 auth.me 认出自己是谁；里面改密码、2FA 这些高危过程另有
  TOKEN_FORBIDDEN_PATHS 挡着（server/ops/apiTokenPolicy.ts），模块管不到它们，也不需要管。
*/

export const API_TOKEN_MODULES = ["rules", "hosts", "lines", "proxy", "users", "billing", "system", "monitoring"] as const;
export type ApiTokenModule = (typeof API_TOKEN_MODULES)[number];

export const API_TOKEN_MODULE_LABELS: Record<ApiTokenModule, string> = {
  rules: "转发规则",
  hosts: "主机",
  lines: "链路与线路",
  proxy: "订阅与代理",
  users: "用户与工单",
  billing: "套餐与计费",
  system: "系统设置",
  monitoring: "监控与事件",
};

export const API_TOKEN_MODULE_DETAILS: Record<ApiTokenModule, string> = {
  rules: "转发规则、线路诊断",
  hosts: "主机、Agent 令牌、换 IP、防火墙、主机日志与网络调优",
  lines: "隧道、转发组、节点池、拓扑、TLS 入口",
  proxy: "代理入站、订阅链接",
  users: "用户、推广、工单",
  billing: "套餐、钱包、支付、流量计费",
  system: "系统设置、DNS 解析记录、插件、公告、Webhook、维护模式",
  monitoring: "总览、诊断、事件、运维看板、可用率",
};

/** 前缀 → 模块。前缀都以 . 结尾，按最长匹配归属。 */
export const API_TOKEN_MODULE_PREFIXES: Record<ApiTokenModule, readonly string[]> = {
  rules: ["rules.", "lineDiagnostics."],
  hosts: [
    "hosts.",
    "agentTokens.",
    "lookingGlass.",
    "ipChange.",
    "netProfile.",
    "agentRuntime.",
    "ops.firewall.",
    "ops.hostSecurity.",
    "ops.agentRelay.",
    "ops.hostOps.",
    "ops.hostLogs.",
    "ops.netTune.",
    "ops.resourceAlert.",
  ],
  lines: ["tunnels.", "forwardGroups.", "nodePools.", "topology.", "tlsInbounds."],
  proxy: ["proxyInbounds.", "proxySubscriptions."],
  users: ["users.", "referral.", "tickets."],
  billing: ["billing.", "plans.", "payment.", "trafficBilling."],
  system: ["system.", "dnsRecords.", "plugins.", "announcements.", "telegram.", "ops.webhooks.", "ops.maintenance.", "ops.quotaPolicy.", "ops.apiRateLimit.", "ops.slowQueries."],
  monitoring: [
    "dashboard.",
    "diagnostics.",
    "ops.events.",
    "ops.board.",
    "ops.faultBoard.",
    "ops.connStats.",
    "ops.statusAvailability.",
    "ops.digest.",
    "ops.onlineIps.",
  ],
};

/** 勾了模块也照样放行的前缀。 */
export const API_TOKEN_ALWAYS_ALLOWED_PREFIXES: readonly string[] = ["auth."];

const PREFIX_TABLE: Array<{ prefix: string; module: ApiTokenModule }> = (Object.keys(API_TOKEN_MODULE_PREFIXES) as ApiTokenModule[])
  .flatMap((module) => API_TOKEN_MODULE_PREFIXES[module].map((prefix) => ({ prefix, module })))
  .sort((a, b) => b.prefix.length - a.prefix.length);

export function isApiTokenModule(value: unknown): value is ApiTokenModule {
  return typeof value === "string" && (API_TOKEN_MODULES as readonly string[]).includes(value);
}

/** 一个过程路径归哪个模块；没列在表里返回 null。 */
export function apiTokenModuleOfPath(path: string): ApiTokenModule | null {
  const text = String(path || "");
  for (const entry of PREFIX_TABLE) {
    if (text.startsWith(entry.prefix)) return entry.module;
  }
  return null;
}

/**
 * 库里 / 输入里的模块列表 → 规范的、去重、按 API_TOKEN_MODULES 排好序的数组；
 * 空、认不出来、全都不认识 → null（= 不限模块）。
 * 存的时候是逗号分隔的字符串，也接受 JSON 数组（手改过库的情况）。
 */
export function normalizeApiTokenModules(value: unknown): ApiTokenModule[] | null {
  let list: unknown[] = [];
  if (Array.isArray(value)) list = value;
  else if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        list = Array.isArray(parsed) ? parsed : [];
      } catch {
        list = [];
      }
    } else {
      list = text.split(",");
    }
  } else return null;
  const picked = new Set(list.map((item) => String(item).trim()).filter(isApiTokenModule));
  if (!picked.size) return null;
  return API_TOKEN_MODULES.filter((module) => picked.has(module));
}

/** 存进库的样子：逗号分隔；不限模块存 null。 */
export function serializeApiTokenModules(modules: readonly ApiTokenModule[] | null | undefined): string | null {
  const normalized = normalizeApiTokenModules(modules ? [...modules] : null);
  return normalized ? normalized.join(",") : null;
}

/** 这组模块允不允许调这个过程。modules 为 null / 空 = 不限。 */
export function apiTokenModulesAllowPath(modules: readonly ApiTokenModule[] | null | undefined, path: string): boolean {
  if (!modules || modules.length === 0) return true;
  const text = String(path || "");
  if (API_TOKEN_ALWAYS_ALLOWED_PREFIXES.some((prefix) => text.startsWith(prefix))) return true;
  const module = apiTokenModuleOfPath(text);
  return !!module && modules.includes(module);
}

/** 给人看的一句：「转发规则、主机」。 */
export function apiTokenModulesLabel(modules: readonly ApiTokenModule[] | null | undefined): string {
  if (!modules || modules.length === 0) return "全部模块";
  return modules.map((module) => API_TOKEN_MODULE_LABELS[module]).join("、");
}
