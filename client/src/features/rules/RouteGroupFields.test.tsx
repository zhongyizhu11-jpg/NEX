import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  applyRouteMode,
  newRouteGroupDraft,
  newRoutePath,
  routeGroupRuleFields,
  routeTemplateGuards,
  type RouteGroup,
  type RouteMode,
} from "@shared/routeGroup";
import { describeRoutePolicy } from "@shared/routePolicy";
import { newRouteLine, routeLinesFromPaths } from "@shared/routeLines";
import { RouteGroupFields, followRoutePath, lineModeHint, routeGroupPayload, routePathIndexFor, summarizeRouteAdvanced, type RouteGroupDraft } from "./RouteGroupFields";
import { SegmentLatencyContext, type SegmentLatencyHook } from "./segmentLatency";

/*
  编辑线路组（效果图 ②）：线路详情第一页和规则表单里是同一个编辑器（2.3.498 起都是直接在页里改）。2.3.497 起
  只认线路：老草稿只有路径的，打开就按路径还原成线路。
*/

// 2026-09-22（星期二）上海 20:00：在「工作日 18:00–01:00」里。
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const TZ = "Asia/Shanghai";
const hosts = [
  { id: 1, name: "HK entry 01", isOnline: true },
  { id: 2, name: "JP relay 02", isOnline: true },
  { id: 3, name: "SG relay 03", isOnline: false },
];

function group(mode: RouteMode = "failover", patch: Partial<RouteGroup["policy"]> = {}, paths?: RouteGroup["paths"]): RouteGroupDraft {
  const draft = newRouteGroupDraft({ timezone: TZ });
  const list = paths || [
    { ...draft.paths[0], hops: [2] },
    { ...draft.paths[1], name: "备用线路", hops: [3, 2], dest: { ip: "10.95.0.11", port: 443 } },
  ];
  const policy = { ...applyRouteMode(draft.policy, mode, { timezone: TZ, pathCount: list.length }), ...patch };
  return { paths: list, policy };
}

/** 和编辑框一样：拿表单现在的样子走同一份模型算「此刻」。 */
function render(value: RouteGroupDraft, advanced: boolean | "auto" = true, protocol = "tcp", extra: Partial<Parameters<typeof RouteGroupFields>[0]> = {}) {
  const policy = describeRoutePolicy({
    failoverEnabled: true,
    targetIp: "10.95.0.10",
    targetPort: 443,
    protocol,
    ...routeGroupRuleFields(value, { targetIp: "10.95.0.10", targetPort: 443 }),
  }, { nowMs: NOW, timeZone: TZ });
  return renderToStaticMarkup(
    <RouteGroupFields
      value={value}
      onChange={() => {}}
      hosts={hosts}
      entryHostId={1}
      mainAddress="10.95.0.10:443"
      policy={policy}
      scheduleTimeZone={TZ}
      defaultAdvancedOpen={advanced === "auto" ? undefined : advanced}
      nowMs={NOW}
      timeZone={TZ}
      protocol={protocol}
      {...extra}
    />,
  );
}

const stateOf = (html: string, testId: string) => html.match(new RegExp(`data-state="(\\w+)" data-testid="${testId}"`))?.[1];
const count = (html: string, pattern: RegExp) => (html.match(pattern) || []).length;

test("老草稿只有路径：打开就是线路的样子（主线路一张卡、备用一行），没有以前那份路径编辑", () => {
  const html = render(group());
  assert.equal(count(html, /data-testid="route-line"/g), 2);
  assert.match(html, /data-testid="route-lines"/);
  assert.doesNotMatch(html, /data-testid="route-paths"|data-testid="route-preview"|data-testid="route-plain"|添加路径/, "老的路径编辑、预览卡、那句大白话都不在了");
  assert.match(html, /<span[^>]*>入口<\/span>[^]*?HK entry 01/, "主线路卡从入口写起");
  assert.match(html, />中转<\/span>[^]*?JP relay 02/, "一跳一行，叫「中转」（不再是「第 1 层」）");
  assert.match(html, /title="规则自己的目标"[^]*?10\.95\.0\.10:443/, "没写落地的走规则自己的目标");
  assert.match(html, /HK entry 01 → SG relay 03 → JP relay 02 → 落地/, "备用折成一行：整条链怎么走");
  assert.match(html, /\+ 添加备用线路/);
});

test("还原出来的线路和路径一一对应：探测地址、落地、权重都带着", () => {
  const lines = routeLinesFromPaths(group("failover", {}, [
    { ...newRoutePath(0), hops: [2], probe: { ip: "10.95.0.10", port: 8443 } },
    { ...newRoutePath(1), dest: { ip: "203.0.113.9", port: 443 }, weight: 30 },
  ]).paths);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].layers.map((layer) => layer.hostIds), [[2]]);
  assert.deepEqual(lines[0].probe, { ip: "10.95.0.10", port: 8443 });
  assert.deepEqual(lines[1].dests, [{ dest: { ip: "203.0.113.9", port: 443 }, destNodeId: null }]);
  assert.equal(lines[1].weight, 30);
});

test("怎么切四格，选中的那格下面一句它会怎么做；手动主备、混合是格子下面的勾", () => {
  const smart = render(group("smart"));
  for (const segment of ["稳定优先", "整链最优", "按权重", "按时段"]) assert.match(smart, new RegExp(`role="radio"[^>]*>${segment}<`), `少了「${segment}」`);
  assert.match(smart, /aria-checked="true"[^>]*>整链最优</);
  assert.match(smart, /坏了 \d+ 秒内切走 · /, "选中那格下面一行要点");
  const hybrid = render(group("hybrid"));
  assert.match(hybrid, /aria-checked="true"[^>]*>按时段</, "混合落在「按时段」那格");
  assert.match(hybrid, /aria-label="时段外挑最快的" data-testid="route-line-hybrid" checked=""|checked=""[^>]*data-testid="route-line-hybrid"/);
  const manual = render(group("manual"));
  assert.match(manual, /aria-checked="true"[^>]*>稳定优先</, "手动主备落在「稳定优先」那格");
  assert.match(manual, /data-testid="route-line-manual"/);
  assert.doesNotMatch(render(group("failover")), /data-testid="route-line-hybrid"/);
});

test("按时段在「怎么切」下面直接配时段表，此刻命中的那一段带「此刻」", () => {
  const html = render(group("scheduled"));
  assert.match(html, /data-testid="route-schedule"/);
  assert.equal(stateOf(html, "policy-schedule"), "deciding");
  assert.equal(count(html, />此刻</g), 1, "「此刻」在命中的时段那一行上，只有一处");
  assert.match(html, /工作日 18:00-01:00（次日） → 备用线路/, "时段复述用的是线路的名字");
  assert.doesNotMatch(render(group("failover")), /data-testid="route-schedule"/, "稳定优先没有时段表");
});

test("手动主备在「怎么切」下面直接选走哪条，没有「自动」这个选项", () => {
  const html = render(group("manual"));
  assert.match(html, /data-testid="policy-pin"/);
  assert.match(html, /aria-pressed="true"[^>]*>主线路</);
  assert.doesNotMatch(html, /aria-label="强制走哪条路径"[^]*?>自动</);
  assert.doesNotMatch(html, /应急人工指定/, "手动模式下没有第二个人工指定");
});

test("按权重：分法四选一，按权重时一条线路一个权重和百分比，没有驻留和切回", () => {
  const html = render(group("weighted"));
  for (const label of ["按权重", "轮流", "随机", "按访客固定"]) assert.match(html, new RegExp(label));
  assert.match(html, /data-testid="route-line-weights"/);
  assert.match(html, /aria-label="主线路 的权重"/);
  assert.match(html, /aria-label="备用线路 的权重"/);
  assert.equal(count(html, />50%</g), 2);
  assert.doesNotMatch(html, /最短驻留|恢复后切回首选|应急人工指定/);
  assert.doesNotMatch(render(group("weighted", { spread: "round_robin" })), /data-testid="route-line-weights"/, "轮流不用填权重");
});

test("「怎么切」下面那一行只说要点：坏了几秒内切走、多久切回（四格已经写了是哪种）", () => {
  const hint = (mode: RouteMode, patch: Partial<RouteGroup["policy"]> = {}, perSession = false) => lineModeHint(group(mode, patch).policy, perSession);
  assert.equal(hint("failover"), "坏了 5 秒内切走 · 5 分钟后切回");
  assert.equal(hint("failover", { autoFailback: false }), "坏了 5 秒内切走 · 不自动切回");
  assert.match(hint("smart"), /^坏了 \d+ 秒内切走 · /);
  assert.match(hint("scheduled"), /^按时段表走 · 坏了/);
  assert.match(hint("hybrid"), /^时段外挑最快的 · 坏了/);
  assert.match(hint("manual"), /^走指定的那条 · 坏了/);
  assert.equal(hint("weighted"), "新连接按权重分 · 坏了的先跳过");
  assert.equal(hint("weighted", {}, true), "新会话按权重分 · 坏了的先跳过", "纯 UDP 按会话说");
  for (const mode of ["failover", "smart", "scheduled", "hybrid", "manual", "weighted"] as RouteMode[]) {
    assert.ok(hint(mode).length <= 24, `一行放得下：${hint(mode)}`);
  }
  // Agent 按「异常多久切」的一半探（1–5 秒）：最坏是刚探完就坏，等下一轮探到、再连续失败够次数、持续够时间
  assert.match(hint("failover", { failoverSeconds: 1, failureThreshold: 1 }), /坏了 2 秒内切走/);
  assert.match(hint("failover", { failoverSeconds: 30, failureThreshold: 3 }), /坏了 35 秒内切走/);
});

test("纯 UDP 的编辑框：分法和旧会话三选一都按会话说，TCP+UDP 照旧按连接", () => {
  const udp = render(group("weighted", { spread: "round_robin" }), true, "udp");
  assert.match(udp, /aria-label="新会话怎么分"/);
  assert.match(udp, /新会话轮流走每一条/);
  assert.match(udp, /切换时旧会话怎么办[^]*?平滑切换[^]*?已有的会话留在原路径[^]*?快速切换[^]*?丢掉它上面的会话[^]*?强制切换/);
  assert.match(udp, /新会话按权重分 · /);
  assert.doesNotMatch(udp, /切换时旧连接怎么办|新连接轮流走每一条|新连接按权重分/);
  const both = render(group("weighted", { spread: "round_robin" }), true, "both");
  assert.match(both, /aria-label="新连接怎么分"/);
  assert.match(both, /切换时旧连接怎么办/);
  assert.match(both, /新连接按权重分 · /);
});

test("高级策略的折叠条只有标题和箭头（2.3.499）；默认折起来，规则表单里改过模板值的打开时直接展开", () => {
  const toggleText = (html: string) => (html.match(/data-testid="route-advanced-toggle"[^>]*>([^]*?)<\/button>/)?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
  const html = render(group(), "auto");
  assert.match(html, /aria-expanded="false"[^>]*data-testid="route-advanced-toggle"/);
  assert.equal(toggleText(html), "高级策略");
  assert.doesNotMatch(html, /按模板预填，一般不用动|route-advanced-summary/);
  assert.doesNotMatch(html, /切换保护|连续失败/, "新手用不上的东西默认折起来");

  const changed = render(group("hybrid", { failureThreshold: 5, switchMode: "force", prewarmSeconds: 0 }), "auto");
  assert.match(changed, /aria-expanded="true"/);
  assert.equal(toggleText(changed), "高级策略", "改过的项不再挂在折叠条上，点开看");
  assert.doesNotMatch(changed, /连续失败 5 次 · 不预热 · 强制切换/);
});

test("高级策略里按模式给控件：择优门槛只在整链最优 / 混合，预热只在按时段 / 混合，应急指定只在自动模式", () => {
  const smart = render(group("smart"));
  assert.match(smart, /择优门槛/);
  assert.doesNotMatch(smart, /计划切换预热/);
  assert.match(smart, /应急人工指定/);
  // 线路详情里每条线路的状态胶囊就能切（2.3.499）：高级策略里不再放第二个入口
  assert.doesNotMatch(render(group("smart"), true, "tcp", { pinOnLineStatus: true }), /应急人工指定|强制走一条/);
  const scheduled = render(group("scheduled"));
  assert.match(scheduled, /计划切换预热/);
  assert.doesNotMatch(scheduled, /择优门槛/);
  const hybrid = render(group("hybrid"));
  assert.match(hybrid, /择优门槛/);
  assert.match(hybrid, /计划切换预热/);
  assert.match(hybrid, /预检不过就不切，继续走当前这条/);
  for (const mode of ["failover", "scheduled", "manual", "smart", "hybrid", "weighted"] as RouteMode[]) {
    const html = render(group(mode));
    assert.match(html, /切换时旧连接怎么办[^]*?平滑切换[^]*?快速切换[^]*?强制切换/, `${mode} 少了旧连接三选一`);
    assert.match(html, /几条一起用[^]*?一次走一条[^]*?聚合[^]*?复制/, `${mode} 少了几条一起用`);
  }
});

test("应急指定钉着时，时段表那一行写明被压着，「一直」说清楚压住的是时段表和评分", () => {
  const html = render(group("scheduled", { pin: { index: 0, untilMs: null } }));
  assert.equal(stateOf(html, "policy-pin"), "deciding");
  assert.match(html, /被人工指定压着/);
  assert.match(html, /aria-pressed="true"[^>]*>一直</);
  assert.match(html, /时段表和评分都不会再改变首选/);
});

test("探测地址填在线路上，一条线路一格", () => {
  const html = render(group("failover", {}, [
    { ...newRoutePath(0), probe: { ip: "10.95.0.10", port: 8443 } },
    newRoutePath(1),
  ]));
  assert.match(html, /aria-label="主线路 的探测地址"[^>]*value="10\.95\.0\.10:8443"/);
  assert.equal(count(html, /placeholder="留空就探拨号地址"/g), 2);
  assert.match(html, /每台中转探它的下一跳/);
  assert.match(render(group("failover", {}, [newRoutePath(0), newRoutePath(1)]), true, "udp"), /placeholder="留空就 ping 拨号地址"/);
});

test("提交的那份按模式归零：时段表只在定时 / 混合，指定不在权重负载，解析出来的 dial / issue 不发；有线路就带上线路", () => {
  const scheduled = routeGroupPayload(group("scheduled", { pin: { index: 1, untilMs: null } }));
  assert.equal(scheduled.schedule?.windows.length, 1);
  assert.deepEqual(scheduled.pin, { index: 1, untilMs: null });
  assert.ok(!("dial" in scheduled.paths[0]) && !("issue" in scheduled.paths[0]));
  assert.ok(!("lines" in scheduled), "没动过的老草稿不带线路：服务端照旧按路径存");
  const weighted = routeGroupPayload(group("weighted", { schedule: group("scheduled").policy.schedule, pin: { index: 1, untilMs: null } }));
  assert.equal(weighted.schedule, null);
  assert.equal(weighted.pin, null);
  assert.equal(routeGroupPayload(group("failover", { schedule: group("scheduled").policy.schedule })).schedule, null);
  const withLines = group();
  const payload = routeGroupPayload({ ...withLines, lines: routeLinesFromPaths(withLines.paths) });
  assert.equal(payload.lines?.length, 2);
  assert.deepEqual(payload.lines?.[0].layers, [{ kind: "hosts", hostIds: [2], pick: "order" }]);
});

test("线路详情里「添加备用线路 / 拖动排序 / 怎么切 / 高级策略」收起来（照效果图 ①，2.3.499）：收起时只剩线路几行；规则表单里一直都在", () => {
  const closed = render(group("smart"), false, "tcp", { groupSettingsOpen: false });
  assert.equal(count(closed, /data-testid="route-line"/g), 2, "线路几行照旧");
  assert.doesNotMatch(closed, /添加备用线路|拖动备 1 排序|data-testid="route-line-mode"|data-testid="route-advanced"/);
  const open = render(group("smart"), false);
  assert.match(open, /添加备用线路/);
  assert.match(open, /拖动备 1 排序/);
  assert.match(open, /data-testid="route-line-mode"/);
  assert.match(open, /data-testid="route-advanced"/);
});

test("线路改了，钉子和时段表的目标跟着线路走：同一条路径优先，线路多展开一条也不挪到别的线路上，线路删了是 null", () => {
  const before = [{ key: "main", lineKey: "main" }, { key: "b1", lineKey: "b1" }];
  // 主线路那一跳多并列了一台：主线路展开成两条，备用 1 往后挪了一位
  const after = [{ key: "main-aaa", lineKey: "main" }, { key: "main-bbb", lineKey: "main" }, { key: "b1", lineKey: "b1" }];
  assert.equal(followRoutePath(before, after, 1), 2, "钉在备用 1 上的还在备用 1（以前夹下标会变成主线路的第二条）");
  assert.equal(followRoutePath(before, after, 0), 0);
  assert.equal(followRoutePath(before, [{ key: "main", lineKey: "main" }], 1), null, "备用 1 删掉了：不改钉到别的线路上");
  assert.equal(followRoutePath([{ key: "p1" }, { key: "p2" }], [{ key: "x", lineKey: "l1" }], 1), 0, "老草稿的路径没有线路归属：对不上照旧夹到范围里");
  assert.equal(routePathIndexFor(after, { key: "main-bbb", lineKey: "main" }), 1, "同一条路径还在就是它");
  assert.equal(routePathIndexFor(after, { key: "gone", lineKey: "b1" }), 2, "路径没了按线路找第一条");
  assert.equal(routePathIndexFor(after, { key: "gone", lineKey: "b9" }), -1);
});

test("摘要只列和模板不一样的", () => {
  const policy = applyRouteMode(newRouteGroupDraft({ timezone: TZ }).policy, "failover", { timezone: TZ, pathCount: 2 });
  assert.deepEqual(summarizeRouteAdvanced({ policy, probes: 0 }), []);
  assert.deepEqual(routeTemplateGuards("failover").minHoldSeconds, 600);
  assert.deepEqual(summarizeRouteAdvanced({ policy: { ...policy, minHoldSeconds: 0, autoFailback: false }, probes: 2 }), ["不限驻留", "恢复后不切回", "探测地址 2 条"]);
});

test("落地选了我的节点：落地那格写节点名，旁边照样能再加一个", () => {
  const value = group();
  value.paths[0] = { ...value.paths[0], destNodeId: 7, dest: { ip: "203.0.113.7", port: 443 } };
  const html = render(value, true, "tcp", { nodeOptions: [{ id: 7, name: "HK 落地", address: "203.0.113.7", port: 443, protocol: "VLESS" }] });
  assert.match(html, /data-testid="route-line-dest"[^]*?HK 落地/);
  assert.doesNotMatch(html, /title="规则自己的目标"/, "主线路的落地是节点，不是规则目标");
  assert.match(html, /data-testid="route-line-dest-add"/);
});

test("每段的毫秒从外面给（编辑框套的那一层）：给了就写在候选和落地后面，刚测完的整链也写出来", () => {
  const useStub: SegmentLatencyHook = () => ({
    latencyOf: (key) => (key === "1>2" ? 23 : key === "2>dest" ? 41 : undefined),
    testingKey: null,
    test: () => {},
    lastRun: { totalMs: 64, viaTunnel: false, errors: [] },
  });
  const html = renderToStaticMarkup(
    <SegmentLatencyContext.Provider value={useStub}>
      <RouteGroupFields value={group()} onChange={() => {}} hosts={hosts} entryHostId={1} mainAddress="10.95.0.10:443" policy={null} scheduleTimeZone={TZ} nowMs={NOW} timeZone={TZ} />
    </SegmentLatencyContext.Provider>,
  );
  assert.match(html, /JP relay 02<\/span><span[^>]*>23</);
  assert.match(html, />41</);
  assert.match(html, /data-testid="route-line-test-total"[^>]*>刚测的这条整链约 <b[^>]*>64 ms/);
  assert.doesNotMatch(render(group()), /data-testid="route-line-test-total"/, "没套那一层（单测）就没有数，照样画得出来");
});

test("线路详情里直接改：给了每条线路的状态，就替掉备用行上「参与切换」的勾；还没保存的新线路返回 null，照旧是勾", () => {
  const draft = group();
  const lines = [...routeLinesFromPaths(draft.paths), newRouteLine(2)];
  const known = new Set(lines.slice(0, 2).map((line) => line.key));
  const html = render({ ...draft, lines }, false, "tcp", {
    renderLineStatus: (line, index) => (known.has(line.key) ? <span data-testid="line-status">状态{index}</span> : null),
  });
  assert.equal(count(html, /data-testid="line-status"/g), 2, "主线路、备 1 各一份");
  assert.match(html, /状态0[^]*?aria-label="主线路的名字"[^]*?data-testid="route-line-test"/, "主线路的状态在那一行上，名字和 ⚡ 在展开的那块里");
  assert.equal(count(html, /参与切换/g), 1, "只剩还没保存的备 2 是勾");
  assert.match(html, /aria-label="备 2 参与切换"/);
});

test("收着的备用行只有路径和状态（⚡ 在展开的那块里）；一跳一个候选不问怎么挑；不再给「可跳过」的勾，勾过的能取消", () => {
  const html = render(group(), false);
  assert.equal(count(html, /data-testid="route-line-test"/g), 1, "只有主线路卡上有 ⚡");
  assert.match(html, /data-testid="route-line-open"/, "备用行整行点开");
  assert.doesNotMatch(html, /最低延迟|按顺序（/, "一个候选没得挑");
  assert.doesNotMatch(html, /可跳过/);
  assert.match(html, /\+ 加中转/, "「再加一层」改叫「加中转」，在链上最后一个中转和落地之间");
  const lines = routeLinesFromPaths(group().paths);
  lines[0] = { ...lines[0], layers: [{ ...lines[0].layers[0], kind: "hosts", hostIds: [2, 3], skippable: true }] };
  const multi = render({ ...group(), lines }, false);
  assert.match(multi, /aria-label="中转怎么挑"/, "两个候选才问怎么挑");
  assert.match(multi, /aria-label="中转可跳过，点一下取消"/, "老配置勾过的照样显示，点一下取消");
});

test("线路详情里主线路也收成一行：都收着，点开才改；此刻在走的那条描边", () => {
  const draft = group();
  const lines = routeLinesFromPaths(draft.paths);
  const html = render({ ...draft, lines }, false, "tcp", {
    renderLineStatus: (line) => <span data-testid="line-status">{line.key}</span>,
    activeLineKey: lines[1].key,
    startCollapsed: true,
  });
  assert.equal(count(html, /data-testid="route-line-open"/g), 2, "主线路、备 1 都是一行");
  assert.match(html, /aria-expanded="false" aria-label="展开改主线路：/);
  assert.doesNotMatch(html, /aria-label="主线路的名字"|data-testid="route-line-test"/, "收着的时候名字和 ⚡ 都不出来");
  assert.equal(count(html, /data-state="on"/g), 1, "只有在走的那条描边");
  assert.match(html, /data-state="on"[^>]*>(?:(?!data-testid="route-line-open")[^])*?备 1/, "描边的是备 1（此刻在走的）");
});

test("线路展开后是一条竖着的链：入口 → 中转 → 加中转 → 落地；落地还是规则目标时是「换落地」", () => {
  const html = render(group(), false);
  const chain = html.slice(html.indexOf('data-testid="route-line-chain"'));
  const order = ["入口", "中转", "+ 加中转", "落地"].map((text) => chain.indexOf(`>${text}<`));
  assert.ok(order.every((index) => index > 0), `都在链上：${order.join(",")}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "按链的顺序摆");
  assert.match(chain, />换落地</, "落地还是规则目标：换一个");
  assert.match(html, /data-testid="route-line-test"[^>]*>[^]*?测一下/, "⚡ 带字：测一下");
});

test("节点池那一跳：平时一个「池 · 名字 · N 台」（池里的机器不和别的混在一排），点开才是一列", () => {
  const pools = [{ id: 7, name: "香港中转池", role: "relay", members: [
    { hostId: 2, name: "JP relay 02", online: true, maintenance: false },
    { hostId: 3, name: "SG relay 03", online: true, maintenance: true },
  ] }];
  const draft = group();
  const lines = routeLinesFromPaths(draft.paths);
  lines[0] = { ...lines[0], layers: [{ ...lines[0].layers[0], kind: "pool", poolId: 7, hostIds: [], tunnelIds: [] }] };
  const html = render({ ...draft, lines }, false, "tcp", { pools });
  assert.match(html, /data-testid="route-line-pool"[^>]*>[^]*?池 · 香港中转池 · 2 台/);
  assert.match(html, /aria-expanded="false"[^>]*data-testid="route-line-pool"|data-testid="route-line-pool"[^>]*aria-expanded="false"|aria-expanded="false" title="看池里有哪几台"/);
  assert.doesNotMatch(html, /data-testid="route-line-pool-members"/, "收着：池里的机器不摊开");
  assert.doesNotMatch(html, /route-line-add-candidate/, "池那一跳没有「+ 并列」");
  // 机器那一跳：「+ 并列」只放机器、隧道，菜单里没有节点池（换池在点机器的菜单里）
  const plain = render(draft, false, "tcp", { pools });
  assert.match(plain, /data-testid="route-line-add-candidate"/);
});

test("同一跳并列的几台在展开后放进一个胶囊（Jinx / jinx）：胶囊里挑一台；收起那一行照旧", () => {
  const draft = group();
  const lines = routeLinesFromPaths(draft.paths);
  lines[0] = { ...lines[0], layers: [{ ...lines[0].layers[0], kind: "hosts", hostIds: [2, 3] }] };
  const html = render({ ...draft, lines }, false);
  assert.match(html, /data-grouped="true"[^>]*>[^]*?JP relay 02[^]*?>\/<[^]*?SG relay 03/, "两台在一个胶囊里，用 / 隔开");
  assert.match(html, /data-grouped="true"[^]*?aria-label="中转怎么挑"/, "怎么挑在胶囊下面一行");
  assert.match(html, /HK entry 01 → JP relay 02 等 2 个 → 落地/, "收起那一行的写法不变");
  const single = render(group(), false);
  assert.doesNotMatch(single, /data-grouped="true"/, "只有一台：普通胶囊");
});
