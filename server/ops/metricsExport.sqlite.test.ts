import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 指标导出接上真库（SQLite）：
 *   1. 设置：默认关；打开时自动生成口令；口令落库是密文；只有管理员能看能改；每次改动进操作审计，审计里没有口令。
 *   2. 取数：主机 / 规则 / 线路组的数从面板现成的批量查询和内存态来，写出来的值对得上。
 *   3. 查库次数不随规则数涨 —— 拦住「每条规则查一次」的写法：只钉绝对值的话，那种写法在小数据上照样能过。
 *   4. 上限保护：规则多于上限时不逐条导出、也不整表读规则；线路组没超就照常给。
 */
function runProbe() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-metrics-export-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    // 钩子挂在建库之前：drizzle 的和裸 SQL 的语句都从 prepare 过（这样语句缓存也不生效，每条都数得到）。
    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    let statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };
    const measure = async (fn) => {
      statements = []; recording = true;
      try { return await fn(); } finally { recording = false; }
    };

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const rateLimitConfig = await import(url("server/apiRateLimitConfig.ts"));
    const rateLimit = await import(url("server/apiRateLimit.ts"));
    rateLimitConfig.setApiRateLimitConfigForTests(rateLimit.DEFAULT_API_RATE_LIMIT);

    const settings = await import(url("server/ops/metricsExportSettings.ts"));
    const collect = await import(url("server/ops/metricsCollect.ts"));
    const families = await import(url("server/ops/metricsFamilies.ts"));
    const text = await import(url("server/ops/metricsText.ts"));
    const audit = await import(url("server/operationAudit.ts"));
    const routeStats = await import(url("server/routeGroupStats.ts"));
    const liveRates = await import(url("server/ruleLiveRates.ts"));
    const hostLoad = await import(url("server/hostLoad.ts"));
    const { databaseHealth } = await import(url("server/databaseHealthState.ts"));
    const { metricsExportRouter } = await import(url("server/routers/ops/metricsExport.ts"));
    databaseHealth.configure("sqlite");
    databaseHealth.healthy();

    const out = {};
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);

    // ── 1. 设置 ──
    const ctxOf = (user) => ({
      req: { headers: { "user-agent": "metrics-test/1.0" }, ip: "203.0.113.9", socket: {}, originalUrl: "/api/trpc/x" },
      res: { cookie() {}, clearCookie() {} },
      user, authSession: null, authFailureReason: null,
    });
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'root', 'h', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'h', 'user')");
    const admin = metricsExportRouter.createCaller(ctxOf({ id: 1, username: "root", role: "admin" }));
    const tenant = metricsExportRouter.createCaller(ctxOf({ id: 2, username: "tenant", role: "user" }));

    const initial = await admin.get();
    out.initial = { enabled: initial.enabled, hasToken: initial.hasToken, maxRules: initial.maxRules, tokenMasked: initial.tokenMasked };
    out.initialConfig = await settings.loadMetricsExportConfig();

    const turnedOn = await admin.update({ enabled: true });
    out.turnedOn = { enabled: turnedOn.enabled, hasToken: turnedOn.hasToken, hasTokenField: "token" in turnedOn };
    const firstToken = (await admin.revealToken()).token;
    out.firstTokenShape = /^nex_metrics_[A-Za-z0-9_-]{43}$/.test(firstToken);
    out.maskedHidesToken = !turnedOn.tokenMasked.includes(firstToken.slice(12, -4)) && turnedOn.tokenMasked.endsWith(firstToken.slice(-4));
    const rawRows = await runtime.queryRaw("SELECT value FROM system_settings WHERE key = 'ops.metrics.token'");
    out.storedEncrypted = rawRows.length === 1 && !String(rawRows[0].value).includes("nex_metrics_") && String(rawRows[0].value).length > 20;

    // 关掉再打开：口令不变（Prometheus 那边不用跟着改）
    await admin.update({ enabled: false });
    out.offConfig = (await settings.loadMetricsExportConfig()).enabled;
    await admin.update({ enabled: true });
    out.tokenKeptAcrossToggle = (await admin.revealToken()).token === firstToken;

    const reset = await admin.resetToken();
    out.resetChanged = reset.token !== firstToken && /^nex_metrics_/.test(reset.token);
    out.resetEffective = (await settings.loadMetricsExportConfig()).token === reset.token;
    out.oldTokenRejected = !settings.metricsTokenMatches("Bearer " + firstToken, (await settings.loadMetricsExportConfig()).token);

    out.maxRulesSaved = (await admin.update({ maxRules: 50 })).maxRules;
    out.maxRulesStillOn = (await admin.get()).enabled;
    const rejects = async (fn) => { try { await fn(); return "ok"; } catch (error) { return String(error?.code || error?.message || error); } };
    out.maxRulesTooBig = await rejects(() => admin.update({ maxRules: 999999 }));
    out.tenantGet = await rejects(() => tenant.get());
    out.tenantUpdate = await rejects(() => tenant.update({ enabled: false }));
    out.tenantReveal = await rejects(() => tenant.revealToken());
    out.tenantReset = await rejects(() => tenant.resetToken());
    out.anonymousGet = await rejects(() => metricsExportRouter.createCaller(ctxOf(null)).get());
    out.stillOnAfterTenant = (await settings.loadMetricsExportConfig()).enabled;

    await audit.drainOperationAuditWrites();
    const auditRows = await runtime.queryRaw("SELECT path, result, actorName, inputJson FROM operation_audit_events ORDER BY id");
    out.audit = auditRows.map((row) => row.path + ":" + row.result + ":" + row.actorName);
    out.auditLeaksToken = auditRows.some((row) => JSON.stringify(row).includes(firstToken) || JSON.stringify(row).includes(reset.token));
    out.auditInputs = auditRows.filter((row) => row.path === "update" && row.result === "ok").map((row) => row.inputJson);

    // ── 2. 取数 ──
    const addHost = (id, name, online, heartbeatAgo, agentVersion) => exec(
      'INSERT INTO hosts (id, name, ip, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion") VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
      [id, name, "203.0.113." + id, "slave", "tok" + id, online ? 1 : 0, heartbeatAgo === null ? null : nowSec - heartbeatAgo, agentVersion],
    );
    await addHost(1, 'HK "入口" 01', true, 5, "2.2.252");
    await addHost(2, "JP 出口 02", false, 7200, "2.2.250");
    await addHost(3, "从没上线", false, null, null);
    await addHost(4, "SG 中转 04", true, 3, "2.2.252");
    await exec('INSERT INTO host_metrics ("hostId", "cpuUsage", "memoryUsage", "diskUsage", "tcpConnections", "udpConnections", "networkIn", "networkOut", "recordedAt") VALUES (1, 37, 62, 81, 120, 8, 1000, 2000, ?)', [nowSec - 10]);
    await exec('INSERT INTO host_metrics ("hostId", "cpuUsage", "memoryUsage", "diskUsage", "tcpConnections", "udpConnections", "networkIn", "networkOut", "recordedAt") VALUES (2, 99, 99, 99, 999, 99, 1000, 2000, ?)', [nowSec - 7200]);
    await exec('INSERT INTO host_traffic_counters ("hostId", "bytesIn", "bytesOut") VALUES (1, 111000, 222000)');
    hostLoad.recordHostLoadSample(1, { at: now - 1000, cpuUsage: 45, networkIn: 0, networkOut: 0 }, 0, now - 1000);

    let ruleId = 100;
    const addRule = async (fields) => {
      ruleId += 1;
      const row = { id: ruleId, hostId: 1, name: "规则 " + ruleId, forwardType: "realm", protocol: "tcp", sourcePort: 20000 + ruleId, targetIp: "198.51.100.7", targetPort: 443, userId: 1, isEnabled: 1, isRunning: 1, ...fields };
      const keys = Object.keys(row);
      await exec("INSERT INTO forward_rules (" + keys.map((key) => '"' + key + '"').join(", ") + ") VALUES (" + keys.map(() => "?").join(", ") + ")", keys.map((key) => row[key]));
      return row.id;
    };
    const routePaths = JSON.stringify([
      { key: "main", name: "主线路", hops: [], dest: null, weight: 50, probe: null, dial: { ip: "198.51.100.7", port: 443 } },
      { key: "backup", name: "晚高峰\"线路\"", hops: [4], dest: null, weight: 50, probe: null, dial: { ip: "203.0.113.4", port: 31000 } },
    ]);
    const plain = await addRule({ name: '游戏"加速"\\线\n路' });
    const stopped = await addRule({ name: "停用的", isEnabled: 0, isRunning: 0 });
    const routed = await addRule({ name: "线路组规则", failoverEnabled: 1, routeMode: "failover", routePaths });
    // 端口转发模板：自己不跑，两台成员机上各一条子规则（一条在跑）；线路组挂在模板上，评分记在子规则上。
    const template = await addRule({ name: "端口转发模板", isRunning: 0, isForwardGroupTemplate: 1, forwardGroupId: 9, failoverEnabled: 1, routeMode: "failover", routePaths });
    const childA = await addRule({ name: "子规则 A", hostId: 1, forwardGroupId: 9, forwardGroupRuleId: template, forwardGroupMemberId: 1, failoverEnabled: 1, routeMode: "failover", routePaths });
    const childB = await addRule({ name: "子规则 B", hostId: 2, isRunning: 0, forwardGroupId: 9, forwardGroupRuleId: template, forwardGroupMemberId: 2, failoverEnabled: 1, routeMode: "failover", routePaths });
    // 不该出现在指标里的：线路组的中继规则、待删除的规则
    const relay = await addRule({ name: "中继", hostId: 4, routeParentRuleId: routed, routePathKey: "backup", routeHopIndex: 0 });
    const deleting = await addRule({ name: "删除中", pendingDelete: 1 });

    const addCounter = (rule, host, bytesIn, bytesOut, connections) => exec(
      'INSERT INTO forward_rule_traffic_counters ("ruleId", "hostId", "userId", "bytesIn", "bytesOut", connections) VALUES (?, ?, 1, ?, ?, ?)',
      [rule, host, bytesIn, bytesOut, connections],
    );
    await addCounter(plain, 1, 5000, 7000, 42);
    await addCounter(routed, 1, 100, 200, 3);
    await addCounter(childA, 1, 1000, 2000, 5);
    await addCounter(childB, 2, 10, 20, 1);
    await exec('INSERT INTO user_traffic_counters ("userId", "bytesIn", "bytesOut", connections) VALUES (1, 6110, 9220, 51)');
    const addProbe = (rule, host, latencyMs, isTimeout, ago) => exec(
      'INSERT INTO tcping_stats ("ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt") VALUES (?, ?, ?, ?, ?)',
      [rule, host, latencyMs, isTimeout ? 1 : 0, nowSec - ago],
    );
    await addProbe(plain, 1, 80, false, 300);
    await addProbe(plain, 1, 38, false, 20);
    await addProbe(routed, 1, null, true, 30);
    await addProbe(stopped, 1, 25, false, 3 * 3600); // 太旧：不导出
    const addEvent = (rule, kind, ago) => exec(
      'INSERT INTO forward_rule_route_events ("ruleId", kind, "fromKey", "toKey", reason, "createdAt") VALUES (?, ?, ?, ?, ?, ?)',
      [rule, kind, "main", "backup", "health check", nowSec - ago],
    );
    await addEvent(routed, "switch", 600);
    await addEvent(routed, "switch", 7200);
    await addEvent(routed, "unhealthy", 500);       // 不是切换
    await addEvent(routed, "switch", 30 * 3600);    // 超过 24 小时
    await addEvent(template, "switch", 100);        // 面板上人工指定引起的，记在模板上
    await addEvent(childA, "switch", 200);          // Agent 报的，记在子规则上
    await addEvent(childB, "switch", 300);

    liveRates.recordRuleTrafficSample({ ruleId: plain, hostId: 1, bytesIn: 0, bytesOut: 0, nowMs: now - 4000 });
    liveRates.recordRuleTrafficSample({ ruleId: plain, hostId: 1, bytesIn: 8000, bytesOut: 4000, nowMs: now - 2000 });
    liveRates.recordRuleTrafficSample({ ruleId: childA, hostId: 1, bytesIn: 0, bytesOut: 0, nowMs: now - 4000 });
    liveRates.recordRuleTrafficSample({ ruleId: childA, hostId: 1, bytesIn: 2000, bytesOut: 1000, nowMs: now - 2000 });
    const target = (index, patch) => ({ index, target: "t" + index, healthy: true, score: 90, latencyMs: 40, lossPct: 0, jitterMs: 4, availabilityPct: 100, consecutiveFailures: 0, connections: 3, samples: 60, lastProbeAt: now - 3000, ...patch });
    routeStats.recordRouteAgentStats({ hostId: 1, isAllowed: () => true, nowMs: now - 2000, reports: [
      { ruleId: routed, sourcePort: 1, strategy: "fallback", activeIndex: 1, activeSince: now - 60000, prewarmIndex: -1, targets: [
        target(0, { healthy: false, score: 12, latencyMs: 300, lossPct: 40, jitterMs: 80, availabilityPct: 60 }),
        target(1, { score: 81, latencyMs: 74, lossPct: 0.5, jitterMs: 11, availabilityPct: 99.5 }),
      ] },
      { ruleId: childA, sourcePort: 2, strategy: "fallback", activeIndex: 0, activeSince: now - 60000, prewarmIndex: -1, targets: [target(0, { score: 95 }), target(1, { score: 70 })] },
    ] });
    // 备用线路经过 4 号机这一跳：中继探到落地 18 毫秒，算进整条链路的延迟
    routeStats.recordRouteHopProbe({ parentRuleId: routed, pathKey: "backup", hopIndex: 0, hostId: 4, hostName: "SG 中转 04", nextLabel: "落地", ok: true, latencyMs: 18, nowMs: now - 1000 });

    const renderWith = async (maxRules) => text.renderMetricFamilies(families.buildMetricFamilies(await collect.collectMetricsSnapshot({ maxRules })));
    collect.resetMetricsCollectStateForTest();
    await renderWith(500); // 第一轮：给全站流量定基线，也把各处「第一次用到才读」的东西读掉
    await exec('UPDATE user_traffic_counters SET "bytesIn" = "bytesIn" + 400, "bytesOut" = "bytesOut" + 600 WHERE "userId" = 1');
    out.full = await measure(() => renderWith(500));
    out.costSmall = statements.length;
    out.statementsSmall = statements.map((sql) => sql.replace(/\s+/g, " ").slice(0, 90));

    // 全站流量：有用户被重置（读数变小）不往回掉
    await exec('UPDATE user_traffic_counters SET "bytesIn" = 50, "bytesOut" = 60 WHERE "userId" = 1');
    out.afterReset = await renderWith(500);
    await exec('UPDATE user_traffic_counters SET "bytesIn" = 150, "bytesOut" = 260 WHERE "userId" = 1');
    out.afterResetGrowth = await renderWith(500);

    // ── 3. 规则多了，查库次数不变 ──
    const addBatch = async (label, plainCount, routedCount) => {
      for (let index = 0; index < plainCount; index += 1) {
        const id = await addRule({ name: label + " " + index });
        await addCounter(id, 1, 10 + index, 20 + index, 1);
        await addProbe(id, 1, 30 + index, false, 15);
      }
      for (let index = 0; index < routedCount; index += 1) {
        const id = await addRule({ name: label + "线路组 " + index, failoverEnabled: 1, routeMode: "failover", routePaths });
        await addEvent(id, "switch", 60);
      }
    };
    // 规则列表那条查询：按 sortOrder 排的整行读取。带 "failoverEnabled" = 条件的是只读线路组规则的那种。
    const readsAllRules = () => statements
      .filter((sql) => /from\s+"forward_rules"/i.test(sql) && /order by/i.test(sql) && /sortOrder/.test(sql))
      .some((sql) => !/"failoverEnabled"\s*=/.test(sql));
    await addBatch("批量", 40, 6);
    out.big = await measure(() => renderWith(500));
    out.costBig = statements.length;
    out.statementsBig = statements.map((sql) => sql.replace(/\s+/g, " ").slice(0, 90));
    out.fullReadsAllRules = readsAllRules();

    // ── 4. 上限保护 ──
    out.capped = await measure(() => renderWith(20));
    out.costCapped = statements.length;
    out.cappedReadsAllRules = readsAllRules();
    out.cappedAll = await renderWith(3);
    out.zero = await renderWith(0);

    await addBatch("再加", 90, 10);
    out.bigger = await measure(() => renderWith(500));
    out.costBigger = statements.length;

    // 数据库不可用：不碰库，只剩面板自己知道的
    databaseHealth.unavailable({ code: "ECONNREFUSED" });
    out.down = await measure(() => renderWith(500));
    out.costDown = statements.length;
    out.downConfigStillKnown = (await settings.loadMetricsExportConfig()).enabled;
    databaseHealth.healthy();

    // 结果有几百 KB：写文件，不走标准输出（管道没写完进程就退出的话会被截断）。
    (await import("node:fs")).writeFileSync(process.env.FORWARDX_TEST_OUT, JSON.stringify(out));
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        JWT_SECRET: "metrics-export-test-secret",
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "metrics.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
        FORWARDX_TEST_OUT: path.join(directory, "out.json"),
      },
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(fs.readFileSync(path.join(directory, "out.json"), "utf8"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

let cached: ReturnType<typeof runProbe> | null = null;
const probe = () => (cached ||= runProbe());

/** 文本里某个指标、带着这些标签片段的那一行的值；没有这一行返回 null。 */
function value(text: string, name: string, ...fragments: string[]): number | null {
  for (const line of text.split("\n")) {
    if (!(line.startsWith(`${name}{`) || line.startsWith(`${name} `))) continue;
    if (!fragments.every((fragment) => line.includes(fragment))) continue;
    return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return null;
}
const seriesOf = (text: string, prefix: string) => text.split("\n").filter((line) => line.startsWith(prefix)).length;

test("设置：默认关、没有口令；打开时自动生成口令，接口只回打码后的样子", () => {
  const out = probe();
  assert.deepEqual(out.initial, { enabled: false, hasToken: false, maxRules: 500, tokenMasked: "" });
  assert.equal(out.initialConfig.enabled, false);
  assert.deepEqual(out.turnedOn, { enabled: true, hasToken: true, hasTokenField: false });
  assert.equal(out.firstTokenShape, true);
  assert.equal(out.maskedHidesToken, true);
});

test("设置：口令落库是密文；关掉再打开口令不变；重置后旧口令立刻失效", () => {
  const out = probe();
  assert.equal(out.storedEncrypted, true);
  assert.equal(out.offConfig, false);
  assert.equal(out.tokenKeptAcrossToggle, true);
  assert.equal(out.resetChanged, true);
  assert.equal(out.resetEffective, true);
  assert.equal(out.oldTokenRejected, true);
});

test("设置：规则上限能改、超出范围被拒；只改上限不会动开关", () => {
  const out = probe();
  assert.equal(out.maxRulesSaved, 50);
  assert.equal(out.maxRulesStillOn, true);
  assert.notEqual(out.maxRulesTooBig, "ok");
});

test("设置：普通用户和没登录的看不了、改不了、看不到口令", () => {
  const out = probe();
  for (const key of ["tenantGet", "tenantUpdate", "tenantReveal", "tenantReset", "anonymousGet"]) {
    assert.notEqual(out[key], "ok", key);
  }
  assert.equal(out.stillOnAfterTenant, true);
});

test("设置：开关、改上限、看口令、重置口令都进操作审计，审计里没有口令本身", () => {
  const out = probe();
  const ok = out.audit.filter((item: string) => item.endsWith(":ok:root"));
  assert.equal(ok.filter((item: string) => item.startsWith("update:")).length, 4);
  assert.equal(ok.filter((item: string) => item.startsWith("revealToken:")).length, 2);
  assert.equal(ok.filter((item: string) => item.startsWith("resetToken:")).length, 1);
  assert.ok(out.audit.some((item: string) => item.startsWith("update:denied:tenant")));
  assert.ok(out.audit.some((item: string) => item.startsWith("resetToken:denied:tenant")));
  assert.equal(out.auditLeaksToken, false);
  assert.deepEqual(out.auditInputs.map((input: string) => JSON.parse(input)), [{ enabled: true }, { enabled: false }, { enabled: true }, { maxRules: 50 }]);
});

test("取数：面板和主机的数对得上，离线主机没有 CPU / 连接数", () => {
  const text: string = probe().full;
  assert.equal(value(text, "nex_database_up"), 1);
  assert.equal(value(text, "nex_panel_info", 'database="sqlite"'), 1);
  assert.equal(value(text, "nex_hosts"), 4);
  assert.equal(value(text, "nex_hosts_online"), 2);
  assert.equal(value(text, "nex_host_online", 'host_id="1"', 'host="HK \\"入口\\" 01"'), 1);
  assert.equal(value(text, "nex_host_online", 'host_id="2"'), 0);
  const age = value(text, "nex_host_heartbeat_age_seconds", 'host_id="1"')!;
  assert.ok(age >= 5 && age < 60, `心跳 ${age} 秒前`);
  assert.equal(value(text, "nex_host_heartbeat_age_seconds", 'host_id="3"'), null, "从没心跳过的没有这条序列");
  assert.equal(value(text, "nex_host_cpu_usage_ratio", 'host_id="1"'), 0.37);
  assert.equal(value(text, "nex_host_memory_usage_ratio", 'host_id="1"'), 0.62);
  assert.equal(value(text, "nex_host_disk_usage_ratio", 'host_id="1"'), 0.81);
  assert.equal(value(text, "nex_host_load_ratio", 'host_id="1"'), 0.45);
  assert.equal(value(text, "nex_host_connections", 'host_id="1"', 'protocol="tcp"'), 120);
  assert.equal(value(text, "nex_host_connections", 'host_id="1"', 'protocol="udp"'), 8);
  assert.equal(value(text, "nex_host_cpu_usage_ratio", 'host_id="2"'), null);
  assert.equal(value(text, "nex_host_connections", 'host_id="2"'), null);
  assert.equal(value(text, "nex_host_traffic_bytes_total", 'host_id="1"', 'direction="in"'), 111000);
  assert.equal(value(text, "nex_host_traffic_bytes_total", 'host_id="1"', 'direction="out"'), 222000);
  assert.equal(value(text, "nex_host_traffic_bytes_total", 'host_id="2"'), null);
  assert.equal(value(text, "nex_host_agent_info", 'host_id="2"', 'version="2.2.250"'), 1);
  assert.equal(value(text, "nex_host_agent_info", 'host_id="3"'), null);
});

test("取数：规则按列表的口径算（模板算一条，子规则、中继规则、待删除的不算）", () => {
  const text: string = probe().full;
  assert.equal(value(text, "nex_rules"), 4);
  assert.equal(value(text, "nex_rules_enabled"), 3);
  assert.equal(value(text, "nex_rules_running"), 3, "模板自己不跑，但有一条子规则在跑，算在跑");
  assert.equal(seriesOf(text, "nex_rule_enabled{"), 4);
  for (const name of ["子规则 A", "子规则 B", "中继", "删除中"]) assert.ok(!text.includes(`rule="${name}"`), name);
  assert.equal(value(text, "nex_rule_enabled", 'rule_id="102"'), 0);
  assert.equal(value(text, "nex_rule_running", 'rule_id="102"'), 0);
  assert.equal(value(text, "nex_rule_running", 'rule_id="104"', 'rule="端口转发模板"'), 1);
  // 规则名里的引号、反斜杠、换行
  assert.ok(text.includes('rule="游戏\\"加速\\"\\\\线\\n路",host="HK \\"入口\\" 01"'));
});

test("取数：规则的累计流量、连接数、此刻速率、最近一次探测", () => {
  const text: string = probe().full;
  assert.equal(value(text, "nex_rule_traffic_bytes_total", 'rule_id="101"', 'direction="in"'), 5000);
  assert.equal(value(text, "nex_rule_traffic_bytes_total", 'rule_id="101"', 'direction="out"'), 7000);
  assert.equal(value(text, "nex_rule_connections_total", 'rule_id="101"'), 42);
  // 模板的累计 = 两台成员机上子规则的和
  assert.equal(value(text, "nex_rule_traffic_bytes_total", 'rule_id="104"', 'direction="in"'), 1010);
  assert.equal(value(text, "nex_rule_traffic_bytes_total", 'rule_id="104"', 'direction="out"'), 2020);
  assert.equal(value(text, "nex_rule_traffic_bytes_total", 'rule_id="102"'), null, "没流量的规则没有累计序列");
  assert.equal(value(text, "nex_rule_rate_bytes_per_second", 'rule_id="101"', 'direction="in"'), 2000);
  assert.equal(value(text, "nex_rule_rate_bytes_per_second", 'rule_id="101"', 'direction="out"'), 1000);
  assert.equal(value(text, "nex_rule_rate_bytes_per_second", 'rule_id="104"', 'direction="in"'), 500, "模板的速率取子规则的");
  assert.equal(value(text, "nex_rule_rate_bytes_per_second", 'rule_id="102"'), null);
  assert.equal(value(text, "nex_rule_probe_latency_seconds", 'rule_id="101"'), 0.038, "取最近一次，不是更早的那次");
  assert.equal(value(text, "nex_rule_probe_timeout", 'rule_id="101"'), 0);
  assert.equal(value(text, "nex_rule_probe_timeout", 'rule_id="103"'), 1);
  assert.equal(value(text, "nex_rule_probe_latency_seconds", 'rule_id="103"'), null);
  assert.equal(value(text, "nex_rule_probe_timeout", 'rule_id="102"'), null, "三小时前的探测太旧，不导出");
});

test("取数：线路组每条路径的评分、延迟、丢包、抖动、可用率、在用、异常，和近 24 小时切换次数", () => {
  const text: string = probe().full;
  const main = ['rule_id="103"', 'path_key="main"', 'path="主线路"'];
  const backup = ['rule_id="103"', 'path_key="backup"', 'path="晚高峰\\"线路\\""'];
  assert.equal(value(text, "nex_route_path_score", ...main), 12);
  assert.equal(value(text, "nex_route_path_score", ...backup), 81);
  assert.equal(value(text, "nex_route_path_latency_seconds", ...main), 0.3);
  assert.equal(value(text, "nex_route_path_latency_seconds", ...backup), 0.092, "入口段 74 毫秒 + 中转段 18 毫秒");
  assert.equal(value(text, "nex_route_path_loss_ratio", ...main), 0.4);
  assert.equal(value(text, "nex_route_path_loss_ratio", ...backup), 0.005);
  assert.equal(value(text, "nex_route_path_jitter_seconds", ...backup), 0.011);
  assert.equal(value(text, "nex_route_path_availability_ratio", ...backup), 0.995);
  assert.equal(value(text, "nex_route_path_active", ...main), 0);
  assert.equal(value(text, "nex_route_path_active", ...backup), 1);
  assert.equal(value(text, "nex_route_path_down", ...main), 1);
  assert.equal(value(text, "nex_route_path_down", ...backup), 0);
  assert.equal(value(text, "nex_route_switches_24h", 'rule_id="103"'), 2, "只数 24 小时内的 switch");
  // 模板：评分读它在跑的那条子规则上报的；切换次数 = 模板上的 + 各子规则上的
  assert.equal(value(text, "nex_route_path_score", 'rule_id="104"', 'path_key="main"'), 95);
  assert.equal(value(text, "nex_route_path_active", 'rule_id="104"', 'path_key="main"'), 1);
  assert.equal(value(text, "nex_route_switches_24h", 'rule_id="104"'), 3);
  assert.equal(seriesOf(text, "nex_route_switches_24h{"), 2);
});

test("全站流量从 0 起算、只增不减：有用户重置流量（读数变小）时不往回掉，之后接着涨", () => {
  const out = probe();
  assert.equal(value(out.full, "nex_traffic_bytes_total", 'direction="in"'), 400);
  assert.equal(value(out.full, "nex_traffic_bytes_total", 'direction="out"'), 600);
  assert.equal(value(out.afterReset, "nex_traffic_bytes_total", 'direction="in"'), 400);
  assert.equal(value(out.afterReset, "nex_traffic_bytes_total", 'direction="out"'), 600);
  assert.equal(value(out.afterResetGrowth, "nex_traffic_bytes_total", 'direction="in"'), 500);
  assert.equal(value(out.afterResetGrowth, "nex_traffic_bytes_total", 'direction="out"'), 800);
});

test("查库次数不随规则数涨：50 条规则和 150 条规则是同样多的语句，没有哪一步是每条规则查一次", () => {
  const out = probe();
  assert.equal(value(out.big, "nex_rules"), 50);
  assert.equal(seriesOf(out.big, "nex_rule_enabled{"), 50);
  assert.equal(seriesOf(out.big, "nex_route_switches_24h{"), 8);
  assert.equal(value(out.bigger, "nex_rules"), 150);
  assert.equal(seriesOf(out.bigger, "nex_rule_enabled{"), 150);
  assert.equal(seriesOf(out.bigger, "nex_route_switches_24h{"), 18);
  assert.equal(out.costBigger, out.costBig, `50 条规则 ${out.costBig} 条语句，150 条规则 ${out.costBigger} 条语句\n${out.statementsBig.join("\n")}`);
  assert.ok(out.costBig <= 40, `一轮取数 ${out.costBig} 条语句，超出预期\n${out.statementsBig.join("\n")}`);
  assert.ok(out.costSmall <= out.costBig, `4 条规则 ${out.costSmall} 条语句，比 50 条规则的 ${out.costBig} 条还多`);
});

test("上限保护：规则多于上限时不逐条导出、也不整表读规则，汇总照旧；线路组没超上限就照常给", () => {
  const out = probe();
  assert.equal(seriesOf(out.capped, "nex_rule_"), 0);
  assert.equal(value(out.capped, "nex_rules"), 50);
  assert.equal(value(out.capped, "nex_rules_running"), 49);
  assert.equal(value(out.capped, "nex_metrics_detail", 'scope="rule"'), 0);
  assert.equal(value(out.capped, "nex_metrics_detail", 'scope="route"'), 1);
  assert.equal(seriesOf(out.capped, "nex_route_switches_24h{"), 8);
  assert.equal(value(out.capped, "nex_route_path_score", 'rule_id="104"', 'path_key="main"'), 95);
  assert.ok(value(out.capped, "nex_traffic_bytes_total", 'direction="in"') !== null);
  assert.equal(out.fullReadsAllRules, true, "逐条导出时确实整份读了规则列表（否则下面那条断言是空的）");
  assert.equal(out.cappedReadsAllRules, false);
  assert.ok(out.costCapped < out.costBig, `只给汇总时 ${out.costCapped} 条语句，逐条导出时 ${out.costBig} 条`);
});

test("上限保护：线路组规则也超过上限时线路明细一起收起；上限填 0 永远只给汇总", () => {
  const out = probe();
  for (const text of [out.cappedAll, out.zero]) {
    assert.equal(seriesOf(text, "nex_rule_"), 0);
    assert.equal(seriesOf(text, "nex_route_"), 0);
    assert.equal(value(text, "nex_metrics_detail", 'scope="route"'), 0);
    assert.equal(value(text, "nex_rules"), 50);
    assert.equal(value(text, "nex_hosts"), 4, "主机不受规则上限影响");
  }
});

test("数据库不可用：一条语句都不发，nex_database_up 为 0，全站流量保持上一次的数，设置沿用上次读到的", () => {
  const out = probe();
  assert.equal(out.costDown, 0);
  assert.equal(value(out.down, "nex_database_up"), 0);
  assert.equal(value(out.down, "nex_hosts"), null);
  assert.equal(value(out.down, "nex_rules"), null);
  assert.equal(seriesOf(out.down, "nex_host_"), 0);
  assert.ok(value(out.down, "nex_traffic_bytes_total", 'direction="in"')! >= 500);
  assert.equal(out.downConfigStillKnown, true);
});
