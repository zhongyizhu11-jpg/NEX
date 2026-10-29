import assert from "node:assert/strict";
import test from "node:test";

import { mergeSiteSamples, normalizeSiteLatencyReport, summarizeSiteSamples } from "./siteLatency";

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
