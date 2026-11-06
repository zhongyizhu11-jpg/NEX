/*
  新设备 / 异地登录提醒（第 1 批第 4 项）。

  每次登录成功（密码、Telegram、通行密钥、Google、Discord 都汇到 auth.issueLoginSession）记一笔
  「设备 + 网段」。没见过的组合就提醒本人（邮件 + Telegram），管理员账号再记一条事件进时间线：
    - 设备认识、网段没见过 → 「在新的网络 / 地区登录」（国家也变了就写「异地登录」）；
    - 设备没见过           → 「在新设备上登录」。
  一个人的第一条记录不提醒：那是升级后第一次登录，或者刚注册，不是「新」。

  提醒是尽力而为：查库、查 IP 归属、发通知任何一步失败都不影响登录本身。
  同一个人一天最多提醒 MAX_ALERTS_PER_DAY 次 —— 被人拿着密码一直试新 IP 时，别把邮箱刷爆。
  关掉：系统设置 loginNewDeviceNotify = "false"。
*/
import type { Request } from "express";
import { executeRaw, queryRaw, quoteDbIdentifier } from "../dbRuntime";
import { clientIp } from "../clientIp";
import * as db from "../db";
import { lookupAddressGeo } from "../hostGeo";
import { notifyUserDirect } from "../userNotify";
import { recordNewDeviceLoginEvent } from "./eventHooks";
import { describeSessionDevice } from "./sessionDevices";

export const LOGIN_NEW_DEVICE_NOTIFY_SETTING = "loginNewDeviceNotify";
const MAX_ALERTS_PER_DAY = 5;
const GEO_TIMEOUT_MS = 3_000;
const alertsToday = new Map<string, number>();

/** IPv4 取 /24、IPv6 取 /48；认不出来的原样（截断）。 */
export function loginIpPrefix(ip: string): string {
  const value = String(ip || "").trim().replace(/^::ffff:/i, "");
  if (!value) return "unknown";
  const v4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (value.includes(":")) {
    const head = value.split("%")[0];
    const parts = head.split("::")[0].split(":").filter(Boolean);
    // 前三段不全（地址里很早就出现 ::）时补 0
    while (parts.length < 3) parts.push("0");
    return `${parts.slice(0, 3).map((part) => part.toLowerCase()).join(":")}::/48`;
  }
  return value.slice(0, 60);
}

export type LoginDeviceDecision =
  | { kind: "known" }
  | { kind: "first" }
  | { kind: "new-device"; device: string; ip: string }
  | { kind: "new-network"; device: string; ip: string };

type KnownRow = { deviceKey: string; device: string; ipPrefix: string; countryCode: string | null };

/** 纯判断（测试用）：这次登录和已有记录比，算哪一种。 */
export function classifyLogin(known: KnownRow[], device: string, ipPrefix: string, ip: string): LoginDeviceDecision {
  const key = `${device}|${ipPrefix}`;
  if (known.some((row) => row.deviceKey === key)) return { kind: "known" };
  if (known.length === 0) return { kind: "first" };
  if (known.some((row) => row.device === device)) return { kind: "new-network", device, ip };
  return { kind: "new-device", device, ip };
}

function dayKey(now = new Date()) {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function takeAlertBudget(userId: number): boolean {
  const key = `${userId}:${dayKey()}`;
  const used = alertsToday.get(key) || 0;
  if (used >= MAX_ALERTS_PER_DAY) return false;
  if (alertsToday.size > 5_000) alertsToday.clear();
  alertsToday.set(key, used + 1);
  return true;
}

async function geoOf(ip: string): Promise<{ countryCode: string | null; label: string }> {
  try {
    const result = await Promise.race([
      lookupAddressGeo(ip),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), GEO_TIMEOUT_MS)),
    ]);
    if (!result) return { countryCode: null, label: "" };
    const label = [result.geoCountryName || result.geoCountryCode, result.geoRegion].filter(Boolean).join(" · ");
    return { countryCode: result.geoCountryCode || null, label };
  } catch {
    return { countryCode: null, label: "" };
  }
}

/**
 * 登录成功后调一次。不 await 也行（内部吞掉所有错误）；返回判断结果给测试看。
 */
export async function noteLoginDevice(user: any, req: Request, sessionKind: string, now = Date.now()): Promise<LoginDeviceDecision | null> {
  try {
    const userId = Number(user?.id || 0);
    if (!userId) return null;
    const ua = String(req.headers?.["user-agent"] || "");
    const device = describeSessionDevice(ua, sessionKind).slice(0, 64);
    const ip = clientIp(req).slice(0, 64);
    const ipPrefix = loginIpPrefix(ip);
    const deviceKey = `${device}|${ipPrefix}`.slice(0, 160);
    const q = quoteDbIdentifier;
    const nowSec = Math.floor(now / 1000);

    const known = await queryRaw(
      `SELECT ${q("deviceKey")}, ${q("device")}, ${q("ipPrefix")}, ${q("countryCode")} FROM ${q("user_login_devices")} WHERE ${q("userId")} = ? ORDER BY ${q("lastSeenAt")} DESC LIMIT 200`,
      [userId],
    ) as KnownRow[];
    const decision = classifyLogin(known.map((row) => ({ ...row, deviceKey: String(row.deviceKey), device: String(row.device) })), device, ipPrefix, ip);

    if (decision.kind === "known") {
      await executeRaw(
        `UPDATE ${q("user_login_devices")} SET ${q("lastSeenAt")} = ?, ${q("lastIp")} = ?, ${q("loginCount")} = ${q("loginCount")} + 1 WHERE ${q("userId")} = ? AND ${q("deviceKey")} = ?`,
        [nowSec, ip || null, userId, deviceKey],
      );
      return decision;
    }

    const geo = decision.kind === "first" ? { countryCode: null, label: "" } : await geoOf(ip);
    try {
      await executeRaw(
        `INSERT INTO ${q("user_login_devices")} (${q("userId")}, ${q("deviceKey")}, ${q("device")}, ${q("ipPrefix")}, ${q("lastIp")}, ${q("countryCode")}, ${q("loginCount")}, ${q("firstSeenAt")}, ${q("lastSeenAt")}) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [userId, deviceKey, device, ipPrefix, ip || null, geo.countryCode, nowSec, nowSec],
      );
    } catch {
      // 同一时刻两次登录撞了唯一键：另一次已经记下（也已经提醒过），这次当认识的处理
      return { kind: "known" };
    }
    if (decision.kind === "first") return decision;

    if ((await db.getSetting(LOGIN_NEW_DEVICE_NOTIFY_SETTING)) === "false") return decision;
    if (!takeAlertBudget(userId)) return decision;

    const otherCountry = !!geo.countryCode && known.length > 0
      && known.every((row) => row.countryCode && row.countryCode !== geo.countryCode);
    const what = decision.kind === "new-device"
      ? "在新设备上登录"
      : otherCountry ? "异地登录" : "在新的网络登录";
    const when = new Date(now).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
    const where = [ip || "未知 IP", geo.label].filter(Boolean).join("（") + (geo.label ? "）" : "");
    const name = String(user.username || user.name || `#${userId}`);
    const title = `你的账号${what}`;
    const body = [
      `${title}：${name}`,
      `设备：${device}`,
      `位置：${where}`,
      `时间：${when}`,
      "",
      "如果不是你本人，请立即修改密码，并在「个人资料 › 已登录设备」里退出这台设备。",
    ].join("\n");
    void notifyUserDirect(user, title, body, "login-device");
    recordNewDeviceLoginEvent(user, { what, device, ip, location: geo.label });
    return decision;
  } catch (error) {
    console.warn("[LoginDevices] note failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** 测试用。 */
export function resetLoginDeviceMemory() {
  alertsToday.clear();
}
