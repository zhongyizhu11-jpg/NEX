/*
  异地自动备份（#10）的纯计算部分：文件名、该不该跑、该删哪些。不碰网络和数据库，便于单测。

  时间一律按北京时间（UTC+8，没有夏令时）—— 设置里「每天几点」写的是北京时间，
  文件名里的时间也是，管理员在网盘里一眼能对上。
*/

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

/** 与设置 › 备份恢复手动导出的文件同一种格式（server/migration.ts 的 encryptMigrationSnapshot）。 */
export const OFFSITE_BACKUP_EXTENSION = ".fwxbak";
export const OFFSITE_BACKUP_NAME_PATTERN = /^nex-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.fwxbak$/;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** nex-backup-YYYYMMDD-HHmm.fwxbak（北京时间）。 */
export function offsiteBackupName(atMs: number): string {
  const d = new Date(atMs + SHANGHAI_OFFSET_MS);
  return `nex-backup-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${OFFSITE_BACKUP_EXTENSION}`;
}

/** 从文件名还原时间（毫秒）；不是我们起的名字返回 null。 */
export function parseOffsiteBackupName(name: string): number | null {
  const match = OFFSITE_BACKUP_NAME_PATTERN.exec(String(name || ""));
  if (!match) return null;
  const [, y, m, d, hh, mm] = match.map(Number) as unknown as number[];
  const ms = Date.UTC(y, m - 1, d, hh, mm) - SHANGHAI_OFFSET_MS;
  return Number.isFinite(ms) ? ms : null;
}

export type RemoteBackupFile = { name: string; size: number; modifiedAt: number | null };

/**
 * 保留最新的 keep 份，返回该删的那些。
 *
 * 只动自己起名的文件（nex-backup-*.fwxbak）：同一个目录里用户自己放的东西、别的面板的
 * 备份，一律不碰。新旧按文件名里的时间排，不按服务器的修改时间 —— 有的 WebDAV 在复制、
 * 迁移后会改掉修改时间。
 */
export function selectBackupsToDelete(files: readonly RemoteBackupFile[], keep: number): RemoteBackupFile[] {
  const ours = files
    .map((file) => ({ file, at: parseOffsiteBackupName(file.name) }))
    .filter((item): item is { file: RemoteBackupFile; at: number } => item.at !== null)
    .sort((a, b) => b.at - a.at || b.file.name.localeCompare(a.file.name));
  const keepCount = Math.max(1, Math.floor(keep) || 1);
  return ours.slice(keepCount).map((item) => item.file);
}

export type OffsiteBackupSchedule =
  | { mode: "daily"; hour: number }
  | { mode: "interval"; everyHours: number };

/** 失败后多久再试一次。 */
export const OFFSITE_BACKUP_RETRY_MS = 60 * 60 * 1000;

/**
 * 最近一个「应该已经备份过」的时间点。
 *   每天 H 点：今天 H 点（还没到就是昨天 H 点）。
 *   每 N 小时：上次成功 + N 小时；从没成功过就是 0（马上该跑）。
 */
export function latestBackupSlot(schedule: OffsiteBackupSchedule, nowMs: number, lastSuccessAt: number | null): number {
  if (schedule.mode === "interval") {
    const every = Math.max(1, Math.floor(schedule.everyHours) || 1) * 3600 * 1000;
    return lastSuccessAt ? lastSuccessAt + every : 0;
  }
  const hour = Math.min(23, Math.max(0, Math.floor(schedule.hour) || 0));
  const shifted = nowMs + SHANGHAI_OFFSET_MS;
  const dayStart = shifted - (shifted % 86_400_000) - SHANGHAI_OFFSET_MS;
  const today = dayStart + hour * 3600 * 1000;
  return nowMs >= today ? today : today - 86_400_000;
}

/**
 * 现在该不该跑一次。
 *
 * 该跑 = 最近那个时间点之后还没成功过，并且（这个时间点之后还没试过，或者上次失败已经过了
 * 一小时）。失败了不会每十分钟重试一次把对方服务器打爆，也不会一直等到明天。
 */
export function isOffsiteBackupDue(input: {
  schedule: OffsiteBackupSchedule;
  nowMs: number;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
}): boolean {
  const slot = latestBackupSlot(input.schedule, input.nowMs, input.lastSuccessAt);
  if (input.nowMs < slot) return false;
  if (input.lastSuccessAt !== null && input.lastSuccessAt >= slot) return false;
  if (input.lastAttemptAt === null || input.lastAttemptAt < slot) return true;
  return input.nowMs - input.lastAttemptAt >= OFFSITE_BACKUP_RETRY_MS;
}

/** 下一次计划时间（给界面显示「下次 10月5日 04:00」）。 */
export function nextBackupAt(schedule: OffsiteBackupSchedule, nowMs: number, lastSuccessAt: number | null): number {
  const slot = latestBackupSlot(schedule, nowMs, lastSuccessAt);
  if (schedule.mode === "interval") return Math.max(slot, nowMs);
  if (lastSuccessAt !== null && lastSuccessAt >= slot) return slot + 86_400_000;
  return Math.max(slot, nowMs);
}
