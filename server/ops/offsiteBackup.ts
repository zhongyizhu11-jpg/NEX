/*
  异地自动备份（#10）：定时把「设置 › 备份恢复」那份加密备份传到 WebDAV / S3 / Telegram（可以同时开几个）。

  - 备份内容、加密方式与手动导出完全相同（exportMigrationSnapshot → prune → encryptMigrationSnapshot），
    恢复也走同一条导入路径（system.importPanelBackup）。从不上传未加密的内容。
    面板没了也能解开：scripts/decrypt-backup.mjs 只用 Node 自带的 crypto。
  - 加密口令存在设置里（定时任务要用），这是管理员自己的选择；界面上写清楚丢了口令备份就打不开。
  - 只删自己起名的文件（nex-backup-*.fwxbak），目录里的别的东西一律不动。
  - 每个目的地各记各的「上次成功」：两个都开、其中一个不通时，每小时的重试只补不通的那个，
    不会往好的那边一小时塞一份、把保留份数里的旧备份挤掉。
  - 目的地的实现（发请求、SSRF 检查）在 offsiteBackupDestinations.ts。
*/
import * as db from "../db";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { encryptMigrationSnapshot, exportMigrationSnapshot, pruneMigrationSnapshotForPanelBackup } from "../migration";
import { getSettingsByPrefix, setSettings } from "../repositories/settingsRepository";
import { recordPanelEvent } from "./panelEvents";
import {
  describeBackupError,
  OFFSITE_BACKUP_TARGET_LABELS,
  OFFSITE_BACKUP_TARGETS,
  s3Destination,
  telegramDestination,
  webdavDestination,
  type BackupDestination,
  type OffsiteBackupTarget,
  type WebdavConfig,
} from "./offsiteBackupDestinations";
import {
  isOffsiteBackupDue,
  nextBackupAt,
  OFFSITE_BACKUP_DEFAULT_KEEP,
  offsiteBackupName,
  parseOffsiteBackupName,
  selectBackupsToDelete,
  shouldReportBackupFailure,
  type OffsiteBackupSchedule,
  type RemoteBackupFile,
} from "./offsiteBackupLogic";
import type { S3Config } from "./offsiteBackupS3";

export { OFFSITE_BACKUP_TARGETS, type OffsiteBackupTarget } from "./offsiteBackupDestinations";

const PREFIX = "ops.backup.";
const K = {
  /** 开着的目的地，逗号分隔（"webdav,s3"）；空串或 "off" 就是没开。 */
  destination: `${PREFIX}destination`,
  webdavUrl: `${PREFIX}webdav.url`,
  webdavUser: `${PREFIX}webdav.user`,
  webdavPassword: `${PREFIX}webdav.password`,
  s3Endpoint: `${PREFIX}s3.endpoint`,
  s3Region: `${PREFIX}s3.region`,
  s3Bucket: `${PREFIX}s3.bucket`,
  s3Prefix: `${PREFIX}s3.prefix`,
  s3AccessKey: `${PREFIX}s3.accessKey`,
  s3SecretKey: `${PREFIX}s3.secretKey`,
  s3PathStyle: `${PREFIX}s3.pathStyle`,
  passphrase: `${PREFIX}passphrase`,
  scheduleMode: `${PREFIX}schedule.mode`,
  scheduleHour: `${PREFIX}schedule.hour`,
  scheduleWeekday: `${PREFIX}schedule.weekday`,
  scheduleEveryHours: `${PREFIX}schedule.everyHours`,
  keep: `${PREFIX}keep`,
  failStreak: `${PREFIX}fail.streak`,
  failReportedAt: `${PREFIX}fail.reportedAt`,
  history: `${PREFIX}history`,
} as const;
const successAtKey = (target: OffsiteBackupTarget) => `${PREFIX}last.${target}.successAt`;
const attemptAtKey = (target: OffsiteBackupTarget) => `${PREFIX}last.${target}.attemptAt`;

/** 「最近结果」留多少条（每个目的地每次一条）。 */
const HISTORY_LIMIT = 20;

export type OffsiteBackupSettings = {
  destinations: OffsiteBackupTarget[];
  webdav: WebdavConfig;
  s3: S3Config;
  passphrase: string;
  schedule: OffsiteBackupSchedule;
  keep: number;
};

export type OffsiteBackupHistoryEntry = {
  /** 毫秒 */
  at: number;
  trigger: "schedule" | "manual";
  destination: OffsiteBackupTarget;
  ok: boolean;
  name: string;
  size: number;
  /** 失败原因；成功时是补充说明（删了几份旧的、清理没成功），没有就是空串。 */
  message: string;
};

export type OffsiteBackupState = {
  targets: Record<OffsiteBackupTarget, { successAt: number | null; attemptAt: number | null }>;
  failStreak: number;
  failReportedAt: number | null;
  history: OffsiteBackupHistoryEntry[];
};

function num(value: unknown, fallback: number, min: number, max: number) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function epochMs(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseDestinations(raw: string): OffsiteBackupTarget[] {
  const wanted = new Set(raw.split(",").map((item) => item.trim()));
  return OFFSITE_BACKUP_TARGETS.filter((target) => wanted.has(target));
}

function isTarget(value: unknown): value is OffsiteBackupTarget {
  return (OFFSITE_BACKUP_TARGETS as readonly unknown[]).includes(value);
}

function parseHistory(raw: string): OffsiteBackupHistoryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: OffsiteBackupHistoryEntry[] = [];
  for (const item of parsed as Array<Partial<OffsiteBackupHistoryEntry> | null>) {
    if (!item || !isTarget(item.destination) || !epochMs(item.at)) continue;
    out.push({
      at: Number(item.at),
      trigger: item.trigger === "manual" ? "manual" : "schedule",
      destination: item.destination,
      ok: item.ok === true,
      name: String(item.name || ""),
      size: Number(item.size) || 0,
      message: String(item.message || ""),
    });
  }
  return out.slice(0, HISTORY_LIMIT);
}

export async function readOffsiteBackupSettings(): Promise<{ settings: OffsiteBackupSettings; state: OffsiteBackupState }> {
  const raw = await getSettingsByPrefix(PREFIX);
  const get = (key: string) => String(raw[key] ?? "");
  const hour = num(raw[K.scheduleHour], 4, 0, 23);
  const mode = get(K.scheduleMode);
  const schedule: OffsiteBackupSchedule = mode === "interval"
    ? { mode: "interval", everyHours: num(raw[K.scheduleEveryHours], 12, 1, 168) }
    : mode === "weekly"
      ? { mode: "weekly", weekday: num(raw[K.scheduleWeekday], 1, 0, 6), hour }
      : { mode: "daily", hour };
  const targets = {} as OffsiteBackupState["targets"];
  for (const target of OFFSITE_BACKUP_TARGETS) {
    targets[target] = { successAt: epochMs(raw[successAtKey(target)]), attemptAt: epochMs(raw[attemptAtKey(target)]) };
  }
  return {
    settings: {
      destinations: parseDestinations(get(K.destination)),
      webdav: { url: get(K.webdavUrl), user: get(K.webdavUser), password: get(K.webdavPassword) },
      s3: {
        endpoint: get(K.s3Endpoint),
        region: get(K.s3Region) || "us-east-1",
        bucket: get(K.s3Bucket),
        prefix: get(K.s3Prefix),
        accessKeyId: get(K.s3AccessKey),
        secretAccessKey: get(K.s3SecretKey),
        pathStyle: get(K.s3PathStyle) !== "false",
      },
      passphrase: get(K.passphrase),
      schedule,
      keep: num(raw[K.keep], OFFSITE_BACKUP_DEFAULT_KEEP, 1, 100),
    },
    state: {
      targets,
      failStreak: num(raw[K.failStreak], 0, 0, 1_000_000),
      failReportedAt: epochMs(raw[K.failReportedAt]),
      history: parseHistory(get(K.history)),
    },
  };
}

export type OffsiteBackupSettingsInput = {
  destinations: readonly OffsiteBackupTarget[];
  webdav?: { url?: string; user?: string; password?: string };
  s3?: { endpoint?: string; region?: string; bucket?: string; prefix?: string; accessKeyId?: string; secretAccessKey?: string; pathStyle?: boolean };
  /** 空串 = 不改 */
  passphrase?: string;
  schedule: OffsiteBackupSchedule;
  keep: number;
};

/** 密钥类字段传空串表示「保持原值」—— 界面上拿到的只是是否已设置，不是原文。 */
export async function saveOffsiteBackupSettings(input: OffsiteBackupSettingsInput) {
  const map: Record<string, string | null> = {
    [K.destination]: OFFSITE_BACKUP_TARGETS.filter((target) => input.destinations.includes(target)).join(","),
    [K.scheduleMode]: input.schedule.mode,
    [K.keep]: String(num(input.keep, OFFSITE_BACKUP_DEFAULT_KEEP, 1, 100)),
  };
  if (input.schedule.mode === "interval") {
    map[K.scheduleEveryHours] = String(num(input.schedule.everyHours, 12, 1, 168));
  } else {
    map[K.scheduleHour] = String(num(input.schedule.hour, 4, 0, 23));
    if (input.schedule.mode === "weekly") map[K.scheduleWeekday] = String(num(input.schedule.weekday, 1, 0, 6));
  }
  if (input.webdav) {
    if (input.webdav.url !== undefined) map[K.webdavUrl] = input.webdav.url.trim();
    if (input.webdav.user !== undefined) map[K.webdavUser] = input.webdav.user.trim();
    if (input.webdav.password) map[K.webdavPassword] = input.webdav.password;
  }
  if (input.s3) {
    if (input.s3.endpoint !== undefined) map[K.s3Endpoint] = input.s3.endpoint.trim().replace(/\/+$/, "");
    if (input.s3.region !== undefined) map[K.s3Region] = input.s3.region.trim();
    if (input.s3.bucket !== undefined) map[K.s3Bucket] = input.s3.bucket.trim();
    if (input.s3.prefix !== undefined) map[K.s3Prefix] = input.s3.prefix.trim();
    if (input.s3.accessKeyId !== undefined) map[K.s3AccessKey] = input.s3.accessKeyId.trim();
    if (input.s3.secretAccessKey) map[K.s3SecretKey] = input.s3.secretAccessKey;
    if (input.s3.pathStyle !== undefined) map[K.s3PathStyle] = input.s3.pathStyle ? "true" : "false";
  }
  if (input.passphrase) map[K.passphrase] = input.passphrase;
  await setSettings(map);
}

/** 给界面看的版本：密钥只说有没有设置。 */
export async function readOffsiteBackupSettingsForClient() {
  const { settings, state } = await readOffsiteBackupSettings();
  const now = Date.now();
  // 开了几个目的地就各算各的，取最早的那个；没设口令时定时任务不会跑，也就没有「下次」。
  const nextRuns = settings.passphrase.length >= 8
    ? settings.destinations.map((target) => nextBackupAt(settings.schedule, now, state.targets[target].successAt, state.targets[target].attemptAt))
    : [];
  return {
    destinations: settings.destinations,
    webdav: { url: settings.webdav.url, user: settings.webdav.user, hasPassword: !!settings.webdav.password },
    s3: {
      endpoint: settings.s3.endpoint,
      region: settings.s3.region,
      bucket: settings.s3.bucket,
      prefix: settings.s3.prefix,
      accessKeyId: settings.s3.accessKeyId,
      hasSecretKey: !!settings.s3.secretAccessKey,
      pathStyle: settings.s3.pathStyle,
    },
    hasPassphrase: !!settings.passphrase,
    schedule: settings.schedule,
    keep: settings.keep,
    history: state.history,
    nextRunAt: nextRuns.length > 0 ? Math.min(...nextRuns) : null,
  };
}

function destinationFor(target: OffsiteBackupTarget, settings: OffsiteBackupSettings): BackupDestination {
  if (target === "webdav") return webdavDestination(settings.webdav);
  if (target === "s3") return s3Destination(settings.s3);
  return telegramDestination();
}

// ==================== 对外操作 ====================

/** 把开着的目的地挨个测一遍。有一个不通就抛错，报错里写清哪个通、哪个不通。 */
export async function testOffsiteBackupConnection(): Promise<string> {
  const { settings } = await readOffsiteBackupSettings();
  if (settings.destinations.length === 0) throw new Error("异地备份未开启");
  const lines: string[] = [];
  let failed = false;
  for (const target of settings.destinations) {
    const label = OFFSITE_BACKUP_TARGET_LABELS[target];
    let destination: BackupDestination | null = null;
    try {
      destination = destinationFor(target, settings);
      lines.push(`${label}：${await destination.test()}`);
    } catch (error) {
      failed = true;
      lines.push(`${label} 不通：${withoutLabel(label, describeBackupError(error, destination?.secrets))}`);
    }
  }
  const message = lines.join("；");
  if (failed) throw new Error(message);
  return message;
}

export type OffsiteBackupRemoteList = {
  destination: OffsiteBackupTarget;
  label: string;
  files: RemoteBackupFile[];
  /** 这个目的地读不到时的原因；读到了是 null。 */
  error: string | null;
};

/** 每个开着的目的地上，面板自己传上去的备份（新的在前）。一个读不到不影响另一个。 */
export async function listOffsiteBackups(): Promise<OffsiteBackupRemoteList[]> {
  const { settings } = await readOffsiteBackupSettings();
  const out: OffsiteBackupRemoteList[] = [];
  for (const target of settings.destinations) {
    const label = OFFSITE_BACKUP_TARGET_LABELS[target];
    let destination: BackupDestination | null = null;
    try {
      destination = destinationFor(target, settings);
      const files = (await destination.list())
        .filter((file) => parseOffsiteBackupName(file.name) !== null)
        .map((file) => ({ ...file, modifiedAt: parseOffsiteBackupName(file.name) ?? file.modifiedAt }))
        .sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
      out.push({ destination: target, label, files, error: null });
    } catch (error) {
      out.push({ destination: target, label, files: [], error: describeBackupError(error, destination?.secrets) });
    }
  }
  return out;
}

/** 下载一份远端备份的原文（加密的 JSON），交给 system.importPanelBackup 去解密、导入。 */
export async function downloadOffsiteBackup(target: OffsiteBackupTarget, name: string): Promise<string> {
  if (parseOffsiteBackupName(name) === null) throw new Error("只能恢复面板自己传上去的备份");
  const { settings } = await readOffsiteBackupSettings();
  let destination: BackupDestination | null = null;
  try {
    destination = destinationFor(target, settings);
    return await destination.download(name);
  } catch (error) {
    throw new Error(describeBackupError(error, destination?.secrets));
  }
}

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 报错里多半已经带着目的地的名字（「WebDAV 上传失败…」）；没带的（超时、连不上）补在前面。 */
function withLabel(label: string, message: string) {
  return message.includes(label) ? message : `${label}：${message}`;
}

/** 反过来：已经单独标了目的地的地方（「最近结果」、测试连接），去掉报错开头重复的那个名字。 */
function withoutLabel(label: string, message: string) {
  return message.startsWith(label) ? message.slice(label.length).trim() : message;
}

export type OffsiteBackupRunResult = { name: string; size: number; deleted: number; message: string };

type TargetResult = { target: OffsiteBackupTarget; label: string; ok: boolean; deleted: number; message: string };

/** 传到一个目的地，再按保留份数清理它上面的旧备份。不抛错，结果里说成没成。 */
async function uploadToTarget(target: OffsiteBackupTarget, settings: OffsiteBackupSettings, name: string, body: Buffer): Promise<TargetResult> {
  const label = OFFSITE_BACKUP_TARGET_LABELS[target];
  let destination: BackupDestination | null = null;
  try {
    destination = destinationFor(target, settings);
    await destination.upload(name, body);
  } catch (error) {
    return { target, label, ok: false, deleted: 0, message: describeBackupError(error, destination?.secrets) };
  }
  // 清理旧备份失败不算备份失败：新的已经传上去了，只记一句。
  let deleted = 0;
  try {
    const stale = selectBackupsToDelete(await destination.list(), settings.keep);
    for (const file of stale) {
      await destination.remove(file.name);
      deleted += 1;
    }
  } catch (error) {
    return { target, label, ok: true, deleted, message: `清理旧备份失败：${describeBackupError(error, destination.secrets)}` };
  }
  return { target, label, ok: true, deleted, message: deleted > 0 ? `删掉 ${deleted} 份旧的` : "" };
}

/**
 * 做一次备份：导出 → 加密 → 传到各个目的地 → 各自按保留份数清理旧的。
 *
 * - 手动（manual）：传到所有开着的目的地。定时（schedule）：只传到这一刻「该跑了」的那些，
 *   并且是拿到锁之后才算 —— 定时任务排在一次手动备份后面时，手动那次已经算数，不再传一遍。
 *   没有该跑的返回 null。
 * - 同一时刻只跑一份（定时与「立即备份」撞上时后来的等前一个跑完）。
 * - 开跑前先记「试过了」：面板中途被杀、或另一个面板进程也在看同一个库时，一小时内不会再来一遍。
 * - 每个目的地成没成都进「最近结果」。事件时间线（会被 Webhook / Telegram 转发）成功记一条；
 *   失败只在这一轮失败的第一次、以及之后每满一天记一条，见 shouldReportBackupFailure。
 * - 有任何一个目的地失败就抛错（报错里写明哪个成了、哪个没成）。
 */
export async function runOffsiteBackup(trigger: "manual"): Promise<OffsiteBackupRunResult>;
export async function runOffsiteBackup(trigger: "schedule"): Promise<OffsiteBackupRunResult | null>;
export async function runOffsiteBackup(trigger: "schedule" | "manual"): Promise<OffsiteBackupRunResult | null> {
  return withKeyedTaskLock("ops-offsite-backup", async () => {
    const startedAt = Date.now();
    const { settings, state } = await readOffsiteBackupSettings();
    if (settings.destinations.length === 0) {
      if (trigger === "schedule") return null;
      throw new Error("异地备份未开启");
    }
    if (settings.passphrase.length < 8) {
      if (trigger === "schedule") return null;
      throw new Error("还没有设置备份口令（至少 8 位）");
    }
    const targets = trigger === "manual"
      ? settings.destinations
      : settings.destinations.filter((target) => isOffsiteBackupDue({
        schedule: settings.schedule,
        nowMs: startedAt,
        lastSuccessAt: state.targets[target].successAt,
        lastAttemptAt: state.targets[target].attemptAt,
      }));
    if (targets.length === 0) return null;
    await setSettings(Object.fromEntries(targets.map((target) => [attemptAtKey(target), String(startedAt)])));

    const name = offsiteBackupName(startedAt);
    let size = 0;
    let results: TargetResult[];
    try {
      const all = await db.getAllSettings();
      const snapshot = await exportMigrationSnapshot(String(all.panelPublicUrl || "") || undefined);
      const encrypted = encryptMigrationSnapshot(pruneMigrationSnapshotForPanelBackup(snapshot), settings.passphrase);
      const body = Buffer.from(JSON.stringify(encrypted), "utf8");
      size = body.length;
      results = [];
      for (const target of targets) results.push(await uploadToTarget(target, settings, name, body));
    } catch (error) {
      // 导出 / 加密这一步就没过：哪儿都没传成。
      const reason = `导出备份失败：${describeBackupError(error)}`;
      results = targets.map((target) => ({ target, label: OFFSITE_BACKUP_TARGET_LABELS[target], ok: false, deleted: 0, message: reason }));
    }

    const succeeded = results.filter((result) => result.ok);
    const failed = results.filter((result) => !result.ok);
    const deleted = results.reduce((sum, result) => sum + result.deleted, 0);
    const finishedAt = Date.now();
    const history: OffsiteBackupHistoryEntry[] = [
      ...results.map((result) => ({
        at: startedAt,
        trigger,
        destination: result.target,
        ok: result.ok,
        name: result.ok ? name : "",
        size: result.ok ? size : 0,
        message: withoutLabel(result.label, result.message),
      })),
      ...state.history,
    ].slice(0, HISTORY_LIMIT);
    const updates: Record<string, string | null> = { [K.history]: JSON.stringify(history) };
    for (const result of succeeded) updates[successAtKey(result.target)] = String(finishedAt);

    const okLabels = succeeded.map((result) => result.label).join("、");
    const data = { trigger, name, size, deleted, succeeded: succeeded.map((result) => result.target), failed: failed.map((result) => result.target) };

    if (failed.length === 0) {
      const notes = succeeded.filter((result) => result.message).map((result) => withLabel(result.label, result.message)).join("；");
      const cleanupFailed = succeeded.some((result) => result.message.startsWith("清理旧备份失败"));
      const recovered = state.failStreak > 0 ? `（此前连续失败 ${state.failStreak} 次，已恢复）` : "";
      const message = `异地备份完成：${name}（${formatSize(size)}，${okLabels}）${notes ? `；${notes}` : ""}${recovered}`;
      updates[K.failStreak] = "0";
      updates[K.failReportedAt] = "";
      await setSettings(updates);
      await recordPanelEvent({ kind: "ops.backup", level: cleanupFailed ? "warn" : "info", message, data });
      return { name, size, deleted, message };
    }

    const streak = state.failStreak + 1;
    const message = `异地备份失败：${failed.map((result) => withLabel(result.label, result.message)).join("；")}${okLabels ? `（${okLabels} 已成功）` : ""}`;
    const report = shouldReportBackupFailure({ streak, lastReportedAt: state.failReportedAt, nowMs: finishedAt });
    updates[K.failStreak] = String(streak);
    if (report) updates[K.failReportedAt] = String(finishedAt);
    // 状态写不进去也要把失败报出去：库本身出问题时这里正是最需要有人看见的地方。
    await setSettings(updates).catch(() => undefined);
    console.warn(`[OffsiteBackup] ${message}${streak > 1 ? `（已连续失败 ${streak} 次）` : ""}`);
    if (report) {
      await recordPanelEvent({
        kind: "ops.backup",
        level: "warn",
        message: `${message}${streak > 1 ? `（已连续失败 ${streak} 次）` : ""}`,
        data: { ...data, streak },
      });
    }
    throw new Error(message);
  });
}
