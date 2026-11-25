import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  presence 每次查的那一行主机（hostRepository.getHostAgentPresenceById）改成了固定文本的裸语句：
  三种库返回的布尔 / 时间列形态不同（SQLite 0/1 + 秒，PostgreSQL 布尔 + 可能是字符串的整数），
  这里对着 Drizzle 路径（getHostById）核对字段形状，并确认 SQLite 上语句文本固定、命中预编译缓存。
  设了 FORWARDX_TEST_DB_KIND=postgresql 时在 PostgreSQL 上也跑一遍。
*/
test("presence host lookup returns the same liveness fields as the ORM path on every dialect", () => {
  runInDatabase(String.raw`
    const hostsRepo = await import(url("server/repositories/hostRepository.ts"));
    await exec('INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)', [1, "admin", "x", "admin"]);
    const heartbeatSeconds = Math.floor(Date.now() / 1000) - 7;
    await exec(
      'INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "ipv6", "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [11, "online-host", "198.51.100.11", "198.51.100.11", "2001:db8::11", "slave", "token-11", 1, 1, heartbeatSeconds],
    );
    await exec(
      'INSERT INTO "hosts" ("id", "name", "ip", "hostType", "agentToken", "userId", "isOnline") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [12, "never-seen", "198.51.100.12", "slave", "token-12", 1, 0],
    );

    const online = await hostsRepo.getHostAgentPresenceById(11);
    assert.deepEqual(Object.keys(online).sort(), ["id", "ip", "ipv4", "ipv6", "isOnline", "lastHeartbeat", "name"]);
    assert.equal(online.id, 11);
    assert.equal(online.name, "online-host");
    assert.equal(online.ip, "198.51.100.11");
    assert.equal(online.ipv4, "198.51.100.11");
    assert.equal(online.ipv6, "2001:db8::11");
    assert.equal(online.isOnline, true, "布尔列是真正的 boolean，不是 0/1 或 't'");
    assert.ok(online.lastHeartbeat instanceof Date, "时间列是 Date");
    assert.equal(Math.floor(online.lastHeartbeat.getTime() / 1000), heartbeatSeconds);

    // 和 Drizzle 路径读出来的同一行一致
    const viaOrm = await hostsRepo.getHostById(11);
    assert.equal(online.isOnline, viaOrm.isOnline);
    assert.equal(online.lastHeartbeat.getTime(), new Date(viaOrm.lastHeartbeat).getTime());
    assert.equal(online.name, viaOrm.name);

    const offline = await hostsRepo.getHostAgentPresenceById(12);
    assert.equal(offline.isOnline, false);
    assert.equal(offline.lastHeartbeat, null, "没心跳过就是 null");
    assert.equal(offline.ipv4, null);
    assert.equal(offline.ipv6, null);

    assert.equal(await hostsRepo.getHostAgentPresenceById(404), undefined);
    assert.equal(await hostsRepo.getHostAgentPresenceById(0), undefined);
    assert.equal(await hostsRepo.getHostAgentPresenceById(Number.NaN), undefined);

    // 写了心跳之后再查，读到的是库里最新的结论（不能有缓存：wasOnline 要看这次请求之前的状态）
    await hostsRepo.touchHostHeartbeat(12);
    const touched = await hostsRepo.getHostAgentPresenceById(12);
    assert.equal(touched.isOnline, true);
    assert.ok(touched.lastHeartbeat instanceof Date);
    assert.ok(Date.now() - touched.lastHeartbeat.getTime() < 10_000);

    skipUnless("sqlite");
    // SQLite：语句文本固定，第二次起命中预编译缓存
    const before = runtime.getSqliteStatementCacheSize();
    await hostsRepo.getHostAgentPresenceById(11);
    await hostsRepo.getHostAgentPresenceById(12);
    assert.equal(runtime.getSqliteStatementCacheSize(), before, "同一条语句不再新编译");
  `, { name: "presence-host-lookup", quiet: true });
});
