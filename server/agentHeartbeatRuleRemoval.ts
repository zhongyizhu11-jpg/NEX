import { tunnelSecretSeed } from "./agentRouteUtils";
import {
  buildCountingCleanupCmds,
  buildIptablesForwardCleanupCmds,
  buildIptablesTransitionCleanupCmds,
  buildKernelForwardTransitionCleanupCmds,
  buildManagedPortCleanupCmds,
  buildNftCleanupCmds,
  buildNftTransitionCleanupCmds,
  killByPatternCmd,
  removeManagedServiceCmd,
  shQuote,
} from "./agentActionCommands";
import { realmConfigPathForPort, realmServiceNameForPort, socatServiceNameForPort } from "./forwardRuntimeConfigs";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import { isForwardXWireGuardV2 } from "./forwardXWireGuard";
import { legacyRealmCleanupCmds, legacySocatCleanupCmds, socatKillByProtocolCmd } from "./agentHeartbeatRuntime";
import { isNginxTunnelMode } from "./agentHeartbeatNginx";
import { cleanupGuardBackendCmds } from "./agentHeartbeatProtocolGuard";
import { buildAccessLimitCleanupCmds } from "./agentHeartbeatAccessLimits";
import type { HeartbeatRequestContext, HeartbeatRow } from "./agentHeartbeatContext";

/*
  停用 / 删除中的规则要发的那条 remove 动作：按转发方式拼清理命令（进程、iptables / nftables、计数链、
  连接数限制、守卫后端、nginx 端口文件），走 FXP 隧道的再带上要撤掉的入口路由。
  从 server/agentHeartbeatRoute.ts 的心跳处理函数里搬出来：函数体原样不动，原来从闭包里读的值改由
  ctx（本次请求只读的值，见 agentHeartbeatContext.ts）和 deps（处理函数里的辅助闭包）在开头解构出来。
*/

export type DisabledRuleRemovalDeps = {
  accessScopeForRule: (rule: HeartbeatRow) => string;
  buildNginxPortCleanupCmds: (rule: HeartbeatRow) => string[];
  forwardXEntryRoute: (tunnel: HeartbeatRow) => Promise<{ hostId: number; host: string; port: number; udpPort: number; key: string; }>;
  isForwardXTunnel: (tunnel: HeartbeatRow) => boolean;
};

export function createDisabledRuleRemovalBuilder(ctx: HeartbeatRequestContext, deps: DisabledRuleRemovalDeps) {
  const { tunnelById } = ctx;
  const { accessScopeForRule, buildNginxPortCleanupCmds, forwardXEntryRoute, isForwardXTunnel } = deps;
  const buildDisabledRuleRemovalAction = async (rule: any) => {
    const tunnel = (rule as any).tunnelId ? tunnelById.get((rule as any).tunnelId) as any : null;
    if (rule.forwardType === "iptables") {
      const cmds: string[] = [
        ...buildNftTransitionCleanupCmds(rule),
        ...buildIptablesForwardCleanupCmds(rule),
        ...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
        ...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)),
      ];
      return {
        ruleId: rule.id,
        op: "remove",
        forwardType: rule.forwardType,
        sourcePort: rule.sourcePort,
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        commands: cmds,
      };
    }
    if (rule.forwardType === "nftables") {
      const cmds = [
        ...buildIptablesTransitionCleanupCmds(rule),
        ...buildNftCleanupCmds(rule, { removeStateFiles: false, cleanupConntrack: true }),
        ...buildManagedPortCleanupCmds(Number(rule.sourcePort), rule.targetIp, rule.targetPort, rule.protocol),
      ];
      cmds.push(...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)));
      return {
        ruleId: rule.id,
        op: "remove",
        forwardType: rule.forwardType,
        sourcePort: rule.sourcePort,
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        commands: cmds,
      };
    }
    if (rule.forwardType === "realm") {
      const svcName = realmServiceNameForPort(rule.sourcePort, rule.protocol);
      const realmConfigPath = realmConfigPathForPort(rule.sourcePort, rule.protocol);
      return {
        ruleId: rule.id,
        op: "remove",
        forwardType: rule.forwardType,
        sourcePort: rule.sourcePort,
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        svcName,
        commands: [
          ...buildKernelForwardTransitionCleanupCmds(rule),
          removeManagedServiceCmd(svcName),
          killByPatternCmd(`[r]ealm .*${realmConfigPath}`),
          ...legacyRealmCleanupCmds(rule.sourcePort, rule.protocol),
          `rm -f ${shQuote(realmConfigPath)} ${shQuote(`${realmConfigPath}.sha256`)} 2>/dev/null || true`,
          ...cleanupGuardBackendCmds(rule),
          `rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`,
          `rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule /var/lib/forwardx-agent/port_${rule.sourcePort}.tunnel 2>/dev/null || true`,
          ...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
          ...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)),
        ],
      };
    }
    if (rule.forwardType === "socat") {
      const removeCmds: string[] = [];
      if (normalizeForwardRuleProtocol(rule.protocol) === "both") {
        const svcTcp = `forwardx-socat-tcp-${rule.sourcePort}`;
        const svcUdp = `forwardx-socat-udp-${rule.sourcePort}`;
        removeCmds.push(removeManagedServiceCmd(svcTcp));
        removeCmds.push(removeManagedServiceCmd(svcUdp));
      } else {
        const svcName = socatServiceNameForPort(rule.sourcePort, rule.protocol);
        removeCmds.push(removeManagedServiceCmd(svcName));
        removeCmds.push(...legacySocatCleanupCmds(rule.sourcePort, rule.protocol));
      }
      removeCmds.push(socatKillByProtocolCmd(rule.sourcePort, rule.protocol));
      removeCmds.push(...buildKernelForwardTransitionCleanupCmds(rule));
      removeCmds.push(...cleanupGuardBackendCmds(rule));
      removeCmds.push(`rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`);
      removeCmds.push(`rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule /var/lib/forwardx-agent/port_${rule.sourcePort}.tunnel 2>/dev/null || true`);
      removeCmds.push(...buildCountingCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol));
      removeCmds.push(...buildAccessLimitCleanupCmds(rule.sourcePort, accessScopeForRule(rule)));
      return {
        ruleId: rule.id,
        op: "remove",
        forwardType: rule.forwardType,
        sourcePort: rule.sourcePort,
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        commands: removeCmds,
      };
    }
    if (rule.forwardType === "nginx") {
      return {
        ruleId: rule.id,
        op: "remove",
        forwardType: rule.forwardType,
        sourcePort: rule.sourcePort,
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        commands: [
          ...buildKernelForwardTransitionCleanupCmds(rule),
          ...buildNginxPortCleanupCmds(rule),
          ...cleanupGuardBackendCmds(rule),
        ],
      };
    }
    if (rule.forwardType === "gost") {
      if (tunnel && isNginxTunnelMode(tunnel)) {
        return {
          ruleId: rule.id,
          tunnelId: tunnel.id,
          statusType: "rule",
          op: "remove",
          forwardType: "nginx-tunnel",
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          commands: [
            ...buildKernelForwardTransitionCleanupCmds(rule),
            ...buildNginxPortCleanupCmds(rule),
            ...cleanupGuardBackendCmds(rule),
          ],
        };
      }
      const fxpRemoveKey = tunnel && isForwardXTunnel(tunnel)
        ? (await forwardXEntryRoute(tunnel)).key
        : "";
      return {
        tunnelId: tunnel ? tunnel.id : 0,
        statusType: tunnel ? "rule" : undefined,
        ruleId: rule.id,
        op: "remove",
        forwardType: rule.forwardType,
        sourcePort: rule.sourcePort,
        targetIp: rule.targetIp,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        commands: [
          ...buildKernelForwardTransitionCleanupCmds(rule),
          ...buildManagedPortCleanupCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol),
          ...cleanupGuardBackendCmds(rule),
        ],
        fxp: tunnel && isForwardXTunnel(tunnel) ? {
          role: "entry",
          transportVersion: isForwardXWireGuardV2(tunnel) ? "v2" : "v1",
          tunnelId: tunnel.id,
          ruleId: rule.id,
          listenPort: rule.sourcePort,
          protocol: rule.protocol,
          key: fxpRemoveKey || tunnelSecretSeed(tunnel),
        } : undefined,
      };
    }
    return null;
  };
  return { buildDisabledRuleRemovalAction };
}
