import assert from "node:assert/strict";
import test from "node:test";

import { formatDateTime } from "./formatTime";

test("时间点：中文 24 小时制；空值、解析不出来的给占位", () => {
  const at = new Date(2026, 9, 16, 15, 40, 50);
  assert.equal(formatDateTime(at), at.toLocaleString("zh-CN", { hour12: false }));
  assert.match(formatDateTime(at), /15:40:50/);
  assert.doesNotMatch(formatDateTime(at), /AM|PM/);
  assert.equal(formatDateTime(at.getTime()), formatDateTime(at), "毫秒数也认");
  assert.equal(formatDateTime(at.toISOString()), formatDateTime(at), "字符串也认");
  assert.equal(formatDateTime(null), "—");
  assert.equal(formatDateTime(undefined), "—");
  assert.equal(formatDateTime(""), "—");
  assert.equal(formatDateTime("not a date"), "—");
  assert.equal(formatDateTime(null, "-"), "-");
  assert.equal(formatDateTime("bad", ""), "");
});
