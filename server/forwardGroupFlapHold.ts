import { quoteIdentifier } from "./dbCompat";
import { queryRaw, rawEpochToDate } from "./dbRuntime";

/*
  主备转发组的抖动抑制（P3）：和线路组在入口 Agent 上的规矩同一套（agent/failover_selection.go 的
  flapHoldLocked）—— 一小时内自动切了三次以上，下一次「切回 / 按优先级换」要多等：三次起 5 分钟，
  之后每多一次翻一倍，最多一小时。

  为什么要有：DNS 切换不像连接级调度，每切一次客户端要等 TTL 过期、已有连接全断；高优先级成员在
  「好一阵、坏一阵」时，每一次切走和切回各自都合规（都满足了观察时间），合起来却是解析来回漂。

  只压「切回」：当前成员不可用时的逃生不受限制（宁可多切一次也不能指着一台坏的）；人工操作
  （调顺序、设为首选、强制同步）不受限制，也不计数、不清零。
*/

export const FORWARD_GROUP_FLAP_WINDOW_MS = 60 * 60 * 1000;
export const FORWARD_GROUP_FLAP_SWITCHES = 3;
export const FORWARD_GROUP_FLAP_HOLD_BASE_MS = 5 * 60 * 1000;
export const FORWARD_GROUP_FLAP_HOLD_MAX_MS = 60 * 60 * 1000;

/** 自动切换写进 forward_group_events 的类型：计数从这里读，面板重启后不丢。 */
export const FORWARD_GROUP_AUTO_SWITCH_EVENT = "auto-switch";

/** 一小时内自动切了 count 次时，距上一次自动切换至少要隔多久才许再切回；没在抖是 0。 */
export function forwardGroupFlapHoldMs(count: number): number {
  const switches = Math.floor(Number(count) || 0);
  if (switches < FORWARD_GROUP_FLAP_SWITCHES) return 0;
  const exponent = Math.min(switches - FORWARD_GROUP_FLAP_SWITCHES, 16);
  return Math.min(FORWARD_GROUP_FLAP_HOLD_MAX_MS, FORWARD_GROUP_FLAP_HOLD_BASE_MS * (2 ** exponent));
}

export type ForwardGroupFlapHold = {
  /** 窗口内的自动切换次数。 */
  switches: number;
  holdMs: number;
  /** 压到什么时候（毫秒时间戳）；没压是 0。 */
  untilMs: number;
};

/** switchTimesMs：这个组最近的自动切换时刻（毫秒），顺序不限。 */
export function forwardGroupFlapHoldAt(switchTimesMs: readonly number[], nowMs: number): ForwardGroupFlapHold {
  const recent = switchTimesMs
    .map(Number)
    .filter((at) => Number.isFinite(at) && at > 0 && nowMs - at < FORWARD_GROUP_FLAP_WINDOW_MS);
  const holdMs = forwardGroupFlapHoldMs(recent.length);
  if (holdMs <= 0 || recent.length === 0) return { switches: recent.length, holdMs: 0, untilMs: 0 };
  // 时钟回拨时事件时间可能在「将来」，按现在算，免得压得比规定的还久。
  const last = Math.min(nowMs, Math.max(...recent));
  const untilMs = last + holdMs;
  return untilMs > nowMs ? { switches: recent.length, holdMs, untilMs } : { switches: recent.length, holdMs, untilMs: 0 };
}

/** 状态消息里的时长：整分钟。 */
export function forwardGroupFlapHoldLabel(holdMs: number): string {
  return `${Math.max(1, Math.round(holdMs / 60_000))} 分钟`;
}

/*
  读「这个组最近一小时的自动切换」（forward_group_events 里的 auto-switch），按成员分（入口组按成员算抖动抑制，
  主备组按整组算 —— 两处以前各写一份查询）。
  读失败时不能当成「没在抖」：那样一次数据库抖动就会把抖动抑制悄悄关掉。用上一次读到的（记日志）；这个进程
  还没读成功过的组只能按没有记录算。
*/
const lastSwitchTimesByGroup = new Map<number, Map<number, number[]>>();

export async function forwardGroupAutoSwitchTimesByMember(groupId: number, nowMs = Date.now()): Promise<Map<number, number[]>> {
  const id = Number(groupId);
  const sinceSeconds = Math.floor((nowMs - FORWARD_GROUP_FLAP_WINDOW_MS) / 1000);
  try {
    const rows = await queryRaw<{ memberId: unknown; createdAt: unknown }>(
      `SELECT ${quoteIdentifier("memberId")}, ${quoteIdentifier("createdAt")} FROM ${quoteIdentifier("forward_group_events")}
        WHERE ${quoteIdentifier("groupId")} = ? AND ${quoteIdentifier("type")} = ? AND ${quoteIdentifier("createdAt")} >= ?`,
      [id, FORWARD_GROUP_AUTO_SWITCH_EVENT, sinceSeconds],
    );
    const byMember = new Map<number, number[]>();
    for (const row of rows) {
      // 整组的切换（主备组）memberId 可能是空：记在 0 下面。
      const memberId = Math.max(0, Number(row.memberId || 0) || 0);
      const at = rawEpochToDate(row.createdAt)?.getTime() || 0;
      if (!(at > 0)) continue;
      const list = byMember.get(memberId);
      if (list) list.push(at);
      else byMember.set(memberId, [at]);
    }
    if (lastSwitchTimesByGroup.size >= 4096 && !lastSwitchTimesByGroup.has(id)) lastSwitchTimesByGroup.clear();
    lastSwitchTimesByGroup.set(id, byMember);
    return byMember;
  } catch (error) {
    console.warn(`[ForwardGroup] reading auto-switch events failed group=${id}; keeping the last known flap state: ${error instanceof Error ? error.message : String(error)}`);
    return lastSwitchTimesByGroup.get(id) ?? new Map();
  }
}

/** 整组的抖动抑制（主备组）：所有成员的自动切换合起来算。 */
export async function forwardGroupFlapHoldForGroup(groupId: number, nowMs = Date.now()) {
  const byMember = await forwardGroupAutoSwitchTimesByMember(groupId, nowMs);
  return forwardGroupFlapHoldAt(Array.from(byMember.values()).flat(), nowMs);
}

export function resetForwardGroupFlapStateForTests() {
  lastSwitchTimesByGroup.clear();
}

