import assert from "node:assert/strict";
import test from "node:test";

import { BALANCE_STATE_TONE, BALANCE_STATE_WORDS, balanceStateHealth, dedupeSwitchEvents, exitRowView, pinBypassText, switchEventView, type ExitRowContext, type ExitSummaryLike } from "./balanceState";

const base: ExitRowContext = { online: true, index: 1, strategy: "auto", live: true, pinHostId: 0, hostId: 3 };
const summary = (patch: Partial<ExitSummaryLike> = {}): ExitSummaryLike => ({
  rules: 2, down: 0, unstable: 0, activeRules: 2, medianMs: 12, minMs: 12, maxMs: 12, jitterMs: 3, lossPct: 0, ...patch,
});

test("八个状态词各有一个颜色，和状态点的健康度对得上", () => {
  assert.deepEqual(Object.values(BALANCE_STATE_WORDS), ["在用", "备用", "连不上", "不稳", "慢启动中", "已指定", "需要升级 Agent", "基础支持"]);
  assert.equal(BALANCE_STATE_TONE.down, "down");
  assert.equal(balanceStateHealth("active"), "healthy");
  assert.equal(balanceStateHealth("unstable"), "degraded");
  assert.equal(balanceStateHealth("standby"), "standby");
});

test("在用：到目标多快、抖多少、分到几成，数字都带单位", () => {
  const view = exitRowView(summary({ share: 0.34 }), base);
  assert.equal(view.state, "active");
  assert.equal(view.detail, "到目标 12 ms · 抖动 3 ms · 分到 34%");
  assert.equal(view.reason, null);
  assert.equal(exitRowView(summary({ minMs: 10, maxMs: 212 }), base).detail, "到目标 10–212 ms · 抖动 3 ms");
});

test("连不上：分清是出口机本身还是到目标，并说该查什么", () => {
  const exit = exitRowView(summary({ down: 2, activeRules: 0, reason: "exit" }), base);
  assert.equal(exit.state, "down");
  assert.equal(exit.reason, "入口连不上这台出口机，已切走");
  assert.match(exit.hint!, /防火墙/);
  const target = exitRowView(summary({ down: 2, activeRules: 0, reason: "target" }), base);
  assert.equal(target.state, "down");
  assert.equal(target.reason, "这台连不上目标，已切走");
  // 用户面板：hep ix 对「广港hkt/2」的高防目标连不上 30 分钟，另外两条规则照走它 —— 还是在用，写清是哪条
  const partly = exitRowView(summary({ rules: 3, down: 1, downRuleIds: [33], activeRules: 2, reason: "target" }), { ...base, ruleNames: { 33: "广港hkt/2" } });
  assert.equal(partly.state, "active");
  assert.equal(partly.reason, "广港hkt/2到目标连不上（已切走），别的规则照走");
  const unnamed = exitRowView(summary({ rules: 3, down: 1, activeRules: 2, reason: "target" }), base);
  assert.equal(unnamed.reason, "1 条规则到目标连不上（已切走），别的规则照走");
  // 别的规则也不走它了（备用）：连不上，括号里写是哪条
  const standbyDown = exitRowView(summary({ rules: 3, down: 1, downRuleIds: [33], activeRules: 0, reason: "target" }), { ...base, ruleNames: { 33: "广港hkt/2" } });
  assert.equal(standbyDown.state, "down");
  assert.equal(standbyDown.reason, "这台连不上目标（广港hkt/2），已切走");
  const offline = exitRowView(summary(), { ...base, online: false });
  assert.equal(offline.state, "down");
  assert.match(offline.reason!, /离线/);
});

test("不稳：丢包多说丢包，否则说抖动；备用和 UDP 不通都写原因", () => {
  assert.equal(exitRowView(summary({ unstable: 1, lossPct: 12 }), base).reason, "到目标丢包 12%，新连接少分给它");
  assert.equal(exitRowView(summary({ unstable: 1, jitterMs: 45 }), base).reason, "到目标抖动 45 ms，新连接少分给它");
  const udp = exitRowView(summary({ udpDown: 1 }), base);
  assert.equal(udp.state, "active");
  assert.match(udp.reason!, /UDP 新会话先不给它/);
  assert.match(exitRowView(summary({ peerOutdated: true, activeRules: 0 }), base).hint!, /升级/);
});

test("指定、升级、没数据：主备只有第一台在用，其余方式都分", () => {
  assert.equal(exitRowView(summary(), { ...base, pinHostId: 3 }).state, "pinned");
  // 指定能用时入口把别的出口都报成备用（activeRules 0）
  const other = exitRowView(summary({ activeRules: 0 }), { ...base, pinHostId: 2 });
  assert.equal(other.state, "standby");
  assert.equal(other.reason, "已指定走别的出口");
  assert.equal(exitRowView(summary(), { ...base, upgradeNeeded: true }).state, "upgrade");
  assert.equal(exitRowView(summary(), { ...base, index: 0, upgradeNeeded: true }).state, "active");
  assert.equal(exitRowView(null, { ...base, strategy: "fallback" }).state, "standby");
  assert.equal(exitRowView(null, { ...base, strategy: "fallback", index: 0 }).state, "active");
  assert.equal(exitRowView(null, base).state, "active");
});

test("刚恢复 1 分钟内是慢启动中（按访客固定、主备、关了慢慢加量的不算）", () => {
  const now = 1_000_000;
  const events = [{ at: now - 20_000, hostId: 3, from: "down", to: "active" }];
  assert.equal(exitRowView(summary(), { ...base, events, nowMs: now }).state, "warming");
  assert.equal(exitRowView(summary(), { ...base, events, nowMs: now + 60_000 }).state, "active");
  assert.equal(exitRowView(summary(), { ...base, events, nowMs: now, strategy: "ip_hash" }).state, "active");
  assert.equal(exitRowView(summary(), { ...base, events, nowMs: now, slowStart: false }).state, "active");
});

test("最近切换：几点、从什么到什么、为什么；同一次变化报两遍的只留一条", () => {
  const at = new Date(2026, 10, 19, 14, 34).getTime();
  const down = switchEventView({ at, hostId: 3, from: "active", to: "down", reason: "exit" }, at + 60_000);
  assert.deepEqual(down, { time: "14:34", from: "在用", to: "连不上", toState: "down", why: "入口连不上出口机" });
  assert.equal(switchEventView({ at, hostId: 3, from: "down", to: "active" }, at).why, "恢复了");
  assert.equal(switchEventView({ at, hostId: 3, from: "active", to: "down", reason: "target" }, at + 86_400_000 * 2).time, "11/19 14:34");
  const events = [
    { at, hostId: 3, from: "active", to: "down" },
    { at: at + 500, hostId: 3, from: "active", to: "down" },
    { at: at + 900, hostId: 2, from: "active", to: "down" },
  ];
  assert.deepEqual(dedupeSwitchEvents(events).map((event) => event.hostId), [2, 3]);
});

// GOST 入口分开报了两段（问题 A / B）：写清楚哪段多少；到目标那段不知道时直说。
test("GOST 入口报的两段：整链 = 到出口 + 到目标；到目标不知道时写「到目标延迟未知」", () => {
  assert.equal(exitRowView(summary({ exitMs: 3, targetMs: 9, jitterMs: 0 }), base).detail, "整链 12 ms（到出口 3 ms + 到目标 9 ms）");
  assert.equal(exitRowView(summary({ exitMs: 5, targetMs: null, targetLatencyUnknown: 2, jitterMs: 0 }), base).detail, "到出口 5 ms · 到目标延迟未知");
  assert.equal(exitRowView(summary({ exitMs: 3, minMs: 10, maxMs: 212, targetMs: 50, jitterMs: 0 }), base).detail, "整链 10–212 ms（到出口 3 ms）");
});

// 延迟口径：两段先用面板探的；面板没测到的那段是入口自己报的，写「Agent 自测」；FXP 太旧只报了到目标的写明。
test("弹窗每台出口：面板两段写成整链；入口报的那段标「Agent 自测」；FXP 太旧的写明没报到出口那段", () => {
  assert.equal(
    exitRowView(summary({ exitMs: 6, targetMs: 3, exitMsSource: "panel", targetMsSource: "panel", minMs: 10, maxMs: 30, jitterMs: 0 }), base).detail,
    "整链 9 ms（到出口 6 ms + 到目标 3 ms）",
  );
  assert.equal(
    exitRowView(summary({ exitMs: 12, targetMs: 3, exitMsSource: "agent", targetMsSource: "panel", jitterMs: 0 }), base).detail,
    "整链 15 ms（到出口 12 ms + 到目标 3 ms；到出口是 Agent 自测）",
  );
  assert.equal(
    exitRowView(summary({ exitMs: null, targetMs: null, exitMsSource: null, targetMsSource: null, jitterMs: 0 }), base).detail,
    "到目标 12 ms（出口机 FXP 太旧，没报到出口那段）",
  );
  assert.equal(
    exitRowView(summary({ exitMs: null, targetMs: 4, exitMsSource: null, targetMsSource: "panel", jitterMs: 0 }), base).detail,
    "到目标 4 ms（到出口那段还没测到）",
  );
});

test("指定的那台对某条规则连不上：那条照常走别的出口，弹窗要写出来，别写「其余备用」（用户面板 2026-11-26）", () => {
  const ruleNames = { 11: "广港hkt/2", 12: "广港Sg/2" };
  // 指定 jinx(39.9y)（hostId 3）：Sg/2 照走它，hkt/2 的高防目标从它连不上
  const pinnedSummary = summary({ rules: 2, activeRules: 1, down: 1, downRuleIds: [11], reason: "target" });
  const pinned = exitRowView(pinnedSummary, { ...base, pinHostId: 3, ruleNames });
  assert.equal(pinned.state, "pinned");
  assert.equal(pinned.reason, "广港hkt/2到目标不通，暂走别的出口");
  assert.match(pinned.hint!, /目标的网络/);
  assert.equal(pinBypassText(pinnedSummary, ruleNames), "广港hkt/2不通");
  // Jinx(29.9y)（hostId 4）替 hkt/2 在走：是在用，不是备用
  const carrying = exitRowView(summary({ rules: 2, activeRules: 1 }), { ...base, hostId: 4, pinHostId: 3 });
  assert.equal(carrying.state, "active");
  assert.equal(carrying.reason, "代指定出口走 1 条规则");
  // 面板估的（没有入口上报）不下这个结论
  assert.equal(exitRowView(summary({ activeRules: 1 }), { ...base, hostId: 4, pinHostId: 3, live: false }).state, "standby");
  // 指定的那台对所有规则都连不上：连不上，流量全按自动走
  const allDown = exitRowView(summary({ rules: 2, activeRules: 0, down: 2, downRuleIds: [11, 12], reason: "exit" }), { ...base, pinHostId: 3, ruleNames });
  assert.equal(allDown.state, "down");
  assert.equal(allDown.reason, "入口连不上这台，已暂走别的出口");
  // 都通：照旧「已指定」，没有原因
  assert.equal(exitRowView(summary({ activeRules: 2 }), { ...base, pinHostId: 3 }).reason, null);
  assert.equal(pinBypassText(summary(), ruleNames), null);
  assert.equal(pinBypassText(null), null);
});

test("指定的那台来回断、刚放回在观察：入口没让它扛，不是连不上（agent failover_exit_flap.go）", () => {
  const observing = summary({ rules: 1, activeRules: 0, down: 0 });
  const view = exitRowView(observing, { ...base, pinHostId: 3 });
  assert.equal(view.state, "pinned");
  assert.equal(view.reason, "来回断，先观察几分钟再走它");
  assert.equal(pinBypassText(observing), "刚恢复，在观察");
  // 面板估的数据不下这个结论
  assert.equal(pinBypassText(observing, undefined, false), null);
  assert.equal(exitRowView(observing, { ...base, pinHostId: 3, live: false }).reason, null);
});
