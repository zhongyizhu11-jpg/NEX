import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 取一个转发组的详情，打多少次库，以及取回来的东西对不对。
 *
 * 这个函数是路由、规则校验、故障转移巡检共用的底座。它原来给**每个成员**都单独
 * 查一次主机：entryAddress 一次、ddnsValue 再一次，隧道成员还要先查隧道再查主机。
 * 于是故障转移巡检（每 5 分钟一轮）按组数线性打库 —— 实测 25 个组 276 次，其中
 * 200 次就是在这儿一条条查主机。
 *
 * 所以这一组钉两件事：
 *   1. **条数不随成员数涨** —— 这才是真正拦 N+1 的那条。只订绝对值的话，
 *      一个「每成员多查一次」的写法在小组上照样能过。
 *   2. **批量之后取回来的没变** —— 省了不等于对。三种记录类型、隧道成员、
 *      查不到的主机，都得和原来逐个查时一模一样。
 */

type Probe = {
  cost: Record<string, number>;
  members: Record<string, Array<{ id: number; entryAddress: string; ddnsValue: string; hasHostField: boolean }>>;
};

function runProbe(): Probe {
  const result = runInDatabase(String.raw`
    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    let statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    // 甲：手填入口地址 + DDNS 域名；乙：只有 IPv4；丙：什么地址都没有
    await exec('INSERT INTO hosts (id, name, ip, ipv4, ipv6, "entryIp", "tunnelEntryIp", "ddnsEnabled", "ddnsDomain", "hostType", "agentToken", "userId", "isOnline") VALUES (1, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, 1)',
      ["甲", "1.2.3.4", "1.2.3.4", "2001:db8::1", "entry.example.com", "10.0.0.1", "ddns.example.com", "slave", "t1"]);
    await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline") VALUES (2, ?, ?, ?, ?, ?, 1, 0)', ["乙", "5.6.7.8", "5.6.7.8", "slave", "t2"]);
    await exec('INSERT INTO hosts (id, name, ip, "hostType", "agentToken", "userId", "isOnline") VALUES (3, ?, ?, ?, ?, 1, 1)', ["丙", "", "slave", "t3"]);
    for (let i = 10; i < 40; i++) {
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline") VALUES (?, ?, ?, ?, ?, ?, 1, 1)',
        [i, "填充" + i, "10.1.0." + i, "10.1.0." + i, "slave", "tok" + i]);
    }
    await exec('INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", secret, "userId", "isEnabled") VALUES (1, ?, 1, 2, ?, 30000, ?, 1, 1)', ["隧道", "tls", "s"]);

    // 三个组分别用三种记录类型，成员形态相同
    for (const [gid, recordType] of [[1, "A"], [2, "AAAA"], [3, "CNAME"]]) {
      await exec("INSERT INTO forward_groups (id, name, groupType, groupMode, targetIp, targetPort, userId, isEnabled, recordType) VALUES (?, ?, 'host', 'failover', '127.0.0.1', 80, 1, 1, ?)", [gid, "组" + gid, recordType]);
      await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority, isEnabled) VALUES (?, ?, 'host', 1, 0, 1)", [gid * 100 + 1, gid]);
      await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority, isEnabled) VALUES (?, ?, 'host', 2, 10, 1)", [gid * 100 + 2, gid]);
      await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority, isEnabled) VALUES (?, ?, 'host', 3, 20, 0)", [gid * 100 + 3, gid]);
      await exec("INSERT INTO forward_group_members (id, groupId, memberType, tunnelId, priority, isEnabled) VALUES (?, ?, 'tunnel', 1, 30, 1)", [gid * 100 + 4, gid]);
      await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority, isEnabled) VALUES (?, ?, 'host', 999, 40, 1)", [gid * 100 + 5, gid]);
    }
    // 第 4 个组：成员类型和 1 号组**完全一样**，只是主机成员多了 30 个。
    // 类型不一样的话条数本来就不可比（没有隧道成员就少一次隧道查询），
    // 那样比出来的差异说明不了任何问题。
    await exec("INSERT INTO forward_groups (id, name, groupType, groupMode, targetIp, targetPort, userId, isEnabled, recordType) VALUES (4, '大组', 'host', 'failover', '127.0.0.1', 80, 1, 1, 'A')");
    await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority, isEnabled) VALUES (401, 4, 'host', 1, 0, 1)");
    await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority, isEnabled) VALUES (402, 4, 'host', 2, 10, 1)");
    await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority, isEnabled) VALUES (403, 4, 'host', 3, 20, 0)");
    await exec("INSERT INTO forward_group_members (id, groupId, memberType, tunnelId, priority, isEnabled) VALUES (404, 4, 'tunnel', 1, 30, 1)");
    await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority, isEnabled) VALUES (405, 4, 'host', 999, 40, 1)");
    for (let i = 10; i < 40; i++) {
      await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority, isEnabled) VALUES (?, 4, 'host', ?, ?, 1)", [400 + i + 10, i, 100 + i]);
    }

    const db = await import(url("server/db.ts"));
    const cost = {};
    const members = {};
    for (const [label, gid] of [["成员5", 1], ["成员35", 4]]) {
      await db.getForwardGroupById(gid);          // 预热：一次性开销先发生
      statements = []; recording = true;
      const group = await db.getForwardGroupById(gid);
      recording = false;
      cost[label] = statements.length;
      members[label] = (group.members || []).map((m) => ({
        id: Number(m.id), entryAddress: m.entryAddress, ddnsValue: m.ddnsValue,
        hasHostField: Object.prototype.hasOwnProperty.call(m, "host"),
      }));
    }
    for (const [label, gid] of [["AAAA", 2], ["CNAME", 3]]) {
      const group = await db.getForwardGroupById(gid);
      members[label] = (group.members || []).map((m) => ({
        id: Number(m.id), entryAddress: m.entryAddress, ddnsValue: m.ddnsValue,
        hasHostField: Object.prototype.hasOwnProperty.call(m, "host"),
      }));
    }
    console.log("GROUPDETAIL " + JSON.stringify({ cost, members }));
  `, { name: "group-detail" });
  const line = result.stdout.split("\n").find((row) => row.startsWith("GROUPDETAIL "));
  assert.ok(line, `没拿到探测结果：\n${result.stdout}`);
  return JSON.parse(line.slice("GROUPDETAIL ".length)) as Probe;
}

const probe = runProbe();

test("取转发组详情的打库次数不随成员数增长", () => {
  assert.equal(
    probe.cost["成员35"],
    probe.cost["成员5"],
    `成员从 5 个涨到 35 个（类型组合一样），打库次数从 ${probe.cost["成员5"]} 变成 ${probe.cost["成员35"]}`
      + " —— 这就是 N+1：每多一个成员多查一次主机。故障转移巡检每 5 分钟把所有组过一遍，"
      + "这里多一次，那边就乘以组数。",
  );
  assert.ok(probe.cost["成员5"] <= 6, `取一个组的详情打了 ${probe.cost["成员5"]} 次库，超了预算 6`);
});

test("批量取回之后，各种成员的入口地址还是原来那个", () => {
  const byId = new Map(probe.members["成员5"].map((member) => [member.id, member]));
  // 手填的入口地址优先于上报的 IP
  assert.equal(byId.get(101)!.entryAddress, "entry.example.com");
  // 没手填就用上报的
  assert.equal(byId.get(102)!.entryAddress, "5.6.7.8");
  // 什么都没有就给空串，不是 undefined，也不该抛
  assert.equal(byId.get(103)!.entryAddress, "");
  // 隧道成员落到隧道的入口主机上
  assert.equal(byId.get(104)!.entryAddress, "entry.example.com", "隧道成员要取到隧道入口主机的地址");
  // 主机已经不在了：给空串，别让整个组取不出来
  assert.equal(byId.get(105)!.entryAddress, "", "查不到的主机要降级成空串");
});

test("三种记录类型的 ddnsValue 各算各的", () => {
  const value = (label: string, id: number) =>
    probe.members[label].find((member) => member.id === id)!.ddnsValue;
  // A 记录取 IPv4
  assert.equal(value("成员5", 101), "1.2.3.4");
  // AAAA 取 IPv6
  assert.equal(value("AAAA", 201), "2001:db8::1");
  // CNAME 取域名 —— 手填的入口地址不是 IP 时，它本身就是 CNAME 目标
  assert.equal(value("CNAME", 301), "entry.example.com");
  // 隧道成员同样按记录类型走
  assert.equal(value("AAAA", 204), "2001:db8::1");
  // 取不到主机的，三种类型都给空串
  for (const label of ["成员5", "AAAA", "CNAME"]) {
    assert.equal(value(label, label === "成员5" ? 105 : label === "AAAA" ? 205 : 305), "");
  }
});

test("详情里的成员不带 host 这一层", () => {
  /*
    批量那个函数本来是给列表页用的，会给每个成员挂一个 host 对象。详情这条路
    没有挂过 —— 它的返回结构是路由、校验、故障转移一大票地方在吃的，凭空多一层
    主机数据既撑大响应，也可能把主机字段漏给不该看的人。
  */
  for (const member of probe.members["成员5"]) {
    assert.equal(member.hasHostField, false, `成员 ${member.id} 多带了 host 字段`);
  }
});
