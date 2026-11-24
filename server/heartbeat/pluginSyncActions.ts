/*
  从 server/agentHeartbeatRoute.ts 第 3195-3230 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { appendPanelLog } from "../_core/panelLogger";
import { AGENT_PLUGIN_SYNC_RESEND_MS, shouldSendPluginSyncAction } from "../agentHeartbeatDispatch";

export type QueuePluginSyncActionsContext = {
  pluginSyncTasks: Array<{ pluginId: string; pluginVersion: string; usageViewId: string; forwardType: string; syncSignature: string; expectAbsent: boolean; commands: string[]; }>;
  reportedPluginInventory: any /* 原类型 AgentPluginInventory | null… 引用了拿不到的 AgentPluginInventory，手动收拾 */;
  deferActionsForLocalState: any;
  host: any;
  responseIssuedAt: number;
  actions: Array<any>;
  pluginSyncActionQueued: boolean;
};

export type QueuePluginSyncActionsResult = {
  pluginSyncActionQueued: boolean;
};

export function queuePluginSyncActions(ctx: QueuePluginSyncActionsContext): QueuePluginSyncActionsResult {
  const { pluginSyncTasks, reportedPluginInventory, deferActionsForLocalState, host, responseIssuedAt, actions } = ctx;
  let { pluginSyncActionQueued } = ctx;
  for (const pluginSyncTask of pluginSyncTasks) {
    const reportedPluginVersion = reportedPluginInventory?.versions.get(pluginSyncTask.pluginId) || "";
    const syncConfirmed = !!reportedPluginInventory && (pluginSyncTask.expectAbsent
      ? !reportedPluginInventory.versions.has(pluginSyncTask.pluginId)
        && !reportedPluginInventory.syncSignatures.has(pluginSyncTask.pluginId)
      : reportedPluginVersion === pluginSyncTask.pluginVersion
        && reportedPluginInventory.syncSignatures.get(pluginSyncTask.pluginId) === pluginSyncTask.syncSignature);
    if (syncConfirmed) continue;
    const pluginSyncAction = {
      statusType: "runtime",
      ruleId: 0,
      tunnelId: 0,
      pluginId: pluginSyncTask.pluginId,
      op: "apply",
      forwardType: pluginSyncTask.forwardType,
      sourcePort: 0,
      targetIp: "",
      targetPort: 0,
      protocol: "tcp",
      knownRunning: false,
      reportStatus: true,
      failureMessage: `插件 ${pluginSyncTask.pluginId} 资源同步失败，请检查 Agent 日志`,
      commands: pluginSyncTask.commands,
    } as any;
    const repairResendMs = reportedPluginInventory && reportedPluginVersion !== pluginSyncTask.pluginVersion
      ? 5_000
      : AGENT_PLUGIN_SYNC_RESEND_MS;
    if (!deferActionsForLocalState && shouldSendPluginSyncAction(Number(host.id), pluginSyncAction, responseIssuedAt, repairResendMs)) {
      actions.push(pluginSyncAction);
      pluginSyncActionQueued = true;
      appendPanelLog(
        "info",
        `[Plugin] sync queued plugin=${pluginSyncTask.pluginId} usageView=${pluginSyncTask.usageViewId} host=${host.id} name=${String(host.name || "-")}`,
      );
    }
  }
  return { pluginSyncActionQueued };
}
