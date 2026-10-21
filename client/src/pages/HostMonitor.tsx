import { resolveSiteTitle } from "@shared/brand";
import { readStoredViewMode, writeStoredViewMode } from "@/lib/viewModeStorage";
import OpsPublicMonitorExtras from "@/features/ops/slots/PublicMonitorExtras";
import DataSectionLoading from "@/components/DataSectionLoading";
import { formatMetricSizeDetail } from "@/lib/formatMetricSize";
import { LatencyPeakCutToggle } from "@/components/LatencyPeakCutToggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ArrowLeftCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarDays,
  Clock,
  Cpu,
  HardDrive,
  LayoutGrid,
  LayoutDashboard,
  List,
  Loader2,
  MemoryStick,
  Monitor,
  Rows3,
  Server,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Link, useLocation } from "wouter";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatBytes,
  formatCpuPercent,
  formatUptime,
  HostRegionBadge,
  metricUsageProgressClass,
} from "@/components/hosts/hostDisplay";
import { applyLatencyPeakCut, getLatencyYAxisTicks, normalizeLatencyProbeCounts } from "@/lib/latencyChart";
import { cn } from "@/lib/utils";
import NotFound from "@/pages/NotFound";
import EmptyState from "@/components/EmptyState";
import { EntityCard } from "@/components/entity/EntityCard";
import { SummaryStrip } from "@/components/entity/SummaryStrip";
import { StatusDot } from "@/components/network/StatusDot";

type HostMonitorViewMode = "card" | "compact-card" | "table";

const HOST_MONITOR_VIEW_MODE_STORAGE_KEY = "forwardx.publicHostMonitor.viewMode";
const serviceChartColors = ["var(--color-primary)", "#16a34a", "#d97706", "#dc2626", "#0d9488", "#be123c", "#f97316", "#64748b"];

function getStoredHostMonitorViewMode(): HostMonitorViewMode {
  return readStoredViewMode<HostMonitorViewMode>(HOST_MONITOR_VIEW_MODE_STORAGE_KEY, ["compact-card", "table", "card"], "card");
}

function storeHostMonitorViewMode(viewMode: HostMonitorViewMode) {
  writeStoredViewMode(HOST_MONITOR_VIEW_MODE_STORAGE_KEY, viewMode);
}

function formatNetworkSpeed(value: number | null | undefined) {
  if (value == null) return "--/s";
  return `${formatBytes(Math.max(0, Number(value) || 0)).replace(" ", "\u00a0")}/s`;
}

function formatOptionalBytesPerSecond(value: unknown) {
  if (value === null || value === undefined) return "--";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  return formatNetworkSpeed(bytes);
}

function formatPercent(value: unknown) {
  const num = Math.round(Number(value) || 0);
  return `${Math.max(0, Math.min(999, num))}%`;
}

function clampPercent(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function formatUsagePercent(value: unknown) {
  const percent = clampPercent(value);
  return percent === null ? "--" : `${percent}%`;
}

function formatFullDateTime(value: unknown) {
  if (!value) return "--";
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? (value > 0 && value < 10_000_000_000 ? value * 1000 : value)
      : Date.parse(String(value));
  if (!Number.isFinite(ms)) return "--";
  const date = new Date(ms);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function formatMonitorDate(value: unknown) {
  if (!value) return "永久有效";
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? (value > 0 && value < 10_000_000_000 ? value * 1000 : value)
      : Date.parse(String(value));
  if (!Number.isFinite(ms)) return "--";
  const date = new Date(ms);
  const text = date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  return ms < Date.now() ? `${text} 已到期` : text;
}

function formatChartTime(value: string | Date | number) {
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function calculateMonitorSummary(hosts: any[], metricsByHostId: Map<number, any>, trafficByHostId: Map<number, any>) {
  let currentTrafficIn = 0;
  let currentTrafficOut = 0;
  let totalTrafficIn = 0;
  let totalTrafficOut = 0;
  for (const host of hosts) {
    const hostId = Number(host.id);
    const metric = metricsByHostId.get(hostId);
    const traffic = trafficByHostId.get(hostId);
    /*
      瞬时速率只算在线的：离线机器的速率是掉线前最后两次采样算出来的，冻在那儿不动。
      原来一起加进「当前瞬时流量」—— 4 台全离线，页头照样写着 12.49 MB/s。
      累计流量是累计量，掉线不影响它，照常加。
    */
    if (host.isOnline) {
      currentTrafficIn += Math.max(0, Number(metric?.networkSpeedIn) || 0);
      currentTrafficOut += Math.max(0, Number(metric?.networkSpeedOut) || 0);
    }
    totalTrafficIn += Math.max(0, Number(traffic?.bytesIn) || 0);
    totalTrafficOut += Math.max(0, Number(traffic?.bytesOut) || 0);
  }
  return {
    totalHosts: hosts.length,
    onlineHosts: hosts.filter((host) => !!host.isOnline).length,
    currentTrafficIn,
    currentTrafficOut,
    totalTrafficIn,
    totalTrafficOut,
  };
}

function normalizeMonitorPathFromLocation(location: string) {
  return String(location || "/")
    .split("?")[0]
    .split("#")[0]
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase() || "dev";
}

function PublicHostCard({
  host,
  metric,
  traffic,
  compact = false,
  onSelect,
}: {
  host: any;
  metric: any;
  traffic: any;
  compact?: boolean;
  onSelect?: (host: any) => void;
}) {
  const isOnline = !!host.isOnline;
  const cpuUsage = Number(metric?.cpuUsage ?? 0);
  const memoryUsage = Number(metric?.memoryUsage ?? 0);
  const diskUsage = Number(metric?.diskUsage ?? 0);
  const totalIn = traffic?.bytesIn == null ? 0 : Number(traffic.bytesIn) || 0;
  const totalOut = traffic?.bytesOut == null ? 0 : Number(traffic.bytesOut) || 0;
  const trafficLimit = Math.max(0, Number(host.trafficLimit || 0));
  const trafficMode = host.trafficMeasureMode === "outbound" || host.trafficMeasureMode === "max" ? host.trafficMeasureMode : "both";
  const usedTraffic = trafficMode === "outbound"
    ? totalOut
    : trafficMode === "max"
      ? Math.max(totalIn, totalOut)
      : totalIn + totalOut;
  const trafficPercent = trafficLimit > 0 ? Math.round((usedTraffic / trafficLimit) * 100) : 0;
  /*
    离线主机的 CPU / 内存 / 磁盘不显示数：一台离线的机器 CPU 不是 18%，是不知道（主机管理页
    2.3.368 就这么改了，这一页原来没跟上 —— 离线的卡上照样写着 18%、42%）。流量是累计量，
    掉线不影响它，照常显示。
  */
  const metricItems = [
    { key: "cpu", label: "CPU", icon: Cpu, value: isOnline ? cpuUsage : undefined, progress: isOnline ? cpuUsage : 0 },
    { key: "memory", label: "内存", icon: MemoryStick, value: isOnline ? memoryUsage : undefined, progress: isOnline ? memoryUsage : 0 },
    { key: "disk", label: "磁盘", icon: HardDrive, value: isOnline ? diskUsage : undefined, progress: isOnline ? diskUsage : 0 },
    { key: "traffic", label: "流量", icon: Activity, value: trafficLimit > 0 ? trafficPercent : null, progress: trafficLimit > 0 ? trafficPercent : 0 },
  ];

  /*
    原来一张卡里套四层小框（名字一框、四根进度条一框、入站出站各一框、累计和到期各一框），
    外面还有悬停上浮加投影。现在是一块白：名字那一行、四根进度条、下面一张两列的小表。
  */
  return (
    <EntityCard
      interactive={!!onSelect}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={() => onSelect?.(host)}
      onKeyDown={(event) => {
        if (!onSelect) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(host);
        }
      }}
      className={cn(compact ? "gap-2 p-3" : "gap-3 p-[var(--fx-card-padding)]", onSelect && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot health={isOnline ? "healthy" : "down"} label={isOnline ? "在线" : "离线"} />
          <span className="min-w-0 truncate text-primary-type font-medium text-foreground" title={host.name}>{host.name || "-"}</span>
          <span className="shrink-0 font-mono text-meta text-muted-foreground">{host.agentVersion ? `v${host.agentVersion}` : "未上报"}</span>
          <span className={cn("ml-auto shrink-0 text-meta font-medium", isOnline ? "text-[var(--fx-healthy-text)]" : "text-[var(--fx-down-text)]")}>
            {isOnline ? "在线" : "离线"}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 pl-4 text-meta text-muted-foreground">
          <HostRegionBadge host={host} compact />
        </div>
      </div>

      <div className={compact ? "space-y-1.5" : "space-y-2"}>
        {metricItems.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.key} className="grid grid-cols-[18px_minmax(0,1fr)_52px] items-center gap-2 text-meta">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-label={item.label} />
              <Progress value={item.progress} className={metricUsageProgressClass(item.progress, isOnline)} />
              <span className="text-right font-medium tabular-nums">
                {item.value === undefined ? "—" : item.value == null ? "∞" : item.key === "cpu" ? formatCpuPercent(item.value, isOnline) : formatPercent(item.value)}
              </span>
            </div>
          );
        })}
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-[var(--fx-stroke-weak)] pt-2 text-meta">
        <dt className="text-muted-foreground" title={isOnline ? "当前瞬时流量" : "最后一次上报时的瞬时流量 —— 机器已离线，这不是现在的速率"}>
          {isOnline ? "当前" : "最后一次"}
        </dt>
        <dd className="truncate text-right tabular-nums text-foreground">
          入 {formatNetworkSpeed(metric?.networkSpeedIn)} · 出 {formatNetworkSpeed(metric?.networkSpeedOut)}
        </dd>
        <dt className="text-muted-foreground">累计</dt>
        <dd className="truncate text-right tabular-nums text-foreground" title={`入 ${formatBytes(totalIn)} / 出 ${formatBytes(totalOut)}`}>
          入 {formatBytes(totalIn)} · 出 {formatBytes(totalOut)}
        </dd>
        <dt className="text-muted-foreground">到期</dt>
        <dd className="truncate text-right tabular-nums text-foreground" title={formatMonitorDate(host.stoppedAt)}>{formatMonitorDate(host.stoppedAt)}</dd>
        <dt className="text-muted-foreground">{isOnline ? "运行时间" : "离线前运行"}</dt>
        <dd className="truncate text-right tabular-nums text-foreground">{metric?.uptime == null ? "-" : formatUptime(metric.uptime)}</dd>
      </dl>
    </EntityCard>
  );
}

function PublicHostListResourceMetric({
  icon: Icon,
  label,
  value,
  detail,
  isOnline,
  formatValue = formatUsagePercent,
}: {
  icon: LucideIcon;
  label: string;
  value: unknown;
  detail?: string;
  isOnline: boolean;
  /** CPU 用它把在线时的 0 写成「<1%」（Agent 按整数上报，0 其实是不到 0.5%） */
  formatValue?: (value: unknown) => string;
}) {
  const percent = clampPercent(value);
  const progressValue = percent ?? 0;
  const progressClass = percent === null
    ? "h-1.5 bg-muted [&>div]:bg-muted-foreground/20"
    : metricUsageProgressClass(progressValue, isOnline);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{label}</span>
        <span className="ml-auto font-semibold tabular-nums text-foreground">{formatValue(value)}</span>
      </div>
      <Progress value={progressValue} className={progressClass} />
      {detail && (
        <div className="truncate text-[10px] leading-none text-muted-foreground" title={detail}>
          {detail}
        </div>
      )}
    </div>
  );
}

function PublicHostListFlowPair({
  inValue,
  outValue,
  inTitle,
  outTitle,
}: {
  inValue: string;
  outValue: string;
  inTitle?: string;
  outTitle?: string;
}) {
  return (
    <div className="min-w-0 space-y-1 text-xs tabular-nums">
      <div className="flex items-center gap-1.5 text-[var(--fx-healthy-text)]" title={inTitle || inValue}>
        <ArrowDownToLine className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{inValue}</span>
      </div>
      <div className="flex items-center gap-1.5 text-primary" title={outTitle || outValue}>
        <ArrowUpFromLine className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{outValue}</span>
      </div>
    </div>
  );
}

function PublicHostTable({
  hosts,
  metricsByHostId,
  trafficByHostId,
  onSelectHost,
}: {
  hosts: any[];
  metricsByHostId: Map<number, any>;
  trafficByHostId: Map<number, any>;
  onSelectHost?: (host: any) => void;
}) {
  return (
    <Card className="border-border bg-card">
      <CardContent className="p-0">
        <Table className="min-w-0 table-fixed">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[76px] whitespace-nowrap px-3">状态</TableHead>
              <TableHead className="w-[230px] px-3">设备名称</TableHead>
              <TableHead className="w-[112px] whitespace-nowrap px-3">CPU</TableHead>
              <TableHead className="w-[116px] whitespace-nowrap px-3">RAM</TableHead>
              <TableHead className="w-[116px] whitespace-nowrap px-3">磁盘</TableHead>
              <TableHead className="w-[118px] whitespace-nowrap px-3">累计流量</TableHead>
              <TableHead className="w-[118px] whitespace-nowrap px-3">实时网络</TableHead>
              <TableHead className="w-[136px] whitespace-nowrap px-3">时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hosts.map((host) => {
              const metric = metricsByHostId.get(Number(host.id));
              const traffic = trafficByHostId.get(Number(host.id));
              const isOnline = !!host.isOnline;
              // 离线主机的 CPU / RAM / Disk 不给数（不是 0%，是不知道）；速率照留，悬停说明是掉线前最后一次的。
              const memoryDetail = formatMetricSizeDetail(metric?.memoryUsed, host.memoryTotal);
              const diskDetail = formatMetricSizeDetail(metric?.diskUsed, metric?.diskTotal);
              return (
                <TableRow
                  key={host.id}
                  className="h-[76px] cursor-pointer align-middle hover:bg-muted/25"
                  onClick={() => onSelectHost?.(host)}
                >
                  <TableCell className="w-[76px] whitespace-nowrap px-3 py-3">
                    <Badge variant="outline" className={`gap-1.5 text-xs ${isOnline ? "border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] text-[var(--fx-healthy-text)]" : "border-destructive/30 text-destructive"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${isOnline ? "bg-[var(--fx-healthy)]" : "bg-destructive"}`} />
                      {isOnline ? "在线" : "离线"}
                    </Badge>
                  </TableCell>
                  <TableCell className="w-[230px] px-3 py-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-semibold" title={host.name}>{host.name || "-"}</span>
                        <span className="shrink-0 rounded border border-border/50 bg-muted/35 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                          {host.agentVersion ? `v${host.agentVersion}` : "未上报"}
                        </span>
                      </div>
                      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="shrink-0">国家/地区：</span>
                        <HostRegionBadge host={host} compact />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="px-3 py-3">
                    <PublicHostListResourceMetric
                      icon={Cpu}
                      label="CPU"
                      value={isOnline ? metric?.cpuUsage : undefined}
                      isOnline={isOnline}
                      formatValue={(value) => (clampPercent(value) === null ? "--" : formatCpuPercent(value, isOnline))}
                    />
                  </TableCell>
                  <TableCell className="px-3 py-3">
                    <PublicHostListResourceMetric icon={MemoryStick} label="RAM" value={isOnline ? metric?.memoryUsage : undefined} detail={isOnline ? memoryDetail : undefined} isOnline={isOnline} />
                  </TableCell>
                  <TableCell className="px-3 py-3">
                    <PublicHostListResourceMetric icon={HardDrive} label="Disk" value={isOnline ? metric?.diskUsage : undefined} detail={isOnline ? diskDetail : undefined} isOnline={isOnline} />
                  </TableCell>
                  <TableCell className="px-3 py-3">
                    <PublicHostListFlowPair
                      inValue={formatBytes(Number(traffic?.bytesIn || 0))}
                      outValue={formatBytes(Number(traffic?.bytesOut || 0))}
                      inTitle={`累计入向：${formatBytes(Number(traffic?.bytesIn || 0))}`}
                      outTitle={`累计出向：${formatBytes(Number(traffic?.bytesOut || 0))}`}
                    />
                  </TableCell>
                  <TableCell className="px-3 py-3">
                    <PublicHostListFlowPair
                      inValue={formatOptionalBytesPerSecond(metric?.networkSpeedIn)}
                      outValue={formatOptionalBytesPerSecond(metric?.networkSpeedOut)}
                      inTitle={isOnline ? "实时入向" : "最后一次上报时的入向速率 —— 机器已离线，这不是现在的速率"}
                      outTitle={isOnline ? "实时出向" : "最后一次上报时的出向速率 —— 机器已离线，这不是现在的速率"}
                    />
                  </TableCell>
                  <TableCell className="px-3 py-3">
                    <div className="space-y-1.5 text-xs font-medium tabular-nums text-muted-foreground">
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <Clock className="h-3.5 w-3.5" />
                      {metric?.uptime == null ? "-" : formatUptime(metric.uptime)}
                    </div>
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <CalendarDays className="h-3.5 w-3.5" />
                      {formatMonitorDate(host.stoppedAt)}
                    </div>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ServiceChartTooltip({ active, payload, label, services }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload || {};
  return (
    <div className="pointer-events-none rounded-md border border-border bg-card px-3 py-2 shadow-md">
      <p className="mb-1 text-xs text-muted-foreground">{point.fullLabel || label}</p>
      <div className="space-y-1">
        {services.map((service: any, index: number) => {
          const raw = point[`service_${service.id}Raw`];
          const counts = normalizeLatencyProbeCounts(raw);
          return (
            <div key={service.id} className="flex min-w-[180px] items-center justify-between gap-4 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: serviceChartColors[index % serviceChartColors.length] }} />
                <span className="truncate">{service.name}</span>
              </span>
              <span className="text-right">
                <span className={counts.isTimeout ? "font-medium text-destructive" : "font-semibold tabular-nums"}>
                  {counts.isTimeout ? "超时" : typeof raw?.latencyMs === "number" ? `${raw.latencyMs}ms` : "--"}
                </span>
                {counts.probeCount > 1 && counts.probeSuccesses < counts.probeCount ? (
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    丢包 {counts.probeCount - counts.probeSuccesses}/{counts.probeCount}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildServiceLatencyChart(series: any[], services: any[]) {
  const serviceIds = new Set(services.map((service) => Number(service.id)));
  const buckets = new Map<number, any>();
  for (const row of series) {
    const serviceId = Number(row.serviceId);
    if (!serviceIds.has(serviceId)) continue;
    const at = new Date(row.recordedAt).getTime();
    if (!Number.isFinite(at)) continue;
    const bucket = Math.floor(at / 60000) * 60000;
    const key = `service_${serviceId}`;
    const point = buckets.get(bucket) || {
      at: bucket,
      label: formatChartTime(bucket),
      fullLabel: formatFullDateTime(bucket),
    };
    const counts = normalizeLatencyProbeCounts(row);
    const isTimeout = counts.isTimeout;
    const latency = isTimeout ? null : Number(row.latencyMs);
    point[key] = isTimeout ? 0 : Number.isFinite(latency) ? latency : null;
    point[`${key}Timeout`] = isTimeout;
    point[`${key}Raw`] = {
      latencyMs: Number.isFinite(latency) ? latency : null,
      isTimeout,
      probeCount: counts.probeCount,
      probeSuccesses: counts.probeSuccesses,
    };
    buckets.set(bucket, point);
  }
  return Array.from(buckets.values()).sort((a, b) => a.at - b.at);
}

function DetailInfoItem({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className={`min-w-0 rounded-lg border border-border/30 bg-card/35 px-3 py-2 sm:border-0 sm:bg-transparent sm:p-0 ${className}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold tabular-nums" title={value}>{value}</p>
    </div>
  );
}

function HostMonitorDetail({
  path,
  host,
  fallbackMetric,
  fallbackTraffic,
  onBack,
}: {
  path: string;
  host: any;
  fallbackMetric: any;
  fallbackTraffic: any;
  onBack: () => void;
}) {
  const hostId = Number(host?.id || 0);
  const detail = trpc.hosts.publicMonitorHostDetail.useQuery(
    { path, hostId, hours: 24 },
    {
      enabled: hostId > 0,
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: pollingInterval("slow", hostId > 0),
    },
  );
  const detailHost = detail.data?.host || host;
  const metric = detail.data?.metric || fallbackMetric || {};
  const traffic = detail.data?.traffic || fallbackTraffic || {};
  const services = (detail.data?.services || []) as any[];
  const series = (detail.data?.serviceSeries || []) as any[];
  const isOnline = !!detailHost?.isOnline;
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<number>>(new Set());
  const [peakCutEnabled, setPeakCutEnabled] = useState(false);
  const visibleServices = useMemo(() => {
    if (selectedServiceIds.size === 0) return services;
    return services.filter((service) => selectedServiceIds.has(Number(service.id)));
  }, [selectedServiceIds, services]);
  const visibleServiceIds = useMemo(
    () => visibleServices.map((service) => Number(service.id)).filter(Boolean),
    [visibleServices],
  );
  const rawChart = useMemo(() => buildServiceLatencyChart(series, services), [series, services]);
  const chart = useMemo(() => {
    if (!peakCutEnabled || visibleServiceIds.length === 0) return rawChart;
    const smoothed = applyLatencyPeakCut(
      rawChart,
      visibleServiceIds.map((id) => ({
        dataKey: `service_${id}`,
        timeoutKey: `service_${id}Timeout`,
      })),
    );
    return smoothed.map((point) => {
      let next = point;
      for (const id of visibleServiceIds) {
        const key = `service_${id}`;
        const rawKey = `${key}Raw`;
        const raw = (next as any)[rawKey];
        const latency = Number((next as any)[key]);
        if (raw && !raw.isTimeout && Number.isFinite(latency) && latency > 0 && raw.latencyMs !== latency) {
          next = {
            ...next,
            [rawKey]: { ...raw, latencyMs: Math.round(latency) },
          };
        }
      }
      return next;
    });
  }, [peakCutEnabled, rawChart, visibleServiceIds]);
  const yMax = useMemo(() => {
    const values = chart.flatMap((point) => visibleServices.map((service) => Number(point[`service_${service.id}`]) || 0));
    const max = Math.max(0, ...values);
    return max > 0 ? Math.ceil(max * 1.2) : 120;
  }, [chart, visibleServices]);
  const yTicks = useMemo(() => getLatencyYAxisTicks(yMax), [yMax]);
  const totalIn = Number(traffic?.bytesIn || 0);
  const totalOut = Number(traffic?.bytesOut || 0);
  const toggleService = (serviceId: number) => {
    setSelectedServiceIds((current) => {
      const next = new Set(current);
      if (next.has(serviceId)) next.delete(serviceId);
      else next.add(serviceId);
      return next;
    });
  };

  return (
    <div className="animate-in fade-in-0 slide-in-from-right-2 duration-200">
      <div className="mb-4 flex min-w-0 items-center gap-2 sm:mb-6">
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-full" onClick={onBack} title="返回">
          <ArrowLeftCircle className="h-5 w-5" />
        </Button>
        <h2 className="min-w-0 truncate text-lg font-bold tracking-tight sm:text-xl">{detailHost?.name || "主机详情"}</h2>
        <Badge variant="outline" className={`ml-auto shrink-0 gap-1.5 sm:ml-2 ${isOnline ? "border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] text-[var(--fx-healthy-text)]" : "border-destructive/30 text-destructive"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${isOnline ? "bg-[var(--fx-healthy)]" : "bg-destructive"}`} />
          {isOnline ? "在线" : "离线"}
        </Badge>
      </div>

      <div className="grid max-w-6xl grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-x-8 sm:gap-y-4 lg:grid-cols-6">
        <DetailInfoItem label="状态" value={isOnline ? "在线" : "离线"} className={isOnline ? "text-[var(--fx-healthy-text)]" : "text-destructive"} />
        <DetailInfoItem label="运行时间" value={metric?.uptime == null ? "-" : formatUptime(metric.uptime)} />
        <DetailInfoItem label="内存" value={formatMetricSizeDetail(metric?.memoryUsed, detailHost?.memoryTotal) || formatUsagePercent(metric?.memoryUsage)} />
        <DetailInfoItem label="磁盘" value={formatMetricSizeDetail(metric?.diskUsed, metric?.diskTotal) || formatUsagePercent(metric?.diskUsage)} />
        <div className="min-w-0 rounded-lg border border-border/30 bg-card/35 px-3 py-2 sm:border-0 sm:bg-transparent sm:p-0">
          <p className="text-xs text-muted-foreground">区域</p>
          <div className="mt-1"><HostRegionBadge host={detailHost} compact /></div>
        </div>
        <DetailInfoItem label="版本" value={detailHost?.agentVersion ? `v${detailHost.agentVersion}` : "未上报"} />
        <DetailInfoItem label="实时入站" value={formatOptionalBytesPerSecond(metric?.networkSpeedIn)} />
        <DetailInfoItem label="实时出站" value={formatOptionalBytesPerSecond(metric?.networkSpeedOut)} />
        <DetailInfoItem label="累计入站" value={formatBytes(totalIn)} />
        <DetailInfoItem label="累计出站" value={formatBytes(totalOut)} />
        <DetailInfoItem label="到期时间" value={formatMonitorDate(detailHost?.stoppedAt)} />
        <DetailInfoItem label="最后上报" value={formatFullDateTime(metric?.recordedAt || detailHost?.lastHeartbeat)} />
      </div>

      <div className="my-5 h-px bg-border sm:my-7" />

        <Card className="overflow-hidden border-border bg-card">
          <CardContent className="p-0">
            {services.length > 0 && (
              <div className="grid min-w-0 overflow-hidden border-b border-border/40 md:grid-cols-[minmax(0,180px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
                <div className="flex min-h-[72px] min-w-0 flex-row items-center justify-between gap-3 overflow-hidden border-b border-border/40 p-3 md:min-h-[92px] md:flex-col md:items-start md:justify-center md:border-b-0 md:border-r md:p-4">
                  <div className="min-w-0 flex-1 overflow-hidden md:w-full md:flex-none">
                    <p className="block max-w-full truncate text-base font-bold md:text-lg" title={detailHost?.name || "主机"}>{detailHost?.name || "主机"}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{services.length} 个监控服务</p>
                  </div>
                  <button
                    type="button"
                    className="inline-flex w-fit shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40 md:mt-2"
                    onClick={() => setSelectedServiceIds(new Set())}
                    disabled={selectedServiceIds.size === 0}
                  >
                    <X className="h-3.5 w-3.5" />
                    清除筛选
                  </button>
                </div>
                <div className="grid min-w-0 grid-cols-2 overflow-hidden xl:grid-cols-4">
                  {services.map((service, index) => {
                    const serviceId = Number(service.id);
                    const active = selectedServiceIds.size === 0 || selectedServiceIds.has(serviceId);
                    const latest = service.latest;
                    const timeout = !!latest?.isTimeout;
                    const latency = latest?.latencyMs == null ? "--" : `${latest.latencyMs}ms`;
                    return (
                      <button
                        key={service.id}
                        type="button"
                        className={cn(
                          "min-h-[84px] min-w-0 overflow-hidden border-b border-r border-border/40 p-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 odd:last:border-r-0 sm:min-h-[92px] sm:p-4 sm:last:border-r-0",
                          active ? "bg-background/20" : "bg-muted/20 opacity-50",
                        )}
                        onClick={() => toggleService(serviceId)}
                        aria-pressed={active}
                        title={active ? "点击取消筛选" : "点击筛选该服务"}
                      >
                        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: serviceChartColors[index % serviceChartColors.length] }} />
                          <span className="min-w-0 truncate" title={service.name}>{service.name}</span>
                        </div>
                        <p className={`mt-2 text-xl font-bold tabular-nums sm:text-2xl ${timeout ? "text-destructive" : ""}`}>{timeout ? "超时" : latency}</p>
                        <p className="mt-1 truncate text-[11px] text-muted-foreground sm:text-xs">{latest?.recordedAt ? formatFullDateTime(latest.recordedAt) : "暂无上报"}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3 px-3 pt-3 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:pt-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">服务延迟趋势</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {selectedServiceIds.size > 0 ? `已筛选 ${visibleServices.length} 个服务` : "点击上方服务可筛选图表"}
                </p>
              </div>
              <LatencyPeakCutToggle id={`public-host-service-peak-cut-${hostId || "current"}`} checked={peakCutEnabled} onCheckedChange={setPeakCutEnabled} className="shrink-0" />
            </div>

            <div className="h-[280px] p-3 sm:h-[360px] sm:p-4">
              {detail.isLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在加载服务监控
                </div>
              ) : services.length === 0 || chart.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无服务监控延迟数据</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={42} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}ms`} width={58} domain={[0, yMax]} ticks={yTicks} allowDecimals={false} />
                    <RTooltip content={<ServiceChartTooltip services={visibleServices} />} cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }} />
                    {visibleServices.map((service, index) => (
                      <Line
                        key={service.id}
                        type="monotone"
                        dataKey={`service_${service.id}`}
                        name={service.name}
                        stroke={serviceChartColors[index % serviceChartColors.length]}
                        strokeWidth={1.25}
                        dot={false}
                        connectNulls={false}
                        activeDot={{ r: 3 }}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
    </div>
  );
}

export default function HostMonitor() {
  const [location] = useLocation();
  const path = normalizeMonitorPathFromLocation(location);
  const [viewMode, setViewMode] = useState<HostMonitorViewMode>(() => getStoredHostMonitorViewMode());
  const [selectedGroupId, setSelectedGroupId] = useState("all");
  const [selectedHostId, setSelectedHostId] = useState<number | null>(null);
  const currentUser = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const publicInfo = trpc.system.publicInfo.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const monitor = trpc.hosts.publicMonitor.useQuery(
    { path },
    {
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: pollingInterval("active"),
    },
  );
  const metricsByHostId = useMemo(() => {
    const map = new Map<number, any>();
    for (const row of (monitor.data?.metrics || []) as any[]) map.set(Number(row.hostId), row);
    return map;
  }, [monitor.data?.metrics]);
  const trafficByHostId = useMemo(() => {
    const map = new Map<number, any>();
    for (const row of (monitor.data?.traffic || []) as any[]) map.set(Number(row.hostId), row);
    return map;
  }, [monitor.data?.traffic]);

  const hosts = (monitor.data?.hosts || []) as any[];
  const groups = (monitor.data?.groups || []) as any[];
  const activeGroup = groups.find((group) => String(group.id) === selectedGroupId);
  const activeGroupId = selectedGroupId === "all" || activeGroup ? selectedGroupId : "all";
  const visibleHosts = useMemo(() => {
    if (activeGroupId === "all") return hosts;
    const hostIds = new Set((activeGroup?.hostIds || []).map((id: unknown) => Number(id)));
    return hosts.filter((host) => hostIds.has(Number(host.id)));
  }, [activeGroup?.hostIds, activeGroupId, hosts]);
  const summary = useMemo(
    () => calculateMonitorSummary(visibleHosts, metricsByHostId, trafficByHostId),
    [metricsByHostId, trafficByHostId, visibleHosts],
  );
  const onlineCount = summary.onlineHosts;
  const totalCount = summary.totalHosts;
  const isLoggedIn = !!currentUser.data;
  const monitorTitle = publicInfo.data?.publicHostMonitor?.title?.trim()
    || `${resolveSiteTitle(publicInfo.data?.siteTitle)} 主机监控`;
  const selectedHost = selectedHostId ? hosts.find((host) => Number(host.id) === selectedHostId) || null : null;
  const handleViewModeChange = (mode: HostMonitorViewMode) => {
    setViewMode(mode);
    storeHostMonitorViewMode(mode);
  };

  if (monitor.isError) return <NotFound />;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border/50 bg-card/70 text-primary">
              <Monitor className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">{monitorTitle}</h1>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!selectedHost && <ViewModeToggle className="flex"
              value={viewMode}
              onChange={handleViewModeChange}
              items={[
                { value: "compact-card", label: "精简卡片", icon: Rows3 },
                { value: "card", label: "标准卡片", icon: LayoutGrid },
                { value: "table", label: "列表视图", icon: List },
              ]}
            />}
            <Button asChild size="sm" className="gap-2">
              <Link href={isLoggedIn ? "/hosts" : "/login"}>
                <LayoutDashboard className="h-4 w-4" />
                {isLoggedIn ? "进入后台" : "登录"}
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-4 py-5 sm:px-6">
        {monitor.isLoading && !monitor.data ? (
          <DataSectionLoading label="正在加载主机监控" minHeight="min-h-[320px]" />
        ) : selectedHost ? (
          <HostMonitorDetail
            path={path}
            host={selectedHost}
            fallbackMetric={metricsByHostId.get(Number(selectedHost.id))}
            fallbackTraffic={trafficByHostId.get(Number(selectedHost.id))}
            onBack={() => setSelectedHostId(null)}
          />
        ) : (
          <>
            <OpsPublicMonitorExtras path={path} />
            {/*
              原来是三张统计卡，各带一个彩色图标方块 —— 「在线状态 0 / 4」旁边是一个绿色的对勾，
              4 台全离线也是绿的。颜色只说状态：一台都不在线是红，部分在线是琥珀，全在线才是绿。
            */}
            <SummaryStrip
              ariaLabel="主机监控概览"
              items={[
                {
                  key: "online",
                  label: "在线",
                  value: `${onlineCount} / ${totalCount}`,
                  hint: totalCount - onlineCount > 0 ? `离线 ${Math.max(0, totalCount - onlineCount)} 台` : "全部在线",
                  tone: totalCount === 0 ? undefined : onlineCount === 0 ? "down" : onlineCount < totalCount ? "warn" : "healthy",
                },
                {
                  key: "speed",
                  label: "当前瞬时流量",
                  value: `入 ${formatNetworkSpeed(summary?.currentTrafficIn)}`,
                  /*
                    「只算在线的 N 台」在手机上放不下（三格一行，一格不到 100px），截断成「只算…」
                    反而让人疑惑；手机上只留出向，旁边那格已经写着离线几台。整句放进 title。
                  */
                  hint: (
                    <>
                      出 {formatNetworkSpeed(summary?.currentTrafficOut)}
                      {totalCount - onlineCount > 0 ? <span className="hidden sm:inline"> · 只算在线的 {onlineCount} 台</span> : null}
                    </>
                  ),
                  title: totalCount - onlineCount > 0 ? `离线的 ${totalCount - onlineCount} 台不算：它们的速率是掉线前最后一次的，不是现在的` : undefined,
                },
                {
                  key: "total",
                  label: "累计流量",
                  value: `入 ${formatBytes(summary?.totalTrafficIn || 0)}`,
                  hint: `出 ${formatBytes(summary?.totalTrafficOut || 0)}`,
                },
              ]}
            />

            <div className="flex min-h-9 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 gap-2 overflow-x-auto pb-1 sm:pb-0">
                <Button
                  type="button"
                  variant={activeGroupId === "all" ? "secondary" : "outline"}
                  size="sm"
                  className="shrink-0"
                  onClick={() => setSelectedGroupId("all")}
                >
                  全部
                  <span className="ml-1 text-xs text-muted-foreground">{hosts.length}</span>
                </Button>
                {groups.map((group) => (
                  <Button
                    key={group.id}
                    type="button"
                    variant={activeGroupId === String(group.id) ? "secondary" : "outline"}
                    size="sm"
                    className="shrink-0"
                    onClick={() => setSelectedGroupId(String(group.id))}
                  >
                    {group.name}
                    <span className="ml-1 text-xs text-muted-foreground">{group.hostIds?.length || 0}</span>
                  </Button>
                ))}
              </div>
              <div
                className={`flex h-5 items-center justify-end gap-2 text-xs text-muted-foreground transition-opacity ${monitor.isFetching && monitor.data ? "opacity-100" : "opacity-0"}`}
                aria-hidden={!(monitor.isFetching && monitor.data)}
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在刷新
              </div>
            </div>

            {visibleHosts.length > 0 ? (
              viewMode === "table" ? (
                <PublicHostTable
                  hosts={visibleHosts}
                  metricsByHostId={metricsByHostId}
                  trafficByHostId={trafficByHostId}
                  onSelectHost={(host) => setSelectedHostId(Number(host.id))}
                />
              ) : (
              <div
                className={
                  viewMode === "compact-card"
                    ? "standard-card-grid-compact host-card-grid-static host-card-grid-static-compact gap-3"
                    : "standard-card-grid host-card-grid-static host-card-grid-static-standard gap-4"
                }
              >
                {visibleHosts.map((host) => (
                  <PublicHostCard
                    key={host.id}
                    host={host}
                    metric={metricsByHostId.get(Number(host.id))}
                    traffic={trafficByHostId.get(Number(host.id))}
                    compact={viewMode === "compact-card"}
                    onSelect={(nextHost) => setSelectedHostId(Number(nextHost.id))}
                  />
                ))}
              </div>
              )
            ) : (
              <EmptyState className="min-h-[240px]" icon={<Server />} title="暂无主机" description="后台添加主机后会在这里展示。" />
            )}
          </>
        )}
      </main>
    </div>
  );
}
