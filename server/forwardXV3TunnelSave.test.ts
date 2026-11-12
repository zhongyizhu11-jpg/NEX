import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * NEX V3 隧道保存时的校验（真 sqlite + 真 tunnels 路由）：
 *
 *   · 隧道上有一台 Agent / FXP 不够新就拒，写清是哪台、差什么；
 *   · 不能组合的特性（抗丢包传输、中转叠加、内核直通、多路并发）拒并给中文原因；
 *   · 外层选项按 V3 存，改回 V1 时清空；
 *   · 外层写坏（路径带换行）拒。
 */
test("NEX V3 隧道的创建 / 修改校验", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-v3-save-"));
  const databasePath = path.join(directory, "v3-save.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { tunnelsRouter } = await import(moduleUrl("server/routers/tunnels.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const rejects = async (promise, pattern, label) => {
      try {
        await promise;
      } catch (error) {
        assert.match(String(error && error.message), pattern, label);
        return;
      }
      assert.fail(label + "：应该被拒");
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("users", ["id", "username", "password", "role", "accountEnabled"], [1, "admin", "x", "admin", 1]);
      const host = (id, name, agentVersion, fxpVersion) => insert(
        "hosts",
        ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline", "agentVersion", "fxpVersion"],
        [id, name, "198.51.100." + id, "slave", 1, 20000 + id * 100, 20099 + id * 100, 1, agentVersion, fxpVersion],
      );
      await host(1, "入口", "2.2.257", "2.2.141");
      await host(2, "出口", "2.2.257", "2.2.141");
      await host(3, "老出口", "2.2.256", "2.2.140");

      const caller = tunnelsRouter.createCaller({
        req: { headers: {} },
        res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      });
      const base = { name: "v3", entryHostId: 1, exitHostId: 2, mode: "forwardx", forwardxVersion: "v3" };

      await rejects(caller.create({ ...base, exitHostId: 3, v3Transport: "tls" }), /NEX V3 要隧道上每台机器都升级：老出口（要 Agent 2\.2\.257、FXP 2\.2\.141 以上）/, "老出口");
      await rejects(caller.create({ ...base, v3Transport: "tls", lossTolerant: true }), /抗丢包传输/, "V3 + 抗丢包传输");
      await rejects(caller.create({ ...base, v3Transport: "tls", kernelPassthrough: true }), /内核直通/, "V3 + 内核直通");
      await rejects(caller.create({ ...base, v3Transport: "http", v3Path: "/a\r\nX: 1" }), /路径/, "路径注入");

      const created = await caller.create({ ...base, v3Transport: "ws", v3Path: "live", v3Host: " cdn.example ", v3Multiplex: true, udpFec: true, tcpFastOpen: true });
      const id = Number(created && created.id || created);
      const row = async () => (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = ?', [id]))[0];
      let saved = await row();
      assert.equal(saved.forwardxVersion, "v3");
      assert.equal(saved.v3Transport, "ws");
      assert.equal(saved.v3Path, "/live");
      assert.equal(saved.v3Host, "cdn.example");
      assert.equal(Number(saved.v3Multiplex), 1);
      assert.equal(Number(saved.udpFec), 1, "UDP 抗丢包可以和 V3 一起开");

      // 打开抗丢包传输：拒。
      await rejects(caller.update({ id, lossTolerant: true }), /抗丢包传输/, "修改时打开抗丢包传输");
      // 换到老出口：拒。
      await rejects(caller.update({ id, exitHostId: 3 }), /老出口/, "修改时换到老出口");
      // 只改外层：照存。
      await caller.update({ id, v3Transport: "tls", v3ServerName: "www.example.com", v3Multiplex: false });
      saved = await row();
      assert.equal(saved.v3Transport, "tls");
      assert.equal(saved.v3ServerName, "www.example.com");
      assert.equal(saved.v3Path, null, "TLS 外层不留 HTTP 路径");
      assert.equal(Number(saved.v3Multiplex), 0);
      // 改回 V1：V3 选项清空。
      await caller.update({ id, forwardxVersion: "v1" });
      saved = await row();
      assert.equal(saved.forwardxVersion, "v1");
      assert.equal(saved.v3Transport, null);
      assert.equal(saved.v3ServerName, null);
      // V1 隧道开了 4 路并发，再切 V3：拒。
      await runtime.executeRaw('UPDATE "tunnels" SET "parallelStreams" = 4 WHERE "id" = ?', [id]);
      await rejects(caller.update({ id, forwardxVersion: "v3", v3Transport: "tls" }), /多路并发/, "V3 + 多路并发");
      await runtime.executeRaw('UPDATE "tunnels" SET "parallelStreams" = 1 WHERE "id" = ?', [id]);
      // 已经是 V3 的隧道不能再打开多路并发。
      await caller.update({ id, forwardxVersion: "v3", v3Transport: "tls" });
      await rejects(caller.setParallelStreams({ id, streams: 4 }), /V3/, "V3 隧道打开多路并发");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 120_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
