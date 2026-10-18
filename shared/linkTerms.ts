/**
 * 线路相关的统一用语。
 *
 * 面板里「多条线路一起用」的地方有八九处（规则的线路组、转发组、入口组、出口组、隧道中转、
 * 多路并发、订阅的选路组……），以前各写各的：同一个「带宽叠加」在隧道里是把一条连接拆开，
 * 在订阅里却只是按连接轮流分；「故障转移 / 主备 / 主备模式」又各指一样东西。
 * 现在只用三个词，意思固定：
 *
 *   主备         平时走一条，坏了才换下一条
 *   负载均衡     新连接分到几条线路上；连接多的时候带宽相加，单条连接仍只走一条
 *   单连接叠加   把一条连接拆开同时走几条线路、在出口拼回来；单条连接也能用上几条的带宽
 *
 * 分连接的方式也只有一套名字（线路组、出口组共用）：主备 / 轮流 / 随机 / 按访客固定 / 按权重。
 */

export const LINK_TERM_FAILOVER = "主备";
export const LINK_TERM_LOAD_BALANCE = "负载均衡";
export const LINK_TERM_SPLIT_CONNECTION = "单连接叠加";

export const LINK_TERM_HINTS = {
  failover: "平时走一条，坏了才换下一条",
  loadBalance: "新连接分到几条线路上，连接多时带宽相加；单条连接仍只走一条",
  splitConnection: "把一条连接拆开同时走几条线路、在出口拼回来，单条连接也能用上几条的带宽",
} as const;

/** 分连接的方式。值和数据库、Agent 里的一致，只是名字统一。 */
export const LINK_SPREAD_LABELS = {
  fallback: { label: "主备", hint: "从上往下，前一个坏了才用下一个" },
  round_robin: { label: "轮流", hint: "新连接轮流走每一个" },
  random: { label: "随机", hint: "新连接随机挑一个能用的" },
  ip_hash: { label: "按访客固定", hint: "同一个来源 IP 总走同一个，适合要保持登录的服务" },
  weighted: { label: "按权重", hint: "新连接按权重分，带宽大的多分一些" },
} as const;

export type LinkSpread = keyof typeof LINK_SPREAD_LABELS;
