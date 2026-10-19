import type { ForwardRuleRouteMode } from "@shared/forwardRuleForm";

/*
  新建规则时，四种走法各一句大白话。

  第一次打开「添加转发规则」，迎面是「端口转发 / 隧道转发 / 转发链 / 转发组」四个标签，
  而新手最常卡的就是「这四个我该选哪个」—— 每个名字都对，可没有一个说了「它适合什么
  情况」。标签下面跟着一句：选中哪个就说哪个，不用切到文档里查。

  说法和 docs/guide/rules.md 的「资源类型」一张表对得上。
*/
/** 规则编辑框顶上的标签：四种走法，外加「叠加」（单连接叠加的隧道单列一个标签，底下仍是隧道转发）。 */
export type RuleRouteTab = ForwardRuleRouteMode | "aggregate";

export const ROUTE_MODE_HINTS: Record<RuleRouteTab, string> = {
  local: "最简单：入口机器收到的流量，直接转给目标地址。",
  tunnel: "入口机和出口机之间走一条隧道，再由出口机转给目标。适合跨地区、要换出口的情况。",
  aggregate: "一条连接拆到几台中转同时送，在落地拼回来，单线程下载也能叠带宽。",
  chain: "按固定顺序经过几台中转机器，一跳接一跳，最后到目标。",
  group: "几台入口机器一起接流量，一台出问题时域名自动解析到别的（需要先配好 DDNS）。",
};
