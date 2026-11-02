import { tallyRouteFaults } from "../../shared/faultBoard";
import { listPanelEvents, type PanelEvent } from "./panelEvents";

/*
  线路告警数的唯一来源：故障看板（server/routers/ops/faultBoard.ts）和线路工作台
  （server/routeLineViews.ts）都从事件时间线（panel_events）取同一批事件，按
  shared/faultBoard.ts 的同一个口径数，免得两处各查一张表、数字对不上。
*/

const MAX_PAGES = 10;
const PAGE_SIZE = 500;

/** 按 id 倒序一页一页往回翻，最多 MAX_PAGES 页；翻满了 truncated = true。 */
export async function panelEventsSince(sinceSeconds: number, options: { kindPrefix?: string | null } = {}) {
  const all: PanelEvent[] = [];
  let beforeId: number | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await listPanelEvents({ sinceSeconds, beforeId, limit: PAGE_SIZE, kindPrefix: options.kindPrefix ?? null });
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return { events: all, truncated: false };
    beforeId = batch[batch.length - 1].id;
  }
  return { events: all, truncated: true };
}

/** 谁能看到哪些线路事件：管理员看全部；普通用户只看自己规则的、和自己名下（无规则的，如转发组）的。 */
export type RouteFaultScope = { all: true } | { all?: false; ruleIds: Iterable<number>; userId: number };

export function filterRouteEventsByScope<T extends Pick<PanelEvent, "ruleId" | "userId">>(events: readonly T[], scope: RouteFaultScope): T[] {
  if (scope.all) return [...events];
  const ruleIds = new Set(Array.from(scope.ruleIds, Number));
  return events.filter((event) => (event.ruleId ? ruleIds.has(event.ruleId) : event.userId === scope.userId));
}

export async function routeFaultCounts(input: { hours: number; nowMs?: number; scope: RouteFaultScope }) {
  const nowMs = input.nowMs ?? Date.now();
  const sinceSeconds = Math.floor(nowMs / 1000) - Math.max(1, Math.floor(input.hours)) * 3600;
  const { events } = await panelEventsSince(sinceSeconds, { kindPrefix: "route." });
  return tallyRouteFaults(filterRouteEventsByScope(events, input.scope), { nowMs, hours: input.hours });
}
