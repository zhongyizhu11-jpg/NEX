import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { EVENT_WEBHOOK_CATEGORY_KEYS, EVENT_WEBHOOK_TEST_TYPE, eventWebhookCategoryOf } from "../../shared/eventWebhook";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DOC = fs.readFileSync(path.join(ROOT, "docs/guide/event-webhooks.md"), "utf8");

/*
  代码里写着 kind: "x.y" 却不是事件时间线里的事件的：
  · ops.webhook_test —— 旧「Webhook 通知」测试消息的一项，只拼进消息体，不落库，事件推送收不到。
*/
const NOT_PANEL_EVENTS = new Set(["ops.webhook_test"]);

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** 面板代码里实际在记的事件种类（扫 kind: "前缀.名字" 这种写法）。 */
function recordedKinds(): Set<string> {
  const kinds = new Set<string>();
  for (const file of sourceFiles(path.join(ROOT, "server"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bkind:\s*"([a-z]+\.[a-z_]+)"/g)) {
      if (!NOT_PANEL_EVENTS.has(match[1])) kinds.add(match[1]);
    }
  }
  return kinds;
}

test("代码里在记的每种事件都属于一个推送类别，并且写进了文档的事件清单", () => {
  const kinds = recordedKinds();
  assert.ok(kinds.size > 40, `只扫到 ${kinds.size} 种事件`);
  for (const kind of ["host.offline", "host.online", "route.switched", "route.unhealthy", "route.recovered", "rule.error"]) {
    assert.ok(kinds.has(kind), `没扫到 ${kind}，扫描的写法可能失效了`);
  }
  for (const kind of kinds) {
    assert.ok(eventWebhookCategoryOf(kind), `${kind} 不属于任何推送类别：要么加类别，要么写明为什么不推`);
    assert.ok(DOC.includes(`\`${kind}\``), `docs/guide/event-webhooks.md 的事件清单里没有 ${kind}`);
  }
  for (const name of NOT_PANEL_EVENTS) assert.ok(!DOC.includes(`\`${name}\``), `${name} 不是事件，不该出现在清单里`);
});

test("文档里每个类别都有一节，测试事件和请求头也写了", () => {
  for (const key of EVENT_WEBHOOK_CATEGORY_KEYS) assert.ok(DOC.includes(`（${key}）**`), `文档没有「${key}」这一类`);
  assert.equal(eventWebhookCategoryOf(EVENT_WEBHOOK_TEST_TYPE), null, "测试事件不属于任何类别，不会群发");
  assert.ok(DOC.includes(`\`${EVENT_WEBHOOK_TEST_TYPE}\``));
  for (const header of ["X-NEX-Timestamp", "X-NEX-Signature", "X-NEX-Event", "X-NEX-Delivery"]) assert.ok(DOC.includes(header), header);
  assert.equal(eventWebhookCategoryOf("weird"), null);
  assert.equal(eventWebhookCategoryOf(".host"), null);
  assert.equal(eventWebhookCategoryOf("hosts.offline"), null, "前缀要整段对上");
});
