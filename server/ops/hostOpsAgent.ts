/*
  扩展模块 "ops"（全部重启 #15、导入现有配置 #16）—— 面板这头的状态和指令。

  三种请求都只放内存、30 分钟过期：全部重启的进度、扫描结果、「停掉原服务」的动作。
  面板重启了就丢 —— 都是当场看结果的事，丢了重新点一次就好，不值得建表。

  指令按主机攒着，Agent 每轮来取；收到对应的结果就不再发。有请求在等时让 Agent 每 5 秒来一次
  （intervalSeconds），结果几秒内就能回到界面上。
*/
import { randomBytes } from "node:crypto";
import { registerAgentExtModule, wakeAgentExt, type AgentExtHost } from "./agentExt";
import { recordPanelEvent } from "./panelEvents";
import {
  restartAllSummary,
  sanitizeScanItem,
  type RestartHostResult,
  type RestartSkip,
  type ScanItem,
} from "./hostOpsLogic";

const STATE_TTL_MS = 30 * 60 * 1000;
const RESTART_TIMEOUT_MS = 3 * 60 * 1000;
const SCAN_TIMEOUT_MS = 2 * 60 * 1000;
const STOP_TIMEOUT_MS = 2 * 60 * 1000;

export function newOpsId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

// ---------------------------------------------------------------- 全部重启

type RestartRequest = {
  requestId: string;
  createdAt: number;
  userId: number | null;
  results: Map<number, RestartHostResult>;
  skipped: RestartSkip[];
  finishedRecorded: boolean;
};

const restartRequests = new Map<string, RestartRequest>();
const pendingRestartByHost = new Map<number, string>();

export function startRestartAllRequest(input: { userId: number | null; targets: Array<{ id: number; name: string }>; skipped: RestartSkip[] }) {
  sweepState();
  const requestId = newOpsId("ra");
  const results = new Map<number, RestartHostResult>();
  for (const host of input.targets) {
    results.set(host.id, { hostId: host.id, name: host.name, status: "pending", restarted: [], failed: [] });
    pendingRestartByHost.set(host.id, requestId);
  }
  restartRequests.set(requestId, { requestId, createdAt: Date.now(), userId: input.userId, results, skipped: input.skipped, finishedRecorded: false });
  for (const host of input.targets) wakeAgentExt(host.id, "restart-all");
  return requestId;
}

function restartRequestView(request: RestartRequest) {
  const now = Date.now();
  const results = Array.from(request.results.values()).map((item) => (
    item.status === "pending" && now - request.createdAt > RESTART_TIMEOUT_MS ? { ...item, status: "timeout" as const } : item
  ));
  const finished = results.every((item) => item.status !== "pending");
  return {
    requestId: request.requestId,
    createdAt: request.createdAt,
    finished,
    total: results.length,
    results,
    skipped: request.skipped,
    summary: restartAllSummary(results, request.skipped),
  };
}

export function getRestartAllStatus(requestId: string) {
  const request = restartRequests.get(requestId);
  if (!request) return null;
  return recordRestartFinishedOnce(request);
}

/** 所有主机都有了结果（或超时）就记一条「全部重启完成」，只记一次。 */
function recordRestartFinishedOnce(request: RestartRequest) {
  const requestId = request.requestId;
  const view = restartRequestView(request);
  if (view.finished && !request.finishedRecorded) {
    request.finishedRecorded = true;
    const failures = view.results.filter((item) => item.status !== "done" || item.failed.length > 0).length;
    void recordPanelEvent({
      kind: "ops.restart_all",
      level: failures > 0 ? "warn" : "info",
      userId: request.userId,
      message: `全部重启完成：${view.summary}`,
      data: { requestId, results: view.results.map((item) => ({ hostId: item.hostId, status: item.status, restarted: item.restarted.length, failed: item.failed })) },
    });
  }
  return view;
}

// ---------------------------------------------------------------- 扫描

type ScanState = {
  scanId: string;
  hostId: number;
  createdAt: number;
  status: "pending" | "done" | "timeout";
  items: ScanItem[];
  finishedAt: number | null;
};

const scans = new Map<string, ScanState>();
const pendingScanByHost = new Map<number, string>();

export function startScan(hostId: number) {
  sweepState();
  const scanId = newOpsId("sc");
  scans.set(scanId, { scanId, hostId, createdAt: Date.now(), status: "pending", items: [], finishedAt: null });
  pendingScanByHost.set(hostId, scanId);
  wakeAgentExt(hostId, "ops-scan");
  return scanId;
}

export function getScan(hostId: number, scanId: string): ScanState | null {
  const scan = scans.get(scanId);
  if (!scan || scan.hostId !== hostId) return null;
  if (scan.status === "pending" && Date.now() - scan.createdAt > SCAN_TIMEOUT_MS) {
    scan.status = "timeout";
    if (pendingScanByHost.get(hostId) === scanId) pendingScanByHost.delete(hostId);
  }
  return scan;
}

// 导入过的：hostId:key → ruleId（给「停掉原服务并启用规则」用）。
const importedRules = new Map<string, { ruleId: number; at: number }>();

export function rememberImportedRule(hostId: number, key: string, ruleId: number) {
  importedRules.set(`${hostId}:${key}`, { ruleId, at: Date.now() });
}

export function importedRuleFor(hostId: number, key: string) {
  return importedRules.get(`${hostId}:${key}`)?.ruleId ?? null;
}

// ---------------------------------------------------------------- 停掉原服务

export type StopActor = { id: number; role: string };

type StopState = {
  actionId: string;
  hostId: number;
  key: string;
  ruleId: number;
  label: string;
  actor: StopActor;
  createdAt: number;
  status: "pending" | "done" | "timeout";
  ok: boolean;
  message: string | null;
  error: string | null;
  ruleEnabled: boolean;
  enableError: string | null;
};

const stops = new Map<string, StopState>();
const pendingStopsByHost = new Map<number, Set<string>>();

/** 启用规则的那一步由路由层注入（它要用 rules 路由里的 toggle，静态引入会成环）。 */
let enableRuleHandler: ((actor: StopActor, ruleId: number) => Promise<void>) | null = null;

export function setImportedRuleEnabler(handler: (actor: StopActor, ruleId: number) => Promise<void>) {
  enableRuleHandler = handler;
}

export function startStopOriginal(input: { hostId: number; key: string; ruleId: number; label: string; actor: StopActor }) {
  sweepState();
  for (const existing of stops.values()) {
    if (existing.hostId === input.hostId && existing.key === input.key && existing.status === "pending") return existing.actionId;
  }
  const actionId = newOpsId("st");
  stops.set(actionId, {
    actionId, hostId: input.hostId, key: input.key, ruleId: input.ruleId, label: input.label, actor: input.actor,
    createdAt: Date.now(), status: "pending", ok: false, message: null, error: null, ruleEnabled: false, enableError: null,
  });
  const set = pendingStopsByHost.get(input.hostId) || new Set<string>();
  set.add(actionId);
  pendingStopsByHost.set(input.hostId, set);
  wakeAgentExt(input.hostId, "ops-stop");
  return actionId;
}

export function getStop(hostId: number, actionId: string) {
  const stop = stops.get(actionId);
  if (!stop || stop.hostId !== hostId) return null;
  if (stop.status === "pending" && Date.now() - stop.createdAt > STOP_TIMEOUT_MS) {
    stop.status = "timeout";
    stop.error = "Agent 一直没有回应";
    pendingStopsByHost.get(hostId)?.delete(actionId);
  }
  const { actor: _actor, ...view } = stop;
  return view;
}

// ---------------------------------------------------------------- 模块

function sweepState() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [id, request] of restartRequests) {
    if (request.createdAt < cutoff) {
      restartRequests.delete(id);
      for (const [hostId, pendingId] of pendingRestartByHost) if (pendingId === id) pendingRestartByHost.delete(hostId);
    }
  }
  for (const [id, scan] of scans) {
    if (scan.createdAt < cutoff) {
      scans.delete(id);
      if (pendingScanByHost.get(scan.hostId) === id) pendingScanByHost.delete(scan.hostId);
    }
  }
  for (const [id, stop] of stops) {
    if (stop.createdAt < cutoff) {
      stops.delete(id);
      pendingStopsByHost.get(stop.hostId)?.delete(id);
    }
  }
  const importCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, value] of importedRules) if (value.at < importCutoff) importedRules.delete(key);
}

function hasPending(hostId: number) {
  return pendingRestartByHost.has(hostId) || pendingScanByHost.has(hostId) || (pendingStopsByHost.get(hostId)?.size || 0) > 0;
}

export function opsDirectiveFor(hostId: number) {
  const directive: Record<string, unknown> = {};
  const requestId = pendingRestartByHost.get(hostId);
  if (requestId) {
    const request = restartRequests.get(requestId);
    if (request && Date.now() - request.createdAt <= RESTART_TIMEOUT_MS) directive.restartAll = { requestId };
    else pendingRestartByHost.delete(hostId);
  }
  const scanId = pendingScanByHost.get(hostId);
  if (scanId && getScan(hostId, scanId)?.status === "pending") directive.scan = { scanId };
  const pendingStops = Array.from(pendingStopsByHost.get(hostId) || [])
    .map((actionId) => stops.get(actionId))
    .filter((stop): stop is StopState => !!stop && stop.status === "pending");
  if (pendingStops.length > 0) directive.stops = pendingStops.map((stop) => ({ actionId: stop.actionId, key: stop.key }));
  return Object.keys(directive).length > 0 ? directive : undefined;
}

async function finishStop(stop: StopState, report: Record<string, unknown>, hostName: string) {
  stop.status = "done";
  stop.ok = report.ok === true;
  stop.message = typeof report.message === "string" ? report.message.slice(0, 300) : null;
  stop.error = typeof report.error === "string" ? report.error.slice(0, 300) : null;
  pendingStopsByHost.get(stop.hostId)?.delete(stop.actionId);
  if (!stop.ok) {
    void recordPanelEvent({
      kind: "ops.import_stop_failed",
      level: "warn",
      hostId: stop.hostId,
      userId: stop.actor.id,
      ruleId: stop.ruleId,
      message: `没能停掉 ${hostName} 上原来的 ${stop.label}：${stop.error || "未知原因"}`,
    });
    return;
  }
  try {
    if (!enableRuleHandler) throw new Error("面板还没准备好启用规则");
    await enableRuleHandler(stop.actor, stop.ruleId);
    stop.ruleEnabled = true;
  } catch (error) {
    stop.enableError = error instanceof Error ? error.message : String(error);
  }
  void recordPanelEvent({
    kind: "ops.import_switched",
    level: stop.ruleEnabled ? "info" : "warn",
    hostId: stop.hostId,
    userId: stop.actor.id,
    ruleId: stop.ruleId,
    message: stop.ruleEnabled
      ? `${hostName} 上原来的 ${stop.label} 已停掉，导入的规则已启用`
      : `${hostName} 上原来的 ${stop.label} 已停掉，但规则没能启用：${stop.enableError}`,
  });
}

async function ingestOpsReport(host: AgentExtHost, raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const report = raw as Record<string, unknown>;
  const hostId = Number(host.id);
  const hostName = String(host.name || "").trim() || `#${hostId}`;
  for (const item of Array.isArray(report.restartAll) ? report.restartAll : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const request = restartRequests.get(String(entry.requestId || ""));
    const result = request?.results.get(hostId);
    if (!request || !result || result.status === "done" || entry.status !== "done") continue;
    result.status = "done";
    result.restarted = Array.isArray(entry.restarted) ? entry.restarted.slice(0, 200).map((name) => String(name).slice(0, 128)) : [];
    result.failed = Array.isArray(entry.failed)
      ? entry.failed.slice(0, 100).map((f: any) => ({ name: String(f?.name || "").slice(0, 128), error: String(f?.error || "").slice(0, 200) }))
      : [];
    if (pendingRestartByHost.get(hostId) === request.requestId) pendingRestartByHost.delete(hostId);
    recordRestartFinishedOnce(request);
  }
  for (const item of Array.isArray(report.scans) ? report.scans : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const scan = scans.get(String(entry.scanId || ""));
    if (!scan || scan.hostId !== hostId || scan.status === "done" || entry.status !== "done") continue;
    scan.items = (Array.isArray(entry.items) ? entry.items : []).slice(0, 500).map(sanitizeScanItem).filter((value): value is ScanItem => !!value);
    scan.status = "done";
    scan.finishedAt = Date.now();
    if (pendingScanByHost.get(hostId) === scan.scanId) pendingScanByHost.delete(hostId);
  }
  for (const item of Array.isArray(report.stops) ? report.stops : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const stop = stops.get(String(entry.actionId || ""));
    if (!stop || stop.hostId !== hostId || stop.status !== "pending" || entry.status !== "done") continue;
    await finishStop(stop, entry, hostName);
  }
}

registerAgentExtModule({
  name: "ops",
  directive: (host) => opsDirectiveFor(Number(host.id)),
  ingest: ingestOpsReport,
  intervalSeconds: (host) => (hasPending(Number(host.id)) ? 5 : undefined),
});

/** 只给测试用：把内存状态清空。 */
export function resetHostOpsStateForTest() {
  restartRequests.clear();
  pendingRestartByHost.clear();
  scans.clear();
  pendingScanByHost.clear();
  stops.clear();
  pendingStopsByHost.clear();
  importedRules.clear();
}

export { ingestOpsReport as ingestOpsReportForTest };
