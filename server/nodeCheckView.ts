import * as db from "./db";
import { dbBool } from "./repositories/repositoryUtils";
import { resolveAgentAdvertisedPanelUrl } from "./agentPanelUrl";
import { findNodeHost, type ExitQualityHost } from "./exitQualityView";
import { hostSupportsNodeCheck, nodeCheckStatus, startNodeCheck, type NodeCheckSubject } from "./ops/nodeCheck";
import { singboxAssetRelayBase } from "./singboxAssets";
import { ensureSingboxBinaryCmd } from "./singboxRuntimePlan";
import { effectiveGithubAccelerator } from "../shared/githubAccelerator";
import { KERNEL_FORWARD_TYPES } from "../shared/forwardTypes";
import { SITE_LATENCY_TARGETS, summarizeSiteSamples, type SiteLatencySample } from "../shared/siteLatency";
import { singboxOutbound } from "../shared/proxySubscription";
import { proxyNodeFromTemplateRow, type ProxySubscriptionEntry } from "../shared/proxySubscriptionPlan";
import { unlockChipItems, UNLOCK_SERVICES } from "../shared/unlockCheck";
import type { ExitCheckResult } from "../shared/nodeCheck";

/*
  两处按需检查怎么落到主机上（逻辑在 ops/nodeCheck.ts，这里只做节点 / 线路 ↔ 主机的对应）：

    · 节点菜单「出口检测」，节点的机器不是自己的：挑一台自己的机器，临时拉 sing-box 把这个节点当出站，
      站点握手 + 解锁走它过去；结果画成和主机那版一样的出口面板。候选机器里绑了这个节点的转发
      所在的入口机排最前。
    · 预览订阅里每条线路的「测速」：在入口机上连自己的入口（回环；内核转发连下一跳），流量走入口 →
      中转 → 落地出去，测的是整条链（见下面 planEntryCheck）。
  机器上没有 sing-box 的，指令里带上自建节点那套装机脚本，Agent 先装再测。
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

/** 机器上没有 sing-box 时让 Agent 装一个用的脚本（和自建节点那套一样：GitHub / 加速 / 面板转发三路试）。 */
export async function singboxInstallCmd() {
  const [panelUrl, settings] = await Promise.all([
    resolveAgentAdvertisedPanelUrl().catch(() => ""),
    db.getAllSettings().catch(() => ({} as Record<string, string | null>)),
  ]);
  const accelerator = effectiveGithubAccelerator({ enabled: settings.githubAcceleratorEnabled === "true", url: settings.githubAcceleratorUrl ?? "" });
  return ensureSingboxBinaryCmd({ accelerator, panelRelayBase: singboxAssetRelayBase(panelUrl) });
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
    ...startNodeCheck(host, { kind: "exit", nodeId: Number(node.id), nodeName: String(node.name || ""), outbound, installCmd: await singboxInstallCmd(), requestedBy: viewer.id }),
  };
}

export async function exitCheckStatusForNode(node: any, viewer: { id: number; role: string }) {
  const plan = await planNodeCheck(node, viewer);
  const status = await nodeCheckStatus({ kind: "exit", hostId: 0, nodeId: Number(node.id) });
  return { plan: { ownHostId: plan.ownHost ? Number(plan.ownHost.id) : 0, ownHostName: plan.ownHost ? String(plan.ownHost.name || "") : "", match: plan.match, candidates: plan.candidates }, ...status };
}

// ---------------------------------------------------------------- 订阅线路：在入口机上连自己的入口测整条链

/*
  订阅预览里一条线路的「测速」要测的是这条链本身：入口 → 中转 → 落地 → 出去。

    · 中转线路（relay）：就在入口机上测。sing-box 当客户端连本机的入口（回环 127.0.0.1:入口端口），
      流量照样经入口的转发、中转、落地出去 —— 和客户端连上入口之后走的是同一条路，只是少了「你到入口」
      那一段（那一段是你自己的宽带，面板测不到）。内核转发（iptables / nftables）不接本机发出的连接，
      就直接连它转去的下一跳，路是同一条。
      以前借一台线路外的机器当客户端，挑到的常常在别的国家（比如香港的机器去连国内入口再回香港），
      多绕两次国境，延迟几百毫秒、带宽也不是这条线路的。
    · 直连节点（direct）、带前置代理的线路、入口机测不了（离线 / Agent 太旧）：借一台机器当客户端连
      订阅里的地址。先挑和入口同一个国家的（直连节点挑国内的 —— 用的人在国内），都没有才随便挑一台，
      界面上写清楚借的是谁、多了哪一段。
*/

export type EntryCheckRole = "entry" | "client";

export type EntryCheckPlan = {
  entry: ProxySubscriptionEntry;
  entryName: string;
  /** 在哪台机器上跑；null = 没有机器能测。 */
  host: any | null;
  /** entry：入口机自己连自己的入口；client：借一台机器当客户端连订阅地址。 */
  hostRole: EntryCheckRole;
  /** 入口机测时 sing-box 实际连的地址：回环，或内核转发的下一跳。 */
  dial: { server: string; port: number; via: "loopback" | "next-hop" } | null;
  /** 给界面的一句话：在哪测、测的是哪一段、为什么借这台。 */
  note: string;
  /** 线路上的机器（入口 / 落地）。 */
  routeHostIds: number[];
};

export function parseEntryKey(entryKey: string): { kind: "relay"; ruleId: number } | { kind: "direct"; templateId: number } | null {
  const relay = /^rule-(\d+)$/.exec(entryKey);
  if (relay) return { kind: "relay", ruleId: Number(relay[1]) };
  const direct = /^direct-(\d+)$/.exec(entryKey);
  if (direct) return { kind: "direct", templateId: Number(direct[1]) };
  return null;
}

/** 用的人默认在国内：直连节点借国内的机器当客户端。 */
const CLIENT_COUNTRY = "CN";

function hostUsable(host: any) {
  return !!host && !!host.isOnline && hostSupportsNodeCheck(host);
}

function hostCountry(host: any) {
  return String(host?.geoCountryCode || "").trim().toUpperCase();
}

/**
 * 入口机上 sing-box 该连哪：用户态转发（gost / realm / socat / nginx）、线路组调度器、隧道入口、
 * 共享 TLS 入站后面的守卫都在本机端口上接，连回环就行；内核转发（iptables / nftables）只改写外面进来
 * 的包，本机发出的连接不经过它，直接连规则的目标 —— 它本来就转去那里（内核转发不跑线路组调度器）。
 */
export function entryLocalDial(rule: any): { server: string; port: number; via: "loopback" | "next-hop" } | null {
  const forwardType = String(rule?.forwardType || "").trim().toLowerCase();
  const kernel = (KERNEL_FORWARD_TYPES as readonly string[]).includes(forwardType) && !(Number(rule?.tunnelId || 0) > 0);
  if (kernel) {
    const server = String(rule?.targetIp || "").trim();
    const port = Number(rule?.targetPort || 0);
    return server && port > 0 && port <= 65535 ? { server, port, via: "next-hop" } : null;
  }
  const port = Number(rule?.sourcePort || 0);
  return port > 0 && port <= 65535 ? { server: "127.0.0.1", port, via: "loopback" } : null;
}

/**
 * 换掉出站连的地址，握手里的东西照客户端的来：TLS 的 SNI、ws / http 的 Host 原来跟着地址走，
 * 换成 127.0.0.1 以后对面就看到 127.0.0.1 了，所以没写的时候写死成原来的地址。
 */
export function retargetOutbound(outbound: Record<string, unknown>, server: string, port: number): Record<string, unknown> {
  const original = String(outbound.server || "").trim();
  const next: Record<string, unknown> = { ...outbound, server, server_port: port };
  if (!original || original === server) return next;
  const tls = outbound.tls as Record<string, unknown> | undefined;
  if (tls && tls.enabled && !tls.server_name && !tls.disable_sni) next.tls = { ...tls, server_name: original };
  const transport = outbound.transport as Record<string, unknown> | undefined;
  if (transport?.type === "ws") {
    const headers = (transport.headers as Record<string, unknown> | undefined) || {};
    if (!headers.Host) next.transport = { ...transport, headers: { ...headers, Host: original } };
  } else if (transport?.type === "http") {
    if (!Array.isArray(transport.host) || transport.host.length === 0) next.transport = { ...transport, host: [original] };
  } else if (transport?.type === "httpupgrade") {
    if (!transport.host) next.transport = { ...transport, host: original };
  }
  return next;
}

/** 组模板（入口组 / DNS 入口池）本身不在哪台机器上跑：挑一条成员规则，入口机在线、Agent 够新的优先。 */
async function entryRuleOf(ruleId: number) {
  const rule = await db.getForwardRuleById(ruleId) as any;
  if (!rule || !dbBool(rule.isForwardGroupTemplate)) return rule;
  const children = (await db.getForwardGroupChildRulesForTemplate(Number(rule.id)) as any[])
    .filter((child) => !dbBool(child.pendingDelete) && dbBool(child.isEnabled, true));
  for (const child of children) {
    if (hostUsable(child.hostId ? await db.getHostById(Number(child.hostId)) : null)) return child;
  }
  return children[0] || rule;
}

export async function planEntryCheck(userId: number, viewer: { id: number; role: string }, entryKey: string): Promise<EntryCheckPlan> {
  const ref = parseEntryKey(entryKey);
  if (!ref) throw new Error("不认识的线路");
  const { plan } = await db.getProxySubscriptionPreviewForUser(userId);
  const entry = plan.entries.find((item) => (ref.kind === "relay" ? item.kind === "relay" && Number(item.ruleId) === ref.ruleId : item.kind === "direct" && Number(item.templateId) === ref.templateId));
  if (!entry) throw new Error("订阅里没有这条线路了");
  const routeHostIds = new Set<number>();
  let entryHost: any = null;
  let entryRule: any = null;
  if (entry.kind === "relay" && entry.ruleId > 0) {
    entryRule = await entryRuleOf(entry.ruleId);
    entryHost = entryRule?.hostId ? await db.getHostById(Number(entryRule.hostId)) : null;
  } else {
    const template = await db.getProxyNodeById(Number(entry.templateId));
    entryHost = template ? (await findNodeHost(template, viewer)).host : null;
  }
  if (entryHost) routeHostIds.add(Number(entryHost.id));
  const template = await db.getProxyNodeById(Number(entry.templateId));
  if (template) {
    const { host: landing } = await findNodeHost(template, viewer);
    if (landing) routeHostIds.add(Number(landing.id));
  }
  const base = { entry, entryName: entry.node.name, routeHostIds: Array.from(routeHostIds) };

  // 中转线路、没有前置代理：入口机上测。
  const hasFront = Number(entry.frontTemplateId || 0) > 0;
  let entryProblem = "";
  if (entry.kind === "relay" && !hasFront) {
    const dial = entryLocalDial(entryRule);
    if (hostUsable(entryHost) && dial) {
      return {
        ...base,
        host: entryHost,
        hostRole: "entry",
        dial,
        note: dial.via === "next-hop"
          ? "在入口机上测：内核转发不接本机发出的连接，直接连它转去的下一跳，路和客户端连入口之后一样"
          : "在入口机上测：连本机的入口，经中转、落地出去；不含你到入口那一段",
      };
    }
    entryProblem = !entryHost ? "找不到入口机" : !entryHost.isOnline ? `入口机 ${entryHost.name} 离线` : !hostSupportsNodeCheck(entryHost) ? `入口机 ${entryHost.name} 的 Agent 太旧` : "入口规则没有可连的端口";
  }

  // 借一台机器当客户端：和入口同一个国家的优先（直连节点按用的人在国内挑）。
  const wantCountry = entry.kind === "relay" ? hostCountry(entryHost) || CLIENT_COUNTRY : CLIENT_COUNTRY;
  const hosts = await viewerHosts(viewer);
  // 线路上的机器不当客户端：入口机连不了自己的公网地址（云主机的公网 IP 是 NAT 的），落地机连自己没有意义。
  const usable = hosts.filter((item) => !routeHostIds.has(Number(item.id)) && hostUsable(item));
  const sameCountry = usable.filter((item) => hostCountry(item) === wantCountry);
  const client = sameCountry[0] || usable[0] || null;
  const where = client ? `${client.name}${hostCountry(client) ? `（${hostCountry(client)}）` : ""}` : "";
  const why = entryProblem ? `${entryProblem}，` : hasFront ? "这条线路先经前置代理，" : entry.kind === "direct" ? "直连节点，" : "";
  const farAway = client && wantCountry && hostCountry(client) !== wantCountry ? `；它不在 ${wantCountry}，结果多了它到入口那一段的距离` : "";
  return {
    ...base,
    host: client,
    hostRole: "client",
    dial: null,
    note: client ? `${why}借 ${where} 当客户端连订阅里的地址${farAway}` : `${why}没有别的在线、Agent 2.2.241 以上的机器能当客户端`,
  };
}

/** 排一次线路测速：入口机连自己的入口（或借一台机器当客户端连订阅地址）走完整条链去测。 */
export async function startSpeedTestForEntry(userId: number, viewer: { id: number; role: string }, input: { entryKey: string }) {
  const plan = await planEntryCheck(userId, viewer, input.entryKey);
  if (!plan.host) throw new Error(`没有机器能测这条线路：${plan.note}`);
  let outbound = singboxOutbound(plan.entry.node);
  delete outbound.detour;
  if (plan.hostRole === "entry" && plan.dial) outbound = retargetOutbound(outbound, plan.dial.server, plan.dial.port);
  const extraOutbounds: Record<string, unknown>[] = [];
  if (plan.hostRole === "client" && plan.entry.frontTemplateId > 0) {
    // 前置代理：订阅里这条线路先经另一条，借来的客户端也照样先经它。
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
    subject: { kind: "speed", hostId: Number(plan.host.id), nodeId: 0, entryKey: input.entryKey } as NodeCheckSubject,
    ...startNodeCheck(plan.host, { kind: "speed", entryKey: input.entryKey, nodeName: plan.entryName, outbound, extraOutbounds, installCmd: await singboxInstallCmd(), requestedBy: viewer.id }),
  };
}

/*
  测速跑的时候界面每秒拉一次状态，每次都把整份订阅算一遍太重：同一个人看同一条线路，10 秒内用上一次排的。
*/
const ENTRY_PLAN_CACHE_MS = 10_000;
const entryPlanCache = new Map<string, { at: number; plan: Promise<EntryCheckPlan> }>();

function cachedEntryPlan(userId: number, viewer: { id: number; role: string }, entryKey: string) {
  const now = Date.now();
  const key = `${userId}:${viewer.id}:${entryKey}`;
  const hit = entryPlanCache.get(key);
  if (hit && now - hit.at < ENTRY_PLAN_CACHE_MS) return hit.plan;
  for (const [cacheKey, entry] of entryPlanCache) {
    if (now - entry.at >= ENTRY_PLAN_CACHE_MS) entryPlanCache.delete(cacheKey);
  }
  const plan = planEntryCheck(userId, viewer, entryKey);
  entryPlanCache.set(key, { at: now, plan });
  plan.catch(() => entryPlanCache.delete(key));
  return plan;
}

export async function speedTestStatusForEntry(userId: number, viewer: { id: number; role: string }, entryKey: string) {
  const plan = await cachedEntryPlan(userId, viewer, entryKey);
  const status = await nodeCheckStatus({ kind: "speed", hostId: 0, nodeId: 0, entryKey });
  return {
    entryName: plan.entryName,
    host: plan.host ? candidateOf(plan.host, false) : null,
    hostRole: plan.hostRole,
    dialVia: plan.dial?.via ?? null,
    note: plan.note,
    ...status,
  };
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
