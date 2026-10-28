import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { newRouteGroupDraft, routeGroupRuleFields, routePolicyOf, type RouteGroup } from "@shared/routeGroup";
import { describeRoutePolicy } from "@shared/routePolicy";
import { RouteGroupPanel, type RouteEvent, type RouteStatus, type RouteStatusPath } from "./RouteGroupSheet";

// 2026-09-22（星期二）上海 20:00：在「工作日 18:00–01:00」里。
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const TZ = "Asia/Shanghai";
const noop = () => {};

const draft = newRouteGroupDraft({ timezone: TZ });
const group: RouteGroup = {
  paths: [
    { ...draft.paths[0], hops: [2], dial: { ip: "203.0.113.2", port: 25311 } },
    { ...draft.paths[1], name: "备用线路", hops: [3, 2], dest: { ip: "10.95.0.11", port: 443 }, dial: { ip: "203.0.113.3", port: 25312 } },
  ],
  policy: { ...draft.policy, mode: "hybrid", schedule: { timezone: TZ, windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }] } },
};
const rule = {
  failoverEnabled: true,
  targetIp: "10.95.0.10",
  targetPort: 443,
  ...routeGroupRuleFields(group, { targetIp: "10.95.0.10", targetPort: 443 }),
  failoverActiveTarget: "203.0.113.3:25312",
  failoverActiveAt: new Date(NOW - 2 * 3_600_000),
};

function path(index: number, patch: Partial<RouteStatusPath> = {}): RouteStatusPath {
  const source = group.paths[index];
  return {
    key: source.key,
    index,
    letter: index === 0 ? "A" : "B",
    name: source.name,
    hops: source.hops.map((hostId, hopIndex) => ({
      hostId,
      name: hostId === 2 ? "JP relay 02" : "SG relay 03",
      port: 25310 + hopIndex,
      running: true,
      enabled: true,
      ok: true,
      latencyMs: 18 + hopIndex * 10,
      consecutiveFailures: 0,
      probedAt: NOW - 20_000,
      nextLabel: hopIndex === source.hops.length - 1 ? "落地" : "JP relay 02",
    })),
    dest: source.dest || { ip: "10.95.0.10", port: 443 },
    dial: source.dial,
    issue: null,
    weight: 50,
    probe: null,
    score: index === 0 ? 93 : 81,
    grade: { label: "优", tone: "healthy" },
    latencyMs: index === 0 ? 42 : 61,
    lossPct: index === 0 ? 0 : 0.4,
    jitterMs: 5,
    availabilityPct: 99.8,
    healthy: true,
    down: false,
    downReason: "",
    connections: index === 1 ? 12 : 0,
    samples: 30,
    active: index === 1,
    prewarming: false,
    ...patch,
  };
}

function status(patch: Partial<RouteStatus> = {}, paths?: RouteStatusPath[]): RouteStatus {
  return {
    ruleId: 1,
    policy: routePolicyOf(rule, { nowMs: NOW }),
    paths: paths || [path(0), path(1)],
    activeIndex: 1,
    activeSince: NOW - 2 * 3_600_000,
    prewarmIndex: -1,
    agentReportedAt: NOW - 10_000,
    agentStale: false,
    agentVersion: "2.2.198",
    agentSupportsScores: true,
    requiredAgentVersion: "2.2.198",
    ...patch,
  };
}

const events: RouteEvent[] = [
  { id: 3, kind: "switch", fromKey: group.paths[0].key, toKey: group.paths[1].key, fromLabel: "主线路", toLabel: "备用线路", reason: "schedule", reasonText: "按时段表", score: 81, latencyMs: 61, at: NOW - 2 * 3_600_000 },
  { id: 2, kind: "precheck_failed", fromKey: null, toKey: group.paths[1].key, fromLabel: null, toLabel: "备用线路", reason: "precheck:relay down: SG relay 03", reasonText: "预检未通过：中转异常：SG relay 03", score: null, latencyMs: null, at: NOW - 26 * 3_600_000 },
  { id: 1, kind: "prewarm", fromKey: null, toKey: group.paths[1].key, fromLabel: null, toLabel: "备用线路", reason: "schedule", reasonText: "按时段表", score: null, latencyMs: null, at: NOW - 26.1 * 3_600_000 },
];

function render(options: { status?: RouteStatus | null; events?: RouteEvent[]; canEdit?: boolean; host?: any } = {}) {
  const policy = describeRoutePolicy(rule, { host: options.host ?? { isOnline: true, agentVersion: "2.2.198" }, nowMs: NOW, timeZone: TZ })!;
  return renderToStaticMarkup(
    <RouteGroupPanel
      policy={policy}
      status={options.status === undefined ? status() : options.status}
      events={options.events ?? events}
      canEdit={options.canEdit ?? true}
      onPin={noop}
      onUnpin={noop}
      nowMs={NOW}
      timeZone={TZ}
    />,
  );
}

test("四段都在：路径、调度计划、最近切换；最后是应急人工指定", () => {
  const html = render();
  const order = ["路径", "调度计划", "最近切换", "应急人工指定"].map((header) => html.indexOf(`>${header}<`));
  assert.ok(order.every((position) => position > 0), `少了一段：${order.join(",")}`);
  assert.deepEqual([...order].sort((left, right) => left - right), order, "顺序就是从上往下");
  assert.match(html, /现在走 备用线路，18:00 起/);
});

test("路径画成链：在走的排最前，段上写每一跳的延迟、整链相加，节点下写中继端口；评分和连接数在卡头", () => {
  const html = render();
  const cards = html.split('data-testid="route-path-card"');
  assert.equal(cards.length, 3, "两条路径两张卡");
  const active = cards[1];
  assert.match(active, /备用线路/);
  assert.match(active, />在走</);
  // 入口探第一跳 61ms，SG 探 JP 18ms，JP 探落地 28ms：整链 107。
  assert.match(active, /61 ms[^]*?SG relay 03[^]*?中继 <span[^>]*>:25310<[^]*?18 ms[^]*?JP relay 02[^]*?中继 <span[^>]*>:25311<[^]*?28 ms[^]*?落地/);
  assert.match(active, /整链 107 ms/);
  assert.match(active, /data-testid="route-score"[^>]*>81 良</);
  assert.match(active, /12 连接/);
  assert.match(cards[2], /主线路/);
  assert.match(cards[2], />备用</);
});

test("断了的路径写明原因，没测到的段标「未测」而不是当成通", () => {
  const html = render({ status: status({}, [path(0, { down: true, downReason: "中转异常：JP relay 02 → 落地", healthy: false, score: 0 }), path(1)]) });
  assert.match(html, /断了 · 中转异常：JP relay 02 → 落地/);
  assert.match(html, /用不了的路径会被跳过/);
  // 20:00 在时段里，首选是按时段表的 B，所以 A 不带「首选」。
  assert.doesNotMatch(html, />首选</);
  const untested = render({ status: status({}, [path(0), path(1, { hops: path(1).hops.map((hop, index) => (index === 0 ? { ...hop, ok: null, latencyMs: null } : hop)) })]) });
  assert.match(untested, /data-state="unknown"[^>]*>[^]*?未测/);
  assert.match(untested, /整链 ≥ 89 ms/, "没测的那段不算进去，写成「≥」");
});

test("调度计划：策略模板、此刻起作用的那一行、切换保护、预热、旧连接", () => {
  const html = render();
  assert.match(html, /晚高峰优化 · 混合策略/);
  assert.equal((html.match(/data-state="deciding"/g) || []).length, 1);
  assert.match(html, /到点前 5 分钟先预热预检，预检不过不切/);
  assert.match(html, /计划切换预热/);
  assert.match(html, /旧连接[^]*?平滑切换/);
  assert.match(html, /探测连续失败 3 次才算异常/);
});

test("最近切换：时间、从哪条到哪条、原因；计划切换未执行写明继续用原路径", () => {
  const html = render();
  assert.equal((html.match(/data-testid="route-event"/g) || []).length, 3);
  assert.match(html, /切换[^]*?主线路 → 备用线路[^]*?按时段表 · 评分 81 良/);
  assert.match(html, /计划切换未执行[^]*?预检未通过：中转异常：SG relay 03 · 继续使用原路径/);
  assert.match(html, /9月21日 18:00/, "不是同一天的带日期");
  assert.match(render({ events: [] }), /还没有记录/);
});

test("Agent 太旧时说清楚没有评分；状态没读到时不空着", () => {
  const old = render({ status: status({ agentSupportsScores: false, agentVersion: "2.2.197" }) });
  assert.match(old, /早于 2\.2\.198：没有评分、不预热预检、不按权重分/);
  assert.match(render({ status: null }), /在读线路状态/);
  const stale = render({ status: status({ agentStale: true, agentReportedAt: NOW - 20 * 60_000 }) });
  assert.match(stale, /评分是 20 分钟前报的/);
});

test("不能改的人看不到人工指定", () => {
  assert.doesNotMatch(render({ canEdit: false }), /应急人工指定|强制走一条/);
  assert.match(render(), /强制走一条/);
});

/*
  「Agent 早于 2.2.199」那几句以调度那台机器为准：GOST / Nginx 隧道的调度在出口机上，调用方
  传进来的是规则所在的机器（入口）。线路状态读的是对的那台，面板按它说、别说两遍。
*/
function renderFor(ruleFields: Record<string, unknown>, statusPatch: Partial<RouteStatus>, host: any) {
  const subject = { ...rule, ...ruleFields };
  const policy = describeRoutePolicy(subject as any, { host, nowMs: NOW, timeZone: TZ })!;
  return renderToStaticMarkup(
    <RouteGroupPanel
      policy={policy}
      status={status(statusPatch)}
      events={events}
      canEdit
      onPin={noop}
      onUnpin={noop}
      nowMs={NOW}
      timeZone={TZ}
    />,
  );
}

test("UDP：调度那台机器的 Agent 早于 2.2.199 时说一次「全部走路径 A、不切换」", () => {
  const html = renderFor(
    { protocol: "both" },
    { protocol: "both", agentVersion: "2.2.198", agentSupportsProtocol: false, requiredAgentVersion: "2.2.199" },
    { isOnline: true, agentVersion: "2.2.198" },
  );
  assert.equal((html.match(/还不会调度 UDP/g) || []).length, 1, "策略算出来的那句和线路状态那句不能都出来");
  assert.match(html, /调度这条线路组的机器上 Agent（2\.2\.198）早于 2\.2\.199，还不会调度 UDP：升级之前这条规则全部走 主线路、不切换/);
  const ready = renderFor(
    { protocol: "both" },
    { protocol: "both", agentVersion: "2.2.199", agentSupportsProtocol: true, requiredAgentVersion: "2.2.199" },
    { isOnline: true, agentVersion: "2.2.198" },
  );
  assert.doesNotMatch(ready, /还不会调度 UDP/, "入口机旧、出口机（调度在这）新：不该报");
});

test("NEX 隧道：出口的 Agent 早于 2.2.199 时说一次，按 NEX 隧道说而不是按 UDP 说", () => {
  const fxp = { protocol: "tcp", tunnelId: 7, tunnelMode: "forwardx" };
  const html = renderFor(
    fxp,
    { protocol: "tcp", agentVersion: "2.2.198", agentSupportsProtocol: false, requiredAgentVersion: "2.2.199", schedulerNeed: "forwardx" },
    { isOnline: true, agentVersion: "2.2.198" },
  );
  assert.equal((html.match(/还不会调度 NEX 隧道/g) || []).length, 1, "策略算出来的那句和线路状态那句不能都出来");
  assert.match(html, /隧道出口的 Agent（2\.2\.198）早于 2\.2\.199，还不会调度 NEX 隧道：升级之前这条规则全部走 主线路、不切换/);
  assert.doesNotMatch(html, /还不会调度 UDP/);
  const ready = renderFor(
    fxp,
    { protocol: "tcp", agentVersion: "2.2.199", agentSupportsProtocol: true, requiredAgentVersion: "2.2.199", schedulerNeed: "forwardx" },
    { isOnline: true, agentVersion: "2.2.198" },
  );
  assert.doesNotMatch(ready, /还不会调度/, "入口机旧、出口机（调度在这）新：不该报");
});

test("按访客固定：只看调度那台机器的 Agent 版本", () => {
  const weighted = routeGroupRuleFields(
    { ...group, policy: { ...group.policy, mode: "weighted", spread: "ip_hash" } },
    { targetIp: "10.95.0.10", targetPort: 443 },
  );
  const oldScheduler = renderFor(
    { ...weighted, protocol: "tcp" },
    { protocol: "tcp", agentVersion: "2.2.198", agentSupportsProtocol: true },
    { isOnline: true, agentVersion: "2.2.199" },
  );
  assert.match(oldScheduler, /调度这条线路组的机器上 Agent（2\.2\.198）早于 2\.2\.199：按访客固定读不到访客地址，所有访客都落在同一条路径上/);
  const newScheduler = renderFor(
    { ...weighted, protocol: "tcp" },
    { protocol: "tcp", agentVersion: "2.2.199", agentSupportsProtocol: true },
    { isOnline: true, agentVersion: "2.2.198" },
  );
  assert.doesNotMatch(newScheduler, /按访客固定读不到访客地址/);
});

test("纯 UDP：调度计划里策略那句和旧会话都按会话说", () => {
  const weighted = routeGroupRuleFields(
    { ...group, policy: { ...group.policy, mode: "weighted", spread: "weighted" } },
    { targetIp: "10.95.0.10", targetPort: 443 },
  );
  const ready = { protocol: "udp", agentVersion: "2.2.199", agentSupportsProtocol: true, requiredAgentVersion: "2.2.199" } as const;
  const udp = renderFor({ ...weighted, protocol: "udp" }, ready, { isOnline: true, agentVersion: "2.2.199" });
  assert.match(udp, /负载均衡 · 权重负载：新会话按权重分到各条路径，旧会话不动/);
  assert.match(udp, />旧会话</);
  assert.doesNotMatch(udp, /新连接按权重分到各条路径/);
  const both = renderFor({ ...weighted, protocol: "both" }, { ...ready, protocol: "both" }, { isOnline: true, agentVersion: "2.2.199" });
  assert.match(both, /负载均衡 · 权重负载：新连接按权重分到各条路径，旧连接不动/);
});
