import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 线路按时间段启用：出口组的第二台机器只在北京时间 20:00-02:00 用。
 * - 存的时候在时段外：实际停着、标「时段停用」；
 * - 定时任务到点恢复，离开时段再停；
 * - 用户自己手动停的，进入时段也不恢复；
 * - 编辑表单把「时段停用」回显成开着，存一次不会变成手动停用。
 */
test("成员可用时段：进出时段自动停用 / 恢复，手动停用不受影响", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-member-schedule-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    console.info = () => {};
    console.warn = () => {};
    const repo = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
    const sweep = await import(moduleUrl("server/forwardGroupMemberSchedule.ts"));
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')");
    await exec("INSERT INTO hosts (id, name, ip, userId) VALUES (1, 'a', '10.0.0.1', 1), (2, 'b', '10.0.0.2', 1)");
    await exec('INSERT INTO forward_groups (id, name, "groupType", "groupMode", "targetIp", "userId", "isEnabled") VALUES (21, ?, ?, ?, ?, 1, 1)', ["exit", "host", "exit", "0.0.0.0"]);
    const peak = { timezone: "Asia/Shanghai", windows: [{ days: [], from: "20:00", to: "02:00" }] };
    const members = (enabledB = true) => [
      { memberType: "host", hostId: 1, priority: 0, isEnabled: true },
      { memberType: "host", hostId: 2, priority: 1, isEnabled: enabledB, activeSchedule: peak },
    ];
    const memberB = async () => (await query('SELECT "isEnabled", "scheduleSuspended", "activeSchedule" FROM forward_group_members WHERE "hostId" = 2'))[0];

    // 现在（真实时间）不一定在时段里：先存，再按「中午」和「晚上」两个时刻跑定时任务。
    await repo.replaceForwardGroupMembers(21, members(), { skipSync: true });
    assert.ok((await memberB()).activeSchedule.includes("20:00"));

    const noon = new Date("2026-10-18T04:00:00Z");
    const evening = new Date("2026-10-18T13:00:00Z");
    await sweep.applyForwardGroupMemberSchedules(noon);
    let b = await memberB();
    assert.equal(Number(b.isEnabled), 0, "中午不在时段里：停");
    assert.equal(Number(b.scheduleSuspended), 1);

    await sweep.applyForwardGroupMemberSchedules(evening);
    b = await memberB();
    assert.equal(Number(b.isEnabled), 1, "晚上进入时段：恢复");
    assert.equal(Number(b.scheduleSuspended), 0);
    const again = await sweep.applyForwardGroupMemberSchedules(evening);
    assert.equal(again.applied, 0, "状态没变就不重写成员");

    // 用户手动停用：进出时段都不碰
    await repo.replaceForwardGroupMembers(21, members(false), { skipSync: true });
    await sweep.applyForwardGroupMemberSchedules(noon);
    await sweep.applyForwardGroupMemberSchedules(evening);
    b = await memberB();
    assert.equal(Number(b.isEnabled), 0);
    assert.equal(Number(b.scheduleSuspended), 0, "手动停用不是时段停用");

    // 不传时段（旧客户端、机器人改成员）：保留原来的时段
    await repo.replaceForwardGroupMembers(21, [
      { memberType: "host", hostId: 1, priority: 0, isEnabled: true },
      { memberType: "host", hostId: 2, priority: 1, isEnabled: true },
    ], { skipSync: true });
    assert.ok((await memberB()).activeSchedule, "没传 activeSchedule 不清掉");
    // 清掉时段：一直可用
    await repo.replaceForwardGroupMembers(21, [
      { memberType: "host", hostId: 1, priority: 0, isEnabled: true },
      { memberType: "host", hostId: 2, priority: 1, isEnabled: true, activeSchedule: null },
    ], { skipSync: true });
    await sweep.applyForwardGroupMemberSchedules(noon);
    b = await memberB();
    assert.equal(b.activeSchedule, null);
    assert.equal(Number(b.isEnabled), 1);
    console.log("OK");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "schedule.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
