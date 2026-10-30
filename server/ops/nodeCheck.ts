/*
  网速测试 / 经节点的出口检测（Agent 2.2.241 起）的面板侧：排检查、收进度和结果、存测速历史。
  扩展模块 "nodecheck" 的注册在 nodeCheckAgent.ts（只由 agentExtModules.ts 引入）。Go 端是
  agent/ext_nodecheck.go，形状在 shared/nodeCheck.ts。

  两种检查、两种对象：
    · 测速（speed）：这台机器自己（nodeId = 0），或经某个节点（nodeId > 0，那台机器临时拉 sing-box）。
    · 出口检测（exit）：只给经节点的；自己的机器有定时的 sitelatency / unlock，不走这里。
  请求只放内存（6 分钟过期）：指令每轮重发，直到收到这个 runId 的 done / error。测速跑的时候
  Agent 每轮把曲线带上来，界面 1 秒一刷就能画实时曲线。
  测速结果校验过才落库（host_speed_tests），每个对象留最近 10 次；出口检测结果放内存一小时。
*/
import { randomBytes } from "node:crypto";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier } from "../dbRuntime";
import { isAgentVersionAtLeast } from "../../shared/version";
import {
  NODE_CHECK_KINDS,
  NODE_CHECK_MIN_AGENT_VERSION,
  normalizeNodeCheckRunReport,
  normalizeSpeedTestResult,
  type ExitCheckResult,
  type NodeCheckKind,
  type NodeCheckRunReport,
  type SpeedTestResult,
} from "../../shared/nodeCheck";
import { SITE_LATENCY_TARGETS } from "../../shared/siteLatency";
import { normalizeUnlockFamily, type UnlockFamily } from "../../shared/unlockCheck";
import { wakeAgentExt, type AgentExtHost } from "./agentExt";

const q = quoteDbIdentifier;
const TABLE = "host_speed_tests";

export const SPEED_TEST_HISTORY_KEEP = 10;
export const NODE_CHECK_RUN_TIMEOUT_MS = 6 * 60_000;
const EXIT_RESULT_TTL_MS = 60 * 60_000;

export function hostSupportsNodeCheck(host: { agentVersion?: string | null } | null | undefined) {
  return !!host && isAgentVersionAtLeast(String(host.agentVersion || "").replace(/^v/i, ""), NODE_CHECK_MIN_AGENT_VERSION);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------- 等结果的请求（内存）

export type NodeCheckSubject = {
  kind: NodeCheckKind;
  hostId: number;
  /** 经哪个节点；0 = 这台机器自己。 */
  nodeId: number;
  /** 订阅里的哪条线路（rule-<id> / direct-<模板 id>）：从 hostId 那台机器连线路入口走完整条链。 */
  entryKey?: string;
};

type PendingRun = NodeCheckSubject & {
  runId: string;
  nodeName: string;
  /** 经节点时下发的 sing-box 出站；null = 直接在这台机器上测。 */
  outbound: Record<string, unknown> | null;
  /** 主出站要经的前置代理等额外出站。 */
  extraOutbounds: Record<string, unknown>[] | null;
  /** 那台机器没有 sing-box 时先跑它装（自建节点那套装机脚本）。 */
  installCmd: string | null;
  family: UnlockFamily;
  requestedBy: number | null;
  createdAt: number;
  /** 测速时给 Agent 的一次性口令：连不上 Cloudflare 就拿它来面板测（server/ops/nodeCheckSpeedRoute.ts）。 */
  speedToken: string | null;
  /** Agent 最近一次报的进度（running）。 */
  report: NodeCheckRunReport | null;
};

type FinishedRun = NodeCheckSubject & {
  runId: string;
  nodeName: string;
  finishedAt: number;
  report: NodeCheckRunReport;
};

const pendingRuns = new Map<string, PendingRun>();
/** 最近一次结果，按对象：speed:h<hostId> / speed:n<nodeId> / exit:n<nodeId>。 */
const latestResults = new Map<string, FinishedRun>();

type SubjectRef = Pick<NodeCheckSubject, "kind" | "hostId" | "nodeId"> & { entryKey?: string };

export function nodeCheckSubjectKey(subject: SubjectRef) {
  if (subject.entryKey) return `${subject.kind}:e${subject.entryKey}`;
  return subject.nodeId > 0 ? `${subject.kind}:n${subject.nodeId}` : `${subject.kind}:h${subject.hostId}`;
}

function sweep(now = Date.now()) {
  for (const [runId, run] of pendingRuns) {
    if (now - run.createdAt > NODE_CHECK_RUN_TIMEOUT_MS) pendingRuns.delete(runId);
  }
  for (const [key, run] of latestResults) {
    if (run.kind === "exit" && now - run.finishedAt > EXIT_RESULT_TTL_MS) latestResults.delete(key);
  }
}

export function pendingNodeCheckRunsForHost(hostId: number) {
  sweep();
  return Array.from(pendingRuns.values()).filter((run) => run.hostId === hostId);
}

export function pendingNodeCheckRun(subject: SubjectRef) {
  sweep();
  const key = nodeCheckSubjectKey(subject);
  return Array.from(pendingRuns.values()).find((run) => nodeCheckSubjectKey(run) === key) || null;
}

function newRunId() {
  return `nc-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

export class NodeCheckError extends Error {}

/**
 * 排一次检查。同一个对象已经在等就返回那一次的 runId，不重复排。
 * 旧 Agent / 离线主机直接报错（界面上会提示换一台机器或升级 Agent）。
 */
export function startNodeCheck(
  host: { id: number; agentVersion?: string | null; isOnline?: unknown },
  input: { kind: NodeCheckKind; nodeId?: number; entryKey?: string; nodeName?: string; outbound?: Record<string, unknown> | null; extraOutbounds?: Record<string, unknown>[]; installCmd?: string | null; family?: unknown; requestedBy?: number | null },
) {
  const hostId = Number(host.id);
  if (!(hostId > 0)) throw new NodeCheckError("主机不存在");
  if (!NODE_CHECK_KINDS.includes(input.kind)) throw new NodeCheckError("不认识的检查");
  if (!hostSupportsNodeCheck(host)) throw new NodeCheckError(`需要把这台机器的 Agent 升级到 ${NODE_CHECK_MIN_AGENT_VERSION} 或更新版本`);
  if (host.isOnline === false || host.isOnline === 0) throw new NodeCheckError("主机离线，等它上线再测");
  const nodeId = Math.max(0, Math.floor(Number(input.nodeId || 0)));
  const entryKey = String(input.entryKey || "").trim().slice(0, 48) || undefined;
  if (input.kind === "exit" && !(nodeId > 0 && input.outbound)) throw new NodeCheckError("出口检测只给经节点的");
  if (entryKey && !input.outbound) throw new NodeCheckError("这条线路没有可连的入口");
  const subject: NodeCheckSubject = { kind: input.kind, hostId, nodeId, ...(entryKey ? { entryKey } : {}) };
  const existing = pendingNodeCheckRun(subject);
  if (existing) return { runId: existing.runId, reused: true };
  const runId = newRunId();
  pendingRuns.set(runId, {
    ...subject,
    runId,
    nodeName: String(input.nodeName || ""),
    outbound: (nodeId > 0 || entryKey) && input.outbound ? input.outbound : null,
    extraOutbounds: input.extraOutbounds && input.extraOutbounds.length > 0 ? input.extraOutbounds : null,
    installCmd: input.installCmd || null,
    family: normalizeUnlockFamily(input.family),
    requestedBy: input.requestedBy ?? null,
    createdAt: Date.now(),
    speedToken: input.kind === "speed" ? randomBytes(18).toString("base64url") : null,
    report: null,
  });
  wakeAgentExt(hostId, "node-check");
  return { runId, reused: false };
}

export function nodeCheckDirectiveFor(hostId: number) {
  const runs = pendingNodeCheckRunsForHost(hostId).map((run) => ({
    runId: run.runId,
    kind: run.kind,
    family: run.family,
    ...(run.outbound ? { via: { outbound: run.outbound, ...(run.extraOutbounds ? { extraOutbounds: run.extraOutbounds } : {}), ...(run.installCmd ? { installCmd: run.installCmd } : {}) } } : {}),
    ...(run.kind === "exit" ? { targets: SITE_LATENCY_TARGETS.map(({ key, host, port }) => ({ key, host, port })) } : {}),
    ...(run.speedToken ? { panel: { token: run.speedToken } } : {}),
  }));
  return runs.length > 0 ? { runs } : undefined;
}

/** 面板当测速服务器时验口令：只认还在跑的测速。回这次测速的主机 id，不认识就 null。 */
export function nodeCheckSpeedTokenHost(token: string): number | null {
  const value = String(token || "").trim();
  if (!value || value.length > 64) return null;
  sweep();
  for (const run of pendingRuns.values()) {
    if (run.speedToken && run.speedToken === value) return run.hostId;
  }
  return null;
}

// ---------------------------------------------------------------- 上报

const RUN_ID_RE = /^nc-[a-z0-9-]{1,60}$/;

export type SpeedTestRecord = {
  hostId: number;
  nodeId: number;
  entryKey?: string;
  runId: string;
  requestedBy: number | null;
  checkedAt: number;
  result: SpeedTestResult;
};

let recordSpeed: (record: SpeedTestRecord) => Promise<void> = (record) => recordSpeedTest(record);

/** 只给测试用：换掉落库那一步。 */
export function setSpeedTestRecorderForTest(fn: ((record: SpeedTestRecord) => Promise<void>) | null) {
  recordSpeed = fn || ((record) => recordSpeedTest(record));
}

export async function ingestNodeCheckReport(host: AgentExtHost, raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const hostId = Number(host.id);
  const runs = (raw as Record<string, unknown>).runs;
  if (!(hostId > 0) || !Array.isArray(runs)) return;
  for (const item of runs.slice(0, 16)) {
    const report = normalizeNodeCheckRunReport(item);
    if (!report || !RUN_ID_RE.test(report.runId)) continue;
    const pending = pendingRuns.get(report.runId);
    // 只认面板自己排过、而且是排给这台主机的那几次；别的（过期的、别台的、编的）一律不收。
    if (!pending || pending.hostId !== hostId || pending.kind !== report.kind) continue;
    if (report.status === "running") {
      pending.report = report;
      continue;
    }
    pendingRuns.delete(report.runId);
    const now = nowSec();
    // Agent 的时钟不一定准：只在差不多的范围内用它的完成时间。
    const checkedAt = report.finishedAt > 0 && Math.abs(report.finishedAt - now) < 15 * 60 ? report.finishedAt : now;
    const finished: FinishedRun = { kind: pending.kind, hostId, nodeId: pending.nodeId, entryKey: pending.entryKey, runId: report.runId, nodeName: pending.nodeName, finishedAt: checkedAt * 1000, report };
    latestResults.set(nodeCheckSubjectKey(pending), finished);
    if (report.status === "done" && report.kind === "speed" && report.speed) {
      await recordSpeed({ hostId, nodeId: pending.nodeId, entryKey: pending.entryKey, runId: report.runId, requestedBy: pending.requestedBy, checkedAt, result: report.speed });
    }
  }
}

// ---------------------------------------------------------------- 查状态

export type NodeCheckStatus = {
  pending: { runId: string; hostId: number; phase: string; startedAt: number; samples: SpeedTestResult["samples"] } | null;
  latest: { runId: string; hostId: number; nodeId: number; checkedAt: number; error: string; speed: SpeedTestResult | null; exit: ExitCheckResult | null } | null;
};

/** 这个对象现在：在跑的那次（带曲线进度）+ 最近一次结果（内存里没有就去库里取测速的最近一次）。 */
export async function nodeCheckStatus(subject: SubjectRef): Promise<NodeCheckStatus> {
  const pending = pendingNodeCheckRun(subject);
  let latest = latestResults.get(nodeCheckSubjectKey(subject)) || null;
  if (!latest && subject.kind === "speed") {
    const rows = await listSpeedTestHistory(subject, 1).catch(() => []);
    const row = rows[0];
    if (row) {
      latest = {
        kind: "speed", hostId: row.hostId, nodeId: row.nodeId, entryKey: row.entryKey || undefined, runId: row.runId, nodeName: "", finishedAt: row.checkedAt * 1000,
        report: { runId: row.runId, kind: "speed", status: "done", phase: "", startedAt: 0, finishedAt: row.checkedAt, error: "", speed: row.result, exit: null },
      };
    }
  }
  return {
    pending: pending ? {
      runId: pending.runId,
      hostId: pending.hostId,
      phase: pending.report?.phase || "queued",
      startedAt: pending.createdAt,
      samples: pending.report?.speed?.samples || [],
    } : null,
    latest: latest ? {
      runId: latest.runId,
      hostId: latest.hostId,
      nodeId: latest.nodeId,
      checkedAt: Math.floor(latest.finishedAt / 1000),
      error: latest.report.status === "error" ? latest.report.error || "检查失败" : "",
      speed: latest.report.speed,
      exit: latest.report.exit,
    } : null,
  };
}

// ---------------------------------------------------------------- 存储

function rowView(row: any) {
  return {
    id: Number(row.id),
    hostId: Number(row.hostId),
    nodeId: Number(row.nodeId) || 0,
    entryKey: String(row.entryKey || ""),
    runId: String(row.runId),
    checkedAt: Number(row.checkedAt) || 0,
    result: (() => {
      try {
        return normalizeSpeedTestResult(JSON.parse(String(row.resultJson || "{}")));
      } catch {
        return null;
      }
    })(),
  };
}

export async function recordSpeedTest(record: SpeedTestRecord) {
  const existing = await queryRaw<any>(`SELECT ${q("id")} FROM ${q(TABLE)} WHERE ${q("runId")} = ? LIMIT 1`, [record.runId]);
  if (existing.length > 0) return;
  await insertAndGetId(TABLE, {
    hostId: record.hostId,
    nodeId: record.nodeId,
    entryKey: record.entryKey || null,
    runId: record.runId,
    requestedBy: record.requestedBy,
    resultJson: JSON.stringify(record.result),
    checkedAt: record.checkedAt,
    createdAt: nowSec(),
  });
  await trimSpeedTestHistory(record);
}

function subjectWhere(subject: Pick<NodeCheckSubject, "hostId" | "nodeId" | "entryKey">) {
  if (subject.entryKey) return { sql: `${q("entryKey")} = ?`, params: [subject.entryKey] };
  return subject.nodeId > 0
    ? { sql: `${q("nodeId")} = ?`, params: [subject.nodeId] }
    : { sql: `${q("hostId")} = ? AND ${q("nodeId")} = ? AND (${q("entryKey")} IS NULL OR ${q("entryKey")} = '')`, params: [subject.hostId, 0] };
}

export async function trimSpeedTestHistory(subject: Pick<NodeCheckSubject, "hostId" | "nodeId" | "entryKey">, keep = SPEED_TEST_HISTORY_KEEP) {
  const where = subjectWhere(subject);
  const rows = await queryRaw<any>(`SELECT ${q("id")} FROM ${q(TABLE)} WHERE ${where.sql} ORDER BY ${q("checkedAt")} DESC, ${q("id")} DESC`, where.params);
  const drop = rows.slice(keep).map((row) => Number(row.id));
  if (drop.length === 0) return 0;
  await executeRaw(`DELETE FROM ${q(TABLE)} WHERE ${q("id")} IN (${drop.map(() => "?").join(", ")})`, drop);
  return drop.length;
}

export async function listSpeedTestHistory(subject: Pick<NodeCheckSubject, "hostId" | "nodeId" | "entryKey">, limit = SPEED_TEST_HISTORY_KEEP) {
  const where = subjectWhere(subject);
  const rows = await queryRaw<any>(
    `SELECT * FROM ${q(TABLE)} WHERE ${where.sql} ORDER BY ${q("checkedAt")} DESC, ${q("id")} DESC LIMIT ${Math.max(1, Math.min(50, Math.floor(limit)))}`,
    where.params,
  );
  return rows.map(rowView).filter((row) => !!row.result);
}

export function resetNodeCheckStateForTest() {
  pendingRuns.clear();
  latestResults.clear();
}
