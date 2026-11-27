#!/usr/bin/env node
/*
  面板页面打开 / 刷新的速度（生产包）。登录一次，然后对规则、链路、主机三页各测「第一次打开」（空缓存）和「刷新」：

    shell     外壳（侧边栏）画出来
    content   这一页的内容画出来（规则卡 / 链路卡 / 主机列表）
    api       这期间等了几个接口、最慢的那个多久
    js        下了多少 JS（刷新时应该几乎都走浏览器缓存）

  两种网络：local（本机直连）和 remote（模拟海外线路：往返 150 ms、下行 20 Mbps）。

  用法（生产模式起面板，数据用开发面板那一份）：
    pnpm build
    NODE_ENV=production FORWARDX_DEV_PANEL=1 DATABASE_TYPE=sqlite DATABASE_CONFIG_PATH=$PWD/.dev/database.json \
      SQLITE_PATH=$PWD/.dev/forwardx-dev.db FORWARDX_JWT_SECRET_PATH=$PWD/.dev/jwt.secret PORT=3100 node --import tsx server/index.ts
    node scripts/bench/page-load.mjs            # NEX_PANEL_URL 默认 http://127.0.0.1:3100
  （先跑过一次 npm run dev:panel，.dev 里才有开发数据。）
*/
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = (process.env.NEX_PANEL_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
const USER = process.env.NEX_USER || "dev.admin@forwardx.local";
const PASS = process.env.NEX_PASS || "forwardx-dev";
const ROUNDS = Number(process.env.NEX_ROUNDS || 3);
const PAGES = [
  { path: "/rules", content: ".fx-ds-rule, .fx-rule-card-body" },
  { path: "/tunnels", content: ".fx-tunnel-card, .fx-ds-link-name" },
  { path: "/hosts", content: ".fx-host-card, .fx-ds-host-list > *" },
];
const NETWORKS = {
  local: null,
  remote: { offline: false, latency: 150, downloadThroughput: (20 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 },
};

async function measure(page, cdp, url, contentSelector, reload) {
  const api = new Map();
  const onRequest = (request) => { if (request.url().includes("/api/trpc/")) api.set(request, { start: Date.now(), end: 0 }); };
  const onFinished = (request) => { const item = api.get(request); if (item) item.end = Date.now(); };
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  const started = Date.now();
  if (reload) await page.reload({ waitUntil: "commit" });
  else await page.goto(url, { waitUntil: "commit" });
  const shell = await page.waitForSelector("[data-sidebar], nav, aside", { timeout: 30_000 }).then(() => Date.now() - started).catch(() => null);
  const content = await page.waitForSelector(contentSelector, { timeout: 30_000 }).then(() => Date.now() - started).catch(() => null);
  await page.waitForTimeout(300);
  page.off("request", onRequest);
  page.off("requestfinished", onFinished);
  // 真的走了网络的 JS 字节（浏览器缓存命中的 transferSize 是 0）
  const jsBytes = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => /\.js(\?|$)/.test(entry.name))
    .reduce((sum, entry) => sum + (entry.transferSize || 0), 0)).catch(() => 0);
  const calls = Array.from(api.values()).filter((item) => item.start - started <= (content ?? 30_000));
  const slowest = calls.reduce((max, item) => Math.max(max, (item.end || Date.now()) - item.start), 0);
  return { shell, content, apiCalls: calls.length, slowestApi: slowest, jsKB: Math.round(jsBytes / 1024) };
}

const median = (values) => {
  const sorted = values.filter((value) => value != null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

const browser = await chromium.launch();
try {
  const login = await browser.newContext();
  const loginPage = await login.newPage();
  await loginPage.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await loginPage.fill("#username", USER);
  await loginPage.fill("#password", PASS);
  await loginPage.press("#password", "Enter");
  await loginPage.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  const storageState = await login.storageState();
  await login.close();

  const rows = [];
  for (const [network, conditions] of Object.entries(NETWORKS)) {
    for (const target of PAGES) {
      const cold = [];
      const warm = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        // 每轮一个新的浏览器上下文：第一次打开是空的 HTTP 缓存，刷新时缓存是热的
        const context = await browser.newContext({ storageState, viewport: { width: 1280, height: 900 } });
        await context.addInitScript(() => { try { localStorage.setItem("forwardx.announcement.dismissed", "all"); } catch {} });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        if (conditions) await cdp.send("Network.emulateNetworkConditions", conditions);
        cold.push(await measure(page, cdp, `${BASE}${target.path}`, target.content, false));
        await page.waitForTimeout(2_000);
        warm.push(await measure(page, cdp, `${BASE}${target.path}`, target.content, true));
        await context.close();
      }
      for (const [kind, samples] of [["首次打开", cold], ["刷新", warm]]) {
        rows.push({
          network, page: target.path, kind,
          shell: median(samples.map((sample) => sample.shell)),
          content: median(samples.map((sample) => sample.content)),
          apiCalls: median(samples.map((sample) => sample.apiCalls)),
          slowestApi: median(samples.map((sample) => sample.slowestApi)),
          jsKB: median(samples.map((sample) => sample.jsKB)),
        });
      }
    }
  }
  console.log("network  page      kind      shell(ms)  content(ms)  api  slowestApi(ms)  js(KB)");
  for (const row of rows) {
    console.log([row.network.padEnd(8), row.page.padEnd(9), row.kind.padEnd(6), String(row.shell).padStart(9), String(row.content).padStart(12), String(row.apiCalls).padStart(4), String(row.slowestApi).padStart(15), String(row.jsKB).padStart(7)].join("  "));
  }
  if (process.env.NEX_JSON) console.log(JSON.stringify(rows));
} finally {
  await browser.close();
}
