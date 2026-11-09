import assert from "node:assert/strict";
import test from "node:test";

import { recordRouteAgentStats, resetRouteStatsForTest } from "./routeGroupStats";
import {
  ROUTE_DRILL_HINT_REASON,
  clampRouteDrillSeconds,
  endRouteDrill,
  hasRouteDrillOnHost,
  noteRouteDrillAgentEvent,
  noteRouteDrillAgentStats,
  routeDrillHints,
  routeDrillInternals,
  routeDrillReportReason,
  routeDrillView,
  startRouteDrill,
  stopRouteDrillForRule,
  withRouteDrillHints,
  type RouteDrillReport,
} from "./routeDrill";
import { describeRouteDrillReason, describeRouteIssue, describeRouteReason } from "../shared/routeGroupText";
import { summarizeRouteSwitches } from "../shared/routeSwitchSummary";

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
let now = T0;
const paths = [
  { key: "a", name: "", hops: [21], dest: { ip: "10.0.0.31", port: 9000 }, weight: 1, probe: null, dial: { ip: "10.0.0.21", port: 20001 }, issue: null },
  { key: "b", name: "", hops: [22], dest: { ip: "10.0.0.31", port: 9000 }, weight: 1, probe: null, dial: { ip: "10.0.0.22", port: 20002 }, issue: null },
] as any[];
const statusPaths = [
  { key: "a", lineKey: "a", down: false, paused: false, healthy: true },
  { key: "b", lineKey: "b", down: false, paused: false, healthy: true },
];

function stats(activeIndex: number, activeSince: number, connections: [number, number]) {
  recordRouteAgentStats({
    hostId: 11,
    isAllowed: () => true,
    nowMs: now,
    reports: [{
      ruleId: 501, sourcePort: 18080, strategy: "fallback", activeIndex, activeSince, prewarmIndex: -1,
      targets: [
        { index: 0, healthy: activeIndex === 0 || true, score: 90, latencyMs: 20, lossPct: 0, jitterMs: 1, availabilityPct: 100, connections: connections[0], samples: 10 },
        { index: 1, healthy: true, score: 80, latencyMs: 30, lossPct: 0, jitterMs: 1, availabilityPct: 100, connections: connections[1], samples: 10 },
      ],
    }],
  });
}

test.beforeEach(() => {
  now = T0;
  routeDrillInternals.setClock(() => now);
  routeDrillInternals.reset();
  resetRouteStatsForTest();
});

test.after(() => {
  routeDrillInternals.setClock(null);
  routeDrillInternals.reset();
});

test("秒数夹在 10–600 之间，认不出来就是默认 60", () => {
  assert.equal(clampRouteDrillSeconds(3), 10);
  assert.equal(clampRouteDrillSeconds(9999), 600);
  assert.equal(clampRouteDrillSeconds("x"), 60);
});

test("开始演练：那条线路给 Agent 的提示是 down，别的提示照留；到点撤掉；报告里有几秒切完、几秒切回、连接留着", async () => {
  // 演练前走主线路 a，上面挂着 3 个连接
  stats(0, T0 - 60_000, [3, 0]);
  const result = await startRouteDrill({ ruleId: 500, lineKey: "a", lineLabel: "主线路", seconds: 30, subjects: [{ rule: { id: 501, hostId: 11 }, paths, entryHostName: null, schedulerHostIds: [11] }], statusPaths });
  assert.equal(result.started, 1);
  assert.equal(hasRouteDrillOnHost(11), true);
  const hints = routeDrillHints(501, now);
  assert.deepEqual(Array.from(hints.keys()), ["a"]);
  assert.equal(hints.get("a")?.reason, ROUTE_DRILL_HINT_REASON);
  const merged = withRouteDrillHints(501, new Map([["b", { down: true as const, hopIndex: 0, reason: "relay down: X → 落地" }]]), now);
  assert.equal(merged.get("b")?.reason, "relay down: X → 落地");
  assert.equal(merged.get("a")?.down, true);
  // Agent 2.1 秒后报了切换 a → b
  now = T0 + 2_100;
  noteRouteDrillAgentEvent(501, { kind: "switch", fromIndex: 0, toIndex: 1, atMs: now });
  const live = routeDrillView([501], now);
  assert.equal(live?.active?.phase, "down");
  assert.equal(live?.active?.switchMs, 2_100);
  assert.equal(live?.active?.switchedToLabel, "备用 1");
  // 切完之后 a 上的连接还留着（平滑切换）
  now = T0 + 5_000;
  stats(1, T0 + 2_100, [3, 2]);
  noteRouteDrillAgentStats({ ruleId: 501, activeIndex: 1, activeSince: T0 + 2_100, reportedAt: now, targets: [{ index: 0, connections: 3 } as any, { index: 1, connections: 2 } as any] });
  // 到点：提示撤掉，等切回
  now = T0 + 30_000;
  await routeDrillInternals.fireTimer(501);
  assert.equal(routeDrillHints(501, now).size, 0, "撤掉之后不再标 down");
  assert.equal(routeDrillView([501], now)?.active?.phase, "restoring");
  // 3.4 秒后切回 a
  now = T0 + 33_400;
  noteRouteDrillAgentEvent(501, { kind: "switch", fromIndex: 1, toIndex: 0, atMs: now });
  const view = routeDrillView([501], now);
  assert.equal(view?.active, null);
  assert.equal(view?.reports.length, 1);
  const report = view!.reports[0];
  assert.equal(report.switched, true);
  assert.equal(report.switchMs, 2_100);
  assert.equal(report.restored, true);
  assert.equal(report.restoreMs, 3_400);
  assert.equal(report.connectionsBefore, 3);
  assert.equal(report.connectionsAfter, 3);
  assert.equal(report.wasActive, true);
  assert.equal(hasRouteDrillOnHost(11), false);
  // 写进切换记录那一句翻成人话
  const reason = routeDrillReportReason(report);
  assert.match(reason, /^drill: done; seconds=30; was=active; switched=2100; to=备用 1; restored=3400; conns=3\/3$/);
  assert.equal(describeRouteDrillReason(reason), "演练结束（当成挂了 30 秒）：2.1 秒切到 备用 1，恢复后 3.4 秒切回，切换时它上面的 3 个连接都留着");
  assert.equal(describeRouteReason("drill: start; seconds=30"), "演练开始：把它当成挂了 30 秒");
});

test("事件丢了也能从评分快照看出切没切；快速切换把连接断了也写进报告", async () => {
  stats(0, T0 - 60_000, [4, 0]);
  await startRouteDrill({ ruleId: 500, lineKey: "a", lineLabel: "主线路", seconds: 20, subjects: [{ rule: { id: 501, hostId: 11 }, paths, entryHostName: null, schedulerHostIds: [11] }], statusPaths });
  now = T0 + 4_000;
  noteRouteDrillAgentStats({ ruleId: 501, activeIndex: 1, activeSince: T0 + 1_500, reportedAt: now, targets: [{ index: 0, connections: 0 } as any, { index: 1, connections: 4 } as any] });
  assert.equal(routeDrillView([501], now)?.active?.switchMs, 1_500);
  now = T0 + 20_000;
  await routeDrillInternals.fireTimer(501);
  // 一直没切回：等够了按没切回收尾
  now = T0 + 20_000 + 90_000;
  await routeDrillInternals.fireTimer(501);
  const report = routeDrillView([501], now)!.reports[0];
  assert.equal(report.restored, false);
  assert.equal(report.connectionsAfter, 0);
  assert.equal(describeRouteDrillReason(routeDrillReportReason(report)), "演练结束（当成挂了 20 秒）：1.5 秒切到 备用 1，恢复后没切回来，切换时它上面的 4 个连接断了 4 个");
});

test("演练前就没走这条：撤掉提示立刻收尾，报告只说它被标成异常", async () => {
  stats(1, T0 - 60_000, [0, 2]);
  await startRouteDrill({ ruleId: 500, lineKey: "a", lineLabel: "主线路", seconds: 15, subjects: [{ rule: { id: 501, hostId: 11 }, paths, entryHostName: null, schedulerHostIds: [11] }], statusPaths });
  now = T0 + 15_000;
  await routeDrillInternals.fireTimer(501);
  const view = routeDrillView([501], now);
  assert.equal(view?.active, null);
  assert.equal(view?.reports[0].wasActive, false);
  assert.equal(view?.reports[0].restored, null);
  assert.equal(describeRouteDrillReason(routeDrillReportReason(view!.reports[0])), "演练结束（当成挂了 15 秒）：演练前就没走这条，只看它被标成异常");
});

test("提前结束算提前；别的线路都不通时不让演练；正在演练时不能再开", async () => {
  stats(0, T0 - 60_000, [1, 0]);
  await assert.rejects(
    startRouteDrill({ ruleId: 500, lineKey: "a", lineLabel: "主线路", seconds: 30, subjects: [{ rule: { id: 501, hostId: 11 }, paths, entryHostName: null, schedulerHostIds: [11] }], statusPaths: [statusPaths[0], { ...statusPaths[1], down: true }] }),
    /演练会真的断流/,
  );
  await startRouteDrill({ ruleId: 500, lineKey: "a", lineLabel: "主线路", seconds: 30, subjects: [{ rule: { id: 501, hostId: 11 }, paths, entryHostName: null, schedulerHostIds: [11] }], statusPaths });
  await assert.rejects(
    startRouteDrill({ ruleId: 500, lineKey: "b", lineLabel: "备用 1", seconds: 30, subjects: [{ rule: { id: 501, hostId: 11 }, paths, entryHostName: null, schedulerHostIds: [11] }], statusPaths }),
    /正在演练/,
  );
  now = T0 + 5_000;
  assert.equal(await stopRouteDrillForRule(500), 1);
  assert.equal(routeDrillView([501], now)?.active?.phase, "restoring");
  assert.equal(await endRouteDrill(501, { early: true }), false, "已经在等切回了，不重复收");
  now = T0 + 6_000;
  noteRouteDrillAgentEvent(501, { kind: "switch", fromIndex: 1, toIndex: 0, atMs: now });
  const report = routeDrillView([501], now)!.reports[0];
  assert.equal(report.stoppedEarly, true);
  assert.equal(report.switched, false);
  assert.match(describeRouteDrillReason(routeDrillReportReason(report)), /当成挂了之后一直没切走.*（提前结束）$/);
});

test("演练期间的切换打了标：界面注明是演练，24h 切换次数、来回漂都不数它；提示原因翻成「演练中」", () => {
  assert.equal(describeRouteReason("drill; relay down: drill"), "演练中：当成挂了（演练）");
  assert.equal(describeRouteReason("relay down: drill"), "演练中：当成挂了");
  assert.equal(describeRouteIssue("drill"), "演练中：当成挂了");
  const summary = summarizeRouteSwitches([
    { kind: "switch", at: T0 - 1_000, reason: "drill; relay down: drill" },
    { kind: "switch", at: T0 - 2_000, reason: "drill; failback" },
    { kind: "switch", at: T0 - 3_000_000, reason: "health check" },
  ], T0);
  assert.equal(summary.count24h, 1);
  assert.equal(summary.flapping, false);
});

test("报告留一小时；塞进去的报告按结束时间倒序", () => {
  const report = (subjectRuleId: number, finishedAt: number): Omit<RouteDrillReport, "reason"> => ({
    ruleId: 500, subjectRuleId, entryHostId: 11, entryHostName: null, lineKey: "a", lineLabel: "主线路", seconds: 30,
    startedAt: finishedAt - 40_000, endedAt: finishedAt - 10_000, finishedAt, wasActive: true, activeBeforeLabel: "主线路",
    switched: true, switchMs: 2_000, switchedToLabel: "备用 1", restored: true, restoreMs: 3_000, connectionsBefore: null, connectionsAfter: null, events: 2, stoppedEarly: false,
  });
  routeDrillInternals.seedReport(report(501, T0 - 10_000));
  routeDrillInternals.seedReport(report(502, T0 - 5_000));
  routeDrillInternals.seedReport(report(503, T0 - 2 * 3_600_000));
  const view = routeDrillView([501, 502, 503], T0);
  assert.deepEqual(view?.reports.map((item) => item.subjectRuleId), [502, 501]);
  assert.equal(routeDrillView([503], T0), null);
});
