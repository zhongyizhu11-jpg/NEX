import assert from "node:assert/strict";
import test from "node:test";

import { faultCategoryOf, faultEventsToCsv, isRecoveryEvent, summarizeFaultEvents, type FaultEventInput } from "./faultBoard";

const now = Date.UTC(2026, 9, 17, 12, 0, 0);
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);

const events: FaultEventInput[] = [
  { id: 1, kind: "host.offline", level: "warn", message: "港-1 断线", hostId: 1, hostName: "港-1", createdAt: at(300) },
  { id: 2, kind: "host.online", level: "info", message: "港-1 断线 5 分钟后恢复", hostId: 1, data: { outageSeconds: 300 }, createdAt: at(295) },
  { id: 3, kind: "host.online", level: "info", message: "新机器上线", hostId: 2, createdAt: at(200) },
  { id: 4, kind: "host.oom_killed", level: "crit", message: "OOM", hostId: 1, hostName: "港-1", createdAt: at(100) },
  { id: 5, kind: "host.resource_high", level: "warn", message: "CPU", hostId: 2, hostName: "日-1", createdAt: at(50) },
  { id: 6, kind: "host.resource_recovered", level: "info", message: "CPU 恢复", hostId: 2, data: { durationSeconds: 100 }, createdAt: at(40) },
  { id: 7, kind: "account.login_failed", level: "warn", message: "登录失败", hostId: null, createdAt: at(30) },
  { id: 8, kind: "rule.error", level: "warn", message: "规则出错", hostId: 1, ruleId: 9, createdAt: at(20) },
  { id: 9, kind: "host.offline", level: "warn", message: "太早", hostId: 3, createdAt: at(25 * 60) },
];

test("分类：登录、工单、用户事件不算故障；首次上线不算恢复", () => {
  assert.equal(faultCategoryOf("account.login_failed", "warn"), null);
  assert.equal(faultCategoryOf("host.oom_killed", "crit"), "oom");
  assert.equal(faultCategoryOf("host.config_refused", "warn"), "other");
  assert.equal(faultCategoryOf("host.agent_restarted", "info"), null);
  assert.equal(isRecoveryEvent(events[1]), true);
  assert.equal(isRecoveryEvent(events[2]), false);
});

test("24 小时汇总", () => {
  const summary = summarizeFaultEvents(events, { nowMs: now, hours: 24 });
  assert.equal(summary.alerts, 4);
  assert.equal(summary.critical, 1);
  assert.deepEqual(summary.byCategory.map((item) => [item.key, item.count]), [["offline", 1], ["resource", 1], ["oom", 1], ["rule", 1]]);
  assert.equal(summary.recovered, 2);
  assert.equal(summary.avgRecoverySeconds, 200);
  assert.deepEqual(summary.topHosts.map((item) => [item.hostId, item.count]), [[1, 3], [2, 1]]);
  assert.equal(summary.hourly.length, 24);
  assert.equal(summary.hourly.reduce((a, b) => a + b, 0), 4);
  assert.equal(summary.hourly[23], 2); // 50 分钟前和 20 分钟前那两条都在最后一小时
});

test("CSV：带表头和 BOM，逗号引号转义，防公式注入", () => {
  const csv = faultEventsToCsv([
    { id: 1, kind: "rule.error", level: "warn", message: 'bind: "443", in use', hostId: 1, hostName: "=cmd", createdAt: now },
  ]);
  const lines = csv.replace(/^﻿/, "").trim().split("\n");
  assert.equal(lines[0], "time,level,kind,category,hostId,hostName,ruleId,message");
  assert.equal(lines[1], `2026-10-17T12:00:00.000Z,warn,rule.error,rule,1,'=cmd,,"bind: ""443"", in use"`);
  assert.ok(csv.startsWith("﻿"));
});

test("线路组：route.unhealthy 算线路告警，route.recovered 算恢复（带异常时长）", () => {
  assert.equal(faultCategoryOf("route.unhealthy", "warn"), "route");
  assert.equal(faultCategoryOf("route.recovered", "info"), null);
  const unhealthy: FaultEventInput = { id: 20, kind: "route.unhealthy", level: "warn", message: "线路 B 异常", hostId: 4, ruleId: 7, createdAt: at(30) };
  const recovered: FaultEventInput = { id: 21, kind: "route.recovered", level: "info", message: "线路 B 恢复", hostId: 4, ruleId: 7, data: { durationSeconds: 120 }, createdAt: at(28) };
  const untimed: FaultEventInput = { id: 22, kind: "route.recovered", level: "info", message: "线路 C 恢复", hostId: 4, ruleId: 7, createdAt: at(10) };
  assert.equal(isRecoveryEvent(recovered), true);
  assert.equal(isRecoveryEvent(untimed), true);
  assert.equal(isRecoveryEvent(unhealthy), false);
  const summary = summarizeFaultEvents([unhealthy, recovered, untimed], { nowMs: now, hours: 24 });
  assert.equal(summary.alerts, 1);
  assert.deepEqual(summary.byCategory.map((item) => [item.key, item.count]), [["route", 1]]);
  assert.equal(summary.recovered, 2);
  assert.equal(summary.avgRecoverySeconds, 120);
  const csv = faultEventsToCsv([unhealthy, recovered]).replace(/^﻿/, "").trim().split("\n");
  assert.match(csv[1], /,warn,route\.unhealthy,route,/);
  assert.match(csv[2], /,info,route\.recovered,recovered,/);
});
