import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { newRouteGroupDraft, routeGroupRuleFields, type RouteGroup } from "@shared/routeGroup";
import { describeRoutePolicy } from "@shared/routePolicy";
import { RouteBoardCard, RouteMiniChain, RoutePathCards, RouteSwitchChip, buildRoutePreviewStatus, describeRouteDials, routeBoardActiveChain, summarizeRouteChain, type RouteBoardPath } from "./RouteBoard";

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

test("线路板卡：规则名、入口机、策略、切换次数、每个节点的速率；备用路径写「空闲」", () => {
  const policy = describeRoutePolicy(rule, { host: { isOnline: true, agentVersion: "2.2.198" }, nowMs: NOW })!;
  const html = renderToStaticMarkup(
    <RouteBoardCard
      name="美国游戏线路"
      status={{
        paths: [path(0), path(1)],
        entry: { hostId: 1, name: "HK entry 01", online: true, sourcePort: 10001 },
        rate: { inBps: 15_000, outBps: 1_200, connections: 8, at: NOW - 3_000 },
        switches: { count24h: 6, count1h: 0, manual24h: 6, flapping: false, lastAt: NOW - 3_600_000, lastFromLabel: "A", lastToLabel: "B", lastReason: "pin" },
      }}
      policy={policy}
      onOpen={() => {}}
    />,
  );
  assert.match(html, /美国游戏线路/);
  assert.match(html, /HK entry 01<span[^>]*>:10001</);
  assert.match(html, /稳定优先 · 自动故障切换 · 2 条路径/);
  assert.match(html, /24h 切换 ×6 · 人工 ×6/);
  const cards = html.split('data-testid="route-path-card"');
  assert.equal(cards.length, 3);
  // 在走的 A：入口写规则的速率，中转写各自中继的，落地写最后一跳的。
  assert.match(cards[1], /↓ 14\.65 KB\/s[^]*?HK relay[^]*?↓ 14\.65 KB\/s[^]*?JP relay[^]*?↓ 29\.3 KB\/s[^]*?落地[^]*?↓ 29\.3 KB\/s/);
  assert.match(cards[1], /整链 73 ms/);
  // 备用的 B 直连：一段，空闲。
  assert.match(cards[2], /直连备用/);
  assert.match(cards[2], /144 ms/);
  assert.equal((cards[2].match(/>空闲</g) || []).length, 2, "入口和落地两个节点都写空闲");
  assert.doesNotMatch(cards[2], /fx-rb-flow/);
  assert.match(cards[1], /fx-rb-flow/, "在走的那条有流动的小点");
});

test("来回漂的线路组在切换药丸上说出来", () => {
  const html = renderToStaticMarkup(<RouteSwitchChip switches={{ count24h: 5, count1h: 4, manual24h: 0, flapping: true, lastAt: NOW - 60_000, lastFromLabel: "A", lastToLabel: "B", lastReason: "score" }} />);
  assert.match(html, /24h 切换 ×5 · 来回漂/);
  assert.match(html, /data-tone="warn"/);
  const quiet = renderToStaticMarkup(<RouteSwitchChip switches={{ count24h: 0, count1h: 0, manual24h: 0, flapping: false, lastAt: null, lastFromLabel: null, lastToLabel: null, lastReason: null }} />);
  assert.match(quiet, /24h 没切过/);
});

test("真实连接的拨号药丸：有失败或慢的染琥珀，没拨过不显示，老 Agent 没有这项", () => {
  assert.equal(describeRouteDials(null), null);
  assert.equal(describeRouteDials(undefined), null);
  assert.equal(describeRouteDials({ ok: 0, failed: 0, slow: 0, dialMs: 0, lastAt: 0 }), null);
  const fine = describeRouteDials({ ok: 120, failed: 0, slow: 0, dialMs: 28, lastAt: NOW })!;
  assert.equal(fine.text, "建连 120 · 拨号 28 ms");
  assert.equal(fine.tone, "ok");
  const bad = describeRouteDials({ ok: 12, failed: 3, slow: 2, dialMs: 640, lastAt: NOW })!;
  assert.equal(bad.text, "建连 12 · 失败 3 · 慢 2 · 拨号 640 ms");
  assert.equal(bad.tone, "warn");
  assert.match(bad.title, /拨不通 3 次、拨得慢 2 次/);
  const policy = describeRoutePolicy(rule, { host: { isOnline: true, agentVersion: "2.2.237" }, nowMs: NOW })!;
  const html = renderToStaticMarkup(
    <RouteBoardCard
      name="美国游戏线路"
      status={{
        paths: [path(0, { dials: { ok: 12, failed: 3, slow: 2, dialMs: 640, lastAt: NOW } }), path(1)],
        entry: { hostId: 1, name: "HK entry 01", online: true, sourcePort: 10001 },
        rate: null,
        switches: { count24h: 0, count1h: 0, manual24h: 0, flapping: false, lastAt: null, lastFromLabel: null, lastToLabel: null, lastReason: null },
      }}
      policy={policy}
      onOpen={() => {}}
    />,
  );
  assert.equal((html.match(/data-testid="route-dials"/g) || []).length, 1, "只有报了拨号的路径有药丸");
  assert.match(html, /data-tone="warn"[^>]*data-testid="route-dials">建连 12 · 失败 3 · 慢 2 · 拨号 640 ms/);
});

test("预览：拿还没保存的路径画链，每段「—」、不写在走、首选写「平时走它」", () => {
  const status = buildRoutePreviewStatus({
    paths: [
      { key: "a", name: "", hops: [2, 3], dest: null, weight: 50, probe: null },
      { key: "b", name: "备用线路", hops: [], dest: { ip: "203.0.113.9", port: 8443 }, weight: 50, probe: null },
    ],
    hosts: [{ id: 1, name: "HK entry" }, { id: 2, name: "HK relay" }, { id: 3, name: "JP relay" }],
    entryHostId: 1,
    sourcePort: 10001,
    mainAddress: "10.95.0.10:443",
  });
  assert.equal(status.entry?.name, "HK entry");
  assert.deepEqual(status.paths[0].dest, { ip: "10.95.0.10", port: 443 }, "没写落地的路径走规则目标");
  assert.equal(status.paths[0].hops[0].nextLabel, "JP relay");
  const policy = describeRoutePolicy(rule, { host: { isOnline: true, agentVersion: "2.2.237" }, nowMs: NOW })!;
  const html = renderToStaticMarkup(<RoutePathCards preview status={status} policy={policy} />);
  assert.equal((html.match(/data-preview=""/g) || []).length, 2);
  assert.match(html, /平时走它/);
  assert.doesNotMatch(html, />在走</);
  assert.doesNotMatch(html, /未测/, "预览里的段不是「未测」");
  assert.equal((html.match(/data-state="planned"/g) || []).length, 4, "A 三段、B 一段");
  assert.doesNotMatch(html, /空闲/, "预览没有速率那一行");
  assert.match(html, /主线路/);
  assert.match(html, /203\.0\.113\.9:8443/);
});

test("规则卡上的迷你链：一行一条，段上写延迟、不通写 ✕，在走的那条标出来", () => {
  const html = renderToStaticMarkup(
    <RouteMiniChain
      status={{ paths: [path(0), path(1, { healthy: false, hops: [{ ...path(1).hops[0], ok: false, consecutiveFailures: 4 }] })], entry: { hostId: 1, name: "HK entry 01", online: true, sourcePort: 10001 } }}
      policy={describeRoutePolicy(rule, { host: { isOnline: true, agentVersion: "2.2.237" }, nowMs: NOW })!}
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
