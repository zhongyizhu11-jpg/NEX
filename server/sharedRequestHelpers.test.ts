import assert from "node:assert/strict";
import test from "node:test";

import { clientIp } from "./clientIp";
import { createKeyedSerial } from "./keyedSerial";
import { escapeHtmlAttr, escapeHtmlText } from "../shared/htmlEscape";

test("escapeHtmlText 只转 & < >（Telegram HTML 模式就要这三个），escapeHtmlAttr 再转引号", () => {
  assert.equal(escapeHtmlText(`a & <b> "c" 'd'`), `a &amp; &lt;b&gt; "c" 'd'`);
  assert.equal(escapeHtmlAttr(`a & <b> "c" 'd'`), "a &amp; &lt;b&gt; &quot;c&quot; &#39;d&#39;");
  assert.equal(escapeHtmlText(null), "");
  assert.equal(escapeHtmlText(undefined), "");
  assert.equal(escapeHtmlText(0), "0");
  assert.equal(escapeHtmlAttr("&amp;"), "&amp;amp;");
});

test("clientIp：用 req.ip，IPv4 映射写法还原成 IPv4，取不到给兜底值", () => {
  assert.equal(clientIp({ ip: "::ffff:1.2.3.4" }), "1.2.3.4");
  assert.equal(clientIp({ ip: "::FFFF:10.0.0.1" }), "10.0.0.1");
  assert.equal(clientIp({ ip: "2001:db8::1" }), "2001:db8::1");
  assert.equal(clientIp({ ip: "::ffff:abcd" }), "::ffff:abcd", "不是 IPv4 映射的不动");
  assert.equal(clientIp({ ip: "", socket: { remoteAddress: "::ffff:5.6.7.8" } }), "5.6.7.8");
  assert.equal(clientIp({}), "");
  assert.equal(clientIp(undefined, "unknown"), "unknown");
  assert.equal(clientIp({ ip: "" }, "unknown"), "unknown");
});

test("createKeyedSerial：同一个键排队跑，不同键并行，出错不卡住后面的", async () => {
  const run = createKeyedSerial<number>();
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const task = (label: string, ms: number, fail = false) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start ${label}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`end ${label}`);
    active -= 1;
    if (fail) throw new Error(label);
    return label;
  };
  const results = await Promise.allSettled([
    run(1, task("a", 30, true)),
    run(1, task("b", 5)),
    run(1, task("c", 5)),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.deepEqual(results.slice(1).map((item) => (item as PromiseFulfilledResult<string>).value), ["b", "c"]);
  assert.equal(maxActive, 1, "同一个键不能并行");
  assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);

  active = 0;
  maxActive = 0;
  await Promise.all([run(1, task("x", 20)), run(2, task("y", 20))]);
  assert.equal(maxActive, 2, "不同键并行");
});
