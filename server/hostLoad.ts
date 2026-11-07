import { hostLoadFromSamples, routePathLoadPct, type HostLoadSample } from "../shared/hostLoad";
import type { RoutePath } from "../shared/routeGroup";
import { quoteIdentifier as q } from "./dbCompat";
import { queryRaw } from "./dbRuntime";

/*
  每台主机此刻的负载（shared/hostLoad.ts 的算法），只留在内存里：心跳每来一次记一份样本，和上一份相减得
  带宽速率，再和 CPU 取大。线路组下发调度时按路径沿途的机器查它（routePathLoadHint）。

  为什么不读 host_metrics：那张表 30 秒才写一行（insertHostMetricSampled），而且是异步写；心跳构建规格是
  同步的，查库也来不及。面板重启丢了也没关系：下一次心跳就有 CPU，再下一次就有带宽。
*/

/** 多久没心跳就不再当成「知道它的负载」：离线的机器路径本来就标不可用，不用再扣分。 */
const LOAD_STALE_MS = 5 * 60 * 1000;
const MAX_HOSTS = 10_000;

type HostLoadState = { previous: HostLoadSample | null; latest: HostLoadSample; bandwidthMbps: number; loadPct: number | null };

const states = new Map<number, HostLoadState>();

/** 心跳里记一份：cpuUsage 是百分比，networkIn / networkOut 是累计字节数，bandwidthMbps 是主机填的线路带宽（0 = 不知道）。 */
export function recordHostLoadSample(hostId: number, sample: HostLoadSample, bandwidthMbps: number, now = Date.now()) {
  const id = Math.floor(Number(hostId));
  if (!Number.isInteger(id) || id <= 0) return;
  const current = states.get(id);
  if (!current && states.size >= MAX_HOSTS) {
    const oldest = states.keys().next().value;
    if (oldest !== undefined) states.delete(oldest);
  }
  // 上一份太旧（机器离线了一阵）就不拿来算速率：中间那段流量平均到几分钟上没意义
  const previous = current && now - current.latest.at <= LOAD_STALE_MS ? current.latest : null;
  const bandwidth = Math.max(0, Math.floor(Number(bandwidthMbps) || 0));
  states.set(id, { previous, latest: sample, bandwidthMbps: bandwidth, loadPct: hostLoadFromSamples(previous, sample, bandwidth) });
}

/** 这台主机此刻的负载（0–100）；不知道（没心跳、太旧、什么都没报）是 null。 */
export function hostLoadPctOf(hostId: number, now = Date.now()): number | null {
  const state = states.get(Math.floor(Number(hostId)));
  if (!state || now - state.latest.at > LOAD_STALE_MS) return null;
  return state.loadPct;
}

/*
  落地是「我的节点」、节点又是某台 NEX 主机上的入站派生的（proxy_nodes.inboundId → proxy_inbounds.hostId）：那台的
  负载也算这条路径的。心跳拼规格是同步的，所以拼之前用 ensureLandingNodeHosts 把要用的节点一次查齐，缓存一分钟
  （节点换机器很少见）；查不到 = 不是 NEX 主机上的节点，记 0，一样缓存。落地池的成员机路径上本来就记着（destHostId），不用查。
*/
const NODE_HOST_TTL_MS = 60_000;
const nodeHosts = new Map<number, { hostId: number; at: number }>();

async function loadLandingNodeHosts(nodeIds: number[]): Promise<Map<number, number>> {
  const found = new Map<number, number>();
  const nodes = await queryRaw<{ id: unknown; inboundId: unknown }>(
    `SELECT ${q("id")}, ${q("inboundId")} FROM ${q("proxy_nodes")} WHERE ${q("id")} IN (${nodeIds.map(() => "?").join(",")})`,
    nodeIds,
  );
  const inboundIds = Array.from(new Set(nodes.map((row) => Number(row.inboundId)).filter((id) => Number.isInteger(id) && id > 0)));
  if (inboundIds.length === 0) return found;
  const inbounds = await queryRaw<{ id: unknown; hostId: unknown }>(
    `SELECT ${q("id")}, ${q("hostId")} FROM ${q("proxy_inbounds")} WHERE ${q("id")} IN (${inboundIds.map(() => "?").join(",")})`,
    inboundIds,
  );
  const hostByInbound = new Map(inbounds.map((row) => [Number(row.id), Number(row.hostId)]));
  for (const row of nodes) {
    const hostId = hostByInbound.get(Number(row.inboundId)) || 0;
    if (hostId > 0) found.set(Number(row.id), hostId);
  }
  return found;
}

/** 心跳拼规格之前调：这些节点在哪台主机上，过期的、没查过的一次查齐。查失败不缓存，下一次心跳再查。 */
export async function ensureLandingNodeHosts(nodeIds: Iterable<number>, load = loadLandingNodeHosts, now = Date.now()) {
  const missing = Array.from(new Set(Array.from(nodeIds, (id) => Math.floor(Number(id)))))
    .filter((id) => Number.isInteger(id) && id > 0)
    .filter((id) => {
      const hit = nodeHosts.get(id);
      return !hit || now - hit.at >= NODE_HOST_TTL_MS;
    });
  if (missing.length === 0) return;
  const found = await load(missing).catch(() => null);
  if (!found) return;
  for (const id of missing) {
    if (!nodeHosts.has(id) && nodeHosts.size >= MAX_HOSTS) {
      const oldest = nodeHosts.keys().next().value;
      if (oldest !== undefined) nodeHosts.delete(oldest);
    }
    nodeHosts.set(id, { hostId: found.get(id) || 0, at: now });
  }
}

/** 「我的节点」在哪台 NEX 主机上；不是 / 还没查过是 0。过期了先用着：刷新查失败时总比这一轮不算强。 */
export function landingNodeHostId(nodeId: number): number {
  return nodeHosts.get(Math.floor(Number(nodeId)))?.hostId || 0;
}

/**
 * 下发给 Agent 的 loadPct：路径沿途（中转 + 落地是 NEX 主机时）最忙那台的负载，取整；一台都不知道是 0（不带）。
 * Agent 2.2.251 起拿它扣评分、算「自动」分法的权重；更老的 Agent 不认这个字段，照旧。
 */
export function routePathLoadHint(path: Pick<RoutePath, "hops"> & { destNodeId?: number | null; destHostId?: number | null }, now = Date.now()): number {
  const load = routePathLoadPct(path, (hostId) => hostLoadPctOf(hostId, now), landingNodeHostId);
  return load === null ? 0 : Math.max(0, Math.min(100, Math.round(load)));
}

export function clearHostLoadForTest() {
  states.clear();
  nodeHosts.clear();
}
