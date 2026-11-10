import { domainToASCII } from "node:url";
import { forwardGroupTypeText } from "@shared/forwardTypes";
import { normalizeRuleEntryDomainSuffix } from "@shared/ruleEntryDomain";
import { queryRaw, quoteDbIdentifier } from "./dbRuntime";
import { getAllSettings } from "./repositories/settingsRepository";

/*
  面板自己在维护的 DNS 名字（DNSPod 解析记录管理页据此把它们设成只读）。

  这些名字的记录值是面板按运行状态写的：主机 IP 变了、入口组成员上下线、转发组故障切换、
  规则换了入口、落地池成员不可用……管理员在记录管理页手改一笔，下一次同步就被改回去；
  删掉一笔，故障切换时域名直接解析不到。所以改不改得动由服务端说了算，页面上的只读只是提示。

  来源和 DDNS 的写入方一一对应：
  - 主机 DDNS（server/hostDdns.ts）：开了 DDNS 的主机的 ddnsDomain；
  - 入口组 / 转发组 / 故障转移（forwardGroupRepository）：开着「自动解析」的组的 domain，
    组停用了也算 —— 一启用就会照常写；
  - 规则专属域名（server/ruleEntryDomain.ts）：已发布的 entryDomain、待删表里还没删掉的，
    以及后缀生效时整个 r<数字>.<后缀> 的命名空间（规则随时可能认领其中一个）；
  - 落地池直连域名（server/landingPools.ts）：node_pools.directDomain。

  不看 DDNS 当前是不是启用、服务商是不是 DNSPod：临时关掉 DDNS 期间改掉的记录，一打开就会被
  覆盖，宁可多挡一些。
*/

export type DnsManagedOwnerKind = "host" | "forwardGroup" | "ruleDomain" | "ruleDomainPending" | "ruleDomainSuffix" | "landingPool";

export type DnsManagedOwner = {
  kind: DnsManagedOwnerKind;
  /** 给人看的一句，例如「主机 DDNS：香港-1」。 */
  label: string;
};

export type DnsManagedIndex = {
  exact: Map<string, DnsManagedOwner[]>;
  /** 生效中的规则专属域名后缀（空 = 没开）。r<数字>.<后缀> 都算面板的。 */
  ruleSuffix: string;
};

export type DnsManagedSourceRows = {
  hosts: Array<{ id: unknown; name?: unknown; ddnsEnabled?: unknown; ddnsDomain?: unknown }>;
  forwardGroups: Array<{ id: unknown; name?: unknown; groupType?: unknown; groupMode?: unknown; domain?: unknown; ddnsAutoResolveEnabled?: unknown }>;
  rules: Array<{ id: unknown; name?: unknown; entryDomain?: unknown }>;
  ruleCleanups: Array<{ domain?: unknown; ruleId?: unknown }>;
  landingPools: Array<{ id: unknown; name?: unknown; directDomain?: unknown }>;
  /** 生效中的规则专属域名后缀。 */
  ruleSuffix?: unknown;
};

/** 统一成小写、去掉结尾的点、国际化域名转 punycode —— 和 DDNS 写入时的名字对得上。 */
export function normalizeManagedDnsName(value: unknown) {
  const text = String(value ?? "").trim().replace(/\.+$/, "").toLowerCase();
  if (!text) return "";
  return domainToASCII(text) || text;
}

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function displayName(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, 60);
}

export function buildDnsManagedIndex(rows: DnsManagedSourceRows): DnsManagedIndex {
  const exact = new Map<string, DnsManagedOwner[]>();
  const add = (domain: unknown, owner: DnsManagedOwner) => {
    const name = normalizeManagedDnsName(domain);
    if (!name) return;
    const list = exact.get(name) || [];
    if (!list.some((item) => item.label === owner.label)) list.push(owner);
    exact.set(name, list);
  };

  for (const host of rows.hosts) {
    if (!truthy(host.ddnsEnabled)) continue;
    add(host.ddnsDomain, { kind: "host", label: `主机 DDNS：${displayName(host.name, `#${host.id}`)}` });
  }
  for (const group of rows.forwardGroups) {
    // 关了「自动解析」的组面板不碰它的域名；默认值是开。
    if (group.ddnsAutoResolveEnabled !== undefined && group.ddnsAutoResolveEnabled !== null && !truthy(group.ddnsAutoResolveEnabled)) continue;
    const kind = forwardGroupTypeText(group);
    add(group.domain, { kind: "forwardGroup", label: `${kind}：${displayName(group.name, `#${group.id}`)}` });
  }
  for (const rule of rows.rules) {
    add(rule.entryDomain, { kind: "ruleDomain", label: `规则专属域名：${displayName(rule.name, `规则 #${rule.id}`)}` });
  }
  for (const cleanup of rows.ruleCleanups) {
    add(cleanup.domain, { kind: "ruleDomainPending", label: `规则专属域名（等待面板删除）：规则 #${String(cleanup.ruleId ?? "?")}` });
  }
  for (const pool of rows.landingPools) {
    add(pool.directDomain, { kind: "landingPool", label: `落地池直连域名：${displayName(pool.name, `#${pool.id}`)}` });
  }
  return { exact, ruleSuffix: normalizeRuleEntryDomainSuffix(rows.ruleSuffix) };
}

/** 这个完整域名归面板里的谁管；不归面板管返回空数组。 */
export function dnsManagedOwnersOf(index: DnsManagedIndex, fqdn: string): DnsManagedOwner[] {
  const name = normalizeManagedDnsName(fqdn);
  if (!name) return [];
  const owners = [...(index.exact.get(name) || [])];
  if (index.ruleSuffix && name.endsWith(`.${index.ruleSuffix}`) && /^r\d+$/.test(name.slice(0, -(index.ruleSuffix.length + 1)))) {
    if (!owners.some((owner) => owner.kind === "ruleDomain")) {
      owners.push({ kind: "ruleDomainSuffix", label: `规则专属域名（后缀 ${index.ruleSuffix} 下的 r<规则ID> 名字由面板分配）` });
    }
  }
  return owners;
}

/**
 * 从库里读一遍。任何一张表读失败都直接抛：不知道哪些名字归面板管时，宁可整页报错，
 * 也不能把「没读出来」当成「没有」放行写入。
 */
export async function loadDnsManagedIndex(): Promise<DnsManagedIndex> {
  const q = quoteDbIdentifier;
  const [hosts, forwardGroups, rules, ruleCleanups, landingPools, settings] = await Promise.all([
    queryRaw<DnsManagedSourceRows["hosts"][number]>(`SELECT ${q("id")}, ${q("name")}, ${q("ddnsEnabled")}, ${q("ddnsDomain")} FROM ${q("hosts")} WHERE ${q("ddnsDomain")} IS NOT NULL AND ${q("ddnsDomain")} <> ''`),
    queryRaw<DnsManagedSourceRows["forwardGroups"][number]>(`SELECT ${q("id")}, ${q("name")}, ${q("groupType")}, ${q("groupMode")}, ${q("domain")}, ${q("ddnsAutoResolveEnabled")} FROM ${q("forward_groups")} WHERE ${q("domain")} IS NOT NULL AND ${q("domain")} <> ''`),
    queryRaw<DnsManagedSourceRows["rules"][number]>(`SELECT ${q("id")}, ${q("name")}, ${q("entryDomain")} FROM ${q("forward_rules")} WHERE ${q("entryDomain")} IS NOT NULL AND ${q("entryDomain")} <> ''`),
    queryRaw<DnsManagedSourceRows["ruleCleanups"][number]>(`SELECT ${q("domain")}, ${q("ruleId")} FROM ${q("rule_entry_domain_cleanups")}`),
    queryRaw<DnsManagedSourceRows["landingPools"][number]>(`SELECT ${q("id")}, ${q("name")}, ${q("directDomain")} FROM ${q("node_pools")} WHERE ${q("directDomain")} IS NOT NULL AND ${q("directDomain")} <> ''`),
    getAllSettings(),
  ]);
  // 后缀只在 DDNS 启用时才会真的被分配（见 resolveRuleEntryDomainRuntimeSettings）；
  // 但这里按「填了就算」：临时关掉 DDNS 再打开，规则会立刻重新认领这些名字。
  return buildDnsManagedIndex({ hosts, forwardGroups, rules, ruleCleanups, landingPools, ruleSuffix: settings.ruleEntryDomainSuffix });
}
