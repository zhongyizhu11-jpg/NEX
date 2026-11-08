/*
  线路组在界面上的说法：模式、分法、切换方式、备用怎么候着、事件的名字，切换原因和
  路径问题怎么翻成人话。shared/routeGroup.ts 统一再导出。
*/
import { LINK_SPREAD_LABELS } from "./linkTerms";
import type {
  RouteDelivery,
  RouteDestSpread,
  RouteEventKind,
  RouteMode,
  RouteSpread,
  RouteSwitchMode,
} from "./routeGroupModel";

export const ROUTE_DEST_SPREAD_LABELS: Record<RouteDestSpread, { label: string; hint: string }> = {
  one: { label: "主备", hint: "几个落地里只用一个，按上面「怎么切」挑，坏了换下一个" },
  least_load: { label: "按负载分", hint: "这条线路在用时，新连接给现在连接最少的那个落地" },
  round_robin: { label: "轮流", hint: "这条线路在用时，新连接轮流走每个落地" },
  random: { label: "随机", hint: "这条线路在用时，新连接随机挑一个能用的落地" },
  ip_hash: { label: "按访客固定", hint: "同一个访客 IP 一直走同一个落地，适合要保持登录的服务" },
  auto: { label: LINK_SPREAD_LABELS.auto.label, hint: "这条线路在用时，按最近延迟和落地主机的负载自动算权重，新连接随机挑两个落地取更好的那个" },
};

/** Agent 切换事件原因后面的标记：这次是换到了同出口 IP 的备用（见 agent/failover_exit_ip.go）。 */
export const ROUTE_REASON_SAME_EXIT_SUFFIX = "; same exit ip";

/** 把切换原因拆成本来的原因和「换到了同出口 IP」这个标记；老 Agent 的原因没有标记，原样过。 */
export function splitRouteReason(reason: unknown): { base: string; sameExitIp: boolean } {
  const text = String(reason ?? "").trim();
  const lower = text.toLowerCase();
  if (lower.endsWith(ROUTE_REASON_SAME_EXIT_SUFFIX)) {
    return { base: text.slice(0, text.length - ROUTE_REASON_SAME_EXIT_SUFFIX.length).trim(), sameExitIp: true };
  }
  return { base: text, sameExitIp: false };
}

export const ROUTE_DELIVERY_INFO: Record<RouteDelivery, { label: string; hint: string }> = {
  cold: { label: "冷备", hint: "平时只走一条，备用只做探测；坏了切走，旧连接留在原线路" },
  hot: { label: "热备", hint: "握手慢了同时拨下一条，谁先通用谁；坏了 10 秒内切走，旧连接断开让客户端马上重连（连接一点不断要靠 NEX 隧道自己的热备）" },
  aggregate: { label: "聚合", hint: "主线路那组的几条路径一起分担：新连接分到最空的那条，带宽按连接叠加；单个连接仍走一条（单连接叠加用 NEX 叠加隧道）" },
  replicate: { label: "复制", hint: "主线路走的 NEX 叠加隧道里，同一份数据在几条腿上同时发，一条腿断了连接不断（隧道要开「复制」）" },
};

export type RouteModeInfo = {
  label: string;
  /** 选项下面那一句：它会怎么做。 */
  hint: string;
  /** 策略模板的名字：创建线路组时先问「你希望怎么用这些线路」，答案就是它。 */
  template: string;
};

export const ROUTE_MODE_INFO: Record<RouteMode, RouteModeInfo> = {
  failover: { label: "自动故障切换", template: "稳定优先", hint: "平时只走主线路，出问题自动换到下一条；主线路恢复并稳定一阵子再切回" },
  scheduled: { label: "定时主备", template: "早晚高峰", hint: "按时段表决定首选（比如晚高峰走 B），时段外回主线路；出问题照样往下切" },
  manual: { label: "手动主备", template: "人工掌控", hint: "一直走你指定的那条，直到你换；它挂了才临时往下切，恢复后再回来" },
  smart: { label: "智能择优", template: "延迟优先", hint: "按线路评分（延迟、丢包、抖动、可用率）走最好的一条；分差够大、持续够久才换，不来回漂" },
  hybrid: { label: "混合策略", template: "晚高峰优化", hint: "时段表给出首选，到点前先预热预检；预检不过就不切，继续走当前这条" },
  weighted: { label: "权重负载", template: "负载均衡", hint: "新连接按权重分到各条路径，旧连接不动；哪条出问题就先跳过它" },
};

/** 模板那句说明：纯 UDP 规则没有连接，权重负载那句换成会话；其余几句不提连接，原样用。 */
const ROUTE_MODE_SESSION_HINTS: Partial<Record<RouteMode, string>> = {
  weighted: "新会话按权重分到各条路径，旧会话不动；哪条出问题就先跳过它",
};

export function routeModeHint(mode: RouteMode, perSession = false): string {
  return (perSession && ROUTE_MODE_SESSION_HINTS[mode]) || ROUTE_MODE_INFO[mode].hint;
}

/** 徽标上的两个字：「主备 · 主线路」「定时 · 晚高峰线路」。 */
export const ROUTE_MODE_SHORT: Record<RouteMode, string> = {
  failover: "主备",
  scheduled: "定时",
  manual: "手动",
  smart: "择优",
  hybrid: "混合",
  weighted: "负载",
};

// 名字和出口组的策略同一套（shared/linkTerms.ts），只是这里说的是「路径」。
export const ROUTE_SPREAD_LABELS: Record<RouteSpread, { label: string; hint: string }> = {
  weighted: { label: LINK_SPREAD_LABELS.weighted.label, hint: "新连接按每条路径的权重分配" },
  least_load: { label: LINK_SPREAD_LABELS.least_load.label, hint: "新连接给现在挂着连接最少的那条（按权重折算），长连接多时比按权重更均匀" },
  round_robin: { label: LINK_SPREAD_LABELS.round_robin.label, hint: "新连接轮流走每一条" },
  random: { label: LINK_SPREAD_LABELS.random.label, hint: "新连接随机挑一条能用的" },
  ip_hash: { label: LINK_SPREAD_LABELS.ip_hash.label, hint: "同一个来源 IP 总走同一条，适合要保持登录的服务" },
  auto: { label: LINK_SPREAD_LABELS.auto.label, hint: "按每条路径最近的延迟和沿途主机的负载自动算权重，新连接随机挑两条取更好的那条；慢了、忙了的少分" },
};

export const ROUTE_SWITCH_MODE_INFO: Record<RouteSwitchMode, { label: string; hint: string }> = {
  smooth: { label: "平滑切换", hint: "旧连接留在原线路，新连接走新线路，基本无感（推荐）" },
  fast: { label: "快速切换", hint: "线路挂了就断开它上面的旧连接，让客户端马上重连到新线路；计划和择优切换仍然平滑" },
  force: { label: "强制切换", hint: "每次切换都断开旧连接，全部客户端立刻走新线路，可能重连" },
};

/*
  纯 UDP 没有连接：Agent 按会话（同一个来源地址发来的包）挑路径，切换时丢的是会话映射，
  下一个包重新挑一条。选项还是那几个，只是说法换成「会话」。
*/
export const ROUTE_SPREAD_SESSION_HINTS: Record<RouteSpread, string> = {
  weighted: "新会话按每条路径的权重分配",
  least_load: "新会话给现在连接最少的那条（按权重折算）",
  round_robin: "新会话轮流走每一条",
  random: "新会话随机挑一条能用的",
  ip_hash: "UDP 分不出访客：同一个会话一直走同一条，同一个访客的不同会话可能分到不同路径",
  auto: "按每条路径最近的延迟和沿途主机的负载自动算权重，新会话随机挑两条取更好的那条",
};

export const ROUTE_SWITCH_MODE_SESSION_HINTS: Record<RouteSwitchMode, string> = {
  smooth: "已有的会话留在原路径，新会话走新路径，基本无感（推荐）",
  fast: "路径挂了就丢掉它上面的会话，下一个包改走新路径；计划和择优切换仍然平滑",
  force: "每次切换都丢掉旧会话，下一个包改走新路径",
};

export const ROUTE_EVENT_KIND_LABELS: Record<RouteEventKind, string> = {
  switch: "切换",
  unhealthy: "线路异常",
  recovered: "线路恢复",
  precheck_failed: "计划切换未执行",
  prewarm: "预热",
  pinned: "人工指定",
  unpinned: "交回自动",
  issue: "路径不可用",
  flap_hold: "抖动抑制",
  slow_dial: "连接变慢",
};

/**
 * Agent 报上来的切换原因 → 人话。
 *
 * Agent 里原因是几个固定的英文短语（health check / dial failed / schedule / score / pin /
 * failback / precheck / relay down: …），Go 那边不做中文。翻译只在这一处，Telegram 和
 * 界面说的才是同一句。
 */
export function describeRouteReason(reason: unknown): string {
  const { base, sameExitIp } = splitRouteReason(reason);
  const described = describeRouteReasonBase(base);
  if (!sameExitIp) return described;
  // Agent 2.2.251 起：挂了之后换到的是出口 IP 一样的备用（agent/failover_exit_ip.go）。
  return described ? `${described}，换到同出口 IP 的备用` : "换到同出口 IP 的备用";
}

function describeRouteReasonBase(text: string): string {
  if (!text) return "";
  const lower = text.toLowerCase();
  if (lower === "health check") return "连续探测不通";
  if (lower === "dial failed") return "新连接拨不通";
  if (lower === "schedule") return "按时段表";
  if (lower === "score") return "线路评分更优";
  if (lower === "pin") return "人工指定";
  if (lower === "unpin" || lower === "pin expired") return "指定到期，交回自动";
  if (lower === "failback") return "首选恢复，切回";
  if (lower === "startup" || lower === "spec updated") return "线路组重新下发";
  if (lower === "relay recovered") return "中转恢复";
  if (lower.startsWith("precheck:")) return `预检未通过：${describeRouteIssue(text.slice("precheck:".length))}`;
  if (lower.startsWith("relay down") || lower === "paused" || lower.startsWith("maintenance:") || lower.startsWith("node offline:") || lower.startsWith("breaker:")) return describeRouteIssue(text);
  if (lower.startsWith("panel:")) return text.slice("panel:".length).trim();
  // Agent 的抖动抑制：flap: 3 switches in 1h, hold 5m until 2026-…
  const flap = /^flap:\s*(\d+)\s+switches in 1h,\s*hold\s+(\d+)m/i.exec(text);
  if (flap) return `一小时内自动切了 ${flap[1]} 次，线路在来回漂：暂停自动切换 ${flap[2]} 分钟（当前线路挂了照样切）`;
  // Agent 的真实连接反馈：slow dial: 820ms x3, probe 40ms
  const slow = /^slow dial:\s*(\d+)ms\s*x(\d+),\s*probe\s+(\d+)ms/i.exec(text);
  if (slow) return `新连接连续 ${slow[2]} 次拨得慢（拨号约 ${slow[1]}ms${Number(slow[3]) > 0 ? `，探测 ${slow[3]}ms` : ""}）：记一次失败，立刻复查`;
  return text;
}

/**
 * Agent 预检 / 中转探测报的问题 → 人话：unreachable、latency 520ms、loss 6%、relay down: JP01。
 * 面板自己写的问题（中转离线、没有入口地址）本来就是中文，原样过。
 */
export function describeRouteIssue(issue: unknown): string {
  const text = String(issue ?? "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  if (lower === "unreachable") return "连不上";
  if (lower === "relay down") return "中转异常";
  if (lower.startsWith("relay down:")) return `中转异常：${text.slice("relay down:".length).trim()}`;
  const latency = /^latency\s+(\d+)\s*ms$/i.exec(text);
  if (latency) return `延迟 ${latency[1]}ms`;
  const loss = /^loss\s+(\d+(?:\.\d+)?)\s*%$/i.exec(text);
  if (loss) return `丢包 ${loss[1]}%`;
  if (lower === "path unresolved") return "路径还没解析出拨号地址";
  if (lower === "paused") return "已手动暂停";
  if (lower.startsWith("maintenance:")) return `${text.slice("maintenance:".length).trim()} 维护中`;
  if (lower.startsWith("node offline:")) return `${text.slice("node offline:".length).trim()} 离线`;
  if (lower.startsWith("breaker:")) return `${text.slice("breaker:".length).trim()} 熔断：几条线路都探不通它`;
  return text;
}
