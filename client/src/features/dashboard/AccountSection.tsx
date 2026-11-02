import type { ReactNode } from "react";

import AnimatedStatValue from "@/components/AnimatedStatValue";
import { ResourceMeter } from "@/components/entity/Metric";
import { ListRow, ListSection } from "@/components/ios/GroupedList";
import { formatBytes } from "@shared/formatBytes";

export type AccountBilling = {
  enabled: boolean;
  bytesText: string;
  amountText: string;
  /** 「已计费 12GB」这一句 */
  billedText: string;
};

export type AccountQuota = {
  hasQuota: boolean;
  unlimited: boolean;
  used: number;
  /** 0 表示不限 */
  limit: number;
  percent: number;
  /** 「额度来源：套餐、加购」；没有生效额度时是 null */
  sourcesText: string | null;
  /** 每月自动重置的那一天；不自动重置是 null */
  autoResetDay: number | null;
};

export type AccountExpiry = {
  dateText: string;
  label: string;
  tone: "normal" | "warning" | "danger";
};

/**
 * 首页的「我的账户」。
 *
 * 原来是一张大卡里套四到六个带边框的小卡，每个小卡一个图标、一个标签、一个大号
 * 数字、一行小字 —— 393px 下管理员那张 707px。框本身不携带任何信息，只是在重复
 * 画边界；六个数一样大，也分不出哪个要紧。
 *
 * 现在是设置页同一套 iOS 分组列表：一行一件事，左边名字、右边值。能处理的那几行
 * 点得进去（套餐、余额），只是看的那几行不画箭头。
 *
 * 删掉的：「权限状态：管理员 · 不受套餐订阅限制」那一格和右上角的「管理员权限」
 * 徽标 —— 管理员自己知道自己是管理员。「转发已启用」的徽标变成一行。
 */
export function AccountSection({
  isAdmin,
  loading,
  cacheScope,
  onOpen,
  trafficUsed,
  billing,
  quota,
  expiry,
  planText,
  balanceText,
  canForward,
  forwardPaused = false,
  error,
}: {
  isAdmin: boolean;
  loading: boolean;
  /** 本地缓存值的作用域：刷新时先显示上一次的值，而不是一排「0」 */
  cacheScope: string;
  onOpen: (href: string) => void;
  trafficUsed: number;
  billing: AccountBilling;
  quota?: AccountQuota;
  expiry?: AccountExpiry;
  planText?: string;
  balanceText?: string;
  canForward?: boolean;
  /** 「需要关注」里已经有一行「转发已暂停」—— 这里要用同一个词 */
  forwardPaused?: boolean;
  /** 账户数据没读到：显示这一块，不显示一排「0 B」「---」 */
  error?: ReactNode;
}) {
  if (error) {
    return (
      <ListSection header={isAdmin ? "我的消耗" : "我的账户"}>
        <div className="p-[var(--fx-card-padding)]">{error}</div>
      </ListSection>
    );
  }
  const cached = (key: string, value: string, fallback: string) => (
    <AnimatedStatValue
      value={value}
      loading={loading}
      cacheKey={`home.account.${cacheScope}.${key}`}
      fallbackValue={fallback}
      className="tabular-nums"
    />
  );

  /*
    按量计费没开时，「计费流量 未开启」「计费消费 -」两行说的是同一件事，
    合成一行。
  */
  const billingRows: ReactNode = billing.enabled ? (
    <>
      <ListRow label="计费流量" detail={billing.billedText} value={cached("billingTraffic", billing.bytesText, "0 B")} />
      <ListRow label="计费消费" value={cached("billingAmount", billing.amountText, "-")} />
    </>
  ) : (
    <ListRow label="按量计费" value="未开启" />
  );

  if (isAdmin) {
    return (
      <ListSection header="我的消耗">
        <ListRow label="已用流量" value={cached("trafficUsed", formatBytes(trafficUsed), "0 B")} />
        {billingRows}
      </ListSection>
    );
  }

  const footer = [
    quota?.sourcesText,
    quota?.hasQuota && quota.autoResetDay
      ? `每月 ${quota.autoResetDay} 日自动重置${Number(quota.autoResetDay) > 28 ? "（小月在月末重置）" : ""}。`
      : null,
  ].filter(Boolean).join("");
  const expiryColor = expiry?.tone === "danger"
    ? "var(--fx-down-text)"
    : expiry?.tone === "warning"
      ? "var(--fx-warn-text)"
      : undefined;

  return (
    <ListSection header="我的账户" footer={footer || null}>
      {/*
        额度这一行带一根条：「12.3 GB / 100 GB」要算一下才知道快不快满，条一眼
        就看出来。接近配额在状态词汇表里就是「降级」，所以快满时条变琥珀。
      */}
      <div className="fx-list-row flex w-full min-w-0 flex-col gap-[var(--fx-space-2)] px-4 py-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-secondary-type text-foreground">流量额度</span>
          <span className="shrink-0 truncate text-secondary-type text-muted-foreground">
            {!quota?.hasQuota
              ? "没有生效的额度"
              : quota.limit > 0
                ? cached("planUsage", `${formatBytes(quota.used)} / ${formatBytes(quota.limit)}`, "---")
                : cached("planUsage", `${formatBytes(quota.used)} / 不限`, "---")}
          </span>
        </div>
        {/*
          阈值和主机资源条不一样：CPU 到 90% 已经是故障的前兆，而额度到 90% 转发
          照常在跑 —— 用完那一刻才会停。所以 80% 起琥珀（快满了），100% 才红。
        */}
        {quota?.hasQuota && quota.limit > 0 ? <ResourceMeter label="已用" percent={quota.percent} warnAt={80} criticalAt={100} /> : null}
      </div>
      <ListRow
        label="到期时间"
        detail={expiry && expiry.label !== expiry.dateText ? <span style={{ color: expiryColor }}>{expiry.label}</span> : undefined}
        value={cached("planExpiry", expiry?.dateText || "---", "---")}
        onSelect={() => onOpen("/subscriptions")}
      />
      <ListRow label="当前套餐" value={cached("planName", planText || "---", "---")} onSelect={() => onOpen("/subscriptions")} />
      <ListRow label="账户余额" value={cached("wallet", balanceText || "-", "-")} onSelect={() => onOpen("/wallet")} />
      {billingRows}
      <ListRow
        label="转发"
        value={
          <span style={canForward ? undefined : { color: "var(--fx-down-text)" }}>
            {canForward ? "已启用" : forwardPaused ? "已暂停" : "已停用"}
          </span>
        }
      />
    </ListSection>
  );
}
