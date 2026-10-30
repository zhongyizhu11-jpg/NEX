import * as db from "./db";
import { findNodeHost, type ExitQualityHost } from "./exitQualityView";
import { hostSupportsNodeCheck, nodeCheckStatus, startNodeCheck, type NodeCheckSubject } from "./ops/nodeCheck";
import { SITE_LATENCY_TARGETS, summarizeSiteSamples, type SiteLatencySample } from "../shared/siteLatency";
import { singboxOutbound } from "../shared/proxySubscription";
import { proxyNodeFromTemplateRow, type ProxySubscriptionEntry } from "../shared/proxySubscriptionPlan";
import { unlockChipItems, UNLOCK_SERVICES } from "../shared/unlockCheck";
import type { ExitCheckResult } from "../shared/nodeCheck";

/*
  两处按需检查怎么落到主机上（逻辑在 ops/nodeCheck.ts，这里只做节点 / 线路 ↔ 主机的对应）：

    · 节点菜单「出口检测」，节点的机器不是自己的：挑一台自己的机器，临时拉 sing-box 把这个节点当出站，
      站点握手 + 解锁走它过去；结果画成和主机那版一样的出口面板。
    · 预览订阅里每条线路的「测速」：挑一台自己的机器（不在这条线路上的），把订阅里这条线路的入口
      当出站（客户端拿到的就是它），对 Cloudflare 测速 —— 测的是整条链：入口 → 中转 → 落地 → 出去。
  候选机器里绑了这个节点的转发所在的入口机排最前（出口检测），线路上的机器排除（测速）。
*/

export type NodeCheckHostCandidate = {
  id: number;
  name: string;
  online: boolean;
  supported: boolean;
  /** 出口检测：绑了这个节点的转发的入口机。 */
  preferred: boolean;
};

function candidateOf(item: any, preferred: boolean): NodeCheckHostCandidate {
  return {
    id: Number(item.id),
    name: String(item.name || `主机 ${item.id}`),
    online: !!item.isOnline,
    supported: hostSupportsNodeCheck(item),
    preferred,
  };
}

function sortCandidates(list: NodeCheckHostCandidate[]) {
  return list.sort((left, right) => Number(right.preferred) - Number(left.preferred) || Number(right.online && right.supported) - Number(left.online && left.supported) || left.id - right.id);
}

async function viewerHosts(viewer: { id: number; role: string }) {
  return (viewer.role === "admin" ? await db.getHosts() : await db.getHosts(viewer.id)) as any[];
}

// ---------------------------------------------------------------- 节点：经一台机器的出口检测

export type NodeCheckPlan = {
  /** 节点落在自己的哪台机器上；null = 要经节点。 */
  ownHost: any | null;
  match: "inbound" | "address" | "none";
  candidates: NodeCheckHostCandidate[];
};

export async function planNodeCheck(node: any, viewer: { id: number; role: string }): Promise<NodeCheckPlan> {
  const { host, match } = await findNodeHost(node, viewer);
  const hosts = await viewerHosts(viewer);
  const ruleIds = await db.getRuleIdsUsingProxyNodes([Number(node.id)]);
  const boundRuleIds = ruleIds.get(Number(node.id)) || [];
  const preferredHostIds = new Set<number>();
  for (const ruleId of boundRuleIds.slice(0, 50)) {
    const rule = await db.getForwardRuleById(ruleId) as any;
    if (rule?.hostId) preferredHostIds.add(Number(rule.hostId));
  }
  const candidates = sortCandidates(hosts
    .filter((item) => Number(item.id) !== Number(host?.id || 0))
    .map((item) => candidateOf(item, preferredHostIds.has(Number(item.id)))));
  return { ownHost: host, match, candidates };
}

/** 排一次经节点的出口检测。 */
export async function startExitCheckForNode(node: any, viewer: { id: number; role: string }, input: { hostId?: number }) {
  const plan = await planNodeCheck(node, viewer);
  const hostId = Number(input.hostId || plan.candidates.find((item) => item.online && item.supported)?.id || 0);
  const candidate = plan.candidates.find((item) => item.id === hostId);
  if (!candidate) throw new Error("没有可以用来检测的机器：要一台在线、Agent 2.2.241 以上的机器");
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  const outbound = singboxOutbound(proxyNodeFromTemplateRow({ ...node, id: Number(node.id) }));
  delete outbound.detour;
  return {
    subject: { kind: "exit", hostId, nodeId: Number(node.id) } as NodeCheckSubject,
    ...startNodeCheck(host, { kind: "exit", nodeId: Number(node.id), nodeName: String(node.name || ""), outbound, requestedBy: viewer.id }),
  };
}

export async function exitCheckStatusForNode(node: any, viewer: { id: number; role: string }) {
  const plan = await planNodeCheck(node, viewer);
  const status = await nodeCheckStatus({ kind: "exit", hostId: 0, nodeId: Number(node.id) });
  return { plan: { ownHostId: plan.ownHost ? Number(plan.ownHost.id) : 0, ownHostName: plan.ownHost ? String(plan.ownHost.name || "") : "", match: plan.match, candidates: plan.candidates }, ...status };
}

// ---------------------------------------------------------------- 订阅线路：从一台机器连入口测整条链

export type EntryCheckPlan = {
  entry: ProxySubscriptionEntry;
  entryName: string;
  /** 线路上的机器（入口 / 落地），不拿来测。 */
  routeHostIds: number[];
  candidates: NodeCheckHostCandidate[];
};

export function parseEntryKey(entryKey: string): { kind: "relay"; ruleId: number } | { kind: "direct"; templateId: number } | null {
  const relay = /^rule-(\d+)$/.exec(entryKey);
  if (relay) return { kind: "relay", ruleId: Number(relay[1]) };
  const direct = /^direct-(\d+)$/.exec(entryKey);
  if (direct) return { kind: "direct", templateId: Number(direct[1]) };
  return null;
}

export async function planEntryCheck(userId: number, viewer: { id: number; role: string }, entryKey: string): Promise<EntryCheckPlan> {
  const ref = parseEntryKey(entryKey);
  if (!ref) throw new Error("不认识的线路");
  const { plan } = await db.getProxySubscriptionPreviewForUser(userId);
  const entry = plan.entries.find((item) => (ref.kind === "relay" ? item.kind === "relay" && Number(item.ruleId) === ref.ruleId : item.kind === "direct" && Number(item.templateId) === ref.templateId));
  if (!entry) throw new Error("订阅里没有这条线路了");
  const routeHostIds = new Set<number>();
  if (entry.kind === "relay" && entry.ruleId > 0) {
    const rule = await db.getForwardRuleById(entry.ruleId) as any;
    if (rule?.hostId) routeHostIds.add(Number(rule.hostId));
  }
  const template = await db.getProxyNodeById(Number(entry.templateId));
  if (template) {
    const { host } = await findNodeHost(template, viewer);
    if (host) routeHostIds.add(Number(host.id));
  }
  const hosts = await viewerHosts(viewer);
  const candidates = sortCandidates(hosts.filter((item) => !routeHostIds.has(Number(item.id))).map((item) => candidateOf(item, false)));
  return { entry, entryName: entry.node.name, routeHostIds: Array.from(routeHostIds), candidates };
}

/** 排一次线路测速：从 hostId 那台机器连这条线路的入口（订阅里给客户端的那个节点）测。 */
export async function startSpeedTestForEntry(userId: number, viewer: { id: number; role: string }, input: { entryKey: string; hostId?: number }) {
  const plan = await planEntryCheck(userId, viewer, input.entryKey);
  const hostId = Number(input.hostId || plan.candidates.find((item) => item.online && item.supported)?.id || 0);
  const candidate = plan.candidates.find((item) => item.id === hostId);
  if (!candidate) throw new Error("没有可以用来测的机器：要一台在线、Agent 2.2.241 以上、而且不在这条线路上的机器");
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  const outbound = singboxOutbound(plan.entry.node);
  delete outbound.detour;
  const extraOutbounds: Record<string, unknown>[] = [];
  if (plan.entry.frontTemplateId > 0) {
    // 前置代理：订阅里这条线路先经另一条，测的时候也照样先经它。
    const { plan: full } = await db.getProxySubscriptionPreviewForUser(userId);
    const front = full.entries.find((item) => Number(item.templateId) === Number(plan.entry.frontTemplateId));
    if (front) {
      const frontOutbound = singboxOutbound(front.node);
      delete frontOutbound.detour;
      frontOutbound.tag = "front";
      extraOutbounds.push(frontOutbound);
      outbound.detour = "front";
    }
  }
  return {
    subject: { kind: "speed", hostId, nodeId: 0, entryKey: input.entryKey } as NodeCheckSubject,
    ...startNodeCheck(host, { kind: "speed", entryKey: input.entryKey, nodeName: plan.entryName, outbound, extraOutbounds, requestedBy: viewer.id }),
  };
}

export async function speedTestStatusForEntry(userId: number, viewer: { id: number; role: string }, entryKey: string) {
  const plan = await planEntryCheck(userId, viewer, entryKey);
  const status = await nodeCheckStatus({ kind: "speed", hostId: 0, nodeId: 0, entryKey });
  return { entryName: plan.entryName, candidates: plan.candidates, ...status };
}

// ---------------------------------------------------------------- 结果画成出口面板

/** 经节点的出口检测结果画成和主机那版一样的出口面板（ExitHostPanel 吃的形状）。 */
export function exitCheckToHostView(result: ExitCheckResult, options: { hostId: number; hostName: string; nodeName: string; checkedAt: number; countryCode?: string | null }): ExitQualityHost {
  const byKey = new Map(result.sites.map((site) => [site.key, site]));
  const atMs = options.checkedAt * 1000;
  const sites = SITE_LATENCY_TARGETS.map((target) => {
    const site = byKey.get(target.key);
    const samples: SiteLatencySample[] = site ? [{ at: atMs, ms: site.ms, fail: site.fail || undefined, tries: site.tries || undefined, ok: site.ok || undefined }] : [];
    return { key: target.key, ...summarizeSiteSamples(samples), values: samples.map((sample) => sample.ms ?? 0) };
  });
  const names = new Map(UNLOCK_SERVICES.map((service) => [service.id, service.name]));
  const order = new Map(UNLOCK_SERVICES.map((service, index) => [service.id, index]));
  const results = [...result.unlock]
    .sort((left, right) => (order.get(left.service) ?? 99) - (order.get(right.service) ?? 99))
    .map((item) => ({ service: item.service, name: names.get(item.service) || item.service, status: item.status, region: item.region }));
  return {
    id: options.hostId,
    name: options.nodeName ? `${options.nodeName}（经 ${options.hostName}）` : options.hostName,
    online: true,
    countryCode: options.countryCode || null,
    sites,
    noEgress: sites.length > 0 && sites.every((site) => site.samples > 0 && site.latestMs === null),
    unverified: false,
    unsupported: false,
    unlock: results.length > 0 ? { checkedAt: options.checkedAt, items: unlockChipItems(results) } : null,
    unlockDetail: results.length > 0 ? { checkedAt: options.checkedAt, family: "auto", results } : null,
    unlockSupported: true,
  };
}
