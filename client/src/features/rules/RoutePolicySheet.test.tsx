import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  describeGroupRoutePolicy,
  describeRoutePolicy,
  type RoutePolicyGroup,
  type RoutePolicyGroupMember,
  type RoutePolicyRule,
} from "@shared/routePolicy";
import { RoutePolicyPanel } from "./RoutePolicySheet";

// 2026-09-22（星期二）上海 20:00：在「工作日 18:00–01:00」里。
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const TZ = "Asia/Shanghai";
const noop = () => {};

const rule = (patch: Partial<Record<keyof RoutePolicyRule, unknown>> = {}): RoutePolicyRule => ({
  failoverEnabled: true,
  failoverStrategy: "fallback",
  targetIp: "198.51.100.7",
  targetPort: 443,
  failoverTargets: JSON.stringify([{ targetIp: "198.51.100.8", targetPort: 443 }]),
  failoverSchedule: JSON.stringify({ timezone: TZ, windows: [{ days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: 1 }] }),
  failoverActiveTarget: "198.51.100.8:443",
  failoverActiveAt: new Date(NOW - 2 * 3_600_000),
  ...patch,
});

function render(patch: Parameters<typeof rule>[0] = {}, canEdit = true) {
  const policy = describeRoutePolicy(rule(patch), { host: { isOnline: true, agentVersion: "2.2.197" }, nowMs: NOW, timeZone: TZ })!;
  return renderToStaticMarkup(
    <RoutePolicyPanel policy={policy} canEdit={canEdit} nowMs={NOW} timeZone={TZ} />,
  );
}

test("此刻起作用的那一行高亮，而且只有一行", () => {
  const html = render();
  assert.equal((html.match(/data-state="deciding"/g) || []).length, 1);
  assert.equal((html.match(/>此刻</g) || []).length, 1);
  // 高亮的是时段表那一行，不是兜底的出站顺序。
  assert.match(html, /data-state="deciding"[^]*?工作日 18:00–01:00（次日）/);
});

test("钉着的时候，被压住的时段表那一行明说「被上面那条压着」", () => {
  const html = render({ failoverPinnedIndex: 0, failoverPinnedUntil: new Date(NOW + 3_600_000) });
  assert.match(html, /data-state="overridden"/);
  assert.match(html, /被上面那条压着/);
});

test("线路上标出首选和在走", () => {
  const html = render();
  assert.equal((html.match(/>首选</g) || []).length, 1);
  assert.equal((html.match(/>在走</g) || []).length, 1);
  assert.match(html, /现在走 备用 1，18:00 起/);
});

test("规则的面板不给「强制走一条」（2.3.499）：手动切换在线路详情每条线路的状态胶囊上", () => {
  assert.doesNotMatch(render(), /强制走一条|交回自动/);
  assert.doesNotMatch(render({}, false), /强制走一条|交回自动/);
});

test("轮询没有「人工指定」这一块，也不说「从上往下」", () => {
  const html = render({ failoverStrategy: "round_robin", failoverSchedule: null });
  assert.doesNotMatch(html, /人工指定|强制走|从上往下/);
  assert.match(html, /每条新连接各走各的/);
});

/* ───────── 转发组：同一块面板，说解析 ───────── */

const groupMember = (id: number, name: string, patch: Partial<RoutePolicyGroupMember> = {}): RoutePolicyGroupMember => ({
  id,
  memberType: "host",
  hostId: id,
  priority: id - 1,
  isEnabled: true,
  healthStatus: "healthy",
  lastLatencyMs: 18,
  healthySince: new Date(NOW - 3_600_000),
  ddnsValue: `203.0.113.${id}`,
  host: { name },
  ...patch,
});

function renderGroup(patch: Partial<RoutePolicyGroup> = {}, options: { ddnsSwitching?: boolean; canEdit?: boolean } = {}) {
  const policy = describeGroupRoutePolicy({
    groupMode: "failover",
    isEnabled: true,
    domain: "hk.example.com",
    recordType: "A",
    activeMemberId: 2,
    templateRuleCount: 1,
    members: [
      groupMember(1, "HK entry 01", { healthStatus: "unhealthy", failureSince: new Date(NOW - 1_800_000), healthySince: null }),
      groupMember(2, "JP entry 02"),
      groupMember(3, "SG entry 03", { isEnabled: false }),
    ],
    ...patch,
  }, { nowMs: NOW, timeZone: TZ, ddnsSwitching: options.ddnsSwitching })!;
  return renderToStaticMarkup(
    <RoutePolicyPanel policy={policy} canEdit={options.canEdit ?? true} onPrefer={noop} onReselect={noop} nowMs={NOW} timeZone={TZ} />,
  );
}

test("转发组：一节叫「成员」，点是成员自己的健康，解析指着的那个标「在用」", () => {
  const html = renderGroup();
  assert.match(html, />成员</);
  assert.doesNotMatch(html, />线路</);
  assert.match(html, /现在解析到 JP entry 02/);
  assert.match(html, /首选 HK entry 01 不健康（19:30 起），所以用的是 JP entry 02。/);
  assert.equal((html.match(/>在用</g) || []).length, 1);
  assert.match(html, /不健康，19:30 起/);
  assert.match(html, /已停用/);
  // 三个成员三种健康：故障、正常、待命 —— 不是规则那边「在走的绿、其余待命」。
  assert.match(html, /aria-label="故障"[^]*?HK entry 01[^]*?aria-label="正常"[^]*?JP entry 02[^]*?aria-label="待命"[^]*?SG entry 03/);
  assert.match(html, /按成员顺序/);
  assert.match(html, /排在最前、而且健康的成员拿到解析/);
});

test("转发组没有「人工指定 / 强制走」；手动那一块是换首选和重新选，换首选只列启用的、不是第一位的成员", () => {
  const html = renderGroup();
  assert.doesNotMatch(html, /人工指定|强制走|交回自动/);
  assert.match(html, />手动</);
  assert.match(html, /现在按顺序重新选/);
  assert.match(html, /换一个首选/);
  assert.doesNotMatch(renderGroup({}, { canEdit: false }), />手动<|重新选|换一个首选/);
});

test("组停用了：不给「重新选」（不检测不切换），顺序照样能改", () => {
  const html = renderGroup({ isEnabled: false });
  assert.doesNotMatch(html, /现在按顺序重新选/);
  assert.match(html, /换一个首选/);
});

test("没配域名时不给「重新选」（没有解析可切），换首选照样能用", () => {
  const html = renderGroup({ domain: "" });
  assert.match(html, /只看成员健康，不切换/);
  assert.doesNotMatch(html, /现在按顺序重新选/);
  assert.match(html, /换一个首选/);
  assert.doesNotMatch(html, />此刻</, "不切换就没有「此刻在起作用」的那一行");
});

test("系统 DDNS 没开：说「建议入口」，标「建议」不标「在用」", () => {
  const html = renderGroup({}, { ddnsSwitching: false });
  assert.match(html, /建议入口是 JP entry 02/);
  assert.match(html, />建议</);
  assert.doesNotMatch(html, />在用</);
});

test("规则的面板没有「手动」那一块，线路一节照旧叫「线路」", () => {
  const html = render();
  assert.doesNotMatch(html, />手动<|换一个首选|重新选/);
  assert.match(html, />线路</);
});
