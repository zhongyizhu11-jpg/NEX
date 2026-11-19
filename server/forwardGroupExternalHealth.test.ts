import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  转发组 / 入口组评估的两件新事，接着真的库和一个假的 DDNS 服务商（Webhook）跑一遍：

    1. 外部观察 —— 别的成员替面板去探一个成员对外的入口端口；成员自己报告正常但两个观察点持续连不上，
       照样拿掉；成员的 Agent 面板连不上但观察点连得上，继续留在解析里。
    2. 就绪宽限 —— 面板刚启动时内存里的存活状态是旧的，还有成员主机没重新上报之前不把解析换走，
       哪怕别的成员已经先回来了。

  纯判定（票数、观察期、坏掉的观察点不作数……）在 server/forwardGroups/evaluate.test.ts。
*/

const PRELUDE = String.raw`
  import assert from "node:assert/strict";
  import http from "node:http";
  import path from "node:path";
  import { pathToFileURL } from "node:url";

  const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
  const runtime = await import(moduleUrl("server/dbRuntime.ts"));
  const schema = await import(moduleUrl("server/dbSchema.ts"));
  const requests = [];
  const webhook = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(body || "{}"));
      response.writeHead(204);
      response.end();
    });
  });
  // Fetch rejects restricted ports through 10080 before issuing a request.
  while (true) {
    await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (address && typeof address === "object" && address.port > 10080) break;
    await new Promise((resolve) => webhook.close(resolve));
  }
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
  await schema.ensureDatabaseSchema();
  const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
  const groups = await import(moduleUrl("server/db.ts"));
  const fast = await import(moduleUrl("server/agentFastLiveness.ts"));
  const readiness = await import(moduleUrl("server/forwardGroups/readiness.ts"));
  await settings.setSettings({
    ddnsEnabled: "true",
    ddnsProvider: "webhook",
    ddnsWebhookUrl: "http://127.0.0.1:" + webhook.address().port + "/ddns",
    ddnsWebhookMethod: "POST",
  });
  const q = (name) => '"' + name + '"';
  const insert = async (table, columns, values) => {
    await runtime.executeRaw(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
  };
  const now = Math.floor(Date.now() / 1000);
  const groupState = async (id) => (await runtime.queryRaw('SELECT "activeMemberId", "lastDdnsValue", "lastStatus", "lastMessage" FROM "forward_groups" WHERE "id" = ?', [id]))[0];
  // 面板确认一台主机离线要等 90 秒没动静的定时器；测试里直接把内存状态改成「已确认离线」。
  const confirmOffline = (hostId, lastSeenMsAgo) => {
    const state = fast.agentFastLivenessTracker.hosts.get(hostId);
    state.confirmedOffline = true;
    state.offlineAt = Date.now();
    state.lastOfflineAt = Date.now();
    state.lastSeenAt = Date.now() - lastSeenMsAgo;
    state.transitionEpoch += 1000;
  };
  const finish = async () => {
    await runtime.closeDatabase().catch(() => undefined);
    await new Promise((resolve) => webhook.close(resolve));
  };
`;

function runIsolatedScript(name: string, body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `forwardx-${name}-`));
  const scriptPath = path.join(directory, `${name}.mjs`);
  fs.writeFileSync(scriptPath, `${PRELUDE}\ntry {\n${body}\n} finally {\n  await finish();\n}\n`, "utf8");
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.error?.stack || result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("外部观察：观察点连不上的成员被拿掉，面板连不上但访客可达的成员留着", () => {
  runIsolatedScript("group-external-health", String.raw`
    const ips = { 1: "198.51.100.10", 2: "198.51.100.20", 3: "198.51.100.30", 4: "198.51.100.40" };
    for (const id of [1, 2, 3]) {
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [id, "entry-" + id, ips[id], ips[id], 1, 1, now, "2.2.264"]);
      fast.registerPresenceCapableHost(id);
    }
    // 指定的观察主机 4 的 Agent 太旧：不当观察点，界面上提示需要升级
    await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [4, "old-agent", ips[4], ips[4], 1, 1, now, "2.2.200"]);
    await insert(
      "forward_groups",
      ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "failoverSeconds", "recoverSeconds", "peerObserverHostIds"],
      [50, "observed-entry", "host", "entry", "peer.example.test", "A", "0.0.0.0", 1, 1, 10, 10, "[4]"],
    );
    for (const [id, hostId, priority] of [[501, 1, 0], [502, 2, 1], [503, 3, 2]]) {
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled", "healthStatus", "lastCheckedAt"], [id, 50, "host", hostId, priority, 1, "healthy", now]);
    }
    // 用这个入口组的隧道上有一条在跑的规则：访客连的是每台入口的 8443
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "entryGroupId", "mode", "listenPort", "secret", "userId", "isEnabled"], [9, "t", 1, 3, 50, "tls", 30000, "s", 1, 1]);
    await insert(
      "forward_rules",
      ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
      [900, 1, "web", "gost", "tcp", 9, 8443, "203.0.113.10", 80, 1, 1, 1],
    );

    // —— 拓扑：每个成员由另外两台来探它的 8443，外加一个参照目标
    const forHost2 = (await groups.getForwardGroupProbeTopologyForHost(2)).peerHealthProbes;
    assert.deepEqual(
      forHost2.map((probe) => [probe.memberId, probe.targetIp, probe.targetPort, probe.method]).sort(),
      [[0, "www.189.cn", 80, "tcp"], [501, ips[1], 8443, "tcp"], [503, ips[3], 8443, "tcp"]],
    );
    assert.deepEqual((await groups.getForwardGroupProbeTopologyForHost(4)).peerHealthProbes, [], "Agent 太旧的主机不当观察点");

    await groups.runForwardGroupFailover(50);
    assert.deepEqual(requests.at(-1).values, [ips[1], ips[2], ips[3]]);
    let view = (await groups.attachForwardGroupPeerHealth([await groups.getForwardGroupById(50)]))[0];
    assert.deepEqual(view.peerProbe, { active: true, outdatedHosts: [{ id: 4, name: "old-agent" }] });
    assert.equal(view.members[0].peerHealth.label, "外部观察暂无结果");

    // —— 观察点报上来：都连得上
    const report = (memberId, ok) => ({ groupId: 50, memberId, probeType: "peer", method: "tcp", targetIp: ips[memberId - 500], targetPort: 8443, isTimeout: !ok, latencyMs: ok ? 12 : 0 });
    const reference = { groupId: 50, probeType: "peer", method: "tcp", targetIp: "www.189.cn", targetPort: 80, isTimeout: false, latencyMs: 30 };
    assert.equal(await groups.ingestForwardGroupPeerReports(1, [report(502, true), report(503, true), reference]), 3);
    assert.equal(await groups.ingestForwardGroupPeerReports(2, [report(501, true), report(503, true), reference]), 3);
    assert.equal(await groups.ingestForwardGroupPeerReports(3, [report(501, true), report(502, true), reference]), 3);
    // 对不上安排的上报丢掉：不是观察点的主机、探错了端口、探自己
    assert.equal(await groups.ingestForwardGroupPeerReports(4, [report(501, false)]), 0);
    assert.equal(await groups.ingestForwardGroupPeerReports(2, [{ ...report(501, false), targetPort: 22 }, report(502, false)]), 0);
    view = (await groups.attachForwardGroupPeerHealth([await groups.getForwardGroupById(50)]))[0];
    assert.equal(view.members[0].peerHealth.label, "外部观察 2/2 可达");
    assert.deepEqual(view.members[0].peerHealth.observers.map((observer) => [observer.name, observer.status]), [["entry-2", "reachable"], ["entry-3", "reachable"]]);

    // —— 成员 1 自己照常报告健康，但两个观察点从 20 秒前起连不上它的 8443（failoverSeconds = 10）
    const baseline = requests.length;
    await groups.ingestForwardGroupPeerReports(2, [report(501, false)], Date.now() - 20_000);
    await groups.ingestForwardGroupPeerReports(3, [report(501, false)], Date.now() - 20_000);
    // 上报会排一次后台评估（只算结论），要写服务商的交给发布队列：等它发出去
    const deadline = Date.now() + 10_000;
    while (requests.length === baseline && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    await groups.waitForForwardGroupPublishIdle();
    assert.deepEqual(requests.at(-1).values, [ips[2], ips[3]], "外部观察持续连不上的成员要从解析里拿掉");
    let state = await groupState(50);
    assert.equal(state.lastDdnsValue, ips[2] + "," + ips[3]);
    assert.match(state.lastMessage, /1 个入口外部观察连不上/);
    const stored = JSON.parse((await runtime.queryRaw('SELECT "externalHealth" FROM "forward_group_members" WHERE "id" = 501'))[0].externalHealth);
    assert.deepEqual(stored, { down: true, reachedBy: [2, 3] }, "外部判定和「谁连通过它」存在成员行里，面板重启后接着用");
    view = (await groups.attachForwardGroupPeerHealth([await groups.getForwardGroupById(50)]))[0];
    assert.equal(view.members[0].peerHealth.state, "down");
    assert.equal(view.members[0].peerHealth.label, "外部观察 0/2 可达");

    // —— 观察点重新连上：不马上加回，要连续正常满 recoverSeconds
    await groups.ingestForwardGroupPeerReports(2, [report(501, true)]);
    await groups.ingestForwardGroupPeerReports(3, [report(501, true)]);
    const afterRemoval = requests.length;
    await groups.runForwardGroupFailover(50);
    assert.equal(requests.length, afterRemoval, "刚恢复的成员不能立刻加回解析");
    assert.match((await groupState(50)).lastMessage, /1 个入口已恢复，持续正常 10 秒后加回/);
    await runtime.executeRaw('UPDATE "forward_group_members" SET "healthySince" = ? WHERE "id" = 501', [now - 11]);
    await groups.runForwardGroupFailover(50);
    assert.deepEqual(requests.at(-1).values, [ips[1], ips[2], ips[3]], "稳够久之后加回来");
    assert.equal(JSON.parse((await runtime.queryRaw('SELECT "externalHealth" FROM "forward_group_members" WHERE "id" = 501'))[0].externalHealth).down, false);

    // —— 成员 1 的 Agent 面板连不上了（确认离线），但观察点还连得上它：继续发布
    confirmOffline(1, 200_000);
    const beforeOffline = requests.length;
    await groups.runForwardGroupFailover(50);
    assert.equal(requests.length, beforeOffline, "面板连不上但访客可达的成员不能被拿掉");
    state = await groupState(50);
    assert.equal(state.lastDdnsValue, [ips[1], ips[2], ips[3]].join(","));
    assert.match(state.lastMessage, /1 个入口面板连不上但访客可达，继续发布/);
    view = (await groups.attachForwardGroupPeerHealth([await groups.getForwardGroupById(50)]))[0];
    assert.equal(view.members[0].peerHealth.reachableWhileAgentOffline, true);

    // —— 观察点也连不上了：Agent 离线又没人连得上，按离线处理（最后一次见到它是 200 秒前，早过了观察时间）
    await groups.ingestForwardGroupPeerReports(2, [report(501, false)]);
    await groups.ingestForwardGroupPeerReports(3, [report(501, false)]);
    await groups.runForwardGroupFailover(50);
    assert.deepEqual(requests.at(-1).values, [ips[2], ips[3]]);
  `);
});

test("就绪宽限：面板刚启动时，先回来的成员不能把解析抢走", () => {
  runIsolatedScript("group-readiness-grace", String.raw`
    const ips = { 1: "198.51.100.10", 2: "198.51.100.20" };
    // 面板停了十分钟再起来：库里的心跳、健康样本全是十分钟前的，isOnline 还写着在线
    for (const id of [1, 2]) {
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [id, "node-" + id, ips[id], ips[id], 1, 1, now - 600, "2.2.264"]);
    }
    await insert(
      "forward_groups",
      ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue", "failoverSeconds"],
      [60, "failover", "host", "failover", "restart.example.test", "A", "0.0.0.0", 1, 1, 601, ips[1], 10],
    );
    await insert(
      "forward_groups",
      ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "lastDdnsValue", "failoverSeconds", "recoverSeconds", "peerProbeEnabled"],
      [61, "entry", "host", "entry", "restart-entry.example.test", "A", "0.0.0.0", 1, 1, ips[1] + "," + ips[2], 10, 10, 0],
    );
    for (const [id, groupId, hostId, priority] of [[601, 60, 1, 0], [602, 60, 2, 1], [611, 61, 1, 0], [612, 61, 2, 1]]) {
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled", "healthStatus", "lastCheckedAt"], [id, groupId, "host", hostId, priority, 1, "healthy", now - 600]);
    }

    // 调度器启动：记下就绪时刻，把带快速存活的主机登记上（都还没重新上报）
    assert.equal(await groups.primeForwardGroupHostLivenessDeadlines(), 2);
    assert.ok(readiness.forwardGroupPanelReadyAt() > 0);

    await groups.runForwardGroupFailover(60);
    await groups.runForwardGroupFailover(61);
    assert.equal(requests.length, 0, "成员主机还没重新上报之前不能动解析");
    assert.match((await groupState(60)).lastMessage, /面板刚启动或数据库刚恢复：还有 2 台成员主机没重新上报/);

    // 备用成员的主机先回来了：以前这时它「在线」而主成员看着像离线，解析会被它抢走
    fast.registerPresenceCapableHost(2);
    await groups.runForwardGroupFailover(60);
    await groups.runForwardGroupFailover(61);
    assert.equal(requests.length, 0, "还有一台没回来：继续等，不让先回来的那台把解析抢走");
    let state = await groupState(60);
    assert.equal(Number(state.activeMemberId), 601);
    assert.equal(state.lastDdnsValue, ips[1]);
    assert.match(state.lastMessage, /还有 1 台成员主机没重新上报/);
    assert.equal((await groupState(61)).lastDdnsValue, ips[1] + "," + ips[2]);

    // 人工操作不受限制（立即同步、保存组照常生效）—— 这里只确认它不被宽限挡住，结论本身和平时一样
    await groups.runForwardGroupFailover(61, { manual: true });
    assert.doesNotMatch((await groupState(61)).lastMessage, /面板刚启动/);
    await runtime.executeRaw('UPDATE "forward_groups" SET "lastDdnsValue" = ? WHERE "id" = 61', [ips[1] + "," + ips[2]]);
    requests.length = 0;

    // 从就绪算起主机 1 沉默满了离线阈值（90 秒）：确认离线，这时才切走
    readiness.setForwardGroupPanelReadyAtForTests(Date.now() - 91_000);
    confirmOffline(1, 600_000);
    await groups.runForwardGroupFailover(60);
    state = await groupState(60);
    assert.equal(Number(state.activeMemberId), 602);
    assert.equal(state.lastDdnsValue, ips[2]);
    assert.deepEqual(requests.at(-1).values, [ips[2]]);

    // 入口组：主机 2 回来了但它的健康样本还是停机前的（没过期也早该过期）—— 样本宽限里只当「还在等」，不拿掉它；
    // 确认离线的主机 1 拿掉。
    await groups.runForwardGroupFailover(61);
    assert.deepEqual(requests.at(-1).values, [ips[2]], "停机前的旧样本在宽限里不算故障");
    assert.equal(requests.at(-1).domain, "restart-entry.example.test");
  `);
});

test("多实例：观察点连在非持有实例上，结果交给持有实例，持有实例照样凑够两票拿掉成员", () => {
  runIsolatedScript("group-external-health-forward", String.raw`
    const ips = { 1: "198.51.100.10", 2: "198.51.100.20", 3: "198.51.100.30" };
    for (const id of [1, 2, 3]) {
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [id, "entry-" + id, ips[id], ips[id], 1, 1, now, "2.2.264"]);
      fast.registerPresenceCapableHost(id);
    }
    await insert(
      "forward_groups",
      ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "failoverSeconds", "recoverSeconds"],
      [70, "observed-entry", "host", "entry", "peer-multi.example.test", "A", "0.0.0.0", 1, 1, 10, 10],
    );
    for (const [id, hostId, priority] of [[701, 1, 0], [702, 2, 1], [703, 3, 2]]) {
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled", "healthStatus", "lastCheckedAt"], [id, 70, "host", hostId, priority, 1, "healthy", now]);
    }
    await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "entryGroupId", "mode", "listenPort", "secret", "userId", "isEnabled"], [9, "t", 1, 3, 70, "tls", 30000, "s", 1, 1]);
    await insert(
      "forward_rules",
      ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
      [900, 1, "web", "gost", "tcp", 9, 8443, "203.0.113.10", 80, 1, 1, 1],
    );
    const leaseModule = await import(moduleUrl("server/panelLease.ts"));
    const work = await import(moduleUrl("server/panelWorkRequests.ts"));
    const peers = await import(moduleUrl("server/forwardGroups/peerObservations.ts"));
    const store = new leaseModule.SqlPanelLeaseStore();
    const quiet = { info: () => {}, warn: () => {} };
    const makeLease = (instanceId) => new leaseModule.PanelLease({ store, instanceId, logger: quiet, setTimer: () => ({ unref() {} }), clearTimer: () => {} });
    const holder = makeLease("holder");
    const other = makeLease("other");
    await holder.start();
    await other.start();
    await holder.tick();
    leaseModule.setPanelBackgroundLeaseForTests(holder);
    await groups.runForwardGroupFailover(70);
    assert.deepEqual(requests.at(-1).values, [ips[1], ips[2], ips[3]]);

    const report = (memberId, ok) => ({ groupId: 70, memberId, probeType: "peer", method: "tcp", targetIp: ips[memberId - 700], targetPort: 8443, isTimeout: !ok, latencyMs: ok ? 12 : 0 });
    const reference = { groupId: 70, probeType: "peer", method: "tcp", targetIp: "www.189.cn", targetPort: 80, isTimeout: false, latencyMs: 30 };
    // 观察点 2、3 连着持有实例：都连通过成员 1
    await groups.ingestForwardGroupPeerReports(2, [report(701, true), report(703, true), reference]);
    await groups.ingestForwardGroupPeerReports(3, [report(701, true), report(702, true), reference]);
    // 之后观察点 3 换连到了非持有实例：它报的「连不上成员 1」（20 秒前起）只进了那个实例
    await groups.ingestForwardGroupPeerReports(2, [report(701, false)], Date.now() - 20_000);
    leaseModule.setPanelBackgroundLeaseForTests(other);
    const before = requests.length;
    assert.equal(await groups.ingestForwardGroupPeerReports(3, [report(701, false), report(702, true), reference], Date.now() - 20_000), 3);
    const pending = await runtime.queryRaw('SELECT "name" FROM "panel_work_requests" ORDER BY "name"');
    assert.deepEqual(pending.map((row) => row.name), ["forward-group-peer-report:3:70:0", "forward-group-peer-report:3:70:701", "forward-group-peer-report:3:70:702"], "非持有实例收到的结果没交给持有者");
    // 持有实例的内存里没有这一份（两个进程各有各的内存）：把它改回持有实例最后看到的样子（25 秒前连得上）
    peers.forwardGroupPeerObservations.record({ observerHostId: 3, groupId: 70, memberId: 701, portKey: "tcp:8443", ok: true, now: Date.now() - 25_000 });
    assert.equal(peers.forwardGroupPeerObservations.view(3, 70, 701, Date.now()).reachable, true);
    leaseModule.setPanelBackgroundLeaseForTests(holder);
    assert.equal(await work.drainPanelWorkRequests(), 3);
    const view = peers.forwardGroupPeerObservations.view(3, 70, 701, Date.now());
    assert.equal(view.reachable, false);
    assert.ok(Date.now() - view.since >= 19_000, "观察时刻按请求年龄还原（不是持有者收到的时刻）");
    const deadline = Date.now() + 10_000;
    while (requests.length === before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    await groups.waitForForwardGroupPublishIdle();
    assert.deepEqual(requests.at(-1).values, [ips[2], ips[3]], "两个观察点持续连不上成员 1：持有实例要拿掉它");
    leaseModule.setPanelBackgroundLeaseForTests(null);
  `);
});
