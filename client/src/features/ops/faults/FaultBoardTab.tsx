import { useState } from "react";
import { Download, FileJson } from "lucide-react";
import { toast } from "sonner";

import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { downloadTextFile } from "@/lib/fileDownload";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { formatOutageDuration } from "@shared/opsEvents";

import { EventRow, type OpsEventItem } from "../events/EventRow";
import { useMinuteNow } from "../events/useNow";

/*
  监控 › 故障：一眼看清「现在好不好、最近出了多少事、多少自己好了」。

  - 顶上四个数：在线主机、告警条数（其中严重几条）、自动恢复几次、平均多久恢复。
  - 「正在告警」：离线主机、还没回落的资源告警和隧道丢包。
  - 按类别和按主机的告警分布、每小时告警数。
  - 最近 20 条告警（点进事件页看全部）。
  - 导出：CSV 只有事件，JSON 带上汇总和当前状态，适合交给技术支持或 AI 分析；
    要整台机器的诊断输出，用「设置 › 备份恢复」旁边的支持包。
*/

const RANGE_OPTIONS = [
  { value: 24, label: "24 小时" },
  { value: 72, label: "3 天" },
  { value: 168, label: "7 天" },
] as const;

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "danger" | "ok" }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-meta text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "danger" ? "text-destructive" : tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : ""}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-meta text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function HourlyBars({ values, hours }: { values: number[]; hours: number }) {
  // 7 天按小时是 168 根柱子，合成每 6 小时一根，不然太细。
  const step = hours > 72 ? 6 : hours > 24 ? 3 : 1;
  const buckets: number[] = [];
  for (let i = 0; i < values.length; i += step) buckets.push(values.slice(i, i + step).reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...buckets);
  return (
    <div className="flex h-16 items-end gap-px" role="img" aria-label={`每 ${step} 小时的告警数，最多 ${max} 条`}>
      {buckets.map((value, index) => (
        <div
          key={index}
          className={value > 0 ? "flex-1 rounded-sm bg-orange-500/70" : "flex-1 rounded-sm bg-muted"}
          style={{ height: `${Math.max(6, (value / max) * 100)}%` }}
          title={`${value} 条`}
        />
      ))}
    </div>
  );
}

export default function FaultBoardTab() {
  const [hours, setHours] = useState<number>(24);
  const now = useMinuteNow();
  const query = trpc.ops.faultBoard.summary.useQuery({ hours }, {
    refetchInterval: pollingInterval("slow"),
    placeholderData: (previous) => previous,
  });
  const exportMutation = trpc.ops.faultBoard.export.useMutation({
    onSuccess: (file) => {
      downloadTextFile(file.filename, file.content, `${file.mime};charset=utf-8`);
      toast.success("已导出");
    },
    onError: (error) => toast.error(error.message || "导出失败"),
  });

  const data = query.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={segmentedControlClassName} role="group" aria-label="时间范围">
          <div className="grid grid-cols-3 gap-1">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={hours === option.value}
                className={segmentedOptionClassName(hours === option.value)}
                onClick={() => setHours(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={exportMutation.isPending} onClick={() => exportMutation.mutate({ hours, format: "csv" })}>
            <Download className="mr-1.5 h-3.5 w-3.5" />导出 CSV
          </Button>
          <Button size="sm" variant="outline" disabled={exportMutation.isPending} onClick={() => exportMutation.mutate({ hours, format: "json" })}>
            <FileJson className="mr-1.5 h-3.5 w-3.5" />导出故障报告
          </Button>
        </div>
      </div>

      {query.isLoading && !data ? (
        <DataSectionLoading label="正在汇总故障" minHeight="min-h-[200px]" />
      ) : query.isError || !data ? (
        <DataSectionError label="故障看板" error={query.error} onRetry={() => { void query.refetch(); }} retrying={query.isFetching} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="在线主机"
              value={`${data.hosts.online} / ${data.hosts.total}`}
              hint={data.hosts.offlineCount > 0 ? `${data.hosts.offlineCount} 台离线` : "全部在线"}
              tone={data.hosts.offlineCount > 0 ? "danger" : "ok"}
            />
            <Stat
              label={`告警（${RANGE_OPTIONS.find((option) => option.value === hours)?.label ?? `${hours} 小时`}）`}
              value={String(data.summary.alerts)}
              hint={data.summary.critical > 0 ? `其中严重 ${data.summary.critical} 条` : "没有严重告警"}
              tone={data.summary.critical > 0 ? "danger" : undefined}
            />
            <Stat label="自动恢复" value={String(data.summary.recovered)} hint="断线恢复、规则恢复、资源和丢包回落" tone={data.summary.recovered > 0 ? "ok" : undefined} />
            <Stat
              label="平均恢复用时"
              value={data.summary.avgRecoverySeconds === null ? "—" : formatOutageDuration(data.summary.avgRecoverySeconds)}
            />
          </div>
          {data.truncated ? <p className="text-meta text-muted-foreground">这段时间的事件太多，只统计了最近 5000 条。</p> : null}

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">正在告警</CardTitle></CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              {data.hosts.offlineCount === 0 && data.firing.length === 0 ? (
                <div className="text-muted-foreground">现在没有正在告警的项。</div>
              ) : (
                <>
                  {data.hosts.offline.map((host) => (
                    <div key={`offline-${host.id}`} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-destructive" aria-hidden />
                      <span className="font-medium">{host.name}</span>
                      <span className="text-muted-foreground">离线{host.lastHeartbeat ? `，最后心跳 ${new Date(host.lastHeartbeat).toLocaleString()}` : "，从没连上过"}</span>
                    </div>
                  ))}
                  {data.hosts.offlineCount > data.hosts.offline.length ? (
                    <div className="text-muted-foreground">…还有 {data.hosts.offlineCount - data.hosts.offline.length} 台离线</div>
                  ) : null}
                  {data.firing.map((item, index) => (
                    <div key={`firing-${index}`} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-orange-500" aria-hidden />
                      <span className="font-medium">{item.hostName || `#${item.hostId}`}</span>
                      <span className="text-muted-foreground">{item.label}{item.since ? `，从 ${new Date(item.since).toLocaleTimeString()} 开始` : ""}</span>
                    </div>
                  ))}
                </>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">告警分布</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <HourlyBars values={data.summary.hourly} hours={hours} />
                {data.summary.byCategory.length === 0 ? (
                  <div className="text-muted-foreground">这段时间没有告警。</div>
                ) : (
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {data.summary.byCategory.map((item) => (
                      <span key={item.key}><span className="text-muted-foreground">{item.label}</span> <span className="font-medium tabular-nums">{item.count}</span></span>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">告警最多的主机</CardTitle></CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {data.summary.topHosts.length === 0 ? (
                  <div className="text-muted-foreground">这段时间没有主机告警。</div>
                ) : data.summary.topHosts.map((host) => (
                  <div key={host.hostId} className="flex items-baseline justify-between gap-2">
                    <a className="truncate underline-offset-2 hover:underline" href={`/insights?tab=events&host=${host.hostId}`}>{host.hostName || `#${host.hostId}`}</a>
                    <span className="tabular-nums text-muted-foreground">{host.count} 条</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">最近的告警</CardTitle></CardHeader>
            <CardContent>
              {data.recent.length === 0 ? (
                <div className="text-sm text-muted-foreground">这段时间没有告警。</div>
              ) : (
                <div className="flex min-w-0 flex-col">
                  {data.recent.map((event) => (
                    <EventRow
                      key={event.id}
                      event={{ ...event, userId: null, userName: null, hostName: event.hostName ?? null } as OpsEventItem}
                      now={now}
                      showUser={false}
                      className="px-0 py-2"
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
