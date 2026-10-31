import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 线路详情的图上落地写名字（2.3.498）：选了我的节点写节点名；地址是规则主人自己某台机器（IP / 入口地址 /
 * DDNS 域名）写那台的名字；别人的机器不认（不把别人的机器名透出来）；都不是不给名字（界面写地址）。
 * 起一个真的 sqlite 跑一遍。
 */
test("落地名字：我的节点 → 节点名；自己机器的地址 → 机器名；别人的机器、陌生地址 → 没有", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-dest-name-"));
  try {
    const script = String.raw`
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin'), (2, 'other', 'hash', 'user')");
      for (const [id, name, ip, userId, ddns] of [[1, "入口机", "203.0.113.1", 1, null], [2, "HK 落地机", "203.0.113.9", 1, "hk.example.test"], [3, "别人的机器", "198.51.100.7", 2, null]]) {
        await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "ddnsDomain") VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, name, ip, ip, "slave", "tok" + id, userId, ddns]);
      }
      await exec('INSERT INTO proxy_nodes (id, name, protocol, address, port, "userId") VALUES (5, ?, ?, ?, ?, 1)', ["SG 节点", "vless", "192.0.2.5", 443]).catch(async () => {
        await exec('INSERT INTO proxy_nodes (id, name, protocol, address, port, "userId", "isEnabled") VALUES (5, ?, ?, ?, ?, 1, 1)', ["SG 节点", "vless", "192.0.2.5", 443]);
      });
      const view = await import(url("server/routeStatusView.ts"));
      const rule = { id: 1, userId: 1, targetIp: "hk.example.test", targetPort: 443 };
      const p = (key, patch = {}) => ({ key, name: key, hops: [], dest: null, destNodeId: null, weight: 50, probe: null, dial: null, issue: null, ...patch });
      const names = await view.routeDestNames(rule, [
        p("node", { destNodeId: 5, dest: { ip: "192.0.2.5", port: 443 } }),
        p("own", { dest: { ip: "203.0.113.9", port: 8443 } }),
        p("ddns"),
        p("foreign", { dest: { ip: "198.51.100.7", port: 443 } }),
        p("unknown", { dest: { ip: "192.0.2.77", port: 443 } }),
      ]);
      console.log("NAMES " + JSON.stringify(Object.fromEntries(names)));
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "names.db"), FORWARDX_LOG_DIR: directory },
      timeout: 120000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const line = result.stdout.split("\n").find((row) => row.startsWith("NAMES "));
    assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(line.slice("NAMES ".length)), { node: "SG 节点", own: "HK 落地机", ddns: "HK 落地机" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
