/*
  面板「就绪」的时刻：进程起来准备好收 Agent 上报（调度器启动时记一次），或者数据库故障恢复的那一刻。

  为什么要记：面板停了一阵再起来、数据库断了一阵再恢复时，内存里的主机存活状态全是旧的（或者全被判了离线），
  谁先重新上报谁就「在线」。转发组评估在这之后的一小段时间里不许自动把解析换走，等每台成员主机要么重新来过、
  要么从就绪算起沉默满了离线阈值（判定见 evaluate.ts 的 readinessGrace）。

  没记过就绪（单元测试里直接调评估、命令行工具）时 readyAt 是 0，宽限不生效，行为和以前一样。
*/

let readyAt = 0;

/** 记一次就绪。已经就绪过、又不是强制（数据库恢复）时不动：调度器重试不会把宽限往后推。 */
export function markForwardGroupPanelReady(now = Date.now(), options: { force?: boolean } = {}) {
  if (readyAt > 0 && !options.force) return readyAt;
  readyAt = Number.isFinite(now) && now > 0 ? now : Date.now();
  return readyAt;
}

export function forwardGroupPanelReadyAt() {
  return readyAt;
}

/** 测试用：直接设（0 = 关掉宽限）。 */
export function setForwardGroupPanelReadyAtForTests(value: number) {
  readyAt = Math.max(0, Number(value) || 0);
}

/**
 * 就绪之前留下的健康样本，在这段时间里「过期」不当成故障，只当成还在等：面板停机期间没人收样本，
 * 样本旧不代表成员坏了。Agent 每分钟报一次健康全量，留够两轮多。
 */
export const FORWARD_GROUP_READINESS_SAMPLE_GRACE_MS = 150_000;

/** 这个样本（时间 sampleAt）是不是「就绪之前的旧样本，而且还在等新样本的宽限里」。 */
export function staleSampleWithinReadinessGrace(sampleAt: number | null | undefined, now: number, ready = readyAt) {
  if (!(ready > 0)) return false;
  if (now >= ready + FORWARD_GROUP_READINESS_SAMPLE_GRACE_MS) return false;
  const at = Number(sampleAt || 0);
  return !(at >= ready);
}
