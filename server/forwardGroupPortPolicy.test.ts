import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

import { combinePortPolicies, isPortAllowedByPolicy, portPolicyFrom } from "@shared/portPolicy";

/**
 * 转发组的「允许端口范围」：界面显示的那一份，必须就是服务端判定用的那一份。
 *
 * 组里每个占端口的成员各有一份策略，服务端原本是**逐个成员**判，而且这段
 * 循环在仓库里存在三份（取范围、找可用端口、校验规则各一份）。界面那边则
 * 完全没有这份答案，转发组模式下一直显示「不限制」—— 用户填一个组里某台
 * 机器不允许的端口，界面一路绿灯，点提交才被打回。
 */

test("逐个成员都放行 ≡ 合并后的策略放行", () => {
  /*
    这条是上面那次抽取的地基：把「逐个成员判」换成「合并后判一次」，前提是
    两者等价。不验就换，等于拿线上的判定结果赌一个想当然。

    随机造成员策略（不限制 / 纯范围 / 纯白名单 / 范围+白名单+多段），
    逐端口比对两种算法。
  */
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const randomSource = () => {
    const shape = (rnd() * 4) | 0;
    const start = 1 + ((rnd() * 60) | 0);
    const end = start + ((rnd() * 30) | 0);
    if (shape === 0) return {};
    if (shape === 1) return { portRangeStart: start, portRangeEnd: end };
    if (shape === 2) return { portAllowlist: [start, end, start + 7].join(",") };
    return {
      portRangeStart: start,
      portRangeEnd: end,
      portAllowlist: String(end + 5),
      portRanges: [{ start: start + 2, end: start + 4 }],
    };
  };

  let bothAllow = 0;
  let bothDeny = 0;
  for (let round = 0; round < 2000; round += 1) {
    const members = Array.from({ length: 1 + ((rnd() * 4) | 0) }, () => portPolicyFrom(randomSource()));
    const combined = combinePortPolicies(...members);
    for (let port = 1; port <= 100; port += 1) {
      const everyMember = members.every((policy) => isPortAllowedByPolicy(port, policy));
      const viaCombined = isPortAllowedByPolicy(port, combined);
      assert.equal(
        everyMember,
        viaCombined,
        `端口 ${port}：逐个成员=${everyMember}，合并后=${viaCombined} —— `
          + "两者不等价的话，「合并一次判完」这个改法就是错的",
      );
      if (everyMember) bothAllow += 1;
      else bothDeny += 1;
    }
  }
  // 两种结果都要有足够样本，否则这条可能是在比两个恒假
  assert.ok(bothAllow > 5000 && bothDeny > 5000, `样本太偏：放行 ${bothAllow} 拒绝 ${bothDeny}`);
});

type Probe = {
  policyText: string;
  allows: Record<string, boolean>;
  checks: Record<string, { used: boolean; reason?: string | null }>;
};

function runProbe(): Probe {
  const result = runInDatabase(String.raw`
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    // 两台成员机，允许范围**部分重叠**：只有交集里的端口才是真正可用的。
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "portRangeStart", "portRangeEnd")'
        + ' VALUES (1, ?, ?, ?, ?, ?, 1, 1, 20000, 20100)',
      ["甲", "10.0.0.1", "10.0.0.1", "slave", "tok1"],
    );
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "portRangeStart", "portRangeEnd")'
        + ' VALUES (2, ?, ?, ?, ?, ?, 1, 1, 20050, 20200)',
      ["乙", "10.0.0.2", "10.0.0.2", "slave", "tok2"],
    );
    await exec("INSERT INTO forward_groups (id, name, groupType, groupMode, targetIp, userId, isEnabled) VALUES (9, '负载组', 'host', 'balance', '127.0.0.1', 1, 1)");
    await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority, isEnabled) VALUES (91, 9, 'host', 1, 10, 1), (92, 9, 'host', 2, 20, 1)");

    const rulesRouter = (await import(url("server/routers/rules.ts"))).rulesRouter;
    const context = () => ({
      user: { id: 1, role: "admin", username: "admin" },
      req: { headers: {} },
      res: { setHeader: () => {} },
    });
    const caller = () => rulesRouter.createCaller(context());
    const shared = await import(url("shared/portPolicy.ts"));

    const { policy } = await caller().entryPortPolicy({ forwardGroupId: 9 });
    const ports = { 只在甲: 20010, 交集里: 20080, 只在乙: 20150, 两边都不在: 30000 };
    const allows = {};
    const checks = {};
    for (const [label, port] of Object.entries(ports)) {
      allows[label] = shared.isPortAllowedByPolicy(port, policy);
      checks[label] = await caller().checkPort({ forwardGroupId: 9, sourcePort: port });
    }
    console.log("GROUPPOLICY " + JSON.stringify({
      policyText: shared.describePortPolicy(policy),
      allows,
      checks,
    }));
  `, { name: "group-port-policy" });
  const line = result.stdout.split("\n").find((row) => row.startsWith("GROUPPOLICY "));
  assert.ok(line, `没拿到探测结果：\n${result.stdout}`);
  return JSON.parse(line.slice("GROUPPOLICY ".length)) as Probe;
}

const probe = runProbe();

test("转发组给界面的范围，就是各成员的交集", () => {
  assert.equal(
    probe.allows["交集里"],
    true,
    `两台机器都允许的端口必须放行（拿到的范围是 ${probe.policyText}）`,
  );
  assert.equal(probe.allows["只在甲"], false, `只有甲允许的端口不该出现在组的范围里（${probe.policyText}）`);
  assert.equal(probe.allows["只在乙"], false, `只有乙允许的端口不该出现在组的范围里（${probe.policyText}）`);
  assert.equal(probe.allows["两边都不在"], false, "两边都不允许的端口当然不该放行");
});

test("界面拿到的范围，和 checkPort 的判定完全一致", () => {
  for (const label of Object.keys(probe.allows)) {
    const allowedByPolicy = probe.allows[label];
    const rejectedByCheck = probe.checks[label].used;
    assert.equal(
      allowedByPolicy,
      !rejectedByCheck,
      `「${label}」这个端口上两边对不上：界面范围=${allowedByPolicy ? "放行" : "拒绝"}，`
        + `checkPort=${rejectedByCheck ? "拒绝" : "放行"}（${probe.checks[label].reason ?? ""}）`,
    );
  }
});

test("被拒时给出的原因，写的是真正的允许范围", () => {
  const reason = String(probe.checks["只在甲"].reason || "");
  assert.ok(reason.includes("20050") && reason.includes("20100"),
    `原因里要写清交集范围（20050-20100），拿到的是：${reason}`);
});
