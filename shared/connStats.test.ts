import assert from "node:assert/strict";
import test from "node:test";

import {
  addConnStats,
  connStatsToCsv,
  bytesToMbps,
  formatConnBytes,
  normalizeConnLegVia,
  emptyConnStatsAggregate,
  estimateConnPercentile,
  normalizeConnEndpoint,
  summarizeConnStats,
} from "./connStats";

test("汇总：成功率、平均耗时只按成功的算、分位数按分档估", () => {
  const aggregate = emptyConnStatsAggregate();
  addConnStats(aggregate, { attempts: 10, failures: 1, sumMs: 900, maxMs: 1500, buckets: [5, 2, 0, 0, 1, 1] });
  addConnStats(aggregate, { attempts: 10, failures: 1, sumMs: 900, maxMs: 300, buckets: [9, 0, 0, 0, 0, 0] });
  const summary = summarizeConnStats(aggregate);
  assert.equal(summary.attempts, 20);
  assert.equal(summary.successRate, 90);
  assert.equal(summary.avgMs, 100);
  assert.equal(summary.p50Ms, 50);
  assert.equal(summary.p95Ms, 1500); // 第 18 个样本落在「1000 以上」那档，报观测到的最大值
  assert.equal(summary.maxMs, 1500);
  assert.equal(estimateConnPercentile(aggregate, 1), 1500);
});

test("没有样本时都是 null", () => {
  const summary = summarizeConnStats(emptyConnStatsAggregate());
  assert.equal(summary.successRate, null);
  assert.equal(summary.avgMs, null);
  assert.equal(summary.p95Ms, null);
});

test("端点只收 host:port", () => {
  assert.equal(normalizeConnEndpoint("203.0.113.1:443"), "203.0.113.1:443");
  assert.equal(normalizeConnEndpoint("[2001:db8::1]:443"), "[2001:db8::1]:443");
  assert.equal(normalizeConnEndpoint("hk.example.com:8443"), "hk.example.com:8443");
  assert.equal(normalizeConnEndpoint("-"), "-");
  assert.equal(normalizeConnEndpoint("<script>"), null);
  assert.equal(normalizeConnEndpoint("a b:1"), null);
});

test("CSV 带表头", () => {
  const csv = connStatsToCsv([{ hostName: "港-1", role: "entry", stage: "tcp", endpoint: "1.2.3.4:443", ruleId: 3, lastError: "timeout", summary: summarizeConnStats(addConnStats(emptyConnStatsAggregate(), { attempts: 2, failures: 1, sumMs: 40, maxMs: 40, buckets: [1, 0, 0, 0, 0, 0] })) }]);
  const lines = csv.replace(/^﻿/, "").trim().split("\n");
  assert.equal(lines[0], "host,role,stage,endpoint,ruleId,attempts,failures,successRate,avgMs,p50Ms,p95Ms,maxMs,lastError,via,bytesUp,bytesDown");
  assert.equal(lines[1], "港-1,entry,tcp,1.2.3.4:443,3,2,1,50,40,50,50,40,timeout,,0,0");
});

test("每一路：via 只认 relay#N / stream#N，速率按 Mbps 算", () => {
  assert.equal(normalizeConnLegVia("relay#12"), "relay#12");
  assert.equal(normalizeConnLegVia("stream#3"), "stream#3");
  assert.equal(normalizeConnLegVia("relay#"), "");
  assert.equal(normalizeConnLegVia("<b>"), "");
  assert.equal(bytesToMbps(125_000_000, 1), 1000);
  assert.equal(bytesToMbps(0, 60), 0);
  assert.equal(formatConnBytes(5 * 1024 * 1024), "5.0 MB");
});
