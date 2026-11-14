import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 线路组：一个入口 + 多条路径 + 一个调度策略。服务端这一半要做到的事：
 *
 *   · 路径里的中转由面板在中转机上**按需建中继规则**，入口 Agent 拿到的是「拨哪个地址」；
 *     从落地往回解析，解析不出来的整条路径标成不可用，不建半截。
 *   · 中继规则不进用户的列表、不算配额；路径删了、规则删了它们跟着走（pendingDelete）。
 *   · Agent 报的切换 / 预检没过落进 forward_rule_route_events，目标地址翻成路径的名字。
 *   · 中转机对它那一跳的探测连着失败，入口 Agent 的下一次心跳就拿到「这条路径断了」。
 *   · 只改钉子的一次保存不能把路径抹掉。
 *
 * 和别的主备测试一样，起一个真的 sqlite 和真的心跳 / 上报路由跑一遍。
 */

type Outcome = {
  firstSync: { created: number; updated: number; retired: number };
  relays: Array<{ id: number; hostId: number; sourcePort: number; targetIp: string; targetPort: number; routePathKey: string; routeHopIndex: number; isEnabled: number; pendingDelete: number }>;
  paths: Array<{ key: string; dial: { ip: string; port: number } | null; issue: string | null }>;
  failoverTargets: Array<{ targetIp: string; targetPort: number }>;
  listedRuleIds: number[];
  ruleCount: number;
  secondSync: { created: number; updated: number; retired: number };
  spec: any;
  events: Array<{ kind: string; fromLabel: string | null; toLabel: string | null; reason: string | null; score: number | null }>;
  agentTargets: number;
  hopDown: { down: boolean; reason: string } | null;
  specAfterHopDown: any;
  relaysAfterPathRemoved: Array<{ hostId: number; pendingDelete: number }>;
  normalized: any;
  pinOnly: any;
  groupTemplate: any;
  retired: number;
  eventsAfterDelete: number;
  spread: any;
  savedLines: any;
};

function run(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-route-groups-"));
  const databasePath = path.join(directory, "routes.db");
  const logDirectory = path.join(directory, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const script = String.raw`
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    // 1 入口；2、3 中转；4 是一台没有任何地址的机器 —— 经过它的路径必须标成不可用。
    for (const [id, name, ip, token] of [[1, "入口机", "203.0.113.1", "tok1"], [2, "东京中转", "203.0.113.2", "tok2"], [3, "新加坡中转", "203.0.113.3", "tok3"], [4, "没地址", "", "tok4"]]) {
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)',
        [id, name, ip, ip, "slave", token, Math.floor(Date.now() / 1000)],
      );
    }
    const paths = [
      { key: "main", name: "主线路", hops: [2], dest: null, weight: 60, probe: null, dial: null },
      { key: "sg", name: "新加坡", hops: [3], dest: { ip: "198.51.100.9", port: 443 }, weight: 40, probe: null, dial: null },
      { key: "bad", name: "坏路", hops: [4], dest: null, weight: 10, probe: null, dial: null },
    ];
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled",'
        + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSchedule", "failoverMinHoldSeconds", "failoverSeconds", "recoverSeconds", "autoFailback",'
        + ' "routeMode", "routePaths", "routeSwitchMode", "routeFailureThreshold", "routeScoreMargin", "routeScoreHoldSeconds", "routePrewarmSeconds", "telegramErrorNotifyEnabled")'
        + ' VALUES (1, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, 600, 10, 300, 1, ?, ?, ?, 3, 10, 180, 300, 0)',
      ["美国线路", "gost", "tcp", 20001, "198.51.100.7", 443, "fallback", "[]",
        JSON.stringify({ timezone: "Asia/Shanghai", windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }] }),
        "hybrid", JSON.stringify(paths), "smooth"],
    );

    const routeGroups = await import(url("server/routeGroups.ts"));
    const stats = await import(url("server/routeGroupStats.ts"));
    const db = await import(url("server/db.ts"));

    const firstSync = await routeGroups.syncRouteRelayRulesForRule(1, { reason: "test" });
    const readRelays = () => query(
      'SELECT id, "hostId", "sourcePort", "targetIp", "targetPort", "routePathKey", "routeHopIndex", "isEnabled", "pendingDelete" FROM forward_rules WHERE "routeParentRuleId" = 1 ORDER BY "routePathKey", "routeHopIndex"',
    );
    const relays = await readRelays();
    const ruleRow = (await query('SELECT "routePaths", "failoverTargets" FROM forward_rules WHERE id = 1'))[0];
    const storedPaths = JSON.parse(ruleRow.routePaths).map((path) => ({ key: path.key, dial: path.dial || null, issue: path.issue || null }));
    const listedRuleIds = (await db.getForwardRules(1)).map((rule) => Number(rule.id));
    const ruleCount = await db.getUserRuleCount(1);
    const secondSync = await routeGroups.syncRouteRelayRulesForRule(1, { reason: "test-again" });

    const express = (await import("express")).default;
    const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
    const reports = await import(url("server/agentReportRoutes.ts"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const authorization = String(req.headers.authorization || "");
      req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      next();
    });
    heartbeat.registerAgentHeartbeatRoute(app);
    reports.registerAgentReportRoutes(app);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = "http://127.0.0.1:" + server.address().port;
    const post = async (route, token, body) => {
      const response = await fetch(base + route, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (response.status !== 200) throw new Error(route + " 没通: " + response.status + " " + JSON.stringify(json));
      return json;
    };
    const specOf = (body) => {
      const actions = (body.desiredState && body.desiredState.actions) || [];
      const withFailover = actions.find((action) => action && action.failover && action.failover.enabled);
      if (withFailover) return withFailover.failover;
      // 只是运行时提示（中转断了、负载……）变了时期望状态不重发，规格跟着 runningRules 走（Agent 每次心跳都按它原地换上提示）。
      const running = (body.runningRules || []).find((rule) => Number(rule.ruleId) === 1 && rule.failover && rule.failover.enabled);
      return running ? running.failover : null;
    };
    const mainDial = storedPaths.find((path) => path.key === "main").dial;
    const sgDial = storedPaths.find((path) => path.key === "sg").dial;
    const endpoint = (dial) => dial ? dial.ip + ":" + dial.port : "";

    // 入口机的心跳：带着切换事件、预检没过、评分快照。
    const first = await post("/api/agent/heartbeat", "tok1", {
      agentVersion: "2.2.198", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true,
      failoverEvents: [
        { ruleId: 1, sourcePort: 20001, kind: "switch", fromTarget: endpoint(mainDial), toTarget: endpoint(sgDial), fromIndex: 0, toIndex: 1, reason: "schedule", score: 88, latencyMs: 46, occurredAt: Date.now() },
        { ruleId: 1, sourcePort: 20001, kind: "precheck_failed", fromTarget: endpoint(sgDial), toTarget: endpoint(mainDial), fromIndex: 1, toIndex: 0, reason: "precheck: loss 6%", occurredAt: Date.now() },
        // 老 Agent 的写法：没有下标，只有地址。
        { ruleId: 1, sourcePort: 20001, kind: "recovered", toTarget: endpoint(mainDial), reason: "health check", latencyMs: 40, occurredAt: Date.now() },
      ],
      failoverStats: [{
        ruleId: 1, sourcePort: 20001, strategy: "fallback", activeIndex: 1, activeSince: Date.now(), prewarmIndex: -1,
        targets: [
          { index: 0, target: endpoint(mainDial), healthy: true, score: 93, latencyMs: 38, lossPct: 0, jitterMs: 4, availabilityPct: 100, consecutiveFailures: 0, connections: 3, samples: 120, lastProbeAt: Date.now() },
          { index: 1, target: endpoint(sgDial), healthy: true, score: 81, latencyMs: 74, lossPct: 0.8, jitterMs: 11, availabilityPct: 99.2, consecutiveFailures: 0, connections: 0, samples: 120, lastProbeAt: Date.now() },
          { index: 2, target: "127.0.0.1:1", healthy: false, down: true, downReason: "path unresolved", score: -1, latencyMs: -1, lossPct: 100, jitterMs: 0, availabilityPct: 0, consecutiveFailures: 0, connections: 0, samples: 0, lastProbeAt: 0 },
        ],
      }],
    });
    const spec = specOf(first);
    const events = (await query('SELECT kind, "fromLabel", "toLabel", reason, score FROM forward_rule_route_events WHERE "ruleId" = 1 ORDER BY id'))
      .map((row) => ({ kind: row.kind, fromLabel: row.fromLabel ?? null, toLabel: row.toLabel ?? null, reason: row.reason ?? null, score: row.score ?? null }));
    const agentTargets = (stats.getRouteStatus(1).agent || { targets: [] }).targets.length;

    // 东京中转探它那一跳（到落地）连着三次不通 → 主线路这条路径断了。
    const mainRelay = relays.find((relay) => relay.routePathKey === "main");
    for (let round = 0; round < 3; round += 1) {
      await post("/api/agent/tcping", "tok2", {
        results: [{ ruleId: Number(mainRelay.id), sourcePort: Number(mainRelay.sourcePort), targetIp: "198.51.100.7", targetPort: 443, method: "tcping", latencyMs: 0, isTimeout: true, probeCount: 1, probeSuccesses: 0 }],
        force: true,
      });
    }
    const parsedPaths = (await import(url("shared/routeGroup.ts"))).parseRoutePaths(ruleRow.routePaths);
    const hopDown = stats.routeHopDownHints(1, parsedPaths).get("main") || null;
    const second = await post("/api/agent/heartbeat", "tok1", { agentVersion: "2.2.198", uptime: 1200, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true });
    const specAfterHopDown = specOf(second);

    // 备用那条路径删掉：新加坡上的中继规则收回。
    await exec('UPDATE forward_rules SET "routePaths" = ? WHERE id = 1', [JSON.stringify(paths.filter((path) => path.key !== "sg"))]);
    await routeGroups.syncRouteRelayRulesForRule(1, { reason: "test-remove" });
    const relaysAfterPathRemoved = (await readRelays()).map((relay) => ({ hostId: Number(relay.hostId), pendingDelete: Number(relay.pendingDelete) }));

    // 保存那一层：整份线路组 → 那几列；只改钉子 → 路径照旧。
    const crud = await import(url("server/routers/rules.crud.ts"));
    const normalized = crud.normalizeFailoverInput({
      failoverEnabled: true,
      routeGroup: {
        mode: "weighted",
        spread: "round_robin",
        paths: [
          { name: "A", hops: [2], weight: 70 },
          { name: "B", hops: [], dest: { ip: "198.51.100.9", port: 443 }, weight: 30 },
        ],
        switchMode: "force",
      },
    }, "tcp", { entryHostId: 1, targetIp: "198.51.100.7", targetPort: 443 });
    const currentRule = await db.getForwardRuleById(1);
    const pinOnly = crud.normalizeFailoverInput({
      failoverEnabled: true,
      failoverStrategy: "fallback",
      failoverTargets: [],
      failoverProbeTarget: null,
      failoverSchedule: JSON.parse(currentRule.failoverSchedule),
      failoverMinHoldSeconds: 600,
      failoverPinnedIndex: 1,
      failoverPinnedUntil: null,
      failoverPreferFastest: true,
      failoverSeconds: 10,
      recoverSeconds: 300,
      autoFailback: true,
    }, "tcp", { rule: currentRule, entryHostId: 1, targetIp: "198.51.100.7", targetPort: 443 });

    /*
      转发组模板上的规则：路径不带中转（allowHops: false），保存时照样要落成路径。
      少传 routeGroup 的那一版在这里会算出 routePaths = null，用户刚编辑的路径当场没了。
    */
    const groupTemplate = crud.normalizeFailoverInput({
      failoverEnabled: true,
      routeGroup: {
        mode: "failover",
        paths: [
          { name: "主线路", hops: [] },
          { name: "备用线路", hops: [], dest: { ip: "198.51.100.9", port: 443 } },
        ],
      },
    }, "tcp", { allowHops: false, targetIp: "198.51.100.7", targetPort: 443 });

    /*
      「几个落地怎么用」（2.3.501）：另一台入口上的规则，主线路三个落地选了按访客固定，备用经东京中转。
      下发的每条目标带上第几条线路、落地是哪一个、怎么分。
    */
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (5, ?, ?, ?, ?, ?, 1, 1, ?)',
      ["多落地入口", "203.0.113.5", "203.0.113.5", "slave", "tok5", Math.floor(Date.now() / 1000)],
    );
    const lineKit = await import(url("shared/routeLines.ts"));
    const groupKit = await import(url("shared/routeGroup.ts"));
    const spreadLines = lineKit.parseRouteLines(JSON.stringify([
      { key: "main", name: "主线路", layers: [], dests: [{ dest: null }, { dest: { ip: "198.51.100.21", port: 443 } }, { dest: { ip: "198.51.100.22", port: 443 } }], weight: 50, destSpread: "ip_hash" },
      { key: "bk", name: "备用 1", layers: [{ kind: "hosts", hostIds: [2], pick: "best" }], dests: [], weight: 50 },
    ]));
    const spreadPaths = lineKit.expandRouteLines(spreadLines, { entryHostId: 5, poolMembers: () => null, hostUsable: () => true, tunnel: () => null }).paths;
    await exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled",'
        + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSeconds", "recoverSeconds", "autoFailback",'
        + ' "routeMode", "routePaths", "routeLines", "routeSwitchMode", "telegramErrorNotifyEnabled")'
        + ' VALUES (900, 5, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, 10, 300, 1, ?, ?, ?, ?, 0)',
      ["多落地", "gost", "tcp", 20002, "198.51.100.20", 443, "fallback", "[]", "smart", groupKit.serializeRoutePaths(spreadPaths), lineKit.serializeRouteLines(spreadLines), "smooth"],
    );
    await routeGroups.syncRouteRelayRulesForRule(900, { reason: "test-spread" });
    const spreadBeat = (agentVersion) => post("/api/agent/heartbeat", "tok5", { agentVersion, uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true });
    const spread = specOf(await spreadBeat("2.2.251"));

    /*
      保存那一层（编辑框按线路提交）：线路上的探测地址、「几个落地怎么用」都要落到 routeLines 和展开的
      每条路径上 —— 以前线路的探测地址在这一步被丢掉（2.3.501 修）。
    */
    const expansion = await import(url("server/routeLineExpansion.ts"));
    const expandedInput = await expansion.expandRouteGroupInputLines({
      failoverEnabled: true,
      routeGroup: {
        mode: "smart",
        paths: [],
        lines: [
          { key: "main", name: "主线路", layers: [], dests: [{ dest: null }, { dest: { ip: "198.51.100.31", port: 443 } }], weight: 50, destSpread: "least_load", probe: { ip: "198.51.100.99", port: 8443 } },
          { key: "bk", name: "备用 1", layers: [{ kind: "hosts", hostIds: [2], pick: "best" }], dests: [], weight: 50 },
        ],
      },
    }, { id: 1, role: "admin" }, 1, null);
    const savedGroup = crud.normalizeFailoverInput(expandedInput, "tcp", { entryHostId: 1, targetIp: "198.51.100.7", targetPort: 443 });
    const savedLines = {
      lines: JSON.parse(savedGroup.routeLines).map((line) => [line.key, line.destSpread || null, line.probe || null]),
      paths: JSON.parse(savedGroup.routePaths).map((path) => [path.lineKey, path.destSpread || null, path.probe || null]),
    };

    const retiredResult = await routeGroups.retireRouteRelayRulesForRule(1, { reason: "test-delete" });
    const eventsAfterDelete = Number((await query('SELECT COUNT(*) AS n FROM forward_rule_route_events WHERE "ruleId" = 1'))[0].n);
    server.close();

    console.log("ROUTES " + JSON.stringify({
      firstSync: { created: firstSync.created, updated: firstSync.updated, retired: firstSync.retired },
      relays: relays.map((relay) => ({ ...relay, id: Number(relay.id), hostId: Number(relay.hostId), sourcePort: Number(relay.sourcePort), targetPort: Number(relay.targetPort), routeHopIndex: Number(relay.routeHopIndex), isEnabled: Number(relay.isEnabled), pendingDelete: Number(relay.pendingDelete) })),
      paths: storedPaths,
      failoverTargets: JSON.parse(ruleRow.failoverTargets),
      listedRuleIds,
      ruleCount,
      secondSync: { created: secondSync.created, updated: secondSync.updated, retired: secondSync.retired },
      spec,
      events,
      agentTargets,
      hopDown,
      specAfterHopDown,
      relaysAfterPathRemoved,
      normalized: { ...normalized, failoverPinnedUntil: normalized.failoverPinnedUntil ? String(normalized.failoverPinnedUntil) : null },
      pinOnly: { ...pinOnly, failoverPinnedUntil: pinOnly.failoverPinnedUntil ? String(pinOnly.failoverPinnedUntil) : null },
      groupTemplate: { routeMode: groupTemplate.routeMode, routePaths: groupTemplate.routePaths, failoverTargets: groupTemplate.failoverTargets },
      retired: retiredResult.retired,
      eventsAfterDelete,
      spread,
      savedLines,
    }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: logDirectory },
    timeout: 180000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("ROUTES "));
  assert.ok(line, `没拿到结果：\n${result.stdout}`);
  return JSON.parse(line.slice("ROUTES ".length)) as Outcome;
}

const outcome = run();

test("有中转的路径在中转机上生成中继规则，指向落地；入口拨的是中转的入口地址", () => {
  assert.deepEqual({ created: outcome.firstSync.created, retired: outcome.firstSync.retired }, { created: 2, retired: 0 });
  const main = outcome.relays.find((relay) => relay.routePathKey === "main");
  const sg = outcome.relays.find((relay) => relay.routePathKey === "sg");
  assert.ok(main && sg, `两条能解析的路径各该有一条中继规则：${JSON.stringify(outcome.relays)}`);
  assert.deepEqual(
    { hostId: main!.hostId, targetIp: main!.targetIp, targetPort: main!.targetPort, hop: main!.routeHopIndex, enabled: main!.isEnabled },
    { hostId: 2, targetIp: "198.51.100.7", targetPort: 443, hop: 0, enabled: 1 },
    "主线路的中继规则该在东京中转上，转到规则自己的落地",
  );
  assert.deepEqual({ hostId: sg!.hostId, targetIp: sg!.targetIp, targetPort: sg!.targetPort }, { hostId: 3, targetIp: "198.51.100.9", targetPort: 443 });
  const mainPath = outcome.paths.find((path) => path.key === "main")!;
  assert.deepEqual(mainPath.dial, { ip: "203.0.113.2", port: main!.sourcePort }, "入口拨的该是中转的入口地址 + 中继规则的端口");
  assert.equal(mainPath.issue, null);
});

test("解析不出来的路径整条标成不可用，不建半截；派生的备用清单只有能拨的", () => {
  const bad = outcome.paths.find((path) => path.key === "bad")!;
  assert.equal(bad.dial, null);
  assert.match(String(bad.issue), /没有入口地址/);
  assert.ok(!outcome.relays.some((relay) => relay.routePathKey === "bad"), "没地址的中转上不该建中继规则");
  assert.deepEqual(outcome.failoverTargets.map((target) => `${target.targetIp}:${target.targetPort}`), [outcome.paths.find((path) => path.key === "sg")!.dial!.ip + ":" + outcome.paths.find((path) => path.key === "sg")!.dial!.port]);
});

test("中继规则不进用户的列表、不算配额；重复同步不产生改动", () => {
  assert.deepEqual(outcome.listedRuleIds, [1], "列表里只该有线路组那条规则");
  assert.equal(outcome.ruleCount, 1);
  assert.deepEqual(outcome.secondSync, { created: 0, updated: 0, retired: 0 });
});

test("下发给入口 Agent：三条路径按下标对齐，解析不出来的标成不可用，策略参数齐全", () => {
  const spec = outcome.spec;
  assert.ok(spec, "心跳里没有主备规格");
  assert.equal(spec.targets.length, 3);
  assert.deepEqual({ ip: spec.targets[0].targetIp, port: spec.targets[0].targetPort, weight: spec.targets[0].weight }, { ip: "203.0.113.2", port: outcome.paths.find((path) => path.key === "main")!.dial!.port, weight: 60 });
  assert.equal(spec.targets[2].down, true, "解析不出来的路径要标成不可用，而不是从清单里消失");
  assert.match(String(spec.targets[2].downReason), /没有入口地址/);
  assert.deepEqual(
    { strategy: spec.strategy, threshold: spec.failureThreshold, margin: spec.scoreMargin, hold: spec.scoreHoldSeconds, prewarm: spec.prewarmSeconds, mode: spec.switchMode, preferFastest: spec.preferFastest, minHold: spec.minHoldSeconds },
    { strategy: "fallback", threshold: 3, margin: 10, hold: 180, prewarm: 300, mode: "smooth", preferFastest: true, minHold: 600 },
  );
  assert.equal(spec.schedule?.windows?.length, 1, "混合策略的时段表要下发");
});

test("Agent 报的切换、预检没过、恢复都落进切换记录，地址翻成路径的名字", () => {
  assert.deepEqual(outcome.events, [
    { kind: "switch", fromLabel: "主线路", toLabel: "新加坡", reason: "schedule", score: 88 },
    { kind: "precheck_failed", fromLabel: "新加坡", toLabel: "主线路", reason: "precheck: loss 6%", score: null },
    { kind: "recovered", fromLabel: null, toLabel: "主线路", reason: "health check", score: null },
  ]);
  assert.equal(outcome.agentTargets, 3, "评分快照该收下三条路径");
});

test("中转跳连着探不通，入口 Agent 下一次心跳就拿到「这条路径断了」", () => {
  assert.ok(outcome.hopDown?.down, "三次超时之后主线路该标成断了");
  assert.match(outcome.hopDown!.reason, /^relay down: 东京中转 → 落地/);
  const main = outcome.specAfterHopDown.targets[0];
  assert.equal(main.down, true);
  assert.match(String(main.downReason), /^relay down: 东京中转/);
});

test("路径删了、规则删了，中继规则跟着走；切换记录一并清掉", () => {
  assert.deepEqual(outcome.relaysAfterPathRemoved, [{ hostId: 2, pendingDelete: 0 }, { hostId: 3, pendingDelete: 1 }]);
  assert.equal(outcome.retired, 1, "删规则时剩下那条中继规则也要收回");
  assert.equal(outcome.eventsAfterDelete, 0);
});

test("整份线路组保存成那几列；只改钉子的一次保存路径照旧", () => {
  const normalized = outcome.normalized;
  assert.equal(normalized.routeMode, "weighted");
  assert.equal(normalized.failoverStrategy, "round_robin", "权重负载按它的分法下发，其余模式都是主备");
  assert.equal(normalized.routeSwitchMode, "force");
  const paths = JSON.parse(normalized.routePaths);
  assert.equal(paths.length, 2);
  assert.deepEqual(paths.map((path: any) => path.hops), [[2], []]);
  assert.match(paths[0].key, /^[a-z][a-z0-9-]*$/);
  assert.equal(normalized.failoverPinnedIndex, null, "权重负载不存钉子");

  const pinOnly = outcome.pinOnly;
  assert.equal(pinOnly.routeMode, "hybrid", "只改钉子不该换模式");
  assert.equal(JSON.parse(pinOnly.routePaths).length, 2, "只改钉子不该抹掉路径");
  assert.equal(pinOnly.failoverPinnedIndex, 1);
  assert.equal(pinOnly.routePrewarmSeconds, 300);
});

test("转发组模板上的线路组也保存成路径；routeGroup 不当成列写进库", () => {
  /*
    转发组那一支原来把 routeGroup 直接混在 data 里（Drizzle 会拿一个不存在的字段去更新），
    又没把它交给 normalizeFailoverInput —— 于是保存要么报错，要么照着老的 failover* 列
    重算，把刚编辑的路径抹成 null。两件事在这里各钉一条。
  */
  const template = outcome.groupTemplate;
  assert.equal(template.routeMode, "failover");
  assert.equal(JSON.parse(template.routePaths).length, 2, "转发组模板的路径不能被算成 null");
  assert.deepEqual(
    JSON.parse(template.routePaths).map((path: any) => path.hops),
    [[], []],
    "转发组模板不跑在机器上，路径不带中转",
  );

  /*
    库里的那一行不能拿整个 input 去更新：routeGroup 不是列，Drizzle 会拿一个不存在的字段
    去写。三条保存路径（直连、转发组模板的新建、转发组模板的编辑）都得先把它摘出来。
  */
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "routers/rules.crud.ts"), "utf8");
  assert.equal(
    /const data: any = \{\s*\.\.\.input,/.test(source),
    false,
    "转发组那一支又把整个 input 摊进库里了：routeGroup 只是传输字段，得先摘出来",
  );
  assert.equal(
    (source.match(/routeGroup: _routeGroupInput, \.\.\./g) || []).length,
    3,
    "三条保存路径都要把 routeGroup 从要写库的字段里摘出来",
  );
});

test("几个落地一起分（2.3.501）：主线路的每条目标带线路、落地、分法；备用不带", () => {
  const fields = (spec: any) => (spec?.targets || []).map((target: any) => [target.line ?? null, target.landing ?? null, target.spread ?? null]);
  assert.ok(outcome.spread, "入口 Agent 应当拿到这条规则的调度规格");
  assert.equal(outcome.spread.strategy, "fallback", "整链最优照旧是主备那一路，Agent 挑出线路再在里面分");
  assert.deepEqual(fields(outcome.spread), [
    [0, "target", "ip_hash"],
    [0, "198.51.100.21:443", "ip_hash"],
    [0, "198.51.100.22:443", "ip_hash"],
    [null, null, null],
  ]);
});

test("按线路保存：线路上的探测地址、「几个落地怎么用」落到 routeLines；并列两个落地时路径各探各的落地，不共用线路的探测地址", () => {
  const probe = { ip: "198.51.100.99", port: 8443 };
  assert.deepEqual(outcome.savedLines.lines, [["main", "least_load", probe], ["bk", null, null]]);
  // main 并列了两个落地：一个探测地址分不出是哪个挂了，展开的路径不带它（各按自己的落地探）
  assert.deepEqual(outcome.savedLines.paths, [["main", "least_load", null], ["main", "least_load", null], ["bk", null, null]]);
});
