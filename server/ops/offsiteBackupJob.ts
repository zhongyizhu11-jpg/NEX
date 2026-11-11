/*
  异地自动备份的定时检查：十分钟看一次该不该跑（isOffsiteBackupDue），该跑就跑一份。
  节奏本身（每天 / 每周几点、每几小时）在设置里，这里只负责看时间。

  没开的时候每十分钟只读一次设置（一条按前缀的查询），别的什么都不做。
  开发面板模式下整个 startScheduler 都不会被调（server/backgroundServices.ts），这里也就不会启动。
*/
import { claimSettingKey } from "../repositories/settingsRepository";
import { createNonOverlappingScheduledTask } from "../scheduledTask";
import { isOffsiteBackupDue, offsiteBackupClaimKey } from "./offsiteBackupLogic";
import { readOffsiteBackupSettings, runOffsiteBackup } from "./offsiteBackup";

export async function runOffsiteBackupIfDue(nowMs = Date.now()) {
  const { settings, state } = await readOffsiteBackupSettings();
  if (settings.destinations.length === 0 || settings.passphrase.length < 8) return;
  const due = settings.destinations.some((target) => isOffsiteBackupDue({
    schedule: settings.schedule,
    nowMs,
    lastSuccessAt: state.targets[target].successAt,
    lastAttemptAt: state.targets[target].attemptAt,
  }));
  if (!due) return;
  // 几个面板进程连着同一个库时，同一个小时只让抢到标记的那个跑（失败后的重试间隔也是一小时）。
  if (!(await claimSettingKey(offsiteBackupClaimKey(nowMs)))) return;
  // 失败已经记了「最近结果」、面板日志和事件，这里只吞掉，免得定时器日志里再刷一遍。
  await runOffsiteBackup("schedule").catch(() => undefined);
}

let started = false;

/** 由 server/scheduler.ts 的 startScheduler() 调一次。 */
export function startOffsiteBackupJob() {
  if (started) return;
  started = true;
  const task = createNonOverlappingScheduledTask("offsite backup", () => runOffsiteBackupIfDue(), { slowTaskMs: 120_000 });
  const startTimer = setTimeout(() => {
    void task();
    const timer = setInterval(() => { void task(); }, 10 * 60_000);
    timer.unref?.();
  }, 4 * 60_000);
  startTimer.unref?.();
}
