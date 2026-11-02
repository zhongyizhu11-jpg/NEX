import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SegmentSpeedResult, formatMbps, isSlowestSegment, segmentStateText, type SpeedRun } from "./SegmentSpeedResult";

function segment(patch: Record<string, unknown>) {
  return {
    from: { hostId: 1, name: "入口" },
    to: { hostId: 2, name: "中转" },
    status: "done",
    mbps: 800,
    reverseMbps: 650,
    retransPerGB: 3,
    reverseRetransPerGB: 5,
    streamRange: { min: 150, max: 250 },
    singleMbps: 300,
    verdict: "单条连接只有多条的一半",
    error: null,
    ...patch,
  } as SpeedRun["segments"][number];
}

const RUN: SpeedRun = {
  status: "done",
  error: null,
  slowest: 1,
  segments: [
    segment({}),
    segment({ from: { hostId: 2, name: "中转" }, to: { hostId: 3, name: "落地" }, mbps: 1500, reverseMbps: null }),
    segment({ from: { hostId: 3, name: "落地" }, to: { hostId: null, name: "目标" }, status: "skipped", mbps: null, error: "不是自己的机器" }),
  ],
};

test("一段的状态两处一个叫法，「最慢」只在测出来不止一段时标", () => {
  assert.equal(segmentStateText({ status: "skipped" }, false), "不测");
  assert.equal(segmentStateText({ status: "done" }, true), "最慢");
  assert.equal(isSlowestSegment(RUN, 1), true);
  assert.equal(isSlowestSegment({ ...RUN, segments: [RUN.segments[0]], slowest: 0 }, 0), false);
  assert.equal(formatMbps(1500), "1.50 Gbps");
  assert.equal(formatMbps(null), "—");
});

test("对拉页（full）和线路详情（compact）画的是同一份数", () => {
  const full = renderToStaticMarkup(<SegmentSpeedResult run={RUN} />);
  assert.match(full, /data-variant="full"/);
  assert.match(full, /正向（上游 → 下游）/);
  assert.match(full, /650 Mbps/);
  assert.match(full, /不是自己的机器/);
  const compact = renderToStaticMarkup(<SegmentSpeedResult run={RUN} variant="compact" />);
  assert.match(compact, /data-variant="compact"/);
  assert.match(compact, /800 Mbps · 反向 650 Mbps/);
  assert.match(compact, /1\.50 Gbps · 最慢/);
  assert.match(compact, /不测/);
  assert.match(compact, /不是自己的机器/);
});

test("两处入口都用这个组件，隧道的诊断框「测带宽」打开对拉页", () => {
  const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8");
  assert.match(read("./Iperf3PairPanel.tsx"), /<SegmentSpeedResult run=\{data\} \/>/);
  assert.match(read("../rules/RouteLineOverview.tsx"), /<SegmentSpeedResult run=\{data\} variant="compact" \/>/);
  assert.match(read("../../components/DiagnoseDialog.tsx"), /\/looking-glass\?method=iperf3-pair&tunnel=/);
  assert.match(read("../../pages/LookingGlass.tsx"), /initialTunnelId=\{pairDeepLink\.tunnelId\}/);
});
