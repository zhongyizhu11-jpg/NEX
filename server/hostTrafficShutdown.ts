import { executeRaw, queryRaw, rawAffectedRows } from "./dbRuntime";
import { boolLiteral, quoteIdentifier as q } from "./dbCompat";
import { appendPanelLog } from "./_core/panelLogger";
import { hostTrafficUsedBytes } from "../shared/hostTrafficQuota";
import {
  evaluateTrafficShutdown,
  normalizeTrafficCycleMark,
  normalizeTrafficShutdownPercent,
  type TrafficShutdownEvaluation,
} from "../shared/hostTrafficShutdown";

/*
  流量阈值关机的面板那一半（规则见 shared/hostTrafficShutdown.ts，Agent 那一半见 agent/ext_traffic_shutdown.go）。

  走 Agent 扩展通道（server/ops/trafficShutdownAgent.ts），不改心跳：
  1. Agent 每轮报「我能不能关机」（root + Linux）和本地记着的上一次关机周期；
  2. 面板看开关、额度、本周期用量，到了阈值就用一条带条件的 UPDATE 认领 —— 条件里再按库里最新的开关、
     额度、比例、计数判一遍，并要求计数是最近 10 分钟内上报过的：过时的判断、刚关掉的开关、刚重置的流量都
     认领不到。认领成功的同时记下周期标记（host_traffic_counters.resetAt），同一周期不会再认领第二次；
  3. 认领成功先发通知（管理员 Telegram / Discord / 邮件 + 事件时间线），再把关机指令放进这一轮回包。

  回包丢了、关机命令失败，这个周期都不会再授权 —— 宁可少关一次，也不能让机器一开机就又被关掉。
*/

/** 计数多久没更新就不认（秒）：Agent 掉线期间的旧计数不拿来关机。 */
export const TRAFFIC_SHUTDOWN_COUNTER_FRESH_SECONDS = 600;

const ENABLED_CACHE_TTL_MS = 30_000;
let enabledCache: { ids: Set<number>; loadedAt: number } | null = null;
let enabledLoad: Promise<Set<number>> | null = null;

export function invalidateHostTrafficShutdownCache() {
  enabledCache = null;
  enabledLoad = null;
}

/** 开了流量关机的主机 id（大多数面板一台都没有：其余主机每轮扩展通道连这条查询都不用跑）。 */
export async function getTrafficShutdownEnabledHostIds(): Promise<ReadonlySet<number>> {
  if (enabledCache && Date.now() - enabledCache.loadedAt < ENABLED_CACHE_TTL_MS) return enabledCache.ids;
  if (!enabledLoad) {
    const load = queryRaw<Record<string, unknown>>(`SELECT ${q("id")} FROM ${q("hosts")} WHERE ${q("trafficShutdownEnabled")} = ${boolLiteral(true)}`)
      .then((rows) => new Set(rows.map((row) => Number(row.id)).filter((id) => id > 0)))
      .catch(() => enabledCache?.ids ?? new Set<number>())
      .then((ids) => {
        if (enabledLoad === load) enabledCache = { ids, loadedAt: Date.now() };
        return ids;
      })
      .finally(() => { if (enabledLoad === load) enabledLoad = null; });
    enabledLoad = load;
  }
  return enabledLoad;
}

export type HostTrafficShutdownSnapshot = {
  hostId: number;
  name: string;
  userId: number;
  enabled: boolean;
  thresholdPercent: number;
  trafficLimit: number;
  trafficMeasureMode: string;
  triggeredAt: number | null;
  triggeredCycleMark: number | null;
  usedBytes: number;
  cycleMark: number;
  counterReportedAt: number | null;
};

function seconds(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export async function readHostTrafficShutdownSnapshot(hostId: number): Promise<HostTrafficShutdownSnapshot | null> {
  const h = (name: string) => `h.${q(name)}`;
  const t = (name: string) => `t.${q(name)}`;
  const rows = await queryRaw<Record<string, unknown>>(
    `SELECT ${h("id")} AS ${q("id")}, ${h("name")} AS ${q("name")}, ${h("userId")} AS ${q("userId")},
            ${h("trafficShutdownEnabled")} AS ${q("trafficShutdownEnabled")}, ${h("trafficShutdownThresholdPercent")} AS ${q("trafficShutdownThresholdPercent")},
            ${h("trafficShutdownTriggeredAt")} AS ${q("trafficShutdownTriggeredAt")}, ${h("trafficShutdownCycleMark")} AS ${q("trafficShutdownCycleMark")},
            ${h("trafficLimit")} AS ${q("trafficLimit")}, ${h("trafficMeasureMode")} AS ${q("trafficMeasureMode")},
            ${t("bytesIn")} AS ${q("bytesIn")}, ${t("bytesOut")} AS ${q("bytesOut")}, ${t("resetAt")} AS ${q("resetAt")}, ${t("lastReportedAt")} AS ${q("lastReportedAt")}
       FROM ${q("hosts")} h LEFT JOIN ${q("host_traffic_counters")} t ON ${t("hostId")} = ${h("id")}
      WHERE ${h("id")} = ?`,
    [hostId],
  );
  const row = rows[0];
  if (!row) return null;
  const enabled = row.trafficShutdownEnabled === true || row.trafficShutdownEnabled === 1 || row.trafficShutdownEnabled === "1" || row.trafficShutdownEnabled === "t";
  return {
    hostId: Number(row.id),
    name: String(row.name || ""),
    userId: Number(row.userId || 0),
    enabled,
    thresholdPercent: normalizeTrafficShutdownPercent(row.trafficShutdownThresholdPercent),
    trafficLimit: Math.max(0, Number(row.trafficLimit) || 0),
    trafficMeasureMode: String(row.trafficMeasureMode || "both"),
    triggeredAt: seconds(row.trafficShutdownTriggeredAt),
    triggeredCycleMark: row.trafficShutdownCycleMark === null || row.trafficShutdownCycleMark === undefined ? null : normalizeTrafficCycleMark(row.trafficShutdownCycleMark),
    usedBytes: hostTrafficUsedBytes({ bytesIn: row.bytesIn, bytesOut: row.bytesOut }, row.trafficMeasureMode),
    cycleMark: normalizeTrafficCycleMark(seconds(row.resetAt)),
    counterReportedAt: seconds(row.lastReportedAt),
  };
}

export function evaluateSnapshot(snapshot: HostTrafficShutdownSnapshot, agentVersion: string | null | undefined, agentSupported: boolean | undefined): TrafficShutdownEvaluation {
  return evaluateTrafficShutdown({
    host: {
      trafficShutdownEnabled: snapshot.enabled,
      trafficShutdownThresholdPercent: snapshot.thresholdPercent,
      trafficShutdownTriggeredAt: snapshot.triggeredAt,
      trafficShutdownCycleMark: snapshot.triggeredCycleMark,
      trafficLimit: snapshot.trafficLimit,
    },
    usedBytes: snapshot.usedBytes,
    cycleMark: snapshot.cycleMark,
    agentVersion,
    agentSupported,
  });
}

/**
 * 认领这个周期的关机名额。判断全写在 UPDATE 里（和 server/hostTrafficPolicy.ts 同一套用量算式），
 * 返回认领到的周期标记；没认领到回 null。
 */
export async function claimHostTrafficShutdown(hostId: number, nowSec = Math.floor(Date.now() / 1000)): Promise<number | null> {
  if (!Number.isSafeInteger(hostId) || hostId <= 0) return null;
  const h = (name: string) => `${q("hosts")}.${q(name)}`;
  const ti = `t.${q("bytesIn")}`;
  const to = `t.${q("bytesOut")}`;
  const counter = (expr: string, fallback: string) => `COALESCE((SELECT ${expr} FROM ${q("host_traffic_counters")} t WHERE t.${q("hostId")} = ${h("id")}), ${fallback})`;
  const used = counter(`CASE WHEN ${h("trafficMeasureMode")} = 'outbound' THEN ${to}
    WHEN ${h("trafficMeasureMode")} = 'max' THEN CASE WHEN ${ti} > ${to} THEN ${ti} ELSE ${to} END
    ELSE ${ti} + ${to} END`, "-1");
  const cycle = counter(`COALESCE(t.${q("resetAt")}, 0)`, "0");
  const reportedAt = counter(`COALESCE(t.${q("lastReportedAt")}, 0)`, "0");
  const percent = `CASE WHEN ${h("trafficShutdownThresholdPercent")} BETWEEN 1 AND 100 THEN ${h("trafficShutdownThresholdPercent")} ELSE 100 END`;
  const result = await executeRaw(
    `UPDATE ${q("hosts")} SET ${q("trafficShutdownTriggeredAt")} = ?, ${q("trafficShutdownCycleMark")} = ${cycle}
      WHERE ${q("id")} = ? AND ${q("trafficShutdownEnabled")} = ${boolLiteral(true)} AND ${q("trafficLimit")} > 0
        AND NOT (${q("trafficShutdownTriggeredAt")} IS NOT NULL AND ${q("trafficShutdownCycleMark")} IS NOT NULL AND ${q("trafficShutdownCycleMark")} = ${cycle})
        AND ${reportedAt} >= ?
        AND ${used} >= ${q("trafficLimit")} * 1.0 * ${percent} / 100`,
    [nowSec, hostId, nowSec - TRAFFIC_SHUTDOWN_COUNTER_FRESH_SECONDS],
  );
  if (rawAffectedRows(result) <= 0) return null;
  const rows = await queryRaw<Record<string, unknown>>(`SELECT ${q("trafficShutdownCycleMark")} FROM ${q("hosts")} WHERE ${q("id")} = ?`, [hostId]);
  const mark = normalizeTrafficCycleMark(rows[0]?.trafficShutdownCycleMark);
  appendPanelLog("warn", `[HostTrafficShutdown] host=${hostId} traffic threshold reached; Agent authorized to power off once this cycle mark=${mark}`);
  return mark;
}

/**
 * 管理员改开关时调用：从关到开（或者开着又重新保存了一次「关→开」）清掉已触发标记，重新布防。
 * 只改阈值、普通保存不清 —— 不然改一下比例就能在同一周期再关一次。
 */
export async function rearmHostTrafficShutdown(hostId: number) {
  await executeRaw(
    `UPDATE ${q("hosts")} SET ${q("trafficShutdownTriggeredAt")} = NULL, ${q("trafficShutdownCycleMark")} = NULL WHERE ${q("id")} = ?`,
    [hostId],
  );
}
