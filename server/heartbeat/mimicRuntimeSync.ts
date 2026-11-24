/*
  从 server/agentHeartbeatRoute.ts 第 3516-3578 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { appendPanelLog } from "../_core/panelLogger";
import { shouldSendRuntimeSyncAction } from "../agentHeartbeatDispatch";
import { compactMimicFiltersForLog, shouldLogMimicRuntimePlan } from "../agentHeartbeatLogging";
import { type AgentLocalRuntimeServiceState } from "../agentHeartbeatReport";
import { AGENT_MIMIC_RUNTIME_RECONCILE_MS, AGENT_RUNTIME_SYNC_REPAIR_RESEND_MS } from "../agentHeartbeatRoute";

export type QueueMimicRuntimeSyncContext = {
  deferActionsForLocalState: any;
  mimicRuntimeSyncWanted: boolean;
  anyTunnelDnsRefresh: (tunnels: any[]) => boolean;
  hostTunnels: any;
  tunnelNeedsMimic: (tunnel: any) => boolean;
  dnsRuntimeRefreshToken: string;
  hostInterface: string;
  mimicFiltersByInterface: Map<string, Set<string>>;
  reportedMimicInterfaces: Set<string>;
  reportedMimicServicesByInterface: Map<string, AgentLocalRuntimeServiceState>;
  mimicRequestedWithoutInterface: boolean;
  host: any;
  buildMimicRuntimeSyncCmds: any;
  mimicRuntimeLifecycleToken: string;
  approvedMimicRemovals: Map<string, string>;
  responseIssuedAt: number;
  mimicRuntimeServiceUnhealthy: any;
  mimicRuntimeTopologyMismatch: boolean;
  runtimeSyncBootstrap: any;
  actions: Array<any>;
};

export function queueMimicRuntimeSync(ctx: QueueMimicRuntimeSyncContext) {
  const { deferActionsForLocalState, mimicRuntimeSyncWanted, anyTunnelDnsRefresh, hostTunnels, tunnelNeedsMimic, dnsRuntimeRefreshToken, hostInterface, mimicFiltersByInterface, reportedMimicInterfaces, reportedMimicServicesByInterface, mimicRequestedWithoutInterface, host, buildMimicRuntimeSyncCmds, mimicRuntimeLifecycleToken, approvedMimicRemovals, responseIssuedAt, mimicRuntimeServiceUnhealthy, mimicRuntimeTopologyMismatch, runtimeSyncBootstrap, actions } = ctx;
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
}
