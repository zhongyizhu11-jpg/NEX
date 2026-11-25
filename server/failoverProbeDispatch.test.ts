import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 健康探测目标要真的走到 Agent 手里。
 *
 * 这一条盯的是整条链路：面板存的 `failoverProbeTarget` 和备用线路里的
 * `probeIp/probePort`，经过心跳下发之后，必须原样出现在 Agent 的主备规格里。
 *
 * 为什么值得单独测：这条路要穿过 rules.crud 的入参、库表、心跳里那段 actionFailover，
 * 中间任何一处漏掉字段，表现都是**面板上配好了、机器上没生效** —— 而主备是兜底
 * 功能，它悄悄不生效的时候没有任何人会发现，直到真出事那天。
 *
 * 探测目标本身解决的是：Agent 的健康检查就是对出站地址连一次 TCP。中转是
 * iptables/DNAT 时这一连是端到端的；中转是 gost、realm 这类用户态转发时，中转本地
 * 就把连接收下了 —— 连得上只能证明中转活着，证明不了它到落地那段还通。那种情况下
 * 中转的上游断了主备不会切，流量继续往死路里送。
 */

type DispatchedTarget = { targetIp: string; targetPort: number; probeIp?: string; probePort?: number };
type DispatchedSchedule = { timezone: string; windows: Array<{ days: number[]; from: string; to: string; targetIndex: number }> };

function dispatchFailoverSpec(): {
  targets: DispatchedTarget[];
  strategy: string;
  schedule?: DispatchedSchedule;
  minHoldSeconds?: number;
  pinnedIndex?: number;
  pinnedUntil?: number;
} {
  const result = runInDatabase(String.raw`
    const http = (await import("node:http")).default;

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline") VALUES (1, ?, ?, ?, ?, ?, 1, 1)',
      ["入口机", "203.0.113.1", "203.0.113.1", "slave", "tok1"],
    );

    /*
      一条开着主备的 gost 规则：
        主线路  198.51.100.7:443   探测 198.51.100.7:9443
        备用    198.51.100.8:443   探测 198.51.100.8:9443
        备用    198.51.100.9:443   没填探测目标（应当退回探它自己）
    */
    const backups = [
      { targetIp: "198.51.100.8", targetPort: 443, probeIp: "198.51.100.8", probePort: 9443 },
      { targetIp: "198.51.100.9", targetPort: 443 },
    ];
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled",'
        + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverProbeTarget", "failoverSchedule", "failoverMinHoldSeconds",'
        + ' "failoverPinnedIndex", "failoverPinnedUntil", "failoverSeconds", "recoverSeconds", "autoFailback")'
        + ' VALUES (1, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, ?, 600, 2, ?, 30, 90, 1)',
      ["主备规则", "gost", "tcp", 20001, "198.51.100.7", 443, "fallback", JSON.stringify(backups), "198.51.100.7:9443",
        JSON.stringify({ timezone: "Asia/Shanghai", windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }] }),
        Math.floor(Date.now() / 1000) + 3600],
    );

    const express = (await import("express")).default;
    const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const authorization = String(req.headers.authorization || "");
      req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      next();
    });
    heartbeat.registerAgentHeartbeatRoute(app);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = "http://127.0.0.1:" + server.address().port;

    const response = await fetch(base + "/api/agent/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok1" },
      body: JSON.stringify({ agentVersion: "2.3.362", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1 }),
    });
    const body = await response.json();
    server.close();
    if (response.status !== 200) throw new Error("心跳没通: " + response.status);

    const actions = (body.desiredState && body.desiredState.actions) || [];
    const withFailover = actions.find((action) => action && action.failover && action.failover.enabled);
    console.log("FAILOVERSPEC " + JSON.stringify(withFailover ? withFailover.failover : null));
  `, { name: "failover-probe", timeoutMs: 180000 });
  const line = result.stdout.split("\n").find((row) => row.startsWith("FAILOVERSPEC "));
  assert.ok(line, `没拿到下发结果：\n${result.stdout}`);
  const spec = JSON.parse(line.slice("FAILOVERSPEC ".length));
  assert.ok(spec, "心跳里没有开着的主备规格 —— 这条测试的前提就没成立");
  return spec;
}

const spec = dispatchFailoverSpec();

test("主线路的探测目标下发到 Agent", () => {
  const main = spec.targets[0];
  assert.deepEqual(
    { targetIp: main.targetIp, targetPort: main.targetPort, probeIp: main.probeIp, probePort: main.probePort },
    { targetIp: "198.51.100.7", targetPort: 443, probeIp: "198.51.100.7", probePort: 9443 },
    "主线路的探测目标没走到 Agent —— 面板上配好了，机器上还在探出站地址本身",
  );
});

test("备用线路各自的探测目标下发到 Agent", () => {
  assert.deepEqual(
    spec.targets.slice(1).map((target: DispatchedTarget) => ({
      targetIp: target.targetIp, probeIp: target.probeIp ?? null, probePort: target.probePort ?? null,
    })),
    [
      { targetIp: "198.51.100.8", probeIp: "198.51.100.8", probePort: 9443 },
      // 没填探测目标的那条不该被塞上别人的 —— 它探的是自己，也就是老行为。
      { targetIp: "198.51.100.9", probeIp: null, probePort: null },
    ],
    "备用线路的探测目标没走到 Agent",
  );
});

test("线路清单本身没被探测目标搅乱", () => {
  // 主线路排第一、备用按顺序跟在后面，是 fallback 策略的语义依据。
  assert.deepEqual(
    spec.targets.map((target: DispatchedTarget) => `${target.targetIp}:${target.targetPort}`),
    ["198.51.100.7:443", "198.51.100.8:443", "198.51.100.9:443"],
  );
  assert.equal(spec.strategy, "fallback");
});

test("时段表和最短驻留也要下发到 Agent", () => {
  /*
    时段表必须在 Agent 本地判定：面板挂了、网络断了，晚高峰照样得切。漏在面板这边
    的话，表现是「到点了没切」—— 而这正是它唯一该干活的时刻，也是最不容易被发现
    的失效方式（平时一切正常）。
  */
  assert.deepEqual(
    spec.schedule,
    { timezone: "Asia/Shanghai", windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }] },
    "时段表没走到 Agent —— 面板上排好了，机器上到点不会切",
  );
  assert.equal(spec.minHoldSeconds, 600, "最短驻留没走到 Agent，线路会来回抖");
});

test("人工钉住也要下发到 Agent，而且带着期限", () => {
  /*
    没有期限的钉子最危险：应急处理完没人记得关，那条线就一直被钉着，后面所有自动
    切换（包括时段表）全部静默失效，而面板上看不出任何异常。所以期限必须一路带到
    Agent —— 只带序号不带期限的话，到点交回自动这件事根本不会发生。
  */
  assert.equal(spec.pinnedIndex, 2, "钉住的出站序号没走到 Agent");
  assert.ok(
    Number(spec.pinnedUntil) > Date.now(),
    `钉住的期限没走到 Agent（拿到 ${spec.pinnedUntil}）—— 到点不会自动交回`,
  );
});
