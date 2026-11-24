/*
  从 server/agentHeartbeatRoute.ts 第 3387-3426 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { appendPanelLog } from "../_core/panelLogger";
import { shouldSendRuntimeSyncAction } from "../agentHeartbeatDispatch";
import { AGENT_RUNTIME_SYNC_REPAIR_RESEND_MS } from "../agentHeartbeatRoute";

export type QueueNginxRuntimeSyncContext = {
  deferActionsForLocalState: any;
  nginxRuntimeConfigChanged: boolean;
  nginxRuntimeServiceUnhealthy: any;
  runtimeSyncBootstrap: any;
  nginxModelMayHaveChanged: boolean;
  nginxPeriodicReconcileDue: boolean;
  getNginxRuntimeSyncPlan: () => Promise<{ preCommands: Array<string>; commands: Array<string>; managedConfigs: Array<any>; }>;
  nginxReconcileInterval: number;
  host: any;
  responseIssuedAt: number;
  actions: Array<any>;
  reportedNginxHasWork: boolean;
  nginxDesiredRelevant: boolean;
};

export async function queueNginxRuntimeSync(ctx: QueueNginxRuntimeSyncContext) {
  const { deferActionsForLocalState, nginxRuntimeConfigChanged, nginxRuntimeServiceUnhealthy, runtimeSyncBootstrap, nginxModelMayHaveChanged, nginxPeriodicReconcileDue, getNginxRuntimeSyncPlan, nginxReconcileInterval, host, responseIssuedAt, actions, reportedNginxHasWork, nginxDesiredRelevant } = ctx;
  if (!deferActionsForLocalState && (
    nginxRuntimeConfigChanged
    || nginxRuntimeServiceUnhealthy
    || runtimeSyncBootstrap
    || nginxModelMayHaveChanged
    || nginxPeriodicReconcileDue
  )) {
    const nginxRuntimePlan = await getNginxRuntimeSyncPlan();
    const nginxRuntimeSyncAction = {
      statusType: "runtime",
      ruleId: 0,
      tunnelId: 0,
      op: "apply",
      forwardType: "nginx-runtime-sync",
      sourcePort: 0,
      targetIp: "",
      targetPort: 0,
      protocol: "tcp",
      knownRunning: false,
      forceRuntimeSync: true,
      preCommands: nginxRuntimePlan.preCommands,
      commands: nginxRuntimePlan.commands,
      managedConfigs: nginxRuntimePlan.managedConfigs,
    } as any;
    const runtimeRepairResendMs = nginxRuntimeServiceUnhealthy
      ? AGENT_RUNTIME_SYNC_REPAIR_RESEND_MS
      : nginxReconcileInterval;
    if (shouldSendRuntimeSyncAction(
      Number(host.id),
      nginxRuntimeSyncAction,
      nginxRuntimeConfigChanged || runtimeSyncBootstrap,
      responseIssuedAt,
      runtimeRepairResendMs,
    )) {
      actions.push(nginxRuntimeSyncAction);
      if (reportedNginxHasWork && !nginxDesiredRelevant) {
        appendPanelLog("warn", `[NginxRuntime] stale shared runtime cleanup queued host=${host.id} name=${String(host.name || "-")}`);
      }
    }
  }
}
