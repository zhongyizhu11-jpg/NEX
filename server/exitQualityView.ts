import * as db from "./db";
import { getSiteLatencySamples, hostSupportsSiteLatency } from "./ops/siteLatency";
import { hostSupportsUnlock, latestUnlockRuns, latestUnlockSummariesByHostIds } from "./ops/unlock";
import { UNLOCK_SERVICES } from "../shared/unlockCheck";
import { isAgentVersionAtLeast } from "../shared/version";
import { getHostEntryAddresses } from "../shared/hostEntryAddress";
import {
  SITE_LATENCY_TARGETS,
  SITE_LATENCY_VERIFIED_AGENT_VERSION,
  siteLatencyNoEgress,
  summarizeSiteSamples,
  type SiteLatencySummary,
} from "../shared/siteLatency";

/*
  落地出口检测（订阅管理 › 我的节点 › 出口检测；订阅内容里点开一条线路的「出口」那一节）。

  原来是概览上的「出口质量」卡：所有主机一排排铺开。用户要回答的其实是「我这个节点从哪台
  机器出去、那台出去以后连得上什么、解锁了什么」，所以挪到节点上，按节点查：
    · 自建节点：入站所在的那台主机。
    · 粘贴节点：按地址对上自己看得到的主机（主机的 IP / 入口地址 / DDNS 域名）；对不上就说清楚
      测不了 —— 那台机器上没有我们的 Agent。
  一台主机的数据：四个站点的握手走势 + 汇总（shared/siteLatency），解锁检测最近一次的摘要。
*/

export type ExitQualitySite = SiteLatencySummary & { key: string; values: number[] };

export type ExitQualityHost = {
  id: number;
  name: string;
  online: boolean;
  countryCode: string | null;
  sites: ExitQualitySite[];
  /** 每个站点整个窗口都没连上过：这台机器多半没有公网出口（国内专线 / 中转入口常这样）。 */
  noEgress: boolean;
  /** Agent 早于 2.2.240：没校验证书，DNS 被污染时可能显示一个假的低延迟。 */
  unverified: boolean;
  /** Agent 还不支持出口探测（早于 2.2.237）。 */
  unsupported: boolean;
  unlock: { checkedAt: number; items: { service: string; text: string; status: string }[] } | null;
  /** 解锁检测最近一次的每一项（不只是卡片上那几个）；没测过是 null。 */
  unlockDetail: { checkedAt: number; family: string; results: { service: string; name: string; status: string; region: string | null }[] } | null;
  unlockSupported: boolean;
};

export const EXIT_QUALITY_TARGETS = SITE_LATENCY_TARGETS.map(({ key, label, host }) => ({ key, label, host }));

export async function buildHostExitQuality(host: any): Promise<ExitQualityHost> {
  const id = Number(host.id);
  const samples = getSiteLatencySamples(id);
  const sites = SITE_LATENCY_TARGETS.map((target) => {
    const list = samples.get(target.key) || [];
    return { key: target.key, ...summarizeSiteSamples(list), values: list.map((sample) => sample.ms ?? 0) };
  });
  const version = String(host.agentVersion || "").replace(/^v/i, "");
  const unlock = await latestUnlockSummariesByHostIds([id]).catch(() => new Map());
  const summary = unlock.get(id);
  const runs = await latestUnlockRuns(id).catch(() => [] as Awaited<ReturnType<typeof latestUnlockRuns>>);
  const run = runs[0] || null;
  const order = new Map(UNLOCK_SERVICES.map((service, index) => [service.id, index]));
  const names = new Map(UNLOCK_SERVICES.map((service) => [service.id, service.name]));
  return {
    id,
    name: String(host.name || `主机 ${id}`),
    online: !!host.isOnline,
    countryCode: host.countryCode ? String(host.countryCode) : null,
    sites,
    noEgress: siteLatencyNoEgress(sites),
    unverified: !!version && !isAgentVersionAtLeast(version, SITE_LATENCY_VERIFIED_AGENT_VERSION),
    unsupported: !hostSupportsSiteLatency(host),
    unlock: summary ? { checkedAt: summary.checkedAt, items: summary.items } : null,
    unlockDetail: run ? {
      checkedAt: run.checkedAt,
      family: run.family,
      results: [...run.results]
        .sort((left, right) => (order.get(left.service) ?? 99) - (order.get(right.service) ?? 99))
        .map((item) => ({ service: item.service, name: names.get(item.service) || item.service, status: item.status, region: item.region })),
    } : null,
    unlockSupported: hostSupportsUnlock(host),
  };
}

function normalizeAddress(value: unknown) {
  return String(value ?? "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

/** 主机能被认出来的所有地址：上报的 IP、自动探测的 v4 / v6、入口地址、DDNS 域名。 */
export function hostAddressSet(host: any): Set<string> {
  const out = new Set<string>();
  for (const value of [host?.ip, host?.ipv4, host?.ipv6, host?.entryIp]) {
    const text = normalizeAddress(value);
    if (text) out.add(text);
  }
  for (const entry of getHostEntryAddresses(host)) {
    const text = normalizeAddress(entry.value);
    if (text) out.add(text);
  }
  return out;
}

export function matchHostByAddress(hosts: readonly any[], address: unknown): any | null {
  const wanted = normalizeAddress(address);
  if (!wanted) return null;
  return hosts.find((host) => hostAddressSet(host).has(wanted)) || null;
}

export type NodeExitResult = {
  targets: typeof EXIT_QUALITY_TARGETS;
  subject: { kind: "inbound" | "node"; id: number; name: string; address: string };
  /** 怎么找到这台主机的：入站所在 / 按地址对上 / 对不上 */
  match: "inbound" | "address" | "none";
  host: ExitQualityHost | null;
};

/** 自建节点（入站）：出口就是入站所在的主机。 */
export async function buildInboundExit(inbound: any): Promise<NodeExitResult> {
  const host = await db.getHostById(Number(inbound.hostId));
  return {
    targets: EXIT_QUALITY_TARGETS,
    subject: { kind: "inbound", id: Number(inbound.id), name: String(inbound.name || ""), address: `${String(host?.name || "")}:${Number(inbound.port || 0)}` },
    match: host ? "inbound" : "none",
    host: host ? await buildHostExitQuality(host) : null,
  };
}

/** 一个节点落在哪台自己的机器上：自建的看入站所在；粘贴的按地址对看得到的主机（管理员看全部，用户只看自己的）。 */
export async function findNodeHost(node: any, viewer: { id: number; role: string }): Promise<{ host: any | null; match: NodeExitResult["match"] }> {
  const inboundId = Number(node.inboundId || 0);
  if (inboundId > 0) {
    const inbound = await db.getProxyInboundById(inboundId);
    const host = inbound ? await db.getHostById(Number(inbound.hostId)) : null;
    if (host) return { host, match: "inbound" };
  }
  const hosts = (viewer.role === "admin" ? await db.getHosts() : await db.getHosts(viewer.id)) as any[];
  const host = matchHostByAddress(hosts, node.address);
  return host ? { host, match: "address" } : { host: null, match: "none" };
}

/** 粘贴节点：按地址对上看得到的主机（管理员看全部，用户只看自己的）。 */
export async function buildNodeExit(node: any, viewer: { id: number; role: string }): Promise<NodeExitResult> {
  const { host, match } = await findNodeHost(node, viewer);
  return {
    targets: EXIT_QUALITY_TARGETS,
    subject: { kind: "node", id: Number(node.id), name: String(node.name || ""), address: `${String(node.address || "")}:${Number(node.port || 0)}` },
    match,
    host: host ? await buildHostExitQuality(host) : null,
  };
}
