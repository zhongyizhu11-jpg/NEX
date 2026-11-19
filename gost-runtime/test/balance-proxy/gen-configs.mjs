// 用面板真实的代码路径生成「GOST 出口组由入口机本机代理挑」的全套下发（见同目录 run.sh）：
//   临时 SQLite 库里建 1 台入口 + 3 台出口、一条开了负载均衡的 GOST 链路、一条走它的规则；
//   入口机、每台出口各发一次真实的心跳（registerAgentHeartbeatRoute），从 desiredState 里取出
//     · 入口机的 gost.json（公网端口 → 本机代理；每台出口一个本机端口 → 单节点链）
//     · 交给入口 Agent 的代理规格（runningRules[].failover）
//     · 每台出口的隧道运行时配置（relay 监听）
//   每个场景（分配方式 / 手动指定 / 发 PROXY 头 / 老 Agent）改一下链路再发一轮，各存一个目录。
//
// 既给端到端测试用（run.sh → agent 的 TestBalanceProxyE2E），也给 server/gostBalanceHeartbeat.test.ts 用：
// 那个测试断言的就是这里取出来的东西，所以「计划从没生效」那种问题在单元测试里就会红。
//
// 用法（仓库根目录）：OUT=<目录> FORWARDX_TEST_DB=<db> node --import tsx gost-runtime/test/balance-proxy/gen-configs.mjs
// 环境变量：TARGET_PORT / ENTRY_PORT / EXIT_PORT_BASE（出口 1–3 的隧道端口是 BASE、BASE+1、BASE+2）、TUNNEL_MODE（默认 tls）。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUT = process.env.OUT;
if (!OUT || !process.env.FORWARDX_TEST_DB) throw new Error("OUT and FORWARDX_TEST_DB are required");
process.env.FORWARDX_LOG_DIR ??= path.join(OUT, "panel-logs");
fs.mkdirSync(process.env.FORWARDX_LOG_DIR, { recursive: true });
const TARGET_PORT = Number(process.env.TARGET_PORT || 28901);
const ENTRY_PORT = Number(process.env.ENTRY_PORT || 28900);
const EXIT_PORT_BASE = Number(process.env.EXIT_PORT_BASE || 28911);
const TUNNEL_MODE = process.env.TUNNEL_MODE || "tls";
const ENTRY = { id: 10, ip: "127.0.0.1", token: "tok-entry" };
const EXITS = [
  { id: 21, ip: "127.0.0.11", token: "tok-exit-1", port: EXIT_PORT_BASE, mbps: 500 },
  { id: 22, ip: "127.0.0.12", token: "tok-exit-2", port: EXIT_PORT_BASE + 1, mbps: 300 },
  { id: 23, ip: "127.0.0.13", token: "tok-exit-3", port: EXIT_PORT_BASE + 2, mbps: 200 },
];
const RULE_ID = 1;
const TUNNEL_ID = 1;

const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
const runtime = await import(url("server/dbRuntime.ts"));
const schema = await import(url("server/dbSchema.ts"));
const { UNIFIED_BALANCE_AGENT_VERSION } = await import(url("shared/loadBalance.ts"));
await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
await schema.ensureDatabaseSchema();
const exec = (sql, params = []) => runtime.executeRaw(sql, params);
const now = Math.floor(Date.now() / 1000);

await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
const addHost = (host, name, mbps) => exec(
  'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "agentVersion", "runtimeVersion", "userId", "isOnline", "lastHeartbeat", "lineBandwidthMbps") VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
  [host.id, name, host.ip, host.ip, "slave", host.token, UNIFIED_BALANCE_AGENT_VERSION, "3.2.6-nex6", now, mbps],
);
await addHost(ENTRY, "入口", 0);
for (const [index, exit] of EXITS.entries()) await addHost(exit, `出口${index + 1}`, exit.mbps);
await exec(
  'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "userId", "isEnabled", "loadBalanceEnabled", "loadBalanceStrategy") VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?)',
  [TUNNEL_ID, "GOST 出口组", ENTRY.id, EXITS[0].id, TUNNEL_MODE, EXITS[0].port, "round_robin"],
);
for (const [index, exit] of EXITS.slice(1).entries()) {
  await exec('INSERT INTO tunnel_exit_nodes ("tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (?, ?, ?, ?, 1)', [TUNNEL_ID, index + 1, exit.id, exit.port]);
}
await exec(
  'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "tunnelId", "tunnelExitPort") VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)',
  [RULE_ID, ENTRY.id, "balance-e2e", "gost", "both", ENTRY_PORT, "127.0.0.1", TARGET_PORT, TUNNEL_ID, EXITS[0].port],
);

const express = (await import("express")).default;
const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
const app = express();
app.use(express.json({ limit: "8mb" }));
app.use((req, _res, next) => {
  const authorization = String(req.headers.authorization || "");
  req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  next();
});
heartbeat.registerAgentHeartbeatRoute(app);
const server = http.createServer(app);
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const base = `http://127.0.0.1:${server.address().port}`;

async function beat(token, agentVersion) {
  const response = await fetch(`${base}/api/agent/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ agentVersion, uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true }),
  });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`心跳没通: ${response.status} ${JSON.stringify(body)}`);
  const configs = {};
  for (const action of body.desiredState?.actions || []) {
    for (const config of action?.managedConfigs || []) {
      if (!String(config.path || "").endsWith(".json")) continue;
      try { configs[path.basename(String(config.path))] = JSON.parse(Buffer.from(String(config.contentBase64 || ""), "base64").toString("utf8")); } catch { /* 不是 JSON 的不要 */ }
    }
  }
  const failover = {};
  for (const rule of body.runningRules || []) {
    if (rule?.failover?.enabled) failover[String(rule.ruleId)] = { sourcePort: Number(rule.sourcePort), spec: rule.failover };
  }
  return { configs, failover };
}

// 入口机上那份共享运行时的配置：里面有这条规则公网端口的那一份
const entryRuntimeConfig = (configs) => Object.values(configs).find((config) => (config.services || []).some((service) => String(service.name || "").startsWith(`fwx-${RULE_ID}-`))) || null;
// 出口机上那份隧道运行时的配置
const exitRuntimeConfig = (configs) => Object.values(configs).find((config) => (config.services || []).some((service) => String(service.name || "").startsWith("fwx-tunnel-exit-"))) || null;

/** 场景：改链路的哪些列、入口机的 Agent 版本。 */
const scenarios = [
  ...["round_robin", "random", "weighted", "least_load", "ip_hash", "fallback", "latency", "auto"].map((strategy) => ({ name: strategy, tunnel: { loadBalanceStrategy: strategy } })),
  { name: "pin", tunnel: { loadBalanceStrategy: "round_robin", balancePinHostId: EXITS[1].id } },
  { name: "proxy-send", tunnel: { loadBalanceStrategy: "round_robin", proxyProtocolSend: 1, proxyProtocolVersion: 2 } },
  { name: "proxy-receive", tunnel: { loadBalanceStrategy: "ip_hash", proxyProtocolReceive: 1 } },
  { name: "sensitive", tunnel: { loadBalanceStrategy: "round_robin", balanceDetect: JSON.stringify({ intervalSeconds: 1, failThreshold: 2, recoverThreshold: 3 }) } },
  { name: "tcp-only", tunnel: { loadBalanceStrategy: "round_robin" }, protocol: "tcp" },
  { name: "udp-only", tunnel: { loadBalanceStrategy: "round_robin" }, protocol: "udp" },
  { name: "old-agent", tunnel: { loadBalanceStrategy: "round_robin" }, entryAgentVersion: "2.2.263" },
];
const reset = { balancePinHostId: null, proxyProtocolSend: 0, proxyProtocolReceive: 0, proxyProtocolVersion: 1, balanceDetect: null };
const only = (process.env.SCENARIOS || "").split(",").map((item) => item.trim()).filter(Boolean);
const summary = {};
let lastEntryGost = null;
const lastExitGost = {};
for (const scenario of scenarios) {
  if (only.length > 0 && !only.includes(scenario.name)) continue;
  const columns = { ...reset, ...scenario.tunnel };
  await exec(`UPDATE tunnels SET ${Object.keys(columns).map((key) => `"${key}" = ?`).join(", ")} WHERE id = ?`, [...Object.values(columns), TUNNEL_ID]);
  await exec('UPDATE forward_rules SET protocol = ? WHERE id = ?', [scenario.protocol || "both", RULE_ID]);
  const entry = await beat(ENTRY.token, scenario.entryAgentVersion || UNIFIED_BALANCE_AGENT_VERSION);
  /*
    面板只在配置内容变了的时候才重发 gost 配置：只换分配方式 / 手动指定时，入口机的 gost.json 一个字节不变
    （这正是交给本机代理的意义：切换不动 gost），所以这一轮心跳里没有它，Agent 盘上还是上一份。这里照着留上一份。
  */
  lastEntryGost = entryRuntimeConfig(entry.configs) || lastEntryGost;
  const entryGostResent = !!entryRuntimeConfig(entry.configs);
  for (const exit of EXITS) {
    const config = exitRuntimeConfig((await beat(exit.token, UNIFIED_BALANCE_AGENT_VERSION)).configs);
    if (config) lastExitGost[String(exit.id)] = config;
  }
  const exits = { ...lastExitGost };
  const bundle = {
    scenario: scenario.name,
    ruleId: RULE_ID,
    tunnelId: TUNNEL_ID,
    protocol: scenario.protocol || "both",
    entryPort: ENTRY_PORT,
    targetPort: TARGET_PORT,
    exits: EXITS.map((exit) => ({ hostId: exit.id, ip: exit.ip, port: exit.port })),
    entryGost: lastEntryGost,
    entryGostResent,
    failover: entry.failover[String(RULE_ID)] || null,
    exitGost: exits,
  };
  const directory = path.join(OUT, scenario.name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "bundle.json"), JSON.stringify(bundle, null, 2));
  summary[scenario.name] = { balanced: !!bundle.failover?.spec?.balanceReport, strategy: bundle.failover?.spec?.strategy || null };
}
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
server.close();
await runtime.closeDatabase?.().catch?.(() => undefined);
process.exit(0);
