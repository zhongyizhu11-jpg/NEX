/*
  自动换 IP 的通知：事件时间线（会被 Webhook 按 host.* 一类推出去）+ Telegram 管理员（按「主机上下线」那一类的个人开关过滤）。
  任何一路失败只记日志，不影响换 IP 本身。
*/
import { IP_CHANGE_TRIGGER_LABELS } from "../../shared/ipChange";
import type { IpChangeNotice } from "./service";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function hostName(notice: IpChangeNotice) {
  return String(notice.host?.name || "").trim() || `主机 #${notice.host?.id}`;
}

export function ipChangeNoticeEvent(notice: IpChangeNotice) {
  const name = hostName(notice);
  if (notice.kind === "changed") {
    return {
      kind: "host.ip_changed",
      level: "warn" as const,
      message: `${name} 已${IP_CHANGE_TRIGGER_LABELS[notice.trigger]}更换 IP：${notice.oldIp || "-"} → ${notice.newIp}${notice.ipRole === "entry" ? "（新入口）" : ""}`,
      data: { provider: notice.provider, oldIp: notice.oldIp, newIp: notice.newIp, ipRole: notice.ipRole, trigger: notice.trigger, notes: notice.notes },
    };
  }
  if (notice.kind === "failed") {
    return {
      kind: "host.ip_change_failed",
      level: "crit" as const,
      message: `${name} ${IP_CHANGE_TRIGGER_LABELS[notice.trigger]}更换 IP ${notice.uncertain ? "结果不确定" : "失败"}：${notice.error}`,
      data: { provider: notice.provider, trigger: notice.trigger, uncertain: notice.uncertain },
    };
  }
  return {
    kind: "host.ip_blocked_suspected",
    level: "warn" as const,
    message: `${name} 连续 ${notice.consecutiveFailures} 轮连不上大陆探测目标，疑似 IP 被墙。${notice.reason}`,
    data: { consecutiveFailures: notice.consecutiveFailures, threshold: notice.threshold },
  };
}

export function ipChangeTelegramText(notice: IpChangeNotice) {
  const name = escapeHtml(hostName(notice));
  const time = escapeHtml(new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }));
  if (notice.kind === "changed") {
    return [
      `<b>▌ NEX 自动换 IP：已更换</b>`,
      "",
      `<b>主机</b>：${name}`,
      `<b>方式</b>：${escapeHtml(IP_CHANGE_TRIGGER_LABELS[notice.trigger])}（${escapeHtml(notice.provider)}）`,
      `<b>旧 IP</b>：<code>${escapeHtml(notice.oldIp || "-")}</code>`,
      `<b>新 IP</b>：<code>${escapeHtml(notice.newIp)}</code>${notice.ipRole === "entry" ? "（新入口）" : ""}`,
      ...notice.notes.slice(0, 5).map((note) => `· ${escapeHtml(note)}`),
      `<b>时间</b>：${time}`,
    ].join("\n");
  }
  if (notice.kind === "failed") {
    return [
      `<b>▌ NEX 自动换 IP：${notice.uncertain ? "结果不确定" : "失败"}</b>`,
      "",
      `<b>主机</b>：${name}`,
      `<b>方式</b>：${escapeHtml(IP_CHANGE_TRIGGER_LABELS[notice.trigger])}（${escapeHtml(notice.provider)}）`,
      `<b>原因</b>：${escapeHtml(notice.error)}`,
      `<b>时间</b>：${time}`,
    ].join("\n");
  }
  return [
    `<b>▌ NEX 自动换 IP：疑似被墙</b>`,
    "",
    `<b>主机</b>：${name}`,
    `<b>情况</b>：连续 ${notice.consecutiveFailures} 轮所有大陆探测目标都不通（阈值 ${notice.threshold}）`,
    `<b>说明</b>：${escapeHtml(notice.reason)}`,
    `<b>时间</b>：${time}`,
  ].join("\n");
}

export async function deliverIpChangeNotice(notice: IpChangeNotice) {
  const event = ipChangeNoticeEvent(notice);
  try {
    const { recordPanelEvent } = await import("../ops/panelEvents");
    await recordPanelEvent({ ...event, hostId: Number(notice.host?.id) || null });
  } catch (error) {
    console.warn(`[IpChange] panel event failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const [{ getAllSettings }, { getTelegramAdminRecipients }, { filterTelegramRecipients }, { sendTelegramMessage }, { ENV }] = await Promise.all([
      import("../repositories/settingsRepository"),
      import("../repositories/userRepository"),
      import("../telegramNotifyPrefs"),
      import("../telegramBot"),
      import("../env"),
    ]);
    const settings = await getAllSettings();
    const envToken = ENV.telegramBotToken.trim();
    const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
    const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
    const text = ipChangeTelegramText(notice);
    if (botEnabled && botConfigured) {
      const recipients = await filterTelegramRecipients(await getTelegramAdminRecipients() as any[], "host");
      for (const user of recipients as any[]) {
        if (!user.telegramId) continue;
        await sendTelegramMessage(user.telegramId, text).catch((error) => {
          console.warn(`[IpChange] Telegram notify failed user=${user.id}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
    // Discord 那一路：和 Telegram 同一批管理员事件，各自独立（Discord 没开时什么也不做）
    const { notifyDiscordAdmins } = await import("../discordNotify");
    await notifyDiscordAdmins(text, { category: "host", label: `ip-change host=${notice.host?.id ?? "-"}` });
  } catch (error) {
    console.warn(`[IpChange] Telegram notify failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
