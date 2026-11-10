import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { takePasswordResetToken } from "./passwordResetLink";

function fakeHistory() {
  const replaced: string[] = [];
  return { replaced, history: { state: null, replaceState: (_state: unknown, _title: string, next: string) => { replaced.push(next); } } };
}

test("重置令牌一读到就从地址栏和历史记录里拿掉，别的 # 参数留着", () => {
  const token = `nxr_${"b".repeat(43)}`;
  const { replaced, history } = fakeHistory();
  assert.equal(takePasswordResetToken({ hash: `#password-reset=${token}&other=1`, pathname: "/login", search: "?x=1" }, history), token);
  assert.deepEqual(replaced, ["/login?x=1#other=1"]);
});

test("没有令牌时什么都不动；超长的当成坏链接", () => {
  const { replaced, history } = fakeHistory();
  assert.equal(takePasswordResetToken({ hash: "#googleTwoFactor=abc", pathname: "/login", search: "" }, history), null);
  assert.deepEqual(replaced, []);
  assert.equal(takePasswordResetToken({ hash: `#password-reset=${"x".repeat(500)}`, pathname: "/login", search: "" }, history), "");
  assert.deepEqual(replaced, ["/login"]);
});

test("令牌只走 # 和请求体，从不放进查询串", () => {
  const dialog = fs.readFileSync(path.join(import.meta.dirname, "PasswordResetDialog.tsx"), "utf8");
  assert.match(dialog, /takePasswordResetToken\(window\.location, window\.history\)/);
  assert.doesNotMatch(dialog, /[?&]password-reset=/);
});
