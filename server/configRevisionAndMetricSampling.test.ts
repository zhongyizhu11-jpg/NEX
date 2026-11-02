import assert from "node:assert/strict";
import test from "node:test";
import { gapDownIntervals } from "./ops/statusAvailabilityLogic";
import { HOST_METRIC_SAMPLE_INTERVAL_MS } from "./repositories/metricsRepository";
import { runInDatabase } from "./testing/runInDatabase";

test("latestConfigRevision skips dispatch rows and reads through the (action, id) index", () => {
  runInDatabase(String.raw`
    const audit = await import(url("server/configAudit.ts"));
    assert.equal(await audit.latestConfigRevision(), 0);
    const insert = (action) => exec('INSERT INTO config_audit_events ("resourceType", "resourceId", action, source, "configHash") VALUES (?, 1, ?, ?, ?)', ["forward_rule", action, "test", "h"]);
    await insert("create");
    await insert("update");
    for (let i = 0; i < 50; i += 1) await insert("dispatch");
    const [{ id: updateId }] = await query("SELECT MAX(id) AS id FROM config_audit_events WHERE action = 'update'");
    assert.equal(await audit.latestConfigRevision(), Number(updateId));
    await insert("delete");
    for (let i = 0; i < 5; i += 1) await insert("dispatch");
    const [{ id: deleteId }] = await query("SELECT MAX(id) AS id FROM config_audit_events WHERE action = 'delete'");
    assert.equal(await audit.latestConfigRevision(), Number(deleteId));

    const plan = await query("EXPLAIN QUERY PLAN SELECT id FROM config_audit_events WHERE action = ? ORDER BY id DESC LIMIT 1", ["update"]);
    const detail = plan.map((row) => String(row.detail)).join(" | ");
    assert.match(detail, /idx_config_audit_events_action_id/, detail);
  `, { name: "config-revision", quiet: true });
});

test("the sampling interval stays far below the availability backfill gap threshold", () => {
  const step = HOST_METRIC_SAMPLE_INTERVAL_MS / 1000;
  // 一台一直在线、每次心跳都被采样到的主机：相邻两行最多隔一个采样间隔，回填不能算出断线。
  const samples = Array.from({ length: 200 }, (_, index) => 10_000 + index * step);
  assert.deepEqual(gapDownIntervals(samples, { until: samples[samples.length - 1] + 5, currentlyOnline: true }), []);
  // 老 Agent 60 秒一次心跳、新 Agent 5 分钟一次：采样不会让间隔变大。
  const fullHeartbeat = Array.from({ length: 20 }, (_, index) => 10_000 + index * 300);
  assert.deepEqual(gapDownIntervals(fullHeartbeat, { until: fullHeartbeat[19] + 5, currentlyOnline: true }), []);
});

test("sampled inserts write one row per host per window and always write when forced", () => {
  runInDatabase(String.raw`
    const metrics = await import(url("server/repositories/metricsRepository.ts"));
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    await exec("INSERT INTO hosts (id, name, ip, agentToken, userId) VALUES (5, 'a', '198.51.100.5', 'tok5', 1)");
    await exec("INSERT INTO hosts (id, name, ip, agentToken, userId) VALUES (6, 'b', '198.51.100.6', 'tok6', 1)");
    const count = async (hostId) => Number((await query("SELECT COUNT(*) AS n FROM host_metrics WHERE hostId = ?", [hostId]))[0].n);
    const t0 = 5_000_000;
    assert.equal(await metrics.insertHostMetricSampled({ hostId: 5, cpuUsage: 1 }, { now: t0 }), true);
    assert.equal(await metrics.insertHostMetricSampled({ hostId: 5, cpuUsage: 2 }, { now: t0 + 3_000 }), false);
    assert.equal(await metrics.insertHostMetricSampled({ hostId: 5, cpuUsage: 3 }, { now: t0 + 29_999 }), false);
    assert.equal(await metrics.insertHostMetricSampled({ hostId: 6, cpuUsage: 9 }, { now: t0 + 1_000 }), true, "每台主机各算各的");
    assert.equal(await metrics.insertHostMetricSampled({ hostId: 5, cpuUsage: 4 }, { now: t0 + 30_000 }), true);
    assert.equal(await metrics.insertHostMetricSampled({ hostId: 5, cpuUsage: 5 }, { now: t0 + 31_000, force: true }), true, "有人在看实时指标时每次都写");
    assert.equal(await count(5), 3);
    assert.equal(await count(6), 1);
    // 主机删掉后采样记录一起清掉，同 id 再来第一条立刻写
    metrics.forgetHostMetricSample(5);
    assert.equal(await metrics.insertHostMetricSampled({ hostId: 5, cpuUsage: 6 }, { now: t0 + 32_000 }), true);
    assert.equal(metrics.HOST_METRIC_SAMPLE_INTERVAL_MS, 30_000);
  `, { name: "host-metric-sampling", quiet: true });
});
