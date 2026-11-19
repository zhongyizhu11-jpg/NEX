import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExitTargetPushDebouncer } from "./exitTargetPush";

/*
  出口上报「连不连得上目标」之后，面板什么时候让入口重新拿配置（GOST 隧道）。真的 sqlite，推送换成记下来的。

  C2：每台都连不上目标之后，各台继续报「连不上」不该再推（以前「延迟优先」记的最快那台冻住，每来一份推一次）。
  C2：同一台出口 30 秒内翻来翻去：第一次连不上马上推，之后的合并。
  C3：面板重启后第一次听到的就是「连不上」（别的出口是好的）：要推。
  C3：半小时没再报的状态清掉。
*/

/** 手拨的时钟和定时器。 */
function pushHarness(Debouncer: typeof ExitTargetPushDebouncer) {
  let now = Date.now();
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const pushes: Array<{ hostId: number; at: number }> = [];
  const debouncer = new Debouncer(
    (hostId) => { pushes.push({ hostId, at: now }); },
    () => now,
    ((callback: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    }),
    ((timer: ReturnType<typeof setTimeout>) => { timers.delete(timer as unknown as number); }),
  );
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = Array.from(timers.entries()).filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = end;
  };
  return { debouncer, pushes, advance, now: () => now };
}

test("出口上报后什么时候推入口：冷启动第一次就是连不上要推、都连不上后不再推、反复翻转合并、过期清理", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-exit-ingest-"));
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const health = await import("./exitTargetHealth");
  // 先定好数据库类型再加载模块（表结构按它生成）。
  const harness = pushHarness((await import("./exitTargetPush")).ExitTargetPushDebouncer);
  health.resetExitTargetStates();
  const original = health.setExitTargetPushDebouncerForTest(harness.debouncer);
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "e.db") } });
    await ensureDatabaseSchema();
    const exec = (sql: string, params: unknown[] = []) => runtime.executeRaw(sql, params);
    const heartbeat = new Date(Date.now() + 3600_000);
    await exec(`INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')`);
    for (const id of [1, 2, 3, 4]) {
      await exec(`INSERT INTO hosts (id, name, ip, "userId", "isOnline", "lastHeartbeat", "agentVersion", "hostType") VALUES (?, ?, ?, 1, 1, ?, '2.2.262', 'slave')`, [id, `H${id}`, `198.51.100.${id}`, heartbeat]);
    }
    // 链路 1：GOST（tls），延迟优先，出口 2（主）、3、4。规则 501、502 走它。
    await exec(`INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", secret, "loadBalanceEnabled", "loadBalanceStrategy", "isEnabled", "isRunning") VALUES (1, 'gost', 1, 2, 'tls', 40001, 1, 's', 1, 'latency', 1, 1)`);
    await exec(`INSERT INTO tunnel_exit_nodes ("tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (1, 1, 3, 40002, 1), (1, 2, 4, 40003, 1)`);
    for (const id of [501, 502, 503]) {
      await exec(`INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (?, 1, 'r', 'gost', 'tcp', 1, ?, '203.0.113.9', 443, 1, 1, 1)`, [id, 30000 + id]);
    }
    const report = (hostId: number, ruleId: number, down: boolean, medianMs = 20) => health.ingestExitTargetReports({
      hostId,
      hostName: `H${hostId}`,
      nowMs: harness.now(),
      results: [{ ruleId, down, medianMs: down ? null : medianMs, latencyMs: down ? null : medianMs, jitterMs: 1, lossPct: down ? 100 : 0, samples: 30 }],
    });
    const pushCount = () => harness.pushes.length;

    // --- C3：冷启动。第一次听到的：出口 3 连不上、出口 2 是好的 → 要推（以前没有「上一次」可比，不推）。
    await report(3, 501, true);
    assert.equal(pushCount(), 0, "只有一台报了连不上、别的还没报：不知道是不是目标的问题，先不摘");
    await report(2, 501, false, 100);
    assert.equal(pushCount(), 1, "另一台确认是好的：出口 3 要摘掉，马上推入口");
    assert.equal(harness.pushes[0].hostId, 1);
    await report(4, 501, false, 10);
    harness.advance(5000);
    const afterColdStart = pushCount();

    // --- C2：每台都连不上目标。过程中会推（摘掉的出口在变），都连不上之后再报多少次都不推。
    harness.advance(40_000);
    for (const hostId of [2, 3, 4]) await report(hostId, 501, true);
    harness.advance(40_000);
    for (const hostId of [2, 3, 4]) await report(hostId, 501, true);
    harness.advance(5000);
    const settled = pushCount();
    assert.ok(settled > afterColdStart, "变成都连不上的过程里推过");
    for (let round = 0; round < 10; round += 1) {
      harness.advance(2000);
      for (const hostId of [2, 3, 4]) await report(hostId, 501, true);
    }
    harness.advance(60_000);
    assert.equal(pushCount(), settled, "每台都连不上之后，各台继续报连不上不再推入口（以前每来一份推一次）");

    // --- C2：同一台出口反复翻转。规则 502：三台都好 → 出口 3 连不上（第一次：马上）→ 好 → 连不上 → 好 ……
    for (const hostId of [2, 3, 4]) await report(hostId, 502, false);
    harness.advance(5000);
    const beforeFlap = pushCount();
    await report(3, 502, true);
    assert.equal(pushCount(), beforeFlap + 1, "第一次连不上：马上推");
    const firstFlapAt = harness.now();
    for (let round = 0; round < 6; round += 1) {
      harness.advance(1100);
      await report(3, 502, round % 2 === 1);
    }
    // 6 次翻转用了约 6.6 秒：不是每次都推
    assert.ok(pushCount() - beforeFlap <= 4, `30 秒内的反复翻转要合并，实际推了 ${pushCount() - beforeFlap} 次`);
    harness.advance(60_000);
    assert.ok(harness.pushes[harness.pushes.length - 1].at - firstFlapAt <= 40_000, "最后的状态（恢复）在翻转停下来约 30 秒内推到");

    // --- 旧的「连不上」（实验室，Agent 2.2.264）：三台一起断、Agent 都退避到 60 秒一次；恢复后先探到的那台一报
    // 「通了」，另外两台手里还是故障期间那份「连不上」—— 以前当场把它们摘掉、推入口。规则 503。
    const reportAged = (hostId: number, down: boolean, ageMs: number, intervalMs: number) => health.ingestExitTargetReports({
      hostId,
      hostName: `H${hostId}`,
      nowMs: harness.now(),
      results: [{ ruleId: 503, down, medianMs: down ? null : 20, latencyMs: down ? null : 20, jitterMs: 1, lossPct: down ? 100 : 0, samples: 30, ageMs, intervalMs }],
    });
    for (const hostId of [2, 3, 4]) await reportAged(hostId, false, 0, 2000);
    harness.advance(5000);
    for (const hostId of [2, 3, 4]) await reportAged(hostId, true, 0, 4000);
    harness.advance(60_000);
    for (const hostId of [2, 3, 4]) await reportAged(hostId, true, 20_000, 60_000);
    harness.advance(5000);
    const beforeRecover = pushCount();
    await reportAged(2, false, 0, 2000);
    harness.advance(1000);
    await reportAged(3, true, 40_000, 60_000);
    harness.advance(5000);
    assert.equal(health.exitTargetExcludedHostIds(503, [2, 3, 4], harness.now()).size, 0, "3、4 的「连不上」是故障期间探的：当不知道，不摘");
    assert.equal(pushCount(), beforeRecover, "摘掉的出口没变：不推");
    // 出口 4 在「都连不上」结束之后又探了一次，还是连不上：这份是新的，摘它、马上推
    harness.advance(10_000);
    await reportAged(4, true, 1000, 60_000);
    assert.deepEqual([...health.exitTargetExcludedHostIds(503, [2, 3, 4], harness.now())], [4]);
    assert.equal(pushCount(), beforeRecover + 1, "新探出来的连不上：马上推");

    // --- C3：半小时没再报的清掉
    assert.ok(health.exitTargetMemorySizeForTest().states >= 6);
    health.pruneExitTargetMemory(harness.now() + 31 * 60_000, true);
    assert.deepEqual(health.exitTargetMemorySizeForTest(), { states: 0, tunnels: 0, seeds: 0, excluded: 0 });
  } finally {
    health.setExitTargetPushDebouncerForTest(original);
    health.resetExitTargetStates();
    await runtime.closeDatabase().catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
