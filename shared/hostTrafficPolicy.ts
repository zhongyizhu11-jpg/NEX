import { hostTrafficUsedBytes } from "./hostTrafficQuota";

/**
 * 主机「流量故障转移」（上游 v2.3.281）。
 *
 * 主机的套餐流量用到设定比例（默认 100%）后，暂停它参与转发组 / 入口组 / 出口组 /
 * 多出口隧道 —— 组里换别的成员顶上；流量重置（手动、按月自动）或者关掉这个开关后恢复。
 * 只改运行时：成员配置、端口、规则开关一样都不动，所以恢复时什么都不用重建。
 *
 * 已用量和主机卡片、主机监控是同一套口径（hostTrafficUsedBytes：系统网卡计数，按机房的
 * 计量方式算出向 / 双向 / 取大）。
 */
export type HostTrafficPolicy = {
  trafficLimit?: unknown;
  trafficMeasureMode?: unknown;
  trafficFailoverEnabled?: unknown;
  trafficFailoverThresholdPercent?: unknown;
  trafficFailoverExcluded?: unknown;
};

export const HOST_TRAFFIC_FAILOVER_DEFAULT_PERCENT = 100;

export function hostPolicyBool(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

export function normalizeHostTrafficFailoverPercent(value: unknown) {
  const percent = Number(value ?? HOST_TRAFFIC_FAILOVER_DEFAULT_PERCENT);
  return Number.isFinite(percent) ? Math.min(100, Math.max(1, Math.floor(percent))) : HOST_TRAFFIC_FAILOVER_DEFAULT_PERCENT;
}

/** 用到多少字节就要暂停。没开、没设套餐流量时返回 null。 */
export function hostTrafficFailoverThresholdBytes(host: HostTrafficPolicy | null | undefined) {
  const limit = Math.max(0, Number(host?.trafficLimit) || 0);
  if (!host || !hostPolicyBool(host.trafficFailoverEnabled) || limit <= 0) return null;
  return limit * normalizeHostTrafficFailoverPercent(host.trafficFailoverThresholdPercent) / 100;
}

/** 按当前计数这台主机该不该被暂停（服务端在 UPDATE 里用同一个算式再判一次，见 server/hostTrafficPolicy.ts）。 */
export function shouldExcludeHostForTraffic(host: HostTrafficPolicy, traffic: { bytesIn?: unknown; bytesOut?: unknown } | null | undefined) {
  const threshold = hostTrafficFailoverThresholdBytes(host);
  return threshold !== null && hostTrafficUsedBytes(traffic, host.trafficMeasureMode) >= threshold;
}

/**
 * 这台主机现在是不是被暂停着。开关和套餐流量仍然说了算：刚关掉开关、还没来得及重算
 * 存着的 trafficFailoverExcluded 时，不能还把它当成暂停。
 */
export function hostTrafficExcluded(host: HostTrafficPolicy | null | undefined) {
  return !!host && hostPolicyBool(host.trafficFailoverEnabled) && Number(host.trafficLimit) > 0
    && hostPolicyBool(host.trafficFailoverExcluded);
}

export const HOST_TRAFFIC_FAILOVER_EXCLUDED_MESSAGE = "主机流量达到故障转移阈值，已暂停组调度";
