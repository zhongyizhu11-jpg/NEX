import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { isHostConsideredOnline } from "../../hostHeartbeatPolicy";
import { listPanelEvents, type PanelEvent } from "../../ops/panelEvents";
import { getHostNamesByIds } from "../../repositories/hostRepository";
import { getFiringLossAlerts, getFiringResourceAlerts } from "../../resourceAlertNotifier";
import { redactSupportValue } from "../../supportBundle";
import { faultEventsToCsv, summarizeFaultEvents, type FaultEventInput } from "../../../shared/faultBoard";
import { resourceAlertMetricLabel, type ResourceAlertMetric } from "../../../shared/resourceAlert";
import { APP_VERSION } from "../../../shared/versions";

/*
  trpc.ops.faultBoard.* —— 监控 › 故障：在线多少、最近告警多少、自动恢复了多少、现在还有什么在报，
  以及把这段时间的事件导出成 CSV / JSON（交给技术支持或 AI 分析）。只给管理员。

  事件按 id 倒序一页 500 条往回翻，最多翻 10 页（5000 条）：再多也看不过来，汇总里会标出「截断」。
*/

const MAX_PAGES = 10;
const PAGE_SIZE = 500;

async function eventsSince(sinceSeconds: number) {
  const all: PanelEvent[] = [];
  let beforeId: number | null = null;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await listPanelEvents({ sinceSeconds, beforeId, limit: PAGE_SIZE });
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return { events: all, truncated };
    beforeId = batch[batch.length - 1].id;
  }
  truncated = true;
  return { events: all, truncated };
}

async function withHostNames(events: PanelEvent[]): Promise<FaultEventInput[]> {
  const ids = [...new Set(events.map((event) => event.hostId).filter((id): id is number => !!id))];
  const names = ids.length > 0 ? await getHostNamesByIds(ids).catch(() => new Map<number, string>()) : new Map<number, string>();
  return events.map((event) => ({
    id: event.id,
    kind: event.kind,
    level: event.level,
    message: event.message,
    hostId: event.hostId,
    hostName: event.hostId ? names.get(event.hostId) || null : null,
    ruleId: event.ruleId,
    data: event.data,
    createdAt: event.createdAt,
  }));
}

const hoursSchema = z.number().int().min(1).max(24 * 7).default(24);

async function hostOverview() {
  const hosts = await db.getHostOptions() as any[];
  const offline = hosts
    .filter((host) => !isHostConsideredOnline(host))
    .map((host) => ({
      id: Number(host.id),
      name: String(host.name || `#${host.id}`),
      lastHeartbeat: host.lastHeartbeat ? new Date(host.lastHeartbeat) : null,
    }))
    .sort((a, b) => (b.lastHeartbeat?.getTime() ?? 0) - (a.lastHeartbeat?.getTime() ?? 0));
  return { total: hosts.length, online: hosts.length - offline.length, offline: offline.slice(0, 50), offlineCount: offline.length };
}

async function firingNow() {
  const resource = getFiringResourceAlerts();
  const loss = getFiringLossAlerts();
  const hostIds = [...new Set([...resource.map((item) => item.hostId), ...loss.map((item) => item.hostId)])];
  const names = hostIds.length > 0 ? await getHostNamesByIds(hostIds).catch(() => new Map<number, string>()) : new Map<number, string>();
  return [
    ...resource.map((item) => ({
      kind: "resource" as const,
      hostId: item.hostId,
      hostName: names.get(item.hostId) || null,
      label: `${resourceAlertMetricLabel(item.metric as ResourceAlertMetric)}超过阈值（最高 ${Math.round(item.peak)}%）`,
      since: item.firedAt ? new Date(item.firedAt) : null,
    })),
    ...loss.map((item) => ({
      kind: "loss" as const,
      hostId: item.hostId,
      hostName: names.get(item.hostId) || null,
      label: `隧道 #${item.tunnelId} 丢包（最高 ${item.peak}%）`,
      since: item.firedAt ? new Date(item.firedAt) : null,
    })),
  ].sort((a, b) => (a.since?.getTime() ?? 0) - (b.since?.getTime() ?? 0));
}

export const faultBoardRouter = router({
  summary: adminProcedure
    .input(z.object({ hours: hoursSchema }).optional())
    .query(async ({ input }) => {
      const hours = input?.hours ?? 24;
      const nowMs = Date.now();
      const [{ events, truncated }, hosts, firing] = await Promise.all([
        eventsSince(Math.floor(nowMs / 1000) - hours * 3600),
        hostOverview(),
        firingNow(),
      ]);
      const named = await withHostNames(events);
      const summary = summarizeFaultEvents(named, { nowMs, hours });
      const recent = named
        .filter((event) => event.level === "warn" || event.level === "crit")
        .slice(0, 20)
        .map(({ data: _data, ...rest }) => rest);
      return { hours, generatedAt: new Date(nowMs), truncated, hosts, firing, summary, recent };
    }),

  /** 导出：CSV 只有事件；JSON 带上汇总、在线情况和正在告警的项。返回文本，前端存成文件。 */
  export: adminProcedure
    .input(z.object({ hours: hoursSchema, format: z.enum(["csv", "json"]) }))
    .mutation(async ({ input }) => {
      const nowMs = Date.now();
      const { events, truncated } = await eventsSince(Math.floor(nowMs / 1000) - input.hours * 3600);
      const named = await withHostNames(events);
      const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      if (input.format === "csv") {
        return { filename: `nex-faults-${stamp}.csv`, mime: "text/csv", content: faultEventsToCsv(named) };
      }
      const [hosts, firing] = await Promise.all([hostOverview(), firingNow()]);
      const report = redactSupportValue({
        kind: "nex-fault-report",
        panelVersion: APP_VERSION,
        generatedAt: new Date(nowMs).toISOString(),
        hours: input.hours,
        truncated,
        hosts,
        firing,
        summary: summarizeFaultEvents(named, { nowMs, hours: input.hours }),
        events: named,
      });
      return { filename: `nex-faults-${stamp}.json`, mime: "application/json", content: JSON.stringify(report, null, 2) };
    }),
});
