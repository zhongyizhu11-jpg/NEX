import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier } from "./dbRuntime";
import { appendPanelLog } from "./_core/panelLogger";
import { getLinkAccessScope } from "./linkAccessView";
import { getTunnelById } from "./repositories/tunnelRepository";
import { routeSegmentLatencyEstimate } from "./routeGroupStats";
import { MAX_LAYER_CANDIDATES, routeLinesOf, type RouteExpandContext, type RouteLine } from "../shared/routeLines";

const q = quoteDbIdentifier;

/*
  节点池的存取，以及线路展开要用的上下文（池成员、谁能当中转、隧道、段延迟估计）。
  表在 server/ops/nodePoolTables.ts。
*/

export const NODE_POOL_ROLES = ["relay", "landing", "any"] as const;
export type NodePoolRole = (typeof NODE_POOL_ROLES)[number];

export type NodePool = { id: number; userId: number; name: string; role: NodePoolRole; hostIds: number[]; note: string; sortOrder: number };

function rowToPool(row: any): NodePool {
  let hostIds: number[] = [];
  try {
    const parsed = JSON.parse(String(row.hostIdsJson || "[]"));
    if (Array.isArray(parsed)) hostIds = Array.from(new Set(parsed.map((value) => Math.floor(Number(value))).filter((value) => value > 0))).slice(0, MAX_LAYER_CANDIDATES * 4);
  } catch { /* 坏数据当空池 */ }
  const role = (NODE_POOL_ROLES as readonly string[]).includes(String(row.role)) ? row.role as NodePoolRole : "relay";
  return { id: Number(row.id), userId: Number(row.userId), name: String(row.name || ""), role, hostIds, note: String(row.note || ""), sortOrder: Number(row.sortOrder || 0) };
}

export async function listNodePools(userId: number | null): Promise<NodePool[]> {
  const rows = userId === null
    ? await queryRaw<any>(`SELECT * FROM ${q("node_pools")} ORDER BY ${q("sortOrder")}, ${q("id")}`)
    : await queryRaw<any>(`SELECT * FROM ${q("node_pools")} WHERE ${q("userId")} = ? ORDER BY ${q("sortOrder")}, ${q("id")}`, [userId]);
  return rows.map(rowToPool);
}

export async function getNodePool(id: number): Promise<NodePool | null> {
  const rows = await queryRaw<any>(`SELECT * FROM ${q("node_pools")} WHERE ${q("id")} = ?`, [Number(id)]);
  return rows[0] ? rowToPool(rows[0]) : null;
}

export async function createNodePool(input: { userId: number; name: string; role: NodePoolRole; hostIds: number[]; note?: string }) {
  const nowSec = Math.floor(Date.now() / 1000);
  return insertAndGetId("node_pools", {
    userId: input.userId,
    name: input.name.trim().slice(0, 60),
    role: input.role,
    hostIdsJson: JSON.stringify(input.hostIds),
    note: input.note ? input.note.slice(0, 200) : null,
    sortOrder: 0,
    createdAt: nowSec,
    updatedAt: nowSec,
  });
}

export async function updateNodePool(id: number, patch: { name?: string; role?: NodePoolRole; hostIds?: number[]; note?: string | null }) {
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.name !== undefined) { sets.push(`${q("name")} = ?`); params.push(patch.name.trim().slice(0, 60)); }
  if (patch.role !== undefined) { sets.push(`${q("role")} = ?`); params.push(patch.role); }
  if (patch.hostIds !== undefined) { sets.push(`${q("hostIdsJson")} = ?`); params.push(JSON.stringify(patch.hostIds)); }
  if (patch.note !== undefined) { sets.push(`${q("note")} = ?`); params.push(patch.note ? patch.note.slice(0, 200) : null); }
  if (sets.length === 0) return;
  sets.push(`${q("updatedAt")} = ?`);
  params.push(Math.floor(Date.now() / 1000));
  params.push(Number(id));
  await executeRaw(`UPDATE ${q("node_pools")} SET ${sets.join(", ")} WHERE ${q("id")} = ?`, params);
}

export async function deleteNodePool(id: number) {
  await executeRaw(`DELETE FROM ${q("node_pools")} WHERE ${q("id")} = ?`, [Number(id)]);
}

/** 哪些线路组规则的线路用到了这个池（池改了要重新展开它们）。 */
export async function ruleIdsUsingPool(poolId: number): Promise<number[]> {
  const rows = await queryRaw<any>(`SELECT ${q("id")}, ${q("routeLines")}, ${q("routePaths")} FROM ${q("forward_rules")} WHERE ${q("routeLines")} IS NOT NULL AND ${q("pendingDelete")} = ?`, [false]).catch(() => [] as any[]);
  return rows
    .filter((row) => routeLinesOf(row).some((line) => line.layers.some((layer) => layer.kind === "pool" && layer.poolId === Number(poolId))))
    .map((row) => Number(row.id));
}

/**
 * 展开线路要的上下文：按规则主人（actor）的可见范围。
 * 能不能当中转只看「看不看得见」：离线、维护、熔断是运行时的事，由心跳给路径打提示，
 * 不在展开时删掉 —— 不然机器掉线一次，恢复后路径也不会自己回来。
 */
export async function buildRouteExpandContext(actor: { id: number; role: string }, entryHostId: number | null, lines: RouteLine[]): Promise<RouteExpandContext> {
  const scope = actor.role === "admin" ? null : await getLinkAccessScope(actor as any);
  const usable = scope ? new Set<number>([...(scope.useHostIds || scope.hostIds)]) : null;
  const poolIds = Array.from(new Set(lines.flatMap((line) => line.layers.filter((layer) => layer.kind === "pool" && layer.poolId).map((layer) => Number(layer.poolId)))));
  const pools = new Map<number, number[] | null>();
  for (const poolId of poolIds) {
    const pool = await getNodePool(poolId);
    pools.set(poolId, pool && (actor.role === "admin" || pool.userId === actor.id) ? pool.hostIds : null);
  }
  const tunnelIds = Array.from(new Set(lines.flatMap((line) => line.layers.flatMap((layer) => layer.tunnelIds))));
  const tunnels = new Map<number, any>();
  for (const tunnelId of tunnelIds) {
    const tunnel = await getTunnelById(tunnelId).catch(() => null) as any;
    if (tunnel) tunnels.set(tunnelId, tunnel);
  }
  return {
    entryHostId,
    poolMembers: (poolId) => pools.get(poolId) ?? null,
    hostUsable: (hostId) => !usable || usable.has(Number(hostId)),
    tunnel: (tunnelId) => {
      const tunnel = tunnels.get(tunnelId);
      if (!tunnel) return null;
      const enabled = tunnel.isEnabled === true || tunnel.isEnabled === 1 || tunnel.isEnabled === "1";
      return {
        id: Number(tunnel.id),
        entryHostId: Number(tunnel.entryHostId),
        exitHostId: Number(tunnel.exitHostId),
        name: String(tunnel.name || "").trim() || `隧道 ${tunnel.id}`,
        usable: enabled && !(Number(tunnel.entryGroupId || 0) > 0),
        issue: !enabled ? `隧道「${tunnel.name || tunnel.id}」已停用` : Number(tunnel.entryGroupId || 0) > 0 ? `隧道「${tunnel.name || tunnel.id}」挂了入口组，不能当线路里的一段` : null,
      };
    },
    estimateMs: (from, to) => routeSegmentLatencyEstimate(from === 0 ? Number(entryHostId || 0) : from, to),
  };
}

export function logPoolReexpand(poolId: number, ruleIds: number[]) {
  if (ruleIds.length > 0) appendPanelLog("info", `[NodePool] pool=${poolId} 成员变了，重新展开 ${ruleIds.length} 条线路`);
}
