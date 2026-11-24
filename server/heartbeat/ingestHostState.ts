/*
  从 server/agentHeartbeatRoute.ts 第 447-759 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { appendPanelLog } from "../_core/panelLogger";
import { loadAverageToStored } from "../../shared/hostLoadAverage";
import { parseAgentCapabilities } from "../../shared/ssEgress";
import { isHostMetricsWatching } from "../agentEvents";
import { AGENT_METRICS_WATCH_INTERVAL_SECONDS, buildBusyAgentHeartbeatResponse, buildReportedRuntimeHeartbeatPatch, shouldPersistAgentPresence } from "../agentHeartbeatGate";
import { resolveAgentLocalRuntimeState } from "../agentHeartbeatLocalState";
import { logAgentHeartbeatSummary } from "../agentHeartbeatLogging";
import { heartbeatIndicatesAgentReboot, heartbeatTimestampMs, resetAgentRuntimeStateForRecovery } from "../agentHeartbeatRecovery";
import { normalizeAgentLocalRuntimeState, normalizeMimicEnvironment } from "../agentHeartbeatReport";
import { AGENT_DYNAMIC_CACHE_MAX, fxpEndpointStatusCache, invalidateAgentDesiredStateCache } from "../agentHeartbeatState";
import { normalizeAgentText } from "../agentInputValidation";
import { setBoundedMapValue } from "../boundedCache";
import * as db from "../db";
import { handleHostAddressChanged } from "../hostAddressRuntime";
import { resolveHostAgentAdvertisedPanelUrl } from "../hostAgentPanelUrl";
import { isHostLiveFocused, recordHostLiveSample } from "../hostLiveMetrics";
import { recordHostLoadSample } from "../hostLoad";
import { syncHostDetectedAddressesSafely } from "../hostPublicAddressSync";
import { recordHostRateSample } from "../hostRateBuckets";
import { notifyHostOnlineIfNeeded } from "../hostStatusNotifier";
import { recordAgentRuntimeStats } from "../ops/agentRuntime";
import { recordHostRestartEvent } from "../ops/eventHooks";
import { observeHostHealthCounters, observeHostResourceSample } from "../resourceAlertNotifier";
import { recordTlsInboundRuntimeStatus } from "../tlsInboundRuntime";
import { hostBandwidthHintMbps } from "@shared/linkWeights";
import { Response } from "express";
import { isIP } from "net";

export type IngestHeartbeatHostStateContext = {
  host: any;
  localRuntimeStateSignature: string;
  req: any /* 原类型 Request<ParamsDictionary, any, any, QueryString.ParsedQs, Record<string, any>>… 引用了拿不到的 ParamsDictionary，手动收拾 */;
  dnsChangedReports: any;
  reportedAddress: any /* 原类型 AgentReportedAddress… 引用了拿不到的 AgentReportedAddress，手动收拾 */;
  wasOnline: boolean;
  previousHost: any;
  uptime: any;
  agentBootId: string;
  agentProcessId: number;
  agentProcessStartedAtSeconds: number;
  nextAgentVersion: string;
  agentVersionChanged: boolean;
  fxpVersionChanged: boolean;
  agentDistributionChanged: boolean;
  capabilitiesChanged: boolean;
  runtimeVersionChanged: boolean;
  ipv6ListenStoredChanged: boolean;
  nextCpuInfo: string;
  memoryTotal: any;
  agentLastReceivedRevision: number;
  agentLastAppliedRevision: number;
  agentLastReceivedHash: string;
  agentLastAppliedHash: string;
  busyHeartbeat: boolean;
  nextFxpVersion: string;
  reportedAgentDistribution: any /* 原类型 AgentDistribution | null… 引用了拿不到的 AgentDistribution，手动收拾 */;
  reportedCapabilities: string | null;
  reportedRuntimeVersion: string | null;
  reportedIpv6Listen: boolean | null;
  agentBootedAtSeconds: number;
  ipv6ListenEffectiveChanged: boolean;
  cpuUsage: any;
  memoryUsage: any;
  memoryUsed: any;
  swapUsage: any;
  swapUsed: any;
  swapTotal: any;
  networkIn: any;
  networkOut: any;
  diskUsage: any;
  diskUsed: any;
  diskTotal: any;
  tcpConnections: any;
  udpConnections: any;
  loadAverage: any /* 原类型 HostLoadAverage… 引用了拿不到的 HostLoadAverage，手动收拾 */;
  logHostId: number;
  logHostName: string;
  res: Response<any, Record<string, any>>;
};

export type IngestHeartbeatHostStateResult =
  | { done: true; value: undefined }
  | { done: false; mimicEnvironment: { available: boolean; version: string | null; status: string; message: string | null; } | null; recoveryTriggered: boolean; addressApplied: boolean; localRuntimeState: any /* 原类型 { state: AgentLocalRuntimeState | null; requestLocalState: boolean; }… 引用了拿不到的 AgentLocalRuntimeState，手动收拾 */; fxpEndpointEvents: any; effectiveAgentVersion: string; dnsChangedScopes: Set<string>; dnsChangedTokenByScope: Map<string, string>; dnsChangedIpByHost: Map<string, string>; rebootDetected: boolean; processRestartDetected: boolean };

export async function ingestHeartbeatHostState(ctx: IngestHeartbeatHostStateContext): Promise<IngestHeartbeatHostStateResult> {
  const { host, localRuntimeStateSignature, req, dnsChangedReports, reportedAddress, wasOnline, previousHost, uptime, agentBootId, agentProcessId, agentProcessStartedAtSeconds, nextAgentVersion, agentVersionChanged, fxpVersionChanged, agentDistributionChanged, capabilitiesChanged, runtimeVersionChanged, ipv6ListenStoredChanged, nextCpuInfo, memoryTotal, agentLastReceivedRevision, agentLastAppliedRevision, agentLastReceivedHash, agentLastAppliedHash, busyHeartbeat, nextFxpVersion, reportedAgentDistribution, reportedCapabilities, reportedRuntimeVersion, reportedIpv6Listen, agentBootedAtSeconds, ipv6ListenEffectiveChanged, cpuUsage, memoryUsage, memoryUsed, swapUsage, swapUsed, swapTotal, networkIn, networkOut, diskUsage, diskUsed, diskTotal, tcpConnections, udpConnections, loadAverage, logHostId, logHostName, res } = ctx;
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
    return { done: true as const, value: undefined };
  }
  return { done: false as const, mimicEnvironment, recoveryTriggered, addressApplied, localRuntimeState, fxpEndpointEvents, effectiveAgentVersion, dnsChangedScopes, dnsChangedTokenByScope, dnsChangedIpByHost, rebootDetected, processRestartDetected };
}
