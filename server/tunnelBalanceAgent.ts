import { agentSupportsUnifiedBalance, UNIFIED_BALANCE_AGENT_VERSION } from "@shared/loadBalance";

/*
  GOST 链路开了负载均衡、入口机的 Agent 却还不能执行统一调度时，给链路和走它的规则的那句「需要升级 Agent」。

  几台出口之间怎么分、怎么切，全在入口机 Agent 的本机代理里做（server/gostBalancePlan.ts），没有老路可退：
  入口机的 Agent 低于 UNIFIED_BALANCE_AGENT_VERSION 时面板只下发主出口一台。这种链路流量是通的，可负载均衡
  一点没生效 —— 光看状态点看不出来，所以直接写在链路和规则上（和 FXP 版本过旧同一个位置：tunnels.list 的
  fxpIssues，见 server/tunnelFxpRuntime.ts；非管理员看不到的主机照样不报名字和版本）。
*/

type HostLite = { id?: unknown; name?: unknown; agentVersion?: unknown };

export type TunnelBalanceAgentIssue = { hostId: number; hostName: string; fxpVersion: null; message: string };

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
}

/** entryHostIds：这条链路的入口机（入口组时是组里启用的成员）；extraExitCount：启用的额外出口节点数。 */
export function tunnelBalanceAgentIssues(
  tunnel: { mode?: unknown; loadBalanceEnabled?: unknown; loadBalanceStrategy?: unknown } | null | undefined,
  entryHostIds: readonly unknown[],
  extraExitCount: number,
  hostById: ReadonlyMap<number, HostLite>,
): TunnelBalanceAgentIssue[] {
  const mode = String(tunnel?.mode || "").trim().toLowerCase();
  if (!tunnel || mode === "forwardx" || mode === "nginx_stream") return [];
  if (!truthy(tunnel.loadBalanceEnabled) || !(extraExitCount > 0)) return [];
  const issues: TunnelBalanceAgentIssue[] = [];
  const seen = new Set<number>();
  for (const value of entryHostIds) {
    const hostId = Number(value || 0);
    if (!Number.isFinite(hostId) || hostId <= 0 || seen.has(hostId)) continue;
    seen.add(hostId);
    const host = hostById.get(hostId);
    if (!host || agentSupportsUnifiedBalance(host.agentVersion)) continue;
    const hostName = String(host.name || "").trim() || `主机 ${hostId}`;
    const current = String(host.agentVersion || "").trim() || "未知";
    issues.push({
      hostId,
      hostName,
      fxpVersion: null,
      message: `入口 ${hostName} 的 Agent（${current}）低于 ${UNIFIED_BALANCE_AGENT_VERSION}，负载均衡没有生效、只走主出口，需要升级 Agent`,
    });
  }
  return issues;
}
