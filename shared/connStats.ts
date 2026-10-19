/*
  逐跳连接监控（forwardx-fxp/conn_stats.go → server/ops/connStats.ts → 隧道详情「连接监控」）前后端共用的部分：
  阶段叫什么、分档怎么换算成 P50 / P95、汇总行怎么算成功率和平均耗时、导出 CSV。
*/

export type ConnStage = "pool" | "tcp" | "handshake" | "target" | "leg";

export const CONN_STAGES: ReadonlyArray<{ key: ConnStage; label: string; description: string }> = [
  { key: "pool", label: "连接池", description: "从预热好的连接池直接拿到下一跳连接，不用拨号" },
  { key: "tcp", label: "TCP 连接", description: "拨下一跳的 TCP" },
  { key: "handshake", label: "加密握手", description: "和下一跳完成加密握手确认（从开始拨号算起）" },
  { key: "target", label: "连目标", description: "出口拨目标地址" },
  { key: "leg", label: "每一路", description: "单连接叠加：入口拨每一路并报到，外加这一路实际跑了多少" },
];

/** 单连接叠加里的一路：relay#主机 ID（并排中转）或 stream#N（同一条线开几路）。 */
export function normalizeConnLegVia(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^(relay|stream)#\d{1,9}$/.test(text) ? text : "";
}

/** 字节数换成 Mbps（一位小数）。 */
export function bytesToMbps(bytes: number, seconds: number) {
  if (!(seconds > 0) || !(bytes > 0)) return 0;
  return Math.round(((bytes * 8) / seconds / 1_000_000) * 10) / 10;
}

export function formatConnBytes(bytes: number) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)} TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

export function connStageLabel(stage: string) {
  return CONN_STAGES.find((item) => item.key === stage)?.label ?? stage;
}

export function connRoleLabel(role: string) {
  if (role === "entry") return "入口";
  if (role === "exit") return "出口";
  if (role === "relay") return "中转";
  return role || "-";
}

/** 分档上限（毫秒），和 FXP 一致；第六档是「1000 以上」。 */
export const CONN_STATS_BUCKETS_MS = [50, 100, 200, 500, 1000] as const;

export type ConnStatsAggregate = {
  attempts: number;
  failures: number;
  sumMs: number;
  maxMs: number;
  buckets: number[];
};

export function emptyConnStatsAggregate(): ConnStatsAggregate {
  return { attempts: 0, failures: 0, sumMs: 0, maxMs: 0, buckets: [0, 0, 0, 0, 0, 0] };
}

export function addConnStats(target: ConnStatsAggregate, source: Partial<ConnStatsAggregate>) {
  target.attempts += Math.max(0, Number(source.attempts) || 0);
  target.failures += Math.max(0, Number(source.failures) || 0);
  target.sumMs += Math.max(0, Number(source.sumMs) || 0);
  target.maxMs = Math.max(target.maxMs, Math.max(0, Number(source.maxMs) || 0));
  const buckets = Array.isArray(source.buckets) ? source.buckets : [];
  for (let i = 0; i < 6; i += 1) target.buckets[i] += Math.max(0, Number(buckets[i]) || 0);
  return target;
}

/**
 * 按分档估一个分位数（毫秒）：落在哪一档就报那一档的上限；落在最后一档报观测到的最大值。
 * 没有成功样本时是 null。
 */
export function estimateConnPercentile(aggregate: ConnStatsAggregate, quantile: number): number | null {
  const total = aggregate.buckets.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const rank = Math.max(1, Math.ceil(total * Math.min(1, Math.max(0, quantile))));
  let seen = 0;
  for (let i = 0; i < aggregate.buckets.length; i += 1) {
    seen += aggregate.buckets[i];
    if (seen >= rank) return i < CONN_STATS_BUCKETS_MS.length ? CONN_STATS_BUCKETS_MS[i] : aggregate.maxMs;
  }
  return aggregate.maxMs;
}

export type ConnStatsSummary = {
  attempts: number;
  failures: number;
  /** 成功率（0–100，一位小数）；没有尝试是 null。 */
  successRate: number | null;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number;
};

export function summarizeConnStats(aggregate: ConnStatsAggregate): ConnStatsSummary {
  const successes = aggregate.attempts - aggregate.failures;
  return {
    attempts: aggregate.attempts,
    failures: aggregate.failures,
    successRate: aggregate.attempts > 0 ? Math.round((successes / aggregate.attempts) * 1000) / 10 : null,
    avgMs: successes > 0 ? Math.round(aggregate.sumMs / successes) : null,
    p50Ms: estimateConnPercentile(aggregate, 0.5),
    p95Ms: estimateConnPercentile(aggregate, 0.95),
    maxMs: aggregate.maxMs,
  };
}

/** 端点：只认 host:port、[v6]:port、"-"，长度 ≤ 160，别的不收。 */
export function normalizeConnEndpoint(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (text === "-") return text;
  if (!text || text.length > 160) return null;
  if (!/^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.\-_]+)(:\d{1,5})?$/.test(text)) return null;
  return text;
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export type ConnStatsExportRow = {
  hostName: string;
  role: string;
  stage: string;
  endpoint: string;
  via?: string;
  bytesUp?: number;
  bytesDown?: number;
  ruleId: number | null;
  summary: ConnStatsSummary;
  lastError: string | null;
};

export function connStatsToCsv(rows: readonly ConnStatsExportRow[]) {
  const header = ["host", "role", "stage", "endpoint", "ruleId", "attempts", "failures", "successRate", "avgMs", "p50Ms", "p95Ms", "maxMs", "lastError", "via", "bytesUp", "bytesDown"];
  const lines = rows.map((row) => [
    row.hostName,
    row.role,
    row.stage,
    row.endpoint,
    row.ruleId ?? "",
    row.summary.attempts,
    row.summary.failures,
    row.summary.successRate ?? "",
    row.summary.avgMs ?? "",
    row.summary.p50Ms ?? "",
    row.summary.p95Ms ?? "",
    row.summary.maxMs,
    row.lastError ?? "",
    row.via ?? "",
    row.bytesUp ?? 0,
    row.bytesDown ?? 0,
  ].map(csvCell).join(","));
  return `﻿${header.join(",")}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}
