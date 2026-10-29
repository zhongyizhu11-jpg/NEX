import assert from "node:assert/strict";
import test from "node:test";

import { getSiteLatencySamples, ingestSiteLatencyReport, resetSiteLatencyForTest, siteLatencyDirectiveFor, siteLatencySince } from "./siteLatency";

const NOW = 1_800_000_000_000;

test("指令：老 Agent 不给；新 Agent 拿到站点表、间隔和面板已有到哪", () => {
  resetSiteLatencyForTest();
  assert.equal(siteLatencyDirectiveFor({ id: 1, agentVersion: "2.2.236" }), undefined);
  const directive = siteLatencyDirectiveFor({ id: 1, agentVersion: "2.2.237" })!;
  assert.equal(directive.since, 0, "面板什么都没有时 since=0，Agent 整段补齐");
  assert.deepEqual(directive.targets.map((target) => target.key), ["baidu", "google", "github", "openai"]);
  assert.equal(directive.intervalSeconds, 120);
});

test("收报告：按主机按站点合并，since 跟着最新样本走，重复的不算新增", () => {
  resetSiteLatencyForTest();
  const host = { id: 7, agentVersion: "2.2.237" };
  const report = { targets: [{ key: "google", samples: [{ t: NOW - 120_000, ms: 12 }, { t: NOW, ms: 14 }] }, { key: "baidu", samples: [{ t: NOW, ms: -1, f: "timeout" }] }] };
  assert.equal(ingestSiteLatencyReport(host, report, NOW), 3);
  assert.equal(ingestSiteLatencyReport(host, report, NOW), 0, "Agent 重发同一段不重复记");
  assert.equal(siteLatencySince(7), NOW);
  assert.deepEqual(getSiteLatencySamples(7).get("baidu"), [{ at: NOW, ms: null, fail: "timeout" }]);
  assert.equal(getSiteLatencySamples(8).size, 0);
  assert.equal(siteLatencyDirectiveFor(host)!.since, NOW);
});
