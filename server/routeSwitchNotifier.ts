import { describeRouteReason, type RouteEventKind } from "../shared/routeGroup";
import { sendTelegramMessage } from "./telegramBot";
import { getTelegramAdminRecipients } from "./repositories/userRepository";
import { isTelegramBotReady } from "./telegramReady";
import { filterTelegramRecipients } from "./telegramNotifyPrefs";

/*
  线路组切换的 Telegram 提醒。

  转发组（DNS 那套）早就有切换提醒，规则级主备一直没有：它切得快、切得静，切完面板
  只在日志里留一行。开了「异常 TG 提醒」的规则现在两件事会响：真的切了线，和计划里的
  切换因为预检没过而**没**切 —— 后者更该知道：晚高峰该走 B 的时候还在 A 上。

  线路异常 / 恢复（unhealthy / recovered）不发：一条备线抖一下就响一次，很快没人看了；
  它们在「最近切换」列表里能查到。
*/

export type RouteSwitchNotifyPayload = {
  rule: any;
  host?: any | null;
  kind: Extract<RouteEventKind, "switch" | "precheck_failed">;
  fromLabel?: string | null;
  fromValue?: string | null;
  toLabel?: string | null;
  toValue?: string | null;
  reason?: string | null;
  score?: number | null;
  latencyMs?: number | null;
};

const NOTIFY_COOLDOWN_MS = 60 * 1000;
const lastNotifyAt = new Map<string, number>();

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTime(value = new Date()) {
  return value.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function valueOrDash(value: unknown) {
  const text = String(value || "").trim();
  return text || "-";
}

function hostName(host: any, rule: any) {
  return String(host?.name || "").trim() || (rule?.hostId ? `主机 ${rule.hostId}` : "-");
}

/** 同一条规则同一种事件一分钟只响一次：来回切三次，第一次就够了。 */
export function shouldNotifyRouteSwitch(ruleId: number, kind: string, now = Date.now()) {
  const key = `${ruleId}:${kind}`;
  const last = lastNotifyAt.get(key) || 0;
  if (now - last < NOTIFY_COOLDOWN_MS) return false;
  lastNotifyAt.set(key, now);
  if (lastNotifyAt.size > 10_000) {
    for (const [entry, at] of lastNotifyAt) {
      if (now - at >= NOTIFY_COOLDOWN_MS) lastNotifyAt.delete(entry);
    }
  }
  return true;
}

export function routeSwitchMessage(payload: RouteSwitchNotifyPayload) {
  const { rule, host } = payload;
  const isPrecheck = payload.kind === "precheck_failed";
  const title = isPrecheck ? "NEX 线路组计划切换未执行" : "NEX 线路组切换提醒";
  const reason = describeRouteReason(payload.reason) || "-";
  const lines = [
    `<b>${isPrecheck ? "🟡" : "🔁"} ${escapeHtml(title)}</b>`,
    "",
    `<b>规则</b>：${escapeHtml(rule?.name || "未命名规则")} (#${escapeHtml(rule?.id || "-")})`,
    `<b>入口</b>：${escapeHtml(hostName(host, rule))} · 端口 <code>${escapeHtml(rule?.sourcePort || "-")}</code>`,
    isPrecheck
      ? `<b>计划切到</b>：${escapeHtml(valueOrDash(payload.toLabel))} / <code>${escapeHtml(valueOrDash(payload.toValue))}</code>`
      : `<b>切换前</b>：${escapeHtml(valueOrDash(payload.fromLabel))} / <code>${escapeHtml(valueOrDash(payload.fromValue))}</code>`,
    isPrecheck
      ? `<b>继续使用</b>：${escapeHtml(valueOrDash(payload.fromLabel))} / <code>${escapeHtml(valueOrDash(payload.fromValue))}</code>`
      : `<b>切换后</b>：${escapeHtml(valueOrDash(payload.toLabel))} / <code>${escapeHtml(valueOrDash(payload.toValue))}</code>`,
    `<b>原因</b>：${escapeHtml(reason)}`,
    typeof payload.score === "number" && payload.score >= 0 ? `<b>评分</b>：${escapeHtml(payload.score)}` : "",
    typeof payload.latencyMs === "number" && payload.latencyMs > 0 ? `<b>延迟</b>：${escapeHtml(payload.latencyMs)} ms` : "",
    `<b>时间</b>：${escapeHtml(formatTime())}`,
  ].filter(Boolean);
  return lines.join("\n");
}

export async function notifyRouteSwitch(payload: RouteSwitchNotifyPayload) {
  const ruleId = Number(payload.rule?.id || 0);
  if (!ruleId || !payload.rule?.telegramErrorNotifyEnabled) return;
  if (!(await isTelegramBotReady())) return;
  if (!shouldNotifyRouteSwitch(ruleId, payload.kind)) return;
  const recipients = await filterTelegramRecipients(await getTelegramAdminRecipients() as any[], "route");
  if (recipients.length === 0) return;
  const text = routeSwitchMessage(payload);
  let sent = 0;
  let failed = 0;
  for (const user of recipients as any[]) {
    if (!user.telegramId) continue;
    try {
      await sendTelegramMessage(user.telegramId, text);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[Telegram] Route switch notify failed user=${user.id} rule=${ruleId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (sent > 0 || failed > 0) {
    console.info(`[Telegram] Route switch notify rule=${ruleId} kind=${payload.kind} sent=${sent} failed=${failed}`);
  }
}

/** 测试用。 */
export function resetRouteSwitchNotifyMemory() {
  lastNotifyAt.clear();
}
