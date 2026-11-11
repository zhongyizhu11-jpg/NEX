import { hostPolicyBool } from "./hostTrafficPolicy";
import { isAgentVersionAtLeast } from "./version";

/*
  流量阈值关机（上游 2.3.287 的行为，NEX 自己实现，默认关、只有管理员能开）。

  主机本周期（上一次流量重置之后）的已用流量达到套餐流量的设定比例时，让 Agent 把**整台机器**关掉
  （shutdown -h now / poweroff），而不是只停转发 —— 给按流量超额收费、超了就天价的机器用。

  - 统计和主机卡片同一套口径（hostTrafficUsedBytes：系统网卡计数，按「流量计算」方式）。
  - 每个周期最多一次：面板用一条带条件的 UPDATE 认领（server/hostTrafficShutdown.ts），认领的同时
    记下这个周期的标记；Agent 那边执行前也落一个本地标记（agent/ext_traffic_shutdown.go）。
    两边都持久化，所以机器开回来、面板或 Agent 重启后都不会再关一次。流量重置（手动 / 每月）换了周期
    才会重新生效；关掉开关再打开保存，也算重新布防。
  - 关机不等故障转移、不等 DDNS 切换，开之前界面上会明确警告。
  - 只支持以 root 运行的 Linux Agent；Agent 从 HOST_TRAFFIC_SHUTDOWN_AGENT_VERSION 起才认这条指令。
*/

/** Agent 从这一版起认得 traffic_shutdown 扩展指令。比它旧的 Agent 不下发、界面提示先升级。 */
export const HOST_TRAFFIC_SHUTDOWN_AGENT_VERSION = "2.2.255";
export const HOST_TRAFFIC_SHUTDOWN_DEFAULT_PERCENT = 100;

export function normalizeTrafficShutdownPercent(value: unknown) {
  const percent = Number(value ?? HOST_TRAFFIC_SHUTDOWN_DEFAULT_PERCENT);
  return Number.isFinite(percent) ? Math.min(100, Math.max(1, Math.floor(percent))) : HOST_TRAFFIC_SHUTDOWN_DEFAULT_PERCENT;
}

export type HostTrafficShutdownConfig = {
  trafficShutdownEnabled?: unknown;
  trafficShutdownThresholdPercent?: unknown;
  trafficShutdownTriggeredAt?: unknown;
  trafficShutdownCycleMark?: unknown;
  trafficLimit?: unknown;
};

/** 周期标记：host_traffic_counters.resetAt（秒），从没重置过是 0。 */
export function normalizeTrafficCycleMark(value: unknown) {
  const mark = Math.floor(Number(value) || 0);
  return mark > 0 ? mark : 0;
}

/** 这个周期是不是已经授权关过机了。 */
export function trafficShutdownTriggeredThisCycle(host: HostTrafficShutdownConfig | null | undefined, cycleMark: unknown) {
  if (!host) return false;
  const triggeredAt = host.trafficShutdownTriggeredAt;
  if (triggeredAt === null || triggeredAt === undefined || triggeredAt === "" || triggeredAt === 0) return false;
  if (host.trafficShutdownCycleMark === null || host.trafficShutdownCycleMark === undefined) return false;
  return normalizeTrafficCycleMark(host.trafficShutdownCycleMark) === normalizeTrafficCycleMark(cycleMark);
}

export type TrafficShutdownBlockReason =
  | "disabled"
  | "no-limit"
  | "agent-too-old"
  | "agent-unsupported"
  | "already-triggered"
  | "below-threshold";

export type TrafficShutdownEvaluation =
  | { due: true; thresholdBytes: number }
  | { due: false; reason: TrafficShutdownBlockReason; thresholdBytes: number | null };

/**
 * 该不该向这台主机的 Agent 发关机指令。真正授权还要再过一次数据库里的条件 UPDATE
 * （拿最新的开关、额度、计数再判一遍），这里决定的只是「值不值得去认领」。
 *
 * agentSupported：Agent 这一轮自己报的「能不能关」（root + Linux）。没报过（undefined）按不支持算 ——
 * 宁可不关，也不能对着一台关不了的机器把这个周期的名额用掉。
 */
export function evaluateTrafficShutdown(input: {
  host: HostTrafficShutdownConfig;
  usedBytes: number;
  cycleMark: unknown;
  agentVersion: string | null | undefined;
  agentSupported: boolean | undefined;
}): TrafficShutdownEvaluation {
  const { host } = input;
  const limit = Math.max(0, Number(host.trafficLimit) || 0);
  if (!hostPolicyBool(host.trafficShutdownEnabled)) return { due: false, reason: "disabled", thresholdBytes: null };
  if (limit <= 0) return { due: false, reason: "no-limit", thresholdBytes: null };
  const thresholdBytes = limit * normalizeTrafficShutdownPercent(host.trafficShutdownThresholdPercent) / 100;
  if (!isAgentVersionAtLeast(input.agentVersion, HOST_TRAFFIC_SHUTDOWN_AGENT_VERSION)) return { due: false, reason: "agent-too-old", thresholdBytes };
  if (input.agentSupported !== true) return { due: false, reason: "agent-unsupported", thresholdBytes };
  if (trafficShutdownTriggeredThisCycle(host, input.cycleMark)) return { due: false, reason: "already-triggered", thresholdBytes };
  if (!(Math.max(0, Number(input.usedBytes) || 0) >= thresholdBytes)) return { due: false, reason: "below-threshold", thresholdBytes };
  return { due: true, thresholdBytes };
}

export const TRAFFIC_SHUTDOWN_REASON_LABELS: Record<TrafficShutdownBlockReason, string> = {
  disabled: "未开启",
  "no-limit": "没有设置套餐流量",
  "agent-too-old": `Agent 版本低于 ${HOST_TRAFFIC_SHUTDOWN_AGENT_VERSION}`,
  "agent-unsupported": "Agent 不是以 root 运行的 Linux，无法关机",
  "already-triggered": "本周期已触发",
  "below-threshold": "未到阈值",
};
