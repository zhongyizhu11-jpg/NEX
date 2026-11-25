import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  评审 F4：删组时要清的「面板发布过的值」必须在评估锁里读。以前删组先读一份组（锁外），再拿锁清解析：
  正在跑的一轮评估这时刚好往服务商写了新值，删组用的却是写之前的那份 —— 新写的记录没人清，组没了它还在。
  这里让服务商写得慢一点，评估写到一半时删组；两边都完了之后，这个名字上不能留任何面板写的记录。
*/
test("评估正在写服务商时删组：删组等这一轮写完，按写完后的值清掉，不留孤儿记录", () => {
  runInDatabase(String.raw`
    console.info = () => {};
    console.warn = () => {};
    const settings = await import(url("server/repositories/settingsRepository.ts"));
    const service = await import(url("server/services/forwardGroupService.ts"));
    const repo = await import(url("server/db.ts"));
    const fast = await import(url("server/agentFastLiveness.ts"));
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
    assert.equal((await query("SELECT id FROM forward_groups WHERE id = 20")).length, 0);
    assert.deepEqual(records.filter((record) => record.name === "race.example.test").map((record) => record.content), [], "评估写到一半时删组：写上去的记录没人清，组没了它还在");
  `, { name: "group-delete-race" });
});
