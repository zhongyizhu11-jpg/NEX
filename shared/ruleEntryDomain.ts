/**
 * 规则专属域名（系统设置 ruleEntryDomainSuffix）。
 *
 * 为什么要有它：订阅里的节点地址原来是「入口主机地址:端口」。规则换到另一台入口
 * （换隧道、换入口主机）之后地址就变了，已经导入订阅的客户端在刷新订阅之前一直连
 * 旧地址，表现为超时。给每条进订阅的规则发一个固定的 `r<规则ID>.<后缀>`，记录值跟着
 * 规则当前的入口走，客户端手里的地址就不用变。
 *
 * 这里只放纯函数：命名、记录类型、资格判断、订阅该用哪个地址。面板（显示）、订阅
 * 组装和服务端的同步逻辑共用同一份，免得三处各算各的、对不上。
 */

import { getEntryAddressFamily } from "./hostEntryAddress";

export type RuleEntryDomainRecordType = "A" | "AAAA" | "CNAME";

/** 规则域名的第一段：r + 规则 ID。只用小写字母和数字，任何 DNS 服务商都收。 */
function ruleEntryDomainLabel(ruleId: unknown): string {
  const id = Number(ruleId);
  return Number.isInteger(id) && id > 0 ? `r${id}` : "";
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * 规整后缀：去空白、转小写、去掉首尾的点和误填的 `*.`。
 *
 * 只认 ASCII（国际化域名由服务端先转成 punycode 再交给这里，见
 * server/ruleEntryDomain.ts 的 normalizeRuleEntryDomainSuffixInput）。
 * 格式不对返回空串，调用方把它当作「功能未开启」处理 —— 宁可不发，也不要拿
 * 一个坏后缀去服务商那里建一堆失败的记录。
 */
export function normalizeRuleEntryDomainSuffix(value: unknown): string {
  let text = String(value ?? "").trim().toLowerCase();
  if (text.startsWith("*.")) text = text.slice(2);
  text = text.replace(/^\.+/, "").replace(/\.+$/, "");
  if (!text) return "";
  const labels = text.split(".");
  // 至少两段：只填一个顶级域（com）明显是填错了，不可能是 DNS 服务商里的区域。
  if (labels.length < 2) return "";
  if (!labels.every((label) => DNS_LABEL.test(label))) return "";
  // 留出 `r<ID>.` 的位置：ID 最长按 10 位算，整名不能超过 253。
  if (text.length > 253 - 12) return "";
  return text;
}

/** 规则的专属域名。后缀无效或规则 ID 无效时返回空串。 */
export function ruleEntryDomainName(ruleId: unknown, suffix: unknown): string {
  const label = ruleEntryDomainLabel(ruleId);
  const normalized = normalizeRuleEntryDomainSuffix(suffix);
  return label && normalized ? `${label}.${normalized}` : "";
}

/**
 * 按入口地址决定记录类型：IPv4 → A、IPv6 → AAAA、主机名（手填的入口域名或主机 DDNS
 * 域名）→ CNAME。认不出来的返回 null，调用方不发布。
 *
 * 主机名用 CNAME 而不是解析成 IP 再写 A：那个域名自己会跟着主机的 IP 变（主机 DDNS），
 * 指过去就不用再追一遍。
 */
export function ruleEntryDomainRecordType(value: unknown): RuleEntryDomainRecordType | null {
  const family = getEntryAddressFamily(value);
  if (family === "ipv4") return "A";
  if (family === "ipv6") return "AAAA";
  if (family === "hostname") return "CNAME";
  return null;
}

/** 记录值：IPv6 去掉方括号，主机名转小写、去掉结尾的点。 */
export function normalizeRuleEntryDomainValue(value: unknown): string {
  let text = String(value ?? "").trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  text = text.replace(/\.+$/, "");
  const type = ruleEntryDomainRecordType(text);
  if (type === "CNAME") return text.toLowerCase();
  return type ? text : "";
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** 判断资格要读到的规则字段。 */
export type RuleEntryDomainRuleFields = {
  id?: unknown;
  isEnabled?: unknown;
  pendingDelete?: unknown;
  isForwardGroupTemplate?: unknown;
  routeParentRuleId?: unknown;
  proxyNodeId?: unknown;
  proxyNodeVisible?: unknown;
  /** 规则对话框里的「专属域名」开关；缺省（undefined / null）算开着，和 proxyNodeVisible 一个口径。 */
  entryDomainEnabled?: unknown;
};

/** 规则上的「专属域名」开关：没查这一列、列为空都算开着。 */
function ruleEntryDomainEnabled(rule: { entryDomainEnabled?: unknown } | null | undefined): boolean {
  const value = rule?.entryDomainEnabled;
  return value === undefined || value === null || flag(value);
}

/**
 * 这条规则该不该有专属域名。
 *
 * 只给真的会出现在订阅里的规则发：启用、没在删、不是转发组模板（模板不在任何机器
 * 上监听），而且绑了节点模板并且没被隐藏。别的规则发了也没人用，只是在 DNS 里多
 * 一堆要维护的记录。线路组生成的中转规则由面板维护、不进订阅，一并排除。
 * 用户在规则上把「专属域名」关掉的也不发：不是每条转发都需要固定域名。
 */
export function ruleQualifiesForEntryDomain(rule: RuleEntryDomainRuleFields | null | undefined): boolean {
  if (!rule) return false;
  if (!ruleEntryDomainLabel(rule.id)) return false;
  if (!flag(rule.isEnabled)) return false;
  if (flag(rule.pendingDelete)) return false;
  if (flag(rule.isForwardGroupTemplate)) return false;
  if (Number(rule.routeParentRuleId || 0) > 0) return false;
  if (!(Number(rule.proxyNodeId || 0) > 0)) return false;
  // 列缺省是 true；调用方没查这一列时按显示处理，和订阅组装的口径一致。
  if (rule.proxyNodeVisible !== undefined && rule.proxyNodeVisible !== null && !flag(rule.proxyNodeVisible)) return false;
  if (!ruleEntryDomainEnabled(rule)) return false;
  return true;
}

/**
 * 这条规则已经发布成功、可以拿来给客户端用的专属域名；没有返回空串。
 *
 * 条件是「至少发布成功过一次」（entryDomainValue 非空），而且域名就是按当前后缀
 * 算出来的那个。后缀一改、功能一关、规则上的开关一关，这里立刻退回入口地址，不必等
 * DNS 那边删完：删记录可能失败、要重试，订阅不能跟着等。按 ID 精确比对，也挡住了
 * 「面板迁移后规则 ID 重排、旧域名其实属于另一条规则」这种情况。
 */
export function publishedRuleEntryDomain(
  rule: { id?: unknown; entryDomain?: unknown; entryDomainValue?: unknown; entryDomainEnabled?: unknown } | null | undefined,
  activeSuffix: unknown,
): string {
  if (!rule) return "";
  if (!ruleEntryDomainEnabled(rule)) return "";
  const domain = String(rule.entryDomain ?? "").trim().toLowerCase();
  const value = String(rule.entryDomainValue ?? "").trim();
  if (!domain || !value) return "";
  const expected = ruleEntryDomainName(rule.id, activeSuffix);
  return expected && expected === domain ? domain : "";
}
