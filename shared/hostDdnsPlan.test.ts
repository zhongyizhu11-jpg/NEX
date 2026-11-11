import assert from "node:assert/strict";
import test from "node:test";

import {
  ddnsProviderSupportsMultipleValues,
  describeHostDdnsPlan,
  formatHostDdnsSignature,
  hostDdnsPlanHasWork,
  hostDdnsRecordTypeFor,
  normalizeHostDdnsIpVersion,
  normalizeHostDdnsValueMode,
  parseHostDdnsSignature,
  planHostDdnsRecords,
} from "./hostDdnsPlan";
import { serializeHostDetectedAddresses } from "./hostPublicAddresses";

const detectedAddresses = serializeHostDetectedAddresses({
  ipv4: ["45.32.10.1", "45.32.10.2", "45.32.10.3"],
  ipv6: ["2001:19f0:5:1::1", "2001:19f0:5:2::2"],
  egressIpv4: "45.32.10.1",
  egressIpv6: "2001:19f0:5:1::1",
  reportedAt: 1,
});

const host = {
  ip: "45.32.10.2",
  ipv4: "45.32.10.2",
  ipv6: "2001:19f0:5:1::1",
  detectedAddresses,
};

const PROVIDERS = ["cloudflare", "huaweicloud", "aliyun", "tencentcloud", "webhook"] as const;

test("normalizers keep old rows on the old meaning", () => {
  assert.equal(normalizeHostDdnsIpVersion(undefined, "AAAA"), "ipv6");
  assert.equal(normalizeHostDdnsIpVersion(undefined, "A"), "ipv4");
  assert.equal(normalizeHostDdnsIpVersion("ipv4", "AAAA"), "ipv4");
  assert.equal(normalizeHostDdnsIpVersion("dual"), "dual");
  assert.equal(normalizeHostDdnsIpVersion("bogus"), "ipv4");
  assert.equal(normalizeHostDdnsValueMode(undefined), "primary");
  assert.equal(normalizeHostDdnsValueMode("all"), "all");
  assert.equal(hostDdnsRecordTypeFor("dual"), "A");
  assert.equal(hostDdnsRecordTypeFor("ipv6"), "AAAA");
});

test("provider capability: webhook is the only single-value provider", () => {
  for (const provider of ["cloudflare", "huaweicloud", "aliyun", "tencentcloud"]) assert.equal(ddnsProviderSupportsMultipleValues(provider), true);
  assert.equal(ddnsProviderSupportsMultipleValues("webhook"), false);
  assert.equal(ddnsProviderSupportsMultipleValues("disabled"), false);
});

test("old single-IP configs plan exactly the old single update for every provider", () => {
  for (const provider of PROVIDERS) {
    // 老行：没有 ddnsValueMode 列的值、lastDdnsValue 是裸地址
    const v4 = planHostDdnsRecords({ ...host, ddnsRecordType: "A", ddnsIpVersion: "ipv4" }, { provider, previous: "45.32.10.9" });
    assert.equal(v4.legacy, true);
    assert.deepEqual(v4.records, [{ recordType: "A", values: ["45.32.10.2"], multiValue: false }]);
    assert.deepEqual(v4.removals, []);
    assert.equal(v4.signature, "45.32.10.2");
    assert.deepEqual(v4.notices, []);

    const v6 = planHostDdnsRecords({ ...host, ddnsRecordType: "AAAA", ddnsIpVersion: null }, { provider, previous: "" });
    assert.deepEqual(v6.records, [{ recordType: "AAAA", values: ["2001:19f0:5:1::1"], multiValue: false }]);
    assert.equal(v6.signature, "2001:19f0:5:1::1");
  }
});

test("old config with no address reports the family as missing and has no work", () => {
  const plan = planHostDdnsRecords({ ipv4: null, ipv6: null, ddnsIpVersion: "ipv4" }, { provider: "cloudflare" });
  assert.equal(hostDdnsPlanHasWork(plan), false);
  assert.deepEqual(plan.missing, ["ipv4"]);
  assert.equal(plan.signature, "");
});

test("dual stack + primary publishes one A and one AAAA through the single-value path", () => {
  for (const provider of PROVIDERS) {
    const plan = planHostDdnsRecords({ ...host, ddnsIpVersion: "dual" }, { provider, previous: "" });
    assert.equal(plan.legacy, false);
    assert.deepEqual(plan.records, [
      { recordType: "A", values: ["45.32.10.2"], multiValue: false },
      { recordType: "AAAA", values: ["2001:19f0:5:1::1"], multiValue: false },
    ]);
    assert.equal(plan.signature, "A=45.32.10.2;AAAA=2001:19f0:5:1::1");
  }
});

test("dual stack with one family missing leaves that family alone and carries its previous value", () => {
  const plan = planHostDdnsRecords({ ...host, ipv6: null, ddnsIpVersion: "dual" }, {
    provider: "cloudflare",
    previous: "A=45.32.10.2;AAAA=2001:19f0:5:9::9",
  });
  assert.deepEqual(plan.records.map((record) => record.recordType), ["A"]);
  assert.deepEqual(plan.missing, ["ipv6"]);
  assert.deepEqual(plan.removals, []);
  assert.equal(plan.signature, "A=45.32.10.2;AAAA=2001:19f0:5:9::9");
});

test("all IPs on multi-value providers: every detected address, primary first, via the values API", () => {
  for (const provider of ["cloudflare", "huaweicloud", "aliyun", "tencentcloud"]) {
    const plan = planHostDdnsRecords({ ...host, ddnsIpVersion: "dual", ddnsValueMode: "all" }, { provider, previous: "" });
    assert.deepEqual(plan.records, [
      { recordType: "A", values: ["45.32.10.2", "45.32.10.1", "45.32.10.3"], multiValue: true },
      { recordType: "AAAA", values: ["2001:19f0:5:1::1", "2001:19f0:5:2::2"], multiValue: true },
    ]);
    assert.equal(plan.signature, "A=45.32.10.2,45.32.10.1,45.32.10.3;AAAA=2001:19f0:5:1::1,2001:19f0:5:2::2");
    assert.deepEqual(plan.notices, []);
  }
});

test("all IPs on a single-value provider (webhook) falls back to the primary and says so", () => {
  const plan = planHostDdnsRecords({ ...host, ddnsIpVersion: "ipv4", ddnsValueMode: "all" }, { provider: "webhook", previous: "" });
  assert.deepEqual(plan.records, [{ recordType: "A", values: ["45.32.10.2"], multiValue: false }]);
  assert.equal(plan.notices.length, 1);
  assert.match(plan.notices[0], /Webhook.*退回主 IP/);
});

test("all IPs without a detected list (old agent) publishes only the primary", () => {
  const plan = planHostDdnsRecords({ ipv4: "45.32.10.2", ddnsIpVersion: "ipv4", ddnsValueMode: "all" }, { provider: "cloudflare" });
  assert.deepEqual(plan.records, [{ recordType: "A", values: ["45.32.10.2"], multiValue: false }]);
  assert.equal(plan.signature, "A=45.32.10.2");
});

test("going back from all IPs to primary cleans up the extra records through the values API", () => {
  const plan = planHostDdnsRecords({ ...host, ddnsIpVersion: "ipv4", ddnsValueMode: "primary" }, {
    provider: "aliyun",
    previous: "A=45.32.10.2,45.32.10.1,45.32.10.3",
  });
  assert.equal(plan.legacy, true);
  assert.deepEqual(plan.records, [{ recordType: "A", values: ["45.32.10.2"], multiValue: true }]);
  // 回到老格式签名
  assert.equal(plan.signature, "45.32.10.2");
});

test("dropping a family removes only records this logic published", () => {
  const plan = planHostDdnsRecords({ ...host, ddnsIpVersion: "ipv4" }, { provider: "cloudflare", previous: "A=45.32.10.2;AAAA=2001:19f0:5:1::1" });
  assert.deepEqual(plan.removals, ["AAAA"]);
  assert.match(describeHostDdnsPlan(plan), /删除 AAAA/);
  // 老格式的裸地址（v4 → v6 切换）不删任何东西，和原来一样
  const legacySwitch = planHostDdnsRecords({ ...host, ddnsIpVersion: "ipv6" }, { provider: "cloudflare", previous: "45.32.10.2" });
  assert.deepEqual(legacySwitch.removals, []);
  // 单值服务商删不了，只提示
  const webhook = planHostDdnsRecords({ ...host, ddnsIpVersion: "ipv4" }, { provider: "webhook", previous: "A=45.32.10.2;AAAA=2001:19f0:5:1::1" });
  assert.deepEqual(webhook.removals, []);
  assert.match(webhook.notices.join(""), /AAAA 记录请手动清理/);
});

test("signature parse / format round trip", () => {
  assert.deepEqual(parseHostDdnsSignature("A=1.1.1.1,2.2.2.2;AAAA=2001:db8::1"), {
    typed: true,
    records: { A: ["1.1.1.1", "2.2.2.2"], AAAA: ["2001:db8::1"] },
  });
  assert.deepEqual(parseHostDdnsSignature("2001:db8::1"), { typed: false, records: { AAAA: ["2001:db8::1"] } });
  assert.deepEqual(parseHostDdnsSignature(null), { typed: false, records: {} });
  assert.equal(formatHostDdnsSignature({ AAAA: ["2001:db8::1"], A: [] }), "AAAA=2001:db8::1");
});
