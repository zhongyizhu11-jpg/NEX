import { Router, Request, Response } from "express";
import { parseFailoverTargets } from "../shared/failoverTargets";
import { loadAverageToStored, parseAgentLoadAverage } from "../shared/hostLoadAverage";
import {
  routeDeliveryStrategy,
  routeDestSpreadReady,
  normalizeRouteDelivery,
  routeGroupForwardTypeSupported,
  routeGroupOf,
  routePathDial,
  routePathsOf,
} from "../shared/routeGroup";
import { normalizeForwardGroupHealthCheckMethod } from "../shared/forwardGroupHealthCheck";
import { noteRouteFirstHops, routeHopDownHints, routeNodeHints } from "./routeGroupStats";
import { withRouteDrillHints } from "./routeDrill";
import { buildRouteFailoverTargets } from "./routeTargetHints";
import { ensureRouteNodeHealthFresh, getRouteNodeStatus } from "./routeNodeHealth";
import { tunnelLinkShaping, hostEgressShaping } from "./tunnelFxpRuntime";
import { ingestFailoverLineReports } from "./failoverLineReports";
import { claimTunnelExitReportRequest, hasTunnelExitPort, loadTunnelExitPorts, recordTunnelExitPorts, tunnelExitPortFor, type TunnelExitPortEntry } from "./tunnelExitPorts";
import * as db from "./db";
import { classifyHeartbeatAgentDistribution, NEX_AGENT_DISTRIBUTION, normalizeAgentDistribution } from "../shared/agentDistribution";
import { isForwardxAgentMigrationEnabled, markForwardxAgentMigrationQueued, shouldQueueForwardxAgentMigration } from "./forwardxAgentMigration";
import { getIpChangeProbeTasksForHost, hasPendingIpChangeProbeDelivery } from "./ipChange/runtime";
import { AGENT_VERSION } from "./_core/systemRouter";
import { clearHostTcpingRequest, hasHostTcpingRequest, isHostMetricsWatching, pushAgentDesiredState, pushAgentRefresh } from "./agentEvents";
import { getEnabledProxyInboundsWithUsersByHost } from "./repositories/proxyInboundRepository";
import { buildSingboxRuntimePlan } from "./singboxRuntimePlan";
import { buildVlessEgressBridgePlan, collectVlessEgressBridges, planVlessEgressBridgePorts } from "./vlessEgress";
import { isVlessEgressAgentSupported } from "../shared/vlessEgress";
import { singboxAssetRelayBase } from "./singboxAssets";
import { resolveHostInboundRoutes } from "./inboundRoutingRuntime";
import {
  PROXY_INBOUND_TRAFFIC_FORWARD_TYPE,
  proxyInboundTrafficProtocol,
  proxyInboundTrafficRuleId,
} from "../shared/proxyInboundTraffic";
import { buildMetaAgentSelfTestPayload, buildRuleAgentSelfTestPayload, hasAgentVersionChanged, isAgentUpgradeCompleted, normalizeReportedFxpVersion, parseSelfTestMeta, tunnelSecretSeed } from "./agentRouteUtils";
// 主机可以单独指定 Agent 连哪个面板地址（server/hostAgentPanelUrl.ts），没指定时就是全局的公开地址。
import { resolveHostAgentAdvertisedPanelUrl } from "./hostAgentPanelUrl";
import { getAgentMigrationSwitchTarget, getPanelMigrationAgentDirective } from "./panelMigrationAgentState";
import * as hopRepo from "./repositories/tunnelRepository";
import {
  getForwardProtocolSettings,
  isRuleProtocolEnabled,
  isTunnelProtocolEnabled,
} from "./forwardProtocolSettings";
import {
  agentHeartbeatGate,
  agentStableHeartbeatPlanCache,
  AGENT_METRICS_WATCH_INTERVAL_SECONDS,
  buildBusyAgentHeartbeatResponse,
  buildPresenceAgentHeartbeatResponse,
  buildReportedRuntimeHeartbeatPatch,
  selectAgentHeartbeatInterval,
  shouldPersistAgentPresence,
} from "./agentHeartbeatGate";
import { mapWithConcurrency } from "./asyncPool";
import { portAccessLimitAction, portAccessLimitSpecs, readPortAccessLimitsEnabled, resolvePortAccessLimitAction } from "./portAccessLimits";
import { ruleLimitRootId } from "./ruleLimits";
import { anomalyAwareRuleMbps } from "./ops/trafficAnomalyThrottles";
import { getHostWireGuardPlane, getTunnelRuntimeGeneration, isTunnelRuntimeHostReady } from "./tunnelRuntimeStatus";
import { appendPanelLog } from "./_core/panelLogger";
import { isIP } from "net";
import { hasQueuedLookingGlassAgentTasks, takeLookingGlassAgentTasks } from "./lookingGlassAgentTasks";
import { hasQueuedDiagnosticsAgentTasks, hasRunningDiagnosticsAgentTasks, takeDiagnosticsAgentTasks } from "./diagnosticsAgentTasks";
import { hasQueuedRuleConnectionsTasks, hasRunningRuleConnectionsTasks, takeRuleConnectionsTasks } from "./ruleConnectionsAgentTasks";
import { hasQueuedIperf3AgentTasks, takeIperf3AgentTasks } from "./iperf3AgentTasks";
import { hasQueuedPluginAgentTasks, takePluginAgentTasks } from "./pluginAgentTasks";
import { hasPendingMimicInstallTask, hasQueuedMimicInstallTask, takeMimicInstallTask } from "./mimicInstallTasks";
import { getAgentPluginInventory, updateAgentPluginInventory } from "./agentPluginInventory";
import { getAgentHostFromRequest, getAgentHostIdentityFromRequest, getAgentPresenceHostFromRequest } from "./agentAuth";
import { isHostLiveFocused, liveMetricsIntervalFor, liveSampleFromCompactMetrics, recordHostLiveSample } from "./hostLiveMetrics";
import { normalizeAgentText, normalizeNetworkInterface } from "./agentInputValidation";
import { setBoundedMapValue } from "./boundedCache";
import { onHostDeleted, onRuleDeleted } from "./entityCleanup";
import { ignoreErrorWith } from "./ignoredError";
import { mergeAgentReportedAddress, observedAgentAddress } from "./agentAddressState";
import { hostEgressAddress, recordHostObservedAddress, type HostEgressSource } from "./hostObservedAddress";
import { noteAgentPrivateIpv4 } from "./agentPrivateAddress";
import {
  gostTunnelTransportType,
  shouldReconcileGostRuntime,
  shouldReconcileNginxRuntime,
  tunnelExitRuntimeForwardType,
  tunnelHopRuntimeForwardType,
  tunnelRuleRuntimeForwardType,
  tunnelRuntimeFamily,
} from "./tunnelRuntimePlan";
import { effectiveTunnelProxyProtocolOptions, gostProxyProtocolMetadata, gostTunnelProxyProtocolPlan, resolveRuleProxyProtocolOptions } from "./gostProxyProtocol";
import { planGostTunnelRuleProtocol } from "./gostTunnelProtocol";
import {
  buildCountingChainCmds,
  buildCountingCleanupCmds,
  buildKernelForwardTransitionCleanupCmds,
  buildEntryBridgeConntrackFlushCmds,
  buildIptablesForwardCleanupCmds,
  buildManagedPortCleanupCmds,
  buildNftCleanupCmds,
  buildKernelForwardCmds,
  gostRuntimeApiConfig,
  gostRuntimeApiExecStart,
  restartManagedServiceIfConfigChangedCmd,
  restartMimicServiceIfConfigChangedCmd,
  shQuote,
  syncGostServiceIfConfigChangedCmd,
  startManagedServiceCmd,
  stopManagedServiceCmd,
} from "./agentActionCommands";
import {
  REALM_CONFIG_DIR,
  buildRealmConfigToml,
  buildRealmServiceUnit,
  buildSocatServiceUnit,
  cleanEndpointHost,
  endpointHostPort,
  realmConfigPathForPort,
  realmServiceNameForPort,
  realmTomlString,
  SOCAT_TRANSFER_BUFFER_FLAG,
  socatDialAddress,
  socatSocketOptions,
  socatServiceNameForPort,
} from "./forwardRuntimeConfigs";
import { handleHostAddressChanged, hostIngressAddress } from "./hostAddressRuntime";
import { syncHostDetectedAddressesSafely } from "./hostPublicAddressSync";
import { isHostStatusOnline, notifyHostOnlineIfNeeded } from "./hostStatusNotifier";
import { buildPluginHostAssetSyncActions } from "./repositories/pluginRepository";
import {
  forwardRuleProtocols,
  isForwardRuleProtocolTcpEnabled,
  isForwardRuleProtocolUdpEnabled,
  normalizeForwardRuleProtocol,
} from "@shared/forwardTypes";
import {
  buildForwardXWireGuardMimicFilters,
  isForwardXWireGuardV2,
  type ForwardXWireGuardNodePlan,
} from "./forwardXWireGuard";
import { forwardXV3SpecFields, isForwardXV3Tunnel } from "@shared/forwardXV3";
import { agentActionIssueTracker, agentStatusOrderGuard, agentStatusOrderingKey } from "./agentStatusOrdering";
import { forwardGroupProbeTopologyKey, tunnelProbeTopologyKey } from "./probeTopology";
import { resolveRuleTrafficPortForHost } from "./agentRuntimeRuleState";
import { isTunnelRelayAggregate, isTunnelRelayFailover, isTunnelRelayHotStandby, tunnelRelayCandidates, tunnelRelayUsesParallelRelays } from "@shared/tunnelRelay";
import {
  buildParallelStreamLegs,
  normalizeTunnelParallelStreams,
  tunnelParallelStreamsUnavailableReason,
} from "@shared/tunnelParallelStreams";
import { exitGroupCapacities, exitGroupWeights, normalizeExitGroupStrategy } from "@shared/exitStrategy";
import { hostBandwidthHintMbps } from "@shared/linkWeights";
import { hostIpv6ListenAvailable, parseReportedIpv6Listen } from "@shared/hostIpv6Listen";
import { ensureLandingNodeHosts, recordHostLoadSample } from "./hostLoad";
import { recordHostRateSample } from "./hostRateBuckets";
import { forwardXExitStrategy } from "./tunnelExitStrategy";
import {
  getMimicLifecycleRevisionSignature,
  latestConfigRevision,
  recordConfigAuditEvent,
  type MimicLifecycleResource,
} from "./configAudit";
import { approveMimicInterfaceRemovals } from "./mimicRemovalGuard";
import { mimicRuntimeLifecycles } from "./mimicRuntimeLifecycle";
import { buildTunnelRuleLatencyProbe } from "./ruleLatency";
import { selectTunnelDialAddress, selectTunnelHopDialAddress } from "./tunnelAddressSelection";
import {
  normalizeAgentLocalRuntimeState,
  normalizeAgentStateSignatures,
  normalizeMimicEnvironment,
  normalizeRuntimeStateSignature,
  stableStateSignature,
  type AgentLocalRuntimeRuleState,
  type AgentLocalRuntimeServiceState,
  type AgentLocalRuntimeTunnelState,
} from "./agentHeartbeatReport";
import { stableActionSignatureHash, stableDesiredStateHash, withDesiredStateConfigHash } from "./agentDesiredStateHash";
// 这几个以前直接从本文件导出，测试和别的模块还按老路径引用。
export { stableStateSignature, stableDesiredStateHash, withDesiredStateConfigHash };
import { createResolvedTargetGate } from "./ruleTargetPolicy";
import { buildForwardXMimicConfig } from "./mimicConfig";
import { gateForwardRulesForRuntime } from "./linkAccessView";
import { getTrafficExcludedHostIds } from "./hostTrafficPolicy";
import { groupRuleTrafficBlocked, planTunnelTrafficParticipation } from "./hostTrafficRuntimePlan";
import { isEntryBridgeRuntimeRule, loadEntryBridgeRuntimeRules, markRuntimeRulesNotRunning, setRuntimeRuleRunning } from "./ruleEntryBridges";
import { isEntryBridgeRuleId } from "../shared/ruleEntryBridge";
import { observePresenceCapableHostActivity, registerPresenceCapableHost } from "./agentFastLiveness";
import { recordAuthenticatedAgentActivity } from "./agentActivity";
import { recordHostRestartEvent } from "./ops/eventHooks";
import { observeHostHealthCounters, observeHostResourceSample } from "./resourceAlertNotifier";
import { buildForwardRateTiers, forwardRateTiersForAgent, mbpsToBytesPerSecond, strictestForwardRate } from "../shared/forwardRateLimit";
import { isSniRuntimeRule, planAgentSniInbounds, recordTlsInboundRuntimeStatus, sniRuleRuntimeView } from "./tlsInboundRuntime";
import { recordAgentRuntimeStats } from "./ops/agentRuntime";
import { evaluateRuleEgress, loadEgressRuntimeContext, ruleEgressRuntimeView, tunnelEgressDialHostIdsOf } from "./ssEgress";
import { normalizeRuleEgressType, parseAgentCapabilities, ruleEgressStateBlocksDelivery } from "../shared/ssEgress";
import { hostSupportsGostApiSync } from "../shared/gostRuntimeApi";
import {
  AGENT_DYNAMIC_CACHE_MAX,
  AGENT_HOST_CACHE_MAX,
  AGENT_ORPHAN_REMOVE_MIN_STREAK,
  agentDesiredDispatchAuditHash,
  agentOrphanPortStreakCache,
  dnsRuntimeGenerations,
  forgetAgentHeartbeatHost,
  forgetAgentHeartbeatRule,
  fxpEndpointStatusCache,
  fxpUdpTargetSignatureCache,
  invalidateAgentDesiredStateCache,
  pruneAgentHeartbeatCaches,
  resolvedIpCache,
} from "./agentHeartbeatState";
import {
  addDnsWatch,
  type AgentDnsWatch,
  buildDnsChangeCleanup,
  buildForwardTargetCleanup,
  expireSharedResolvedIp,
  failoverProxyHandlesTargetDns,
  resolveTargetIpCached,
} from "./agentHeartbeatDns";
import {
  forwardXUDPTargetAddress,
  getSingboxAccelerator,
  isForwardXTunnelMode,
  isGostTunnelMode,
  legacyRealmCleanupCmds,
  legacySocatCleanupCmds,
  MIMIC_CONFIG_DIR,
  mimicFilterEndpoint,
  RUNTIME_BIN,
  RUNTIME_CONFIG_PATH,
  RUNTIME_SERVICE_NAME,
  runtimeBool,
  selectForwardChainListenerPort,
  SHARED_GOST_FORWARD_TYPES,
  SHARED_RUNTIME_NOFILE,
  TUNNEL_RUNTIME_SERVICE_NAME,
  udpOverTcpEnabled,
} from "./agentHeartbeatRuntime";
import {
  isNginxTunnelMode,
  NGINX_SERVICE_NAME,
  nginxRuntimeVerifyCmd,
  SHARED_NGINX_FORWARD_TYPES,
} from "./agentHeartbeatNginx";
import {
  allocateProtocolGuardPorts,
  cleanupGuardBackendCmds,
  hasProtocolPolicy,
  PROTOCOL_GUARD_LEGACY_SPAN,
  PROTOCOL_GUARD_PORT_MAX,
  PROTOCOL_GUARD_PORT_MIN,
  protocolPolicyFromHost,
  realmGuardConfigPathForPort,
  selectProtocolGuardProxyProtocol,
  selectProtocolGuardRateLimit,
  shouldReconcileProtocolGuardBackend,
  shouldUseProcessBackendGuard,
  shouldUseProtocolGuard,
} from "./agentHeartbeatProtocolGuard";
import { buildAccessLimitCleanupCmds, buildAccessLimitCmds } from "./agentHeartbeatAccessLimits";
import type { HeartbeatRequestContext, TunnelEgressHelper } from "./agentHeartbeatContext";
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
import {
  actionMayAffectRuntimeFamily,
  AGENT_PLUGIN_SYNC_RESEND_MS,
  dropStalePortRemoveActions,
  isTunnelApplyBlockingProbe,
  resolveActionBatchIssuedAt,
  ruleRuntimeIdentityKey,
  ruleRuntimePortIdentityKey,
  runtimePortProtocolKey,
  runtimeSyncReconcileDue,
  shouldSendDesiredState,
  shouldSendPluginSyncAction,
  shouldSendRuntimeSyncAction,
} from "./agentHeartbeatDispatch";
import {
  agentPluginInventorySignature,
  buildAgentStateResponseSections,
  getOrphanPortStreaks,
  isKernelForwardRule,
  resolveAgentLocalRuntimeState,
  settleStoppedRule,
} from "./agentHeartbeatLocalState";
import {
  heartbeatIndicatesAgentReboot,
  heartbeatTimestampMs,
  resetAgentRuntimeStateForRecovery,
} from "./agentHeartbeatRecovery";
import {
  compactMimicFiltersForLog,
  logAgentHeartbeatSummary,
  shouldLogAgentRuntimeDrift,
  shouldLogMimicRuntimePlan,
} from "./agentHeartbeatLogging";
import { isPortRangeRule, ruleSourcePortEnd } from "@shared/portRange";
import { portRangeAgentUnsupportedReason } from "./rulePortRange";
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
const AGENT_RUNTIME_SYNC_REPAIR_RESEND_MS = 60 * 1000;
const AGENT_GOST_RUNTIME_RECONCILE_MS = 5 * 60 * 1000;
const AGENT_NGINX_RUNTIME_RECONCILE_MS = 5 * 60 * 1000;
const AGENT_MIMIC_RUNTIME_RECONCILE_MS = 5 * 60 * 1000;
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
        return;
      }
    }
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
    const localRuntimeState = resolveAgentLocalRuntimeState(
      Number(host.id),
      localRuntimeStateSignature,
      normalizeAgentLocalRuntimeState(req.body?.localState),
    );
    const mimicEnvironment = normalizeMimicEnvironment(req.body?.mimicEnvironment);
    // 共享 TLS 入站的监听状态随心跳带上来（不另开上报路径），只存内存，主机详情里显示。
    if (Array.isArray(req.body?.sniInbounds)) recordTlsInboundRuntimeStatus(Number(host.id), req.body.sniInbounds);
    // Agent 进程自己的运行状况（内存 / 协程 / GC / UDP 会话 / AES），同样只存内存（ops/agentRuntime.ts）。
    recordAgentRuntimeStats(Number(host.id), req.body?.agentRuntime);
    const fxpEndpointEvents = Array.isArray(req.body?.fxpEndpointEvents) ? req.body.fxpEndpointEvents.slice(0, 256) : [];
    for (const rawEvent of fxpEndpointEvents) {
      const tunnelId = Math.max(0, Math.floor(Number(rawEvent?.tunnelId || 0)));
      const ruleId = Math.max(0, Math.floor(Number(rawEvent?.ruleId || 0)));
      const role = normalizeAgentText(rawEvent?.role, 16) || "unknown";
      const endpoint = normalizeAgentText(rawEvent?.endpoint, 256);
      const status = normalizeAgentText(rawEvent?.status, 16);
      if (!endpoint || (status !== "unhealthy" && status !== "recovered")) continue;
      const key = `${host.id}:${role}:${tunnelId}:${ruleId}:${endpoint}`;
      if (fxpEndpointStatusCache.get(key) === status) continue;
      setBoundedMapValue(fxpEndpointStatusCache, key, status, AGENT_DYNAMIC_CACHE_MAX);
      const startedAt = Number(rawEvent?.startedAt || 0);
      const occurredAt = Number(rawEvent?.occurredAt || 0);
      const durationMs = status === "recovered" && startedAt > 0 && occurredAt >= startedAt ? occurredAt - startedAt : 0;
      const message = normalizeAgentText(rawEvent?.message, 512);
      appendPanelLog(
        status === "unhealthy" ? "warn" : "info",
        `[FXPEndpoint] host=${host.id} role=${role} tunnel=${tunnelId} rule=${ruleId} endpoint=${endpoint} status=${status}${durationMs > 0 ? ` durationMs=${durationMs}` : ""}${message ? ` message=${message}` : ""}`,
      );
    }
    const reportedMimicRuntimeServices = (localRuntimeState.state?.services || [])
      .filter((service) => String(service.name || "").startsWith("mimic@"));
    const mimicRuntimeStatus = reportedMimicRuntimeServices.length === 0
      ? "not-configured"
      : reportedMimicRuntimeServices.some((service) => !service.active)
        ? "unavailable"
        : reportedMimicRuntimeServices.some((service) => service.connectionState === "established")
          ? "established"
          : reportedMimicRuntimeServices.some((service) => service.connectionState === "connecting")
            ? "connecting"
            : reportedMimicRuntimeServices.some((service) => service.connectionState === "waiting")
              ? "waiting"
              : reportedMimicRuntimeServices.some((service) => service.connectionState === "idle")
                ? "idle"
                : "active";
    const mimicRuntimeMessage = reportedMimicRuntimeServices
      .map((service) => `${service.name}:${service.status || (service.active ? "active" : "unavailable")}${service.hooksReady === false ? ":hooks-not-detected" : ""}${service.message ? `:${service.message}` : ""}`)
      .join(" | ") || null;
    const dnsChangedIpByHost = new Map<string, string>();
    const dnsChangedScopes = new Set<string>();
    const dnsChangedTokenByScope = new Map<string, string>();
    for (const report of dnsChangedReports) {
      const name = String(report?.host || "").trim().toLowerCase();
      const scope = String(report?.scope || "").trim();
      const refId = Number(report?.refId || 0);
      const nextIps = (Array.isArray(report?.new) ? report.new : [])
        .map((value: unknown) => String(value || "").trim())
        .filter((value: string) => !!value && isIP(value))
        .sort();
      const nextIp = nextIps[0];
      if (name && nextIp) dnsChangedIpByHost.set(name, nextIp);
      if (scope) {
        const key = `${scope}:${Number.isFinite(refId) && refId > 0 ? refId : 0}`;
        dnsChangedScopes.add(key);
        dnsChangedTokenByScope.set(key, `${name}:${nextIps.join(",")}`);
      }
    }
    const addressChanged = [
      ["ip", reportedAddress.ip],
      ["ipv4", reportedAddress.ipv4],
      ["ipv6", reportedAddress.ipv6],
    ].some(([key, value]) => String(value || "") !== String((host as any)[key as string] || ""));
    const recoveredFromOffline = wasOnline === false;
    const rebootDetected = heartbeatIndicatesAgentReboot(previousHost, uptime, agentBootId);
    const previousProcessStartedAt = heartbeatTimestampMs(previousHost.agentProcessStartedAt);
    const processIdChanged = agentProcessId > 0
      && Number(previousHost.agentProcessId || 0) > 0
      && agentProcessId !== Number(previousHost.agentProcessId || 0);
    const processStartChanged = previousProcessStartedAt > 0
      && agentProcessStartedAtSeconds > 0
      && agentProcessStartedAtSeconds * 1000 !== previousProcessStartedAt;
    // boot_id identifies the host, not the Agent process. A quick systemd
    // restart can keep the same boot_id and even the same Unix second; the PID
    // change is the primary signal, with start time as the PID-reuse fallback.
    const processRestartDetected = processIdChanged || processStartChanged;
    const recoveryTriggered = recoveredFromOffline || rebootDetected || processRestartDetected;
    const effectiveAgentVersion = nextAgentVersion || String((host as any).agentVersion || "");

    const busyHeartbeatHostStateChanged = !wasOnline
      || recoveryTriggered
      || addressChanged
      || agentVersionChanged
      || fxpVersionChanged
      || agentDistributionChanged
      || capabilitiesChanged
      || runtimeVersionChanged
      || ipv6ListenStoredChanged
      || (!!nextCpuInfo && nextCpuInfo !== String(previousHost.cpuInfo || ""))
      || (Number(memoryTotal || 0) > 0 && Number(memoryTotal) !== Number(previousHost.memoryTotal || 0))
      || (!!agentBootId && agentBootId !== normalizeAgentText(previousHost.agentBootId, 128))
      || (agentProcessId > 0 && agentProcessId !== Number(previousHost.agentProcessId || 0))
      || (agentProcessStartedAtSeconds > 0 && Math.abs(agentProcessStartedAtSeconds * 1000 - previousProcessStartedAt) > 5_000)
      || (agentLastReceivedRevision > 0 && agentLastReceivedRevision !== Number(previousHost.agentLastReceivedRevision || 0))
      || (agentLastAppliedRevision > 0 && agentLastAppliedRevision !== Number(previousHost.agentLastAppliedRevision || 0))
      || (!!agentLastReceivedHash && agentLastReceivedHash !== String(previousHost.agentLastReceivedHash || ""))
      || (!!agentLastAppliedHash && agentLastAppliedHash !== String(previousHost.agentLastAppliedHash || ""))
      || (!!mimicEnvironment && (
        previousHost.mimicAvailable !== mimicEnvironment.available
        || String(previousHost.mimicStatus || "") !== mimicEnvironment.status
        || String(previousHost.mimicVersion || "") !== String(mimicEnvironment.version || "")
        || String(previousHost.mimicMessage || "") !== String(mimicEnvironment.message || "")
      ));
    if (busyHeartbeat && !busyHeartbeatHostStateChanged) {
      if (shouldPersistAgentPresence({ wasOnline, lastHeartbeat: previousHost.lastHeartbeat })) {
        await db.touchHostHeartbeat(host.id);
      }
    } else await db.updateHostHeartbeat(host.id, {
      agentVersion: nextAgentVersion || (host as any).agentVersion || null,
      ...(nextFxpVersion ? { fxpVersion: nextFxpVersion } : {}),
      ...(agentDistributionChanged ? { agentDistribution: reportedAgentDistribution } : {}),
      ...(reportedCapabilities !== null ? { agentCapabilities: reportedCapabilities } : {}),
      ...(reportedRuntimeVersion !== null ? { runtimeVersion: reportedRuntimeVersion || null } : {}),
      ...(ipv6ListenStoredChanged ? { ipv6ListenAvailable: reportedIpv6Listen } : {}),
      cpuInfo: nextCpuInfo || (host as any).cpuInfo || null,
      memoryTotal: memoryTotal || (host as any).memoryTotal || null,
      ...(agentBootId ? { agentBootId } : {}),
      ...(agentBootedAtSeconds > 0 ? { agentBootedAt: new Date(agentBootedAtSeconds * 1000) } : {}),
      ...(agentProcessId > 0 ? { agentProcessId } : {}),
      ...(agentProcessStartedAtSeconds > 0 ? { agentProcessStartedAt: new Date(agentProcessStartedAtSeconds * 1000) } : {}),
      ...(agentLastReceivedRevision > 0 ? { agentLastReceivedRevision } : {}),
      ...(agentLastAppliedRevision > 0 ? { agentLastAppliedRevision } : {}),
      ...(agentLastReceivedHash ? { agentLastReceivedHash } : {}),
      ...(agentLastAppliedHash ? { agentLastAppliedHash } : {}),
      ...buildReportedRuntimeHeartbeatPatch({
        hasLocalRuntimeState: !!localRuntimeState.state,
        mimicRuntimeStatus,
        mimicRuntimeMessage,
      }),
      ...(recoveryTriggered ? {
        agentRecoveryStartedAt: new Date(),
        agentRecoveryCompletedAt: null,
        agentRecoveryExpected: 0,
        agentRecoveryReady: 0,
      } : {}),
      ...(mimicEnvironment ? {
        mimicAvailable: mimicEnvironment.available,
        mimicVersion: mimicEnvironment.version,
        mimicStatus: mimicEnvironment.status,
        mimicMessage: mimicEnvironment.message,
        mimicCheckedAt: new Date(),
      } : {}),
    } as any);
    // 地址单独写、带条件：用户刚好在这次心跳期间手改了地址时不盖掉它（见 applyAgentReportedHostAddress）
    const addressApplied = addressChanged && await db.applyAgentReportedHostAddress(host.id, reportedAddress);
    if (addressApplied) Object.assign(host as any, reportedAddress);
    // Agent 2.2.255+ 上报的网卡全部公网地址（没带就不动），见 hostPublicAddressSync
    await syncHostDetectedAddressesSafely(host, req.body);
    if (agentDistributionChanged) {
      appendPanelLog(
        "info",
        `[AgentUpgrade] host=${host.id} distribution=${String(host.agentDistribution || "-")} -> ${reportedAgentDistribution}`,
      );
      host.agentDistribution = reportedAgentDistribution;
    }
    if (fxpVersionChanged) {
      appendPanelLog(
        "info",
        `[AgentUpgrade] host=${host.id} fxp=${String(previousHost.fxpVersion || "-")} -> ${nextFxpVersion}`,
      );
      (host as any).fxpVersion = nextFxpVersion;
    }
    if (capabilitiesChanged || runtimeVersionChanged) {
      appendPanelLog(
        "info",
        `[AgentUpgrade] host=${host.id} runtime=${String(previousHost.runtimeVersion || "-")} -> ${reportedRuntimeVersion ?? String(previousHost.runtimeVersion || "-")} capabilities=${parseAgentCapabilities(previousHost.agentCapabilities).join(",") || "-"} -> ${parseAgentCapabilities(reportedCapabilities ?? previousHost.agentCapabilities).join(",") || "-"}`,
      );
      if (reportedCapabilities !== null) (host as any).agentCapabilities = reportedCapabilities;
      if (reportedRuntimeVersion !== null) (host as any).runtimeVersion = reportedRuntimeVersion || null;
      if (capabilitiesChanged && !agentVersionChanged) {
        invalidateAgentDesiredStateCache(host.id, { preserveLocalRuntimeState: !!localRuntimeState.state });
      }
    }
    if (ipv6ListenStoredChanged) {
      host.ipv6ListenAvailable = reportedIpv6Listen;
      if (ipv6ListenEffectiveChanged) {
        appendPanelLog("info", `[AgentHost] host=${host.id} ipv6Listen=${reportedIpv6Listen}; realm/socat/nginx listeners switch to ${reportedIpv6Listen ? "dual-stack [::]" : "IPv4 0.0.0.0"}`);
        if (!agentVersionChanged) invalidateAgentDesiredStateCache(host.id, { preserveLocalRuntimeState: !!localRuntimeState.state });
      }
    }
    if (agentVersionChanged) {
      invalidateAgentDesiredStateCache(host.id, { preserveLocalRuntimeState: !!localRuntimeState.state });
      appendPanelLog(
        "info",
        `[AgentUpgrade] host=${host.id} version=${String(previousHost.agentVersion || "-")} -> ${nextAgentVersion}; desired state marked for resync`,
      );
    }
    if (mimicEnvironment) {
      Object.assign(host as any, {
        mimicAvailable: mimicEnvironment.available,
        mimicVersion: mimicEnvironment.version,
        mimicStatus: mimicEnvironment.status,
        mimicMessage: mimicEnvironment.message,
        mimicCheckedAt: new Date(),
      });
      if (
        previousHost.mimicAvailable !== mimicEnvironment.available
        || String(previousHost.mimicStatus || "") !== mimicEnvironment.status
        || String(previousHost.mimicVersion || "") !== String(mimicEnvironment.version || "")
      ) {
        appendPanelLog(
          mimicEnvironment.available ? "info" : "warn",
          `[Mimic] environment host=${host.id} name=${String((host as any).name || "-")} available=${mimicEnvironment.available} status=${mimicEnvironment.status} version=${mimicEnvironment.version || "-"}${mimicEnvironment.message ? ` message=${mimicEnvironment.message}` : ""}`,
        );
      }
    }
    if (recoveredFromOffline) {
      void notifyHostOnlineIfNeeded(host).catch((error) => {
        console.warn(`[HostStatus] Online notify failed host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (addressApplied) {
      await handleHostAddressChanged(host.id, host, previousHost, "agent-address-changed");
    }
    // 事件时间线：机器重启 / Agent 重启（含升级后的重启）
    recordHostRestartEvent(host, { reboot: rebootDetected, processRestart: processRestartDetected, upgradedTo: agentVersionChanged ? nextAgentVersion : null });
    if (recoveryTriggered) {
      const reason = recoveredFromOffline ? "agent-reconnected" : rebootDetected ? "agent-reboot-detected" : "agent-process-restarted";
      await resetAgentRuntimeStateForRecovery(host.id, reason, {
        preserveReportedRuntime: !!localRuntimeState.state && !localRuntimeState.requestLocalState,
      });
    }
    if (dnsChangedReports.length > 0) {
      appendPanelLog("info", `[AgentDNS] host=${host.id} reported DNS change for ${dnsChangedReports.length} watched name(s); rule-specific refresh only`);
    }

    // 30 秒内同一台只写一行（见 metricsRepository.insertHostMetricSampled）；有人正在看实时指标时每次都写。
    await db.insertHostMetricSampled({
      hostId: host.id,
      cpuUsage: cpuUsage ?? null,
      memoryUsage: memoryUsage ?? null,
      memoryUsed: memoryUsed ?? null,
      swapUsage: swapUsage ?? null,
      swapUsed: swapUsed ?? null,
      swapTotal: swapTotal ?? null,
      networkIn: networkIn ?? null,
      networkOut: networkOut ?? null,
      diskUsage: diskUsage ?? null,
      diskUsed: diskUsed ?? null,
      diskTotal: diskTotal ?? null,
      uptime: uptime ?? null,
      tcpConnections: tcpConnections ?? null,
      udpConnections: udpConnections ?? null,
      // 库里存乘 100 的整数（没有浮点列），见 shared/hostLoadAverage.ts
      loadAvg1: loadAverageToStored(loadAverage.load1),
      loadAvg5: loadAverageToStored(loadAverage.load5),
      loadAvg15: loadAverageToStored(loadAverage.load15),
    }, { force: isHostMetricsWatching(host.id) || isHostLiveFocused(host.id) });
    // 按 95 值计费的主机记 5 分钟桶（主机账本用）；别的主机这里直接返回（server/hostRateBuckets.ts）。
    void recordHostRateSample(host, { atMs: Date.now(), networkIn: networkIn ?? null, networkOut: networkOut ?? null }).catch(() => undefined);
    // 资源告警：CPU / 内存 / 磁盘持续超过阈值时通知管理员（不阻塞心跳）
    observeHostResourceSample(host, { cpu: cpuUsage ?? null, memory: memoryUsage ?? null, disk: diskUsage ?? null });
    // 这台此刻的负载（CPU、带宽占用取大）：线路组给沿途经过它的路径带 loadPct（server/hostLoad.ts）。
    recordHostLoadSample(host.id, { at: Date.now(), cpuUsage: cpuUsage ?? null, networkIn: networkIn ?? null, networkOut: networkOut ?? null }, hostBandwidthHintMbps(host));
    // OOM / 服务崩溃（Agent ≥ 2.2.230 才报这两项）
    observeHostHealthCounters(host, { bootId: agentBootId, oomKillCount: req.body?.oomKillCount, serviceRestarts: req.body?.serviceRestarts });
    recordHostLiveSample(host.id, {
      at: Date.now(),
      source: "heartbeat",
      cpuUsage: cpuUsage ?? null,
      memoryUsage: memoryUsage ?? null,
      memoryUsed: memoryUsed ?? null,
      memoryTotal: memoryTotal ?? null,
      swapUsage: swapUsage ?? null,
      swapUsed: swapUsed ?? null,
      swapTotal: swapTotal ?? null,
      networkIn: networkIn ?? null,
      networkOut: networkOut ?? null,
      diskUsage: diskUsage ?? null,
      diskUsed: diskUsed ?? null,
      diskTotal: diskTotal ?? null,
      uptime: uptime ?? null,
      tcpConnections: tcpConnections ?? null,
      udpConnections: udpConnections ?? null,
      ...loadAverage,
    });

    if (busyHeartbeat) {
      const panelUrl = await resolveHostAgentAdvertisedPanelUrl(host);
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
        recoveryPending: recoveryTriggered
          || (!!previousHost.agentRecoveryStartedAt && !previousHost.agentRecoveryCompletedAt),
        requestLocalState: localRuntimeState.requestLocalState,
        stable: false,
        metricsWatching,
        nextInterval: metricsWatching ? AGENT_METRICS_WATCH_INTERVAL_SECONDS : 5,
      });
      res.json(buildBusyAgentHeartbeatResponse({
        panelUrl,
        requestLocalState: localRuntimeState.requestLocalState,
        metricsWatching,
        trafficReportInterval: metricsWatching ? 10 : undefined,
      }));
      return;
    }

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
      return;
    }

    // 获取该主机的转发规则
    const [rawRules, hostTunnels, forwardProtocolSettings, configRevision, hostTlsInbounds] = await Promise.all([
      db.getForwardRulesForAgent(host.id),
      db.getTunnelsByHost(host.id),
      getForwardProtocolSettings(),
      latestConfigRevision(),
      db.listTlsInboundsByHost(Number(host.id)),
    ]);
    /*
      共享 TLS 入站上的规则：入站不在 / 停用 / Agent 太旧时按停用下发；要发 PROXY 头时守卫先收入站给的头。
      见 server/tlsInboundRuntime.ts。普通规则原样通过（同一个对象）。
    */
    const tlsInboundById = new Map(hostTlsInbounds.map((inbound) => [inbound.id, inbound] as const));
    const sniRuntimeView = <T extends Record<string, any>>(rule: T): T => sniRuleRuntimeView(rule, {
      hostId: Number(host.id),
      agentVersion: effectiveAgentVersion,
      inboundById: tlsInboundById,
    });
    /*
      Shadowsocks 出口（server/ssEgress.ts）：出口失效、落地入站没了、Agent 低于 2.2.226、要 UDP / SS2022
      而入口机没报这项能力时规则按停用下发（绝不退回直连）；能跑的规则带上 egressRuntime，下面生成 gost 配置时挂出口链。只管这台主机自己的规则。
    */
    let egressRuntimeContext = await loadEgressRuntimeContext(rawRules as any[]);
    // VLESS Reality 出口的本机 sing-box 桥接端口（server/vlessEgress.ts）：下面协议守卫分端口时当作已占用。
    const vlessBridgePorts = await planVlessEgressBridgePorts(Number(host.id), rawRules, hostTunnels);
    const egressRuntimeView = <T extends Record<string, any>>(rule: T): T => (Number(rule?.hostId) === Number(host.id)
      ? ruleEgressRuntimeView(rule, {
        entryHostId: Number(host.id),
        entryAgentVersion: effectiveAgentVersion,
        entryHostName: String((host as any).name || ""),
        // 这次心跳刚报的能力（上面已经写回 host）：UDP / SS2022 出口只发给此刻撑得起的入口机。
        entryAgentCapabilities: (host as any).agentCapabilities,
        entryRuntimeVersion: (host as any).runtimeVersion,
        context: egressRuntimeContext,
        vlessBridgePorts,
      })
      : rule);
    const gatedRules = (await gateForwardRulesForRuntime(rawRules as any[])).map(sniRuntimeView).map(egressRuntimeView);
    /*
      换隧道后旧入口的临时桥接（server/ruleEntryBridges）：合成成普通的 iptables 规则行接在
      后面，下面整条下发流程原样生成动作、计数、孤儿清理。桥接到期或删掉后这一行消失，
      Agent 上报的那个监听随即被当成孤儿撤掉。
    */
    const rules = [...gatedRules, ...await loadEntryBridgeRuntimeRules(Number(host.id), gatedRules)];
    const actions: any[] = [];
    const dnsWatches = new Map<string, AgentDnsWatch>();
    const responseIssuedAt = Date.now();

    // Prefer the explicit host setting. Current Agents also report the
    // interface selected by the default route so mimic is not silently skipped.
    const configuredHostInterface = normalizeNetworkInterface((host as any).networkInterface);
    const hostInterface = configuredHostInterface || reportedDefaultNetworkInterface;
    // 内核关了 IPv6 的机器（Agent 2.2.256+ 报 ipv6Listen=false）：realm / socat 只听 IPv4。没报过按有 IPv6，配置不变。
    const hostIpv6Listen = hostIpv6ListenAvailable(host);
    const mimicFiltersByInterface = new Map<string, Set<string>>();
    const mimicLifecycleResources = new Map<string, MimicLifecycleResource>();
    const reportedMimicInterfaces = new Set<string>();
    const reportedMimicServicesByInterface = new Map<string, AgentLocalRuntimeServiceState>();
    let mimicRequestedWithoutInterface = false;
    const addMimicFilter = (
      filter: string,
      iface = hostInterface,
      lifecycleResources: MimicLifecycleResource[] = [],
    ) => {
      const networkInterface = normalizeNetworkInterface(iface);
      const text = String(filter || "").trim();
      if (!text) return;
      if (!networkInterface) {
        mimicRequestedWithoutInterface = true;
        return;
      }
      if (!mimicFiltersByInterface.has(networkInterface)) mimicFiltersByInterface.set(networkInterface, new Set());
      mimicFiltersByInterface.get(networkInterface)!.add(text);
      for (const resource of lifecycleResources) {
        const resourceId = Math.floor(Number(resource.resourceId) || 0);
        if (resourceId <= 0) continue;
        mimicLifecycleResources.set(`${resource.resourceType}:${resourceId}`, {
          resourceType: resource.resourceType,
          resourceId,
        });
      }
    };
    const dnsChangedKey = (scope: string, refId: unknown) => `${scope}:${Number(refId) || 0}`;
    const dnsChangedFor = (scope: string, refId: unknown) => dnsChangedScopes.has(dnsChangedKey(scope, refId));
    const dnsRuntimeGeneration = (scope: string, refId: unknown) => {
      return dnsRuntimeGenerations.generation(scope, refId, dnsChangedTokenByScope.get(dnsChangedKey(scope, refId)));
    };
    const buildMimicRuntimeSyncCmds = (lifecycleToken: string, dnsRefreshToken = "", approvedRemovals = new Map<string, string>()) => {
      if (mimicRequestedWithoutInterface && !hostInterface) {
        return {
          commands: [`echo "[mimic] no usable network interface; configure the host network interface or upgrade the Agent so it can report the default interface"; exit 1`],
          removalCommands: [] as string[],
          rollbackCommands: [] as string[],
        };
      }
      const cmds: string[] = [];
      const removalCommands: string[] = [];
      const rollbackCommands: string[] = [];
      const activeIfaces = Array.from(mimicFiltersByInterface.keys()).sort();
      const knownIfaces = new Set([
        ...activeIfaces,
        ...approvedRemovals.keys(),
      ]);
      for (const networkInterface of Array.from(knownIfaces).sort()) {
        const desiredFilters = Array.from(mimicFiltersByInterface.get(networkInterface) || []).sort();
        const filters = desiredFilters;
        const configPath = `${MIMIC_CONFIG_DIR}/${networkInterface}.conf`;
        const backupPath = `${configPath}.forwardx-backup`;
        const backupActivePath = `${configPath}.forwardx-backup-active`;
        const backupEnabledPath = `${configPath}.forwardx-backup-enabled`;
        const dnsRefreshPath = `${configPath}.forwardx-dns-refresh`;
        const xdpModePath = `${configPath}.forwardx-xdp-mode`;
        const lifecyclePath = `${configPath}.forwardx-lifecycle`;
        const configTempPath = `${configPath}.forwardx-new`;
        const serviceName = `mimic@${networkInterface}`;
        const bpfDropInPath = `/etc/systemd/system/${serviceName}.service.d/forwardx-bpf.conf`;
        const bpfDropInDir = `/etc/systemd/system/${serviceName}.service.d`;
        const serviceNameQuoted = shQuote(serviceName);
        const serviceActiveCheck = `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl is-active --quiet ${serviceNameQuoted}.service; elif command -v rc-service >/dev/null 2>&1; then rc-service ${serviceNameQuoted} status >/dev/null 2>&1; elif [ -x /etc/init.d/${serviceName} ]; then /etc/init.d/${serviceName} status >/dev/null 2>&1; else false; fi`;
        const serviceEnabledCheck = `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl is-enabled --quiet ${serviceNameQuoted}.service; elif command -v rc-update >/dev/null 2>&1; then rc-update show default 2>/dev/null | grep -q -F ${shQuote(serviceName)}; else false; fi`;
        const enableRestoredService = `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl enable ${serviceNameQuoted}.service; elif command -v rc-update >/dev/null 2>&1; then rc-update add ${serviceNameQuoted} default; else echo "[mimic] cannot restore enabled state for ${serviceName} on unsupported init system"; exit 1; fi`;
        const restartRestoredService = `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl restart ${serviceNameQuoted}.service; elif command -v rc-service >/dev/null 2>&1; then rc-service ${serviceNameQuoted} restart; elif [ -x /etc/init.d/${serviceName} ]; then /etc/init.d/${serviceName} restart; else echo "[mimic] cannot restore service ${serviceName} on unsupported init system"; exit 1; fi`;
        if (filters.length === 0) {
          removalCommands.push(
            `if [ -f ${shQuote(configPath)} ] && grep -q '^# Managed by ForwardX$' ${shQuote(configPath)} 2>/dev/null; then ${stopManagedServiceCmd(serviceName)}; if [ -f ${shQuote(backupPath)} ]; then mv -f ${shQuote(backupPath)} ${shQuote(configPath)}; if [ -f ${shQuote(backupEnabledPath)} ]; then if ! { ${enableRestoredService}; }; then exit 1; fi; fi; if [ -f ${shQuote(backupActivePath)} ]; then if ! { ${restartRestoredService}; }; then exit 1; fi; fi; else rm -f ${shQuote(configPath)}; fi; rm -f ${shQuote(backupActivePath)} ${shQuote(backupEnabledPath)} ${shQuote(dnsRefreshPath)} ${shQuote(xdpModePath)} ${shQuote(lifecyclePath)} ${shQuote(configTempPath)} ${shQuote(`${configPath}.forwardx-last-good`)} ${shQuote(configPath)}.sha256 ${shQuote(bpfDropInPath)} 2>/dev/null || true; rmdir ${shQuote(bpfDropInDir)} 2>/dev/null || true; if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl daemon-reload 2>/dev/null || true; fi; fi; rm -f ${shQuote(xdpModePath)} ${shQuote(lifecyclePath)} 2>/dev/null || true`,
          );
          continue;
        }
        const config = buildForwardXMimicConfig(filters);
        const encodedConfig = Buffer.from(config, "utf8").toString("base64");
        cmds.push([
          "set -e",
          `if ! command -v mimic >/dev/null 2>&1; then echo "[mimic] mimic is not installed; install mimic and mimic-dkms to use UDP camouflage"; exit 1; fi`,
          `if ! ip link show dev ${shQuote(networkInterface)} >/dev/null 2>&1; then echo "[mimic] network interface ${shQuote(networkInterface)} does not exist"; exit 1; fi`,
          `mkdir -p ${shQuote(MIMIC_CONFIG_DIR)}`,
          `if [ -f ${shQuote(configPath)} ] && ! grep -q '^# Managed by ForwardX$' ${shQuote(configPath)} 2>/dev/null && [ ! -f ${shQuote(backupPath)} ]; then if { ${serviceActiveCheck}; }; then : > ${shQuote(backupActivePath)}; else rm -f ${shQuote(backupActivePath)}; fi; if { ${serviceEnabledCheck}; }; then : > ${shQuote(backupEnabledPath)}; else rm -f ${shQuote(backupEnabledPath)}; fi; rm -f ${shQuote(`${configPath}.forwardx-last-good`)}; cp -p ${shQuote(configPath)} ${shQuote(backupPath)}; fi`,
          `printf '%s' '${encodedConfig}' | base64 -d > ${shQuote(configTempPath)}`,
          `printf '\\n' >> ${shQuote(configTempPath)}; mimic_filter_count=$(grep -c '^filter = ' ${shQuote(configTempPath)} 2>/dev/null || true); if [ "$mimic_filter_count" -le 0 ] || [ "$mimic_filter_count" -gt 32 ]; then rm -f ${shQuote(configTempPath)}; echo "[mimic] invalid filter count: $mimic_filter_count (supported 1-32)"; exit 1; fi; if [ -f ${shQuote(configPath)} ] && grep -q '^# Managed by ForwardX$' ${shQuote(configPath)} 2>/dev/null; then cp -p ${shQuote(configPath)} ${shQuote(`${configPath}.forwardx-last-good`)}; fi; mv -f ${shQuote(configTempPath)} ${shQuote(configPath)}; chmod 644 ${shQuote(configPath)}`,
          `echo "[mimic] sync ${shQuote(networkInterface)} filters=$mimic_filter_count"`,
          `if ! modprobe mimic 2>/dev/null; then echo "[mimic] kernel module could not be loaded"; exit 1; fi`,
          `mimic_force_restart=0; if [ "$(cat ${shQuote(lifecyclePath)} 2>/dev/null || true)" != ${shQuote(lifecycleToken)} ]; then mimic_force_restart=1; fi`,
          dnsRefreshToken
            ? `mimic_old_hash=$(cat ${shQuote(configPath)}.sha256 2>/dev/null || true); if command -v sha256sum >/dev/null 2>&1; then mimic_new_hash=$(sha256sum ${shQuote(configPath)} 2>/dev/null | awk '{print "sha256:"$1}'); elif command -v cksum >/dev/null 2>&1; then mimic_new_hash=$(cksum ${shQuote(configPath)} 2>/dev/null | awk '{print "cksum:"$1":"$2}'); else mimic_new_hash="mtime:$(wc -c < ${shQuote(configPath)} 2>/dev/null):$(date -r ${shQuote(configPath)} +%s 2>/dev/null)"; fi; mimic_dns_restart=0; if { ${serviceActiveCheck}; } && [ "$mimic_new_hash" = "$mimic_old_hash" ] && [ "$(cat ${shQuote(dnsRefreshPath)} 2>/dev/null || true)" != ${shQuote(dnsRefreshToken)} ]; then mimic_dns_restart=1; fi`
            : "mimic_dns_restart=0",
          restartMimicServiceIfConfigChangedCmd(serviceName, configPath, networkInterface),
          dnsRefreshToken
            ? `if [ "$mimic_dns_restart" = "1" ] && [ "$mimic_needs_start" != "1" ]; then echo ${shQuote(`[mimic] DNS refresh ${dnsRefreshToken}`)}; ${startManagedServiceCmd(serviceName)}; fi; printf '%s' ${shQuote(dnsRefreshToken)} > ${shQuote(dnsRefreshPath)}`
            : "",
          `if ! mimic show ${shQuote(networkInterface)} >/dev/null 2>&1; then echo "[mimic] runtime hooks are unavailable on ${shQuote(networkInterface)}"; systemctl status ${shQuote(serviceName)}.service --no-pager -l 2>/dev/null || true; journalctl -u ${shQuote(serviceName)}.service -n 80 --no-pager 2>/dev/null || true; exit 1; fi`,
          `mimic_lifecycle_tmp=${shQuote(`${lifecyclePath}.tmp`)}.$$; printf '%s' ${shQuote(lifecycleToken)} > "$mimic_lifecycle_tmp"; chmod 644 "$mimic_lifecycle_tmp"; mv -f "$mimic_lifecycle_tmp" ${shQuote(lifecyclePath)}`,
        ].filter(Boolean).join("\n"));
        rollbackCommands.push(`if [ -f ${shQuote(`${configPath}.forwardx-last-good`)} ]; then cp -p ${shQuote(`${configPath}.forwardx-last-good`)} ${shQuote(configPath)}; ${startManagedServiceCmd(serviceName)}; elif [ -f ${shQuote(backupPath)} ]; then ${stopManagedServiceCmd(serviceName)}; cp -p ${shQuote(backupPath)} ${shQuote(configPath)}; if [ -f ${shQuote(backupEnabledPath)} ]; then if ! { ${enableRestoredService}; }; then exit 1; fi; fi; if [ -f ${shQuote(backupActivePath)} ]; then if ! { ${restartRestoredService}; }; then exit 1; fi; fi; rm -f ${shQuote(backupPath)} ${shQuote(backupActivePath)} ${shQuote(backupEnabledPath)} ${shQuote(dnsRefreshPath)} ${shQuote(xdpModePath)} ${shQuote(configTempPath)} ${shQuote(configPath)}.sha256 2>/dev/null || true; else ${stopManagedServiceCmd(serviceName)}; rm -f ${shQuote(configPath)} ${shQuote(xdpModePath)} 2>/dev/null || true; fi`);
      }
      return { commands: cmds, removalCommands, rollbackCommands };
    };

    /** 包装一条只追加一次的 iptables 规则：先 -C 检查是否存在，不存在才 -A */
    /**
     * 为转发规则创建一对 mangle 计数链以跨转发方式采集准确流量。
     * - FWX_IN_<port>：匹配 dport=<port> 的入站包（客户端→Agent）
     * - FWX_OUT_<port>：匹配 sport=<port> 的出站包（Agent→客户端响应）
     * 不设 RETURN，所以只作计数不影响路由。三种转发方式都会经过 mangle 表，覆盖 100% 路径。
     */
    const gostServiceName = RUNTIME_SERVICE_NAME;
    /*
      能力 gostApiSync（Agent ≥ 2.2.229、运行时 ≥ 3.2.6）的机器：gost.json 开 root 专用的 Unix 套接字 API，
      ExecStart 包一层准备套接字目录，重启命令前加 API 同步标记 —— API 能做的改动不再重启共享进程（shared/gostRuntimeApi.ts）。
      别的机器上配置、单元、命令和以前逐字节相同。
    */
    const gostApiSync = hostSupportsGostApiSync({ agentVersion: effectiveAgentVersion, agentCapabilities: (host as any).agentCapabilities });
    const gostRuntimeExecStart = (service: string, configPath: string) => (
      gostApiSync ? gostRuntimeApiExecStart(RUNTIME_BIN, service, configPath) : `${RUNTIME_BIN} -C ${configPath}`
    );
    const gostRuntimeApiSection = (service: string) => (gostApiSync ? { api: gostRuntimeApiConfig(service) } : {});
    const gostRuntimeSyncCmd = (service: string, configPath: string) => (
      gostApiSync ? syncGostServiceIfConfigChangedCmd(service, configPath) : restartManagedServiceIfConfigChangedCmd(service, configPath)
    );
    const gostServiceUnit = [
      "[Unit]",
      "Description=ForwardX unified runtime forwarder",
      "After=network.target",
      "StartLimitIntervalSec=60",
      "StartLimitBurst=5",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${gostRuntimeExecStart(gostServiceName, RUNTIME_CONFIG_PATH)}`,
      "Restart=always",
      "RestartSec=5",
      // 这台机器上所有 gost 规则共用这一个进程，一条转发占两个句柄：65535 意味着
      // 整机三万来个并发就到顶，新连接直接 accept 失败。
      `LimitNOFILE=${SHARED_RUNTIME_NOFILE}`,
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");
    const agentHostRules = rules as any[];
    // DNS 预解析：将域名转换为 IP，缓存中比较检测变更
    const dnsChangedRuleIds = new Set<number>();
    const dnsPreviousIpByRuleId = new Map<number, string>();
    const resolvedTargetGate = createResolvedTargetGate(host as any);
    const resolvedHostRuleTargets = await mapWithConcurrency(agentHostRules as any[], 32, async (rule: any) => {
      if (!rule.targetIp) return null;
      addDnsWatch(dnsWatches, rule.targetIp, "forward-rule-target", Number(rule.id));
      const rawTargetIp = String(rule.targetIp || "").trim();
      const previous = resolvedIpCache.get(Number(rule.id));
      const forcedResolved = dnsChangedIpByHost.get(rawTargetIp.toLowerCase());
      const resolved = forcedResolved || await resolveTargetIpCached(Number(rule.id), rawTargetIp);
      return { rule, rawTargetIp, previous, forcedResolved, resolved };
    });
    for (const target of resolvedHostRuleTargets) {
      if (!target) continue;
      const { rule, rawTargetIp, previous, forcedResolved, resolved } = target;
      if (forcedResolved) expireSharedResolvedIp(Number(rule.id));
      if (dnsChangedFor("forward-rule-target", Number(rule.id)) && previous && previous.raw === rawTargetIp && previous.ip !== resolved) {
        // IP 变更：标记为需要重新下发
        dnsChangedRuleIds.add(rule.id);
        dnsPreviousIpByRuleId.set(rule.id, previous.ip);
      }
      if (!forcedResolved) setBoundedMapValue(resolvedIpCache, rule.id, { raw: rawTargetIp, ip: resolved }, AGENT_DYNAMIC_CACHE_MAX);
      // 保存原始值（域名），将 rule.targetIp 替换为解析后的 IP
      (rule as any)._originalTargetIp = rule.targetIp;
      rule.targetIp = resolved;
      // 域名解析到了内网 / 环回，而这台机器不是规则主人的：不下发（见 ruleTargetPolicy）。
      if (await resolvedTargetGate(rule, rawTargetIp, resolved)) {
        rule.isEnabled = false;
        (rule as any).resourceAccessDenied = true;
      }
    }

    const chainMemberAddress = (member: any, hostLike: any) => {
      const configured = String(member?.connectHost || "").trim();
      if (configured) {
        addDnsWatch(dnsWatches, configured, "forward-chain-member", Number(member?.id || 0));
        return configured;
      }
      const value = hostIngressAddress(hostLike);
      addDnsWatch(dnsWatches, value, "host-entry", Number(hostLike?.id || member?.hostId || 0));
      return value;
    };
    const forwardChainHostById = new Map<number, any>();
    const forwardChainGroupById = new Map<number, any>();
    const forwardChainChildrenByTemplateId = new Map<number, Promise<any[]>>();
    const getForwardChainHost = async (hostId: number) => {
      const id = Number(hostId);
      if (!Number.isFinite(id) || id <= 0) return null;
      if (forwardChainHostById.has(id)) return forwardChainHostById.get(id);
      const nextHost = await db.getHostById(id);
      forwardChainHostById.set(id, nextHost || null);
      return nextHost || null;
    };
    const getForwardChainGroup = async (groupId: number) => {
      const id = Number(groupId);
      if (!Number.isFinite(id) || id <= 0) return null;
      if (forwardChainGroupById.has(id)) return forwardChainGroupById.get(id);
      const group = await db.getForwardGroupById(id);
      forwardChainGroupById.set(id, group || null);
      return group || null;
    };
    const getForwardChainChildren = async (templateRuleId: number) => {
      const id = Number(templateRuleId);
      if (!Number.isFinite(id) || id <= 0) return [] as any[];
      let pending = forwardChainChildrenByTemplateId.get(id);
      if (!pending) {
        pending = db.getForwardGroupChildRulesForTemplate(id).then((rows: any) => rows as any[]);
        forwardChainChildrenByTemplateId.set(id, pending);
      }
      return pending;
    };
    const resolveForwardChainTarget = async (rule: any) => {
      const groupId = Number(rule?.forwardGroupId || 0);
      const memberId = Number(rule?.forwardGroupMemberId || 0);
      if (!groupId || !memberId) return null;
      const group = await getForwardChainGroup(groupId);
      if (String((group as any)?.groupMode || "") !== "chain") return null;
      const members = [...(((group as any).members || []) as any[])]
        .filter((member: any) => runtimeBool(member?.isEnabled))
        .sort((a: any, b: any) => Number(a.priority) - Number(b.priority));
      const memberIdx = members.findIndex((member: any) => Number(member.id) === memberId);
      if (memberIdx < 0) return null;
      const currentMember = members[memberIdx] as any;
      if (memberIdx === 0 && Number(rule.hostId || 0) !== Number(currentMember.hostId || 0)) {
        const entryGroupId = Number((group as any)?.entryGroupId || 0);
        if (!entryGroupId) return null;
        const entryGroup = await getForwardChainGroup(entryGroupId);
        const isEntryGroupHost = !!entryGroup
          && runtimeBool((entryGroup as any).isEnabled)
          && String((entryGroup as any).groupMode || "") === "entry"
          && (((entryGroup as any).members || []) as any[]).some((member: any) => (
            member
            && runtimeBool(member.isEnabled, true)
            && member.memberType === "host"
            && Number(member.hostId || 0) === Number(rule.hostId || 0)
          ));
        if (!isEntryGroupHost) return null;
        const firstHost = await getForwardChainHost(Number(currentMember.hostId));
        const targetIp = chainMemberAddress(currentMember, firstHost);
        const childRules = await getForwardChainChildren(Number(rule.forwardGroupRuleId || 0));
        const targetPort = selectForwardChainListenerPort(
          childRules,
          currentMember.id,
          currentMember.hostId,
          rule.targetPort,
        );
        if (!targetIp || targetPort <= 0) return null;
        const forcedResolved = dnsChangedIpByHost.get(String(targetIp).toLowerCase());
        const resolvedTargetIp = forcedResolved || await resolveTargetIpCached(Number(rule.id), targetIp);
        if (forcedResolved) expireSharedResolvedIp(Number(rule.id));
        if (!forcedResolved) setBoundedMapValue(resolvedIpCache, Number(rule.id), { raw: targetIp, ip: resolvedTargetIp }, AGENT_DYNAMIC_CACHE_MAX);
        return { targetIp: resolvedTargetIp, targetPort, originalTargetIp: targetIp };
      }
      if (memberIdx >= members.length - 1) return null;
      if (Number(rule.hostId || 0) !== Number(currentMember.hostId || 0)) return null;
      const nextMember = members[memberIdx + 1] as any;
      if (nextMember.memberType !== "host") return null;
      const nextHost = await getForwardChainHost(Number(nextMember.hostId));
      const targetIp = chainMemberAddress(nextMember, nextHost);
      const childRules = await getForwardChainChildren(Number(rule.forwardGroupRuleId || 0));
      const targetPort = selectForwardChainListenerPort(
        childRules,
        nextMember.id,
        nextMember.hostId,
        rule.targetPort,
      );
      if (!targetIp || targetPort <= 0) return null;
      const forcedResolved = dnsChangedIpByHost.get(String(targetIp).toLowerCase());
      const resolvedTargetIp = forcedResolved || await resolveTargetIpCached(Number(rule.id), targetIp);
      if (forcedResolved) expireSharedResolvedIp(Number(rule.id));
      if (!forcedResolved) setBoundedMapValue(resolvedIpCache, Number(rule.id), { raw: targetIp, ip: resolvedTargetIp }, AGENT_DYNAMIC_CACHE_MAX);
      return { targetIp: resolvedTargetIp, targetPort, originalTargetIp: targetIp };
    };

    // 对 DNS 变更且正在运行的规则，先生成清理动作，再通过 isRunning=false 触发重新下发
    for (const rule of agentHostRules as any[]) {
      if (!dnsChangedRuleIds.has(rule.id)) continue;
      if (!runtimeBool(rule.isEnabled) || !runtimeBool(rule.isRunning)) continue;
      if (failoverProxyHandlesTargetDns(rule)) {
        console.log(`[DNS] rule=${rule.id} target changed; failover proxy will resolve ${rule._originalTargetIp || rule.targetIp} without service reload`);
        continue;
      }
      const oldIp = dnsPreviousIpByRuleId.get(rule.id) || rule._originalTargetIp || rule.targetIp;
      const ruleResolvedIp = rule.targetIp; // 已经是新解析的 IP
      const cleanupCmds = buildDnsChangeCleanup(rule, oldIp);
      if (cleanupCmds.length > 0) {
        actions.push({
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: ruleResolvedIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          networkInterface: hostInterface,
          commands: cleanupCmds,
        } as any);
      }
      // 重置 isRunning 让主循环生成 apply 动作
      rule.isRunning = false;
      console.log(`[DNS] rule=${rule.id} target changed: ${oldIp} → ${ruleResolvedIp}, re-applying`);
    }

    const chainTargetsByRuleId = new Map<number, { targetIp: string; targetPort: number; originalTargetIp?: string }>();
    await mapWithConcurrency(agentHostRules as any[], 16, async (rule: any) => {
      const chainTarget = await resolveForwardChainTarget(rule);
      if (!chainTarget) return;
      const oldTargetIp = String(rule.targetIp || "").trim();
      const oldTargetPort = Number(rule.targetPort) || 0;
      chainTargetsByRuleId.set(Number(rule.id), chainTarget);
      if (oldTargetIp === chainTarget.targetIp && oldTargetPort === chainTarget.targetPort) return;
      if (runtimeBool(rule.isEnabled) && runtimeBool(rule.isRunning)) {
        actions.push({
          ruleId: rule.id,
          op: "remove",
          forwardType: rule.forwardType,
          sourcePort: rule.sourcePort,
          targetIp: oldTargetIp,
          targetPort: oldTargetPort,
          protocol: rule.protocol,
          networkInterface: hostInterface,
          commands: buildForwardTargetCleanup(rule, oldTargetIp, oldTargetPort),
        } as any);
        rule.isRunning = false;
      }
      rule.targetIp = chainTarget.targetIp;
      rule.targetPort = chainTarget.targetPort;
      (rule as any)._originalTargetIp = chainTarget.originalTargetIp || chainTarget.targetIp;
      await db.updateForwardRule(Number(rule.id), {
        targetIp: chainTarget.originalTargetIp || chainTarget.targetIp,
        targetPort: chainTarget.targetPort,
        isRunning: false,
      } as any);
      appendPanelLog("info", `[ForwardChain] rule=${rule.id} target=${chainTarget.targetIp}:${chainTarget.targetPort}${chainTarget.originalTargetIp && chainTarget.originalTargetIp !== chainTarget.targetIp ? ` resolvedFrom=${chainTarget.originalTargetIp}` : ""} source=chain-config`);
    });
    for (const rule of rules as any[]) {
      const chainTarget = chainTargetsByRuleId.get(Number(rule.id));
      if (!chainTarget) continue;
      rule.targetIp = chainTarget.targetIp;
      rule.targetPort = chainTarget.targetPort;
      (rule as any)._originalTargetIp = chainTarget.originalTargetIp || chainTarget.targetIp;
      if ((agentHostRules as any[]).some((item: any) => Number(item.id) === Number(rule.id) && !runtimeBool(item.isRunning))) {
        rule.isRunning = false;
      }
    }

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
    for (const [ruleId, objects] of tunnelEgressRuleObjects) {
      const rule = objects[0];
      if (objects.every((item) => runtimeBool(item.pendingDelete) || !runtimeBool(item.isEnabled))) continue;
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      if (!tunnel) {
        holdTunnelEgressRule(objects, "shape_invalid");
        continue;
      }
      const dialHostIds = tunnelEgressDialHostIdsOf(
        tunnel,
        tunnelHopsByTunnelId.get(Number(tunnel.id)) || [],
        tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [],
      );
      const selfDial = dialHostIds.includes(Number(host.id));
      if (selfDial) {
        const evaluation = evaluateRuleEgress(rule, {
          entryHostId: Number(host.id),
          entryAgentVersion: effectiveAgentVersion,
          entryHostName: String((host as any).name || ""),
          entryAgentCapabilities: (host as any).agentCapabilities,
          entryRuntimeVersion: (host as any).runtimeVersion,
          tunnelMode: tunnel.mode,
          context: egressRuntimeContext,
        });
        if (!evaluation || !evaluation.runtime || ruleEgressStateBlocksDelivery(evaluation.state)) {
          holdTunnelEgressRule(objects, evaluation?.state || "config_invalid");
          continue;
        }
        tunnelEgressHelpers.set(ruleId, {
          ruleId,
          tunnel,
          runtime: evaluation.runtime,
          targetHost: String(rule._originalTargetIp || rule.targetIp || ""),
          targetPort: Number(rule.targetPort || 0),
          protocol: String(rule.protocol || "both"),
          port: 0,
        });
        // 本机跑着这条规则的 SS 客户端：目标等分完端口再换（分守卫端口之后那一段），不用等别的出口。
        continue;
      }
      const pending = dialHostIds.filter((exitHostId) => !hasTunnelExitPort(exitHostId, "egress", ruleId));
      for (const exitHostId of pending) {
        if (claimTunnelExitReportRequest(exitHostId)) pushAgentRefresh(exitHostId, "tunnel-exit-ports-needed");
      }
      const port = dialHostIds.length > 0 && pending.length === 0
        ? tunnelExitPortFor("egress", ruleId, dialHostIds, 0, { whenRuleMissing: "none" })
        : null;
      if (!port) {
        holdTunnelEgressRule(objects, "pending");
        continue;
      }
      pointTunnelEgressRule(objects, port);
    }
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
    if (trafficExcludedHosts.size > 0) {
      const blockForTraffic = (rule: any) => {
        rule.isEnabled = false;
        rule.resourceAccessDenied = true;
        rule.hostTrafficExcluded = true;
      };
      const groupById = new Map<number, any>();
      for (const rule of [...agentHostRules, ...agentAllRules] as any[]) {
        const groupId = Number(rule.forwardGroupId || 0);
        if (groupId > 0 && !groupById.has(groupId)) groupById.set(groupId, await db.getForwardGroupById(groupId));
        const group = groupById.get(groupId);
        const chainHostIds = String(group?.groupMode) === "chain"
          ? (group.members || []).filter((member: any) => runtimeBool(member.isEnabled, true)).map((member: any) => Number(member.hostId))
          : [];
        if (groupRuleTrafficBlocked(rule, trafficExcludedHosts, chainHostIds)) blockForTraffic(rule);
        // 组成员用的是固定出口 / 链式中转的隧道：出口或中转被暂停，这条子规则也走不通。
        const memberTunnel = tunnelById.get(Number(rule.tunnelId)) as any;
        const memberHops = memberTunnel ? tunnelHopsByTunnelId.get(Number(memberTunnel.id)) || [] : [];
        const blockedFixedExit = memberTunnel && !Number(memberTunnel.exitGroupId) && !runtimeBool(memberTunnel.loadBalanceEnabled)
          && trafficExcludedHosts.has(Number(memberTunnel.exitHostId));
        const blockedTransit = memberTunnel && !isTunnelRelayFailover(memberTunnel, memberHops)
          && memberHops.slice(1, -1).some((hop: any) => trafficExcludedHosts.has(Number(hop.hostId)));
        if (groupId > 0 && (blockedFixedExit || blockedTransit)) blockForTraffic(rule);
      }
      for (const tunnel of hostTunnels as any[]) {
        const tunnelId = Number(tunnel.id);
        const originalHops = tunnelHopsByTunnelId.get(tunnelId) || [];
        const originalExits = tunnelExitNodesByTunnelId.get(tunnelId) || [];
        const plan = planTunnelTrafficParticipation(tunnel, originalHops, originalExits,
          tunnelEntryHostIdsByTunnelId.get(tunnelId) || [], trafficExcludedHosts);
        if (Number(tunnel.entryGroupId) > 0 && trafficExcludedHosts.has(Number(host.id))) {
          // 入口组隧道的规则存着原主人的 hostId、却装在每个入口上：按「当前这台 Agent」拦，
          // 不按存着的 hostId；全局的出口规则留给别的入口用。
          for (const rule of agentHostRules as any[]) {
            if (Number(rule.tunnelId) === tunnelId) blockForTraffic(rule);
          }
        }
        // 出口组 / 多出口的 NEX 隧道：这台被暂停时明确撤掉它原来的出口监听（只改主出口的运行时
        // 副本，老 Agent 上那个监听会一直留着）。
        if (String(tunnel.mode) === "forwardx" && (Number(tunnel.exitGroupId) > 0 || runtimeBool(tunnel.loadBalanceEnabled)) && trafficExcludedHosts.has(Number(host.id))) {
          const localExit = Number(tunnel.exitHostId) === Number(host.id) ? tunnel
            : originalExits.find((node: any) => Number(node.hostId) === Number(host.id));
          if (localExit && Number(localExit.listenPort) > 0 && isTunnelRuntimeHostReady(tunnelId, Number(host.id))) {
            actions.push({
              tunnelId, ruleId: 0, statusType: "tunnel", op: "remove", forwardType: "forwardx-tunnel",
              sourcePort: Number(localExit.listenPort), targetIp: host.ip, targetPort: Number(localExit.listenPort), protocol: "both", commands: [],
              // V3 的出口进程身份带着 v3（Agent 的 fxpServerID），撤的时候要说清楚是哪个版本。
              fxp: { role: "exit", tunnelId, ruleId: 0, listenPort: Number(localExit.listenPort), ...(isForwardXV3Tunnel(tunnel) ? { transportVersion: "v3" } : {}) },
            } as any);
          }
        }
        if (plan.promotedExit) {
          // GOST 在每个出口上给每条规则分的端口不一样：提上来的出口要用它自己的那组映射，不能沿用原主出口的端口。
          for (const rule of [...agentHostRules, ...agentAllRules] as any[]) {
            if (Number(rule.tunnelId) !== tunnelId) continue;
            const mapping = (tunnelExitRowsByRuleId.get(Number(rule.id)) || [])
              .find((row: any) => Number(row.exitNodeId) === Number(plan.promotedExit.id));
            if (mapping) rule.tunnelExitPort = Number(mapping.tunnelExitPort);
          }
        }
        Object.assign(tunnel, plan.tunnel);
        tunnelHopsByTunnelId.set(tunnelId, plan.hops);
        tunnelExitNodesByTunnelId.set(tunnelId, plan.exits);
        tunnelEntryHostIdsByTunnelId.set(tunnelId, plan.entryHostIds);
        if (!runtimeBool(tunnel.isEnabled)) {
          for (const rule of [...agentHostRules, ...agentAllRules] as any[]) {
            if (Number(rule.tunnelId) === tunnelId) blockForTraffic(rule);
          }
        }
      }
    }
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
    const protocolGuardPorts = allocateProtocolGuardPorts(
      [...agentAllRules, ...agentHostRules],
      reservedProtocolGuardPorts,
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
      if (runtimeBool(tunnel?.loadBalanceEnabled) && normalizeExitGroupStrategy(tunnel?.loadBalanceStrategy) !== "none") {
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
        scoreMargin: policy.scoreMargin,
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
    const getTunnelDialHost = (hostId: unknown) => {
      const id = Number(hostId);
      let pending = tunnelDialHostPromiseById.get(id);
      if (!pending) {
        pending = db.getHostById(id);
        tunnelDialHostPromiseById.set(id, pending);
      }
      return pending;
    };
    const tunnelExitHostAddress = async (tunnel: any) => {
      const connectHost = String(tunnel?.connectHost || "").trim();
      if (connectHost) {
        const address = selectTunnelDialAddress(tunnel, null);
        addDnsWatch(dnsWatches, address, "tunnel-connect", Number(tunnel?.id || 0));
        return address;
      }
      const exit = await getTunnelDialHost(tunnel.exitHostId);
      const address = selectTunnelDialAddress(tunnel, exit);
      if (!address) return "";
      addDnsWatch(dnsWatches, address, "host-entry", Number((exit as any)?.id || tunnel?.exitHostId || 0));
      return address;
    };
    const tunnelExitEndpointById = new Map<number, { host: string; port: number; udpPort?: number }>();
    // 拆到 agentHeartbeat*Plan.ts 等模块里的那几段要读的、本次请求只读的值（见 agentHeartbeatContext.ts）。
    const heartbeatCtx: HeartbeatRequestContext = {
      host,
      hostTunnels,
      agentHostRules,
      agentAllRules,
      forwardProtocolSettings,
      tunnelById,
      tunnelHopsByTunnelId,
      tunnelExitNodesByTunnelId,
      tunnelExitEndpointById,
    };
    const hostIngressAddressById = new Map<number, string>();
    const getHostIngressAddress = async (hostId: number) => {
      const id = Number(hostId);
      if (!Number.isFinite(id) || id <= 0) return "";
      const cached = hostIngressAddressById.get(id);
      if (cached !== undefined) return cached;
      const hopHost = await getTunnelDialHost(id) as any;
      const addr = hopHost ? hostPublicAddress(hopHost) : "";
      hostIngressAddressById.set(id, addr);
      return addr;
    };
    const getHopDialAddress = async (hop: any, tunnel?: any) => {
      const configured = String((hop as any)?.connectHost || "").trim();
      if (configured) {
        addDnsWatch(dnsWatches, configured, "tunnel-hop-connect", Number((hop as any)?.id || 0));
        return configured;
      }
      const hopHost = await getTunnelDialHost((hop as any)?.hostId) as any;
      const selected = selectTunnelHopDialAddress(hop, hopHost, tunnel);
      const privateAddress = String(hopHost?.tunnelEntryIp || "").trim();
      if (privateAddress && selected === privateAddress) {
        addDnsWatch(dnsWatches, selected, "tunnel-private", Number((hop as any)?.hostId || 0));
        return selected;
      }
      return getHostIngressAddress(Number((hop as any)?.hostId));
    };
    const getExtraExitDialAddress = async (exitNode: any, tunnel?: any) => {
      const configured = String((exitNode as any)?.connectHost || "").trim();
      if (configured) {
        addDnsWatch(dnsWatches, configured, "tunnel-exit-connect", Number((exitNode as any)?.id || 0));
        return configured;
      }
      const exitHost = await getTunnelDialHost((exitNode as any)?.hostId) as any;
      const selected = selectTunnelHopDialAddress(exitNode, exitHost, tunnel);
      const privateAddress = String(exitHost?.tunnelEntryIp || "").trim();
      if (privateAddress && selected === privateAddress) {
        addDnsWatch(dnsWatches, selected, "tunnel-private", Number((exitNode as any)?.hostId || 0));
        return selected;
      }
      return getHostIngressAddress(Number((exitNode as any)?.hostId));
    };
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
    const applyForwardXTransport = async (fxpSpec: any, tunnel: any) => {
      // 链路整形跟着每个角色的配置走（入口、出口、中转都要）：主动拨出去的连接按
      // 上行整形，接进来的连接按下行整形，FXP 自己按方向取。手动给上限，自动给提示值。
      const link = tunnelLinkShaping(tunnel);
      fxpSpec.linkShaping = link.mode;
      if (link.mode === "manual") {
        if (link.upMbps > 0) fxpSpec.linkUpMbps = link.upMbps;
        if (link.downMbps > 0) fxpSpec.linkDownMbps = link.downMbps;
      } else if (link.mode === "auto") {
        const hint = (await linkShapingHints()).get(Number(tunnel.id));
        if (hint?.up) fxpSpec.linkUpHintMbps = hint.up;
        if (hint?.down) fxpSpec.linkDownHintMbps = hint.down;
      }
      // 抗丢包（FXP 的 udp_fec.go）：隧道上每个角色都要带，冗余包是逐跳发、逐跳还原的。
      // 关着不写字段，配置和旧版本一模一样，FXP 不会因此重启。
      if (runtimeBool((tunnel as any)?.udpFec)) fxpSpec.udpFec = true;
      // 抗丢包传输（FXP 的 loss_carrier.go）：入口、中转、出口都要带，承载是逐跳的。只给 V1
      // （V2 外层已经是 WireGuard 的 UDP，FXP 也会拒）。关着不写字段，配置和旧版一模一样。
      if (runtimeBool(tunnel?.lossTolerant) && !isForwardXWireGuardV2(tunnel)) fxpSpec.lossTolerant = true;
      // 主机公网出口整形按主机配置，每条隧道的配置都带同一份（FXP 整台机器只建一个）。
      // 关着不写字段，老 FXP 的配置保持原样。
      const egress = hostEgressShaping(host);
      if (egress.mode !== "off") {
        fxpSpec.egressShaping = egress.mode;
        if (egress.mode === "manual") fxpSpec.egressMbps = egress.mbps;
        else if (await egressHint()) fxpSpec.egressHintMbps = await egressHint();
      }
      // NEX V3（shared/forwardXV3.ts）：外层选项逐跳都带，入口、中转、出口读的是同一行隧道配置。
      if (isForwardXV3Tunnel(tunnel)) {
        const v3Fields = forwardXV3SpecFields(tunnel);
        if (!v3Fields) return null;
        // 面板保存时已经拒了 V3 + 抗丢包传输；库里要是还留着旧值（比如直接改库），这里不下发，
        // 免得 FXP 拒掉整份配置、隧道上别的规则跟着起不来。多路径（中转叠加 / 热备 / 单连接
        // 多路并发）照常下发：FXP 2.2.141 起每条腿是一条自己的 V3 物理连接。
        delete fxpSpec.lossTolerant;
        fxpSpec.transportVersion = "v3";
        Object.assign(fxpSpec, v3Fields);
        return fxpSpec;
      }
      if (!isForwardXWireGuardV2(tunnel)) {
        fxpSpec.transportVersion = "v1";
        return fxpSpec;
      }
      const plan = await getCurrentHostForwardXWireGuardPlan(tunnel);
      if (!plan) return null;
      fxpSpec.transportVersion = "v2";
      return fxpSpec;
    };
    const tunnelRuleExitMappings = (rule: any) => {
      const rows = tunnelExitRowsByRuleId.get(Number(rule?.id || 0)) || [];
      return rows
        .map((row: any) => ({
          exitNodeId: Number(row.exitNodeId),
          exitSeq: Number(row.exitSeq),
          exitHostId: Number(row.exitHostId),
          tunnelExitPort: Number(row.tunnelExitPort),
        }))
        .filter((row) => row.exitHostId > 0)
        .sort((a, b) => a.exitSeq - b.exitSeq);
    };
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
      runtimeBool((tunnel as any)?.loadBalanceEnabled) && normalizeExitGroupStrategy((tunnel as any)?.loadBalanceStrategy) !== "none"
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
      if (!runtimeBool((tunnel as any).loadBalanceEnabled) || normalizeExitGroupStrategy((tunnel as any).loadBalanceStrategy) === "none") return routes;
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
    const exitBandwidthsForHostIds = async (hostIds: number[]) => {
      const missing = Array.from(new Set(hostIds.filter((id) => id > 0 && !exitBandwidthCache.has(id))));
      if (missing.length > 0) {
        const rows = await db.getHostsByIds(missing) as any[];
        for (const id of missing) exitBandwidthCache.set(id, 0);
        for (const row of rows) exitBandwidthCache.set(Number(row.id), hostBandwidthHintMbps(row));
      }
      return hostIds.map((id) => exitBandwidthCache.get(id) || 0);
    };
    const exitWeightsForHostIds = async (strategy: unknown, hostIds: number[]) => {
      const normalized = normalizeExitGroupStrategy(strategy);
      if ((normalized !== "weighted" && normalized !== "least_load") || hostIds.length < 2) return null;
      return exitGroupWeights(strategy, await exitBandwidthsForHostIds(hostIds));
    };
    // 交给 FXP 的线路带宽（「按负载」「按访客固定」用）。
    const exitCapacitiesForHostIds = async (strategy: unknown, hostIds: number[]) => {
      const normalized = normalizeExitGroupStrategy(strategy);
      if ((normalized !== "least_load" && normalized !== "ip_hash") || hostIds.length < 2) return null;
      return exitGroupCapacities(strategy, await exitBandwidthsForHostIds(hostIds));
    };
    /*
      出口组「故障切换优先同出口 IP」（2.3.520）：每个出口带上那台主机的出口地址（hostEgressAddress）。先写进 FXP 规格，
      FXP 主备换出口时按它取舍要等 FXP 那边接上（现在的 FXP 不读这个字段）；Agent 不拿它算签名，带上不会重载 FXP。
      出口不到两个用不上，不查。一次心跳里同一台只查一次。
    */
    const exitIpCache = new Map<number, string>();
    const exitIpsForHostIds = async (hostIds: number[]): Promise<string[] | null> => {
      if (hostIds.length < 2) return null;
      const missing = Array.from(new Set(hostIds.filter((id) => id > 0 && !exitIpCache.has(id))));
      if (missing.length > 0) {
        const rows: HostEgressSource[] = await db.getHostsByIds(missing).catch(ignoreErrorWith("AgentHeartbeat exit ips", []));
        for (const id of missing) exitIpCache.set(id, "");
        for (const row of rows) exitIpCache.set(Number(row.id), hostEgressAddress(row));
      }
      const ips = hostIds.map((id) => exitIpCache.get(id) || "");
      return ips.some(Boolean) ? ips : null;
    };
    const forwardXEntryRoutes = async (_rule: any, tunnel: any) => {
      const routes: Array<{ hostId: number; host: string; port: number; udpPort: number; key: string }> = [];
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      if (Array.isArray(hops) && tunnelRelayUsesParallelRelays(tunnel, hops)) {
        for (const relayHop of tunnelRelayCandidates(hops) as any[]) {
          const relayHost = String(await getHopDialAddress(relayHop, tunnel)).trim();
          const relayPort = Number(relayHop?.listenPort) || 0;
          const relayKey = fxpHopKey(tunnel, relayHop, Number(relayHop?.seq || 0));
          if (!relayHost || relayPort <= 0 || !relayKey) continue;
          routes.push({
            hostId: Number(relayHop?.hostId || 0),
            host: relayHost,
            port: relayPort,
            udpPort: Number(relayHop?.mimicPort || 0),
            key: relayKey,
          });
        }
        return routes;
      }
      const primary = await forwardXEntryRoute(tunnel);
      if (primary.host && primary.port > 0 && primary.key) routes.push(primary);
      if (!Array.isArray(hops) || hops.length < 3) {
        routes.push(...await forwardXExtraExitRoutes(tunnel));
      }
      return routes;
    };
    const addMimicRemoteFilterForRoutes = (
      routes: Array<{ host: string; port: number; udpPort?: number }>,
      lifecycleResources: MimicLifecycleResource[],
    ) => {
      for (const route of routes) {
        const udpPort = Number(route.udpPort || 0);
        if (udpPort <= 0) continue;
        const endpoint = mimicFilterEndpoint(route.host, udpPort);
        if (endpoint) addMimicFilter(`remote=${endpoint}`, hostInterface, lifecycleResources);
      }
    };
    const addMimicLocalFilterForPort = (port: unknown, lifecycleResources: MimicLifecycleResource[]) => {
      const p = Number(port) || 0;
      if (p <= 0 || p > 65535) return;
      // Mimic natively supports wildcard local filters and tracks interface
      // address changes itself. Avoid resolving only the first global address
      // in a shell command, which can miss the actual WireGuard destination.
      addMimicFilter(`local=0.0.0.0:${p}`, hostInterface, lifecycleResources);
      addMimicFilter(`local=[::]:${p}`, hostInterface, lifecycleResources);
    };
    const collectMimicFiltersForRule = async (rule: any, tunnel: any) => {
      if (!udpOverTcpEnabled(rule, tunnel) || !isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) return;
      const lifecycleResources: MimicLifecycleResource[] = [
        { resourceType: "forward_rule", resourceId: Number(rule.id) },
        { resourceType: "tunnel", resourceId: Number(tunnel.id) },
      ];
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      const hostId = Number(host.id);
      const addCurrentHostExtraExitFilters = () => {
        if (normalizeExitGroupStrategy((tunnel as any).loadBalanceStrategy) === "none") return;
        const extraExitNodes = (tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [])
          .filter((node: any) => runtimeBool(node?.isEnabled, true) && Number(node.hostId) === hostId);
        for (const extraExitNode of extraExitNodes) {
          addMimicLocalFilterForPort(Number((extraExitNode as any).mimicPort || 0), lifecycleResources);
        }
      };
      if (isCurrentHostTunnelEntry(tunnel)) {
        addMimicRemoteFilterForRoutes(await forwardXEntryRoutes(rule, tunnel), lifecycleResources);
      }
      if (Array.isArray(hops) && hops.length >= 2) {
        const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === hostId);
        if (hostIdx >= 0) {
          const currentHop = hops[hostIdx] as any;
          if (hostIdx > 0) {
            addMimicLocalFilterForPort(Number(currentHop?.mimicPort || 0), lifecycleResources);
          }
          if (hostIdx < hops.length - 1) {
            const nextHop = isTunnelRelayFailover(tunnel, hops)
              ? hops[hops.length - 1] as any
              : hops[hostIdx + 1] as any;
            const nextHost = String(await getHopDialAddress(nextHop, tunnel)).trim();
            const nextRoutes = [{ host: nextHost, port: Number(nextHop?.listenPort || 0), udpPort: Number(nextHop?.mimicPort || 0) }];
            const nextIsFinalExit = Number(nextHop?.hostId || 0) === Number((hops[hops.length - 1] as any)?.hostId || 0);
            if (nextIsFinalExit && runtimeBool((tunnel as any).loadBalanceEnabled)) {
              nextRoutes.push(...await forwardXExtraExitRoutes(tunnel));
            }
            addMimicRemoteFilterForRoutes(nextRoutes, lifecycleResources);
          }
        }
        addCurrentHostExtraExitFilters();
        return;
      }
      const primaryExitHostId = Number(tunnel.exitHostId || 0);
      if (primaryExitHostId === hostId) {
        addMimicLocalFilterForPort(Number((tunnel as any).mimicPort) || 0, lifecycleResources);
      }
      addCurrentHostExtraExitFilters();
    };
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
    const tunnelProbes = (await Promise.all((hostTunnels as any[])
      .filter((tunnel: any) => runtimeBool(tunnel.isEnabled) && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel))
      .map(async (tunnel: any) => {
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        const topologyKey = tunnelProbeTopologyKey(
          tunnel,
          Array.isArray(hops) ? hops : [],
          tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [],
        );
        if (Array.isArray(hops) && hops.length >= 3) {
          const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === Number(host.id));
          const currentHostIsEntry = isCurrentHostTunnelEntry(tunnel);
          if (!currentHostIsEntry && (hostIdx < 0 || hostIdx >= hops.length - 1)) return null;
          const routeHostIdx = currentHostIsEntry ? 0 : hostIdx;
          const relayFailover = tunnelRelayUsesParallelRelays(tunnel, hops);
          const probeTargets = relayFailover && currentHostIsEntry
            ? tunnelRelayCandidates(hops).map((hop: any, index: number) => ({ hop, index: index + 1 }))
            : [{ hop: relayFailover ? hops[hops.length - 1] : hops[routeHostIdx + 1], index: routeHostIdx + 1 }];
          const probes = await Promise.all(probeTargets.map(async ({ hop: nextHop, index: targetIndex }: any) => {
            const targetIp = await getHopDialAddress(nextHop, tunnel);
            const targetPort = Number(nextHop?.listenPort) || 0;
            if (!targetIp || targetPort <= 0) return null;
            const relayCandidateIndex = relayFailover ? (currentHostIsEntry ? targetIndex : hostIdx) : 0;
            return {
              tunnelId: tunnel.id,
              targetIp,
              targetPort,
              protocol: "tcp",
              hopIndex: relayFailover ? (currentHostIsEntry ? 0 : 1) : routeHostIdx,
              hopCount: relayFailover ? 2 : hops.length - 1,
              ...(relayFailover ? {
                seriesKey: `relay-${relayCandidateIndex}`,
                seriesLabel: `中转 ${relayCandidateIndex}`,
              } : {}),
              probeKey: `tunnel:${Number(tunnel.id)}:host:${Number(host.id)}:hop:${routeHostIdx}/${hops.length - 1}:target:${targetIndex}:${String(targetIp).toLowerCase()}:${targetPort}`,
              topologyKey,
              wireGuardPeerId: isForwardXWireGuardV2(tunnel) ? String(Number(nextHop?.hostId || 0)) : undefined,
            };
          }));
          return probes.filter(Boolean);
        }
        if (!isCurrentHostTunnelEntry(tunnel)) return null;
        const primaryEndpoint = tunnelExitEndpointById.get(tunnel.id);
        const baseProbe = {
          tunnelId: tunnel.id,
          targetIp: primaryEndpoint?.host || "",
          targetPort: Number(primaryEndpoint?.port) || 0,
          protocol: "tcp",
          probeKey: `tunnel:${Number(tunnel.id)}:host:${Number(host.id)}:direct:${String(primaryEndpoint?.host || "").toLowerCase()}:${Number(primaryEndpoint?.port) || 0}`,
          topologyKey,
          wireGuardPeerId: isForwardXWireGuardV2(tunnel) ? String(Number(tunnel.exitHostId || 0)) : undefined,
        };
        if (!runtimeBool((tunnel as any).loadBalanceEnabled)) return baseProbe;
        const probes: any[] = [];
        if (baseProbe.targetIp && baseProbe.targetPort > 0) {
          probes.push({
            ...baseProbe,
            seriesKey: "primary",
            seriesLabel: "主出口",
            probeKey: `${baseProbe.probeKey}:primary`,
          });
        }
        const extraRoutes = await forwardXExtraExitRoutes(tunnel);
        extraRoutes.forEach((route, index) => {
          if (!route.host || Number(route.port) <= 0) return;
          probes.push({
            tunnelId: tunnel.id,
            targetIp: route.host,
            targetPort: Number(route.port) || 0,
            protocol: "tcp",
            seriesKey: `exit-${index + 2}`,
            seriesLabel: `出口 ${index + 2}`,
            probeKey: `tunnel:${Number(tunnel.id)}:host:${Number(host.id)}:direct:${String(route.host).toLowerCase()}:${Number(route.port) || 0}:exit-${index + 2}`,
            topologyKey,
            wireGuardPeerId: isForwardXWireGuardV2(tunnel) ? String(Number((route as any).hostId || 0)) : undefined,
          });
        });
        return probes;
      }))).flat().filter((probe: any) => probe && probe.targetIp && probe.targetPort > 0);
    const emptyProtocolPolicy = { blockHttp: false, blockSocks: false, blockTls: false };
    const hostProtocolPolicyById = new Map<number, typeof emptyProtocolPolicy>([
      [Number(host.id), protocolPolicyFromHost(host)],
    ]);
    const getHostProtocolPolicy = async (hostId: number) => {
      const id = Number(hostId);
      if (!Number.isFinite(id) || id <= 0) return emptyProtocolPolicy;
      const cached = hostProtocolPolicyById.get(id);
      if (cached) return cached;
      const entryHost = await db.getHostById(id);
      const policy = entryHost ? protocolPolicyFromHost(entryHost) : emptyProtocolPolicy;
      hostProtocolPolicyById.set(id, policy);
      return policy;
    };
    const ruleProtocolPolicy = (rule: any) => getHostProtocolPolicy(Number((rule as any)?.hostId || 0));
    const tunnelProtocolPolicy = (tunnel: any) => getHostProtocolPolicy(isCurrentHostTunnelEntry(tunnel) ? Number(host.id) : Number((tunnel as any)?.entryHostId || 0));
    /*
      V2 内核直通（隧道开关 kernelPassthrough，2.3.431 起）。

      开着的时候，这条隧道上的普通规则不再经 FXP：入口机把规则端口 DNAT 到出口机的 WireGuard
      地址（同一个端口），包在内核里直接进 nexwg；出口机在 nexwg 上把来自入口 WireGuard 地址的
      这个端口 DNAT 到规则目标。两头都没有用户态进程，加密只有 WireGuard 这一层。入口这边下发
      的就是一条普通的 iptables 规则（目标 = 出口 WireGuard 地址:规则端口），所以状态上报、
      流量计数、就绪检查、从 FXP 切换过来时停掉旧进程这些都走现成的 iptables 路径；出口那边
      的 DNAT 跟着 WireGuard 数据面配置一起下发（wireGuard.passthrough），Agent 在建 / 更新
      nexwg 时同步，隧道停掉时跟着清掉。

      只有这些条件全满足才直通，否则规则照旧走 FXP（切换是自动的，不用改规则）：
        - 隧道是 V2，单入口、单出口（没有中转、没有入口组、没有额外出口）；
        - 两台机器都报告自己跑的是内核 WireGuard（用户态 wireguard-go 没有内核路由可用）；
        - 隧道没开链路整形、UDP 抗丢包、协议拦截、PROXY protocol（这些都是 FXP 里做的）；
        - 规则没有限速、连接数 / IP 数限制、线路组、PROXY protocol，目标是 IPv4 地址
          （域名由面板解析成 IP 后同样可以）。
    */
    type KernelPassthroughPlan = { entryHostId: number; exitHostId: number; entryAddress: string; exitAddress: string };
    const kernelPassthroughPlanPromises = new Map<number, Promise<KernelPassthroughPlan | null>>();
    const tunnelKernelPassthroughPlan = (tunnel: any): Promise<KernelPassthroughPlan | null> => {
      const tunnelId = Number(tunnel?.id || 0);
      const cached = kernelPassthroughPlanPromises.get(tunnelId);
      if (cached) return cached;
      const work = (async () => {
        if (!tunnel || tunnelId <= 0 || !runtimeBool((tunnel as any).kernelPassthrough) || !isForwardXWireGuardV2(tunnel)) return null;
        if (!runtimeBool(tunnel.isEnabled) || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return null;
        const entryHostIds = tunnelEntryHostIds(tunnel);
        const exitHostId = Number(tunnel.exitHostId || 0);
        const hops = tunnelHopsByTunnelId.get(tunnelId) || [];
        const extraExits = (tunnelExitNodesByTunnelId.get(tunnelId) || []).filter((node: any) => runtimeBool(node?.isEnabled, true));
        if (entryHostIds.length !== 1 || exitHostId <= 0 || entryHostIds[0] === exitHostId) return null;
        if (hops.length >= 3 || (runtimeBool((tunnel as any).loadBalanceEnabled) && extraExits.length > 0)) return null;
        if (tunnelLinkShaping(tunnel).mode !== "off" || runtimeBool((tunnel as any).udpFec)) return null;
        if (runtimeBool((tunnel as any).proxyProtocolReceive) || runtimeBool((tunnel as any).proxyProtocolSend)
          || runtimeBool((tunnel as any).proxyProtocolExitReceive) || runtimeBool((tunnel as any).proxyProtocolExitSend)) return null;
        const policy = await tunnelProtocolPolicy(tunnel);
        if (policy.blockHttp || policy.blockSocks || policy.blockTls) return null;
        const entryHostId = entryHostIds[0];
        for (const hostId of [entryHostId, exitHostId]) {
          if (getHostWireGuardPlane(tunnelId, hostId) !== "kernel") return null;
          const member = hostId === Number(host.id) ? host : await getTunnelDialHost(hostId).catch(() => null);
          if (!member) return null;
        }
        let plans: Map<number, ForwardXWireGuardNodePlan>;
        try {
          plans = await getForwardXWireGuardPlans(tunnel);
        } catch {
          return null;
        }
        const entryAddress = String(plans.get(entryHostId)?.address || "").trim();
        const exitAddress = String(plans.get(exitHostId)?.address || "").trim();
        if (!entryAddress || !exitAddress) return null;
        return { entryHostId, exitHostId, entryAddress, exitAddress };
      })();
      kernelPassthroughPlanPromises.set(tunnelId, work);
      return work;
    };
    const kernelPassthroughRuleTarget = (rule: any) => {
      const targetIp = cleanEndpointHost(rule?.targetIp);
      const targetPort = Number(rule?.targetPort || 0);
      if (isIP(targetIp) !== 4 || !Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) return null;
      return { targetIp, targetPort };
    };
    const ruleKernelPassthroughEligible = (rule: any, tunnel: any) => {
      if (!rule || rule.forwardType !== "gost" || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled)) return false;
      if (Number(rule.tunnelId || 0) !== Number(tunnel?.id || 0) || !isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) return false;
      if (isEntryBridgeRuntimeRule(rule) || runtimeBool(rule.failoverEnabled) || forwardGroupHealthByRuleId.has(Number(rule.id))) return false;
      // 共享 TLS 入站上的规则：连接从本机回环进来，PREROUTING 的直通规则接不到。
      if (isSniRuntimeRule(rule)) return false;
      const port = Number(rule.sourcePort || 0);
      if (!Number.isInteger(port) || port <= 0 || port > 65535 || !kernelPassthroughRuleTarget(rule)) return false;
      const limits = ruleRateLimits(rule, tunnel);
      if (limits.limitIn > 0 || limits.limitOut > 0) return false;
      const access = userAccessLimits(Number(rule.userId));
      if (access.maxConnections > 0 || access.maxIPs > 0) return false;
      const proxy = proxyProtocolOptions(rule);
      if (proxy.proxyProtocolReceive || proxy.proxyProtocolSend || proxy.proxyProtocolExitReceive || proxy.proxyProtocolExitSend) return false;
      return true;
    };
    /** 入口机上这条规则该不该直通；是的话返回隧道的直通计划（出口 WireGuard 地址在里面）。 */
    const kernelPassthroughForRule = async (rule: any, tunnel: any) => {
      if (!tunnel || !isForwardXWireGuardV2(tunnel) || !runtimeBool((tunnel as any).kernelPassthrough)) return null;
      if (!ruleKernelPassthroughEligible(rule, tunnel)) return null;
      const plan = await tunnelKernelPassthroughPlan(tunnel);
      return plan && plan.entryHostId === Number(host.id) ? plan : null;
    };
    /** 直通规则在入口机上的样子：一条 iptables 规则，目标是出口 WireGuard 地址上的同一个端口。 */
    const kernelPassthroughRuleView = (rule: any, plan: KernelPassthroughPlan) => ({
      ...rule,
      forwardType: "iptables",
      targetIp: plan.exitAddress,
      _originalTargetIp: plan.exitAddress,
      targetPort: Number(rule.sourcePort),
    });
    /** 这台机器在隧道 WireGuard 配置里要带的直通表：出口带 DNAT 目标，入口只是告诉 Agent 有规则在用这条隧道。 */
    const kernelPassthroughEntriesForTunnel = async (tunnel: any) => {
      const plan = await tunnelKernelPassthroughPlan(tunnel);
      if (!plan) return [] as Array<Record<string, unknown>>;
      const role = plan.exitHostId === Number(host.id) ? "exit" : plan.entryHostId === Number(host.id) ? "entry" : "";
      if (!role) return [] as Array<Record<string, unknown>>;
      const entries: Array<Record<string, unknown>> = [];
      for (const rule of agentAllRules as any[]) {
        if (!ruleKernelPassthroughEligible(rule, tunnel)) continue;
        const target = kernelPassthroughRuleTarget(rule)!;
        entries.push({
          ruleId: Number(rule.id),
          role,
          peerId: String(role === "exit" ? plan.entryHostId : plan.exitHostId),
          port: Number(rule.sourcePort),
          protocol: normalizeForwardRuleProtocol(rule.protocol, "both"),
          ...(role === "exit" ? { targetIp: target.targetIp, targetPort: target.targetPort } : {}),
        });
      }
      return entries.sort((a, b) => Number(a.ruleId) - Number(b.ruleId));
    };
    const tunnelForRule = (rule: any) => (
      Number(rule?.tunnelId || 0) > 0 ? tunnelById.get(Number(rule.tunnelId)) as any : null
    );
    const isNginxTunnelEntryRule = (rule: any, tunnel = tunnelForRule(rule)) => (
      !!tunnel && isNginxTunnelMode(tunnel) && isCurrentHostTunnelEntry(tunnel)
    );
    const guardRateLimitForRule = (rule: any) => {
      const tunnel = tunnelForRule(rule);
      const limits = ruleRateLimits(rule, tunnel);
      return selectProtocolGuardRateLimit({
        hostId: Number(host.id) || 0,
        rule: {
          ...rule,
          tunnelMode: tunnel?.mode,
          tunnelEntry: isNginxTunnelEntryRule(rule, tunnel),
        },
        ...limits,
      });
    };
    const shouldUseRuleGuard = async (rule: any) => {
      // 端口段规则（shared/portRange.ts）只走内核 DNAT：守卫是一个端口一个进程，接不了一整段。
      // 段规则要限速时不在这里悄悄放行，而是下面内核那一支直接报错（portRangeRuntimeBlocker）。
      if (isPortRangeRule(rule)) return false;
      // 旧入口桥接只是把流量原样递给新入口，限速、协议封禁由新入口上的规则本身执行；
      // 这里再套一层守卫会多一个用户态进程，还会让同一份限速串联两次。
      if (isEntryBridgeRuntimeRule(rule)) return false;
      // 共享 TLS 入站上的规则一律由守卫在回环上接（入站把连接交到 127.0.0.1:sourcePort），
      // 计数、限速和普通规则同一套。经隧道的不用守卫：隧道入口自己只听回环（见 tlsInboundRuntime.ts）。
      const tunnel = tunnelForRule(rule);
      if (isSniRuntimeRule(rule) && !tunnel) return true;
      const nginxTunnelEntry = isNginxTunnelEntryRule(rule, tunnel);
      const rateLimits = guardRateLimitForRule(rule);
      if (rateLimits.limitIn > 0 || rateLimits.limitOut > 0) {
        // GOST already applies the same user bucket in its runtime config.
        // Keep the Agent guard for process backends and Nginx tunnel entries
        // only, otherwise two serial buckets halve the effective rate.
        if (rule.forwardType !== "gost" || nginxTunnelEntry) return true;
      }
      if (tunnel) return false;
      if (!shouldUseProcessBackendGuard(rule)) return false;
      if (!isForwardRuleProtocolTcpEnabled(rule.protocol)) return false;
      return hasProtocolPolicy(await ruleProtocolPolicy(rule));
    };
    const guardListenPort = (rule: any) => protocolGuardPortsForRule(rule).guardListenPort;
    /** 端口段规则这一轮能不能下发；不能就是给用户看的原因（见内核转发那一支）。 */
    const portRangeRuntimeBlocker = (rule: Record<string, unknown>): string | null => {
      const agentReason = portRangeAgentUnsupportedReason(host);
      if (agentReason) return agentReason;
      const limits = guardRateLimitForRule(rule);
      if (limits.limitIn > 0 || limits.limitOut > 0) return "端口段规则不能限速（内核转发限速要换成用户态守卫，一个端口一个进程），请取消限速或改回单端口";
      return null;
    };
    const guardBackendPort = (rule: any) => protocolGuardPortsForRule(rule).guardBackendPort;
    const guardTargetForRule = (rule: any, useRuleGuard: boolean) => (
      useRuleGuard && shouldUseProcessBackendGuard(rule)
        && (!tunnelForRule(rule) || isNginxTunnelEntryRule(rule))
        ? {
            targetIp: "127.0.0.1",
            targetPort: guardBackendPort(rule),
            backendPort: guardBackendPort(rule),
            backendForwardType: isNginxTunnelEntryRule(rule) ? "nginx" : String(rule.forwardType || ""),
          }
        : { ...failoverTargetEndpoint(rule), backendPort: 0, backendForwardType: "" }
    );
    const tunnelExitRules = agentAllRules
      .filter((r: any) => {
        if (runtimeBool(r.pendingDelete) || !runtimeBool(r.isEnabled) || r.forwardType !== "gost" || !r.tunnelId) return false;
        const tunnel = tunnelById.get(r.tunnelId) as any;
        return !!tunnel
          && runtimeBool(tunnel.isEnabled)
          && isGostTunnelMode(tunnel)
          && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
          && isRuleProtocolEnabled(forwardProtocolSettings, r, tunnel)
          && isCurrentHostTunnelExitForRule(r, tunnel);
      });
    const nginxTunnelExitRules = agentAllRules
      .filter((r: any) => {
        if (runtimeBool(r.pendingDelete) || !runtimeBool(r.isEnabled) || r.forwardType !== "gost" || !r.tunnelId) return false;
        const tunnel = tunnelById.get(r.tunnelId) as any;
        return !!tunnel
          && runtimeBool(tunnel.isEnabled)
          && isNginxTunnelMode(tunnel)
          && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
          && isRuleProtocolEnabled(forwardProtocolSettings, r, tunnel)
          && isCurrentHostTunnelExitForRule(r, tunnel);
      });
    const buildLoadBalancedExitNodes = async (rule: any, tunnel: any, primaryHostOverride?: string) => {
      const nodes: any[] = [];
      const nodeHostIds: number[] = [];
      const protocolPlan = planGostTunnelRuleProtocol({
        protocol: rule.protocol,
        tunnelId: Number(tunnel.id),
        ruleId: Number(rule.id),
        secretSeed: tunnelSecretSeed(tunnel),
      });
      for (const endpoint of tunnelExitEndpointsForRule(rule, tunnel)) {
        const exitHost = endpoint.primary
          ? (String(primaryHostOverride || "").trim() || tunnelExitEndpointById.get(tunnel.id)?.host || await tunnelExitHostAddress(tunnel))
          : await getExtraExitDialAddress(endpoint.node, tunnel);
        if (!exitHost || endpoint.listenPort <= 0) continue;
        const exitKey = endpoint.primary ? 0 : (endpoint.exitSeq || endpoint.exitNodeId);
        nodes.push(gostTunnelNode(
          `exit-${rule.id}-${exitKey}`,
          endpointHostPort(exitHost, endpoint.listenPort),
          gostTunnelTransportType(tunnel.mode),
          tunnel,
          protocolPlan.chainConnector,
        ));
        nodeHostIds.push(endpoint.exitHostId);
      }
      // 按权重 / 按负载：份数写进节点的 metadata.weight，gost 的 rand 按它加权随机（gostExitSelector）。
      // 以前是把出口按份数重复列，可每一份各记各的失败：权重 5 的出口挂了要失败 5 次才全部跳过。
      const weights = await exitWeightsForHostIds(tunnel.loadBalanceStrategy, nodeHostIds);
      if (!weights) return nodes;
      return nodes.map((node, index) => ({ ...node, metadata: { ...(node.metadata || {}), weight: weights[index] } }));
    };
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
    /*
      填「按访客固定」要剥头的 gost 端口转发名单（routeHeaderStripRuleIds 的来历见那里）。条件：
      gost 直连、不过协议守卫（守卫在前面时 gost 看到的访客是守卫自己）、有 TCP、规则本身不发
      PROXY 头（发的话头已经在了，调度器读完原样转）、调度确实会下发且分法是按访客。
    */
    for (const rule of Array.from(new Set([...agentAllRules, ...agentHostRules])) as any[]) {
      if (!rule?.failoverEnabled || rule.forwardType !== "gost" || Number(rule.tunnelId || 0) > 0) continue;
      if (!isForwardRuleProtocolTcpEnabled(rule.protocol) || proxyProtocolEnabled(rule, "send")) continue;
      const spec = actionFailover(rule, { listenPort: failoverProxyPort(rule), bindAddress: "127.0.0.1" });
      if (!spec || spec.strategy !== "ip_hash") continue;
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
      buildLoadBalancedExitNodes,
      buildProxyRuleDebugCmd,
      currentHostTunnelExitPortsForRule,
      dnsRuntimeRefreshCmd,
      failoverTargetAddr,
      getHopDialAddress,
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
    for (const tunnel of hostTunnels as any[]) {
      const isCurrentHostPrimaryExit = Number(tunnel.exitHostId) === Number(host.id);
      const currentHostExtraExitNode = (tunnelExitNodesByTunnelId.get(Number(tunnel.id)) || [])
        .find((node: any) => runtimeBool(node?.isEnabled, true) && Number(node.hostId) === Number(host.id));
      const isCurrentHostExtraExit = !!currentHostExtraExitNode;
      const isCurrentHostActiveExit = isCurrentHostPrimaryExit
        || (isCurrentHostExtraExit && normalizeExitGroupStrategy((tunnel as any).loadBalanceStrategy) !== "none");
      const existingHops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      const runtimeFamily = tunnelRuntimeFamily(tunnel);
      if (!runtimeFamily) continue;
      const fxpTunnel = runtimeFamily === "forwardx";
      const wireGuardV2 = fxpTunnel && isForwardXWireGuardV2(tunnel);
      const isCurrentHostSharedRuntimeExtraExit = !fxpTunnel && isCurrentHostExtraExit;
      if (!isCurrentHostPrimaryExit && !(fxpTunnel && isCurrentHostExtraExit) && !isCurrentHostSharedRuntimeExtraExit) continue;
      if (runtimeFamily !== "nginx" && Array.isArray(existingHops) && existingHops.length >= (fxpTunnel ? 2 : 3) && !isCurrentHostExtraExit) continue;
      const fxpListenPort = isCurrentHostPrimaryExit
        ? Number(tunnel.listenPort)
        : Number((currentHostExtraExitNode as any)?.listenPort || 0);
      const fxpUdpListenPort = !wireGuardV2 && tunnelNeedsMimic(tunnel)
        ? (isCurrentHostPrimaryExit
          ? Number((tunnel as any).mimicPort || 0)
          : Number((currentHostExtraExitNode as any)?.mimicPort || 0))
        : 0;
      const runtimeReady = (fxpTunnel || isCurrentHostSharedRuntimeExtraExit)
        ? isTunnelRuntimeHostReady(Number(tunnel.id), Number(host.id))
        : false;
      const tunnelProtocolEnabled = isTunnelProtocolEnabled(forwardProtocolSettings, tunnel);
      const endpointEnabled = runtimeBool(tunnel.isEnabled) && tunnelProtocolEnabled && isCurrentHostActiveExit;
      const udpTargets = fxpTunnel ? forwardXUDPTargets(tunnel) : [];
      const streamTargets = fxpTunnel ? forwardXStreamTargets(tunnel) : [];
      const shouldSyncUDPTargets = fxpTunnel
        && runtimeBool(tunnel.isEnabled)
        && tunnelProtocolEnabled
        && forwardXUDPTargetsChanged(tunnel, { udpTargets, streamTargets });
      const shouldRefreshExit = fxpTunnel
        ? (!runtimeReady || shouldSyncUDPTargets)
        : (!runtimeBool(tunnel.isRunning) || pendingTunnelExitRuleIds.has(Number(tunnel.id)) || (isCurrentHostSharedRuntimeExtraExit && !runtimeReady));
      if (fxpTunnel && endpointEnabled && tunnelNeedsMimic(tunnel)) {
        addMimicLocalFilterForPort(isCurrentHostPrimaryExit
          ? Number((tunnel as any).mimicPort || 0)
          : Number((currentHostExtraExitNode as any)?.mimicPort || 0), [{
          resourceType: "tunnel",
          resourceId: Number(tunnel.id),
        }]);
      }
      const tunnelSourcePort = fxpTunnel ? fxpListenPort : (isCurrentHostPrimaryExit ? Number(tunnel.listenPort) : Number((currentHostExtraExitNode as any)?.listenPort || 0));
      const tunnelForwardType = tunnelExitRuntimeForwardType(tunnel);
      if (!tunnelForwardType) continue;
      if (endpointEnabled && tunnelSourcePort > 0) {
        expectedTunnelPorts.add(tunnelSourcePort);
      }
      const shouldRepairLocalExit = endpointEnabled
        && tunnelSourcePort > 0
        && !localTunnelMatches(Number(tunnel.id), tunnelForwardType, tunnelSourcePort);
      const baseExitFXPSpec = fxpTunnel && fxpListenPort > 0 ? {
        role: "exit",
        tunnelId: tunnel.id,
        ruleId: 0,
        listenPort: fxpListenPort,
        ...(fxpUdpListenPort > 0 ? { udpListenPort: fxpUdpListenPort } : {}),
        protocol: "both",
        key: tunnelSecretSeed(tunnel),
        udpTargets,
        streamTargets,
        dnsGeneration: tunnelDnsGeneration(tunnel),
      } : null;
      const exitFXPSpec = baseExitFXPSpec ? await applyForwardXTransport(baseExitFXPSpec, tunnel) : undefined;
      if (endpointEnabled && (shouldRefreshExit || shouldRepairLocalExit)) {
        if (fxpTunnel && !exitFXPSpec) continue;
        actions.push({
          tunnelId: tunnel.id,
          statusType: "tunnel",
          ruleId: 0,
          op: "apply",
          forwardType: tunnelForwardType,
          sourcePort: tunnelSourcePort,
          targetIp: host.ip,
          targetPort: tunnelSourcePort,
          protocol: "tcp",
          commands: [],
          fxp: exitFXPSpec,
        });
      } else if (!endpointEnabled && (fxpTunnel ? runtimeReady : (runtimeBool(tunnel.isRunning) || runtimeReady))) {
        actions.push({
          tunnelId: tunnel.id,
          statusType: "tunnel",
          ruleId: 0,
          op: "remove",
          forwardType: tunnelForwardType,
          sourcePort: tunnelSourcePort,
          targetIp: host.ip,
          targetPort: tunnelSourcePort,
          protocol: "tcp",
          commands: [],
          fxp: exitFXPSpec || baseExitFXPSpec || undefined,
        });
      }
    }

    // Find multi-hop tunnels involving this host
    if (hostTunnels && hostTunnels.length > 0) {
      for (const tunnel of hostTunnels as any[]) {
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id)) || [];
        if (!hops || hops.length < 2) continue; // Not a multi-hop tunnel

        const hostIdx = hops.findIndex((h: any) => Number(h.hostId) === host.id);
        if (hostIdx < 0) continue; // This host is not a hop in this tunnel

        const tunnelForwardType = tunnelHopRuntimeForwardType(tunnel);
        if (!tunnelForwardType) continue;
        const isFXP = tunnelRuntimeFamily(tunnel) === "forwardx";
        const multiHopRuntimeReady = isTunnelRuntimeHostReady(Number(tunnel.id), Number(host.id));
        const listenPortValue = Number((hops[hostIdx] as any)?.listenPort || 0);
        const isLastHop = hostIdx === hops.length - 1;
        const isFirst = hostIdx === 0;
        const udpTargets = isFXP && isLastHop ? forwardXUDPTargets(tunnel) : [];
        const streamTargets = isFXP && isLastHop ? forwardXStreamTargets(tunnel) : [];
        const shouldSyncUDPTargets = isFXP
          && isLastHop
          && runtimeBool(tunnel.isEnabled)
          && forwardXUDPTargetsChanged(tunnel, { udpTargets, streamTargets });
        if (runtimeBool(tunnel.isEnabled) && listenPortValue > 0) {
          expectedTunnelPorts.add(listenPortValue);
        }
        const shouldRepairLocalHop = runtimeBool(tunnel.isEnabled)
          && listenPortValue > 0
          && !localTunnelMatches(Number(tunnel.id), tunnelForwardType, listenPortValue, {
            allowPassiveForwardXFirstHop: isFXP && isFirst,
          });
        const shouldApply = runtimeBool(tunnel.isEnabled) && (!multiHopRuntimeReady || shouldRepairLocalHop || shouldSyncUDPTargets);
        const shouldRemove = isFXP ? !runtimeBool(tunnel.isEnabled) : !runtimeBool(tunnel.isEnabled) && (runtimeBool(tunnel.isRunning) || multiHopRuntimeReady);

        if (!shouldApply && !shouldRemove) continue;

        const op = shouldApply ? "apply" : "remove";
        const { listenPort } = hops[hostIdx] as any;

        if (isFXP) {
          if (!isFirst && tunnelNeedsMimic(tunnel)) {
            addMimicLocalFilterForPort(Number((hops[hostIdx] as any)?.mimicPort || 0), [{
              resourceType: "tunnel",
              resourceId: Number(tunnel.id),
            }]);
          }
          // NEX multi-hop
          if (isFirst) {
            actions.push({
              tunnelId: tunnel.id,
              statusType: "tunnel",
              ruleId: 0,
              op,
              forwardType: "forwardx-tunnel",
              sourcePort: Number(listenPort),
              targetIp: host.ip,
              targetPort: Number(listenPort),
              protocol: "tcp",
              commands: [],
            } as any);
            continue;
          }
          const fxpSpec = await buildForwardXHopSpec(tunnel, hops, hostIdx, op);
          if (!fxpSpec) continue;
          if (isLastHop) {
            fxpSpec.udpTargets = udpTargets;
            fxpSpec.streamTargets = streamTargets;
          }

          actions.push({
            tunnelId: tunnel.id,
            statusType: "tunnel",
            ruleId: 0,
            op,
            forwardType: "forwardx-tunnel",
            sourcePort: Number(listenPort),
            targetIp: host.ip,
            targetPort: Number(listenPort),
            protocol: "tcp",
            commands: [],
            fxp: fxpSpec,
          } as any);
        } else {
          // GOST multi-hop config is refreshed by the shared runtime sync action.
          if (shouldApply) {
            actions.push({
              tunnelId: tunnel.id,
              statusType: "tunnel",
              ruleId: 0,
              op: "apply",
              forwardType: "gost-tunnel",
              sourcePort: Number(listenPort),
              targetIp: host.ip,
              targetPort: Number(listenPort),
              protocol: "tcp",
              commands: [],
            } as any);
          } else {
            actions.push({
              tunnelId: tunnel.id,
              statusType: "tunnel",
              ruleId: 0,
              op: "remove",
              forwardType: "gost-tunnel",
              sourcePort: Number(listenPort),
              targetIp: host.ip,
              targetPort: Number(listenPort),
              protocol: "tcp",
              commands: [],
            } as any);
          }
        }
      }
    }

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
            const entryRoutes = await forwardXEntryRoutes(rule, tunnel);
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
            const entryExitWeights = entryExitsAreRelays ? null : await exitWeightsForHostIds((tunnel as any).loadBalanceStrategy, entryExitHostIds);
            const entryExitCapacities = entryExitsAreRelays ? null : await exitCapacitiesForHostIds((tunnel as any).loadBalanceStrategy, entryExitHostIds);
            // 每个出口从哪个 IP 出去（2.3.520，见 exitIpsForHostIds）。并排中转不是出口，不带。
            const entryExitIps = entryExitsAreRelays ? null : await exitIpsForHostIds(entryExitHostIds);
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
              exitStrategy: tunnelRelayUsesParallelRelays(tunnel, tunnelHopsByTunnelId.get(Number(tunnel.id)) || [])
                ? "fallback"
                : forwardXExitStrategy((tunnel as any).loadBalanceStrategy),
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

    for (const rule of tunnelExitRules) {
      const tunnel = tunnelById.get((rule as any).tunnelId) as any;
      const policy = tunnel ? await tunnelProtocolPolicy(tunnel) : emptyProtocolPolicy;
      const tunnelProxyPlan = tunnelProxyProtocolPlan(rule);
      const useExitBridge = shouldUseProtocolGuard(rule, policy) || !!tunnelProxyPlan.exitBridgeReceive || !!tunnelProxyPlan.exitBridgeSend;
      if (tunnel && !isForwardXTunnel(tunnel) && useExitBridge) {
        const target = failoverTargetEndpoint(rule, "exitSend");
        guardRules.push({
          ruleId: rule.id,
          tunnelId: tunnel.id,
          listenPort: guardListenPort(rule),
          bindAddress: "127.0.0.1",
          targetIp: target.targetIp,
          targetPort: target.targetPort,
          protocol: normalizeForwardRuleProtocol(rule.protocol),
          policy,
          proxyProtocolReceive: !!tunnelProxyPlan.exitBridgeReceive,
          proxyProtocolSend: !!tunnelProxyPlan.exitBridgeSend,
          proxyProtocolVersion: proxyProtocolVersion(rule),
        });
      }
    }
    for (const rule of nginxTunnelExitRules) {
      const tunnel = tunnelById.get((rule as any).tunnelId) as any;
      if (!tunnel) continue;
      const policy = await tunnelProtocolPolicy(tunnel);
      if (shouldUseProtocolGuard(rule, policy)) {
        const target = failoverTargetEndpoint(rule);
        guardRules.push({
          ruleId: rule.id,
          tunnelId: tunnel.id,
          listenPort: guardListenPort(rule),
          bindAddress: "127.0.0.1",
          targetIp: target.targetIp,
          targetPort: target.targetPort,
          protocol: normalizeForwardRuleProtocol(rule.protocol),
          policy,
          proxyProtocolReceive: false,
          proxyProtocolSend: false,
          proxyProtocolVersion: proxyProtocolVersion(rule),
        });
      }
    }

    for (const rule of tunnelExitRules) {
      if (!runtimeBool(rule.isEnabled)) continue;
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      for (const trafficPort of currentHostTunnelExitPortsForRule(rule, tunnel)) {
        if (!trafficPort) continue;
        protectActiveRulePort(rule, trafficPort);
        addRunningRule({
          ruleId: rule.id,
          tunnelId: tunnel ? Number(tunnel.id) : 0,
          sourcePort: trafficPort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          forwardType: tunnel && isForwardXTunnel(tunnel) ? "forwardx-tunnel-exit" : "gost-tunnel-exit",
          failover: failoverForCurrentHost(rule, tunnel, { listenPort: failoverProxyPort(rule) }),
        });
      }
    }
    for (const rule of nginxTunnelExitRules) {
      if (!runtimeBool(rule.isEnabled)) continue;
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      for (const trafficPort of currentHostTunnelExitPortsForRule(rule, tunnel)) {
        if (!trafficPort) continue;
        protectActiveRulePort(rule, trafficPort);
        addRunningRule({
          ruleId: rule.id,
          tunnelId: tunnel ? Number(tunnel.id) : 0,
          sourcePort: trafficPort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          forwardType: "nginx-tunnel-exit",
          failover: failoverForCurrentHost(rule, tunnel, { listenPort: failoverProxyPort(rule) }),
        });
      }
    }
    /*
      NEX 隧道的线路组：出口机上只跑调度器（schedulerOnly，见 shared/routeGroup 的
      routeGroupIsForwardXTunnel）。这台机器上没有这条规则的端口：sourcePort 填调度器自己的监听端口，
      只给 Agent 当认调度器的标识；Agent 不给它写端口状态、不装计数链，流量照旧在入口计。
    */
    for (const rule of agentAllRules as any[]) {
      if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || !rule.failoverEnabled) continue;
      if (rule.forwardType !== "gost" || !rule.tunnelId) continue;
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      if (!tunnel || !isForwardXTunnel(tunnel) || !runtimeBool(tunnel.isEnabled)) continue;
      if (!isTunnelProtocolEnabled(forwardProtocolSettings, tunnel) || !isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) continue;
      const failover = forwardXSchedulerFailover(rule, tunnel);
      if (!failover || Number(failover.listenPort || 0) <= 0) continue;
      addRunningRule({
        ruleId: Number(rule.id),
        tunnelId: Number(tunnel.id),
        sourcePort: Number(failover.listenPort),
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        forwardType: "route-scheduler",
        schedulerOnly: true,
        failover,
      });
    }

    const gostMultiHopRelayRules = await Promise.all(agentAllRules
      .filter((rule: any) => {
        if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || !runtimeBool(rule.isRunning)) return false;
        if (rule.forwardType !== "gost" || !rule.tunnelId) return false;
        const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
        if (!tunnel || !isGostTunnelMode(tunnel) || !runtimeBool(tunnel.isEnabled)) return false;
        if (!isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return false;
        if (!isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) return false;
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
        return Array.isArray(hops) && hops.length >= 3;
      })
      .map(async (rule: any) => {
        const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
        const hops = tunnelHopsByTunnelId.get(Number(tunnel.id)) || [];
        const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === Number(host.id));
        if (hostIdx <= 0 || hostIdx >= hops.length - 1) return null;
        const currentHop = hops[hostIdx] as any;
        const nextHop = tunnelRelayUsesParallelRelays(tunnel, hops) ? hops[hops.length - 1] : hops[hostIdx + 1] as any;
        const nextHost = await getHopDialAddress(nextHop, tunnel);
        const sourcePort = Number(currentHop.listenPort) || 0;
        const targetPort = Number(nextHop.listenPort) || 0;
        if (!sourcePort || !targetPort || !nextHost) return null;
        return {
          ruleId: Number(rule.id),
          tunnelId: Number(tunnel.id),
          sourcePort,
          targetIp: nextHost,
          targetPort,
          protocol: "tcp",
          forwardType: "gost-tunnel-hop",
        };
      }));
    for (const runningRule of gostMultiHopRelayRules) {
      if (runningRule) addRunningRule(runningRule);
    }

    /**
     * 落地入站的端口也要进 runningRules —— 但只为了计数，不为了转发。
     *
     * 这条路能走通靠两个既有事实：runningRules 只驱动「写状态 + 装计数链」，
     * 转发器是 actions 启动的；而非 iptables/nftables/forwardx 的方式走
     * countingRuleProcess 模式，装计数链只需要监听端口和协议，不需要目标地址。
     * 所以放进来但不发 apply 动作，就只会计数。已装的 Agent 不必升级。
     *
     * 必须放在下面那个 expectedRulePorts 循环之前：那里算的是「这台机器上应该
     * 存在哪些端口」，漏掉的话 Agent 会把落地端口的计数链当孤儿清掉。
     */
    const hostProxyInbounds = await getEnabledProxyInboundsWithUsersByHost(Number(host.id));
    for (const row of hostProxyInbounds) {
      // Mieru 由 mita 按用户计数（server/mitaTraffic.ts）：mita 的用户不分端口，按端口计会记错人。
      if (row.protocol === "mieru") continue;
      addRunningRule({
        ruleId: proxyInboundTrafficRuleId(row.id),
        sourcePort: row.port,
        // 只计数，没有转发目标。
        targetIp: "",
        targetPort: 0,
        protocol: proxyInboundTrafficProtocol(row.protocol),
        forwardType: PROXY_INBOUND_TRAFFIC_FORWARD_TYPE,
      });
    }

    for (const runningRule of runningRules) {
      // 只跑调度器的那种不占端口（上面 NEX 隧道出口那段），不算这台机器上「应该有」的端口。
      if (runningRule.schedulerOnly) continue;
      const port = Number(runningRule.sourcePort || 0);
      if (port > 0) expectedRulePorts.add(runtimePortProtocolKey(port, runningRule.protocol));
      if (port > 0) expectedRuleIdentityKeys.add(ruleRuntimeIdentityKey(runningRule.ruleId, port, runningRule.protocol));
      if (port > 0) expectedRulePortIdentityKeys.add(ruleRuntimePortIdentityKey(runningRule.ruleId, port));
    }
    if (hasReportedRuntimeState) {
      const ruleActionPorts = new Set<string>();
      const ruleActionPortIdentityKeys = new Set<string>();
      const applyPortsByRuleId = new Map<number, Set<number>>();
      const tunnelActionPorts = new Set<number>();
      for (const action of actions) {
        const port = Number(action?.sourcePort || 0);
        if (port <= 0) continue;
        const statusType = String(action?.statusType || "");
        const ruleId = Number(action?.ruleId || 0);
        const tunnelId = Number(action?.tunnelId || 0);
        if (ruleId > 0 || statusType === "rule") {
          ruleActionPorts.add(runtimePortProtocolKey(port, action?.protocol));
          ruleActionPortIdentityKeys.add(ruleRuntimePortIdentityKey(ruleId, port));
          if (action?.op === "apply" && ruleId > 0) {
            const applyPorts = applyPortsByRuleId.get(ruleId) || new Set<number>();
            applyPorts.add(port);
            applyPortsByRuleId.set(ruleId, applyPorts);
          }
        } else if (tunnelId > 0 || statusType === "tunnel") {
          tunnelActionPorts.add(port);
        }
      }
      // 稳定身份护栏：一个上报端口的 ruleId 若属于面板已知、启用、未删除的规则
      // （无论本机自有还是跨主机隧道 entry/exit/hop 规则），说明该端口很可能是合法的，
      // 只是本轮运行态推导（如出口端口计算）出现了瞬时缺口。对这类端口施加迟滞：
      // 必须连续多轮心跳都判为孤儿才真正拆除，杜绝与 apply 形成抖动死循环。
      const knownEnabledRuleIds = new Set<number>();
      for (const rule of agentAllRules as any[]) {
        if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled)) continue;
        const ruleId = Number(rule.id || 0);
        if (ruleId > 0) knownEnabledRuleIds.add(ruleId);
      }
      const orphanStreaks = getOrphanPortStreaks(Number(host.id));
      const seenOrphanKeys = new Set<string>();
      for (const localRule of reportedLocalRules) {
        const port = Number(localRule.port || 0);
        if (port <= 0) continue;
        const localRuntimeKey = runtimePortProtocolKey(port, localRule.protocol || "both");
        const reportedRuleId = Number(localRule.ruleId || 0);
        const localIdentityKey = ruleRuntimeIdentityKey(reportedRuleId, port, localRule.protocol || "both");
        const localPortIdentityKey = ruleRuntimePortIdentityKey(reportedRuleId, port);
        const expectedIdentity = !!localIdentityKey && expectedRuleIdentityKeys.has(localIdentityKey);
        const expectedPortIdentity = !!localPortIdentityKey && expectedRulePortIdentityKeys.has(localPortIdentityKey);
        if (expectedIdentity || expectedPortIdentity || (!reportedRuleId && expectedRulePorts.has(localRuntimeKey)) || ruleActionPorts.has(localRuntimeKey) || (!!localPortIdentityKey && ruleActionPortIdentityKeys.has(localPortIdentityKey))) continue;
        // A replacement apply for this same rule proves that an old listener was
        // superseded by an edit. Remove it in this batch; without that concrete
        // replacement, retain orphan hysteresis for transient runtime gaps.
        const replacementPorts = applyPortsByRuleId.get(reportedRuleId);
        const supersededByRuleEdit = !!replacementPorts
          && (replacementPorts.size > 1 || !replacementPorts.has(port));
        const guarded = !supersededByRuleEdit
          && reportedRuleId > 0
          && knownEnabledRuleIds.has(reportedRuleId);
        const orphanKey = localIdentityKey || `unknown:${localRuntimeKey}`;
        if (guarded) {
          seenOrphanKeys.add(orphanKey);
          const streak = (orphanStreaks.get(orphanKey) || 0) + 1;
          orphanStreaks.set(orphanKey, streak);
          if (streak < AGENT_ORPHAN_REMOVE_MIN_STREAK) {
            appendPanelLog("info", `[AgentReconcile] host=${host.id} port=${port} protocol=${normalizeForwardRuleProtocol(localRule.protocol, "both")} rule=${reportedRuleId} suspected-orphan streak=${streak}/${AGENT_ORPHAN_REMOVE_MIN_STREAK}; defer removal (identity known, likely transient runtime gap)`);
            continue;
          }
          appendPanelLog("warn", `[AgentReconcile] host=${host.id} port=${port} protocol=${normalizeForwardRuleProtocol(localRule.protocol, "both")} rule=${reportedRuleId} orphan confirmed after ${streak} heartbeats; removing`);
        }
        actions.push(buildGenericLocalRuleRemovalAction(localRule));
        ruleActionPorts.add(localRuntimeKey);
        orphanStreaks.delete(orphanKey);
      }
      // 端口一旦重新匹配上规则（不再进入上面的孤儿分支），清零其迟滞计数。
      for (const orphanKey of Array.from(orphanStreaks.keys())) {
        if (!seenOrphanKeys.has(orphanKey)) orphanStreaks.delete(orphanKey);
      }
      if (orphanStreaks.size === 0) agentOrphanPortStreakCache.delete(Number(host.id));
      for (const localTunnel of localTunnelsByPort.values()) {
        const port = Number(localTunnel.port || 0);
        if (port <= 0 || expectedTunnelPorts.has(port) || tunnelActionPorts.has(port)) continue;
        actions.push(buildGenericLocalTunnelRemovalAction(localTunnel));
        tunnelActionPorts.add(port);
      }
    }

    const forwardGroupProbeMap = new Map<string, any>();
    const forwardGroupProbeTopology = await db.getForwardGroupProbeTopologyForHost(Number(host.id));
    for (const group of forwardGroupProbeTopology.chainGroups as any[]) {
      const probes = group.probes as any[];
      const topologyKey = forwardGroupProbeTopologyKey(Number(group.groupId), probes);
      for (const probe of probes) {
        if (Number(probe.fromHostId) !== Number(host.id)) continue;
        const key = `${probe.groupId}:${probe.hopIndex}:${probe.targetIp}:${probe.targetPort}:${probe.method}`;
        forwardGroupProbeMap.set(key, {
          groupId: probe.groupId,
          targetIp: probe.targetIp,
          targetPort: probe.targetPort,
          method: probe.method,
          hopIndex: probe.hopIndex,
          hopCount: probe.hopCount,
          probeKey: `forward-group:${Number(probe.groupId)}:host:${Number(host.id)}:hop:${Number(probe.hopIndex)}/${Number(probe.hopCount)}:${String(probe.targetIp).toLowerCase()}:${Number(probe.targetPort) || 0}:${String(probe.method || "tcp").toLowerCase()}`,
          topologyKey,
        });
      }
    }
    for (const probe of forwardGroupProbeTopology.chinaHealthProbes as any[]) {
      const key = `china:${probe.groupId}:${probe.memberId}:${probe.targetIp}:${probe.targetPort}`;
      forwardGroupProbeMap.set(key, {
        groupId: probe.groupId,
        memberId: probe.memberId,
        probeType: "china",
        targetIp: probe.targetIp,
        targetPort: probe.targetPort,
        // 按组里选的方法探（tcp / ping / udp）。
        method: normalizeForwardGroupHealthCheckMethod(probe.method),
        hopIndex: 0,
        hopCount: 1,
        probeKey: `forward-group:${Number(probe.groupId)}:host:${Number(host.id)}:china:${Number(probe.memberId)}:${String(probe.targetIp).toLowerCase()}:${Number(probe.targetPort) || 0}`,
        topologyKey: `forward-group:${Number(probe.groupId)}:china:${Number(probe.memberId)}`,
        failoverSeconds: Math.max(10, Number(probe.failoverSeconds || 60)),
        recoverSeconds: Math.max(10, Number(probe.recoverSeconds || 120)),
      });
    }
    for (const probe of forwardGroupProbeTopology.entryHealthProbes as any[]) {
      const key = `entry:${probe.groupId}:${probe.memberId}`;
      forwardGroupProbeMap.set(key, {
        groupId: probe.groupId,
        memberId: probe.memberId,
        probeType: "entry",
        targetIp: "",
        targetPort: 0,
        method: "self",
        hopIndex: 0,
        hopCount: 1,
        probeKey: `forward-group:${Number(probe.groupId)}:host:${Number(host.id)}:entry:${Number(probe.memberId)}`,
        topologyKey: `forward-group:${Number(probe.groupId)}:entry:${Number(probe.memberId)}`,
        failoverSeconds: Math.max(10, Number(probe.failoverSeconds || 60)),
        recoverSeconds: Math.max(10, Number(probe.recoverSeconds || 120)),
      });
    }
    const forwardGroupProbes = Array.from(forwardGroupProbeMap.values());
    const ruleLatencyProbes = (agentAllRules as any[])
      .filter((rule: any) => {
        if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || !runtimeBool(rule.isRunning)) return false;
        const tunnelId = Number(rule.tunnelId || 0);
        if (tunnelId <= 0) return false;
        const tunnel = tunnelById.get(tunnelId) as any;
        return !!tunnel
          && runtimeBool(tunnel.isEnabled)
          && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
          && isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel);
      })
      .map((rule: any) => {
        // 接了 Shadowsocks 出口：出口机拨的是本机的 SS 客户端，测它没有意义 —— 测出口机到 SS 落地这一段。
        const egressHelper = tunnelEgressHelpers.get(Number(rule.id));
        const probe = buildTunnelRuleLatencyProbe({
          hostId: host.id,
          rule: egressHelper ? { ...rule, targetPort: egressHelper.runtime.port } : rule,
          tunnel: tunnelById.get(Number(rule.tunnelId || 0)),
          targetIp: egressHelper ? egressHelper.runtime.server : processTarget(rule),
        });
        return probe ? {
          ...probe,
          forwardGroupHealth: forwardGroupHealthByRuleId.get(Number(rule.id)),
        } : null;
      })
      .filter(Boolean)
      .sort((left: any, right: any) => Number(left.ruleId) - Number(right.ruleId));
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
    if (shouldQueueForwardxAgentMigration({
      enabled: forwardxAgentMigrationEnabled,
      hostId: Number(host.id),
      agentDistribution: host.agentDistribution,
      agentUpgradeRequested: host.agentUpgradeRequested,
    })) {
      await db.requestHostAgentUpgrade(host.id, AGENT_VERSION, null, new Date(responseIssuedAt), NEX_AGENT_DISTRIBUTION);
      markForwardxAgentMigrationQueued(Number(host.id));
      Object.assign(host, {
        agentUpgradeRequested: true,
        agentUpgradeTargetVersion: AGENT_VERSION,
        agentUpgradeReleaseVersion: null,
        agentUpgradeTargetDistribution: NEX_AGENT_DISTRIBUTION,
        agentUpgradeRequestedAt: new Date(responseIssuedAt),
      });
      appendPanelLog(
        "info",
        `[AgentMigration] queued host=${host.id} name=${String(host.name || "-")} version=${effectiveAgentVersion || "-"} distribution=forwardx target=${AGENT_VERSION}/nex`,
      );
    }
    const requestedTargetVersion = (host as any).agentUpgradeTargetVersion || AGENT_VERSION;
    const agentUpgradeCompleted = (host as any).agentUpgradeRequested
      && agentVersion
      && isAgentUpgradeCompleted(
        {
          agentVersion,
          fxpVersion: nextFxpVersion || host.fxpVersion,
          agentDistribution: host.agentDistribution,
          agentUpgradeTargetDistribution: host.agentUpgradeTargetDistribution,
        },
        requestedTargetVersion,
        AGENT_VERSION,
      );
    if (agentUpgradeCompleted) {
      await db.clearHostAgentUpgradeRequest(host.id);
    }
    const panelUrl = await resolveHostAgentAdvertisedPanelUrl(host);
    const agentMigrationTargetPanelUrl = await getAgentMigrationSwitchTarget();
    const panelMigration = await getPanelMigrationAgentDirective(Number(host.id));
    const staleMigrationUpgrade = (host as any).agentUpgradeRequested
      && requestedTargetVersion === "9999.0.0"
      && !agentMigrationTargetPanelUrl;
    if (staleMigrationUpgrade) await db.clearHostAgentUpgradeRequest(host.id);
    const agentUpgradeRequestedAt = heartbeatTimestampMs((host as any).agentUpgradeRequestedAt);
    const agentUpgradeDue = agentUpgradeRequestedAt <= 0 || agentUpgradeRequestedAt <= responseIssuedAt;
    const agentUpgrade = (host as any).agentUpgradeRequested && agentUpgradeDue && !agentUpgradeCompleted && !staleMigrationUpgrade ? {
      targetVersion: requestedTargetVersion,
      panelUrl: agentMigrationTargetPanelUrl || panelUrl,
      releaseVersion: (host as any).agentUpgradeReleaseVersion || null,
    } : null;

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
    /**
     * 落地节点：把这台主机上启用中的入站合成一份 sing-box 配置推下去。
     *
     * 无条件生成计划（有入站就下发，没有就下发一份收尾），而不是「有入站才管」：
     * 用户删掉最后一个入站之后，这台机器上就再也没有行了，那时若不下发收尾，
     * sing-box 会带着一份过期配置继续跑。收尾用的命令每一条都带 `|| true`，
     * 对从没装过 sing-box 的主机是无害的空操作，而 shouldSendRuntimeSyncAction
     * 会按签名去重，所以只会真正下发一次。
     */
    if (!deferActionsForLocalState) {
      // 分流（按服务 / 域名从别的落地出去）：出口在这里现挑，解锁检测结果变了下次心跳就跟着变。
      const inboundRoutes = await resolveHostInboundRoutes(Number(host.id), hostProxyInbounds).catch((error) => {
        appendPanelLog("warn", `[SingboxRouting] resolve failed host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
        return new Map<number, any[]>();
      });
      const singboxPlan = buildSingboxRuntimePlan({
        inbounds: hostProxyInbounds.map((row) => ({
          inbound: row.inbound,
          // 用行 id 做 tag：改名不该让 sing-box 认为这是另一个入站。
          tag: `inbound-${row.id}`,
          ...(inboundRoutes.has(row.id) ? { routes: inboundRoutes.get(row.id) } : {}),
        })),
        accelerator: await getSingboxAccelerator(),
        panelRelayBase: singboxAssetRelayBase(panelUrl),
      });
      const singboxAction = {
        statusType: "runtime",
        ruleId: 0,
        tunnelId: 0,
        op: "apply",
        forwardType: "singbox-runtime-sync",
        sourcePort: 0,
        targetIp: "",
        targetPort: 0,
        protocol: "tcp",
        knownRunning: false,
        forceRuntimeSync: true,
        preCommands: singboxPlan.preCommands,
        commands: singboxPlan.commands,
        managedConfigs: singboxPlan.managedConfigs,
      } as any;
      if (shouldSendRuntimeSyncAction(
        Number(host.id),
        singboxAction,
        runtimeSyncBootstrap,
        responseIssuedAt,
        AGENT_GOST_RUNTIME_RECONCILE_MS,
      )) {
        actions.push(singboxAction);
      }
      /*
        VLESS Reality 出口的本机桥接（server/vlessEgress.ts）：单独一个 sing-box 服务，规则改了不打断上面的落地入站。
        只发给 2.2.255 起的 Agent（旧 Agent 上这类规则本来就按停用下发，也就没有桥接）；没有桥接时发一份收尾。
      */
      if (isVlessEgressAgentSupported(effectiveAgentVersion)) {
        const bridgePlan = buildVlessEgressBridgePlan({
          bridges: collectVlessEgressBridges(rules, Number(host.id)),
          accelerator: await getSingboxAccelerator(),
          panelRelayBase: singboxAssetRelayBase(panelUrl),
        });
        const bridgeAction = {
          statusType: "runtime",
          ruleId: 0,
          tunnelId: 0,
          op: "apply",
          forwardType: "singbox-egress-runtime-sync",
          sourcePort: 0,
          targetIp: "",
          targetPort: 0,
          protocol: "tcp",
          knownRunning: false,
          forceRuntimeSync: true,
          preCommands: bridgePlan.preCommands,
          commands: bridgePlan.commands,
          managedConfigs: bridgePlan.managedConfigs,
        };
        if (shouldSendRuntimeSyncAction(Number(host.id), bridgeAction, runtimeSyncBootstrap, responseIssuedAt, AGENT_GOST_RUNTIME_RECONCILE_MS)) {
          actions.push(bridgeAction);
        }
      }
    }
    if (!deferActionsForLocalState && mimicRuntimeSyncWanted) {
      const mimicDnsRefreshToken = anyTunnelDnsRefresh(
        (hostTunnels as any[]).filter((tunnel: any) => tunnelNeedsMimic(tunnel)),
      ) ? dnsRuntimeRefreshToken : "";
      const mimicLogIfaces = Array.from(new Set([
        ...(hostInterface ? [hostInterface] : []),
        ...Array.from(mimicFiltersByInterface.keys()),
        ...Array.from(reportedMimicInterfaces),
      ])).sort();
      const mimicLogPlan = mimicLogIfaces.map((iface) => {
        const filters = Array.from(mimicFiltersByInterface.get(iface) || []).sort();
        const reported = reportedMimicServicesByInterface.get(iface);
        const active = reported ? (reported.active ? "yes" : "no") : "-";
        const hooks = reported ? (reported.hooksReady === true ? "ready" : reported.hooksReady === false ? "missing" : "unknown") : "-";
        const state = reported ? String(reported.connectionState || reported.status || "unknown") : "-";
        return `${iface}{desired=${filters.length ? compactMimicFiltersForLog(filters) : "-"} reported=${reported ? "yes" : "no"} active=${active} hooks=${hooks} state=${state}}`;
      }).join(" ");
      const mimicLogSignature = JSON.stringify({
        hostInterface,
        requestedWithoutInterface: mimicRequestedWithoutInterface,
        dnsRefresh: !!mimicDnsRefreshToken,
        plan: mimicLogPlan,
      });
      if (shouldLogMimicRuntimePlan(Number(host.id), mimicLogSignature)) {
        appendPanelLog("info", `[Mimic] runtime plan host=${host.id} iface=${hostInterface || "-"} requestedWithoutInterface=${mimicRequestedWithoutInterface} dnsRefresh=${!!mimicDnsRefreshToken} ${mimicLogPlan || "plan=-"}`);
      }
      const mimicCommandPlan = buildMimicRuntimeSyncCmds(
        mimicRuntimeLifecycleToken,
        mimicDnsRefreshToken,
        approvedMimicRemovals,
      );
      const mimicRuntimeSyncAction = {
        statusType: "runtime",
        ruleId: 0,
        tunnelId: 0,
        op: "apply",
        forwardType: "mimic-runtime-sync",
        sourcePort: 0,
        targetIp: "",
        targetPort: 0,
        protocol: "udp",
        knownRunning: false,
        forceRuntimeSync: true,
        reportStatus: true,
        requiresMimicEnvironment: mimicFiltersByInterface.size > 0 || mimicRequestedWithoutInterface,
        failureMessage: "mimic UDP 混淆同步失败，请检查主机网卡、mimic/mimic-dkms 环境和 Agent 日志",
        commands: mimicCommandPlan.commands,
        removalCommands: mimicCommandPlan.removalCommands,
        removalToken: Array.from(approvedMimicRemovals.entries()).sort().map(([iface, token]) => `${iface}:${token}`).join(","),
        rollbackCommands: mimicCommandPlan.rollbackCommands,
      } as any;
      if (shouldSendRuntimeSyncAction(
        Number(host.id),
        mimicRuntimeSyncAction,
        false,
        responseIssuedAt,
        mimicRuntimeServiceUnhealthy || mimicRuntimeTopologyMismatch || runtimeSyncBootstrap
          ? AGENT_RUNTIME_SYNC_REPAIR_RESEND_MS
          : AGENT_MIMIC_RUNTIME_RECONCILE_MS,
      )) {
        actions.push(mimicRuntimeSyncAction);
      }
    }

    if (hasReportedRuntimeState) {
      /*
        隧道入口规则也按本机监听恢复：主机地址变了、短暂掉线、面板重启都会把这台机器的运行状态清掉
        （resetAgentRuntimeStateForHost），普通规则下一次心跳就按本机监听恢复了，隧道规则以前被排除在外，
        只能等 Agent 再报一次 —— 可 Agent 那边配置没变、不会重下发，于是流量照通、面板一直写「没在运行」
        （动态 IP 的机器隔几分钟就来一次）。现在：本机上这条规则的监听对得上（转发类型按隧道算：FXP 隧道是
        forwardx，传输版本 V1 / V2 / V3 也要对上），并且它走的隧道已经报了在跑，就一起恢复。
        守卫、内核直通这类本机形态不一样的对不上，照旧等 Agent 报。
      */
      const recoverableRules = (rules as any[]).filter((rule: any) => {
        if (
          !rule
          || !runtimeBool(rule.isEnabled)
          || runtimeBool(rule.pendingDelete)
          || runtimeBool(rule.isRunning)
          || Number(rule.sourcePort || 0) <= 0
        ) return false;
        if (!rule.tunnelId) return localRuleMatches(rule, String(rule.forwardType || ""), Number(rule.sourcePort));
        const ruleTunnel = tunnelById.get(rule.tunnelId);
        if (!ruleTunnel || !runtimeBool(ruleTunnel.isEnabled) || !runtimeBool(ruleTunnel.isRunning)) return false;
        const expectedForwardType = rule.forwardType === "gost"
          ? tunnelRuleRuntimeForwardType(ruleTunnel) || rule.forwardType
          : rule.forwardType;
        return localRuleMatches(rule, String(expectedForwardType || ""), Number(rule.sourcePort));
      });
      if (recoverableRules.length > 0) {
        await mapWithConcurrency(recoverableRules, 16, async (rule: any) => {
          await setRuntimeRuleRunning(Number(rule.id), true);
          rule.isRunning = true;
        });
        appendPanelLog(
          "info",
          `[AgentReconcile] host=${host.id} recovered running state from local listeners rules=${recoverableRules.map((rule: any) => Number(rule.id)).join(",")}`,
        );
      }
    }

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
    const effectiveActions = dropStalePortRemoveActions(actions, protectedRuleRemoveActionKeys);
    const actionBatchIssuedAt = resolveActionBatchIssuedAt(Number(host.id), effectiveActions, responseIssuedAt);
    const ruleByIdForDesired = new Map((rules as any[]).map((rule: any) => [Number(rule.id), rule]));
    const desiredKnownRunning = (action: any) => {
      if (action?.op === "remove") return true;
      /*
        V2 隧道的 WireGuard 运行时动作：本机报上来的 localState 里有这条隧道的数据面（kernel / netstack），
        就是已经在跑。原来所有 runtime 动作一律算「没在跑」，于是每台 V2 隧道两端的主机：
          - 每次心跳都有待办，永远走不上稳定快路径，每次都整份重算期望状态；
          - 期望状态每 60 秒整份重发一遍；
          - 重连后的恢复进度永远差一条（「恢复中 23/24」），每次心跳还要写一次库。
        配置变了动作内容就变，照样立刻下发（shouldSendDesiredState 比的是不含 knownRunning 的签名）；
        Agent 对 runtime 动作不看 knownRunning，按自己的记录决定要不要重做，所以这里改成 true 不影响下发。
      */
      if (action?.statusType === "runtime") {
        return action?.op === "apply"
          && String(action?.forwardType || "") === "forwardx-wireguard"
          && hasReportedRuntimeState
          && Number(action?.tunnelId || 0) > 0
          && !!getHostWireGuardPlane(Number(action.tunnelId), Number(host.id));
      }
      const ruleId = Number(action?.ruleId || 0);
      if (ruleId > 0) {
        const rule = ruleByIdForDesired.get(ruleId) as any;
        const sourcePort = Number(action?.sourcePort || 0);
        if (rule && hasReportedRuntimeState && sourcePort > 0) {
          return localRuleMatches(rule, String(action?.forwardType || rule.forwardType || ""), sourcePort);
        }
        return runtimeBool(rule?.isRunning);
      }
      const tunnelId = Number(action?.tunnelId || 0);
      if (tunnelId > 0) {
        const sourcePort = Number(action?.sourcePort || 0);
        if (hasReportedRuntimeState && sourcePort > 0) {
          return localTunnelMatches(tunnelId, String(action?.forwardType || ""), sourcePort);
        }
        const tunnel = tunnelById.get(tunnelId) as any;
        return runtimeBool(tunnel?.isRunning) || isTunnelRuntimeHostReady(tunnelId, Number(host.id));
      }
      return false;
    };
    // 每条动作只规整一次：同一份结果既出 configHash，又留给下面的 desiredStateHash 拼接。
    const desiredStatePieceByAction = new WeakMap<object, string>();
    const normalizedActions = effectiveActions.map((action: any) => {
      const statusType = action.statusType || (Number(action.ruleId) > 0 ? "rule" : (Number(action.tunnelId) > 0 ? "tunnel" : undefined));
      const normalized = {
        ...action,
        issuedAt: Number(action.issuedAt) || actionBatchIssuedAt,
        configRevision,
        knownRunning: typeof action.knownRunning === "boolean" ? action.knownRunning : desiredKnownRunning(action),
        statusType,
        // A tunnel apply can be fully adopted by the Agent's persisted local
        // runtime record. Ask it to report that adoption so a panel restart or
        // a cleared in-memory runtime map becomes ready without restarting the
        // healthy listener.
        ...(statusType === "tunnel" && action.op === "apply" && action.reportStatus === undefined
          ? { reportStatus: true }
          : {}),
      };
      return withDesiredStateConfigHash(normalized, desiredStatePieceByAction);
    });
    if (!deferActionsForLocalState) {
      const runningRuleKeys = new Set(runningRules.map((rule: any) => ruleRuntimeIdentityKey(rule.ruleId, rule.sourcePort, rule.protocol)));
      for (const action of normalizedActions) {
        if (action.op !== "apply" || !Number(action.ruleId) || !Number(action.sourcePort)) continue;
        const key = ruleRuntimeIdentityKey(action.ruleId, action.sourcePort, action.protocol);
        if (runningRuleKeys.has(key)) continue;
        addRunningRule({
          ruleId: Number(action.ruleId),
          tunnelId: Number(action.tunnelId || 0) || undefined,
          sourcePort: Number(action.sourcePort),
          ...(Number(action.sourcePortEnd || 0) > Number(action.sourcePort) ? { sourcePortEnd: Number(action.sourcePortEnd) } : {}),
          targetIp: String(action.targetIp || ""),
          targetPort: Number(action.targetPort || 0),
          protocol: action.protocol || "tcp",
          forwardType: action.forwardType || "unknown",
          failover: action.failover,
        });
        runningRuleKeys.add(key);
      }
    }
    const actionRank = (action: any) => (
      action.statusType === "runtime" ? 0 : action.op === "apply" ? 1 : 2
    );
    const orderedActions = normalizedActions.slice().sort((a: any, b: any) => actionRank(a) - actionRank(b));
    const activeWorkActions = deferActionsForLocalState
      ? []
      : orderedActions.filter((action: any) => action.op === "remove" || !action.knownRunning);
    const recoveryWasInProgress = recoveryTriggered
      || (!!previousHost.agentRecoveryStartedAt && !previousHost.agentRecoveryCompletedAt);
    if (recoveryWasInProgress) {
      const currentApplyCount = activeWorkActions.filter((action: any) => action.op === "apply").length;
      const expected = recoveryTriggered
        ? orderedActions.filter((action: any) => action.op === "apply").length
        : Math.max(Number(previousHost.agentRecoveryExpected || 0), currentApplyCount);
      const ready = Math.max(0, expected - currentApplyCount);
      const completed = !deferActionsForLocalState && currentApplyCount === 0;
      await db.updateHostHeartbeat(host.id, {
        agentRecoveryExpected: expected,
        agentRecoveryReady: completed ? expected : ready,
        ...(completed ? { agentRecoveryCompletedAt: new Date() } : {}),
      } as any);
      if (completed && !previousHost.agentRecoveryCompletedAt) {
        appendPanelLog("info", `[AgentRecovery] host=${host.id} complete ready=${expected}/${expected} bootId=${agentBootId || "-"} pid=${agentProcessId || "-"}`);
      }
    }
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
    const tunnelExitPortEntries: TunnelExitPortEntry[] = [];
    for (const runningRule of runningRules) {
      const tunnel = tunnelById.get(Number(runningRule.tunnelId || 0)) as any;
      if (!tunnel || !runningRule.failover?.enabled || (!isGostTunnelMode(tunnel) && !isForwardXTunnel(tunnel))) continue;
      tunnelExitPortEntries.push({
        ruleId: Number(runningRule.ruleId),
        kind: "scheduler",
        port: Number(runningRule.failover.listenPort),
        entryHostIds: tunnelEntryHostIds(tunnel),
      });
    }
    for (const guardRule of guardRules) {
      const tunnel = tunnelById.get(Number(guardRule?.tunnelId || 0)) as any;
      if (!tunnel || !isGostTunnelMode(tunnel)) continue;
      tunnelExitPortEntries.push({
        ruleId: Number(guardRule.ruleId),
        kind: "guard",
        port: Number(guardRule.listenPort),
        entryHostIds: tunnelEntryHostIds(tunnel),
      });
    }
    for (const helper of tunnelEgressHelpers.values()) {
      if (!helper.port) continue;
      tunnelExitPortEntries.push({
        ruleId: helper.ruleId,
        kind: "egress",
        port: helper.port,
        entryHostIds: tunnelEntryHostIds(helper.tunnel),
      });
    }
    for (const entryHostId of recordTunnelExitPorts(Number(host.id), tunnelExitPortEntries)) {
      pushAgentRefresh(entryHostId, "tunnel-exit-ports-changed");
    }
    const sniInbounds = planAgentSniInbounds({
      hostId: Number(host.id),
      agentVersion: effectiveAgentVersion,
      inbounds: hostTlsInbounds,
      rules,
    });
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
