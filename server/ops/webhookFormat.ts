/*
  Webhook 推送的消息格式（纯函数，测试见 webhookFormat.test.ts）。

  看地址认平台，不让人选「这是 Discord 还是 Slack」：
  - Discord（discord.com / discordapp.com 的 /api/webhooks/…）：{ content }，最长 2000 字；
    带 allowed_mentions 关掉 @ 提醒 —— 事件消息里有用户名、规则名，不能让谁起个
    「@everyone」的名字就把整个频道叫起来。
  - Slack（hooks.slack.com）和 Mattermost（…/hooks/<id>）：{ text }，按 Slack 规矩转义 & < >。
  - 其它：通用 JSON { text, events: [...] }，给自己写接收端的人用，字段稳定。
*/
import { BILLING_TIME_ZONE } from "../../shared/billingTime";

export type WebhookFormat = "discord" | "slack" | "mattermost" | "generic";

export type WebhookEventItem = {
  time: Date;
  level: "info" | "warn" | "crit";
  kind: string;
  message: string;
  host: string | null;
  user: string | null;
};

const DISCORD_MAX_CONTENT = 2000;
const TEXT_MAX = 8000;

export function detectWebhookFormat(rawUrl: string): WebhookFormat {
  let url: URL;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    return "generic";
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const path = url.pathname;
  if (/(^|\.)discord(app)?\.com$/.test(host) && /^\/api\/(v\d+\/)?webhooks\//.test(path)) return "discord";
  if (host === "hooks.slack.com") return "slack";
  // Mattermost 的入站 Webhook：https://chat.example.com/hooks/<26 位 id>
  if (/^\/hooks\/[a-z0-9]{10,}\/?$/i.test(path)) return "mattermost";
  return "generic";
}

export const WEBHOOK_FORMAT_LABELS: Record<WebhookFormat, string> = {
  discord: "Discord",
  slack: "Slack",
  mattermost: "Mattermost",
  generic: "通用 JSON",
};

/**
 * 地址本身就是密钥（Discord / Slack 的 Webhook 地址谁拿到谁就能发），存下以后只给看个头尾：
 * 「https://discord.com/api/webhooks/…abcd」。查询串整个藏掉（有人把 token 放在 ?key= 里）。
 */
export function maskWebhookUrl(rawUrl: string | null | undefined): string {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "…";
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const keep = segments.slice(0, Math.min(2, Math.max(0, segments.length - 1)));
  const secret = `${segments.slice(keep.length).join("/")}${url.search}`;
  const tail = secret.length > 8 ? secret.slice(-4) : "";
  return `${url.origin}/${keep.length > 0 ? `${keep.join("/")}/` : ""}…${tail}`;
}

const LEVEL_ICON: Record<WebhookEventItem["level"], string> = { info: "🟢", warn: "🟠", crit: "🔴" };

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BILLING_TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 「10/12 09:31」（北京时间，和 Telegram 通知同一个时区）。 */
export function formatWebhookTime(value: Date): string {
  const time = value instanceof Date ? value : new Date(value);
  return Number.isFinite(time.getTime()) ? timeFormatter.format(time) : "";
}

function infoIcon(item: WebhookEventItem) {
  // 恢复类用绿点，其余普通消息用一个中性的点 —— 「登录了」不该是绿灯的意思
  if (item.level !== "info") return LEVEL_ICON[item.level];
  return /(?:\.online|\.recovered)$/.test(item.kind) ? LEVEL_ICON.info : "🔵";
}

/** 纯文本正文：一条时一行，多条时一行标题加每条一行。 */
export function buildWebhookText(items: readonly WebhookEventItem[], source = "NEX"): string {
  if (items.length === 0) return "";
  if (items.length === 1) {
    const item = items[0];
    return `${infoIcon(item)} [${source}] ${item.message} · ${formatWebhookTime(item.time)}`;
  }
  const lines = [`[${source}] ${items.length} 条新事件`];
  for (const item of items) lines.push(`${infoIcon(item)} ${formatWebhookTime(item.time)} ${item.message}`);
  return lines.join("\n");
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function escapeSlack(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildWebhookPayload(format: WebhookFormat, items: readonly WebhookEventItem[], source = "NEX"): Record<string, unknown> {
  const text = buildWebhookText(items, source);
  if (format === "discord") {
    return { content: truncate(text, DISCORD_MAX_CONTENT), allowed_mentions: { parse: [] } };
  }
  if (format === "slack" || format === "mattermost") {
    return { text: truncate(escapeSlack(text), TEXT_MAX) };
  }
  return {
    text: truncate(text, TEXT_MAX),
    events: items.map((item) => ({
      time: item.time.toISOString(),
      level: item.level,
      kind: item.kind,
      message: item.message,
      host: item.host,
      user: item.user,
    })),
  };
}
