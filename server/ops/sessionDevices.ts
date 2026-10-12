/*
  已登录设备（#13）：个人资料里列出本人所有还有效的登录，能逐个退出或一键退出其他设备。

  auth_sessions 原来只记 sid / 种类 / 时间，看不出是哪台设备。这里给它补上最近一次请求的
  User-Agent 和来源 IP：createContext 解析出会话后调 noteSessionClient —— 而不是只在登录时
  写一次 —— 这样密码、Telegram、通行密钥哪条路登录进来的都有，IP 也跟着人走（手机换网络）。
  内存里记着每个 sid 上次写的值，没变就不写，变了也最多 5 分钟写一次。
*/
import type { Request } from "express";
import { executeRaw, queryRaw, quoteDbIdentifier, rawEpochToDate } from "../dbRuntime";

const WRITE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TRACKED_SESSIONS = 20_000;
const written = new Map<string, { ua: string; ip: string; at: number }>();

function requestIp(req: Request) {
  return String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "").slice(0, 64);
}

function requestUserAgent(req: Request) {
  return String(req.headers?.["user-agent"] || "").slice(0, 512);
}

/** 记下这个会话最近的 UA / IP。异步、节流、失败只记日志。 */
export function noteSessionClient(sid: string, req: Request) {
  const ua = requestUserAgent(req);
  const ip = requestIp(req);
  const previous = written.get(sid);
  const now = Date.now();
  if (previous && previous.ua === ua && previous.ip === ip) return;
  if (previous && now - previous.at < WRITE_INTERVAL_MS) return;
  if (written.size >= MAX_TRACKED_SESSIONS) written.clear();
  written.set(sid, { ua, ip, at: now });
  const q = quoteDbIdentifier;
  void executeRaw(
    `UPDATE ${q("auth_sessions")} SET ${q("userAgent")} = ?, ${q("ip")} = ? WHERE ${q("sid")} = ?`,
    [ua || null, ip || null, sid],
  ).catch((error) => {
    written.delete(sid);
    console.warn(`[Sessions] note client failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * 从 User-Agent 读出「iPhone · Safari」「Windows · Chrome」这样一句。
 * kind 是会话种类：mobile 是 NEX App，telegram 是 Telegram 里打开的面板。
 */
export function describeSessionDevice(userAgent: string | null | undefined, kind?: string | null): string {
  if (kind === "mobile") return "NEX App";
  const ua = String(userAgent || "");
  if (kind === "telegram" || /Telegram/i.test(ua)) return "Telegram";
  if (!ua) return "未知设备";

  let os = "";
  if (/iPhone/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua)) os = "iPad";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "Mac";
  else if (/Linux/.test(ua)) os = "Linux";

  let browser = "";
  if (/MicroMessenger/i.test(ua)) browser = "微信";
  else if (/Edg(e|A|iOS)?\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = "Firefox";
  else if (/SamsungBrowser\//.test(ua)) browser = "Samsung";
  else if (/Chrome\/|CriOS\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";
  else if (/^curl\//i.test(ua)) browser = "curl";

  if (os && browser) return `${os} · ${browser}`;
  return os || browser || "未知设备";
}

export type UserSessionItem = {
  sid: string;
  kind: string;
  device: string;
  ip: string | null;
  createdAt: Date | null;
  lastSeenAt: Date | null;
  current: boolean;
};

/** 本人所有还有效的会话，当前这个排第一，其余按最近活动倒序。 */
export async function listActiveUserSessions(userId: number, currentSid: string | null): Promise<UserSessionItem[]> {
  const q = quoteDbIdentifier;
  const rows = await queryRaw(
    `SELECT ${q("sid")}, ${q("kind")}, ${q("userAgent")}, ${q("ip")}, ${q("createdAt")}, ${q("lastSeenAt")} FROM ${q("auth_sessions")}`
      + ` WHERE ${q("userId")} = ? AND ${q("revokedAt")} IS NULL AND ${q("expiresAt")} > ? ORDER BY ${q("lastSeenAt")} DESC LIMIT 100`,
    [userId, Math.floor(Date.now() / 1000)],
  );
  const items = rows.map((row) => ({
    sid: String(row.sid),
    kind: String(row.kind || "browser"),
    device: describeSessionDevice(row.userAgent, row.kind),
    ip: row.ip ? String(row.ip) : null,
    createdAt: rawEpochToDate(row.createdAt),
    lastSeenAt: rawEpochToDate(row.lastSeenAt),
    current: !!currentSid && String(row.sid) === currentSid,
  }));
  return items.sort((a, b) => Number(b.current) - Number(a.current));
}
