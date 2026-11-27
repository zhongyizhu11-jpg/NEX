/*
  从 server/agentHeartbeatRoute.ts 第 1513-1604 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { runtimeBool } from "../agentHeartbeatRuntime";
import { noteTunnelEffectivePin } from "../tunnelPinState";
import * as db from "../db";
import { hostEgressAddress, type HostEgressSource } from "../hostObservedAddress";
import { ignoreErrorWith } from "../ignoredError";
import { fxpSupportsTargetAware } from "../tunnelExitStrategy";
import { hostBandwidthHintMbps } from "@shared/linkWeights";
import { exitGroupCapacities, exitGroupWeights, normalizeExitGroupStrategy } from "@shared/loadBalance";

export type BuildExitSelectionHelpersContext = {
  exitBandwidthCache: Map<number, number>;
};

export type BuildExitSelectionHelpersResult = {
  exitCapacitiesForHostIds: (strategy: unknown, hostIds: number[]) => Promise<Array<number> | null>;
  exitWeightsForHostIds: (strategy: unknown, hostIds: number[], tunnel?: unknown) => Promise<Array<number> | null>;
  exitIpsForHostIds: (hostIds: number[]) => Promise<string[] | null>;
  exitBandwidthsForHostIds: (hostIds: number[]) => Promise<Array<number>>;
  pinnedExitHostId: (tunnel: unknown) => Promise<number>;
  exitTargetStatusForHostIds: (hostIds: number[]) => Promise<boolean[] | null>;
};

export function buildExitSelectionHelpers(ctx: BuildExitSelectionHelpersContext): BuildExitSelectionHelpersResult {
  const { exitBandwidthCache } = ctx;
  const exitBandwidthsForHostIds = async (hostIds: number[]) => {
    const missing = Array.from(new Set(hostIds.filter((id) => id > 0 && !exitBandwidthCache.has(id))));
    if (missing.length > 0) {
      const rows = await db.getHostsByIds(missing) as any[];
      for (const id of missing) exitBandwidthCache.set(id, 0);
      for (const row of rows) exitBandwidthCache.set(Number(row.id), hostBandwidthHintMbps(row));
    }
    return hostIds.map((id) => exitBandwidthCache.get(id) || 0);
  };
  /*
    出口组「按权重」时每台手填的份数（成员的 aggregationWeight，2.3.534 起）：全部填了才按它分，
    有空的就照旧按线路带宽算（混着比没有意义）。
  */
  const exitManualWeightCache = new Map<number, Map<number, number>>();
  const exitManualWeights = async (tunnel: unknown, hostIds: number[]): Promise<number[] | null> => {
    const groupId = Number((tunnel as { exitGroupId?: number | null } | null)?.exitGroupId || 0);
    if (groupId <= 0) return null;
    let weights = exitManualWeightCache.get(groupId);
    if (!weights) {
      weights = new Map<number, number>();
      const group = await db.getForwardGroupById(groupId).catch(() => null) as { members?: Array<{ hostId?: number | null; aggregationWeight?: number | null }> } | null;
      for (const member of group?.members || []) {
        const weight = Math.floor(Number(member?.aggregationWeight) || 0);
        if (Number(member?.hostId || 0) > 0 && weight > 0) weights.set(Number(member.hostId), weight);
      }
      exitManualWeightCache.set(groupId, weights);
    }
    const manual = hostIds.map((hostId) => weights!.get(Number(hostId)) || 0);
    return manual.every((weight) => weight > 0) ? manual : null;
  };
  const exitWeightsForHostIds = async (strategy: unknown, hostIds: number[], tunnel?: unknown) => {
    const normalized = normalizeExitGroupStrategy(strategy);
    if ((normalized !== "weighted" && normalized !== "least_load" && normalized !== "auto" && normalized !== "latency") || hostIds.length < 2) return null;
    if (normalized === "weighted" && tunnel) {
      const manual = await exitManualWeights(tunnel, hostIds);
      if (manual) return manual;
    }
    return exitGroupWeights(strategy, await exitBandwidthsForHostIds(hostIds));
  };
  // 交给 FXP 的线路带宽（「按负载」「自动」「延迟优先」「按访客固定」用）。
  const exitCapacitiesForHostIds = async (strategy: unknown, hostIds: number[]) => {
    const normalized = normalizeExitGroupStrategy(strategy);
    if ((normalized !== "least_load" && normalized !== "ip_hash" && normalized !== "auto" && normalized !== "latency") || hostIds.length < 2) return null;
    return exitGroupCapacities(strategy, await exitBandwidthsForHostIds(hostIds));
  };
  /*
    每台出口的 FXP 会不会回报「连上目标没有」（2.2.142 起，见 forwardx-fxp/target_health.go）：
    会的才让入口等结果、当场换出口。按主机上报的 FXP 版本判断；老出口照旧只看它本身通不通。
  */
  /*
    负载均衡手动切换（tunnels.balancePinHostId，2.3.534）：只用这一台出口。这台离线时不理它，照常自动分 ——
    手动指定的那台挂了还死守着，等于让整条链路断着。NEX 隧道（FXP 规格）和 GOST 隧道（本机代理规格）都按它。
  */
  const pinOnlineCache = new Map<number, boolean>();
  const pinnedExitHostId = async (tunnel: unknown): Promise<number> => {
    const row = tunnel as { id?: number | null; balancePinHostId?: number | null } | null;
    const hostId = Number(row?.balancePinHostId || 0);
    let effective = 0;
    if (hostId > 0) {
      if (!pinOnlineCache.has(hostId)) {
        const rows = await db.getHostsByIds([hostId]).catch(ignoreErrorWith("AgentHeartbeat exit pin", [])) as Array<{ id: number; isOnline?: unknown }>;
        pinOnlineCache.set(hostId, rows.some((item) => Number(item.id) === hostId && runtimeBool(item.isOnline)));
      }
      effective = pinOnlineCache.get(hostId) ? hostId : 0;
    }
    // 规则卡要知道入口手里的「指定」是哪台（server/tunnelPinState.ts）
    noteTunnelEffectivePin(row?.id, effective);
    return effective;
  };
  const exitTargetStatusCache = new Map<number, boolean>();
  const exitTargetStatusForHostIds = async (hostIds: number[]): Promise<boolean[] | null> => {
    if (hostIds.length < 2) return null;
    const missing = Array.from(new Set(hostIds.filter((id) => id > 0 && !exitTargetStatusCache.has(id))));
    if (missing.length > 0) {
      const rows = await db.getHostsByIds(missing).catch(ignoreErrorWith("AgentHeartbeat exit fxp versions", [])) as Array<{ id: number; fxpVersion?: string | null }>;
      for (const id of missing) exitTargetStatusCache.set(id, false);
      for (const row of rows) exitTargetStatusCache.set(Number(row.id), fxpSupportsTargetAware(row.fxpVersion));
    }
    const flags = hostIds.map((id) => exitTargetStatusCache.get(id) === true);
    return flags.some(Boolean) ? flags : null;
  };
  /*
    出口组「故障切换优先同出口 IP」（2.3.520）：每个出口带上那台主机的出口地址（hostEgressAddress）。先写进 FXP 规格，
    FXP 主备换出口时按它取舍要等 FXP 那边接上（现在的 FXP 不读这个字段）；Agent 不拿它算签名，带上不会重载 FXP。
    出口不到两个用不上，不查。一次心跳里同一台只查一次。
  */
  const exitIpCache = new Map<number, string>();
  const exitIpsForHostIds = async (hostIds: number[]): Promise<string[] | null> => {
    if (hostIds.length < 2) return null;
    const missing = Array.from(new Set(hostIds.filter((id) => id > 0 && !exitIpCache.has(id))));
    if (missing.length > 0) {
      const rows: HostEgressSource[] = await db.getHostsByIds(missing).catch(ignoreErrorWith("AgentHeartbeat exit ips", []));
      for (const id of missing) exitIpCache.set(id, "");
      for (const row of rows) exitIpCache.set(Number(row.id), hostEgressAddress(row));
    }
    const ips = hostIds.map((id) => exitIpCache.get(id) || "");
    return ips.some(Boolean) ? ips : null;
  };
  return { exitCapacitiesForHostIds, exitWeightsForHostIds, exitIpsForHostIds, exitBandwidthsForHostIds, pinnedExitHostId, exitTargetStatusForHostIds };
}
