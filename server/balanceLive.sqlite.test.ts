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
        { hostId: 3, host: "198.51.100.3", port: 40002, state: "active", share: 0.6, picks: 6, medianMs: 7.2, jitterMs: 1, samples: 30, udpState: "down" },
        // 老配置没带主机号：按地址 + 端口认
        { host: "198.51.100.4", port: 40003, state: "active", share: 0.4, picks: 4, medianMs: 3.1, jitterMs: 1, samples: 30, udpState: "unverified", peerOutdated: true },
      ],
      events: [{ at: Date.now() - 5000, hostId: 2, host: "198.51.100.2", from: "active", to: "down", reason: "target" }],
    };
    const notEntry = await live.ingestBalanceLiveReport({ hostId: 3, source: "fxp", rules: [rule] });
    assert.equal(notEntry.recorded, 0, "出口机不能替入口报");
    const outcome = await live.ingestBalanceLiveReport({ hostId: 1, source: "fxp", rules: [rule] });
    assert.equal(outcome.recorded, 1);
    assert.equal(outcome.reports[0].exits[2].hostId, 4, "地址 + 端口认出是 Jinx(29.9y)");
    // FXP 报的 UDP 那一侧原样留着；没报的是 null
    assert.deepEqual(outcome.reports[0].exits.map((exit) => [exit.udpState, exit.peerOutdated]), [[null, false], ["down", false], ["unverified", true]]);

    const [row] = health.withRuleExitTargets([{ ruleId: 501, latestLatencyMs: null, latestLatencyIsTimeout: true }]);
    assert.deepEqual(row.exitTargetVia, ["hep ix", "Jinx(29.9y)"], "经后面写实际在用的出口");
    // 面板还没测到在用那台的两段：不写主出口那条的「超时」（流量在别的出口上照走），也不拿入口报的数顶
    assert.equal(row.latestLatencyIsTimeout, false);
    assert.equal(row.latestLatencyMs, null);
    assert.equal(row.latestLatencyChain, null);
    // 面板测到了扛流量最多那台（hep ix 分到 60%）的两段：整链 = 入口到它 + 它到目标，入口报的 7.2 不用
    const view = await import("./ruleLatencyView");
    view.resetRuleLatencyViewForTest();
    view.recordTunnelExitLeg(1, 3, 6);
    view.recordRuleTargetLeg({ ruleId: 501, tunnelId: 1, exitHostId: 3, primaryHostId: 2, ms: 3 });
    const [measured] = health.withRuleExitTargets([{ ruleId: 501, latestLatencyMs: null, latestLatencyIsTimeout: true }]);
    assert.equal(measured.latestLatencyMs, 9);
    assert.equal(measured.latestLatencySource, "panel");
    assert.deepEqual(measured.latestLatencyChain, { exitHostId: 3, exitName: "hep ix", exitMs: 6, targetMs: 3, share: 0.6 });
    assert.equal(row.exitTargetTotal, 3);
    assert.equal(row.exitTargetOk, 2);
    // 2.3.558：自动分配时某台连不上、流量在别的出口上照走，卡片不写；指定的那台连不上才写、并说切到了哪台
    assert.equal(row.exitTargetNote, null, "自动分配：卡片不写哪台坏了");
    const pinState = await import("./tunnelPinState");
    pinState.noteTunnelEffectivePin(1, 2);
    const [pinnedRow] = health.withRuleExitTargets([{ ruleId: 501, latestLatencyMs: null, latestLatencyIsTimeout: true }]);
    assert.match(String(pinnedRow.exitTargetNote), /指定的出口 jinx\(39\.9y\) 连不上目标，已切到 hep ix/);
    pinState.resetTunnelPinStateForTest();

    const via = health.ruleActiveExit(501, 1);
    assert.deepEqual(via?.hostIds, [3, 4], "诊断从在用的出口测");

    const summary = health.exitTargetSummaryForTunnel({ id: 1, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "auto" }, [2, 3, 4], {
      hostNames: new Map([[2, "jinx(39.9y)"], [3, "hep ix"], [4, "Jinx(29.9y)"]]),
    });
    assert.equal(summary.live, true);
    assert.deepEqual(summary.exits.map((exit) => [exit.hostId, exit.down, exit.activeRules]), [[2, 1, 0], [3, 0, 1], [4, 0, 1]]);
    assert.deepEqual(summary.exits.map((exit) => [exit.udpOk, exit.udpDown, exit.udpUnverified, exit.peerOutdated]), [[0, 0, 0, false], [0, 1, 0, false], [0, 0, 1, true]]);
    assert.equal(summary.how, "自动：hep ix 60%、Jinx(29.9y) 40%", "连不上的那台不算备用");
    // 弹窗每台出口一行：连不上的是哪一段、在用的分到几成（入口报的 share）
    assert.deepEqual(summary.exits.map((exit) => [exit.reason, exit.share]), [["target", null], [null, 0.6], [null, 0.4]]);
    assert.equal(summary.events?.[0]?.text, "jinx(39.9y) 连不上（到目标），已切走");
    // 每台出口在走哪几条规则、各自整链多少（2.3.559）：hep ix 用面板测的两段（6 + 3），Jinx(29.9y) 面板没测到、用入口报的整链 3.1
    assert.deepEqual(summary.exits.map((exit) => exit.usedBy), [[], [{ ruleId: 501, ms: 9 }], [{ ruleId: 501, ms: 3 }]]);

    // 主出口在用、入口没报它的延迟：延迟照旧（最近一次诊断的），「经」写它
    await live.ingestBalanceLiveReport({ hostId: 1, source: "fxp", rules: [{ ...rule, exits: rule.exits.map((exit, index) => ({ ...exit, state: index === 0 ? "active" : "standby" })) }] });
    const [plain] = health.withRuleExitTargets([{ ruleId: 501, latestLatencyMs: 9, latestLatencyIsTimeout: false }]);
    assert.deepEqual(plain.exitTargetVia, ["jinx(39.9y)"]);
    assert.equal(plain.latestLatencyMs, 9);
    assert.equal(plain.latestLatencyChain, null, "主出口的两段面板还没测到：留着规则自己的定时探测");
    assert.equal(health.ruleActiveExit(501, 1)?.hostIds[0], 2, "诊断从主出口测（rules.selfTest 不当成 viaActiveExit）");

    // 出口机本身连不上（不是到目标）：自动分配时不写；指定的就是它时照实说「连不上指定的出口」
    await live.ingestBalanceLiveReport({ hostId: 1, source: "fxp", rules: [{ ...rule, exits: rule.exits.map((exit, index) => (index === 0 ? { ...exit, reason: "exit" } : exit)) }] });
    const [unreachable] = health.withRuleExitTargets([{ ruleId: 501, latestLatencyMs: null, latestLatencyIsTimeout: true }]);
    assert.equal(unreachable.exitTargetNote, null);
    pinState.noteTunnelEffectivePin(1, 2);
    const [pinnedUnreachable] = health.withRuleExitTargets([{ ruleId: 501, latestLatencyMs: null, latestLatencyIsTimeout: true }]);
    assert.match(String(pinnedUnreachable.exitTargetNote), /^连不上指定的出口 jinx\(39\.9y\)/);
    pinState.resetTunnelPinStateForTest();

    /*
      GOST 入口（Agent）分开报两段：两条规则同一个目标，卡上都是「扛流量最多那台的整链」（问题 B，用户截图里
      hkt/2「经 3 台出口 · 10 ms」、hkt/3「经 hep ix · 4 ms」口径不一样）。主出口也在用时一样换。
    */
    const gostRule = {
      ...rule,
      strategy: "auto",
      exits: [
        { hostId: 2, host: "198.51.100.2", port: 40001, state: "active", share: 0.2, picks: 2, medianMs: 10, exitMs: 3, targetMs: 7, samples: 30 },
        { hostId: 3, host: "198.51.100.3", port: 40002, state: "active", share: 0.5, picks: 5, medianMs: 6, exitMs: 2, targetMs: 4, samples: 30 },
        { hostId: 4, host: "198.51.100.4", port: 40003, state: "active", share: 0.3, picks: 3, medianMs: 5, exitMs: 5, targetLatencyUnknown: true, samples: 30 },
      ],
      events: [],
    };
    await live.ingestBalanceLiveReport({ hostId: 1, source: "agent", rules: [gostRule] });
    const [gost] = health.withRuleExitTargets([{ ruleId: 501, latestLatencyMs: 4, latestLatencyIsTimeout: false, latestLatencyAt: new Date(0) }]);
    assert.equal(gost.latestLatencyMs, 9, "hep ix 分到 50%：它的整链，面板探的两段（6 + 3），不是入口报的 2 + 4");
    assert.deepEqual(gost.latestLatencyChain, { exitHostId: 3, exitName: "hep ix", exitMs: 6, targetMs: 3, share: 0.5 });
    assert.deepEqual(gost.exitTargetVia, ["hep ix", "jinx(39.9y)", "Jinx(29.9y)"], "扛流量的排第一");
    assert.equal(health.ruleActiveExit(501, 1)?.hostIds[0], 3, "诊断从同一台测");
    const unknownExit = live.liveBalanceForRule(501)!.exits[2];
    assert.deepEqual([unknownExit.exitMs, unknownExit.targetMs, unknownExit.targetLatencyUnknown], [5, null, true]);
    const gostSummary = health.exitTargetSummaryForTunnel({ id: 1, mode: "forwardx", loadBalanceEnabled: true, loadBalanceStrategy: "auto" }, [2, 3, 4], {});
    // 弹窗：面板测到的那台用面板的两段，没测到的用入口自己报的并标出来
    assert.deepEqual(
      gostSummary.exits.map((exit) => [exit.exitMs, exit.targetMs, exit.exitMsSource, exit.targetMsSource, exit.targetLatencyUnknown]),
      [[3, 7, "agent", "agent", 0], [6, 3, "panel", "panel", 0], [5, null, "agent", null, 1]],
    );

    // 这阵子没有新连接（share 都是空的）：取整链延迟低的；到目标不知道的那台只是下限，排在知道的后面
    await live.ingestBalanceLiveReport({ hostId: 1, source: "agent", rules: [{ ...gostRule, exits: gostRule.exits.map((exit) => ({ ...exit, share: -1 })) }] });
    const [idle] = health.withRuleExitTargets([{ ruleId: 501, latestLatencyMs: 4, latestLatencyIsTimeout: false }]);
    assert.equal(idle.latestLatencyMs, 9);
    assert.equal(idle.latestLatencyChain?.exitName, "hep ix");
    // 在用的那台面板没测到：留着规则自己的定时探测（4），不拿入口报的数
    await live.ingestBalanceLiveReport({ hostId: 1, source: "agent", rules: [{ ...gostRule, exits: gostRule.exits.map((exit, index) => ({ ...exit, state: index === 2 ? "active" : "standby" })) }] });
    const [lowerBound] = health.withRuleExitTargets([{ ruleId: 501, latestLatencyMs: 4, latestLatencyIsTimeout: false }]);
    assert.equal(lowerBound.latestLatencyMs, 4);
    assert.equal(lowerBound.latestLatencyChain, null);

    // 延迟优先「只走最快的一台」：入口报一台 active、其余 standby，弹窗写「只走 X（最快）」，不写主备
    await live.ingestBalanceLiveReport({ hostId: 1, source: "agent", rules: [{ ...gostRule, strategy: "latency", exits: gostRule.exits.map((exit, index) => ({ ...exit, state: index === 1 ? "active" : "standby" })) }] });
    const fastestSummary = health.exitTargetSummaryForTunnel(
      { id: 1, mode: "gost", loadBalanceEnabled: true, loadBalanceStrategy: "latency", balanceDetect: JSON.stringify({ fastestOnly: true }) },
      [2, 3, 4],
      { hostNames: new Map([[2, "jinx(39.9y)"], [3, "hep ix"], [4, "Jinx(29.9y)"]]) },
    );
    assert.equal(fastestSummary.how, "延迟优先：只走 hep ix（最快），2 台备用");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
