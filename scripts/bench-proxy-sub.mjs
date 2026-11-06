#!/usr/bin/env node
/**
 * 订阅生成压测：GET /api/sub/<token>（server/proxySubBench.fixture.ts 灌的大账号，约一千条节点）。
 *
 *   node scripts/bench-proxy-sub.mjs run [--db <file>] [--cache <秒>] [--requests 30] [--concurrency 20] [--json <out>]
 *     起一个只挂订阅路由的服务（子进程），每种格式用典型客户端连拉 N 次（规则订阅），再加几条节点订阅，
 *     最后 20 个客户端并发混着拉。量的是：p50 / p95、每次请求服务端吃的 CPU、正文大小。
 *     --cache 0 = 冷（每次都重新组装）；--cache 60 = 热（缓存命中，只走资格检查 + 发正文）。
 *
 *   node scripts/bench-proxy-sub.mjs profile [--db <file>] [--requests 20] --out <dir>
 *     冷路径带 --cpu-prof 跑一遍，退出时写 .cpuprofile 到 <dir>，再按自身耗时汇总前 40 个函数。
 *
 *   node scripts/bench-proxy-sub.mjs analyze <file.cpuprofile>
 *
 * 库文件不存在时子进程会先灌数据（几秒）；之后同一个文件复用，冷热两次测的是同一份数据。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(item);
  }
  return out;
}

function startServer({ db, cache, profileDir }) {
  const nodeArgs = [];
  if (profileDir) nodeArgs.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`, "--cpu-prof-interval=200");
  nodeArgs.push("--import", "tsx", "server/proxySubBench.fixture.ts", "serve");
  const child = spawn(process.execPath, nodeArgs, {
    cwd: root,
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: db, BENCH_CACHE_TTL: String(cache), FORWARDX_LOG_DIR: path.join(path.dirname(db), "logs"), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`server did not start in time\n${stderr}`)), 180_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((item) => item.startsWith("READY "));
      if (line) {
        clearTimeout(timer);
        resolve({ child, info: JSON.parse(line.slice(6)), stderr: () => stderr });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}\n${stderr}`));
    });
  });
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
// 客户端大多带 gzip（mihomo / sing-box 是 Go 的 http 客户端，默认就带）；--encoding identity 量不压的。
let acceptEncoding = "gzip";

function get(port, pathName, userAgent) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const headers = { "user-agent": userAgent, host: "panel.example.test" };
    if (acceptEncoding && acceptEncoding !== "identity") headers["accept-encoding"] = acceptEncoding;
    const req = http.get({ host: "127.0.0.1", port, path: pathName, agent, headers }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
      });
      res.on("end", () => resolve({ status: res.statusCode, bytes, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    });
    req.on("error", reject);
  });
}

async function stats(port) {
  const result = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/__bench/stats", agent }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
  return result;
}

const cpuMs = (before, after) => ((after.cpu.user - before.cpu.user) + (after.cpu.system - before.cpu.system)) / 1000;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(samples) {
  const ms = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  return {
    n: samples.length,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    max: ms[ms.length - 1] || 0,
    bytes: samples[0]?.bytes || 0,
    statuses: Array.from(new Set(samples.map((sample) => sample.status))),
  };
}

function cases(info) {
  const list = [];
  for (const [format, userAgent] of Object.entries(info.formatClients)) {
    list.push({ label: `${format} · 规则`, path: `/api/sub/${info.tokens.default}/${format}?rules=1`, userAgent });
  }
  list.push({ label: "clash · 节点", path: `/api/sub/${info.tokens.default}/clash`, userAgent: info.formatClients.clash });
  list.push({ label: "base64 · 节点", path: `/api/sub/${info.tokens.default}/base64`, userAgent: info.formatClients.base64 });
  list.push({ label: "clash-verge（UA 识别）", path: `/api/sub/${info.tokens.default}?rules=1`, userAgent: info.detectedClients["clash-verge"] });
  list.push({ label: "stash（UA 识别）", path: `/api/sub/${info.tokens.default}?rules=1`, userAgent: info.detectedClients.stash });
  list.push({ label: "sing-box · 作用域令牌", path: `/api/sub/${info.tokens.scoped}?rules=1`, userAgent: info.detectedClients["sing-box"] });
  list.push({ label: "clash · 模板令牌", path: `/api/sub/${info.tokens.templated}?rules=1`, userAgent: info.detectedClients.mihomo });
  return list;
}

async function runLoad(port, list, { requests, concurrency }) {
  // 预热：每条先拉一次（JIT、懒加载的模块、SQLite 页缓存）。
  for (const item of list) await get(port, item.path, item.userAgent);
  const perCase = [];
  for (const item of list) {
    const before = await stats(port);
    const samples = [];
    for (let i = 0; i < requests; i++) samples.push(await get(port, item.path, item.userAgent));
    const after = await stats(port);
    perCase.push({ label: item.label, ...summarize(samples), cpuMsPerRequest: cpuMs(before, after) / requests });
  }

  // 并发：concurrency 个客户端一起拉，每个按自己的顺序轮着不同的格式。
  const total = Math.max(concurrency * 10, requests * 4);
  const before = await stats(port);
  const started = process.hrtime.bigint();
  const samples = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async (_unused, worker) => {
    while (next < total) {
      const index = next++;
      const item = list[(index + worker) % list.length];
      samples.push(await get(port, item.path, item.userAgent));
    }
  }));
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const after = await stats(port);
  const concurrent = { concurrency, ...summarize(samples), requestsPerSecond: (samples.length / wallMs) * 1000, cpuMsPerRequest: cpuMs(before, after) / samples.length, rssMb: after.memory.rss / 1048576, heapUsedMb: after.memory.heapUsed / 1048576 };
  return { perCase, concurrent };
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.removeAllListeners("exit");
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

function table(result) {
  const lines = [];
  lines.push(`| 请求 | p50 ms | p95 ms | CPU ms/次 | 传输 |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  for (const row of result.perCase) {
    lines.push(`| ${row.label} | ${row.p50.toFixed(1)} | ${row.p95.toFixed(1)} | ${row.cpuMsPerRequest.toFixed(1)} | ${(row.bytes / 1024).toFixed(0)} KB |`);
  }
  const c = result.concurrent;
  lines.push("");
  lines.push(`并发 ${c.concurrency}：${c.n} 次，${c.requestsPerSecond.toFixed(1)} 次/秒，p50 ${c.p50.toFixed(1)} ms，p95 ${c.p95.toFixed(1)} ms，CPU ${c.cpuMsPerRequest.toFixed(1)} ms/次，RSS ${c.rssMb.toFixed(0)} MB，堆 ${c.heapUsedMb.toFixed(0)} MB`);
  return lines.join("\n");
}

function analyze(file, top = 40) {
  const profile = JSON.parse(fs.readFileSync(file, "utf8"));
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const deltas = profile.timeDeltas || [];
  let totalUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    const delta = Math.max(0, deltas[i] || 0);
    totalUs += delta;
    if (!node) continue;
    const frame = node.callFrame;
    const where = frame.url ? `${frame.url.replace(/^file:\/\//, "").replace(root, "")}:${frame.lineNumber + 1}` : "";
    const key = `${frame.functionName || "(anonymous)"}  ${where}`;
    self.set(key, (self.get(key) || 0) + delta);
  }
  const rows = Array.from(self.entries()).sort((a, b) => b[1] - a[1]).slice(0, top);
  const lines = [`总采样 ${(totalUs / 1000).toFixed(0)} ms`, "| 自身 ms | 占比 | 函数 |", "|---:|---:|---|"];
  for (const [key, us] of rows) lines.push(`| ${(us / 1000).toFixed(1)} | ${((us / totalUs) * 100).toFixed(1)}% | \`${key}\` |`);
  return lines.join("\n");
}

const options = args(process.argv.slice(2));
const command = options._[0] || "run";
if (options.encoding) acceptEncoding = String(options.encoding);
const db = path.resolve(String(options.db || path.join(os.tmpdir(), "forwardx-sub-bench", "bench.db")));
fs.mkdirSync(path.dirname(db), { recursive: true });

if (command === "analyze") {
  console.log(analyze(options._[1], Number(options.top || 40)));
} else if (command === "run") {
  const server = await startServer({ db, cache: Number(options.cache || 0) });
  try {
    const result = await runLoad(server.info.port, cases(server.info), { requests: Number(options.requests || 30), concurrency: Number(options.concurrency || 20) });
    const output = { cacheTtlSec: server.info.cacheTtlSec, acceptEncoding, seeded: server.info.seeded, ...result };
    if (options.json) fs.writeFileSync(String(options.json), JSON.stringify(output, null, 2));
    console.log(`缓存 ${server.info.cacheTtlSec} 秒，Accept-Encoding: ${acceptEncoding}`);
    console.log(table(result));
  } finally {
    await stop(server.child);
  }
} else if (command === "profile") {
  const out = path.resolve(String(options.out || path.join(path.dirname(db), "profile")));
  fs.mkdirSync(out, { recursive: true });
  for (const file of fs.readdirSync(out)) if (file.endsWith(".cpuprofile")) fs.rmSync(path.join(out, file));
  const server = await startServer({ db, cache: 0, profileDir: out });
  try {
    const list = cases(server.info);
    for (let round = 0; round < Number(options.requests || 20); round++) {
      for (const item of list) await get(server.info.port, item.path, item.userAgent);
    }
  } finally {
    await stop(server.child);
  }
  const file = fs.readdirSync(out).find((name) => name.endsWith(".cpuprofile"));
  if (!file) throw new Error("no .cpuprofile written");
  console.log(path.join(out, file));
  console.log(analyze(path.join(out, file), Number(options.top || 40)));
} else {
  console.error("usage: bench-proxy-sub.mjs run|profile|analyze …");
  process.exitCode = 2;
}
agent.destroy();
