import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 线路组不只 gost 的 TCP：UDP、TCP+UDP，以及 realm / socat / nginx 前置。
 *
 * 调度器在入口 Agent 里（agent/route_group_udp.go、agent/main.go 的 failoverProxy），前面的
 * 用户态转发工具把「另拨」的目标换成它。服务端这一半要做到：
 *
 *   · realm / socat / nginx 前置时拨本机的调度器，调度规格跟着下发；
 *   · UDP、TCP+UDP 下发 UDP 调度；
 *   · 中转机上的中继规则跟着父规则的协议走；
 *   · gost 端口转发的「按访客固定」：面板让 gost 给调度器加一个 PROXY 头、调度器读完就扔；
 *   · Nginx 隧道：调度器在出口机上，出口的 nginx 拨它（NEX 隧道见 routeGroupForwardX.test.ts）。
 *
 * 起一个真的 sqlite 和真的心跳路由跑一遍。
 */

type Heartbeat = {
  specs: Record<string, any>;
  gostServices: Record<string, any>;
  realmConfig: string;
  socatUnits: string[];
  nginxConfig: string;
};

type Outcome = {
  relays: Array<{ hostId: number; protocol: string; forwardType: string; routePathKey: string }>;
  mainDial: { ip: string; port: number } | null;
  agent: Heartbeat;
  echo: { relayed: boolean[]; socat: boolean[] };
  kernelError: string;
  udpAllowed: boolean;
  nginxTunnelAllowed: boolean;
  forwardxTunnelAllowed: boolean;
  unknownTunnelError: string;
  statusHosts: Record<string, number[]>;
};

function run(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-route-protocols-"));
  const databasePath = path.join(directory, "routes.db");
  const logDirectory = path.join(directory, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const script = String.raw`
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    for (const [id, name, ip, token] of [[1, "入口机", "203.0.113.1", "tok1"], [2, "东京中转", "203.0.113.2", "tok2"]]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, name, ip, ip, "slave", token, Math.floor(Date.now() / 1000)],
      );
    }
    const direct = (key, dest) => ({ key, name: key, hops: [], dest, weight: 50, probe: null, dial: null });
    const insertRule = (id, forwardType, protocol, sourcePort, targetPort, mode, strategy, paths) => exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled",'
        + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSeconds", "recoverSeconds", "autoFailback", "routeMode", "routePaths", "routeSwitchMode", "telegramErrorNotifyEnabled")'
        + ' VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, 10, 60, 1, ?, ?, ?, 0)',
      [id, forwardType + "-" + protocol, forwardType, protocol, sourcePort, "198.51.100.7", targetPort, strategy, "[]", mode, JSON.stringify(paths), "smooth"],
    );
    // 1：gost UDP，主线路经过东京中转；备用直连另一个落地。
    await insertRule(1, "gost", "udp", 21001, 53, "failover", "fallback", [
      { key: "main", name: "主线路", hops: [2], dest: null, weight: 50, probe: null, dial: null },
      direct("backup", { ip: "198.51.100.9", port: 53 }),
    ]);
    // 2：realm TCP。
    await insertRule(2, "realm", "tcp", 21002, 443, "failover", "fallback", [direct("main", null), direct("backup", { ip: "198.51.100.9", port: 443 })]);
    // 3：gost TCP，按访客固定。
    await insertRule(3, "gost", "tcp", 21003, 443, "weighted", "ip_hash", [direct("a", null), direct("b", { ip: "198.51.100.9", port: 443 })]);
    // 4：socat TCP+UDP。
    await insertRule(4, "socat", "both", 21004, 8443, "failover", "fallback", [direct("main", null), direct("backup", { ip: "198.51.100.9", port: 8443 })]);
    // 5：nginx TCP。
    await insertRule(5, "nginx", "tcp", 21005, 9443, "failover", "fallback", [direct("main", null), direct("backup", { ip: "198.51.100.9", port: 9443 })]);
    // 6：走 Nginx 隧道（入口东京、出口是入口机 1），TCP+UDP。调度器在出口机上。
    await exec(
      'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled") VALUES (1, ?, 2, 1, ?, ?, 1, 1)',
      ["Nginx 隧道", "nginx_stream", 22006],
    );
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "tunnelId", "tunnelExitPort",'
        + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSeconds", "recoverSeconds", "autoFailback", "routeMode", "routePaths", "routeSwitchMode", "telegramErrorNotifyEnabled")'
        + ' VALUES (6, 2, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, 1, ?, ?, 10, 60, 1, ?, ?, ?, 0)',
      ["nginx-tunnel", "gost", "both", 21006, "198.51.100.7", 7443, 22006, "fallback", "[]", "failover",
        JSON.stringify([direct("main", null), direct("backup", { ip: "198.51.100.9", port: 7443 })]), "smooth"],
    );

    /*
      7–9：GOST 隧道（入口东京、出口入口机 1），UDP。第三台机器是一个额外的出口节点：
        7 —— 开着负载均衡，但这个节点停用了；
        8 —— 节点还在，但负载均衡关掉了；
        9 —— 开着负载均衡、节点也开着（它真的在出流量）。
    */
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "userId", "isOnline", "lastHeartbeat") VALUES (3, ?, ?, ?, ?, ?, ?, 1, 1, ?)',
      ["出口节点", "203.0.113.3", "203.0.113.3", "slave", "tok3", "2.2.251", Math.floor(Date.now() / 1000)],
    );
    for (const [tunnelId, listenPort, loadBalanceEnabled, nodeEnabled, ruleId, sourcePort] of [
      [2, 22007, 1, 0, 7, 21007],
      [3, 22008, 0, 1, 8, 21008],
      [4, 22009, 1, 1, 9, 21009],
    ]) {
      await exec(
        'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "loadBalanceEnabled", "loadBalanceStrategy") VALUES (?, ?, 2, 1, ?, ?, 1, 1, ?, ?)',
        [tunnelId, "GOST 隧道 " + tunnelId, "tls", listenPort, loadBalanceEnabled, "round_robin"],
      );
      await exec(
        'INSERT INTO tunnel_exit_nodes ("tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (?, 1, 3, ?, ?)',
        [tunnelId, listenPort + 100, nodeEnabled],
      );
      await exec(
        'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "tunnelId", "tunnelExitPort",'
          + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSeconds", "recoverSeconds", "autoFailback", "routeMode", "routePaths", "routeSwitchMode", "telegramErrorNotifyEnabled")'
          + ' VALUES (?, 2, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 1, ?, ?, 10, 60, 1, ?, ?, ?, 0)',
        [ruleId, "gost-tunnel-" + ruleId, "gost", "udp", sourcePort, "198.51.100.7", 53, tunnelId, listenPort, "fallback", "[]", "failover",
          JSON.stringify([direct("main", null), direct("backup", { ip: "198.51.100.9", port: 53 })]), "smooth"],
      );
    }

    // nginx 和 Nginx 隧道默认是关的（DEFAULT_FORWARD_PROTOCOL_SETTINGS），这里在系统设置里打开。
    const settings = await import(url("server/repositories/settingsRepository.ts"));
    await settings.setSetting("forwardProtocols", JSON.stringify({ nginx: true, nginx_stream: true }));

    const routeGroups = await import(url("server/routeGroups.ts"));
    await routeGroups.syncRouteRelayRulesForRule(1, { reason: "test" });
    const relays = (await query('SELECT "hostId", protocol, "forwardType", "routePathKey" FROM forward_rules WHERE "routeParentRuleId" = 1 AND "pendingDelete" = 0'))
      .map((row) => ({ hostId: Number(row.hostId), protocol: String(row.protocol), forwardType: String(row.forwardType), routePathKey: String(row.routePathKey) }));
    const ruleRow = (await query('SELECT "routePaths" FROM forward_rules WHERE id = 1'))[0];
    const mainDial = JSON.parse(ruleRow.routePaths).find((item) => item.key === "main").dial || null;

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
    const beat = async (agentVersion) => {
      const response = await fetch(base + "/api/agent/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok1" },
        body: JSON.stringify({ agentVersion, uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
      const actions = (body.desiredState && body.desiredState.actions) || [];
      const specs = {};
      const gostServices = {};
      let realmConfig = "";
      let nginxConfig = "";
      const socatUnits = [];
      for (const action of actions) {
        if (action && action.failover && action.failover.enabled && action.ruleId) specs[String(action.ruleId)] = action.failover;
        for (const config of (action.managedConfigs || [])) {
          const text = Buffer.from(String(config.contentBase64 || ""), "base64").toString("utf8");
          if (String(config.path || "").endsWith("/gost.json")) {
            for (const service of JSON.parse(text).services || []) gostServices[String(service.name)] = service;
          }
          if (String(config.path || "").endsWith("/nginx.conf")) nginxConfig = text;
        }
        if (Number(action.ruleId) === 2) {
          for (const command of action.preCommands || []) {
            const match = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(String(command));
            if (match) realmConfig = Buffer.from(match[1], "base64").toString("utf8");
          }
        }
        if (Number(action.ruleId) === 4) {
          if (action.unit) socatUnits.push(String(action.unit));
          if (action.unitExtra) socatUnits.push(String(action.unitExtra));
        }
      }
      // runningRules 在心跳回复的顶层（Agent 的 heartbeatResponse），不在 desiredState 里。
      const running = body.runningRules || (body.desiredState && body.desiredState.runningRules) || [];
      for (const rule of running) {
        if (rule && rule.failover && rule.failover.enabled && rule.ruleId && !specs[String(rule.ruleId)]) specs[String(rule.ruleId)] = rule.failover;
      }
      return { specs, gostServices, realmConfig, socatUnits, nginxConfig };
    };
    const agent = await beat("2.2.251");
    // UDP 回声探测：对端（东京中转 2）是自己的机器才带 probeUdpEcho。
    const echoFlags = (heartbeat, ruleId) => ((heartbeat.specs[String(ruleId)] || {}).targets || []).map((target) => target.probeUdpEcho === true);
    const echo = {
      relayed: echoFlags(agent, 1),
      socat: echoFlags(agent, 4),
    };
    server.close();

    // 保存那一层：内核转发上开线路组要被拦住，UDP 不再被拦。
    const crud = await import(url("server/routers/rules.crud.ts"));
    let kernelError = "";
    try {
      crud.requireMainBackupAllowed({ enabled: true, protocol: "tcp", forwardType: "iptables", isAdmin: true });
    } catch (error) {
      kernelError = String(error && error.message || error);
    }
    let udpAllowed = true;
    try {
      crud.requireMainBackupAllowed({ enabled: true, protocol: "udp", forwardType: "realm", isAdmin: true });
      crud.normalizeFailoverInput({ failoverEnabled: true, failoverStrategy: "fallback", failoverTargets: [{ targetIp: "198.51.100.9", targetPort: 53 }] }, "udp", {});
    } catch {
      udpAllowed = false;
    }
    let nginxTunnelAllowed = true;
    try {
      crud.requireMainBackupAllowed({ enabled: true, protocol: "both", forwardType: "gost", tunnelId: 1, tunnelMode: "nginx_stream", isAdmin: false });
    } catch {
      nginxTunnelAllowed = false;
    }
    let forwardxTunnelAllowed = true;
    try {
      crud.requireMainBackupAllowed({ enabled: true, protocol: "both", forwardType: "gost", tunnelId: 9, tunnelMode: "forwardx", isAdmin: false });
    } catch {
      forwardxTunnelAllowed = false;
    }
    // 认不出来的隧道类型（老数据）照样拦。
    let unknownTunnelError = "";
    try {
      crud.requireMainBackupAllowed({ enabled: true, protocol: "tcp", forwardType: "gost", tunnelId: 9, tunnelMode: "wireguard", isAdmin: false });
    } catch (error) {
      unknownTunnelError = String(error && error.message || error);
    }
    // 调度器跑在哪几台机器上：线路面板和心跳同一个口径（真的从库里读隧道和出口节点）。
    const dbModule = await import(url("server/db.ts"));
    const statusHosts = {};
    for (const tunnelId of [1, 2, 3, 4]) {
      const tunnel = await dbModule.getTunnelById(tunnelId);
      statusHosts[tunnelId] = crud.routeSchedulerHostIds(2, tunnel, await dbModule.getTunnelExitNodes(tunnelId));
    }
    statusHosts.direct = crud.routeSchedulerHostIds(5, null, []);
    statusHosts.forwardx = crud.routeSchedulerHostIds(2, { id: 9, mode: "forwardx", exitHostId: 1, loadBalanceEnabled: 1 }, [{ hostId: 3, listenPort: 1, isEnabled: 1 }]);
    statusHosts.forwardxSingle = crud.routeSchedulerHostIds(2, { id: 10, mode: "forwardx", exitHostId: 1, loadBalanceEnabled: 0 }, [{ hostId: 3, listenPort: 1, isEnabled: 1 }]);
    console.log("OUTCOME " + JSON.stringify({ relays, mainDial, agent, echo, kernelError, udpAllowed, nginxTunnelAllowed, forwardxTunnelAllowed, unknownTunnelError, statusHosts }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: logDirectory },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

const outcome = run();

test("中转机上的中继规则跟着父规则的协议走", () => {
  assert.equal(outcome.relays.length, 1);
  assert.deepEqual(outcome.relays[0], { hostId: 2, protocol: "udp", forwardType: "gost", routePathKey: "main" });
  assert.ok(outcome.mainDial, "主线路经过中转，应当解析出拨号地址");
});

test("UDP 规则下发 UDP 调度，gost 的 UDP 服务拨本机的调度器", () => {
  const spec = outcome.agent.specs["1"];
  assert.ok(spec, "UDP 线路组没有下发调度");
  assert.equal(spec.protocol, "udp");
  assert.equal(spec.targets.length, 2);
  const service = outcome.agent.gostServices["fwx-1-udp"];
  assert.ok(service, "UDP 规则没生成 gost UDP 服务");
  assert.equal(service.forwarder.nodes[0].addr, `127.0.0.1:${spec.listenPort}`);
});

test("UDP 回声探测：对端是自己的中转才带 probeUdpEcho；直连手填的落地不带", () => {
  assert.deepEqual(outcome.echo.relayed, [true, false], "主线路经过东京中转带；备用直连手填的落地不知道是谁的机器，不带");
  assert.deepEqual(outcome.echo.socat, [false, false], "直连路径不带");
});

test("realm 前置：拨本机的调度器，调度规格跟着 realm 的动作下发", () => {
  const spec = outcome.agent.specs["2"];
  assert.ok(spec, "realm 规则没有下发调度");
  assert.equal(spec.protocol, "tcp");
  assert.match(outcome.agent.realmConfig, new RegExp(`remote = "127\\.0\\.0\\.1:${spec.listenPort}"`), outcome.agent.realmConfig);
});

test("socat 前置、TCP+UDP：两个 socat 都拨调度器", () => {
  const spec = outcome.agent.specs["4"];
  assert.ok(spec, "socat TCP+UDP 规则没有下发调度");
  assert.equal(spec.protocol, "both");
  assert.equal(outcome.agent.socatUnits.length, 2);
  for (const unit of outcome.agent.socatUnits) {
    assert.match(unit, new RegExp(`(TCP|UDP):127\\.0\\.0\\.1:${spec.listenPort}`), unit);
  }
});

test("nginx 前置：upstream 指向调度器，nginx 的动作带着调度规格", () => {
  const spec = outcome.agent.specs["5"];
  assert.ok(spec, "nginx 规则没有下发调度");
  assert.ok(outcome.agent.nginxConfig.includes(`127.0.0.1:${spec.listenPort}`), outcome.agent.nginxConfig);
  assert.ok(!/server 198\.51\.100\.7:9443/.test(outcome.agent.nginxConfig), "nginx 还在直连规则目标");
});

test("gost 按访客固定：由 gost 给调度器加一个 PROXY 头、调度器读完就扔", () => {
  const spec = outcome.agent.specs["3"];
  assert.ok(spec);
  assert.equal(spec.strategy, "ip_hash");
  assert.equal(spec.proxyProtocolReceive, true);
  assert.equal(spec.proxyProtocolStrip, true);
  assert.deepEqual(outcome.agent.gostServices["fwx-3-tcp"].handler.metadata, { proxyProtocol: "1" });
  // 不按访客分的 gost 规则从来不加头。
  assert.equal(outcome.agent.gostServices["fwx-1-udp"].handler.metadata, undefined);
});

test("保存时只拦内核转发，不再拦 UDP 和 realm / socat / nginx", () => {
  assert.match(outcome.kernelError, /iptables \/ nftables/);
  assert.equal(outcome.udpAllowed, true);
});

test("Nginx 隧道：出口的 nginx 拨出口机上的调度器，规格下发给出口机", () => {
  const spec = outcome.agent.specs["6"];
  assert.ok(spec, "Nginx 隧道的线路组没有下发到出口机");
  assert.equal(spec.protocol, "both");
  assert.equal(spec.proxyProtocolReceive, false, "Nginx 隧道的出口不发 PROXY 头");
  for (const proto of ["tcp", "udp"]) {
    const upstream = new RegExp(`upstream fwx_texit_1_6_22006_${proto}\\s*\\{[^}]*127\\.0\\.0\\.1:${spec.listenPort}`);
    assert.match(outcome.agent.nginxConfig, upstream, outcome.agent.nginxConfig);
  }
});

test("保存时放开 Nginx 隧道和 NEX 隧道，认不出来的隧道类型照样拦", () => {
  assert.equal(outcome.nginxTunnelAllowed, true);
  assert.equal(outcome.forwardxTunnelAllowed, true);
  assert.match(outcome.unknownTunnelError, /这种隧道用不了线路组/);
});

test("负载均衡隧道：出口机照常收到 UDP 调度", () => {
  for (const ruleId of ["7", "8", "9"]) {
    assert.ok(outcome.agent.specs[ruleId], `规则 ${ruleId} 的 UDP 调度没下发到出口机`);
    assert.equal(outcome.agent.specs[ruleId].protocol, "udp");
  }
});

test("调度器跑在哪几台机器上：线路面板和心跳同一个口径", () => {
  assert.deepEqual(outcome.statusHosts["1"], [1], "Nginx 隧道：出口机");
  assert.deepEqual(outcome.statusHosts["2"], [1], "停用的出口节点不算");
  assert.deepEqual(outcome.statusHosts["3"], [1], "负载均衡关掉后留着的节点不算");
  assert.deepEqual(outcome.statusHosts["4"], [1, 3], "开着的负载均衡出口都算");
  assert.deepEqual(outcome.statusHosts.direct, [5], "直连规则：规则所在的机器");
  assert.deepEqual(outcome.statusHosts.forwardx, [1, 3], "NEX 隧道：出口和开着的负载均衡出口");
  assert.deepEqual(outcome.statusHosts.forwardxSingle, [1], "NEX 隧道没开负载均衡：只有出口");
});
