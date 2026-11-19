/*
  组变化之后让 Agent 跟上：刷新用到这个组的规则 / 隧道 / 链式组的下发，组启用 / 停用时连带停 / 恢复规则和隧道，
  被连带停掉的规则在原因消除后自动恢复（healAutoStoppedForwardRules）。
*/

import { forwardGroupModeOf } from "../../shared/forwardTypes";
import { and, eq, inArray, sql } from "drizzle-orm";
import { forwardGroups, forwardRules, tunnels } from "../../drizzle/schema";
import { pushAgentRefresh } from "../agentEvents";
import { appendPanelLog } from "../_core/panelLogger";
import { getDb, isDatabaseTransactionActive, nowDate } from "../dbRuntime";
import { getForwardGroupChildRules } from "../repositories/forwardRuleRepository";
import {
  assertOutsideDatabaseTransaction,
  disableForwardRulesByTunnel,
  getTunnelById,
  getTunnelExitNodes,
  getTunnelHops,
  getTunnels,
  resetForwardRulesByTunnel,
  restoreForwardRulesByTunnel,
  forwardRuleOwnerAllowsRuntime,
  pushRouteRelayHostsForParents,
  syncTunnelExitGroupEndpoints,
  updateTunnel,
} from "../repositories/tunnelRepository";
import { clearTunnelRuntimeStatus, clearTunnelRuntimeStatusForHosts } from "../tunnelRuntimeStatus";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { dbBool } from "../repositories/repositoryUtils";
import { normalizeExitGroupStrategy } from "@shared/exitStrategy";
import { chainEntryMembers, insertForwardGroupEvent, isCollectionGroupMode, memberEntryHostId, sortedMembers } from "./common";
import { runForwardGroupFailover, scheduleForwardGroupFailover } from "./evaluateDriver";
import { getForwardGroupById } from "../repositories/forwardGroupRepository";
import { invalidateForwardGroupProbeTopologyAfterChange } from "./probeTopology";
import { afterForwardGroupSyncCommit, syncChainsUsingEntryGroup, syncForwardGroupRules } from "./ruleSync";

export async function groupHostIds(groupId: unknown) {
  const id = Number(groupId || 0);
  if (!Number.isFinite(id) || id <= 0) return [] as number[];
  const group = await getForwardGroupById(id) as any;
  if (!group) return [] as number[];
  return sortedMembers(group)
    .filter((member: any) => member?.memberType === "host")
    .map((member: any) => Number(member.hostId || 0))
    .filter((hostId: number) => Number.isFinite(hostId) && hostId > 0);
}

async function refreshControlledTunnelRuntime(
  tunnel: any,
  reason: string,
  options: { resetRules?: boolean; extraHostIds?: number[] } = {},
) {
  const tunnelId = Number(tunnel?.id || 0);
  if (!Number.isFinite(tunnelId) || tunnelId <= 0) return;
  clearTunnelRuntimeStatus(tunnelId);
  await updateTunnel(tunnelId, { isRunning: false } as any);
  if (options.resetRules) await resetForwardRulesByTunnel(tunnelId);

  const hostIds = new Set<number>(options.extraHostIds || []);
  for (const value of [tunnel?.entryHostId, tunnel?.exitHostId]) {
    const hostId = Number(value || 0);
    if (Number.isFinite(hostId) && hostId > 0) hostIds.add(hostId);
  }
  for (const hostId of await groupHostIds(tunnel?.entryGroupId)) hostIds.add(hostId);
  for (const hostId of await groupHostIds(tunnel?.exitGroupId)) hostIds.add(hostId);

  const hops = await getTunnelHops(tunnelId).catch(() => []);
  for (const hop of hops as any[]) {
    const hostId = Number(hop?.hostId || 0);
    if (Number.isFinite(hostId) && hostId > 0) hostIds.add(hostId);
  }
  const extraExits = await getTunnelExitNodes(tunnelId).catch(() => []);
  for (const node of extraExits as any[]) {
    const hostId = Number(node?.hostId || 0);
    if (Number.isFinite(hostId) && hostId > 0) hostIds.add(hostId);
  }
  for (const hostId of hostIds) pushAgentRefresh(hostId, `${reason}-tunnel-${tunnelId}`, { urgent: true });
}

/*
  链路的配置变了、但不用重新铺（P9）：出口组只改了分配方式、检测与切换参数，或只调了后面几台出口的
  先后。入口换一份配置就行 —— GOST / Nginx 的配置是按内容比对同步的，FXP 入口（和多跳里挑出口的中转）
  看到自己「没就绪」会带着新规格再下发一次，都不停转发。所以这里不动 tunnels.isRunning、不重置规则，
  只把入口和中转的就绪状态清掉并通知各台来拉配置。出口机的就绪状态留着，免得被连带重装。
*/
async function pushControlledTunnelConfig(
  tunnel: { id?: unknown; entryHostId?: unknown; exitHostId?: unknown; entryGroupId?: unknown } | null | undefined,
  reason: string,
  extraHostIds: number[] = [],
) {
  const tunnelId = Number(tunnel?.id || 0);
  if (!Number.isFinite(tunnelId) || tunnelId <= 0) return;
  const entryHostIds = new Set<number>();
  const entryHostId = Number(tunnel?.entryHostId || 0);
  if (entryHostId > 0) entryHostIds.add(entryHostId);
  for (const hostId of await groupHostIds(tunnel?.entryGroupId)) entryHostIds.add(hostId);
  const exitHostIds = new Set<number>();
  const primaryExitHostId = Number(tunnel?.exitHostId || 0);
  if (primaryExitHostId > 0) exitHostIds.add(primaryExitHostId);
  for (const node of await getTunnelExitNodes(tunnelId).catch(() => []) as Array<{ hostId?: unknown }>) {
    const hostId = Number(node?.hostId || 0);
    if (hostId > 0) exitHostIds.add(hostId);
  }
  // 中转（多跳里除了出口的那几跳）和入口一样要重新拿规格。
  const relayHostIds = new Set<number>();
  for (const hop of await getTunnelHops(tunnelId).catch(() => []) as Array<{ hostId?: unknown }>) {
    const hostId = Number(hop?.hostId || 0);
    if (hostId > 0 && !exitHostIds.has(hostId)) relayHostIds.add(hostId);
  }
  const dispatchHostIds = new Set<number>([...entryHostIds, ...relayHostIds]);
  clearTunnelRuntimeStatusForHosts(tunnelId, Array.from(dispatchHostIds));
  for (const hostId of dispatchHostIds) pushAgentRefresh(hostId, `${reason}-tunnel-${tunnelId}`, { urgent: true });
  for (const hostId of new Set<number>([...exitHostIds, ...extraHostIds])) {
    if (hostId > 0 && !dispatchHostIds.has(hostId)) pushAgentRefresh(hostId, `${reason}-tunnel-${tunnelId}`);
  }
}

async function refreshTunnelsUsingForwardGroup(
  groupId: number,
  groupMode: "entry" | "exit",
  reason: string,
  previousHostIds: number[] = [],
) {
  const id = Number(groupId);
  if (!Number.isFinite(id) || id <= 0) return;
  const allTunnels = await getTunnels() as any[];
  const referenceKey = groupMode === "entry" ? "entryGroupId" : "exitGroupId";
  const affectedTunnels = allTunnels.filter((tunnel: any) => Number(tunnel?.[referenceKey] || 0) === id);
  if (affectedTunnels.length === 0) return;

  const referencedHostIds = Array.from(new Set([
    ...previousHostIds,
    ...await groupHostIds(id),
  ].map(Number).filter((hostId) => Number.isFinite(hostId) && hostId > 0)));

  const group = groupMode === "exit" ? await getForwardGroupById(id) as any : null;
  const exitStrategy = groupMode === "exit" ? normalizeExitGroupStrategy(group?.exitStrategy) : null;
  const exitMembers = group ? sortedMembers(group) : [];
  const hasEnabledExitMember = exitMembers.some((member: any) => member?.memberType === "host" && dbBool(member?.isEnabled));

  for (const tunnel of affectedTunnels) {
    // 入口组的成员变化、出口组加减出口 / 换主出口：要重新铺，照旧标未运行。只是配置变了的走配置下发。
    let reprovision = true;
    if (exitStrategy && group && hasEnabledExitMember) {
      const synced = await syncTunnelExitGroupEndpoints(tunnel, exitMembers, exitStrategy, group?.balanceDetect ?? null);
      Object.assign(tunnel, synced.tunnel);
      reprovision = synced.reprovision;
    } else if (exitStrategy && dbBool(group?.isEnabled)) {
      throw new Error("Enabled exit group must contain at least one enabled host");
    }
    if (reprovision) await refreshControlledTunnelRuntime(tunnel, reason, { resetRules: true, extraHostIds: referencedHostIds });
    else await pushControlledTunnelConfig(tunnel, reason, referencedHostIds);
  }
}

export async function refreshForwardGroupReferences(
  groupId: number,
  options: {
    reason?: string;
    previousHostIds?: number[];
    syncDependentChains?: boolean;
  } = {},
) {
  const group = await getForwardGroupById(Number(groupId));
  const mode = forwardGroupModeOf(group);
  if (mode !== "entry" && mode !== "exit") return;
  if (mode === "entry" && options.syncDependentChains !== false) {
    await syncChainsUsingEntryGroup(Number(groupId));
  }
  await refreshTunnelsUsingForwardGroup(
    Number(groupId),
    mode,
    options.reason || `${mode}-group-updated`,
    options.previousHostIds || [],
  );
}

/** 通知这条规则涉及的 Agent 重新拉配置。在事务里时等提交之后再通知（见 afterForwardGroupSyncCommit）。 */
export async function refreshRuleEndpoints(rule: any, reason: string) {
  if (!rule) return;
  if (isDatabaseTransactionActive()) {
    // 提交之后回调里已经不在事务里，会走下面直接通知。
    await afterForwardGroupSyncCommit(`refresh rule=${Number(rule?.id || 0)}`, () => refreshRuleEndpoints(rule, reason));
    return;
  }
  pushAgentRefresh(Number(rule.hostId), reason, { urgent: true });
  if ((rule as any).tunnelId) {
    const tunnel = await getTunnelById(Number((rule as any).tunnelId));
    if (tunnel) {
      pushAgentRefresh(Number(tunnel.entryHostId), `${reason}-entry`, { urgent: true });
      pushAgentRefresh(Number(tunnel.exitHostId), `${reason}-exit`, { urgent: true });
    }
  }
}

export async function refreshForwardChainRuntime(groupId: number, reason: string) {
  const group = await getForwardGroupById(groupId);
  if (!group || forwardGroupModeOf(group) !== "chain") return;
  const hostIds = new Set<number>();
  for (const member of await chainEntryMembers(group)) {
    const hostId = Number(member?.hostId || 0);
    if (hostId > 0) hostIds.add(hostId);
  }
  for (const member of sortedMembers(group, true) as any[]) {
    const hostId = await memberEntryHostId(member).catch(() => 0);
    if (hostId > 0) hostIds.add(hostId);
  }
  const childRules = await getForwardGroupChildRules(groupId);
  for (const rule of childRules as any[]) {
    const hostId = Number(rule?.hostId || 0);
    if (hostId > 0) hostIds.add(hostId);
  }
  for (const hostId of hostIds) pushAgentRefresh(hostId, `${reason}-chain-${groupId}`, { urgent: true });
  if (hostIds.size > 0) {
    appendPanelLog("info", `[ForwardChain] refresh group=${groupId} reason=${reason} hosts=${Array.from(hostIds).join(",")}`);
  }
}

async function dependentChainGroupIds(entryGroupId: number) {
  const db = await getDb();
  if (!db) return [] as number[];
  const rows = await db.select({ id: forwardGroups.id }).from(forwardGroups).where(and(
    inArray(forwardGroups.groupMode, ["chain", "port"]),
    eq(forwardGroups.entryGroupId, entryGroupId),
  ));
  return (rows as any[]).map((row) => Number(row.id || 0)).filter((id) => id > 0);
}

export async function forwardGroupRuntimeDependenciesEnabled(group: any) {
  if (!dbBool(group?.isEnabled)) return false;
  const mode = forwardGroupModeOf(group);
  if (mode !== "chain" && mode !== "port") return true;
  const entryGroupId = Number(group?.entryGroupId || 0);
  if (entryGroupId <= 0) return true;
  const entryGroup = await getForwardGroupById(entryGroupId) as any;
  return dbBool(entryGroup?.isEnabled) && forwardGroupModeOf(entryGroup) === "entry";
}

/** 通知这批规则涉及的 Agent（和隧道两端）。在事务里时等提交之后再通知（见 afterForwardGroupSyncCommit）。 */
export async function refreshControlledForwardRules(rules: any[], reason: string) {
  if (isDatabaseTransactionActive()) {
    await afterForwardGroupSyncCommit(`refresh ${rules.length} rules`, () => refreshControlledForwardRules(rules, reason));
    return;
  }
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  for (const rule of rules) {
    if (rule?.isForwardGroupTemplate) continue;
    const hostId = Number(rule?.hostId || 0);
    if (hostId > 0) hostIds.add(hostId);
    const tunnelId = Number(rule?.tunnelId || 0);
    if (tunnelId > 0) tunnelIds.add(tunnelId);
  }
  for (const hostId of hostIds) pushAgentRefresh(hostId, reason, { urgent: true });
  for (const tunnelId of tunnelIds) {
    const tunnel = await getTunnelById(tunnelId);
    if (tunnel) await refreshControlledTunnelRuntime(tunnel, reason);
  }
}

export async function refreshForwardGroupRuntime(groupId: number, reason = "forward-group-runtime-updated") {
  const rules = (await getForwardGroupChildRules(Number(groupId)) as any[])
    .filter((rule) => !dbBool(rule?.pendingDelete));
  await refreshControlledForwardRules(rules, reason);
  return rules.length;
}

async function disableForwardRulesByGroupIds(groupIds: number[], reason: string) {
  const ids = Array.from(new Set(groupIds.map((id) => Number(id)).filter((id) => id > 0)));
  if (ids.length === 0) return 0;
  const db = await getDb();
  if (!db) return 0;
  const rules = await db.select().from(forwardRules).where(and(
    inArray(forwardRules.forwardGroupId, ids),
    eq(forwardRules.pendingDelete, false),
  ));
  const controlledRules = (rules as any[]).filter((rule) => (
    dbBool(rule.isEnabled) || dbBool(rule.disabledByTunnel) || dbBool(rule.disabledByGroup)
  ));
  const controlledIds = controlledRules.map((rule) => Number(rule.id || 0)).filter((id) => id > 0);
  if (controlledIds.length > 0) {
    appendPanelLog("warn", `[RuleStop] forward groups=${ids.join(",")} stopped ${controlledIds.length} rule(s) reason=${reason}; they resume automatically when the group is enabled again`);
    await db.update(forwardRules).set({
      isEnabled: false,
      isRunning: false,
      disabledByGroup: true,
      updatedAt: nowDate(),
    } as any).where(inArray(forwardRules.id, controlledIds));
    await refreshControlledForwardRules(controlledRules, reason);
    // 这些规则要是线路组规则，中转机上的中继也跟着停，通知中转机马上拉配置。
    await pushRouteRelayHostsForParents(controlledIds, reason);
  }
  return controlledIds.length;
}

/** 余额不足只停计费资源上的规则（见 server/trafficBillingRuleBlock.ts）。按需加载，避免仓储层和它互相引用。 */
export async function handleTrafficBillingShortfallLazily(userId: number, reason: string) {
  const { handleTrafficBillingShortfall } = await import("../trafficBillingRuleBlock");
  await handleTrafficBillingShortfall(userId, reason);
}

export async function restoreForwardRulesByGroupId(groupId: number, reason: string) {
  const group = await getForwardGroupById(groupId) as any;
  if (!group || !(await forwardGroupRuntimeDependenciesEnabled(group))) return 0;
  const db = await getDb();
  if (!db) return 0;
  const rules = await db.select().from(forwardRules).where(and(
    eq(forwardRules.forwardGroupId, groupId),
    eq(forwardRules.disabledByGroup, true),
    eq(forwardRules.pendingDelete, false),
  ));
  for (const rule of rules as any[]) {
    const isTemplate = dbBool(rule.isForwardGroupTemplate);
    const ownerAllowed = !isTemplate || await forwardRuleOwnerAllowsRuntime(rule.userId);
    const canEnableTemplate = isTemplate
      && ownerAllowed
      && !dbBool(rule.disabledByTunnel)
      && !dbBool(rule.disabledByUser)
      && !String(rule.protocolBlockReason || "").trim();
    await db.update(forwardRules).set({
      isEnabled: canEnableTemplate,
      isRunning: false,
      disabledByGroup: false,
      ...(ownerAllowed ? {} : { disabledByUser: true }),
      updatedAt: nowDate(),
    } as any).where(eq(forwardRules.id, Number(rule.id)));
  }
  if (rules.length > 0) appendPanelLog("info", `[RuleStop] forward group=${groupId} resumed ${rules.length} rule(s) reason=${reason}`);
  await syncForwardGroupRules(groupId);
  await refreshControlledForwardRules(rules as any[], reason);
  await pushRouteRelayHostsForParents((rules as any[]).map((rule) => Number(rule.id)), reason);
  return rules.length;
}

async function tunnelGroupDependenciesEnabled(tunnel: any) {
  const refs: Array<{ id: number; mode: "entry" | "exit" }> = [
    { id: Number(tunnel?.entryGroupId || 0), mode: "entry" },
    { id: Number(tunnel?.exitGroupId || 0), mode: "exit" },
  ];
  for (const ref of refs) {
    if (ref.id <= 0) continue;
    const group = await getForwardGroupById(ref.id) as any;
    if (!dbBool(group?.isEnabled) || forwardGroupModeOf(group) !== ref.mode) return false;
  }
  return true;
}

async function setTunnelsEnabledByGroup(groupId: number, groupMode: "entry" | "exit", isEnabled: boolean) {
  assertOutsideDatabaseTransaction("setTunnelsEnabledByGroup");
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select().from(tunnels).where(
    groupMode === "entry" ? eq(tunnels.entryGroupId, groupId) : eq(tunnels.exitGroupId, groupId),
  );
  let changed = 0;
  for (const row of rows as any[]) {
    const tunnelId = Number(row.id || 0);
    if (tunnelId <= 0) continue;
    await withKeyedTaskLock(`tunnel:${tunnelId}`, async () => {
      const tunnel = await getTunnelById(tunnelId) as any;
      if (!tunnel) return;
      if (!isEnabled) {
        if (!dbBool(tunnel.isEnabled) && !dbBool(tunnel.disabledByGroup)) return;
        await updateTunnel(tunnelId, {
          isEnabled: false,
          isRunning: false,
          disabledByGroup: true,
        } as any);
        await disableForwardRulesByTunnel(tunnelId, `${groupMode}-group-${groupId}-disabled`);
        await refreshControlledTunnelRuntime({ ...tunnel, isEnabled: false, disabledByGroup: true }, `${groupMode}-group-disabled`, { resetRules: true });
        changed += 1;
        return;
      }
      if (!dbBool(tunnel.disabledByGroup) || !(await tunnelGroupDependenciesEnabled(tunnel))) return;
      await updateTunnel(tunnelId, {
        isEnabled: true,
        isRunning: false,
        disabledByGroup: false,
      } as any);
      await restoreForwardRulesByTunnel(tunnelId);
      await refreshControlledTunnelRuntime({ ...tunnel, isEnabled: true, disabledByGroup: false }, `${groupMode}-group-enabled`, { resetRules: true });
      changed += 1;
    });
  }
  return changed;
}

/**
 * 自愈：被系统（隧道停用、转发资源停用）连带停掉的规则，原因消除了就自己恢复。
 *
 * 正常情况下，开隧道 / 开资源那一步已经把规则拉回来了。这里兜的是「那一步没走完」
 * 的情况：面板在中途重启、某次恢复抛了错、并发把标记写乱了 —— 以前一旦漏掉，
 * 一整条隧道的规则就停在那里，只能一条条手动开。手动关掉的规则不带这些标记，
 * 这里不会碰。
 */
export async function healAutoStoppedForwardRules(reason = "auto-heal") {
  // 第 1、2 步按隧道拿 tunnel:<id> 键锁，理由同 setTunnelsEnabledByGroup。
  assertOutsideDatabaseTransaction("healAutoStoppedForwardRules");
  const db = await getDb();
  if (!db) return { tunnels: 0, tunnelRules: 0, groupRules: 0 };
  let healedTunnels = 0;
  let tunnelRules = 0;
  let groupRules = 0;

  // 1) 被入口/出口组连带停掉的隧道：组已经重新启用，隧道自己回来。
  const groupStoppedTunnels = await db.select().from(tunnels).where(and(
    eq(tunnels.disabledByGroup, true),
    eq(tunnels.isEnabled, false),
  ));
  for (const row of groupStoppedTunnels as any[]) {
    const tunnelId = Number(row.id || 0);
    if (tunnelId <= 0) continue;
    await withKeyedTaskLock(`tunnel:${tunnelId}`, async () => {
      const tunnel = await getTunnelById(tunnelId) as any;
      if (!tunnel || dbBool(tunnel.isEnabled) || !dbBool(tunnel.disabledByGroup)) return;
      if (!(await tunnelGroupDependenciesEnabled(tunnel))) return;
      await updateTunnel(tunnelId, { isEnabled: true, isRunning: false, disabledByGroup: false } as any);
      tunnelRules += await restoreForwardRulesByTunnel(tunnelId) || 0;
      await refreshControlledTunnelRuntime({ ...tunnel, isEnabled: true, disabledByGroup: false }, `${reason}-tunnel-group-restored`, { resetRules: true });
      healedTunnels += 1;
    });
  }

  // 2) 标着「因隧道停用而停」、隧道其实已经开着的规则。
  const tunnelStopped = await db.select({ tunnelId: forwardRules.tunnelId }).from(forwardRules).where(and(
    eq(forwardRules.disabledByTunnel, true),
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.tunnelId} IS NOT NULL`,
  ));
  const tunnelIds = Array.from(new Set((tunnelStopped as any[]).map((row) => Number(row.tunnelId || 0)).filter((id) => id > 0)));
  for (const tunnelId of tunnelIds) {
    await withKeyedTaskLock(`tunnel:${tunnelId}`, async () => {
      const tunnel = await getTunnelById(tunnelId) as any;
      if (!tunnel || !dbBool(tunnel.isEnabled) || dbBool(tunnel.disabledByGroup)) return;
      if (!(await tunnelGroupDependenciesEnabled(tunnel))) return;
      const restored = await restoreForwardRulesByTunnel(tunnelId) || 0;
      tunnelRules += restored;
      await refreshControlledTunnelRuntime(tunnel, `${reason}-tunnel-rules-restored`, { resetRules: true });
    });
  }

  // 3) 标着「因转发资源停用而停」、资源其实已经启用的规则。
  const groupStopped = await db.select({ groupId: forwardRules.forwardGroupId }).from(forwardRules).where(and(
    eq(forwardRules.disabledByGroup, true),
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupId} IS NOT NULL`,
  ));
  const groupIds = Array.from(new Set((groupStopped as any[]).map((row) => Number(row.groupId || 0)).filter((id) => id > 0)));
  for (const groupId of groupIds) {
    const group = await getForwardGroupById(groupId) as any;
    if (!group || !dbBool(group.isEnabled)) continue;
    groupRules += await restoreForwardRulesByGroupId(groupId, `${reason}-group-rules-restored`);
  }

  if (healedTunnels + tunnelRules + groupRules > 0) {
    appendPanelLog("info", `[RuleRecovery] ${reason}: tunnels=${healedTunnels} tunnelRules=${tunnelRules} groupRules=${groupRules} resumed after their cause cleared`);
  }
  return { tunnels: healedTunnels, tunnelRules, groupRules };
}

export async function setForwardGroupEnabled(groupId: number, isEnabled: boolean) {
  try {
    return await setForwardGroupEnabledUnwatched(groupId, isEnabled);
  } finally {
    invalidateForwardGroupProbeTopologyAfterChange();
  }
}

async function setForwardGroupEnabledUnwatched(groupId: number, isEnabled: boolean) {
  const group = await getForwardGroupById(groupId) as any;
  if (!group) throw new Error("转发资源不存在");
  const mode = forwardGroupModeOf(group);
  const wasEnabled = dbBool(group.isEnabled);
  if (isEnabled && mode === "exit" && !sortedMembers(group, true).some((member: any) => member?.memberType === "host")) {
    throw new Error("Enabled exit group must contain at least one enabled host");
  }
  if (isEnabled && (mode === "chain" || mode === "port") && Number(group.entryGroupId || 0) > 0) {
    const entryGroup = await getForwardGroupById(Number(group.entryGroupId)) as any;
    if (!dbBool(entryGroup?.isEnabled) || forwardGroupModeOf(entryGroup) !== "entry") {
      throw new Error("关联入口组未启用，请先开启入口组");
    }
  }

  const ruleGroupIds = mode === "entry"
    ? await dependentChainGroupIds(groupId)
    : isCollectionGroupMode(mode)
      ? []
      : [groupId];
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(forwardGroups).set({
    isEnabled,
    updatedAt: nowDate(),
  } as any).where(eq(forwardGroups.id, groupId));

  let affectedRules = 0;
  let affectedTunnels = 0;
  try {
    if (!isEnabled) {
      affectedRules = await disableForwardRulesByGroupIds(ruleGroupIds, `${mode}-group-disabled`);
      for (const id of ruleGroupIds) await syncForwardGroupRules(id);
      if (mode === "entry" || mode === "exit") {
        affectedTunnels = await setTunnelsEnabledByGroup(groupId, mode, false);
      }
    } else {
      for (const id of ruleGroupIds) {
        affectedRules += await restoreForwardRulesByGroupId(id, `${mode}-group-enabled`);
      }
      if (mode === "entry" || mode === "exit") {
        affectedTunnels = await setTunnelsEnabledByGroup(groupId, mode, true);
      }
    }
  } catch (error) {
    if (isEnabled && !wasEnabled) {
      try {
        await db.update(forwardGroups).set({ isEnabled: false, updatedAt: nowDate() } as any).where(eq(forwardGroups.id, groupId));
        await disableForwardRulesByGroupIds(ruleGroupIds, `${mode}-group-enable-rollback`);
        for (const id of ruleGroupIds) await syncForwardGroupRules(id);
        if (mode === "entry" || mode === "exit") await setTunnelsEnabledByGroup(groupId, mode, false);
      } catch (rollbackError) {
        appendPanelLog("warn", `[ForwardGroup] enable rollback failed group=${groupId}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    throw error;
  }
  if (isEnabled && (mode === "failover" || mode === "entry" || mode === "exit")) {
    // 选活动成员 / 推 DDNS 放到启用之后、尽力而为：DNS 服务商一时报错不该把已经恢复好的
    // 规则和隧道整个回滚成停用。失败记日志，交给评估队列按退避重试（DDNS 值没更新成功，
    // 下一轮会再推）。
    try {
      await runForwardGroupFailover(groupId, { manual: true, forceSync: true });
    } catch (error) {
      appendPanelLog("warn", `[ForwardGroup] failover/DDNS sync after enable failed group=${groupId}; retry scheduled: ${error instanceof Error ? error.message : String(error)}`);
      scheduleForwardGroupFailover([groupId]);
    }
  }
  await insertForwardGroupEvent(groupId, null, isEnabled ? "enabled" : "disabled", isEnabled ? "链路资源已启用。" : "链路资源已停用，关联规则已受控关闭。");
  return { success: true, affectedRules, affectedTunnels };
}
