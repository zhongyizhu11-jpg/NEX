import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 端口转发（转发组模板）上的线路组：模板不跑，跑的是每台成员机上的子规则，Agent 只看子规则。
 *
 * 2.3.522 线上：线路详情里点「切到备用 1、2 小时」，界面写着「人工指定，到 17:45 强制走 备用 1」，
 * 机器照旧走主线路 —— 钉子存在模板上，子规则从来没抄过去（时段表、最短驻留、只走最快、探测目标也一样）。
 * 界面是照模板算的，所以看不出任何异常。
 *
 * 这一组走真实的路：rules.update 改模板（和线路详情、Telegram 是同一个入口）→ 组同步 → Agent 心跳，
 * 只测读法的话，哪天又有一处没抄，读法的测试照样全绿。
 */

type Spec = {
  pinnedIndex: number | null;
  pinnedUntil: number;
  minHoldSeconds: number;
  preferFastest: boolean;
  hasSchedule: boolean;
};
type ChildState = {
  pinIndex: number | null;
  pinUntil: number | null;
  running: boolean;
  minHold: number;
  preferFastest: boolean;
  schedule: string | null;
};
type Step = { error: string | null; child: ChildState; spec: Spec | null; reset: boolean | null };
type Outcome = {
  now: number;
  initial: { hops: ChildState; direct: ChildState; specHops: Spec | null };
  pinned: Step;
  pinnedSecondEntry: ChildState | null;
  pinnedMain: Step;
  unpinned: Step;
  scheduled: Step;
  structural: Step;
  paused: { error: string | null; templateKeys: string[]; childKeys: string[]; childPaused: boolean[]; running: boolean };
  events: {
    template: Array<{ kind: string; toLabel: string | null; reason: string | null }>;
    viaRouter: Array<{ kind: string; reason: string | null; entryHostName: string | null }>;
  };
};

function runScenario(): Outcome {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-route-policy-"));
  const databasePath = path.join(directory, "group-route-policy.db");
  const script = String.raw`
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const { AGENT_VERSION } = await import(url("shared/versions.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const q = (name) => '"' + name + '"';
    const insert = (table, columns, values) => exec(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const now = Math.floor(Date.now() / 1000);

    await insert("users", ["id", "username", "password", "role"], [1, "admin", "hash", "admin"]);
    const host = (id, name, ip, token) => insert(
      "hosts", ["id", "name", "ip", "ipv4", "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat"],
      [id, name, ip, ip, "slave", token, 1, 1, now],
    );
    await host(1, "入口机", "198.51.100.10", "tok1");
    await host(2, "中转 A", "198.51.100.20", "tok2");
    await host(3, "中转 B", "198.51.100.30", "tok3");
    await host(4, "入口机 2", "198.51.100.40", "tok4");
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "targetIp", "userId", "isEnabled"], [10, "端口组", "host", "port", "gost", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
    // 两台入口：同一条线路在两台成员机上各展开一条子规则，指定要两条都带上。
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 4, 1, 1]);

    // 300：和线上那条一样 —— gost、TCP+UDP、两条线路各带一台中转、整链最优、热备、最短驻留 60 秒。
    const hopPaths = JSON.stringify([
      { key: "a", name: "主线路", hops: [2], dest: { ip: "203.0.113.10", port: 45855 }, weight: 50, probe: null, dial: null, tier: 0, lineKey: "a" },
      { key: "b", name: "备用 1", hops: [3], dest: { ip: "203.0.113.10", port: 45855 }, weight: 50, probe: null, dial: null, tier: 1, lineKey: "b" },
    ]);
    await insert("forward_rules", [
      "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
      "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "failoverEnabled", "failoverStrategy",
      "routeMode", "routePaths", "routeDelivery", "failoverPreferFastest", "failoverMinHoldSeconds", "failoverSeconds", "recoverSeconds", "autoFailback",
    ], [300, 1, "带中转", "gost", "both", 10, 1, 17000, "203.0.113.10", 45855, 1, 1, 0, 1, "fallback", "smart", hopPaths, "hot", 1, 60, 3, 300, 1]);
    // 310：没有中转，两个落地直连（编辑框存出来的样子：照样有路径列）。
    const directPaths = JSON.stringify([
      { key: "m", name: "主线路", hops: [], dest: { ip: "203.0.113.20", port: 80 }, weight: 50, probe: null, dial: null, lineKey: "m" },
      { key: "n", name: "备用 1", hops: [], dest: { ip: "198.51.100.9", port: 80 }, weight: 50, probe: null, dial: null, lineKey: "n" },
    ]);
    await insert("forward_rules", [
      "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
      "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "failoverEnabled", "failoverStrategy", "failoverTargets",
      "routeMode", "routePaths", "failoverSeconds", "recoverSeconds", "autoFailback",
    ], [310, 1, "直连", "gost", "tcp", 10, 1, 17010, "203.0.113.20", 80, 1, 1, 0, 1, "fallback", JSON.stringify([{ targetIp: "198.51.100.9", targetPort: 80 }]), "failover", directPaths, 60, 120, 1]);

    const forwardGroups = await import(url("server/repositories/forwardGroupRepository.ts"));
    await forwardGroups.syncForwardGroupRules(10);
    // 当成 Agent 已经把子规则跑起来了（热更新只对跑着的生效）。
    await exec('UPDATE forward_rules SET "isRunning" = 1 WHERE "forwardGroupRuleId" IN (300, 310)');

    const childRow = async (templateId, hostId = 1) => (await runtime.queryRaw(
      'SELECT * FROM forward_rules WHERE "forwardGroupRuleId" = ? AND "hostId" = ? AND "isForwardGroupTemplate" = 0 AND "pendingDelete" = 0',
      [templateId, hostId],
    ))[0];
    const childState = async (templateId, hostId = 1) => {
      const row = await childRow(templateId, hostId);
      if (!row) return null;
      return {
        id: Number(row.id),
        pinIndex: row.failoverPinnedIndex === null ? null : Number(row.failoverPinnedIndex),
        pinUntil: row.failoverPinnedUntil === null ? null : Number(row.failoverPinnedUntil),
        running: Number(row.isRunning) === 1,
        minHold: Number(row.failoverMinHoldSeconds || 0),
        preferFastest: Number(row.failoverPreferFastest) === 1,
        schedule: row.failoverSchedule ?? null,
      };
    };

    // —— Agent 心跳：拿入口机这一份，按规则号找线路组规格 ——
    const express = (await import("express")).default;
    const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const authorization = String(req.headers.authorization || "");
      req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      next();
    });
    heartbeat.registerAgentHeartbeatRoute(app);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const specFor = async (ruleId) => {
      const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok1" },
        // forceReconcile：同一台 5 秒内的第二次心跳会被合并掉，测试里连着发好几次。
        body: JSON.stringify({ agentVersion: AGENT_VERSION, uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1, forceReconcile: true }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
      const lists = [body.desiredState && body.desiredState.actions, body.runningRules];
      for (const list of lists) {
        for (const item of list || []) {
          if (!item || Number(item.ruleId) !== Number(ruleId) || !item.failover || !item.failover.enabled) continue;
          const failover = item.failover;
          return {
            pinnedIndex: failover.pinnedIndex ?? null,
            pinnedUntil: Number(failover.pinnedUntil || 0),
            minHoldSeconds: Number(failover.minHoldSeconds || 0),
            preferFastest: !!failover.preferFastest,
            hasSchedule: !!failover.schedule,
          };
        }
      }
      return null;
    };

    const { rulesRouter } = await import(url("server/routers/rules.ts"));
    const caller = rulesRouter.createCaller({
      req: { headers: {} },
      res: { clearCookie() {} },
      user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
      authSession: null,
      authFailureReason: null,
    });
    // 每一步各记各的错：一步抛了不能把后面的检查一起吞掉。
    // 心跳里的这台「Agent」不报本机状态，面板会把规则当成要重下发（isRunning 记回 0）；每一步之前当成 Agent 又照做了。
    const markChildrenRunning = () => exec('UPDATE forward_rules SET "isRunning" = 1 WHERE "forwardGroupRuleId" IN (300, 310)');
    const step = async (templateId, input) => {
      await markChildrenRunning();
      let error = null;
      let reset = null;
      try {
        const result = await caller.update({ id: templateId, ...input });
        reset = result && typeof result.reset === "boolean" ? result.reset : null;
      } catch (caught) {
        error = String(caught?.message || caught);
      }
      const child = await childState(templateId);
      return { error, reset, child, spec: child ? await specFor(child.id) : null };
    };

    const initialHops = await childState(300);
    const initial = { hops: initialHops, direct: await childState(310), specHops: initialHops ? await specFor(initialHops.id) : null };

    // 线路详情「切到这条 · 2 小时」：传的就是这两个字段（client/src/pages/Rules.tsx pinMutation）。
    const pinned = await step(300, { failoverPinnedIndex: 1, failoverPinnedUntil: now + 7200 });
    const pinnedSecondEntry = await childState(300, 4);
    // 钉在主线路（第 0 条）也是钉住
    const pinnedMain = await step(310, { failoverPinnedIndex: 0, failoverPinnedUntil: null });
    // 交回自动
    const unpinned = await step(300, { failoverPinnedIndex: null, failoverPinnedUntil: null });
    // 按时段：模板换成按时段 + 时段表（编辑框存进来的就是这两列），组同步之后子规则跟着拿到时段表
    await exec('UPDATE forward_rules SET "routeMode" = ?, "failoverSchedule" = ?, "failoverPinnedIndex" = NULL WHERE id = 310', [
      "scheduled",
      JSON.stringify({ timezone: "Asia/Shanghai", windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "23:00", targetIndex: 1 }] }),
    ]);
    await markChildrenRunning();
    await forwardGroups.syncForwardGroupRules(10);
    const scheduledChild = await childState(310);
    const scheduled = { error: null, reset: null, child: scheduledChild, spec: scheduledChild ? await specFor(scheduledChild.id) : null };
    // 改了端口这种真要重下发的：子规则照旧标成没在跑
    const structural = await step(300, { targetPort: 45856 });

    // 暂停一条线路（运行中那一屏的暂停按钮）：记在模板上，组同步带到子规则。没带中转的模板以前到不了 ——
    // 子规则没有路径列，按老列推出来的路径叫 main / backup-1，和模板上的对不上。
    await markChildrenRunning();
    const { lineDiagnosticsRouter } = await import(url("server/routers/lineDiagnostics.ts"));
    const lineCaller = lineDiagnosticsRouter.createCaller({
      req: { headers: {} },
      res: { clearCookie() {} },
      user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
      authSession: null,
      authFailureReason: null,
    });
    const directTemplatePaths = JSON.parse((await runtime.queryRaw('SELECT "routePaths" FROM forward_rules WHERE id = 310'))[0].routePaths || "[]");
    let pauseError = null;
    const pausedKey = directTemplatePaths[1] ? (directTemplatePaths[1].lineKey || directTemplatePaths[1].key) : null;
    try {
      await lineCaller.linePause({ ruleId: 310, lineKey: pausedKey || "missing", paused: true });
    } catch (caught) {
      pauseError = String(caught?.message || caught);
    }
    const pausedChild = await childRow(310);
    const pausedChildPaths = JSON.parse(pausedChild?.routePaths || "[]");
    const paused = {
      error: pauseError,
      templateKeys: directTemplatePaths.map((item) => item.key),
      childKeys: pausedChildPaths.map((item) => item.key),
      childPaused: pausedChildPaths.map((item) => !!item.paused),
      running: Number(pausedChild?.isRunning) === 1,
    };

    const templateEvents = (await runtime.queryRaw(
      'SELECT kind, "toLabel", reason FROM forward_rule_route_events WHERE "ruleId" = ? ORDER BY id',
      [300],
    )).map((row) => ({ kind: row.kind, toLabel: row.toLabel ?? null, reason: row.reason ?? null }));
    // Agent 报的事件记在子规则上；线路详情的切换记录按模板问，也得看得到。
    const child300 = await childState(300);
    await insert("forward_rule_route_events", ["ruleId", "kind", "fromKey", "toKey", "fromLabel", "toLabel", "reason", "createdAt"],
      [child300.id, "switch", "a", "b", "主线路", "备用 1", "agent: pinned", now + 1]);
    const viaRouter = (await caller.routeEvents({ ruleId: 300, limit: 20 })).map((row) => ({ kind: row.kind, reason: row.reason, entryHostName: row.entryHostName ?? null }));

    server.close();
    console.log("OUTCOME " + JSON.stringify({ now, initial, pinned, pinnedSecondEntry, pinnedMain, unpinned, scheduled, structural, paused, events: { template: templateEvents, viaRouter } }));
    await runtime.closeDatabase();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: path.join(directory, "logs") },
    timeout: 180_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

const outcome = runScenario();

test("前提：两个模板都展开了子规则，带中转那条的规格下发到入口机", () => {
  assert.ok(outcome.initial.hops, "带中转的模板没有子规则");
  assert.ok(outcome.initial.direct, "直连的模板没有子规则");
  assert.ok(outcome.initial.specHops, "入口机心跳里没有子规则的线路组规格");
});

test("模板上的最短驻留、只走最快跟着到子规则，Agent 拿到的也是这两样", () => {
  assert.equal(outcome.initial.hops.minHold, 60, "模板设了最短驻留 60 秒，子规则还是 0：切过去马上又能被切走");
  assert.equal(outcome.initial.hops.preferFastest, true);
  assert.equal(outcome.initial.specHops?.minHoldSeconds, 60);
  assert.equal(outcome.initial.specHops?.preferFastest, true);
});

test("模板上「切到备用 1 · 2 小时」：子规则钉在备用 1，入口机拿到的规格也钉在备用 1", () => {
  const { pinned, now } = outcome;
  assert.equal(pinned.error, null);
  assert.equal(pinned.child.pinIndex, 1, "钉子没到子规则 —— 这就是线上「切过去了还走主线路」");
  assert.equal(pinned.child.pinUntil, now + 7200);
  assert.equal(pinned.spec?.pinnedIndex, 1, "Agent 拿到的规格没有钉子");
  assert.equal(pinned.spec?.pinnedUntil, (now + 7200) * 1000, "Agent 那边的期限是毫秒");
});

test("两台入口：两条子规则都钉上，哪台都不重启", () => {
  assert.ok(outcome.pinnedSecondEntry, "第二台入口没有展开子规则");
  assert.equal(outcome.pinnedSecondEntry?.pinIndex, 1, "第二台入口上的子规则没拿到钉子：从这台进来的连接照旧走主线路");
  assert.equal(outcome.pinnedSecondEntry?.pinUntil, outcome.now + 7200);
  assert.equal(outcome.pinnedSecondEntry?.running, true);
});

test("只改钉子不重启成员机上的转发：子规则还在跑，Agent 原地换规格", () => {
  assert.equal(outcome.pinned.child.running, true, "点了「切到这条」，成员机上的转发被整条停掉重来 —— 连着的人全断");
  assert.equal(outcome.unpinned.child.running, true);
});

test("钉在主线路（第 0 条）也照样带到子规则，不被当成「没钉」", () => {
  assert.equal(outcome.pinnedMain.error, null);
  assert.equal(outcome.pinnedMain.child.pinIndex, 0);
  assert.equal(outcome.pinnedMain.child.pinUntil, null, "没期限 = 一直钉着");
  assert.equal(outcome.pinnedMain.spec?.pinnedIndex, 0);
  assert.equal(outcome.pinnedMain.spec?.pinnedUntil, 0, "没期限在 Agent 协议里写 0");
});

test("交回自动：子规则的钉子清掉，Agent 拿到的是「交回自动」", () => {
  assert.equal(outcome.unpinned.error, null);
  assert.equal(outcome.unpinned.child.pinIndex, null);
  assert.equal(outcome.unpinned.child.pinUntil, null);
  assert.equal(outcome.unpinned.spec?.pinnedIndex ?? null, null);
});

test("模板上的时段表跟着到子规则（没带中转的那种也一样）", () => {
  assert.equal(outcome.scheduled.error, null);
  assert.notEqual(outcome.scheduled.child.schedule, null, "时段表没到子规则：模板写着 18:00 切备用，机器上从不切");
  assert.equal(outcome.scheduled.spec?.hasSchedule, true);
  assert.equal(outcome.scheduled.child.running, true, "只改时段表也不该重启转发");
});

test("真要重下发的改动（换目标端口）照旧把子规则标成没在跑", () => {
  // 反向对照：热更新不能把结构上的改动也吞掉，否则机器上永远是旧端口。
  assert.equal(outcome.structural.error, null);
  assert.equal(outcome.structural.child.running, false);
});

test("没带中转的模板：子规则也照抄路径（同一套 key），暂停一条线路带到机器上，不重启转发", () => {
  const { paused } = outcome;
  assert.equal(paused.error, null);
  assert.ok(paused.templateKeys.length >= 2, "测试前提：模板存成了线路组（有路径）");
  assert.deepEqual(paused.childKeys, paused.templateKeys, "子规则的路径和模板对不上：暂停、权重、质量历史都按 key 走");
  assert.deepEqual(paused.childPaused, [false, true], "暂停没带到子规则：界面写着暂停，机器照样往这条上发新连接");
  assert.equal(paused.running, true, "暂停一条线路不该重启转发");
});

test("模板上的「切到这条 / 交回自动」记进切换记录", () => {
  const kinds = outcome.events.template.map((event) => event.kind);
  assert.ok(kinds.includes("pinned"), `没有指定的记录：${JSON.stringify(outcome.events.template)}`);
  assert.ok(kinds.includes("unpinned"), `没有交回自动的记录：${JSON.stringify(outcome.events.template)}`);
});

test("线路详情按模板问切换记录，看得到 Agent 在子规则上报的切换", () => {
  const kinds = outcome.events.viaRouter.map((event) => event.kind);
  assert.ok(kinds.includes("switch"), `机器上的切换看不到：${JSON.stringify(outcome.events.viaRouter)}`);
  assert.ok(kinds.includes("pinned"), "面板上的指定也得在");
  // 两台入口：机器报的那条写上是哪台入口报的；面板上的指定不是哪台机器报的，不带
  assert.equal(outcome.events.viaRouter.find((event) => event.kind === "switch")?.entryHostName, "入口机");
  assert.equal(outcome.events.viaRouter.find((event) => event.kind === "pinned")?.entryHostName, null);
});
