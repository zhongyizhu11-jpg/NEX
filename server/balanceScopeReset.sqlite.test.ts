import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { balanceDetectWithoutScope } from "./dbSchema";

/*
  2.3.557 整改：「附加：检查出口到目标」默认关，现有的也一起关（用户选「全部默认关」）。升级时把链路 / 转发组存着的
  scope 去掉一次（回到默认：只看出口组）；之后用户再打开的不再动。
*/
test("去掉存着的 scope，别的检测参数原样留着", () => {
  assert.equal(balanceDetectWithoutScope('{"intervalSeconds":5,"scope":"chain"}'), '{"intervalSeconds":5}');
  assert.equal(balanceDetectWithoutScope('{"intervalSeconds":5}'), null);
  assert.equal(balanceDetectWithoutScope("not json scope"), null);
  assert.equal(balanceDetectWithoutScope(null), null);
});

test("升级只关一次：现有的回到只看出口组，之后用户打开的保留", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-balance-scope-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.NEX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);

      // 模拟 2.3.556 存下的：表单默认带着 scope = chain
      await exec("DELETE FROM system_settings WHERE key = 'balance-scope-default-tunnel-v1'");
      await exec('INSERT INTO forward_groups (id, name, "targetIp", "userId", "balanceDetect") VALUES (5, ?, ?, 1, ?)', ["g", "203.0.113.1", '{"intervalSeconds":5,"scope":"chain"}']);
      await schema.ensureDatabaseSchema();
      const after = await query('SELECT "balanceDetect" AS d FROM forward_groups WHERE id = 5');
      assert.equal(after[0].d, '{"intervalSeconds":5}');

      // 之后用户自己打开：再启动也不动
      await exec('UPDATE forward_groups SET "balanceDetect" = ? WHERE id = 5', ['{"intervalSeconds":5,"scope":"chain"}']);
      await schema.ensureDatabaseSchema();
      const kept = await query('SELECT "balanceDetect" AS d FROM forward_groups WHERE id = 5');
      assert.equal(kept[0].d, '{"intervalSeconds":5,"scope":"chain"}');
      console.log("OK");
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", NEX_TEST_DB: path.join(directory, "scope.db") },
      timeout: 180_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
