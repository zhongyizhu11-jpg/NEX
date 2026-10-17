import assert from "node:assert/strict";
import test from "node:test";

import {
  BYTES_PER_MEGABIT,
  buildForwardRateTiers,
  describeForwardRate,
  forwardRateTiersForAgent,
  strictestForwardRate,
} from "./forwardRateLimit";

test("没有任何限速时一级都没有", () => {
  assert.deepEqual(buildForwardRateTiers({ userId: 1, hostId: 2 }), []);
  assert.deepEqual(strictestForwardRate([]), { inMbps: 0, outMbps: 0, scope: "" });
});

test("用户上下行分开，和隧道、规则、整台主机叠加；每个方向取最严", () => {
  const tiers = buildForwardRateTiers({
    userId: 1,
    hostId: 2,
    user: { inMbps: 50, outMbps: 200 },
    tunnel: { id: 7, mbps: 100 },
    rule: { id: 9, inMbps: 0, outMbps: 80 },
    hostLimitMbps: 500,
  });
  assert.deepEqual(tiers.map((tier) => tier.scope), ["user-1-host-2", "user-1-host-2-tunnel-7", "rule-9-host-2", "host-2"]);
  assert.deepEqual(strictestForwardRate(tiers), { inMbps: 50, outMbps: 80, scope: "user-1-host-2" });
});

test("突发：峰值桶 + 基础桶，基础桶深 = (峰值 - 基础) × 秒数", () => {
  const tiers = buildForwardRateTiers({ userId: 1, hostId: 2, user: { inMbps: 100, outMbps: 100, burstMbps: 300, burstSeconds: 60 } });
  assert.equal(tiers.length, 2);
  assert.deepEqual(tiers[0], { scope: "user-1-host-2", inMbps: 300, outMbps: 300 });
  assert.equal(tiers[1].scope, "user-1-host-2-sustain");
  assert.equal(tiers[1].inMbps, 100);
  assert.equal(tiers[1].burstInBytes, 200 * BYTES_PER_MEGABIT * 60);
  // 只认一个数的地方按基础速率限，scope 仍是用户那一级
  assert.deepEqual(strictestForwardRate(tiers), { inMbps: 100, outMbps: 100, scope: "user-1-host-2" });
  const agent = forwardRateTiersForAgent(tiers);
  assert.equal(agent[0].in, 300 * BYTES_PER_MEGABIT);
  assert.equal(agent[1].burstIn, 200 * BYTES_PER_MEGABIT * 60);
});

test("突发只对限了速的方向生效；峰值不高于基础速率就当没开", () => {
  const oneWay = buildForwardRateTiers({ userId: 1, hostId: 2, user: { inMbps: 100, outMbps: 0, burstMbps: 300, burstSeconds: 30 } });
  assert.deepEqual(oneWay.map((tier) => [tier.scope, tier.inMbps, tier.outMbps]), [["user-1-host-2", 300, 0], ["user-1-host-2-sustain", 100, 0]]);
  assert.equal(oneWay[1].burstOutBytes, 0);
  const noBurst = buildForwardRateTiers({ userId: 1, hostId: 2, user: { inMbps: 100, outMbps: 100, burstMbps: 50, burstSeconds: 30 } });
  assert.equal(noBurst.length, 1);
  const noSeconds = buildForwardRateTiers({ userId: 1, hostId: 2, user: { inMbps: 100, outMbps: 100, burstMbps: 500, burstSeconds: 0 } });
  assert.equal(noSeconds.length, 1);
});

test("文案", () => {
  assert.equal(describeForwardRate(0, 0), "不限");
  assert.equal(describeForwardRate(100, 100), "上下行 100 Mbps");
  assert.equal(describeForwardRate(50, 0), "上行 50 Mbps / 下行 不限");
});
