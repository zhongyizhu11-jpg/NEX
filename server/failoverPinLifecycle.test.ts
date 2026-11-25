import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 人工钉住这一层，每一个出口都得把「没钉」当成没钉。
 *
 * 2.3.365 到 2.3.369，这一层有三处各自的读法（心跳下发、保存归一化、编辑框加载），
 * 三处都先 `Number()` 再判断，而 `Number(null)` 是 0、0 是主线路。编辑时的合并又一律
 * 写成 `input.x ?? rule.x`，把「传了 null（清空）」当成「没传（沿用）」。加起来：
 * 没钉过的规则下发成「钉在主线路、一直钉着」，钉住压过时段表和自动择优 —— 这两样
 * 在机器上从没生效过，面板上看不出任何异常。
 *
 * shared/failoverPin.test.ts 钉的是读法本身；这一组钉的是**每一个出口都用上了它**：
 * 心跳下发、新建、编辑，以及把旧数据清回来的那次一次性修正。只测读法的话，哪天
 * 又有一处自己 `Number()` 一下，读法的测试照样全绿。
 */

type Dispatched = { pinnedIndex?: number | null; pinnedUntil?: number };
type StoredPin = { index: number | null; until: number | null };
type Saved = StoredPin & {
  schedule: string | null;
  probe: string | null;
  strategy: string;
  enabled: boolean;
  targets: number;
  error: string | null;
};

type Outcome = {
  now: number;
  dispatched: Record<string, Dispatched>;
  updated: Record<string, Saved>;
  pushes: Record<string, { reset: boolean | null; hotUpdated: boolean | null; error: string | null }>;
  created: StoredPin & { error: string | null };
  backfill: { first: number; second: number; rules: Record<string, StoredPin> };
};

function runLifecycle(): Outcome {
  const result = runInDatabase(String.raw`
    const http = (await import("node:http")).default;

    const now = Math.floor(Date.now() / 1000);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (1, ?, ?, ?, ?, ?, 1, 1, ?)',
      ["入口机", "203.0.113.1", "203.0.113.1", "slave", "tok1", now],
    );

    // 每条都是 gost + TCP + 两条备用线路，一共三条线：序号 0 主线路，1、2 备用。
    const backups = JSON.stringify([
      { targetIp: "198.51.100.8", targetPort: 443 },
      { targetIp: "198.51.100.9", targetPort: 443 },
    ]);
    const schedule = JSON.stringify({ timezone: "Asia/Shanghai", windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }] });
    const rule = (id, pinnedIndex, pinnedUntil, extra = {}) => exec(
      'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning",'
        + ' "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSchedule", "failoverProbeTarget",'
        + ' "failoverPinnedIndex", "failoverPinnedUntil", "failoverSeconds", "recoverSeconds", "autoFailback")'
        + ' VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1, 1, ?, 1, ?, ?, ?, ?, ?, ?, 60, 120, 1)',
      [id, "规则 " + id, "gost", "tcp", 20000 + id, "198.51.100.7", 443, extra.running ? 1 : 0, extra.strategy || "fallback", backups,
        extra.schedule === undefined ? schedule : extra.schedule, extra.probe ?? null, pinnedIndex, pinnedUntil],
    );

    // —— 下发 ——
    await rule(1, null, null);            // 从没钉过，带着时段表：这就是被读成「钉在主线路」的那一条
    await rule(2, 0, null);               // 真的钉在主线路、一直钉着
    await rule(3, 1, now - 60);           // 钉过，早就过期
    await rule(4, 1, now + 3600);         // 钉着，一小时后交回
    await rule(5, 5, null);               // 指向不存在的出站

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
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok1" },
      body: JSON.stringify({ agentVersion: "2.3.362", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1 }),
    });
    const body = await response.json();
    server.close();
    if (response.status !== 200) throw new Error("心跳没通: " + response.status);
    const dispatched = {};
    for (const action of (body.desiredState && body.desiredState.actions) || []) {
      if (!action || !action.failover || !action.failover.enabled) continue;
      dispatched[action.ruleId] = { pinnedIndex: action.failover.pinnedIndex, pinnedUntil: action.failover.pinnedUntil };
    }

    // —— 编辑 ——
    const { rulesRouter } = await import(url("server/routers/rules.ts"));
    const caller = rulesRouter.createCaller({
      req: { headers: {} },
      res: { clearCookie() {} },
      user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
      authSession: null,
      authFailureReason: null,
    });
    const stored = async (id) => {
      const row = (await query(
        'SELECT "failoverPinnedIndex" AS pinIndex, "failoverPinnedUntil" AS pinUntil, "failoverSchedule" AS schedule,'
          + ' "failoverProbeTarget" AS probe, "failoverStrategy" AS strategy, "failoverEnabled" AS enabled,'
          + ' "failoverTargets" AS targets FROM forward_rules WHERE id = ?',
        [id],
      ))[0];
      return {
        index: row.pinIndex === null ? null : Number(row.pinIndex),
        until: row.pinUntil === null ? null : Number(row.pinUntil),
        schedule: row.schedule ?? null,
        probe: row.probe ?? null,
        strategy: row.strategy,
        enabled: Number(row.enabled) === 1,
        targets: JSON.parse(row.targets || "[]").length,
      };
    };
    // 编辑框每次保存都带着整份主备配置，照它的样子传。
    const form = (overrides) => ({
      failoverEnabled: true,
      failoverStrategy: "fallback",
      failoverTargets: [{ targetIp: "198.51.100.8", targetPort: 443 }, { targetIp: "198.51.100.9", targetPort: 443 }],
      failoverProbeTarget: "198.51.100.7:9443",
      failoverSchedule: JSON.parse(schedule),
      failoverMinHoldSeconds: 0,
      failoverPinnedIndex: null,
      failoverPinnedUntil: null,
      failoverPreferFastest: false,
      failoverSeconds: 60,
      recoverSeconds: 120,
      autoFailback: true,
      ...overrides,
    });
    // 每一步各记各的错：一步抛了不能把后面的检查一起吞掉，否则一处坏掉就看不出别处好没好。
    const save = async (id, input) => {
      try {
        await caller.update({ id, ...input });
        return { ...(await stored(id)), error: null };
      } catch (error) {
        return { ...(await stored(id)), error: String(error?.message || error) };
      }
    };
    const updated = {};

    await rule(11, 2, now + 3600, { probe: "198.51.100.7:9443" });
    updated.forever = await save(11, form({ failoverPinnedIndex: 2, failoverPinnedUntil: null }));
    updated.cleared = await save(11, form({ failoverPinnedIndex: null, failoverSchedule: null, failoverProbeTarget: null }));

    await rule(12, 1, now - 60);
    updated.expiredUntouched = await save(12, { failoverSeconds: 90 });

    await rule(13, null, null, { probe: "198.51.100.7:9443" });
    updated.pinOnly = await save(13, { failoverPinnedIndex: 2, failoverPinnedUntil: now + 7200 });

    await rule(14, null, null, { schedule: null });
    updated.roundRobin = await save(14, form({ failoverStrategy: "round_robin", failoverSchedule: null, failoverPinnedIndex: 1 }));

    // —— 推给 Agent ——
    // 连着事件流的 Agent 五分钟才整轮对账一次，配置变更靠保存时那一推。update 的返回值
    // 说了推没推、怎么推：hotUpdated 是原地热更新并推送，reset 是停掉重来。
    const pushed = async (input) => {
      try {
        const result = await caller.update({ id: 15, ...input });
        return { reset: result.reset, hotUpdated: result.hotUpdated, error: null };
      } catch (error) {
        return { reset: null, hotUpdated: null, error: String(error?.message || error) };
      }
    };
    const pushes = {};
    await rule(15, null, null, { running: true });
    await pushed(form({}));
    // 先按编辑框的样子存一遍，库里就是归一化之后的样子；再当成 Agent 已经照做了。
    await exec('UPDATE forward_rules SET "isRunning" = 1 WHERE id = 15');
    pushes.unchanged = await pushed(form({}));
    pushes.pinned = await pushed(form({ failoverPinnedIndex: 1, failoverPinnedUntil: now + 3600 }));
    pushes.samePin = await pushed(form({ failoverPinnedIndex: 1, failoverPinnedUntil: now + 3600 }));

    // —— 新建 ——
    let created = { index: null, until: null, error: "没建出来" };
    try {
      const row = await caller.create({
        hostId: 1,
        name: "新建的主备",
        forwardType: "gost",
        protocol: "tcp",
        sourcePort: 20100,
        targetIp: "198.51.100.7",
        targetPort: 443,
        ...form({ failoverProbeTarget: null, failoverSchedule: null }),
      });
      const { index, until } = await stored(Number(row.id));
      created = { index, until, error: null };
    } catch (error) {
      created = { index: null, until: null, error: String(error?.message || error) };
    }

    // —— 一次性修正 ——
    await rule(21, 0, null);              // 被 bug 存成的样子（也可能是真有人这么选的 —— 分不出来）
    await rule(22, 0, now + 3600);        // 带期限：一定是人选的
    await rule(23, 1, null);              // 钉在备用上：一定是人选的
    await rule(24, null, null);
    const database = await import(url("server/db.ts"));
    const first = await database.clearFailoverPinZeroArtifactsOnce();
    await rule(25, 0, null);              // 修正做过之后才钉的：是升级之后有人亲手选的
    const second = await database.clearFailoverPinZeroArtifactsOnce();
    const backfillRules = {};
    for (const id of [2, 21, 22, 23, 24, 25]) {
      const { index, until } = await stored(id);
      backfillRules[id] = { index, until };
    }

    console.log("OUTCOME " + JSON.stringify({
      now,
      dispatched,
      updated,
      pushes,
      created,
      backfill: { first, second, rules: backfillRules },
    }));
  `, { name: "failover-pin", timeoutMs: 180000 });
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

const outcome = runLifecycle();

test("没钉过的规则，下发给 Agent 的是「交回自动」，不是「钉在主线路」", () => {
  const spec = outcome.dispatched[1];
  assert.ok(spec, "这条主备规则没有下发 —— 测试前提没成立");
  assert.equal(
    spec.pinnedIndex ?? null,
    null,
    `拿到 pinnedIndex=${spec.pinnedIndex}：Agent 会把它当成人工钉住，这条规则的时段表永远不会生效`,
  );
});

test("真钉在主线路的照样下发 —— 修的是「null 当 0」，不是「0 不能用」", () => {
  // 反向对照：要是修成「0 一律不下发」，上面那条也会绿，而真钉住的主线路会被静默丢掉。
  assert.equal(outcome.dispatched[2]?.pinnedIndex, 0);
  assert.equal(outcome.dispatched[2]?.pinnedUntil, 0, "没期限在 Agent 协议里写 0，意思是一直钉着");
});

test("过期的、越界的钉子都不下发；没过期的带着毫秒期限下发", () => {
  assert.equal(outcome.dispatched[3]?.pinnedIndex ?? null, null, "过期的钉子被下发了");
  assert.equal(outcome.dispatched[5]?.pinnedIndex ?? null, null, "指向不存在出站的钉子被下发了");
  assert.equal(outcome.dispatched[4]?.pinnedIndex, 1);
  assert.equal(outcome.dispatched[4]?.pinnedUntil, (outcome.now + 3600) * 1000, "Agent 那边的期限是毫秒");
});

test("编辑框把期限改成「一直钉着」，保存后真的是一直钉着", () => {
  // 上一版 `input.failoverPinnedUntil ?? 库里的期限`：null 被当成没传，原来的期限原样留着。
  assert.equal(outcome.updated.forever.error, null);
  assert.deepEqual({ index: outcome.updated.forever.index, until: outcome.updated.forever.until }, { index: 2, until: null });
});

test("编辑框改回「自动」、删光时段表、清空探测目标，保存后三样都清掉", () => {
  const cleared = outcome.updated.cleared;
  assert.equal(cleared.error, null);
  assert.equal(cleared.index, null, "钉子还在 —— 它压过时段表和自动择优，解不开等于这两样永远不生效");
  assert.equal(cleared.until, null);
  assert.equal(cleared.schedule, null, "时段表删不掉");
  assert.equal(cleared.probe, null, "主线路的探测目标清不掉");
});

test("早就过期的钉子，改一下别的主备设置不会复活成永久的", () => {
  // 上一版把已经过去的期限当成「没填期限」：改个切换时间，一个早就交回的钉子就变成一直钉着。
  assert.equal(outcome.updated.expiredUntouched.error, null);
  assert.equal(outcome.updated.expiredUntouched.index, null);
  assert.equal(outcome.updated.expiredUntouched.until, null);
});

test("只改钉子的一次保存也走归一化：期限按秒传进来，存进去的是那个时刻", () => {
  /*
    上一版只看策略、出站、切换时间这几个字段决定要不要归一化。只改钉子时不归一化，
    按秒传进来的期限原样落进时间列 —— 保存直接报错（value.getTime is not a function）。
    「交回自动 / 强制走」这种一键操作走的就是这条路。
  */
  assert.equal(outcome.updated.pinOnly.error, null, "只改钉子的保存报错了");
  assert.equal(outcome.updated.pinOnly.index, 2);
  assert.equal(outcome.updated.pinOnly.until, outcome.now + 7200);
  // 整份重新归一化时，没传的那些照库里的来：主备还开着，两条备用、时段表、探测目标都还在。
  // 「强制走」点一下把整套主备配置冲掉的话，比不能强制走糟得多。
  assert.equal(outcome.updated.pinOnly.enabled, true, "只改钉子，主备被关掉了");
  assert.equal(outcome.updated.pinOnly.targets, 2, "只改钉子，备用线路没了");
  assert.notEqual(outcome.updated.pinOnly.schedule, null, "只改钉子，时段表没了");
  assert.equal(outcome.updated.pinOnly.probe, "198.51.100.7:9443", "只改钉子，探测目标没了");
});

test("轮询不存钉子：Agent 不看它，存着只会让面板写着「强制走」而机器上什么都没发生", () => {
  assert.equal(outcome.updated.roundRobin.error, null);
  assert.equal(outcome.updated.roundRobin.strategy, "round_robin", "测试前提：策略确实换成了轮询");
  assert.equal(outcome.updated.roundRobin.index, null);
});

test("只改钉子也要当场推给 Agent，而且是热更新，不重启转发", () => {
  /*
    上一版这张单子里没有钉子、期限、时段表、探测目标、最短驻留、自动择优：只改它们的
    一次保存不推。Agent 连着事件流时整轮对账五分钟一次 —— 应急时点下「强制走」，
    最长五分钟后机器才照做。
  */
  assert.equal(outcome.pushes.pinned.error, null);
  assert.equal(outcome.pushes.pinned.hotUpdated, true, "只改了钉子，没有推给 Agent");
  assert.equal(outcome.pushes.pinned.reset, false, "只改了钉子，不该停掉转发重来");
});

test("原样再存一遍不算改动 —— 期限按时刻比，不按对象比", () => {
  // 反过来也得钉住：要是原样保存也算改动，每点一次保存就推一次；期限是 Date，
  // 用 !== 比的话两个一样的时刻也永远「不一样」。
  assert.deepEqual(outcome.pushes.unchanged, { reset: false, hotUpdated: false, error: null });
  assert.deepEqual(outcome.pushes.samePin, { reset: false, hotUpdated: false, error: null });
});

test("新建时选「自动」，存进去的就是没钉", () => {
  assert.equal(outcome.created.error, null, "测试前提：规则建出来了");
  assert.equal(outcome.created.index, null, "新建的主备规则被存成了钉在主线路");
  assert.equal(outcome.created.until, null);
});

test("一次性修正：只清「钉在主线路、没期限」这一种，只清一次", () => {
  const { first, second, rules } = outcome.backfill;
  /*
    2 号是上面「真钉在主线路」的那条，21 号是 bug 存成的样子 —— 库里一模一样，修正
    分不出来，两条都清。这是有意的取舍：没有时段表、没开自动择优的规则，「钉在主线路、
    一直钉着」和「自动」在 Agent 上走的路完全一样；有这两样的规则，清掉才是面板上
    写着的那个行为。
  */
  assert.equal(first, 2, "只有 2 号和 21 号是那个形状");
  assert.deepEqual(rules[2], { index: null, until: null });
  assert.deepEqual(rules[21], { index: null, until: null });
  assert.deepEqual(rules[22], { index: 0, until: outcome.now + 3600 }, "带期限的一定是人选的，不能动");
  assert.deepEqual(rules[23], { index: 1, until: null }, "钉在备用上的一定是人选的，不能动");
  assert.deepEqual(rules[24], { index: null, until: null });
  assert.equal(second, 0);
  assert.deepEqual(rules[25], { index: 0, until: null }, "修正做过之后亲手钉的主线路，不能被第二次启动清掉");
});
