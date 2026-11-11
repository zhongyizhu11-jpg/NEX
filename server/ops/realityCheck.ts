/*
  REALITY 伪装目标检查（Agent 2.2.253 起）的面板侧：排检查、收结果。规则和候选清单在 shared/realityDestCheck.ts，
  扩展模块 "realitycheck" 的注册在 realityCheckAgent.ts（只由 agentExtModules.ts 引入，理由同 unlock.ts），
  Go 端是 agent/ext_realitycheck.go。

  和解锁检测同一个做法，只是不落库：结果只对正在填表的那个人有用（选一个能偷的握手目标），过了几分钟就没意义。
    · 请求放内存（3 分钟没回就丢）：指令 runs: [{runId, targets}] 每轮重发，直到收到这个 runId 的 done；
    · 结果也只放内存，留 10 分钟，界面按 runId 轮询；
    · 每台主机同一时间只排一次（Agent 那边也是一轮一轮跑），重复点直接回在跑的那次。
*/
import { randomBytes } from "node:crypto";

import {
  isRealityDestCheckAgentSupported,
  normalizeRealityDestCheckResults,
  REALITY_DEST_CHECK_AGENT_VERSION,
  REALITY_DEST_CHECK_MAX_TARGETS,
  type RealityDestCheckResult,
  type RealityDestCheckTarget,
} from "../../shared/realityDestCheck";
import { wakeAgentExt, type AgentExtHost } from "./agentExt";

export const REALITY_CHECK_PENDING_TIMEOUT_MS = 3 * 60_000;
export const REALITY_CHECK_RESULT_TTL_MS = 10 * 60_000;

export class RealityCheckError extends Error {}

type RealityCheckRun = {
  runId: string;
  hostId: number;
  requestedBy: number;
  targets: RealityDestCheckTarget[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  results: RealityDestCheckResult[] | null;
};

const runs = new Map<string, RealityCheckRun>();

function sweep(now = Date.now()) {
  for (const [runId, run] of runs) {
    const expired = run.finishedAt
      ? now - run.finishedAt > REALITY_CHECK_RESULT_TTL_MS
      : now - run.createdAt > REALITY_CHECK_PENDING_TIMEOUT_MS;
    if (expired) runs.delete(runId);
  }
}

export function pendingRealityChecksForHost(hostId: number) {
  sweep();
  return Array.from(runs.values()).filter((run) => run.hostId === hostId && !run.finishedAt);
}

/**
 * 排一次检查。离线主机、旧 Agent 直接报错（界面上提示要升级到哪一版）。这台主机已经有一次在跑就回那一次。
 */
export function startRealityCheck(
  host: { id: number; name?: unknown; agentVersion?: string | null; isOnline?: unknown },
  input: { targets: readonly RealityDestCheckTarget[]; requestedBy: number },
) {
  const hostId = Number(host.id);
  if (!(hostId > 0)) throw new RealityCheckError("主机不存在");
  if (host.isOnline === false || host.isOnline === 0) throw new RealityCheckError("主机离线，等它上线再检查");
  if (!isRealityDestCheckAgentSupported(host.agentVersion)) {
    throw new RealityCheckError(`主机「${String(host.name || hostId)}」的 Agent 需要升级到 ${REALITY_DEST_CHECK_AGENT_VERSION} 或更新版本才能检查 REALITY 目标`);
  }
  const targets = input.targets.slice(0, REALITY_DEST_CHECK_MAX_TARGETS);
  if (targets.length === 0) throw new RealityCheckError("没有要检查的目标");
  const running = pendingRealityChecksForHost(hostId)[0];
  if (running) return { runId: running.runId, reused: true };
  const runId = `rc-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  runs.set(runId, {
    runId,
    hostId,
    requestedBy: Number(input.requestedBy),
    targets: targets.map((target) => ({ dest: target.dest, serverName: target.serverName })),
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    results: null,
  });
  wakeAgentExt(hostId, "reality-check");
  return { runId, reused: false };
}

export function realityCheckDirectiveFor(hostId: number) {
  const pending = pendingRealityChecksForHost(hostId).map((run) => ({ runId: run.runId, targets: run.targets }));
  return pending.length > 0 ? { runs: pending } : undefined;
}

const RUN_ID_RE = /^rc-[a-z0-9-]{1,60}$/;

export function ingestRealityCheckReport(host: AgentExtHost, raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const hostId = Number(host.id);
  const reported = (raw as Record<string, unknown>).runs;
  if (!(hostId > 0) || !Array.isArray(reported)) return;
  for (const item of reported.slice(0, 16)) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const runId = String(entry.runId || "");
    if (!RUN_ID_RE.test(runId)) continue;
    const run = runs.get(runId);
    // 只认面板自己排给这台主机、还没收过结果的那几次。
    if (!run || run.hostId !== hostId || run.finishedAt) continue;
    if (entry.status === "running") {
      run.startedAt = run.startedAt || Date.now();
      continue;
    }
    if (entry.status !== "done") continue;
    const results = normalizeRealityDestCheckResults(entry.results) || [];
    // 结果按面板排的目标对齐：Agent 少报了的按「检查超时」算，不让界面上凭空少一行。
    run.results = run.targets.map((target) => results.find((result) => result.dest === target.dest && result.serverName === target.serverName) || {
      dest: target.dest,
      serverName: target.serverName,
      resolvedIp: "",
      reachable: false,
      tls13: false,
      x25519: false,
      h2: false,
      certValid: false,
      feasible: false,
      latencyMs: 0,
      error: "timeout",
    });
    run.finishedAt = Date.now();
  }
}

/** 界面轮询用。只有排这次检查的人（或管理员）看得到；过期、不存在一律当作不存在。 */
export function getRealityCheckRun(runId: string, viewer: { id: number; role: string }) {
  sweep();
  const run = runs.get(String(runId || ""));
  if (!run) return null;
  if (viewer.role !== "admin" && Number(viewer.id) !== run.requestedBy) return null;
  return {
    runId: run.runId,
    hostId: run.hostId,
    status: run.finishedAt ? "done" as const : run.startedAt ? "running" as const : "queued" as const,
    createdAt: run.createdAt,
    targets: run.targets,
    results: run.results || [],
  };
}

export function resetRealityCheckStateForTest() {
  runs.clear();
}
