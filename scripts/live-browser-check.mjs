#!/usr/bin/env node
/*
  实时链路的浏览器检查（2.3.559）：对着本地开发面板跑，查三件事，任何一条不满足就以非 0 退出。

    1. 页面连上了实时通知（/api/live），一个页面只连一条
    2. 另一个标签页改了规则，这一页不等轮询就重取（默认要求 1.5 秒内，NEX_LIVE_MAX_MS 可调）
    3. 本机查询缓存里没有延迟 / 测试结果这些「状态」字段（刷新不拿旧状态顶着）

  用法：
    npm run dev:panel                     # 另开一个终端
    node scripts/live-browser-check.mjs   # 默认 http://127.0.0.1:5173，NEX_PANEL_URL 可改

  要装了 Playwright 的 Chromium（云端开发环境自带；本机 npx playwright install chromium）。
  服务端那一段（上报 → 推送 → 重取到新数）在 server/liveEndToEnd.sqlite.test.ts，CI 里跑。
*/
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("[live-check] 没找到 playwright：npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}

const BASE = (process.env.NEX_PANEL_URL || "http://127.0.0.1:5173").replace(/\/$/, "");
const MAX_MS = Number(process.env.NEX_LIVE_MAX_MS || 1500);
const STATUS_FIELD = /"(latestLatency\w*|lastLatencyMs|lastTest\w*|latestProbeFailure|exitTarget\w*|liveRate)"/;
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "✓" : "✗"} ${message}`);
  if (!ok) failures.push(message);
};

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const watcher = await context.newPage();
  const actor = await context.newPage();
  const requests = [];
  watcher.on("request", (request) => {
    const path = request.url().replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/api/")) requests.push({ at: Date.now(), path });
  });

  await watcher.goto(`${BASE}/rules`, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => undefined);
  await watcher.waitForTimeout(3_000);
  const streams = requests.filter((request) => request.path.startsWith("/api/live")).length;
  check(streams === 1, `页面连着实时通知（/api/live 连接数 ${streams}，应为 1）`);

  await actor.goto(`${BASE}/dev`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  const rule = await actor.evaluate(async () => {
    const response = await fetch("/api/trpc/rules.list", { credentials: "include" });
    const rows = (await response.json())?.result?.data?.json || [];
    return rows[0] ? { id: rows[0].id, isEnabled: !!rows[0].isEnabled } : null;
  });
  check(!!rule, "开发数据里有规则可以拿来开关");
  if (rule) {
    // 关一下再开回去：数据恢复原样
    for (const enabled of [!rule.isEnabled, rule.isEnabled]) {
      const status = await actor.evaluate(async ({ id, enabled }) => (await fetch("/api/trpc/rules.toggle", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { id, isEnabled: enabled } }),
      })).status, { id: rule.id, enabled });
      const changedAt = Date.now();
      await watcher.waitForTimeout(MAX_MS + 1_000);
      // 只看轮询不会碰的那份（累计流量，几分钟一轮），它被重取说明是通知触发的
      const refetch = requests.find((request) => request.at >= changedAt && request.path.includes("rules.trafficSummary") && request.path.includes("%22total%22"));
      const delay = refetch ? refetch.at - changedAt : null;
      check(status === 200 && delay !== null && delay <= MAX_MS, `另一个标签页${enabled ? "开启" : "关闭"}规则后 ${delay ?? "∞"} ms 重取（要求 ≤ ${MAX_MS} ms）`);
    }
  }

  // 查询缓存最快 30 秒存一轮：等它存过再看
  await watcher.waitForTimeout(32_000);
  const stored = await watcher.evaluate(() => {
    const out = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("forwardx.queryCache")) out.push(localStorage.getItem(key) || "");
    }
    return out.join("\n");
  });
  const leaked = stored.match(STATUS_FIELD);
  check(stored.length > 0 && !leaked, `本机查询缓存不存状态字段${leaked ? `（发现 ${leaked[1]}）` : ""}`);

  const started = Date.now();
  await watcher.reload({ waitUntil: "commit" });
  await watcher.waitForSelector("main", { timeout: 10_000 }).catch(() => undefined);
  const painted = Date.now() - started;
  check(painted <= 3_000, `刷新后 ${painted} ms 画出页面（要求 ≤ 3000 ms）`);
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n[live-check] ${failures.length} 项没过`);
  process.exit(1);
}
console.log("\n[live-check] 全部通过");
