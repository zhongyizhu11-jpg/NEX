import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 公开监控页和主机批量接口打多少次库，以及打完之后结果对不对。
 *
 * 公开监控页（hosts.publicMonitor）不登录、每个观看者每 3 秒轮询一次。原来每个主机主人
 * 各一次 getUserById 判断是不是管理员，而且每次轮询都整页重算。latestMetricsSummary /
 * trafficSummary / watchMetrics 原来逐台 requireHostAccess，一次 500 台就是上千条查询。
 *
 * 所以这一组钉三件事：
 *   1. **条数不随主人数 / 主机数涨** —— 真正拦 N+1 的是这条，只订绝对值的话，
 *      「每个多查一次」的写法在小数据上照样能过。
 *   2. **缓存命中时不重算，但开关/路径校验仍在缓存外** —— 关掉公开页要立刻生效。
 *   3. **批量校验的报错与逐台校验一致** —— 按入参顺序遇到的第一台不存在/无权的主机，
 *      抛同样的文案。
 */

type Probe = {
  monitorCost: Record<string, number>;
  cachedCost: number;
  monitorHostIds: number[];
  cachedSame: boolean;
  disabledError: string;
  accessCost: Record<string, number>;
  errors: Record<string, string>;
  watchCount: number;
};

function runProbe(): Probe {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-monitor-cost-"));
  const databasePath = path.join(directory, "hosts.db");
  const script = String.raw`
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    // 钩子挂在建库之前：drizzle 的和裸 SQL 的语句都从 prepare 过。
    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    let statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    // 接口限流的配置第一次用到时才去库里读（server/apiRateLimitConfig.ts，之后 30 秒后台刷新一次）：
    // 先固定下来，免得那一次读正好被算进第一轮测量，看起来像 N+1。
    const rateLimitConfig = await import(url("server/apiRateLimitConfig.ts"));
    const rateLimit = await import(url("server/apiRateLimit.ts"));
    rateLimitConfig.setApiRateLimitConfigForTests(rateLimit.DEFAULT_API_RATE_LIMIT);
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const settings = await import(url("server/repositories/settingsRepository.ts"));

    // 1 号是管理员；2..7 号：偶数管理员、奇数租户。
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    for (let u = 2; u <= 7; u++) {
      await exec("INSERT INTO users (id, username, password, role) VALUES (?, ?, 'hash', ?)", [u, "u" + u, u % 2 === 0 ? "admin" : "user"]);
    }
    let hostId = 0;
    const addHost = async (userId) => {
      hostId += 1;
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
        [hostId, "机器" + hostId, "10.0.0." + hostId, "10.0.0." + hostId, "slave", "tok" + hostId, userId, Math.floor(Date.now() / 1000)],
      );
      return hostId;
    };
    // 第一轮：一个管理员主人 + 一个租户主人 + 一台没有主人的机器
    await addHost(1);
    await addHost(3);
    await addHost(0);

    const hostsRouter = (await import(url("server/routers/hosts.ts"))).hostsRouter;
    const publicCaller = hostsRouter.createCaller({ user: null, req: { headers: {} }, res: { setHeader: () => {} } });
    const measure = async (fn) => {
      statements = []; recording = true;
      try { return await fn(); } finally { recording = false; }
    };

    await settings.setSetting("publicHostMonitorEnabled", "true");
    const monitorCost = {};
    await settings.setSetting("publicHostMonitorPath", "watch-a");
    await measure(() => publicCaller.publicMonitor({ path: "watch-a" }));
    monitorCost["owners=2"] = statements.length;

    // 第二轮：再加五个主人（管理员和租户都有），换一个路径让缓存键变掉
    for (let u = 2; u <= 7; u++) { await addHost(u); await addHost(u); }
    await settings.setSetting("publicHostMonitorPath", "watch-b");
    const fresh = await measure(() => publicCaller.publicMonitor({ path: "watch-b" }));
    monitorCost["owners=7"] = statements.length;

    const cached = await measure(() => publicCaller.publicMonitor({ path: "watch-b" }));
    const cachedCost = statements.length;

    await settings.setSetting("publicHostMonitorEnabled", "false");
    let disabledError = "";
    try { await publicCaller.publicMonitor({ path: "watch-b" }); } catch (error) { disabledError = String(error?.message || error); }

    // 批量主机权限：租户 3 号自己有 4、8、9 号机（见上面 addHost 的顺序），另授权 1 号机
    await exec('INSERT INTO user_host_permissions ("userId", "hostId") VALUES (3, 1)');
    const tenant = hostsRouter.createCaller({ user: { id: 3, role: "user", username: "u3" }, req: { headers: {} }, res: { setHeader: () => {} } });
    const owned = [2, 6, 7];
    const accessCost = {};
    await measure(() => tenant.latestMetricsSummary({ hostIds: [owned[0], 1] }));
    accessCost["latest:2"] = statements.length;
    await measure(() => tenant.latestMetricsSummary({ hostIds: [...owned, 1] }));
    accessCost["latest:4"] = statements.length;
    await measure(() => tenant.trafficSummary({ hostIds: [owned[0], 1] }));
    accessCost["traffic:2"] = statements.length;
    await measure(() => tenant.trafficSummary({ hostIds: [...owned, 1] }));
    accessCost["traffic:4"] = statements.length;

    const errors = {};
    const capture = async (key, fn) => {
      try { await fn(); errors[key] = "ok"; } catch (error) { errors[key] = String(error?.message || error); }
    };
    // 4 号机是 2 号管理员的，租户无权；999 不存在。报的是入参顺序里的第一个问题。
    await capture("missing-first", () => tenant.latestMetricsSummary({ hostIds: [2, 999, 4] }));
    await capture("forbidden-first", () => tenant.latestMetricsSummary({ hostIds: [2, 4, 999] }));
    await capture("traffic-forbidden", () => tenant.trafficSummary({ hostIds: [4] }));
    await capture("watch-forbidden", () => tenant.watchMetrics({ hostIds: [2, 4] }));
    await capture("allowed", () => tenant.latestMetricsSummary({ hostIds: [2, 1] }));
    const watch = await tenant.watchMetrics({ hostIds: [2, 1, 2] });

    console.log("MONITORCOST " + JSON.stringify({
      monitorCost,
      cachedCost,
      monitorHostIds: fresh.hosts.map((host) => host.id),
      cachedSame: JSON.stringify(fresh) === JSON.stringify(cached),
      disabledError,
      accessCost,
      errors,
      watchCount: watch.count,
    }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    timeout: 120000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("MONITORCOST "));
  assert.ok(line, `没拿到探测结果：\n${result.stdout}`);
  return JSON.parse(line.slice("MONITORCOST ".length)) as Probe;
}

const probe = runProbe();

test("公开监控页的打库次数不随主机主人数增长", () => {
  const { "owners=2": small, "owners=7": large } = probe.monitorCost;
  assert.equal(large, small, `主人从 2 个涨到 7 个，打库次数却在变：${JSON.stringify(probe.monitorCost)}（每个主人一次 getUserById 就是 N+1）`);
  assert.ok(small <= 10, `公开监控页一次打库 ${small} 次，超了预算 10`);
});

test("公开监控页只展示管理员的和没有主人的机器", () => {
  // 1 号（管理员 1）、3 号（无主）、2/4/6 号主人的机器（管理员），租户 3/5/7 的不出现
  assert.deepEqual(probe.monitorHostIds.slice().sort((a, b) => a - b), [1, 3, 4, 5, 8, 9, 12, 13]);
});

test("公开监控页在缓存有效期内不重算，关掉之后立刻不可访问", () => {
  assert.ok(probe.cachedSame, "缓存命中返回的内容和刚算出来的不一样");
  assert.ok(probe.cachedCost <= 1, `缓存命中还打了 ${probe.cachedCost} 次库（最多只该有开关校验读设置那一次）`);
  assert.match(probe.disabledError, /主机监控面板未开启或路径不正确/);
});

test("批量主机接口的权限校验不随主机数增长", () => {
  assert.equal(probe.accessCost["latest:4"], probe.accessCost["latest:2"], JSON.stringify(probe.accessCost));
  assert.equal(probe.accessCost["traffic:4"], probe.accessCost["traffic:2"], JSON.stringify(probe.accessCost));
});

test("批量权限校验按入参顺序报第一个错误，文案与逐台校验一致", () => {
  assert.equal(probe.errors["missing-first"], "主机不存在");
  assert.equal(probe.errors["forbidden-first"], "无权访问该主机");
  assert.equal(probe.errors["traffic-forbidden"], "无权访问该主机");
  assert.equal(probe.errors["watch-forbidden"], "无权访问该主机");
  assert.equal(probe.errors.allowed, "ok");
  // 重复的 id 照旧各算一次
  assert.equal(probe.watchCount, 3);
});
