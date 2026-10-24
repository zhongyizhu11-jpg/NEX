/*
  安全巡检（#3）的面板侧：收 Agent 的发现、维护状态、下发处置动作、提醒管理员。

  Agent 那头（agent/ext_security.go）每 N 分钟巡检一次，第一次只建基线。每条发现带稳定的指纹，
  这里按 (hostId, fingerprint) 合并成一行，状态流转见 hostSecurityCore.ts。
  新的（或从「已知道」重新打开的）高危 / 严重发现：记一条 security.finding 事件，并给管理员发 Telegram。
  处置动作（停止进程 / 隔离文件 / 撤销隔离）写进 host_security_actions，随下一轮指令发给 Agent，
  同时叫醒 Agent 立刻来取；Agent 核对过发现仍然成立才动手，结果回来再落库。
*/
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier } from "../dbRuntime";
import { getSetting, setSetting } from "../repositories/settingsRepository";
import { hostSupportsAgentExt, wakeAgentExt, type AgentExtHost } from "./agentExt";
import { recordPanelEvent } from "./panelEvents";
import {
  applyIncomingFinding,
  availableActions,
  decideFinding,
  findingsToResolve,
  normalizeSecurityReport,
  normalizeSeverity,
  SEVERITY_RANK,
  type ExpectedScope,
  type FindingDecision,
  type FindingSeverity,
  type FindingStatus,
  type IncomingFinding,
} from "./hostSecurityCore";

const q = quoteDbIdentifier;
const FINDINGS = "host_security_findings";
const EXPECTED = "host_security_expected";
const ACTIONS = "host_security_actions";

export const SECURITY_INTERVAL_SETTING = "ops.hostSecurity.intervalMinutes";
const STATUS_SETTING_PREFIX = "ops.hostSecurity.status.";
const BASELINE_TOKEN_PREFIX = "ops.hostSecurity.baselineToken.";
const MANAGED_PORTS_CACHE_MS = 60_000;
const STATUS_PERSIST_EVERY_MS = 30 * 60_000;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function num(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ---------- 主机巡检状态（最后一次巡检、基线） ----------

export type HostSecurityStatus = { checkedAt: number; baselineAt: number; baselineReady: boolean; intervalMinutes: number; persistedAt?: number };
const hostStatus = new Map<number, HostSecurityStatus>();

async function readHostStatus(hostId: number): Promise<HostSecurityStatus | null> {
  const cached = hostStatus.get(hostId);
  if (cached) return cached;
  const raw = await getSetting(STATUS_SETTING_PREFIX + hostId).catch(() => null);
  if (!raw) return null;
  const parsed = parseJson(raw);
  const status: HostSecurityStatus = {
    checkedAt: num(parsed.checkedAt),
    baselineAt: num(parsed.baselineAt),
    baselineReady: parsed.baselineReady === true,
    intervalMinutes: num(parsed.intervalMinutes) || 5,
    persistedAt: Date.now(),
  };
  hostStatus.set(hostId, status);
  return status;
}

async function noteHostStatus(hostId: number, next: Omit<HostSecurityStatus, "persistedAt">) {
  const prev = await readHostStatus(hostId);
  if (!next.baselineAt && prev?.baselineAt) next = { ...next, baselineAt: prev.baselineAt };
  const persist = !prev || prev.baselineAt !== next.baselineAt || prev.baselineReady !== next.baselineReady
    || Date.now() - (prev.persistedAt || 0) >= STATUS_PERSIST_EVERY_MS;
  const status: HostSecurityStatus = { ...next, persistedAt: persist ? Date.now() : prev?.persistedAt };
  hostStatus.set(hostId, status);
  if (persist) {
    // 只在基线变了或隔半小时才写一次库；「最后巡检时间」平时在内存里，重启后最多差半小时。
    await setSetting(STATUS_SETTING_PREFIX + hostId, JSON.stringify({
      checkedAt: next.checkedAt, baselineAt: next.baselineAt, baselineReady: next.baselineReady, intervalMinutes: next.intervalMinutes,
    })).catch(() => undefined);
  }
}

// ---------- 指令 ----------

const managedPortCache = new Map<number, { at: number; ports: number[] }>();

/** 面板给这台主机配的所有端口（转发入口、隧道监听、入站……）：Agent 开着它们不算「新端口」。 */
export async function managedPortsForHost(hostId: number): Promise<number[]> {
  const cached = managedPortCache.get(hostId);
  if (cached && Date.now() - cached.at < MANAGED_PORTS_CACHE_MS) return cached.ports;
  const ports = new Set<number>();
  const collect = async (sql: string, params: unknown[]) => {
    const rows = await queryRaw<any>(sql, params).catch(() => []);
    for (const row of rows) {
      for (const value of Object.values(row)) {
        const port = Number(value);
        if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
      }
    }
  };
  await collect(`SELECT ${q("sourcePort")}, ${q("udpOverTcpPort")}, ${q("tunnelExitPort")} FROM ${q("forward_rules")} WHERE ${q("hostId")} = ?`, [hostId]);
  await collect(
    `SELECT r.${q("tunnelExitPort")} FROM ${q("forward_rules")} r JOIN ${q("tunnels")} t ON t.${q("id")} = r.${q("tunnelId")} WHERE t.${q("exitHostId")} = ?`,
    [hostId],
  );
  await collect(`SELECT ${q("tunnelExitPort")} FROM ${q("forward_rule_tunnel_exits")} WHERE ${q("exitHostId")} = ?`, [hostId]);
  await collect(`SELECT ${q("listenPort")}, ${q("mimicPort")} FROM ${q("tunnels")} WHERE ${q("exitHostId")} = ? OR ${q("entryHostId")} = ?`, [hostId, hostId]);
  await collect(`SELECT ${q("listenPort")}, ${q("mimicPort")} FROM ${q("tunnel_hops")} WHERE ${q("hostId")} = ?`, [hostId]);
  await collect(`SELECT ${q("listenPort")}, ${q("mimicPort")} FROM ${q("tunnel_exit_nodes")} WHERE ${q("hostId")} = ?`, [hostId]);
  await collect(`SELECT ${q("port")} FROM ${q("proxy_inbounds")} WHERE ${q("hostId")} = ?`, [hostId]);
  const list = Array.from(ports).sort((a, b) => a - b);
  managedPortCache.set(hostId, { at: Date.now(), ports: list });
  return list;
}

export async function securityIntervalMinutes() {
  const raw = Number(await getSetting(SECURITY_INTERVAL_SETTING).catch(() => null));
  return Number.isInteger(raw) && raw >= 1 && raw <= 60 ? raw : 5;
}

export async function securityDirectiveFor(host: AgentExtHost) {
  if (!hostSupportsAgentExt(host)) return undefined;
  const hostId = Number(host.id);
  const pending = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("action")}, ${q("payloadJson")} FROM ${q(ACTIONS)} WHERE ${q("hostId")} = ? AND ${q("status")} = ? ORDER BY ${q("id")} ASC LIMIT 20`,
    [hostId, "pending"],
  ).catch(() => []);
  const token = await getSetting(BASELINE_TOKEN_PREFIX + hostId).catch(() => null);
  return {
    intervalMinutes: await securityIntervalMinutes(),
    managedPorts: await managedPortsForHost(hostId),
    actions: pending.map((row) => ({ id: Number(row.id), action: String(row.action), ...parseJson(row.payloadJson) })),
    ...(token ? { baselineToken: token } : {}),
  };
}

// ---------- 收上报 ----------

async function globallyExpectedSet(fingerprints: string[]) {
  if (fingerprints.length === 0) return new Set<string>();
  const rows = await queryRaw<any>(
    `SELECT ${q("fingerprint")} FROM ${q(EXPECTED)} WHERE ${q("fingerprint")} IN (${fingerprints.map(() => "?").join(", ")})`,
    fingerprints,
  );
  return new Set(rows.map((row) => String(row.fingerprint)));
}

/** 写一条发现（合并到已有的那一行），返回状态流转的结果。 */
async function upsertFinding(hostId: number, f: IncomingFinding, globallyExpected: boolean) {
  const rows = await queryRaw<any>(
    `SELECT * FROM ${q(FINDINGS)} WHERE ${q("hostId")} = ? AND ${q("fingerprint")} = ? LIMIT 1`,
    [hostId, f.fingerprint],
  );
  const row = rows[0];
  const existing = row
    ? {
      status: (String(row.status) as FindingStatus) || "open",
      expectedScope: (row.expectedScope as ExpectedScope) || null,
      episodeAt: row.episodeAt == null ? null : num(row.episodeAt),
      resolvedAt: row.resolvedAt == null ? null : num(row.resolvedAt),
    }
    : null;
  const t = applyIncomingFinding(existing, f, globallyExpected);
  const at = f.at || nowSec();
  if (!row) {
    const id = await insertAndGetId(FINDINGS, {
      hostId,
      fingerprint: f.fingerprint,
      kind: f.kind,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      evidenceJson: JSON.stringify(f.evidence),
      status: t.status,
      expectedScope: t.expectedScope,
      persistent: f.persistent,
      episodeAt: t.episodeAt,
      firstSeenAt: Math.min(at, f.since || at),
      lastSeenAt: at,
      resolvedAt: null,
    });
    return { id, ...t };
  }
  // 证据（pid、哈希）每次用最新的；只是同一段的重复上报就不必动标题和详情以外的东西。
  await executeRaw(
    `UPDATE ${q(FINDINGS)} SET ${q("severity")} = ?, ${q("title")} = ?, ${q("detail")} = ?, ${q("evidenceJson")} = ?, ${q("status")} = ?,
       ${q("expectedScope")} = ?, ${q("persistent")} = ?, ${q("episodeAt")} = ?, ${q("lastSeenAt")} = ?, ${q("resolvedAt")} = ?
     WHERE ${q("id")} = ?`,
    [f.severity, f.title, f.detail, JSON.stringify(f.evidence), t.status, t.expectedScope, f.persistent, t.episodeAt, Math.max(at, num(row.lastSeenAt)), null, Number(row.id)],
  );
  return { id: Number(row.id), ...t };
}

let lastExpireAt = 0;

export async function ingestSecurityReport(host: AgentExtHost, raw: unknown) {
  const hostId = Number(host.id);
  const report = normalizeSecurityReport(raw);
  if (!hostId || !report) return;
  if (Date.now() - lastExpireAt > 60 * 60_000) {
    lastExpireAt = Date.now();
    await expireStaleSecurityActions();
  }
  if (report.checkedAt) {
    await noteHostStatus(hostId, {
      checkedAt: report.checkedAt,
      baselineAt: report.baselineAt,
      baselineReady: report.baselineReady,
      intervalMinutes: report.intervalMinutes,
    });
  }
  const expected = await globallyExpectedSet(Array.from(new Set(report.findings.map((f) => f.fingerprint))));
  const hostName = String(host.name || `主机 #${hostId}`);
  for (const finding of report.findings) {
    const result = await upsertFinding(hostId, finding, expected.has(finding.fingerprint));
    if (!result.notify) continue;
    const crit = SEVERITY_RANK[finding.severity] >= SEVERITY_RANK.high;
    await recordPanelEvent({
      kind: "security.finding",
      level: crit ? "crit" : "warn",
      hostId,
      message: `${hostName}：${finding.title}${result.reopened ? "（又出现了）" : ""}`,
      data: { findingId: result.id, fingerprint: finding.fingerprint, kind: finding.kind, severity: finding.severity },
    });
    void notifyAdminsTelegram(hostName, finding, result.reopened);
  }
  if (report.complete) {
    const open = await queryRaw<any>(
      `SELECT ${q("id")}, ${q("fingerprint")}, ${q("persistent")}, ${q("resolvedAt")} FROM ${q(FINDINGS)} WHERE ${q("hostId")} = ? AND ${q("persistent")} = ? AND ${q("resolvedAt")} IS NULL`,
      [hostId, true],
    );
    const ids = findingsToResolve(
      open.map((row) => ({ id: Number(row.id), fingerprint: String(row.fingerprint), persistent: true, resolvedAt: null })),
      report.active,
    );
    for (const id of ids) {
      await executeRaw(`UPDATE ${q(FINDINGS)} SET ${q("resolvedAt")} = ? WHERE ${q("id")} = ?`, [report.checkedAt || nowSec(), id]);
    }
  }
  for (const result of report.actionResults) {
    await executeRaw(
      `UPDATE ${q(ACTIONS)} SET ${q("status")} = ?, ${q("message")} = ?, ${q("quarantineId")} = ?, ${q("finishedAt")} = ? WHERE ${q("id")} = ? AND ${q("hostId")} = ?`,
      [result.ok ? "done" : "failed", result.message || null, result.quarantineId || null, result.at, result.id, hostId],
    );
  }
}

// ---------- Telegram ----------

const SEVERITY_LABEL: Record<FindingSeverity, string> = { low: "低", medium: "中", high: "高", critical: "严重" };

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 和主机离线提醒同一批收件人（管理员里绑了 Telegram、没关掉「主机」类提醒的人）。
 * 机器人没开 / 没配置就什么也不做。动态 import：telegramBot 很大，别让扩展通道一加载就拖进来。
 */
async function notifyAdminsTelegram(hostName: string, finding: IncomingFinding, reopened: boolean) {
  try {
    const [{ getAllSettings, getTelegramAdminRecipients }, { ENV }, { filterTelegramRecipients }, { sendTelegramMessage }] = await Promise.all([
      import("../db"),
      import("../env"),
      import("../telegramNotifyPrefs"),
      import("../telegramBot"),
    ]);
    const settings = await getAllSettings();
    const envToken = ENV.telegramBotToken.trim();
    const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
    const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
    const text = [
      `<b>🛡 安全巡检 · ${escapeHtml(SEVERITY_LABEL[finding.severity])}</b>`,
      "",
      `<b>${escapeHtml(hostName)}</b>：${escapeHtml(finding.title)}${reopened ? "（又出现了）" : ""}`,
      escapeHtml(finding.detail.slice(0, 600)),
      "",
      "到面板「监控 › 安全巡检」处理。",
    ].join("\n");
    if (botEnabled && botConfigured) {
      const recipients = await filterTelegramRecipients(await getTelegramAdminRecipients() as any[], "host");
      for (const user of recipients as any[]) {
        if (!user.telegramId) continue;
        await sendTelegramMessage(user.telegramId, text).catch((error: unknown) => {
          console.warn(`[HostSecurity] telegram notify failed user=${user.id}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
    // Discord 那一路（同一批管理员事件，按各自的「主机」类开关过滤；Discord 没开时什么也不做）
    const { notifyDiscordAdmins } = await import("../discordNotify");
    await notifyDiscordAdmins(text, { category: "host", label: "host-security" });
  } catch (error) {
    console.warn(`[HostSecurity] telegram notify failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------- 给界面 ----------

export type FindingListFilter = {
  status?: FindingStatus | "all";
  minSeverity?: FindingSeverity;
  hostId?: number;
  limit?: number;
};

export async function listFindings(filter: FindingListFilter) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status && filter.status !== "all") { where.push(`f.${q("status")} = ?`); params.push(filter.status); }
  if (filter.hostId) { where.push(`f.${q("hostId")} = ?`); params.push(filter.hostId); }
  if (filter.minSeverity && filter.minSeverity !== "low") {
    const allowed = (["low", "medium", "high", "critical"] as FindingSeverity[]).filter((s) => SEVERITY_RANK[s] >= SEVERITY_RANK[filter.minSeverity!]);
    where.push(`f.${q("severity")} IN (${allowed.map(() => "?").join(", ")})`);
    params.push(...allowed);
  }
  const limit = Math.min(500, Math.max(1, Math.floor(filter.limit || 200)));
  const rows = await queryRaw<any>(
    `SELECT f.*, h.${q("name")} AS ${q("hostName")} FROM ${q(FINDINGS)} f LEFT JOIN ${q("hosts")} h ON h.${q("id")} = f.${q("hostId")}
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY f.${q("lastSeenAt")} DESC, f.${q("id")} DESC LIMIT ${limit}`,
    params,
  );
  const ids = rows.map((row) => Number(row.id));
  const actionsByFinding = new Map<number, any[]>();
  if (ids.length) {
    const actions = await queryRaw<any>(
      `SELECT ${q("id")}, ${q("findingId")}, ${q("action")}, ${q("status")}, ${q("message")}, ${q("quarantineId")}, ${q("createdAt")}, ${q("finishedAt")} FROM ${q(ACTIONS)}
       WHERE ${q("findingId")} IN (${ids.map(() => "?").join(", ")}) ORDER BY ${q("id")} ASC`,
      ids,
    );
    for (const action of actions) {
      const list = actionsByFinding.get(Number(action.findingId)) || [];
      list.push(action);
      actionsByFinding.set(Number(action.findingId), list);
    }
  }
  return rows.map((row) => {
    const evidence = parseJson(row.evidenceJson);
    const actions = (actionsByFinding.get(Number(row.id)) || []).map((a) => ({
      id: Number(a.id),
      action: String(a.action) as "kill" | "quarantine" | "restore",
      status: String(a.status) as "pending" | "done" | "failed",
      message: a.message ? String(a.message) : null,
      createdAt: num(a.createdAt),
      finishedAt: a.finishedAt == null ? null : num(a.finishedAt),
    }));
    const quarantined = isQuarantined(actionsByFinding.get(Number(row.id)) || []);
    const pending = actions.some((a) => a.status === "pending");
    return {
      id: Number(row.id),
      hostId: Number(row.hostId),
      hostName: String(row.hostName || `主机 #${row.hostId}`),
      fingerprint: String(row.fingerprint),
      kind: String(row.kind),
      severity: normalizeSeverity(row.severity),
      title: String(row.title || ""),
      detail: String(row.detail || ""),
      evidence,
      status: (String(row.status) || "open") as FindingStatus,
      expectedScope: (row.expectedScope || null) as ExpectedScope | null,
      persistent: !!Number(row.persistent) || row.persistent === true,
      firstSeenAt: num(row.firstSeenAt),
      lastSeenAt: num(row.lastSeenAt),
      resolvedAt: row.resolvedAt == null ? null : num(row.resolvedAt),
      actions,
      availableActions: pending ? [] : availableActions(String(row.kind), evidence, quarantined),
      actionPending: pending,
    };
  });
}

/** 最近一次成功的隔离之后没有成功的撤销 = 文件还在隔离区。 */
function isQuarantined(actions: any[]) {
  let quarantined = false;
  for (const a of actions) {
    if (String(a.status) !== "done") continue;
    if (a.action === "quarantine") quarantined = true;
    if (a.action === "restore") quarantined = false;
  }
  return quarantined;
}

function latestQuarantineId(actions: any[]) {
  let id: string | null = null;
  for (const a of actions) {
    if (String(a.status) !== "done") continue;
    if (a.action === "quarantine" && a.quarantineId) id = String(a.quarantineId);
    if (a.action === "restore") id = null;
  }
  return id;
}

export async function getFinding(id: number) {
  const rows = await queryRaw<any>(`SELECT * FROM ${q(FINDINGS)} WHERE ${q("id")} = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

export async function decideFindingStatus(id: number, decision: FindingDecision, scope: ExpectedScope, userId: number) {
  const row = await getFinding(id);
  if (!row) return null;
  const next = decideFinding(decision, scope);
  const at = nowSec();
  const fingerprint = String(row.fingerprint);
  if (decision === "expected" && scope === "all") {
    const existing = await queryRaw<any>(`SELECT ${q("id")} FROM ${q(EXPECTED)} WHERE ${q("fingerprint")} = ? LIMIT 1`, [fingerprint]);
    if (!existing[0]) {
      await insertAndGetId(EXPECTED, { fingerprint, kind: String(row.kind), title: String(row.title || ""), createdBy: userId, createdAt: at });
    }
    // 其他主机上同一件事也一并收起来（「这台」标过的保持原样）。
    await executeRaw(
      `UPDATE ${q(FINDINGS)} SET ${q("status")} = ?, ${q("expectedScope")} = ?, ${q("decidedAt")} = ?, ${q("decidedBy")} = ? WHERE ${q("fingerprint")} = ? AND ${q("status")} <> ?`,
      ["expected", "all", at, userId, fingerprint, "expected"],
    );
  }
  if (decision === "reopen" && String(row.status) === "expected" && row.expectedScope === "all") {
    // 撤销「所有主机」：名单删掉，因为它被收起来的别的主机上的同一件事也重新打开。
    await executeRaw(`DELETE FROM ${q(EXPECTED)} WHERE ${q("fingerprint")} = ?`, [fingerprint]);
    await executeRaw(
      `UPDATE ${q(FINDINGS)} SET ${q("status")} = ?, ${q("expectedScope")} = ?, ${q("decidedAt")} = ?, ${q("decidedBy")} = ? WHERE ${q("fingerprint")} = ? AND ${q("status")} = ? AND ${q("expectedScope")} = ?`,
      ["open", null, at, userId, fingerprint, "expected", "all"],
    );
  }
  await executeRaw(
    `UPDATE ${q(FINDINGS)} SET ${q("status")} = ?, ${q("expectedScope")} = ?, ${q("decidedAt")} = ?, ${q("decidedBy")} = ? WHERE ${q("id")} = ?`,
    [next.status, next.expectedScope, at, userId, id],
  );
  return { id, ...next };
}

export type SecurityActionKind = "kill" | "quarantine" | "restore";

export async function requestSecurityAction(id: number, action: SecurityActionKind, userId: number): Promise<{ ok: true; actionId: number } | { ok: false; message: string }> {
  const row = await getFinding(id);
  if (!row) return { ok: false, message: "找不到这条发现" };
  const evidence = parseJson(row.evidenceJson);
  const history = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("action")}, ${q("status")}, ${q("quarantineId")} FROM ${q(ACTIONS)} WHERE ${q("findingId")} = ? ORDER BY ${q("id")} ASC`,
    [id],
  );
  if (history.some((a) => String(a.status) === "pending")) return { ok: false, message: "上一个动作还在执行，等它回来" };
  const allowed = availableActions(String(row.kind), evidence, isQuarantined(history));
  if (!allowed.includes(action)) return { ok: false, message: "这条发现不能做这个操作" };
  const hostId = Number(row.hostId);
  const hosts = await queryRaw<any>(`SELECT ${q("id")}, ${q("agentVersion")} FROM ${q("hosts")} WHERE ${q("id")} = ? LIMIT 1`, [hostId]);
  if (!hosts[0] || !hostSupportsAgentExt(hosts[0])) return { ok: false, message: "这台主机的 Agent 太旧，先升级到 2.2.216" };
  const payload: Record<string, unknown> = { fingerprint: String(row.fingerprint) };
  if (action === "kill") {
    payload.pid = Number(evidence.pid);
    payload.exe = String(evidence.exe || "");
  } else if (action === "quarantine") {
    payload.path = String(evidence.exe || "");
    payload.sha256 = String(evidence.sha256 || "");
  } else {
    const quarantineId = latestQuarantineId(history);
    if (!quarantineId) return { ok: false, message: "没有找到隔离记录" };
    payload.quarantineId = quarantineId;
  }
  const actionId = await insertAndGetId(ACTIONS, {
    findingId: id,
    hostId,
    action,
    status: "pending",
    payloadJson: JSON.stringify(payload),
    requestedBy: userId,
    createdAt: nowSec(),
  });
  wakeAgentExt(hostId, "security-action");
  return { ok: true, actionId };
}

/** Agent 一直没来取（离线了）的动作，过一天标成失败，界面上不会一直转圈。 */
export async function expireStaleSecurityActions() {
  const cutoff = nowSec() - 86400;
  await executeRaw(
    `UPDATE ${q(ACTIONS)} SET ${q("status")} = ?, ${q("message")} = ?, ${q("finishedAt")} = ? WHERE ${q("status")} = ? AND ${q("createdAt")} < ?`,
    ["failed", "Agent 一天内都没来取这个动作，已取消", nowSec(), "pending", cutoff],
  ).catch(() => undefined);
}

export async function hostSecuritySummary(hostId: number) {
  const rows = await queryRaw<any>(
    `SELECT ${q("severity")}, COUNT(*) AS ${q("n")} FROM ${q(FINDINGS)} WHERE ${q("hostId")} = ? AND ${q("status")} = ? GROUP BY ${q("severity")}`,
    [hostId, "open"],
  );
  const counts: Record<FindingSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const row of rows) counts[normalizeSeverity(row.severity)] += num(row.n);
  const status = await readHostStatus(hostId);
  const hosts = await queryRaw<any>(`SELECT ${q("id")}, ${q("agentVersion")} FROM ${q("hosts")} WHERE ${q("id")} = ? LIMIT 1`, [hostId]);
  return {
    hostId,
    open: counts,
    openTotal: counts.low + counts.medium + counts.high + counts.critical,
    lastCheckAt: status?.checkedAt || null,
    baselineAt: status?.baselineAt || null,
    baselineReady: !!status?.baselineReady,
    intervalMinutes: status?.intervalMinutes || (await securityIntervalMinutes()),
    supported: !!hosts[0] && hostSupportsAgentExt(hosts[0]),
  };
}

/** 重新建立基线：换一个新令牌，Agent 下一轮看到就丢掉旧基线重新记。 */
export async function requestRebaseline(hostId: number) {
  await setSetting(BASELINE_TOKEN_PREFIX + hostId, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  hostStatus.delete(hostId);
  await setSetting(STATUS_SETTING_PREFIX + hostId, null).catch(() => undefined);
  wakeAgentExt(hostId, "security-rebaseline");
}
