import { timestampMillis } from "./timestamp";

/**
 * 一次端到端探测多久之内还算数。
 *
 * 超过这个窗口的探测结果不是「坏消息」，是**过期的消息**：三天前那一次超时说明
 * 不了此刻通不通，拿它下结论比不下结论更糟。
 */
export const LINK_PROBE_FRESH_MS = 6 * 60 * 1000;

/**
 * 允许探测时间戳比现在早多少 —— Agent 与面板的钟对不齐时，会收到「未来」的时间。
 * 超出这个偏差的一律不认，否则一个钟走快了的 Agent 能让它那条线路永远显示新鲜。
 */
export const LINK_PROBE_MAX_FUTURE_SKEW_MS = 60 * 1000;

/**
 * 这次探测还新鲜吗。
 *
 * 原来这三个条件在五个地方各写一遍（链路可用性、节点健康、转发规则状态、规则探测
 * 缓存，还有隧道那条 SQL）—— 而 Telegram 那一路干脆一个都没写：同一条规则，面板
 * 按新鲜期判成「运行中」，机器人拿三天前那次超时判成「目标探测超时」。两个地方
 * 对同一件事给两个答案，比给错答案更让人不敢信。
 *
 * 传进来的可以是 Date、毫秒、秒或字符串（Agent 那边有的字段报的是秒），统一走
 * timestampMillis；解析不出来当作没探测过。
 */
export function isLinkProbeFresh(at: unknown, now = Date.now()): boolean {
  const recordedAt = timestampMillis(at);
  return recordedAt > 0
    && recordedAt <= now + LINK_PROBE_MAX_FUTURE_SKEW_MS
    && now - recordedAt <= LINK_PROBE_FRESH_MS;
}

/** 连续几次端到端探测都超时，才算这条转发「不通」（订阅自动隐藏用）。 */
const RULE_UNREACHABLE_CONSECUTIVE_TIMEOUTS = 3;

/**
 * 这条转发现在是不是不通：最近的 RULE_UNREACHABLE_CONSECUTIVE_TIMEOUTS 次探测全超时，
 * 且最新那次还新鲜。一次超时不算 —— 偶发的一次失败不该让节点从订阅里消失；
 * 探测过期了也不算 —— 拿旧消息下结论比不下结论更糟。
 *
 * samples 按时间从新到旧排列。
 */
export function isRuleProbeUnreachable(
  samples: ReadonlyArray<{ isTimeout: boolean; recordedAt: unknown }>,
  now = Date.now(),
): boolean {
  if (samples.length < RULE_UNREACHABLE_CONSECUTIVE_TIMEOUTS) return false;
  if (!isLinkProbeFresh(samples[0].recordedAt, now)) return false;
  return samples.slice(0, RULE_UNREACHABLE_CONSECUTIVE_TIMEOUTS).every((sample) => sample.isTimeout);
}
