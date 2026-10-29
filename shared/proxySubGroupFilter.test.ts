import assert from "node:assert/strict";
import test from "node:test";

import { compileProxySubGroupFilter, validateProxySubGroupFilter } from "./proxySubGroupFilter";

const names = ["🇭🇰 香港 01", "🇭🇰 香港 IPLC 02", "HK-03 0.5x", "🇯🇵 日本 01", "🇸🇬 新加坡 IPLC"];
const pick = (filter: string, match: "regex" | "any" | "all") => names.filter(compileProxySubGroupFilter(filter, match));

test("正则模式照旧：整个表达式一个正则，非法时按子串；留空全选", () => {
  assert.deepEqual(pick("港|HK", "regex"), ["🇭🇰 香港 01", "🇭🇰 香港 IPLC 02", "HK-03 0.5x"]);
  assert.deepEqual(pick("香港 (", "regex"), []);
  assert.deepEqual(pick("", "regex"), names);
});

test("任一关键词：逗号分隔命中一个就算，!词 排除", () => {
  assert.deepEqual(pick("香港, HK", "any"), ["🇭🇰 香港 01", "🇭🇰 香港 IPLC 02", "HK-03 0.5x"]);
  assert.deepEqual(pick("香港, HK, !IPLC", "any"), ["🇭🇰 香港 01", "HK-03 0.5x"]);
  assert.deepEqual(pick("!IPLC", "any"), ["🇭🇰 香港 01", "HK-03 0.5x", "🇯🇵 日本 01"], "只有排除词时其余都要");
});

test("全部关键词：都含才算；regex: 正则、=名 精确、&& 并且", () => {
  assert.deepEqual(pick("香港, IPLC", "all"), ["🇭🇰 香港 IPLC 02"]);
  assert.deepEqual(pick("regex:^HK-, 0.5", "all"), ["HK-03 0.5x"]);
  assert.deepEqual(pick("=🇯🇵 日本 01", "any"), ["🇯🇵 日本 01"]);
  assert.deepEqual(pick("香港 && !IPLC, 日本", "any"), ["🇭🇰 香港 01", "🇯🇵 日本 01"]);
  assert.deepEqual(pick("keyword:iplc", "any"), ["🇭🇰 香港 IPLC 02", "🇸🇬 新加坡 IPLC"], "不分大小写");
});

test("保存前的语法检查", () => {
  assert.equal(validateProxySubGroupFilter("香港, !IPLC", "all"), null);
  assert.match(validateProxySubGroupFilter("regex:(", "any") || "", /不合法/);
  assert.match(validateProxySubGroupFilter("香港, !", "any") || "", /「!」后面/);
  assert.match(validateProxySubGroupFilter("a && ", "all") || "", /「&&」/);
  assert.equal(validateProxySubGroupFilter("(", "regex"), null, "正则模式非法时按子串，不拦");
});
