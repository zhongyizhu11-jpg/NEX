// 用面板真实的代码路径生成端到端测试的配置（见 README.md）：
//   - 临时 SQLite 库里建主机、落地 SS 入站（proxyInboundsRouter.create，和界面同一条路）、
//     带出口的规则（rulesRouter.create，保存时的校验全走一遍）；
//   - 入口机、落地机各发一次真实的心跳（registerAgentHeartbeatRoute），从下发的 desiredState 里
//     取出入口机的 gost.json 和落地机的 sing-box 配置。
// 面板不允许出口服务器是 127.x，所以库里的落地地址用文档地址 198.51.100.10，写文件时换成 127.0.0.1。
//
// 用法（仓库根目录）：OUT=<目录> FORWARDX_TEST_DB=<db> node --import tsx gost-runtime/test/ss-egress-e2e/gen-configs.mjs
// 环境变量 TARGET_TCP_UDP / TARGET_DNS / TARGET_QUIC 是目标服务的端口（tool serve 的端口）。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUT = process.env.OUT;
if (!OUT || !process.env.FORWARDX_TEST_DB) throw new Error("OUT and FORWARDX_TEST_DB are required");
const ECHO_PORT = Number(process.env.TARGET_TCP_UDP || 29500);
const DNS_PORT = Number(process.env.TARGET_DNS || 29553);
const QUIC_PORT = Number(process.env.TARGET_QUIC || 29443);
const LANDING_IP = "198.51.100.10";
const METHODS = (process.env.METHODS || "aes-128-gcm,aes-256-gcm,chacha20-ietf-poly1305,2022-blake3-aes-128-gcm,2022-blake3-aes-256-gcm").split(",");
const CAPS = ["ssEgress2022", "ssEgressUdp"];

const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
const runtime = await import(url("server/dbRuntime.ts"));
const schema = await import(url("server/dbSchema.ts"));
await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
await schema.ensureDatabaseSchema();
const exec = (sql, params = []) => runtime.executeRaw(sql, params);
const query = (sql, params = []) => runtime.queryRaw(sql, params);
const now = Math.floor(Date.now() / 1000);

await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
const addHost = (id, name, ip, token, agentVersion, caps, runtimeVersion) => exec(
  'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "agentCapabilities", "runtimeVersion") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)',
  [id, name, ip, ip, "slave", token, now, agentVersion, JSON.stringify(caps), runtimeVersion],
);
// 10：升级好的入口（Agent 2.2.227 + 运行时 nex3，报了能力）；11：还是旧运行时的入口（没能力）。
await addHost(10, "入口-nex3", "203.0.113.10", "tok10", "2.2.227", CAPS, "3.2.6-nex3");
await addHost(11, "入口-nex2", "203.0.113.11", "tok11", "2.2.227", [], "3.2.6-nex2");
await addHost(20, "落地", LANDING_IP, "tok20", "2.2.227", CAPS, "3.2.6-nex3");

const ctx = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
const { proxyInboundsRouter } = await import(url("server/routers/proxyInbounds.ts"));
const { rulesRouter } = await import(url("server/routers/rules.ts"));
const inboundApi = proxyInboundsRouter.createCaller(ctx);
const rules = rulesRouter.createCaller(ctx);

const plan = { methods: {}, plain: {}, gating: {} };
let landingPort = 28800;
let rulePort = 29000;
const { isProxyInboundShadowsocksMethod } = await import(url("shared/proxyInbound.ts"));
// 面板的落地入站不提供的方法（chacha20-ietf-poly1305）：落地侧在生成的 sing-box 配置里补一个同样格式的入站，
// 规则走「外部 ss:// 链接」那条路（也就是用户粘贴别家 SS 落地的情形）。
const extraInbounds = [];
for (const method of METHODS) {
  let base;
  let inboundId = null;
  if (isProxyInboundShadowsocksMethod(method)) {
    const inbound = await inboundApi.create({ hostId: 20, name: `落地 ${method}`, protocol: "shadowsocks", method, port: landingPort++, transport: "tcp", security: "none" });
    inboundId = Number(inbound.id ?? inbound);
    const stored = (await query("SELECT method FROM proxy_inbounds WHERE id = ?", [inboundId]))[0];
    if (stored.method !== method) throw new Error(`landing inbound stored ${stored.method}, wanted ${method}`);
    base = { hostId: 10, forwardType: "gost", targetIp: "127.0.0.1", egressType: "ss_host", egressInboundId: inboundId, egressUdp: true };
  } else {
    const port = landingPort++;
    const password = `e2e-${method}-${Math.random().toString(36).slice(2, 12)}`;
    extraInbounds.push({ type: "shadowsocks", tag: `e2e-${method}`, listen: "::", listen_port: port, method, password });
    const link = "ss://" + Buffer.from(`${method}:${password}`).toString("base64url") + `@${LANDING_IP}:${port}#${method}`;
    base = { hostId: 10, forwardType: "gost", targetIp: "127.0.0.1", egressType: "ss_link", egressLink: link, egressUdp: true };
  }
  const echo = await rules.create({ ...base, name: `echo ${method}`, protocol: "both", sourcePort: rulePort++, targetPort: ECHO_PORT });
  const dns = await rules.create({ ...base, name: `dns ${method}`, protocol: "udp", sourcePort: rulePort++, targetPort: DNS_PORT });
  const quic = await rules.create({ ...base, name: `quic ${method}`, protocol: "udp", sourcePort: rulePort++, targetPort: QUIC_PORT });
  const tcpOnly = await rules.create({ ...base, name: `tcp-only ${method}`, protocol: "tcp", egressUdp: false, sourcePort: rulePort++, targetPort: ECHO_PORT });
  plan.methods[method] = {
    inboundId,
    source: base.egressType,
    echoPort: (await query('SELECT "sourcePort" FROM forward_rules WHERE id = ?', [echo.id]))[0].sourcePort,
    dnsPort: (await query('SELECT "sourcePort" FROM forward_rules WHERE id = ?', [dns.id]))[0].sourcePort,
    quicPort: (await query('SELECT "sourcePort" FROM forward_rules WHERE id = ?', [quic.id]))[0].sourcePort,
    tcpOnlyPort: (await query('SELECT "sourcePort" FROM forward_rules WHERE id = ?', [tcpOnly.id]))[0].sourcePort,
    ruleIds: [echo.id, dns.id, quic.id, tcpOnly.id],
  };
  rulePort += 6;
}
// 外部 ss:// 链接（同一个落地）：走 ss_link 那条路，SS2022 的 base64 密钥原样带过去。
{
  const method = METHODS.includes("2022-blake3-aes-256-gcm") ? "2022-blake3-aes-256-gcm" : "aes-256-gcm";
  const inbound = (await query("SELECT port, password FROM proxy_inbounds WHERE id = ?", [plan.methods[method].inboundId]))[0];
  const link = "ss://" + Buffer.from(`${method}:${inbound.password}`).toString("base64url") + `@${LANDING_IP}:${inbound.port}#e2e`;
  const viaLink = await rules.create({ hostId: 10, forwardType: "gost", targetIp: "127.0.0.1", egressType: "ss_link", egressLink: link, egressUdp: true, name: "echo via link", protocol: "both", sourcePort: rulePort, targetPort: ECHO_PORT });
  plan.link = { method, port: rulePort, ruleId: viaLink.id };
  rulePort += 10;
}
// 不挂出口的普通 gost 规则：TCP+UDP 直连目标（回归对照）。
const plain = await rules.create({ hostId: 10, forwardType: "gost", targetIp: "127.0.0.1", protocol: "both", sourcePort: rulePort, targetPort: ECHO_PORT, name: "plain" });
plan.plain = { port: rulePort, ruleId: plain.id };
rulePort += 10;

// 能力闸门：没能力的入口机上，保存 UDP 出口 / SS2022 出口必须被拒。
const classic = plan.methods["aes-256-gcm"];
const ss2022 = plan.methods["2022-blake3-aes-128-gcm"];
const rejects = async (promise) => promise.then(() => "saved", (error) => String(error?.message || error));
plan.gating.udpSaveOnOldHost = await rejects(rules.create({ hostId: 11, forwardType: "gost", targetIp: "127.0.0.1", egressType: "ss_host", egressInboundId: classic.inboundId, egressUdp: true, protocol: "both", sourcePort: 29900, targetPort: ECHO_PORT }));
plan.gating.ss2022SaveOnOldHost = ss2022 ? await rejects(rules.create({ hostId: 11, forwardType: "gost", targetIp: "127.0.0.1", egressType: "ss_host", egressInboundId: ss2022.inboundId, protocol: "tcp", sourcePort: 29901, targetPort: ECHO_PORT })) : "skipped";
const oldTcp = await rules.create({ hostId: 11, forwardType: "gost", targetIp: "127.0.0.1", egressType: "ss_host", egressInboundId: classic.inboundId, protocol: "tcp", sourcePort: 29902, targetPort: ECHO_PORT, name: "old host classic tcp" });
// 规则建好之后入口机失去能力（例如运行时回滚）：直接写库模拟一条已经存在的 UDP 出口规则。
await exec(
  'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "egressType", "egressInboundId", "egressUdp") VALUES (9900, 11, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 1)',
  ["old host udp egress", "gost", "both", 29903, "127.0.0.1", ECHO_PORT, "ss_host", classic.inboundId],
);
plan.gating.oldHostTcpRuleId = oldTcp.id;

const express = (await import("express")).default;
const route = await import(url("server/agentHeartbeatRoute.ts"));
const gate = await import(url("server/agentHeartbeatGate.ts"));
const app = express();
app.use(express.json());
app.use((req, _res, next) => { const a = String(req.headers.authorization || ""); req.agentToken = a.startsWith("Bearer ") ? a.slice(7) : ""; next(); });
route.registerAgentHeartbeatRoute(app);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const heartbeat = async (token, caps, runtimeVersion) => {
  for (const id of [10, 11, 20]) gate.agentStableHeartbeatPlanCache.invalidate(id);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ agentVersion: "2.2.227", runtimeVersion, agentCapabilities: caps, uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1 }),
  });
  if (response.status !== 200) throw new Error("heartbeat failed " + response.status);
  return response.json();
};
const configFrom = (body, test) => {
  for (const action of body.desiredState?.actions || []) {
    for (const config of action.managedConfigs || []) {
      if (test(String(config.path || ""))) return Buffer.from(config.contentBase64, "base64").toString("utf8");
    }
  }
  return null;
};
const entry = await heartbeat("tok10", CAPS, "3.2.6-nex3");
const oldEntry = await heartbeat("tok11", [], "3.2.6-nex2");
const landing = await heartbeat("tok20", CAPS, "3.2.6-nex3");
server.close();

const toLoopback = (text) => text.split(`${LANDING_IP}:`).join("127.0.0.1:");
const gostText = configFrom(entry, (p) => p.endsWith("/gost.json"));
const oldGostText = configFrom(oldEntry, (p) => p.endsWith("/gost.json"));
const singbox = configFrom(landing, (p) => /sing-?box/i.test(p) && p.endsWith(".json"));
if (!gostText || !singbox) throw new Error(`missing config: gost=${!!gostText} singbox=${!!singbox}`);
fs.writeFileSync(path.join(OUT, "gost.json"), toLoopback(gostText));
fs.writeFileSync(path.join(OUT, "gost-old-host.json"), oldGostText || "{}");
const singboxConfig = JSON.parse(singbox);
singboxConfig.inbounds = [...(singboxConfig.inbounds || []), ...extraInbounds];
fs.writeFileSync(path.join(OUT, "singbox.json"), JSON.stringify(singboxConfig, null, 2));

// 卡片上的状态（规则列表接口）。
const listed = await rules.list({ scope: "all" });
const stateOf = (id) => listed.find((item) => item.id === id)?.egress || null;
plan.gating.oldHostUdpRuleState = stateOf(9900);
plan.gating.oldHostTcpRuleState = stateOf(oldTcp.id)?.state;
plan.gating.newHostUdpRuleState = stateOf(classic.ruleIds[0]);
const oldGost = JSON.parse(oldGostText || "{}");
plan.gating.oldHostServices = (oldGost.services || []).map((service) => service.name);
plan.gating.oldHostChains = (oldGost.chains || []).map((chain) => `${chain.name}:${chain.hops?.[0]?.nodes?.[0]?.connector?.type}`);
fs.writeFileSync(path.join(OUT, "plan.json"), JSON.stringify(plan, null, 2));
console.log(JSON.stringify({ methods: Object.keys(plan.methods), link: plan.link, plain: plan.plain, gating: plan.gating }));
process.exit(0);
