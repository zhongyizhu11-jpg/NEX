import assert from "node:assert/strict";
import test from "node:test";

import { normalizeQuotaMode, quotaFlushItems } from "./quotaPolicy";

test("模式：默认立即断开，只认两个值", () => {
  assert.equal(normalizeQuotaMode(null), "cut");
  assert.equal(normalizeQuotaMode("drain"), "drain");
  assert.equal(normalizeQuotaMode("cut"), "cut");
  assert.equal(normalizeQuotaMode("whatever"), "cut");
});

test("清理清单：只要最近一天、停下超过 5 秒的，key 带上停下的时间", () => {
  const now = 1_800_000_000;
  const items = quotaFlushItems([
    { id: 1, sourcePort: 3000, protocol: "tcp", updatedAt: now - 60 },
    { id: 2, sourcePort: 3001, protocol: "both", updatedAt: new Date((now - 120) * 1000) },
    { id: 3, sourcePort: 3002, protocol: "udp", updatedAt: now - 2 },
    { id: 4, sourcePort: 3003, protocol: "tcp", updatedAt: now - 2 * 86400 },
    { id: 5, sourcePort: 0, protocol: "tcp", updatedAt: now - 60 },
    { id: 6, sourcePort: 3005, protocol: "tcp+udp", updatedAt: null },
  ], now);
  assert.deepEqual(items, [
    { key: `r1-p3000-t${now - 60}`, port: 3000, protocol: "tcp" },
    { key: `r2-p3001-t${now - 120}`, port: 3001, protocol: "both" },
  ]);
});
