import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  describeRoutePolicy,
  describeRoutePolicyReport,
  formatPolicyDuration,
  type RoutePolicyRule,
} from "./routePolicy";

// 2026-09-22 是星期二。上海 20:00 在「工作日 18:00–01:00」里，上海 10:00 不在。
const IN_WINDOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const OUT_OF_WINDOW = Date.UTC(2026, 8, 22, 2, 0, 0);
const HOUR = 3_600_000;
const TZ = "Asia/Shanghai";
const current = { isOnline: true, agentVersion: "2.2.197" };
const eventOnly = { isOnline: true, agentVersion: "2.2.196" };

const schedule = { timezone: TZ, windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }] };
const rule = (patch: Partial<Record<keyof RoutePolicyRule, unknown>> = {}): RoutePolicyRule => ({
  failoverEnabled: true,
  failoverStrategy: "fallback",
  targetIp: "198.51.100.7",
  targetPort: 443,
  failoverTargets: JSON.stringify([{ targetIp: "198.51.100.8", targetPort: 443 }, { targetIp: "198.51.100.9", targetPort: 443 }]),
  failoverSeconds: 60,
  recoverSeconds: 120,
  autoFailback: true,
  ...patch,
});
const policyAt = (nowMs: number, patch: Parameters<typeof rule>[0] = {}, host: any = current) =>
  describeRoutePolicy(rule(patch), { host, nowMs, timeZone: TZ })!;
const states = (policy: ReturnType<typeof policyAt>) => policy.conditions.map((condition) => `${condition.kind}:${condition.state}`);

test("没开主备就没有策略", () => {
  assert.equal(describeRoutePolicy(rule({ failoverEnabled: false }), { host: current, nowMs: IN_WINDOW }), null);
});

test("什么都没配：出站顺序在决定，首选主线路", () => {
  const policy = policyAt(IN_WINDOW);
  assert.deepEqual(states(policy), ["order:deciding"]);
  assert.equal(policy.conditions[0].when, "按顺序");
  assert.equal(policy.conditions[0].then, "主线路 → 备用 1 → 备用 2");
  assert.equal(policy.preferredIndex, 0);
  assert.deepEqual(policy.lines.map((line) => line.preferred), [true, false, false]);
});

test("时段内，高亮的是时段表那一行；时段外，退回出站顺序", () => {
  const inside = policyAt(IN_WINDOW, { failoverSchedule: JSON.stringify(schedule) });
  assert.deepEqual(states(inside), ["schedule:deciding", "order:idle"]);
  assert.equal(inside.conditions[0].when, "工作日 18:00–01:00（次日）");
  assert.equal(inside.conditions[0].then, "首选 备用 1");
  assert.equal(inside.conditions[1].when, "其余时候");
  assert.equal(inside.preferredIndex, 1);

  const outside = policyAt(OUT_OF_WINDOW, { failoverSchedule: JSON.stringify(schedule) });
  assert.deepEqual(states(outside), ["schedule:idle", "order:deciding"]);
  assert.equal(outside.preferredIndex, 0);
});

test("钉着的时候，时段表命中了也不算数 —— 那一行标成「被压着」，不是「不适用」", () => {
  /*
    两种状态要分开：「不在时段内」是这一行本来就没轮到；「在时段内但被钉子压着」是
    钉子一到期它就会接手。后者正是用户最该知道的 —— 应急钉完忘了关，时段表就一直
    被压着。
  */
  const policy = policyAt(IN_WINDOW, {
    failoverSchedule: JSON.stringify(schedule),
    failoverPinnedIndex: 2,
    failoverPinnedUntil: new Date(IN_WINDOW + HOUR),
  });
  assert.deepEqual(states(policy), ["pin:deciding", "schedule:overridden", "order:idle"]);
  assert.equal(policy.conditions[0].when, "人工指定，到 21:00");
  assert.equal(policy.conditions[0].then, "强制走 备用 2");
  assert.equal(policy.preferredIndex, 2);
});

test("过期的钉子不出现在策略里", () => {
  const policy = policyAt(OUT_OF_WINDOW, { failoverPinnedIndex: 1, failoverPinnedUntil: new Date(OUT_OF_WINDOW - HOUR) });
  assert.equal(policy.pin, null);
  assert.deepEqual(states(policy), ["order:deciding"]);
});

test("自动择优在决定时，首选交给 Agent —— 面板不知道谁更快，不猜", () => {
  const outside = policyAt(OUT_OF_WINDOW, { failoverPreferFastest: true, failoverSchedule: JSON.stringify(schedule) });
  assert.deepEqual(states(outside), ["schedule:idle", "fastest:deciding", "order:idle"]);
  assert.equal(outside.preferredIndex, null);
  assert.deepEqual(outside.lines.map((line) => line.preferred), [false, false, false]);

  const inside = policyAt(IN_WINDOW, { failoverPreferFastest: true, failoverSchedule: JSON.stringify(schedule) });
  assert.deepEqual(states(inside), ["schedule:deciding", "fastest:overridden", "order:idle"], "时段表压过自动择优");
});

test("择优的门槛写的是 Agent 里那三个数", () => {
  // 文案里照抄了 Agent 的常数。Agent 那边改了、这里没跟上，界面就在说一套机器上不存在的规矩。
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../agent/main.go"), "utf8");
  const constant = (name: string) => Number(source.match(new RegExp(`const ${name} = ([\\d.]+)`))?.[1]);
  const then = policyAt(OUT_OF_WINDOW, { failoverPreferFastest: true }).conditions[0].then;
  assert.match(then, new RegExp(`快 ${constant("failoverFastestMarginMs")}ms`));
  assert.match(then, new RegExp(`快 ${Math.round(constant("failoverFastestMarginRatio") * 100)}%`));
  assert.match(then, new RegExp(`连续 ${constant("failoverFastestHoldSeconds") / 60} 分钟`));
});

test("Agent 早于 2.2.196：人工指定、时段表、自动择优它都不认，策略照实说只按顺序走", () => {
  const policy = policyAt(
    IN_WINDOW,
    { failoverSchedule: JSON.stringify(schedule), failoverPinnedIndex: 2, failoverPreferFastest: true },
    { isOnline: true, agentVersion: "2.2.195" },
  );
  assert.equal(policy.report.kind, "unsupported");
  assert.deepEqual(states(policy), ["pin:idle", "schedule:idle", "fastest:idle", "order:deciding"]);
  assert.equal(policy.preferredIndex, 0);
  assert.match(policy.warnings.join(""), /都不认/);
});

test("现在走哪条：新版 Agent 叫「现在」，2.2.196 只能叫「最近一次切换」", () => {
  const reported = { failoverActiveTarget: "198.51.100.8:443", failoverActiveAt: new Date(IN_WINDOW - 2 * HOUR) };
  const fresh = policyAt(IN_WINDOW, reported);
  assert.deepEqual(fresh.report, { kind: "current", index: 1, since: Math.floor((IN_WINDOW - 2 * HOUR) / 1000) });
  assert.equal(describeRoutePolicyReport(fresh, { nowMs: IN_WINDOW, timeZone: TZ }).text, "现在走 备用 1，18:00 起");
  assert.deepEqual(fresh.lines.map((line) => line.active), [false, true, false]);

  const old = policyAt(IN_WINDOW, reported, eventOnly);
  assert.equal(old.report.kind, "lastSwitch");
  const text = describeRoutePolicyReport(old, { nowMs: IN_WINDOW, timeZone: TZ });
  assert.equal(text.text, "最近一次切到 备用 1，18:00 起");
  assert.match(String(text.note), /回到主线路/, "得说清楚这份记录可能已经过时");
});

test("没有记录时不替它说「走主线路」", () => {
  /*
    2.2.196 的记录只来自切换事件，而这一版之前面板会在心跳早退时丢事件 —— 没有记录
    不等于没切过。新版 Agent 没报上来，是还没来得及报。
  */
  assert.equal(policyAt(IN_WINDOW, {}, eventOnly).report.kind, "noSwitch");
  assert.equal(policyAt(IN_WINDOW, {}, current).report.kind, "pending");
  for (const policy of [policyAt(IN_WINDOW, {}, eventOnly), policyAt(IN_WINDOW, {}, current)]) {
    assert.deepEqual(policy.lines.map((line) => line.active), [false, false, false]);
    assert.equal(describeRoutePolicyReport(policy).tone, "muted");
  }
});

test("机器离线就什么都不说；报上来的地址不在清单里就如实说认不出", () => {
  const reported = { failoverActiveTarget: "198.51.100.8:443", failoverActiveAt: new Date(IN_WINDOW) };
  assert.equal(policyAt(IN_WINDOW, reported, { isOnline: false, agentVersion: "2.2.197" }).report.kind, "offline");
  assert.equal(policyAt(IN_WINDOW, reported, null).report.kind, "offline");
  const unlisted = policyAt(IN_WINDOW, { failoverActiveTarget: "203.0.113.9:1" });
  assert.deepEqual(unlisted.report, { kind: "unlisted", target: "203.0.113.9:1" });
  assert.equal(describeRoutePolicyReport(unlisted).tone, "warn");
});

test("颜色看的是「走的是不是首选」，不是「是不是在备用上」", () => {
  const onBackup = { failoverActiveTarget: "198.51.100.8:443", failoverActiveAt: new Date(IN_WINDOW) };
  // 晚上按时段表走备用 1：排好的，不是出事。
  const planned = policyAt(IN_WINDOW, { ...onBackup, failoverSchedule: JSON.stringify(schedule) });
  assert.equal(describeRoutePolicyReport(planned).tone, "normal");
  assert.equal(planned.divergence, null);
  // 白天首选主线路，却在备用 1 上：值得看一眼。
  const unplanned = policyAt(OUT_OF_WINDOW, { ...onBackup, failoverSchedule: JSON.stringify(schedule) });
  assert.equal(describeRoutePolicyReport(unplanned).tone, "deviated");
  // 自动择优在决定时没有首选，走哪条都不算偏。
  assert.equal(describeRoutePolicyReport(policyAt(OUT_OF_WINDOW, { ...onBackup, failoverPreferFastest: true })).tone, "normal");
});

test("没走首选时只说确实可能的原因，不下结论", () => {
  const onBackup = { failoverActiveTarget: "198.51.100.8:443", failoverActiveAt: new Date(OUT_OF_WINDOW) };
  const auto = policyAt(OUT_OF_WINDOW, onBackup);
  assert.equal(auto.divergence, "首选是 主线路，没走它：它可能正挂着、刚恢复还在观察（2 分钟）。");
  const held = policyAt(OUT_OF_WINDOW, { ...onBackup, failoverMinHoldSeconds: 600 });
  assert.match(String(held.divergence), /最短驻留（10 分钟）/);
  const noFailback = policyAt(OUT_OF_WINDOW, { ...onBackup, autoFailback: false });
  assert.equal(noFailback.divergence, "首选是 主线路，但「恢复后切回」关着：备用 1 不出问题就不会换过去。");
});

test("切换条件：挂了就切、切不切回、最短驻留", () => {
  assert.deepEqual(policyAt(IN_WINDOW, { failoverMinHoldSeconds: 600 }).guards.map((guard) => `${guard.label}：${guard.value}`), [
    "挂了就切：探测连续失败 3 次才算异常，异常持续 60 秒就切走；新连接拨不通也算一次失败",
    "切回首选：首选那条恢复后稳定 2 分钟",
    "最短驻留：切过去之后至少走 10 分钟，线路挂了不受它限制",
    "旧连接：平滑切换：旧连接留在原线路，新连接走新线路，基本无感",
  ]);
  assert.deepEqual(policyAt(IN_WINDOW, { autoFailback: false }).guards.map((guard) => guard.label), ["挂了就切", "不切回", "旧连接"]);
  // 连续失败次数调成 1 就回到老说法：一次不通就开始计时。
  assert.match(policyAt(IN_WINDOW, { routeFailureThreshold: 1 }).guards[0].value, /^探测连续失败 60 秒，或新连接拨不通$/);
});

test("轮询、随机、哈希：只有一行分摊的规矩，没有首选，也不说现在走哪条", () => {
  const reported = { failoverActiveTarget: "198.51.100.8:443", failoverActiveAt: new Date(IN_WINDOW) };
  for (const [strategy, then] of [["round_robin", "轮流走这 3 条"], ["random", "从 3 条里随机挑一条"], ["ip_hash", "按来源 IP 固定分到其中一条"]]) {
    const policy = policyAt(IN_WINDOW, { ...reported, failoverStrategy: strategy, failoverPinnedIndex: 1 });
    assert.deepEqual(policy.conditions.map((condition) => `${condition.when}→${condition.then}`), [`每条新连接→${then}`]);
    assert.equal(policy.preferredIndex, null);
    assert.deepEqual(policy.lines.map((line) => `${line.preferred}/${line.active}`), ["false/false", "false/false", "false/false"]);
    assert.deepEqual(policy.guards.map((guard) => guard.label), ["挂了就切", "恢复后回来", "旧连接"], "切不切回、最短驻留只对主备有意义");
    assert.equal(describeRoutePolicyReport(policy).text, "每条新连接各走各的，共 3 条");
  }
});

test("时长的说法", () => {
  assert.equal(formatPolicyDuration(90), "90 秒");
  assert.equal(formatPolicyDuration(120), "2 分钟");
  assert.equal(formatPolicyDuration(5400), "90 分钟");
  assert.equal(formatPolicyDuration(7200), "2 小时");
  assert.equal(formatPolicyDuration(9000), "2.5 小时");
});

test("gost / realm / socat / nginx 都走线路组；只有内核转发照实说不会走", () => {
  assert.deepEqual(policyAt(IN_WINDOW).warnings, [], "gost + TCP（默认）没有提示");
  for (const forwardType of ["realm", "socat", "nginx"]) {
    assert.deepEqual(policyAt(IN_WINDOW, { forwardType, protocol: "tcp" }).warnings, [], `${forwardType} 前置也走线路组`);
  }
  for (const forwardType of ["iptables", "nftables"]) {
    assert.match(policyAt(IN_WINDOW, { forwardType }).warnings.join(""), /内核转发.*不会走线路组/);
  }
});

test("UDP、TCP+UDP：调度所在机器的 Agent 到 2.2.199 才调度，更老的全部走路径 A、不切换", () => {
  const ready = { isOnline: true, agentVersion: "2.2.199" };
  for (const protocol of ["udp", "both"]) {
    assert.match(
      policyAt(IN_WINDOW, { protocol }).warnings.join(""),
      /早于 2\.2\.199，还不会调度 UDP：升级之前这条规则全部走 主线路、不切换/,
    );
  }
  assert.deepEqual(policyAt(IN_WINDOW, { protocol: "both" }, ready).warnings, [], "TCP+UDP 用 TCP 探测，不用提醒 ping");
  assert.deepEqual(policyAt(IN_WINDOW, { protocol: "tcp" }).warnings, [], "TCP 不看这个版本");
});

test("NEX 隧道：隧道出口的 Agent 到 2.2.199 才调度，更老的全部走路径 A、不切换", () => {
  const ready = { isOnline: true, agentVersion: "2.2.199" };
  const fxp = { tunnelId: 7, tunnelMode: "forwardx" };
  for (const protocol of ["tcp", "udp", "both"]) {
    const warnings = policyAt(IN_WINDOW, { ...fxp, protocol }).warnings.join("");
    assert.match(warnings, /隧道出口的 Agent 早于 2\.2\.199，还不会调度 NEX 隧道：升级之前这条规则全部走 主线路、不切换/);
    assert.doesNotMatch(warnings, /还不会调度 UDP/, "说一句就够");
  }
  assert.deepEqual(policyAt(IN_WINDOW, { ...fxp, protocol: "tcp" }, ready).warnings, []);
  // 调度都没下发时不再说「按访客固定读不到访客」：上面那句已经说了全部走路径 A。
  const oldIpHash = policyAt(IN_WINDOW, { ...fxp, failoverStrategy: "ip_hash" }).warnings.join("");
  assert.doesNotMatch(oldIpHash, /读不到访客地址|所有访客会落在同一条路径上/);
  // 新 Agent：和 GOST 隧道一样，按访客分要打开「出口发送到目标」。
  assert.match(policyAt(IN_WINDOW, { ...fxp, failoverStrategy: "ip_hash" }, ready).warnings.join(""), /走隧道时调度器只看得到本机.*「出口发送到目标」/);
  assert.deepEqual(policyAt(IN_WINDOW, { ...fxp, failoverStrategy: "ip_hash", proxyProtocolExitSend: true }, ready).warnings, []);
  // 不知道隧道类型（没传 tunnelMode）时按 GOST 隧道说：TCP 不看版本。
  assert.deepEqual(policyAt(IN_WINDOW, { tunnelId: 7, protocol: "tcp" }).warnings, []);
});

test("纯 UDP 没有握手：没填探测地址的路径靠 ping，照实提醒；都填了就不提", () => {
  const ready = { isOnline: true, agentVersion: "2.2.199" };
  assert.match(policyAt(IN_WINDOW, { protocol: "udp" }, ready).warnings.join(""), /没填探测地址的路径靠 ping 拨号地址/);
  const probed = {
    protocol: "udp",
    failoverProbeTarget: "198.51.100.7:22",
    failoverTargets: JSON.stringify([
      { targetIp: "198.51.100.8", targetPort: 443, probeIp: "198.51.100.8", probePort: 22 },
      { targetIp: "198.51.100.9", targetPort: 443, probeIp: "198.51.100.9", probePort: 22 },
    ]),
  };
  assert.deepEqual(policyAt(IN_WINDOW, probed, ready).warnings, []);
});

test("纯 UDP 按会话说：没有「新连接拨不通」，旧连接叫旧会话，权重分的是新会话", () => {
  const ready = { isOnline: true, agentVersion: "2.2.199" };
  const udp = policyAt(IN_WINDOW, { protocol: "udp" }, ready);
  assert.equal(udp.perSession, true);
  const failover = udp.guards.find((guard) => guard.key === "failover")!;
  assert.doesNotMatch(failover.value, /拨不通/);
  assert.match(failover.value, /探测连续失败 3 次才算异常/);
  const oldSessions = udp.guards.find((guard) => guard.key === "switch")!;
  assert.equal(oldSessions.label, "旧会话");
  assert.match(oldSessions.value, /^平滑切换：已有的会话留在原路径，新会话走新路径，基本无感$/);
  const force = policyAt(IN_WINDOW, { protocol: "udp", routeSwitchMode: "force" }, ready).guards.find((guard) => guard.key === "switch")!;
  assert.match(force.value, /丢掉旧会话，下一个包改走新路径/);
  const weighted = policyAt(IN_WINDOW, { protocol: "udp", failoverStrategy: "round_robin" }, ready);
  assert.deepEqual(weighted.conditions.map((condition) => condition.when), ["每个新会话"]);
  assert.equal(describeRoutePolicyReport(weighted).text, "每个新会话各走各的，共 3 条");
  // UDP 读不到访客地址，「按访客固定」在这里是按会话固定，不能写成按来源 IP。
  const pinned = policyAt(IN_WINDOW, { protocol: "udp", failoverStrategy: "ip_hash" }, ready);
  assert.equal(pinned.conditions[0].then, "按会话固定分到其中一条");
  assert.equal(policyAt(IN_WINDOW, { protocol: "tcp", failoverStrategy: "ip_hash" }, ready).conditions[0].then, "按来源 IP 固定分到其中一条");
  // TCP+UDP 里 TCP 那一半照旧按连接说。
  const both = policyAt(IN_WINDOW, { protocol: "both" }, ready);
  assert.equal(both.perSession, false);
  assert.match(both.guards.find((guard) => guard.key === "failover")!.value, /新连接拨不通也算一次失败/);
  assert.equal(both.guards.find((guard) => guard.key === "switch")!.label, "旧连接");
});

test("按访客固定：调度器要从 PROXY 头里读访客，读不到时照实说所有访客落在同一条", () => {
  const ready = { isOnline: true, agentVersion: "2.2.199" };
  const ipHash = { failoverStrategy: "ip_hash" };
  // gost 端口转发：面板给调度器专门加一个头，新 Agent 不用提醒；老 Agent 读不了。
  assert.deepEqual(policyAt(IN_WINDOW, ipHash, ready).warnings, []);
  assert.match(policyAt(IN_WINDOW, ipHash).warnings.join(""), /早于 2\.2\.199：按访客固定读不到访客地址，所有访客都落在同一条路径上/);
  // realm / socat / nginx 前置、走隧道：加不了这个头，除非规则本来就发 PROXY 协议。
  for (const forwardType of ["realm", "socat", "nginx"]) {
    assert.match(
      policyAt(IN_WINDOW, { ...ipHash, forwardType }, ready).warnings.join(""),
      new RegExp(`${forwardType} 转发时调度器只看得到本机.*改用 gost 转发就能按访客分`),
    );
  }
  assert.deepEqual(policyAt(IN_WINDOW, { ...ipHash, forwardType: "realm", proxyProtocolSend: true }, ready).warnings, [], "转发组里开了「发送 PROXY」的 realm 已经带着头");
  const tunnelled = policyAt(IN_WINDOW, { ...ipHash, tunnelId: 7 }, ready).warnings.join("");
  assert.match(tunnelled, /走隧道时调度器只看得到本机.*隧道设置里打开 PROXY Protocol 的「出口发送到目标」/);
  assert.doesNotMatch(tunnelled, /改用 gost/);
  assert.deepEqual(policyAt(IN_WINDOW, { ...ipHash, tunnelId: 7, proxyProtocolExitSend: true }, ready).warnings, []);
  // Nginx 隧道连「发送 PROXY 协议」都没有：别让人去找一个不存在的开关。
  const nginxTunnel = policyAt(IN_WINDOW, { ...ipHash, tunnelId: 7, tunnelMode: "nginx_stream" }, ready).warnings.join("");
  assert.match(nginxTunnel, /Nginx 隧道传不了访客地址.*改用 GOST 隧道，并在隧道设置里打开「出口发送到目标」/);
  // UDP 没有访客地址可读：按会话固定。
  const udp = policyAt(IN_WINDOW, { ...ipHash, protocol: "both" }, ready).warnings.join("");
  assert.match(udp, /按访客固定对 UDP 是按会话固定/);
  assert.doesNotMatch(udp, /所有访客会落在同一条路径上/, "TCP 那一半由 gost 加的头解决");
});

test("时段表那几行带着配置里的序号：前面有一条失效的，此刻也标在对的那一行上", () => {
  // 第 0 个时段指向不存在的备用 5（比如刚删了那条备用），不算；命中的是第 1 个。
  const policy = policyAt(IN_WINDOW, { failoverSchedule: JSON.stringify({ timezone: TZ, windows: [
    { days: [], from: "00:00", to: "23:59", targetIndex: 5 },
    { days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 2 },
  ] }) });
  const deciding = policy.conditions.find((condition) => condition.state === "deciding");
  assert.equal(deciding?.windowIndex, 1);
  assert.equal(deciding?.key, "schedule-1");
  assert.equal(policy.preferredIndex, 2);
});
