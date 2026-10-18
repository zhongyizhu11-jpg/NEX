import * as db from "./db";
import { queryRaw, quoteDbIdentifier } from "./dbRuntime";
import { appendPanelLog } from "./_core/panelLogger";
import { dbBool } from "./repositories/repositoryUtils";
import { memberEnabledIntent, resolveMemberScheduleState } from "../shared/memberSchedule";

/*
  线路按时间段启用（shared/memberSchedule.ts）的执行端：每分钟看一遍设了可用时段的成员，
  进出时段的组按原来「改成员」那条路重写一次 —— 端口检查、主备重选、入口组引用刷新、子规则同步
  都照旧，跟在界面上点一下成员开关是一回事。

  只动跨过时段边界的组：每分钟一次的查询只读成员表里设了时段（或者被时段停着）的那几行。
  改成员失败（比如恢复时端口被别的规则占了）记日志和组事件，下一分钟再试。
*/

const q = quoteDbIdentifier;

export async function applyForwardGroupMemberSchedules(at = new Date()) {
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("groupId")}, ${q("isEnabled")}, ${q("scheduleSuspended")}, ${q("activeSchedule")}
       FROM ${q("forward_group_members")}
      WHERE ${q("activeSchedule")} IS NOT NULL OR ${q("scheduleSuspended")} = ?`,
    [true],
  ).catch(() => []);
  const changed = new Map<number, Array<{ memberId: number; enabled: boolean }>>();
  for (const row of rows) {
    const state = resolveMemberScheduleState(memberEnabledIntent(row), row.activeSchedule, at);
    if (state.isEnabled === dbBool(row.isEnabled) && state.scheduleSuspended === dbBool(row.scheduleSuspended)) continue;
    const groupId = Number(row.groupId);
    const list = changed.get(groupId) || [];
    list.push({ memberId: Number(row.id), enabled: state.isEnabled });
    changed.set(groupId, list);
  }
  let applied = 0;
  for (const [groupId, members] of changed) {
    try {
      const group = await db.getForwardGroupById(groupId) as any;
      if (!group) continue;
      const inputs = ((group.members || []) as any[]).map((member) => ({
        memberType: member.memberType,
        hostId: member.hostId,
        tunnelId: member.tunnelId,
        connectHost: member.connectHost,
        priority: member.priority,
        // 传用户的意思进去，实际开不开由写库那一步按时段算（memberSchedulePayload）。
        isEnabled: memberEnabledIntent(member),
        bandwidthMbps: member.bandwidthMbps,
        aggregationWeight: member.aggregationWeight,
      }));
      await db.replaceForwardGroupMembers(groupId, inputs, { scheduleAt: at });
      applied += 1;
      const summary = members.map((member) => `#${member.memberId} ${member.enabled ? "进入可用时段，已恢复" : "离开可用时段，已暂停"}`).join("；");
      appendPanelLog("info", `[ForwardGroup] member schedule group=${groupId}: ${summary}`);
      await db.recordForwardGroupEvent(groupId, members[0]?.memberId ?? null, "member-schedule", `按可用时段调整成员：${summary}`).catch(() => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendPanelLog("warn", `[ForwardGroup] member schedule failed group=${groupId}: ${message}`);
      await db.recordForwardGroupEvent(groupId, null, "member-schedule-failed", `按可用时段调整成员失败（下一分钟再试）：${message}`).catch(() => undefined);
    }
  }
  return { checked: rows.length, applied };
}
