import * as db from "./db";
import { resolveAgentAdvertisedPanelUrl } from "./agentPanelUrl";
import { findNodeHost, type ExitQualityHost } from "./exitQualityView";
import { hostSupportsNodeCheck, nodeCheckStatus, startNodeCheck, type NodeCheckSubject } from "./ops/nodeCheck";
import { singboxAssetRelayBase } from "./singboxAssets";
import { ensureSingboxBinaryCmd } from "./singboxRuntimePlan";
import { effectiveGithubAccelerator } from "../shared/githubAccelerator";
import { SITE_LATENCY_TARGETS, summarizeSiteSamples, type SiteLatencySample } from "../shared/siteLatency";
import { singboxOutbound } from "../shared/proxySubscription";
import { proxyNodeFromTemplateRow } from "../shared/proxySubscriptionPlan";
import { unlockChipItems, UNLOCK_SERVICES } from "../shared/unlockCheck";
import { type ExitCheckResult } from "../shared/nodeCheck";

/*
  按需检查怎么落到主机上（逻辑在 ops/nodeCheck.ts，这里只做节点 / 线路 ↔ 主机的对应）：

    · 节点菜单「出口检测」，节点的机器不是自己的：挑一台自己的机器，临时拉 sing-box 把这个节点当出站，
      站点握手 + 解锁走它过去；结果画成和主机那版一样的出口面板。候选机器里绑了这个节点的转发
      所在的入口机排最前。
  机器上没有 sing-box 的，指令里带上自建节点那套装机脚本，Agent 先装再测。
*/

type NodeCheckHostCandidate = {
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

/** 机器上没有 sing-box 时让 Agent 装一个用的脚本（和自建节点那套一样：GitHub / 加速 / 面板转发三路试）。 */
async function singboxInstallCmd() {
  const [panelUrl, settings] = await Promise.all([
    resolveAgentAdvertisedPanelUrl().catch(() => ""),
    db.getAllSettings().catch(() => ({} as Record<string, string | null>)),
  ]);
  const accelerator = effectiveGithubAccelerator({ enabled: settings.githubAcceleratorEnabled === "true", url: settings.githubAcceleratorUrl ?? "" });
  return ensureSingboxBinaryCmd({ accelerator, panelRelayBase: singboxAssetRelayBase(panelUrl) });
}

// ---------------------------------------------------------------- 节点：经一台机器的出口检测

type NodeCheckPlan = {
  /** 节点落在自己的哪台机器上；null = 要经节点。 */
  ownHost: any | null;
  match: "inbound" | "address" | "none";
  candidates: NodeCheckHostCandidate[];
};

async function planNodeCheck(node: any, viewer: { id: number; role: string }): Promise<NodeCheckPlan> {
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
    ...startNodeCheck(host, { kind: "exit", nodeId: Number(node.id), nodeName: String(node.name || ""), outbound, installCmd: await singboxInstallCmd(), requestedBy: viewer.id }),
  };
}

export async function exitCheckStatusForNode(node: any, viewer: { id: number; role: string }) {
  const plan = await planNodeCheck(node, viewer);
  const status = await nodeCheckStatus({ kind: "exit", hostId: 0, nodeId: Number(node.id) });
  return { plan: { ownHostId: plan.ownHost ? Number(plan.ownHost.id) : 0, ownHostName: plan.ownHost ? String(plan.ownHost.name || "") : "", match: plan.match, candidates: plan.candidates }, ...status };
}

// ---------------------------------------------------------------- 订阅线路：在入口机上连自己的入口测整条链

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
