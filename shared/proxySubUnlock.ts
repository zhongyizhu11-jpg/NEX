/**
 * 解锁出口自动分流：订阅里给流媒体 / AI 分类额外建一个「只含出口检测为可用的节点」的组，
 * 并让该分类的策略组默认选它。
 *
 *   条目（去重后的节点名 + 出口主机 id）
 *     × 每台出口主机最新的解锁检测结论（server/ops/unlock.ts latestUnlockStatusesByHostIds，服务端查好传进来）
 *     → 每个分类挑出合格节点，按「最近一次检测」新到旧排
 *     → 一个 fallback 组（「Netflix 解锁」等），排在分类组成员的最前面
 *
 * 纯函数，不碰数据库。规则和 server/inboundRoutingRuntime.ts 的 pickAutoUnlockLanding 一致：
 * 必需的服务每一项都要是 ok（partial / blocked / unknown / 没测过都不算），按必需服务里
 * 最旧的那次检测时间排，越新越靠前。
 *
 * 出口主机：节点流量从哪台机器的公网 IP 出去 —— 直连节点是节点所在的机器，中转条目是它
 * 绑的落地（模板）所在的机器（入口机只是转发，不是出口）。粘来的 / 别人分享的节点没有机器，
 * 面板没测过，永远不进解锁组。
 */

import type { UnlockStatus } from "./unlockCheck";

/** 一台主机每个服务最新的结论（server/ops/unlock.ts latestUnlockStatusesByHostIds 的返回形状）。 */
export type ProxySubUnlockServiceStatus = { status: UnlockStatus; checkedAt: number };
export type ProxySubUnlockStatusMap = ReadonlyMap<number, ReadonlyMap<string, ProxySubUnlockServiceStatus>>;

export type ProxySubUnlockCategoryRule = {
  /** 分流分类 key（shared/proxyRuleset.ts PROXY_RULE_CATEGORIES）。 */
  categoryKey: string;
  /** 解锁组的名字。 */
  groupName: string;
  /** 这些服务（UNLOCK_SERVICES 的 id）每一项都必须是 ok。 */
  required: readonly string[];
  /** 这些服务测出来是 blocked 就排除；没测过 / partial / unknown 不排除。 */
  notBlocked?: readonly string[];
};

/**
 * 分类 → 解锁服务。
 *
 * AI 分类同时覆盖 OpenAI / Claude / Gemini 等的域名：要求 ChatGPT 可用（最常用、也最常被
 * 按地区拦），Claude、Gemini 只要没有被明确测为「不可用」即可 —— 三项全要求 ok 的话，
 * 大多数机器会因为某一项是 partial / 没测过而一台都选不出来。
 */
export const PROXY_SUB_UNLOCK_CATEGORY_RULES: readonly ProxySubUnlockCategoryRule[] = [
  { categoryKey: "ai", groupName: "AI 解锁", required: ["chatgpt"], notBlocked: ["claude", "gemini"] },
  { categoryKey: "youtube", groupName: "YouTube 解锁", required: ["youtube_premium"] },
  { categoryKey: "netflix", groupName: "Netflix 解锁", required: ["netflix"] },
  { categoryKey: "disney", groupName: "Disney+ 解锁", required: ["disney"] },
  { categoryKey: "tiktok", groupName: "TikTok 解锁", required: ["tiktok"] },
];

/** 合格时返回排序用的检测时间（必需服务里最旧的那次），不合格返回 null。 */
export function proxySubUnlockQualifies(
  services: ReadonlyMap<string, ProxySubUnlockServiceStatus> | undefined,
  rule: Pick<ProxySubUnlockCategoryRule, "required" | "notBlocked">,
): number | null {
  if (!services || rule.required.length === 0) return null;
  let oldest = Infinity;
  for (const id of rule.required) {
    const result = services.get(id);
    if (!result || result.status !== "ok") return null;
    oldest = Math.min(oldest, Number(result.checkedAt) || 0);
  }
  for (const id of rule.notBlocked || []) {
    if (services.get(id)?.status === "blocked") return null;
  }
  return oldest;
}

export type ProxySubUnlockNode = { name: string; exitHostId?: number | null };

export type ProxySubUnlockGroup = { name: string; type: "fallback"; members: string[] };

export type ProxySubUnlockGroupsResult = {
  groups: ProxySubUnlockGroup[];
  /** 分类 key → 该分类组要首选的解锁组名。 */
  preferredByCategory: Record<string, string>;
};

/**
 * 按分类挑出合格节点建组。没有合格节点的分类不出组（分类组保持原样）。
 * 同一台出口的多个节点都进组（客户端 fallback 会按顺序挑第一个通的）；排序稳定：
 * 检测时间相同按节点原来的顺序。
 */
export function buildProxySubUnlockGroups(
  nodes: readonly ProxySubUnlockNode[],
  statuses: ProxySubUnlockStatusMap | null | undefined,
  options: { categoryKeys?: Iterable<string>; reservedNames?: Iterable<string>; rules?: readonly ProxySubUnlockCategoryRule[] } = {},
): ProxySubUnlockGroupsResult {
  const result: ProxySubUnlockGroupsResult = { groups: [], preferredByCategory: {} };
  if (!statuses || statuses.size === 0 || nodes.length === 0) return result;
  const allowed = options.categoryKeys ? new Set(options.categoryKeys) : null;
  // 和已有的节点名 / 组名撞了就不出：同名会让客户端引用产生歧义。
  const reserved = new Set(options.reservedNames || []);
  for (const rule of options.rules || PROXY_SUB_UNLOCK_CATEGORY_RULES) {
    if (allowed && !allowed.has(rule.categoryKey)) continue;
    if (reserved.has(rule.groupName)) continue;
    const picked: Array<{ name: string; checkedAt: number; index: number }> = [];
    const seen = new Set<string>();
    nodes.forEach((node, index) => {
      const hostId = Number(node.exitHostId || 0);
      if (!(hostId > 0) || !node.name || seen.has(node.name)) return;
      const checkedAt = proxySubUnlockQualifies(statuses.get(hostId), rule);
      if (checkedAt === null) return;
      seen.add(node.name);
      picked.push({ name: node.name, checkedAt, index });
    });
    if (picked.length === 0) continue;
    picked.sort((a, b) => b.checkedAt - a.checkedAt || a.index - b.index);
    result.groups.push({ name: rule.groupName, type: "fallback", members: picked.map((item) => item.name) });
    result.preferredByCategory[rule.categoryKey] = rule.groupName;
    reserved.add(rule.groupName);
  }
  return result;
}

/** 条目里所有出口主机 id（去重），服务端按它批量查解锁结论。 */
export function proxySubUnlockExitHostIds(entries: readonly { meta?: { exitHostId?: number | null } }[]): number[] {
  const ids = new Set<number>();
  for (const entry of entries) {
    const id = Number(entry.meta?.exitHostId || 0);
    if (id > 0) ids.add(id);
  }
  return Array.from(ids);
}
