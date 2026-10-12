/*
  维护模式（#14）：管理员要动面板（升级、换库、整理数据）时，先把普通用户挡在外面。

  开着的时候：
  · 普通用户登录不进来（密码、Telegram、通行密钥三条路都在 createLoginAuthSession 汇合，挡在那儿）；
  · 已经登录的普通用户，调任何需要登录的接口都返回「面板维护中」—— auth.me、退出和公开接口
    不受影响，界面才能把横幅画出来；
  · 管理员一切照常；转发、Agent 上报、订阅全都不受影响（它们不走 tRPC 的登录接口）。

  开关存在设置表里（ops.maintenance.*），每个需要登录的请求都要看一眼：读的是 getAllSettings
  那份全面板共享的 5 秒缓存，自己再记 5 秒；本进程改了设置立刻更新。
*/
import { TRPCError } from "@trpc/server";
import { getAllSettings, setSettings } from "../repositories/settingsRepository";

export const MAINTENANCE_ENABLED_KEY = "ops.maintenance.enabled";
export const MAINTENANCE_MESSAGE_KEY = "ops.maintenance.message";
export const MAINTENANCE_BASE_MESSAGE = "面板维护中，请稍后再来";
export const MAINTENANCE_MESSAGE_MAX_LENGTH = 200;
const CACHE_TTL_MS = 5_000;

export type MaintenanceState = { enabled: boolean; message: string };

let cache: { state: MaintenanceState; loadedAt: number } | null = null;

export function normalizeMaintenanceMessage(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAINTENANCE_MESSAGE_MAX_LENGTH);
}

export async function getMaintenanceState(): Promise<MaintenanceState> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.state;
  try {
    // 走 getAllSettings 的共享缓存（5 秒）：面板里到处在读它，这里基本不会多打一次库。
    const all = await getAllSettings();
    const state = { enabled: all[MAINTENANCE_ENABLED_KEY] === "true", message: normalizeMaintenanceMessage(all[MAINTENANCE_MESSAGE_KEY]) };
    cache = { state, loadedAt: Date.now() };
    return state;
  } catch {
    // 库读不出来时不能把所有人挡在外面：按「没开」处理，沿用上一次的值优先。
    return cache?.state ?? { enabled: false, message: "" };
  }
}

export async function saveMaintenanceState(state: MaintenanceState) {
  const next = { enabled: !!state.enabled, message: normalizeMaintenanceMessage(state.message) };
  await setSettings({
    [MAINTENANCE_ENABLED_KEY]: next.enabled ? "true" : "false",
    [MAINTENANCE_MESSAGE_KEY]: next.message || null,
  });
  cache = { state: next, loadedAt: Date.now() };
  return next;
}

/** 给人看的那句：固定开头 + 管理员写的说明。 */
export function maintenanceErrorMessage(state: MaintenanceState) {
  return state.message ? `${MAINTENANCE_BASE_MESSAGE}：${state.message}` : MAINTENANCE_BASE_MESSAGE;
}

/** 这个用户现在会不会被维护模式挡住。纯函数，便于测试。 */
export function isBlockedByMaintenance(state: MaintenanceState, user: { role?: unknown } | null | undefined) {
  return state.enabled && !!user && user.role !== "admin";
}

/** 登录接口和需要登录的接口都调这一个：被挡就抛「面板维护中」。 */
export async function assertMaintenanceAllows(user: { role?: unknown } | null | undefined) {
  if (!user || user.role === "admin") return;
  const state = await getMaintenanceState();
  if (isBlockedByMaintenance(state, user)) {
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: maintenanceErrorMessage(state) });
  }
}
