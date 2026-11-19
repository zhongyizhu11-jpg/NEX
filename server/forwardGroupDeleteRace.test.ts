import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  评审 F4：删组时要清的「面板发布过的值」必须在评估锁里读。以前删组先读一份组（锁外），再拿锁清解析：
  正在跑的一轮评估这时刚好往服务商写了新值，删组用的却是写之前的那份 —— 新写的记录没人清，组没了它还在。
  这里让服务商写得慢一点，评估写到一半时删组；两边都完了之后，这个名字上不能留任何面板写的记录。
*/
test("评估正在写服务商时删组：删组等这一轮写完，按写完后的值清掉，不留孤儿记录", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-delete-race-"));
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
    const fast = await import(moduleUrl("server/agentFastLiveness.ts"));
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);

    let records = [];
    let nextId = 1;
    let postStarted = null;
    const postSeen = new Promise((resolve) => { postStarted = resolve; });
    globalThis.fetch = async (rawUrl, init = {}) => {
      const url = new URL(String(rawUrl));
      const method = String(init.method || "GET").toUpperCase();
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
      const id = url.pathname.split("/dns_records/")[1];
      if (method === "GET") {
        return json({ success: true, result: records.filter((record) => record.name === url.searchParams.get("name") && record.type === url.searchParams.get("type")) });
      }
      if (method === "POST") {
        postStarted();
        // 服务商慢：写一条要 300 毫秒
        await new Promise((resolve) => setTimeout(resolve, 300));
        const payload = JSON.parse(String(init.body));
        const record = { id: "r" + nextId++, name: payload.name, type: payload.type, content: payload.content };
        records.push(record);
        return json({ success: true, result: record });
      }
      if (method === "DELETE") {
        records = records.filter((item) => item.id !== id);
        return json({ success: true, result: { id } });
      }
      return json({ success: false }, 400);
    };
    await settings.setSettings({ ddnsEnabled: "true", ddnsProvider: "cloudflare", ddnsCloudflareZoneId: "zone-1", ddnsCloudflareApiToken: "token-1" });
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')");
    for (const [id, ip] of [[1, "198.51.100.1"], [2, "198.51.100.2"]]) {
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, 1, 1, ?)', [id, "h" + id, ip, ip, now]);
      fast.registerPresenceCapableHost(id);
    }
    await exec('INSERT INTO forward_groups (id, name, "groupType", "groupMode", domain, "recordType", "targetIp", "userId", "isEnabled") VALUES (20, ?, ?, ?, ?, ?, ?, 1, 1)', ["race", "host", "entry", "race.example.test", "A", "0.0.0.0"]);
    for (const [index, hostId] of [1, 2].entries()) {
      await exec('INSERT INTO forward_group_members ("groupId", "memberType", "hostId", priority, "isEnabled", "healthStatus", "lastCheckedAt", "healthySince") VALUES (20, ?, ?, ?, 1, ?, ?, ?)', ["host", hostId, index, "healthy", now, now - 300]);
    }

    // 第一次发布：服务商写到一半时删组
    const evaluation = repo.runForwardGroupFailover(20);
    await postSeen;
    const deletion = service.deleteForwardGroupWithImpact(20, true);
    await Promise.all([evaluation.catch(() => undefined), deletion]);
    assert.equal((await runtime.queryRaw("SELECT id FROM forward_groups WHERE id = 20")).length, 0);
    assert.deepEqual(records.filter((record) => record.name === "race.example.test").map((record) => record.content), [], "评估写到一半时删组：写上去的记录没人清，组没了它还在");
    console.log("OK");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "race.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
