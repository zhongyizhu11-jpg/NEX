import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import {
  BANDWIDTH_AGGREGATION_STRATEGY_LABELS,
  formatAggregationUtilization,
  formatBandwidthMbps,
  normalizeBandwidthAggregationStrategy,
} from "@shared/bandwidthAggregation";

type Props = {
  /** Entry group being inspected. `0` disables the query. */
  groupId: number;
  /** Whether the surrounding dialog or panel is open. */
  open: boolean;
};

function utilizationTone(utilization: number) {
  if (utilization >= 0.9) return "text-destructive";
  if (utilization >= 0.7) return "text-[var(--fx-warn-text)]";
  return "text-[var(--fx-healthy-text)]";
}

/**
 * Live view of an entry group's multi-front-VPS bandwidth aggregation: how much
 * uplink the healthy front VPS hosts add up to, how much of it is in use, and
 * the share of new connections each one is set to receive.
 */
export function BandwidthAggregationSummary({ groupId, open }: Props) {
  const enabled = open && Number(groupId) > 0;
  const { data, isLoading } = trpc.forwardGroups.bandwidthAggregation.useQuery(
    { groupId: Number(groupId) },
    { enabled, refetchInterval: pollingInterval("slow", enabled), refetchOnWindowFocus: false },
  );

  if (!enabled) return null;
  if (isLoading && !data) {
    return (
      <div className="rounded-md border border-border/60 p-3 text-xs text-muted-foreground">
        正在读取排序状态…
      </div>
    );
  }
  if (!data) return null;

  const members = Array.isArray(data.members) ? data.members : [];
  const utilization = Number(data.utilization) || 0;

  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">当前排序</span>
        <Badge variant={data.degraded ? "outline" : "secondary"}>
          {BANDWIDTH_AGGREGATION_STRATEGY_LABELS[normalizeBandwidthAggregationStrategy(data.strategy)]}
        </Badge>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <div className="text-[11px] text-muted-foreground">入口带宽合计</div>
          <div className="text-sm font-medium">{formatBandwidthMbps(data.aggregateCapacityMbps)}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">实时已用</div>
          <div className={"text-sm font-medium " + utilizationTone(utilization)}>
            {formatBandwidthMbps(data.aggregateUsedMbps)}
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">
              {formatAggregationUtilization(utilization)}
            </span>
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">健康前置</div>
          <div className="text-sm font-medium">{data.healthyCount} / {data.memberCount} 台</div>
        </div>
      </div>

      <Progress value={Math.min(100, Math.round(utilization * 100))} className="h-1.5" />

      {data.reason ? (
        <p className="text-xs text-[var(--fx-warn-text)]">{data.reason}</p>
      ) : null}

      <div className="space-y-1.5">
        {members.map((member: any) => {
          const memberUtilization = Number(member.utilization) || 0;
          return (
            <div
              key={member.memberId}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/50 px-2.5 py-1.5 text-xs"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{member.label || member.value}</span>
                {member.healthy ? null : <Badge variant="outline">不健康</Badge>}
              </span>
              <span className="flex items-center gap-3 text-muted-foreground">
                <span title="该前置的上行带宽">{formatBandwidthMbps(member.effectiveBandwidthMbps)}</span>
                <span className={utilizationTone(memberUtilization)} title="该前置的实时占用">
                  {formatAggregationUtilization(memberUtilization)}
                </span>
                <span className="font-medium text-foreground" title="排序用的比重：越高越靠前（不是准确的连接比例）">
                  {member.healthy ? `${Number(member.weight || 0).toFixed(1)}%` : "-"}
                </span>
              </span>
            </div>
          );
        })}
        {members.length === 0 && (
          <p className="text-xs text-muted-foreground">还没有可参与排序的入口主机。</p>
        )}
      </div>
    </div>
  );
}
