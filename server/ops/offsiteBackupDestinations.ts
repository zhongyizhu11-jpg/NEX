/*
  异地备份的三种目的地：WebDAV、S3 兼容存储、Telegram。各自只管「传上去 / 列出来 / 取回来 / 删掉 /
  测一下」，什么时候备份、备份什么、记不记事件都在 offsiteBackup.ts。

  - WebDAV / S3 只允许 HTTPS，并且过 SSRF 检查（不让面板去请求内网地址），不跟随重定向。
    WebDAV 用的是 Basic 认证，走明文 HTTP 等于把密码交出去。
  - 发请求的那一层（transport）可以在测试里换掉：单测起一个本机的 HTTP 服务器冒充 S3 / WebDAV，
    本机地址和明文 HTTP 正是上面两条规矩要拦的，所以只在测试里绕开，别的代码不许调那个开关。
*/
import * as db from "../db";
import { ENV } from "../env";
import { getSettingsByPrefix, setSettings } from "../repositories/settingsRepository";
import { assertSafeOutboundUrl } from "../ssrf";
import { sendTelegramMessage } from "../telegramBot";
import type { RemoteBackupFile } from "./offsiteBackupLogic";
import { buildSignedS3Request, normalizeS3Prefix, parseListObjectsV2, parseS3Error, type S3Config } from "./offsiteBackupS3";
import { basicAuthHeader, parseWebdavPropfind, WEBDAV_PROPFIND_BODY, webdavFileUrl, webdavFolderUrl } from "./offsiteBackupWebdav";

export const OFFSITE_BACKUP_TARGETS = ["webdav", "s3", "telegram"] as const;
export type OffsiteBackupTarget = (typeof OFFSITE_BACKUP_TARGETS)[number];
export const OFFSITE_BACKUP_TARGET_LABELS: Record<OffsiteBackupTarget, string> = { webdav: "WebDAV", s3: "S3", telegram: "Telegram" };

export type WebdavConfig = { url: string; user: string; password: string };

/** Telegram 没有「列目录」，发出去的备份自己记一份（文件 id、消息 id），存在设置里。 */
const TELEGRAM_FILES_KEY = "ops.backup.telegram.files";

/** 下载回来的备份最大多大（与手动导入的上限一致）。 */
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
/** Telegram Bot API 只能下载 20 MB 以内的文件。 */
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
/** 「测试连接」试写的那个小文件。名字不符合备份文件的格式，所以列表、保留份数都不会把它当备份。 */
const CONNECTION_TEST_NAME = "nex-backup-connection-test.txt";

// ==================== 网络 ====================

type ErrorWithCause = Error & { cause?: { code?: unknown } };

export function describeBackupError(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "TimeoutError") message = "请求超时";
  const causeCode = error instanceof Error ? (error as ErrorWithCause).cause?.code : undefined;
  if (causeCode) message = `${message}（${String(causeCode)}）`;
  for (const secret of secrets) if (secret) message = message.split(secret).join("***");
  return message.slice(0, 300);
}

export type BackupTransport = (url: string, init: RequestInit & { timeoutMs?: number }, purpose: string) => Promise<Response>;

/** 对外请求：只许 HTTPS、过 SSRF 检查、不跟随重定向（防止被 30x 带去内网）、带超时。 */
const safeTransport: BackupTransport = async (url, init, purpose) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`${purpose} 只支持 HTTPS 地址`);
  await assertSafeOutboundUrl(url, { purpose });
  const { timeoutMs, ...rest } = init;
  const response = await fetch(url, { ...rest, redirect: "manual", signal: AbortSignal.timeout(timeoutMs ?? REQUEST_TIMEOUT_MS) });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${purpose} 返回了重定向（${response.status}），为安全起见不跟随，请直接填最终地址`);
  }
  return response;
};

let transportOverride: BackupTransport | null = null;

/** 测试用：换掉发请求的那一层（冒充 S3 / WebDAV 的本机服务器只有明文 HTTP）。传 null 恢复。 */
export function setOffsiteBackupTransportForTests(transport: BackupTransport | null) {
  transportOverride = transport;
}

const send: BackupTransport = (url, init, purpose) => (transportOverride ?? safeTransport)(url, init, purpose);

async function readLimitedText(response: Response, limit = MAX_BACKUP_BYTES): Promise<string> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new Error(`备份文件过大（${Math.round(declared / 1024 / 1024)} MB）`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) throw new Error(`备份文件过大（${Math.round(buffer.length / 1024 / 1024)} MB）`);
  return buffer.toString("utf8");
}

function httpError(purpose: string, status: number, detail = "") {
  const hint = status === 401 || status === 403 ? "：账号、密码或权限不对" : status === 404 ? "：路径不存在" : status === 507 ? "：空间不足" : "";
  return new Error(`${purpose}失败，HTTP ${status}${hint}${detail ? `（${detail.slice(0, 160)}）` : ""}`);
}

export type BackupDestination = {
  label: string;
  upload(name: string, body: Buffer): Promise<void>;
  list(): Promise<RemoteBackupFile[]>;
  download(name: string): Promise<string>;
  remove(name: string): Promise<void>;
  test(): Promise<string>;
  /** 报错信息里要抹掉的东西（密码、Secret Key、机器人 Token）。 */
  secrets: string[];
};

// ==================== WebDAV ====================

export function webdavDestination(config: WebdavConfig): BackupDestination {
  if (!config.url) throw new Error("请填写 WebDAV 地址");
  const folder = webdavFolderUrl(config.url);
  const auth = basicAuthHeader(config.user, config.password);
  const purpose = "WebDAV";
  const list = async () => {
    const response = await send(folder, {
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
    const response = await send(webdavFileUrl(folder, name), {
      method: "PUT",
      headers: { authorization: auth, "content-type": "application/octet-stream" },
      body: new Uint8Array(body),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }, purpose);
    if (![200, 201, 204].includes(response.status)) throw httpError("WebDAV 上传", response.status);
  };
  const remove = async (name: string) => {
    const response = await send(webdavFileUrl(folder, name), { method: "DELETE", headers: { authorization: auth } }, purpose);
    if (![200, 202, 204, 404].includes(response.status)) throw httpError("WebDAV 删除", response.status);
  };
  return {
    label: OFFSITE_BACKUP_TARGET_LABELS.webdav,
    secrets: [config.password],
    list,
    upload,
    remove,
    async download(name) {
      const response = await send(webdavFileUrl(folder, name), { method: "GET", headers: { authorization: auth }, timeoutMs: UPLOAD_TIMEOUT_MS }, purpose);
      if (response.status !== 200) throw httpError("WebDAV 下载", response.status);
      return readLimitedText(response);
    },
    async test() {
      let created = false;
      const probe = await send(folder, {
        method: "PROPFIND",
        headers: { authorization: auth, depth: "0", "content-type": "application/xml; charset=utf-8" },
        body: WEBDAV_PROPFIND_BODY,
      }, purpose);
      if (probe.status === 404) {
        const mk = await send(folder, { method: "MKCOL", headers: { authorization: auth } }, purpose);
        if (![200, 201].includes(mk.status)) throw httpError("WebDAV 建目录", mk.status);
        created = true;
      } else if (probe.status !== 207 && probe.status !== 200) {
        throw httpError("WebDAV 连接", probe.status);
      }
      // 试写一个小文件再删掉：只读账号能列目录，却存不了备份。
      await upload(CONNECTION_TEST_NAME, Buffer.from("NEX offsite backup connection test\n"));
      await remove(CONNECTION_TEST_NAME);
      return created ? "连接正常，目录不存在，已新建" : "连接正常，可以写入";
    },
  };
}

// ==================== S3 ====================

export function s3Destination(config: S3Config): BackupDestination {
  if (!config.endpoint || !config.bucket) throw new Error("请填写 S3 地址和存储桶");
  if (!config.accessKeyId || !config.secretAccessKey) throw new Error("请填写 Access Key 和 Secret Key");
  const prefix = normalizeS3Prefix(config.prefix);
  const purpose = "S3";
  const call = async (request: Parameters<typeof buildSignedS3Request>[1], timeoutMs = REQUEST_TIMEOUT_MS) => {
    const signed = buildSignedS3Request(config, request);
    return send(signed.url, {
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
      const response = await call({ method: "GET", key: "", query });
      if (response.status !== 200) throw await failure("列目录", response);
      const parsed = parseListObjectsV2(await response.text());
      for (const object of parsed.objects) {
        // 只看前缀这一层：桶里更深的目录、前缀对不上的对象都不是我们的。
        if (!object.key.startsWith(prefix)) continue;
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
    const response = await call({ method: "PUT", key: `${prefix}${name}`, body, contentType: "application/octet-stream" }, UPLOAD_TIMEOUT_MS);
    if (response.status !== 200) throw await failure("上传", response);
  };
  const remove = async (name: string) => {
    const response = await call({ method: "DELETE", key: `${prefix}${name}` });
    if (![200, 204, 404].includes(response.status)) throw await failure("删除", response);
  };
  return {
    label: OFFSITE_BACKUP_TARGET_LABELS.s3,
    secrets: [config.secretAccessKey],
    list,
    upload,
    remove,
    async download(name) {
      const response = await call({ method: "GET", key: `${prefix}${name}` }, UPLOAD_TIMEOUT_MS);
      if (response.status !== 200) throw await failure("下载", response);
      return readLimitedText(response);
    },
    async test() {
      await list();
      await upload(CONNECTION_TEST_NAME, Buffer.from("NEX offsite backup connection test\n"));
      await remove(CONNECTION_TEST_NAME);
      return "连接正常，可以写入";
    },
  };
}

// ==================== Telegram ====================

type TelegramBackupRecord = {
  name: string;
  size: number;
  at: number;
  fileId: string;
  messages: Array<{ chatId: string; messageId: number }>;
};

type TelegramDocumentResult = { message_id?: number; document?: { file_id?: string } };
type TelegramFileResult = { file_path?: string };

async function telegramToken(): Promise<string> {
  const settings = await db.getAllSettings();
  return ENV.telegramBotToken.trim() || String(settings.telegramBotToken || "").trim();
}

async function readTelegramRecords(): Promise<TelegramBackupRecord[]> {
  const raw = (await getSettingsByPrefix(TELEGRAM_FILES_KEY))[TELEGRAM_FILES_KEY];
  try {
    const parsed: unknown = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is TelegramBackupRecord => !!item && typeof item.name === "string") : [];
  } catch {
    return [];
  }
}

async function writeTelegramRecords(records: TelegramBackupRecord[]) {
  await setSettings({ [TELEGRAM_FILES_KEY]: JSON.stringify(records.slice(0, 200)) });
}

async function telegramCall<T>(token: string, method: string, body: Record<string, unknown> | FormData, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "content-type": "application/json" },
    body: isForm ? (body as FormData) : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => null) as { ok?: boolean; description?: string; result?: T } | null;
  if (!response.ok || !json?.ok) {
    throw new Error(`Telegram ${method} 失败：${String(json?.description || `HTTP ${response.status}`).slice(0, 200)}`);
  }
  return json.result as T;
}

export function telegramDestination(): BackupDestination {
  const secrets: string[] = [];
  const context = async () => {
    const token = await telegramToken();
    if (!token) throw new Error("还没有配置 Telegram 机器人（设置 › Telegram）");
    secrets.push(token);
    const recipients = ((await db.getTelegramAdminRecipients()) as Array<{ telegramId?: unknown }>)
      .map((user) => String(user.telegramId || "").trim())
      .filter(Boolean);
    if (recipients.length === 0) throw new Error("没有绑定了 Telegram 的管理员，备份无处可发");
    return { token, recipients };
  };
  return {
    label: OFFSITE_BACKUP_TARGET_LABELS.telegram,
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
        const result = await telegramCall<TelegramDocumentResult>(token, "sendDocument", form, UPLOAD_TIMEOUT_MS);
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
      const file = await telegramCall<TelegramFileResult>(token, "getFile", { file_id: record.fileId });
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
