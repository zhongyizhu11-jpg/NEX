import { hostPolicyBool } from "../shared/hostTrafficPolicy";
import { isTunnelRelayFailover, isTunnelRelayHotStandby } from "../shared/tunnelRelay";

/*
  流量故障转移在 Agent 配置里的样子（上游 v2.3.281）。这里返回的全是运行时副本：只在心跳
  生成配置时用，绝不能写回数据库或喂给端口分配 —— 恢复的时候要原样回到保存着的配置。
*/

/**
 * 按暂停名单改一条隧道的运行时副本：
 * - 入口组隧道：去掉被暂停的入口；当前主入口被暂停就换一个；全被暂停就停用这条隧道。
 * - 出口组 / 多出口隧道：被暂停的出口不参与；主出口被暂停时把下一个可用出口提上来当主出口
 *   （端口、混淆端口、连接地址一起换），没有可用出口就停用。
 * - 中转：链式中转不能跳过中间某一跳（那就不是保存的那条路了），被暂停就整条停用；
 *   故障转移式中转可以只去掉被暂停的那个候选，全没了才停用。
 * 固定入口、固定出口的普通隧道不受影响（它们不在任何「组」里，没有别人可以顶上）。
 */
export function planTunnelTrafficParticipation(tunnel: any, hops: any[], exits: any[], entryIds: number[], excluded: ReadonlySet<number>) {
  const next = { ...tunnel };
  const groupedEntries = Number(tunnel.entryGroupId) > 0;
  const groupedExits = Number(tunnel.exitGroupId) > 0 || hostPolicyBool(tunnel.loadBalanceEnabled);
  let nextHops = hops.map((hop) => ({ ...hop }));
  const entryHostIds = groupedEntries ? entryIds.filter((id) => !excluded.has(id)) : [...entryIds];
  let nextExits = exits.map((node) => ({ ...node, isEnabled: hostPolicyBool(node.isEnabled ?? true) && (!groupedExits || !excluded.has(Number(node.hostId))) }));
  let promotedExit: any = null;
  if (groupedEntries && entryHostIds.length === 0) next.isEnabled = false;
  if (groupedEntries && excluded.has(Number(next.entryHostId)) && entryHostIds.length > 0) {
    next.entryHostId = entryHostIds[0];
    if (nextHops.length > 0) nextHops[0].hostId = next.entryHostId;
  }
  if (groupedExits && excluded.has(Number(next.exitHostId))) {
    promotedExit = nextExits.filter((node) => hostPolicyBool(node.isEnabled))
      .sort((a, b) => Number(a.seq) - Number(b.seq))[0] || null;
    if (!promotedExit) next.isEnabled = false;
    else {
      Object.assign(next, { exitHostId: promotedExit.hostId, listenPort: promotedExit.listenPort, mimicPort: promotedExit.mimicPort, connectHost: promotedExit.connectHost || null });
      nextExits = nextExits.filter((node) => Number(node.id) !== Number(promotedExit.id));
      if (nextHops.length >= 2) Object.assign(nextHops[nextHops.length - 1], {
        hostId: next.exitHostId, listenPort: next.listenPort, mimicPort: next.mimicPort, connectHost: next.connectHost,
      });
    }
  }
  if (groupedEntries || groupedExits || isTunnelRelayFailover(tunnel, hops) || isTunnelRelayHotStandby(tunnel, hops)) {
    const transit = nextHops.slice(1, -1);
    if (String(tunnel.relayMode) === "failover" || String(tunnel.relayMode) === "hot_standby") {
      // 主备 / 热备：少一台中转照样走，只把被暂停的那台拿掉；全没了才停。
      nextHops = nextHops.filter((hop, index) => index === 0 || index === nextHops.length - 1 || !excluded.has(Number(hop.hostId)));
      if (transit.length > 0 && nextHops.length === 2) next.isEnabled = false;
    } else if (transit.some((hop) => excluded.has(Number(hop.hostId)))) next.isEnabled = false;
  }
  return { tunnel: next, hops: nextHops, exits: nextExits, entryHostIds, promotedExit };
}

/** 转发组的子规则：所在主机（或链式组里任何一个成员）被暂停就不下发。模板规则本身不下发，不管它。 */
export function groupRuleTrafficBlocked(rule: any, excluded: ReadonlySet<number>, chainHostIds: number[] = []) {
  return Number(rule.forwardGroupId) > 0 && !hostPolicyBool(rule.isForwardGroupTemplate)
    && (excluded.has(Number(rule.hostId)) || chainHostIds.some((id) => excluded.has(id)));
}
