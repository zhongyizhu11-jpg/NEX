#!/usr/bin/env node
/*
  控制面压测：模拟 N 台 Agent，按真实 Agent 的协议和节奏打一个面板副本。

  协议和 agent/ 里的 Go 代码一致：每个请求都是 POST /api/sync，body 是加密信封
  {v,iv,ct,mac,ts}（AES-256-CTR + HMAC，见 server/agentCrypto.ts / agent/panel_client.go），
  Authorization 是 v1 签名证明（agent/auth_proof.go）；SSE 走 GET /api/stream?e=<信封>。
  节奏照 agent/main.go、agent/heartbeat_schedule.go、agent/metrics.go：
    - presence 每 5 秒（减去 0~10% 的固定抖动）；
    - 完整心跳：连着 SSE 时 5 分钟一次（不连 SSE 时 60 秒），面板回的 nextInterval 更短时照办，
      requestLocalState 时 2 秒后带上整份 localState 再来；SSE 连上后 0~10 秒内补一次；
    - 流量：每 10 秒采一次，有规则流量时按面板给的间隔（默认 30 秒）上报，紧凑格式 s / h；
    - TCPing：规则数 < 100 时每 60 秒探一轮，每条结果没变化时 5 分钟报一次（Agent 端的上报闸门），
      隧道上的规则每轮都报；
    - 面板下发的期望状态（desiredState）照单「执行」：记进本地运行态、批量回报规则状态
      （/api/agent/rule-status-batch），下一次心跳带上新的 localState 和签名，面板随后走稳定快路径。
  失败重试：最少 5 秒、最多 30 秒的 full jitter，连续 4 次后冷却 1 分钟（和 Agent 一样）。

  用法：
    1) 往面板副本的库里放 N 台假主机（面板没起的时候跑；会先删掉上次放的 bench-* 主机）：
         DATABASE_CONFIG_PATH=/path/database.json node --import tsx scripts/bench/heartbeat-load.mjs \
           provision --hosts 200 --rules 20 --tunnel-hosts 0.5 --tunnel-share 0.2 --out /path/tokens.json
       （tunnel-hosts：多少比例的主机两两配一条 V2 隧道；tunnel-share：隧道入口机上多少比例的规则走隧道。
         其余规则 gost-share 比例是 gost，剩下的是 iptables。）
    2) 起面板（可选：FORWARDX_PERF_SAMPLE_FILE=/path/samples.jsonl 打开面板侧采样，见 server/perfSampler.ts；
       node --cpu-prof --cpu-prof-dir=/path/prof dist/index.js，跑完 kill -USR2 <pid> 让它写出剖析文件）。
    3) 跑：
         node scripts/bench/heartbeat-load.mjs run --panel http://127.0.0.1:9816 --tokens /path/tokens.json \
           --duration 600 --pid <面板 pid> --db /path/forwardx.db --samples /path/samples.jsonl --out /path/result.json
       可选：--no-sse、--warmup 120（前 120 秒不计入统计）、--restart-at 300（第 300 秒假装面板重启：
       所有 Agent 同时断开、按各自的退避重连）、--hosts 50（只用 tokens 里的前 50 台）。
    4) 剖析文件取自耗时前 N 的函数（可按 samples 里的时间窗口截取；--inclusive 看连同调用的同步代码一起的耗时）：
         node scripts/bench/heartbeat-load.mjs profile-top --profile /path/prof/x.cpuprofile \
           [--samples /path/samples.jsonl --from <ms> --to <ms>] [--top 25] [--inclusive] [--sourcemap dist/index.js.map]
*/
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) { out._.push(arg); continue; }
    const key = arg.slice(2);
    if (key.startsWith("no-")) { out[key.slice(3)] = false; continue; }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) { out[key] = true; continue; }
    out[key] = next;
    index += 1;
  }
  return out;
}

const numberArg = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/* ---------------------------------------------------------------- provision */

async function provision(options) {
  const hosts = Math.max(1, Math.floor(numberArg(options.hosts, 200)));
  const rulesPerHost = Math.max(0, Math.floor(numberArg(options.rules, 20)));
  const tunnelShare = Math.min(1, Math.max(0, numberArg(options["tunnel-share"], 0.2)));
  const tunnelHostShare = Math.min(1, Math.max(0, numberArg(options["tunnel-hosts"], 0.5)));
  const gostShare = Math.min(1, Math.max(0, numberArg(options["gost-share"], 0.3)));
  const agentVersion = String(options["agent-version"] || "2.2.249");
  const fxpVersion = String(options["fxp-version"] || "2.2.138");
  const out = String(options.out || "bench-tokens.json");
  const root = process.cwd();
  const url = (file) => pathToFileURL(path.join(root, file)).href;
  const runtime = await import(url("server/dbRuntime.ts"));
  const schema = await import(url("server/dbSchema.ts"));
  await runtime.connectDatabase();
  await schema.ensureDatabaseSchema();
  const q = runtime.quoteDbIdentifier;
  const exec = (sql, params = []) => runtime.executeRaw(sql, params);
  const query = (sql, params = []) => runtime.queryRaw(sql, params);

  const admins = await query(`SELECT id FROM ${q("users")} WHERE ${q("role")} = 'admin' ORDER BY id LIMIT 1`);
  if (!admins.length) throw new Error("no admin user in this database; finish panel setup first");
  const adminId = Number(admins[0].id);

  const previous = await query(`SELECT id FROM ${q("hosts")} WHERE ${q("name")} LIKE 'bench-%'`);
  const previousIds = previous.map((row) => Number(row.id));
  if (previousIds.length) {
    const list = previousIds.join(",");
    await exec(`DELETE FROM ${q("forward_rules")} WHERE ${q("hostId")} IN (${list})`);
    await exec(`DELETE FROM ${q("tunnels")} WHERE ${q("entryHostId")} IN (${list}) OR ${q("exitHostId")} IN (${list})`);
    await exec(`DELETE FROM ${q("hosts")} WHERE id IN (${list})`);
    console.log(`removed ${previousIds.length} previous bench hosts`);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const created = [];
  for (let index = 0; index < hosts; index += 1) {
    const token = crypto.randomBytes(24).toString("hex");
    const ip = `198.18.${Math.floor(index / 250)}.${(index % 250) + 2}`;
    const name = `bench-${String(index + 1).padStart(4, "0")}`;
    const hostId = await runtime.insertAndGetId("hosts", {
      name,
      ip,
      ipv4: ip,
      hostType: "slave",
      agentToken: token,
      agentVersion,
      fxpVersion,
      userId: adminId,
      isOnline: false,
      lastHeartbeat: new Date((nowSeconds - 600) * 1000),
    });
    created.push({ hostId, name, token, ip, rules: 0, tunnelRules: 0 });
  }

  // 前 tunnel-hosts 比例的主机两两配一条 forwardx V2 隧道（偶数号做入口），入口机上 tunnel-share 比例的规则走隧道。
  const tunnelByEntry = new Map();
  if (tunnelShare > 0) {
    const pairedHosts = Math.floor((created.length * tunnelHostShare) / 2) * 2;
    for (let index = 0; index + 1 < pairedHosts; index += 2) {
      const entry = created[index];
      const exit = created[index + 1];
      const tunnelId = await runtime.insertAndGetId("tunnels", {
        name: `bench-tunnel-${entry.hostId}-${exit.hostId}`,
        entryHostId: entry.hostId,
        exitHostId: exit.hostId,
        mode: "forwardx",
        forwardxVersion: "v2",
        listenPort: 31000 + index,
        userId: adminId,
        isEnabled: true,
      });
      tunnelByEntry.set(entry.hostId, tunnelId);
    }
  }

  for (const host of created) {
    const tunnelId = tunnelByEntry.get(host.hostId) || 0;
    const tunnelRules = tunnelId ? Math.round(rulesPerHost * tunnelShare) : 0;
    const gostRules = Math.round((rulesPerHost - tunnelRules) * gostShare);
    for (let index = 0; index < rulesPerHost; index += 1) {
      const onTunnel = index < tunnelRules;
      const forwardType = onTunnel ? "gost" : index < tunnelRules + gostRules ? "gost" : "iptables";
      const sourcePort = 20000 + index;
      await runtime.insertAndGetId("forward_rules", {
        hostId: host.hostId,
        name: `${host.name}-r${index + 1}`,
        forwardType,
        protocol: index % 5 === 4 ? "both" : "tcp",
        sourcePort,
        targetIp: `203.0.113.${(index % 250) + 1}`,
        targetPort: 443 + (index % 7),
        userId: adminId,
        isEnabled: true,
        isRunning: false,
        ...(onTunnel ? { tunnelId, tunnelExitPort: 40000 + index } : {}),
      });
      host.rules += 1;
      if (onTunnel) host.tunnelRules += 1;
    }
  }
  fs.writeFileSync(out, `${JSON.stringify({ createdAt: new Date().toISOString(), rulesPerHost, tunnelShare, tunnelHostShare, tunnels: tunnelByEntry.size, hosts: created }, null, 2)}\n`);
  console.log(`provisioned ${created.length} hosts × ${rulesPerHost} rules (${tunnelByEntry.size} tunnels) -> ${out}`);
  process.exit(0);
}

/* ------------------------------------------------------------------- crypto */

const keyCache = new Map();
function keys(token) {
  let cached = keyCache.get(token);
  if (!cached) {
    const sha = (text) => crypto.createHash("sha256").update(text).digest();
    cached = {
      enc: sha(`${token}|forwardx-agent-v1`),
      mac: sha(`${token}|forwardx-agent-mac`),
      auth: sha(`${token}|forwardx-agent-auth`),
      fingerprint: crypto.createHash("sha256").update(`${token}|forwardx-agent-auth-id`).digest("hex").slice(0, 32),
    };
    keyCache.set(token, cached);
  }
  return cached;
}

function macInput(iv, ct, ts) {
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64BE(BigInt(ts));
  return Buffer.concat([Buffer.from("v1"), iv, ct, tsBuf]);
}

function encrypt(payload, token) {
  const { enc, mac } = keys(token);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-ctr", enc, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  const ts = Date.now();
  return {
    v: 1,
    iv: iv.toString("hex"),
    ct: ct.toString("hex"),
    mac: crypto.createHmac("sha256", mac).update(macInput(iv, ct, ts)).digest("hex"),
    ts,
  };
}

function decrypt(envelope, token) {
  const { enc, mac } = keys(token);
  const iv = Buffer.from(envelope.iv, "hex");
  const ct = Buffer.from(envelope.ct, "hex");
  const expected = crypto.createHmac("sha256", mac).update(macInput(iv, ct, envelope.ts)).digest("hex");
  if (expected !== envelope.mac) throw new Error("response MAC mismatch");
  const decipher = crypto.createDecipheriv("aes-256-ctr", enc, iv);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"));
}

function authProof(token, method, requestPath, bodyText) {
  const { auth, fingerprint } = keys(token);
  const ts = Date.now();
  const nonce = crypto.randomBytes(16).toString("hex");
  const bodyHash = crypto.createHash("sha256").update(bodyText || "", "utf8").digest("hex");
  const input = ["v1", method.toUpperCase(), requestPath, String(ts), nonce, bodyHash].join("\n");
  const signature = crypto.createHmac("sha256", auth).update(input).digest("hex");
  return `v1.${fingerprint}.${ts}.${nonce}.${signature}`;
}

/* ------------------------------------------------------------------ metrics */

class Recorder {
  constructor() {
    this.windowStart = 0;
    this.series = new Map();
    this.heartbeatKinds = new Map();
    this.events = new Map();
    this.allKinds = new Map();
    this.allEvents = new Map();
  }
  startWindow(at = Date.now()) {
    this.windowStart = at;
    this.series.clear();
    this.heartbeatKinds.clear();
    this.events.clear();
  }
  latency(label, ms, status) {
    if (Date.now() < this.windowStart) return;
    let entry = this.series.get(label);
    if (!entry) { entry = { values: [], errors: new Map(), count: 0 }; this.series.set(label, entry); }
    entry.count += 1;
    if (status >= 200 && status < 300) entry.values.push(ms);
    else entry.errors.set(String(status), (entry.errors.get(String(status)) || 0) + 1);
  }
  heartbeatKind(kind) {
    this.allKinds.set(kind, (this.allKinds.get(kind) || 0) + 1);
    if (Date.now() < this.windowStart) return;
    this.heartbeatKinds.set(kind, (this.heartbeatKinds.get(kind) || 0) + 1);
  }
  event(name, count = 1) {
    this.allEvents.set(name, (this.allEvents.get(name) || 0) + count);
    if (Date.now() < this.windowStart) return;
    this.events.set(name, (this.events.get(name) || 0) + count);
  }
  summary(durationSeconds) {
    const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
    const endpoints = {};
    for (const [label, entry] of [...this.series.entries()].sort()) {
      const sorted = entry.values.slice().sort((a, b) => a - b);
      const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
      endpoints[label] = {
        requests: entry.count,
        perSecond: Math.round((entry.count / Math.max(1, durationSeconds)) * 100) / 100,
        ok: entry.values.length,
        errors: Object.fromEntries(entry.errors),
        p50: round(percentile(sorted, 50)),
        p95: round(percentile(sorted, 95)),
        p99: round(percentile(sorted, 99)),
        max: round(sorted.length ? sorted[sorted.length - 1] : null),
      };
    }
    return {
      endpoints,
      heartbeatKinds: Object.fromEntries(this.heartbeatKinds),
      events: Object.fromEntries(this.events),
      heartbeatKindsAllTime: Object.fromEntries(this.allKinds),
      eventsAllTime: Object.fromEntries(this.allEvents),
    };
  }
}

/* --------------------------------------------------------------- fake agent */

const PRESENCE_INTERVAL_MS = 5_000;
const FULL_HEARTBEAT_SSE_MS = 5 * 60_000;
const FULL_HEARTBEAT_IDLE_MS = 60_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 30_000;
const RETRY_LIMIT = 4;
const RETRY_COOLDOWN_MS = 60_000;
const TRAFFIC_COLLECT_MS = 10_000;
const HOST_TRAFFIC_IDLE_MS = 5 * 60_000;
const TCPING_STEADY_REPORT_MS = 5 * 60_000;

const random = (min, max) => min + Math.random() * (max - min);
const stableJitterBelow = (baseMs, seed, percent) => {
  const digest = crypto.createHash("sha256").update(seed).digest();
  const fraction = digest.readUInt32BE(0) / 0xffffffff;
  return baseMs - baseMs * (percent / 100) * fraction;
};

class FakeAgent {
  constructor(spec, context) {
    this.spec = spec;
    this.token = spec.token;
    this.context = context;
    this.bootId = crypto.randomUUID();
    this.processId = 1000 + Math.floor(Math.random() * 60000);
    this.processStartedAt = Math.floor(Date.now() / 1000);
    this.uptimeBase = Math.floor(random(3600, 90 * 86400));
    this.localRules = new Map();
    this.localTunnels = new Map();
    this.wireGuardPlanes = new Map();
    this.stateSignatures = {};
    this.received = { revision: 0, hash: "" };
    this.applied = { revision: 0, hash: "" };
    this.lastLocalStateSignature = "";
    this.forceLocalState = true;
    this.presenceSupported = false;
    this.compactReports = false;
    this.sseConnected = false;
    this.sseAbort = null;
    this.stopped = false;
    this.fullTimer = null;
    this.fullInFlight = false;
    this.fullQueued = false;
    this.fullFailures = 0;
    this.presenceFailures = 0;
    this.trafficIntervalMs = 10_000;
    this.lastRuleTrafficAt = 0;
    this.lastHostTrafficAt = 0;
    this.trafficPending = new Map();
    this.tcpingReportedAt = new Map();
    this.tcpingCounters = new Map();
    this.staticReportedAt = 0;
    this.timers = new Set();
    this.knownRuleIds = new Set();
  }

  later(ms, work) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) work();
    }, Math.max(0, ms));
    this.timers.add(timer);
    return timer;
  }

  start(initialDelayMs) {
    this.stopped = false;
    this.later(initialDelayMs, () => {
      if (this.context.sse) this.connectSse();
      this.scheduleFull(this.context.sse ? random(0, 10_000) : random(0, 2_000), true);
      this.later(stableJitterBelow(PRESENCE_INTERVAL_MS, `${this.bootId}:presence`, 10), () => this.presenceLoop());
      this.later(random(0, TRAFFIC_COLLECT_MS), () => this.trafficLoop());
      this.later(random(5_000, 60_000), () => this.tcpingLoop());
    });
  }

  /** 面板重启：所有连接断开，Agent 进程不重启（boot / pid 不变），按各自的退避重连。 */
  disconnect() {
    this.sseAbort?.abort();
    this.sseConnected = false;
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.sseAbort?.abort();
  }

  async post(requestPath, payload, label) {
    const envelope = encrypt({ path: requestPath, payload }, this.token);
    const bodyText = JSON.stringify(envelope);
    const startedAt = performance.now();
    let status = 0;
    try {
      const response = await fetch(`${this.context.panel}/api/sync`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authProof(this.token, "POST", "/api/sync", bodyText)}`,
          "user-agent": "forwardx-bench-agent",
        },
        body: bodyText,
        signal: AbortSignal.timeout(label === "presence" ? 8_000 : 30_000),
      });
      status = response.status;
      const text = await response.text();
      this.context.recorder.latency(label, performance.now() - startedAt, status);
      if (status < 200 || status >= 300) throw Object.assign(new Error(`HTTP ${status}: ${text.slice(0, 200)}`), { status });
      const parsed = JSON.parse(text);
      return parsed && parsed.v === 1 ? decrypt(parsed, this.token) : parsed;
    } catch (error) {
      if (!status) this.context.recorder.latency(label, performance.now() - startedAt, error?.name === "TimeoutError" ? "timeout" : "neterr");
      throw error;
    }
  }

  localStatePayload() {
    const rules = [...this.localRules.values()].sort((a, b) => a.port - b.port || a.ruleId - b.ruleId);
    const tunnels = [...this.localTunnels.values()].sort((a, b) => a.port - b.port);
    const wireGuardPlanes = [...this.wireGuardPlanes.entries()].map(([tunnelId, plane]) => ({ tunnelId, plane })).sort((a, b) => a.tunnelId - b.tunnelId);
    const state = {};
    if (rules.length) state.rules = rules;
    if (tunnels.length) state.tunnels = tunnels;
    if (wireGuardPlanes.length) state.wireGuardPlanes = wireGuardPlanes;
    return state;
  }

  heartbeatPayload(forceReconcile) {
    const now = Date.now();
    const uptime = this.uptimeBase + Math.floor((now / 1000) - this.processStartedAt);
    const memoryTotal = 2 * 1024 ** 3;
    const memoryUsed = Math.floor(memoryTotal * random(0.25, 0.4));
    const payload = {
      agentBootId: this.bootId,
      agentBootedAt: Math.floor(now / 1000) - uptime,
      agentProcessId: this.processId,
      agentProcessStartedAt: this.processStartedAt,
      agentLastReceivedRevision: this.received.revision,
      agentLastAppliedRevision: this.applied.revision,
      agentLastReceivedHash: this.received.hash,
      agentLastAppliedHash: this.applied.hash,
      fxpEndpointEvents: [],
      sniInbounds: [],
      failoverEvents: [],
      failoverActive: [],
      failoverStats: [],
      pluginVersions: {},
      pluginSyncSignatures: {},
      mimicEnvironment: { available: false, version: "", status: "not-installed", message: "" },
      fxpVersion: "2.2.138",
      runtimeVersion: "3.2.6-nex.1",
      agentCapabilities: ["ssEgressUdp", "ssEgress2022"],
      oomKillCount: 0,
      serviceRestarts: 0,
      defaultNetworkInterface: "eth0",
      privateIpv4: "10.0.0.2",
    };
    const metrics = [
      Math.round(random(2, 25)), Math.round((memoryUsed / memoryTotal) * 100), memoryUsed, memoryTotal,
      0, 0, 0, Math.floor(random(1e9, 9e9)), Math.floor(random(1e9, 9e9)),
      38, 20 * 1024 ** 3, 50 * 1024 ** 3, uptime, Math.floor(random(20, 400)), Math.floor(random(0, 40)),
    ];
    const reportStatic = !this.compactReports || !this.staticReportedAt || now - this.staticReportedAt >= 30 * 60_000;
    if (this.compactReports) payload.m = metrics;
    else {
      Object.assign(payload, {
        cpuUsage: metrics[0], memoryUsage: metrics[1], memoryUsed: metrics[2], memoryTotal: metrics[3],
        swapUsage: 0, swapUsed: 0, swapTotal: 0, networkIn: metrics[7], networkOut: metrics[8],
        diskUsage: metrics[9], diskUsed: metrics[10], diskTotal: metrics[11], uptime, tcpConnections: metrics[13], udpConnections: metrics[14],
      });
    }
    if (reportStatic) {
      payload.ip = this.spec.ip;
      payload.ipv4 = this.spec.ip;
      payload.cpuInfo = "Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz x 2";
      payload.agentVersion = this.context.agentVersion;
    }
    if (forceReconcile) payload.forceReconcile = true;
    if (Object.keys(this.stateSignatures).length) payload.stateSignatures = this.stateSignatures;
    const state = this.localStatePayload();
    const signature = crypto.createHash("sha1").update(JSON.stringify(state)).digest("hex").slice(0, 16);
    payload.localStateSignature = signature;
    if (this.forceLocalState || signature !== this.lastLocalStateSignature) {
      payload.localState = state;
      this.forceLocalState = false;
      this.lastLocalStateSignature = signature;
    }
    return { payload, reportStatic };
  }

  scheduleFull(delayMs, force = false) {
    if (this.fullTimer) clearTimeout(this.fullTimer);
    this.timers.delete(this.fullTimer);
    this.fullTimer = this.later(delayMs, () => {
      this.fullTimer = null;
      void this.fullHeartbeat(force);
    });
  }

  async fullHeartbeat(force = false) {
    if (this.fullInFlight) { this.fullQueued = true; return; }
    this.fullInFlight = true;
    let nextMs = FULL_HEARTBEAT_IDLE_MS;
    try {
      const { payload, reportStatic } = this.heartbeatPayload(force);
      const response = await this.post("/api/agent/heartbeat", payload, "heartbeat");
      this.fullFailures = 0;
      this.compactReports = response.compactReports === true;
      this.presenceSupported = response.presenceSupported === true;
      if (reportStatic && !response.reconciliationCoalesced) this.staticReportedAt = Date.now();
      if (Number(response.trafficReportInterval) > 0) {
        this.trafficIntervalMs = Math.min(30, Math.max(10, Number(response.trafficReportInterval))) * 1000;
      }
      const kind = response.reconciliationCoalesced
        ? "coalesced"
        : response.requestLocalState
          ? "request-local-state"
          : Object.prototype.hasOwnProperty.call(response, "stateSignatures")
            ? (response.desiredState ? "full-with-desired-state" : "full-unchanged")
            : "stable-fast-path";
      this.context.recorder.heartbeatKind(kind);
      if (this.context.trace && this.context.traceHostIds.has(this.spec.hostId)) {
        const summarize = (action) => `${action.op}:${action.statusType || "?"}:${action.ruleId || 0}/${action.tunnelId || 0}:${action.forwardType}:${action.sourcePort || 0}:kr=${action.knownRunning}`;
        fs.appendFileSync(this.context.trace, `${JSON.stringify({
          at: new Date().toISOString(),
          hostId: this.spec.hostId,
          kind,
          sent: { localState: !!payload.localState, signature: payload.localStateSignature, rev: payload.agentLastReceivedRevision, hash: payload.agentLastReceivedHash, stateSignatures: Object.keys(payload.stateSignatures || {}).length, force: !!payload.forceReconcile },
          nextInterval: response.nextInterval,
          requestLocalState: response.requestLocalState,
          sections: Object.keys(response).filter((key) => !["success", "actions", "selfTests", "lookingGlassTests", "iperf3Tasks", "pluginTasks", "agentUpgrade", "panelUrl", "panelMigration", "nextInterval", "requestLocalState", "compactReports", "presenceSupported", "metricsOnly", "forceTcping", "stateSignatures", "desiredState"].includes(key)),
          desired: response.desiredState ? { rev: response.desiredState.configRevision, hash: response.desiredState.configHash, issuedAt: response.desiredState.issuedAt, actions: (response.desiredState.actions || []).map(summarize) } : null,
        })}\n`);
      }
      let serverInterval = Number(response.nextInterval || 0);
      if (response.requestLocalState) {
        this.forceLocalState = true;
        nextMs = (serverInterval <= 0 || serverInterval > 2 ? 2 : serverInterval) * 1000;
      } else {
        if (!response.reconciliationCoalesced) this.applyHeartbeatState(response);
        nextMs = this.successfulDelayMs(serverInterval);
      }
    } catch (error) {
      this.fullFailures += 1;
      this.context.recorder.event("heartbeat-failed");
      nextMs = this.fullFailures > RETRY_LIMIT
        ? RETRY_COOLDOWN_MS
        : random(RETRY_MIN_MS, Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (this.fullFailures - 1)));
      if (this.fullFailures > RETRY_LIMIT) this.fullFailures = 0;
    } finally {
      this.fullInFlight = false;
    }
    if (this.fullQueued) {
      this.fullQueued = false;
      this.scheduleFull(500);
      return;
    }
    this.scheduleFull(nextMs);
  }

  successfulDelayMs(serverIntervalSeconds) {
    let interval = serverIntervalSeconds > 0 ? serverIntervalSeconds : 60;
    if (this.presenceSupported) {
      if (this.sseConnected && interval > 3) interval = FULL_HEARTBEAT_SSE_MS / 1000;
      else if (!this.sseConnected && interval > 60) interval = 60;
    }
    if (interval < 2) interval = 2;
    const ms = interval * 1000;
    return ms >= 60_000 ? stableJitterBelow(ms, `${this.bootId}:full-heartbeat`, 10) : ms;
  }

  applyHeartbeatState(response) {
    if (response.stateSignatures && typeof response.stateSignatures === "object") {
      this.stateSignatures = { ...response.stateSignatures };
    }
    if (Array.isArray(response.runningRules)) this.adoptRunningRules(response.runningRules);
    if (response.desiredState) this.applyDesiredState(response.desiredState);
    if (Array.isArray(response.actions) && response.actions.length) this.applyActions(response.actions, 0);
  }

  adoptRunningRules(runningRules) {
    for (const rule of runningRules) {
      const ruleId = Number(rule?.ruleId || 0);
      const port = Number(rule?.sourcePort || 0);
      if (ruleId <= 0 || port <= 0 || rule?.schedulerOnly) continue;
      const entry = this.ruleEntry({ ...rule, ruleId, sourcePort: port });
      this.localRules.set(this.ruleKey(entry), entry);
      this.knownRuleIds.add(ruleId);
    }
  }

  ruleKey(entry) {
    return `${entry.ruleId}:${entry.port}:${entry.protocol || ""}`;
  }

  ruleEntry(action) {
    const forwardType = String(action.forwardType || "");
    const tunnelId = Number(action.tunnelId || 0) || undefined;
    const transportVersion = action.fxp?.transportVersion
      || action.transportVersion
      || (tunnelId && forwardType === "forwardx" ? "v2" : undefined);
    const entry = {
      port: Number(action.sourcePort),
      ruleId: Number(action.ruleId),
      forwardType,
      targetIp: action.targetIp ? String(action.targetIp) : undefined,
      targetPort: Number(action.targetPort || 0) || undefined,
      protocol: action.protocol ? String(action.protocol) : undefined,
      ready: true,
    };
    if (tunnelId) entry.tunnelId = tunnelId;
    if (transportVersion) entry.transportVersion = transportVersion;
    return entry;
  }

  applyDesiredState(state) {
    const revision = Number(state.configRevision || 0);
    const hash = String(state.configHash || "");
    this.received = { revision, hash };
    const actions = Array.isArray(state.actions) ? state.actions : [];
    this.applyActions(actions, Number(state.issuedAt || 0));
    this.applied = { revision, hash };
  }

  applyActions(actions, batchIssuedAt) {
    const statuses = [];
    let applied = 0;
    for (const action of actions) {
      if (!action || typeof action !== "object") continue;
      const issuedAt = Number(action.issuedAt || batchIssuedAt || 0) || undefined;
      const statusType = action.statusType || (Number(action.ruleId) > 0 ? "rule" : Number(action.tunnelId) > 0 ? "tunnel" : "");
      const sourcePort = Number(action.sourcePort || 0);
      if (statusType === "runtime") {
        if (action.op === "apply" && action.reportStatus !== false) {
          statuses.push({ ruleId: 0, tunnelId: 0, statusType: "runtime", isRunning: true, forwardType: action.forwardType, issuedAt });
        }
        continue;
      }
      if (statusType === "rule" && Number(action.ruleId) > 0 && sourcePort > 0) {
        const entry = this.ruleEntry(action);
        const key = this.ruleKey(entry);
        if (action.op === "remove") {
          for (const [existingKey, existing] of this.localRules) {
            if (existing.ruleId === entry.ruleId && existing.port === entry.port) this.localRules.delete(existingKey);
          }
        } else {
          if (action.knownRunning === true && this.localRules.has(key)) continue;
          this.localRules.set(key, entry);
          this.knownRuleIds.add(entry.ruleId);
          applied += 1;
        }
        statuses.push({
          ruleId: entry.ruleId,
          tunnelId: Number(action.tunnelId || 0),
          statusType: "rule",
          sourcePort,
          targetPort: Number(action.targetPort || 0) || undefined,
          isRunning: action.op !== "remove",
          forwardType: action.forwardType,
          protocol: action.protocol,
          issuedAt,
        });
        continue;
      }
      if (statusType === "tunnel" && Number(action.tunnelId) > 0) {
        const tunnelId = Number(action.tunnelId);
        if (action.op === "remove") {
          if (sourcePort > 0) this.localTunnels.delete(sourcePort);
          this.wireGuardPlanes.delete(tunnelId);
        } else {
          const forwardType = String(action.forwardType || "");
          const isWireGuard = forwardType === "forwardx-wireguard" || !!action.wireGuard;
          if (sourcePort > 0) {
            this.localTunnels.set(sourcePort, {
              port: sourcePort,
              tunnelId,
              forwardType,
              ...(action.fxp?.transportVersion || isWireGuard ? { transportVersion: action.fxp?.transportVersion || "v2" } : {}),
              ...(isWireGuard ? { wireGuardPlane: "kernel" } : {}),
              ready: true,
            });
          }
          if (isWireGuard) this.wireGuardPlanes.set(tunnelId, "kernel");
          applied += 1;
        }
        if (action.reportStatus !== false) {
          statuses.push({
            ruleId: 0,
            tunnelId,
            statusType: "tunnel",
            sourcePort: sourcePort || undefined,
            isRunning: action.op !== "remove",
            forwardType: action.forwardType,
            issuedAt,
          });
        }
      }
    }
    if (applied > 0) this.context.recorder.event("actions-applied", applied);
    if (statuses.length) void this.reportStatuses(statuses);
  }

  async reportStatuses(statuses) {
    for (let index = 0; index < statuses.length; index += 200) {
      const batch = statuses.slice(index, index + 200);
      try {
        await this.post("/api/agent/rule-status-batch", { statuses: batch }, "rule-status-batch");
      } catch {
        this.context.recorder.event("status-report-failed");
      }
    }
  }

  async presenceLoop() {
    let nextMs = stableJitterBelow(PRESENCE_INTERVAL_MS, `${this.bootId}:presence`, 10);
    if (this.presenceSupported) {
      try {
        const response = await this.post("/api/agent/presence", {
          mode: "presence",
          agentBootId: this.bootId,
          agentProcessId: this.processId,
          agentProcessStartedAt: this.processStartedAt,
          agentLastReceivedRevision: this.received.revision,
          agentLastAppliedRevision: this.applied.revision,
          agentLastReceivedHash: this.received.hash,
          agentLastAppliedHash: this.applied.hash,
        }, "presence");
        this.presenceFailures = 0;
        if (!response?.presence || !response?.presenceSupported) {
          this.presenceSupported = false;
          this.scheduleFull(0);
        }
      } catch {
        this.presenceFailures += 1;
        nextMs = this.presenceFailures > RETRY_LIMIT
          ? RETRY_COOLDOWN_MS
          : random(1_000, Math.min(RETRY_MAX_MS, 1_000 * 2 ** this.presenceFailures));
        if (this.presenceFailures > RETRY_LIMIT) this.presenceFailures = 0;
      }
    }
    this.later(nextMs, () => this.presenceLoop());
  }

  async trafficLoop() {
    const now = Date.now();
    const activeShare = this.context.activeRuleShare;
    for (const rule of this.localRules.values()) {
      if (Math.random() > activeShare) continue;
      const pending = this.trafficPending.get(rule.ruleId) || [0, 0, 0];
      pending[0] += Math.floor(random(2e5, 6e7));
      pending[1] += Math.floor(random(1e5, 2e7));
      pending[2] += Math.floor(random(0, 6));
      this.trafficPending.set(rule.ruleId, pending);
    }
    const reportRules = this.trafficPending.size > 0 && (!this.lastRuleTrafficAt || now - this.lastRuleTrafficAt >= this.trafficIntervalMs);
    const reportHost = reportRules || !this.lastHostTrafficAt || now - this.lastHostTrafficAt >= HOST_TRAFFIC_IDLE_MS;
    if (reportRules || reportHost) {
      const stats = reportRules ? [...this.trafficPending.entries()].map(([ruleId, [bytesIn, bytesOut, connections]]) => [ruleId, bytesIn, bytesOut, connections]) : [];
      const hostTraffic = [Math.floor(random(1e7, 5e8)), Math.floor(random(1e7, 5e8))];
      const payload = this.compactReports
        ? { s: stats, h: hostTraffic }
        : { stats: stats.map(([ruleId, bytesIn, bytesOut, connections]) => ({ ruleId, bytesIn, bytesOut, connections })), hostTraffic: { bytesIn: hostTraffic[0], bytesOut: hostTraffic[1] } };
      payload.reportId = `agent-${crypto.randomBytes(16).toString("hex")}`;
      payload.reportProducerId = `agent-bench-${this.spec.hostId}`;
      try {
        const response = await this.post("/api/agent/traffic", payload, "traffic");
        if (reportRules) { this.trafficPending.clear(); this.lastRuleTrafficAt = now; }
        this.lastHostTrafficAt = now;
        if (Number(response?.trafficReportInterval) > 0) {
          this.trafficIntervalMs = Math.min(30, Math.max(10, Number(response.trafficReportInterval))) * 1000;
        }
      } catch {
        this.context.recorder.event("traffic-failed");
      }
    }
    this.later(stableJitterBelow(TRAFFIC_COLLECT_MS, `${this.bootId}:traffic`, 10), () => this.trafficLoop());
  }

  async tcpingLoop() {
    const now = Date.now();
    const rules = [...this.localRules.values()];
    const results = [];
    for (const rule of rules) {
      const flapped = Math.random() < this.context.tcpingFlapRate;
      const timeout = flapped && Math.random() < 0.5;
      // Agent 端每条探测都累计（报不报都算），上报的那条带上累计值（agent/tcping_report_gate.go）。
      let counter = this.tcpingCounters.get(rule.ruleId);
      if (!counter) {
        counter = { epoch: crypto.randomBytes(16).toString("hex"), count: 0, successes: 0 };
        this.tcpingCounters.set(rule.ruleId, counter);
      }
      counter.count += 3;
      counter.successes += timeout ? 0 : 3;
      const last = this.tcpingReportedAt.get(rule.ruleId) || 0;
      const due = !!rule.tunnelId || flapped || !last || now - last >= TCPING_STEADY_REPORT_MS;
      if (!due) continue;
      results.push({
        ruleId: rule.ruleId,
        tunnelId: rule.tunnelId || 0,
        sourcePort: rule.port,
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
        method: "tcp",
        probeCount: 3,
        probeSuccesses: timeout ? 0 : 3,
        probeCounterEpoch: counter.epoch,
        probeTotalCount: counter.count,
        probeTotalSuccesses: counter.successes,
        latencyMs: timeout ? 0 : Math.round(random(8, 180) * 10) / 10,
        isTimeout: timeout,
      });
      this.tcpingReportedAt.set(rule.ruleId, now);
    }
    if (results.length) {
      try {
        await this.post("/api/agent/tcping", { results, tunnels: [], forwardGroups: [], services: [], force: false }, "tcping");
      } catch {
        this.context.recorder.event("tcping-failed");
      }
    }
    const workCount = rules.length;
    const interval = workCount >= 500 ? 15_000 : workCount >= 200 ? 20_000 : workCount >= 100 ? 30_000 : 60_000;
    this.later(stableJitterBelow(interval, `${this.bootId}:tcping`, 10), () => this.tcpingLoop());
  }

  async connectSse() {
    if (this.stopped) return;
    const controller = new AbortController();
    this.sseAbort = controller;
    const envelope = encrypt({ agentVersion: this.context.agentVersion, fxpVersion: "2.2.138" }, this.token);
    const query = JSON.stringify(envelope);
    let reconnectMs = random(1_000, 5_000);
    try {
      const startedAt = performance.now();
      const response = await fetch(`${this.context.panel}/api/stream?e=${encodeURIComponent(query)}`, {
        headers: {
          accept: "text/event-stream",
          "cache-control": "no-cache",
          authorization: `Bearer ${authProof(this.token, "GET", "/api/stream", "")}`,
        },
        signal: controller.signal,
      });
      this.context.recorder.latency("sse-connect", performance.now() - startedAt, response.status);
      if (response.status !== 200) throw new Error(`SSE HTTP ${response.status}`);
      this.sseConnected = true;
      this.later(random(0, 10_000), () => this.scheduleFull(0, true));
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let separator;
        while ((separator = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("");
          if (!data) continue;
          try {
            const message = decrypt(JSON.parse(data), this.token);
            this.handleSseMessage(message);
          } catch {
            this.context.recorder.event("sse-bad-frame");
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted && this.stopped) return;
      this.context.recorder.event("sse-error");
      reconnectMs = random(1_000, 15_000);
    } finally {
      this.sseConnected = false;
    }
    if (!this.stopped) this.later(reconnectMs, () => this.connectSse());
  }

  handleSseMessage(message) {
    const type = String(message?.type || "");
    this.context.recorder.event(`sse:${type}`);
    if (type === "agent-desired-state") {
      const data = message.data || {};
      if (Array.isArray(data.runningRules)) this.adoptRunningRules(data.runningRules);
      if (data.desiredState) this.applyDesiredState(data.desiredState);
      if (data.stateSignatures && typeof data.stateSignatures === "object") {
        this.stateSignatures = { ...this.stateSignatures, ...data.stateSignatures };
      }
    } else if (type === "agent-refresh") {
      this.scheduleFull(random(0, 1_000), false);
    }
  }
}

/* --------------------------------------------------------------- run */

function readProcStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0);
    let writeBytes = 0;
    try { writeBytes = Number(/write_bytes:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/io`, "utf8"))?.[1] || 0); } catch { /* no io stats */ }
    return { ticks: Number(fields[11]) + Number(fields[12]), rssKb, writeBytes };
  } catch {
    return null;
  }
}

function dbSize(dbPath) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { total += fs.statSync(dbPath + suffix).size; } catch { /* missing */ }
  }
  return total;
}

function readPanelSamples(file, fromMs, toMs) {
  if (!file || !fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const samples = lines.filter((line) => line.type === "sample" && line.ts > fromMs && line.ts <= toMs);
  if (!samples.length) return null;
  const seconds = samples.reduce((sum, line) => sum + line.intervalMs, 0) / 1000;
  const sum = (pick) => samples.reduce((total, line) => total + pick(line), 0);
  const sorted = (pick) => samples.map(pick).sort((a, b) => a - b);
  const pct = (values, p) => values[Math.min(values.length - 1, Math.floor((p / 100) * values.length))];
  const lagP99 = sorted((line) => line.eventLoop.p99);
  const lagMax = sorted((line) => line.eventLoop.max);
  const top = new Map();
  for (const line of samples) {
    for (const entry of line.db.top || []) {
      const existing = top.get(entry.sql) || { count: 0, totalMs: 0, kind: entry.kind };
      existing.count += entry.count;
      existing.totalMs += entry.totalMs;
      top.set(entry.sql, existing);
    }
  }
  const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
  return {
    seconds: round(seconds, 0),
    cpuPercent: round((sum((line) => line.cpuUserUs + line.cpuSystemUs) / 1e6 / seconds) * 100),
    eventLoopP50Ms: round(pct(sorted((line) => line.eventLoop.p50), 50), 2),
    eventLoopP99MsMedian: round(pct(lagP99, 50), 2),
    eventLoopP99MsWorst: round(lagP99[lagP99.length - 1], 2),
    eventLoopMaxMs: round(lagMax[lagMax.length - 1], 1),
    eventLoopUtilization: round(sum((line) => line.eventLoop.utilization * line.intervalMs) / (seconds * 1000), 3),
    dbReadsPerSecond: round(sum((line) => line.db.read) / seconds),
    dbWritesPerSecond: round(sum((line) => line.db.write) / seconds),
    dbOtherPerSecond: round(sum((line) => line.db.other) / seconds),
    dbMsPerSecond: round(sum((line) => line.db.readMs + line.db.writeMs + line.db.otherMs) / seconds),
    dbErrors: sum((line) => line.db.errors),
    rssMbMax: round(Math.max(...samples.map((line) => line.rss)) / 1048576, 0),
    topStatements: [...top.entries()]
      .map(([sql, entry]) => ({ sql: sql.slice(0, 220), perSecond: round(entry.count / seconds, 2), msPerSecond: round(entry.totalMs / seconds, 2), kind: entry.kind }))
      .sort((a, b) => b.perSecond - a.perSecond)
      .slice(0, 25),
  };
}

async function run(options) {
  const panel = String(options.panel || "http://127.0.0.1:9816").replace(/\/+$/, "");
  const tokensFile = String(options.tokens || "bench-tokens.json");
  const duration = Math.max(10, numberArg(options.duration, 600));
  const warmup = Math.max(0, numberArg(options.warmup, 120));
  const restartAt = options["restart-at"] !== undefined ? numberArg(options["restart-at"], 0) : 0;
  const tokens = JSON.parse(fs.readFileSync(tokensFile, "utf8"));
  const limit = options.hosts !== undefined ? Math.floor(numberArg(options.hosts, tokens.hosts.length)) : tokens.hosts.length;
  const specs = tokens.hosts.slice(0, limit);
  const recorder = new Recorder();
  const context = {
    panel,
    recorder,
    sse: options.sse !== false,
    agentVersion: String(options["agent-version"] || "2.2.249"),
    activeRuleShare: Math.min(1, Math.max(0, numberArg(options["active-rules"], 0.6))),
    tcpingFlapRate: Math.min(1, Math.max(0, numberArg(options["tcping-flap"], 0.02))),
    trace: options.trace ? String(options.trace) : "",
    traceHostIds: new Set(String(options["trace-host"] || "").split(",").filter(Boolean).map(Number)),
  };
  const pid = options.pid ? Number(options.pid) : 0;
  const dbPath = options.db ? String(options.db) : "";
  const startedAt = Date.now();
  const agents = specs.map((spec) => new FakeAgent(spec, context));
  // 起步错开 0~20 秒，像一批 Agent 在面板起来之后陆续连上来。
  for (const agent of agents) agent.start(random(0, Math.min(20_000, duration * 500)));
  recorder.startWindow(startedAt + warmup * 1000);
  console.log(`[bench] ${agents.length} agents → ${panel}, duration ${duration}s (warmup ${warmup}s), sse=${context.sse}`);

  const resourceSamples = [];
  let windowStartProc = null;
  let windowStartDb = 0;
  let windowStartAt = 0;
  const sampleTimer = setInterval(() => {
    const now = Date.now();
    const proc = pid ? readProcStat(pid) : null;
    const size = dbPath ? dbSize(dbPath) : 0;
    if (!windowStartAt && now >= startedAt + warmup * 1000) {
      windowStartAt = now;
      windowStartProc = proc;
      windowStartDb = size;
    }
    resourceSamples.push({ at: now, proc, size });
  }, 1000);
  if (restartAt > 0) {
    setTimeout(() => {
      console.log("[bench] simulating panel restart: dropping every Agent connection");
      recorder.event("restart-simulated");
      for (const agent of agents) agent.disconnect();
    }, restartAt * 1000);
  }
  const progress = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const pr = recorder.series.get("presence")?.count || 0;
    console.log(`[bench] t=${elapsed}s presence(window)=${pr} kinds(all)=${JSON.stringify(Object.fromEntries(recorder.allKinds))} events(all)=${JSON.stringify(Object.fromEntries(recorder.allEvents))}`);
  }, 30_000);
  await new Promise((resolve) => setTimeout(resolve, duration * 1000));
  clearInterval(sampleTimer);
  clearInterval(progress);
  const endedAt = Date.now();
  for (const agent of agents) agent.stop();

  const windowSeconds = Math.max(1, (endedAt - (windowStartAt || startedAt)) / 1000);
  const last = resourceSamples[resourceSamples.length - 1];
  let processSummary = null;
  if (pid && windowStartProc && last?.proc) {
    const windowSamples = resourceSamples.filter((sample) => sample.at >= windowStartAt && sample.proc);
    const rss = windowSamples.map((sample) => sample.proc.rssKb / 1024);
    processSummary = {
      cpuPercent: Math.round(((last.proc.ticks - windowStartProc.ticks) / 100 / windowSeconds) * 1000) / 10,
      rssMbAvg: Math.round(rss.reduce((a, b) => a + b, 0) / Math.max(1, rss.length)),
      rssMbMax: Math.round(Math.max(...rss)),
      diskWriteMbPerHour: Math.round(((last.proc.writeBytes - windowStartProc.writeBytes) / 1048576 / windowSeconds) * 3600 * 10) / 10,
    };
  }
  const dbGrowth = dbPath ? {
    bytesAtStart: windowStartDb,
    bytesAtEnd: last?.size || 0,
    mbPerHour: Math.round((((last?.size || 0) - windowStartDb) / 1048576 / windowSeconds) * 3600 * 10) / 10,
  } : null;
  const result = {
    startedAt: new Date(startedAt).toISOString(),
    hosts: agents.length,
    rulesPerHost: tokens.rulesPerHost,
    tunnelShare: tokens.tunnelShare,
    tunnelHostShare: tokens.tunnelHostShare,
    tunnels: tokens.tunnels,
    sse: context.sse,
    durationSeconds: duration,
    warmupSeconds: warmup,
    windowSeconds: Math.round(windowSeconds),
    process: processSummary,
    dbGrowth,
    panel: readPanelSamples(options.samples ? String(options.samples) : "", windowStartAt || startedAt, endedAt),
    ...recorder.summary(windowSeconds),
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) fs.writeFileSync(String(options.out), text);
  console.log(text);
  process.exit(0);
}

/* ------------------------------------------------------------ profile-top */

async function profileTop(options) {
  const profile = JSON.parse(fs.readFileSync(String(options.profile), "utf8"));
  const top = Math.max(1, Math.floor(numberArg(options.top, 25)));
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  let fromUs = -Infinity;
  let toUs = Infinity;
  if (options.samples && (options.from || options.to)) {
    // 面板侧采样文件里同时记了墙钟和单调时钟，用它把墙钟窗口换成剖析文件里的时间。
    const lines = fs.readFileSync(String(options.samples), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const anchor = lines.find((line) => line.monoUs && line.ts);
    const toMono = (wallMs) => anchor.monoUs + (wallMs - anchor.ts) * 1000;
    if (options.from) fromUs = toMono(Number(options.from));
    if (options.to) toUs = toMono(Number(options.to));
  }
  const selfUs = new Map();
  let time = profile.startTime;
  let totalUs = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    const delta = profile.timeDeltas[index] || 0;
    time += delta;
    if (time < fromUs || time > toUs) continue;
    const id = profile.samples[index];
    const next = profile.timeDeltas[index + 1] || delta;
    selfUs.set(id, (selfUs.get(id) || 0) + next);
    totalUs += next;
  }
  const mapper = options.sourcemap ? sourceMapLookup(JSON.parse(fs.readFileSync(String(options.sourcemap), "utf8"))) : null;
  const keyCacheById = new Map();
  const functionKey = (node) => {
    let key = keyCacheById.get(node.id);
    if (key) return key;
    const frame = node.callFrame;
    const location = frame.url
      ? (mapper && /\/dist\/index\.js$/.test(frame.url) ? mapper(frame.lineNumber, frame.columnNumber) : null)
        || `${frame.url.replace(/^.*\/node_modules\//, "node_modules/").replace(/^file:\/\/.*\/dist\//, "dist/")}:${frame.lineNumber + 1}`
      : "";
    key = `${frame.functionName || "(anonymous)"} ${location}`.trim();
    keyCacheById.set(node.id, key);
    return key;
  };
  const parentById = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parentById.set(child, node.id);
  const byFunction = new Map();
  for (const [id, us] of selfUs) {
    if (!options.inclusive) {
      const key = functionKey(nodes.get(id));
      byFunction.set(key, (byFunction.get(key) || 0) + us);
      continue;
    }
    // --inclusive：样本记到栈上每个（去重后的）函数头上 —— 看「这个函数连同它调用的同步代码」花了多少。
    const seen = new Set();
    for (let current = id; current !== undefined; current = parentById.get(current)) {
      const key = functionKey(nodes.get(current));
      if (seen.has(key)) continue;
      seen.add(key);
      byFunction.set(key, (byFunction.get(key) || 0) + us);
    }
  }
  byFunction.delete("(root)");
  const idleUs = byFunction.get("(idle)") || 0;
  byFunction.delete("(idle)");
  const busyUs = Math.max(1, totalUs - idleUs);
  const rows = [...byFunction.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  console.log(`sampled ${(totalUs / 1e6).toFixed(1)}s, busy ${(busyUs / 1e6).toFixed(1)}s (${((busyUs / Math.max(1, totalUs)) * 100).toFixed(1)}%); share below is of busy time`);
  for (const [name, us] of rows) {
    console.log(`${(us / 1000).toFixed(0).padStart(8)} ms  ${((us / busyUs) * 100).toFixed(1).padStart(5)}%  ${name}`);
  }
}

/** 最小的 source map v3 解码：生成代码的 (行, 列) → 源文件:行（剖析结果里把 dist/index.js 换回 server/*.ts）。 */
function sourceMapLookup(map) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values = new Map([...alphabet].map((char, index) => [char, index]));
  const lines = [];
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  for (const lineText of String(map.mappings || "").split(";")) {
    const segments = [];
    let column = 0;
    for (const segmentText of lineText.split(",")) {
      if (!segmentText) continue;
      const fields = [];
      let value = 0;
      let shift = 0;
      for (const char of segmentText) {
        const digit = values.get(char);
        value += (digit & 31) << shift;
        if (digit & 32) { shift += 5; continue; }
        fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
      column += fields[0];
      if (fields.length >= 4) {
        source += fields[1];
        sourceLine += fields[2];
        sourceColumn += fields[3];
        segments.push([column, source, sourceLine]);
      }
    }
    lines.push(segments);
  }
  return (line, column) => {
    const segments = lines[line];
    if (!segments || !segments.length) return null;
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (segments[mid][0] <= column) low = mid; else high = mid - 1;
    }
    const [, sourceIndex, originalLine] = segments[low];
    const name = String(map.sources?.[sourceIndex] || "").replace(/^(\.\.\/)+/, "");
    return name ? `${name}:${originalLine + 1}` : null;
  };
}

/* --------------------------------------------------------------- main */

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (command === "provision") await provision(args);
else if (command === "run") await run(args);
else if (command === "profile-top") await profileTop(args);
else {
  console.error("usage: heartbeat-load.mjs provision|run|profile-top [options] (see the comment at the top of this file)");
  process.exit(2);
}
