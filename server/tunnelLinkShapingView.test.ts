import assert from "node:assert/strict";
import test from "node:test";

import { hostEgressShapingStatusView, isLinkShapingReportStale, LINK_SHAPING_STALE_MS, tunnelLinkShapingStatusView } from "./tunnelLinkShapingView";

const NOW = Date.UTC(2026, 9, 12, 16, 0, 0);
const fresh = new Date(NOW - 30_000);
const old = new Date(NOW - LINK_SHAPING_STALE_MS - 1000);

function row(overrides: Record<string, unknown> = {}) {
  return {
    tunnelId: 7,
    hostId: 3,
    role: "entry",
    direction: "down",
    mode: "auto",
    state: "shaping",
    rateMbps: 376,
    learnedMbps: 0,
    lossPermille: 12,
    updatedAt: fresh,
    ...overrides,
  };
}

test("开着整形的 NEX 隧道照常给状态", () => {
  const view = tunnelLinkShapingStatusView({ mode: "forwardx", linkShapingMode: "auto" }, [row()], NOW);
  assert.equal(view.length, 1);
  assert.equal(view[0].state, "shaping");
  assert.equal(view[0].rateMbps, 376);
  assert.equal(view[0].lossPct, 1.2);
  assert.equal(view[0].stale, false);
});

test("换了隧道协议之后不再给旧的整形状态", () => {
  assert.deepEqual(tunnelLinkShapingStatusView({ mode: "gost", linkShapingMode: "auto" }, [row()], NOW), []);
  assert.deepEqual(tunnelLinkShapingStatusView({ mode: "nginx_stream", linkShapingMode: "auto" }, [row()], NOW), []);
});

test("把链路整形关掉之后不再给旧的整形状态", () => {
  assert.deepEqual(tunnelLinkShapingStatusView({ mode: "forwardx", linkShapingMode: "off" }, [row()], NOW), []);
  // 手动档没填上限等于没开
  assert.deepEqual(
    tunnelLinkShapingStatusView({ mode: "forwardx", linkShapingMode: "manual", linkUpMbps: 0, linkDownMbps: 0 }, [row()], NOW),
    [],
  );
});

test("好一会儿没上报的标成 stale，值还留着", () => {
  const view = tunnelLinkShapingStatusView({ mode: "forwardx", linkShapingMode: "auto" }, [row({ updatedAt: old, learnedMbps: 420 })], NOW);
  assert.equal(view.length, 1);
  assert.equal(view[0].stale, true);
  assert.equal(view[0].learnedMbps, 420);
});

test("没有上报时间的老记录也算过期", () => {
  assert.equal(isLinkShapingReportStale(null, NOW), true);
  assert.equal(isLinkShapingReportStale(0, NOW), true);
  assert.equal(isLinkShapingReportStale(fresh, NOW), false);
  // 秒和毫秒两种时间戳都认
  assert.equal(isLinkShapingReportStale(Math.floor(fresh.getTime() / 1000), NOW), false);
  assert.equal(isLinkShapingReportStale(fresh.toISOString(), NOW), false);
  assert.equal(isLinkShapingReportStale(old, NOW), true);
});

test("主机公网出口整形：关着的机器不给，过期的标 stale", () => {
  const egress = row({ tunnelId: 0, direction: "egress" });
  assert.equal(hostEgressShapingStatusView({ egressShapingMode: "off" }, egress, NOW), null);
  assert.equal(hostEgressShapingStatusView({ egressShapingMode: "auto" }, null, NOW), null);
  assert.equal(hostEgressShapingStatusView({ egressShapingMode: "auto" }, egress, NOW)?.stale, false);
  assert.equal(hostEgressShapingStatusView({ egressShapingMode: "auto" }, { ...egress, updatedAt: old }, NOW)?.stale, true);
});

test("没写档位的隧道默认不整形", () => {
  // 旧版本默认「自动」，2026-10-12 起改成关：没写过档位就不探限速点
  assert.deepEqual(tunnelLinkShapingStatusView({ mode: "forwardx" }, [row()], NOW), []);
  assert.deepEqual(tunnelLinkShapingStatusView({ mode: "forwardx", linkShapingMode: "" }, [row()], NOW), []);
});
