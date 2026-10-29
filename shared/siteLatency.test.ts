import assert from "node:assert/strict";
import test from "node:test";

import { mergeSiteSamples, normalizeSiteLatencyReport, siteLatencyNoEgress, summarizeSiteSamples } from "./siteLatency";

const NOW = 1_800_000_000_000;

test("合并：按时刻去重、排序、只留最近 keep 个，未来的时刻不要", () => {
  const merged = mergeSiteSamples(
    [{ at: NOW - 3000, ms: 30 }, { at: NOW - 2000, ms: 31 }],
    [{ at: NOW - 2000, ms: 99 }, { at: NOW - 1000, ms: null, fail: "timeout" }, { at: NOW + 10 * 60_000, ms: 1 }],
    NOW,
    2,
  );
  assert.deepEqual(merged, [{ at: NOW - 2000, ms: 99 }, { at: NOW - 1000, ms: null, fail: "timeout" }]);
});

test("汇总：最近一次、中位数、丢失率和分档", () => {
  assert.equal(summarizeSiteSamples([]).tone, "off");
  const fine = summarizeSiteSamples([{ at: 1, ms: 40 }, { at: 2, ms: 60 }, { at: 3, ms: 50 }]);
  assert.deepEqual([fine.latestMs, fine.medianMs, fine.lossPct, fine.tone], [50, 50, 0, "ok"]);
  const lossy = summarizeSiteSamples([{ at: 1, ms: 40 }, { at: 2, ms: null }, { at: 3, ms: 50 }, ...Array.from({ length: 7 }, (_, i) => ({ at: 4 + i, ms: 45 }))]);
  assert.equal(lossy.lossPct, 10);
  assert.equal(lossy.tone, "down", "丢 10% 算差");
  assert.equal(summarizeSiteSamples([{ at: 1, ms: 200 }]).tone, "warn");
  assert.equal(summarizeSiteSamples([{ at: 1, ms: 400 }]).tone, "down");
  const failed = summarizeSiteSamples([{ at: 1, ms: 40 }, { at: 2, ms: null, fail: "dns" }]);
  assert.equal(failed.latestMs, null);
  assert.equal(failed.latestFail, "dns");
  assert.equal(failed.tone, "down");
});

test("收 Agent 的报告：只认已知站点，负数当没连上，坏时刻丢掉", () => {
  const report = normalizeSiteLatencyReport({ targets: [
    { key: "google", samples: [{ t: NOW, ms: 12.6 }, { t: NOW + 1, ms: -1, f: "refused" }, { t: "x", ms: 3 }] },
    { key: "evil", samples: [{ t: NOW, ms: 1 }] },
    { key: "baidu", samples: [] },
  ] });
  assert.deepEqual([...report.keys()], ["google"]);
  assert.deepEqual(report.get("google"), [{ at: NOW, ms: 13 }, { at: NOW + 1, ms: null, fail: "refused" }]);
  assert.equal(normalizeSiteLatencyReport(null).size, 0);
});

test("2.2.240 的样本：丢失率按握手次数算，最近一次带 n/k", () => {
  const report = normalizeSiteLatencyReport({ targets: [
    { key: "google", samples: [{ t: NOW, ms: 30, n: 3, k: 2 }, { t: NOW + 1, ms: -1, f: "poisoned", n: 3 }, { t: NOW + 2, ms: 31, n: 3, k: 9 }] },
  ] });
  const samples = report.get("google")!;
  assert.deepEqual(samples, [
    { at: NOW, ms: 30, tries: 3, ok: 2 },
    { at: NOW + 1, ms: null, fail: "poisoned", tries: 3, ok: 0 },
    { at: NOW + 2, ms: 31, tries: 3, ok: 3 },
  ]);
  const summary = summarizeSiteSamples(samples);
  // 9 次里连上 5 次
  assert.equal(summary.lossPct, 44.4);
  assert.deepEqual([summary.latestTries, summary.latestOk], [3, 3]);
  // 老样本和新样本混着：老的按一次算
  assert.equal(summarizeSiteSamples([{ at: 1, ms: 20 }, { at: 2, ms: 20, tries: 3, ok: 1 }]).lossPct, 50);
});

test("出不去的主机：所有站点整个窗口都没连上过", () => {
  const down = summarizeSiteSamples([{ at: 1, ms: null, fail: "timeout" }, { at: 2, ms: null, fail: "timeout" }]);
  const flaky = summarizeSiteSamples([{ at: 1, ms: 40 }, { at: 2, ms: null, fail: "timeout" }]);
  assert.equal(siteLatencyNoEgress([down, down, down, down]), true);
  assert.equal(siteLatencyNoEgress([down, flaky]), false, "有一个站点窗口里连上过，就不是出不去");
  assert.equal(siteLatencyNoEgress([]), false);
});
