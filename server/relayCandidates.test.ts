import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 「从中转里选一条」这个清单，得给对人、给对料。
 *
 * 备用线路原来是手填 `地址:端口`。面板其实认得这些中转 —— 它们就是一条条指向落地的
 * 转发规则。把候选列出来省掉手填只是顺带，真正要紧的是**连带的那几个字段**：
 * 转发方式（决定健康检查有没有盲区）、它自己指向哪个落地（决定和主线路配不配对）。
 * 没有这些，界面只能干巴巴地列地址，用户还是看不出对错。
 *
 * 这一组盯两件事：不该出现的别出现（关掉的、UDP 的、没入口地址的、自己），
 * 以及该带的字段一个不少。
 */

type Candidate = {
  id: number;
  label: string;
  hostName: string;
  address: string;
  forwardType: string;
  userspaceRelay: boolean;
  targetIp: string;
  targetPort: number;
};

function listCandidates(role: "admin" | "user", userId: number, protocol?: "tcp" | "udp" | "both"): Candidate[] {
  const result = runInDatabase(String.raw`
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'h', 'user')");

    // 3 号机归管理员，但租户的规则跑在上面 —— 按量计费资源就是这个形状。
    const hosts = [
      [1, "中转A", "203.0.113.1", 2],
      [2, "中转B", "203.0.113.2", 2],
      [3, "计费机", "203.0.113.3", 1],
      [4, "没地址的机器", "", 2],
    ];
    for (const [id, name, ip, owner] of hosts) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline") VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
        [id, name, ip, ip, "slave", "tok" + id, owner],
      );
    }

    const rules = [
      // id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled
      [1, 1, "香港→洛杉矶", "iptables", "tcp", 20001, "198.51.100.7", 443, 2, 1],
      [2, 2, "东京→洛杉矶", "gost", "tcp", 20002, "198.51.100.7", 443, 2, 1],
      [3, 3, "计费机→洛杉矶", "nftables", "tcp", 20003, "198.51.100.7", 443, 2, 1],
      [4, 1, "关掉的", "iptables", "tcp", 20004, "198.51.100.7", 443, 2, 0],
      [5, 1, "只走 UDP", "iptables", "udp", 20005, "198.51.100.7", 443, 2, 1],
      [6, 4, "机器没入口地址", "iptables", "tcp", 20006, "198.51.100.7", 443, 2, 1],
      [7, 1, "管理员自己的", "iptables", "tcp", 20007, "198.51.100.7", 443, 1, 1],
    ];
    for (const row of rules) {
      await exec(
        'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled")'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        row,
      );
    }

    const { rulesRouter } = await import(url("server/routers/rules.ts"));
    const caller = rulesRouter.createCaller({
      req: { headers: {} },
      res: { clearCookie() {} },
      user: { id: Number(process.env.CALLER_ID), username: "u", role: process.env.CALLER_ROLE, accountEnabled: true },
      authSession: null,
      authFailureReason: null,
    });
    const protocol = process.env.CANDIDATE_PROTOCOL || undefined;
    console.log("CANDIDATES " + JSON.stringify(await caller.relayCandidates(protocol ? { excludeRuleId: 1, protocol } : { excludeRuleId: 1 })));
  `, { name: "relay-candidates", env: { CALLER_ROLE: role, CALLER_ID: String(userId), CANDIDATE_PROTOCOL: protocol || "" }, timeoutMs: 180000 });
  const line = result.stdout.split("\n").find((row) => row.startsWith("CANDIDATES "));
  assert.ok(line, `没拿到候选清单：\n${result.stdout}`);
  return JSON.parse(line.slice("CANDIDATES ".length)) as Candidate[];
}

const tenant = listCandidates("user", 2);

test("不该当备用线路的都不出现在清单里", () => {
  const ids = tenant.map((candidate) => candidate.id).sort((left, right) => left - right);
  assert.deepEqual(
    ids,
    [2, 3],
    "清单应当只剩 2（东京中转）和 3（计费机上的中转）。\n"
      + "1 号是正在编辑的这条规则本身（选自己当自己的备用线路没有意义）；\n"
      + "4 号已关掉（选了等于配一条一定连不上的备用线路）；\n"
      + "5 号只走 UDP（没说协议时按 TCP 规则挑，它接不住 TCP）；\n"
      + "6 号所在的机器没有入口地址（拼不出 地址:端口）；\n"
      + "7 号是别人的规则。\n"
      + `实际拿到 ${JSON.stringify(tenant, null, 2)}`,
  );
});

test("租户跑在管理员机器上的规则也要列出来", () => {
  /*
    租户的规则可以跑在管理员的按量计费主机上。主机按「归属」取的话这些中转会整批
    消失，而用户在自己的规则行上明明看得见它们 —— 那种消失最难排查：界面上什么都
    没说，只是少了几个选项。
  */
  const billing = tenant.find((candidate) => candidate.id === 3);
  assert.ok(billing, "计费机上的中转没有出现在候选里");
  assert.equal(billing.hostName, "计费机");
  assert.equal(billing.address, "203.0.113.3:20003");
});

test("转发方式和它自己的落地要带上 —— 界面全靠这两样说人话", () => {
  const userspace = tenant.find((candidate) => candidate.id === 2)!;
  assert.equal(userspace.forwardType, "gost");
  assert.equal(userspace.userspaceRelay, true, "gost 是用户态转发，探测只能确认中转在线");
  assert.equal(userspace.targetIp, "198.51.100.7");
  assert.equal(userspace.targetPort, 443);

  const kernel = tenant.find((candidate) => candidate.id === 3)!;
  assert.equal(kernel.userspaceRelay, false, "nftables 是 DNAT，握手是和落地完成的");
  assert.equal(kernel.hostName, "计费机");
  assert.equal(kernel.label, "计费机→洛杉矶");
});

test("管理员看得到所有人的中转", () => {
  const admin = listCandidates("admin", 1);
  assert.ok(
    admin.some((candidate) => candidate.id === 7),
    "管理员应当看得到自己的规则（7 号），租户那份清单里不该有它",
  );
  assert.equal(tenant.some((candidate) => candidate.id === 7), false);
});

test("UDP、TCP+UDP 规则挑中转：只列接得住这个协议的", () => {
  assert.deepEqual(
    listCandidates("user", 2, "udp").map((candidate) => candidate.id),
    [5],
    "UDP 规则只能接到走 UDP 的中转上；只走 TCP 的 2、3 号接不住",
  );
  assert.deepEqual(
    listCandidates("user", 2, "both").map((candidate) => candidate.id),
    [],
    "TCP+UDP 要两样都接得住，这份数据里没有这样的中转",
  );
});
