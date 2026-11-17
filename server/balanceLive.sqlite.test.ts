import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  入口报真实状态（FXP 2.2.145 / Agent 2.2.262 起）→ 规则卡「经」、延迟，链路弹窗「怎么走」、切换记录都按它显示，
  不再按出口的探测去猜。用户的例子：主出口 jinx(39.9y) 连不上高防目标，流量在 hep ix / Jinx(29.9y) 上。
*/
test("入口上报的真实状态：规则卡、链路弹窗、切换记录都按它显示；不是入口的机器报的不收", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-balance-live-"));
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "b.db") } });
    await ensureDatabaseSchema();
    const exec = (sql: string, params: unknown[] = []) => runtime.executeRaw(sql, params);
    const now = new Date(Date.now() + 3600_000);
    await exec(`INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')`);
    for (const [id, name] of [[1, "Po0"], [2, "jinx(39.9y)"], [3, "hep ix"], [4, "Jinx(29.9y)"]] as const) {
      await exec(`INSERT INTO hosts (id, name, ip, "userId", "isOnline", "lastHeartbeat", "agentVersion", "hostType") VALUES (?, ?, ?, 1, 1, ?, '2.2.262', 'slave')`, [id, name, `198.51.100.${id}`, now]);
    }
    await exec(`INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "forwardxVersion", "listenPort", "userId", secret, "loadBalanceEnabled", "loadBalanceStrategy", "isEnabled", "isRunning") VALUES (1, 'Po0', 1, 2, 'forwardx', 'v1', 40001, 1, 's', 1, 'auto', 1, 1)`);
    await exec(`INSERT INTO tunnel_exit_nodes ("tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (1, 1, 3, 40002, 1), (1, 2, 4, 40003, 1)`);
    await exec(`INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (501, 1, 'hkt', 'gost', 'tcp', 1, 37326, 'hkboil.ddos.top', 24895, 1, 1, 1)`);

    const live = await import("./balanceLive");
    const health = await import("./exitTargetHealth");
    live.resetBalanceLiveForTest();
    const rule = {
      tunnelId: 1,
      ruleId: 501,
      strategy: "auto",
      targetAware: true,
      exits: [
        { hostId: 2, host: "198.51.100.2", port: 40001, state: "down", reason: "target", share: 0, picks: 0, samples: 30, lossPct: 100 },
        { hostId: 3, host: "198.51.100.3", port: 40002, state: "active", share: 0.6, picks: 6, medianMs: 7.2, jitterMs: 1, samples: 30 },
        // 老配置没带主机号：按地址 + 端口认
        { host: "198.51.100.4", port: 40003, state: "active", share: 0.4, picks: 4, medianMs: 3.1, jitterMs: 1, samples: 30 },
      ],
      events: [{ at: Date.now() - 5000, hostId: 2, host: "198.51.100.2", from: "active", to: "down", reason: "target" }],
    };
    const notEntry = await live.ingestBalanceLiveReport({ hostId: 3, source: "fxp", rules: [rule] });
    assert.equal(notEntry.recorded, 0, "出口机不能替入口报");
    const outcome = await live.ingestBalanceLiveReport({ hostId: 1, source: "fxp", rules: [rule] });
    assert.equal(outcome.recorded, 1);
    assert.equal(outcome.reports[0].exits[2].hostId, 4, "地址 + 端口认出是 Jinx(29.9y)");

    const [row] = health.withRuleExitTargets([{ ruleId: 501, latestLatencyMs: null, latestLatencyIsTimeout: true }]);
    assert.deepEqual(row.exitTargetVia, ["hep ix", "Jinx(29.9y)"], "经后面写实际在用的出口");
    assert.equal(row.latestLatencyIsTimeout, false);
    assert.equal(row.latestLatencyMs, 3);
    assert.equal(row.exitTargetTotal, 3);
    assert.equal(row.exitTargetOk, 2);
    assert.match(String(row.exitTargetNote), /jinx\(39\.9y\) 连不上目标，已切走/);

    const via = health.ruleActiveExit(501, 1);
    assert.deepEqual(via?.hostIds, [3, 4], "诊断从在用的出口测");

    const summary = health.exitTargetSummaryForTunnel({ id: 1, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "auto" }, [2, 3, 4], {
      hostNames: new Map([[2, "jinx(39.9y)"], [3, "hep ix"], [4, "Jinx(29.9y)"]]),
    });
    assert.equal(summary.live, true);
    assert.deepEqual(summary.exits.map((exit) => [exit.hostId, exit.down, exit.activeRules]), [[2, 1, 0], [3, 0, 1], [4, 0, 1]]);
    assert.equal(summary.how, "自动：hep ix 60%、Jinx(29.9y) 40%，1 台备用");
    assert.equal(summary.events?.[0]?.text, "jinx(39.9y) 连不上（到目标），已切走");

    // 主出口在用：照旧按主出口，不写「经」
    await live.ingestBalanceLiveReport({ hostId: 1, source: "fxp", rules: [{ ...rule, exits: rule.exits.map((exit, index) => ({ ...exit, state: index === 0 ? "active" : "standby" })) }] });
    const [plain] = health.withRuleExitTargets([{ ruleId: 501, latestLatencyMs: 9, latestLatencyIsTimeout: false }]);
    assert.equal(plain.exitTargetVia, null);
    assert.equal(plain.latestLatencyMs, 9);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
