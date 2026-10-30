/*
  故障看板（监控 › 故障）前后端共用的汇总：把一段时间里的事件（server/ops/panelEvents.ts）数成
  「告警多少条、分哪几类、多少自动恢复了、平均多久恢复」，再把它们导出成 CSV / JSON 交给技术支持或 AI 分析。

  纯函数：事件由调用方查好传进来。
*/

export type FaultEventInput = {
  id: number;
  kind: string;
  level: "info" | "warn" | "crit";
  message: string;
  hostId: number | null;
  hostName?: string | null;
  ruleId?: number | null;
  data?: Record<string, unknown> | null;
  createdAt: Date | string | number;
};

export type FaultCategoryKey = "offline" | "resource" | "oom" | "crash" | "loss" | "rule" | "route" | "security" | "other";

export const FAULT_CATEGORIES: ReadonlyArray<{ key: FaultCategoryKey; label: string }> = [
  { key: "offline", label: "主机断线" },
  { key: "resource", label: "资源超限" },
  { key: "oom", label: "内存耗尽" },
  { key: "crash", label: "进程崩溃" },
  { key: "loss", label: "隧道丢包" },
  { key: "rule", label: "规则出错" },
  { key: "route", label: "线路切换 / 异常" },
  { key: "security", label: "安全巡检" },
  { key: "other", label: "其它" },
];

/** 事件 kind → 故障类别；不算故障的（登录、工单、恢复本身……）返回 null。 */
export function faultCategoryOf(kind: string, level: string): FaultCategoryKey | null {
  switch (kind) {
    case "host.offline":
      return "offline";
    case "host.resource_high":
      return "resource";
    case "host.oom_killed":
      return "oom";
    case "host.process_crashed":
      return "crash";
    case "host.packet_loss":
      return "loss";
    case "rule.error":
      return "rule";
    case "route.switched":
    case "route.group_switched":
    case "route.precheck_failed":
    // 线路组里某条路径探测不通（Agent 报的 unhealthy）：没切线也是一次线路告警。
    case "route.unhealthy":
      return "route";
    case "security.finding":
      return "security";
    default:
      break;
  }
  if (level !== "warn" && level !== "crit") return null;
  if (kind.startsWith("account.") || kind.startsWith("ticket.") || kind.startsWith("user.")) return null;
  return "other";
}

/** 恢复类事件：哪个 kind，持续时长从 data 的哪个字段取。 */
const RECOVERY_KINDS: Record<string, string> = {
  "host.online": "outageSeconds",
  "rule.recovered": "",
  "host.resource_recovered": "durationSeconds",
  "host.packet_loss_recovered": "durationSeconds",
  // 线路组路径恢复：durationSeconds 是这条路径异常了多久（面板重启后配不上的不带）。
  "route.recovered": "durationSeconds",
};

export function isRecoveryEvent(event: Pick<FaultEventInput, "kind" | "data">) {
  if (!(event.kind in RECOVERY_KINDS)) return false;
  // host.online 只有配上了之前的断线（带 outageSeconds）才算「恢复」，首次上线不算。
  if (event.kind === "host.online") return Number(event.data?.outageSeconds) >= 0 && event.data?.outageSeconds !== undefined;
  return true;
}

export function recoveryDurationSeconds(event: Pick<FaultEventInput, "kind" | "data">): number | null {
  const field = RECOVERY_KINDS[event.kind];
  if (!field) return null;
  const value = Number(event.data?.[field]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export type FaultSummary = {
  alerts: number;
  critical: number;
  byCategory: Array<{ key: FaultCategoryKey; label: string; count: number }>;
  recovered: number;
  avgRecoverySeconds: number | null;
  /** 告警最多的几台主机。 */
  topHosts: Array<{ hostId: number; hostName: string | null; count: number }>;
  /** 按小时的告警数（最早一小时在前），画小柱状图用。 */
  hourly: number[];
};

function toMs(value: Date | string | number) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function summarizeFaultEvents(events: readonly FaultEventInput[], options: { nowMs: number; hours: number }): FaultSummary {
  const hours = Math.max(1, Math.floor(options.hours));
  const startMs = options.nowMs - hours * 3_600_000;
  const counts = new Map<FaultCategoryKey, number>();
  const hostCounts = new Map<number, { hostName: string | null; count: number }>();
  const hourly = new Array<number>(hours).fill(0);
  let alerts = 0;
  let critical = 0;
  let recovered = 0;
  let recoverySum = 0;
  let recoveryTimed = 0;
  for (const event of events) {
    const at = toMs(event.createdAt);
    if (at < startMs || at > options.nowMs) continue;
    if (isRecoveryEvent(event)) {
      recovered += 1;
      const duration = recoveryDurationSeconds(event);
      if (duration !== null) {
        recoverySum += duration;
        recoveryTimed += 1;
      }
      continue;
    }
    const category = faultCategoryOf(event.kind, event.level);
    if (!category) continue;
    alerts += 1;
    if (event.level === "crit") critical += 1;
    counts.set(category, (counts.get(category) || 0) + 1);
    const bucket = Math.min(hours - 1, Math.max(0, Math.floor((at - startMs) / 3_600_000)));
    hourly[bucket] += 1;
    if (event.hostId) {
      const current = hostCounts.get(event.hostId) || { hostName: event.hostName ?? null, count: 0 };
      current.count += 1;
      if (!current.hostName && event.hostName) current.hostName = event.hostName;
      hostCounts.set(event.hostId, current);
    }
  }
  return {
    alerts,
    critical,
    byCategory: FAULT_CATEGORIES.map((category) => ({ ...category, count: counts.get(category.key) || 0 })).filter((item) => item.count > 0),
    recovered,
    avgRecoverySeconds: recoveryTimed > 0 ? Math.round(recoverySum / recoveryTimed) : null,
    topHosts: [...hostCounts.entries()]
      .map(([hostId, value]) => ({ hostId, hostName: value.hostName, count: value.count }))
      .sort((a, b) => b.count - a.count || a.hostId - b.hostId)
      .slice(0, 5),
    hourly,
  };
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  // 防公式注入：以 = + - @ 开头的格子前面加一个单引号（Excel / WPS 打开不会当公式执行）。
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** 导出成 CSV（带 BOM，Excel 直接打开不乱码）。 */
export function faultEventsToCsv(events: readonly FaultEventInput[]): string {
  const header = ["time", "level", "kind", "category", "hostId", "hostName", "ruleId", "message"];
  const rows = events.map((event) => [
    new Date(toMs(event.createdAt)).toISOString(),
    event.level,
    event.kind,
    isRecoveryEvent(event) ? "recovered" : faultCategoryOf(event.kind, event.level) || "",
    event.hostId ?? "",
    event.hostName ?? "",
    event.ruleId ?? "",
    event.message,
  ].map(csvCell).join(","));
  return `﻿${header.join(",")}\n${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`;
}
