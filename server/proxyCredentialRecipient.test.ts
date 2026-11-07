import test from "node:test";
import assert from "node:assert/strict";

import { proxyCredentialRecipientActive, proxyCredentialRecipientBlockReason } from "./repositories/proxyInboundRepository";

const now = Date.UTC(2026, 10, 6);
const base = { role: "user", accountEnabled: 1, allowProxySubscription: 1, expiresAt: null, trafficLimit: 0, trafficUsed: 0 };

test("订阅 / 落地凭据的资格：正常用户放行", () => {
  assert.equal(proxyCredentialRecipientBlockReason(base, now), null);
  assert.equal(proxyCredentialRecipientActive(base, now), true);
});

test("流量用完：直接比用量和额度（额度为 0 = 不限）", () => {
  assert.equal(proxyCredentialRecipientBlockReason({ ...base, trafficLimit: 100, trafficUsed: 100 }, now), "traffic-exhausted");
  assert.equal(proxyCredentialRecipientBlockReason({ ...base, trafficLimit: 100, trafficUsed: 99 }, now), null);
  assert.equal(proxyCredentialRecipientBlockReason({ ...base, trafficLimit: 0, trafficUsed: 10 ** 12 }, now), null);
});

test("自动暂停的原因决定说法：超流量 / 到期 / 欠费 / 手动收回", () => {
  const paused = { ...base, allowProxySubscription: 0 };
  assert.equal(proxyCredentialRecipientBlockReason({ ...paused, forwardAccessPauseReason: "traffic_limit" }, now), "traffic-exhausted");
  assert.equal(proxyCredentialRecipientBlockReason({ ...paused, forwardAccessPauseReason: "expired" }, now), "expired");
  assert.equal(proxyCredentialRecipientBlockReason({ ...paused, forwardAccessPauseReason: "traffic_billing_balance" }, now), "balance-insufficient");
  assert.equal(proxyCredentialRecipientBlockReason({ ...paused, forwardAccessPauseReason: "manual" }, now), "no-permission");
  assert.equal(proxyCredentialRecipientBlockReason(paused, now), "no-permission");
});

test("到期优先于流量；停用的账号谁都不放；管理员不看订阅开关和流量，但到期照算", () => {
  assert.equal(proxyCredentialRecipientBlockReason({ ...base, expiresAt: new Date(now - 1000), trafficLimit: 1, trafficUsed: 5 }, now), "expired");
  assert.equal(proxyCredentialRecipientBlockReason({ ...base, accountEnabled: 0 }, now), "disabled");
  assert.equal(proxyCredentialRecipientBlockReason({ ...base, role: "admin", allowProxySubscription: 0, trafficLimit: 1, trafficUsed: 5 }, now), null);
  assert.equal(proxyCredentialRecipientBlockReason({ ...base, role: "admin", expiresAt: new Date(now - 1000) }, now), "expired");
  assert.equal(proxyCredentialRecipientBlockReason({ ...base, role: "admin", accountEnabled: 0 }, now), "disabled");
  assert.equal(proxyCredentialRecipientBlockReason(null, now), "missing");
});
