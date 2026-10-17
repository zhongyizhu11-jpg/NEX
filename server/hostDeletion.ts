import { TRPCError } from "@trpc/server";
import { appendPanelLog } from "./_core/panelLogger";
import { pushAgentRefresh } from "./agentEvents";
import * as db from "./db";
import { withDatabaseTransaction } from "./dbRuntime";
import { isHostConsideredOnline } from "./hostHeartbeatPolicy";

/*
  手动删主机（照上游 poouo/Forwardx server/hostDeletion.ts 移植，保留 NEX 自己的检查和提示）。

  「待清理」的规则是用户已经删掉、但 Agent 还没确认停掉监听的规则（pendingDelete 且 isRunning）。
  以前不管主机在不在线都直接把它们标成已停再删主机 —— 在线的机器上监听还开着，面板却以为停了，
  机器上留一个没人管的转发。现在：
  - 主机在线：拒绝删除，并催 Agent 立刻刷新一次把规则停掉，稍后再删；
  - 主机离线：面板确认不了，调用方必须明确 confirmOfflineCleanup 才删（界面上会再问一次）。
  引用检查和删除放在同一个事务里，检查完到删之间不会有新规则 / 引用插进来，删到一半出错也整体回滚；
  修引用（会拿转发组同步锁）在事务开始前做完，事务里只数不修。
*/

export type HostRuleOwner = { userId: number; username: string | null; name: string | null; ruleCount: number };

/** 「用户 Customer A（customer-a）：3 条、其他用户 2 条」—— 只给管理员看。 */
export function ruleOwnerSummary(owners: HostRuleOwner[]) {
  const visibleOwners = owners.slice(0, 5);
  const labels = visibleOwners.map((owner) => {
    const username = owner.username || `用户 ID ${owner.userId}`;
    const label = owner.name && owner.name !== username ? `${owner.name}（${username}）` : username;
    return `用户 ${label}：${owner.ruleCount} 条`;
  });
  const hiddenRuleCount = owners.slice(visibleOwners.length)
    .reduce((total, owner) => total + owner.ruleCount, 0);
  if (hiddenRuleCount > 0) labels.push(`其他用户 ${hiddenRuleCount} 条`);
  return labels.join("、");
}

export const HOST_DELETE_PENDING_CLEANUP_ONLINE = "主机正在清理已删除的规则，已通知 Agent 停止监听，请稍后再删除主机（不需要重新保存规则）";
export const HOST_DELETE_PENDING_CLEANUP_OFFLINE = "主机离线，面板无法确认已删除的规则已经在机器上停止";

/** 修好删主机前能修的过期引用；在线且有待清理规则时催 Agent 刷新。事务开始前调用。 */
export async function prepareHostDeletion(hostId: number) {
  await db.repairForwardGroupTemplateHostReferencesForHost(hostId);
  // 顺带修端口转发模板和转发组子规则的残留（getHostRuleDeleteBlockers 里做）。
  const blockers = await db.getHostRuleDeleteBlockers(hostId);
  const host = await db.getHostById(hostId);
  if (blockers.pendingCleanupCount > 0 && isHostConsideredOnline(host)) {
    pushAgentRefresh(hostId, "host-delete-pending-cleanup", { urgent: true });
  }
  return blockers;
}

export async function deleteHostWithChecks(
  hostId: number,
  options: { confirmOfflineCleanup?: boolean; showRuleOwners?: boolean } = {},
) {
  await prepareHostDeletion(hostId);
  return withDatabaseTransaction(async () => {
    const host = await db.getHostById(hostId);
    if (!host) throw new Error("主机不存在");
    const blockers = await db.countHostRuleDeleteBlockers(hostId);
    const ownerHint = (owners: HostRuleOwner[]) => {
      const summary = options.showRuleOwners ? ruleOwnerSummary(owners) : "";
      return summary ? `（${summary}）` : "";
    };
    // 检查已标记删除且停止运行的历史记录不阻止删除主机。
    if (blockers.ruleCount > 0) {
      throw new Error(`该主机下还有 ${blockers.ruleCount} 条转发规则${ownerHint(blockers.ruleOwners)}，请先删除所有规则后再删除主机`);
    }
    if (blockers.managedRuleCount > 0) {
      throw new Error(`该主机仍被 ${blockers.managedRuleCount} 条转发组/转发链规则引用${ownerHint(blockers.managedRuleOwners)}，请先在转发组中移除该主机或删除对应转发组`);
    }
    // 隧道、转发组成员、套餐里还引用着它时不能删：这些行不会跟着主机删，会留下指向空主机的引用。
    const references = await db.getHostDeleteReferenceLabels(hostId);
    if (references.length > 0) {
      throw new Error(`该主机仍被引用：${references.join("；")}。请先解除这些引用后再删除主机`);
    }
    const pending = blockers.pendingCleanupCount;
    if (pending > 0) {
      if (isHostConsideredOnline(host)) {
        throw new TRPCError({ code: "CONFLICT", message: `${HOST_DELETE_PENDING_CLEANUP_ONLINE}（${pending} 条）` });
      }
      if (!options.confirmOfflineCleanup) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${HOST_DELETE_PENDING_CLEANUP_OFFLINE}（${pending} 条）。确认后直接删除主机，机器恢复联网后请手动卸载 Agent 或清理残留转发`,
        });
      }
      await db.releaseHostPendingRuleCleanup(hostId);
    }
    await db.deleteHostPermissions(hostId);
    await db.deleteHost(hostId);
    appendPanelLog("info", `[Host] deleted host=${hostId} offlineCleanup=${pending > 0} pending=${pending}`);
    return { success: true as const };
  });
}
