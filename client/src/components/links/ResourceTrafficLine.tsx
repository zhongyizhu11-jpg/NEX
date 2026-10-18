import { formatBytes } from "@shared/formatBytes";

export type ResourceTrafficTotals = {
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  ruleCount: number;
};

/**
 * 隧道 / 转发组卡片上的一行「累计 12.3 GB · 4 条规则」（上游 2.3.285 的链路资源流量汇总）。
 *
 * 只是一行灰字：卡片上的主角还是线路和延迟。悬停看入向 / 出向。
 * 累计流量 = 当前关联规则的实际流量（入 + 出），不按倍率折算；规则按逻辑规则去重，含停用的。
 * 普通用户在共享资源上只看到自己规则的数。没拿到数（旧接口、加载中）就不显示。
 */
export function ResourceTrafficLine({ summary, className = "" }: { summary?: ResourceTrafficTotals | null; className?: string }) {
  if (!summary) return null;
  const title = `入向 ${formatBytes(summary.bytesIn)} · 出向 ${formatBytes(summary.bytesOut)}（当前关联规则的累计实际流量，不按倍率折算）`;
  return (
    <div className={`flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground tabular-nums ${className}`} title={title}>
      <span className="truncate">累计 {formatBytes(summary.totalBytes)}</span>
      <span aria-hidden="true">·</span>
      <span className="shrink-0">{summary.ruleCount} 条规则</span>
    </div>
  );
}
