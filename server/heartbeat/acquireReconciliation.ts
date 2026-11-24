/*
  从 server/agentHeartbeatRoute.ts 第 267-308 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { agentHeartbeatGate } from "../agentHeartbeatGate";
import { logAgentHeartbeatSummary } from "../agentHeartbeatLogging";
import { resetAgentRuntimeStateForRecovery } from "../agentHeartbeatRecovery";
import { normalizeRuntimeStateSignature } from "../agentHeartbeatReport";
import * as db from "../db";
import { notifyHostOnlineIfNeeded } from "../hostStatusNotifier";
import { getPanelMigrationAgentDirective } from "../panelMigrationAgentState";
import { Response } from "express";

export type AcquireHeartbeatReconciliationContext = {
  busyHeartbeat: boolean;
  releaseHeartbeatReconciliation: (() => void) | null;
  logHostId: number;
  forceReconcile: boolean;
  wasOnline: boolean;
  host: any;
  req: any /* 原类型 Request<ParamsDictionary, any, any, QueryString.ParsedQs, Record<string, any>>… 引用了拿不到的 ParamsDictionary，手动收拾 */;
  logHostName: string;
  res: Response<any, Record<string, any>>;
};

export type AcquireHeartbeatReconciliationResult =
  | { done: true; value: undefined }
  | { done: false; releaseHeartbeatReconciliation: (() => void) | null };

export async function acquireHeartbeatReconciliation(ctx: AcquireHeartbeatReconciliationContext): Promise<AcquireHeartbeatReconciliationResult> {
  const { busyHeartbeat, logHostId, forceReconcile, wasOnline, host, req, logHostName, res } = ctx;
  let { releaseHeartbeatReconciliation } = ctx;
  if (!busyHeartbeat) {
    releaseHeartbeatReconciliation = agentHeartbeatGate.tryAcquire(logHostId, { force: forceReconcile });
    if (!releaseHeartbeatReconciliation) {
      await db.touchHostHeartbeat(logHostId);
      if (!wasOnline) {
        await resetAgentRuntimeStateForRecovery(logHostId, "agent-reconnected-heartbeat-coalesced");
        void notifyHostOnlineIfNeeded({ ...host, isOnline: true, lastHeartbeat: new Date() }).catch((error) => {
          console.warn(`[HostStatus] Online notify failed host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      const panelMigration = await getPanelMigrationAgentDirective(logHostId);
      const coalescedRequestLocalState = !!normalizeRuntimeStateSignature(req.body?.localStateSignature);
      const coalescedRetrySeconds = agentHeartbeatGate.retryHintSeconds(logHostId);
      logAgentHeartbeatSummary({
        hostId: logHostId,
        hostName: logHostName,
        expectedRules: 0,
        reportedRules: 0,
        reportedServices: 0,
        actions: 0,
        pendingApply: 0,
        pendingRemove: 0,
        recoveryPending: !wasOnline,
        requestLocalState: coalescedRequestLocalState,
        coalesced: true,
        stable: false,
        nextInterval: coalescedRetrySeconds,
      });
      res.json({
        success: true,
        actions: [],
        selfTests: [],
        nextInterval: coalescedRetrySeconds,
        requestLocalState: coalescedRequestLocalState,
        compactReports: true,
        presenceSupported: true,
        reconciliationCoalesced: true,
        panelMigration,
      });
      return { done: true as const, value: undefined };
    }
  }
  return { done: false as const, releaseHeartbeatReconciliation };
}
