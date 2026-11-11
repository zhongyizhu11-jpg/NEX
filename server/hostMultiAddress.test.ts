import assert from "node:assert/strict";
import test from "node:test";

import { mergeAgentReportedAddress } from "./agentAddressState";
import { applyHostDdnsPlan, hostDdnsPlanFor, hostDdnsTargetValue, type HostDdnsWriter } from "./hostDdns";
import { detectedAddressesUpdate } from "./hostPublicAddressSync";
import { forwardGroupMirrorRecordType, forwardGroupSupportsDualStack, mirrorForwardGroupDdnsValues } from "./forwardGroupDualStackDdns";
import { serializeHostDetectedAddresses } from "../shared/hostPublicAddresses";

const detectedAddresses = serializeHostDetectedAddresses({
  ipv4: ["45.32.10.1", "45.32.10.2"],
  ipv6: ["2001:19f0:5:1::1", "2001:19f0:5:2::2"],
  egressIpv4: "45.32.10.1",
  egressIpv6: "2001:19f0:5:1::1",
  reportedAt: 1,
});

function recordingWriter() {
  const calls: Array<{ kind: "record" | "values"; input: any }> = [];
  const writer: HostDdnsWriter = {
    updateRecord: async (input) => { calls.push({ kind: "record", input }); },
    updateValues: async (input) => { calls.push({ kind: "values", input }); },
  };
  return { calls, writer };
}

test("heartbeat merge without a chosen primary is unchanged", () => {
  const body = { ip: "45.32.10.1", ipv4: "45.32.10.1", ipv6: "2001:19f0:5:1::1" };
  assert.deepEqual(mergeAgentReportedAddress(body, { ip: "45.32.10.1", ipv4: "45.32.10.1", detectedAddresses }), {
    ip: "45.32.10.1",
    ipv4: "45.32.10.1",
    ipv6: "2001:19f0:5:1::1",
  });
});

test("heartbeat merge feeds the chosen primary into ip / ipv4 / ipv6", () => {
  const body = { ip: "45.32.10.1", ipv4: "45.32.10.1", ipv6: "2001:19f0:5:1::1" };
  const host = { ip: "45.32.10.2", ipv4: "45.32.10.2", primaryIpv4: "45.32.10.2", primaryIpv6: "2001:19f0:5:2::2", detectedAddresses };
  assert.deepEqual(mergeAgentReportedAddress(body, host), { ip: "45.32.10.2", ipv4: "45.32.10.2", ipv6: "2001:19f0:5:2::2" });
  // 只有 IPv6 的机器只挑了主 IPv6：ip 栏也跟着换
  assert.deepEqual(
    mergeAgentReportedAddress({ ip: "2001:19f0:5:1::1", ipv6: "2001:19f0:5:1::1" }, { primaryIpv6: "2001:19f0:5:2::2" }),
    { ip: "2001:19f0:5:2::2", ipv4: null, ipv6: "2001:19f0:5:2::2" },
  );
});

test("manual address override still wins over a chosen primary", () => {
  const host = { addressManual: true, ip: "1.1.1.1", ipv4: "1.1.1.1", ipv6: null, primaryIpv4: "45.32.10.2", detectedAddresses };
  assert.deepEqual(mergeAgentReportedAddress({ ipv4: "45.32.10.1" }, host), { ip: "1.1.1.1", ipv4: "1.1.1.1", ipv6: null });
});

test("detected list is only written when the agent sent one and it changed", () => {
  assert.equal(detectedAddressesUpdate({}, { ipv4: "45.32.10.1" }), null);
  const next = detectedAddressesUpdate({}, { publicAddresses: { ipv4: ["45.32.10.1"], ipv6: [], egressIpv4: "45.32.10.1" } }, 5);
  assert.ok(next);
  assert.deepEqual(JSON.parse(next), { ipv4: ["45.32.10.1"], ipv6: [], egressIpv4: "45.32.10.1", egressIpv6: null, reportedAt: 5 });
  assert.equal(detectedAddressesUpdate({ detectedAddresses: next }, { publicAddresses: { ipv4: ["45.32.10.1"], ipv6: [], egressIpv4: "45.32.10.1" } }, 9), null);
  assert.ok(detectedAddressesUpdate({ detectedAddresses: next }, { publicAddresses: { ipv4: [], ipv6: [] } }));
});

test("old single-IP DDNS config makes the exact same single provider call as before", async () => {
  const host = { id: 7, ipv4: "45.32.10.2", ipv6: null, ddnsRecordType: "A", ddnsIpVersion: "ipv4", lastDdnsValue: "45.32.10.1" };
  const plan = hostDdnsPlanFor(host, "cloudflare");
  const { calls, writer } = recordingWriter();
  await applyHostDdnsPlan(plan, { domain: "node.example.com", hostId: 7 }, writer);
  assert.deepEqual(calls, [{ kind: "record", input: { domain: "node.example.com", recordType: "A", value: "45.32.10.2", groupId: -7 } }]);
  assert.equal(plan.signature, "45.32.10.2");
  assert.deepEqual(hostDdnsTargetValue(host), { recordType: "A", ipVersion: "ipv4", value: "45.32.10.2" });
});

test("dual stack all-IP DDNS writes multi-value records and removes nothing extra", async () => {
  const host = { id: 8, ipv4: "45.32.10.2", ipv6: "2001:19f0:5:1::1", ddnsIpVersion: "dual", ddnsValueMode: "all", detectedAddresses };
  const { calls, writer } = recordingWriter();
  await applyHostDdnsPlan(hostDdnsPlanFor(host, "huaweicloud"), { domain: "n.example.com", hostId: 8 }, writer);
  assert.deepEqual(calls, [
    { kind: "values", input: { domain: "n.example.com", recordType: "A", values: ["45.32.10.2", "45.32.10.1"], groupId: -8 } },
    { kind: "values", input: { domain: "n.example.com", recordType: "AAAA", values: ["2001:19f0:5:1::1", "2001:19f0:5:2::2"], groupId: -8 } },
  ]);
});

test("switching back to single stack deletes the AAAA this logic had published", async () => {
  const host = { id: 9, ipv4: "45.32.10.2", ipv6: "2001:19f0:5:1::1", ddnsIpVersion: "ipv4", lastDdnsValue: "A=45.32.10.2;AAAA=2001:19f0:5:1::1" };
  const { calls, writer } = recordingWriter();
  await applyHostDdnsPlan(hostDdnsPlanFor(host, "tencentcloud"), { domain: "n.example.com", hostId: 9 }, writer);
  assert.deepEqual(calls, [
    { kind: "record", input: { domain: "n.example.com", recordType: "A", value: "45.32.10.2", groupId: -9 } },
    { kind: "values", input: { domain: "n.example.com", recordType: "AAAA", values: [], groupId: -9 } },
  ]);
});

test("webhook all-IP mode publishes only the primary per family through the single-value call", async () => {
  const host = { id: 10, ipv4: "45.32.10.2", ipv6: "2001:19f0:5:1::1", ddnsIpVersion: "dual", ddnsValueMode: "all", detectedAddresses };
  const { calls, writer } = recordingWriter();
  await applyHostDdnsPlan(hostDdnsPlanFor(host, "webhook"), { domain: "n.example.com", hostId: 10 }, writer);
  assert.deepEqual(calls.map((call) => [call.kind, call.input.recordType, call.input.value]), [
    ["record", "A", "45.32.10.2"],
    ["record", "AAAA", "2001:19f0:5:1::1"],
  ]);
});

test("forward group dual stack mirrors the selected members' other family", () => {
  assert.equal(forwardGroupMirrorRecordType({ recordType: "A", ddnsDualStack: true }), "AAAA");
  assert.equal(forwardGroupMirrorRecordType({ recordType: "AAAA", ddnsDualStack: 1 }), "A");
  assert.equal(forwardGroupMirrorRecordType({ recordType: "CNAME", ddnsDualStack: true }), null);
  // 老组：没开双栈，一切照旧
  assert.equal(forwardGroupMirrorRecordType({ recordType: "A" }), null);
  assert.equal(forwardGroupMirrorRecordType({ recordType: "A", ddnsDualStack: false }), null);
  const pairs = [
    { primary: "45.32.10.1", mirror: "2001:19f0:5:1::1" },
    { primary: "45.32.10.2", mirror: "2001:19f0:5:2::2" },
    { primary: "45.32.10.3", mirror: "" },
  ];
  // 故障转移切到第二台：AAAA 也只剩第二台
  assert.deepEqual(mirrorForwardGroupDdnsValues(["45.32.10.2"], pairs), ["2001:19f0:5:2::2"]);
  // 入口组：次序跟主记录走，没有 IPv6 的成员少一条
  assert.deepEqual(mirrorForwardGroupDdnsValues(["45.32.10.3", "45.32.10.2", "45.32.10.1"], pairs), ["2001:19f0:5:2::2", "2001:19f0:5:1::1"]);
  // 选中的成员都没有另一族：副记录清空
  assert.deepEqual(mirrorForwardGroupDdnsValues(["45.32.10.3"], pairs), []);
  assert.equal(forwardGroupSupportsDualStack("entry", "A"), true);
  assert.equal(forwardGroupSupportsDualStack("failover", "AAAA"), true);
  assert.equal(forwardGroupSupportsDualStack("entry", "CNAME"), false);
  assert.equal(forwardGroupSupportsDualStack("chain", "A"), false);
});
