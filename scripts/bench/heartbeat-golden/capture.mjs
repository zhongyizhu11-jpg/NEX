/*
  心跳对照基准：拷一份 seed.db，按 Agent 2.2.251 给每台主机发两拍心跳，把完整响应排好键序写成 JSON。
  结构整理（不改行为）前后各录一份，逐字节比 —— 一样就说明下发给 Agent 的东西一个字节都没变。

  用法（都在仓库根目录下跑）：
    1) 灌种子库，只灌一次，前后两次录制用同一份（换一份种子库就得重录基线）：
         node --import tsx scripts/bench/heartbeat-golden/seed.mjs /tmp/golden/seed
         node --import tsx scripts/bench/heartbeat-golden/seed-extra.mjs /tmp/golden/seed
    2) 在改动前的代码上录基线（比如 git worktree add /tmp/golden/base <基线提交>，到那个目录里跑）：
         node --import tsx scripts/bench/heartbeat-golden/capture.mjs /tmp/golden/seed /tmp/golden/base.json
    3) 在改动后的代码上再录一份，然后比：
         node --import tsx scripts/bench/heartbeat-golden/capture.mjs /tmp/golden/seed /tmp/golden/now.json
         cmp /tmp/golden/base.json /tmp/golden/now.json \
           || node scripts/bench/heartbeat-golden/diff.mjs /tmp/golden/base.json /tmp/golden/now.json
    同一份代码连录两次应当逐字节一样（时钟冻结、随机数定种子，见下面），不需要屏蔽任何字段。
    GOLDEN_PORT 改监听端口（默认 38452）。
*/
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const seedDir = path.resolve(process.argv[2]);
const outFile = path.resolve(process.argv[3]);

/*
  冻结时钟：每一拍心跳里时间不走（Date.now / new Date() 都是同一个值），两拍之间往后挪 1 秒，起点是灌库时间 + 1 分钟。
  这样「多久没心跳」「恢复中」这类按时间走的分支每次都一样，和什么时候跑无关；也和代码里调几次 Date.now 无关。
  Math.random 每拍从同一个种子开始。
*/
const { seededAt } = JSON.parse(fs.readFileSync(path.join(seedDir, "seed-time.json"), "utf8"));
const RealDate = Date;
let fakeNow = Number(seededAt) + 60_000;
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(fakeNow);
    else super(...args);
  }
  static now() { return fakeNow; }
}
globalThis.Date = FrozenDate;
let randomState = 1;
function resetRandom() { randomState = 0x9e3779b9; }
Math.random = () => {
  randomState |= 0;
  randomState = (randomState + 0x6d2b79f5) | 0;
  let t = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
resetRandom();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-golden-"));
const dbPath = path.join(workDir, "golden.db");
fs.copyFileSync(path.join(seedDir, "seed.db"), dbPath);
process.env.DATABASE_TYPE = "sqlite";
process.env.FORWARDX_PANEL_TIME_SYNC = "false";
process.env.FORWARDX_LOG_DIR = path.join(workDir, "logs");
process.env.FORWARDX_DATA_DIR = workDir;
fs.mkdirSync(process.env.FORWARDX_LOG_DIR, { recursive: true });

const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
const runtime = await import(url("server/dbRuntime.ts"));
const schema = await import(url("server/dbSchema.ts"));
await runtime.connectDatabase({ type: "sqlite", sqlite: { path: dbPath } });
await schema.ensureDatabaseSchema();
const q = (name) => '"' + name + '"';

// 内存里的运行时状态（负载、中转探测）：确定性地灌一份，让负载 / 下游延迟 / 中转断了这些提示都有东西可发。
const hostLoad = await import(url("server/hostLoad.ts"));
const stats = await import(url("server/routeGroupStats.ts"));
const hosts = await runtime.queryRaw(`SELECT ${q("id")}, ${q("name")}, ${q("agentToken")} FROM ${q("hosts")} ORDER BY ${q("id")}`);
const cpu = [12, 85, 47, 96, 33, 71, 5, 64, 88, 21, 55, 79, 9, 41, 92, 18, 66];
hosts.forEach((host, index) => {
  hostLoad.recordHostLoadSample(Number(host.id), { at: Date.now(), cpuUsage: cpu[index % cpu.length], networkIn: null, networkOut: null }, 0);
});
const routeRules = await runtime.queryRaw(`SELECT ${q("id")}, ${q("routePaths")} FROM ${q("forward_rules")} WHERE ${q("failoverEnabled")} = 1 AND ${q("routeParentRuleId")} IS NULL AND ${q("routePaths")} IS NOT NULL ORDER BY ${q("id")}`);
const hostName = new Map(hosts.map((host) => [Number(host.id), String(host.name)]));
let downInjected = false;
for (const rule of routeRules) {
  let paths = [];
  try { paths = JSON.parse(rule.routePaths || "[]"); } catch { paths = []; }
  paths.forEach((pathItem, pathIndex) => {
    const hops = Array.isArray(pathItem.hops) ? pathItem.hops : [];
    hops.forEach((hostId, hopIndex) => {
      const failing = !downInjected && Number(rule.id) === 11 && pathIndex === paths.length - 1 && hopIndex === 0;
      const rounds = failing ? 3 : 1;
      for (let round = 0; round < rounds; round += 1) {
        stats.recordRouteHopProbe({
          parentRuleId: Number(rule.id),
          pathKey: String(pathItem.key),
          hopIndex,
          hostId: Number(hostId),
          hostName: hostName.get(Number(hostId)) || `主机 ${hostId}`,
          nextLabel: hopIndex + 1 < hops.length ? (hostName.get(Number(hops[hopIndex + 1])) || "中转") : "落地",
          ok: !failing,
          latencyMs: failing ? null : 7 + pathIndex * 5 + hopIndex * 3,
        });
      }
      if (failing) downInjected = true;
    });
  });
}

const { createRequire } = await import("node:module");
const express = createRequire(path.join(process.cwd(), "package.json"))("express");
const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use((req, _res, next) => {
  const authorization = String(req.headers.authorization || "");
  req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  next();
});
heartbeat.registerAgentHeartbeatRoute(app);
const server = http.createServer(app);
const port = Number(process.env.GOLDEN_PORT || 38452);
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
const base = `http://127.0.0.1:${port}`;

async function beat(host) {
  const response = await fetch(base + "/api/agent/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + host.agentToken },
    body: JSON.stringify({ agentVersion: "2.2.251", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true }),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: response.status, body };
}

const out = { round1: {}, round2: {} };
for (const round of ["round1", "round2"]) {
  for (const host of hosts) {
    fakeNow += 1000;
    resetRandom();
    out[round][String(host.id)] = await beat(host);
    // 让心跳里顺手发起的异步写库（审计、状态）落完，再发下一台：两次跑的先后顺序才一样。
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
server.close();

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}
fs.writeFileSync(outFile, JSON.stringify(sortKeys(out), null, 1));
console.log("captured", hosts.length, "hosts ->", outFile);
fs.rmSync(workDir, { recursive: true, force: true });
process.exit(0);
