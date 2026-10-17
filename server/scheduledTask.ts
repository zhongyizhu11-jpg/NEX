import { isDatabaseMaintenanceActive } from "./databaseMaintenance";
import { databaseHealth } from "./databaseHealthState";

type ScheduledTaskLogger = Pick<typeof console, "warn" | "error">;

export function createNonOverlappingScheduledTask(
  name: string,
  task: () => Promise<void>,
  options: {
    logger?: ScheduledTaskLogger;
    now?: () => number;
    slowTaskMs?: number;
    skipLogIntervalMs?: number;
    /** 额外的放行条件；默认在主库不可用时整轮跳过，见下。 */
    shouldRun?: () => boolean;
  } = {},
) {
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  const slowTaskMs = Math.max(0, Number(options.slowTaskMs ?? 5_000));
  const skipLogIntervalMs = Math.max(1_000, Number(options.skipLogIntervalMs ?? 5 * 60_000));
  let running = false;
  let lastSkipLogAt = Number.NEGATIVE_INFINITY;

  return async () => {
    // 切换数据库期间整轮跳过：定时任务几乎都在写库（扣费、重置流量、写提醒标记），
    // 写进正在被复制的旧库只会丢失或新旧两边对不上。下一个周期再跑。
    if (isDatabaseMaintenanceActive()) return false;
    // 主库连不上时同样整轮跳过（上游 v2.3.281）：定时任务几乎都要读写库，硬跑只会每个周期
    // 刷一遍连接超时、占着连接池。databaseHealthMonitor 确认恢复后下一个周期自然接着跑。
    if (databaseHealth.isUnavailable()) return false;
    if (options.shouldRun && !options.shouldRun()) return false;
    if (running) {
      const skippedAt = now();
      if (skippedAt - lastSkipLogAt >= skipLogIntervalMs) {
        lastSkipLogAt = skippedAt;
        logger.warn(`[Scheduler] ${name} is still running; skipped overlapping execution`);
      }
      return false;
    }

    running = true;
    const startedAt = now();
    try {
      await task();
    } catch (error) {
      logger.error(`[Scheduler] ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      const elapsedMs = Math.max(0, now() - startedAt);
      running = false;
      if (slowTaskMs > 0 && elapsedMs >= slowTaskMs) {
        logger.warn(`[Scheduler] ${name} completed slowly duration=${elapsedMs}ms`);
      }
    }
    return true;
  };
}
