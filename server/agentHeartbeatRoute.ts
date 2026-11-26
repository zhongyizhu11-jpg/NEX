import { orderEntryRoutesForPin } from "./tunnelExitPin";
import { Router, Request, Response } from "express";
import { parseFailoverTargets } from "../shared/failoverTargets";
import { parseAgentLoadAverage } from "../shared/hostLoadAverage";
import {
  routeDeliveryStrategy,
  routeDestSpreadReady,
  normalizeRouteDelivery,
  routeGroupForwardTypeSupported,
  routeGroupOf,
  routePathDial,
  routePathsOf,
} from "../shared/routeGroup";
import { noteRouteFirstHops, routeHopDownHints, routeNodeHints } from "./routeGroupStats";
import { withRouteDrillHints } from "./routeDrill";
import { buildRouteFailoverTargets } from "./routeTargetHints";
import { ensureRouteNodeHealthFresh, getRouteNodeStatus } from "./routeNodeHealth";
import { ingestFailoverLineReports } from "./failoverLineReports";
import { claimTunnelExitReportRequest, hasTunnelExitPort, loadTunnelExitPorts, tunnelExitPortFor } from "./tunnelExitPorts";
import * as db from "./db";
import { classifyHeartbeatAgentDistribution, normalizeAgentDistribution } from "../shared/agentDistribution";
import { isForwardxAgentMigrationEnabled, shouldQueueForwardxAgentMigration } from "./forwardxAgentMigration";
import { getIpChangeProbeTasksForHost } from "./ipChange/runtime";
import { clearHostTcpingRequest, hasHostTcpingRequest, isHostMetricsWatching, pushAgentDesiredState, pushAgentRefresh } from "./agentEvents";
import { buildMetaAgentSelfTestPayload, buildRuleAgentSelfTestPayload, hasAgentVersionChanged, normalizeReportedFxpVersion, parseSelfTestMeta, tunnelSecretSeed } from "./agentRouteUtils";
import { getPanelMigrationAgentDirective } from "./panelMigrationAgentState";
import * as hopRepo from "./repositories/tunnelRepository";
import { isRuleProtocolEnabled, isTunnelProtocolEnabled } from "./forwardProtocolSettings";
import { agentStableHeartbeatPlanCache, buildPresenceAgentHeartbeatResponse, selectAgentHeartbeatInterval, shouldPersistAgentPresence } from "./agentHeartbeatGate";
import { mapWithConcurrency } from "./asyncPool";
import { portAccessLimitAction, portAccessLimitSpecs, readPortAccessLimitsEnabled, resolvePortAccessLimitAction } from "./portAccessLimits";
import { ruleLimitRootId } from "./ruleLimits";
import { anomalyAwareRuleMbps } from "./ops/trafficAnomalyThrottles";
import { getTunnelRuntimeGeneration, isTunnelRuntimeHostReady } from "./tunnelRuntimeStatus";
import { appendPanelLog } from "./_core/panelLogger";
import { takeLookingGlassAgentTasks } from "./lookingGlassAgentTasks";
import { hasRunningDiagnosticsAgentTasks, takeDiagnosticsAgentTasks } from "./diagnosticsAgentTasks";
import { hasRunningRuleConnectionsTasks, takeRuleConnectionsTasks } from "./ruleConnectionsAgentTasks";
import { takeIperf3AgentTasks } from "./iperf3AgentTasks";
import { hasQueuedPluginAgentTasks, takePluginAgentTasks } from "./pluginAgentTasks";
import { hasPendingMimicInstallTask, takeMimicInstallTask } from "./mimicInstallTasks";
import { getAgentPluginInventory, updateAgentPluginInventory } from "./agentPluginInventory";
import { getAgentHostFromRequest, getAgentHostIdentityFromRequest, getAgentPresenceHostFromRequest } from "./agentAuth";
import { liveMetricsIntervalFor, liveSampleFromCompactMetrics, recordHostLiveSample } from "./hostLiveMetrics";
import { normalizeAgentText, normalizeNetworkInterface } from "./agentInputValidation";
import { setBoundedMapValue } from "./boundedCache";
import { onHostDeleted, onRuleDeleted } from "./entityCleanup";
import { ignoreErrorWith } from "./ignoredError";
import { mergeAgentReportedAddress, observedAgentAddress } from "./agentAddressState";
import { hostEgressAddress, recordHostObservedAddress, type HostEgressSource } from "./hostObservedAddress";
import { noteAgentPrivateIpv4 } from "./agentPrivateAddress";
import { gostTunnelTransportType, shouldReconcileGostRuntime, shouldReconcileNginxRuntime, tunnelRuleRuntimeForwardType } from "./tunnelRuntimePlan";
import { effectiveTunnelProxyProtocolOptions, gostProxyProtocolMetadata, gostTunnelProxyProtocolPlan, resolveRuleProxyProtocolOptions } from "./gostProxyProtocol";
import { planGostTunnelRuleProtocol } from "./gostTunnelProtocol";
import { buildCountingChainCmds, buildCountingCleanupCmds, buildKernelForwardTransitionCleanupCmds, buildEntryBridgeConntrackFlushCmds, buildIptablesForwardCleanupCmds, buildManagedPortCleanupCmds, buildNftCleanupCmds, buildKernelForwardCmds, shQuote } from "./agentActionCommands";
import { REALM_CONFIG_DIR, buildRealmConfigToml, buildRealmServiceUnit, buildSocatServiceUnit, endpointHostPort, realmConfigPathForPort, realmServiceNameForPort, realmTomlString, SOCAT_TRANSFER_BUFFER_FLAG, socatDialAddress, socatSocketOptions, socatServiceNameForPort } from "./forwardRuntimeConfigs";
import { hostIngressAddress } from "./hostAddressRuntime";
import { isHostStatusOnline, notifyHostOnlineIfNeeded } from "./hostStatusNotifier";
import { buildPluginHostAssetSyncActions } from "./repositories/pluginRepository";
import {
  forwardRuleProtocols,
  isForwardRuleProtocolTcpEnabled,
  isForwardRuleProtocolUdpEnabled,
  normalizeForwardRuleProtocol,
} from "@shared/forwardTypes";
import { buildForwardXWireGuardMimicFilters, isForwardXWireGuardV2 } from "./forwardXWireGuard";
import { agentActionIssueTracker, agentStatusOrderGuard, agentStatusOrderingKey } from "./agentStatusOrdering";
import { resolveRuleTrafficPortForHost } from "./agentRuntimeRuleState";
import { isTunnelRelayAggregate, isTunnelRelayHotStandby, tunnelRelayUsesParallelRelays } from "@shared/tunnelRelay";
import {
  buildParallelStreamLegs,
  normalizeTunnelParallelStreams,
  tunnelParallelStreamsUnavailableReason,
} from "@shared/tunnelParallelStreams";
import { hostIpv6ListenAvailable, parseReportedIpv6Listen } from "@shared/hostIpv6Listen";
import { ensureLandingNodeHosts } from "./hostLoad";
import { forwardXExitStrategy, fxpSupportsTargetAware } from "./tunnelExitStrategy";
import { agentSupportsUnifiedBalance, balanceDetectForRuntime, exitGroupWeights, GOST_BALANCE_MAX_EXITS } from "@shared/loadBalance";
import { planGostBalanceRules, type GostBalanceRulePlan } from "./gostBalancePlan";
import { exitTargetExcludedHostIds, exitTargetUsableStatesForRule, tunnelBalanceDetect, tunnelBalancesExits } from "./exitTargetHealth";
import { getMimicLifecycleRevisionSignature, recordConfigAuditEvent } from "./configAudit";
import { approveMimicInterfaceRemovals } from "./mimicRemovalGuard";
import { mimicRuntimeLifecycles } from "./mimicRuntimeLifecycle";
import { normalizeAgentStateSignatures, normalizeRuntimeStateSignature, stableStateSignature, type AgentLocalRuntimeRuleState, type AgentLocalRuntimeServiceState, type AgentLocalRuntimeTunnelState } from "./agentHeartbeatReport";
import { stableActionSignatureHash, stableDesiredStateHash, withDesiredStateConfigHash } from "./agentDesiredStateHash";
// 这几个以前直接从本文件导出，测试和别的模块还按老路径引用。
export { stableStateSignature, stableDesiredStateHash, withDesiredStateConfigHash };
import { createResolvedTargetGate } from "./ruleTargetPolicy";
import { gateForwardRulesForRuntime } from "./linkAccessView";
import { getTrafficExcludedHostIds } from "./hostTrafficPolicy";
import { isEntryBridgeRuntimeRule, markRuntimeRulesNotRunning } from "./ruleEntryBridges";
import { isEntryBridgeRuleId } from "../shared/ruleEntryBridge";
import { observePresenceCapableHostActivity, registerPresenceCapableHost } from "./agentFastLiveness";
import { recordAuthenticatedAgentActivity } from "./agentActivity";
import { buildForwardRateTiers, forwardRateTiersForAgent, mbpsToBytesPerSecond, strictestForwardRate } from "../shared/forwardRateLimit";
import { isSniRuntimeRule } from "./tlsInboundRuntime";
import { loadEgressRuntimeContext } from "./ssEgress";
import { normalizeRuleEgressType, parseAgentCapabilities } from "../shared/ssEgress";
import { AGENT_DYNAMIC_CACHE_MAX, AGENT_HOST_CACHE_MAX, agentDesiredDispatchAuditHash, forgetAgentHeartbeatHost, forgetAgentHeartbeatRule, fxpUdpTargetSignatureCache, pruneAgentHeartbeatCaches } from "./agentHeartbeatState";
import { addDnsWatch, expireSharedResolvedIp, resolveTargetIpCached } from "./agentHeartbeatDns";
import { forwardXUDPTargetAddress, isForwardXTunnelMode, isGostTunnelMode, legacyRealmCleanupCmds, legacySocatCleanupCmds, RUNTIME_SERVICE_NAME, runtimeBool, SHARED_GOST_FORWARD_TYPES, TUNNEL_RUNTIME_SERVICE_NAME, udpOverTcpEnabled } from "./agentHeartbeatRuntime";
import {
  isNginxTunnelMode,
  NGINX_SERVICE_NAME,
  nginxRuntimeVerifyCmd,
  SHARED_NGINX_FORWARD_TYPES,
} from "./agentHeartbeatNginx";
import { allocateProtocolGuardPorts, cleanupGuardBackendCmds, PROTOCOL_GUARD_LEGACY_SPAN, PROTOCOL_GUARD_PORT_MAX, PROTOCOL_GUARD_PORT_MIN, protocolPolicyFromHost, realmGuardConfigPathForPort, selectProtocolGuardProxyProtocol, shouldReconcileProtocolGuardBackend, shouldUseProtocolGuard } from "./agentHeartbeatProtocolGuard";
import { buildAccessLimitCleanupCmds, buildAccessLimitCmds } from "./agentHeartbeatAccessLimits";
import type { TunnelEgressHelper } from "./agentHeartbeatContext";
import { createGostRuntimePlan } from "./agentHeartbeatGostPlan";
import { createDisabledRuleRemovalBuilder } from "./agentHeartbeatRuleRemoval";
import { createForwardXWireGuardPlanner } from "./agentHeartbeatWireGuardPlan";
import { createForwardXHopSpecBuilder } from "./agentHeartbeatForwardXHop";
import { createLocalRuntimeMatchers } from "./agentHeartbeatLocalMatch";
import { createNginxRuntimeSyncPlanBuilder } from "./agentHeartbeatNginxPlan";
import {
  fxpHopKey,
  gostTunnelNode,
  holdTunnelEgressRule,
  pointTunnelEgressRule,
  tunnelExitRowsMatchNodes,
} from "./agentHeartbeatTunnel";
import { actionMayAffectRuntimeFamily, isTunnelApplyBlockingProbe, ruleRuntimeIdentityKey, ruleRuntimePortIdentityKey, runtimePortProtocolKey, runtimeSyncReconcileDue, shouldSendDesiredState } from "./agentHeartbeatDispatch";
import { agentPluginInventorySignature, buildAgentStateResponseSections, isKernelForwardRule, settleStoppedRule } from "./agentHeartbeatLocalState";
import { resetAgentRuntimeStateForRecovery } from "./agentHeartbeatRecovery";
import { logAgentHeartbeatSummary, shouldLogAgentRuntimeDrift } from "./agentHeartbeatLogging";
import { isPortRangeRule, ruleSourcePortEnd } from "@shared/portRange";
import { buildForwardGroupProbes } from "./heartbeat/forwardGroupProbes";
import { reconcileTunnelRuntimeReadiness } from "./heartbeat/tunnelRuntimeReadiness";
import { buildProtocolPolicyHelpers } from "./heartbeat/protocolPolicyHelpers";
import { resolveHostRuleTargets } from "./heartbeat/hostRuleTargets";
import { loadHeartbeatRules } from "./heartbeat/loadRules";
import { ingestHeartbeatHostState } from "./heartbeat/ingestHostState";
import { planTunnelExitPortsAndSni } from "./heartbeat/tunnelExitPortsAndSni";
import { orderHeartbeatActions } from "./heartbeat/orderActions";
import { resolveAgentUpgradeDirective } from "./heartbeat/agentUpgradeDirective";
import { collectHeartbeatRunningRules } from "./heartbeat/runningRules";
import { restoreTunnelRulesFromLocalState } from "./heartbeat/restoreTunnelRulesFromLocalState";
import { queueMimicRuntimeSync } from "./heartbeat/mimicRuntimeSync";
import { queueSingboxRuntimeSync } from "./heartbeat/singboxRuntimeSync";
import { queueNginxRuntimeSync } from "./heartbeat/nginxRuntimeSync";
import { queueGostRuntimeSync } from "./heartbeat/gostRuntimeSync";
import { queuePluginSyncActions } from "./heartbeat/pluginSyncActions";
import { protectActionPortsFromLocalState } from "./heartbeat/protectActionPorts";
import { buildTunnelProbes } from "./heartbeat/tunnelProbes";
import { blockRulesForTrafficExcludedHosts } from "./heartbeat/trafficExcludedHosts";
import { validateTunnelEgressRules } from "./heartbeat/tunnelEgressRuleShape";
import { acquireHeartbeatReconciliation } from "./heartbeat/acquireReconciliation";
import { tryStableHeartbeatFastPath } from "./heartbeat/stablePlanFastPath";
import { buildExitSelectionHelpers } from "./heartbeat/exitSelectionHelpers";
import { buildDialAddressHelpers } from "./heartbeat/dialAddressHelpers";
import { buildMimicFilterHelpers } from "./heartbeat/mimicFilterHelpers";
import { buildForwardXTransportHelpers } from "./heartbeat/forwardXTransportHelpers";
// 下面这些拆到了 agentHeartbeat*.ts，测试和别的模块还按老路径从本文件引用。
export { forgetAgentHeartbeatHost, forgetAgentHeartbeatRule, pruneAgentHeartbeatCaches, invalidateAgentDesiredStateCache } from "./agentHeartbeatState";
export { normalizeAgentRuntimeBoolean, buildGostRuleListener, forwardXUDPTargetAddress, selectForwardChainListenerPort } from "./agentHeartbeatRuntime";
export { buildNginxStreamServerBlock, buildNginxStreamConfig, buildNginxTunnelTlsClientOptions, buildNginxTunnelServerCertificate, buildNginxCertificateCleanupCmd, buildNginxRuntimeRetirementPlan } from "./agentHeartbeatNginx";
export { shouldReconcileProtocolGuardBackend, allocateProtocolGuardPorts, selectProtocolGuardRateLimit, selectProtocolGuardProxyProtocol } from "./agentHeartbeatProtocolGuard";
export type { ProtocolGuardPortPlan } from "./agentHeartbeatProtocolGuard";
export { isTunnelApplyBlockingProbe } from "./agentHeartbeatDispatch";

onHostDeleted(forgetAgentHeartbeatHost);
onRuleDeleted(forgetAgentHeartbeatRule);

const agentCacheCleanupTimer = setInterval(() => pruneAgentHeartbeatCaches(), 10 * 60 * 1000);
agentCacheCleanupTimer.unref?.();
export const AGENT_RUNTIME_SYNC_REPAIR_RESEND_MS = 60 * 1000;
export const AGENT_GOST_RUNTIME_RECONCILE_MS = 5 * 60 * 1000;
const AGENT_NGINX_RUNTIME_RECONCILE_MS = 5 * 60 * 1000;
export const AGENT_MIMIC_RUNTIME_RECONCILE_MS = 5 * 60 * 1000;
const VERBOSE_AGENT_ACTIONS = /^(1|true|yes|on)$/i.test(String(process.env.FORWARDX_VERBOSE_AGENT_ACTIONS || ""));

export function registerAgentHeartbeatRoute(agentRouter: Router) {
/*
  实时指标（Agent 2.2.225 起）：主机详情开着时 Agent 每秒发一份紧凑指标 m，只放内存
  （hostLiveMetrics.ts），不进库、不碰对账。回包 intervalMs 告诉它下一次多久后发，0 就停。
*/
agentRouter.post("/api/agent/live-metrics", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const hostId = Number((host as any).id);
    const sample = liveSampleFromCompactMetrics(req.body?.m, Date.now(), "live", req.body?.loadAverage);
    if (sample) recordHostLiveSample(hostId, sample);
    res.json({ success: true, intervalMs: liveMetricsIntervalFor(hostId) });
  } catch (error) {
    console.error("[Agent LiveMetrics] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/presence", async (req: Request, res: Response) => {
  try {
    const host = await getAgentPresenceHostFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const wasOnline = isHostStatusOnline(host);
    recordAuthenticatedAgentActivity(host.id);
    registerPresenceCapableHost(host.id);
    if (shouldPersistAgentPresence({ wasOnline, lastHeartbeat: (host as any).lastHeartbeat })) {
      await db.touchHostHeartbeat(host.id);
    }
    if (!wasOnline) {
      // Presence has an eight-second client timeout and must remain a liveness-only
      // request. Runtime recovery is serialized separately and must not make an
      // already accepted presence look like a communication failure to the Agent.
      void resetAgentRuntimeStateForRecovery(host.id, "agent-reconnected-presence")
        .then(() => notifyHostOnlineIfNeeded({ ...host, isOnline: true, lastHeartbeat: new Date() }))
        .catch((error) => {
          console.warn(`[AgentRecovery] Presence recovery failed host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    const panelMigration = await getPanelMigrationAgentDirective(Number(host.id));
    res.json(buildPresenceAgentHeartbeatResponse({ panelMigration }));
  } catch (error) {
    console.error("[Agent Presence] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/heartbeat", async (req: Request, res: Response) => {
  let logHostId = 0;
  let logHostName = "";
  let releaseHeartbeatReconciliation: (() => void) | null = null;
  try {
    const host = await getAgentHostFromRequest(req, { recordActivity: false });
    if (!host) {
      const migratedTo = await db.getSetting("migratedToPanelUrl");
      if (migratedTo) {
        res.status(410).json({
          success: false,
          agentUpgrade: { targetVersion: "9999.0.0", panelUrl: migratedTo },
          error: "Panel migrated",
        });
        return;
      }
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const wasOnline = isHostStatusOnline(host);
    recordAuthenticatedAgentActivity(host.id);
    observePresenceCapableHostActivity(host.id);
    logHostId = Number((host as any).id || 0);
    logHostName = String((host as any).name || "").trim();
    updateAgentPluginInventory(logHostId, req.body?.pluginVersions, req.body?.pluginSyncSignatures);
    /*
      主备线路的切换事件和「现在走哪条」的快照，在这里收 —— 下面有三处早退（对账合并、
      忙碌心跳、稳定快路径），Agent 那边这一批事件已经清掉了，谁都没看的话就永远丢了。
      见 failoverLineReports。
    */
    await ingestFailoverLineReports({
      hostId: logHostId,
      events: req.body?.failoverEvents,
      snapshot: req.body?.failoverActive,
      stats: req.body?.failoverStats,
      loadHostRules: () => db.getForwardRuleFailoverLinesForAgent(logHostId) as Promise<any[]>,
    }).catch((error) => {
      appendPanelLog("warn", `[Failover] host=${logHostId} 线路上报处理失败: ${String((error as any)?.message || error)}`);
    });

    const compactMetrics = Array.isArray(req.body?.m) ? req.body.m : [];
    const busyHeartbeat = req.body?.busy === true || String(req.body?.busy || "").toLowerCase() === "true";
    const forceReconcile = req.body?.forceReconcile === true || String(req.body?.forceReconcile || "").toLowerCase() === "true";
    const acquireHeartbeatReconciliationResult = await acquireHeartbeatReconciliation({ busyHeartbeat, releaseHeartbeatReconciliation, logHostId, forceReconcile, wasOnline, host, req, logHostName, res });
    if (acquireHeartbeatReconciliationResult.done) return ;
    releaseHeartbeatReconciliation = acquireHeartbeatReconciliationResult.releaseHeartbeatReconciliation;
    // 指标一律转成有限的非负数：Agent 在租户手里，传一段几 MB 的字符串进来，SQLite 会
    // 原样存成 TEXT，每次心跳都往 host_metrics 里塞，主机列表每次也要把它读出来。
    // 这些列都是整型（百分比几项是 INT，其余 BIGINT）：小数在 PG 上是 invalid input syntax for type
    // integer，超过 int 范围两边都报 out of range —— 整条心跳的指标写入失败。一律取整，INT 列再截到 int 上限。
    const heartbeatMetric = (key: string, index: number, max = Number.MAX_SAFE_INTEGER) => {
      const raw = req.body?.[key] ?? compactMetrics[index];
      if (raw === undefined || raw === null) return raw;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), max) : undefined;
    };
    const cpuUsage = heartbeatMetric("cpuUsage", 0, 2147483647);
    const memoryUsage = heartbeatMetric("memoryUsage", 1, 2147483647);
    const memoryUsed = heartbeatMetric("memoryUsed", 2);
    const memoryTotal = heartbeatMetric("memoryTotal", 3);
    const swapUsage = heartbeatMetric("swapUsage", 4, 2147483647);
    const swapUsed = heartbeatMetric("swapUsed", 5);
    const swapTotal = heartbeatMetric("swapTotal", 6);
    const networkIn = heartbeatMetric("networkIn", 7);
    const networkOut = heartbeatMetric("networkOut", 8);
    const diskUsage = heartbeatMetric("diskUsage", 9, 2147483647);
    const diskUsed = heartbeatMetric("diskUsed", 10);
    const diskTotal = heartbeatMetric("diskTotal", 11);
    const uptime = heartbeatMetric("uptime", 12);
    // 2.2.215 起 Agent 多报两个数：此刻的 TCP / UDP 连接数。旧 Agent 没有这两项，存 null，界面画「—」。
    const tcpConnections = heartbeatMetric("tcpConnections", 13, 2147483647);
    const udpConnections = heartbeatMetric("udpConnections", 14, 2147483647);
    // 2.2.255 起 Agent 多报 loadAverage：[1, 5, 15 分钟负载]，小数。不走上面的 heartbeatMetric（那边一律取整），
    // 老 Agent、没有 /proc/loadavg 的平台不报，三个都是 null，界面上不多画。
    const loadAverage = parseAgentLoadAverage(req.body?.loadAverage);
    const { cpuInfo, agentVersion } = req.body;
    const nextCpuInfo = normalizeAgentText(cpuInfo, 256);
    const nextAgentVersion = normalizeAgentText(agentVersion, 64);
    const agentVersionChanged = hasAgentVersionChanged((host as any).agentVersion, nextAgentVersion);
    // 没报（旧 Agent）就保留库里的值；报了就以这次为准。
    const nextFxpVersion = normalizeReportedFxpVersion(req.body?.fxpVersion);
    const fxpVersionChanged = !!nextFxpVersion && nextFxpVersion !== String((host as any).fxpVersion || "");
    // 发行来源（NEX / 原版 ForwardX，shared/agentDistribution.ts）：这次认不出来（精简心跳）就保留库里的值。
    const forwardxAgentMigrationEnabled = await isForwardxAgentMigrationEnabled();
    const reportedAgentDistribution = classifyHeartbeatAgentDistribution(req.body, { unknownAsForwardx: forwardxAgentMigrationEnabled });
    const agentDistributionChanged = !!reportedAgentDistribution
      && reportedAgentDistribution !== normalizeAgentDistribution(host.agentDistribution);
    /*
      2.2.227 起 Agent 每次心跳都带上：实测的 gost 运行时版本和能力（ssEgressUdp / ssEgress2022，见
      shared/ssEgress.ts）。报了就以这次为准（运行时回滚后能力会消失）；没报（旧 Agent）保留库里的值，
      反正能力还要 Agent ≥ 2.2.227 才认。能力一变，这台机器的期望状态要重算：UDP / SS2022 出口的规则
      按新能力下发或按停用下发。
    */
    const reportedCapabilities = Array.isArray(req.body?.agentCapabilities)
      ? JSON.stringify(parseAgentCapabilities(req.body.agentCapabilities))
      : null;
    const reportedRuntimeVersion = req.body?.runtimeVersion !== undefined ? normalizeAgentText(req.body?.runtimeVersion, 64) : null;
    const capabilitiesChanged = reportedCapabilities !== null
      && reportedCapabilities !== JSON.stringify(parseAgentCapabilities((host as any).agentCapabilities));
    const runtimeVersionChanged = reportedRuntimeVersion !== null
      && reportedRuntimeVersion !== String((host as any).runtimeVersion || "");
    const agentBootId = normalizeAgentText(req.body?.agentBootId, 128);
    const agentBootedAtSeconds = Number(req.body?.agentBootedAt || 0);
    const agentProcessId = Math.max(0, Math.floor(Number(req.body?.agentProcessId || 0)));
    const agentProcessStartedAtSeconds = Number(req.body?.agentProcessStartedAt || 0);
    const agentLastReceivedRevision = Math.max(0, Math.floor(Number(req.body?.agentLastReceivedRevision || 0)));
    const agentLastAppliedRevision = Math.max(0, Math.floor(Number(req.body?.agentLastAppliedRevision || 0)));
    const agentLastReceivedHash = normalizeAgentText(req.body?.agentLastReceivedHash, 64);
    const agentLastAppliedHash = normalizeAgentText(req.body?.agentLastAppliedHash, 64);
    const reportedDefaultNetworkInterface = normalizeNetworkInterface(req.body?.defaultNetworkInterface);
    /*
      Agent 2.2.256 起每次心跳带 ipv6Listen：这台机器能不能开 IPv6 监听（agent/ipv6_listen.go）。报了就记到
      主机上（没报的老 Agent 不动，按能用算）；生效的结论（null 和 true 都算能用）一变，期望状态要重算：
      realm / socat / nginx 的监听在 [::] 和 0.0.0.0 之间换。
    */
    const reportedIpv6Listen = parseReportedIpv6Listen(req.body?.ipv6Listen);
    const ipv6ListenStoredChanged = reportedIpv6Listen !== null
      && reportedIpv6Listen !== (host.ipv6ListenAvailable ?? null);
    const ipv6ListenEffectiveChanged = reportedIpv6Listen !== null
      && reportedIpv6Listen !== hostIpv6ListenAvailable(host);
    const previousHost = { ...(host as any) };
    const observedAddress = observedAgentAddress(req);
    const reportedAddress = mergeAgentReportedAddress(req.body, host, observedAddress);
    // 出口 IP 核对（hostObservedAddress）：面板看到的对端地址和登记的 IP 不一样时主机卡上提示。
    recordHostObservedAddress(Number(host.id), observedAddress);
    noteAgentPrivateIpv4(host.id, req.body?.privateIpv4);
    const dnsChangedReports = Array.isArray(req.body?.dnsChanged) ? req.body.dnsChanged : [];
    const agentStateSignatures = normalizeAgentStateSignatures(req.body?.stateSignatures);
    const localRuntimeStateSignature = normalizeRuntimeStateSignature(req.body?.localStateSignature);
    const ingestHeartbeatHostStateResult = await ingestHeartbeatHostState({ host, localRuntimeStateSignature, req, dnsChangedReports, reportedAddress, wasOnline, previousHost, uptime, agentBootId, agentProcessId, agentProcessStartedAtSeconds, nextAgentVersion, agentVersionChanged, fxpVersionChanged, agentDistributionChanged, capabilitiesChanged, runtimeVersionChanged, ipv6ListenStoredChanged, nextCpuInfo, memoryTotal, agentLastReceivedRevision, agentLastAppliedRevision, agentLastReceivedHash, agentLastAppliedHash, busyHeartbeat, nextFxpVersion, reportedAgentDistribution, reportedCapabilities, reportedRuntimeVersion, reportedIpv6Listen, agentBootedAtSeconds, ipv6ListenEffectiveChanged, cpuUsage, memoryUsage, memoryUsed, swapUsage, swapUsed, swapTotal, networkIn, networkOut, diskUsage, diskUsed, diskTotal, tcpConnections, udpConnections, loadAverage, logHostId, logHostName, res });
    if (ingestHeartbeatHostStateResult.done) return ;
    const { mimicEnvironment, recoveryTriggered, addressApplied, localRuntimeState, fxpEndpointEvents, effectiveAgentVersion, dnsChangedScopes, dnsChangedTokenByScope, dnsChangedIpByHost, rebootDetected, processRestartDetected } = ingestHeartbeatHostStateResult;

    const reportedPluginInventoryForFastPath = getAgentPluginInventory(host.id);
    const pluginInventorySignature = agentPluginInventorySignature(reportedPluginInventoryForFastPath);
    const mimicEnvironmentSignature = stableStateSignature(mimicEnvironment || null);
    const panelMigrationForFastPath = await getPanelMigrationAgentDirective(Number(host.id));
    // 从原版 ForwardX 迁过来、还要排「换成 NEX Agent」的主机：走完整心跳（排队在完整心跳里做）
    const forwardxAgentMigrationDue = shouldQueueForwardxAgentMigration({
      enabled: forwardxAgentMigrationEnabled,
      hostId: Number(host.id),
      agentDistribution: host.agentDistribution,
      agentUpgradeRequested: host.agentUpgradeRequested,
    });
    const tryStableHeartbeatFastPathResult = tryStableHeartbeatFastPath({ host, forceReconcile, forwardxAgentMigrationDue, panelMigrationForFastPath, recoveryTriggered, addressApplied, dnsChangedReports, req, localRuntimeState, fxpEndpointEvents, localRuntimeStateSignature, agentStateSignatures, effectiveAgentVersion, agentBootId, agentProcessStartedAtSeconds, reportedDefaultNetworkInterface, pluginInventorySignature, mimicEnvironmentSignature, agentLastReceivedRevision, agentLastAppliedRevision, agentLastReceivedHash, agentLastAppliedHash, logHostId, logHostName, res });
    if (tryStableHeartbeatFastPathResult.done) return ;

    // 获取该主机的转发规则
    const loadHeartbeatRulesResult = await loadHeartbeatRules({ host, effectiveAgentVersion, reportedDefaultNetworkInterface, dnsChangedScopes, dnsChangedTokenByScope });
    const { rules, dnsWatches, dnsChangedFor, actions, hostInterface, hostTunnels, sniRuntimeView, egressRuntimeView, dnsRuntimeGeneration, responseIssuedAt, forwardProtocolSettings, vlessBridgePorts, addMimicFilter, gostRuntimeApiSection, gostRuntimeExecStart, gostRuntimeSyncCmd, gostServiceName, gostServiceUnit, reportedMimicInterfaces, reportedMimicServicesByInterface, hostIpv6Listen, mimicFiltersByInterface, mimicRequestedWithoutInterface, mimicLifecycleResources, configRevision, buildMimicRuntimeSyncCmds, hostTlsInbounds } = loadHeartbeatRulesResult;
    let { egressRuntimeContext } = loadHeartbeatRulesResult;
    const agentHostRules = rules as any[];
    // DNS 预解析：将域名转换为 IP，缓存中比较检测变更
    const dnsChangedRuleIds = new Set<number>();
    const dnsPreviousIpByRuleId = new Map<number, string>();
    const resolvedTargetGate = createResolvedTargetGate(host as any);
    const resolveHostRuleTargetsResult = await resolveHostRuleTargets({ agentHostRules, dnsWatches, dnsChangedIpByHost, dnsChangedFor, dnsChangedRuleIds, dnsPreviousIpByRuleId, resolvedTargetGate, actions, hostInterface, rules });
    const { getForwardChainGroup } = resolveHostRuleTargetsResult;

    const rawAgentAllRules = await db.getForwardRulesForAgentScope(
      Number(host.id),
      (hostTunnels as any[]).map((tunnel: any) => Number(tunnel.id)),
    );
    egressRuntimeContext = await loadEgressRuntimeContext(rawAgentAllRules as any[], egressRuntimeContext);
    const agentAllRules = (await gateForwardRulesForRuntime(rawAgentAllRules as any[])).map(sniRuntimeView).map(egressRuntimeView);
    const forwardGroupHealthConfigs = await db.getForwardGroupHealthConfigs(([...agentAllRules, ...agentHostRules] as any[])
      .map((rule: any) => Number(rule?.forwardGroupId || 0)));
    const forwardGroupRuntimeConfigById = new Map((forwardGroupHealthConfigs as any[])
      .map((group: any) => [Number(group.id), group]));
    const forwardGroupHealthConfigById = new Map((forwardGroupHealthConfigs as any[])
      .filter((group: any) => runtimeBool(group?.isEnabled) && String(group.groupMode || "failover") === "failover")
      .map((group: any) => [Number(group.id), group]));
    const forwardGroupHealthByRuleId = new Map<number, any>();
    for (const rule of agentAllRules as any[]) {
      const groupId = Number(rule?.forwardGroupId || 0);
      const memberId = Number(rule?.forwardGroupMemberId || 0);
      const group = forwardGroupHealthConfigById.get(groupId) as any;
      if (!group || memberId <= 0 || rule?.isForwardGroupTemplate) continue;
      forwardGroupHealthByRuleId.set(Number(rule.id), {
        groupId,
        memberId,
        failoverSeconds: Math.max(10, Number(group.failoverSeconds || 60)),
        recoverSeconds: Math.max(10, Number(group.recoverSeconds || 120)),
      });
    }
    const hydrateRuntimeTarget = async (rule: any) => {
      if (!rule || !rule.targetIp) return;
      if (!(rule as any)._originalTargetIp) {
        (rule as any)._originalTargetIp = rule.targetIp;
      }
      const rawTargetIp = String((rule as any)._originalTargetIp || rule.targetIp || "").trim();
      if (!rawTargetIp) return;
      const forcedResolved = dnsChangedIpByHost.get(rawTargetIp.toLowerCase());
      const resolved = forcedResolved || await resolveTargetIpCached(Number(rule.id), rawTargetIp);
      if (forcedResolved) expireSharedResolvedIp(Number(rule.id));
      rule.targetIp = resolved;
      if (await resolvedTargetGate(rule, rawTargetIp, resolved)) {
        rule.isEnabled = false;
        (rule as any).resourceAccessDenied = true;
      }
    };
    await mapWithConcurrency(agentAllRules as any[], 32, (rule: any) => hydrateRuntimeTarget(rule));
    const tunnelById = new Map((hostTunnels as any[]).map((t: any) => [t.id, t]));
    const tunnelIds = Array.from(new Set((hostTunnels as any[])
      .map((tunnel: any) => Number(tunnel?.id || 0))
      .filter((id: number) => id > 0)));
    const tunnelHopsByTunnelId = new Map<number, any[]>(tunnelIds.map((id) => [id, []]));
    const tunnelExitNodesByTunnelId = new Map<number, any[]>(tunnelIds.map((id) => [id, []]));
    const [tunnelHopRows, tunnelExitNodeRows] = await Promise.all([
      hopRepo.getTunnelHopsByTunnelIds(tunnelIds),
      hopRepo.getTunnelExitNodesByTunnelIds(tunnelIds),
    ]);
    for (const hop of tunnelHopRows as any[]) {
      const id = Number(hop?.tunnelId || 0);
      if (!tunnelHopsByTunnelId.has(id)) continue;
      tunnelHopsByTunnelId.get(id)!.push(hop);
    }
    for (const id of tunnelIds) {
      if ((tunnelHopsByTunnelId.get(id) || []).length < 2) tunnelHopsByTunnelId.set(id, []);
    }
    for (const node of tunnelExitNodeRows as any[]) {
      const id = Number(node?.tunnelId || 0);
      if (!tunnelExitNodesByTunnelId.has(id)) continue;
      tunnelExitNodesByTunnelId.get(id)!.push(node);
    }
    const tunnelDnsRefreshByTunnelId = new Map<number, number>();
    const changedTunnelDnsRefreshIds = new Set<number>();
    const markTunnelDnsRefresh = (tunnelId: unknown, generation: number, changed: boolean) => {
      const id = Number(tunnelId) || 0;
      if (id <= 0) return;
      if (generation > 0) {
        tunnelDnsRefreshByTunnelId.set(id, Math.max(tunnelDnsRefreshByTunnelId.get(id) || 0, generation));
      }
      if (changed) changedTunnelDnsRefreshIds.add(id);
    };
    for (const tunnel of hostTunnels as any[]) {
      const tunnelId = Number(tunnel?.id || 0);
      const recordTunnelDnsRefresh = (scope: string, refId: unknown) => {
        markTunnelDnsRefresh(tunnelId, dnsRuntimeGeneration(scope, refId), dnsChangedFor(scope, refId));
      };
      if (String(tunnel?.connectHost || "").trim()) {
        recordTunnelDnsRefresh("tunnel-connect", tunnelId);
      } else {
        recordTunnelDnsRefresh("host-entry", Number(tunnel?.exitHostId || 0));
      }
      for (const hop of tunnelHopsByTunnelId.get(Number(tunnel?.id || 0)) || []) {
        if (String((hop as any)?.connectHost || "").trim()) {
          recordTunnelDnsRefresh("tunnel-hop-connect", Number((hop as any)?.id || 0));
        } else {
          recordTunnelDnsRefresh("host-entry", Number((hop as any)?.hostId || 0));
        }
      }
      for (const node of tunnelExitNodesByTunnelId.get(Number(tunnel?.id || 0)) || []) {
        if (String((node as any)?.connectHost || "").trim()) {
          recordTunnelDnsRefresh("tunnel-exit-connect", Number((node as any)?.id || 0));
        } else {
          recordTunnelDnsRefresh("host-entry", Number((node as any)?.hostId || 0));
        }
      }
    }
    const tunnelDnsGeneration = (tunnel: any) => tunnelDnsRefreshByTunnelId.get(Number(tunnel?.id || 0)) || 0;
    const anyTunnelDnsRefresh = (tunnels: any[]) => tunnels.some((tunnel) => changedTunnelDnsRefreshIds.has(Number(tunnel?.id || 0)));
    /*
      走隧道的规则接 Shadowsocks 出口：SS 客户端跑在隧道的出口机上（server/ssEgress 的 tunnelEgressDialHostIdsOf）。
      出口机的 gost 在 127.0.0.1:端口 上起一个本机服务，经 SS 落地去连真正的目标；入口把目标换成 127.0.0.1:这个端口 ——
      NEX 隧道写进握手、GOST 隧道写进 relay 请求，出口拨的就是它自己的这个服务，隧道本身什么都不用改。端口由出口自己分、
      按 server/tunnelExitPorts 报给入口（kind "egress"），和线路组调度器、出口桥守卫同一个机制。

      出口还没报（规则刚建、出口 Agent 太旧、落地失效、撑不起 UDP / SS2022……）时这条规则按停用下发，绝不退回直连：
      退回直连会让流量换一个出口 IP，用户以为在走落地，其实没有。

      停不停用要在下面生成 gostRules 之前定下来；出口机自己的端口要等分完守卫端口才分（见下面 failoverProxyPort 之后那一段）。
    */
    await loadTunnelExitPorts();
    /** 这台是出口机、要在本机跑 SS 客户端的规则。 */
    const tunnelEgressHelpers = new Map<number, TunnelEgressHelper>();
    /** 同一条规则在 agentHostRules / agentAllRules 里是不同的对象，改目标、停用要一起改。 */
    const tunnelEgressRuleObjects = new Map<number, any[]>();
    for (const rule of [...agentHostRules, ...agentAllRules] as any[]) {
      if (!rule || Number(rule.tunnelId || 0) <= 0 || normalizeRuleEgressType(rule.egressType) === "none") continue;
      const list = tunnelEgressRuleObjects.get(Number(rule.id)) || [];
      list.push(rule);
      tunnelEgressRuleObjects.set(Number(rule.id), list);
    }
    validateTunnelEgressRules({ tunnelEgressRuleObjects, tunnelById, tunnelHopsByTunnelId, tunnelExitNodesByTunnelId, host, effectiveAgentVersion, egressRuntimeContext, tunnelEgressHelpers });
    const dnsRuntimeRefreshToken = dnsChangedReports.length > 0
      ? `${responseIssuedAt}:${Array.from(dnsChangedScopes).sort().join(",") || Array.from(dnsChangedIpByHost.keys()).sort().join(",")}`
      : "";
    const dnsRuntimeRefreshCmd = (label: string) => (
      dnsRuntimeRefreshToken ? `echo ${shQuote(`[dns] ${label} refresh ${dnsRuntimeRefreshToken}`)}` : ""
    );
    const tunnelRuntimeGenerationCmd = () => {
      const tokens = (hostTunnels as any[])
        .map((tunnel: any) => {
          const tunnelId = Number(tunnel?.id || 0);
          const generation = getTunnelRuntimeGeneration(tunnelId);
          return tunnelId > 0 && generation > 0 ? `${tunnelId}:${generation}` : "";
        })
        .filter(Boolean)
        .sort()
        .join(",");
      return tokens ? `echo ${shQuote(`[runtime] tunnel generation ${tokens}`)}` : "";
    };
    const tunnelEntryHostIdsByTunnelId = new Map<number, number[]>();
    // 多条隧道常挂在同一个入口组上；按组 id 合并成一次取组（存 Promise，
    // 下面是 Promise.all 并发跑的，存结果挡不住同时发出的重复查询）。
    const tunnelEntryGroupPromiseById = new Map<number, Promise<any>>();
    await Promise.all((hostTunnels as any[]).map(async (tunnel: any) => {
      const entryHostIds = new Set<number>();
      const primaryEntryHostId = Number(tunnel?.entryHostId || 0);
      if (Number.isFinite(primaryEntryHostId) && primaryEntryHostId > 0) entryHostIds.add(primaryEntryHostId);
      const entryGroupId = Number(tunnel?.entryGroupId || 0);
      if (entryGroupId > 0) {
        let entryGroupPending = tunnelEntryGroupPromiseById.get(entryGroupId);
        if (!entryGroupPending) {
          entryGroupPending = db.getForwardGroupById(entryGroupId);
          tunnelEntryGroupPromiseById.set(entryGroupId, entryGroupPending);
        }
        const entryGroup = await entryGroupPending as any;
        if (entryGroup && runtimeBool(entryGroup.isEnabled) && String(entryGroup.groupMode || "") === "entry") {
          for (const member of entryGroup.members || []) {
            if (!member || !runtimeBool(member.isEnabled, true) || member.memberType !== "host") continue;
            const memberHostId = Number(member.hostId || 0);
            if (Number.isFinite(memberHostId) && memberHostId > 0) entryHostIds.add(memberHostId);
          }
        }
      }
      tunnelEntryHostIdsByTunnelId.set(Number(tunnel.id), Array.from(entryHostIds));
    }));
    const tunnelEntryHostIds = (tunnel: any) => {
      const tunnelId = Number(tunnel?.id || 0);
      const cached = tunnelEntryHostIdsByTunnelId.get(tunnelId);
      // 空数组是「入口组里的入口全被流量故障转移暂停了」，不能再退回到保存着的主入口。
      if (cached) return cached;
      const entryHostId = Number(tunnel?.entryHostId || 0);
      return Number.isFinite(entryHostId) && entryHostId > 0 ? [entryHostId] : [];
    };
    const isCurrentHostTunnelEntry = (tunnel: any) => tunnelEntryHostIds(tunnel).includes(Number(host.id));
    const allTunnelRuleIds = agentAllRules
      .filter((rule: any) => rule && rule.forwardType === "gost" && Number(rule.tunnelId || 0) > 0)
      .map((rule: any) => Number(rule.id))
      .filter((id: number) => Number.isFinite(id) && id > 0);
    const allTunnelRuleExitRows = await db.getForwardRuleTunnelExitsByRuleIds(allTunnelRuleIds);
    const tunnelExitRowsByRuleId = new Map<number, any[]>();
    for (const row of allTunnelRuleExitRows as any[]) {
      const ruleId = Number(row.ruleId);
      const rows = tunnelExitRowsByRuleId.get(ruleId) || [];
      rows.push(row);
      tunnelExitRowsByRuleId.set(ruleId, rows);
    }
    const isForwardXTunnel = isForwardXTunnelMode;
    const tunnelNeedsMimic = (tunnel: any) => {
      if (!tunnel || !isForwardXTunnel(tunnel) || !runtimeBool(tunnel.isEnabled) || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return false;
      // V2 carries every tunnel protocol inside its WireGuard UDP socket. Its
      // Mimic decision must not depend on a separate UDP rule being present.
      if (isForwardXWireGuardV2(tunnel)) return runtimeBool((tunnel as any).udpOverTcp);
      return (agentAllRules as any[]).some((rule: any) => {
        if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || rule.forwardType !== "gost") return false;
        if (Number(rule.tunnelId || 0) !== Number(tunnel.id || 0)) return false;
        return udpOverTcpEnabled(rule, tunnel) && isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel);
      });
    };
    for (const tunnel of hostTunnels as any[]) {
      if (!tunnelNeedsMimic(tunnel) && !isForwardXWireGuardV2(tunnel)) continue;
      try {
        const ensured = await hopRepo.ensureForwardXMimicPorts(
          tunnel,
          tunnelHopsByTunnelId.get(Number(tunnel.id)) || [],
          tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [],
        );
        Object.assign(tunnel, ensured.tunnel);
        if (Array.isArray(ensured.hops) && ensured.hops.length > 0) {
          tunnelHopsByTunnelId.set(Number(tunnel.id), ensured.hops);
        }
        if (Array.isArray(ensured.exitNodes) && ensured.exitNodes.length > 0) {
          tunnelExitNodesByTunnelId.set(Number(tunnel.id), ensured.exitNodes);
        }
        if (ensured.changed) {
          appendPanelLog("info", `[Tunnel] allocated dedicated UDP transport ports for NEX tunnel=${tunnel.id}`);
        }
      } catch (error) {
        appendPanelLog("error", `[Tunnel] failed to allocate dedicated UDP transport port tunnel=${tunnel.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const rule of agentAllRules as any[]) {
      if (!rule || rule.forwardType !== "gost" || !rule.tunnelId || runtimeBool(rule.pendingDelete)) continue;
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      if (!tunnel || String(tunnel?.mode || "").toLowerCase() === "forwardx" || !runtimeBool((tunnel as any).loadBalanceEnabled)) continue;
      const extraNodes = tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [];
      const rows = tunnelExitRowsByRuleId.get(Number(rule.id)) || [];
      if (!tunnelExitRowsMatchNodes(rows, extraNodes)) {
        const nextRows = await db.reconcileForwardRuleTunnelExits(rule, tunnel);
        tunnelExitRowsByRuleId.set(Number(rule.id), nextRows as any[]);
      }
    }
    /*
      主机流量故障转移（上游 v2.3.281，见 shared/hostTrafficPolicy.ts）：端口分配、出口映射都排好之后
      再按暂停名单改运行时副本 —— 下面每一处改的都是这次心跳里的对象，保存着的成员、端口、
      开关一样不动，流量重置后下一次心跳自然回到原样。
    */
    const trafficExcludedHosts = await getTrafficExcludedHostIds();
    // 线路组路径的「此刻不该走」提示要读每台机器在不在线、在不在维护（十秒快照）。
    await ensureRouteNodeHealthFresh();
    await blockRulesForTrafficExcludedHosts({ trafficExcludedHosts, agentHostRules, agentAllRules, tunnelById, tunnelHopsByTunnelId, hostTunnels, tunnelExitNodesByTunnelId, tunnelEntryHostIdsByTunnelId, host, actions, tunnelExitRowsByRuleId });
    // realm/socat/gost 进程命令使用原始 targetIp（域名形式），以便工具自身解析 DNS，
    // iptables/nftables/计数链使用已解析的 IP（rule.targetIp 已被替换为解析后的值）。
    const processTarget = (rule: any) => (rule as any)._originalTargetIp || rule.targetIp;
    const forwardXUDPTargets = (tunnel: any) => {
      if (!tunnel || !isForwardXTunnel(tunnel) || !runtimeBool(tunnel.isEnabled) || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) {
        return [] as Array<{ ruleId: number; targetIp: string; targetPort: number }>;
      }
      const targets = new Map<number, { ruleId: number; targetIp: string; targetPort: number }>();
      for (const rule of agentAllRules as any[]) {
        if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || rule.forwardType !== "gost") continue;
        if (Number(rule.tunnelId || 0) !== Number(tunnel.id || 0)) continue;
        if (!isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel) || !isForwardRuleProtocolUdpEnabled(rule.protocol)) continue;
        const ruleId = Number(rule.id || 0);
        // The heartbeat resolver already preserves the last known-good IP and
        // dnsGeneration restarts FXP when it changes. Passing that IP avoids a
        // blocking DNS lookup in the shared UDP receive loop for every session.
        let targetIp = forwardXUDPTargetAddress(rule);
        let targetPort = Number(rule.targetPort || 0);
        if (rule.failoverEnabled) {
          /*
            线路组：这台出口跑着调度器就交给它（本机），没跑（出口 Agent 早于 2.2.199）就拨路径 A，
            和入口给 TCP 的目标一个口径（failoverTargetEndpoint）。路径 A 就是规则自己的目标时
            照旧用解析好的 IP。
          */
          const scheduler = forwardXSchedulerFailover(rule, tunnel);
          const primary = scheduler ? null : routePrimaryEndpoint(rule);
          if (scheduler) {
            targetIp = "127.0.0.1";
            targetPort = Number(scheduler.listenPort);
          } else if (primary && (primary.targetIp !== processTarget(rule) || Number(primary.targetPort) !== targetPort)) {
            targetIp = String(primary.targetIp || "").trim();
            targetPort = Number(primary.targetPort || 0);
          }
        }
        if (!Number.isInteger(ruleId) || ruleId <= 0 || !targetIp || !Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) continue;
        targets.set(ruleId, { ruleId, targetIp, targetPort });
      }
      return Array.from(targets.values()).sort((a, b) => a.ruleId - b.ruleId);
    };
    /*
      出口的 TCP 目标表（streamTargets）：FXP 出口只拨表里的目标，hello 里别的一律拒（见
      forwardx-fxp/exit_targets.go），免得拿到隧道密钥的人把出口当开放代理。和入口写进 hello 的
      一个口径（tunnelExitSchedulerEndpoint）：规则目标（域名原样、解析出的 IP 都放）、线路组的
      路径 A，这台出口跑着调度器时再加本机调度器。走 TCP 的 UDP（UDP over TCP）拨的也是这个目标，
      所以不按协议筛。
    */
    const forwardXStreamTargets = (tunnel: any) => {
      type StreamTarget = { ruleId: number; targetIp: string; targetPort: number };
      if (!tunnel || !isForwardXTunnel(tunnel) || !runtimeBool(tunnel.isEnabled) || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) {
        return [] as StreamTarget[];
      }
      const targets = new Map<string, StreamTarget>();
      const add = (ruleId: number, targetIp: unknown, targetPort: unknown) => {
        const ip = String(targetIp || "").trim();
        const port = Number(targetPort || 0);
        if (!ip || !Number.isInteger(port) || port <= 0 || port > 65535) return;
        targets.set(`${ruleId}|${ip}|${port}`, { ruleId, targetIp: ip, targetPort: port });
      };
      for (const rule of agentAllRules as any[]) {
        if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || rule.forwardType !== "gost") continue;
        if (Number(rule.tunnelId || 0) !== Number(tunnel.id || 0)) continue;
        if (!isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) continue;
        const ruleId = Number(rule.id || 0);
        if (!Number.isInteger(ruleId) || ruleId <= 0) continue;
        add(ruleId, processTarget(rule), rule.targetPort);
        add(ruleId, rule.targetIp, rule.targetPort);
        const primary = routePrimaryEndpoint(rule);
        add(ruleId, primary.targetIp, primary.targetPort);
        const scheduler = forwardXSchedulerFailover(rule, tunnel);
        if (scheduler) add(ruleId, "127.0.0.1", scheduler.listenPort);
      }
      return Array.from(targets.values()).sort((a, b) => a.ruleId - b.ruleId
        || a.targetIp.localeCompare(b.targetIp)
        || a.targetPort - b.targetPort);
    };
    const forwardXUDPTargetsChanged = (tunnel: any, targets: unknown) => {
      const key = `${Number(host.id)}:${Number(tunnel?.id || 0)}`;
      const signature = stableStateSignature(targets);
      if (fxpUdpTargetSignatureCache.get(key) === signature) return false;
      setBoundedMapValue(fxpUdpTargetSignatureCache, key, signature, AGENT_DYNAMIC_CACHE_MAX);
      return true;
    };
    const proxyDebugBool = (value: unknown) => value ? "true" : "false";
    const buildProxyRuleDebugCmd = (label: string, rule: any, extra: Record<string, unknown> = {}) => {
      const fields: Record<string, unknown> = {
        rule: Number(rule?.id || 0),
        host: Number(host.id),
        tunnel: Number(rule?.tunnelId || 0),
        source: Number(rule?.sourcePort || 0),
        ruleTargetRaw: String((rule as any)?._originalTargetIp || rule?.targetIp || ""),
        ruleTargetRuntime: String(rule?.targetIp || ""),
        runtimeTarget: `${processTarget(rule)}:${Number(rule?.targetPort || 0)}`,
        protocol: String(rule?.protocol || ""),
        proxyVersion: proxyProtocolVersion(rule),
        entryReceive: proxyDebugBool(proxyProtocolEnabled(rule, "entryReceive")),
        entrySend: proxyDebugBool(proxyProtocolEnabled(rule, "entrySend")),
        exitReceive: proxyDebugBool(proxyProtocolEnabled(rule, "exitReceive")),
        exitSend: proxyDebugBool(proxyProtocolEnabled(rule, "exitSend")),
        ...extra,
      };
      const text = Object.entries(fields)
        .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, " ")}`)
        .join(" ");
      return `echo ${shQuote(`proxy-rule-debug ${label} ${text}`)}`;
    };
    const gostRules = agentHostRules
      .filter((r: any) => {
        if (runtimeBool(r.pendingDelete) || !runtimeBool(r.isEnabled) || r.forwardType !== "gost") return false;
        const tunnel = (r as any).tunnelId ? tunnelById.get((r as any).tunnelId) as any : null;
        if (tunnel && isNginxTunnelMode(tunnel)) return false;
        return isRuleProtocolEnabled(forwardProtocolSettings, r, tunnel);
      });
    const rateLimitUserIds = Array.from(new Set([...agentHostRules, ...agentAllRules]
      .map((rule: any) => Number(rule.userId))
      .filter((id: number) => Number.isFinite(id) && id > 0))) as number[];
    const rateLimitUsers = await Promise.all(rateLimitUserIds.map((id) => db.getUserById(id)));
    const rateLimitUserById = new Map(rateLimitUsers.filter(Boolean).map((u: any) => [u.id, u]));
    const gostRateLimiters: any[] = [];
    const gostRateLimiterNames = new Set<string>();
    const ensureGostLimiter = (name: string, inMbps: number, outMbps: number) => {
      const inBytes = mbpsToBytesPerSecond(inMbps);
      const outBytes = mbpsToBytesPerSecond(outMbps);
      if ((inBytes <= 0 && outBytes <= 0) || gostRateLimiterNames.has(name)) return;
      gostRateLimiterNames.add(name);
      gostRateLimiters.push({
        name,
        // gost 限速器：上行（in）/ 下行（out），0 = 这个方向不限。
        limits: [`$ ${inBytes}B ${outBytes}B`],
      });
    };
    /** 这条规则在这台主机上的各级限速（见 shared/forwardRateLimit.ts）。 */
    const rateTiersForRule = (rule: any, tunnel?: any | null) => {
      const userId = Number(rule?.userId || 0);
      const user = rateLimitUserById.get(userId) as any;
      const forwardGroupId = Number(rule?.forwardGroupId || 0);
      const group = forwardGroupRuntimeConfigById.get(forwardGroupId) as any;
      // 流量异常的临时限速叠在规则这一级上，和手动设的取严的那个（server/ops/trafficAnomalyThrottles.ts）。
      const ruleMbps = anomalyAwareRuleMbps(ruleLimitRootId(rule), rule?.rateLimitMbps);
      return buildForwardRateTiers({
        userId,
        hostId: Number(host.id) || 0,
        user: {
          inMbps: user?.gostRateLimitIn,
          outMbps: user?.gostRateLimitOut,
          burstMbps: user?.forwardBurstMbps,
          burstSeconds: user?.forwardBurstSeconds,
        },
        tunnel: { id: tunnel?.id, mbps: tunnel?.rateLimitMbps },
        group: { id: forwardGroupId, mbps: group?.rateLimitMbps },
        // 单条规则限速（server/ruleLimits.ts）：成员规则 / 中转跳按根规则算，同一台机器上共用一个桶。
        rule: { id: ruleLimitRootId(rule), inMbps: ruleMbps, outMbps: ruleMbps },
        hostLimitMbps: (host as any).rateLimitMbps,
      });
    };
    const applyGostLimiter = (service: any, rule: any, tunnel?: any | null) => {
      // gost 自带的限速器只认一对上下行数：每个方向取最严的那一级，同名的规则共用一个桶。
      const limit = strictestForwardRate(rateTiersForRule(rule, tunnel));
      if (limit.inMbps > 0 || limit.outMbps > 0) {
        const name = limit.inMbps === limit.outMbps
          ? `fwx-${limit.scope}-${limit.inMbps}`
          : `fwx-${limit.scope}-${limit.inMbps}-${limit.outMbps}`;
        ensureGostLimiter(name, limit.inMbps, limit.outMbps);
        service.limiter = name;
      }
      return service;
    };
    const ruleRateLimits = (rule: any, tunnel?: any | null) => {
      const tiers = rateTiersForRule(rule, tunnel);
      const limit = strictestForwardRate(tiers);
      return {
        rateLimitScope: limit.scope,
        limitIn: mbpsToBytesPerSecond(limit.inMbps),
        limitOut: mbpsToBytesPerSecond(limit.outMbps),
        rateLimits: forwardRateTiersForAgent(tiers),
      };
    };
    const userAccessLimits = (userId: number) => {
      const user = rateLimitUserById.get(userId) as any;
      return {
        maxConnections: Math.max(0, Number(user?.maxConnections) || 0),
        maxIPs: Math.max(0, Number(user?.maxIPs) || 0),
      };
    };
    const accessScopeForRule = (rule: any) => (
      rule.tunnelId
        ? `u${Number(rule.userId) || 0}_t${Number(rule.tunnelId) || 0}`
        : `u${Number(rule.userId) || 0}_h${host.id}`
    );
    const buildRuleAccessLimitCmds = (rule: any): string[] => (
      rule.tunnelId
        ? buildAccessLimitCmds(rule.sourcePort, accessScopeForRule(rule), userAccessLimits(Number(rule.userId)))
        : buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule))
    );
    const reservedProtocolGuardPorts = new Set<number>();
    const reserveProtocolGuardPort = (value: unknown) => {
      const port = Number(value || 0);
      if (Number.isInteger(port) && port > 0 && port <= 65535) reservedProtocolGuardPorts.add(port);
    };
    for (const port of vlessBridgePorts.ports()) reserveProtocolGuardPort(port);
    for (const rule of agentAllRules as any[]) {
      reserveProtocolGuardPort(rule?.udpOverTcpPort);
      reserveProtocolGuardPort(rule?.gostRelayPort);
      for (const target of parseFailoverTargets(rule?.failoverTargets)) {
        reserveProtocolGuardPort(target.targetPort);
      }
      const tunnel = tunnelById.get(Number(rule?.tunnelId || 0)) as any;
      if (tunnel && Number(tunnel.exitHostId || 0) === Number(host.id)) {
        reserveProtocolGuardPort(rule?.tunnelExitPort);
      }
    }
    for (const rows of tunnelExitRowsByRuleId.values()) {
      for (const row of rows as any[]) {
        if (Number(row?.exitHostId || 0) === Number(host.id)) reserveProtocolGuardPort(row?.tunnelExitPort);
      }
    }
    for (const tunnel of hostTunnels as any[]) {
      if (Number(tunnel?.exitHostId || 0) === Number(host.id)) {
        reserveProtocolGuardPort(tunnel?.listenPort);
        reserveProtocolGuardPort(tunnel?.mimicPort);
      }
      for (const hop of tunnelHopsByTunnelId.get(Number(tunnel?.id || 0)) || []) {
        if (Number(hop?.hostId || 0) !== Number(host.id)) continue;
        reserveProtocolGuardPort(hop?.listenPort);
        reserveProtocolGuardPort(hop?.mimicPort);
      }
      for (const exitNode of tunnelExitNodesByTunnelId.get(Number(tunnel?.id || 0)) || []) {
        if (Number(exitNode?.hostId || 0) !== Number(host.id)) continue;
        reserveProtocolGuardPort(exitNode?.listenPort);
        reserveProtocolGuardPort(exitNode?.mimicPort);
      }
    }
    /*
      GOST 链路负载均衡由入口机的本机代理挑（见 server/gostBalancePlan.ts）：入口机上这条规则的端口后面放本机代理，
      每台出口一个本机 gost 端口（只走那台出口；多跳链路是「中转 → 那台出口」）。TCP、UDP 都这样走。代理按分配方式
      分新连接 / 新 UDP 会话，自己探出口机、自己切；出口到目标不通由出口机的探测经面板给提示，或者真实连接被关
      以后经出口复核。切换不改 gost 配置，正在走的连接不断。

      没有老路可退：gost 自己的节点选择器那条路已经删掉。下面这些情况只下发主出口一台（单节点链）：
        · 这台入口机的 Agent 还不能执行统一调度（agentSupportsUnifiedBalance）—— 链路和规则上标「需要升级 Agent」
          （server/tunnelBalanceAgent.ts）；
        · 规则带线路组、而这台入口机同时又是这条规则的出口之一（两个调度器要同一个本机端口）。
      出口超过 GOST_BALANCE_MAX_EXITS 台时按顺序取前这么多台。

      这里先按粗条件给要的规则分本机端口（出口数），细的条件在下面 gostBalancePlans 里判，判下来不用的端口空着无妨。
    */
    const gostBalanceAgentReady = agentSupportsUnifiedBalance(effectiveAgentVersion);
    const gostBalanceExitCounts = new Map<number, number>();
    type BalanceRuleLite = { id: number; tunnelId?: number | null; forwardType?: string | null; failoverEnabled?: unknown; protocol?: string | null; pendingDelete?: unknown; isEnabled?: unknown };
    type BalanceTunnelLite = { id: number; mode?: string | null; isEnabled?: unknown; entryHostId?: number | null; entryGroupId?: number | null; loadBalanceEnabled?: unknown; loadBalanceStrategy?: string | null; balanceDetect?: string | null; exitHostId?: number | null; balancePinHostId?: number | null };
    if (gostBalanceAgentReady) {
      for (const rule of gostRules as unknown as BalanceRuleLite[]) {
        const tunnel = Number(rule?.tunnelId || 0) > 0 ? tunnelById.get(Number(rule.tunnelId)) as BalanceTunnelLite | undefined : null;
        if (!tunnel || !isGostTunnelMode(tunnel) || !tunnelBalancesExits(tunnel) || !isCurrentHostTunnelEntry(tunnel)) continue;
        const extra = ((tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || []) as Array<{ isEnabled?: unknown; hostId?: number | null }>).filter((node) => runtimeBool(node?.isEnabled, true) && Number(node?.hostId || 0) > 0);
        const count = Math.min(GOST_BALANCE_MAX_EXITS, 1 + extra.length);
        if (count >= 2) gostBalanceExitCounts.set(Number(rule.id), count);
      }
    }
    const protocolGuardPorts = allocateProtocolGuardPorts(
      [...agentAllRules, ...agentHostRules],
      reservedProtocolGuardPorts,
      gostBalanceExitCounts,
    );
    const protocolGuardPortsForRule = (rule: any) => {
      const ruleId = Number(rule?.id || 0);
      const plan = protocolGuardPorts.get(ruleId);
      if (!plan) throw new Error(`Missing protocol guard port plan for rule ${ruleId || "unknown"}`);
      return plan;
    };
    const failoverProxyPort = (rule: any) => protocolGuardPortsForRule(rule).failoverProxyPort;
    /*
      这台出口机上的 Shadowsocks 出口本机服务（见上面 tunnelEgressHelpers）分端口：在守卫、调度器这些端口之后分，
      避开它们和这台机器上规则、隧道用到的端口。优先 45000 + 规则号，被占了往后顺延；分完把本机这份规则的目标换成它。
    */
    if (tunnelEgressHelpers.size > 0) {
      const usedPorts = new Set<number>(reservedProtocolGuardPorts);
      for (const plan of protocolGuardPorts.values()) {
        usedPorts.add(plan.guardListenPort);
        usedPorts.add(plan.failoverProxyPort);
        usedPorts.add(plan.guardBackendPort);
      }
      for (const rule of [...agentAllRules, ...agentHostRules] as any[]) {
        for (const value of [rule?.sourcePort, rule?.targetPort, rule?._tunnelEgressTarget?.port]) {
          const port = Number(value || 0);
          if (Number.isInteger(port) && port > 0) usedPorts.add(port);
        }
      }
      const poolSize = PROTOCOL_GUARD_PORT_MAX - PROTOCOL_GUARD_PORT_MIN + 1;
      for (const helper of Array.from(tunnelEgressHelpers.values()).sort((left, right) => left.ruleId - right.ruleId)) {
        const preferredOffset = 45000 + (helper.ruleId % PROTOCOL_GUARD_LEGACY_SPAN) - PROTOCOL_GUARD_PORT_MIN;
        for (let offset = 0; offset < poolSize; offset += 1) {
          const port = PROTOCOL_GUARD_PORT_MIN + ((preferredOffset + offset) % poolSize);
          if (usedPorts.has(port)) continue;
          usedPorts.add(port);
          helper.port = port;
          break;
        }
        if (helper.port > 0) pointTunnelEgressRule(tunnelEgressRuleObjects.get(helper.ruleId) || [], helper.port);
        else holdTunnelEgressRule(tunnelEgressRuleObjects.get(helper.ruleId) || [], "config_invalid");
      }
    }
    /*
      线路组的调度器跑在哪台机上：直连规则是规则所在的机器，隧道规则是出口（多出口时每个出口各跑
      一个）。隧道规则的入口和出口各自心跳、各自生成配置：入口这边算「出口拨哪儿」时要用出口报上来的
      调度器端口（server/tunnelExitPorts）。
    */
    // 出口报过的调度器、守卫端口（server/tunnelExitPorts）：面板重启后第一次用之前从库里读回来。
    await loadTunnelExitPorts();
    const routeTunnelOf = (rule: any) => (Number(rule?.tunnelId || 0) > 0 ? tunnelById.get(Number(rule.tunnelId)) as any : null);
    /*
      NEX 隧道由出口的 FXP 拨目标：主出口（多跳时是最后一跳），负载均衡开着时还有额外的
      出口节点 —— 和入口分流用的 forwardXExtraExitRoutes 同一个条件（开着负载均衡、分法不是
      none、节点开着、有端口）。每个出口各跑一个调度器。
    */
    const forwardXSchedulerHostIds = (tunnel: any): number[] => {
      const hops = tunnelHopsByTunnelId.get(Number(tunnel?.id || 0));
      const lastHop = Array.isArray(hops) && hops.length >= 2 ? hops[hops.length - 1] as any : null;
      const ids = [Number(tunnel?.exitHostId || 0), Number(lastHop?.hostId || 0)];
      if (runtimeBool(tunnel?.loadBalanceEnabled)) {
        for (const exitNode of tunnelExitNodesByTunnelId.get(Number(tunnel?.id || 0)) || []) {
          if (!runtimeBool((exitNode as any)?.isEnabled, true) || Number((exitNode as any)?.listenPort || 0) <= 0) continue;
          ids.push(Number((exitNode as any)?.hostId || 0));
        }
      }
      return Array.from(new Set(ids.filter((id) => id > 0)));
    };
    /*
      真正跑调度器的机器：直连规则是规则所在的机器；GOST / Nginx 隧道是这条规则实际用到的出口
      （tunnelExitEndpointsForRule：主出口加上开着的负载均衡出口）—— 停用的出口节点、负载均衡关掉后
      还留着的节点不算；NEX 隧道是 forwardXSchedulerHostIds。tunnelExitEndpointsForRule 定义在后面：
      这里只在调用时读，而用到它的地方都在它定义之后。
    */
    const routeSchedulerHostIds = (rule: any): number[] => {
      const tunnel = routeTunnelOf(rule);
      if (!tunnel) return [Number(rule?.hostId || host.id)];
      if (isForwardXTunnel(tunnel)) {
        const ids = forwardXSchedulerHostIds(tunnel);
        return ids.length > 0 ? ids : [Number(rule?.hostId || host.id)];
      }
      const ids = Array.from(new Set(tunnelExitEndpointsForRule(rule, tunnel).map((endpoint) => endpoint.exitHostId).filter((id) => id > 0)));
      return ids.length > 0 ? ids : [Number(tunnel.exitHostId || rule?.hostId || host.id)];
    };
    // 落地是「我的节点」的路径：节点在哪台 NEX 主机上（loadPct 要算那台的负载，server/hostLoad.ts），也是拼规格前一次查齐。
    await ensureLandingNodeHosts([...agentAllRules, ...agentHostRules]
      .filter((rule) => rule?.failoverEnabled)
      .flatMap((rule) => routePathsOf(rule))
      .filter((path) => Number(path.destNodeId || 0) > 0 && !(Number(path.destHostId || 0) > 0))
      .map((path) => Number(path.destNodeId)));
    /*
      「故障切换优先同出口 IP」（2.3.520）：每条路径带上它最后从哪个 IP 出去（exitIp）。落地是 NEX 主机
      （落地池成员）时是那台的出口地址 —— 面板看到的心跳来源，没有就是登记的 IPv4 / IPv6（hostEgressAddress）；落地是
      手填地址、节点地址、规则自己的目标时就是那个地址本身。要用到的落地主机在这里一次查完，查不到就退回落地的拨号地址。
    */
    const routeExitHostIds = new Set<number>();
    for (const rule of [...agentAllRules, ...agentHostRules]) {
      if (!rule?.failoverEnabled) continue;
      for (const path of routePathsOf(rule)) {
        const destHostId = Number(path.destHostId || 0);
        if (destHostId > 0) routeExitHostIds.add(destHostId);
      }
    }
    const routeExitHostById = new Map<number, HostEgressSource>();
    if (routeExitHostIds.size > 0) {
      const rows: HostEgressSource[] = await db.getHostsByIds(Array.from(routeExitHostIds))
        .catch(ignoreErrorWith("AgentHeartbeat route exit hosts", []));
      for (const row of rows) routeExitHostById.set(Number(row.id), row);
    }
    const routeHostEgressIp = (hostId: number) => hostEgressAddress(routeExitHostById.get(hostId) || null);
    /*
      「按访客固定」要让调度器知道访客是谁：规则本来不往目标发 PROXY 头的 gost 端口转发，由面板
      让 gost 专门给调度器加一个头，调度器读完就扔（proxyProtocolStrip）。名单在下面生成 gost
      配置之前填好（要等 shouldUseRuleGuard，见 routeHeaderStripReady）；gost 配置和下发给 Agent
      的规格都按这一份名单，两边必须一致 —— gost 发了头而调度器不扔，目标就会收到一个它不认识的头。
    */
    const routeHeaderStripRuleIds = new Set<number>();
    /** 线路组在这条规则上能不能由 Agent 调度。 */
    const routeSchedulingAllowed = (rule: any) => {
      if (!rule || !rule.failoverEnabled) return false;
      // 调度器插在前面那个用户态转发工具和路径之间；内核转发（iptables / nftables）没有这一步。
      if (!routeGroupForwardTypeSupported(rule.forwardType)) return false;
      if (!rule.tunnelId) {
        const owner = rateLimitUserById.get(Number(rule.userId)) as any;
        if (owner?.role !== "admin") return false;
      }
      return true;
    };
    const actionFailover = (rule: any, options?: { listenPort?: number; bindAddress?: string; proxyDirection?: "send" | "exitSend" | "none" }) => {
      if (!routeSchedulingAllowed(rule)) return undefined;
      const protocol = normalizeForwardRuleProtocol(rule.protocol);
      /*
        线路组（shared/routeGroup）：一条路径对入口 Agent 来说就是一个要拨的地址（dial）。
        没有中转的路径拨落地；有中转的拨第一跳上那条中继规则的入口（server/routeGroups.ts
        解析后写在 routePaths 里）。老规则（routePaths 为空）从 failover* 列推出来，和上一版
        下发的一模一样。

        解析不出来的路径（中转离线、没端口）**照样占一个下标**，只是标成不可用：Agent 那边
        健康、样本、连接都按下标记，少发一条会让后面的全部错位。中转跳探测发现中间断了
        的路径也是这样标（routeHopDownHints）—— 入口 Agent 自己只探得到第一跳。

        钉子、时段表、参数全部从 routePolicyOf 读：它认 routeMode 那几列，也认老列，读法
        只有一份。没钉住时 pinnedIndex 传 null 而不是省略字段：Agent 那边是指针，null 明确
        表示「交回自动」。
      */
      const routeRule = { ...rule, targetIp: processTarget(rule) };
      const group = routeGroupOf(routeRule);
      if (!group || group.paths.length < 2) return undefined;
      const { paths, policy } = group;
      // 中转探测发现中间断了的，加上切换演练里「当成挂了」的那条（server/routeDrill）
      const hints = withRouteDrillHints(Number(rule.id), routeHopDownHints(Number(rule.id), paths));
      // 暂停、维护中、离线、熔断：比中转探测的结论更硬，压过它。
      const nodeHints = routeNodeHints(paths, getRouteNodeStatus);
      const delivery = normalizeRouteDelivery(policy.delivery);
      /*
        分层（每条目标带 tier，Agent 只在最低的、还有健康路径的那一层里挑 / 分，2.2.243 起）只给「聚合 / 复制」：
        那是「主线路那组几条一起分担，备用组只兜底」。整链最优、按权重、按时段时段外择优都得在所有线路里比、
        在所有线路上分 —— 带着分层，Agent 只在主线路里挑，备用线路再快也切不过去、权重也分不到备用上
        （2.3.497 及以前：选了整链最优一直不切）。稳定优先 / 按时段 / 人工指定本来就按顺序走，分不分层一样。
      */
      const tiered = (delivery === "aggregate" || delivery === "replicate") && paths.every((path) => typeof path.tier === "number");
      const strategy = routeDeliveryStrategy(policy, delivery);
      /*
        「落地怎么分」（2.3.501）：一次走一条线路时（主备 / 择优 / 时段 / 人工指定都是 fallback），
        线路选了「一起分」的，每条目标带上第几条线路、落地是哪一个、怎么分 —— Agent 挑出该走的那条之后，在它那条
        线路的几个落地里按这个分新连接。按权重（整组一起分）、聚合 / 复制（分层）不带：那时已经在分了。
      */
      const destSpreadReady = routeDestSpreadReady({ strategy, tiered, paths });
      // 第 N 个目标的第一跳是哪台：入口 Agent 报的第一段延迟就是「进那台机器」的延迟（节点池卡上的毫秒数）。
      noteRouteFirstHops(Number(rule.id), paths.map((path) => (path.hops.length > 0 ? Number(path.hops[0]) : null)));
      // 每条目标的字段（拨号地址、探测、权重、分层、落地怎么分、下游延迟、负载、出口 IP、用不了）
      // 一个文件一种，按注册的顺序拼：server/routeTargetHints/。
      const targets = buildRouteFailoverTargets(paths, {
        ruleId: Number(rule.id),
        routeRule,
        protocol,
        tiered,
        destSpreadReady,
        nodeHints,
        hopHints: hints,
        hostEgressIp: routeHostEgressIp,
      });
      // "none"：前面那一跳根本不发 PROXY 头（Nginx 隧道的出口）。
      const failoverProxyEnabled = options?.proxyDirection === "none" ? false : proxyProtocolEnabled(rule, options?.proxyDirection || "send");
      const stripProxyHeader = !failoverProxyEnabled
        && (options?.proxyDirection || "send") === "send"
        && routeHeaderStripRuleIds.has(Number(rule.id));
      const pin = policy.pin;
      return {
        enabled: true,
        listenPort: Number(options?.listenPort || rule.sourcePort || 0),
        bindAddress: options?.bindAddress || "127.0.0.1",
        // UDP 按会话调度，TCP+UDP 两个都开（Agent 2.2.199 起，上面已经按版本挡过）。
        protocol,
        // 权重负载按它的分法（按权重 / 轮流 / 随机 / 按访客），其余模式都是主备（fallback）。
        // 「按负载」老 Agent 不认（会退成主备），改发「按权重」。
        strategy,
        ...(delivery !== "cold" ? { delivery } : {}),
        targets,
        failoverSeconds: policy.failoverSeconds,
        recoverSeconds: policy.recoverSeconds,
        autoFailback: policy.autoFailback,
        // 时段表在 Agent 本地判定：面板挂了、网络断了，晚高峰照样得切。
        schedule: policy.schedule || undefined,
        minHoldSeconds: policy.minHoldSeconds,
        pinnedIndex: pin ? pin.index : null,
        pinnedUntil: pin?.untilMs ?? 0,
        preferFastest: policy.mode === "smart" || policy.mode === "hybrid",
        // 2.2.198 起的切换保护和计划切换预检；老 Agent 不认这几个字段，照老规矩切。
        failureThreshold: policy.failureThreshold,
        scoreHoldSeconds: policy.scoreHoldSeconds,
        prewarmSeconds: policy.prewarmSeconds,
        switchMode: policy.switchMode,
        // The local failover process is another hop and must preserve the header
        // generated by either the entry side or the tunnel exit bridge.
        // 头在的时候「按访客固定」从头里读访客地址（Agent 2.2.199 起）；strip 表示这个头是面板
        // 专门加给调度器的，读完就扔（见 routeHeaderStripRuleIds）。
        proxyProtocolReceive: failoverProxyEnabled || stripProxyHeader,
        ...(stripProxyHeader ? { proxyProtocolStrip: true } : {}),
        proxyProtocolSend: failoverProxyEnabled,
        proxyProtocolVersion: proxyProtocolVersion(rule),
      };
    };
    /*
      调度器下发不了（UDP 规则或 NEX 隧道，而调度所在机器的 Agent 还没到 2.2.199）时，前面的转发工具拨主线路
      （路径 A）的拨号地址。直接拨规则目标的话，路径 A 带中转时流量会绕过中转直奔落地 —— 用户
      配中转多半就是因为直连不通。不是线路组、或者路径 A 解析不出来，才退回规则目标（老行为）。
    */
    const routePrimaryEndpoint = (rule: any) => {
      const fallback = { targetIp: processTarget(rule), targetPort: Number(rule.targetPort) };
      if (!routeSchedulingAllowed(rule)) return fallback;
      const routeRule = { ...rule, targetIp: processTarget(rule) };
      const primary = routeGroupOf(routeRule)?.paths[0];
      const dial = primary ? routePathDial(primary, routeRule) : null;
      return dial ? { targetIp: dial.ip, targetPort: Number(dial.port) } : fallback;
    };
    const failoverTargetEndpoint = (rule: any, proxyDirection: "send" | "exitSend" = "send") => {
      const failover = actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1", proxyDirection });
      return failover
        ? { targetIp: "127.0.0.1", targetPort: Number(failover.listenPort) }
        : routePrimaryEndpoint(rule);
    };
    const failoverTargetAddr = (rule: any, proxyDirection: "send" | "exitSend" = "send") => {
      const endpoint = failoverTargetEndpoint(rule, proxyDirection);
      return endpointHostPort(endpoint.targetIp, endpoint.targetPort);
    };
    /*
      隧道入口让出口拨的调度器（GOST 隧道写进 relay 请求，NEX 隧道写进握手）。调度器跑在出口上，
      端口是出口按它自己的规则集分的，不一定等于入口这边算的：按出口报的填（server/tunnelExitPorts）。
      几个出口分到的不一样时，一个目标满足不了所有出口，这条规则退回路径 A（不调度，流量照样通）。
    */
    const tunnelExitPortWarnedRuleIds = new Set<number>();
    const tunnelExitSchedulerEndpoint = (rule: any) => {
      const failover = actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1", proxyDirection: "exitSend" });
      if (!failover) return routePrimaryEndpoint(rule);
      const ruleId = Number(rule.id);
      const exitHostIds = routeSchedulerHostIds(rule);
      /*
        出口还没报这条规则：规则刚建、出口还没重算时先拨路径 A（whenRuleMissing: "none"），出口一次
        都没报过（刚升级）时按本机算的。两种都催出口来一次心跳，它报上来端口不一样会推回入口。
      */
      const pending = exitHostIds.filter((exitHostId) => exitHostId !== Number(host.id) && !hasTunnelExitPort(exitHostId, "scheduler", ruleId));
      for (const exitHostId of pending) {
        if (claimTunnelExitReportRequest(exitHostId)) pushAgentRefresh(exitHostId, "tunnel-exit-ports-needed");
      }
      const port = tunnelExitPortFor("scheduler", ruleId, exitHostIds, Number(failover.listenPort), { selfHostId: Number(host.id), whenRuleMissing: "none" });
      if (port) return { targetIp: "127.0.0.1", targetPort: port };
      if (pending.length === 0 && !tunnelExitPortWarnedRuleIds.has(ruleId)) {
        tunnelExitPortWarnedRuleIds.add(ruleId);
        appendPanelLog("warn", `[RouteGroup] tunnel exits run the scheduler on different ports; entry dials path A rule=${ruleId} exits=${exitHostIds.join(",")}`);
      }
      return routePrimaryEndpoint(rule);
    };
    const failoverForCurrentHost = (rule: any, tunnel?: any | null, options?: { listenPort?: number }) => {
      // GOST 链路负载均衡：入口本机代理（gostBalancePlans，在下面算好；这里用到的时候已经有了）
      const balance = tunnel ? gostBalancePlans.get(Number(rule?.id || 0)) : undefined;
      if (balance) return balance.spec;
      if (!rule?.failoverEnabled) return undefined;
      const listenPort = Number(options?.listenPort || failoverProxyPort(rule));
      if (!tunnel) return actionFailover(rule, { listenPort, bindAddress: "127.0.0.1" });
      /*
        NEX 隧道的调度器不在入口：FXP 的出口拨的是入口握手里给的目标，调度器只能在出口机上
        （forwardXSchedulerFailover，出口机收到一条只跑调度器的运行规则）。上一版把它开在入口、
        又让入口把 127.0.0.1 当目标发给出口，出口拨的是它自己的本机 —— 那里什么都没有。
      */
      if (isForwardXTunnel(tunnel)) return undefined;
      if (isGostTunnelMode(tunnel) && isCurrentHostTunnelExitForRule(rule, tunnel)) {
        return actionFailover(rule, { listenPort, bindAddress: "127.0.0.1", proxyDirection: "exitSend" });
      }
      // Nginx 隧道：出口的 nginx 拨本机的调度器（见下面生成 fwx_texit_* upstream 的地方）。出口不发 PROXY 头。
      if (isNginxTunnelMode(tunnel) && isCurrentHostTunnelExitForRule(rule, tunnel)) {
        return actionFailover(rule, { listenPort, bindAddress: "127.0.0.1", proxyDirection: "none" });
      }
      return undefined;
    };
    /*
      NEX 隧道在这台出口机上的调度规格（这台是 forwardXSchedulerHostIds 之一时）。FXP 出口
      按入口握手里的 exitSend 给目标发 PROXY 头：发的话调度器原样转，按访客固定从头里读访客。
      入口按出口报上来的端口当目标（tunnelExitSchedulerEndpoint），出口的 UDP 目标表
      （forwardXUDPTargets）也指到这里。
    */
    const forwardXSchedulerFailover = (rule: any, tunnel: any) => {
      if (!rule?.failoverEnabled || !tunnel || !isForwardXTunnel(tunnel)) return undefined;
      if (!forwardXSchedulerHostIds(tunnel).includes(Number(host.id))) return undefined;
      return actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1", proxyDirection: "exitSend" });
    };
    const proxyProtocolOptions = (rule: any) => resolveRuleProxyProtocolOptions(
      rule,
      Number(rule?.tunnelId || 0) > 0 ? tunnelById.get(Number(rule.tunnelId)) : null,
    );
    const proxyProtocolEnabled = (rule: any, direction: "receive" | "send" | "entryReceive" | "entrySend" | "exitReceive" | "exitSend") => {
      const options = proxyProtocolOptions(rule);
      if (direction === "receive" || direction === "entryReceive") return options.proxyProtocolReceive;
      if (direction === "send" || direction === "entrySend") return options.proxyProtocolSend;
      if (direction === "exitReceive") return options.proxyProtocolExitReceive;
      return options.proxyProtocolExitSend;
    };
    const proxyProtocolVersion = (rule: any) => proxyProtocolOptions(rule).proxyProtocolVersion;
    const maybeProxyProtocolMetadata = (rule: any, direction: "receive" | "send" | "entryReceive" | "entrySend" | "exitReceive" | "exitSend") => (
      proxyProtocolEnabled(rule, direction) ? gostProxyProtocolMetadata(proxyProtocolVersion(rule)) : undefined
    );
    const tunnelProxyProtocolPlan = (rule: any) => gostTunnelProxyProtocolPlan({
      entryReceive: proxyProtocolEnabled(rule, "entryReceive"),
      entrySend: proxyProtocolEnabled(rule, "entrySend"),
      exitReceive: proxyProtocolEnabled(rule, "exitReceive"),
      exitSend: proxyProtocolEnabled(rule, "exitSend"),
      version: proxyProtocolVersion(rule),
    });
    const tunnelForwardProtos = (protocol: string) => forwardRuleProtocols(protocol);
    const hostPublicAddress = (hostLike: any) => {
      const value = hostIngressAddress(hostLike);
      addDnsWatch(dnsWatches, value, "host-entry", Number(hostLike?.id || 0));
      return value;
    };
    // 隧道出口 / 中转 / 额外出口的拨号地址都要按 hostId 取主机，而同一次心跳里
    // 一台出口机会被几十条规则、WG 拓扑、relay 计划反复问到。这里按 hostId 记住
    // 取主机的 Promise（只活在这一次请求里，不跨请求，读到的仍是本次心跳的库状态），
    // 同一台机器整趟心跳只打一次库；存 Promise 而不是结果，是为了并发的调用也能合并。
    const tunnelDialHostPromiseById = new Map<number, Promise<any>>();
    const buildDialAddressHelpersResult = buildDialAddressHelpers({ tunnelDialHostPromiseById, dnsWatches, host, hostTunnels, agentHostRules, agentAllRules, forwardProtocolSettings, tunnelById, tunnelHopsByTunnelId, tunnelExitNodesByTunnelId, hostPublicAddress });
    const { heartbeatCtx, getExtraExitDialAddress, getHopDialAddress, tunnelExitHostAddress, tunnelExitEndpointById, getTunnelDialHost } = buildDialAddressHelpersResult;
    const {
      getCurrentHostForwardXWireGuardPlan,
      getForwardXWireGuardPlans,
    } = createForwardXWireGuardPlanner(heartbeatCtx, {
      getExtraExitDialAddress,
      getHopDialAddress,
      tunnelDnsGeneration,
      tunnelEntryHostIds,
      tunnelExitHostAddress,
      tunnelNeedsMimic,
    });
    // 自动模式的提示值：这台主机上每条隧道学到过的限速点（FXP 报上来记在面板里的）。
    let linkShapingHintsPromise: Promise<Map<number, { up: number; down: number }>> | null = null;
    const linkShapingHints = () => {
      if (!linkShapingHintsPromise) {
        linkShapingHintsPromise = db.tunnelLinkShapingHintsByHost(Number(host.id)).catch(() => new Map());
      }
      return linkShapingHintsPromise;
    };
    // 主机公网出口整形的提示值：这台机器学到过的公网带宽上限。
    let egressHintPromise: Promise<number> | null = null;
    const egressHint = () => {
      if (!egressHintPromise) {
        egressHintPromise = db.hostEgressShapingHint(Number(host.id)).catch(ignoreErrorWith("AgentHeartbeat egress hint", 0));
      }
      return egressHintPromise;
    };
    const buildForwardXTransportHelpersResult = buildForwardXTransportHelpers({ linkShapingHints, host, egressHint, getCurrentHostForwardXWireGuardPlan, tunnelExitRowsByRuleId });
    const { tunnelRuleExitMappings, applyForwardXTransport } = buildForwardXTransportHelpersResult;
    const primaryManagedTunnelRuleIdByTunnelId = new Map<number, number>();
    for (const rule of agentAllRules as any[]) {
      const tunnelId = Number((rule as any)?.tunnelId || 0);
      if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || rule.forwardType !== "gost" || tunnelId <= 0) continue;
      const tunnel = tunnelById.get(tunnelId) as any;
      if (!tunnel || (!isGostTunnelMode(tunnel) && !isNginxTunnelMode(tunnel)) || !runtimeBool(tunnel.isEnabled)) continue;
      if (!isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) continue;
      if (!isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) continue;
      const ruleId = Number((rule as any).id || 0);
      const current = primaryManagedTunnelRuleIdByTunnelId.get(tunnelId) || 0;
      if (ruleId > 0 && (!current || ruleId < current)) {
        primaryManagedTunnelRuleIdByTunnelId.set(tunnelId, ruleId);
      }
    }
    const useConfiguredTunnelListenPortsForRule = (rule: any, tunnel: any) => (
      !!rule
      && !!tunnel
      && Number(primaryManagedTunnelRuleIdByTunnelId.get(Number((tunnel as any).id || 0)) || 0) === Number((rule as any).id || 0)
    );
    const tunnelExtraExitNodes = (tunnel: any) => (
      runtimeBool((tunnel as any)?.loadBalanceEnabled)
        ? (tunnelExitNodesByTunnelId.get(Number(tunnel?.id || 0)) || [])
        : []
    )
      .filter((node: any) => node && runtimeBool((node as any).isEnabled, true) && Number((node as any).hostId) > 0 && Number((node as any).listenPort) > 0)
      .sort((a: any, b: any) => Number((a as any).seq || 0) - Number((b as any).seq || 0));
    const tunnelExitEndpointsForRule = (rule: any, tunnel: any) => {
      if (!tunnel || (!isGostTunnelMode(tunnel) && !isNginxTunnelMode(tunnel))) return [];
      const useConfiguredPorts = useConfiguredTunnelListenPortsForRule(rule, tunnel);
      const endpoints: Array<{ exitNodeId: number; exitSeq: number; exitHostId: number; listenPort: number; rulePort: number; primary: boolean; node?: any }> = [];
      const primaryListenPort = useConfiguredPorts ? Number((tunnel as any).listenPort || 0) : Number((rule as any).tunnelExitPort || 0);
      const primaryRulePort = Number((rule as any).tunnelExitPort || 0);
      if (Number((tunnel as any).exitHostId) > 0 && primaryListenPort > 0) {
        endpoints.push({
          exitNodeId: 0,
          exitSeq: 0,
          exitHostId: Number((tunnel as any).exitHostId),
          listenPort: primaryListenPort,
          rulePort: primaryRulePort,
          primary: true,
        });
      }
      const mappingByNodeId = new Map(tunnelRuleExitMappings(rule).map((row) => [Number(row.exitNodeId), row]));
      for (const node of tunnelExtraExitNodes(tunnel)) {
        const nodeId = Number((node as any).id || 0);
        const mapping = mappingByNodeId.get(nodeId);
        const listenPort = useConfiguredPorts ? Number((node as any).listenPort || 0) : Number(mapping?.tunnelExitPort || 0);
        const exitHostId = Number((node as any).hostId || mapping?.exitHostId || 0);
        if (nodeId <= 0 || exitHostId <= 0 || listenPort <= 0) continue;
        endpoints.push({
          exitNodeId: nodeId,
          exitSeq: Number((node as any).seq || mapping?.exitSeq || 0),
          exitHostId,
          listenPort,
          rulePort: Number(mapping?.tunnelExitPort || 0),
          primary: false,
          node,
        });
      }
      return endpoints;
    };
    const isCurrentHostTunnelExitForRule = (rule: any, tunnel: any) => {
      if (!tunnel || (!isGostTunnelMode(tunnel) && !isNginxTunnelMode(tunnel))) return false;
      return tunnelExitEndpointsForRule(rule, tunnel).some((endpoint) => endpoint.exitHostId === Number(host.id));
    };
    const currentHostTunnelExitPortsForRule = (rule: any, tunnel: any) => {
      const ports = tunnelExitEndpointsForRule(rule, tunnel)
        .filter((endpoint) => endpoint.exitHostId === Number(host.id) && endpoint.listenPort > 0)
        .map((endpoint) => endpoint.listenPort);
      return Array.from(new Set(ports));
    };
    const forwardXExtraExitRoutes = async (tunnel: any) => {
      const routes: Array<{ hostId: number; host: string; port: number; udpPort: number; key: string }> = [];
      if (!runtimeBool((tunnel as any).loadBalanceEnabled)) return routes;
      const extraNodes = tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [];
      for (const exitNode of extraNodes as any[]) {
        if (!runtimeBool((exitNode as any).isEnabled, true)) continue;
        const port = Number((exitNode as any).listenPort || 0);
        if (port <= 0) continue;
        const exitHost = await getExtraExitDialAddress(exitNode, tunnel);
        if (!exitHost) continue;
        routes.push({ hostId: Number((exitNode as any).hostId || 0), host: exitHost, port, udpPort: Number((exitNode as any).mimicPort || 0), key: tunnelSecretSeed(tunnel) });
      }
      return routes;
    };
    const {
      buildForwardXHopSpec,
    } = createForwardXHopSpecBuilder({
      addMimicFilter,
      applyForwardXTransport,
      // 这几个在下面才声明：转调一层，真正调用时才读，和原来闭包的时机一样。
      exitCapacitiesForHostIds: (strategy: unknown, hostIds: number[]) => exitCapacitiesForHostIds(strategy, hostIds),
      exitWeightsForHostIds: (strategy: unknown, hostIds: number[]) => exitWeightsForHostIds(strategy, hostIds),
      exitIpsForHostIds: (hostIds: number[]) => exitIpsForHostIds(hostIds),
      forwardXExtraExitRoutes,
      getHopDialAddress,
      hostInterface,
      tunnelDnsGeneration,
      tunnelNeedsMimic,
    });
    const forwardXEntryRoute = async (tunnel: any) => {
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      if (Array.isArray(hops) && hops.length >= 2) {
        const nextHop = hops[1] as any;
        return {
          hostId: Number(nextHop?.hostId || 0),
          host: String(await getHopDialAddress(nextHop, tunnel)).trim(),
          port: Number(nextHop?.listenPort) || 0,
          udpPort: Number(nextHop?.mimicPort || 0),
          key: fxpHopKey(tunnel, nextHop, 1),
        };
      }
      const endpoint = tunnelExitEndpointById.get(tunnel.id);
      return {
        hostId: Number(tunnel.exitHostId || 0),
        host: String(endpoint?.host || await tunnelExitHostAddress(tunnel)).trim(),
        port: Number(endpoint?.port || tunnel.listenPort) || 0,
        udpPort: Number((endpoint as any)?.udpPort || (tunnel as any).mimicPort || 0),
        key: tunnelSecretSeed(tunnel),
      };
    };
    // 出口组「按权重」：每个出口主机的线路带宽，一次心跳里同一台只查一次。
    const exitBandwidthCache = new Map<number, number>();
    const buildExitSelectionHelpersResult = buildExitSelectionHelpers({ exitBandwidthCache });
    const { exitCapacitiesForHostIds, exitWeightsForHostIds, exitIpsForHostIds, exitBandwidthsForHostIds, pinnedExitHostId, exitTargetStatusForHostIds } = buildExitSelectionHelpersResult;
    const buildMimicFilterHelpersResult = buildMimicFilterHelpers({ tunnelHopsByTunnelId, getHopDialAddress, forwardXEntryRoute, forwardXExtraExitRoutes, addMimicFilter, hostInterface, forwardProtocolSettings, host, tunnelExitNodesByTunnelId, isCurrentHostTunnelEntry });
    const { addMimicLocalFilterForPort, collectMimicFiltersForRule, forwardXEntryRoutes, addMimicRemoteFilterForRoutes } = buildMimicFilterHelpersResult;
    // WireGuard V2 always transports the tunnel through its own UDP socket.
    // Build Mimic filters from the actual peer plan so enabling Mimic does not
    // depend on a separate UDP forwarding rule being present or running.
    for (const tunnel of hostTunnels as any[]) {
      if (!isForwardXWireGuardV2(tunnel) || !tunnelNeedsMimic(tunnel)) continue;
      const plan = await getCurrentHostForwardXWireGuardPlan(tunnel);
      if (!plan) continue;
      for (const filter of buildForwardXWireGuardMimicFilters(plan)) {
        addMimicFilter(filter, hostInterface, [{ resourceType: "tunnel", resourceId: Number(tunnel.id) }]);
      }
    }
    for (const tunnel of hostTunnels as any[]) {
      if (isCurrentHostTunnelEntry(tunnel) && runtimeBool(tunnel.isEnabled) && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) {
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        const nextHop = Array.isArray(hops) && hops.length >= 2 ? (hops[1] as any) : null;
        tunnelExitEndpointById.set(tunnel.id, {
          host: nextHop ? await getHopDialAddress(nextHop, tunnel) : await tunnelExitHostAddress(tunnel),
          port: nextHop ? Number(nextHop.listenPort) : Number(tunnel.listenPort),
          udpPort: nextHop ? Number(nextHop.mimicPort || 0) : Number((tunnel as any).mimicPort || 0),
        });
      }
    }
    const buildTunnelProbesResult = await buildTunnelProbes({ hostTunnels, forwardProtocolSettings, tunnelHopsByTunnelId, tunnelExitNodesByTunnelId, host, isCurrentHostTunnelEntry, getHopDialAddress, tunnelExitEndpointById, forwardXExtraExitRoutes });
    const { tunnelProbes } = buildTunnelProbesResult;
    const emptyProtocolPolicy = { blockHttp: false, blockSocks: false, blockTls: false };
    const hostProtocolPolicyById = new Map<number, typeof emptyProtocolPolicy>([
      [Number(host.id), protocolPolicyFromHost(host)],
    ]);
    const buildProtocolPolicyHelpersResult = buildProtocolPolicyHelpers({ emptyProtocolPolicy, hostProtocolPolicyById, isCurrentHostTunnelEntry, host, forwardProtocolSettings, tunnelEntryHostIds, tunnelHopsByTunnelId, tunnelExitNodesByTunnelId, getTunnelDialHost, getForwardXWireGuardPlans, forwardGroupHealthByRuleId, ruleRateLimits, userAccessLimits, proxyProtocolOptions, agentAllRules, tunnelById, protocolGuardPortsForRule, failoverTargetEndpoint, isCurrentHostTunnelExitForRule });
    const { tunnelProtocolPolicy, guardListenPort, shouldUseRuleGuard, guardBackendPort, tunnelExitRules, nginxTunnelExitRules, ruleProtocolPolicy, kernelPassthroughForRule, guardTargetForRule, guardRateLimitForRule, kernelPassthroughRuleView, portRangeRuntimeBlocker, kernelPassthroughEntriesForTunnel } = buildProtocolPolicyHelpersResult;
    /*
      不走本机代理时链里出口那一跳的唯一节点：主出口。几台出口之间怎么分、哪台坏了摘掉、手动指定、延迟优先的排序，
      全部在入口机的本机代理里做（gostBalancePlans）；面板不再排 gost 节点的顺序、不再从配置里摘节点。
    */
    const buildPrimaryExitNode = async (rule: any, tunnel: any, primaryHostOverride?: string) => {
      const primary = tunnelExitEndpointsForRule(rule, tunnel).find((endpoint) => endpoint.primary);
      if (!primary || primary.listenPort <= 0) return null;
      const exitHost = String(primaryHostOverride || "").trim() || tunnelExitEndpointById.get(tunnel.id)?.host || await tunnelExitHostAddress(tunnel);
      if (!exitHost) return null;
      const protocolPlan = planGostTunnelRuleProtocol({
        protocol: rule.protocol,
        tunnelId: Number(tunnel.id),
        ruleId: Number(rule.id),
        secretSeed: tunnelSecretSeed(tunnel),
      });
      return gostTunnelNode(`exit-${rule.id}-0`, endpointHostPort(exitHost, primary.listenPort), gostTunnelTransportType(tunnel.mode), tunnel, protocolPlan.chainConnector);
    };
    /*
      GOST 链路负载均衡由入口本机代理挑：这条规则在这台入口机上用不用、每台出口的本机端口和 gost 节点、出口该拨的
      目标、交给 Agent 的代理规格（server/gostBalancePlan.ts 的 planGostBalanceRules）。用不了的只下发主出口一台
      （单节点链，没有 gost 选择器那条路了；哪些用不了见上面分端口那里的清单）。gostBalancePlans 在这里只是声明：
      里面要用 gostTunnelExitTargetAddr，等它定义以后再填。
    */
    const gostBalancePlans = new Map<number, GostBalanceRulePlan<ReturnType<typeof gostTunnelNode>>>();
    const gostRelayFailoverHopMetadata = { strategy: "fifo", maxFails: 1, failTimeout: "5s" };
    const gostTunnelExitTargetAddr = async (rule: any, tunnel: any) => {
      const policy = await tunnelProtocolPolicy(tunnel);
      const tunnelProxyPlan = tunnelProxyProtocolPlan(rule);
      const useExitBridge = shouldUseProtocolGuard(rule, policy)
        || !!tunnelProxyPlan.exitBridgeReceive
        || !!tunnelProxyPlan.exitBridgeSend;
      if (useExitBridge) {
        /*
          出口桥的守卫端口也是出口自己分的（见 server/tunnelExitPorts）：按出口报的填。几个出口分到的
          不一样时没有能绕过守卫的退路，还用本机算的（和以前一样）。
        */
        const localPort = guardListenPort(rule);
        const exitHostIds = routeSchedulerHostIds(rule);
        for (const exitHostId of exitHostIds) {
          if (exitHostId === Number(host.id) || hasTunnelExitPort(exitHostId, "guard", Number(rule.id))) continue;
          if (claimTunnelExitReportRequest(exitHostId)) pushAgentRefresh(exitHostId, "tunnel-exit-ports-needed");
        }
        const port = tunnelExitPortFor("guard", Number(rule.id), exitHostIds, localPort, { selfHostId: Number(host.id), whenRuleMissing: "local" });
        return `127.0.0.1:${port ?? localPort}`;
      }
      const endpoint = tunnelExitSchedulerEndpoint(rule);
      return endpointHostPort(endpoint.targetIp, endpoint.targetPort);
    };
    for (const [ruleId, plan] of await planGostBalanceRules(gostRules as unknown as BalanceRuleLite[], {
      exitCounts: gostBalanceExitCounts,
      tunnelOf: (rule) => tunnelById.get(Number(rule.tunnelId)) as (BalanceTunnelLite & Parameters<typeof tunnelSecretSeed>[0]) | undefined,
      hopsOf: (tunnel) => tunnelHopsByTunnelId.get(Number(tunnel.id)) || [],
      isCurrentHostExitForRule: (rule, tunnel) => isCurrentHostTunnelExitForRule(rule, tunnel),
      chainConnectorFor: (rule, tunnel) => planGostTunnelRuleProtocol({ protocol: rule.protocol, tunnelId: Number(tunnel.id), ruleId: Number(rule.id), secretSeed: tunnelSecretSeed(tunnel) }).chainConnector,
      balanceExitPorts: (rule) => protocolGuardPortsForRule(rule).balanceExitPorts || [],
      hopDialAddress: (hop, tunnel) => getHopDialAddress(hop, tunnel),
      primaryExitHost: async (tunnel) => tunnelExitEndpointById.get(tunnel.id)?.host || await tunnelExitHostAddress(tunnel),
      extraExitDialAddress: (node, tunnel) => getExtraExitDialAddress(node, tunnel),
      exitEndpoints: (rule, tunnel) => tunnelExitEndpointsForRule(rule, tunnel),
      transportOf: (tunnel) => gostTunnelTransportType((tunnel as { mode?: string | null }).mode),
      buildNode: (name, addr, transport, tunnel, connector) => gostTunnelNode(name, addr, transport as ReturnType<typeof gostTunnelTransportType>, tunnel, connector as never),
      endpointAddr: (hostValue, port) => endpointHostPort(hostValue, port),
      // 旧的「连不上」（全局故障刚过、Agent 还在退避里没再探）当不知道，见 exitTargetDownStale
      exitTargetStates: (ruleId) => exitTargetUsableStatesForRule(ruleId),
      exitTargetExcludedHostIds: (ruleId, hostIds) => exitTargetExcludedHostIds(ruleId, hostIds),
      // 份数和 FXP 用的同一个来源：按权重先看手填的份数，再看线路带宽；按访客固定按线路带宽加权（FXP 那边也是）。
      weightsFor: async (strategy, hostIds, tunnel) => (strategy === "ip_hash"
        ? exitGroupWeights("weighted", await exitBandwidthsForHostIds(hostIds))
        : exitWeightsForHostIds(tunnel.loadBalanceStrategy, hostIds, tunnel)),
      failoverPort: (rule) => failoverProxyPort(rule),
      proxyVersion: (rule) => proxyProtocolVersion(rule),
      detectFor: (tunnel) => tunnelBalanceDetect(tunnel),
      // 手动指定的那台离线：不理它、照常自动分（和 NEX 隧道一样，pinnedExitHostId）。
      pinnedExitHostId: (tunnel) => pinnedExitHostId(tunnel),
      proxyHeaderForward: (rule) => proxyProtocolEnabled(rule, "entrySend"),
      exitTargetAddr: (rule, tunnel) => gostTunnelExitTargetAddr(rule, tunnel),
    })) gostBalancePlans.set(ruleId, plan);
    /*
      填「按访客固定」要剥头的 gost 端口转发名单（routeHeaderStripRuleIds 的来历见那里）。条件：
      gost 直连、不过协议守卫（守卫在前面时 gost 看到的访客是守卫自己）、有 TCP、规则本身不发
      PROXY 头（发的话头已经在了，调度器读完原样转）、调度确实会下发且分法是按访客。
      「分法是按访客」看每一层：整组策略，或者任何一条线路的落地之间按访客分（targets[].spread）——
      只看整组的话，整组主备、线路里按访客固定时调度器看到的访客全是 127.0.0.1，所有人落到同一个落地。
      剥头不另设版本门槛：Agent 认线路级分法（2.2.245）比认 proxyProtocolStrip（2.2.199）晚，和整组那种同一个口径。
    */
    for (const rule of Array.from(new Set([...agentAllRules, ...agentHostRules])) as any[]) {
      if (!rule?.failoverEnabled || rule.forwardType !== "gost" || Number(rule.tunnelId || 0) > 0) continue;
      if (!isForwardRuleProtocolTcpEnabled(rule.protocol) || proxyProtocolEnabled(rule, "send")) continue;
      const spec = actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" });
      if (!spec) continue;
      const visitorSticky = spec.strategy === "ip_hash"
        || spec.targets.some((target) => (target as { spread?: string }).spread === "ip_hash");
      if (!visitorSticky) continue;
      if (await shouldUseRuleGuard(rule)) continue;
      routeHeaderStripRuleIds.add(Number(rule.id));
    }
    const {
      buildGostReloadCmds,
      buildTunnelReloadCmds,
      gostManagedConfigs,
      gostServiceConfig,
      gostTunnelProbePlans,
    } = await createGostRuntimePlan(heartbeatCtx, {
      VERBOSE_AGENT_ACTIONS,
      anyTunnelDnsRefresh,
      applyGostLimiter,
      buildPrimaryExitNode,
      buildProxyRuleDebugCmd,
      currentHostTunnelExitPortsForRule,
      dnsRuntimeRefreshCmd,
      failoverTargetAddr,
      getHopDialAddress,
      gostBalancePlans,
      gostRateLimiters,
      gostRelayFailoverHopMetadata,
      gostRules,
      gostRuntimeApiSection,
      gostRuntimeExecStart,
      gostRuntimeSyncCmd,
      gostServiceName,
      gostServiceUnit,
      gostTunnelExitTargetAddr,
      guardBackendPort,
      isCurrentHostTunnelEntry,
      isForwardXTunnel,
      maybeProxyProtocolMetadata,
      proxyProtocolEnabled,
      proxyProtocolVersion,
      routeHeaderStripRuleIds,
      shouldUseRuleGuard,
      tunnelEgressHelpers,
      tunnelExitEndpointsForRule,
      tunnelExitRules,
      tunnelForwardProtos,
      tunnelProxyProtocolPlan,
    });

    // 收集所有正在运行的规则的 port→ruleId 映射，用于 agent 重建映射文件
    const buildNginxPortCleanupCmds = (rule: any) => [
      `rm -f /var/lib/forwardx-agent/traffic_${Number(rule.sourcePort) || 0}.prev /var/lib/forwardx-agent/port_${Number(rule.sourcePort) || 0}.rule /var/lib/forwardx-agent/port_${Number(rule.sourcePort) || 0}.fwtype /var/lib/forwardx-agent/port_${Number(rule.sourcePort) || 0}.tunnel /var/lib/forwardx-agent/target_${Number(rule.sourcePort) || 0}.info 2>/dev/null || true`,
      ...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
      ...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)),
    ];
    const {
      buildNginxRuntimeSyncPlan,
    } = createNginxRuntimeSyncPlanBuilder(heartbeatCtx, {
      anyTunnelDnsRefresh,
      buildRuleAccessLimitCmds,
      currentHostTunnelExitPortsForRule,
      dnsRuntimeRefreshCmd,
      exitWeightsForHostIds,
      failoverTargetEndpoint,
      getExtraExitDialAddress,
      guardBackendPort,
      isCurrentHostTunnelEntry,
      nginxTunnelExitRules,
      shouldUseRuleGuard,
      tunnelExitEndpointsForRule,
      tunnelExitHostAddress,
      tunnelExtraExitNodes,
    });
    let nginxRuntimeSyncPlanPromise: ReturnType<typeof buildNginxRuntimeSyncPlan> | null = null;
    const getNginxRuntimeSyncPlan = () => {
      if (!nginxRuntimeSyncPlanPromise) {
        nginxRuntimeSyncPlanPromise = buildNginxRuntimeSyncPlan();
      }
      return nginxRuntimeSyncPlanPromise;
    };

    const buildGostRuntimeSyncCmds = async () => [
      tunnelRuntimeGenerationCmd(),
      ...buildGostReloadCmds(),
      ...await buildTunnelReloadCmds(),
    ].filter(Boolean);

    const ruleTrafficPort = (rule: any) => {
      const tunnel = rule.tunnelId ? tunnelById.get(rule.tunnelId) as any : null;
      return resolveRuleTrafficPortForHost({
        sourcePort: rule.sourcePort,
        usesTunnelRuntime: !!tunnel && (isGostTunnelMode(tunnel) || isNginxTunnelMode(tunnel)),
        isEntry: !!tunnel && isCurrentHostTunnelEntry(tunnel),
        exitPorts: tunnel ? currentHostTunnelExitPortsForRule(rule, tunnel) : [],
      });
    };
    const runningRules: { ruleId: number; tunnelId?: number; sourcePort: number; sourcePortEnd?: number; targetIp: string; targetPort: number; protocol: string; forwardType: string; failover?: any; forwardGroupHealth?: any; schedulerOnly?: boolean }[] = [];
    const runningRuleSeen = new Set<string>();
    const guardRules: any[] = [];
    const addRunningRule = (rule: { ruleId: number; tunnelId?: number; sourcePort: number; sourcePortEnd?: number; targetIp: string; targetPort: number; protocol: string; forwardType: string; failover?: any; forwardGroupHealth?: any; schedulerOnly?: boolean }) => {
      if (!rule.ruleId || !rule.sourcePort) return;
      const key = ruleRuntimeIdentityKey(rule.ruleId, rule.sourcePort, rule.protocol);
      if (runningRuleSeen.has(key)) return;
      runningRuleSeen.add(key);
      runningRules.push({
        ...rule,
        forwardGroupHealth: rule.forwardGroupHealth || forwardGroupHealthByRuleId.get(Number(rule.ruleId)),
      });
    };

    const {
      buildDisabledRuleRemovalAction,
    } = createDisabledRuleRemovalBuilder(heartbeatCtx, {
      accessScopeForRule,
      buildNginxPortCleanupCmds,
      forwardXEntryRoute,
      isForwardXTunnel,
    });

    const reportedRuntimeState = localRuntimeState.state;
    const hasReportedRuntimeState = !!reportedRuntimeState;
    const reportedLocalRules = Array.isArray(reportedRuntimeState?.rules) ? reportedRuntimeState.rules : [];
    const localRulesByPort = new Map<number, AgentLocalRuntimeRuleState>();
    const localTunnelsByPort = new Map<number, AgentLocalRuntimeTunnelState>();
    const protectedRuleRemoveActionKeys = new Set<string>();
    for (const item of reportedLocalRules) {
      const port = Number(item.port || 0);
      if (port > 0 && !localRulesByPort.has(port)) localRulesByPort.set(port, item);
    }
    for (const item of reportedRuntimeState?.tunnels || []) {
      if (Number(item.port) > 0) localTunnelsByPort.set(Number(item.port), item);
    }
    const reportedRuntimeServices = reportedRuntimeState?.services || [];
    for (const service of reportedRuntimeServices) {
      const name = String(service?.name || "").trim();
      if (!name.startsWith("mimic@")) continue;
      const iface = normalizeNetworkInterface(name.slice("mimic@".length));
      if (iface) {
        reportedMimicInterfaces.add(iface);
        reportedMimicServicesByInterface.set(iface, service);
      }
    }
    const runtimeServiceUnhealthy = (serviceNames: Set<string>) => hasReportedRuntimeState && reportedRuntimeServices
      .some((service: AgentLocalRuntimeServiceState) => (
        serviceNames.has(String(service.name || "").trim())
        && service.hasWork
        && !service.active
      ));
    const gostRuntimeServiceUnhealthy = runtimeServiceUnhealthy(new Set([RUNTIME_SERVICE_NAME, TUNNEL_RUNTIME_SERVICE_NAME]));
    const nginxRuntimeServiceUnhealthy = runtimeServiceUnhealthy(new Set([NGINX_SERVICE_NAME]));
    const mimicRuntimeServiceUnhealthy = hasReportedRuntimeState && reportedRuntimeServices.some((service: AgentLocalRuntimeServiceState) => (
      String(service?.name || "").trim().startsWith("mimic@")
      && service.hasWork
      && !service.active
    ));
    const expectedRulePorts = new Set<string>();
    const expectedRuleIdentityKeys = new Set<string>();
    const expectedRulePortIdentityKeys = new Set<string>();
    const expectedTunnelPorts = new Set<number>();
    const {
      buildGenericLocalRuleRemovalAction,
      buildGenericLocalTunnelRemovalAction,
      localRuleHasKernelForwardState,
      localRuleMatches,
      localRuleNeedsRemoval,
      localTunnelMatches,
      protectActiveRulePort,
    } = createLocalRuntimeMatchers(heartbeatCtx, {
      buildNginxPortCleanupCmds,
      hasReportedRuntimeState,
      localRulesByPort,
      localTunnelsByPort,
      processTarget,
      protectedRuleRemoveActionKeys,
      reportedLocalRules,
    });
    const shouldForceStoppedKernelRuleCleanup = (rule: any) => !!rule?.resourceAccessDenied
      || (isKernelForwardRule(rule) && localRuleNeedsRemoval(rule))
      // The desired rule may already be disabled after a backend edit. If
      // the Agent still reports the same rule as an iptables/nftables owner,
      // issue one cleanup action so a stale kernel redirect cannot survive.
      || localRuleHasKernelForwardState(rule);

    const pendingTunnelExitRuleIds = new Set(
      tunnelExitRules
        .filter((rule: any) => !runtimeBool(rule.isRunning))
        .map((rule: any) => Number(rule.tunnelId))
    );
    await reconcileTunnelRuntimeReadiness({ hostTunnels, host, tunnelExitNodesByTunnelId, tunnelHopsByTunnelId, tunnelNeedsMimic, forwardProtocolSettings, forwardXUDPTargets, forwardXStreamTargets, forwardXUDPTargetsChanged, pendingTunnelExitRuleIds, addMimicLocalFilterForPort, expectedTunnelPorts, localTunnelMatches, tunnelDnsGeneration, applyForwardXTransport, actions, buildForwardXHopSpec });

    const runtimeDriftedRuleIds: number[] = [];
    for (const rule of rules) {
      if ((rule as any)._skipRuntimeApply) continue;
      const ruleTunnel = (rule as any).tunnelId ? tunnelById.get((rule as any).tunnelId) as any : null;
      // 旧入口桥接不是用户选的转发方式，协议总开关管不到它（关掉 iptables 不该让换隧道的规则断流）。
      const ruleProtocolEnabled = isEntryBridgeRuntimeRule(rule) || isRuleProtocolEnabled(forwardProtocolSettings, rule, ruleTunnel);
      const useRuleGuard = await shouldUseRuleGuard(rule);
      const ruleGuardPolicy = useRuleGuard ? await ruleProtocolPolicy(rule) : emptyProtocolPolicy;
      // V2 内核直通：入口机上这条规则变成一条到出口 WireGuard 地址的 iptables 规则（见 tunnelKernelPassthroughPlan）。
      const rulePassthrough = !useRuleGuard && ruleProtocolEnabled && rule.forwardType === "gost" && ruleTunnel
        && isForwardXTunnel(ruleTunnel) && isCurrentHostTunnelEntry(ruleTunnel)
        ? await kernelPassthroughForRule(rule, ruleTunnel)
        : null;
      if (runtimeBool(rule.isEnabled) && ruleProtocolEnabled && rule.forwardType === "gost" && ruleTunnel && isForwardXTunnel(ruleTunnel) && !rulePassthrough) {
        await collectMimicFiltersForRule(rule, ruleTunnel);
      }
      if (!ruleProtocolEnabled) {
        const forceKernelCleanup = shouldForceStoppedKernelRuleCleanup(rule);
        if (runtimeBool(rule.isRunning) || forceKernelCleanup) {
          if (!localRuleNeedsRemoval(rule) && !forceKernelCleanup) {
            await settleStoppedRule(rule);
            continue;
          }
          const removeAction = await buildDisabledRuleRemovalAction(rule);
          if (removeAction) actions.push(removeAction);
        }
        continue;
      }
      // 收集所有已运行的规则映射（无论是否有 action 下发）
      if (runtimeBool(rule.isEnabled) && runtimeBool(rule.isRunning)) {
        const trafficPort = ruleTrafficPort(rule);
        if (trafficPort) {
          if (useRuleGuard) {
            const guardTarget = guardTargetForRule(rule, useRuleGuard);
            const guardProxyProtocol = selectProtocolGuardProxyProtocol({
              backendPort: guardTarget.backendPort,
              backendForwardType: guardTarget.backendForwardType,
              receive: proxyProtocolEnabled(rule, "receive"),
              send: proxyProtocolEnabled(rule, "send"),
            });
            guardRules.push({
              ruleId: rule.id,
              tunnelId: 0,
              listenPort: Number(rule.sourcePort),
              ...(isSniRuntimeRule(rule) ? { bindAddress: "127.0.0.1" } : {}),
              targetIp: guardTarget.targetIp,
              targetPort: guardTarget.targetPort,
              backendPort: guardTarget.backendPort,
              backendForwardType: guardTarget.backendForwardType,
              protocol: normalizeForwardRuleProtocol(rule.protocol),
              policy: ruleGuardPolicy,
              ...guardProxyProtocol,
              proxyProtocolVersion: proxyProtocolVersion(rule),
              ...guardRateLimitForRule(rule),
            });
          }
          const runningForwardType = useRuleGuard
            ? "guard"
            : rulePassthrough
            ? "iptables"
            : rule.forwardType === "gost" && ruleTunnel
            ? tunnelRuleRuntimeForwardType(ruleTunnel) || rule.forwardType
            : rule.forwardType;
          addRunningRule({
            ruleId: rule.id,
            tunnelId: ruleTunnel ? Number(ruleTunnel.id) : 0,
            sourcePort: trafficPort,
            // 端口段：Agent 按它装整段的计数规则、做就绪检查，并把这条规则排除在快速转发之外。
            ...(isPortRangeRule(rule) && trafficPort === Number(rule.sourcePort) ? { sourcePortEnd: ruleSourcePortEnd(rule) } : {}),
            targetIp: rulePassthrough ? rulePassthrough.exitAddress : rule.targetIp,
            targetPort: rulePassthrough ? Number(rule.sourcePort) : rule.targetPort,
            protocol: rule.protocol,
            forwardType: runningForwardType,
            failover: failoverForCurrentHost(rule, ruleTunnel, { listenPort: failoverProxyPort(rule) }),
          });
        }
      }

      const ruleTunnelHops = ruleTunnel ? tunnelHopsByTunnelId.get(Number(ruleTunnel.id)) : null;
      const isCurrentTunnelEntryRule = !!ruleTunnel && isCurrentHostTunnelEntry(ruleTunnel);
      const isGostMultiHopRule = !!ruleTunnel
        && isGostTunnelMode(ruleTunnel)
        && Array.isArray(ruleTunnelHops)
        && ruleTunnelHops.length >= 3
        && (isCurrentTunnelEntryRule || ruleTunnelHops.some((hop: any) => Number(hop.hostId) === Number(host.id)));
      const shouldRefreshTunnelEntryRule = isCurrentTunnelEntryRule
        && (isForwardXTunnel(ruleTunnel) || isGostMultiHopRule)
        && !isTunnelRuntimeHostReady(Number(ruleTunnel.id), Number(host.id));
      const isForwardXMultiHopRule = !!ruleTunnel
        && isForwardXTunnel(ruleTunnel)
        && Array.isArray(ruleTunnelHops)
        && ruleTunnelHops.length >= 3
        && ruleTunnelHops.some((hop: any) => Number(hop.hostId) === Number(host.id));
      const shouldRefreshForwardXMultiHopRule = isForwardXMultiHopRule
        && !isTunnelRuntimeHostReady(Number(ruleTunnel.id), Number(host.id));
      const isForwardXEntryRule = !!ruleTunnel
        && isForwardXTunnel(ruleTunnel)
        && isCurrentTunnelEntryRule;
      const shouldRefreshForwardXEntryRule = isForwardXEntryRule && shouldRefreshTunnelEntryRule;
      const shouldRefreshGuardBackend = shouldReconcileProtocolGuardBackend(useRuleGuard, rule.forwardType);
      const expectedRulePort = Number(rule.sourcePort) || 0;
      const expectedRuleForwardType = useRuleGuard
        ? "guard"
        : rulePassthrough
        ? "iptables"
        : rule.forwardType === "gost" && ruleTunnel
        ? tunnelRuleRuntimeForwardType(ruleTunnel) || rule.forwardType
        : rule.forwardType;
      if (runtimeBool(rule.isEnabled) && expectedRulePort > 0) {
        expectedRulePorts.add(runtimePortProtocolKey(expectedRulePort, rule.protocol));
        expectedRuleIdentityKeys.add(ruleRuntimeIdentityKey(rule.id, expectedRulePort, rule.protocol));
        expectedRulePortIdentityKeys.add(ruleRuntimePortIdentityKey(rule.id, expectedRulePort));
        protectActiveRulePort(rule, expectedRulePort);
      }
      const shouldRepairLocalRule = runtimeBool(rule.isEnabled)
        && expectedRulePort > 0
        && !localRuleMatches(rulePassthrough ? kernelPassthroughRuleView(rule, rulePassthrough) : rule, expectedRuleForwardType, expectedRulePort);
      if (shouldRepairLocalRule && runtimeBool(rule.isRunning)) {
        runtimeDriftedRuleIds.push(Number(rule.id));
        rule.isRunning = false;
        if (shouldLogAgentRuntimeDrift(Number(host.id), Number(rule.id))) {
          appendPanelLog(
            "warn",
            `[AgentRecovery] local listener missing; rule marked for reapply host=${host.id} name=${String(host.name || "-")} rule=${rule.id} port=${expectedRulePort} protocol=${String(rule.protocol || "-")} forwardType=${expectedRuleForwardType}`,
          );
        }
      }
      if (runtimeBool(rule.isEnabled) && (!runtimeBool(rule.isRunning) || shouldRepairLocalRule || shouldRefreshTunnelEntryRule || shouldRefreshForwardXMultiHopRule || shouldRefreshGuardBackend)) {
        const cmds: string[] = [];
        if (useRuleGuard) {
          const guardTarget = guardTargetForRule(rule, useRuleGuard);
          const guardFailover = failoverForCurrentHost(rule, ruleTunnel, { listenPort: failoverProxyPort(rule) });
          const guardProxyProtocol = selectProtocolGuardProxyProtocol({
            backendPort: guardTarget.backendPort,
            backendForwardType: guardTarget.backendForwardType,
            receive: proxyProtocolEnabled(rule, "receive"),
            send: proxyProtocolEnabled(rule, "send"),
          });
          guardRules.push({
            ruleId: rule.id,
            tunnelId: 0,
            listenPort: Number(rule.sourcePort),
            ...(isSniRuntimeRule(rule) ? { bindAddress: "127.0.0.1" } : {}),
            targetIp: guardTarget.targetIp,
            targetPort: guardTarget.targetPort,
            backendPort: guardTarget.backendPort,
            backendForwardType: guardTarget.backendForwardType,
            protocol: normalizeForwardRuleProtocol(rule.protocol),
            policy: ruleGuardPolicy,
            ...guardProxyProtocol,
            proxyProtocolVersion: proxyProtocolVersion(rule),
            ...guardRateLimitForRule(rule),
          });
          const guardBaseCleanupCmds = [
            ...buildManagedPortCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
            ...buildIptablesForwardCleanupCmds(rule),
            ...buildNftCleanupCmds(rule),
          ];
          const guardCountingCmds = [
            ...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
            ...buildRuleAccessLimitCmds(rule),
          ];
          const guardAction: any = {
            ruleId: rule.id,
            op: "apply",
            forwardType: "guard",
            runtimeBackendForwardType: guardTarget.backendForwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: normalizeForwardRuleProtocol(rule.protocol),
            networkInterface: hostInterface,
          };
          // 守卫后面的 realm / socat 拨哪儿：线路组生效时是本机的调度器，否则是规则目标。
          const backendDial = failoverTargetEndpoint(rule);
          if (guardTarget.backendPort > 0 && rule.forwardType === "realm") {
            const svcName = `forwardx-realm-guard-${rule.sourcePort}`;
            const realmConfigPath = realmGuardConfigPathForPort(rule.sourcePort);
            const realmRemote = endpointHostPort(backendDial.targetIp, backendDial.targetPort);
            const realmConfig = [
              "[log]",
              'level = "warn"',
              "",
              "[network]",
              `use_udp = ${isForwardRuleProtocolUdpEnabled(rule.protocol) ? "true" : "false"}`,
              "tcp_timeout = 300",
              "udp_timeout = 30",
              "ipv6_only = false",
              `send_proxy = ${proxyProtocolEnabled(rule, "send") ? "true" : "false"}`,
              `send_proxy_version = ${proxyProtocolVersion(rule)}`,
              `accept_proxy = ${(proxyProtocolEnabled(rule, "send") || proxyProtocolEnabled(rule, "receive")) ? "true" : "false"}`,
              "accept_proxy_timeout = 5",
              "",
              "[[endpoints]]",
              `listen = ${realmTomlString(`127.0.0.1:${guardTarget.backendPort}`)}`,
              `remote = ${realmTomlString(realmRemote)}`,
              "",
            ].join("\n");
            const realmConfigB64 = Buffer.from(realmConfig, "utf8").toString("base64");
            const ifaceFlag = hostInterface ? ` --interface ${hostInterface}` : "";
            const realmCmd = `/usr/local/bin/realm -c ${realmConfigPath}${ifaceFlag}`;
            guardAction.svcName = svcName;
            guardAction.unit = [
              "[Unit]",
              `Description=ForwardX guarded realm backend ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
              "After=network.target",
              "StartLimitIntervalSec=60",
              "StartLimitBurst=5",
              "",
              "[Service]",
              "Type=simple",
              `ExecStart=${realmCmd}`,
              "Restart=always",
              "RestartSec=5",
              "LimitNOFILE=65535",
              "",
              "[Install]",
              "WantedBy=multi-user.target",
              "",
            ].join("\n");
            guardAction.preCommands = [
              ...guardBaseCleanupCmds,
              ...cleanupGuardBackendCmds(rule, [svcName]),
              `mkdir -p ${shQuote(REALM_CONFIG_DIR)}`,
              `printf '%s' '${realmConfigB64}' | base64 -d > ${shQuote(realmConfigPath)}`,
            ];
            guardAction.commands = guardCountingCmds;
          } else if (guardTarget.backendPort > 0 && rule.forwardType === "socat") {
            let socatPreCmds: string[] = [];
            if (normalizeForwardRuleProtocol(rule.protocol) === "both") {
              const svcNameTcp = `forwardx-socat-guard-tcp-${rule.sourcePort}`;
              const svcNameUdp = `forwardx-socat-guard-udp-${rule.sourcePort}`;
              socatPreCmds = [
                ...guardBaseCleanupCmds,
                ...cleanupGuardBackendCmds(rule, [svcNameTcp, svcNameUdp]),
                `command -v socat >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq socat || yum install -y -q socat || dnf install -y -q socat || zypper -n install socat || apk add --no-cache socat || pacman -Sy --noconfirm socat; } 2>/dev/null`,
              ];
              guardAction.svcName = svcNameTcp;
              guardAction.svcNameExtra = svcNameUdp;
              guardAction.unit = [
                "[Unit]",
                `Description=ForwardX guarded socat TCP backend ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
                "After=network.target",
                "",
                "[Service]",
                "Type=simple",
                `ExecStart=/usr/bin/socat ${SOCAT_TRANSFER_BUFFER_FLAG} TCP4-LISTEN:${guardTarget.backendPort},fork,reuseaddr,bind=127.0.0.1${socatSocketOptions("TCP")} ${socatDialAddress("TCP", backendDial.targetIp, backendDial.targetPort)}`,
                "Restart=always",
                "RestartSec=5",
                "LimitNOFILE=65535",
                "",
                "[Install]",
                "WantedBy=multi-user.target",
                "",
              ].join("\n");
              guardAction.unitExtra = [
                "[Unit]",
                `Description=ForwardX guarded socat UDP backend ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
                "After=network.target",
                "",
                "[Service]",
                "Type=simple",
                `ExecStart=/usr/bin/socat ${SOCAT_TRANSFER_BUFFER_FLAG} UDP4-LISTEN:${guardTarget.backendPort},fork,reuseaddr,bind=127.0.0.1 ${socatDialAddress("UDP", backendDial.targetIp, backendDial.targetPort)}`,
                "Restart=always",
                "RestartSec=5",
                "LimitNOFILE=65535",
                "",
                "[Install]",
                "WantedBy=multi-user.target",
                "",
              ].join("\n");
            } else {
              const protoUpper = normalizeForwardRuleProtocol(rule.protocol) === "udp" ? "UDP" : "TCP";
              const listenProto = protoUpper === "UDP" ? "UDP4" : "TCP4";
              guardAction.svcName = `forwardx-socat-guard-${rule.sourcePort}`;
              socatPreCmds = [
                ...guardBaseCleanupCmds,
                ...cleanupGuardBackendCmds(rule, [guardAction.svcName]),
                `command -v socat >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq socat || yum install -y -q socat || dnf install -y -q socat || zypper -n install socat || apk add --no-cache socat || pacman -Sy --noconfirm socat; } 2>/dev/null`,
              ];
              guardAction.unit = [
                "[Unit]",
                `Description=ForwardX guarded socat ${rule.protocol} backend ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
                "After=network.target",
                "",
                "[Service]",
                "Type=simple",
                `ExecStart=/usr/bin/socat ${SOCAT_TRANSFER_BUFFER_FLAG} ${listenProto}-LISTEN:${guardTarget.backendPort},fork,reuseaddr,bind=127.0.0.1${socatSocketOptions(protoUpper)} ${socatDialAddress(protoUpper, backendDial.targetIp, backendDial.targetPort)}`,
                "Restart=always",
                "RestartSec=5",
                "LimitNOFILE=65535",
                "",
                "[Install]",
                "WantedBy=multi-user.target",
                "",
              ].join("\n");
            }
            guardAction.preCommands = socatPreCmds;
            guardAction.commands = guardCountingCmds;
          } else {
            guardAction.commands = [
              ...guardBaseCleanupCmds,
              ...cleanupGuardBackendCmds(rule),
              ...(guardTarget.backendForwardType === "nginx" ? [nginxRuntimeVerifyCmd()] : []),
              ...guardCountingCmds,
            ];
          }
          actions.push(guardAction);
          addRunningRule({
            ruleId: rule.id,
            sourcePort: Number(rule.sourcePort),
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: normalizeForwardRuleProtocol(rule.protocol),
            forwardType: "guard",
            failover: guardFailover,
          });
        } else if (rule.forwardType === "iptables" || rule.forwardType === "nftables") {
          const rangeBlocker = isPortRangeRule(rule) ? portRangeRuntimeBlocker(rule) : null;
          if (rangeBlocker) {
            /*
              端口段规则在这台机器上跑不了（Agent 太老，或者之后才加上了限速）：不下发半套规则，
              发一条一定失败、带着原因的动作，规则卡上直接看到为什么。老 Agent 收到端口段命令
              虽然也能执行，但它的就绪检查只认单端口，会一直当成「没装上」反复重下。
            */
            actions.push({
              ruleId: rule.id,
              op: "apply",
              forwardType: rule.forwardType,
              sourcePort: rule.sourcePort,
              sourcePortEnd: ruleSourcePortEnd(rule),
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              commands: [`echo ${shQuote(rangeBlocker)} >&2`, "exit 1"],
              failureMessage: rangeBlocker,
            });
          } else {
          // 两种内核态转发只差三处，差别写在 buildKernelForwardCmds 里。
          cmds.push(...buildKernelForwardCmds(rule, rule.forwardType, buildRuleAccessLimitCmds(rule)));
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            ...(isPortRangeRule(rule) ? { sourcePortEnd: ruleSourcePortEnd(rule) } : {}),
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            commands: cmds,
          });
          }
        } else if (rule.forwardType === "realm") {
          const svcName = realmServiceNameForPort(rule.sourcePort, rule.protocol);
          const realmConfigPath = realmConfigPathForPort(rule.sourcePort, rule.protocol);
          // 线路组生效时 realm 拨本机的调度器，由它挑路径。
          const realmDial = failoverTargetEndpoint(rule);
          const realmRemote = endpointHostPort(realmDial.targetIp, realmDial.targetPort);
          const realmConfig = buildRealmConfigToml({
            sourcePort: rule.sourcePort,
            protocol: rule.protocol,
            remote: realmRemote,
            sendProxy: proxyProtocolEnabled(rule, "send"),
            acceptProxy: proxyProtocolEnabled(rule, "receive"),
            proxyVersion: proxyProtocolVersion(rule),
            ipv6Listen: hostIpv6Listen,
          });
          const realmConfigB64 = Buffer.from(realmConfig, "utf8").toString("base64");
          const unit = buildRealmServiceUnit({
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            configPath: realmConfigPath,
            networkInterface: hostInterface,
          });
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            svcName,
            unit,
            preCommands: [
              ...buildKernelForwardTransitionCleanupCmds(rule),
              ...cleanupGuardBackendCmds(rule),
              ...legacyRealmCleanupCmds(rule.sourcePort, rule.protocol),
              `mkdir -p ${shQuote(REALM_CONFIG_DIR)}`,
              `printf '%s' '${realmConfigB64}' | base64 -d > ${shQuote(realmConfigPath)}`,
            ],
            commands: [
              // 同时为该端口挂入 mangle 计数链，保证 realm 转发也能被准确统计
              ...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
              ...buildRuleAccessLimitCmds(rule),
            ],
            failover: actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
          });
        } else if (rule.forwardType === "socat") {
          // socat 转发：用户态进程，通过 systemd 管理
          const socatPreCmds: string[] = [
            ...buildKernelForwardTransitionCleanupCmds(rule),
            ...cleanupGuardBackendCmds(rule),
            `command -v socat >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq socat || yum install -y -q socat || dnf install -y -q socat || zypper -n install socat || apk add --no-cache socat || pacman -Sy --noconfirm socat; } 2>/dev/null`,
          ];
          const socatPostCmds: string[] = [];
          // 线路组生效时 socat 拨本机的调度器，由它挑路径。
          const socatDial = failoverTargetEndpoint(rule);

          // 根据协议生成 socat 命令
          // TCP: socat TCP-LISTEN:sourcePort,fork,reuseaddr TCP:targetIp:targetPort
          // UDP: socat UDP-LISTEN:sourcePort,fork,reuseaddr UDP:targetIp:targetPort
          // both: 需要两个 socat 进程
          if (normalizeForwardRuleProtocol(rule.protocol) === "both") {
            // 两个服务：一个 TCP 一个 UDP
            const svcNameTcp = socatServiceNameForPort(rule.sourcePort, "tcp");
            const svcNameUdp = socatServiceNameForPort(rule.sourcePort, "udp");
            const socatUnitBase = {
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              dialHost: socatDial.targetIp,
              dialPort: socatDial.targetPort,
              ipv6Listen: hostIpv6Listen,
            };
            const unitTcp = buildSocatServiceUnit({ ...socatUnitBase, descriptionProtocol: "TCP", dialProtocol: "TCP" });
            const unitUdp = buildSocatServiceUnit({ ...socatUnitBase, descriptionProtocol: "UDP", dialProtocol: "UDP" });
            // socat both 模式下为该端口挂入 mangle 计数链
            for (const c of buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol)) socatPostCmds.push(c);
            for (const c of buildRuleAccessLimitCmds(rule)) socatPostCmds.push(c);
            actions.push({
              ruleId: rule.id,
              op: "apply",
              forwardType: rule.forwardType,
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              preCommands: socatPreCmds,
              svcName: svcNameTcp,
              svcNameExtra: svcNameUdp,
              unit: unitTcp,
              unitExtra: unitUdp,
              postCommands: socatPostCmds,
              failover: actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
            });
          } else {
            const protoUpper = normalizeForwardRuleProtocol(rule.protocol) === "udp" ? "UDP" : "TCP";
            const singleSvcName = socatServiceNameForPort(rule.sourcePort, rule.protocol);
            // Description 里沿用规则上的原始协议写法（小写），和 both 模式那两个单元不同。
            const unit = buildSocatServiceUnit({
              descriptionProtocol: rule.protocol,
              dialProtocol: protoUpper,
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              dialHost: socatDial.targetIp,
              dialPort: socatDial.targetPort,
              ipv6Listen: hostIpv6Listen,
            });
            // socat 单协议模式下为该端口挂入 mangle 计数链
            for (const c of buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol)) socatPostCmds.push(c);
            for (const c of buildRuleAccessLimitCmds(rule)) socatPostCmds.push(c);
            actions.push({
              ruleId: rule.id,
              op: "apply",
              forwardType: rule.forwardType,
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              preCommands: [
                ...socatPreCmds,
                ...legacySocatCleanupCmds(rule.sourcePort, rule.protocol),
              ],
              svcName: singleSvcName,
              unit,
              postCommands: socatPostCmds,
              failover: actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
            });
          }
        } else if (rule.forwardType === "nginx") {
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            commands: [
              ...buildKernelForwardTransitionCleanupCmds(rule),
              ...cleanupGuardBackendCmds(rule),
              nginxRuntimeVerifyCmd(),
            ],
            // nginx 的 upstream 在线路组生效时指向本机的调度器（见上面的 stream 配置）。
            failover: actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
          });
        } else if (rule.forwardType === "gost") {
          const tunnel = (rule as any).tunnelId ? tunnelById.get((rule as any).tunnelId) as any : null;
          if (tunnel && isNginxTunnelMode(tunnel)) {
            actions.push({
              tunnelId: tunnel.id,
              statusType: "rule",
              ruleId: rule.id,
              op: "apply",
              forwardType: "nginx-tunnel",
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              commands: [
                ...buildKernelForwardTransitionCleanupCmds(rule),
                nginxRuntimeVerifyCmd(),
              ],
            });
            continue;
          }
          if (tunnel && isForwardXTunnel(tunnel) && rulePassthrough) {
            // 内核直通：和用户自己选 iptables 的规则一样下发，只是目标换成出口的 WireGuard 地址。
            // Agent 看到端口上的转发方式从 forwardx 变成 iptables，会先停掉这条规则的 FXP 入口进程。
            const view = kernelPassthroughRuleView(rule, rulePassthrough);
            actions.push({
              tunnelId: tunnel.id,
              statusType: "rule",
              ruleId: rule.id,
              op: "apply",
              forwardType: "iptables",
              sourcePort: rule.sourcePort,
              targetIp: view.targetIp,
              targetPort: view.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              commands: [
                ...buildManagedPortCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
                ...buildKernelForwardCmds(view, "iptables"),
              ],
            });
            continue;
          }
          if (tunnel && isForwardXTunnel(tunnel)) {
            const allEntryRoutes = await forwardXEntryRoutes(rule, tunnel);
            // 手动切换（它在这些出口里、而且在线时）：出口全部下发、指定的排第一、分法换成主备（tunnelExitPin.ts 的
            // orderEntryRoutesForPin）—— 指定的那台能用就只走它，连不上目标就当场走下一台，好了切回
            const entryPin = orderEntryRoutesForPin(allEntryRoutes as Array<{ hostId?: number | null }>, await pinnedExitHostId(tunnel));
            const entryRoutes = entryPin.routes as typeof allEntryRoutes;
            const entryRoute = entryRoutes[0] || { host: "", port: 0, key: "" };
            if (!entryRoute.host || entryRoute.port <= 0 || !entryRoute.key) {
              appendPanelLog("error", `[TunnelRoute] invalid NEX entry route tunnel=${tunnel.id} rule=${rule.id} nextHost=${entryRoute.host || "-"} nextPort=${entryRoute.port || "-"}`);
              continue;
            }
            const rateLimits = ruleRateLimits(rule, tunnel);
            const accessLimits = userAccessLimits(Number(rule.userId));
            /*
              出口拨什么：线路组由出口机上的调度器调度时是出口本机的调度器（端口按出口报的），调度
              下发不了（出口 Agent 早于 2.2.199）时是路径 A，不是线路组就是规则目标。调度器不在入口
              （见 failoverForCurrentHost）。
            */
            const fxpTarget = tunnelExitSchedulerEndpoint(rule);
            const useUdpOverTcp = udpOverTcpEnabled(rule, tunnel);
            const wireGuardV2 = isForwardXWireGuardV2(tunnel);
            const effectiveProxyProtocol = effectiveTunnelProxyProtocolOptions({
              entryReceive: proxyProtocolEnabled(rule, "entryReceive"),
              entrySend: proxyProtocolEnabled(rule, "entrySend"),
              exitReceive: proxyProtocolEnabled(rule, "exitReceive"),
              exitSend: proxyProtocolEnabled(rule, "exitSend"),
              version: proxyProtocolVersion(rule),
            });
            if (useUdpOverTcp && entryRoutes.some((route) => Number((route as any).udpPort || 0) <= 0)) {
              appendPanelLog("error", `[TunnelRoute] missing NEX mimic UDP exit port tunnel=${tunnel.id} rule=${rule.id}`);
              continue;
            }
            if (useUdpOverTcp) {
              addMimicRemoteFilterForRoutes(entryRoutes, [
                { resourceType: "forward_rule", resourceId: Number(rule.id) },
                { resourceType: "tunnel", resourceId: Number(tunnel.id) },
              ]);
            }
            // Aggregate mode turns the relay set into parallel legs: the entry
            // stripes each client connection over all of them and the exit
            // reassembles it, so one connection can use their combined egress.
            const relayAggregate = isTunnelRelayAggregate(tunnel, tunnelHopsByTunnelId.get(Number(tunnel.id)) || []);
            // 热备和叠加同一套腿：热备只是第一台中转当主腿送，其余标成 standby 挂着等（FXP 2.2.137 起认）。
            const relayHotStandby = !relayAggregate && isTunnelRelayHotStandby(tunnel, tunnelHopsByTunnelId.get(Number(tunnel.id)) || []);
            const aggregateRoutes = relayAggregate || relayHotStandby
              ? entryRoutes.filter((route) => route.host && Number(route.port) > 0 && route.key)
              : [];
            // 每一路带上那台中转的线路带宽：FXP 一开始就按它给各路分份额，起速更快（实测出来以后以实测为准）。
            const aggregateBandwidths = aggregateRoutes.length > 0
              ? await exitBandwidthsForHostIds(aggregateRoutes.map((route) => Number((route as any).hostId || 0)))
              : [];
            const multipathLegs: Array<{ host: string; port: number; key: string; via: string; capacityMbps?: number; standby?: boolean }> = aggregateRoutes.map((route, index) => ({
              host: route.host,
              port: Number(route.port),
              key: route.key,
              via: `relay#${Number((route as any).hostId || 0)}`,
              ...(aggregateBandwidths[index] > 0 ? { capacityMbps: aggregateBandwidths[index] } : {}),
              ...(relayHotStandby && index > 0 ? { standby: true } : {}),
            }));
            // 单连接多路并发：没有并排中转时，把同一个出口（或链的第一跳）重复 N 条腿。
            if (!relayAggregate && !relayHotStandby && normalizeTunnelParallelStreams((tunnel as any).parallelStreams) >= 2) {
              const hopsForStreams = tunnelHopsByTunnelId.get(Number(tunnel.id)) || [];
              if (!tunnelParallelStreamsUnavailableReason(tunnel, hopsForStreams, entryRoutes.length)) {
                multipathLegs.push(...buildParallelStreamLegs(entryRoute, (tunnel as any).parallelStreams));
              }
            }
            // 并排中转时 entryRoutes 是几台中转（固定主备），权重只给出口组的出口。
            const entryExitsAreRelays = tunnelRelayUsesParallelRelays(tunnel, tunnelHopsByTunnelId.get(Number(tunnel.id)) || []);
            const entryExitHostIds = entryRoutes.map((route) => Number((route as any).hostId || 0));
            const entryExitWeights = entryExitsAreRelays ? null : await exitWeightsForHostIds((tunnel as any).loadBalanceStrategy, entryExitHostIds, tunnel);
            const entryExitCapacities = entryExitsAreRelays ? null : await exitCapacitiesForHostIds((tunnel as any).loadBalanceStrategy, entryExitHostIds);
            // 每个出口从哪个 IP 出去（2.3.520，见 exitIpsForHostIds）。并排中转不是出口，不带。
            const entryExitIps = entryExitsAreRelays ? null : await exitIpsForHostIds(entryExitHostIds);
            // 负载均衡：入口机的 FXP 新（2.2.142 起）才给「自动 / 延迟优先」、出口回报连目标的结果、检测参数。
            const entryHostFxpVersion = (host as { fxpVersion?: string | null }).fxpVersion;
            const tunnelBalance = tunnel as { loadBalanceStrategy?: string | null; balanceDetect?: string | null };
            const entryFxpTargetAware = !entryExitsAreRelays && entryRoutes.length > 1 && fxpSupportsTargetAware(entryHostFxpVersion);
            // 「只看隧道」（2.3.556）：出口不带 targetStatus —— FXP 只在有出口回报目标结果时才探目标、按目标判出口
            // （forwardx-fxp newTargetAwareness），这样它只看入口到出口；检测参数（探出口机的节奏、只走最快的一台）照发
            const entryScopeTunnel = balanceDetectForRuntime(tunnelBalance.balanceDetect)?.scope === "tunnel";
            const entryExitTargetStatus = entryFxpTargetAware && !entryScopeTunnel ? await exitTargetStatusForHostIds(entryExitHostIds) : null;
            const fxpSpec = await applyForwardXTransport({
              role: "entry",
              tunnelId: tunnel.id,
              ruleId: rule.id,
              listenPort: rule.sourcePort,
              // 共享 TLS 入站上的规则：入口只听回环，客户端连的是入站端口（SNI 分流器交过来）。
              ...(isSniRuntimeRule(rule) ? { listenHost: "127.0.0.1" } : {}),
              protocol: rule.protocol,
              exitHost: entryRoute.host,
              exitPort: entryRoute.port,
              ...(multipathLegs.length >= 2 ? { multipathEnabled: true, multipathLegs, ...(runtimeBool((tunnel as any).multipathReplicate) ? { multipathReplicate: true } : {}) } : {}),
              exitStrategy: tunnelRelayUsesParallelRelays(tunnel, tunnelHopsByTunnelId.get(Number(tunnel.id)) || []) || entryPin.pinned
                ? "fallback"
                : forwardXExitStrategy(tunnelBalance.loadBalanceStrategy, fxpSupportsTargetAware(entryHostFxpVersion)),
              ...(entryFxpTargetAware ? { balanceDetect: balanceDetectForRuntime(tunnelBalance.balanceDetect) } : {}),
              exitPeerId: wireGuardV2 ? String(Number((entryRoute as any).hostId || 0)) : undefined,
              ...(!wireGuardV2 && useUdpOverTcp ? { udpExitPort: Number((entryRoute as any).udpPort || 0) } : {}),
              exits: entryRoutes.map((route, index) => ({
                host: route.host,
                port: route.port,
                ...(!wireGuardV2 && useUdpOverTcp ? { udpPort: Number((route as any).udpPort || 0) } : {}),
                key: route.key,
                peerId: wireGuardV2 ? String(Number((route as any).hostId || 0)) : undefined,
                ...(entryExitWeights ? { weight: entryExitWeights[index] } : {}),
                ...(entryExitCapacities ? { capacityMbps: entryExitCapacities[index] } : {}),
                ...(entryExitIps?.[index] ? { exitIp: entryExitIps[index] } : {}),
                ...(entryExitTargetStatus?.[index] ? { targetStatus: true } : {}),
                // 主机号：FXP 2.2.145 起上报负载均衡真实状态时用它说「是哪台」（老 FXP 不认，忽略）
                ...(Number(entryExitHostIds[index] || 0) > 0 ? { hostId: entryExitHostIds[index] } : {}),
              })),
              targetIp: fxpTarget.targetIp,
              targetPort: fxpTarget.targetPort,
              key: entryRoute.key,
              limitIn: rateLimits.limitIn,
              limitOut: rateLimits.limitOut,
              ...accessLimits,
              accessScope: accessScopeForRule(rule),
              ...await tunnelProtocolPolicy(tunnel),
              proxyProtocolReceive: effectiveProxyProtocol.entryReceive,
              proxyProtocolSend: effectiveProxyProtocol.entrySend,
              proxyProtocolExitReceive: effectiveProxyProtocol.exitReceive,
              proxyProtocolExitSend: effectiveProxyProtocol.exitSend,
              proxyProtocolVersion: effectiveProxyProtocol.version,
              tcpFastOpen: runtimeBool((rule as any).tcpFastOpen),
              dnsGeneration: tunnelDnsGeneration(tunnel),
            }, tunnel);
            if (!fxpSpec) continue;
            actions.push({
              tunnelId: tunnel.id,
              statusType: "rule",
              ruleId: rule.id,
              op: "apply",
              forwardType: "forwardx",
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              commands: (!runtimeBool(rule.isRunning) || shouldRefreshForwardXEntryRule || shouldRepairLocalRule) ? [
                ...buildKernelForwardTransitionCleanupCmds(rule),
                ...buildManagedPortCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
                ...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol, "forwardx"),
              ] : [],
              fxp: fxpSpec,
            });
            continue;
          }
          actions.push({
            tunnelId: tunnel ? tunnel.id : 0,
            statusType: tunnel ? "rule" : undefined,
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            commands: [
              ...buildKernelForwardTransitionCleanupCmds(rule),
              ...cleanupGuardBackendCmds(rule),
              ...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol, rule.forwardType),
              ...buildRuleAccessLimitCmds(rule),
            ],
            failover: tunnel ? undefined : actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" }),
          });
        }
      } else if (!runtimeBool(rule.isEnabled) && (runtimeBool(rule.isRunning) || shouldForceStoppedKernelRuleCleanup(rule))) {
        const forceKernelCleanup = shouldForceStoppedKernelRuleCleanup(rule);
        if (!localRuleNeedsRemoval(rule) && !forceKernelCleanup) {
          await settleStoppedRule(rule);
          continue;
        }
        /*
          停用和删除下发的清理命令是同一套，所以这里直接用同一个构造器。

          原来这一段把 buildDisabledRuleRemovalAction 里那六种分支又手抄了一遍
          （只有 nftables 一支是调过去的），两份各改各的，已经漏过一次：nginx
          手动停用时不清故障转移的守护后端，而删除那条清。两份手抄的列表不可能
          长期保持一致 —— 唯一的办法是只留一份。
        */
        const removeAction = await buildDisabledRuleRemovalAction(rule);
        if (removeAction) actions.push(removeAction);
      }
    }

    // 取走该主机的 pending 转发自测任务并标为 running
    if (runtimeDriftedRuleIds.length > 0) await markRuntimeRulesNotRunning(runtimeDriftedRuleIds);

    const collectHeartbeatRunningRulesResult = await collectHeartbeatRunningRules({ tunnelExitRules, tunnelById, tunnelProtocolPolicy, emptyProtocolPolicy, tunnelProxyProtocolPlan, isForwardXTunnel, failoverTargetEndpoint, guardRules, guardListenPort, proxyProtocolVersion, nginxTunnelExitRules, currentHostTunnelExitPortsForRule, protectActiveRulePort, addRunningRule, failoverForCurrentHost, failoverProxyPort, agentAllRules, forwardProtocolSettings, forwardXSchedulerFailover, tunnelHopsByTunnelId, host, getHopDialAddress, runningRules, expectedRulePorts, expectedRuleIdentityKeys, expectedRulePortIdentityKeys });
    const { hostProxyInbounds } = collectHeartbeatRunningRulesResult;
    protectActionPortsFromLocalState({ hasReportedRuntimeState, actions, agentAllRules, host, reportedLocalRules, expectedRuleIdentityKeys, expectedRulePortIdentityKeys, expectedRulePorts, buildGenericLocalRuleRemovalAction, localTunnelsByPort, expectedTunnelPorts, buildGenericLocalTunnelRemovalAction });

    const forwardGroupProbeMap = new Map<string, any>();
    const forwardGroupProbeTopology = await db.getForwardGroupProbeTopologyForHost(Number(host.id));
    const buildForwardGroupProbesResult = await buildForwardGroupProbes({ forwardGroupProbeTopology, host, forwardGroupProbeMap, agentAllRules, tunnelById, forwardProtocolSettings, tunnelEgressHelpers, processTarget, tunnelExitNodesByTunnelId, forwardGroupHealthByRuleId });
    const { ruleLatencyProbes, forwardGroupProbes } = buildForwardGroupProbesResult;
    // 自动换 IP 的探测借同一个通道下发（保留的 serviceId 段，不进 host_probe_services 表），见 server/ipChange/。
    const hostProbeServices = [
      // URL 连接检测只发给够版本的 Agent：用这一次心跳报上来的版本，升级后的第一次心跳就拿得到
      ...await db.getHostProbeTasksForHost(host.id, { agentVersion: effectiveAgentVersion }),
      ...await getIpChangeProbeTasksForHost(Number(host.id)),
    ];

    for (const tunnel of hostTunnels as any[]) {
      if (!isForwardXWireGuardV2(tunnel)) continue;
      const tunnelProtocolEnabled = isTunnelProtocolEnabled(forwardProtocolSettings, tunnel);
      const enabled = runtimeBool(tunnel.isEnabled) && tunnelProtocolEnabled;
      const plan = enabled ? await getCurrentHostForwardXWireGuardPlan(tunnel) : null;
      if (enabled && !plan) continue;
      const passthrough = plan ? await kernelPassthroughEntriesForTunnel(tunnel) : [];
      actions.push({
        tunnelId: Number(tunnel.id),
        statusType: "runtime",
        ruleId: 0,
        op: enabled ? "apply" : "remove",
        forwardType: "forwardx-wireguard",
        sourcePort: 0,
        targetIp: "",
        targetPort: 0,
        protocol: "udp",
        commands: [],
        wireGuard: plan ? (passthrough.length > 0 ? { ...plan, passthrough } : plan) : undefined,
        reportStatus: false,
      });
    }

    /*
      从原版 ForwardX 迁过来的面板（server/forwardxAgentMigration.ts）：原版 Agent 自动排一次升级，
      换成 NEX 发的 Agent。不看版本号 —— 原版的版本号可能比 NEX 的还高。
    */
    const resolveAgentUpgradeDirectiveResult = await resolveAgentUpgradeDirective({ forwardxAgentMigrationEnabled, host, responseIssuedAt, effectiveAgentVersion, agentVersion, nextFxpVersion });
    const { panelUrl, agentUpgrade, panelMigration } = resolveAgentUpgradeDirectiveResult;

    // Do not mark plugin sync as delivered while an Agent is first uploading its
    // local runtime snapshot. Desired state is intentionally withheld for that
    // response, so caching the plugin action here would otherwise lose it until
    // the five-minute plugin retry window expires.
    const deferActionsForLocalState = localRuntimeState.requestLocalState;
    const selfTests: any[] = [];
    if (!deferActionsForLocalState) {
      const pendingTests = await db.getPendingForwardTestsByHost(host.id);
      for (const t of pendingTests) {
        const claimed = await db.markForwardTestRunning(t.id);
        if (!claimed) continue;
        const meta = parseSelfTestMeta(db.forwardTestRequestMessage(t as any));
        const metaSelfTest = buildMetaAgentSelfTestPayload(t, meta);
        if (metaSelfTest) {
          selfTests.push(metaSelfTest);
          continue;
        }
        const rule = await db.getForwardRuleById(t.ruleId);
        if (!rule) continue;
        selfTests.push(buildRuleAgentSelfTestPayload(t, rule));
      }
    }
    const pluginSyncTasks = await buildPluginHostAssetSyncActions(Number(host.id));
    const reportedPluginInventory = reportedPluginInventoryForFastPath;
    let pluginSyncActionQueued = false;
    const queuePluginSyncActionsResult = queuePluginSyncActions({ pluginSyncTasks, reportedPluginInventory, deferActionsForLocalState, host, responseIssuedAt, actions, pluginSyncActionQueued });
    pluginSyncActionQueued = queuePluginSyncActionsResult.pluginSyncActionQueued;

    const dnsRuntimeChanged = dnsChangedReports.length > 0;
    const gostRuntimeConfigChanged = actions.some((action) => actionMayAffectRuntimeFamily(action, SHARED_GOST_FORWARD_TYPES)) || dnsRuntimeChanged;
    const nginxRuntimeConfigChanged = actions.some((action) => actionMayAffectRuntimeFamily(action, SHARED_NGINX_FORWARD_TYPES)) || dnsRuntimeChanged;
    const reportedGostRuntimeServices = reportedRuntimeServices.filter((service: AgentLocalRuntimeServiceState) => {
      const name = String(service?.name || "").trim();
      return name === RUNTIME_SERVICE_NAME || name === TUNNEL_RUNTIME_SERVICE_NAME;
    });
    const reportedGostHasWork = reportedGostRuntimeServices.some((service: AgentLocalRuntimeServiceState) => service?.hasWork === true);
    const gostMultiHopRuntimeDesired = (hostTunnels as any[]).some((tunnel: any) => {
      if (!tunnel || !runtimeBool(tunnel.isEnabled) || !isGostTunnelMode(tunnel) || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return false;
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      if (!Array.isArray(hops) || hops.length < 2) return false;
      const hostIndex = hops.findIndex((hop: any) => Number(hop?.hostId || 0) === Number(host.id));
      return hostIndex >= 0 && hostIndex < hops.length - 1;
    });
    const gostDesiredRelevant = gostServiceConfig.length > 0
      || tunnelExitRules.length > 0
      || gostTunnelProbePlans.length > 0
      || gostMultiHopRuntimeDesired;
    const reportedNginxRuntimeService = reportedRuntimeServices.find((service: AgentLocalRuntimeServiceState) => (
      String(service?.name || "").trim() === NGINX_SERVICE_NAME
    ));
    const reportedNginxHasWork = reportedNginxRuntimeService?.hasWork === true;
    const nginxDesiredRelevant = (agentHostRules as any[]).some((rule: any) => {
      if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled)) return false;
      if (rule.forwardType === "nginx") {
        return isRuleProtocolEnabled(forwardProtocolSettings, rule, null);
      }
      if (rule.forwardType !== "gost" || !rule.tunnelId) return false;
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      return !!tunnel
        && runtimeBool(tunnel.isEnabled)
        && isNginxTunnelMode(tunnel)
        && isCurrentHostTunnelEntry(tunnel)
        && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
        && isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel);
    }) || nginxTunnelExitRules.length > 0 || (hostTunnels as any[]).some((tunnel: any) => (
      !!tunnel
      && runtimeBool(tunnel.isEnabled)
      && isNginxTunnelMode(tunnel)
      && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
      && (
        Number(tunnel.exitHostId) === Number(host.id)
        || tunnelExtraExitNodes(tunnel).some((node: any) => Number(node?.hostId || 0) === Number(host.id))
      )
    ));
    const managedPortTopologyChanged = actions.some((action: any) => (
      action?.statusType !== "runtime"
      && Number(action?.sourcePort || 0) > 0
      && (action?.op === "apply" || action?.op === "remove")
    ));
    const desiredMimicInterfaces = new Set(Array.from(mimicFiltersByInterface.keys()));
    const approvedMimicRemovals = approveMimicInterfaceRemovals({
      hostId: Number(host.id),
      desiredInterfaces: desiredMimicInterfaces,
      reportedInterfaces: reportedMimicInterfaces,
      completeSnapshot: hasReportedRuntimeState && !localRuntimeState.requestLocalState,
      rebootDetected: rebootDetected || processRestartDetected,
      now: responseIssuedAt,
    });
    const mimicRuntimeSyncWanted = mimicFiltersByInterface.size > 0
      || mimicRequestedWithoutInterface
      || approvedMimicRemovals.size > 0;
    const mimicRuntimeTopologyMismatch = desiredMimicInterfaces.size !== reportedMimicInterfaces.size
      || Array.from(desiredMimicInterfaces).some((iface) => !reportedMimicInterfaces.has(iface));
    const mimicDesiredPlanSignature = JSON.stringify({
      requestedWithoutInterface: mimicRequestedWithoutInterface,
      interfaces: Array.from(mimicFiltersByInterface.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([iface, filters]) => [iface, Array.from(filters).sort()]),
    });
    const mimicResourceRevisionSignature = desiredMimicInterfaces.size > 0
      ? await getMimicLifecycleRevisionSignature(Array.from(mimicLifecycleResources.values()))
      : "";
    const mimicRuntimeLifecycleToken = mimicRuntimeLifecycles.observe({
      hostId: Number(host.id),
      planSignature: mimicDesiredPlanSignature,
      resourceRevisionSignature: mimicResourceRevisionSignature,
      desired: desiredMimicInterfaces.size > 0,
      repairNeeded: desiredMimicInterfaces.size > 0
        && (mimicRuntimeServiceUnhealthy || mimicRuntimeTopologyMismatch),
      revision: configRevision,
    });
    const runtimeSyncBootstrap = !hasReportedRuntimeState || localRuntimeState.requestLocalState;
    const gostReconcileCandidate = shouldReconcileGostRuntime({
      configChanged: gostRuntimeConfigChanged,
      serviceUnhealthy: gostRuntimeServiceUnhealthy,
      bootstrap: runtimeSyncBootstrap,
      desiredRelevant: gostDesiredRelevant,
      reportedHasWork: reportedGostHasWork,
    });
    const gostReconcileInterval = reportedGostHasWork && !gostDesiredRelevant
      ? AGENT_RUNTIME_SYNC_REPAIR_RESEND_MS
      : AGENT_GOST_RUNTIME_RECONCILE_MS;
    const gostPeriodicReconcileDue = gostReconcileCandidate && runtimeSyncReconcileDue(
      Number(host.id),
      "gost-runtime-sync",
      responseIssuedAt,
      gostReconcileInterval,
    );
    await queueGostRuntimeSync({ deferActionsForLocalState, gostRuntimeConfigChanged, gostRuntimeServiceUnhealthy, runtimeSyncBootstrap, gostPeriodicReconcileDue, buildGostRuntimeSyncCmds, gostManagedConfigs, gostReconcileInterval, host, responseIssuedAt, actions, reportedGostHasWork, gostDesiredRelevant });
    const nginxReconcileCandidate = shouldReconcileNginxRuntime({
      configChanged: nginxRuntimeConfigChanged,
      serviceUnhealthy: nginxRuntimeServiceUnhealthy,
      bootstrap: runtimeSyncBootstrap,
      desiredRelevant: nginxDesiredRelevant,
      reportedHasWork: reportedNginxHasWork,
    });
    const nginxReconcileInterval = reportedNginxHasWork && !nginxDesiredRelevant
      ? AGENT_RUNTIME_SYNC_REPAIR_RESEND_MS
      : AGENT_NGINX_RUNTIME_RECONCILE_MS;
    const nginxPeriodicReconcileDue = nginxReconcileCandidate && runtimeSyncReconcileDue(
      Number(host.id),
      "nginx-runtime-sync",
      responseIssuedAt,
      nginxReconcileInterval,
    );
    const nginxModelMayHaveChanged = reportedNginxHasWork && managedPortTopologyChanged;
    await queueNginxRuntimeSync({ deferActionsForLocalState, nginxRuntimeConfigChanged, nginxRuntimeServiceUnhealthy, runtimeSyncBootstrap, nginxModelMayHaveChanged, nginxPeriodicReconcileDue, getNginxRuntimeSyncPlan, nginxReconcileInterval, host, responseIssuedAt, actions, reportedNginxHasWork, nginxDesiredRelevant });
    /**
     * 落地节点：把这台主机上启用中的入站合成一份 sing-box 配置推下去。
     *
     * 无条件生成计划（有入站就下发，没有就下发一份收尾），而不是「有入站才管」：
     * 用户删掉最后一个入站之后，这台机器上就再也没有行了，那时若不下发收尾，
     * sing-box 会带着一份过期配置继续跑。收尾用的命令每一条都带 `|| true`，
     * 对从没装过 sing-box 的主机是无害的空操作，而 shouldSendRuntimeSyncAction
     * 会按签名去重，所以只会真正下发一次。
     */
    await queueSingboxRuntimeSync({ deferActionsForLocalState, host, hostProxyInbounds, panelUrl, runtimeSyncBootstrap, responseIssuedAt, actions, effectiveAgentVersion, rules });
    queueMimicRuntimeSync({ deferActionsForLocalState, mimicRuntimeSyncWanted, anyTunnelDnsRefresh, hostTunnels, tunnelNeedsMimic, dnsRuntimeRefreshToken, hostInterface, mimicFiltersByInterface, reportedMimicInterfaces, reportedMimicServicesByInterface, mimicRequestedWithoutInterface, host, buildMimicRuntimeSyncCmds, mimicRuntimeLifecycleToken, approvedMimicRemovals, responseIssuedAt, mimicRuntimeServiceUnhealthy, mimicRuntimeTopologyMismatch, runtimeSyncBootstrap, actions });

    await restoreTunnelRulesFromLocalState({ hasReportedRuntimeState, forwardProtocolSettings, tunnelHopsByTunnelId, isCurrentHostTunnelEntry, host, tunnelExitNodesByTunnelId, tunnelEntryHostIds, hostTunnels, tunnelById, rules, localRuleMatches });

    /*
      规则换回还留着桥接的机器：这个端口的 conntrack 里还有被桥接 DNAT 出去的老流（换之前就连着
      的 UDP 客户端）。Agent 接管端口时会删掉桥接的 DNAT 规则，但不会动这些记录，老客户端的包
      会继续被送去另一台入口绕一圈，等那边的桥接到期就断。规则的下发里先把它们清掉
      （Agent 是先删 DNAT 规则再跑 preCommands，顺序正好）。
    */
    for (const action of actions) {
      if (action?.op !== "apply" || action?.statusType === "runtime") continue;
      const ruleId = Number(action?.ruleId || 0);
      const port = Number(action?.sourcePort || 0);
      if (ruleId <= 0 || isEntryBridgeRuleId(ruleId) || port <= 0) continue;
      const bridgeOnPort = reportedLocalRules.some((local: AgentLocalRuntimeRuleState) => Number(local?.port || 0) === port && isEntryBridgeRuleId(local?.ruleId));
      if (!bridgeOnPort) continue;
      action.preCommands = [...buildEntryBridgeConntrackFlushCmds(port, action.protocol), ...(Array.isArray(action.preCommands) ? action.preCommands : [])];
    }
    /*
      普通端口转发的单 IP 接入限制（server/portAccessLimits.ts）：按这台入口机上全部
      已启用的普通规则出一份完整快照，和规则自己的下发互不相干 —— 已经在跑的规则不会因此
      被重新下发或重启。只算面对客户端的入口端口：线路组中转跳、转发链后面几跳、共享 TLS
      入站分过来的回环端口、换隧道留下的入口桥接，来源都是上一台机器或本机，按单 IP 一限
      全体用户都会被卡住。
    */
    if (!deferActionsForLocalState) {
      // 设置里没打开时候选为空 → 空快照：不限，并撤掉之前打开时下发的限制。
      // 读设置失败不能当成「关」：空快照会撤掉全部限制，这段时间放进来的连接之后也不会被踢掉。
      // 读不到就沿用上一次发给这台机器的快照（没有就这轮不发，Agent 保持现状）。
      const enforcePortLimits = await readPortAccessLimitsEnabled((key) => db.getSetting(key));
      if (enforcePortLimits === null) appendPanelLog("warn", `[PortAccessLimits] host=${host.id} setting read failed, keeping previous snapshot`);
      const portLimitCandidates: any[] = [];
      for (const rule of (enforcePortLimits ? agentHostRules : []) as any[]) {
        if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled)) continue;
        if (Number(rule.hostId || 0) !== Number(host.id) || runtimeBool(rule.isForwardGroupTemplate)) continue;
        if (Number(rule.tunnelId || 0) > 0 || Number(rule.routeParentRuleId || 0) > 0 || Number(rule.tlsInboundId || 0) > 0) continue;
        if (isEntryBridgeRuntimeRule(rule) || !isRuleProtocolEnabled(forwardProtocolSettings, rule, null)) continue;
        if (Number(rule.forwardGroupRuleId || 0) > 0 && Number(rule.forwardGroupMemberId || 0) > 0) {
          const group = await getForwardChainGroup(Number(rule.forwardGroupId || 0));
          if (String((group as any)?.groupMode || "") === "chain") {
            const members = [...(((group as any)?.members || []) as any[])]
              .filter((member: any) => runtimeBool(member?.isEnabled))
              .sort((a: any, b: any) => Number(a.priority) - Number(b.priority));
            if (Number(members[0]?.id || 0) !== Number(rule.forwardGroupMemberId)) continue;
          }
        }
        portLimitCandidates.push(rule);
      }
      const portLimitAction = resolvePortAccessLimitAction(
        Number(host.id),
        enforcePortLimits,
        () => portAccessLimitAction(portAccessLimitSpecs(portLimitCandidates, userAccessLimits)),
      );
      if (portLimitAction) actions.push(portLimitAction);
    }
    const orderHeartbeatActionsResult = await orderHeartbeatActions({ actions, protectedRuleRemoveActionKeys, host, responseIssuedAt, rules, hasReportedRuntimeState, localRuleMatches, localTunnelMatches, tunnelById, configRevision, deferActionsForLocalState, runningRules, addRunningRule, recoveryTriggered, previousHost, agentBootId, agentProcessId });
    const { activeWorkActions, orderedActions, desiredStatePieceByAction, actionBatchIssuedAt, recoveryWasInProgress } = orderHeartbeatActionsResult;
    const hasTunnelApplyActions = activeWorkActions.some(isTunnelApplyBlockingProbe);
    const hasPendingMultiHopRuntime = (hostTunnels as any[]).some((tunnel: any) => {
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      return runtimeBool(tunnel?.isEnabled)
        && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
        && Array.isArray(hops)
        && hops.length >= 3
        && hops.some((hop: any) => Number(hop.hostId) === Number(host.id))
        && !isTunnelRuntimeHostReady(Number(tunnel.id), Number(host.id));
    });
    const tcpingRequested = hasHostTcpingRequest(host.id);
    const forceTcping = tcpingRequested && !hasTunnelApplyActions;
    if (forceTcping) clearHostTcpingRequest(host.id);

    const lookingGlassTests = takeLookingGlassAgentTasks(host.id);
    // 一键链路诊断
    const diagnosticsTasks = takeDiagnosticsAgentTasks(host.id);
    // 规则的「连接」清单
    const ruleConnectionTasks = takeRuleConnectionsTasks(host.id);
    const iperf3Tasks = takeIperf3AgentTasks(host.id);
    const pluginsAwaitingSync = new Set(pluginSyncTasks.map((task) => task.pluginId));
    const pluginTasks = reportedPluginInventory && !pluginSyncActionQueued
      ? takePluginAgentTasks(host.id, 4, (task) => (
          !pluginsAwaitingSync.has(task.pluginId)
          && reportedPluginInventory.versions.get(task.pluginId) === task.pluginVersion
        ))
      : [];
    const hasPendingPluginTasks = hasQueuedPluginAgentTasks(host.id);
    // 「安装 / 修复 mimic」（2.3.439）：排了就下一次心跳带下去，跑的时候心跳也勤一点，页面上进度跟得紧
    const mimicInstallTask = takeMimicInstallTask(host.id);
    const hasInteractiveTasks = lookingGlassTests.length > 0
      || diagnosticsTasks.length > 0
      || hasRunningDiagnosticsAgentTasks(host.id)
      || ruleConnectionTasks.length > 0
      || hasRunningRuleConnectionsTasks(host.id)
      || iperf3Tasks.length > 0
      || pluginTasks.length > 0
      || hasPendingPluginTasks
      || !!mimicInstallTask
      || hasPendingMimicInstallTask(host.id)
      || pluginSyncActionQueued
      || forceTcping
      || (hasPendingMultiHopRuntime && !hasTunnelApplyActions);
    const nextInterval = selectAgentHeartbeatInterval({
      requestLocalState: localRuntimeState.requestLocalState,
      hasInteractiveTasks,
      metricsWatching: isHostMetricsWatching(host.id),
      serviceProbeIntervals: hostProbeServices.map((service: any) => service?.intervalSeconds),
    });
    const desiredStateHash = stableDesiredStateHash(orderedActions, desiredStatePieceByAction);
    /*
      Agent 报上来的「已执行的期望状态摘要」和这一份对不上：它手里不是最新的。常见的是摘要里含
      knownRunning，规则 / 隧道刚跑起来那一下摘要就变了，可动作内容（下发签名）没变，不会重发；
      也可能是上一份推送丢了。稳定快路径要求两边摘要一致，对不上就一直走完整对账、一直对不上。
      所以 Agent 落后时也重发一份，和有待办时一样最多 60 秒一次。
    */
    const agentBehindDesiredState = !!agentLastAppliedHash
      && agentLastAppliedHash.toLowerCase() !== desiredStateHash;
    const sendDesiredState = !deferActionsForLocalState
      && shouldSendDesiredState(Number(host.id), orderedActions, activeWorkActions, responseIssuedAt, configRevision, agentBehindDesiredState);
    if (sendDesiredState) {
      for (const action of orderedActions) {
        const statusKey = agentStatusOrderingKey(Number(host.id), action);
        // 内容没变的原样重发不抬高期望：Agent 对上一份的结果仍然算数（见 AgentActionIssueTracker）。
        if (!agentActionIssueTracker.shouldExpect(statusKey, stableActionSignatureHash([action]), responseIssuedAt)) continue;
        agentStatusOrderGuard.expect(statusKey, action.issuedAt, responseIssuedAt);
      }
    }
    const desiredState = sendDesiredState ? {
      version: 1,
      issuedAt: actionBatchIssuedAt,
      configRevision,
      configHash: desiredStateHash,
      actions: orderedActions,
    } : undefined;
    /*
      这台是隧道出口时，把调度器和出口桥守卫实际用的端口记到 server/tunnelExitPorts：这两个端口由入口
      替出口填，得按出口自己分到的来。端口有变化（包括出口升级、降级后调度器出现或没了）就推这些隧道的
      入口（含入口组的成员）马上重算，不等 5 分钟一次的核对。
    */
    const planTunnelExitPortsAndSniResult = planTunnelExitPortsAndSni({ runningRules, tunnelById, isForwardXTunnel, tunnelEntryHostIds, guardRules, tunnelEgressHelpers, host, effectiveAgentVersion, hostTlsInbounds, rules, gostBalancePlans });
    const { sniInbounds } = planTunnelExitPortsAndSniResult;
    const stateSections = buildAgentStateResponseSections({
      runningRules,
      ruleLatencyProbes,
      tunnelProbes,
      forwardGroupProbes,
      hostProbeServices,
      guardRules,
      dnsWatch: Array.from(dnsWatches.values()),
      sniInbounds,
    }, agentStateSignatures);
    const probeStateRefreshed = ["runningRules", "ruleLatencyProbes", "tunnelProbes", "forwardGroupProbes", "hostProbeServices"]
      .some((name) => Object.prototype.hasOwnProperty.call(stateSections.payload, name));
    // 有 SSE 长连接时立即将 desiredState + runningRules 推送给 Agent，
    // 无需等待下一个心跳周期即可执行转发规则变更。
    // heartbeat response 里仍携带 desiredState 作为兜底（SSE 断开时的最终一致保证）。
    if (desiredState) {
      if (agentDesiredDispatchAuditHash.get(Number(host.id)) !== desiredState.configHash) {
        setBoundedMapValue(agentDesiredDispatchAuditHash, Number(host.id), desiredState.configHash, AGENT_HOST_CACHE_MAX);
        void recordConfigAuditEvent({
          resourceType: "runtime",
          resourceId: Number(host.id),
          hostId: Number(host.id),
          action: "dispatch",
          source: "system:desired-state",
          after: { configRevision, configHash: desiredState.configHash, actionCount: orderedActions.length },
        });
      }
      pushAgentDesiredState(Number(host.id), {
        desiredState,
        runningRules,
        ruleLatencyProbes,
        stateSignatures: {
          runningRules: stateSections.signatures.runningRules,
          ruleLatencyProbes: stateSections.signatures.ruleLatencyProbes,
        },
      });
    }
    const metricsWatching = isHostMetricsWatching(host.id);
    const stablePlanReady = !!localRuntimeState.state
      && !!localRuntimeStateSignature
      && !localRuntimeState.requestLocalState
      && activeWorkActions.length === 0
      && selfTests.length === 0
      && lookingGlassTests.length === 0
      && diagnosticsTasks.length === 0
      && ruleConnectionTasks.length === 0
      && iperf3Tasks.length === 0
      && pluginTasks.length === 0
      && !hasPendingPluginTasks
      && !pluginSyncActionQueued
      && !agentUpgrade
      && !panelMigration
      && !forceTcping
      && !hasPendingMultiHopRuntime;
    if (stablePlanReady) {
      agentStableHeartbeatPlanCache.remember(host.id, {
        plannedAt: responseIssuedAt,
        configRevision,
        desiredStateHash,
        localStateSignature: localRuntimeStateSignature,
        stateSignatures: stateSections.signatures,
        agentVersion: effectiveAgentVersion,
        agentBootId,
        agentProcessStartedAt: agentProcessStartedAtSeconds,
        defaultNetworkInterface: reportedDefaultNetworkInterface,
        pluginInventorySignature,
        mimicEnvironmentSignature,
        idleNextInterval: selectAgentHeartbeatInterval({
          requestLocalState: false,
          hasInteractiveTasks: false,
          metricsWatching: false,
          serviceProbeIntervals: hostProbeServices.map((service: any) => service?.intervalSeconds),
        }),
        panelUrl,
      });
    } else {
      agentStableHeartbeatPlanCache.invalidate(host.id);
    }
    const pendingApplyCount = activeWorkActions.filter((action: any) => action?.op === "apply").length;
    const pendingRemoveCount = activeWorkActions.filter((action: any) => action?.op === "remove").length;
    logAgentHeartbeatSummary({
      hostId: logHostId,
      hostName: logHostName,
      expectedRules: runningRules.length,
      reportedRules: reportedLocalRules.length,
      reportedServices: reportedRuntimeServices.length,
      actions: orderedActions.length,
      pendingApply: pendingApplyCount,
      pendingRemove: pendingRemoveCount,
      recoveryPending: recoveryWasInProgress && (pendingApplyCount > 0 || localRuntimeState.requestLocalState),
      requestLocalState: localRuntimeState.requestLocalState,
      stable: stablePlanReady,
      runtimeDrift: new Set(runtimeDriftedRuleIds).size,
      metricsWatching,
      nextInterval,
      interactiveTasks: hasInteractiveTasks ? (
        lookingGlassTests.length
        + diagnosticsTasks.length
        + ruleConnectionTasks.length
        + iperf3Tasks.length
        + pluginTasks.length
        + (hasPendingPluginTasks ? 1 : 0)
        + (forceTcping ? 1 : 0)
        + (hasPendingMultiHopRuntime && !hasTunnelApplyActions ? 1 : 0)
      ) : 0,
    });
    res.json({
      success: true,
      actions: [],
      desiredState,
      selfTests,
      ...stateSections.payload,
      stateSignatures: stateSections.signatures,
      lookingGlassTests,
      ...(diagnosticsTasks.length > 0 ? { diagnosticsTasks } : {}),
      ...(ruleConnectionTasks.length > 0 ? { ruleConnectionTasks } : {}),
      iperf3Tasks,
      pluginTasks,
      ...(mimicInstallTask ? { mimicInstallTask } : {}),
      agentUpgrade,
      panelUrl,
      panelMigration,
      forceTcping: forceTcping || probeStateRefreshed,
      nextInterval,
      requestLocalState: localRuntimeState.requestLocalState,
      compactReports: true,
      presenceSupported: true,
      metricsOnly: metricsWatching
        && !hasInteractiveTasks
        && !localRuntimeState.requestLocalState
        && activeWorkActions.length === 0,
      ...(metricsWatching ? { trafficReportInterval: 10 } : {}),
    });
  } catch (error) {
    console.error(`[Agent Heartbeat] Error host=${logHostId || "-"} name=${logHostName || "-"}:`, error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    releaseHeartbeatReconciliation?.();
  }
});

// Agent 规则状态回调

}
