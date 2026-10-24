import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

import type { NetworkMapModel } from "./networkMapModel";

/**
 * 地图上的线分四类：
 *
 *   主线路   正在用、探测通过的线（实线亮蓝，上面有流动的光点）
 *   备用线路 没在用的线：手动停用 / 待命的隧道（白灰虚线）
 *   降级线路 在用、但探测说不太好（橙色虚线）
 *   中断线路 该通没通（红色虚线，正中一个 ⊗）
 *
 * 隧道没有「主 / 备」这个字段，只有状态 —— 所以按状态归类：正常 = 主线路、停用 = 备用。
 * 「未上报」（还没探出结论）既不能当正常画成实线，也不是故障，画法和备用一样（灰虚线）、计数也算在
 * 备用里：这是最不误导的一档。首页的图例列主线路 / 降级 / 中断，备用有才列。
 *
 * 纯函数，在 node 里测。
 */
export type LineKind = "main" | "backup" | "degraded" | "down";
/** 图例上的名字 */
export const LINE_KIND_SHORT: Record<LineKind, string> = {
  main: "主线路",
  backup: "备用",
  degraded: "降级",
  down: "中断",
};

export function lineKindOfHealth(health: NetworkHealth): LineKind {
  const token = describeNetworkHealth(health).token;
  if (token === "healthy") return "main";
  // 切换中（path）也是「在用但不稳」，画成降级
  if (token === "warn" || token === "path") return "degraded";
  if (token === "down") return "down";
  return "backup";
}

/** 图例上的四个数：隧道（画得出、画不出的都算） */
export function lineLegend(model: Pick<NetworkMapModel, "links" | "stubs">): Record<LineKind, number> {
  const counts: Record<LineKind, number> = { main: 0, backup: 0, degraded: 0, down: 0 };
  for (const link of model.links) counts[link.kind] += 1;
  for (const stub of model.stubs) counts[lineKindOfHealth(stub.health)] += 1;
  return counts;
}

/**
 * 「枢纽」：画成亮蓝、光晕大一圈的那台 —— 挂着最多条线（至少两条）的那台在线主机（一样多取 id 小的），
 * 一眼看出流量汇在哪。掉线的不当枢纽：它该是红的。
 */
export function pickHubNode(model: Pick<NetworkMapModel, "nodes">): number | null {
  let best: { id: number; count: number } | null = null;
  for (const node of model.nodes) {
    if (node.health !== "healthy" || node.linkCount < 2) continue;
    if (!best || node.linkCount > best.count || (node.linkCount === best.count && node.id < best.id)) best = { id: node.id, count: node.linkCount };
  }
  return best?.id ?? null;
}

export type NodeTone = "hub" | "ok" | "warn" | "down" | "standby";

/**
 * 主机画成什么颜色：掉线红、没接入过灰；在线的看经过它的线 —— 有线、且一条能用的主线路都没有
 * （全是降级 / 中断）就是琥珀色，不然绿；枢纽亮蓝。
 */
export function nodeTone(model: Pick<NetworkMapModel, "nodes" | "links">, hostId: number, hubId: number | null): NodeTone {
  const node = model.nodes.find((item) => item.id === hostId);
  if (!node) return "standby";
  if (node.health === "down") return "down";
  if (node.health !== "healthy") return "standby";
  if (hubId === hostId) return "hub";
  const through = model.links.filter((link) => link.path.includes(hostId) && link.kind !== "backup");
  if (through.length > 0 && through.every((link) => link.kind === "degraded" || link.kind === "down")) return "warn";
  return "ok";
}

/**
 * 主机名下面那行延迟：流量到这台机要多久（ms）。走过它的每条隧道里，它不是入口的那些：逐跳延迟齐全时
 * 用从入口累加到它的那段，它是出口时用整条隧道的延迟；取最小的那个。入口机、没有延迟数据的返回 null
 * （不写这一行，不编一个数）。
 */
export function nodeLatency(model: Pick<NetworkMapModel, "links">, hostId: number): number | null {
  let best: number | null = null;
  for (const link of model.links) {
    const index = link.path.indexOf(hostId);
    if (index <= 0) continue;
    let value: number | null = null;
    const hops = link.hopLatencies.slice(0, index);
    if (hops.length === index && hops.every((hop) => typeof hop === "number")) value = (hops as number[]).reduce((sum, hop) => sum + hop, 0);
    else if (index === link.path.length - 1 && typeof link.latencyMs === "number") value = link.latencyMs;
    if (value !== null && (best === null || value < best)) best = value;
  }
  return best;
}
