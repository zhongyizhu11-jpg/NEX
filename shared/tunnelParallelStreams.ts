/**
 * NEX 隧道的「单连接多路并发」（单连接带宽聚合，直连版）。
 *
 * 跨境线路常按单条 TCP 流限速或丢包：一条连接只跑得到几十 Mbit/s，十条连接加起来却能跑满。
 * 中转「单连接叠加」把一条连接拆到几台中转上；这里是没有中转（或者中转串成一条链）时的同一件事：
 * 入口把每条客户端连接拆成 N 片，从 N 条并行的安全连接发到同一个出口，出口按序号重组，
 * 目标看到的字节流和单路一模一样。用的是 FXP 现成的多路会话（multipath），出口上的重组、
 * 丢腿重传、乱序缓冲都是同一套。
 */

import { tunnelRelayUsesParallelRelays } from "./tunnelRelay";

export const TUNNEL_PARALLEL_STREAM_OPTIONS = [1, 2, 3, 4, 6, 8] as const;
export const TUNNEL_PARALLEL_STREAMS_MAX = 8;

/** 存储值 → 档位。0 / 1 / 坏值 = 不拆（单路）。 */
export function normalizeTunnelParallelStreams(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 2) return 1;
  return Math.min(TUNNEL_PARALLEL_STREAMS_MAX, parsed);
}

/**
 * 这条隧道能不能开，不能开时给出原因。
 * - 只有 NEX V1：V2 是 WireGuard，外面本来就只有一条 UDP 流，里面拆几条 TCP 没有用；
 *   V3 的物理会话不支持 FXP 的多路径；
 * - 中转是「主备 / 单连接叠加」时不用：那两种已经是并排的中转，叠加模式本来就在拆；
 * - 多出口负载均衡的隧道不用：重组必须在同一个出口，拆了就没法按出口分流。
 */
export function tunnelParallelStreamsUnavailableReason(tunnel: any, hops: readonly any[], exitRouteCount = 1): string {
  if (String(tunnel?.mode || "").trim().toLowerCase() !== "forwardx") return "只有 NEX 隧道支持单连接多路并发";
  const version = String(tunnel?.forwardxVersion || "v1").trim().toLowerCase();
  if (version === "v2") return "NEX V2（WireGuard）隧道外层只有一条 UDP 流，拆成多路没有用";
  if (version === "v3") return "NEX V3 隧道不支持单连接多路并发（多路并发走的是 FXP 的多路径，V3 的会话不支持）";
  if (tunnelRelayUsesParallelRelays(tunnel, [...hops])) return "中转是「主备」或「单连接叠加」的隧道不用再开（单连接叠加已经在拆）";
  if (exitRouteCount > 1) return "多出口负载均衡的隧道不能拆（重组必须在同一个出口）";
  return "";
}

export type ParallelStreamRoute = { host: string; port: number; key: string };

/** N 条腿都指向同一个出口（或链的第一跳），只是各开一条连接。 */
export function buildParallelStreamLegs(route: ParallelStreamRoute, streams: number) {
  const count = normalizeTunnelParallelStreams(streams);
  if (count < 2 || !route.host || !(Number(route.port) > 0) || !route.key) return [];
  return Array.from({ length: count }, (_, index) => ({
    host: route.host,
    port: Number(route.port),
    key: route.key,
    via: `stream#${index + 1}`,
  }));
}

export function describeTunnelParallelStreams(value: unknown) {
  const count = normalizeTunnelParallelStreams(value);
  return count < 2 ? "单路" : `${count} 路并发`;
}
