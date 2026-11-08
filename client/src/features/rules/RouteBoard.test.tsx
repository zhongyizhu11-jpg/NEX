import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { newRouteGroupDraft, routeGroupRuleFields, type RouteGroup } from "@shared/routeGroup";
import { describeRoutePolicy } from "@shared/routePolicy";
import { RouteMiniChain, describeRouteLoad, describeRouteUdpSplit, routeBoardActiveChain, summarizeRouteChain, type RouteBoardPath } from "./RouteBoard";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const draft = newRouteGroupDraft({ timezone: "Asia/Shanghai" });
const group: RouteGroup = {
  paths: [
    { ...draft.paths[0], hops: [2, 3], dial: { ip: "203.0.113.2", port: 25311 } },
    { ...draft.paths[1], name: "直连备用", hops: [], dial: { ip: "10.95.0.10", port: 443 } },
  ],
  policy: { ...draft.policy, mode: "failover" },
};
const rule = { failoverEnabled: true, targetIp: "10.95.0.10", targetPort: 443, ...routeGroupRuleFields(group, { targetIp: "10.95.0.10", targetPort: 443 }) };

function path(index: number, patch: Partial<RouteBoardPath> = {}): RouteBoardPath {
  const source = group.paths[index];
  return {
    key: source.key,
    index,
    letter: index === 0 ? "A" : "B",
    name: source.name,
    hops: source.hops.map((hostId, hopIndex) => ({
      hostId,
      name: hostId === 2 ? "HK relay" : "JP relay",
      port: 25310 + hopIndex,
      running: true,
      enabled: true,
      ok: true,
      latencyMs: 20 + hopIndex * 10,
      consecutiveFailures: 0,
      probedAt: NOW - 20_000,
      nextLabel: hopIndex === source.hops.length - 1 ? "落地" : "JP relay",
      rate: { inBps: 15_000 * (hopIndex + 1), outBps: 1_200, connections: 3, at: NOW - 5_000 },
    })),
    dest: { ip: "10.95.0.10", port: 443 },
    probe: null,
    weight: 50,
    score: index === 0 ? 92 : 70,
    latencyMs: index === 0 ? 23 : 144,
    lossPct: 0,
    jitterMs: 3,
    availabilityPct: 100,
    healthy: true,
    down: false,
    downReason: "",
    connections: index === 0 ? 8 : 0,
    active: index === 0,
    prewarming: false,
    probedAt: NOW - 10_000,
    ...patch,
  };
}

test("链拆成段：入口探第一跳 + 每台中转探下一跳；整链是各段相加", () => {
  const chain = summarizeRouteChain(path(0));
  assert.deepEqual(chain.segments.map((segment) => [segment.state, segment.latencyMs]), [["measured", 23], ["measured", 20], ["measured", 30]]);
  assert.equal(chain.totalMs, 73);
  assert.equal(chain.partial, false);
  assert.equal(chain.broken, false);
});

test("一段没人探就是「未测」、整链写部分；探不通是「不通」且整链算断", () => {
  const untested = summarizeRouteChain(path(0, { hops: path(0).hops.map((hop, index) => (index === 1 ? { ...hop, ok: null, latencyMs: null } : hop)) }));
  assert.equal(untested.segments[2].state, "unknown");
  assert.equal(untested.totalMs, 43);
  assert.equal(untested.partial, true);
  const broken = summarizeRouteChain(path(0, { hops: path(0).hops.map((hop, index) => (index === 0 ? { ...hop, ok: false, latencyMs: null, consecutiveFailures: 4 } : hop)) }));
  assert.equal(broken.segments[1].state, "failed");
  assert.equal(broken.segments[1].failures, 4);
  assert.equal(broken.broken, true);
});

test("自定探测目标时第一段不算实测，整链用入口探到的那个数", () => {
  const chain = summarizeRouteChain(path(0, { probe: { ip: "1.1.1.1", port: 443 }, latencyMs: 88 }));
  assert.equal(chain.segments[0].state, "unknown");
  assert.equal(chain.totalMs, 88);
  assert.equal(chain.partial, false);
});

test("主机负载药丸：沿途有一台忙到 70% 以上才显示，95% 起染红，title 写扣了几分；老 Agent 没报就没有", () => {
  assert.equal(describeRouteLoad(null), null);
  assert.equal(describeRouteLoad(undefined), null);
  assert.equal(describeRouteLoad(69), null, "70% 以下评分不扣，不显示");
  const warm = describeRouteLoad(85)!;
  assert.equal(warm.text, "负载 85%");
  assert.equal(warm.tone, "warn");
  assert.equal(warm.penalty, 9);
  assert.match(warm.title, /评分扣 9 分/);
  const hot = describeRouteLoad(97)!;
  assert.equal(hot.tone, "down");
  assert.equal(hot.penalty, 15);
});

test("规则卡上的迷你链：一行一条，段上写延迟、不通写 ✕，在走的那条标出来", () => {
  const html = renderToStaticMarkup(
    <RouteMiniChain
      status={{ paths: [path(0), path(1, { healthy: false, hops: [{ ...path(1).hops[0], ok: false, consecutiveFailures: 4 }] })], entry: { hostId: 1, name: "HK entry 01", online: true, sourcePort: 10001 } }}
      policy={describeRoutePolicy(rule, { host: { isOnline: true }, nowMs: NOW })!}
      onOpen={() => {}}
    />,
  );
  const rows = html.split("<li ").slice(1);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /HK entry 01[^]*?>23<[^]*?HK relay[^]*?>20<[^]*?JP relay[^]*?>30<[^]*?落地/);
  assert.match(rows[0], />在走</);
  assert.match(rows[0], /73 ms/);
  assert.match(rows[1], /data-state="failed"/);
  assert.match(rows[1], />✕</);
});

test("规则卡的延迟标签用当前在走那条路径的整链：各段相加，没有在走的就没有", () => {
  const active = routeBoardActiveChain({ paths: [path(0), path(1)] });
  assert.equal(active?.totalMs, 73);
  assert.equal(active?.partial, false);
  assert.equal(routeBoardActiveChain({ paths: [path(1)] }), null);
  assert.equal(routeBoardActiveChain(null), null);
});

test("TCP+UDP 两侧结论不一致时路径上标「UDP 不通」/「仅 UDP 通」；一致或老 Agent 没报就不标", () => {
  assert.equal(describeRouteUdpSplit(path(0)), null, "老 Agent 没报 udpHealthy");
  assert.equal(describeRouteUdpSplit(path(0, { udpHealthy: true })), null, "两侧都通");
  assert.equal(describeRouteUdpSplit(path(0, { healthy: true, udpHealthy: false }))?.text, "UDP 不通");
  assert.equal(describeRouteUdpSplit(path(0, { healthy: false, udpHealthy: true, udpLatencyMs: 12 }))?.text, "仅 UDP 通");
  assert.equal(describeRouteUdpSplit(path(0, { down: true, healthy: false, udpHealthy: true })), null, "断了的路径交给「断了」说");
  const policy = describeRoutePolicy(rule, { host: { isOnline: true }, nowMs: NOW })!;
  const mini = renderToStaticMarkup(<RouteMiniChain status={{ paths: [path(0, { udpHealthy: false }), path(1)] }} policy={policy} onOpen={() => {}} />);
  assert.match(mini, /在走 · UDP 不通/);
});
