import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 「这台机器算不算在线」只能有一套判定。
 *
 * 三个条件缺一不可：库里那个 isOnline（上一次写入的结论）、心跳还新鲜（那个结论
 * 会过期，而它不会自己变）、快速失联没有确认掉线（Agent 那条实时通道最新）。
 *
 * 这三条原来在两处各写一遍 —— 仓储读出来时折算一次，Telegram 状态通知那边又写
 * 一次。判的是同一件事，漂了就会出现「列表上是绿的、机器人刚发过掉线通知」，
 * 而这种不一致没人查得出来是哪一边错。
 */
test("SQLite 主机在线判定：列表与状态通知走同一套", () => {
  runInDatabase(String.raw`
    const hostRepo = await import(url("server/repositories/hostRepository.ts"));
    const notifier = await import(url("server/hostStatusNotifier.ts"));
    const { HOST_ONLINE_TTL_MS } = await import(url("shared/hostHeartbeat.ts"));

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    const addHost = (id, name, isOnline, heartbeatMs) => exec(
      'INSERT INTO hosts (id, name, ip, "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, "203.0.113." + id, "tok" + id, 1, isOnline, heartbeatMs === null ? null : Math.floor(heartbeatMs / 1000)],
    );

    const now = Date.now();
    await addHost(1, "心跳新鲜", 1, now);
    await addHost(2, "心跳过期", 1, now - HOST_ONLINE_TTL_MS - 60_000);
    await addHost(3, "库里就是离线", 0, now);
    await addHost(4, "从没有过心跳", 1, null);

    const rows = await hostRepo.getHosts();
    const byId = new Map(rows.map((row) => [Number(row.id), row]));

    const expected = { 1: true, 2: false, 3: false, 4: false };
    for (const [id, want] of Object.entries(expected)) {
      const host = byId.get(Number(id));
      assert.equal(!!host.isOnline, want, "列表把 " + host.name + " 判错了");
      assert.equal(
        notifier.isHostStatusOnline({ ...host, lastHeartbeat: host.lastHeartbeat }),
        want,
        "状态通知对「" + host.name + "」的判定和列表不一致：会出现列表是绿的、机器人刚发过掉线通知",
      );
    }

    /**
     * 通知那一路拿到的往往是**原始行**（没经过 withComputedOnline 折算），
     * 所以要拿原始 isOnline 再核一遍：心跳过期的那台，原始行里 isOnline 仍是 1。
     */
    const raw = await query('SELECT id, name, "isOnline", "lastHeartbeat" FROM hosts ORDER BY id');
    const rawStale = raw.find((row) => Number(row.id) === 2);
    assert.equal(Number(rawStale.isOnline), 1, "原始行里它还写着在线 —— 正是这一点让两套判定容易漂");
    assert.equal(
      notifier.isHostStatusOnline(rawStale),
      false,
      "拿原始行判定时必须自己再验一次心跳，不能只信库里那一列",
    );
  `, { name: "host-online" });
});
