/*
  经其他主机连面板（#8）—— 面板这头：扩展模块 "relay"、配置读写、自动切换。

  一台主机的指令（每轮都发，哪怕是空的：Agent 只有收到指令才会改设置，「改回直连」也得发）：
    via    经由的那台主机的入口地址:中转端口（没设 = 不带）
    listen 它自己给别人当中转时：{port, target: 面板的 host:port, allow: 那几台主机的 IP}
  Agent 回报的状态只放内存（几分钟就会重新报一次），界面上那句「现在：……」由它算出来。

  自动切换：每分钟给开了「自动切换」、还在直连的主机记一个在线样本；4 小时里累计离线超过
  设定的分钟数，就切到选好的中转一次，记事件、发通知。之后不会自动切回 —— 切回直连要人来点。
*/
import { getHostEntryAddress } from "../../shared/hostEntryAddress";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawEpochToDate } from "../dbRuntime";
import * as db from "../db";
import { isHostConsideredOnline } from "../hostHeartbeatPolicy";
import { getConfiguredPanelUrl } from "../agentPanelUrl";
import { reserveAvailableHostPort } from "../portReservations";
import { registerAgentExtModule, wakeAgentExt, type AgentExtHost } from "./agentExt";
import { recordPanelEvent } from "./panelEvents";
import { invalidateOpsReservedPorts, registerOpsReservedPortsLoader } from "./opsReservedPorts";
import {
  OfflineSampler,
  joinHostPort,
  normalizeThreshold,
  panelAddrFromUrl,
  relayAllowList,
  relayCandidateIssue,
  shouldAutoSwitch,
  type RelayConfigRow,
  type RelayReport,
} from "./agentRelayLogic";

const TABLE = "ops_agent_relay";
const q = quoteDbIdentifier;

// ---------------------------------------------------------------- 配置

let configCache: Map<number, RelayConfigRow> | null = null;
let configCacheAt = 0;
const CONFIG_CACHE_MS = 15_000;

function rowToConfig(row: Record<string, any>): RelayConfigRow {
  const optional = (value: unknown) => {
    const n = Math.floor(Number(value));
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const switchedAt = rawEpochToDate(row.autoSwitchedAt);
  return {
    hostId: Number(row.hostId),
    viaHostId: optional(row.viaHostId),
    autoViaHostId: optional(row.autoViaHostId),
    autoThresholdMinutes: normalizeThreshold(row.autoThresholdMinutes),
    autoSwitchedAt: switchedAt ? Math.floor(switchedAt.getTime() / 1000) : null,
    listenPort: optional(row.listenPort),
  };
}

export async function loadRelayConfigs(force = false): Promise<Map<number, RelayConfigRow>> {
  if (!force && configCache && Date.now() - configCacheAt < CONFIG_CACHE_MS) return configCache;
  const rows = await queryRaw(`SELECT * FROM ${q(TABLE)}`);
  const map = new Map<number, RelayConfigRow>();
  for (const row of rows) {
    const config = rowToConfig(row);
    if (config.hostId > 0) map.set(config.hostId, config);
  }
  configCache = map;
  configCacheAt = Date.now();
  return map;
}

function invalidateRelayConfigs() {
  configCache = null;
  configCacheAt = 0;
  invalidateOpsReservedPorts();
}

export function emptyRelayConfig(hostId: number): RelayConfigRow {
  return { hostId, viaHostId: null, autoViaHostId: null, autoThresholdMinutes: normalizeThreshold(undefined), autoSwitchedAt: null, listenPort: null };
}

export async function writeRelayConfig(config: RelayConfigRow) {
  const values = {
    viaHostId: config.viaHostId,
    autoViaHostId: config.autoViaHostId,
    autoThresholdMinutes: config.autoThresholdMinutes,
    autoSwitchedAt: config.autoSwitchedAt,
    listenPort: config.listenPort,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  const existing = await queryRaw(`SELECT ${q("id")} FROM ${q(TABLE)} WHERE ${q("hostId")} = ?`, [config.hostId]);
  if (existing.length > 0) {
    const columns = Object.keys(values);
    await executeRaw(
      `UPDATE ${q(TABLE)} SET ${columns.map((column) => `${q(column)} = ?`).join(", ")} WHERE ${q("hostId")} = ?`,
      [...columns.map((column) => (values as any)[column]), config.hostId],
    );
  } else {
    await insertAndGetId(TABLE, { hostId: config.hostId, ...values });
  }
  invalidateRelayConfigs();
}

registerOpsReservedPortsLoader("agentRelay", async () => {
  const configs = await loadRelayConfigs();
  return Array.from(configs.values())
    .filter((row) => row.listenPort)
    .map((row) => ({ hostId: row.hostId, port: Number(row.listenPort) }));
});

/** 给中转主机分一个中转端口（已有就沿用）。按主机的端口策略挑，避开规则 / 隧道 / 入站占着的。 */
export async function ensureRelayListenPort(relayHostId: number): Promise<number> {
  const configs = await loadRelayConfigs(true);
  const current = configs.get(relayHostId) || emptyRelayConfig(relayHostId);
  if (current.listenPort) return current.listenPort;
  const reservation = await reserveAvailableHostPort({
    hostId: relayHostId,
    protocol: "tcp",
    findPort: (reserved) => db.findAvailablePort(relayHostId, null, null, "tcp", reserved),
    isUsed: (port) => db.isPortUsedOnHost(relayHostId, port, undefined, "tcp"),
  });
  if (!reservation) throw new Error("这台中转主机的端口区间里已经没有空端口");
  try {
    await writeRelayConfig({ ...current, listenPort: reservation.port });
  } finally {
    reservation.release();
  }
  return reservation.port;
}

/** 没人再经由它了就把中转端口放掉，让规则可以用。 */
export async function releaseRelayListenPortIfUnused(relayHostId: number) {
  const configs = await loadRelayConfigs(true);
  const current = configs.get(relayHostId);
  if (!current?.listenPort) return;
  const stillUsed = Array.from(configs.values()).some((row) => row.viaHostId === relayHostId);
  if (stillUsed) return;
  await writeRelayConfig({ ...current, listenPort: null });
  wakeAgentExt(relayHostId, "relay-released");
}

// ---------------------------------------------------------------- Agent 回报

type StoredReport = { report: RelayReport; at: number };
const reports = new Map<number, StoredReport>();

export function getRelayReport(hostId: number): StoredReport | null {
  return reports.get(hostId) || null;
}

function cleanReport(raw: unknown): RelayReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;
  const text = (value: unknown, max = 300) => (typeof value === "string" ? value.slice(0, max) : undefined);
  const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : undefined);
  const listen = r.listen && typeof r.listen === "object"
    ? { port: num(r.listen.port), listening: !!r.listen.listening, target: text(r.listen.target, 260), error: text(r.listen.error) }
    : null;
  return {
    role: text(r.role, 16),
    via: text(r.via, 260),
    viaActive: !!r.viaActive,
    fallbackActive: !!r.fallbackActive,
    fallbackSince: num(r.fallbackSince),
    fallbackCount: num(r.fallbackCount),
    lastError: text(r.lastError),
    lastErrorAt: num(r.lastErrorAt),
    panelAddr: text(r.panelAddr, 260),
    publicIps: Array.isArray(r.publicIps) ? r.publicIps.slice(0, 4).map((ip: unknown) => String(ip).slice(0, 64)) : undefined,
    listen,
    relayedConnections: num(r.relayedConnections),
    activeConnections: num(r.activeConnections),
    rejectedConnections: num(r.rejectedConnections),
    failedConnections: num(r.failedConnections),
  };
}

async function hostName(hostId: number) {
  const names = await db.getHostNamesByIds([hostId]).catch(() => new Map<number, string>());
  return names.get(hostId) || `#${hostId}`;
}

async function ingestRelayReport(host: AgentExtHost, raw: unknown) {
  const report = cleanReport(raw);
  if (!report) return;
  const hostId = Number(host.id);
  const previous = reports.get(hostId)?.report;
  reports.set(hostId, { report, at: Date.now() });
  // 中转坏了退回直连：记一条（每次退回只记一次）。
  const fellBack = report.fallbackActive && !!report.lastError && (report.fallbackCount || 0) > (previous?.fallbackCount || 0);
  if (previous && fellBack) {
    const name = String(host.name || "").trim() || `#${hostId}`;
    void recordPanelEvent({
      kind: "host.relay_fallback",
      level: "warn",
      hostId,
      message: `${name} 经中转连不上面板，已退回直连（会定时再试中转）`,
      data: { via: report.via, error: report.lastError },
    });
  }
}

// ---------------------------------------------------------------- 指令

async function panelTargetFor(dependents: Array<{ id: number }>): Promise<string> {
  const configured = panelAddrFromUrl(await getConfiguredPanelUrl().catch(() => ""));
  if (configured) return configured;
  for (const dependent of dependents) {
    const addr = reports.get(dependent.id)?.report.panelAddr;
    if (addr) return addr;
  }
  return "";
}

export async function relayDirectiveFor(hostId: number) {
  const configs = await loadRelayConfigs();
  const own = configs.get(hostId);
  const directive: { via?: string; listen?: { port: number; target: string; allow: string[] } } = {};
  if (own?.viaHostId) {
    const relayConfig = configs.get(own.viaHostId);
    const relayHost = relayConfig?.listenPort ? await db.getHostById(own.viaHostId) : null;
    const address = relayHost ? getHostEntryAddress(relayHost as any) : "";
    if (relayConfig?.listenPort && address) directive.via = joinHostPort(address, relayConfig.listenPort);
  }
  if (own?.listenPort) {
    const dependentIds = Array.from(configs.values()).filter((row) => row.viaHostId === hostId).map((row) => row.hostId);
    if (dependentIds.length > 0) {
      const dependents = await db.getHostsByIds(dependentIds);
      const target = await panelTargetFor(dependents as any[]);
      const allow = relayAllowList((dependents as any[]).map((host) => ({
        ip: host.ip, ipv4: host.ipv4, ipv6: host.ipv6, publicIps: reports.get(Number(host.id))?.report.publicIps,
      })));
      if (target && allow.length > 0) directive.listen = { port: own.listenPort, target, allow };
    }
  }
  return directive;
}

registerAgentExtModule({
  name: "relay",
  directive: async (host) => {
    ensureAutoSwitchSampler();
    return relayDirectiveFor(Number(host.id));
  },
  ingest: ingestRelayReport,
});

// ---------------------------------------------------------------- 自动切换

const sampler = new OfflineSampler();
let samplerTimer: ReturnType<typeof setInterval> | null = null;

export function ensureAutoSwitchSampler() {
  if (samplerTimer) return;
  samplerTimer = setInterval(() => {
    void runAutoSwitchRound().catch((error) => {
      console.warn(`[AgentRelay] auto switch round failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 60_000);
  samplerTimer.unref?.();
}

export function autoSwitchStats(hostId: number) {
  return sampler.stats(hostId);
}

async function runAutoSwitchRound() {
  const configs = await loadRelayConfigs();
  const watched = Array.from(configs.values()).filter((row) => row.autoViaHostId && !row.viaHostId && !row.autoSwitchedAt);
  sampler.keepOnly(watched.map((row) => row.hostId));
  if (watched.length === 0) return;
  const hosts = await db.getHostsByIds(watched.map((row) => row.hostId));
  const byId = new Map((hosts as any[]).map((host) => [Number(host.id), host]));
  for (const row of watched) {
    const host = byId.get(row.hostId);
    if (!host) continue;
    sampler.record(row.hostId, isHostConsideredOnline(host));
    const stats = sampler.stats(row.hostId);
    if (!shouldAutoSwitch(stats, row.autoThresholdMinutes)) continue;
    await autoSwitchHost(host, row, stats.offlineMinutes).catch((error) => {
      console.warn(`[AgentRelay] auto switch host=${row.hostId} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function autoSwitchHost(host: any, row: RelayConfigRow, offlineMinutes: number) {
  const relayId = Number(row.autoViaHostId);
  const configs = await loadRelayConfigs(true);
  const relay = await db.getHostById(relayId);
  if (!relay) return;
  const issue = relayCandidateIssue(
    { id: relayId, name: (relay as any).name, agentVersion: (relay as any).agentVersion, online: isHostConsideredOnline(relay) },
    row.hostId,
    configs,
  );
  if (issue) {
    // 中转主机此刻不合适（离线之类）：这一轮不切，下一分钟再看。
    return;
  }
  await ensureRelayListenPort(relayId);
  const latest = (await loadRelayConfigs(true)).get(row.hostId) || row;
  await writeRelayConfig({ ...latest, viaHostId: relayId, autoSwitchedAt: Math.floor(Date.now() / 1000) });
  sampler.forget(row.hostId);
  const name = String(host.name || "").trim() || `#${row.hostId}`;
  const relayName = String((relay as any).name || "").trim() || `#${relayId}`;
  const message = `${name} 4 小时内离线 ${offlineMinutes} 分钟，已自动改为经由 ${relayName} 连面板`;
  await recordPanelEvent({
    kind: "host.relay_switched",
    level: "warn",
    hostId: row.hostId,
    message,
    data: { viaHostId: relayId, offlineMinutes, auto: true },
  });
  wakeAgentExt(relayId, "relay-auto-switch");
  wakeAgentExt(row.hostId, "relay-auto-switch");
  void notifyAdmins(`🔀 ${message}`);
}

/** 和主机上下线通知同一个开关（Telegram「主机状态通知」）。 */
async function notifyAdmins(text: string) {
  try {
    const settings = await db.getAllSettings();
    const { ENV } = await import("../env");
    const envToken = ENV.telegramBotToken.trim();
    const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
    const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
    if (settings.telegramHostStatusNotify !== "true" || !botEnabled || !botConfigured) return;
    const { filterTelegramRecipients } = await import("../telegramNotifyPrefs");
    const { sendTelegramMessage } = await import("../telegramBot");
    const recipients = await filterTelegramRecipients(await db.getTelegramAdminRecipients() as any[], "host");
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    for (const user of recipients as any[]) {
      if (!user.telegramId) continue;
      await sendTelegramMessage(user.telegramId, escaped).catch(() => undefined);
    }
  } catch (error) {
    console.warn(`[AgentRelay] notify failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
