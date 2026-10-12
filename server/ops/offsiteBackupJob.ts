/*
  异地自动备份的定时检查：十分钟看一次该不该跑（isOffsiteBackupDue），该跑就跑一份。
  节奏本身（每天几点 / 每几小时）在设置里，这里只负责看时间。
*/
import { createNonOverlappingScheduledTask } from "../scheduledTask";
import { isOffsiteBackupDue } from "./offsiteBackupLogic";
import { readOffsiteBackupSettings, runOffsiteBackup } from "./offsiteBackup";

export async function runOffsiteBackupIfDue() {
  const { settings, status } = await readOffsiteBackupSettings();
  if (settings.destination === "off" || settings.passphrase.length < 8) return;
  if (!isOffsiteBackupDue({
    schedule: settings.schedule,
    nowMs: Date.now(),
    lastSuccessAt: status.lastSuccessAt,
    lastAttemptAt: status.lastAttemptAt,
  })) return;
  // 失败已经记了事件和状态，这里只吞掉，免得定时器日志里再刷一遍。
  await runOffsiteBackup("schedule").catch(() => undefined);
}

let started = false;

/** 由 server/scheduler.ts 的 startScheduler() 调一次。 */
export function startOffsiteBackupJob() {
  if (started) return;
  started = true;
  const task = createNonOverlappingScheduledTask("offsite backup", runOffsiteBackupIfDue, { slowTaskMs: 120_000 });
  const startTimer = setTimeout(() => {
    void task();
    const timer = setInterval(() => { void task(); }, 10 * 60_000);
    timer.unref?.();
  }, 4 * 60_000);
  startTimer.unref?.();
}
