/**
 * 链路管理的「叠加」页签：一个入口、几台中转、一个落地，一条连接拆到几台中转同时送，在落地拼回来。
 *
 * 底下就是一条 NEX V1 隧道，中转方式「单连接叠加」（shared/tunnelRelay.ts），不另起数据结构：
 * 规则选它和选隧道一样（转发规则里的「叠加」），线路组、订阅照常用。这里只管「哪些隧道算叠加」
 * 和简化表单的校验。入口是哪台都行 —— VPS 或者家里常开的 Linux（入口只往外拨，不用公网 IP）。
 */

export const AGGREGATE_LINK_MIN_RELAYS = 2;
/** 隧道最多 10 跳（MAX_TUNNEL_HOPS），首尾各占一个。 */
export const AGGREGATE_LINK_MAX_RELAYS = 8;

/** 这条隧道在「叠加」页签里（而不是「隧道链路」）：NEX 隧道、中转方式单连接叠加。和列表接口的 kind 筛选同一个口径。 */
export function isAggregateLinkTunnel(tunnel: { mode?: unknown; relayMode?: unknown } | null | undefined) {
  if (!tunnel) return false;
  return String(tunnel.mode || "").trim().toLowerCase() === "forwardx"
    && String(tunnel.relayMode || "").trim().toLowerCase() === "aggregate";
}

export type AggregateLinkSelection = {
  entryHostId: number | null | undefined;
  relayHostIds: number[];
  exitHostId: number | null | undefined;
};

/** 选得对不对；对了返回 null，不对返回给人看的一句话。 */
export function aggregateLinkError(selection: AggregateLinkSelection): string | null {
  const entry = Number(selection.entryHostId || 0);
  const exit = Number(selection.exitHostId || 0);
  const relays = selection.relayHostIds.map(Number).filter((id) => id > 0);
  if (!(entry > 0)) return "先选入口";
  if (!(exit > 0)) return "先选落地";
  if (entry === exit) return "入口和落地不能是同一台";
  if (relays.length < AGGREGATE_LINK_MIN_RELAYS) return `至少选 ${AGGREGATE_LINK_MIN_RELAYS} 台中转，带宽才叠得起来`;
  if (relays.length > AGGREGATE_LINK_MAX_RELAYS) return `中转最多 ${AGGREGATE_LINK_MAX_RELAYS} 台`;
  if (new Set(relays).size !== relays.length) return "中转不能重复";
  if (relays.includes(entry)) return "入口不能同时当中转";
  if (relays.includes(exit)) return "落地不能同时当中转";
  return null;
}

/** 隧道跳点：入口、中转…、落地。 */
export function aggregateLinkHops(selection: AggregateLinkSelection): number[] {
  return [Number(selection.entryHostId), ...selection.relayHostIds.map(Number), Number(selection.exitHostId)];
}

/** 从隧道跳点拆回三段（编辑时用）。跳点不够三个时中转为空。 */
export function aggregateLinkSelectionOf(tunnel: { hopHostIds?: unknown; entryHostId?: unknown; exitHostId?: unknown }): AggregateLinkSelection {
  const hops = Array.isArray(tunnel.hopHostIds) ? tunnel.hopHostIds.map(Number).filter((id) => id > 0) : [];
  if (hops.length >= 3) return { entryHostId: hops[0], relayHostIds: hops.slice(1, -1), exitHostId: hops[hops.length - 1] };
  return { entryHostId: Number(tunnel.entryHostId) || null, relayHostIds: [], exitHostId: Number(tunnel.exitHostId) || null };
}
