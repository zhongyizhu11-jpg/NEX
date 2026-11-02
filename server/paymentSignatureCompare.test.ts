import assert from "node:assert/strict";
import test from "node:test";
import { easyPaySignatureMatches } from "./payment";

test("易支付签名比较：大小写不敏感，长度不同、缺失、非字符串都不算", () => {
  const expected = "0123456789abcdef0123456789abcdef";
  assert.equal(easyPaySignatureMatches(expected, expected), true);
  assert.equal(easyPaySignatureMatches(expected, expected.toUpperCase()), true);
  assert.equal(easyPaySignatureMatches(expected, `${expected}0`), false);
  assert.equal(easyPaySignatureMatches(expected, expected.slice(1)), false);
  assert.equal(easyPaySignatureMatches(expected, "f".repeat(32)), false);
  assert.equal(easyPaySignatureMatches(expected, ""), false);
  assert.equal(easyPaySignatureMatches(expected, undefined), false);
  assert.equal(easyPaySignatureMatches(expected, ["x"]), false);
  // 多字节字符：按字节比长度，不会因为字符数相同而抛错。
  assert.equal(easyPaySignatureMatches(expected, "é".repeat(32)), false);
});
