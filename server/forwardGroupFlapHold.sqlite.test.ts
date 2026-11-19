import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  抖动抑制读 forward_group_events（server/forwardGroupFlapHold.ts）：主备组按整组、入口组按成员，同一个查询。
  读失败时不能当成「没在抖」—— 以前两处查询都是 .catch(() => [])，一次数据库抖动就把抖动抑制悄悄关掉了。
  现在用上一次读到的（记日志）。
*/
test("抖动抑制：按成员分；读事件失败时沿用上一次读到的，不悄悄关掉", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-flap-hold-"));
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const flap = await import("./forwardGroupFlapHold");
  const originalWarn = console.warn;
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "f.db") } });
    await ensureDatabaseSchema();
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const [memberId, ago] of [[11, 600], [11, 400], [11, 200], [12, 100]] as const) {
      await runtime.executeRaw(`INSERT INTO forward_group_events ("groupId", "memberId", type, message, "createdAt") VALUES (5, ?, ?, 'x', ?)`, [memberId, flap.FORWARD_GROUP_AUTO_SWITCH_EVENT, nowSeconds - ago]);
    }
    const byMember = await flap.forwardGroupAutoSwitchTimesByMember(5);
    assert.deepEqual([...byMember.keys()].sort(), [11, 12]);
    assert.equal(byMember.get(11)!.length, 3);
    const held = await flap.forwardGroupFlapHoldForGroup(5);
    assert.equal(held.switches, 4);
    assert.ok(held.untilMs > Date.now(), "一小时内自动切了 4 次：要压着");

    // 读失败（表暂时读不了）
    await runtime.executeRaw(`ALTER TABLE forward_group_events RENAME TO forward_group_events_gone`);
    const warnings: string[] = [];
    console.warn = (message: unknown) => { warnings.push(String(message)); };
    const afterError = await flap.forwardGroupFlapHoldForGroup(5);
    assert.equal(afterError.switches, 4, "读失败被当成「没有自动切换」：抖动抑制被悄悄关掉了");
    assert.ok(afterError.untilMs > Date.now());
    assert.ok(warnings.some((line) => /keeping the last known flap state/.test(line)));
    assert.equal((await flap.forwardGroupAutoSwitchTimesByMember(6)).size, 0, "没读成功过的组只能按没有记录算");
  } finally {
    console.warn = originalWarn;
    await runtime.closeDatabase().catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
