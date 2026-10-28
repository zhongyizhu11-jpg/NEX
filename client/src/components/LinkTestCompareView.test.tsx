import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LinkTestCompareView } from "./LinkTestCompareView";

const planned = [
  { from: "HK entry", to: "JP relay", fromHostId: 1, toHostId: 2, hopIndex: 0, hopCount: 2 },
  { from: "JP relay", to: "目标", fromHostId: 2, toHostId: null, hopIndex: 1, hopCount: 2 },
];
const NOW = Date.now();

test("推算和实测并排，对不上的那行标出来并写原因，整链单独一行", () => {
  const html = renderToStaticMarkup(
    <LinkTestCompareView
      planned={planned}
      parsed={{ message: "", totalLatencyMs: 260, details: [
        { success: true, latencyMs: 42, fromHostId: 1, toHostId: 2, hopIndex: 0 },
        { success: true, latencyMs: 218, fromHostId: 2, hopIndex: 1 },
      ] }}
      expected={{ total: { latencyMs: 95, isTimeout: false, at: NOW - 120_000 }, segments: [
        { hopIndex: 0, fromHostId: 1, toHostId: 2, latencyMs: 40, isTimeout: false, at: NOW - 120_000 },
        { hopIndex: 1, fromHostId: 2, toHostId: null, latencyMs: 55, isTimeout: false, at: NOW - 120_000 },
      ] }}
      measuredAt={NOW}
    />,
  );
  assert.match(html, /推算 vs 实测/);
  assert.match(html, /2 段对不上/);
  const rows = html.split(/<div class="fx-cmp-row(?: fx-cmp-row-total)?"/);
  assert.equal(rows.length, 4, "两段 + 整链");
  assert.doesNotMatch(rows[1], /data-mismatch/);
  assert.match(rows[1], /40 ms[^]*?2 分钟前[^]*?42 ms[^]*?\+2 ms/);
  assert.match(rows[2], /data-mismatch/);
  assert.match(rows[2], /55 ms[^]*?218 ms[^]*?\+163 ms[^]*?这一段比后台探测慢得多/);
  assert.match(rows[3], /目标（整链）[^]*?95 ms[^]*?260 ms/);
});

test("后台没有逐段探测时只有实测一列，并说明原因", () => {
  const html = renderToStaticMarkup(
    <LinkTestCompareView planned={planned} parsed={{ message: "", totalLatencyMs: null, details: [] }} expected={{ total: null, segments: [] }} />,
  );
  assert.match(html, /后台还没有这条链的逐段探测，只有实测/);
  assert.match(html, /—/);
});
