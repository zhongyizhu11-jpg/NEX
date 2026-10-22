/**
 * 设备数限制：一条订阅地址最多被几台设备用。
 *
 * 做法照 Remnawave：客户端拉订阅时带 `x-hwid`（Happ、v2RayTun 和一批社区分支会发），
 * 面板按 (令牌, hwid) 登记设备，超过上限就拒绝，并用 `x-hwid-*` 响应头告诉客户端
 * 是为什么。不发 hwid 的客户端（绝大多数）走两条路：
 *
 *   - 严格模式：拒绝。只有明确知道客户群全用 Happ 之类的商家才开。
 *   - 退化模式（默认）：按来源 IP 当设备，窗口内（默认 24 小时）没再来的 IP 不算。
 *     一台手机换个网络就是「新设备」，所以这个口径只适合卡「发给一群人」，不适合
 *     卡「同一个人的几台设备」—— 界面上要说清楚。
 *
 * 这里只做纯判断，设备记录的增删由服务端做。
 */

export type ProxySubDeviceRecord = {
  /** 真 hwid，或退化模式下的 `ip:<地址>`。 */
  hwid: string;
  lastSeenAt: number;
};

export type ProxySubDeviceDecision = {
  allowed: boolean;
  /** 拒绝原因：device-limit（满了）/ hwid-required（严格模式没带 hwid）。 */
  reason?: "device-limit" | "hwid-required";
  /** 要登记 / 刷新的设备键；空表示这次不登记（没开限制或没有可登记的标识）。 */
  deviceKey: string;
  /** 这次是不是第一次见到这台设备。 */
  isNew: boolean;
  /** 现在算几台（含这一台）。 */
  count: number;
  /** 给客户端的提示头。 */
  headers: Record<string, string>;
};

export type ProxySubDeviceLimitInput = {
  enabled: boolean;
  strict: boolean;
  /** 0 = 不限。 */
  limit: number;
  hwid: string;
  ip: string;
  now: number;
  ipWindowMs: number;
  devices: readonly ProxySubDeviceRecord[];
};

/** hwid 只认 10–64 位的字母数字和 = -（Remnawave v3 的口径），别的一律当没发。 */
export function normalizeProxySubHwid(value: unknown): string {
  const raw = String(value ?? "").trim();
  return /^[A-Za-z0-9=-]{10,64}$/.test(raw) ? raw : "";
}

export function ipDeviceKey(ip: string): string {
  const clean = String(ip || "").trim();
  return clean ? `ip:${clean}` : "";
}

export function evaluateProxySubDeviceAccess(input: ProxySubDeviceLimitInput): ProxySubDeviceDecision {
  const headers: Record<string, string> = {};
  if (!input.enabled) {
    // 没开限制也登记真 hwid：商家想看「这条地址在几台设备上」不必先开限制。
    const key = normalizeProxySubHwid(input.hwid);
    const known = key ? input.devices.some((device) => device.hwid === key) : false;
    return { allowed: true, deviceKey: key, isNew: !!key && !known, count: input.devices.length + (key && !known ? 1 : 0), headers };
  }
  headers["x-hwid-active"] = "true";
  const hwid = normalizeProxySubHwid(input.hwid);
  let key = hwid;
  if (!hwid) {
    headers["x-hwid-not-supported"] = "true";
    if (input.strict) return { allowed: false, reason: "hwid-required", deviceKey: "", isNew: false, count: input.devices.length, headers };
    key = ipDeviceKey(input.ip);
  }
  if (!key) return { allowed: true, deviceKey: "", isNew: false, count: input.devices.length, headers };

  // 退化模式下过期的 IP 设备不算数；真 hwid 不按时间淘汰（设备换了网络照样是那台）。
  const active = input.devices.filter((device) => !device.hwid.startsWith("ip:") || input.now - device.lastSeenAt <= input.ipWindowMs);
  const known = active.some((device) => device.hwid === key);
  const count = active.length + (known ? 0 : 1);
  if (!known && input.limit > 0 && active.length >= input.limit) {
    headers["x-hwid-max-devices-reached"] = "true";
    headers["x-hwid-limit"] = "true";
    return { allowed: false, reason: "device-limit", deviceKey: key, isNew: true, count: active.length, headers };
  }
  return { allowed: true, deviceKey: key, isNew: !known, count, headers };
}

/** 令牌 / 用户 / 全局三层上限取最严的那个（0 = 没设）。 */
export function effectiveDeviceLimit(...limits: unknown[]): number {
  let result = 0;
  for (const value of limits) {
    const n = Math.floor(Number(value) || 0);
    if (n <= 0) continue;
    result = result === 0 ? n : Math.min(result, n);
  }
  return result;
}
