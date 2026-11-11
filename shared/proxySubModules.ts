/**
 * 订阅模板里挂的「模块 / 插件」：Loon 的 [Plugin]（去广告、BoxJs、各种脚本……）和 Egern 的 modules。
 *
 * 模板只存**引用**（地址、开没开、名字、参数），不存插件正文：插件由客户端自己下载、自己更新，
 * 面板去拉一份再塞进订阅既多一处会过期的拷贝，又等于替第三方脚本做了分发。
 *
 * 两家共用同一份存储（url / enabled / tag / argument），差别只在参数怎么写：
 *   - Loon：argument 原样写进 `argument=`（整段 [ ] 或一个带引号的串）；
 *   - Egern：写成 `KEY=值`，多个用 & 隔开，渲染成模块引用上的 compat_arguments 对象
 *     （egernapp.com/docs/configuration/modules：只覆盖模块文件里声明过的参数）。
 *
 * 校验从严：只收 http / https、不含空白和逗号（Loon 的 [Plugin] 一行以逗号分隔，地址里一个
 * 逗号就把后面的选项全拆错位；Egern 跟着同一套，模板换目标格式时不用重新检查地址）、
 * 不含控制字符（防往配置里插段落），数量和长度都有上限。
 */

export type ProxySubTemplateModule = {
  url: string;
  enabled: boolean;
  /** 客户端里显示的名字（Loon 的 tag、Egern 的 name）；空 = 让客户端用插件自己的名字。 */
  tag: string;
  /** 插件参数：Loon 原样写进 argument=；Egern 是 `KEY=值&KEY2=值`。空 = 不写。 */
  argument: string;
};

/** 按哪家的写法校验参数。存储一样，报错文字也跟着叫「插件」或「模块」。 */
export type ProxySubModuleFlavor = "loon" | "egern";

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
export function proxySubModuleProblem(module: ProxySubTemplateModule, index: number, flavor: ProxySubModuleFlavor = "loon"): string | null {
  const label = `第 ${index + 1} 个${flavor === "egern" ? "模块" : "插件"}`;
  const urlProblem = proxySubModuleUrlProblem(module.url);
  if (urlProblem) return `${label}：${urlProblem}`;
  if (module.tag.length > PROXY_SUB_TEMPLATE_MODULE_LIMITS.tag) return `${label}：名字太长（上限 ${PROXY_SUB_TEMPLATE_MODULE_LIMITS.tag} 字符）`;
  if (CONTROL.test(module.tag) || /[,=]/.test(module.tag)) return `${label}：名字里不能有逗号、等号或控制字符`;
  if (module.argument.length > PROXY_SUB_TEMPLATE_MODULE_LIMITS.argument) return `${label}：参数太长（上限 ${PROXY_SUB_TEMPLATE_MODULE_LIMITS.argument} 字符）`;
  if (CONTROL.test(module.argument)) return `${label}：参数里不能有换行或控制字符`;
  if (flavor === "egern") {
    const parsed = parseEgernModuleArguments(module.argument);
    return parsed.ok ? null : `${label}：${parsed.error}`;
  }
  // 不是方括号包着的整段时，要给它加引号；里面再有引号就没法写了。
  if (!isBracketed(module.argument) && module.argument.includes("\"")) return `${label}：参数里有双引号时要整段用 [ ] 包起来`;
  return null;
}

/**
 * Egern 的模块参数：`KEY=值&KEY2=值` → 键值对。
 *
 * 为什么用 & 分隔而不是逗号：Egern 文档明说值里可以有逗号和冒号；不能有的是双引号、反斜杠
 * （模块文件里的占位符多半写在双引号里，按纯文本替换，一个引号就把那行 YAML 打坏）。
 * 键重复算错：同一个键在 YAML 对象里出现两次，解析器可能直接拒绝整份配置。
 */
export function parseEgernModuleArguments(argument: string): { ok: true; pairs: Array<[string, string]> } | { ok: false; error: string } {
  const text = String(argument || "").trim();
  if (!text) return { ok: true, pairs: [] };
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const raw of text.split("&")) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) return { ok: false, error: `参数「${part.slice(0, 40)}」要写成 KEY=值，多个用 & 隔开` };
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!/^[^\s=&"\\]{1,64}$/.test(key)) return { ok: false, error: `参数名「${key.slice(0, 40)}」不合法（不能有空白、引号、反斜杠，最长 64 字符）` };
    if (/["\\]/.test(value)) return { ok: false, error: `参数 ${key} 的值里不能有双引号或反斜杠` };
    if (seen.has(key)) return { ok: false, error: `参数 ${key} 写了两次` };
    seen.add(key);
    pairs.push([key, value]);
  }
  return { ok: true, pairs };
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
