import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 停用一条转发时，端口上的**故障转移守护后端**要不要一起清掉。
 *
 * 守护后端是故障转移用的本地兜底进程（`forwardx-realm-guard-<端口>`、
 * `forwardx-socat-guard-<端口>` 等），由 realm / socat 规则在配了故障转移时拉起来，
 * 占着一个本地端口往真实落地转。
 *
 * 面板里有**三条**路径会下发「这条转发别跑了」：用户手动停用、管理员在设置里
 * 关掉整个协议、规则被删除。三条各写各的清理命令，六种转发方式各写一遍 ——
 * 十八段手抄的命令列表，谁也不盯着谁。
 *
 * 这一组就订一件事：**同一种转发方式，三条路径对守护后端的处理必须一致**。
 * 不订绝对值（那会跟着功能变），只订「自己跟自己一致」—— 这才是能拦住抄漏的那条。
 */

type GuardCounts = Record<string, number>;

function guardCleanupCounts(protocolsEnabled: boolean): GuardCounts {
  const result = runInDatabase(String.raw`
    const http = (await import("node:http")).default;

    const TYPES = ["iptables", "nftables", "realm", "socat", "nginx", "gost"];
    const enabled = process.env.PROTOCOLS_ENABLED === "1";
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline") VALUES (1, ?, ?, ?, ?, ?, 1, 1)',
      ["入口机", "203.0.113.1", "203.0.113.1", "slave", "tok1"],
    );
    await exec(
      "INSERT INTO system_settings (key, value) VALUES (?, ?)",
      ["forwardProtocols", JSON.stringify(Object.fromEntries(TYPES.map((t) => [t, enabled])))],
    );

    // 六条一模一样的规则，只有转发方式不同：都已停用，但 Agent 还报着在跑。
    const localRules = [];
    let id = 0;
    for (const forwardType of TYPES) {
      id += 1;
      await exec(
        'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning")'
          + ' VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1, 0, 1)',
        [id, forwardType + "-停用", forwardType, "tcp", 20000 + id, "198.51.100.7", 443],
      );
      localRules.push({ port: 20000 + id, protocol: "tcp", ruleId: id, forwardType });
    }

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

    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok1" },
      // 不报 localState 的话面板认为「Agent 还没说话」，会直接把规则标成停了而不下发清理。
      body: JSON.stringify({
        agentVersion: "2.3.362", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1,
        localState: { rules: localRules, services: [], tunnels: [] },
      }),
    });
    const body = await response.json();
    server.close();
    if (response.status !== 200) throw new Error("心跳没通: " + response.status);

    const counts = {};
    for (const forwardType of TYPES) counts[forwardType] = 0;
    for (const action of (body.desiredState && body.desiredState.actions) || []) {
      const ruleId = Number(action.ruleId || 0);
      if (ruleId <= 0) continue;
      counts[TYPES[ruleId - 1]] = (action.commands || [])
        .map(String)
        .filter((command) => command.includes("guard"))
        .length;
    }
    console.log("GUARD " + JSON.stringify(counts));
  `, { name: "guard-cleanup", env: { PROTOCOLS_ENABLED: protocolsEnabled ? "1" : "0" } });
  const line = result.stdout.split("\n").find((row) => row.startsWith("GUARD "));
  assert.ok(line, `没拿到计数：\n${result.stdout}`);
  return JSON.parse(line.slice("GUARD ".length)) as GuardCounts;
}

/** 用户手动停用（协议还开着）。 */
const byUser = guardCleanupCounts(true);
/** 管理员把整个协议关掉 —— 另一条清理路径，同样是「这条转发别跑了」。 */
const byProtocolOff = guardCleanupCounts(false);

test("两条停用路径对守护后端的处理必须一致", () => {
  /*
    这一条是这组的**本体**。原来 nginx 在这里是 0 对 5：用户手动停用不清守护后端，
    管理员关协议才清。也就是说一条 realm 转发改成 nginx 的同时被停用（改类型那一步
    的 apply 根本不会跑），它的守护进程就永远留在机器上占着本地端口往老落地转 ——
    面板上那条规则显示「已停用」，看不出机器上还有东西在跑。

    不订绝对条数（那会跟着功能变），只订自己跟自己一致。
  */
  assert.deepEqual(
    byUser,
    byProtocolOff,
    "同一种转发方式，手动停用和关协议这两条路径清理的守护后端不一样 —— 少清的那条会在机器上留下占着端口的进程",
  );
});

test("用户态转发都要清守护后端，内核态不用", () => {
  /*
    守护后端只由 realm / socat 规则拉起来，但清理是**按端口**做的：同一个端口
    以前跑过带故障转移的 realm，后来换成别的用户态方式，老守护进程还在。所以
    四种用户态方式都得清，不能只清「自己会创建守护后端」的那两种。

    内核态（iptables / nftables）不进程、不占端口，本来就没有守护后端这回事。
  */
  for (const forwardType of ["realm", "socat", "nginx", "gost"]) {
    assert.ok(
      byUser[forwardType] > 0,
      `${forwardType} 停用时一条守护后端清理都没下发`,
    );
  }
  for (const forwardType of ["iptables", "nftables"]) {
    assert.equal(byUser[forwardType], 0, `${forwardType} 是内核态转发，不该有守护后端要清`);
  }
});
