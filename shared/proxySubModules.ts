/**
 * 订阅模板里挂的「模块 / 插件」：Loon 的 [Plugin]（去广告、BoxJs、各种脚本……）。
 *
 * 模板只存**引用**（地址、开没开、标签、参数），不存插件正文：插件由 Loon 自己下载、自己更新，
 * 面板去拉一份再塞进订阅既多一处会过期的拷贝，又等于替第三方脚本做了分发。
 *
 * Egern 的 modules 没做：Egern 的完整配置是它自己的一套 YAML（proxies / policy_groups / rules
 * 的写法都和 Clash 不同），面板目前给 Egern 发的是 Surge 格式（shared/proxyClientUserAgent.ts），
 * Surge 格式的配置里没有模块的位置（Surge 的模块要在客户端里单独装）。要做得先有一个 Egern
 * 渲染器，不是这里几行的事。存储格式是通用的，到时候直接复用。
 *
 * 校验从严：只收 http / https、不含空白和逗号（Loon 的 [Plugin] 一行以逗号分隔，地址里一个
 * 逗号就把后面的选项全拆错位）、不含控制字符（防往配置里插段落），数量和长度都有上限。
 */

export type ProxySubTemplateModule = {
  url: string;
  enabled: boolean;
  /** 客户端里显示的名字（Loon 的 tag）；空 = 让客户端用插件自己的名字。 */
  tag: string;
  /** 插件参数（Loon 的 argument）：原样写进 argument=。空 = 不写。 */
  argument: string;
};

export const PROXY_SUB_TEMPLATE_MODULE_LIMITS = {
  count: 30,
  url: 1000,
  tag: 64,
  argument: 1000,
} as const;

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]");

export function proxySubModuleUrlProblem(url: string): string | null {
  const value = String(url || "").trim();
  if (!value) return "要填地址";
  if (value.length > PROXY_SUB_TEMPLATE_MODULE_LIMITS.url) return `地址太长（上限 ${PROXY_SUB_TEMPLATE_MODULE_LIMITS.url} 字符）`;
  if (CONTROL.test(value) || /[\s,]/.test(value)) return "地址里不能有空白、逗号或控制字符";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "不是合法的地址";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "只收 http / https 地址";
  if (!parsed.hostname) return "地址里没有主机名";
  return null;
}

/** 一条模块哪里不对；没问题返回 null。index 从 0 起，只用在报错文字里。 */
export function proxySubModuleProblem(module: ProxySubTemplateModule, index: number): string | null {
  const label = `第 ${index + 1} 个插件`;
  const urlProblem = proxySubModuleUrlProblem(module.url);
  if (urlProblem) return `${label}：${urlProblem}`;
  if (module.tag.length > PROXY_SUB_TEMPLATE_MODULE_LIMITS.tag) return `${label}：名字太长（上限 ${PROXY_SUB_TEMPLATE_MODULE_LIMITS.tag} 字符）`;
  if (CONTROL.test(module.tag) || /[,=]/.test(module.tag)) return `${label}：名字里不能有逗号、等号或控制字符`;
  if (module.argument.length > PROXY_SUB_TEMPLATE_MODULE_LIMITS.argument) return `${label}：参数太长（上限 ${PROXY_SUB_TEMPLATE_MODULE_LIMITS.argument} 字符）`;
  if (CONTROL.test(module.argument)) return `${label}：参数里不能有换行或控制字符`;
  // 不是方括号包着的整段时，要给它加引号；里面再有引号就没法写了。
  if (!isBracketed(module.argument) && module.argument.includes("\"")) return `${label}：参数里有双引号时要整段用 [ ] 包起来`;
  return null;
}

function isBracketed(value: string): boolean {
  return value.startsWith("[") && value.endsWith("]");
}

/** 存储 / 输入 → 规整的列表。认不出的字段丢掉，空地址的条目丢掉，超出上限的截断。 */
export function normalizeProxySubTemplateModules(input: unknown): ProxySubTemplateModule[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((raw: unknown): Record<string, unknown> => (raw && typeof raw === "object" ? raw as Record<string, unknown> : {}))
    .map((item) => ({
      url: String(item?.url ?? "").trim(),
      enabled: item?.enabled !== false,
      tag: String(item?.tag ?? "").trim(),
      argument: String(item?.argument ?? "").trim(),
    }))
    .filter((item) => item.url)
    .slice(0, PROXY_SUB_TEMPLATE_MODULE_LIMITS.count);
}

export function parseProxySubTemplateModulesJson(json: unknown): ProxySubTemplateModule[] {
  if (!json || typeof json !== "string") return [];
  try {
    return normalizeProxySubTemplateModules(JSON.parse(json));
  } catch {
    return [];
  }
}

/**
 * Loon [Plugin] 段的一行：`地址, tag=名字, argument=参数, enabled=true`（官方 example.conf 的写法）。
 * 校验没过的（存进来之后规则又收紧了）整条不写，宁可少一个插件，也不要一份 Loon 读不懂的配置。
 */
export function loonPluginLine(module: ProxySubTemplateModule): string | null {
  if (proxySubModuleProblem(module, 0)) return null;
  const parts = [module.url];
  if (module.tag) parts.push(`tag=${module.tag}`);
  if (module.argument) parts.push(`argument=${isBracketed(module.argument) || !/[,\s]/.test(module.argument) ? module.argument : `"${module.argument}"`}`);
  parts.push(`enabled=${module.enabled ? "true" : "false"}`);
  return parts.join(", ");
}

/** 整段 [Plugin]；一条能写的都没有时返回空数组（不留一个空段落）。 */
export function loonPluginSection(modules: readonly ProxySubTemplateModule[] | undefined): string[] {
  const lines = (modules || []).map(loonPluginLine).filter((line): line is string => !!line);
  return lines.length > 0 ? ["", "[Plugin]", ...lines] : [];
}
