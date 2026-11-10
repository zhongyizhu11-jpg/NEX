import type { BadgeTone } from "@/components/ui/badge";
import {
  OPERATION_AUDIT_CHANNEL_LABELS,
  OPERATION_AUDIT_RESULT_LABELS,
  operationAuditModuleLabel,
  type OperationAuditChannel,
  type OperationAuditResult,
} from "@shared/operationAudit";

/* 操作审计页面上的几处写法：时间、操作名、结果颜色、来源。列表行和详情共用。 */

export type AuditListItem = {
  id: number;
  actorUserId: number | null;
  actorName: string | null;
  actorRole: string | null;
  apiTokenId: number | null;
  apiTokenName: string | null;
  /** 管理员代入用户后台时做的操作：被代入的用户（操作人那一栏是管理员）。 */
  onBehalfOfUserId?: number | null;
  onBehalfOfName?: string | null;
  channel: OperationAuditChannel;
  path: string;
  module: string;
  result: OperationAuditResult;
  errorCode: string | null;
  errorMessage: string | null;
  /** 只有详情接口带（列表不带参数） */
  input?: unknown;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  durationMs: number;
  createdAt: Date | string | number;
};

export const RESULT_TONE: Record<OperationAuditResult, BadgeTone> = { ok: "up", denied: "warn", error: "down" };

export function auditResultLabel(result: OperationAuditResult) {
  return OPERATION_AUDIT_RESULT_LABELS[result] || result;
}

export function auditChannelLabel(item: Pick<AuditListItem, "channel" | "apiTokenName" | "onBehalfOfUserId" | "onBehalfOfName">) {
  const base = OPERATION_AUDIT_CHANNEL_LABELS[item.channel] || item.channel;
  // 代入：写明是以谁的身份做的，不然只看到管理员改了一条「不是他的」规则。
  const onBehalfOf = item.onBehalfOfName || (item.onBehalfOfUserId ? `#${item.onBehalfOfUserId}` : "");
  if (onBehalfOf) return `${base}「${onBehalfOf}」`;
  return item.apiTokenName ? `${base}「${item.apiTokenName}」` : base;
}

/** 「系统设置」+「updateSettings」：模块用页面上的叫法，过程名照原样（审计要能对得上代码）。 */
export function auditOperationParts(item: Pick<AuditListItem, "path" | "module">) {
  const procedure = item.path.slice(item.module ? item.module.length + 1 : 0) || item.path;
  return { module: operationAuditModuleLabel(item.module), procedure };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** 列表里的时间：今年的不写年份。 */
export function formatAuditTime(value: AuditListItem["createdAt"], now = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return date.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}-${day} ${time}`;
}

export function formatAuditDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export const CONFIG_RESOURCE_LABELS: Record<string, string> = {
  forward_rule: "转发规则",
  host: "主机",
  tunnel: "隧道",
  runtime: "运行配置",
};

export const CONFIG_ACTION_LABELS: Record<string, string> = { create: "新建", update: "修改", delete: "删除" };

/** 差异里的一个值，写成一行字。 */
export function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return "（空）";
  if (typeof value === "string") return value || "（空）";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const text = JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  } catch {
    return String(value);
  }
}

export const RANGE_OPTIONS = [
  { value: "1d", label: "近 24 小时", seconds: 86400 },
  { value: "7d", label: "近 7 天", seconds: 7 * 86400 },
  { value: "30d", label: "近 30 天", seconds: 30 * 86400 },
  { value: "all", label: "全部时间", seconds: 0 },
] as const;
export type AuditRange = typeof RANGE_OPTIONS[number]["value"];
