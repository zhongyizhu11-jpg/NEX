import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { liveEntryExitSegment, tcpingEntryExitSegment, waitViaExitSegment } from "./selfTestViaExit";
import type { LiveRuleReport } from "./balanceLive";

/*
  问题 C：负载均衡链路的诊断从扛流量的出口（hep ix）测目标，「入口 → 出口」那一段以前却拿链路自己的样本（入口到
  主出口 Jinx 的），画成「po0 → 7 ms → Jinx」。现在这一段是测目标那台的：入口的真实上报，没有就入口现测一次。
*/

const liveReport = (exits: Array<Partial<LiveRuleReport["exits"][number]> & { hostId: number }>, at = Date.now()): LiveRuleReport => ({
  ruleId: 100,
  tunnelId: 30,
  entryHostId: 1,
  entryHostName: "po0",
  strategy: "auto",
  targetAware: true,
  source: "agent",
  events: [],
  at,
  exits: exits.map((exit) => ({
    hostName: `主机 ${exit.hostId}`, host: `198.51.100.${exit.hostId}`, port: 40000 + exit.hostId, state: "active", reason: null, share: null, picks: 0,
    medianMs: null, exitMs: null, targetMs: null, targetLatencyUnknown: false, jitterMs: null, lossPct: null, samples: 0, udpState: null, peerOutdated: false,
    ...exit,
  })),
});

test("入口 → 在用出口那一段：入口实时上报优先，连不上出口机算超时，没有就等入口现测的那一次", async () => {
  const live = liveReport([{ hostId: 2, exitMs: 7.4 }, { hostId: 3, exitMs: 2.2 }, { hostId: 4, state: "down", reason: "exit" }], 1000);
  assert.deepEqual(liveEntryExitSegment(live, 3), { entryHostId: 1, exitHostId: 3, recordedAt: 1000, source: "live", latencyMs: 2, isTimeout: false });
  assert.equal(liveEntryExitSegment(live, 4)?.isTimeout, true);
  assert.equal(liveEntryExitSegment(liveReport([{ hostId: 3 }]), 3), null, "老 Agent 没报 exitMs");
  assert.equal(liveEntryExitSegment(null, 3), null);
  assert.equal(tcpingEntryExitSegment({ status: "pending" }, 1, 3), null);
  assert.deepEqual(tcpingEntryExitSegment({ status: "success", latencyMs: 3, updatedAt: 5000 }, 1, 3), { entryHostId: 1, exitHostId: 3, latencyMs: 3, isTimeout: false, recordedAt: 5000, source: "tcping" });
  assert.equal(tcpingEntryExitSegment({ status: "failed", latencyMs: null }, 1, 3)?.isTimeout, true);

  let clock = 0;
  const rows = [{ status: "pending" }, { status: "running" }, { status: "success", latencyMs: 4, updatedAt: 9000 }];
  const waited = await waitViaExitSegment({
    ruleId: 100, entryHostId: 1, exitHostId: 3, entryExitTestId: 77, waitMs: 10_000,
    loadLive: () => liveReport([{ hostId: 3 }]),
    loadTest: async () => rows.shift(),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });
  assert.equal(waited?.source, "tcping");
  assert.equal(waited?.latencyMs, 4);
  assert.equal(await waitViaExitSegment({ ruleId: 100, entryHostId: 1, exitHostId: 3, waitMs: 10_000, loadLive: () => null, loadTest: async () => null }), null, "没现测就不等");
  clock = 0;
  assert.equal(await waitViaExitSegment({
    ruleId: 100, entryHostId: 1, exitHostId: 3, entryExitTestId: 77, waitMs: 2_000,
    loadLive: () => null, loadTest: async () => ({ status: "pending" }), sleep: async (ms) => { clock += ms; }, now: () => clock,
  }), null, "等到点还没回来：这一段没测到");
});

test("诊断从扛流量的出口测：入口 → 出口那一段用这台的（实时上报 / 现测），不和主出口的链路样本拼", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-via-exit-"));
  process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "v.db") } });
    await ensureDatabaseSchema();
    const exec = (sql: string, params: unknown[] = []) => runtime.executeRaw(sql, params);
    const db = await import("./db");
    const utils = await import("./agentRouteUtils");
    const live = await import("./balanceLive");
    const { selfTestRulesRouter } = await import("./routers/rules.selfTest");
    const { Router } = await import("express");
    const { registerAgentSelfTestRoutes } = await import("./agentSelfTestRoutes");
    const now = new Date(Date.now() + 3600_000);
    await exec(`INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')`);
    for (const [id, name] of [[1, "po0"], [2, "Jinx"], [3, "hep ix"], [4, "Jinx(29.9y)"]] as const) {
      await exec(`INSERT INTO hosts (id, name, ip, "userId", "isOnline", "lastHeartbeat", "agentVersion", "hostType", "agentToken") VALUES (?, ?, ?, 1, 1, ?, '2.3.540', 'slave', ?)`, [id, name, `198.51.100.${id}`, now, `token-${id}`]);
    }
    await exec(`INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", secret, "loadBalanceEnabled", "loadBalanceStrategy", "isEnabled", "isRunning", "lastTestStatus") VALUES (30, 'po0', 1, 2, 'tls', 40002, 1, 's', 1, 'auto', 1, 1, 'success')`);
    await exec(`INSERT INTO tunnel_exit_nodes ("tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (30, 1, 3, 40003, 1), (30, 2, 4, 40004, 1)`);
    await exec(`INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (100, 1, 'hkt', 'gost', 'tcp', 30, 32001, '203.0.113.10', 443, 1, 1, 1)`);
    // 链路自己的样本是入口到主出口 Jinx 的：50 ms。拼进去就错了。
    await db.insertTunnelLatencyStat({ tunnelId: 30, latencyMs: 50, isTimeout: false });

    const caller = selfTestRulesRouter.createCaller({ user: { id: 1, role: "admin" }, req: { headers: {} }, res: {} } as never);
    const agentRouter = Router();
    registerAgentSelfTestRoutes(agentRouter);
    const route = (url: string) => (agentRouter.stack as any[]).find((layer) => layer.route?.path === url).route.stack[0].handle;
    const report = async (hostId: number, body: Record<string, unknown>) => {
      let result: unknown;
      await route("/api/agent/selftest-result")({ agentToken: `token-${hostId}`, body }, { json: (value: unknown) => { result = value; }, status: (code: number) => { throw new Error(`HTTP ${code}`); } });
      return result;
    };
    const ingest = (exits: unknown[]) => live.ingestBalanceLiveReport({ hostId: 1, source: "agent", rules: [{ tunnelId: 30, ruleId: 100, strategy: "auto", targetAware: true, exits }] });
    const exits = (hepIx: Record<string, unknown>) => [
      { hostId: 2, host: "198.51.100.2", port: 40002, state: "active", share: 0.2, picks: 2, medianMs: 12, exitMs: 7, targetMs: 5, samples: 20 },
      { hostId: 3, host: "198.51.100.3", port: 40003, state: "active", share: 0.6, picks: 6, samples: 20, ...hepIx },
      { hostId: 4, host: "198.51.100.4", port: 40004, state: "active", share: 0.2, picks: 2, medianMs: 9, exitMs: 4, targetMs: 5, samples: 20 },
    ];

    // 1. 入口报了 hep ix 的 exitMs：从 hep ix 测目标，入口 → hep ix 用实时上报的 2 ms
    await ingest(exits({ medianMs: 6, exitMs: 2.2, targetMs: 4 }));
    const first = await db.getForwardTestById((await caller.startSelfTest({ ruleId: 100 })).id) as any;
    assert.equal(first.hostId, 3, "从扛流量的 hep ix 测");
    const meta = utils.parseSelfTestMeta(first.requestMessage) as any;
    assert.deepEqual([meta.kind, meta.exitHostId, meta.primaryExitHostId, meta.viaActiveExit, meta.entryExitTestId], ["forward-via-tunnel", 3, 2, true, undefined]);
    await report(3, { testId: first.id, targetReachable: true, latencyMs: 4 });
    const done = await db.getForwardTestById(first.id) as any;
    assert.equal(done.status, "success");
    assert.equal(Number(done.latencyMs), 6, "2 ms（入口到 hep ix）+ 4 ms（hep ix 到目标），不是 50 + 4");
    const message = JSON.parse(done.message);
    const segment = message.details.find((detail: any) => detail.toHostId != null);
    assert.deepEqual([segment.fromHostId, segment.toHostId, segment.latencyMs, segment.routeLabel], [1, 3, 2, "po0 -> hep ix"]);
    assert.equal(message.details.some((detail: any) => detail.toHostId === 2 || detail.fromHostId === 2), false, "主出口不出现在路径里");
    assert.match(message.message, /入口到 hep ix 2ms/);

    // 2. 入口没报 hep ix 的 exitMs（老 Agent）：开始诊断时让入口现测一次到 hep ix 的 tcping
    await ingest(exits({ medianMs: 4 }));
    const second = await db.getForwardTestById((await caller.startSelfTest({ ruleId: 100 })).id) as any;
    const secondMeta = utils.parseSelfTestMeta(second.requestMessage) as any;
    assert.ok(secondMeta.entryExitTestId > 0, "排了一次入口现测");
    const probe = await db.getForwardTestById(secondMeta.entryExitTestId) as any;
    assert.equal(probe.hostId, 1, "入口机测");
    assert.equal(Number(probe.ruleId), 0, "不算这条规则的诊断记录");
    assert.deepEqual([utils.parseSelfTestMeta(probe.message)?.kind, (utils.parseSelfTestMeta(probe.message) as any)?.targetIp, (utils.parseSelfTestMeta(probe.message) as any)?.targetPort], ["line-segment", "198.51.100.3", 40003]);
    await report(1, { testId: probe.id, targetReachable: true, latencyMs: 3 });
    await report(3, { testId: second.id, targetReachable: true, latencyMs: 4 });
    const secondDone = await db.getForwardTestById(second.id) as any;
    assert.equal(Number(secondDone.latencyMs), 7, "3 ms（现测）+ 4 ms");
    assert.equal((await db.getLatestForwardTest(100, { includeActive: false }) as any).id, second.id, "规则的最近一次诊断还是主那一行");

    // 3. 主出口扛得最多：照旧从主出口测，用链路自己的样本
    await ingest(exits({ medianMs: 6, exitMs: 2, targetMs: 4, share: 0.1 }).map((exit, index) => (index === 0 ? { ...exit, share: 0.7 } : exit)));
    const third = await db.getForwardTestById((await caller.startSelfTest({ ruleId: 100 })).id) as any;
    assert.equal(third.hostId, 2);
    assert.equal((utils.parseSelfTestMeta(third.requestMessage) as any).viaActiveExit, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
