import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  P6：删主备组 / 入口组要把面板发过的解析记录清掉，而且只清面板自己写的。

  用一个假的 Cloudflare（内存里的记录表）跑：
    1. 主备组发布了 198.51.100.1；同一个名字上还有一条别人手动加的 203.0.113.99。删组后前者没了、后者还在。
    2. 入口组发布了两台；删组后两条都没了。
    3. 自动解析关着的组：面板从没替它写过，删组时一条请求都不发。
    4. 服务商报错：组照样删掉，面板日志里留一条「请手动删除」。
*/
test("删除主备组 / 入口组：清掉面板发布的解析记录，别人加的不动，清不掉不拦删除", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-delete-ddns-"));
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
    const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
    const service = await import(moduleUrl("server/services/forwardGroupService.ts"));
    const repo = await import(moduleUrl("server/db.ts"));
    const panelLogger = await import(moduleUrl("server/_core/panelLogger.ts"));
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);

    // 假 Cloudflare：records 是服务商那边的全部记录。
    let records = [];
    let nextId = 1;
    let failDeletes = false;
    const calls = [];
    globalThis.fetch = async (rawUrl, init = {}) => {
      const url = new URL(String(rawUrl));
      const method = String(init.method || "GET").toUpperCase();
      calls.push(method + " " + url.pathname);
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
      const id = url.pathname.split("/dns_records/")[1];
      if (method === "GET") {
        const name = url.searchParams.get("name");
        const type = url.searchParams.get("type");
        return json({ success: true, result: records.filter((record) => record.name === name && record.type === type) });
      }
      if (method === "POST") {
        const payload = JSON.parse(String(init.body));
        const record = { id: "r" + nextId++, name: payload.name, type: payload.type, content: payload.content };
        records.push(record);
        return json({ success: true, result: record });
      }
      if (method === "PUT") {
        const payload = JSON.parse(String(init.body));
        const record = records.find((item) => item.id === id);
        record.content = payload.content;
        return json({ success: true, result: record });
      }
      if (method === "DELETE") {
        if (failDeletes) return json({ success: false, errors: [{ message: "provider is down" }] }, 500);
        records = records.filter((item) => item.id !== id);
        return json({ success: true, result: { id } });
      }
      return json({ success: false }, 400);
    };
    await settings.setSettings({ ddnsEnabled: "true", ddnsProvider: "cloudflare", ddnsCloudflareZoneId: "zone-1", ddnsCloudflareApiToken: "token-1" });

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')");
    for (const [id, ip] of [[1, "198.51.100.1"], [2, "198.51.100.2"]]) {
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, 1, 1, ?)', [id, "h" + id, ip, ip, now]);
      // 在线 = 连着面板、有快速存活状态（没有的算离线，见 server/forwardGroups/liveness.ts）
      (await import(moduleUrl("server/agentFastLiveness.ts"))).registerPresenceCapableHost(id);
    }
    const addGroup = async (id, mode, domain, autoResolve = 1) => {
      await exec(
        'INSERT INTO forward_groups (id, name, "groupType", "groupMode", domain, "recordType", "targetIp", "userId", "isEnabled", "ddnsAutoResolveEnabled") VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, mode + id, "host", mode, domain, "A", "0.0.0.0", autoResolve],
      );
      for (const [index, hostId] of [1, 2].entries()) {
        // 入口组只发布健康的成员：直接写成已经稳定健康了 5 分钟。
        await exec(
          'INSERT INTO forward_group_members ("groupId", "memberType", "hostId", priority, "isEnabled", "healthStatus", "lastCheckedAt", "healthySince") VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
          [id, "host", hostId, index, "healthy", now, now - 300],
        );
      }
      await repo.runForwardGroupFailover(id);
    };
    const contents = (name) => records.filter((record) => record.name === name).map((record) => record.content).sort();
    const exists = async (id) => (await query('SELECT id FROM forward_groups WHERE id = ?', [id])).length > 0;

    // 1. 主备组
    await addGroup(10, "failover", "fo.example.test");
    assert.deepEqual(contents("fo.example.test"), ["198.51.100.1"], "主备组发布第一台");
    records.push({ id: "manual-1", name: "fo.example.test", type: "A", content: "203.0.113.99" });
    await service.deleteForwardGroupWithImpact(10, true);
    assert.equal(await exists(10), false);
    assert.deepEqual(contents("fo.example.test"), ["203.0.113.99"], "面板发的那条清掉了，手动加的那条不是面板写的，留着");

    // 2. 入口组
    await addGroup(11, "entry", "entry.example.test");
    assert.deepEqual(contents("entry.example.test"), ["198.51.100.1", "198.51.100.2"]);
    await service.deleteForwardGroupWithImpact(11, true);
    assert.deepEqual(contents("entry.example.test"), [], "入口组发布的两条都清掉");

    // 3. 自动解析关着：面板没写过，也不删
    records.push({ id: "manual-2", name: "manual.example.test", type: "A", content: "198.51.100.1" });
    await addGroup(12, "entry", "manual.example.test", 0);
    calls.length = 0;
    await service.deleteForwardGroupWithImpact(12, true);
    assert.deepEqual(calls, [], "自动解析关着的组删除时不碰服务商");
    assert.deepEqual(contents("manual.example.test"), ["198.51.100.1"]);

    // 4. 清不掉不拦删除
    await addGroup(13, "failover", "broken.example.test");
    failDeletes = true;
    await service.deleteForwardGroupWithImpact(13, true);
    assert.equal(await exists(13), false, "服务商报错，组照样删掉");
    const logs = (await panelLogger.getPanelLogs()).map((entry) => String(entry.message || JSON.stringify(entry)));
    assert.ok(logs.some((line) => /转发组已删除，但.*没清掉，请到 DNS 服务商手动删除.*broken\.example\.test/.test(line)), logs.slice(-5).join("\n"));
    console.log("OK");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "delete.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
