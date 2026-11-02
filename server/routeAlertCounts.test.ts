import assert from "node:assert/strict";
import test from "node:test";
import { summarizeFaultEvents, tallyRouteFaults, type FaultEventInput } from "../shared/faultBoard";
import { filterRouteEventsByScope } from "./ops/routeFaultCounts";
import { runInDatabase } from "./testing/runInDatabase";

const now = Date.UTC(2026, 0, 2, 12, 0, 0);
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);

test("the fault board route category and the line workspace tally count the same events", () => {
  const events: FaultEventInput[] = [
    { id: 1, kind: "route.switched", level: "info", message: "切线", hostId: 1, ruleId: 7, createdAt: at(5) },
    { id: 2, kind: "route.unhealthy", level: "warn", message: "异常", hostId: 1, ruleId: 7, createdAt: at(10) },
    { id: 3, kind: "route.precheck_failed", level: "warn", message: "预检没过", hostId: 1, ruleId: 8, createdAt: at(20) },
    { id: 4, kind: "route.recovered", level: "info", message: "恢复", hostId: 1, ruleId: 7, data: { durationSeconds: 60 }, createdAt: at(8) },
    { id: 5, kind: "host.offline", level: "warn", message: "断线", hostId: 2, createdAt: at(30) },
    { id: 6, kind: "host.online", level: "info", message: "恢复", hostId: 2, data: { outageSeconds: 30 }, createdAt: at(29) },
    { id: 7, kind: "route.unhealthy", level: "warn", message: "太早", hostId: 1, ruleId: 7, createdAt: at(60 * 25) },
  ];
  const summary = summarizeFaultEvents(events, { nowMs: now, hours: 24 });
  const tally = tallyRouteFaults(events, { nowMs: now, hours: 24 });
  const routeCategory = summary.byCategory.find((item) => item.key === "route")?.count ?? 0;
  assert.equal(tally.alerts, routeCategory);
  assert.equal(tally.alerts, 3);
  assert.equal(tally.recovered, 1);
  // 看板总恢复数还包括主机恢复，线路只算线路自己的
  assert.equal(summary.recovered, 2);
});

test("tenants only see route events of their own rules and their own forward groups", () => {
  const events = [
    { ruleId: 7, userId: 2 },
    { ruleId: 9, userId: 3 },
    { ruleId: null, userId: 2 },
    { ruleId: null, userId: 3 },
  ];
  assert.equal(filterRouteEventsByScope(events, { all: true }).length, 4);
  assert.deepEqual(filterRouteEventsByScope(events, { ruleIds: [7], userId: 2 }), [events[0], events[2]]);
});

test("line workspace alert counts match the fault board on a real database", () => {
  runInDatabase(String.raw`
    const events = await import(url("server/ops/panelEvents.ts"));
    const { faultBoardRouter } = await import(url("server/routers/ops/faultBoard.ts"));
    const { lineWorkspace } = await import(url("server/routeLineViews.ts"));
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'h', 'user')");
    const nowSeconds = Math.floor(Date.now() / 1000);
    await events.recordPanelEvent({ kind: "route.switched", level: "info", ruleId: 5, userId: 1, message: "切线", at: nowSeconds - 600 });
    await events.recordPanelEvent({ kind: "route.unhealthy", level: "warn", ruleId: 5, userId: 1, message: "异常", at: nowSeconds - 500 });
    await events.recordPanelEvent({ kind: "route.recovered", level: "info", ruleId: 5, userId: 1, message: "恢复", data: { durationSeconds: 100 }, at: nowSeconds - 400 });
    await events.recordPanelEvent({ kind: "route.group_switched", level: "info", userId: 2, message: "转发组切换", at: nowSeconds - 300 });
    await events.recordPanelEvent({ kind: "host.offline", level: "warn", hostId: 3, message: "断线", at: nowSeconds - 200 });

    const caller = faultBoardRouter.createCaller({
      req: { headers: {}, ip: "127.0.0.1", socket: {} }, res: { cookie() {}, clearCookie() {} },
      user: { id: 1, role: "admin", username: "admin" }, authSession: null, authFailureReason: null,
    });
    const board = await caller.summary({ hours: 24 });
    const routeCategory = board.summary.byCategory.find((item) => item.key === "route")?.count ?? 0;
    const adminView = await lineWorkspace({ id: 1, role: "admin" }, 24);
    assert.equal(routeCategory, 3);
    assert.equal(adminView.alerts, routeCategory);
    assert.equal(adminView.recovered, 1);
    assert.equal(board.summary.alerts, 4);

    // 普通用户只数自己的（这里只有自己转发组的那次切换）
    const tenantView = await lineWorkspace({ id: 2, role: "user" }, 24);
    assert.equal(tenantView.alerts, 1);
    assert.equal(tenantView.recovered, 0);
    assert.deepEqual(Object.keys(adminView).sort(), ["alerts", "hosts", "hours", "lines", "recent", "recovered"]);
  `, { name: "route-alert-counts", quiet: true });
});
