/*
  异地自动备份（#10）：定时把「设置 › 备份恢复」那份加密备份传到 WebDAV / S3 / Telegram。

  - 备份内容、加密方式与手动导出完全相同（exportMigrationSnapshot → prune → encryptMigrationSnapshot），
    恢复也走同一条导入路径（system.importPanelBackup）。从不上传未加密的内容。
  - 加密口令存在设置里（定时任务要用），这是管理员自己的选择；界面上写清楚丢了口令备份就打不开。
  - WebDAV / S3 只允许 HTTPS，并且过 SSRF 检查（不让面板去请求内网地址），不跟随重定向。
  - 只删自己起名的文件（nex-backup-*.fwxbak），目录里的别的东西一律不动。
*/
import * as db from "../db";
import { ENV } from "../env";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { encryptMigrationSnapshot, exportMigrationSnapshot, pruneMigrationSnapshotForPanelBackup } from "../migration";
import { getSettingsByPrefix, setSettings } from "../repositories/settingsRepository";
import { assertSafeOutboundUrl } from "../ssrf";
import { sendTelegramMessage } from "../telegramBot";
import { recordPanelEvent } from "./panelEvents";
import {
  offsiteBackupName,
  parseOffsiteBackupName,
  selectBackupsToDelete,
  type OffsiteBackupSchedule,
  type RemoteBackupFile,
} from "./offsiteBackupLogic";
import { buildSignedS3Request, normalizeS3Prefix, parseListObjectsV2, parseS3Error, type S3Config } from "./offsiteBackupS3";
import { basicAuthHeader, parseWebdavPropfind, WEBDAV_PROPFIND_BODY, webdavFileUrl, webdavFolderUrl } from "./offsiteBackupWebdav";

export const OFFSITE_BACKUP_DESTINATIONS = ["off", "webdav", "s3", "telegram"] as const;
export type OffsiteBackupDestination = (typeof OFFSITE_BACKUP_DESTINATIONS)[number];
const PREFIX = "ops.backup.";
const K = {
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
  scheduleEveryHours: `${PREFIX}schedule.everyHours`,
  keep: `${PREFIX}keep`,
  lastSuccessAt: `${PREFIX}last.successAt`,
  lastAttemptAt: `${PREFIX}last.attemptAt`,
  lastStatus: `${PREFIX}last.status`,
  lastMessage: `${PREFIX}last.message`,
  lastName: `${PREFIX}last.name`,
  lastSize: `${PREFIX}last.size`,
  telegramFiles: `${PREFIX}telegram.files`,
} as const;

/** 下载回来的备份最大多大（与手动导入的上限一致）。 */
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
/** Telegram Bot API 只能下载 20 MB 以内的文件。 */
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export type OffsiteBackupSettings = {
  destination: OffsiteBackupDestination;
  webdav: { url: string; user: string; password: string };
  s3: S3Config;
  passphrase: string;
  schedule: OffsiteBackupSchedule;
  keep: number;
};

export type OffsiteBackupStatus = {
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastStatus: "success" | "failed" | null;
  lastMessage: string;
  lastName: string;
  lastSize: number;
};

function num(value: unknown, fallback: number, min: number, max: number) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function epochMs(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function readOffsiteBackupSettings(): Promise<{ settings: OffsiteBackupSettings; status: OffsiteBackupStatus }> {
  const raw = await getSettingsByPrefix(PREFIX);
  const get = (key: string) => String(raw[key] ?? "");
  const destination = (OFFSITE_BACKUP_DESTINATIONS as readonly string[]).includes(get(K.destination))
    ? (get(K.destination) as OffsiteBackupDestination)
    : "off";
  const schedule: OffsiteBackupSchedule = get(K.scheduleMode) === "interval"
    ? { mode: "interval", everyHours: num(raw[K.scheduleEveryHours], 12, 1, 168) }
    : { mode: "daily", hour: num(raw[K.scheduleHour], 4, 0, 23) };
  return {
    settings: {
      destination,
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
      keep: num(raw[K.keep], 7, 1, 100),
    },
    status: {
      lastSuccessAt: epochMs(raw[K.lastSuccessAt]),
      lastAttemptAt: epochMs(raw[K.lastAttemptAt]),
      lastStatus: get(K.lastStatus) === "success" ? "success" : get(K.lastStatus) === "failed" ? "failed" : null,
      lastMessage: get(K.lastMessage),
      lastName: get(K.lastName),
      lastSize: Number(raw[K.lastSize] || 0) || 0,
    },
  };
}

export type OffsiteBackupSettingsInput = {
  destination: OffsiteBackupDestination;
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
    [K.destination]: input.destination,
    [K.scheduleMode]: input.schedule.mode,
    [K.keep]: String(num(input.keep, 7, 1, 100)),
  };
  if (input.schedule.mode === "daily") map[K.scheduleHour] = String(num(input.schedule.hour, 4, 0, 23));
  else map[K.scheduleEveryHours] = String(num(input.schedule.everyHours, 12, 1, 168));
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
  const { settings, status } = await readOffsiteBackupSettings();
  return {
    destination: settings.destination,
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
    status,
  };
}

// ==================== 网络 ====================

function describeError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "TimeoutError") message = "请求超时";
  if (error instanceof Error && (error as any).cause?.code) message = `${message}（${(error as any).cause.code}）`;
  for (const secret of secrets) if (secret) message = message.split(secret).join("***");
  return message.slice(0, 300);
}

/** 对外请求：只许 HTTPS、过 SSRF 检查、不跟随重定向（防止被 30x 带去内网）、带超时。 */
async function safeFetch(url: string, init: RequestInit & { timeoutMs?: number }, purpose: string): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`${purpose} 只支持 HTTPS 地址`);
  await assertSafeOutboundUrl(url, { purpose });
  const { timeoutMs, ...rest } = init;
  const response = await fetch(url, { ...rest, redirect: "manual", signal: AbortSignal.timeout(timeoutMs ?? REQUEST_TIMEOUT_MS) });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${purpose} 返回了重定向（${response.status}），为安全起见不跟随，请直接填最终地址`);
  }
  return response;
}

async function readLimitedText(response: Response, limit = MAX_BACKUP_BYTES): Promise<string> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new Error(`备份文件过大（${Math.round(declared / 1024 / 1024)} MB）`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) throw new Error(`备份文件过大（${Math.round(buffer.length / 1024 / 1024)} MB）`);
  return buffer.toString("utf8");
}

function httpError(purpose: string, status: number, detail = "") {
  const hint = status === 401 || status === 403 ? "：账号、密码或权限不对" : status === 404 ? "：路径不存在" : "";
  return new Error(`${purpose} 失败，HTTP ${status}${hint}${detail ? `（${detail.slice(0, 160)}）` : ""}`);
}

type Destination = {
  label: string;
  upload(name: string, body: Buffer): Promise<void>;
  list(): Promise<RemoteBackupFile[]>;
  download(name: string): Promise<string>;
  remove(name: string): Promise<void>;
  test(): Promise<string>;
  secrets: string[];
};

function webdavDestination(config: OffsiteBackupSettings["webdav"]): Destination {
  if (!config.url) throw new Error("请填写 WebDAV 地址");
  const folder = webdavFolderUrl(config.url);
  const auth = basicAuthHeader(config.user, config.password);
  const purpose = "WebDAV";
  const list = async () => {
    const response = await safeFetch(folder, {
      method: "PROPFIND",
      headers: { authorization: auth, depth: "1", "content-type": "application/xml; charset=utf-8" },
      body: WEBDAV_PROPFIND_BODY,
    }, purpose);
    if (response.status !== 207 && response.status !== 200) throw httpError("WebDAV 列目录", response.status);
    return parseWebdavPropfind(await response.text())
      .filter((entry) => !entry.isCollection && entry.name)
      .map((entry) => ({ name: entry.name, size: entry.size, modifiedAt: entry.modifiedAt }));
  };
  const upload = async (name: string, body: Buffer) => {
    const response = await safeFetch(webdavFileUrl(folder, name), {
      method: "PUT",
      headers: { authorization: auth, "content-type": "application/octet-stream" },
      body: new Uint8Array(body),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }, purpose);
    if (![200, 201, 204].includes(response.status)) throw httpError("WebDAV 上传", response.status);
  };
  const remove = async (name: string) => {
    const response = await safeFetch(webdavFileUrl(folder, name), { method: "DELETE", headers: { authorization: auth } }, purpose);
    if (![200, 202, 204, 404].includes(response.status)) throw httpError("WebDAV 删除", response.status);
  };
  return {
    label: "WebDAV",
    secrets: [config.password],
    list,
    upload,
    remove,
    async download(name) {
      const response = await safeFetch(webdavFileUrl(folder, name), { method: "GET", headers: { authorization: auth }, timeoutMs: UPLOAD_TIMEOUT_MS }, purpose);
      if (response.status !== 200) throw httpError("WebDAV 下载", response.status);
      return readLimitedText(response);
    },
    async test() {
      let created = false;
      const probe = await safeFetch(folder, {
        method: "PROPFIND",
        headers: { authorization: auth, depth: "0", "content-type": "application/xml; charset=utf-8" },
        body: WEBDAV_PROPFIND_BODY,
      }, purpose);
      if (probe.status === 404) {
        const mk = await safeFetch(folder, { method: "MKCOL", headers: { authorization: auth } }, purpose);
        if (![200, 201].includes(mk.status)) throw httpError("WebDAV 建目录", mk.status);
        created = true;
      } else if (probe.status !== 207 && probe.status !== 200) {
        throw httpError("WebDAV 连接", probe.status);
      }
      // 试写一个小文件再删掉：只读账号能列目录，却存不了备份。
      const testName = "nex-backup-connection-test.txt";
      await upload(testName, Buffer.from("NEX offsite backup connection test\n"));
      await remove(testName);
      return created ? "连接正常，目录不存在，已新建" : "连接正常，可以写入";
    },
  };
}

function s3Destination(config: S3Config): Destination {
  if (!config.endpoint || !config.bucket) throw new Error("请填写 S3 地址和存储桶");
  if (!config.accessKeyId || !config.secretAccessKey) throw new Error("请填写 Access Key 和 Secret Key");
  const prefix = normalizeS3Prefix(config.prefix);
  const purpose = "S3";
  const send = async (request: Parameters<typeof buildSignedS3Request>[1], timeoutMs = REQUEST_TIMEOUT_MS) => {
    const signed = buildSignedS3Request(config, request);
    return safeFetch(signed.url, {
      method: request.method,
      headers: signed.headers,
      body: request.body ? new Uint8Array(request.body) : undefined,
      timeoutMs,
    }, purpose);
  };
  const failure = async (action: string, response: Response) => {
    const text = await response.text().catch(() => "");
    return httpError(`S3 ${action}`, response.status, parseS3Error(text));
  };
  const list = async () => {
    const out: RemoteBackupFile[] = [];
    let token: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query: Array<[string, string]> = [["list-type", "2"], ["prefix", prefix]];
      if (token) query.push(["continuation-token", token]);
      const response = await send({ method: "GET", key: "", query });
      if (response.status !== 200) throw await failure("列目录", response);
      const parsed = parseListObjectsV2(await response.text());
      for (const object of parsed.objects) {
        const name = object.key.slice(prefix.length);
        if (!name || name.includes("/")) continue;
        out.push({ name, size: object.size, modifiedAt: object.lastModified });
      }
      if (!parsed.isTruncated || !parsed.nextToken) break;
      token = parsed.nextToken;
    }
    return out;
  };
  const upload = async (name: string, body: Buffer) => {
    const response = await send({ method: "PUT", key: `${prefix}${name}`, body, contentType: "application/octet-stream" }, UPLOAD_TIMEOUT_MS);
    if (response.status !== 200) throw await failure("上传", response);
  };
  const remove = async (name: string) => {
    const response = await send({ method: "DELETE", key: `${prefix}${name}` });
    if (![200, 204, 404].includes(response.status)) throw await failure("删除", response);
  };
  return {
    label: "S3",
    secrets: [config.secretAccessKey],
    list,
    upload,
    remove,
    async download(name) {
      const response = await send({ method: "GET", key: `${prefix}${name}` }, UPLOAD_TIMEOUT_MS);
      if (response.status !== 200) throw await failure("下载", response);
      return readLimitedText(response);
    },
    async test() {
      await list();
      const testName = "nex-backup-connection-test.txt";
      await upload(testName, Buffer.from("NEX offsite backup connection test\n"));
      await remove(testName);
      return "连接正常，可以写入";
    },
  };
}

type TelegramBackupRecord = {
  name: string;
  size: number;
  at: number;
  fileId: string;
  messages: Array<{ chatId: string; messageId: number }>;
};

async function telegramToken(): Promise<string> {
  const settings = await db.getAllSettings();
  return ENV.telegramBotToken.trim() || String(settings.telegramBotToken || "").trim();
}

async function readTelegramRecords(): Promise<TelegramBackupRecord[]> {
  const raw = (await getSettingsByPrefix(K.telegramFiles))[K.telegramFiles];
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.name === "string") : [];
  } catch {
    return [];
  }
}

async function writeTelegramRecords(records: TelegramBackupRecord[]) {
  await setSettings({ [K.telegramFiles]: JSON.stringify(records.slice(0, 200)) });
}

async function telegramCall<T = any>(token: string, method: string, body: Record<string, unknown> | FormData, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "content-type": "application/json" },
    body: isForm ? (body as FormData) : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => null) as any;
  if (!response.ok || !json?.ok) {
    throw new Error(`Telegram ${method} 失败：${String(json?.description || `HTTP ${response.status}`).slice(0, 200)}`);
  }
  return json.result as T;
}

function telegramDestination(): Destination {
  const secrets: string[] = [];
  const context = async () => {
    const token = await telegramToken();
    if (!token) throw new Error("还没有配置 Telegram 机器人（设置 › Telegram）");
    secrets.push(token);
    const recipients = ((await db.getTelegramAdminRecipients()) as any[])
      .map((user) => String(user.telegramId || "").trim())
      .filter(Boolean);
    if (recipients.length === 0) throw new Error("没有绑定了 Telegram 的管理员，备份无处可发");
    return { token, recipients };
  };
  return {
    label: "Telegram",
    secrets,
    async upload(name, body) {
      const { token, recipients } = await context();
      if (body.length > 50 * 1024 * 1024) throw new Error("备份超过 50 MB，Telegram 机器人发不了，请改用 WebDAV 或 S3");
      const record: TelegramBackupRecord = { name, size: body.length, at: Date.now(), fileId: "", messages: [] };
      for (const chatId of recipients) {
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append("caption", `NEX 异地备份 ${name}（已加密，恢复时需要备份口令）`);
        form.append("document", new Blob([new Uint8Array(body)], { type: "application/octet-stream" }), name);
        const result = await telegramCall<any>(token, "sendDocument", form, UPLOAD_TIMEOUT_MS);
        if (!record.fileId) record.fileId = String(result?.document?.file_id || "");
        record.messages.push({ chatId, messageId: Number(result?.message_id || 0) });
      }
      const records = (await readTelegramRecords()).filter((item) => item.name !== name);
      await writeTelegramRecords([record, ...records]);
    },
    async list() {
      return (await readTelegramRecords()).map((item) => ({ name: item.name, size: item.size, modifiedAt: item.at }));
    },
    async download(name) {
      const { token } = await context();
      const record = (await readTelegramRecords()).find((item) => item.name === name);
      if (!record?.fileId) throw new Error("找不到这份备份在 Telegram 里的记录");
      if (record.size > TELEGRAM_DOWNLOAD_LIMIT) {
        throw new Error("Telegram 机器人只能取回 20 MB 以内的文件：请在 Telegram 里手动下载这份备份，到「备份恢复」里导入");
      }
      const file = await telegramCall<any>(token, "getFile", { file_id: record.fileId });
      const filePath = String(file?.file_path || "");
      if (!filePath) throw new Error("Telegram 没有返回文件地址");
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Telegram 下载失败，HTTP ${response.status}`);
      return readLimitedText(response);
    },
    async remove(name) {
      const records = await readTelegramRecords();
      const record = records.find((item) => item.name === name);
      if (record) {
        const token = await telegramToken();
        // Telegram 只允许删 48 小时内的消息；删不掉就留在聊天里，只是不再算进「保留最新 N 份」。
        for (const message of record.messages) {
          if (!token || !message.messageId) continue;
          await telegramCall(token, "deleteMessage", { chat_id: message.chatId, message_id: message.messageId }).catch(() => undefined);
        }
      }
      await writeTelegramRecords(records.filter((item) => item.name !== name));
    },
    async test() {
      const { token, recipients } = await context();
      await telegramCall(token, "getMe", {});
      for (const chatId of recipients) {
        await sendTelegramMessage(chatId, "NEX 异地备份：连接测试成功，之后的备份会以文件形式发到这里。");
      }
      return `连接正常，备份会发给 ${recipients.length} 位管理员`;
    },
  };
}

function destinationFor(settings: OffsiteBackupSettings): Destination {
  if (settings.destination === "webdav") return webdavDestination(settings.webdav);
  if (settings.destination === "s3") return s3Destination(settings.s3);
  if (settings.destination === "telegram") return telegramDestination();
  throw new Error("异地备份未开启");
}

// ==================== 对外操作 ====================

export async function testOffsiteBackupConnection(): Promise<string> {
  const { settings } = await readOffsiteBackupSettings();
  const destination = destinationFor(settings);
  try {
    return await destination.test();
  } catch (error) {
    throw new Error(describeError(error, destination.secrets));
  }
}

export async function listOffsiteBackups(): Promise<Array<RemoteBackupFile & { ours: boolean }>> {
  const { settings } = await readOffsiteBackupSettings();
  if (settings.destination === "off") return [];
  const destination = destinationFor(settings);
  try {
    const files = await destination.list();
    return files
      .filter((file) => parseOffsiteBackupName(file.name) !== null)
      .map((file) => ({ ...file, ours: true, modifiedAt: parseOffsiteBackupName(file.name) ?? file.modifiedAt }))
      .sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
  } catch (error) {
    throw new Error(describeError(error, destination.secrets));
  }
}

/** 下载一份远端备份的原文（加密的 JSON），交给 system.importPanelBackup 去解密、导入。 */
export async function downloadOffsiteBackup(name: string): Promise<string> {
  if (parseOffsiteBackupName(name) === null) throw new Error("只能恢复面板自己传上去的备份");
  const { settings } = await readOffsiteBackupSettings();
  const destination = destinationFor(settings);
  try {
    return await destination.download(name);
  } catch (error) {
    throw new Error(describeError(error, destination.secrets));
  }
}

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 做一次备份：导出 → 加密 → 上传 → 按保留份数清理旧的。
 *
 * 同一时刻只跑一份（定时与「立即备份」撞上时后来的等前一个跑完）。成功、失败都记一条
 * ops.backup 事件；失败那条是 warn，写明原因。
 */
export async function runOffsiteBackup(trigger: "schedule" | "manual") {
  return withKeyedTaskLock("ops-offsite-backup", async () => {
    const startedAt = Date.now();
    const { settings } = await readOffsiteBackupSettings();
    let destination: Destination | null = null;
    try {
      if (settings.destination === "off") throw new Error("异地备份未开启");
      if (settings.passphrase.length < 8) throw new Error("还没有设置备份口令（至少 8 位）");
      destination = destinationFor(settings);
      const all = await db.getAllSettings();
      const snapshot = await exportMigrationSnapshot(String(all.panelPublicUrl || "") || undefined);
      const encrypted = encryptMigrationSnapshot(pruneMigrationSnapshotForPanelBackup(snapshot), settings.passphrase);
      const body = Buffer.from(JSON.stringify(encrypted), "utf8");
      const name = offsiteBackupName(startedAt);
      await destination.upload(name, body);

      // 清理旧备份失败不算备份失败：新的已经传上去了，只记一句。
      let deleted = 0;
      let cleanupWarning = "";
      try {
        const stale = selectBackupsToDelete(await destination.list(), settings.keep);
        for (const file of stale) {
          await destination.remove(file.name);
          deleted += 1;
        }
      } catch (error) {
        cleanupWarning = `清理旧备份失败：${describeError(error, destination.secrets)}`;
      }

      const message = `异地备份完成：${name}（${formatSize(body.length)}，${destination.label}）${deleted > 0 ? `，删掉 ${deleted} 份旧的` : ""}${cleanupWarning ? `；${cleanupWarning}` : ""}`;
      await setSettings({
        [K.lastSuccessAt]: String(Date.now()),
        [K.lastAttemptAt]: String(Date.now()),
        [K.lastStatus]: "success",
        [K.lastMessage]: message,
        [K.lastName]: name,
        [K.lastSize]: String(body.length),
      });
      await recordPanelEvent({
        kind: "ops.backup",
        level: cleanupWarning ? "warn" : "info",
        message,
        data: { trigger, destination: settings.destination, name, size: body.length, deleted },
      });
      return { name, size: body.length, deleted, message };
    } catch (error) {
      const reason = describeError(error, destination?.secrets || []);
      const message = `异地备份失败：${reason}`;
      await setSettings({
        [K.lastAttemptAt]: String(Date.now()),
        [K.lastStatus]: "failed",
        [K.lastMessage]: message,
      }).catch(() => undefined);
      await recordPanelEvent({
        kind: "ops.backup",
        level: "warn",
        message,
        data: { trigger, destination: settings.destination },
      });
      throw new Error(message);
    }
  });
}
