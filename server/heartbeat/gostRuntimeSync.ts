/*
  从 server/agentHeartbeatRoute.ts 第 3331-3370 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { appendPanelLog } from "../_core/panelLogger";
import { shouldSendRuntimeSyncAction } from "../agentHeartbeatDispatch";
import { AGENT_RUNTIME_SYNC_REPAIR_RESEND_MS } from "../agentHeartbeatRoute";

export type QueueGostRuntimeSyncContext = {
  deferActionsForLocalState: any;
  gostRuntimeConfigChanged: boolean;
  gostRuntimeServiceUnhealthy: any;
  runtimeSyncBootstrap: any;
  gostPeriodicReconcileDue: boolean;
  buildGostRuntimeSyncCmds: () => Promise<Array<string>>;
  gostManagedConfigs: Array<any>;
  gostReconcileInterval: number;
  host: any;
  responseIssuedAt: number;
  actions: Array<any>;
  reportedGostHasWork: any;
  gostDesiredRelevant: boolean;
};

export async function queueGostRuntimeSync(ctx: QueueGostRuntimeSyncContext) {
  const { deferActionsForLocalState, gostRuntimeConfigChanged, gostRuntimeServiceUnhealthy, runtimeSyncBootstrap, gostPeriodicReconcileDue, buildGostRuntimeSyncCmds, gostManagedConfigs, gostReconcileInterval, host, responseIssuedAt, actions, reportedGostHasWork, gostDesiredRelevant } = ctx;
  if (!deferActionsForLocalState && (
    gostRuntimeConfigChanged
    || gostRuntimeServiceUnhealthy
    || runtimeSyncBootstrap
    || gostPeriodicReconcileDue
  )) {
    const runtimeSyncAction = {
      statusType: "runtime",
      ruleId: 0,
      tunnelId: 0,
      op: "apply",
      forwardType: "gost-runtime-sync",
      sourcePort: 0,
      targetIp: "",
      targetPort: 0,
      protocol: "tcp",
      knownRunning: false,
      forceRuntimeSync: gostRuntimeConfigChanged
        || gostRuntimeServiceUnhealthy
        || runtimeSyncBootstrap
        || gostPeriodicReconcileDue,
      commands: await buildGostRuntimeSyncCmds(),
      managedConfigs: gostManagedConfigs,
    } as any;
    const runtimeRepairResendMs = gostRuntimeServiceUnhealthy
      ? AGENT_RUNTIME_SYNC_REPAIR_RESEND_MS
      : gostReconcileInterval;
    if (shouldSendRuntimeSyncAction(
      Number(host.id),
      runtimeSyncAction,
      gostRuntimeConfigChanged || runtimeSyncBootstrap,
      responseIssuedAt,
      runtimeRepairResendMs,
    )) {
      actions.push(runtimeSyncAction);
      if (reportedGostHasWork && !gostDesiredRelevant) {
        appendPanelLog("warn", `[GostRuntime] stale shared runtime cleanup queued host=${host.id} name=${String(host.name || "-")}`);
      }
    }
  }
}
