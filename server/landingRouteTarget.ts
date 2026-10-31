import { appendPanelLog } from "./_core/panelLogger";
import { pushAgentRefresh } from "./agentEvents";
import * as db from "./db";
import { getNodePool } from "./nodePools";
import { dbBool } from "./repositories/repositoryUtils";
import { getHostEntryAddress } from "../shared/hostEntryAddress";
import { MAX_LANDING_POOL_MEMBERS, parseLandingState } from "../shared/landingPool";
import type { RouteEndpoint, RoutePath } from "../shared/routeGroup";
import type { RouteLandingPoolInfo } from "../shared/routeLines";

/*
  转发 / 线路的落地是落地池（2.3.500，server/landingPools.ts）：

    · 线路：落地候选选的是池节点（或者「规则目标」绑着池节点）→ 展开成池里每台开着的成员一条路径
      （shared/routeLines.ts 的 landingPool 上下文，路径带 destHostId）；下发前按那台的成员入站解析
      地址端口（resolveLandingPoolDests，server/routeGroups.ts 调）。
    · 普通转发的目标选了池节点：能做成线路组的（gost / realm / socat / nginx 转发，管理员或隧道 / 端口转发
      资源上的规则），保存时直接做成「一条线路、落地 = 这个池」的线路组，新连接在几台里分（按负载）；
      做不成的（iptables / nftables、普通用户的普通端口转发）只能指向一台：池节点的首选那台，坏了跟着换。
*/

export type LandingMemberEndpoint = {
  hostId: number;
  dest: RouteEndpoint | null;
  /** 成员入站开出来了、没报错、那台有对外地址。 */
  ready: boolean;
  issue: string | null;
};

export type LandingPoolEndpoints = { poolId: number; name: string; members: LandingMemberEndpoint[] };

/** 池节点 → 它的落地池和每台成员的落地地址（不是池节点返回 null）。 */
export async function landingEndpointsForNode(nodeId: number): Promise<LandingPoolEndpoints | null> {
  const node = await db.getProxyNodeById(Number(nodeId)) as any;
  const poolId = Number(node?.nodePoolId || 0);
  if (!node || !(poolId > 0)) return null;
  const pool = await getNodePool(poolId);
  if (!pool || pool.role !== "landing") return { poolId, name: String(node.name || "落地池"), members: [] };
  const { getLandingMemberInbounds } = await import("./landingPools");
  const rows = await getLandingMemberInbounds(poolId);
  const states = parseLandingState(pool.landingStateJson);
  const hostIds = pool.hostIds.slice(0, MAX_LANDING_POOL_MEMBERS);
  const hosts = hostIds.length > 0 ? await db.getHostsByIds(hostIds) as any[] : [];
  const hostById = new Map(hosts.map((host) => [Number(host.id), host]));
  const members = hostIds.map((hostId): LandingMemberEndpoint => {
    const row = rows.find((item) => Number(item.hostId) === hostId);
    const state = states.find((item) => item.hostId === hostId);
    const address = getHostEntryAddress(hostById.get(hostId));
    const port = Number(row?.port || 0);
    const dest = address && port > 0 ? { ip: address, port } : null;
    const issue = state?.error
      || (!row ? "这台的落地还没开出来" : !dbBool(row.isEnabled, true) ? "这台的落地停用了" : !address ? "这台机器还没有对外地址" : null);
    return { hostId, dest, ready: !issue && !!dest, issue };
  });
  return { poolId, name: pool.name, members };
}

/**
 * 线路展开用：这几个节点里是池节点的，各自的落地池里开着的成员。只认规则主人看得见的节点（自己的，
 * 或者分享给他的）；管理员都行。
 */
export async function routeLandingPoolsForNodes(actor: { id: number; role: string }, nodeIds: readonly number[]): Promise<Map<number, RouteLandingPoolInfo>> {
  const result = new Map<number, RouteLandingPoolInfo>();
  const ids = Array.from(new Set(nodeIds.map(Number).filter((id) => id > 0)));
  if (ids.length === 0) return result;
  const visible = actor.role === "admin"
    ? null
    : new Set((await db.getProxyNodesForSubscription(Number(actor.id)) as any[]).map((node) => Number(node.id)));
  for (const nodeId of ids) {
    if (visible && !visible.has(nodeId)) continue;
    const endpoints = await landingEndpointsForNode(nodeId);
    if (!endpoints) continue;
    result.set(nodeId, {
      poolId: endpoints.poolId,
      name: endpoints.name,
      members: endpoints.members.filter((member) => member.ready).map((member) => ({ hostId: member.hostId, dest: member.dest })),
    });
  }
  return result;
}

/**
 * 下发前：落在落地池成员上的路径（destHostId）按那台的成员入站解析地址端口。成员去掉了、没开出来、
 * 停用了：dest 清空（或留着）并记 issue，这条路径就用不了，调度器走别的成员。
 * 返回处理过的路径数（其余的路径交回 resolveDestNodes 按普通节点解析）。
 */
export async function resolveLandingPoolDests(paths: RoutePath[]): Promise<Set<RoutePath>> {
  const handled = new Set<RoutePath>();
  const byNode = new Map<number, LandingPoolEndpoints | null>();
  for (const path of paths) {
    const nodeId = Number(path.destNodeId || 0);
    const hostId = Number(path.destHostId || 0);
    if (!(nodeId > 0) || !(hostId > 0)) continue;
    if (!byNode.has(nodeId)) byNode.set(nodeId, await landingEndpointsForNode(nodeId).catch(() => null));
    const endpoints = byNode.get(nodeId);
    handled.add(path);
    if (!endpoints) {
      path.dest = null;
      path.issue = "落地节点已经不在了";
      continue;
    }
    const member = endpoints.members.find((item) => item.hostId === hostId);
    if (!member) {
      path.dest = null;
      path.issue = `这台机器已经不在落地池「${endpoints.name}」里了`;
      continue;
    }
    path.dest = member.dest;
    path.issue = member.ready ? null : `落地池「${endpoints.name}」：${member.issue || "这台用不了"}`;
  }
  return handled;
}

/** 调度器在哪台机器上：隧道规则在隧道出口机，其余在规则所在的机器。 */
async function schedulerHostOf(hostId: number, tunnelId: number | null | undefined): Promise<{ hostId: number; tunnel: any | null }> {
  if (!(Number(tunnelId || 0) > 0)) return { hostId, tunnel: null };
  const tunnel = await db.getTunnelById(Number(tunnelId)).catch(() => null) as any;
  return { hostId: Number(tunnel?.exitHostId || hostId), tunnel };
}

/** 这条规则能不能做成线路组（和保存时 requireMainBackupAllowed 一个口径；做不成就不自动做）。 */
async function routeGroupAllowed(actor: { id: number; role: string }, input: { protocol?: unknown; forwardType?: unknown; tunnelId?: unknown; forwardGroupId?: unknown; tunnel?: any }) {
  const { requireMainBackupAllowed } = await import("./routers/rules.crud");
  try {
    requireMainBackupAllowed({
      enabled: true,
      protocol: input.protocol ? String(input.protocol) : null,
      forwardType: input.forwardType ? String(input.forwardType) : null,
      tunnelId: Number(input.tunnelId || 0) || null,
      tunnelMode: input.tunnel ? String(input.tunnel.mode || "") : undefined,
      isPortForwardGroup: Number(input.forwardGroupId || 0) > 0,
      isAdmin: actor.role === "admin",
    });
    return true;
  } catch {
    return false;
  }
}

/** 新建的「目标 = 落地池」线路组：一条线路、不经中转、落地 = 规则目标（池），新连接按负载在几台里分。 */
function landingRouteGroupInput() {
  return {
    mode: "weighted" as const,
    spread: "least_load" as const,
    paths: [],
    lines: [{ key: "main", name: "主线路", layers: [], dests: [], weight: 50 }],
  };
}

/**
 * 保存规则前：目标选的是池节点、没自己配线路组、这条规则能做成线路组、池里开着的成员（不算调度器那台）
 * 有两台以上 → 改成「落地 = 这个池」的线路组再交给原来的保存流程。做不成的照原样保存（指向池节点的首选）。
 */
/** 这条规则的线路组是不是「目标 = 落地池」时自动做的那种：一条线路、不经中转、落地就是规则目标。 */
function isAutoLandingRouteGroup(input: any, rule: any | null | undefined) {
  const lines = Array.isArray(input.routeGroup?.lines) ? input.routeGroup.lines : rule?.routeLines ? (() => {
    try { return JSON.parse(String(rule.routeLines)); } catch { return null; }
  })() : null;
  return Array.isArray(lines) && lines.length === 1
    && (!Array.isArray(lines[0]?.layers) || lines[0].layers.length === 0)
    && (!Array.isArray(lines[0]?.dests) || lines[0].dests.length === 0);
}

export async function applyLandingPoolTargetToRuleInput(
  input: any,
  actor: { id: number; role: string },
  context: { rule?: any | null; hostId: number; tunnelId: number | null; forwardGroupId: number | null },
): Promise<boolean> {
  const nodeId = input.proxyNodeId !== undefined ? Number(input.proxyNodeId || 0) : Number(context.rule?.proxyNodeId || 0);
  const node = nodeId > 0 ? await db.getProxyNodeById(nodeId) as any : null;
  /*
    目标从落地池换成了别的（或者不绑了）：保存时自动做的那种线路组（一条线路、落地 = 规则目标）只有在池里才有
    几条路径，换成一台就只剩一条 —— 退回普通转发，不然这次保存会被「线路组至少要两条路径」拦住。
  */
  const previousNodeId = Number(context.rule?.proxyNodeId || 0);
  if (context.rule && input.proxyNodeId !== undefined && previousNodeId > 0 && previousNodeId !== nodeId && !(Number(node?.nodePoolId || 0) > 0)) {
    const previous = await db.getProxyNodeById(previousNodeId) as any;
    const failover = input.failoverEnabled !== undefined ? !!input.failoverEnabled : dbBool(context.rule.failoverEnabled);
    if (Number(previous?.nodePoolId || 0) > 0 && failover && isAutoLandingRouteGroup(input, context.rule)) {
      input.failoverEnabled = false;
      input.routeGroup = null;
    }
    return false;
  }
  if (!(nodeId > 0) || input.tlsInboundId) return false;
  if (!node || !(Number(node.nodePoolId || 0) > 0)) return false;
  // 用户自己配了线路组：线路里的「规则目标」会展开成池里的几台（ruleTargetNodeId），这里不动
  const failover = input.failoverEnabled !== undefined ? !!input.failoverEnabled : dbBool(context.rule?.failoverEnabled);
  if (failover && (input.routeGroup || context.rule?.routePaths || (Array.isArray(input.failoverTargets) && input.failoverTargets.length > 0))) return false;
  const scheduler = await schedulerHostOf(context.hostId, context.tunnelId);
  const allowed = await routeGroupAllowed(actor, {
    protocol: input.protocol ?? context.rule?.protocol,
    forwardType: input.forwardType ?? context.rule?.forwardType,
    tunnelId: context.tunnelId,
    forwardGroupId: context.forwardGroupId,
    tunnel: scheduler.tunnel,
  });
  if (!allowed) return false;
  const pools = await routeLandingPoolsForNodes(actor, [nodeId]);
  const usable = (pools.get(nodeId)?.members || []).filter((member) => member.hostId !== scheduler.hostId);
  if (usable.length < 2) return false;
  input.failoverEnabled = true;
  input.routeGroup = landingRouteGroupInput();
  return true;
}

/**
 * 池从一台变成两台以上之后：绑着池节点的普通转发补成线路组（和保存时做的一样）。做不成 / 不用做返回 false。
 * 不经过表单，直接用规则保存那一套归一化（normalizeFailoverInput）和中继同步。
 */
export async function ensureLandingRouteGroupForRule(ruleId: number, reason: string): Promise<boolean> {
  const rule = await db.getForwardRuleById(Number(ruleId)) as any;
  if (!rule || dbBool(rule.pendingDelete) || dbBool(rule.failoverEnabled) || rule.routePaths) return false;
  if (Number(rule.forwardGroupRuleId || 0) > 0 && !dbBool(rule.isForwardGroupTemplate)) return false;
  if (Number(rule.routeParentRuleId || 0) > 0) return false;
  const owner = await db.getUserById(Number(rule.userId)) as any;
  const actor = { id: Number(rule.userId), role: String(owner?.role || "user") };
  const input: any = { proxyNodeId: Number(rule.proxyNodeId || 0) || null };
  const converted = await applyLandingPoolTargetToRuleInput(input, actor, {
    rule,
    hostId: Number(rule.hostId),
    tunnelId: Number(rule.tunnelId || 0) || null,
    forwardGroupId: Number(rule.forwardGroupId || 0) || null,
  });
  if (!converted) return false;
  try {
    const { expandRouteGroupInputLines } = await import("./routeLineExpansion");
    const { normalizeFailoverInput } = await import("./routers/rules.crud");
    const expanded = await expandRouteGroupInputLines(input, actor, Number(rule.hostId), Number(rule.tunnelId || 0) || null, {
      groupTemplate: Number(rule.forwardGroupId || 0) > 0,
      ruleTargetNodeId: Number(rule.proxyNodeId || 0) || null,
    });
    const scheduler = await schedulerHostOf(Number(rule.hostId), rule.tunnelId);
    const columns = normalizeFailoverInput(expanded as any, rule.protocol, {
      rule,
      entryHostId: scheduler.hostId,
      targetIp: rule.targetIp,
      targetPort: rule.targetPort,
    });
    await db.updateForwardRule(Number(rule.id), { ...columns, isRunning: false } as any);
    if (dbBool(rule.isForwardGroupTemplate) && Number(rule.forwardGroupId || 0) > 0) {
      await db.syncForwardGroupRules(Number(rule.forwardGroupId));
    } else {
      const { syncRouteRelayRulesForRule } = await import("./routeGroups");
      await syncRouteRelayRulesForRule(Number(rule.id), { reason });
    }
    pushAgentRefresh(Number(rule.hostId), `${reason}-landing-route-group`, { urgent: true });
    appendPanelLog("info", `[LandingPool] rule=${rule.id} 目标是落地池，池里有两台以上了：改成线路组，在几台里分（${reason}）`);
    return true;
  } catch (error) {
    appendPanelLog("warn", `[LandingPool] rule=${rule.id} 改成线路组失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
