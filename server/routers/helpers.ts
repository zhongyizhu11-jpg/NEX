import * as db from "../db";
import { pushAgentRefresh, requestHostTcping } from "../agentEvents";
import { appendPanelLog } from "../_core/panelLogger";
import { clearTunnelRuntimeStatus } from "../tunnelRuntimeStatus";
import { tunnelLatencyProbeSourceHostIds } from "../tunnelLatencyDetails";
import { clearTunnelAutoHopLatencyState } from "../tunnelAutoLatencyState";
import { clearTunnelMultiEntryLatencyState } from "../tunnelMultiEntryLatencyState";
import { getLinkAccessScope } from "../linkAccessView";

/**
 * 写进日志的账号名要打码，两处（登录审计和用户操作日志）原来各存一份一模一样的实现。
 * 打码规则是**隐私口径**：漂了就意味着有一条路上比另一条路露得多，而多露的那条
 * 不会自己报错，只会安安静静地写进日志。
 */
export function maskIdentifier(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return "unknown";
  const [name, domain] = text.split("@");
  if (domain) {
    const visible = name.length <= 2 ? `${name[0] || "*"}*` : `${name.slice(0, 2)}***`;
    return `${visible}@${domain}`;
  }
  if (text.length <= 3) return `${text[0] || "*"}***`;
  return `${text.slice(0, 2)}***${text.slice(-1)}`;
}

export function ensureAdminOrSelf(ctx: { user: { id: number; role: string } }, userId: number) {
  if (ctx.user.role !== "admin" && ctx.user.id !== userId) {
    throw new Error("无权访问该用户的数据");
  }
}

export async function requireHostAccess(ctx: { user: { id: number; role: string } }, hostId: number) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) {
    const hasPermission = await db.checkUserHostPermission(ctx.user.id, host.id);
    if (!hasPermission) throw new Error("无权访问该主机");
  }
  return host;
}

/**
 * requireHostAccess 的批量版：总共约 3 次查询（取主机、取直接授权、必要时取套餐），
 * 而不是每台主机 1~3 次。
 *
 * 行为与逐个调用 requireHostAccess 完全一致：按入参顺序检查，遇到的第一台不存在 /
 * 无权访问的主机就抛同样的错误（同样的文案）；全部通过时按入参顺序返回主机。
 */
export async function requireHostsAccess(ctx: { user: { id: number; role: string } }, hostIds: readonly number[]) {
  if (hostIds.length === 0) return [];
  const rows = await db.getHostsByIds(hostIds);
  const hostById = new Map<number, (typeof rows)[number]>();
  for (const row of rows as any[]) hostById.set(Number(row.id), row);
  let permitted = new Set<number>();
  if (ctx.user.role !== "admin") {
    const needPermission = (rows as any[])
      .filter((host) => host.userId !== ctx.user.id)
      .map((host) => Number(host.id));
    if (needPermission.length > 0) {
      permitted = await db.getUserPermittedHostIdsAmong(ctx.user.id, needPermission);
    }
  }
  return hostIds.map((hostId) => {
    const host = hostById.get(hostId);
    if (!host) throw new Error("主机不存在");
    if (ctx.user.role !== "admin" && host.userId !== ctx.user.id && !permitted.has(Number(host.id))) {
      throw new Error("无权访问该主机");
    }
    return host;
  });
}

export async function requireRuleAccess(ctx: { user: { id: number; role: string } }, ruleId: number) {
  const rule = await db.getForwardRuleById(ruleId);
  if (!rule) throw new Error("规则不存在");
  if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
    throw new Error("无权访问该规则");
  }
  return rule;
}

export async function requireTrafficBillingAccessIfConfigured(
  ctx: { user: { id: number; role: string } },
  resourceType: "host" | "tunnel" | "forward_group",
  resourceId: number,
) {
  if (ctx.user.role === "admin") return false;
  const snapshot = await db.getTrafficBillingAccessSnapshot(ctx.user.id);
  if (snapshot.status === "disabled") return false;
  if (snapshot.status === "failed") {
    throw new Error("流量计费授权状态暂时无法确认，请稍后重试");
  }
  const state = db.trafficBillingSnapshotResourceState(snapshot, resourceType, resourceId);
  if (!state.active) return false;
  if (!state.usable) {
    if (resourceType === "host") throw new Error("您没有使用该主机流量计费资源的权限，请联系管理员授权");
    if (resourceType === "tunnel") throw new Error("您没有使用该隧道流量计费资源的权限，请联系管理员授权");
    throw new Error("您没有使用该转发计费资源的权限，请联系管理员授权");
  }
  return true;
}

export async function requireHostUseAccess(ctx: { user: { id: number; role: string } }, hostId: number) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  const isTrafficBillingResource = await requireTrafficBillingAccessIfConfigured(ctx, "host", host.id);
  if (ctx.user.role !== "admin" && !isTrafficBillingResource && host.userId !== ctx.user.id) {
    const hasPermission = await db.checkUserHostPermission(ctx.user.id, host.id);
    if (!hasPermission) throw new Error("您没有使用该主机的权限，请联系管理员授权");
  }
  return { host, isTrafficBillingResource };
}

export async function requireTunnelUseOrTrafficBillingAccess(ctx: { user: { id: number; role: string } }, tunnelId: number) {
  const tunnel = await db.getTunnelById(tunnelId);
  if (!tunnel) throw new Error("隧道不存在");
  const isTrafficBillingResource = await requireTrafficBillingAccessIfConfigured(ctx, "tunnel", tunnel.id);
  if (ctx.user.role !== "admin" && !isTrafficBillingResource && tunnel.userId !== ctx.user.id) {
    const hasPermission = await db.checkUserTunnelPermission(ctx.user.id, tunnel.id);
    if (!hasPermission) throw new Error("无权使用该隧道");
  }
  if (ctx.user.role !== "admin" && !isTrafficBillingResource && tunnel.userId === ctx.user.id) {
    // 自己建的隧道也要看它经过的主机还能不能用：主机授权收回之后不能再拿它建 / 开规则。
    // 口径和运行时的闸（gateForwardRulesForRuntime）是同一份，见 linkAccessView.restrictOwnedTunnelUse。
    const scope = await getLinkAccessScope(ctx.user);
    if (scope && !(scope.useTunnelIds || scope.tunnelIds).has(Number(tunnel.id))) {
      throw new Error("该隧道经过的主机已不在您的授权范围内，暂时无法使用，请联系管理员恢复主机授权");
    }
  }
  return { tunnel, isTrafficBillingResource };
}

export async function pushTunnelEndpointRefresh(
  tunnel: any,
  reason: string,
  options?: { urgent?: boolean; forceTcping?: boolean },
) {
  if (tunnel?.id) clearTunnelRuntimeStatus(Number(tunnel.id));
  const hopRows = tunnel?.id ? await db.getTunnelHops(Number(tunnel.id)) : [];
  const extraExitRows = tunnel?.id ? await db.getTunnelExitNodes(Number(tunnel.id)) : [];
  const hopHostIds = Array.isArray(hopRows)
    ? hopRows.map((hop: any) => Number(hop.hostId)).filter((id: number) => Number.isFinite(id) && id > 0)
    : [];
  const extraExitHostIds = Array.isArray(extraExitRows)
    ? extraExitRows.map((exit: any) => Number(exit.hostId)).filter((id: number) => Number.isFinite(id) && id > 0)
    : [];
  let entryHostIds = [Number(tunnel?.entryHostId)].filter((id) => Number.isFinite(id) && id > 0);
  const entryGroupId = Number(tunnel?.entryGroupId || 0);
  if (entryGroupId > 0) {
    const entryGroup = await db.getForwardGroupById(entryGroupId) as any;
    const groupHostIds = entryGroup && entryGroup.isEnabled && String(entryGroup.groupMode || "") === "entry"
      ? (entryGroup.members || [])
        .filter((member: any) => member?.isEnabled !== false && member.memberType === "host")
        .map((member: any) => Number(member.hostId))
        .filter((id: number) => Number.isFinite(id) && id > 0)
      : [];
    if (groupHostIds.length > 0) entryHostIds = Array.from(new Set([...entryHostIds, ...groupHostIds]));
  }
  const hostIds = [
    ...(hopHostIds.length >= 3
    ? [...entryHostIds, ...hopHostIds]
    : [...entryHostIds, Number(tunnel.exitHostId)].filter((id) => Number.isFinite(id) && id > 0)),
    ...extraExitHostIds,
  ];
  const uniqueHostIds = Array.from(new Set(hostIds));
  const tcpingHostIds = options?.forceTcping === true
    ? tunnelLatencyProbeSourceHostIds(entryHostIds, hopRows)
    : [];
  if (options?.forceTcping === true) {
    clearTunnelAutoHopLatencyState(Number(tunnel?.id));
    clearTunnelMultiEntryLatencyState(Number(tunnel?.id));
  }
  for (const hostId of tcpingHostIds) requestHostTcping(hostId);
  const tunnelName = String(tunnel?.name || `隧道 #${tunnel?.id || "-"}`).trim();
  const pushed = uniqueHostIds.map((hostId) => ({
    hostId,
    pushed: pushAgentRefresh(hostId, `${reason}-host-${hostId}`, { urgent: options?.urgent === true }),
  }));
  const allPushed = pushed.every((item) => item.pushed);
  appendPanelLog(
    allPushed ? "info" : "warn",
    `[Tunnel] refresh tunnel=${tunnel.id} name=${tunnelName} reason=${reason} urgent=${options?.urgent === true} forceTcping=${options?.forceTcping === true} tcpingHosts=${tcpingHostIds.join(",") || "-"} entry=${Number(tunnel?.entryHostId || 0) || "-"} exit=${Number(tunnel?.exitHostId || 0) || "-"} loadBalance=${!!tunnel?.loadBalanceEnabled} hops=${hopHostIds.join("->") || "-"} extraExits=${extraExitHostIds.join(",") || "-"} hosts=${pushed.map((item) => `${item.hostId}:${item.pushed}`).join(",") || "-"}`,
  );
  const entryHostIdSet = new Set(entryHostIds);
  return {
    entryPushed: pushed.some((item) => entryHostIdSet.has(item.hostId) && item.pushed),
    exitPushed: pushed.some((item) => item.hostId === Number(tunnel.exitHostId) && item.pushed),
    hostPushed: pushed,
  };
}

export async function refreshUserForwardEndpoints(
  userId: number,
  reason: string,
  options: { urgent?: boolean; preserveOrdinaryRuntime?: boolean } = {},
) {
  const rules = [...await db.getForwardRulesForUserSync(userId)] as any[];
  if (options.preserveOrdinaryRuntime) {
    // 普通规则的单 IP 接入限制有自己的防火墙对齐（server/portAccessLimits.ts），
    // 只有隧道规则的限制还写在它们自己的下发命令里，需要重新下发。
    await db.markForwardRulesNotRunning(rules.filter((rule) => Number(rule.tunnelId || 0) > 0).map((rule) => Number(rule.id)));
  } else {
    await db.resetForwardRulesForUserSync(userId);
  }
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  for (const rule of rules as any[]) {
    hostIds.add(Number(rule.hostId));
    if (rule.tunnelId) tunnelIds.add(Number(rule.tunnelId));
  }
  for (const hostId of hostIds) {
    if (hostId > 0) pushAgentRefresh(hostId, reason, { urgent: options.urgent === true });
  }
  for (const tunnelId of tunnelIds) {
    const tunnel = await db.getTunnelById(tunnelId);
    if (!tunnel) continue;
    await db.updateTunnel(tunnelId, { isRunning: false } as any);
    await pushTunnelEndpointRefresh(tunnel, reason, { urgent: options.urgent === true });
  }
}

export function maskToken(token: string) {
  if (!token) return "";
  if (token.length <= 12) return `${token.slice(0, 4)}...`;
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}
