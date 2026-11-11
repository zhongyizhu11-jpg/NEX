#!/usr/bin/env node
/*
  VLESS Reality 出口的端到端验证：拿随 Agent 下发的真二进制把规则的 TCP 和 UDP 整条路跑一遍。

    客户端 ─TCP/UDP─▶ gost 运行时（入口:规则端口，面板生成的 gost.json）
                       └─ socks5（UDP 时 relay=udp 的 UDP ASSOCIATE）──▶ sing-box 桥接（面板生成的 egress.json）
                            └─ vless + REALITY + Vision（UDP 走 xudp）──▶ sing-box 落地（面板生成的落地入站配置）
                                 └─▶ 本机 TCP / UDP 回声服务（目标）

  配置不是手写的：子进程（--generate）在临时 SQLite 库里用面板真实的接口建主机、VLESS REALITY 落地入站
  （proxyInboundsRouter.create）、带出口的规则（rulesRouter.create，保存时的校验全走一遍），再给入口机、落地机
  各发一次真实心跳，从下发的 desiredState 里取出 gost.json、egress.json 和落地的 sing-box 配置。只改了几处，
  都不碰数据路径：
    - 面板不许出口服务器是 127.x，库里落地用文档地址 198.51.100.10，写文件时换成 127.0.0.1；
    - 落地 REALITY 的握手目标换成本机起的 TLS 1.3 服务（REALITY 要把握手转给一个真的 TLS 1.3 站点）；
    - 日志级别调到 info：拿 gost 每个流结束时记的 inputBytes / outputBytes 和 sing-box 的连接日志当证据。

  验的是：UDP 各种大小的数据报逐字节回来、多个源端口同时发互不串、空闲超过 gost UDP 监听 ttl 后同一个源端口
  能恢复、gost 数到的字节和客户端发收的一致（root 且有 nft 时再加一份和 Agent 同口径的 nft 端口计数）、
  限速对出口规则和普通规则一样生效、桥接停掉时 UDP / TCP 都不通（没有偷偷直连）、桥接重启后恢复；TCP 回声照旧。

  用法（仓库根目录）：
    GOST_BIN=<gost-runtime/build.sh 编出来的 forwardx-runtime> SING_BOX_BIN=<sing-box 1.14.0> node scripts/verify-vless-egress.mjs
  没给二进制（CI）时打印 SKIP、退出码 0；REQUIRE_BINARIES=1 时缺二进制算失败。
  --generate-only <目录>：只用面板代码生成配置并检查形状（不需要二进制，scripts/verifyVlessEgress.test.ts 跑这个）。
  环境变量：IDLE_SECONDS（默认 65：gost 的 UDP 监听每 ttl（面板下发 30s）查一次空闲，连着两次都空闲才回收，
  所以一个流在最后一个包之后 30~60 秒之间才结束；0 跳过空闲恢复和 gost 字节核对）、
  BASE_PORT（默认 31000）、KEEP_WORK=1 保留工作目录、NO_NFT=1 不用 nft。
*/
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANDING_IP = "198.51.100.10";
const BASE_PORT = Number(process.env.BASE_PORT || 31000);
const PORTS = {
  echo: BASE_PORT + 500,
  tls: BASE_PORT + 444,
  landing: BASE_PORT + 443,
  rules: { both: BASE_PORT + 1, udpLink: BASE_PORT + 2, tcp: BASE_PORT + 3, udpLimited: BASE_PORT + 4, plainLimited: BASE_PORT + 5, plain: BASE_PORT + 6 },
};
const REALITY_SNI = "www.example.com";
const RATE_LIMIT_MBPS = 2;

/* ── 子进程：用面板代码生成配置（要 tsx 和临时库的环境变量，所以单独一个进程）──────────────── */

async function generate(out) {
  const url = (file) => pathToFileURL(path.join(ROOT, file)).href;
  const runtime = await import(url("server/dbRuntime.ts"));
  const schema = await import(url("server/dbSchema.ts"));
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
  await schema.ensureDatabaseSchema();
  const exec = (sql, params = []) => runtime.executeRaw(sql, params);
  const query = (sql, params = []) => runtime.queryRaw(sql, params);
  const now = Math.floor(Date.now() / 1000);
  const agentVersion = "2.2.253";

  await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
  const addHost = (id, name, ip, token) => exec(
    'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "runtimeVersion") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)',
    [id, name, ip, ip, "slave", token, now, agentVersion, "3.2.6-nex5"],
  );
  // 入口机不报 ssEgressUdp 能力：VLESS 的 UDP 不该依赖它。
  await addHost(10, "入口", "203.0.113.10", "tok10");
  await addHost(20, "落地", LANDING_IP, "tok20");

  const ctx = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
  const { proxyInboundsRouter } = await import(url("server/routers/proxyInbounds.ts"));
  const { rulesRouter } = await import(url("server/routers/rules.ts"));
  const rules = rulesRouter.createCaller(ctx);
  const inboundApi = proxyInboundsRouter.createCaller(ctx);

  const created = await inboundApi.create({
    hostId: 20, name: "落地 REALITY", protocol: "vless", port: PORTS.landing, transport: "tcp", security: "reality",
    flow: "xtls-rprx-vision", serverName: REALITY_SNI,
  });
  const inboundId = Number(created?.id ?? created);
  const inbound = (await query('SELECT "realityPublicKey", "realityShortId", "serverName", port FROM proxy_inbounds WHERE id = ?', [inboundId]))[0];
  const user = (await query('SELECT uuid FROM proxy_inbound_users WHERE "inboundId" = ? ORDER BY id LIMIT 1', [inboundId]))[0];
  if (!inbound?.realityPublicKey || !user?.uuid) throw new Error("landing inbound has no REALITY key / user");
  const sid = String(inbound.realityShortId || "").split(",")[0].trim();
  const link = `vless://${user.uuid}@${LANDING_IP}:${inbound.port}?type=tcp&security=reality&flow=xtls-rprx-vision&sni=${inbound.serverName}&fp=chrome&pbk=${inbound.realityPublicKey}${sid ? `&sid=${sid}` : ""}#verify`;

  const base = { hostId: 10, forwardType: "gost", targetIp: "127.0.0.1", targetPort: PORTS.echo };
  const viaHost = { egressType: "vless_host", egressInboundId: inboundId };
  const ids = {};
  ids.both = (await rules.create({ ...base, ...viaHost, name: "VLESS TCP+UDP", protocol: "both", egressUdp: true, sourcePort: PORTS.rules.both })).id;
  ids.udpLink = (await rules.create({ ...base, egressType: "vless_link", egressLink: link, name: "VLESS 链接 UDP", protocol: "udp", egressUdp: true, sourcePort: PORTS.rules.udpLink })).id;
  ids.tcp = (await rules.create({ ...base, ...viaHost, name: "VLESS TCP", protocol: "tcp", sourcePort: PORTS.rules.tcp })).id;
  ids.udpLimited = (await rules.create({ ...base, ...viaHost, name: "VLESS UDP 限速", protocol: "udp", egressUdp: true, sourcePort: PORTS.rules.udpLimited })).id;
  ids.plainLimited = (await rules.create({ ...base, name: "普通 UDP 限速", protocol: "udp", sourcePort: PORTS.rules.plainLimited })).id;
  ids.plain = (await rules.create({ ...base, name: "普通 TCP+UDP", protocol: "both", sourcePort: PORTS.rules.plain })).id;
  // 单条规则限速（server/ruleLimits.ts）直接写库：出口规则和普通规则同一个数，比的是两者限得一样。
  for (const id of [ids.udpLimited, ids.plainLimited]) await exec('UPDATE forward_rules SET "rateLimitMbps" = ? WHERE id = ?', [RATE_LIMIT_MBPS, id]);
  const rejected = await rules.create({ ...base, ...viaHost, name: "UDP 不走出口", protocol: "both", egressUdp: false, sourcePort: BASE_PORT + 9 })
    .then(() => "saved", (error) => String(error?.message || error));

  const express = (await import("express")).default;
  const route = await import(url("server/agentHeartbeatRoute.ts"));
  const gate = await import(url("server/agentHeartbeatGate.ts"));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { const auth = String(req.headers.authorization || ""); req.agentToken = auth.startsWith("Bearer ") ? auth.slice(7) : ""; next(); });
  route.registerAgentHeartbeatRoute(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const heartbeat = async (token) => {
    for (const id of [10, 20]) gate.agentStableHeartbeatPlanCache.invalidate(id);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ agentVersion, runtimeVersion: "3.2.6-nex5", agentCapabilities: [], uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1 }),
    });
    if (response.status !== 200) throw new Error("heartbeat failed " + response.status + " " + await response.text());
    return response.json();
  };
  const configAt = (body, test) => {
    for (const action of body.desiredState?.actions || []) {
      for (const config of action.managedConfigs || []) {
        if (test(String(config.path || ""))) return Buffer.from(config.contentBase64, "base64").toString("utf8");
      }
    }
    return null;
  };
  const entry = await heartbeat("tok10");
  const landing = await heartbeat("tok20");
  server.close();
  const gostText = configAt(entry, (p) => p.endsWith("/gost.json"));
  const bridgeText = configAt(entry, (p) => p === "/etc/forwardx/singbox/egress.json");
  const landingText = configAt(landing, (p) => p === "/etc/forwardx/singbox/config.json");
  if (!gostText || !bridgeText || !landingText) throw new Error(`missing config: gost=${!!gostText} bridge=${!!bridgeText} landing=${!!landingText}`);
  fs.writeFileSync(path.join(out, "gost.panel.json"), gostText);
  fs.writeFileSync(path.join(out, "egress.panel.json"), bridgeText);
  fs.writeFileSync(path.join(out, "landing.panel.json"), landingText);
  const listed = await rules.list({ scope: "all" });
  const egressOf = (id) => listed.find((item) => item.id === id)?.egress || null;
  fs.writeFileSync(path.join(out, "plan.json"), JSON.stringify({
    ids, rejected, link: link.replace(String(user.uuid), "<uuid>"),
    egress: Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, egressOf(id) && { state: egressOf(id).state, udp: egressOf(id).udp }])),
  }, null, 2));
}

/** 面板生成的配置形状对不对（不需要二进制）。失败时抛出。 */
function checkGeneratedShapes(dir) {
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  const gost = JSON.parse(fs.readFileSync(path.join(dir, "gost.panel.json"), "utf8"));
  const bridge = JSON.parse(fs.readFileSync(path.join(dir, "egress.panel.json"), "utf8"));
  const errors = [];
  const expect = (ok, message) => { if (!ok) errors.push(message); };
  const service = (name) => (gost.services || []).find((item) => item.name === name);
  const chain = (name) => (gost.chains || []).find((item) => item.name === name);
  const { ids } = plan;
  expect(/UDP 也要走出口/.test(plan.rejected), `TCP+UDP without egressUdp must be rejected, got: ${plan.rejected}`);
  for (const key of ["both", "udpLink", "udpLimited"]) {
    const udp = service(`fwx-${ids[key]}-udp`);
    expect(udp?.handler?.chain === `chain-egress-${ids[key]}-udp`, `${key}: UDP service must use the egress chain`);
    const node = chain(udp?.handler?.chain)?.hops?.[0]?.nodes?.[0];
    expect(node?.connector?.type === "socks5" && node?.connector?.metadata?.relay === "udp" && node?.dialer?.type === "tcp", `${key}: UDP chain must be socks5 relay=udp over tcp`);
    // gost 只认字符串形式的整数 metadata；写成数字时缓冲退回 4096，大包会被截断。
    expect(node?.connector?.metadata?.udpBufferSize === "65535", `${key}: udpBufferSize must be the string "65535"`);
    expect(bridge.outbounds.find((item) => item.tag === `egress-${ids[key]}`)?.packet_encoding === "xudp", `${key}: bridge outbound must use xudp`);
    expect(plan.egress[key]?.state === "running" && plan.egress[key]?.udp === true, `${key}: card state ${JSON.stringify(plan.egress[key])}`);
  }
  const tcpNode = chain(service(`fwx-${ids.tcp}-tcp`)?.handler?.chain)?.hops?.[0]?.nodes?.[0];
  expect(JSON.stringify(tcpNode?.connector?.metadata) === JSON.stringify({ notls: true }), "TCP-only chain metadata must stay {notls:true}");
  expect(!service(`fwx-${ids.tcp}-udp`), "TCP-only rule must not get a UDP service");
  expect(!("packet_encoding" in (bridge.outbounds.find((item) => item.tag === `egress-${ids.tcp}`) || {})), "TCP-only outbound must not carry packet_encoding");
  expect(bridge.inbounds.every((item) => item.type === "socks" && item.listen === "127.0.0.1" && item.users?.length), "bridge inbounds must be loopback socks with credentials");
  expect(!bridge.outbounds.some((item) => item.type !== "vless"), "bridge must only have vless outbounds");
  // 限速器按规则各一个（同名共桶），比的是限速值一样。
  const limitsOf = (name) => JSON.stringify((gost.limiters || []).find((item) => item.name === service(name)?.limiter)?.limits || null);
  expect(limitsOf(`fwx-${ids.udpLimited}-udp`) !== "null" && limitsOf(`fwx-${ids.udpLimited}-udp`) === limitsOf(`fwx-${ids.plainLimited}-udp`), "UDP egress rule must carry the same rate limit as the plain rule");
  if (errors.length) throw new Error("generated configs: " + errors.join("; "));
  return plan;
}

/* ── 主进程 ─────────────────────────────────────────────────────────────── */

const children = [];
let workDir = "";
let nftTable = "";

function log(message) { console.log(`[verify-vless] ${message}`); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function runGenerate(dir) {
  fs.rmSync(path.join(dir, "verify.db"), { force: true });
  const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--generate", dir], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(dir, "verify.db") },
    timeout: 240_000,
  });
  if (result.status !== 0) throw new Error(`config generation failed:\n${result.stdout}\n${result.stderr}`);
}

function start(name, bin, args) {
  const file = path.join(workDir, `${name}.log`);
  const out = fs.openSync(file, "w");
  const child = spawn(bin, args, { stdio: ["ignore", out, out] });
  children.push({ name, child, file });
  return child;
}

async function waitTcp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(true); });
      socket.on("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`port ${port} did not come up`);
}

function stopChild(entry) {
  return new Promise((resolve) => {
    if (entry.child.exitCode !== null || entry.child.signalCode) return resolve();
    entry.child.once("exit", () => resolve());
    entry.child.kill("SIGTERM");
  });
}

/** 目标：TCP、UDP 回声（同一个端口）。UDP 回声原样回包。 */
function startEcho(port) {
  const udp = dgram.createSocket("udp4");
  udp.on("message", (message, remote) => udp.send(message, remote.port, remote.address));
  const tcp = net.createServer((socket) => socket.pipe(socket));
  return Promise.all([
    new Promise((resolve) => udp.bind(port, "127.0.0.1", resolve)),
    new Promise((resolve) => tcp.listen(port, "127.0.0.1", resolve)),
  ]).then(() => ({ close: () => { udp.close(); tcp.close(); } }));
}

/** REALITY 的握手目标：一个本机 TLS 1.3 站点（证书用 sing-box 现生成的自签名）。 */
async function startTlsDest(singBox, port) {
  const out = spawnSync(singBox, ["generate", "tls-keypair", REALITY_SNI], { encoding: "utf8" });
  if (out.status !== 0) throw new Error("sing-box generate tls-keypair failed: " + out.stderr);
  const key = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/.exec(out.stdout)?.[0];
  const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(out.stdout)?.[0];
  const server = tls.createServer({ key, cert, minVersion: "TLSv1.3" }, (socket) => {
    socket.on("error", () => {});
    socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
  });
  server.on("tlsClientError", () => {});
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

/**
 * 一个源端口发一串数据报，逐个比对回包。每个包带 16 字节标记，回包按标记对上。最多 window 个在路上：
 * 一口气灌进去的话，丢包发生在客户端 → gost 那一段回环（gost 的接收缓冲满了），量的就不是出口这条路了。
 * 返回发了多少、回来多少、丢了 / 坏了 / 重复 / 对不上的各多少，以及发出 / 收到 / 丢掉的负载字节数。
 */
async function udpExchange(port, { sizes, perSize, socket: given, window = 8, waitMs = 1500 }) {
  const socket = given || dgram.createSocket("udp4");
  if (!given) await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const queue = [];
  for (const size of sizes) for (let index = 0; index < perSize; index += 1) queue.push(crypto.randomBytes(Math.max(size, 16)));
  const pending = new Map();
  const done = new Set();
  const stats = { sent: 0, ok: 0, lost: 0, corrupt: 0, duplicate: 0, foreign: 0, bytesOut: 0, bytesIn: 0, lostBytes: 0 };
  let wake = () => {};
  const onMessage = (message) => {
    stats.bytesIn += message.length;
    const tag = message.subarray(0, 16).toString("hex");
    const expected = pending.get(tag);
    if (!expected) {
      if (done.has(tag)) stats.duplicate += 1; else stats.foreign += 1;
      return;
    }
    pending.delete(tag);
    done.add(tag);
    if (Buffer.compare(expected.payload, message) === 0) stats.ok += 1; else stats.corrupt += 1;
    wake();
  };
  socket.on("message", onMessage);
  const expire = () => {
    const now = Date.now();
    for (const [tag, item] of pending) {
      if (now - item.at < waitMs) continue;
      pending.delete(tag);
      done.add(tag);
      stats.lost += 1;
      stats.lostBytes += item.payload.length;
    }
  };
  while (queue.length > 0 || pending.size > 0) {
    while (queue.length > 0 && pending.size < window) {
      const payload = queue.shift();
      pending.set(payload.subarray(0, 16).toString("hex"), { payload, at: Date.now() });
      socket.send(payload, port, "127.0.0.1");
      stats.sent += 1;
      stats.bytesOut += payload.length;
    }
    await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 50); });
    expire();
  }
  // 晚到的回包也要数进来（算重复 / 对不上），所以多等一小会儿再撤监听。
  await sleep(200);
  socket.off("message", onMessage);
  if (!given) socket.close();
  return stats;
}

/** 多个源端口同时发：每个回包必须回到发它的那个源端口。 */
async function udpFlows(port, flows, rounds) {
  const results = await Promise.all(Array.from({ length: flows }, () => udpExchange(port, { sizes: [200], perSize: rounds, window: 2 })));
  const sum = {};
  for (const item of results) for (const [key, value] of Object.entries(item)) sum[key] = (sum[key] || 0) + value;
  return sum;
}

/** 一串 TCP 连接各回声 bytes 字节，SHA-256 比对。 */
async function tcpEcho(port, conns, bytes, timeoutMs = 20000) {
  const one = () => new Promise((resolve) => {
    const payload = crypto.randomBytes(bytes);
    const chunks = [];
    let received = 0;
    const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= bytes) {
        clearTimeout(timer);
        socket.destroy();
        const hash = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
        resolve(hash(Buffer.concat(chunks).subarray(0, bytes)) === hash(payload));
      }
    });
    socket.on("error", () => { clearTimeout(timer); resolve(false); });
    socket.on("close", () => { clearTimeout(timer); if (received < bytes) resolve(false); });
  });
  const results = await Promise.all(Array.from({ length: conns }, one));
  return { conns, ok: results.filter(Boolean).length, bytes };
}

/** 限速对比：同样的速率（按时间补齐，不受事件循环抖动影响）发 seconds 秒，数回来多少字节。 */
async function udpBlast(port, seconds, packetSize = 1200, pps = 2000) {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  let bytesIn = 0;
  socket.on("message", (message) => { bytesIn += message.length; });
  const payload = crypto.randomBytes(packetSize);
  const total = pps * seconds;
  const begin = Date.now();
  let sent = 0;
  while (sent < total && Date.now() - begin < (seconds + 2) * 1000) {
    const due = Math.min(total, Math.floor(((Date.now() - begin) / 1000) * pps));
    for (let budget = 200; sent < due && budget > 0; budget -= 1) { socket.send(payload, port, "127.0.0.1"); sent += 1; }
    await sleep(5);
  }
  const elapsed = (Date.now() - begin) / 1000;
  await sleep(1500);
  socket.close();
  return { sentBytes: sent * packetSize, seconds: Number(elapsed.toFixed(2)), bytesIn, mbps: Number(((bytesIn * 8) / elapsed / 1e6).toFixed(2)) };
}

/* nft 端口计数：和 Agent 的 counting_rules.go 同口径（input 按目的端口、output 按源端口）。 */
function setupNft(ports) {
  if (process.env.NO_NFT || typeof process.getuid !== "function" || process.getuid() !== 0) return false;
  if (spawnSync("nft", ["--version"]).status !== 0) return false;
  nftTable = `nex_vless_verify_${process.pid}`;
  const lines = [
    `table inet ${nftTable} {`,
    "  chain input { type filter hook input priority -10; policy accept;",
    ...ports.flatMap((port) => [`    udp dport ${port} counter comment "udp-in-${port}"`, `    tcp dport ${port} counter comment "tcp-in-${port}"`]),
    "  }",
    "  chain output { type filter hook output priority -10; policy accept;",
    ...ports.flatMap((port) => [`    udp sport ${port} counter comment "udp-out-${port}"`, `    tcp sport ${port} counter comment "tcp-out-${port}"`]),
    "  }",
    "}",
  ];
  const file = path.join(workDir, "nft-counters.nft");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const result = spawnSync("nft", ["-f", file], { encoding: "utf8" });
  if (result.status !== 0) { nftTable = ""; log(`nft unavailable: ${result.stderr.trim()}`); return false; }
  return true;
}

function readNft() {
  const result = spawnSync("nft", ["-j", "list", "table", "inet", nftTable], { encoding: "utf8" });
  const counters = {};
  for (const item of JSON.parse(result.stdout).nftables || []) {
    const rule = item.rule;
    if (!rule) continue;
    const counter = rule.expr.find((expr) => expr.counter)?.counter;
    if (counter && rule.comment) counters[rule.comment] = { packets: counter.packets, bytes: counter.bytes };
  }
  return counters;
}

/** gost 每个流结束时那一行（"><"）记的 inputBytes / outputBytes，按服务加起来。 */
function gostFlowBytes(file, serviceName) {
  let input = 0;
  let output = 0;
  let flows = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.service !== serviceName || entry.inputBytes === undefined) continue;
    input += Number(entry.inputBytes || 0);
    output += Number(entry.outputBytes || 0);
    flows += 1;
  }
  return { flows, input, output };
}

function countLines(file, pattern) {
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => pattern.test(line)).length;
}

async function main() {
  if (process.argv[2] === "--generate") {
    await generate(process.argv[3]);
    process.exit(0);
  }
  if (process.argv[2] === "--generate-only") {
    const dir = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "nex-vless-verify-"));
    fs.mkdirSync(dir, { recursive: true });
    runGenerate(dir);
    const plan = checkGeneratedShapes(dir);
    console.log(`RESULT generated-configs ok rules=${JSON.stringify(plan.ids)}`);
    return;
  }

  const gostBin = process.env.GOST_BIN || "";
  const singBox = process.env.SING_BOX_BIN || "";
  const missing = [["GOST_BIN", gostBin], ["SING_BOX_BIN", singBox]].filter(([, file]) => !file || !fs.existsSync(file)).map(([name]) => name);
  if (missing.length > 0) {
    const message = `SKIP verify-vless-egress: ${missing.join(", ")} not set or not found (see the header of scripts/verify-vless-egress.mjs)`;
    if (process.env.REQUIRE_BINARIES) throw new Error(message);
    console.log(message);
    return;
  }
  const idleSeconds = Number(process.env.IDLE_SECONDS ?? 65);
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-vless-verify-"));
  const results = [];
  const fails = [];
  const record = (name, ok, detail) => {
    const line = `RESULT ${name} ${ok ? "ok" : "FAIL"} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    console.log(line);
    results.push(line);
    if (!ok) fails.push(name);
  };

  log(`gost: ${spawnSync(gostBin, ["-V"], { encoding: "utf8" }).stdout.trim()}`);
  log(`sing-box: ${spawnSync(singBox, ["version"], { encoding: "utf8" }).stdout.split("\n")[0]}`);
  log(`work dir ${workDir}; generating configs with the panel code paths`);
  runGenerate(workDir);
  const plan = checkGeneratedShapes(workDir);
  const { ids } = plan;
  record("generated-configs", true, { ids, cardStates: plan.egress });

  // 只换地址、握手目标和日志级别（见文件开头），数据路径上的字段原样。
  const gost = JSON.parse(fs.readFileSync(path.join(workDir, "gost.panel.json"), "utf8"));
  gost.log = { level: "info", format: "json", output: "stdout" };
  fs.writeFileSync(path.join(workDir, "gost.json"), JSON.stringify(gost, null, 2));
  const bridge = JSON.parse(fs.readFileSync(path.join(workDir, "egress.panel.json"), "utf8").split(`"${LANDING_IP}"`).join('"127.0.0.1"'));
  bridge.log = { ...(bridge.log || {}), level: "info" };
  fs.writeFileSync(path.join(workDir, "egress.json"), JSON.stringify(bridge, null, 2));
  const landing = JSON.parse(fs.readFileSync(path.join(workDir, "landing.panel.json"), "utf8"));
  landing.log = { ...(landing.log || {}), level: "info" };
  const realityInbound = (landing.inbounds || []).find((item) => item.type === "vless" && item.listen_port === PORTS.landing);
  if (!realityInbound?.tls?.reality) throw new Error("landing config has no REALITY inbound on " + PORTS.landing);
  realityInbound.tls.reality.handshake = { server: "127.0.0.1", server_port: PORTS.tls };
  fs.writeFileSync(path.join(workDir, "landing.json"), JSON.stringify(landing, null, 2));
  for (const file of ["egress.json", "landing.json"]) {
    const check = spawnSync(singBox, ["check", "-c", path.join(workDir, file)], { encoding: "utf8" });
    if (check.status !== 0) throw new Error(`sing-box check ${file}: ${check.stderr}`);
  }

  const echo = await startEcho(PORTS.echo);
  const tlsDest = await startTlsDest(singBox, PORTS.tls);
  const rulePorts = Object.values(PORTS.rules);
  const nft = setupNft(rulePorts);
  try {
    const landingProc = start("landing", singBox, ["run", "-c", path.join(workDir, "landing.json")]);
    let bridgeProc = start("bridge", singBox, ["run", "-c", path.join(workDir, "egress.json")]);
    start("gost", gostBin, ["-C", path.join(workDir, "gost.json")]);
    await waitTcp(PORTS.landing);
    for (const inbound of bridge.inbounds) await waitTcp(inbound.listen_port);
    for (const port of rulePorts) if (port !== PORTS.rules.udpLink && port !== PORTS.rules.udpLimited && port !== PORTS.rules.plainLimited) await waitTcp(port);
    await sleep(500);
    void landingProc;

    const sizes = [1, 64, 512, 1200, 1400, 1472, 4096, 8192];
    const perSize = 40;
    // 回环上不该丢：留 1% 的余量只是不让偶发的调度抖动把整次验证判死；坏包、串包、重复一个都不许。
    const udpOk = (result) => result.corrupt === 0 && result.foreign === 0 && result.duplicate === 0 && result.ok >= result.sent * 0.99;
    const totals = {};
    const addTotal = (key, result) => {
      totals[key] = totals[key] || { bytesOut: 0, bytesIn: 0, lostBytes: 0 };
      totals[key].bytesOut += result.bytesOut;
      totals[key].bytesIn += result.bytesIn;
      totals[key].lostBytes += result.lostBytes;
    };

    // 同一个源端口发完所有大小：后面空闲恢复要用回这个源端口。
    const keepSocket = dgram.createSocket("udp4");
    await new Promise((resolve) => keepSocket.bind(0, "127.0.0.1", resolve));
    const both = await udpExchange(PORTS.rules.both, { sizes, perSize, socket: keepSocket });
    addTotal("both", both);
    record("udp-echo/vless_host-both", udpOk(both), both);
    const viaLink = await udpExchange(PORTS.rules.udpLink, { sizes, perSize });
    addTotal("udpLink", viaLink);
    record("udp-echo/vless_link-udp", udpOk(viaLink), viaLink);
    const flows = await udpFlows(PORTS.rules.both, 32, 20);
    addTotal("both", flows);
    record("udp-flows-32/vless_host-both", udpOk(flows), flows);
    const plainUdp = await udpExchange(PORTS.rules.plain, { sizes, perSize: 10 });
    record("udp-echo/plain-no-egress", udpOk(plainUdp), plainUdp);

    const tcpBoth = await tcpEcho(PORTS.rules.both, 8, 4 << 20);
    record("tcp-echo/vless_host-both", tcpBoth.ok === tcpBoth.conns, tcpBoth);
    const tcpOnly = await tcpEcho(PORTS.rules.tcp, 8, 4 << 20);
    record("tcp-echo/vless_host-tcp-only", tcpOnly.ok === tcpOnly.conns, tcpOnly);

    // 桥接确实在路上：落地 / 桥接都记了 UDP 的包连接（xudp 进、直连出）。
    const landingPackets = countLines(path.join(workDir, "landing.log"), /inbound\/vless.*inbound packet connection/);
    const bridgePackets = countLines(path.join(workDir, "bridge.log"), /inbound\/socks.*inbound packet connection/);
    record("path-evidence", landingPackets > 0 && bridgePackets > 0, { landingVlessPacketConns: landingPackets, bridgeSocksPacketConns: bridgePackets });

    if (idleSeconds > 0) {
      const sessionsOf = (port) => countLines(path.join(workDir, "gost.log"), new RegExp(`"client":"127\\.0\\.0\\.1:${port}".*"msg":"[^"]* <> `));
      log(`idle ${idleSeconds}s (gost recycles an idle UDP flow 30~60s after its last packet) before resuming on the same source port`);
      await sleep(idleSeconds * 1000);
      const keepPort = keepSocket.address().port;
      const closedBefore = gostFlowBytes(path.join(workDir, "gost.log"), `fwx-${ids.both}-udp`).flows;
      const resumed = await udpExchange(PORTS.rules.both, { sizes: [100, 1400], perSize: 20, socket: keepSocket });
      addTotal("both", resumed);
      // 同一个源端口：旧会话已经被回收，新包要立刻建一个新会话（gost 对这个源端口记了第二个「<>」，即新的 UDP ASSOCIATE）
      // 并收到回包。gostFlowsClosedBeforeResume 是此刻 gost 已经记下结束的流数，只作参考。
      record("udp-idle-resume/vless_host-both", udpOk(resumed) && sessionsOf(keepPort) >= 2, { ...resumed, gostSessionsForSourcePort: sessionsOf(keepPort), gostFlowsClosedBeforeResume: closedBefore });
      await sleep(idleSeconds * 1000);
      // gost 在流结束（空闲超过 ttl）时记一行字节数：和客户端发出 / 收到的负载对得上，说明 UDP 都过了入口的 gost。
      for (const key of ["both", "udpLink"]) {
        const counted = gostFlowBytes(path.join(workDir, "gost.log"), `fwx-${ids[key]}-udp`);
        // 客户端收到的每个字节都是 gost 回的；gost 收到的 = 客户端发的减去在回环上丢掉的（没丢就完全相等）。
        const ok = counted.output === totals[key].bytesIn
          && counted.input <= totals[key].bytesOut && counted.input >= totals[key].bytesOut - totals[key].lostBytes;
        record(`gost-byte-count/${key}`, ok, { gost: counted, client: totals[key] });
      }
    }
    keepSocket.close();
    // 限速（放在字节核对之后，免得灌的量混进去）：出口规则和普通规则同一个限速，同样的发包速率，
    // 回来的量应该差不多，并且远低于不限速的出口规则。
    const limitedEgress = await udpBlast(PORTS.rules.udpLimited, 3);
    const limitedPlain = await udpBlast(PORTS.rules.plainLimited, 3);
    const unlimited = await udpBlast(PORTS.rules.both, 3);
    // 不限速的那一次要真的灌得进去（发了 ≥90%），对比才有意义。
    const parity = unlimited.sentBytes >= 2000 * 3 * 1200 * 0.9
      && limitedEgress.bytesIn <= Math.max(limitedPlain.bytesIn * 1.5, 64 * 1024) && limitedEgress.bytesIn < unlimited.bytesIn * 0.5;
    record("udp-rate-limit-parity", parity, { limitMbps: RATE_LIMIT_MBPS, egress: limitedEgress, plain: limitedPlain, unlimitedEgress: unlimited });

    if (nft) {
      const counters = readNft();
      const port = PORTS.rules.both;
      const udpIn = counters[`udp-in-${port}`];
      const udpOut = counters[`udp-out-${port}`];
      // nft 数的是整个 IP 包（多了 IP + UDP 头 28 字节），所以只能「不少于负载」。
      const ok = udpIn && udpOut && udpIn.bytes >= totals.both.bytesOut && udpOut.bytes >= totals.both.bytesIn;
      record("nft-port-counters/vless_host-both", !!ok, { udpIn, udpOut, tcpIn: counters[`tcp-in-${port}`], tcpOut: counters[`tcp-out-${port}`], clientPayload: totals.both });
    }

    // 桥接停掉：UDP、TCP 都不能通（没有直连兜底）；重启后同样的规则恢复。
    await stopChild(children.find((entry) => entry.child === bridgeProc));
    await sleep(500);
    const downUdp = await udpExchange(PORTS.rules.both, { sizes: [100], perSize: 20, waitMs: 1000 });
    const downTcp = await tcpEcho(PORTS.rules.both, 2, 4096, 4000);
    record("bridge-down-no-bypass", downUdp.ok === 0 && downTcp.ok === 0, { udp: downUdp, tcp: downTcp });
    bridgeProc = start("bridge-restarted", singBox, ["run", "-c", path.join(workDir, "egress.json")]);
    for (const inbound of bridge.inbounds) await waitTcp(inbound.listen_port);
    await sleep(500);
    const upUdp = await udpExchange(PORTS.rules.both, { sizes: [100, 1400], perSize: 20 });
    const upTcp = await tcpEcho(PORTS.rules.both, 2, 1 << 20);
    record("bridge-restart-recovers", udpOk(upUdp) && upTcp.ok === upTcp.conns, { udp: upUdp, tcp: upTcp });
  } finally {
    for (const entry of children.reverse()) await stopChild(entry);
    echo.close();
    tlsDest.close();
    if (nftTable) spawnSync("nft", ["delete", "table", "inet", nftTable]);
    if (process.env.KEEP_WORK) log(`work dir kept: ${workDir}`);
    else fs.rmSync(workDir, { recursive: true, force: true });
  }
  log(`${results.length - fails.length}/${results.length} passed`);
  if (fails.length) {
    console.log(`FAIL ${fails.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  for (const entry of children) entry.child.kill("SIGKILL");
  if (nftTable) spawnSync("nft", ["delete", "table", "inet", nftTable]);
  process.exit(1);
});
