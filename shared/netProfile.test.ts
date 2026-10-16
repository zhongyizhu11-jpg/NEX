import assert from "node:assert/strict";
import test from "node:test";

import {
  DNSBL_LISTS,
  DNSBL_QUERY_REFUSED,
  DNSBL_UNEXPECTED_ANSWER,
  dnsblCodeLabel,
  dnsblQueryName,
  dualStackState,
  interpretDnsblAnswer,
  netProfileHistoryItem,
  normalizeNetProfileReport,
  parseStoredNetProfile,
  reverseIpv4,
  summarizeDnsbl,
} from "./netProfile";

test("DNSBL 查询名：IPv4 反写 + 区名；不是 IPv4 不查", () => {
  assert.equal(reverseIpv4("203.0.113.7"), "7.113.0.203");
  assert.equal(reverseIpv4("2001:db8::1"), null);
  assert.equal(reverseIpv4("256.1.1.1"), null);
  assert.equal(reverseIpv4("01.2.3.4"), null, "前导 0 不认（有的解析库当八进制）");
  assert.equal(dnsblQueryName("203.0.113.7", "zen.spamhaus.org."), "7.113.0.203.zen.spamhaus.org");
  assert.equal(dnsblQueryName("203.0.113.7", "bad zone"), null);
  assert.ok(!DNSBL_LISTS.some((item) => item.zone === "dnsbl.sorbs.net"), "SORBS 已关停，查它只会得到假的「未列入」");
});

test("DNSBL 应答：127.0.0.x 是列入并带码，NXDOMAIN 是没列入", () => {
  assert.deepEqual(interpretDnsblAnswer("bl.spamcop.net", { addresses: ["127.0.0.2"] }), { list: "bl.spamcop.net", listed: true, code: "127.0.0.2", error: null });
  assert.deepEqual(
    interpretDnsblAnswer("zen.spamhaus.org", { addresses: ["127.0.0.10", "127.0.0.4", "127.0.0.4"] }),
    { list: "zen.spamhaus.org", listed: true, code: "127.0.0.10,127.0.0.4", error: null },
    "去重、排序",
  );
  assert.deepEqual(interpretDnsblAnswer("cbl.abuseat.org", { notFound: true }), { list: "cbl.abuseat.org", listed: false, code: null, error: null });
  assert.equal(interpretDnsblAnswer("cbl.abuseat.org", { error: "ENOTFOUND" }).error, null, "Node 的 ENOTFOUND 就是 NXDOMAIN");
  assert.equal(interpretDnsblAnswer("cbl.abuseat.org", { error: "ENODATA" }).listed, false);
  assert.equal(interpretDnsblAnswer("x", { addresses: [] }).listed, false, "没有 A 记录 = 没列入");
});

test("DNSBL 应答：Spamhaus 的 127.255.255.252/254/255 是查询被拒，不是列入", () => {
  for (const code of ["127.255.255.252", "127.255.255.254", "127.255.255.255"]) {
    const entry = interpretDnsblAnswer("zen.spamhaus.org", { addresses: [code] });
    assert.equal(entry.listed, false, code);
    assert.equal(entry.error, DNSBL_QUERY_REFUSED, code);
  }
  const hijacked = interpretDnsblAnswer("zen.spamhaus.org", { addresses: ["93.184.216.34"] });
  assert.equal(hijacked.listed, false);
  assert.equal(hijacked.error, DNSBL_UNEXPECTED_ANSWER, "解析器劫持 NXDOMAIN 回广告页地址");
  const timeout = interpretDnsblAnswer("zen.spamhaus.org", { error: "ETIMEOUT" });
  assert.equal(timeout.listed, false);
  assert.match(timeout.error || "", /查询失败/);
});

test("Spamhaus 返回码含义；汇总", () => {
  assert.equal(dnsblCodeLabel("zen.spamhaus.org", "127.0.0.2"), "SBL");
  assert.equal(dnsblCodeLabel("zen.spamhaus.org", "127.0.0.4,127.0.0.11"), "XBL / PBL");
  assert.equal(dnsblCodeLabel("bl.spamcop.net", "127.0.0.2"), null);
  const summary = summarizeDnsbl([
    { list: "zen.spamhaus.org", listed: false, code: null, error: DNSBL_QUERY_REFUSED },
    { list: "bl.spamcop.net", listed: true, code: "127.0.0.2", error: null },
    { list: "cbl.abuseat.org", listed: false, code: null, error: null },
  ]);
  assert.equal(summary.state, "listed");
  assert.deepEqual(summary.listed, ["bl.spamcop.net"]);
  assert.deepEqual(summary.failed, ["zen.spamhaus.org"]);
  assert.equal(summary.checked, 2);
  assert.equal(summarizeDnsbl([{ list: "a", listed: false, code: null, error: "x" }]).state, "unknown");
  assert.equal(summarizeDnsbl([]).state, "none");
  assert.equal(summarizeDnsbl([{ list: "a", listed: false, code: null, error: null }]).state, "clean");
});

test("收敛 Agent 上报：形状对的留下，乱的丢掉，原始应答按面板规则重读", () => {
  const now = 1_800_000_000;
  const report = normalizeNetProfileReport({
    checkedAt: now - 30,
    resultId: "abc",
    ipv4: { ok: true, address: "203.0.113.7", latencyMs: 41.6 },
    ipv6: { ok: false, error: "dial tcp6: network is unreachable", configured: false },
    smtp25: {
      status: "timeout",
      detail: "都超时",
      targets: [{ target: "gmail-smtp-in.l.google.com:25", status: "timeout", detail: "i/o timeout" }, { target: "x", status: "weird" }],
    },
    dnsbl: [
      // Agent 自己读成了「列入」，但原始应答是 Spamhaus 的拒绝码：面板按自己的规则重读
      { list: "zen.spamhaus.org", listed: true, code: "127.255.255.254", answers: ["127.255.255.254"], notFound: false },
      { list: "bl.spamcop.net", listed: false, answers: [], notFound: true },
      { list: "cbl.abuseat.org", listed: false, answers: [], notFound: false, error: "server misbehaving" },
      { nope: true },
    ],
    dnsblAddress: "203.0.113.7",
  }, now);
  assert.ok(report);
  assert.equal(report.checkedAt, now - 30);
  assert.deepEqual(report.ipv4, { ok: true, address: "203.0.113.7", latencyMs: 42, error: null });
  assert.equal(report.ipv6?.ok, false);
  assert.equal(report.ipv6?.configured, false);
  assert.match(report.ipv6?.error || "", /unreachable/);
  assert.equal(report.smtp25?.status, "timeout");
  assert.equal(report.smtp25?.targets.length, 1, "认不出的 status 丢掉");
  assert.equal(report.dnsbl.length, 3);
  assert.equal(report.dnsbl[0].listed, false);
  assert.equal(report.dnsbl[0].error, DNSBL_QUERY_REFUSED);
  assert.deepEqual(report.dnsbl[1], { list: "bl.spamcop.net", listed: false, code: null, error: null });
  assert.match(report.dnsbl[2].error || "", /server misbehaving/);
  assert.equal(report.dnsblSource, "agent");
  assert.equal(report.agentCheckedAt, now - 30);

  assert.equal(normalizeNetProfileReport(null), null);
  assert.equal(normalizeNetProfileReport([1, 2]), null);
  const skewed = normalizeNetProfileReport({ checkedAt: now + 3600 }, now);
  assert.equal(skewed?.checkedAt, now, "主机时钟跑到未来就用面板时间");
  const bogus = normalizeNetProfileReport({ ipv4: { ok: true, address: "not-an-ip" }, ipv6: { ok: true, address: "1.2.3.4" } }, now);
  assert.equal(bogus?.ipv4?.ok, false, "说通了却给了个不是 IP 的东西：不算通");
  assert.equal(bogus?.ipv6?.ok, false, "IPv6 那一栏给了 IPv4：不算通");
  assert.equal(bogus?.smtp25, null);
  assert.deepEqual(bogus?.dnsbl, []);
  const derived = normalizeNetProfileReport({ smtp25: { targets: [{ target: "a:25", status: "refused" }, { target: "b:25", status: "timeout" }] } }, now);
  assert.equal(derived?.smtp25?.status, "blocked", "没给总状态时按各目标推");
});

test("存库的 JSON 读回来；历史摘要；双栈状态", () => {
  const now = Math.floor(Date.now() / 1000);
  const stored = JSON.stringify({
    checkedAt: now - 60,
    ipv4: { ok: true, address: "198.51.100.16", latencyMs: 20 },
    ipv6: { ok: true, address: "2001:DB8::16", latencyMs: 30, configured: true },
    smtp25: { status: "open", detail: "220 ok", targets: [] },
    dnsbl: [{ list: "bl.spamcop.net", listed: true, code: "127.0.0.2", error: null }],
    dnsblAddress: "198.51.100.16",
    dnsblSource: "panel",
    dnsblCheckedAt: now - 30,
    agentCheckedAt: now - 3600,
  });
  const profile = parseStoredNetProfile(stored);
  assert.ok(profile);
  assert.equal(profile.ipv6?.address, "2001:db8::16");
  assert.equal(profile.dnsblSource, "panel");
  assert.equal(profile.dnsblCheckedAt, now - 30);
  assert.equal(profile.agentCheckedAt, now - 3600);
  assert.equal(dualStackState(profile), "dual");
  assert.deepEqual(netProfileHistoryItem(profile), { checkedAt: now - 60, ipv4Ok: true, ipv6Ok: true, smtp25: "open", listed: 1 });
  assert.equal(parseStoredNetProfile("{oops"), null);
  assert.equal(parseStoredNetProfile(null), null);
  assert.equal(dualStackState(null), "unknown");
  assert.equal(dualStackState({ ipv4: { ok: false, address: null, latencyMs: null, error: "x" }, ipv6: null }), "none");
  assert.equal(dualStackState({ ipv4: { ok: true, address: "1.1.1.1", latencyMs: 1, error: null }, ipv6: null }), "ipv4");
});
