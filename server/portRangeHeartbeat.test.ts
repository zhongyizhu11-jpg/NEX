import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 端口段规则（shared/portRange.ts）随心跳下发成什么样：新 Agent 收到整段的内核规则和段结尾，
 * 老 Agent 收到一条带原因、一定失败的动作 —— 不下发半套规则（老 Agent 的就绪检查只认单端口，
 * 会一直当成没装上反复重下）。搭法同 disabledRuleGuardCleanup.test.ts：真心跳路由 + SQLite。
 */
function heartbeatFor(token: string, agentVersion: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-port-range-hb-"));
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
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "agentVersion") VALUES (1, ?, ?, ?, ?, ?, 1, 1, ?)',
      ["入口机", "203.0.113.1", "203.0.113.1", "slave", process.env.AGENT_TOKEN, process.env.AGENT_VERSION]);
    const cols = '(id, "hostId", name, "forwardType", protocol, "sourcePort", "sourcePortEnd", "targetIp", "targetPort", "userId", "isEnabled", "isRunning")';
    await exec("INSERT INTO forward_rules " + cols + " VALUES (11, 1, 'nft-same', 'nftables', 'tcp', 20000, 20100, '198.51.100.7', 20000, 1, 1, 0)");
    await exec("INSERT INTO forward_rules " + cols + " VALUES (12, 1, 'ipt-shift', 'iptables', 'udp', 21000, 21009, '198.51.100.8', 31000, 1, 1, 0)");

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
      headers: { "content-type": "application/json", authorization: "Bearer " + process.env.AGENT_TOKEN },
      body: JSON.stringify({
        agentVersion: process.env.AGENT_VERSION, uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1,
        localState: { rules: [], services: [], tunnels: [] },
      }),
    });
    const body = await response.json();
    server.close();
    if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body).slice(0, 300));
    const actions = ((body.desiredState && body.desiredState.actions) || []).filter((action) => [11, 12].includes(Number(action.ruleId)));
    console.log("RESULT " + JSON.stringify({ actions, runningRules: body.runningRules || [] }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "hb.db"), AGENT_TOKEN: token, AGENT_VERSION: agentVersion },
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("RESULT "));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice("RESULT ".length)) as {
    actions: Array<{ ruleId: number; sourcePortEnd?: number; commands?: string[]; failureMessage?: string }>;
    runningRules: Array<{ ruleId: number; sourcePort: number; sourcePortEnd?: number }>;
  };
}

test("新 Agent：段规则下发整段的内核规则，动作和 runningRules 都带段结尾", () => {
  const { actions, runningRules } = heartbeatFor("tok-new", "2.2.253");
  const nft = actions.find((action) => Number(action.ruleId) === 11);
  const ipt = actions.find((action) => Number(action.ruleId) === 12);
  assert.ok(nft && ipt, JSON.stringify(actions).slice(0, 500));
  assert.equal(nft.sourcePortEnd, 20100);
  assert.equal(ipt.sourcePortEnd, 21009);
  assert.ok(!nft.failureMessage && !ipt.failureMessage);
  const nftText = (nft.commands || []).join("\n");
  assert.match(nftText, /tcp dport 20000-20100 counter dnat ip to 198\.51\.100\.7 comment/);
  const iptText = (ipt.commands || []).join("\n");
  assert.match(iptText, /--dport 21000:21009 -j DNAT --to-destination 198\.51\.100\.8:31000-31009\/21000/);
  assert.match(iptText, /--ctorigdstport 21000:21009 -d 198\.51\.100\.8 --dport 31000:31009/);
  for (const ruleId of [11, 12]) {
    const running = runningRules.find((rule) => Number(rule.ruleId) === ruleId);
    assert.ok(running, `runningRules 里没有 ${ruleId}`);
    assert.equal(running.sourcePortEnd, ruleId === 11 ? 20100 : 21009);
  }
});

test("老 Agent：段规则不下发半套规则，而是一条一定失败、写明要升级的动作", () => {
  const { actions } = heartbeatFor("tok-old", "2.2.252");
  for (const ruleId of [11, 12]) {
    const action = actions.find((item) => Number(item.ruleId) === ruleId);
    assert.ok(action, JSON.stringify(actions).slice(0, 500));
    assert.match(String(action.failureMessage), /端口段需要 Agent 2\.2\.253 或更新/);
    const text = (action.commands || []).join("\n");
    assert.match(text, /exit 1/);
    assert.doesNotMatch(text, /dnat|DNAT/);
  }
});
