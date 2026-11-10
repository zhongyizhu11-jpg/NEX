import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  流量异常检测接上真库（sqlite）：基线从 traffic_stat_buckets 来、事件写进 panel_events、临时限速落
  traffic_anomaly_throttles。实时速率、在线 IP、通知、推 Agent 都换成假的，时间由测试一分钟一分钟往前推。
*/
test("流量异常：老规则突增会报、新规则不判、自动限速加了会撤、不碰手动限速、重启后能收回", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-traffic-anomaly-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const anomaly = await import(url("server/ops/trafficAnomaly.ts"));
      const throttles = await import(url("server/ops/trafficAnomalyThrottles.ts"));
      const { trafficAnomalyRouter } = await import(url("server/routers/ops/trafficAnomaly.ts"));

      const MIN = 60_000;
      const base = Math.floor(Date.now() / 1_800_000) * 1_800_000;
      const baseSec = Math.floor(base / 1000);
      const exec = runtime.executeRaw;
      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
      for (const [id, name] of [[2, 'alice'], [3, 'bob'], [4, 'carol']]) {
        await exec("INSERT INTO users (id, username, name, password, role, createdAt) VALUES (?, ?, ?, 'h', 'user', ?)", [id, name, name, baseSec - 30 * 86400]);
      }
      await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (1, '港-1', '203.0.113.1', 'slave', 'tok1', 1)");
      const rule = (id, userId, name, createdAt, rateLimitMbps = 0) => exec(
        "INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, userId, createdAt, rateLimitMbps) VALUES (?, 1, ?, ?, '127.0.0.1', 80, ?, ?, ?)",
        [id, name, 10000 + id, userId, createdAt, rateLimitMbps],
      );
      await rule(10, 2, "香港入口", baseSec - 10 * 86400);
      await rule(11, 4, "刚建的", baseSec - 2 * 3600);
      await rule(12, 3, "手动限 20", baseSec - 10 * 86400, 20);
      await rule(13, 3, "手动限 500", baseSec - 10 * 86400, 500);
      // 老规则过去 48 小时一直稳定在 10 Mbps（较大的一向）。
      const bytes10Mbps = 10 * 1_000_000 / 8 * 1800;
      for (const ruleId of [10, 12, 13]) {
        const userId = ruleId === 10 ? 2 : 3;
        for (let slot = baseSec - 48 * 3600; slot < baseSec; slot += 1800) {
          await exec(
            "INSERT INTO traffic_stat_buckets (bucketStart, bucketMinutes, userId, ruleId, hostId, bytesIn, bytesOut, connections) VALUES (?, 30, ?, ?, 1, ?, ?, 0)",
            [slot, userId, ruleId, Math.round(bytes10Mbps / 4), Math.round(bytes10Mbps)],
          );
        }
      }

      const mbps = (value) => value * 1_000_000 / 8;
      const rates = new Map();
      let online = [];
      const refreshed = [];
      const alerts = [];
      anomaly.setTrafficAnomalyDepsForTest({
        liveRates: () => new Map(rates),
        onlineRows: () => online,
        refreshRule: async (ruleId, reason) => { refreshed.push([ruleId, reason]); },
        sendAlert: async (message) => { alerts.push(message); },
      });
      const events = async (kind) => runtime.queryRaw("SELECT * FROM panel_events WHERE kind = ? ORDER BY id", [kind]);
      const throttleRows = async () => (await runtime.queryRaw("SELECT ruleId, mbps FROM traffic_anomaly_throttles ORDER BY ruleId")).map((row) => [Number(row.ruleId), Number(row.mbps)]);
      const tick = async (minute) => anomaly.runTrafficAnomalyTick(base + minute * MIN);

      // 关着的时候什么都不做。
      rates.set(10, { inBps: 0, outBps: mbps(200) });
      for (let m = 0; m < 12; m += 1) await tick(m);
      assert.equal((await events("rule.traffic_surge")).length, 0, "默认关着");

      await anomaly.saveTrafficAnomalyConfig({ enabled: true, sensitivity: "normal", autoThrottle: true, throttleMinutes: 30 });
      anomaly.resetTrafficAnomalyStateForTest();
      rates.set(11, { inBps: 0, outBps: mbps(500) });
      rates.set(12, { inBps: mbps(200), outBps: 0 });
      rates.set(13, { inBps: 0, outBps: mbps(200) });
      online = [
        { hostId: 1, port: 10010, ruleId: 10, inboundId: 0, userId: 2, ip: "198.51.100.7", conns: 600, since: baseSec },
        { hostId: 2, port: 10010, ruleId: 10, inboundId: 0, userId: 2, ip: "198.51.100.7", conns: 300, since: baseSec },
        { hostId: 1, port: 10010, ruleId: 10, inboundId: 0, userId: 2, ip: "198.51.100.8", conns: 20, since: baseSec },
      ];

      // 第 0–8 分钟：还不够持续 10 分钟，不报。
      for (let m = 0; m < 9; m += 1) await tick(m);
      assert.equal((await events("rule.traffic_surge")).length, 0, "持续时间没到不报");
      for (let m = 9; m <= 11; m += 1) await tick(m);

      const surges = await events("rule.traffic_surge");
      assert.deepEqual(surges.map((row) => Number(row.ruleId)).sort(), [10, 12, 13], "新规则 11 没有基线，不判");
      const surge10 = surges.find((row) => Number(row.ruleId) === 10);
      assert.match(surge10.message, /香港入口.*200 Mbps.*平时约 10 Mbps.*已自动限速到 50 Mbps/);
      const data10 = JSON.parse(surge10.dataJson);
      assert.equal(data10.baselineMbps, 10);
      assert.equal(data10.thresholdMbps, 50);
      assert.match(surges.find((row) => Number(row.ruleId) === 12).message, /更严的手动限速（20 Mbps），没有再加/);
      assert.deepEqual(await throttleRows(), [[10, 50], [13, 50]], "手动限 20 的那条不加");
      assert.ok(refreshed.some(([id]) => id === 10) && refreshed.some(([id]) => id === 13), "加限速后推 Agent 重算");
      assert.ok(!refreshed.some(([id]) => id === 12));
      // 下发：手动 500 叠上临时 50 → 50；手动的数原样在库里。
      assert.equal(throttles.anomalyAwareRuleMbps(13, 500, base + 12 * MIN), 50);
      assert.equal(throttles.anomalyAwareRuleMbps(12, 20, base + 12 * MIN), 20);
      assert.equal(Number((await runtime.queryRaw("SELECT rateLimitMbps FROM forward_rules WHERE id = 13"))[0].rateLimitMbps), 500);
      const userSurges = await events("user.traffic_surge");
      assert.ok(userSurges.some((row) => Number(row.userId) === 2), "用户层面也报");
      // 规则 11 自己太新不判；但它的主人 carol 是 30 天前的老用户、三天来一点流量都没有，突然 500 Mbps：用户这一级要报。
      assert.ok(userSurges.some((row) => Number(row.userId) === 4));
      const ipSurges = await events("rule.ip_conn_surge");
      assert.equal(ipSurges.length, 1, "两台入口机加起来 900 个连接，超过 800");
      assert.match(ipSurges[0].message, /198\.51\.100\.7.*900 个连接/);
      assert.ok(alerts.length >= 5, "每条异常都发了管理员通知");

      // 规则卡上看得到。
      const decorated = await throttles.withAnomalyThrottles([{ id: 13 }, { id: 99, forwardGroupRuleId: 13 }, { id: 12 }], base + 12 * MIN);
      assert.equal(decorated[0].anomalyThrottle.mbps, 50);
      assert.equal(decorated[1].anomalyThrottle.mbps, 50, "转发组成员按模板算");
      assert.equal(decorated[2].anomalyThrottle, undefined);

      // 第 12–23 分钟：规则 10 回落到 1 Mbps、那个 IP 走了 → 恢复，临时限速撤掉。
      rates.set(10, { inBps: 0, outBps: mbps(1) });
      online = [];
      for (let m = 12; m <= 23; m += 1) await tick(m);
      const recovered = await events("rule.traffic_surge.recovered");
      assert.deepEqual(recovered.map((row) => Number(row.ruleId)), [10]);
      assert.match(recovered[0].message, /回落到 1 Mbps.*最高 200 Mbps.*临时限速已撤掉/);
      assert.deepEqual(await throttleRows(), [[13, 50]]);
      assert.equal((await events("rule.ip_conn_surge.recovered")).length, 1);

      // 第 24–35 分钟：规则 10 又冲上去 —— 冷却里不再发事件，但照样限速。
      rates.set(10, { inBps: 0, outBps: mbps(200) });
      const surgeAlerts10 = () => alerts.filter((item) => item.title === "NEX 流量异常：香港入口").length;
      const alertsBefore = surgeAlerts10();
      for (let m = 24; m <= 35; m += 1) await tick(m);
      assert.equal((await events("rule.traffic_surge")).filter((row) => Number(row.ruleId) === 10).length, 1, "冷却里不重复报");
      assert.equal(surgeAlerts10(), alertsBefore, "冷却里也不发通知");
      assert.deepEqual(await throttleRows(), [[10, 50], [13, 50]]);

      // 规则 13 第 10 分钟加的限速，30 分钟后（第 40 分钟）到期撤掉；还在超线，要再连续 10 分钟才重新限。
      for (let m = 36; m <= 40; m += 1) await tick(m);
      assert.ok(!(await throttleRows()).some(([id]) => id === 13), "到期撤掉");
      assert.equal(throttles.anomalyAwareRuleMbps(13, 500, base + 41 * MIN), 500, "撤掉后回到手动的 500");
      for (let m = 41; m <= 51; m += 1) await tick(m);
      assert.ok((await throttleRows()).some(([id]) => id === 13), "还在超线：再限一轮");

      // 管理员在设置里手动撤掉：直到恢复都不再自动加。
      const caller = trafficAnomalyRouter.createCaller({
        req: { headers: {}, ip: "127.0.0.1", socket: {} },
        res: { cookie() {}, clearCookie() {} },
        user: { id: 1, role: "admin", username: "admin" },
        authSession: null,
        authFailureReason: null,
      });
      const listed = await caller.throttles();
      assert.ok(listed.some((item) => item.ruleId === 13 && item.manualMbps === 500));
      await caller.release({ ruleId: 13 });
      for (let m = 52; m <= 70; m += 1) await tick(m);
      assert.ok(!(await throttleRows()).some(([id]) => id === 13), "手动撤掉后这一轮不再加回来");

      // ---- 面板重启：内存全没了，表里留着上次的 ----
      anomaly.resetTrafficAnomalyStateForTest();
      throttles.resetAnomalyThrottlesForTest();
      await exec("DELETE FROM traffic_anomaly_throttles");
      const nowSec = Math.floor((base + 71 * MIN) / 1000);
      await exec("INSERT INTO traffic_anomaly_throttles (ruleId, mbps, baselineDeciMbps, thresholdDeciMbps, appliedAt, expiresAt) VALUES (10, 50, 100, 500, ?, ?)", [nowSec - 600, nowSec + 1200]);
      await exec("INSERT INTO traffic_anomaly_throttles (ruleId, mbps, baselineDeciMbps, thresholdDeciMbps, appliedAt, expiresAt) VALUES (13, 50, 100, 500, ?, ?)", [nowSec - 3600, nowSec - 60]);
      await exec("INSERT INTO traffic_anomaly_throttles (ruleId, mbps, baselineDeciMbps, thresholdDeciMbps, appliedAt, expiresAt) VALUES (777, 50, 100, 500, ?, ?)", [nowSec - 60, nowSec + 1200]);
      const recovery = await anomaly.recoverAnomalyThrottlesOnStartup(base + 71 * MIN);
      assert.deepEqual(recovery, { kept: 1, revoked: 2 }, "过期的、规则已删的当场撤；还没到点的接着管");
      assert.deepEqual(await throttleRows(), [[10, 50]]);
      assert.equal(throttles.anomalyAwareRuleMbps(10, 0, base + 72 * MIN), 50, "重启后心跳照样叠上");
      assert.equal(anomaly.getTrafficAnomalyStateForTest("rule:10").firing, true, "按正在告警接着管");
      // 接着管：回落后照常恢复、撤掉。
      rates.clear();
      for (let m = 72; m <= 83; m += 1) await tick(m);
      assert.deepEqual(await throttleRows(), []);
      assert.equal((await events("rule.traffic_surge.recovered")).filter((row) => Number(row.ruleId) === 10).length, 2);

      // 重启时自动限速已经关了：留下的当场撤掉。
      throttles.resetAnomalyThrottlesForTest();
      await exec("INSERT INTO traffic_anomaly_throttles (ruleId, mbps, baselineDeciMbps, thresholdDeciMbps, appliedAt, expiresAt) VALUES (10, 50, 100, 500, ?, ?)", [nowSec, nowSec + 1800]);
      // 直接改设置（不走 saveTrafficAnomalyConfig）：模拟「关掉之后、撤之前面板就重启了」。
      const { setSetting } = await import(url("server/repositories/settingsRepository.ts"));
      await setSetting("ops.trafficAnomaly.autoThrottle", "false");
      assert.deepEqual(await anomaly.recoverAnomalyThrottlesOnStartup(base + 90 * MIN), { kept: 0, revoked: 1 });
      assert.deepEqual(await throttleRows(), []);

      // 关掉检测：正在限的当场撤掉；手动限速一直是原来的数。
      await anomaly.saveTrafficAnomalyConfig({ enabled: true, autoThrottle: true });
      await throttles.saveAnomalyThrottle({ ruleId: 13, mbps: 50, baselineMbps: 10, thresholdMbps: 50, appliedAt: base, expiresAt: Date.now() + 3600_000 });
      const saved = await caller.save({ enabled: false, sensitivity: "high", multiplier: 9, minMbps: 9, sustainMinutes: 9, ipConnThreshold: 9, autoThrottle: true, throttleMinutes: 30 });
      assert.equal(saved.enabled, false);
      assert.equal(saved.multiplier, 3, "选了灵敏档就按灵敏档的数");
      assert.deepEqual(await throttleRows(), []);
      assert.equal(Number((await runtime.queryRaw("SELECT rateLimitMbps FROM forward_rules WHERE id = 13"))[0].rateLimitMbps), 500);
      assert.equal(Number((await runtime.queryRaw("SELECT rateLimitMbps FROM forward_rules WHERE id = 12"))[0].rateLimitMbps), 20);
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "traffic-anomaly.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
