/**
 * 规则编辑器里「单条规则限额」一段，只给管理员看：限速、流量额度（及计算方式）、到期时间。
 *
 * 判定在 shared/ruleLimits.ts，和服务端（server/ruleLimits.ts）同一份。这里只负责填和校验格式：
 *   - 留空 / 0 = 不限；
 *   - 提交时只带**改过的**字段（ruleLimitsChanges）—— 管理员只是改个名字，不该顺手把用户自己的
 *     规则变成「管理员管理」（服务端收到任何一项限额就会这么记）。
 */

import DatePickerInput, { formatDateInputValue, parseDateInputValue } from "@/components/DatePickerInput";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatBytes } from "@shared/formatBytes";
import {
  RULE_TRAFFIC_MODE_LABELS,
  RULE_TRAFFIC_MODES,
  normalizeRuleTrafficMode,
  ruleTrafficUsed,
  type RuleTrafficMode,
} from "@shared/ruleLimits";

// 和用户 / 套餐的流量额度同一口径（1024 进制，界面写 GB），见 Users.tsx、Plans.tsx。
const GIB = 1024 ** 3;

export type RuleLimitsFormValue = {
  speed: string;
  quota: string;
  mode: RuleTrafficMode;
  expiresDate: string;
  expiresTime: string;
  /** 编辑时这条规则已经记下的用量（只读展示），null = 还没开始记。 */
  quotaUsedIn: number | null;
  quotaUsedOut: number | null;
};

export type RuleLimitsPayload = {
  rateLimitMbps: number;
  trafficLimit: number;
  trafficMode: RuleTrafficMode;
  expiresAt: Date | null;
};

function timeText(value: Date) {
  return [value.getHours(), value.getMinutes()].map((part) => String(part).padStart(2, "0")).join(":");
}

function trimNumber(value: number) {
  return String(Number(value.toFixed(3)));
}

export function newRuleLimitsForm(rule?: any): RuleLimitsFormValue {
  const expires = rule?.expiresAt ? new Date(rule.expiresAt) : null;
  const validExpiry = expires && Number.isFinite(expires.getTime()) ? expires : null;
  const trafficLimit = Number(rule?.trafficLimit || 0);
  return {
    speed: Number(rule?.rateLimitMbps) > 0 ? String(Number(rule.rateLimitMbps)) : "",
    quota: trafficLimit > 0 ? trimNumber(trafficLimit / GIB) : "",
    mode: normalizeRuleTrafficMode(rule?.trafficMode),
    expiresDate: validExpiry ? formatDateInputValue(validExpiry) : "",
    expiresTime: validExpiry ? timeText(validExpiry) : "23:59",
    quotaUsedIn: rule?.quotaUsedIn == null ? null : Number(rule.quotaUsedIn),
    quotaUsedOut: rule?.quotaUsedOut == null ? null : Number(rule.quotaUsedOut),
  };
}

/** 整份限额（格式不对直接抛错，提示原样给用户看）。 */
export function ruleLimitsPayload(value: RuleLimitsFormValue): RuleLimitsPayload {
  const speedText = value.speed.trim();
  const quotaText = value.quota.trim();
  const speed = speedText ? Number(speedText) : 0;
  const quota = quotaText ? Number(quotaText) : 0;
  if (!Number.isInteger(speed) || speed < 0 || speed > 1_000_000) throw new Error("限速请填 0 到 1000000 之间的整数（Mbps）");
  if (!Number.isFinite(quota) || quota < 0 || quota * GIB > Number.MAX_SAFE_INTEGER) throw new Error("流量额度请填不小于 0 的数字（GB）");
  let expiresAt: Date | null = null;
  if (value.expiresDate) {
    const date = parseDateInputValue(value.expiresDate);
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.expiresTime.trim());
    if (!date || !match) throw new Error("请选择有效的到期日期和时间");
    const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
    if (hours > 23 || minutes > 59 || seconds > 59) throw new Error("请选择有效的到期日期和时间");
    date.setHours(hours, minutes, seconds, 0);
    expiresAt = date;
  }
  return {
    rateLimitMbps: speed,
    // 填了额度就至少 1 字节，免得很小的数四舍五入成「不限」。
    trafficLimit: quota > 0 ? Math.max(1, Math.round(quota * GIB)) : 0,
    trafficMode: value.mode,
    expiresAt,
  };
}

/**
 * 只取和规则现在不一样的字段。新建时 rule 为空：只带设了值的。
 * 返回空对象表示「限额没动」，提交时一项都不带。
 */
export function ruleLimitsChanges(value: RuleLimitsFormValue, rule?: any): Partial<RuleLimitsPayload> {
  const next = ruleLimitsPayload(value);
  const changes: Partial<RuleLimitsPayload> = {};
  const currentSpeed = Math.max(0, Number(rule?.rateLimitMbps) || 0);
  const currentQuota = Math.max(0, Number(rule?.trafficLimit) || 0);
  const currentMode = normalizeRuleTrafficMode(rule?.trafficMode);
  const currentExpiry = rule?.expiresAt ? new Date(rule.expiresAt).getTime() : null;
  if (next.rateLimitMbps !== currentSpeed) changes.rateLimitMbps = next.rateLimitMbps;
  // 额度换算成 GiB 再换回来会有零头：表单上的数没改就当没改。
  if (newRuleLimitsForm(rule).quota !== value.quota.trim() && next.trafficLimit !== currentQuota) changes.trafficLimit = next.trafficLimit;
  if (next.trafficMode !== currentMode && (next.trafficLimit > 0 || currentQuota > 0)) changes.trafficMode = next.trafficMode;
  const nextExpiry = next.expiresAt ? next.expiresAt.getTime() : null;
  // 表单只精确到分钟：同一分钟内的旧值不算改动。
  const sameMinute = nextExpiry !== null && currentExpiry !== null && Math.floor(nextExpiry / 60_000) === Math.floor(currentExpiry / 60_000);
  if (!(nextExpiry === currentExpiry || sameMinute)) changes.expiresAt = next.expiresAt;
  return changes;
}

/** 「更多设置」折叠条上的一句摘要：折起来也看得见限额现在是什么样。 */
export function ruleLimitsSummary(value: RuleLimitsFormValue): string | null {
  const parts: string[] = [];
  const speed = Number(value.speed);
  const quota = Number(value.quota);
  if (value.speed.trim() && Number.isFinite(speed) && speed > 0) parts.push(`限速 ${speed} Mbps`);
  if (value.quota.trim() && Number.isFinite(quota) && quota > 0) parts.push(`额度 ${trimNumber(quota)} GB`);
  if (value.expiresDate) parts.push(`${value.expiresDate.slice(5)} 到期`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

type Props = {
  value: RuleLimitsFormValue;
  onChange: (value: RuleLimitsFormValue) => void;
  /** 新规则归谁（管理员替所选用户建时显示）；为空不显示。 */
  ownerLabel?: string | null;
};

export function RuleLimitsForm({ value, onChange, ownerLabel }: Props) {
  const patch = (data: Partial<RuleLimitsFormValue>) => onChange({ ...value, ...data });
  const quotaSet = value.quota.trim() !== "" && Number(value.quota) > 0;
  const used = value.quotaUsedIn === null
    ? null
    : ruleTrafficUsed(value.mode, value.quotaUsedIn || 0, value.quotaUsedOut || 0);
  return (
    <div className="space-y-3 rounded-md bg-muted/35 px-3 py-2.5" data-testid="rule-limits-section">
      <div className="min-w-0 space-y-0.5">
        <Label className="text-sm font-medium">单条规则限额</Label>
        <p data-fx-help="" className="text-xs text-muted-foreground">
          仅管理员可设，和用户账户的限制同时生效；留空表示不限。设了任何一项，规则主人就只能查看、不能修改。
          {ownerLabel ? ` 新规则归属：${ownerLabel}。` : ""}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField className="space-y-1.5">
          <Label htmlFor="rule-limit-speed">限速（Mbps）</Label>
          <Input
            id="rule-limit-speed"
            type="number"
            inputMode="numeric"
            min={0}
            max={1_000_000}
            step={1}
            placeholder="不限"
            value={value.speed}
            onChange={(event) => patch({ speed: event.target.value })}
          />
        </FormField>
        <FormField className="space-y-1.5">
          <Label htmlFor="rule-limit-quota">流量额度（GB）</Label>
          <Input
            id="rule-limit-quota"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder="不限"
            value={value.quota}
            onChange={(event) => patch({ quota: event.target.value })}
          />
        </FormField>
        <FormField className="space-y-1.5">
          <Label>额度怎么算</Label>
          <Select value={value.mode} onValueChange={(mode) => patch({ mode: normalizeRuleTrafficMode(mode) })} disabled={!quotaSet}>
            <SelectTrigger aria-label="额度怎么算"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RULE_TRAFFIC_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>{RULE_TRAFFIC_MODE_LABELS[mode]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField className="space-y-1.5">
          <Label>到期时间</Label>
          <div className="flex min-w-0 gap-2">
            <DatePickerInput
              className="min-w-0 flex-1"
              value={value.expiresDate}
              placeholder="永久有效"
              onChange={(expiresDate) => patch({ expiresDate })}
            />
            <Input
              aria-label="到期时刻"
              type="time"
              className="w-[6.5rem] shrink-0"
              disabled={!value.expiresDate}
              value={value.expiresTime}
              onChange={(event) => patch({ expiresTime: event.target.value })}
            />
          </div>
        </FormField>
      </div>
      <p className="text-xs text-muted-foreground">
        {used === null
          ? "用量从设置额度那一刻起累计（已有的累计流量一并算进去），到额度或到期后规则自动停用，放宽额度、延期或重置统计后自动恢复。"
          : `已用 ${formatBytes(used)}（${RULE_TRAFFIC_MODE_LABELS[value.mode]}）。到额度或到期后规则自动停用，放宽额度、延期或重置统计后自动恢复。`}
      </p>
    </div>
  );
}
