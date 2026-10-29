import assert from "node:assert/strict";
import test from "node:test";

import {
  makeLooseMatcher,
  normalizeProxySubAlias,
  normalizeProxySubTokenOptions,
  parseProxySubTokenOptions,
  parseProxySubTokenScope,
  PROXY_SUB_DEFAULT_TOKEN_OPTIONS,
  resolveTriState,
  serializeProxySubTokenOptions,
  serializeProxySubTokenScope,
} from "./proxySubTokenScope";

test("作用域：宽松解析，空作用域存 null", () => {
  assert.equal(serializeProxySubTokenScope(parseProxySubTokenScope(null)), null);
  assert.equal(serializeProxySubTokenScope(parseProxySubTokenScope("{bad json")), null);
  const scope = parseProxySubTokenScope(JSON.stringify({ templateIds: [3, "4", 0, -1, 3], protocols: ["VLESS", "nope"], regions: ["hk", "JP", "xyz"], include: "香港", excludeDirect: true }));
  assert.deepEqual(scope.templateIds, [3, 4]);
  assert.deepEqual(scope.protocols, ["vless"]);
  assert.deepEqual(scope.regions, ["HK", "JP"]);
  assert.equal(scope.include, "香港");
  assert.equal(scope.excludeDirect, true);
  assert.equal(typeof serializeProxySubTokenScope(scope), "string");
});

test("外观选项：三态、排序、改名规则、分类去向；默认值存 null", () => {
  assert.equal(serializeProxySubTokenOptions(PROXY_SUB_DEFAULT_TOKEN_OPTIONS), null);
  const options = normalizeProxySubTokenOptions({
    flagEmoji: "true",
    infoNodes: "off",
    sortMode: "REGION",
    renames: [{ from: "BGP", to: "IEPL" }, { from: "", to: "x" }],
    categoryTargets: { ai: "🇺🇸 美国", "bad key!": "x", cn: "DIRECT" },
    nameTemplate: "{flag} {node}",
  });
  assert.equal(options.flagEmoji, "on");
  assert.equal(options.infoNodes, "off");
  assert.equal(options.sortMode, "region");
  assert.deepEqual(options.renames, [{ from: "BGP", to: "IEPL" }]);
  assert.deepEqual(options.categoryTargets, { ai: "🇺🇸 美国", cn: "DIRECT" });
  const roundTrip = parseProxySubTokenOptions(serializeProxySubTokenOptions(options));
  assert.deepEqual(roundTrip, options);
  assert.equal(resolveTriState("default", true), true);
  assert.equal(resolveTriState("off", true), false);
});

test("短链别名的规则", () => {
  assert.equal(normalizeProxySubAlias("My-Phone"), "my-phone");
  assert.equal(normalizeProxySubAlias("ab"), "");
  assert.equal(normalizeProxySubAlias("-abc"), "");
  assert.equal(normalizeProxySubAlias("abc_d"), "");
  assert.equal(normalizeProxySubAlias("a".repeat(33)), "");
});

test("宽松匹配：非法正则退化成子串", () => {
  assert.equal(makeLooseMatcher("")!, null);
  assert.equal(makeLooseMatcher("^hk")!("HK-01"), true);
  assert.equal(makeLooseMatcher("[")!("a[b"), true);
  assert.equal(makeLooseMatcher("[")!("ab"), false);
});

test("客户端看到的到期：账号和链接取更早的，都没有是 0", async () => {
  const { effectiveProxySubExpiry } = await import("./proxySubTokenScope");
  const token = new Date("2027-10-29T23:59:59Z");
  const owner = new Date("2026-12-31T00:00:00Z");
  assert.equal(effectiveProxySubExpiry(token, null), token.getTime(), "管理员账号没到期，链接的到期要写出来");
  assert.equal(effectiveProxySubExpiry(token, owner), owner.getTime());
  assert.equal(effectiveProxySubExpiry(null, owner.toISOString()), owner.getTime());
  assert.equal(effectiveProxySubExpiry(null, undefined), 0);
  assert.equal(effectiveProxySubExpiry("not a date", ""), 0);
});
