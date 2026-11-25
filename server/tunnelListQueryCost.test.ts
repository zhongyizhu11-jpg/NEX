import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 隧道列表页打多少次库，以及打完之后内容对不对。
 *
 * 这一页原来是**每行三次**：一次取中继跳、一次取额外落地节点、一次取主机。
 * 翻一页 12 行就是 41 条，而 pageSize 上限是 100 —— 一次翻页三百多条，
 * 页面还在轮询。批量版本仓库里早就有（心跳路由和可用性汇总都在用），只有这里
 * 还在循环。
 *
 * 所以这一组钉两件事：
 *   1. **条数不随页大小涨** —— 这才是真正拦 N+1 的那条。只订绝对值的话，
 *      一个「每行多查一次」的写法在小页上照样能过。
 *   2. **批量之后内容没变** —— 省了不等于对。按 tunnelId 分组要是写错，
 *      隧道会显示成没有中继链，而页面上看不出来：它只是少画几个节点。
 */

type Probe = {
  cost: Record<string, { queries: number; rows: number }>;
  page: any;
};

function runProbe(): Probe {
  const result = runInDatabase(String.raw`
    // 钩子挂在建库之前：drizzle 的和裸 SQL 的语句都从 prepare 过。
    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    let statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    for (let h = 1; h <= 12; h++) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
        [h, "机器" + h, "10.0.0." + h, "10.0.0." + h, "slave", "tok" + h, h % 3 === 0 ? 0 : 1, Math.floor(Date.now() / 1000)],
      );
    }
    for (let t = 1; t <= 10; t++) {
      await exec(
        'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", secret, "userId", "isEnabled", "relayMode")'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [t, "隧道" + t, ((t - 1) % 12) + 1, (t % 12) + 1, t % 2 ? "tls" : "forwardx", 30000 + t, "s" + t, t % 3 === 0 ? "failover" : "chain"],
      );
    }
    // 1-3 号带四跳中继，其中一跳配了 connectHost
    let hopId = 0;
    for (const t of [1, 2, 3]) {
      for (let seq = 0; seq < 4; seq++) {
        hopId += 1;
        await exec(
          'INSERT INTO tunnel_hops (id, "tunnelId", seq, "hostId", "listenPort", "mimicPort", "connectHost") VALUES (?, ?, ?, ?, ?, 0, ?)',
          [hopId, t, seq, ((seq + t) % 12) + 1, 31000 + hopId, seq === 1 ? ("relay" + hopId + ".example.com") : null],
        );
      }
    }
    // 6 号第一跳的 hostId 是 0（坏数据），用来钉住下面那条不对称
    await exec('INSERT INTO tunnel_hops (id, "tunnelId", seq, "hostId", "listenPort", "mimicPort", "connectHost") VALUES (90, 6, 0, 0, 31900, 0, ?)', ["bad.example.com"]);
    await exec('INSERT INTO tunnel_hops (id, "tunnelId", seq, "hostId", "listenPort", "mimicPort", "connectHost") VALUES (91, 6, 1, 5, 31901, 0, NULL)');
    await exec('INSERT INTO tunnel_hops (id, "tunnelId", seq, "hostId", "listenPort", "mimicPort", "connectHost") VALUES (92, 6, 2, 7, 31902, 0, NULL)');
    // 4-5 号带额外落地节点，其中一个是停用的
    let nodeId = 0;
    for (const t of [4, 5]) {
      for (let seq = 0; seq < 3; seq++) {
        nodeId += 1;
        await exec(
          'INSERT INTO tunnel_exit_nodes (id, "tunnelId", seq, "hostId", "listenPort", "connectHost", "isEnabled") VALUES (?, ?, ?, ?, ?, ?, ?)',
          [nodeId, t, seq, ((seq + t) % 12) + 1, 32000 + nodeId, seq === 0 ? ("exit" + nodeId + ".example.com") : null, seq === 2 ? 0 : 1],
        );
      }
    }

    const tunnelsRouter = (await import(url("server/routers/tunnels.ts"))).tunnelsRouter;
    const context = () => ({
      user: { id: 1, role: "admin", username: "admin" },
      req: { headers: {} },
      res: { setHeader: () => {} },
    });
    const listPage = (pageSize) => tunnelsRouter.createCaller(context()).listPage({ page: 1, pageSize, search: "" });

    const cost = {};
    for (const pageSize of [1, 2, 4, 12]) {
      await listPage(pageSize);            // 预热：一次性开销先发生
      statements = []; recording = true;
      const result = await listPage(pageSize);
      recording = false;
      cost["pageSize=" + pageSize] = { queries: statements.length, rows: result.items.length };
    }

    const page = await listPage(12);
    const scrub = (value) => JSON.parse(JSON.stringify(value, (key, item) =>
      (key === "lastHeartbeat" || key === "createdAt" || key === "updatedAt" || key === "lastTestAt") ? "<ts>" : item));
    console.log("TUNNELCOST " + JSON.stringify({ cost, page: scrub(page) }));
  `, { name: "tunnel-cost" });
  const line = result.stdout.split("\n").find((row) => row.startsWith("TUNNELCOST "));
  assert.ok(line, `没拿到探测结果：\n${result.stdout}`);
  return JSON.parse(line.slice("TUNNELCOST ".length)) as Probe;
}

const probe = runProbe();
const tunnelById = new Map<number, any>(probe.page.items.map((item: any) => [Number(item.id), item]));

test("隧道列表的打库次数不随页大小增长", () => {
  const counts = Object.values(probe.cost).map((entry) => entry.queries);
  const first = counts[0];
  assert.ok(
    counts.every((count) => count === first),
    `每页行数从 1 涨到 12，打库次数却在变：${JSON.stringify(probe.cost)}`
      + "（这就是 N+1：每多一行多查一次，pageSize 上限 100 时会放大一百倍）",
  );
  // 绝对值也订一个上限，挡住数量级的劣化。相对基准会跟着劣化一起漂，等于没订。
  assert.ok(first <= 12, `隧道列表一次打库 ${first} 次，超了预算 12`);
  assert.equal(probe.cost["pageSize=12"].rows, 10, "测试数据里应当有 10 条隧道");
});

test("批量取回之后，多跳中继链仍然完整", () => {
  const tunnel = tunnelById.get(1);
  assert.deepEqual(tunnel.hopHostIds, [2, 3, 4, 5], "四跳的顺序和内容都要保持 seq 顺序");
  assert.deepEqual(tunnel.hopHosts.map((host: any) => host.id), [2, 3, 4, 5], "跳上的主机要按跳的顺序挂好");
  assert.deepEqual(tunnel.hopConnectHosts, [null, "relay2.example.com", null, null]);
  // 分组写错最典型的症状就是「串台」：别的隧道的跳挂到这条上。
  assert.deepEqual(tunnelById.get(2).hopHostIds, [3, 4, 5, 6]);
  assert.deepEqual(tunnelById.get(3).hopHostIds, [4, 5, 6, 7]);
  // 没有中继的隧道不该凭空长出跳来。
  assert.deepEqual(tunnelById.get(10).hopHostIds, []);
  assert.deepEqual(tunnelById.get(10).hopHosts, []);
});

test("跳里的坏 hostId 只影响主机列表，不影响 connectHost 列表", () => {
  /*
    这两个列表的过滤规则**故意不一样**：hopHostIds 会先滤掉 hostId <= 0 再判「够不够两跳」，
    而 hopConnectHosts 不滤，原样保留每一跳的位置。位置对不上的话，界面上
    「第二跳走哪个域名」就会错位到第一跳去。

    改成批量取回时这是最容易顺手抹平的一条 —— 两个列表长度不同看着像 bug。
  */
  const tunnel = tunnelById.get(6);
  assert.deepEqual(tunnel.hopHostIds, [5, 7], "hostId 为 0 的那跳要被滤掉");
  assert.equal(tunnel.hopConnectHosts.length, 3, "connectHost 列表要保留全部三跳的位置");
  assert.equal(tunnel.hopConnectHosts[0], "bad.example.com", "被滤掉的那跳的 connectHost 仍在原位");
});

test("批量取回之后，额外落地节点仍然完整", () => {
  const exits = tunnelById.get(4).loadBalanceExits;
  assert.deepEqual(exits.map((node: any) => node.id), [1, 2, 3], "要按 seq 顺序");
  assert.deepEqual(exits.map((node: any) => node.hostId), [5, 6, 7]);
  assert.deepEqual(exits.map((node: any) => node.isEnabled), [true, true, false], "停用的落地节点也要返回，由前端决定怎么显示");
  assert.equal(exits[0].connectHost, "exit1.example.com");
  assert.equal(exits[0].host.name, "机器5", "节点上的主机要挂好");
  // 别的隧道的落地节点不该串过来。
  assert.deepEqual(tunnelById.get(5).loadBalanceExits.map((node: any) => node.id), [4, 5, 6]);
  assert.deepEqual(tunnelById.get(1).loadBalanceExits, []);
});

test("主机的在线状态是算出来的，不是直接读库", () => {
  // 批量取主机要和逐个取一样跑 withComputedOnline，否则整页的绿点红点全错。
  const tunnel = tunnelById.get(1);
  assert.equal(tunnel.entryHost.isOnline, true);
  assert.equal(tunnel.hopHosts.find((host: any) => host.id === 3).isOnline, false, "3 号机器在库里是离线的");
});
