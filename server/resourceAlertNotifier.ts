/*
  资源告警：心跳里的 CPU / 内存 / 磁盘持续超过阈值时，记一条事件、发给管理员（Telegram / Discord /
  邮件），回落后再报一次恢复。判定在 shared/resourceAlert.ts，这里只管存状态和发消息。

  - 设置存在 system_settings 的 ops.resourceAlert.* 里，读走 getAllSettings 的缓存，心跳路径上
    不会多一次查库。
  - 每台主机的判定状态只在内存里：面板重启后从头计时，正在告警的那台会在持续时间到了之后再报一次
    ——宁可多报一次，也不要因为重启把一台一直在 100% 的机器漏掉。
  - Telegram / Discord 走「资源告警」这一类（每个管理员可以在机器人菜单里自己关掉）；邮件发给
    有邮箱的管理员，需要面板的邮件服务已经开着。
  - observeHostResourceSample 不抛错、不阻塞心跳：发消息全在后台做。
*/
import { getAllSettings, setSettings } from "./repositories/settingsRepository";
import { queryRaw, quoteDbIdentifier } from "./dbRuntime";
import { appendPanelLog } from "./_core/panelLogger";
import { ENV } from "./env";
import { recordPanelEvent } from "./ops/panelEvents";
import {
  DEFAULT_RESOURCE_ALERT_CONFIG,
  emptyResourceAlertHostState,
  evaluateResourceAlertSample,
  normalizeResourceAlertConfig,
  resourceAlertMetricLabel,
  type ResourceAlertConfig,
  type ResourceAlertHostState,
  type ResourceAlertSample,
  type ResourceAlertTransition,
} from "../shared/resourceAlert";
import { formatOutageDuration } from "../shared/opsEvents";

const KEY_PREFIX = "ops.resourceAlert.";
const CONFIG_KEYS: Array<keyof ResourceAlertConfig> = [
  "enabled",
  "cpuPercent",
  "memoryPercent",
  "diskPercent",
  "sustainSeconds",
  "recoverMarginPercent",
  "emailEnabled",
];

export async function readResourceAlertConfig(): Promise<ResourceAlertConfig> {
  const settings = await getAllSettings().catch(() => ({} as Record<string, string | null>));
  const raw: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const value = settings[`${KEY_PREFIX}${key}`];
    if (value !== undefined && value !== null && value !== "") raw[key] = value;
  }
  return normalizeResourceAlertConfig({ ...DEFAULT_RESOURCE_ALERT_CONFIG, ...raw } as any);
}

export async function saveResourceAlertConfig(input: Partial<ResourceAlertConfig>): Promise<ResourceAlertConfig> {
  const current = await readResourceAlertConfig();
  const next = normalizeResourceAlertConfig({ ...current, ...input });
  const map: Record<string, string> = {};
  for (const key of CONFIG_KEYS) map[`${KEY_PREFIX}${key}`] = String(next[key]);
  await setSettings(map);
  if (!next.enabled) hostStates.clear();
  return next;
}

// ---------------- 管理员告警投递（资源告警、OOM、进程崩溃、丢包共用） ----------------

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTime(value = new Date()) {
  return value.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function telegramBotReady(settings: Record<string, string | null>) {
  const envToken = ENV.telegramBotToken.trim();
  const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
  return botEnabled && botConfigured;
}

async function adminEmails(): Promise<string[]> {
  const q = quoteDbIdentifier;
  const rows = await queryRaw<any>(
    `SELECT ${q("email")}, ${q("accountEnabled")} FROM ${q("users")} WHERE ${q("role")} = 'admin' AND ${q("email")} IS NOT NULL`,
  );
  const seen = new Set<string>();
  for (const row of rows) {
    // 布尔列在 SQLite / MySQL 是 0/1，在 PG 是 true/false：在这边判断，不往 SQL 里塞布尔参数。
    if (row.accountEnabled === false || row.accountEnabled === 0 || row.accountEnabled === "0" || row.accountEnabled === "f") continue;
    const email = String(row.email || "").trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) seen.add(email.toLowerCase());
  }
  return [...seen];
}

export type AdminAlertMessage = {
  /** 邮件标题，同时是 Telegram 消息的第一行（加粗）。 */
  title: string;
  marker: string;
  /** [标签, 值]；值按纯文本转义。 */
  fields: Array<[string, string]>;
  logLabel: string;
};

function alertHtml(message: AdminAlertMessage) {
  return [
    `<b>${message.marker} ${escapeHtml(message.title)}</b>`,
    "",
    ...message.fields.map(([label, value]) => `<b>${escapeHtml(label)}</b>：${escapeHtml(value)}`),
    `<b>时间</b>：${escapeHtml(formatTime())}`,
  ].join("\n");
}

/** 发给管理员：Telegram、Discord（「资源告警」这一类）和可选的邮件。永远不抛。 */
export async function sendAdminAlert(message: AdminAlertMessage, options: { email: boolean }) {
  const html = alertHtml(message);
  try {
    const settings = await getAllSettings();
    if (telegramBotReady(settings)) {
      const [{ getTelegramAdminRecipients }, { filterTelegramRecipients }, { sendTelegramMessage }] = await Promise.all([
        import("./repositories/userRepository"),
        import("./telegramNotifyPrefs"),
        import("./telegramBot"),
      ]);
      const recipients = await filterTelegramRecipients(await getTelegramAdminRecipients() as any[], "resource");
      for (const user of recipients as any[]) {
        if (!user.telegramId) continue;
        await sendTelegramMessage(user.telegramId, html).catch((error: unknown) => {
          appendPanelLog("warn", `[ResourceAlert] Telegram ${message.logLabel} user=${user.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  } catch (error) {
    appendPanelLog("warn", `[ResourceAlert] Telegram ${message.logLabel} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const { notifyDiscordAdmins } = await import("./discordNotify");
    await notifyDiscordAdmins(html, { category: "resource", label: `resource-alert ${message.logLabel}` });
  } catch (error) {
    appendPanelLog("warn", `[ResourceAlert] Discord ${message.logLabel} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!options.email) return;
  try {
    const { sendMail, getEmailConfig } = await import("./email");
    if (!(await getEmailConfig()).enabled) return;
    const text = [message.title, "", ...message.fields.map(([label, value]) => `${label}：${value}`), `时间：${formatTime()}`].join("\n");
    for (const to of await adminEmails()) {
      await sendMail({ to, subject: `[NEX] ${message.title}`, text }).catch((error: unknown) => {
        appendPanelLog("warn", `[ResourceAlert] email ${message.logLabel} to=${to} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  } catch (error) {
    appendPanelLog("warn", `[ResourceAlert] email ${message.logLabel} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------- 资源阈值 ----------------

const hostStates = new Map<number, ResourceAlertHostState>();
const MAX_TRACKED_HOSTS = 20_000;

function hostLabel(host: any) {
  return String(host?.name || "").trim().slice(0, 60) || `主机 #${Number(host?.id) || "?"}`;
}

export function describeResourceTransition(host: any, transition: ResourceAlertTransition, config: ResourceAlertConfig) {
  const name = hostLabel(host);
  const label = resourceAlertMetricLabel(transition.metric);
  if (transition.kind === "fire") {
    return {
      event: `${name} 的${label}使用率 ${Math.round(transition.value)}%，已连续 ${formatOutageDuration(transition.durationSeconds)}超过 ${transition.threshold}%`,
      alert: {
        title: `NEX ${label}告警：${name}`,
        marker: "🟠",
        fields: [
          ["主机", `${name} (#${Number(host?.id) || "-"})`],
          [`${label}使用率`, `${Math.round(transition.value)}%（阈值 ${transition.threshold}%）`],
          ["持续", formatOutageDuration(transition.durationSeconds)],
        ],
        logLabel: `fire host=${Number(host?.id) || "-"} metric=${transition.metric}`,
      } satisfies AdminAlertMessage,
    };
  }
  return {
    event: `${name} 的${label}使用率回落到 ${Math.round(transition.value)}%（告警持续 ${formatOutageDuration(transition.durationSeconds)}，最高 ${Math.round(transition.peak)}%）`,
    alert: {
      title: `NEX ${label}恢复：${name}`,
      marker: "🟢",
      fields: [
        ["主机", `${name} (#${Number(host?.id) || "-"})`],
        [`${label}使用率`, `${Math.round(transition.value)}%（恢复线 ${Math.max(0, transition.threshold - config.recoverMarginPercent)}%）`],
        ["告警期间最高", `${Math.round(transition.peak)}%`],
        ["告警持续", formatOutageDuration(transition.durationSeconds)],
      ],
      logLabel: `recover host=${Number(host?.id) || "-"} metric=${transition.metric}`,
    } satisfies AdminAlertMessage,
  };
}

/**
 * 心跳写完指标后调用。sample 里的值是百分比（0–100），没报的项给 null。
 * 不抛错、不等发消息。
 */
export function observeHostResourceSample(host: any, sample: ResourceAlertSample, nowMs = Date.now()) {
  const hostId = Number(host?.id || 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return;
  void (async () => {
    const config = await readResourceAlertConfig();
    if (!config.enabled) {
      hostStates.delete(hostId);
      return;
    }
    const previous = hostStates.get(hostId) ?? emptyResourceAlertHostState();
    const { state, transitions } = evaluateResourceAlertSample(previous, config, sample, nowMs);
    hostStates.delete(hostId);
    hostStates.set(hostId, state);
    while (hostStates.size > MAX_TRACKED_HOSTS) {
      const oldest = hostStates.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      hostStates.delete(oldest);
    }
    for (const transition of transitions) {
      const described = describeResourceTransition(host, transition, config);
      await recordPanelEvent({
        kind: transition.kind === "fire" ? "host.resource_high" : "host.resource_recovered",
        level: transition.kind === "fire" ? "warn" : "info",
        hostId,
        message: described.event,
        data: { metric: transition.metric, value: transition.value, threshold: transition.threshold, peak: transition.peak, durationSeconds: transition.durationSeconds },
      });
      await sendAdminAlert(described.alert, { email: config.emailEnabled });
    }
  })().catch((error) => {
    appendPanelLog("warn", `[ResourceAlert] host=${hostId} evaluate failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** 某台主机现在哪几项正在告警（主机列表 / 故障看板用）。 */
export function getFiringResourceAlerts(): Array<{ hostId: number; metric: string; firedAt: number; peak: number }> {
  const out: Array<{ hostId: number; metric: string; firedAt: number; peak: number }> = [];
  for (const [hostId, state] of hostStates) {
    for (const metric of ["cpu", "memory", "disk"] as const) {
      const item = state[metric];
      if (item.firing) out.push({ hostId, metric, firedAt: item.firedAt ?? 0, peak: item.peak });
    }
  }
  return out;
}

/** 主机删掉时清掉它的状态。 */
export function forgetHostResourceAlertState(hostId: number) {
  hostStates.delete(Number(hostId));
}

/** 测试用。 */
export function resetResourceAlertMemory() {
  hostStates.clear();
}
