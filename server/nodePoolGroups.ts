import * as db from "./db";
import { queryRaw, executeRaw, quoteDbIdentifier } from "./dbRuntime";
import { appendPanelLog } from "./_core/panelLogger";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { getNodePool } from "./nodePools";
import { memberEnabledIntent } from "../shared/memberSchedule";
import type { ForwardGroupMemberInput } from "./repositories/forwardGroupRepository";

const q = quoteDbIdentifier;

/*
  入口组 / 出口组 / 主备转发组跟着节点池走（2.3.497）：组的 poolId 设了，组的主机成员就是池里的机器。

    · 池里还在的机器：成员原样留着（连接地址、带宽、权重、时段、启用都不动）。
    · 池里新加的机器：加成主机成员，默认启用、排在后面。
    · 池里去掉的机器：从组里去掉（它在组里的子规则跟着收掉，和在组编辑框里删成员一样）。
    · 隧道成员不归池管，照留。
  真正写库走 replaceForwardGroupMembers：端口占用、死循环、记录类型的校验和之后的规则同步、
  DNS 刷新都和手动改成员是同一条路。池空了不同步（组至少要一台），报出来。
*/

/** 能跟着节点池的组：成员就是一堆机器的那几种。 */
export const POOL_FOLLOWING_GROUP_MODES = ["entry", "exit", "failover"] as const;

export type PoolGroupSyncResult = { groupId: number; added: number; removed: number; kept: number; skipped?: string };

/** 按池算出这个组的新成员清单；纯函数，单测直接测它。 */
export function poolMemberPlan(existing: readonly any[], poolHostIds: readonly number[]): { members: ForwardGroupMemberInput[]; added: number; removed: number; kept: number } {
  const inPool = new Set(poolHostIds.map(Number));
  const members: ForwardGroupMemberInput[] = [];
  let kept = 0;
  let removed = 0;
  const sorted = [...existing].sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0) || Number(left.id || 0) - Number(right.id || 0));
  for (const row of sorted) {
    const isHost = String(row.memberType || "host") === "host";
    if (isHost && !inPool.has(Number(row.hostId))) {
      removed += 1;
      continue;
    }
    if (isHost) kept += 1;
    members.push({
      memberType: isHost ? "host" : "tunnel",
      hostId: isHost ? Number(row.hostId) : null,
      tunnelId: isHost ? null : Number(row.tunnelId || 0) || null,
      connectHost: row.connectHost ?? null,
      // 时段停掉的成员，用户的意思还是「开着」；手动关掉的照旧关着（和按时段调成员是同一个口径）
      isEnabled: memberEnabledIntent(row) || row.isEnabled === undefined || row.isEnabled === null,
      bandwidthMbps: row.bandwidthMbps ?? null,
      aggregationWeight: row.aggregationWeight ?? null,
    });
  }
  const present = new Set(sorted.filter((row) => String(row.memberType || "host") === "host").map((row) => Number(row.hostId)));
  let added = 0;
  for (const hostId of poolHostIds) {
    if (present.has(Number(hostId))) continue;
    members.push({ memberType: "host", hostId: Number(hostId), isEnabled: true });
    added += 1;
  }
  members.forEach((member, index) => { member.priority = index; });
  return { members, added, removed, kept };
}

/** 一个组按它跟着的池同步一遍成员；没跟、池没了、成员没变化都直接返回。 */
export async function syncGroupMembersFromPool(groupId: number, reason: string): Promise<PoolGroupSyncResult> {
  const group = await db.getForwardGroupById(Number(groupId)) as any;
  if (!group) return { groupId, added: 0, removed: 0, kept: 0, skipped: "组不在了" };
  const poolId = Number(group.poolId || 0);
  if (!(poolId > 0)) return { groupId, added: 0, removed: 0, kept: 0, skipped: "没跟着节点池" };
  const pool = await getNodePool(poolId);
  if (!pool) return { groupId, added: 0, removed: 0, kept: 0, skipped: "节点池不在了" };
  const existing = await queryRaw<any>(`SELECT * FROM ${q("forward_group_members")} WHERE ${q("groupId")} = ?`, [Number(groupId)]);
  const plan = poolMemberPlan(existing, pool.hostIds);
  if (plan.added === 0 && plan.removed === 0) return { groupId, added: 0, removed: 0, kept: plan.kept };
  if (plan.members.length === 0) return { groupId, added: 0, removed: 0, kept: 0, skipped: "节点池是空的，组至少要一台机器，没同步" };
  await db.replaceForwardGroupMembers(Number(groupId), plan.members);
  appendPanelLog("info", `[NodePool] group=${groupId} follows pool=${poolId} (${reason}): +${plan.added} -${plan.removed} kept=${plan.kept}`);
  return { groupId, added: plan.added, removed: plan.removed, kept: plan.kept };
}

/** 设 / 取消组跟着的池；设了马上同步一遍。 */
export async function setGroupPool(groupId: number, poolId: number | null): Promise<PoolGroupSyncResult> {
  const group = await db.getForwardGroupById(Number(groupId)) as any;
  if (!group) throw new Error("组不存在");
  if (poolId !== null) {
    if (!(POOL_FOLLOWING_GROUP_MODES as readonly string[]).includes(String(group.groupMode || ""))) throw new Error("只有入口组、出口组、主备转发组能跟着节点池");
    const pool = await getNodePool(poolId);
    if (!pool) throw new Error("节点池不存在");
    if (pool.hostIds.length === 0) throw new Error("节点池是空的：先往池里加机器");
    // 池的主人改池就会改组的成员（同步时不再查主机权限），所以只能跟着组主人自己的池或管理员的池
    if (Number(pool.userId) !== Number(group.userId)) {
      const owner = await db.getUserById(Number(pool.userId)) as any;
      if (owner?.role !== "admin") throw new Error("这个节点池是别的用户的：组只能跟着组主人自己的池，或管理员的池");
    }
  }
  await executeRaw(`UPDATE ${q("forward_groups")} SET ${q("poolId")} = ? WHERE ${q("id")} = ?`, [poolId, Number(groupId)]);
  if (poolId === null) return { groupId, added: 0, removed: 0, kept: 0, skipped: "不再跟着节点池，成员留着现在这些" };
  return syncGroupMembersFromPool(groupId, "follow");
}

/** 池改了：跟着它的组一个个同步；一个组失败不拦别的，失败的原因带回去给界面看。 */
export async function syncGroupsFollowingPool(poolId: number, reason: string): Promise<Array<PoolGroupSyncResult & { error?: string }>> {
  const rows = await queryRaw<any>(`SELECT ${q("id")} FROM ${q("forward_groups")} WHERE ${q("poolId")} = ?`, [Number(poolId)]);
  const results: Array<PoolGroupSyncResult & { error?: string }> = [];
  for (const row of rows) {
    try {
      // 和在组编辑框里改成员用同一把锁：别和手动编辑同时写这个组的成员
      results.push(await withKeyedTaskLock(`forward-group:${Number(row.id)}`, () => syncGroupMembersFromPool(Number(row.id), reason)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendPanelLog("warn", `[NodePool] group=${row.id} sync from pool=${poolId} failed: ${message}`);
      results.push({ groupId: Number(row.id), added: 0, removed: 0, kept: 0, error: message });
    }
  }
  return results;
}

/** 池删了：跟着它的组不再跟（成员留着现在这些）。 */
export async function releaseGroupsFollowingPool(poolId: number) {
  await executeRaw(`UPDATE ${q("forward_groups")} SET ${q("poolId")} = NULL WHERE ${q("poolId")} = ?`, [Number(poolId)]);
}
