import assert from "node:assert/strict";
import test from "node:test";
import { liveQueriesForTopics, parseLiveStream } from "./liveEvents";

test("实时通知：上报只刷「现在」的几份，改配置刷整个模块", () => {
  assert.deepEqual(liveQueriesForTopics(["rules.live"]), ["rules.trafficSummary", "rules.routeStatus"]);
  assert.deepEqual(liveQueriesForTopics(["balance"]).sort(), ["rules.trafficSummary", "tunnels.exitTargets"]);
  // 整个 rules 模块都刷了，就不用再单独刷 trafficSummary
  assert.deepEqual(liveQueriesForTopics(["mutation:rules", "rules.live", "balance"]).sort(), ["rules.*", "tunnels.exitTargets"]);
  assert.deepEqual(liveQueriesForTopics(["不认识的"]), []);
});

test("实时通知：按 text/event-stream 拆，半截的留到下一次", () => {
  const first = parseLiveStream('retry: 3000\n\n: ping\n\nevent: change\ndata: {"topics":["rules.live","balance"]}\n\nevent: change\ndata: {"top');
  assert.deepEqual(first.topics, ["rules.live", "balance"]);
  const second = parseLiveStream(first.rest + 'ics":["tunnels.live"]}\r\n\r\n');
  assert.deepEqual(second.topics, ["tunnels.live"]);
  assert.equal(second.rest, "");
  assert.deepEqual(parseLiveStream("event: change\ndata: {不是 JSON}\n\n").topics, []);
});
