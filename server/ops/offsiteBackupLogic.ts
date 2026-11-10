/*
  异地自动备份（#10）的纯计算部分：文件名、该不该跑、该删哪些。不碰网络和数据库，便于单测。

  时间一律按面板时区（shared/billingTime.ts 的 BILLING_TIME_ZONE：北京时间，固定 UTC+8、没有
  夏令时）—— 设置里「每天 / 每周几点」写的是它，文件名里的时间也是，管理员在网盘里一眼能对上。
  因为没有夏令时，这里直接按固定偏移算，不必每次过 Intl。
*/

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 保留份数的默认值：每天一份就是两周。 */
export const OFFSITE_BACKUP_DEFAULT_KEEP = 14;

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
  /** weekday：0 = 周日 … 6 = 周六（和 Date#getDay 一致） */
  | { mode: "weekly"; weekday: number; hour: number }
  | { mode: "interval"; everyHours: number };

/** 失败后多久再试一次。 */
export const OFFSITE_BACKUP_RETRY_MS = 60 * 60 * 1000;

/**
 * 最近一个「应该已经备份过」的时间点。
 *   每天 H 点：今天 H 点（还没到就是昨天 H 点）。
 *   每周 W 的 H 点：最近一个已经过去的周 W H 点。
 *   每 N 小时：上次成功 + N 小时；从没成功过就是 0（马上该跑）。
 *
 * 只有「最近一个」：面板停了五天再起来，欠下的五个时间点只算一个，补跑一次就不再欠。
 */
export function latestBackupSlot(schedule: OffsiteBackupSchedule, nowMs: number, lastSuccessAt: number | null): number {
  if (schedule.mode === "interval") {
    const every = Math.max(1, Math.floor(schedule.everyHours) || 1) * HOUR_MS;
    return lastSuccessAt ? lastSuccessAt + every : 0;
  }
  const hour = Math.min(23, Math.max(0, Math.floor(schedule.hour) || 0));
  const shifted = nowMs + SHANGHAI_OFFSET_MS;
  const dayStart = shifted - (shifted % DAY_MS) - SHANGHAI_OFFSET_MS;
  if (schedule.mode === "weekly") {
    const weekday = Math.min(6, Math.max(0, Math.floor(schedule.weekday) || 0));
    const todayWeekday = new Date(shifted).getUTCDay();
    const slot = dayStart - ((todayWeekday - weekday + 7) % 7) * DAY_MS + hour * HOUR_MS;
    // 今天正好是那一天但还没到点：算上周的。
    return nowMs >= slot ? slot : slot - 7 * DAY_MS;
  }
  const today = dayStart + hour * HOUR_MS;
  return nowMs >= today ? today : today - DAY_MS;
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

/**
 * 下一次会跑的时间（给界面显示「下次 10月5日 04:00」）。
 * 这个时间点已经欠着：刚失败过就是失败后一小时的那次重试，否则就是现在（下一轮检查就跑）。
 */
export function nextBackupAt(schedule: OffsiteBackupSchedule, nowMs: number, lastSuccessAt: number | null, lastAttemptAt: number | null = null): number {
  const slot = latestBackupSlot(schedule, nowMs, lastSuccessAt);
  if (schedule.mode !== "interval" && lastSuccessAt !== null && lastSuccessAt >= slot) {
    return slot + (schedule.mode === "weekly" ? 7 : 1) * DAY_MS;
  }
  if (nowMs < slot) return slot;
  if (lastAttemptAt !== null && lastAttemptAt >= slot) return Math.max(nowMs, lastAttemptAt + OFFSITE_BACKUP_RETRY_MS);
  return nowMs;
}

/** 连续失败期间，隔多久再往事件时间线记一条（事件会被 Webhook / Telegram 转发，不能每小时一条）。 */
export const OFFSITE_BACKUP_FAILURE_REPORT_MS = DAY_MS;

/**
 * 这次失败要不要记进事件时间线。
 *
 * 失败后每小时重试一次，目的地一直不通的话一天就是二十多次：只在这一轮失败的第一次记，
 * 之后每满一天再记一条（带上「已连续失败 N 次」），恢复时由成功那条事件说明。
 * 每次失败的原因照常进「最近结果」和面板日志，只是不再各发一条通知。
 */
export function shouldReportBackupFailure(input: { streak: number; lastReportedAt: number | null; nowMs: number }): boolean {
  if (input.streak <= 1 || input.lastReportedAt === null) return true;
  return input.nowMs - input.lastReportedAt >= OFFSITE_BACKUP_FAILURE_REPORT_MS;
}

/**
 * 定时任务抢「这一个小时由我来跑」用的键（settingsRepository.claimSettingKey，一条带冲突忽略的
 * INSERT）。两个面板进程连着同一个库、同一刻都算出「该跑了」时，只有抢到的那个跑。
 * 结尾带日期，settingsRepository 的日标记清理会在一周后把它删掉。
 */
export function offsiteBackupClaimKey(nowMs: number): string {
  const bucket = Math.floor(nowMs / OFFSITE_BACKUP_RETRY_MS);
  return `opsBackupRun:${bucket}:${new Date(nowMs).toISOString().slice(0, 10)}`;
}
