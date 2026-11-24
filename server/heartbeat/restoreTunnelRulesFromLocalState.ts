/*
  从 server/agentHeartbeatRoute.ts 第 3579-3670 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { appendPanelLog } from "../_core/panelLogger";
import type { HeartbeatTunnelRow } from "../agentHeartbeatContext";
import { rememberHostWaitingForTunnels } from "../agentHeartbeatGate";
import { runtimeBool } from "../agentHeartbeatRuntime";
import { mapWithConcurrency } from "../asyncPool";
import * as db from "../db";
import { isTunnelProtocolEnabled } from "../forwardProtocolSettings";
import { setRuntimeRuleRunning } from "../ruleEntryBridges";
import { tunnelRuleRuntimeForwardType } from "../tunnelRuntimePlan";
import { getTunnelRuntimeTopologyStatus } from "../tunnelRuntimeStatus";

export type RestoreTunnelRulesFromLocalStateContext = {
  hasReportedRuntimeState: boolean;
  forwardProtocolSettings: any;
  tunnelHopsByTunnelId: Map<number, Array<any>>;
  isCurrentHostTunnelEntry: (tunnel: any) => boolean;
  host: any;
  tunnelExitNodesByTunnelId: Map<number, Array<any>>;
  tunnelEntryHostIds: (tunnel: any) => Array<number>;
  hostTunnels: any;
  tunnelById: Map<any, any>;
  rules: Array<any>;
  localRuleMatches: (rule: any, expectedForwardType: string, port: number) => boolean;
};

export async function restoreTunnelRulesFromLocalState(ctx: RestoreTunnelRulesFromLocalStateContext) {
  const { hasReportedRuntimeState, forwardProtocolSettings, tunnelHopsByTunnelId, isCurrentHostTunnelEntry, host, tunnelExitNodesByTunnelId, tunnelEntryHostIds, hostTunnels, tunnelById, rules, localRuleMatches } = ctx;
  if (hasReportedRuntimeState) {
    /*
      隧道入口规则也按本机监听恢复：主机地址变了、短暂掉线、面板重启都会把这台机器的运行状态清掉
      （resetAgentRuntimeStateForHost），普通规则下一次心跳就按本机监听恢复了，隧道规则以前被排除在外，
      只能等 Agent 再报一次 —— 可 Agent 那边配置没变、不会重下发，于是流量照通、面板一直写「没在运行」
      （动态 IP 的机器隔几分钟就来一次）。现在：本机上这条规则的监听对得上（转发类型按隧道算：FXP 隧道是
      forwardx，传输版本 V1 / V2 / V3 也要对上），并且它走的隧道已经报了在跑，就一起恢复。
      守卫、内核直通这类本机形态不一样的对不上，照旧等 Agent 报。

      隧道本身（tunnels.isRunning）也一样被清：这台是入口时 resetAgentRuntimeStateForHost 连它走的隧道一起
      写成没在运行，可出口那台什么都没变 —— FXP 隧道的出口动作只看「出口报过的运行状态」（内存里的
      tunnelRuntimeStatus，只清地址变了的那台），不会重下发、出口也就不会再报；规则这边又要等隧道在跑，
      两头互相等，只能碰运气等入口的隧道测速把隧道写回来（2026-11 联调：隔几分钟清一次，规则 8 一直没恢复）。
      所以：单跳隧道（没有中转）在这台是入口、出口那台报过的运行状态还在（自它上次报告以来出口没被清过、
      隧道没改过），就按出口的报告把隧道恢复成在运行，规则接着按上面的条件恢复。出口没报过、报的是没在跑、
      或者是多跳隧道，照旧等各自的上报。
    */
    const exitConfirmedTunnelIds = new Set<number>();
    const tunnelExitRuntimeConfirmed = (tunnel: HeartbeatTunnelRow) => {
      const tunnelId = Number(tunnel?.id || 0);
      if (
        tunnelId <= 0
        || !runtimeBool(tunnel?.isEnabled)
        || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
        || (tunnelHopsByTunnelId.get(tunnelId) || []).length > 0
        || !isCurrentHostTunnelEntry(tunnel)
        || Number(tunnel?.exitHostId || 0) === Number(host.id)
      ) return false;
      const extraExitHostIds = (tunnelExitNodesByTunnelId.get(tunnelId) || [])
        .filter((node) => runtimeBool(node?.isEnabled, true))
        .map((node) => Number(node?.hostId || 0))
        .filter((hostId: number) => hostId > 0);
      return getTunnelRuntimeTopologyStatus(tunnelId, {
        entryHostIds: tunnelEntryHostIds(tunnel),
        hopHostIds: [],
        primaryExitHostId: Number(tunnel.exitHostId || 0),
        extraExitHostIds,
        relayMode: String(tunnel.relayMode || "chain"),
        loadBalanceEnabled: runtimeBool(tunnel.loadBalanceEnabled),
        loadBalanceStrategy: String(tunnel.loadBalanceStrategy || "none"),
      }).running;
    };
    for (const tunnel of hostTunnels) {
      if (!tunnel || runtimeBool(tunnel.isRunning) || !tunnelExitRuntimeConfirmed(tunnel)) continue;
      exitConfirmedTunnelIds.add(Number(tunnel.id));
    }
    if (exitConfirmedTunnelIds.size > 0) {
      await mapWithConcurrency(Array.from(exitConfirmedTunnelIds), 8, async (tunnelId: number) => {
        await db.updateTunnelRunningStatus(tunnelId, true);
        const tunnel = tunnelById.get(tunnelId);
        if (tunnel) tunnel.isRunning = true;
      });
      appendPanelLog(
        "info",
        `[AgentReconcile] host=${host.id} recovered tunnel running state from exit runtime reports tunnels=${Array.from(exitConfirmedTunnelIds).join(",")}`,
      );
    }
    // 本机监听对得上、就差隧道没在跑的规则：记下在等哪几条隧道，隧道一回来就作废稳定快路径（见 agentHeartbeatGate）。
    const waitingTunnelIds = new Set<number>();
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
      if (!ruleTunnel || !runtimeBool(ruleTunnel.isEnabled)) return false;
      const expectedForwardType = rule.forwardType === "gost"
        ? tunnelRuleRuntimeForwardType(ruleTunnel) || rule.forwardType
        : rule.forwardType;
      const localMatches = localRuleMatches(rule, String(expectedForwardType || ""), Number(rule.sourcePort));
      if (!runtimeBool(ruleTunnel.isRunning)) {
        if (localMatches) waitingTunnelIds.add(Number(ruleTunnel.id));
        return false;
      }
      return localMatches;
    });
    rememberHostWaitingForTunnels(host.id, waitingTunnelIds);
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
}
