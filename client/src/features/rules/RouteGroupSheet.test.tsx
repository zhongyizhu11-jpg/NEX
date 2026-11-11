import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { newRouteGroupDraft, routeGroupRuleFields, routePolicyOf, type RouteGroup } from "@shared/routeGroup";
import { describeRoutePolicy } from "@shared/routePolicy";
import { RouteGroupPanel, type RouteEvent, type RouteStatus, type RouteStatusPath } from "./RouteGroupSheet";
import { RouteLineDiagram } from "./RouteLineDiagram";
import { RouteLineDetail, pinDurationSeconds, routeDrillAction, routeLineStatusControls } from "./RouteLineOverview";

// 2026-09-22（星期二）上海 20:00：在「工作日 18:00–01:00」里。
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const TZ = "Asia/Shanghai";
const noop = () => {};

const draft = newRouteGroupDraft({ timezone: TZ });
const group: RouteGroup = {
  paths: [
    { ...draft.paths[0], hops: [2], dial: { ip: "203.0.113.2", port: 25311 } },
    { ...draft.paths[1], name: "晚高峰", hops: [3, 2], dest: { ip: "10.95.0.11", port: 443 }, dial: { ip: "203.0.113.3", port: 25312 } },
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
    ...patch,
  };
}

const events: RouteEvent[] = [
  { id: 3, kind: "switch", fromKey: group.paths[0].key, toKey: group.paths[1].key, fromLabel: "主线路", toLabel: "晚高峰", reason: "schedule", reasonText: "按时段表", score: 81, latencyMs: 61, at: NOW - 2 * 3_600_000 },
  { id: 2, kind: "precheck_failed", fromKey: null, toKey: group.paths[1].key, fromLabel: null, toLabel: "晚高峰", reason: "precheck:relay down: SG relay 03", reasonText: "预检未通过：中转异常：SG relay 03", score: null, latencyMs: null, at: NOW - 26 * 3_600_000 },
  { id: 1, kind: "prewarm", fromKey: null, toKey: group.paths[1].key, fromLabel: null, toLabel: "晚高峰", reason: "schedule", reasonText: "按时段表", score: null, latencyMs: null, at: NOW - 26.1 * 3_600_000 },
];

function render(options: { status?: RouteStatus | null; events?: RouteEvent[]; host?: any; rule?: typeof rule } = {}) {
  const policy = describeRoutePolicy(options.rule ?? rule, { host: options.host ?? { isOnline: true }, nowMs: NOW, timeZone: TZ })!;
  return renderToStaticMarkup(
    <RouteGroupPanel
      policy={policy}
      status={options.status === undefined ? status() : options.status}
      events={options.events ?? events}
      nowMs={NOW}
      timeZone={TZ}
    />,
  );
}

test("两段：调度计划、最近切换；路径不在这里画（线路详情上面已经有分层图和线路列表）", () => {
  const html = render();
  const order = ["调度计划", "最近切换"].map((header) => html.indexOf(`>${header}<`));
  assert.ok(order.every((position) => position > 0), `少了一段：${order.join(",")}`);
  assert.deepEqual([...order].sort((left, right) => left - right), order, "顺序就是从上往下");
  assert.doesNotMatch(html, />路径(（每条都在走）)?</);
  assert.doesNotMatch(html, /route-path-card/);
  assert.match(html, /现在走 晚高峰，18:00 起/);
});

test("调度计划：策略模板、此刻起作用的那一行、切换保护、预热、旧连接", () => {
  const html = render();
  assert.match(html, /晚高峰优化 · 混合策略/);
  assert.equal((html.match(/data-state="deciding"/g) || []).length, 1);
  assert.match(html, /到点前 5 分钟先预热预检，预检不过不切/);
  assert.match(html, /计划切换预热/);
  assert.match(html, /旧连接[^]*?平滑切换/);
  assert.match(html, /探测连续失败 2 次才算异常，异常持续 3 秒就切走/);
});

test("最近切换：时间、从哪条到哪条、原因；计划切换未执行写明继续用原路径", () => {
  const html = render();
  assert.equal((html.match(/data-testid="route-event"/g) || []).length, 3);
  assert.match(html, /切换[^]*?主线路 → 晚高峰[^]*?按时段表 · 评分 81 良/);
  assert.match(html, /计划切换未执行[^]*?预检未通过：中转异常：SG relay 03 · 继续使用原路径/);
  assert.match(html, /9月21日 18:00/, "不是同一天的带日期");
  assert.match(render({ events: [] }), /还没有记录/);
});

test("状态没读到时照样画调度计划和最近切换（「在读线路状态…」由外面的线路详情写）；评分是多久前报的照实说", () => {
  const unread = render({ status: null });
  assert.match(unread, />调度计划</);
  assert.match(unread, />最近切换</);
  const sheet = fs.readFileSync(new URL("./RouteGroupSheet.tsx", import.meta.url), "utf8");
  assert.match(sheet, /\{!status \? \(\s*<p[^>]*>在读线路状态…<\/p>/, "线路详情在状态没读到时写「在读线路状态…」，不空着");
  const stale = render({ status: status({ agentStale: true, agentReportedAt: NOW - 20 * 60_000 }) });
  assert.match(stale, /评分是 20 分钟前报的/);
});

test("异常明细里没有「强制走一条」（2.3.499）：手动切换只在线路的状态胶囊上，钉着的时候也不再列一遍", () => {
  assert.doesNotMatch(render(), /应急人工指定|强制走一条|交回自动/);
  const pinned = render({ rule: { ...rule, failoverPinnedIndex: 0, failoverPinnedUntil: Math.floor(NOW / 1000) + 3_600 } });
  assert.doesNotMatch(pinned, /应急人工指定|强制走一条|交回自动/);
  // 调度计划里照样看得出是人工指定在决定
  assert.match(pinned, /data-state="overridden"/);
});

/* 按规则字段和线路状态画一份面板。 */
function renderFor(ruleFields: Record<string, unknown>, statusPatch: Partial<RouteStatus>, host: any) {
  const subject = { ...rule, ...ruleFields };
  const policy = describeRoutePolicy(subject as any, { host, nowMs: NOW, timeZone: TZ })!;
  return renderToStaticMarkup(
    <RouteGroupPanel
      policy={policy}
      status={status(statusPatch)}
      events={events}
      nowMs={NOW}
      timeZone={TZ}
    />,
  );
}

test("纯 UDP：调度计划里策略那句和旧会话都按会话说", () => {
  const weighted = routeGroupRuleFields(
    { ...group, policy: { ...group.policy, mode: "weighted", spread: "weighted" } },
    { targetIp: "10.95.0.10", targetPort: 443 },
  );
  const ready = { protocol: "udp" } as const;
  const udp = renderFor({ ...weighted, protocol: "udp" }, ready, { isOnline: true });
  assert.match(udp, /负载均衡 · 权重负载：新会话按权重分到各条路径，旧会话不动/);
  assert.match(udp, />旧会话</);
  assert.doesNotMatch(udp, /新连接按权重分到各条路径/);
  const both = renderFor({ ...weighted, protocol: "both" }, { ...ready, protocol: "both" }, { isOnline: true });
  assert.match(both, /负载均衡 · 权重负载：新连接按权重分到各条路径，旧连接不动/);
});

test("线路详情里直接改：编辑器每条线路后面是此刻的状态和立刻生效的暂停；还没保存的新线路没有（照旧是勾）", () => {
  const paused: string[] = [];
  const onPause = (lineKey: string, value: boolean) => { paused.push(`${lineKey}:${value}`); };
  const backup = renderToStaticMarkup(<>{routeLineStatusControls(status(), group.paths[1].key, onPause)}</>);
  assert.match(backup, /data-testid="route-line-state"[^>]*>[^]*使用中/, "在走的那条写「使用中」");
  assert.match(backup, /aria-label="暂停线路 晚高峰"/, "暂停按钮还在，不用保存");
  const main = renderToStaticMarkup(<>{routeLineStatusControls(status(), group.paths[0].key)}</>);
  assert.match(main, /待命/);
  assert.doesNotMatch(main, /route-line-pause/, "只能看的时候没有暂停");
  assert.equal(routeLineStatusControls(status(), "new-line-not-saved"), null, "还没保存的新线路：没有状态，编辑器照旧给「参与切换」的勾");
  assert.equal(routeLineStatusControls(null, group.paths[0].key), null, "状态还没读到");
});

test("分层图：落地是最后一列、一直画到右边，后面没有「目标」小圆点；落地写全名", () => {
  // 和用户那条一样：主线路、备用各经一台中转（一列中转）
  const landing = status({}, [
    path(0, { dest: { ip: "hkboil.ddos.top", port: 24895 }, active: true }),
    path(1, { active: false, hops: path(1).hops.slice(0, 1) }),
  ]);
  const html = renderToStaticMarkup(<RouteLineDiagram status={landing} modeLabel="整链最优" timeZone={TZ} />);
  assert.doesNotMatch(html, />目标</, "表头没有「目标」");
  assert.doesNotMatch(html, /<circle[^>]*r="7"/, "没有目标圆点");
  assert.match(html, />hkboil\.ddos\.top</, "一列中转时落地名字写得下，不截");
  const viewBox = Number(/viewBox="0 0 (\d+)/.exec(html)?.[1]);
  const rects = Array.from(html.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)).map((match) => Number(match[1]) + Number(match[2]));
  assert.ok(Math.max(...rects) <= viewBox && Math.max(...rects) >= viewBox - 4, `落地框贴着右边（${Math.max(...rects)} / ${viewBox}）`);
});

test("手动换线路：点状态胶囊就能切到这条；指定了的那条胶囊带「指定」；没给切换（按权重 / 只能看）就是普通胶囊", () => {
  const lineSwitch = { pinIndex: null, pinUntilMs: null, pending: false, onPin: noop, onUnpin: noop };
  const idle = renderToStaticMarkup(<>{routeLineStatusControls(status(), group.paths[0].key, undefined, false, lineSwitch)}</>);
  assert.match(idle, /aria-label="手动切换：主线路"[^>]*data-testid="route-line-switch"[^]*待命/, "胶囊本身就是切换按钮");
  const pinned = renderToStaticMarkup(<>{routeLineStatusControls(status(), group.paths[1].key, undefined, false, { ...lineSwitch, pinIndex: 1 })}</>);
  assert.match(pinned, /使用中 · 指定/);
  // 指定了主线路、机器还走在备用上：不写「待命 · 指定」（看着像指定了也不走），写「切换中」
  const switching = renderToStaticMarkup(<>{routeLineStatusControls(status(), group.paths[0].key, undefined, false, { ...lineSwitch, pinIndex: 0 })}</>);
  assert.match(switching, /切换中 · 指定/);
  assert.doesNotMatch(switching, /待命/);
  const plain = renderToStaticMarkup(<>{routeLineStatusControls(status(), group.paths[0].key)}</>);
  assert.doesNotMatch(plain, /route-line-switch/);
});

test("期望 vs 实际对不上：线路详情顶上出红条，逐项列「面板 / 机器」，有「重新下发」；异常明细里也写一句", () => {
  const drift = { fields: [{ key: "pin", label: "人工指定", expected: "备用 1 · 到 18:36", actual: "没有" }, { key: "minHold", label: "最短驻留", expected: "1 分钟", actual: "0 秒" }], reportedAt: NOW - 5_000 };
  let resynced = 0;
  const html = renderToStaticMarkup(
    <RouteLineDetail status={status({ drift })} events={events} modeLabel="整链最优" detailsOpen={false} onToggleDetails={noop} nowMs={NOW} timeZone={TZ} onResync={() => { resynced += 1; }} />,
  );
  assert.match(html, /data-testid="route-drift"[^]*?机器上跑的不是面板里这份/);
  assert.match(html, /人工指定[^]*?面板 备用 1 · 到 18:36[^]*?机器 没有/);
  assert.match(html, /最短驻留[^]*?面板 1 分钟[^]*?机器 0 秒/);
  assert.match(html, /data-testid="route-drift-resync"[^>]*>重新下发/);
  // 一致（null）就什么都没有：别让人以为老 Agent 也有问题
  assert.doesNotMatch(renderToStaticMarkup(<RouteLineDetail status={status({ drift: null })} events={events} modeLabel="整链最优" detailsOpen={false} onToggleDetails={noop} nowMs={NOW} timeZone={TZ} />), /route-drift/);
  assert.equal(resynced, 0);
  assert.match(render({ status: status({ drift }) }), /route-drift-note[^>]*>机器上跑的不是面板里这份：人工指定（面板 备用 1 · 到 18:36 \/ 机器 没有）；最短驻留（面板 1 分钟 \/ 机器 0 秒）。/);
});

test("切换演练只占一个小按钮：详情顶上没有卡、胶囊菜单里没有演练一节；演练那条的胶囊写「演练中」；按钮在该有的时候才有", () => {
  const active = { lineKey: group.paths[0].key, phase: "down" as const };
  // 进行中、没在演练：线路详情第一页都不多出任何东西
  for (const drill of [{ active }, { active: null }, null]) {
    const html = renderToStaticMarkup(<RouteLineDetail status={status({ drill })} events={events} modeLabel="整链最优" detailsOpen={false} onToggleDetails={noop} nowMs={NOW} timeZone={TZ} />);
    assert.doesNotMatch(html, /route-drill|演练报告|提前结束/);
  }
  const lineSwitch = { pinIndex: null, pinUntilMs: null, pending: false, onPin: noop, onUnpin: noop };
  assert.doesNotMatch(renderToStaticMarkup(<>{routeLineStatusControls(status(), group.paths[0].key, undefined, false, lineSwitch)}</>), /演练/);
  // 演练那条的胶囊：面板给的提示原因是 drill，写「演练中」而不是「不通」
  const drilled = status();
  drilled.paths = drilled.paths.map((path, index) => (index === 0 ? { ...path, active: false, down: true, downReason: "drill", healthy: false } : { ...path, active: index === 1 }));
  const pill = renderToStaticMarkup(<>{routeLineStatusControls(drilled, group.paths[0].key, undefined, false, lineSwitch)}</>);
  assert.match(pill, /演练中/);
  assert.doesNotMatch(pill, /不通/);
  // 「异常明细」里的按钮：演练现在走的那条；进行中变成「结束演练」；只能看的人、按权重分的、只有一条线路的没有
  const inUse = status().paths.find((path) => path.active)!;
  assert.deepEqual(routeDrillAction(status(), true), { drilling: false, lineKey: inUse.lineKey || inUse.key, label: "演练 60 秒", title: "把现在走的这条当成挂了一分钟（机器上的转发不动），看切不切；结果记在「最近切换」里" });
  assert.equal(routeDrillAction(status({ drill: { active } }), true)?.label, "结束演练");
  assert.equal(routeDrillAction(status(), false), null);
  assert.equal(routeDrillAction(status({ policy: { ...status().policy, mode: "weighted" } }), true), null);
  assert.equal(routeDrillAction(status({}, [status().paths[0]]), true), null);
});

test("手动切的时长自己填：几分钟 / 几小时，空、0、负数、超过 30 天都不行", () => {
  assert.equal(pinDurationSeconds("2", "hour"), 7200);
  assert.equal(pinDurationSeconds("1.5", "hour"), 5400);
  assert.equal(pinDurationSeconds("30", "min"), 1800);
  assert.equal(pinDurationSeconds("", "hour"), null);
  assert.equal(pinDurationSeconds("0", "min"), null);
  assert.equal(pinDurationSeconds("-3", "hour"), null);
  assert.equal(pinDurationSeconds("721", "hour"), null, "超过 30 天：选「不限时」");
  assert.equal(pinDurationSeconds("720", "hour"), 720 * 3600);
});

test("线路详情照效果图 ①（2.3.499）：「线路」标题右边那行（怎么切的摘要 + 箭头）是个下拉，点开才出添加备用线路、怎么切、高级策略", () => {
  const renderDetail = (settings?: { open: boolean; onToggle: () => void }) => renderToStaticMarkup(
    <RouteLineDetail
      status={status()}
      events={events}
      modeLabel="按时段"
      detailsOpen={false}
      onToggleDetails={noop}
      nowMs={NOW}
      timeZone={TZ}
      editor={<div data-testid="fake-editor" />}
      settings={settings}
    />,
  );
  const closed = renderDetail({ open: false, onToggle: noop });
  assert.match(closed, /<button[^>]*aria-expanded="false"[^>]*data-testid="route-line-settings"/);
  assert.match(renderDetail({ open: true, onToggle: noop }), /<button[^>]*aria-expanded="true"[^>]*data-testid="route-line-settings"/);
  assert.doesNotMatch(renderDetail(), /route-line-settings/, "没有编辑器（只能看）就是一行字");
  // 线路下面紧跟着连接；「精确到哪一段」那句小字去掉了
  assert.match(closed, /fake-editor[^]*?连接 · 最近 10 分钟/);
  assert.doesNotMatch(closed, /精确到哪一段/);
});

test("调度计划里的「多落地」（2.3.501）：一起分的线路列成「主线路 按负载分」，不带长说明；主备的线路不列", () => {
  const line = (key: string, name: string, destSpread?: "one" | "least_load" | "ip_hash") => ({ key, name, paused: false, layers: [], dests: [], weight: 50, ...(destSpread ? { destSpread } : {}) });
  const html = render({ status: status({ lines: [line("main", "主线路", "least_load"), line("bk", "备用 1", "one"), line("bk2", "晚高峰", "ip_hash")] }) });
  assert.match(html, />多落地<[^]*?主线路 按负载分；晚高峰 按访客固定</);
  assert.doesNotMatch(html, /这条线路在用时/);
  assert.doesNotMatch(render({ status: status({ lines: [line("main", "主线路")] }) }), />多落地</, "没有线路一起分：不列");
});
