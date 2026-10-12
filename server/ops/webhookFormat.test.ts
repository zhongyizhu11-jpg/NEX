import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWebhookPayload, buildWebhookText, detectWebhookFormat, maskWebhookUrl, type WebhookEventItem } from "./webhookFormat";
import { parseWebhookCategories, shouldDeliverWebhookEvent, webhookCategoryOf, webhookLevelAtLeast } from "../../shared/opsWebhook";

const at = new Date("2026-10-12T01:31:00Z"); // 北京时间 09:31

function item(overrides: Partial<WebhookEventItem> = {}): WebhookEventItem {
  return { time: at, level: "warn", kind: "host.offline", message: "港-1 断线", host: "港-1", user: null, ...overrides };
}

test("format is detected from the URL", () => {
  assert.equal(detectWebhookFormat("https://discord.com/api/webhooks/123/abc"), "discord");
  assert.equal(detectWebhookFormat("https://discordapp.com/api/webhooks/123/abc"), "discord");
  assert.equal(detectWebhookFormat("https://ptb.discord.com/api/v10/webhooks/123/abc"), "discord");
  assert.equal(detectWebhookFormat("https://discord.com/channels/1/2"), "generic");
  assert.equal(detectWebhookFormat("https://hooks.slack.com/services/T0/B0/XYZ"), "slack");
  assert.equal(detectWebhookFormat("https://chat.example.com/hooks/abcdefghijklmnopqrstuvwxyz"), "mattermost");
  assert.equal(detectWebhookFormat("https://example.com/notify?token=1"), "generic");
  assert.equal(detectWebhookFormat("not a url"), "generic");
});

test("stored URLs are masked, keeping only the start of the path and the last four characters", () => {
  assert.equal(maskWebhookUrl("https://discord.com/api/webhooks/123456/secretTokenabcd"), "https://discord.com/api/webhooks/…abcd");
  assert.equal(maskWebhookUrl("https://hooks.slack.com/services/T000/B000/XXXXwxyz"), "https://hooks.slack.com/services/T000/…wxyz");
  assert.equal(maskWebhookUrl("https://example.com/hook?key=supersecret1234"), "https://example.com/…1234");
  assert.equal(maskWebhookUrl("https://example.com/a"), "https://example.com/…");
  assert.equal(maskWebhookUrl(""), "");
  assert.equal(maskWebhookUrl(null), "");
  for (const masked of [maskWebhookUrl("https://discord.com/api/webhooks/123456/secretTokenabcd"), maskWebhookUrl("https://example.com/hook?key=supersecret1234")]) {
    assert.ok(!masked.includes("secret"), masked);
  }
});

test("single and batched texts", () => {
  assert.equal(buildWebhookText([item()]), "🟠 [NEX] 港-1 断线 · 10/12 09:31");
  const batch = buildWebhookText([
    item(),
    item({ level: "info", kind: "host.online", message: "港-1 断线 35 分钟后恢复" }),
    item({ level: "info", kind: "account.login", message: "管理员 admin 登录" }),
  ]);
  assert.equal(batch, ["[NEX] 3 条新事件", "🟠 10/12 09:31 港-1 断线", "🟢 10/12 09:31 港-1 断线 35 分钟后恢复", "🔵 10/12 09:31 管理员 admin 登录"].join("\n"));
  assert.equal(buildWebhookText([]), "");
});

test("payload shape per platform", () => {
  const discord = buildWebhookPayload("discord", [item({ message: "@everyone 规则「x」出错" })]);
  assert.deepEqual(Object.keys(discord).sort(), ["allowed_mentions", "content"]);
  assert.deepEqual(discord.allowed_mentions, { parse: [] });
  const long = buildWebhookPayload("discord", Array.from({ length: 20 }, () => item({ message: "很长的一句话".repeat(40) })));
  assert.ok(String(long.content).length <= 2000);

  const slack = buildWebhookPayload("slack", [item({ message: "a <!channel> & b" })]);
  assert.deepEqual(Object.keys(slack), ["text"]);
  assert.match(String(slack.text), /a &lt;!channel&gt; &amp; b/);
  assert.deepEqual(Object.keys(buildWebhookPayload("mattermost", [item()])), ["text"]);

  const generic = buildWebhookPayload("generic", [item({ user: "alice" })]);
  assert.equal(generic.text, "🟠 [NEX] 港-1 断线 · 10/12 09:31");
  assert.deepEqual(generic.events, [{ time: "2026-10-12T01:31:00.000Z", level: "warn", kind: "host.offline", message: "港-1 断线", host: "港-1", user: "alice" }]);
});

test("category and level filtering", () => {
  assert.equal(webhookCategoryOf("host.rebooted"), "host");
  assert.equal(webhookCategoryOf("route.switched"), "rule");
  assert.equal(webhookCategoryOf("rule.error"), "rule");
  assert.equal(webhookCategoryOf("account.login_failed"), "account");
  assert.equal(webhookCategoryOf("security.finding"), "security");
  assert.equal(webhookCategoryOf("ops.backup"), null);

  assert.equal(webhookLevelAtLeast("crit", "warn"), true);
  assert.equal(webhookLevelAtLeast("info", "warn"), false);
  assert.equal(webhookLevelAtLeast("warn", "bogus"), true);

  const filter = { categories: parseWebhookCategories("host,rule"), minLevel: "warn" };
  assert.equal(shouldDeliverWebhookEvent({ kind: "host.offline", level: "warn" }, filter), true);
  assert.equal(shouldDeliverWebhookEvent({ kind: "host.online", level: "info" }, filter), false);
  assert.equal(shouldDeliverWebhookEvent({ kind: "route.precheck_failed", level: "warn" }, filter), true);
  assert.equal(shouldDeliverWebhookEvent({ kind: "user.quota_exhausted", level: "warn" }, filter), false);
  assert.equal(shouldDeliverWebhookEvent({ kind: "ops.backup", level: "crit" }, { categories: parseWebhookCategories(null), minLevel: "info" }), false);
});

test("categories default to all and drop unknown values", () => {
  assert.deepEqual(parseWebhookCategories(null), ["host", "user", "rule", "account", "security"]);
  assert.deepEqual(parseWebhookCategories(""), []);
  assert.deepEqual(parseWebhookCategories("security,bogus,host"), ["host", "security"]);
});
