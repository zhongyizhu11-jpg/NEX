import { useState } from "react";
import { Download, FileJson } from "lucide-react";
import { toast } from "sonner";

import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { downloadTextFile } from "@/lib/fileDownload";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { CONN_STAGES, connRoleLabel, connStageLabel, formatConnBytes } from "@shared/connStats";

/*
  隧道 › 连接监控：真实用户连接在每一跳、每个阶段花了多久、成没成（FXP 每分钟报一次，留 7 天）。
  和「诊断」「延迟记录」那种主动探测不同，这里是业务连接本身的数据：哪一跳在拖、在哪个阶段失败，一眼看出来。
  只有 NEX 隧道有（FXP 2.2.133 起）。
*/

const RANGES = [
  { value: 1, label: "1 小时" },
  { value: 24, label: "24 小时" },
  { value: 168, label: "7 天" },
] as const;

function formatMs(value: number | null) {
  return value === null ? "—" : `${value} ms`;
}

function formatMbps(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} Gbps` : `${value} Mbps`;
}

function rateClass(rate: number | null) {
  if (rate === null) return "text-muted-foreground";
  if (rate >= 99) return "text-[var(--fx-healthy-text)]";
  if (rate >= 95) return "text-[var(--fx-warn-text)]";
  return "text-[var(--fx-down-text)]";
}

function rateBarClass(rate: number | null) {
  if (rate === null) return "bg-muted";
  if (rate >= 99) return "bg-[var(--fx-healthy)]";
  if (rate >= 95) return "bg-[var(--fx-warn)]";
  return "bg-[var(--fx-down)]";
}

type Props = { tunnel: { id: number; name: string } | null; onClose: () => void };

export default function TunnelConnStatsDialog({ tunnel, onClose }: Props) {
  return (
    <Dialog open={!!tunnel} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>连接监控{tunnel ? ` · ${tunnel.name}` : ""}</DialogTitle>
          <DialogDescription data-fx-help="">
            真实连接每一跳的成功率和耗时；单连接叠加还列出每一路跑了多少。留 7 天。
          </DialogDescription>
        </DialogHeader>
        <TunnelConnStatsBody tunnel={tunnel} />
      </DialogContent>
    </Dialog>
  );
}

/*
  连接监控的正文，没有对话框外壳：标准布局下套在上面的对话框里；精简布局下并进「诊断」框当一页
  （Tunnels.tsx 传给 DiagnoseDialog 的 extraTabs）。
*/
export function TunnelConnStatsBody({ tunnel }: { tunnel: { id: number; name: string } | null }) {
  const [hours, setHours] = useState<number>(24);
  const query = trpc.ops.connStats.tunnel.useQuery(
    { tunnelId: tunnel?.id ?? 0, hours },
    { enabled: !!tunnel, refetchInterval: pollingInterval("slow"), placeholderData: (previous) => previous },
  );
  const exportMutation = trpc.ops.connStats.export.useMutation({
    onSuccess: (file) => downloadTextFile(file.filename, file.content, `${file.mime};charset=utf-8`),
    onError: (error) => toast.error(error.message || "导出失败"),
  });
  const data = query.data;
  const stagesWithData = CONN_STAGES.filter((stage) => data?.hourly.some((row) => row.stage === stage.key && row.summary.attempts > 0));

  return (
    <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className={segmentedControlClassName} role="group" aria-label="时间范围">
            <div className="grid grid-cols-3 gap-1">
              {RANGES.map((range) => (
                <button
                  key={range.value}
                  type="button"
                  aria-pressed={hours === range.value}
                  className={segmentedOptionClassName(hours === range.value)}
                  onClick={() => setHours(range.value)}
                >
                  {range.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!tunnel || exportMutation.isPending} onClick={() => tunnel && exportMutation.mutate({ tunnelId: tunnel.id, hours, format: "csv" })}>
              <Download className="mr-1.5 h-3.5 w-3.5" />CSV
            </Button>
            <Button size="sm" variant="outline" disabled={!tunnel || exportMutation.isPending} onClick={() => tunnel && exportMutation.mutate({ tunnelId: tunnel.id, hours, format: "json" })}>
              <FileJson className="mr-1.5 h-3.5 w-3.5" />JSON
            </Button>
          </div>
        </div>

        {query.isLoading && !data ? (
          <DataSectionLoading label="正在读取连接统计" minHeight="min-h-[160px]" />
        ) : query.isError || !data ? (
          <DataSectionError label="连接统计" error={query.error} onRetry={() => { void query.refetch(); }} retrying={query.isFetching} />
        ) : data.groups.length === 0 && data.legs.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            这段时间还没有连接统计。隧道上有流量、FXP 升级到 2.2.133 以上后，一两分钟内就会出现。
          </div>
        ) : (
          <>
            {data.legs.length > 0 ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <div className="text-sm font-medium">单连接叠加 · 每一路</div>
                  <div className="text-xs text-muted-foreground">速率是最近 {Math.round(data.legRecentSeconds / 60)} 分钟平均</div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {data.legs.map((leg) => (
                    <div key={`${leg.hostId}-${leg.via}-${leg.endpoint}`} className="space-y-2 rounded-md border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{leg.legName || leg.endpoint}</div>
                          <div className="truncate font-mono text-xs text-muted-foreground">{leg.endpoint}</div>
                        </div>
                        <div className="shrink-0 text-right text-sm tabular-nums">
                          <div>↓ {formatMbps(leg.recentDownMbps)}</div>
                          <div className="text-xs text-muted-foreground">↑ {formatMbps(leg.recentUpMbps)}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" role="img" aria-label={`占 ${leg.sharePercent}%`}>
                          <div className="h-full rounded-full bg-primary" style={{ width: `${leg.sharePercent}%` }} />
                        </div>
                        <div className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{leg.sharePercent}%</div>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
                        <span>共 ↓ {formatConnBytes(leg.bytesDown)} ↑ {formatConnBytes(leg.bytesUp)}</span>
                        {leg.summary.attempts > 0 ? (
                          <span>
                            拨 {leg.summary.attempts} 次
                            {leg.summary.successRate !== null ? <span className={`ml-1 ${rateClass(leg.summary.successRate)}`}>{leg.summary.successRate}%</span> : null}
                            {leg.summary.avgMs !== null ? `，平均 ${leg.summary.avgMs} ms` : ""}
                          </span>
                        ) : null}
                      </div>
                      {leg.lastError ? <div className="text-xs text-[var(--fx-down-text)]">最近失败：{leg.lastError}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {data.groups.length > 0 ? (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">主机</th>
                      <th className="px-3 py-2 font-medium">阶段</th>
                      <th className="px-3 py-2 font-medium">连向</th>
                      <th className="px-3 py-2 text-right font-medium">次数</th>
                      <th className="px-3 py-2 text-right font-medium">成功率</th>
                      <th className="px-3 py-2 text-right font-medium">平均</th>
                      <th className="px-3 py-2 text-right font-medium">P50</th>
                      <th className="px-3 py-2 text-right font-medium">P95</th>
                      <th className="px-3 py-2 text-right font-medium">最慢</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.groups.map((group) => (
                      <tr key={`${group.hostId}-${group.role}-${group.stage}-${group.endpoint}`} className="border-t align-top">
                        <td className="px-3 py-2">
                          <div className="font-medium">{group.hostName}</div>
                          <div className="text-xs text-muted-foreground">{connRoleLabel(group.role)}</div>
                        </td>
                        <td className="px-3 py-2">{connStageLabel(group.stage)}</td>
                        <td className="px-3 py-2">
                          <div className="font-mono text-xs">{group.endpoint}</div>
                          {group.lastError ? <div className="mt-0.5 text-xs text-[var(--fx-down-text)]">最近失败：{group.lastError}</div> : null}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{group.summary.attempts}</td>
                        <td className={`px-3 py-2 text-right font-medium tabular-nums ${rateClass(group.summary.successRate)}`}>
                          {group.summary.successRate === null ? "—" : `${group.summary.successRate}%`}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{group.stage === "pool" ? "—" : formatMs(group.summary.avgMs)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{group.stage === "pool" ? "—" : formatMs(group.summary.p50Ms)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{group.stage === "pool" ? "—" : formatMs(group.summary.p95Ms)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{group.stage === "pool" ? "—" : formatMs(group.summary.maxMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {stagesWithData.length > 0 ? (
              <div className="space-y-2">
                <div className="text-sm font-medium">每小时成功率</div>
                {stagesWithData.map((stage) => {
                  const rows = data.hourly.filter((row) => row.stage === stage.key);
                  return (
                    <div key={stage.key} className="flex items-center gap-3">
                      <div className="w-20 shrink-0 text-xs text-muted-foreground">{stage.label}</div>
                      <div className="flex h-5 min-w-0 flex-1 items-stretch gap-px" role="img" aria-label={`${stage.label}每小时成功率`}>
                        {rows.map((row) => (
                          <div
                            key={row.hourAt}
                            className={`min-w-[2px] flex-1 rounded-[1px] ${rateBarClass(row.summary.successRate)}`}
                            title={`${new Date(row.hourAt * 1000).toLocaleString()}：${row.summary.successRate ?? "—"}%，${row.summary.attempts} 次，平均 ${formatMs(row.summary.avgMs)}`}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
    </div>
  );
}
