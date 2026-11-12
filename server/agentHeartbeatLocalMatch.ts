import { isPassiveForwardXFirstHopMarker } from "./tunnelRuntimePlan";
import { buildKernelForwardTransitionCleanupCmds, buildManagedPortCleanupCmds } from "./agentActionCommands";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import { isForwardXWireGuardV2 } from "./forwardXWireGuard";
import { isForwardXV3Tunnel } from "@shared/forwardXV3";
import { resolveLocalForwardXTransportVersion } from "./agentRuntimeRuleState";
import type { AgentLocalRuntimeRuleState, AgentLocalRuntimeTunnelState } from "./agentHeartbeatReport";
import { isForwardXTunnelMode, runtimeBool } from "./agentHeartbeatRuntime";
import { SHARED_NGINX_FORWARD_TYPES } from "./agentHeartbeatNginx";
import type { HeartbeatRequestContext, HeartbeatRow } from "./agentHeartbeatContext";
import { actionPortKey, ruleRuntimePortIdentityKey } from "./agentHeartbeatDispatch";
import {
  forwardTypeCompatible,
  isKernelForwardRule,
  localForwardXTransportCompatible,
  localNumberCompatible,
  localProtocolCompatible,
  localTextCompatible,
} from "./agentHeartbeatLocalState";

/*
  拿 Agent 报上来的本地运行态（localState）和这一次的期望比：本地这条规则 / 隧道是不是已经照期望在跑、
  哪些端口要保护起来不拆、本地多出来的规则 / 隧道该发什么 remove、停用的内核转发规则还要不要清。
  从 server/agentHeartbeatRoute.ts 的心跳处理函数里搬出来：语句原样不动，原来从闭包里读的值改由
  ctx（本次请求只读的值，见 agentHeartbeatContext.ts）和 deps（本次上报整理出来的本地状态、辅助闭包）在开头解构出来。
*/

export type LocalRuntimeMatchDeps = {
  buildNginxPortCleanupCmds: (rule: HeartbeatRow) => string[];
  hasReportedRuntimeState: boolean;
  localRulesByPort: Map<number, AgentLocalRuntimeRuleState>;
  localTunnelsByPort: Map<number, AgentLocalRuntimeTunnelState>;
  processTarget: (rule: HeartbeatRow) => HeartbeatRow;
  protectedRuleRemoveActionKeys: Set<string>;
  reportedLocalRules: AgentLocalRuntimeRuleState[];
};

export function createLocalRuntimeMatchers(ctx: HeartbeatRequestContext, deps: LocalRuntimeMatchDeps) {
  const { tunnelById } = ctx;
  const {
    buildNginxPortCleanupCmds,
    hasReportedRuntimeState,
    localRulesByPort,
    localTunnelsByPort,
    processTarget,
    protectedRuleRemoveActionKeys,
    reportedLocalRules,
  } = deps;
  const expectedForwardXTransportVersion = (tunnelId: number, expectedForwardType: string) => {
    const normalizedType = String(expectedForwardType || "").trim();
    if (normalizedType !== "forwardx" && normalizedType !== "forwardx-tunnel") return undefined;
    const tunnel = tunnelById.get(Number(tunnelId || 0)) as any;
    if (!isForwardXTunnelMode(tunnel)) return undefined;
    if (isForwardXV3Tunnel(tunnel)) return "v3" as const;
    return isForwardXWireGuardV2(tunnel) ? "v2" as const : "v1" as const;
  };
  const findLocalRuleState = (port: number, protocol: unknown, ruleId?: number) => {
    const normalizedProtocol = normalizeForwardRuleProtocol(protocol, "both");
    const candidates = reportedLocalRules.filter((local: AgentLocalRuntimeRuleState) => Number(local.port || 0) === Number(port || 0));
    const exact = candidates.find((local: AgentLocalRuntimeRuleState) => (
      (ruleId === undefined || Number(local.ruleId || 0) === Number(ruleId || 0))
      && localProtocolCompatible(local.protocol, normalizedProtocol)
    ));
    return exact || candidates.find((local: AgentLocalRuntimeRuleState) => localProtocolCompatible(local.protocol, normalizedProtocol)) || localRulesByPort.get(port);
  };
  const localRuleMatches = (rule: any, expectedForwardType: string, port: number) => {
    if (!hasReportedRuntimeState || port <= 0) return true;
    const local = findLocalRuleState(port, rule.protocol, Number(rule.id));
    return !!local
      && local.ready !== false
      && Number(local.ruleId || 0) === Number(rule.id)
      && (Number(local.tunnelId || 0) <= 0 || Number(local.tunnelId || 0) === Number(rule?.tunnelId || 0))
      && forwardTypeCompatible(local.forwardType, expectedForwardType)
      && localForwardXTransportCompatible(local, expectedForwardXTransportVersion(Number(rule?.tunnelId || 0), expectedForwardType))
      && (localTextCompatible(local.targetIp, processTarget(rule)) || localTextCompatible(local.targetIp, rule.targetIp))
      && localNumberCompatible(local.targetPort, rule.targetPort)
      && localProtocolCompatible(local.protocol, rule.protocol);
  };
  const protectActiveRulePort = (rule: any, port = Number(rule?.sourcePort || 0)) => {
    const ruleId = Number(rule?.id || 0);
    if (ruleId <= 0 || port <= 0 || runtimeBool(rule?.pendingDelete)) return;
    protectedRuleRemoveActionKeys.add(actionPortKey({
      statusType: "rule",
      ruleId,
      sourcePort: port,
      protocol: rule.protocol,
    }));
    protectedRuleRemoveActionKeys.add(ruleRuntimePortIdentityKey(ruleId, port));
  };
  const localTunnelMatches = (
    tunnelId: number,
    expectedForwardType: string,
    port: number,
    options: { allowPassiveForwardXFirstHop?: boolean } = {},
  ) => {
    if (!hasReportedRuntimeState || port <= 0) return true;
    const local = localTunnelsByPort.get(port);
    const passiveForwardXFirstHop = isPassiveForwardXFirstHopMarker({
      isFirstHop: !!options.allowPassiveForwardXFirstHop,
      tunnelId,
      port,
      local,
    });
    return !!local
      && (local.ready !== false || passiveForwardXFirstHop)
      && Number(local.tunnelId || 0) === Number(tunnelId)
      && forwardTypeCompatible(local.forwardType, expectedForwardType)
      && (passiveForwardXFirstHop || localForwardXTransportCompatible(local, expectedForwardXTransportVersion(tunnelId, expectedForwardType)));
  };
  const buildGenericLocalRuleRemovalAction = (local: AgentLocalRuntimeRuleState) => {
    const port = Number(local.port || 0);
    const forwardType = String(local.forwardType || "").trim() || "unknown";
    const protocol = local.protocol || "both";
    const transportVersion = resolveLocalForwardXTransportVersion({
      reportedTransportVersion: local.transportVersion,
      tunnel: tunnelById.get(Number(local.tunnelId || 0)),
    });
    const fxp = forwardType === "forwardx" && Number(local.ruleId || 0) > 0
      ? {
          role: "entry",
          ...(transportVersion ? { transportVersion } : {}),
          tunnelId: Number(local.tunnelId || 0),
          ruleId: Number(local.ruleId || 0),
          listenPort: port,
          protocol,
          key: "",
        }
      : undefined;
    const cleanupCmds = SHARED_NGINX_FORWARD_TYPES.has(forwardType)
      ? [
        // A local nginx state record may be the result of a previous
        // nftables -> nginx handoff.  Shared-nginx cleanup intentionally
        // keeps the shared daemon alive, so also remove any per-rule kernel
        // forwarding state left behind by an older Agent.
        ...buildKernelForwardTransitionCleanupCmds({
          id: Number(local.ruleId || 0),
          sourcePort: port,
          targetIp: local.targetIp || "",
          targetPort: Number(local.targetPort || 0),
          protocol,
        }),
        ...buildNginxPortCleanupCmds({
          sourcePort: port,
          targetIp: local.targetIp || "",
          targetPort: Number(local.targetPort || 0),
          protocol,
        }),
      ]
      : [
        ...buildManagedPortCleanupCmds(port, local.targetIp, local.targetPort, protocol),
        ...(fxp ? [] : [
          `for pid in $(pgrep -f '[f]orwardx-fxp.*fxp-.*-${port}\\\\.json' 2>/dev/null || true); do if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi; kill "$pid" 2>/dev/null || true; done`,
          `rm -f /run/forwardx-agent/fxp-*-${port}.json 2>/dev/null || true`,
        ]),
        `rm -f /var/lib/forwardx-agent/tunnel_${port}.id /var/lib/forwardx-agent/tunnel_${port}.fwtype 2>/dev/null || true`,
      ];
    return {
      ruleId: Number(local.ruleId || 0),
      tunnelId: Number(local.tunnelId || 0),
      statusType: "rule",
      op: "remove",
      forwardType,
      sourcePort: port,
      targetIp: local.targetIp || "",
      targetPort: Number(local.targetPort || 0),
      protocol,
      commands: cleanupCmds,
      fxp,
    };
  };
  const buildGenericLocalTunnelRemovalAction = (local: AgentLocalRuntimeTunnelState) => {
    const port = Number(local.port || 0);
    const forwardType = String(local.forwardType || "").trim() || "gost-tunnel";
    const cleanupCmds = SHARED_NGINX_FORWARD_TYPES.has(forwardType)
      ? [
        ...buildNginxPortCleanupCmds({
          sourcePort: port,
          targetIp: "",
          targetPort: port,
          protocol: "tcp",
        }),
        `rm -f /var/lib/forwardx-agent/tunnel_${port}.id /var/lib/forwardx-agent/tunnel_${port}.fwtype 2>/dev/null || true`,
      ]
      : [
        ...buildManagedPortCleanupCmds(port),
        `for pid in $(pgrep -f '[f]orwardx-fxp.*fxp-.*-${port}\\\\.json' 2>/dev/null || true); do if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi; kill "$pid" 2>/dev/null || true; done`,
        `rm -f /run/forwardx-agent/fxp-*-${port}.json /var/lib/forwardx-agent/tunnel_${port}.id /var/lib/forwardx-agent/tunnel_${port}.fwtype 2>/dev/null || true`,
      ];
    return {
      tunnelId: Number(local.tunnelId || 0),
      statusType: "tunnel",
      ruleId: 0,
      op: "remove",
      forwardType,
      sourcePort: port,
      targetIp: "",
      targetPort: port,
      protocol: "tcp",
      commands: cleanupCmds,
    };
  };
  const localRuleNeedsRemoval = (rule: any) => {
    if (!hasReportedRuntimeState) return true;
    const port = Number(rule?.sourcePort || 0);
    if (port <= 0) return true;
    const local = findLocalRuleState(port, rule.protocol, Number(rule?.id || 0));
    if (!local) return true;
    if (isKernelForwardRule(rule)) return true;
    return Number(local.ruleId || 0) === Number(rule?.id || 0);
  };
  const localRuleHasKernelForwardState = (rule: any) => {
    if (!hasReportedRuntimeState) return false;
    const local = findLocalRuleState(
      Number(rule?.sourcePort || 0),
      rule?.protocol,
      Number(rule?.id || 0),
    );
    return !!local
      && Number(local.ruleId || 0) === Number(rule?.id || 0)
      && isKernelForwardRule(local);
  };
  return {
    buildGenericLocalRuleRemovalAction,
    buildGenericLocalTunnelRemovalAction,
    localRuleHasKernelForwardState,
    localRuleMatches,
    localRuleNeedsRemoval,
    localTunnelMatches,
    protectActiveRulePort,
  };
}
