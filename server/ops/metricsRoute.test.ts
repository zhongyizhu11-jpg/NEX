import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { generateMetricsToken, maskMetricsToken, metricsTokenMatches, normalizeMetricsMaxRules, type MetricsExportConfig } from "./metricsExportSettings";
import { createMetricsRouter, METRICS_CACHE_TTL_MS, METRICS_CONTENT_TYPE } from "./metricsRoute";

const TOKEN = "nex_metrics_test-token-0123456789";

/** 起一个只挂了 /metrics 的小服务；后面再挂一个兜底路由，模拟面板「别的路径回前端页面」。 */
async function withServer(
  options: { config: MetricsExportConfig | null | (() => MetricsExportConfig | null); render?: (config: MetricsExportConfig) => Promise<string>; now?: () => number },
  run: (context: { get: (headers?: Record<string, string>) => Promise<Response>; renders: () => number; base: string }) => Promise<void>,
) {
  let renders = 0;
  const app = express();
  app.use(createMetricsRouter({
    loadConfig: async () => (typeof options.config === "function" ? options.config() : options.config),
    render: async (config) => {
      renders += 1;
      return options.render ? options.render(config) : `nex_test ${renders}\n`;
    },
    now: options.now,
  }));
  app.get("*", (_req, res) => { res.status(200).type("text/html").send("<html>面板</html>"); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ base, renders: () => renders, get: (headers = {}) => fetch(`${base}/metrics`, { headers }) });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const enabled = (patch: Partial<MetricsExportConfig> = {}): MetricsExportConfig => ({ enabled: true, token: TOKEN, maxRules: 500, ...patch });
const bearer = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

test("没开时 /metrics 回 404：带对的口令也一样，不取数、不透露这里有指标接口", async () => {
  for (const config of [null, enabled({ enabled: false })]) {
    await withServer({ config }, async ({ get, renders }) => {
      for (const headers of [{}, bearer(), bearer("wrong")]) {
        const response = await get(headers);
        assert.equal(response.status, 404);
        assert.equal(response.headers.get("www-authenticate"), null);
        assert.equal(await response.text(), "Not Found\n");
      }
      assert.equal(renders(), 0);
    });
  }
});

test("开着时没带口令、口令不对、不是 Bearer 都回 401，并且不取数", async () => {
  await withServer({ config: enabled() }, async ({ get, renders }) => {
    const attempts: Array<Record<string, string>> = [
      {},
      bearer("nex_metrics_wrong"),
      bearer(`${TOKEN}x`),
      bearer(TOKEN.slice(0, -1)),
      { authorization: TOKEN },
      { authorization: `Basic ${Buffer.from(`metrics:${TOKEN}`).toString("base64")}` },
    ];
    for (const headers of attempts) {
      const response = await get(headers);
      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.match(String(response.headers.get("www-authenticate")), /^Bearer /);
      assert.ok(!(await response.text()).includes("nex_test"));
    }
    assert.equal(renders(), 0);
  });
});

test("口令不认查询参数：地址里带口令照样 401", async () => {
  await withServer({ config: enabled() }, async ({ base }) => {
    const response = await fetch(`${base}/metrics?token=${TOKEN}&access_token=${TOKEN}`);
    assert.equal(response.status, 401);
  });
});

test("开着但没有口令（比如密钥变了解不开）：任何请求都是 401，空口令也对不上", async () => {
  await withServer({ config: enabled({ token: "" }) }, async ({ get }) => {
    assert.equal((await get()).status, 401);
    assert.equal((await get({ authorization: "Bearer " })).status, 401);
    assert.equal((await get({ authorization: "Bearer" })).status, 401);
  });
});

test("口令对了回 200，类型是 Prometheus 文本格式 0.0.4，不让中间缓存", async () => {
  await withServer({ config: enabled(), render: async () => "# HELP nex_hosts 主机总数\n# TYPE nex_hosts gauge\nnex_hosts 3\n" }, async ({ get }) => {
    const response = await get(bearer());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), METRICS_CONTENT_TYPE);
    assert.equal(METRICS_CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "# HELP nex_hosts 主机总数\n# TYPE nex_hosts gauge\nnex_hosts 3\n");
    // Bearer 大小写不敏感（RFC 7235）
    assert.equal((await get({ authorization: `bearer ${TOKEN}` })).status, 200);
  });
});

test("缓存：10 秒内抓多少次都只取一次数，过了 10 秒才重新取", async () => {
  let now = 1_000_000;
  await withServer({ config: enabled(), now: () => now }, async ({ get, renders }) => {
    assert.equal(METRICS_CACHE_TTL_MS, 10_000);
    assert.equal(await (await get(bearer())).text(), "nex_test 1\n");
    for (let index = 0; index < 20; index += 1) {
      now += 400;
      assert.equal(await (await get(bearer())).text(), "nex_test 1\n");
    }
    assert.equal(renders(), 1);
    now = 1_000_000 + METRICS_CACHE_TTL_MS - 1;
    await get(bearer());
    assert.equal(renders(), 1);
    now = 1_000_000 + METRICS_CACHE_TTL_MS;
    assert.equal(await (await get(bearer())).text(), "nex_test 2\n");
    assert.equal(renders(), 2);
  });
});

test("缓存：口令不对的请求拿不到缓存里的内容", async () => {
  await withServer({ config: enabled() }, async ({ get }) => {
    assert.equal((await get(bearer())).status, 200);
    const denied = await get(bearer("nex_metrics_wrong"));
    assert.equal(denied.status, 401);
    assert.equal(await denied.text(), "Unauthorized\n");
  });
});

test("缓存：同时来的几个抓取等同一次取数，不各取各的", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withServer({
    config: enabled(),
    render: async () => {
      await gate;
      return "nex_test 1\n";
    },
  }, async ({ get, renders }) => {
    const pending = [get(bearer()), get(bearer()), get(bearer())];
    // 等三个请求都进到取数那一步
    for (let attempt = 0; attempt < 50 && renders() === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const responses = await Promise.all(pending);
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
    assert.equal(renders(), 1);
  });
});

test("缓存：规则上限改了立刻按新设置重新取，关掉再打开也不会拿到关之前的旧内容", async () => {
  let config = enabled({ maxRules: 500 });
  await withServer({ config: () => config, render: async (current) => `nex_test_max_rules ${current.maxRules}\n` }, async ({ get, renders }) => {
    assert.equal(await (await get(bearer())).text(), "nex_test_max_rules 500\n");
    config = enabled({ maxRules: 50 });
    assert.equal(await (await get(bearer())).text(), "nex_test_max_rules 50\n");
    assert.equal(renders(), 2);
    config = enabled({ enabled: false, maxRules: 50 });
    assert.equal((await get(bearer())).status, 404);
    config = enabled({ maxRules: 50 });
    await get(bearer());
    assert.equal(renders(), 3);
  });
});

test("取数出错回 500，不带错误细节；下一次抓取会重试", async () => {
  let fail = true;
  await withServer({
    config: enabled(),
    render: async () => {
      if (fail) throw new Error("SQLITE_BUSY: /data/forwardx.db is locked");
      return "nex_test 1\n";
    },
  }, async ({ get }) => {
    const failed = await get(bearer());
    assert.equal(failed.status, 500);
    assert.ok(!(await failed.text()).includes("forwardx.db"));
    fail = false;
    assert.equal((await get(bearer())).status, 200);
  });
});

test("读设置出错按没开处理：404", async () => {
  await withServer({ config: () => { throw new Error("database is down"); } }, async ({ get }) => {
    assert.equal((await get(bearer())).status, 404);
  });
});

test("只有 GET /metrics 这一条路径归它管，别的路径照常落到面板自己的路由上", async () => {
  await withServer({ config: enabled() }, async ({ base }) => {
    assert.equal((await fetch(`${base}/metrics/extra`)).status, 200);
    assert.equal((await fetch(`${base}/api/metrics`)).status, 200);
  });
});

test("口令：每次生成的都不一样、带 nex_metrics_ 前缀、足够长；打码后只留末 4 位", () => {
  const first = generateMetricsToken();
  const second = generateMetricsToken();
  assert.notEqual(first, second);
  assert.match(first, /^nex_metrics_[A-Za-z0-9_-]{43}$/);
  const masked = maskMetricsToken(first);
  assert.ok(masked.endsWith(first.slice(-4)));
  assert.ok(!masked.includes(first.slice(12, -4)));
  assert.equal(maskMetricsToken(""), "");
});

test("口令比对：只认完整相等的 Bearer 口令", () => {
  assert.equal(metricsTokenMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(metricsTokenMatches(`Bearer  ${TOKEN} `, TOKEN), true);
  assert.equal(metricsTokenMatches([`Bearer ${TOKEN}`], TOKEN), true);
  assert.equal(metricsTokenMatches(`Bearer ${TOKEN.toUpperCase()}`, TOKEN), false);
  assert.equal(metricsTokenMatches(undefined, TOKEN), false);
  assert.equal(metricsTokenMatches("Bearer ", ""), false);
  assert.equal(metricsTokenMatches(`Bearer ${TOKEN}`, ""), false);
});

test("规则上限：不填用默认 500，乱填回默认，超过 2000 压到 2000，0 表示永远只给汇总", () => {
  assert.equal(normalizeMetricsMaxRules(undefined), 500);
  assert.equal(normalizeMetricsMaxRules(""), 500);
  assert.equal(normalizeMetricsMaxRules("abc"), 500);
  assert.equal(normalizeMetricsMaxRules(-1), 500);
  assert.equal(normalizeMetricsMaxRules("120"), 120);
  assert.equal(normalizeMetricsMaxRules(0), 0);
  assert.equal(normalizeMetricsMaxRules(99999), 2000);
});
