import assert from "node:assert/strict";
import test from "node:test";

import { compileProxySubGroupFilter, validateProxySubGroupFilter } from "./proxySubGroupFilter";
import { makeLooseMatcher } from "./proxySubTokenScope";
import { compileSafeRegex, isSafeRegexSource, SAFE_REGEX_MAX_LENGTH } from "./safeRegex";

test("会灾难性回溯的写法拦下来，常见的筛选写法放行", () => {
  for (const bad of ["(a+)+$", "(a*)*", "(.*a){2,}", "((ab)*c)+", "(a|aa)+", "(\\d|\\w)*x", "(?:港|HK)+", "(a+)?", "(x|y){3}"]) {
    assert.equal(isSafeRegexSource(bad), false, bad);
  }
  for (const good of ["港|HK", "^(?=.*香港)(?!.*IPLC)", "HK-\\d+", "(香港|HK)", "[+*(|]+", "a{2,5}b*", "(?<name>a)b+", "\\(a+\\)+", "(?:ab)+", "x*?y+?", "(a+)b"]) {
    assert.equal(isSafeRegexSource(good), true, good);
  }
  assert.equal(isSafeRegexSource("a".repeat(SAFE_REGEX_MAX_LENGTH + 1)), false, "超长拒掉");
});

test("灾难性的表达式几毫秒内就被拒，三处调用方都退化成子串", () => {
  const evil = "(a+)+$";
  const victim = `${"a".repeat(40)}!`;
  const started = performance.now();
  // 直接匹配要回溯 2^40 次；这里只做结构检查，拒掉就返回。
  assert.equal(compileSafeRegex(evil, "i"), null);
  const scope = makeLooseMatcher(evil);
  assert.ok(scope);
  assert.equal(scope(victim), false);
  assert.equal(scope(`x ${evil} y`), true, "按子串匹配");
  const group = compileProxySubGroupFilter(evil, "regex");
  assert.equal(group(victim), false);
  assert.equal(group(`节点 ${evil}`), true);
  const keyword = compileProxySubGroupFilter(`regex:${evil}`, "any");
  assert.equal(keyword(victim), false);
  assert.equal(keyword(`节点 ${evil}`), true);
  assert.ok(performance.now() - started < 200, "不该跑到回溯里去");
  assert.match(String(validateProxySubGroupFilter(evil, "regex")), /太复杂/);
  assert.match(String(validateProxySubGroupFilter(`regex:${evil}`, "any")), /太复杂/);
  assert.equal(validateProxySubGroupFilter("港|HK", "regex"), null);
});

test("编译结果按标志 + 源记住；语法错误也记成 null", () => {
  const first = compileSafeRegex("港|HK", "i");
  assert.ok(first instanceof RegExp);
  assert.equal(compileSafeRegex("港|HK", "i"), first, "同一份只编一次");
  assert.notEqual(compileSafeRegex("港|HK", "g"), first, "标志不同是另一份");
  assert.equal(compileSafeRegex("香港 (", "i"), null);
  assert.equal(compileSafeRegex("香港 (", "i"), null);
  // 带 g 的实例共用：replace 每次从头开始，连续两次结果一样。
  const global = compileSafeRegex("a", "g")!;
  assert.equal("banana".replace(global, "o"), "bonono");
  assert.equal("banana".replace(global, "o"), "bonono");
});
