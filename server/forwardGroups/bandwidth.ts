/*
  入口组带宽聚合要用的两样实时数据：成员主机的实时上行（按权重解析「按剩余带宽」用）、成员没填上行时用主机上的
  「线路带宽」。以前放在 ddnsEntryGroup.ts，ddnsPublish.ts 和转发组仓库为了这两个函数引它，绕成圈。
*/

import { getHostsByIds } from "../repositories/hostRepository";
import { getLatestHostMetricSnapshots } from "../repositories/metricsRepository";
import { hostThroughputMbpsFromSnapshots, type AggregationMemberRow } from "../bandwidthAggregation";

/** Live uplink throughput, in Mbps, for the hosts behind a set of members. */
export async function memberThroughputMbps(members: AggregationMemberRow[]) {
  const hostIds = Array.from(new Set(members
    .map((member) => Number(member.hostId || 0))
    .filter((hostId) => Number.isInteger(hostId) && hostId > 0)));
  if (hostIds.length === 0) return new Map<number, number>();
  const snapshots = await getLatestHostMetricSnapshots(hostIds).catch(() => []);
  return hostThroughputMbpsFromSnapshots(snapshots as Parameters<typeof hostThroughputMbpsFromSnapshots>[0]);
}

/** 成员上没填「上行 Mbps」时，用主机上的「线路带宽」（一台机器只填一处）。 */
export async function withHostLineBandwidth<T extends { hostId: number; bandwidthMbps?: number | null }>(members: T[]): Promise<T[]> {
  const missing = Array.from(new Set(members.filter((member) => !(Number(member.bandwidthMbps) > 0) && member.hostId > 0).map((member) => member.hostId)));
  if (missing.length === 0) return members;
  const rows = await getHostsByIds(missing).catch(() => []) as Array<{ id: unknown; lineBandwidthMbps?: unknown }>;
  const lineById = new Map(rows.map((row) => [Number(row.id), Math.max(0, Number(row.lineBandwidthMbps) || 0)]));
  return members.map((member) => (Number(member.bandwidthMbps) > 0 || !lineById.get(member.hostId)
    ? member
    : { ...member, bandwidthMbps: lineById.get(member.hostId)! }));
}
