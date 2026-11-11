/**
 * 订阅模板可视化编辑的数据模型：把存着的规则文本拆成一行一行的「卡片」，改完再拼回文本。
 *
 * 为什么不另存一份结构化的规则：存储格式就是那段文本（shared/proxySubCustomRules.ts），全局、用户、
 * 令牌三处也是它，管理员在「高级 / 代码」里照样直接改文本。可视化只是同一份数据换个样子改，
 * 两边随时切换都得**原样往返**：
 *
 *   - 没动过的行原样写回（一个空格都不改）：解析会把值规整（域名转小写、补 /32），直接用规整后的
 *     重新拼，管理员切一下 Tab 什么都没改，文本就变了，看着像被面板改坏了；
 *   - 注释、空行、认不出的类型、写坏的行都留着（作为「原样保留」的行），可视化里改不了它们，
 *     但也绝不丢；
 *   - 停用的规则存成注释行 `# DOMAIN,…,DIRECT`：渲染时本来就跳过注释，文本里还看得见、
 *     一键能开回来。反过来，一行注释去掉 `#` 正好是条合法规则的，就当它是停用的规则。
 *
 * 纯函数，界面和测试共用。
 */

import { parseProxyCustomRules, PROXY_CUSTOM_RULE_TYPES, type ProxyCustomRuleType } from "./proxySubCustomRules";

export type ProxySubRuleRow =
  | {
    kind: "rule";
    id: string;
    enabled: boolean;
    type: ProxyCustomRuleType;
    value: string;
    target: string;
    noResolve: boolean;
    /** 原文那一行；改过任何字段后置为 null，按字段重新拼。 */
    raw: string | null;
  }
  | {
    kind: "raw";
    id: string;
    /** 原样保留的一行（注释、空行、认不出的、写坏的）。 */
    text: string;
  };

export const PROXY_CUSTOM_RULE_TYPE_INFO: Record<ProxyCustomRuleType, { hint: string; placeholder: string; noResolve: boolean }> = {
  DOMAIN: { hint: "完整域名，只匹配这一个（不含子域名）", placeholder: "www.example.com", noResolve: false },
  "DOMAIN-SUFFIX": { hint: "域名后缀：这个域名和它所有的子域名", placeholder: "example.com", noResolve: false },
  "DOMAIN-KEYWORD": { hint: "域名里含这个关键字就算", placeholder: "google", noResolve: false },
  "IP-CIDR": { hint: "目标 IPv4 网段；勾「不解析」时域名请求不为它去查 DNS", placeholder: "10.0.0.0/8", noResolve: true },
  "IP-CIDR6": { hint: "目标 IPv6 网段", placeholder: "2001:db8::/32", noResolve: true },
  GEOIP: { hint: "目标 IP 所在国家 / 地区（两位国家码，PRIVATE = 局域网）", placeholder: "CN", noResolve: true },
  GEOSITE: { hint: "按域名分类库（mihomo / sing-box 才有；Surge / Loon / QX / Shadowrocket 上跳过）", placeholder: "netflix", noResolve: false },
};

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `r${sequence}`;
}

/** 这一行能不能当成一条规则（去掉注释符之后）。能就返回解析结果。 */
function parseOne(content: string) {
  const parsed = parseProxyCustomRules(content);
  return parsed.errors.length === 0 && parsed.rules.length === 1 ? parsed.rules[0] : null;
}

export function parseProxySubRuleRows(text: unknown): ProxySubRuleRow[] {
  const source = String(text ?? "");
  if (!source) return [];
  return source.split("\n").map((line): ProxySubRuleRow => {
    const content = line.replace(/\r$/, "").trim();
    let enabled = true;
    let body = content;
    const comment = content.match(/^(?:#|;|\/\/)\s*(.*)$/);
    if (comment) {
      enabled = false;
      body = comment[1];
    }
    const rule = body ? parseOne(body) : null;
    if (!rule) return { kind: "raw", id: nextId(), text: line };
    return { kind: "rule", id: nextId(), enabled, type: rule.type, value: rule.value, target: rule.target, noResolve: rule.noResolve, raw: line };
  });
}

/** 按字段拼一行（不看 raw）。 */
export function proxySubRuleRowLine(row: Extract<ProxySubRuleRow, { kind: "rule" }>): string {
  const noResolve = row.noResolve && PROXY_CUSTOM_RULE_TYPE_INFO[row.type].noResolve;
  const line = `${row.type},${row.value.trim()},${row.target.trim()}${noResolve ? ",no-resolve" : ""}`;
  return row.enabled ? line : `# ${line}`;
}

export function formatProxySubRuleRows(rows: readonly ProxySubRuleRow[]): string {
  return rows.map((row) => (row.kind === "raw" ? row.text : row.raw ?? proxySubRuleRowLine(row))).join("\n");
}

/** 改一行的某几个字段：改了就不再原样写回。 */
export function patchProxySubRuleRow(row: Extract<ProxySubRuleRow, { kind: "rule" }>, patch: Partial<Omit<Extract<ProxySubRuleRow, { kind: "rule" }>, "kind" | "id" | "raw">>): ProxySubRuleRow {
  return { ...row, ...patch, raw: null };
}

export function newProxySubRuleRow(target = "PROXY"): ProxySubRuleRow {
  return { kind: "rule", id: nextId(), enabled: true, type: "DOMAIN-SUFFIX", value: "", target, noResolve: false, raw: null };
}

/** 一行规则现在写得对不对（停用的也查：开回来时不该是坏的）。没问题返回 null。 */
export function proxySubRuleRowProblem(row: Extract<ProxySubRuleRow, { kind: "rule" }>): string | null {
  const parsed = parseProxyCustomRules(proxySubRuleRowLine({ ...row, enabled: true }));
  return parsed.errors[0]?.message ?? null;
}

/** 上下挪一格；越界不动。 */
export function moveProxySubRow<T>(rows: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return [...rows];
  const next = [...rows];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export { PROXY_CUSTOM_RULE_TYPES };
