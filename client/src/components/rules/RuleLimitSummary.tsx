/**
 * 规则卡片 / 表格里那一行「单条规则限额」：限速、额度用量（带细进度条）、到期时间，
 * 外加流量异常时面板自动加的临时限速（「异常自动限速 60 Mbps，到 14:30」）。
 *
 * 用量取规则行上的 quotaUsedIn/Out —— 和服务端判定停用的是同一个数（shared/ruleLimits.ts），
 * 不拿图表那份会被重置的流量统计来凑。没有任何限额的规则不渲染。只读，不带任何操作。
 */

import { formatBytes } from "@shared/formatBytes";
import {
  RULE_LIMIT_REASON_LABELS,
  RULE_TRAFFIC_MODE_LABELS,
  hasRuleLimits,
  normalizeRuleLimitReason,
  normalizeRuleTrafficMode,
  ruleTrafficUsed,
} from "@shared/ruleLimits";

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function formatRuleExpiry(value: unknown, now = Date.now()) {
  const date = value ? new Date(value as any) : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const day = `${sameYear ? "" : `${date.getFullYear()}-`}${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 流量异常的临时限速（server/ops/trafficAnomalyThrottles.ts，规则列表接口带上来）：到点前才显示。 */
function activeAnomalyThrottle(rule: { anomalyThrottle?: { mbps?: unknown; until?: unknown } | null } | null | undefined, now: number): { mbps: number; until: number } | null {
  const throttle = rule?.anomalyThrottle;
  const until = Number(throttle?.until);
  const mbps = Number(throttle?.mbps);
  return Number.isFinite(until) && until > now && mbps > 0 ? { mbps, until } : null;
}

function formatClock(ms: number) {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function RuleLimitSummary({ rule, now = Date.now() }: { rule: any; now?: number }) {
  const throttle = activeAnomalyThrottle(rule, now);
  if (!hasRuleLimits(rule) && !throttle) return null;
  const speed = Math.max(0, Number(rule.rateLimitMbps) || 0);
  const limit = Math.max(0, Number(rule.trafficLimit) || 0);
  const mode = normalizeRuleTrafficMode(rule.trafficMode);
  const known = rule.quotaUsedIn != null || rule.quotaUsedOut != null;
  const used = ruleTrafficUsed(mode, Number(rule.quotaUsedIn) || 0, Number(rule.quotaUsedOut) || 0);
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const expiry = formatRuleExpiry(rule.expiresAt, now);
  const expiresAt = rule.expiresAt ? new Date(rule.expiresAt).getTime() : NaN;
  const reason = normalizeRuleLimitReason(rule.ruleLimitReason);
  const expired = reason === "expired" || (Number.isFinite(expiresAt) && expiresAt <= now);
  const exhausted = reason === "traffic_limit" || (limit > 0 && known && used >= limit);
  const quotaTone = exhausted ? "down" : percent >= 90 ? "warn" : "ok";
  return (
    <div className="fx-rule-limits" data-testid="rule-limit-summary">
      {throttle ? (
        <span
          className="fx-rule-limit"
          data-tone="warn"
          data-testid="rule-anomaly-throttle"
          title={`流量突增，面板自动临时限速到 ${throttle.mbps} Mbps，到点或流量回落后自动撤掉${speed > 0 ? `；手动设的 ${speed} Mbps 不受影响` : ""}`}
        >
          异常自动限速 {throttle.mbps} Mbps，到 {formatClock(throttle.until)}
        </span>
      ) : null}
      {speed > 0 ? (
        <span className="fx-rule-limit" title="管理员为这条规则设置的限速">限速 {speed} Mbps</span>
      ) : null}
      {limit > 0 ? (
        <span
          className="fx-rule-limit fx-rule-limit-quota"
          data-tone={quotaTone}
          title={`单条规则流量额度（${RULE_TRAFFIC_MODE_LABELS[mode]}）：已用 ${known ? formatBytes(used) : "—"}，额度 ${formatBytes(limit)}${exhausted ? `。${RULE_LIMIT_REASON_LABELS.traffic_limit}` : ""}`}
        >
          <span className="fx-rule-limit-bar" role="progressbar" aria-label="规则流量额度用量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
            <span style={{ width: `${percent}%` }} />
          </span>
          <span className="tabular-nums">{known ? formatBytes(used) : "—"} / {formatBytes(limit)}</span>
        </span>
      ) : null}
      {expiry ? (
        <span className="fx-rule-limit" data-tone={expired ? "down" : undefined} title={expired ? RULE_LIMIT_REASON_LABELS.expired : "到期后规则自动停用，延期后自动恢复"}>
          {expired ? "已于 " : ""}{expiry} 到期
        </span>
      ) : null}
    </div>
  );
}
