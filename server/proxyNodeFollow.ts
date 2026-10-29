import { and, eq, like } from "drizzle-orm";

import { forwardRules } from "../drizzle/schema";
import { parseRoutePaths, serializeRoutePaths } from "../shared/routeGroup";
import { appendPanelLog } from "./_core/panelLogger";
import { pushAgentRefresh } from "./agentEvents";
import { getDb } from "./dbRuntime";
import { getProxyNodeById } from "./repositories/proxySubscriptionRepository";
import { syncForwardGroupRules } from "./repositories/forwardGroupRepository";
import { getForwardRuleById, updateForwardRule } from "./repositories/forwardRuleRepository";
import { dbBool } from "./repositories/repositoryUtils";
import { getTunnelById } from "./repositories/tunnelRepository";
import { syncRouteRelayRulesForRule } from "./routeGroups";

/*
  「落地统一引用」里的那条规矩：转发的目标是我的某个节点时，节点地址变了，转发跟着变。

  以前转发目标和节点各记各的地址，节点地址一变（换机房、主机改了入口地址、重新粘了链接），
  规则在订阅里变成「指向已变」，要人回去改。现在凡是绑着这个节点的转发（forward_rules.proxyNodeId）
  和线路组里落地选了这个节点的路径（RoutePath.destNodeId），都在这里改成新地址并推给 Agent。

  谁来叫它：派生节点跟着入站 / 主机地址重算时（proxyInboundRepository.syncProxyNodeFromInbound），
  以及用户给节点换了链接时（proxySubscriptions.updateNode）。
*/

export type ProxyNodeFollowResult = { nodeId: number; retargeted: number[]; routePaths: number[] };

function sameEndpoint(ip: unknown, port: unknown, address: string, nodePort: number) {
  const left = String(ip || "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return left === address.toLowerCase().replace(/^\[/, "").replace(/\]$/, "") && Number(port) === nodePort;
}

async function refreshRule(rule: any, reason: string) {
  const hostId = Number(rule.hostId || 0);
  if (hostId > 0) pushAgentRefresh(hostId, reason, { urgent: true });
  const tunnelId = Number(rule.tunnelId || 0);
  if (tunnelId > 0) {
    const tunnel = await getTunnelById(tunnelId) as any;
    for (const id of [Number(tunnel?.entryHostId || 0), Number(tunnel?.exitHostId || 0)]) {
      if (id > 0 && id !== hostId) pushAgentRefresh(id, reason, { urgent: true });
    }
  }
}

/** 节点的地址或端口变了：把绑着它的转发、落地选它的线路组路径一并改过去。 */
export async function followBoundRulesToNode(nodeId: number, reason = "proxy-node-moved"): Promise<ProxyNodeFollowResult> {
  const id = Math.floor(Number(nodeId) || 0);
  const result: ProxyNodeFollowResult = { nodeId: id, retargeted: [], routePaths: [] };
  const db = await getDb();
  if (!db || id <= 0) return result;
  const node = await getProxyNodeById(id) as any;
  const address = String(node?.address || "").trim();
  const port = Math.floor(Number(node?.port) || 0);
  if (!node || !address || port <= 0) return result;

  const bound = (await db
    .select()
    .from(forwardRules)
    .where(and(eq(forwardRules.proxyNodeId, id), eq(forwardRules.pendingDelete, false)))) as any[];
  for (const rule of bound) {
    // 转发组成员和线路组中继由各自的模板 / 父规则带着走，自己不动。
    if (Number(rule.forwardGroupRuleId || 0) > 0 || Number(rule.routeParentRuleId || 0) > 0) continue;
    if (sameEndpoint(rule.targetIp, rule.targetPort, address, port)) continue;
    await updateForwardRule(Number(rule.id), { targetIp: address, targetPort: port, isRunning: false } as any);
    if (dbBool(rule.isForwardGroupTemplate) && Number(rule.forwardGroupId || 0) > 0) {
      await syncForwardGroupRules(Number(rule.forwardGroupId));
    }
    if (dbBool(rule.failoverEnabled)) await syncRouteRelayRulesForRule(Number(rule.id), { reason });
    await refreshRule(rule, reason);
    result.retargeted.push(Number(rule.id));
  }

  // 线路组路径的落地选的是这个节点：重新解析一遍，dest 跟着节点走（中继规则的目标也会跟着改）。
  const marker = `%"destNodeId":${id}%`;
  const referencing = (await db
    .select({ id: forwardRules.id, routePaths: forwardRules.routePaths, hostId: forwardRules.hostId, tunnelId: forwardRules.tunnelId })
    .from(forwardRules)
    .where(and(like(forwardRules.routePaths, marker), eq(forwardRules.pendingDelete, false)))) as any[];
  for (const row of referencing) {
    const paths = parseRoutePaths(row.routePaths);
    if (!paths.some((path) => path.destNodeId === id && !(path.dest && sameEndpoint(path.dest.ip, path.dest.port, address, port)))) continue;
    const next = paths.map((path) => (path.destNodeId === id ? { ...path, dest: { ip: address, port } } : path));
    await updateForwardRule(Number(row.id), { routePaths: serializeRoutePaths(next) } as any);
    await syncRouteRelayRulesForRule(Number(row.id), { reason });
    const fresh = await getForwardRuleById(Number(row.id));
    if (fresh) await refreshRule(fresh, reason);
    result.routePaths.push(Number(row.id));
  }

  if (result.retargeted.length > 0 || result.routePaths.length > 0) {
    appendPanelLog("info", `[ProxyNode] node=${id} 地址变为 ${address}:${port}，跟着改了 ${result.retargeted.length} 条转发、${result.routePaths.length} 条线路组`);
  }
  return result;
}
