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
  counterIncrease,
  DEFAULT_RESOURCE_ALERT_CONFIG,
  emptyLossWindowState,
  emptyResourceAlertHostState,
  evaluateLossSample,
  normalizeServiceRestarts,
  serviceRestartIncreases,
  type LossWindowState,
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
  "oomAlert",
  "crashAlert",
  "lossPercent",
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
  if (!next.enabled) {
    hostStates.clear();
    lossStates.clear();
  }
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

// ---------------- 每台主机串行 ----------------

/*
  同一台主机的样本按到达顺序一个一个判：判定前要读设置（有 await），两次心跳挨得近时
  后一次可能读到前一次还没写回的状态，把「连续超过」算断。按主机排队就没这个问题。
*/
const hostQueues = new Map<string, Promise<void>>();

function runSerialized(key: string, task: () => Promise<void>, label: string) {
  const previous = hostQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task).catch((error) => {
    appendPanelLog("warn", `[ResourceAlert] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  hostQueues.set(key, next);
  void next.finally(() => {
    if (hostQueues.get(key) === next) hostQueues.delete(key);
  });
}

// ---------------- 资源阈值 ----------------

const hostStates = new Map<number, ResourceAlertHostState>();
const MAX_TRACKED_HOSTS = 20_000;

function hostLabel(host: any) {
  return String(host?.name || "").trim().slice(0, 60) || `主机 #${Number(host?.id) || "?"}`;
}

/** 「CPU使用率」→「CPU 使用率」：中英文之间留空格，和全站文案一致。前后两个版本：标签后面接中文、标签前面接中文。 */
function spacedLabel(label: string) {
  const latin = /^[A-Za-z]/.test(label);
  return { before: latin ? `${label} ` : label, around: latin ? ` ${label} ` : label };
}

export function describeResourceTransition(host: any, transition: ResourceAlertTransition, config: ResourceAlertConfig) {
  const name = hostLabel(host);
  const label = resourceAlertMetricLabel(transition.metric);
  const spaced = spacedLabel(label);
  if (transition.kind === "fire") {
    return {
      event: `${name} 的${spaced.around}使用率 ${Math.round(transition.value)}%，已连续 ${formatOutageDuration(transition.durationSeconds)}超过 ${transition.threshold}%`,
      alert: {
        title: `NEX ${spaced.before}告警：${name}`,
        marker: "🟠",
        fields: [
          ["主机", `${name} (#${Number(host?.id) || "-"})`],
          [`${spaced.before}使用率`, `${Math.round(transition.value)}%（阈值 ${transition.threshold}%）`],
          ["持续", formatOutageDuration(transition.durationSeconds)],
        ],
        logLabel: `fire host=${Number(host?.id) || "-"} metric=${transition.metric}`,
      } satisfies AdminAlertMessage,
    };
  }
  return {
    event: `${name} 的${spaced.around}使用率回落到 ${Math.round(transition.value)}%（告警持续 ${formatOutageDuration(transition.durationSeconds)}，最高 ${Math.round(transition.peak)}%）`,
    alert: {
      title: `NEX ${spaced.before}恢复：${name}`,
      marker: "🟢",
      fields: [
        ["主机", `${name} (#${Number(host?.id) || "-"})`],
        [`${spaced.before}使用率`, `${Math.round(transition.value)}%（恢复线 ${Math.max(0, transition.threshold - config.recoverMarginPercent)}%）`],
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
  runSerialized(`resource:${hostId}`, async () => {
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
  }, `host=${hostId} evaluate`);
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

// ---------------- OOM / 服务崩溃 ----------------

type HostCounterState = { bootId: string; oomKillCount: number | null; serviceRestarts: Record<string, number> | null };
const counterStates = new Map<number, HostCounterState>();

function boundedPut<K, V>(map: Map<K, V>, key: K, value: V) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_HOSTS) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** 服务名 → 人话：「forwardx-realm-12.service」→「realm 规则 #12」。 */
export function describeServiceUnit(unit: string) {
  const name = unit.replace(/\.service$/, "");
  const rule = /^forwardx-(realm|socat|gost|singbox)-(\d+)$/.exec(name);
  if (rule) return `${rule[1]} 规则 #${rule[2]}`;
  const labels: Record<string, string> = {
    "forwardx-agent": "Agent",
    "forwardx-runtime": "gost 运行时",
    "forwardx-tunnel-runtime": "隧道运行时",
    "forwardx-tunnels": "FXP 隧道",
    "forwardx-nginx": "Nginx Stream",
  };
  return labels[name] || name;
}

/**
 * 心跳里的 oomKillCount / serviceRestarts（Agent ≥ 2.2.229 才报）。计数涨了就记事件、发告警。
 * 机器重启（bootId 变了）时两项都从头当基线。不抛错、不阻塞心跳。
 */
export function observeHostHealthCounters(host: any, input: { bootId?: string | null; oomKillCount?: unknown; serviceRestarts?: unknown }) {
  const hostId = Number(host?.id || 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return;
  const rawOom = Number(input.oomKillCount);
  const oomKillCount = input.oomKillCount !== undefined && input.oomKillCount !== null && Number.isInteger(rawOom) && rawOom >= 0 ? rawOom : null;
  const serviceRestarts = normalizeServiceRestarts(input.serviceRestarts);
  if (oomKillCount === null && serviceRestarts === null) return;
  const bootId = String(input.bootId || "");
  const previous = counterStates.get(hostId);
  const sameBoot = !!previous && previous.bootId === bootId;
  const next: HostCounterState = {
    bootId,
    oomKillCount: oomKillCount ?? (sameBoot ? previous!.oomKillCount : null),
    serviceRestarts: serviceRestarts ?? (sameBoot ? previous!.serviceRestarts : null),
  };
  boundedPut(counterStates, hostId, next);
  if (!sameBoot) return;
  const oomDelta = counterIncrease(previous!.oomKillCount, oomKillCount);
  const crashes = serviceRestarts ? serviceRestartIncreases(previous!.serviceRestarts, serviceRestarts) : [];
  if (oomDelta <= 0 && crashes.length === 0) return;
  void (async () => {
    const config = await readResourceAlertConfig();
    if (!config.enabled) return;
    const name = hostLabel(host);
    // 先把事件都记下，再发通知：时间线不该等 Telegram / 邮件。
    const alerts: AdminAlertMessage[] = [];
    if (oomDelta > 0 && config.oomAlert) {
      await recordPanelEvent({
        kind: "host.oom_killed",
        level: "crit",
        hostId,
        message: `${name} 内存耗尽，内核 OOM 杀掉了 ${oomDelta} 个进程（开机以来共 ${oomKillCount} 次）`,
        data: { delta: oomDelta, total: oomKillCount },
      });
      alerts.push({
        title: `NEX 内存耗尽（OOM）：${name}`,
        marker: "🔴",
        fields: [
          ["主机", `${name} (#${hostId})`],
          ["说明", `内核 OOM killer 杀掉了 ${oomDelta} 个进程，转发可能中断过`],
          ["开机以来", `${oomKillCount} 次`],
        ],
        logLabel: `oom host=${hostId}`,
      });
    }
    if (crashes.length > 0 && config.crashAlert) {
      const summary = crashes.slice(0, 5).map((item) => `${describeServiceUnit(item.unit)}${item.delta > 1 ? ` ×${item.delta}` : ""}`).join("、");
      const more = crashes.length > 5 ? ` 等 ${crashes.length} 个服务` : "";
      await recordPanelEvent({
        kind: "host.process_crashed",
        level: "warn",
        hostId,
        message: `${name} 上的 ${summary}${more} 崩溃后被自动重启`,
        data: { units: crashes.slice(0, 50) },
      });
      alerts.push({
        title: `NEX 进程崩溃：${name}`,
        marker: "🟠",
        fields: [
          ["主机", `${name} (#${hostId})`],
          ["崩溃的服务", `${summary}${more}`],
          ["说明", "systemd 已自动重启；反复出现请到主机详情查看日志"],
        ],
        logLabel: `crash host=${hostId}`,
      });
    }
    for (const alert of alerts) await sendAdminAlert(alert, { email: config.emailEnabled });
  })().catch((error) => {
    appendPanelLog("warn", `[ResourceAlert] host=${hostId} counters failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

// ---------------- 隧道丢包 ----------------

const lossStates = new Map<string, LossWindowState>();

async function tunnelName(tunnelId: number) {
  const q = quoteDbIdentifier;
  const rows = await queryRaw<any>(`SELECT ${q("name")} FROM ${q("tunnels")} WHERE ${q("id")} = ?`, [tunnelId]).catch(() => []);
  return String(rows[0]?.name || "").trim().slice(0, 60) || `隧道 #${tunnelId}`;
}

/**
 * 入口 Agent 报上来一批隧道探测结果（count 个包里成功 ok 个）之后调用。
 * 按（主机, 隧道）滑动 10 分钟窗口算丢包率。不抛错、不阻塞上报。
 */
export function observeTunnelProbeLoss(host: any, reports: Array<{ tunnelId: number; count: number; ok: number }>, nowMs = Date.now()) {
  const hostId = Number(host?.id || 0);
  if (!Number.isInteger(hostId) || hostId <= 0 || reports.length === 0) return;
  runSerialized(`loss:${hostId}`, async () => {
    const config = await readResourceAlertConfig();
    if (!config.enabled || config.lossPercent <= 0) {
      for (const key of [...lossStates.keys()]) if (key.startsWith(`${hostId}:`)) lossStates.delete(key);
      return;
    }
    const merged = new Map<number, { count: number; ok: number }>();
    for (const report of reports) {
      const tunnelId = Number(report.tunnelId || 0);
      if (!Number.isInteger(tunnelId) || tunnelId <= 0) continue;
      const current = merged.get(tunnelId) || { count: 0, ok: 0 };
      current.count += Math.max(0, Number(report.count) || 0);
      current.ok += Math.max(0, Number(report.ok) || 0);
      merged.set(tunnelId, current);
    }
    for (const [tunnelId, sample] of merged) {
      const key = `${hostId}:${tunnelId}`;
      const { state, transition } = evaluateLossSample(lossStates.get(key) ?? emptyLossWindowState(), config.lossPercent, sample, nowMs);
      boundedPut(lossStates, key, state);
      if (!transition) continue;
      const hostName = hostLabel(host);
      const name = await tunnelName(tunnelId);
      if (transition.kind === "fire") {
        await recordPanelEvent({
          kind: "host.packet_loss",
          level: "warn",
          hostId,
          message: `隧道「${name}」从 ${hostName} 探测丢包 ${transition.lossPercent}%（近 10 分钟 ${transition.probes} 次探测）`,
          data: { tunnelId, lossPercent: transition.lossPercent, probes: transition.probes },
        });
        await sendAdminAlert({
          title: `NEX 丢包告警：${name}`,
          marker: "🟠",
          fields: [
            ["隧道", `${name} (#${tunnelId})`],
            ["探测主机", `${hostName} (#${hostId})`],
            ["丢包率", `${transition.lossPercent}%（阈值 ${config.lossPercent}%，近 10 分钟 ${transition.probes} 次探测）`],
          ],
          logLabel: `loss host=${hostId} tunnel=${tunnelId}`,
        }, { email: config.emailEnabled });
      } else {
        await recordPanelEvent({
          kind: "host.packet_loss_recovered",
          level: "info",
          hostId,
          message: `隧道「${name}」从 ${hostName} 探测丢包回落到 ${transition.lossPercent}%（持续 ${formatOutageDuration(transition.durationSeconds)}，最高 ${transition.peak}%）`,
          data: { tunnelId, lossPercent: transition.lossPercent, peak: transition.peak, durationSeconds: transition.durationSeconds },
        });
        await sendAdminAlert({
          title: `NEX 丢包恢复：${name}`,
          marker: "🟢",
          fields: [
            ["隧道", `${name} (#${tunnelId})`],
            ["探测主机", `${hostName} (#${hostId})`],
            ["丢包率", `${transition.lossPercent}%（告警期间最高 ${transition.peak}%）`],
            ["告警持续", formatOutageDuration(transition.durationSeconds)],
          ],
          logLabel: `loss-recover host=${hostId} tunnel=${tunnelId}`,
        }, { email: config.emailEnabled });
      }
    }
  }, `host=${hostId} loss`);
}

/** 正在告警的丢包（故障看板用）。 */
export function getFiringLossAlerts(): Array<{ hostId: number; tunnelId: number; firedAt: number; peak: number }> {
  const out: Array<{ hostId: number; tunnelId: number; firedAt: number; peak: number }> = [];
  for (const [key, state] of lossStates) {
    if (!state.firing) continue;
    const [hostId, tunnelId] = key.split(":").map(Number);
    out.push({ hostId, tunnelId, firedAt: state.firedAt ?? 0, peak: state.peak });
  }
  return out;
}

/** 主机删掉时清掉它的状态。 */
export function forgetHostResourceAlertState(hostId: number) {
  const id = Number(hostId);
  hostStates.delete(id);
  counterStates.delete(id);
  for (const key of [...lossStates.keys()]) if (key.startsWith(`${id}:`)) lossStates.delete(key);
}

/** 测试用。 */
export function resetResourceAlertMemory() {
  hostStates.clear();
  counterStates.clear();
  lossStates.clear();
}
