import { randomUUID } from "node:crypto";
import { withDatabaseTransaction } from "./dbRuntime";
import { aggregateHopTestResults, type HopTestResult } from "./hopTestState";
import { structuredLinkTestMessage } from "./linkTestMessages";
import { insertForwardGroupLatencyStat } from "./repositories/metricsRepository";
import {
  claimSettledForwardTestBatch,
  findUnsettledFinishedForwardTestBatchIds,
  FORWARD_CHAIN_BATCH_PREFIX,
  forwardTestRequestMessage,
  updateForwardTestResult,
} from "./repositories/forwardTestRepository";
import { selfTestSweepActivity, selfTestTimeoutSeconds } from "./selfTestTiming";
import { appendPanelLog } from "./_core/panelLogger";
import { normalizeLinkProbeMethod } from "@shared/latencyProbe";

/*
  转发链逐跳测试的持久化批次（移植上游 forwardChainManualProbe）。

  以前批次登记在面板进程的内存里：面板一重启，已经发给 Agent 的各跳结果回来时找不到批次，
  汇总永远不出，转发链延迟历史也少一笔。现在每一跳都是 forward_tests 里带同一个 batchId 的
  一行，汇总只看数据库：最后一跳的结果、超时扫描、面板重启后的恢复扫描，谁先看到「整批都结束」
  谁来汇总，batchSettled 保证只汇总一次。
*/

export function newForwardChainBatchId() {
  return `${FORWARD_CHAIN_BATCH_PREFIX}${randomUUID()}`;
}

export function forwardChainLatencyMode(meta: any) {
  const value = String(meta?.latencyMode || "");
  return value === "multi-source-remaining-path" || value === "remaining-path" ? value : "sum";
}

function parseRequest(row: any): any {
  try { return JSON.parse(forwardTestRequestMessage(row) || "null") || {}; }
  catch { return {}; }
}

/** One stored row → the hop result the in-memory aggregator used to receive. */
export function forwardChainHopResultFromRow(row: any, request = parseRequest(row)): HopTestResult {
  const hopLabel = String(request.hopLabel || "hop");
  const success = row.status === "success" && Number(row.latencyMs) > 0;
  const timedOut = row.status === "timeout";
  return {
    success,
    latencyMs: success ? Number(row.latencyMs) : null,
    message: timedOut
      ? `转发链逐跳测试超时：${hopLabel} 未在 ${selfTestTimeoutSeconds(request)} 秒内上报结果`
      : (typeof row.message === "string" ? row.message : null),
    hopLabel,
    routeLabel: typeof request.routeLabel === "string" ? request.routeLabel : null,
    method: normalizeLinkProbeMethod(request.method),
  };
}

/**
 * Aggregate a finished batch exactly once. Returns false while hops are still
 * outstanding, for an unknown batch, and when another caller already did it.
 */
export async function settleManualForwardChainBatch(batchId: string) {
  if (!String(batchId || "").startsWith(FORWARD_CHAIN_BATCH_PREFIX)) return false;
  const outcome = await withDatabaseTransaction(async () => {
    const rows = await claimSettledForwardTestBatch(batchId);
    if (!rows) return null;
    const requests = rows.map(parseRequest);
    const meta = requests[0] || {};
    const groupId = Number(meta.groupId || 0);
    const aggregate = aggregateHopTestResults(groupId, rows.map((row, index) => forwardChainHopResultFromRow(row, requests[index])), {
      successPrefix: "转发链逐跳测试成功",
      failurePrefix: "转发链逐跳测试失败",
      latencyMode: forwardChainLatencyMode(meta),
    });
    // Raw per-hop reports stay as they are; the last row carries the summary
    // (getLatestForwardTest / getLatestForwardGroupTest read the newest row).
    await updateForwardTestResult(Number(rows[rows.length - 1].id), {
      status: aggregate.success ? "success" : "failed",
      listenOk: aggregate.success,
      targetReachable: aggregate.success,
      forwardOk: aggregate.success,
      latencyMs: aggregate.success ? aggregate.latencyMs : null,
      message: structuredLinkTestMessage({
        kind: "forward-chain-hop-summary",
        groupId,
        message: aggregate.message,
        details: aggregate.details,
        totalLatencyMs: aggregate.latencyMs,
      }),
    });
    if (groupId > 0) {
      await insertForwardGroupLatencyStat({
        groupId,
        latencyMs: aggregate.success ? aggregate.latencyMs : null,
        isTimeout: !aggregate.success,
      });
    }
    return { groupId, aggregate, segments: rows.length };
  });
  if (!outcome) return false;
  appendPanelLog(
    outcome.aggregate.success ? "info" : "warn",
    `[SelfTest] forward-chain group=${outcome.groupId} batch=${batchId} completed segments=${outcome.segments} success=${outcome.aggregate.success} latency=${outcome.aggregate.success && outcome.aggregate.latencyMs !== null ? `${outcome.aggregate.latencyMs}ms` : "-"} message=${outcome.aggregate.message}`,
  );
  return true;
}

/** Batches whose hops all finished but whose summary was never written (panel exited in between). */
export async function recoverManualForwardChainBatches() {
  const batchIds = await findUnsettledFinishedForwardTestBatchIds(FORWARD_CHAIN_BATCH_PREFIX, 100);
  for (const batchId of batchIds) await settleManualForwardChainBatch(batchId);
  if (batchIds.length === 100) selfTestSweepActivity.markActive();
}
