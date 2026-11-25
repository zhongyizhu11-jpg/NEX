import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * Agent 报上来的主备切换，面板要收得下、也要拦得住。
 *
 * 规则级主备是**数据面**的：Agent 每 5 秒探一次、自己在出站之间切，毫秒级，不经过
 * 面板。好处是快，而且面板挂了也照常工作；代价是切换这件事原来只留在机器本地的日志
 * 里 —— 面板一无所知。而主备恰恰是「平时看不出来、出事才知道有没有用」的东西：切了
 * 没人知道，没切更没人知道。
 *
 * 所以 Agent 把切换和健康翻转攒着随心跳带回来。这一组盯两件事：
 *
 *   · 报上来的事件真的落进面板日志，而且带着「从哪条到哪条、为什么、当时多少延迟」。
 *     只写「切了」的话，查起来和没有一样。
 *   · **不是这台机器的规则一律丢掉**。Agent 的令牌只代表它自己那台机器，一台被攻陷
 *     的机器不能往别人的规则上写记录 —— 那会让面板日志本身变成不可信的东西。
 */

type Ingested = { logs: string[] };

function ingestFailoverEvents(): Ingested {
  const result = runInDatabase(String.raw`
    const http = (await import("node:http")).default;

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    for (const [id, token] of [[1, "tok1"], [2, "tok2"]]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline") VALUES (?, ?, ?, ?, ?, ?, 1, 1)',
        [id, "机" + id, "203.0.113." + id, "203.0.113." + id, "slave", token],
      );
    }
    // 1 号规则在 1 号机上，2 号规则在**另一台**机器上。
    for (const [ruleId, hostId, port] of [[1, 1, 20001], [2, 2, 20002]]) {
      await exec(
        'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled")'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)',
        [ruleId, hostId, "规则" + ruleId, "gost", "tcp", port, "198.51.100.7", 443],
      );
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
    const base = "http://127.0.0.1:" + server.address().port;

    const response = await fetch(base + "/api/agent/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok1" },
      body: JSON.stringify({
        agentVersion: "2.3.362", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1,
        failoverEvents: [
          { ruleId: 1, sourcePort: 20001, kind: "switch", fromTarget: "198.51.100.7:443", toTarget: "198.51.100.8:443", reason: "health check", latencyMs: 87, occurredAt: Date.now() },
          { ruleId: 1, sourcePort: 20001, kind: "unhealthy", toTarget: "198.51.100.7:443", reason: "health check", occurredAt: Date.now() },
          { ruleId: 1, sourcePort: 20001, kind: "recovered", toTarget: "198.51.100.7:443", reason: "health check", latencyMs: 41, occurredAt: Date.now() },
          // 这一条是别人家机器上的规则，必须被丢掉。
          { ruleId: 2, sourcePort: 20002, kind: "switch", fromTarget: "a:1", toTarget: "被冒用的规则:443", reason: "health check", occurredAt: Date.now() },
          // 认不出来的类型也丢掉，别把未知字符串原样写进日志。
          { ruleId: 1, sourcePort: 20001, kind: "定时切换", toTarget: "198.51.100.9:443", occurredAt: Date.now() },
        ],
      }),
    });
    await response.json();
    server.close();
    if (response.status !== 200) throw new Error("心跳没通: " + response.status);

    const logger = await import(url("server/_core/panelLogger.ts"));
    const entries = await logger.getPanelLogs();
    console.log("INGEST " + JSON.stringify({
      logs: entries.map((entry) => String(entry.message)).filter((message) => message.startsWith("[Failover]")),
    }));
  `, { name: "failover-ingest", timeoutMs: 180000 });
  const line = result.stdout.split("\n").find((row) => row.startsWith("INGEST "));
  assert.ok(line, `没拿到收取结果：\n${result.stdout}`);
  return JSON.parse(line.slice("INGEST ".length)) as Ingested;
}

const ingested = ingestFailoverEvents();

test("切换记录落进面板日志，带上从哪到哪、为什么、多少延迟", () => {
  const switched = ingested.logs.find((message) => message.includes(" switch "));
  assert.ok(switched, `没找到切换记录：\n${ingested.logs.join("\n")}`);
  for (const fragment of ["rule=1", "198.51.100.7:443 -> 198.51.100.8:443", "reason=health check", "latencyMs=87"]) {
    assert.ok(
      switched.includes(fragment),
      `切换记录里少了「${fragment}」：${switched}\n只写「切了」的话，查起来和没有一样`,
    );
  }
});

test("健康翻转也记下来 —— 那是切换的原因本身", () => {
  assert.ok(ingested.logs.some((message) => message.includes(" unhealthy ")), "没记下出站变不健康");
  assert.ok(ingested.logs.some((message) => message.includes(" recovered ")), "没记下出站恢复");
});

test("不是这台机器的规则，一条都不许记", () => {
  /*
    Agent 的令牌只代表它自己那台机器。不验归属的话，一台被攻陷的机器可以往任意
    规则上写记录 —— 面板日志本身就不可信了，而它正是出事之后唯一的线索。
  */
  const forged = ingested.logs.filter((message) => message.includes("rule=2") || message.includes("被冒用的规则"));
  assert.deepEqual(forged, [], `收下了别人家机器的规则事件：\n${forged.join("\n")}`);
});

test("认不出来的事件类型直接丢掉", () => {
  // 未知字符串原样写进日志，等于把日志的格式交给上报方决定。
  const unknown = ingested.logs.filter((message) => message.includes("定时切换"));
  assert.deepEqual(unknown, [], `收下了认不出来的事件类型：\n${unknown.join("\n")}`);
});
