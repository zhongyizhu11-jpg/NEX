import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  探测样本攒批写（server/dbWriteBatcher.ts）接到真实的 SQLite 库上：
  - 隧道的「最近一次测试」几列立刻更新，历史行晚一点才落库；
  - 读「最新一条」的查询自己先刷，调用方看不出延迟；
  - 五类上报（隧道延迟、转发组延迟、TCPing、主机探测服务、探测计数快照）都能落到各自的表里，
    排队时定下的 recordedAt 不会因为晚落库而变晚。
*/
test("SQLite: probe sample reports still land, tunnel last-status columns update at once", () => {
  runInDatabase(String.raw`
    const metrics = await import(url("server/repositories/metricsRepository.ts"));
    const probes = await import(url("server/repositories/hostProbeServiceRepository.ts"));
    const counters = await import(url("server/repositories/probeCounterRepository.ts"));
    const tunnelsRepo = await import(url("server/repositories/tunnelRepository.ts"));
    const batcher = await import(url("server/dbWriteBatcher.ts"));
    assert.equal(batcher.isWriteBatchingEnabled(), true, "测试默认就开着攒批");
    // 定时器放远一点，看清楚每一步是谁把行写进去的
    batcher.configureWriteBatcher({ batchMs: 60_000 });
    const count = async (table, where = "1 = 1", params = []) => Number((await query('SELECT COUNT(*) AS "n" FROM "' + table + '" WHERE ' + where, params))[0].n);

    await runtime.insertAndGetId("users", { id: 1, username: "admin", password: "x", role: "admin" });
    for (let id = 1; id <= 2; id++) {
      await runtime.insertAndGetId("hosts", { id, name: "host-" + id, ip: "192.0.2." + id, userId: 1, agentToken: "token-" + id });
    }
    await runtime.insertAndGetId("tunnels", { id: 7, name: "t7", entryHostId: 1, exitHostId: 2, userId: 1, listenPort: 4007, mode: "tls", isRunning: true });
    await runtime.insertAndGetId("forward_groups", { id: 9, name: "g9", userId: 1 }).catch(() => undefined);
    await runtime.insertAndGetId("host_probe_services", { id: 3, name: "dns", method: "tcping", targetIp: "192.0.2.53", targetPort: 53, intervalSeconds: 60, userId: 1 });

    // 1. 隧道延迟：状态列立刻变，历史行先在队列里
    const t0 = Math.floor(Date.now() / 1000);
    await metrics.insertTunnelLatencyStat({ tunnelId: 7, latencyMs: 42, isTimeout: false, seriesKey: "total" }, { message: "ok" });
    const tunnel = await tunnelsRepo.getTunnelById(7);
    assert.equal(tunnel.lastLatencyMs, 42, "lastLatencyMs 立刻更新");
    assert.equal(tunnel.lastTestStatus, "success");
    assert.equal(tunnel.lastTestMessage, "ok");
    assert.equal(await count("tunnel_latency_stats"), 0, "历史行还在队列里");
    assert.equal(batcher.pendingWriteCount("tunnel_latency_stats"), 1);
    // 读最新一条：自己先刷
    const latest = await metrics.getLatestTunnelLatencies([7]);
    assert.equal(latest.get(7).latencyMs, 42);
    assert.equal(await count("tunnel_latency_stats"), 1);
    assert.equal(batcher.pendingWriteCount("tunnel_latency_stats"), 0);
    // 超时样本同样：状态列立刻 failed，行稍后
    await metrics.insertTunnelLatencyStat({ tunnelId: 7, latencyMs: null, isTimeout: true }, { preserveMessage: true });
    assert.equal((await tunnelsRepo.getTunnelById(7)).lastTestStatus, "failed");
    assert.equal(await count("tunnel_latency_stats"), 1);
    const series = await metrics.getTunnelLatencySeries(7);
    assert.equal(series.length, 2);
    assert.equal(series[1].isTimeout, true);

    // 2. recordedAt 在排队时就定下：等 1.2 秒再刷，行的时间还是排队那一刻
    await metrics.insertTcpingStats([
      { ruleId: 11, hostId: 1, latencyMs: 5, isTimeout: false, probeCount: 3, probeSuccesses: 3 },
      { ruleId: 12, hostId: 1, latencyMs: null, isTimeout: true, probeCount: 3, probeSuccesses: 0 },
    ]);
    const queuedAt = Math.floor(Date.now() / 1000);
    assert.equal(batcher.pendingWriteCount("tcping_stats"), 2);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await batcher.flushPendingWrites("tcping_stats");
    const tcping = await query('SELECT "ruleId", "latencyMs", "isTimeout", "probeSuccesses", "recordedAt" FROM "tcping_stats" ORDER BY "id"');
    assert.equal(tcping.length, 2);
    assert.equal(Number(tcping[0].latencyMs), 5);
    assert.equal(Number(tcping[1].isTimeout), 1);
    assert.ok(Number(tcping[0].recordedAt) >= t0 && Number(tcping[0].recordedAt) <= queuedAt, "recordedAt 是排队时间，不是落库时间");
    // 读 TCPing 的查询自己先刷
    await metrics.insertTcpingStats([{ ruleId: 12, hostId: 1, latencyMs: null, isTimeout: true, probeCount: 3, probeSuccesses: 0 }]);
    assert.equal(batcher.pendingWriteCount("tcping_stats"), 1);
    await metrics.getUnreachableRuleIds([12]);
    assert.equal(await count("tcping_stats"), 3);
    assert.equal(batcher.pendingWriteCount("tcping_stats"), 0);

    // 3. 转发组延迟、主机探测服务、探测计数快照：读之前自己刷
    await metrics.insertForwardGroupLatencyStat({ groupId: 9, latencyMs: 30, isTimeout: false, probeCount: 1, probeSuccesses: 1 });
    assert.equal(await count("forward_group_latency_stats"), 0);
    assert.equal((await metrics.getForwardGroupLatencySeries(9)).length, 1);
    assert.equal(await count("forward_group_latency_stats"), 1);

    await probes.insertHostProbeServiceStats([{ serviceId: 3, hostId: 1, latencyMs: 8, isTimeout: false, probeCount: 1, probeSuccesses: 1 }]);
    assert.equal(await count("host_probe_service_stats"), 0);
    const latestProbe = await probes.getLatestHostProbeServiceStats([3]);
    assert.equal(latestProbe.get(3).latencyMs, 8);
    assert.equal(await count("host_probe_service_stats"), 1);

    const snapshot = counters.probeCounterSnapshot("rule", 11, 1, { probeCounterEpoch: "epoch-1", probeCount: 3, probeSuccesses: 3, probeTotalCount: 30, probeTotalSuccesses: 29 });
    await counters.insertProbeCounterSnapshots([snapshot, snapshot], new Date((t0 - 60) * 1000));
    await counters.insertProbeCounterSnapshots([snapshot], new Date(t0 * 1000));
    assert.equal(await count("probe_counter_snapshots"), 0);
    const stats = await counters.getProbeCounterStatistics("rule", 11, new Date((t0 - 600) * 1000));
    assert.equal(stats.total, 3, "重复的快照行靠 ON CONFLICT 吞掉，统计不重复算");
    assert.equal(await count("probe_counter_snapshots"), 1);

    // 4. 删除路径先刷：清隧道历史时，队列里的那一行也一起清掉
    await metrics.insertTunnelLatencyStat({ tunnelId: 7, latencyMs: 50, isTimeout: false }, { preserveMessage: true, updateTunnel: false });
    assert.equal(batcher.pendingWriteCount("tunnel_latency_stats"), 1);
    await tunnelsRepo.clearTunnelTestSnapshot(7, { clearHistory: true });
    assert.equal(await count("tunnel_latency_stats", '"tunnelId" = 7'), 0);
    assert.equal(batcher.pendingWriteCount(), 0);

    // 5. 事务里写（手动测隧道的结算就在事务里）：排着的旧样本先写进同一个事务，id 跟时间同序，
    //    按 MAX(id) 取的「最新一条」是事务里这条新的
    await metrics.insertTunnelLatencyStat({ tunnelId: 7, latencyMs: 70, isTimeout: false, seriesKey: "total" }, { preserveMessage: true });
    assert.equal(batcher.pendingWriteCount("tunnel_latency_stats"), 1);
    await runtime.withDatabaseTransaction(async () => {
      await metrics.insertTunnelLatencyStat({ tunnelId: 7, latencyMs: 80, isTimeout: false, seriesKey: "total" }, { message: "manual" });
    });
    assert.equal(batcher.pendingWriteCount("tunnel_latency_stats"), 0);
    const ordered = await query('SELECT "latencyMs" FROM "tunnel_latency_stats" WHERE "tunnelId" = 7 ORDER BY "id"');
    assert.deepEqual(ordered.map((row) => Number(row.latencyMs)), [70, 80]);
    assert.equal((await metrics.getLatestTunnelLatencies([7])).get(7).latencyMs, 80);
    assert.equal((await tunnelsRepo.getTunnelById(7)).lastTestMessage, "manual");

    // 6. 删主机在事务里（deleteHostWithChecks 就是这样）：这台主机排着的样本写进同一个事务、跟着一起删掉
    await probes.insertHostProbeServiceStats([{ serviceId: 3, hostId: 2, latencyMs: 9, isTimeout: false, probeCount: 1, probeSuccesses: 1 }]);
    await metrics.insertTcpingStats([{ ruleId: 21, hostId: 2, latencyMs: 4, isTimeout: false, probeCount: 1, probeSuccesses: 1 }]);
    assert.equal(batcher.pendingWriteCount(), 2);
    const hostsRepo = await import(url("server/repositories/hostRepository.ts"));
    await runtime.withDatabaseTransaction(() => hostsRepo.deleteHost(2));
    assert.equal(batcher.pendingWriteCount(), 0, "排着的行没有留到删完之后再写");
    assert.equal(await count("host_probe_service_stats", '"hostId" = 2'), 0);
    assert.equal(await count("tcping_stats", '"ruleId" = 21'), 1, "别的表的行照常落库（这条规则不归这台主机的规则表管）");
    assert.equal(await count("hosts", '"id" = 2'), 0);

    // 7. 关掉攒批：回到立刻写
    batcher.configureWriteBatcher({ batchMs: 0 });
    await metrics.insertTunnelLatencyStat({ tunnelId: 7, latencyMs: 60, isTimeout: false }, { preserveMessage: true });
    assert.equal(await count("tunnel_latency_stats", '"tunnelId" = 7'), 3);
    assert.equal(batcher.pendingWriteCount(), 0);
  `, { name: "write-batcher-sqlite", quiet: true });
});
