import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFirewallDirective, counterDelta, effectiveFirewallMode } from "./firewallDirective";
import { downloadCountryCidrs } from "./firewallCountryData";
import { effectiveHostRule, normalizeCountryRule } from "./firewallStore";

const geo = { hash: "geo-1", v4: ["1.0.1.0/24"], v6: ["2400:3200::/32"], ready: true };
const ports = { tcp: [443, 80, 443], udp: [443] };

test("directive is disabled when nothing to enforce", () => {
  const off = buildFirewallDirective({ mode: "off", geo: null, ports, blocked: [], trusted: [] });
  assert.equal(off.enabled, false);
  assert.equal(off.hash, "off");
  const noPorts = buildFirewallDirective({ mode: "block", geo, ports: { tcp: [], udp: [] }, blocked: ["9.9.9.9"], trusted: [] });
  assert.equal(noPorts.enabled, false);
});

test("country lists are only sent when the agent does not have them", () => {
  const first = buildFirewallDirective({ mode: "allow", geo, ports, blocked: [], trusted: [], reportedCountryHash: null });
  assert.equal(first.enabled, true);
  assert.equal(first.mode, "allow");
  assert.deepEqual(first.tcp, [80, 443]);
  assert.equal(first.countryHash, "geo-1");
  assert.equal(first.geoIncluded, true);
  assert.deepEqual(first.geo4, ["1.0.1.0/24"]);
  const second = buildFirewallDirective({ mode: "allow", geo, ports, blocked: [], trusted: [], reportedCountryHash: "geo-1" });
  assert.equal(second.geoIncluded, false);
  assert.deepEqual(second.geo4, []);
  // 带不带列表不影响哈希：Agent 不会因此重写规则
  assert.equal(second.hash, first.hash);
});

test("hash is stable and changes with content", () => {
  const base = { mode: "block" as const, geo, ports, blocked: ["9.9.9.9", "8.8.8.0/24"], trusted: ["203.0.113.7"] };
  const a = buildFirewallDirective(base);
  const b = buildFirewallDirective({ ...base, blocked: ["8.8.8.0/24", "9.9.9.9/32"], ports: { tcp: [443, 80], udp: [443] } });
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.block4, ["8.8.8.0/24", "9.9.9.9/32"]);
  const c = buildFirewallDirective({ ...base, blocked: ["9.9.9.9"] });
  assert.notEqual(c.hash, a.hash);
  const d = buildFirewallDirective({ ...base, geo: { ...geo, hash: "geo-2" } });
  assert.notEqual(d.hash, a.hash);
});

test("trusted addresses keep only public IP literals", () => {
  const directive = buildFirewallDirective({
    mode: "off", geo: null, ports, blocked: ["9.9.9.9"],
    trusted: ["203.0.113.7", "hk.example.com", "10.0.0.3", "2001:4860::8888", "[2001:4860::8889]", ""],
  });
  // 203.0.113.0/24 在共享分类里算保留段（文档用），所以不收
  assert.deepEqual(directive.allow4, []);
  assert.deepEqual(directive.allow6, ["2001:4860::8888/127"]);
  const real = buildFirewallDirective({ mode: "off", geo: null, ports, blocked: ["9.9.9.9"], trusted: ["8.8.4.4"] });
  assert.deepEqual(real.allow4, ["8.8.4.4/32"]);
});

test("block / allow fall back to off until country data is ready", () => {
  assert.equal(effectiveFirewallMode("allow", { ...geo, ready: false }).mode, "off");
  assert.equal(effectiveFirewallMode("allow", { ...geo, v4: [], v6: [] }).mode, "off");
  assert.equal(effectiveFirewallMode("block", geo).mode, "block");
  const pending = buildFirewallDirective({ mode: "allow", geo: { ...geo, ready: false }, ports, blocked: ["9.9.9.9"], trusted: [] });
  assert.equal(pending.enabled, true);
  assert.equal(pending.mode, "off");
  assert.equal(pending.countryHash, "");
  assert.equal(pending.geoIncluded, false);
});

test("host override resolution", () => {
  const global = normalizeCountryRule({ mode: "block", countries: ["cn", "XX"] });
  assert.deepEqual(global, { mode: "block", countries: ["CN"] });
  assert.deepEqual(normalizeCountryRule({ mode: "allow", countries: [] }), { mode: "off", countries: [] });
  assert.deepEqual(effectiveHostRule(global, undefined), global);
  assert.deepEqual(effectiveHostRule(global, { hostId: 1, policy: "off", rule: global }), { mode: "off", countries: [] });
  const custom = { mode: "allow" as const, countries: ["HK"] };
  assert.deepEqual(effectiveHostRule(global, { hostId: 1, policy: "custom", rule: custom }), custom);
});

test("counter deltas survive agent restarts", () => {
  assert.equal(counterDelta(null, { since: 100, value: 5 }), 5);
  assert.equal(counterDelta({ since: 100, value: 5 }, { since: 100, value: 12 }), 7);
  assert.equal(counterDelta({ since: 100, value: 12 }, { since: 200, value: 3 }), 3);
  assert.equal(counterDelta({ since: 100, value: 12 }, { since: 100, value: 4 }), 4);
});

test("country download falls back between sources and rejects HTML", async () => {
  const sources = [
    { name: "a", v4: (cc: string) => `a/${cc}/4`, v6: (cc: string) => `a/${cc}/6` },
    { name: "b", v4: (cc: string) => `b/${cc}/4`, v6: (cc: string) => `b/${cc}/6` },
  ];
  const responses: Record<string, any> = {
    "a/cn/4": { ok: true, text: "<html><body>blocked</body></html>" },
    "a/cn/6": { ok: true, text: "<html>" },
    "b/cn/4": { ok: true, text: "# cn\n1.0.1.0/24\n1.0.2.0/23\n" },
    "b/cn/6": { ok: false, notFound: true, error: "404" },
  };
  const fetcher = async (url: string) => responses[url] ?? { ok: false, notFound: true, error: "404" };
  const outcome = await downloadCountryCidrs("CN", sources, fetcher);
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.source, "b");
    assert.deepEqual(outcome.v4, ["1.0.1.0/24", "1.0.2.0/23"]);
    assert.deepEqual(outcome.v6, []);
  }
  const none = await downloadCountryCidrs("AQ", sources, fetcher);
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.noData, true);
  const down = await downloadCountryCidrs("JP", sources, async () => ({ ok: false, notFound: false, error: "连接超时" }));
  assert.equal(down.ok, false);
  if (!down.ok) {
    assert.equal(down.noData, false);
    assert.match(down.error, /连接超时/);
  }
});
