import { randomUUID } from "node:crypto";
import { executeRaw, rawAffectedRows, withDatabaseTransaction } from "./dbRuntime";
import { boolLiteral, quoteIdentifier as q } from "./dbCompat";
import { aggregateHopTestResults, type HopTestAggregate, type HopTestResult } from "./hopTestState";
import { structuredLinkTestMessage, tunnelHopLatencyMode, tunnelHopModeText, type TunnelHopLatencyMode } from "./linkTestMessages";
import { insertTunnelLatencyStat } from "./repositories/metricsRepository";
import { updateTunnelRunningStatus, updateTunnelTestResult } from "./repositories/tunnelRepository";
import {
  claimSettledForwardTestBatch,
  findUnsettledFinishedForwardTestBatchIds,
  forwardTestRequestMessage,
  TUNNEL_PROBE_BATCH_PREFIX,
} from "./repositories/forwardTestRepository";
import { SELF_TEST_MAX_LIFETIME_SECONDS, selfTestSweepActivity, selfTestTimeoutSeconds } from "./selfTestTiming";
import { appendPanelLog } from "./_core/panelLogger";

/*
  隧道手动测试（逐跳 / 多入口 / 多出口）的持久化批次，和 forwardChainManualProbe 同一套做法：
  批次只存在 forward_tests 里（batchId 以 tp- 开头），面板重启、结果先后到达、超时扫描都从
  数据库汇总，batchSettled 保证只汇总一次。规划哪些段要测仍是 routers/tunnels.ts 原来的逻辑。
*/

export function newTunnelProbeBatchId() {
  return `${TUNNEL_PROBE_BATCH_PREFIX}${randomUUID()}`;
}

function parseRequest(row: any): any {
  try { return JSON.parse(forwardTestRequestMessage(row) || "null") || {}; }
  catch { return {}; }
}

function tunnelSeriesLabel(value: unknown, fallback: string) {
  const label = String(value || fallback).trim().replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ");
  return (label || fallback).slice(0, 96);
}

export function tunnelHopSuccessMode(latencyMode: TunnelHopLatencyMode) {
  return latencyMode === "max" ? "any" : latencyMode === "multi-source" ? "multi-source" : "all";
}

export function tunnelHopResultFromRow(row: any, request = parseRequest(row)): HopTestResult {
  const hopLabel = String(request.hopLabel || "hop");
  const success = row.status === "success" && Number(row.latencyMs) > 0;
  const modeText = tunnelHopModeText(tunnelHopLatencyMode(request));
  return {
    success,
    latencyMs: success ? Number(row.latencyMs) : null,
    message: row.status === "timeout"
      ? `${modeText.label}超时：${hopLabel} 未在 ${selfTestTimeoutSeconds(request)} 秒内上报结果`
      : (typeof row.message === "string" ? row.message : null),
    hopLabel,
    routeLabel: typeof request.routeLabel === "string" ? request.routeLabel : null,
    groupKey: typeof request.groupKey === "string" ? request.groupKey : null,
    groupLabel: typeof request.groupLabel === "string" ? request.groupLabel : null,
  };
}

/** Publish an aggregated manual tunnel test: tunnel status, branch series and the total sample. */
export async function applyTunnelHopAggregate(tunnelId: number, aggregate: Pick<HopTestAggregate, "success" | "latencyMs" | "message" | "details">, latencyMode: TunnelHopLatencyMode) {
  const modeText = tunnelHopModeText(latencyMode);
  const aggregateMessage = structuredLinkTestMessage({
    kind: modeText.kind,
    tunnelId,
    message: aggregate.message,
    details: aggregate.details,
    totalLatencyMs: aggregate.latencyMs,
  });
  if (aggregate.success) await updateTunnelRunningStatus(tunnelId, true);
  await updateTunnelTestResult(tunnelId, {
    status: aggregate.success ? "success" : "failed",
    latencyMs: aggregate.success ? aggregate.latencyMs : null,
    message: aggregateMessage,
  });
  const recordedAt = new Date();
  if (latencyMode === "max") {
    let branchIndex = 0;
    for (const detail of aggregate.details || []) {
      branchIndex += 1;
      const key = branchIndex === 1 ? "primary" : `exit-${branchIndex}`;
      const label = tunnelSeriesLabel((detail as any).routeLabel || (detail as any).hopLabel, `出口 ${branchIndex}`);
      const branchLatency = typeof (detail as any).latencyMs === "number" && (detail as any).latencyMs > 0 ? Number((detail as any).latencyMs) : null;
      await insertTunnelLatencyStat({
        tunnelId,
        latencyMs: (detail as any).success ? branchLatency : null,
        isTimeout: !(detail as any).success,
        seriesKey: key,
        seriesLabel: label,
        recordedAt,
      }, { preserveMessage: true, updateTunnel: false });
    }
  }
  await insertTunnelLatencyStat({
    tunnelId,
    latencyMs: aggregate.success ? aggregate.latencyMs : null,
    isTimeout: !aggregate.success,
    seriesKey: "total",
    seriesLabel: modeText.seriesLabel,
    recordedAt,
  }, { message: aggregateMessage });
}

export async function settleManualTunnelProbeBatch(batchId: string) {
  if (!String(batchId || "").startsWith(TUNNEL_PROBE_BATCH_PREFIX)) return false;
  const outcome = await withDatabaseTransaction(async () => {
    const rows = await claimSettledForwardTestBatch(batchId);
    if (!rows) return null;
    const requests = rows.map(parseRequest);
    const meta = requests[0] || {};
    const tunnelId = Number(meta.tunnelId || 0);
    const latencyMode = tunnelHopLatencyMode(meta);
    const modeText = tunnelHopModeText(latencyMode);
    const aggregate = aggregateHopTestResults(tunnelId, rows.map((row, index) => tunnelHopResultFromRow(row, requests[index])), {
      successPrefix: modeText.successPrefix,
      failurePrefix: modeText.failurePrefix,
      totalLabel: modeText.totalLabel,
      latencyMode,
      successMode: tunnelHopSuccessMode(latencyMode),
    });
    if (tunnelId > 0) await applyTunnelHopAggregate(tunnelId, aggregate, latencyMode);
    return { tunnelId, aggregate, segments: rows.length };
  });
  if (!outcome) return false;
  appendPanelLog(
    outcome.aggregate.success ? "info" : "warn",
    `[TunnelTest] tunnel=${outcome.tunnelId} batch=${batchId} completed segments=${outcome.segments} success=${outcome.aggregate.success} latency=${outcome.aggregate.success && outcome.aggregate.latencyMs !== null ? `${outcome.aggregate.latencyMs}ms` : "-"}`,
  );
  return true;
}

/**
 * A new manual test supersedes the tunnel's unfinished batches: their late
 * reports still complete their own rows but can no longer overwrite the
 * newer result. Call inside the same tunnel lock as the new batch.
 */
export async function supersedeManualTunnelProbeBatches(tunnelId: number) {
  const id = Math.floor(Number(tunnelId));
  if (!Number.isInteger(id) || id <= 0) return 0;
  const result = await executeRaw(
    `UPDATE ${q("forward_tests")} SET ${q("batchSettled")} = ${boolLiteral(true)}
      WHERE ${q("batchSettled")} = ${boolLiteral(false)} AND ${q("batchId")} LIKE ?
        AND (${q("requestMessage")} LIKE ? OR ${q("requestMessage")} LIKE ?)`,
    [`${TUNNEL_PROBE_BATCH_PREFIX}%`, `%"tunnelId":${id},%`, `%"tunnelId":${id}}%`],
  );
  return rawAffectedRows(result);
}

/**
 * Tunnels left showing "pending"/"running" well past every test's lifetime —
 * e.g. a batch held only in memory by a panel version before durable batches.
 * Periodic probes can no longer overwrite a pending manual status, so release
 * it explicitly instead of leaving the card spinning forever.
 */
async function releaseAbandonedTunnelTestStatuses() {
  const cutoff = Math.floor(Date.now() / 1000) - SELF_TEST_MAX_LIFETIME_SECONDS * 2;
  await executeRaw(
    `UPDATE ${q("tunnels")}
        SET ${q("lastTestStatus")} = 'failed',
            ${q("lastTestMessage")} = ?
      WHERE ${q("lastTestStatus")} IN ('pending', 'running')
        AND (${q("lastTestAt")} IS NULL OR ${q("lastTestAt")} < ?)`,
    ["隧道测试未完成：没有收到全部 Agent 结果（测试已过期），请重新测试", cutoff],
  );
}

export async function recoverManualTunnelProbeBatches() {
  const batchIds = await findUnsettledFinishedForwardTestBatchIds(TUNNEL_PROBE_BATCH_PREFIX, 100);
  for (const batchId of batchIds) await settleManualTunnelProbeBatch(batchId);
  if (batchIds.length === 100) selfTestSweepActivity.markActive();
  await releaseAbandonedTunnelTestStatuses();
}
