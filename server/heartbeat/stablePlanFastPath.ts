/*
  从 server/agentHeartbeatRoute.ts 第 369-440 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { hasHostTcpingRequest, isHostMetricsWatching } from "../agentEvents";
import { AGENT_METRICS_WATCH_INTERVAL_SECONDS, agentStableHeartbeatPlanCache } from "../agentHeartbeatGate";
import { logAgentHeartbeatSummary } from "../agentHeartbeatLogging";
import { hasQueuedDiagnosticsAgentTasks } from "../diagnosticsAgentTasks";
import { hasPendingIpChangeProbeDelivery } from "../ipChange/runtime";
import { hasQueuedIperf3AgentTasks } from "../iperf3AgentTasks";
import { hasQueuedLookingGlassAgentTasks } from "../lookingGlassAgentTasks";
import { hasQueuedMimicInstallTask } from "../mimicInstallTasks";
import { hasQueuedPluginAgentTasks } from "../pluginAgentTasks";
import { hasQueuedRuleConnectionsTasks } from "../ruleConnectionsAgentTasks";
import { Response } from "express";

export type TryStableHeartbeatFastPathContext = {
  host: any;
  forceReconcile: boolean;
  forwardxAgentMigrationDue: boolean;
  panelMigrationForFastPath: any /* 原类型 PanelMigrationAgentDirective | null… 引用了拿不到的 PanelMigrationAgentDirective，手动收拾 */;
  recoveryTriggered: boolean;
  addressApplied: boolean;
  dnsChangedReports: any;
  req: any /* 原类型 Request<ParamsDictionary, any, any, QueryString.ParsedQs, Record<string, any>>… 引用了拿不到的 ParamsDictionary，手动收拾 */;
  localRuntimeState: any;
  fxpEndpointEvents: any;
  localRuntimeStateSignature: string;
  agentStateSignatures: Partial<Record<"runningRules" | "ruleLatencyProbes" | "tunnelProbes" | "forwardGroupProbes" | "hostProbeServices" | "guardRules" | "dnsWatch" | "sniInbounds", string>>;
  effectiveAgentVersion: string;
  agentBootId: string;
  agentProcessStartedAtSeconds: number;
  reportedDefaultNetworkInterface: string;
  pluginInventorySignature: string;
  mimicEnvironmentSignature: string;
  agentLastReceivedRevision: number;
  agentLastAppliedRevision: number;
  agentLastReceivedHash: string;
  agentLastAppliedHash: string;
  logHostId: number;
  logHostName: string;
  res: Response<any, Record<string, any>>;
};

export type TryStableHeartbeatFastPathResult =
  | { done: true; value: undefined }
  | { done: false };

export function tryStableHeartbeatFastPath(ctx: TryStableHeartbeatFastPathContext): TryStableHeartbeatFastPathResult {
  const { host, forceReconcile, forwardxAgentMigrationDue, panelMigrationForFastPath, recoveryTriggered, addressApplied, dnsChangedReports, req, localRuntimeState, fxpEndpointEvents, localRuntimeStateSignature, agentStateSignatures, effectiveAgentVersion, agentBootId, agentProcessStartedAtSeconds, reportedDefaultNetworkInterface, pluginInventorySignature, mimicEnvironmentSignature, agentLastReceivedRevision, agentLastAppliedRevision, agentLastReceivedHash, agentLastAppliedHash, logHostId, logHostName, res } = ctx;
  const stablePlan = agentStableHeartbeatPlanCache.match(host.id, {
    forceReconcile,
    hasBlockingWork: !!(host as any).agentUpgradeRequested
      || forwardxAgentMigrationDue
      || !!panelMigrationForFastPath
      || hasHostTcpingRequest(host.id)
      || hasQueuedLookingGlassAgentTasks(host.id)
      // 一键链路诊断（2.3.444）：排着的任务只在完整心跳里下发
      || hasQueuedDiagnosticsAgentTasks(host.id)
      || hasQueuedRuleConnectionsTasks(host.id)
      || hasQueuedIperf3AgentTasks(host.id)
      || hasQueuedPluginAgentTasks(host.id)
      // 排着的 mimic 安装任务只在完整心跳里下发（2.3.441 前漏了这条：配置不变的主机任务永远发不下去）
      || hasQueuedMimicInstallTask(host.id)
      // 自动换 IP 的探测任务跟着 hostProbeServices 下发；插件刚启停时配置签名没变，得靠这一条把快路径打断。
      || hasPendingIpChangeProbeDelivery(host.id),
    recoveryTriggered,
    addressChanged: addressApplied,
    hasDnsChanges: dnsChangedReports.length > 0,
    hasLocalStateUpload: !!req.body?.localState || localRuntimeState.requestLocalState,
    hasEndpointEvents: fxpEndpointEvents.length > 0,
    localStateSignature: localRuntimeStateSignature,
    stateSignatures: agentStateSignatures as Record<string, string>,
    agentVersion: effectiveAgentVersion,
    agentBootId,
    agentProcessStartedAt: agentProcessStartedAtSeconds,
    defaultNetworkInterface: reportedDefaultNetworkInterface,
    pluginInventorySignature,
    mimicEnvironmentSignature,
    agentLastReceivedRevision,
    agentLastAppliedRevision,
    agentLastReceivedHash,
    agentLastAppliedHash,
  });
  if (stablePlan) {
    const metricsWatching = isHostMetricsWatching(host.id);
    logAgentHeartbeatSummary({
      hostId: logHostId,
      hostName: logHostName,
      expectedRules: 0,
      reportedRules: Array.isArray(localRuntimeState.state?.rules) ? localRuntimeState.state.rules.length : 0,
      reportedServices: Array.isArray(localRuntimeState.state?.services) ? localRuntimeState.state.services.length : 0,
      actions: 0,
      pendingApply: 0,
      pendingRemove: 0,
      recoveryPending: false,
      requestLocalState: false,
      stable: true,
      metricsWatching,
      nextInterval: metricsWatching ? AGENT_METRICS_WATCH_INTERVAL_SECONDS : stablePlan.idleNextInterval,
    });
    res.json({
      success: true,
      actions: [],
      selfTests: [],
      lookingGlassTests: [],
      diagnosticsTasks: [],
      ruleConnectionTasks: [],
      iperf3Tasks: [],
      pluginTasks: [],
      agentUpgrade: null,
      panelUrl: stablePlan.panelUrl,
      forceTcping: false,
      nextInterval: metricsWatching ? AGENT_METRICS_WATCH_INTERVAL_SECONDS : stablePlan.idleNextInterval,
      requestLocalState: false,
      compactReports: true,
      presenceSupported: true,
      metricsOnly: metricsWatching,
      ...(metricsWatching ? { trafficReportInterval: 10 } : {}),
    });
    return { done: true as const, value: undefined };
  }
  return { done: false as const };
}
