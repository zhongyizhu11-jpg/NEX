import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

import { combinePortPolicies, describePortPolicy, isPortAllowedByPolicy, portPolicyFrom } from "@shared/portPolicy";

/**
 * 「这个端口允不允许」只能有一处说了算。
 *
 * 新建转发的对话框要显示「允许端口范围」，以前它自己照着算了一份：
 * 主机策略和隧道范围**直接求交**。服务端用的是 combineHostPortPolicyWithRange，
 * 它在「隧道范围恰好等于主机范围」时会保留主机的完整策略 —— 求交则会把主机
 * 白名单里那些额外端口吃掉。
 *
 * 后果不止是提示文案不准：界面判定超范围时会**直接返回、连请求都不发**，
 * 用户就被硬拦在一个服务端明明放行的端口上。界面那份还完全不知道套餐端口段
 * 的存在，于是反过来又会放行一个服务端要拒的端口，用户点了提交才被打回。
 */

const HOST_RANGE_START = 22600;
const HOST_RANGE_END = 22600;
const HOST_EXTRA_PORT = 23001;
const PLAN_ONLY_PORT = 22601;

test("界面以前那套算法，和服务端在同一个主机上结论不一样", () => {
  // 这一条不碰数据库，纯粹把两种算法摆在一起，说明为什么界面不能自己算。
  const host = {
    portRangeStart: HOST_RANGE_START,
    portRangeEnd: HOST_RANGE_END,
    portAllowlist: String(HOST_EXTRA_PORT),
  };
  const tunnelRange = { portRangeStart: HOST_RANGE_START, portRangeEnd: HOST_RANGE_END };

  const oldClientPolicy = combinePortPolicies(portPolicyFrom(host), portPolicyFrom(tunnelRange));
  assert.equal(
    isPortAllowedByPolicy(HOST_EXTRA_PORT, oldClientPolicy),
    false,
    `界面那套求交本来就会吃掉主机白名单端口（算出来是 ${describePortPolicy(oldClientPolicy)}）；`
      + "这条断言要是变成 true，说明共享算法改了，下面服务端那条也该跟着重新核对",
  );
});

type Probe = {
  policyText: string;
  allowsHostExtra: boolean;
  allowsPlanOnly: boolean;
  checkExtra: { used: boolean; reason?: string | null };
  checkOutside: { used: boolean; reason?: string | null };
};

function runProbe(): Probe {
  const result = runInDatabase(String.raw`
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "portRangeStart", "portRangeEnd", "portAllowlist")'
        + ' VALUES (1, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)',
      ["入口机", "10.0.0.1", "10.0.0.1", "slave", "tok1", ${HOST_RANGE_START}, ${HOST_RANGE_END}, "${HOST_EXTRA_PORT}"],
    );
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline") VALUES (2, ?, ?, ?, ?, ?, 1, 1)',
      ["出口机", "10.0.0.2", "10.0.0.2", "slave", "tok2"],
    );
    // 隧道范围**恰好等于**主机范围 —— 正是两种算法分道扬镳的那一格。
    await exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", secret, "userId", "isEnabled", "portRangeStart", "portRangeEnd")'
        + ' VALUES (1, ?, 1, 2, ?, 30000, ?, 1, 1, ?, ?)',
      ["隧道", "tls", "s1", ${HOST_RANGE_START}, ${HOST_RANGE_END}],
    );

    const rulesRouter = (await import(url("server/routers/rules.ts"))).rulesRouter;
    const context = () => ({
      user: { id: 1, role: "admin", username: "admin" },
      req: { headers: {} },
      res: { setHeader: () => {} },
    });
    const caller = () => rulesRouter.createCaller(context());
    const shared = await import(url("shared/portPolicy.ts"));

    const { policy } = await caller().entryPortPolicy({ hostId: 1, tunnelId: 1 });
    const checkExtra = await caller().checkPort({ hostId: 1, tunnelId: 1, sourcePort: ${HOST_EXTRA_PORT} });
    const checkOutside = await caller().checkPort({ hostId: 1, tunnelId: 1, sourcePort: 40000 });

    console.log("ENTRYPOLICY " + JSON.stringify({
      policyText: shared.describePortPolicy(policy),
      allowsHostExtra: shared.isPortAllowedByPolicy(${HOST_EXTRA_PORT}, policy),
      allowsPlanOnly: shared.isPortAllowedByPolicy(${PLAN_ONLY_PORT}, policy),
      checkExtra,
      checkOutside,
    }));
  `, { name: "entry-port-policy" });
  const line = result.stdout.split("\n").find((row) => row.startsWith("ENTRYPOLICY "));
  assert.ok(line, `没拿到探测结果：\n${result.stdout}`);
  return JSON.parse(line.slice("ENTRYPOLICY ".length)) as Probe;
}

const probe = runProbe();

test("服务端给界面的策略，和服务端自己放行的端口是同一套", () => {
  assert.equal(
    probe.allowsHostExtra,
    true,
    `主机白名单里的 ${HOST_EXTRA_PORT} 必须在给界面的策略里（拿到的是 ${probe.policyText}）`
      + " —— 界面就是照这个显示、也照这个判超范围的",
  );
  assert.equal(
    probe.checkExtra.used,
    false,
    `checkPort 放行了 ${HOST_EXTRA_PORT}，给界面的策略就不能把它排除在外：${probe.checkExtra.reason ?? ""}`,
  );
  assert.equal(probe.allowsPlanOnly, false, `${PLAN_ONLY_PORT} 不在主机范围里，不该被放行`);
});

test("范围外的端口，checkPort 要把原因说清楚", () => {
  assert.equal(probe.checkOutside.used, true, "40000 在允许范围外，应当被拒");
  assert.ok(
    /必须在允许范围内/.test(String(probe.checkOutside.reason || "")),
    `拒绝时要带上原因，界面直接显示这句话，拿到的是：${probe.checkOutside.reason}`,
  );
  assert.ok(
    String(probe.checkOutside.reason || "").includes(String(HOST_EXTRA_PORT)),
    `原因里要写清完整的允许范围（含白名单端口），拿到的是：${probe.checkOutside.reason}`,
  );
});
