import type * as db from "./db";
import type { ForwardProtocolSettings } from "../shared/forwardTypes";
import type { SsEgressRuntime } from "./ssEgress";

/*
  心跳处理函数里每次请求算一次、之后只读的那些值，打包成一个上下文交给拆出去的模块
  （agentHeartbeatNginxPlan / GostPlan / RuleRemoval / WireGuardPlan / LocalMatch.ts）。上下文在处理函数里这些值都已就绪的地方
  建一次；里面只放 const 绑定（Map / 数组本身之后还会被往里加东西，传的是同一个对象，和闭包看到的一样）。
  会被重新赋值的 let、以及在后面才声明的闭包，不放进来：由调用处按原来的时机传。

  行的类型沿用 db 层查询的返回类型。getDb() 的结果没有行类型（是 any），所以规则 / 隧道 / 主机 / 跳点
  这些行在心跳里一直是 any；这里只是给它们起个名字，不收紧也不放宽。
*/

export type HeartbeatHostRow = NonNullable<Awaited<ReturnType<typeof db.getHostByAgentToken>>>;
export type HeartbeatRuleRow = Awaited<ReturnType<typeof db.getForwardRulesForAgent>>[number];
export type HeartbeatTunnelRow = Awaited<ReturnType<typeof db.getTunnelsByHost>>[number];
/** 跳点、出口节点和别的没有行类型的值：同上，就是 db 层给的那个类型。 */
export type HeartbeatRow = HeartbeatRuleRow;

/** 走隧道、接 SS 出口的规则在出口机上要跑的那个本机 gost 转发（原来是心跳处理函数里的局部类型）。 */
export type TunnelEgressHelper = { ruleId: number; tunnel: any; runtime: SsEgressRuntime; targetHost: string; targetPort: number; protocol: string; port: number };

export type HeartbeatRequestContext = {
  host: HeartbeatHostRow;
  hostTunnels: HeartbeatTunnelRow[];
  agentHostRules: HeartbeatRuleRow[];
  agentAllRules: HeartbeatRuleRow[];
  forwardProtocolSettings: ForwardProtocolSettings;
  tunnelById: Map<HeartbeatRow, HeartbeatTunnelRow>;
  tunnelHopsByTunnelId: Map<number, HeartbeatRow[]>;
  tunnelExitNodesByTunnelId: Map<number, HeartbeatRow[]>;
  tunnelExitEndpointById: Map<number, { host: string; port: number; udpPort?: number }>;
};
