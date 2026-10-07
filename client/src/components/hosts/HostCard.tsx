import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Clock,
  Cpu,
  Download,
  Gauge,
  HardDrive,
  RotateCcw,
  Coins,
  Loader2,
  MemoryStick,
  Monitor,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, type ReactNode } from "react";
import { hostBillingBadge } from "@shared/hostBillingBadge";
import {
  HOST_TRAFFIC_MEASURE_MODE_LABELS,
  hostTrafficPercent,
  hostTrafficUsedBytes,
  normalizeHostTrafficMeasureMode,
} from "@shared/hostTrafficQuota";
import { parseHostOs } from "@shared/hostOs";
import { HostOsGlyph } from "./HostOsBadge";
import { FxpRuntimeBadge } from "./FxpRuntimeBadge";
import { hostEgressShapingCardText } from "./hostEgressShaping";
import {
  formatBytes,
  formatCpuPercent,
  formatUptime,
  HostRegionBadge,
  hostPrimaryAddressText,
  isAgentUpgradeTimedOut,
  isAgentVersionBehind,
  metricUsageProgressClass,
  readCachedHostMetrics,
  writeCachedHostMetrics,
} from "./hostDisplay";

function formatNetworkSpeed(value: number | null) {
  if (value === null) return "--/s";
  const formatted = formatBytes(value);
  return `${formatted.replace(" ", "\u00a0")}/s`;
}

function metricBytesOrNull(value: unknown) {
  if (value === null || value === undefined) return null;
  const bytes = Number(value);
  return Number.isFinite(bytes) ? Math.max(0, bytes) : null;
}

function formatOptionalBytes(value: number | null) {
  return value === null ? "--" : formatBytes(value);
}

const dayMs = 24 * 60 * 60 * 1000;

export function parseHostDateTime(value: unknown) {
  if (!value) return null;
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function formatRemainingTime(purchasedAt: unknown, stoppedAt: unknown) {
  const purchasedMs = parseHostDateTime(purchasedAt);
  const stoppedMs = parseHostDateTime(stoppedAt);
  if (purchasedMs === null || stoppedMs === null || stoppedMs <= purchasedMs) return null;
  const remainingMs = stoppedMs - Date.now();
  if (remainingMs <= 0) return "已到期";
  if (remainingMs < dayMs) return "不足1天";
  return `剩余${Math.ceil(remainingMs / dayMs)}天`;
}

function compactHostOsInfo(value: unknown) {
  return String(value || "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "-";
}
type HostCardProps = {
  host: any;
  onEdit: (host: any) => void;
  onDelete: (id: number) => void;
  onUpgrade: (host: any) => void;
  onResetTraffic?: (host: any) => void;
  onCorrectTraffic?: (host: any) => void;
  /** 给这台机器配「整台按量计费」。只有管理员那边传，租户那边不渲染这一项。 */
  onEditBilling?: (host: any) => void;
  onViewProbeLatency?: (host: any) => void;
  resetTrafficPending?: boolean;
  traffic?: { bytesIn?: number | null; bytesOut?: number | null } | null;
  metrics?: any[] | null;
  canUpgrade: boolean;
  latestAgentVersion?: string;
  refreshInterval: number | false;
  compact?: boolean;
  dragHandle?: ReactNode;
  sortableClassName?: string;
};

type HostActionButtonsProps = Pick<
  HostCardProps,
  "host" | "onEdit" | "onDelete" | "onUpgrade" | "onResetTraffic" | "onCorrectTraffic" | "onEditBilling" | "onViewProbeLatency" | "resetTrafficPending" | "canUpgrade"
> & {
  className?: string;
  buttonClassName?: string;
};

export function HostActionButtons({
  host,
  onEdit,
  onDelete,
  onUpgrade,
  onResetTraffic,
  onCorrectTraffic,
  onEditBilling,
  onViewProbeLatency,
  resetTrafficPending = false,
  canUpgrade,
  className = "flex shrink-0 items-center justify-end gap-1",
  buttonClassName = "h-7 w-7",
}: HostActionButtonsProps) {
  const confirmDialog = useConfirmDialog();
  const isOnline = !!host.isOnline;
  // 服务端没给这个字段时按「能管」算：管理员那一侧本来就都能管。
  const manageable = host?.manageable !== false;
  const agentUpgradeTimedOut = isAgentUpgradeTimedOut(host);
  const upgradeTitle = !isOnline
    ? "主机离线，无法下发升级任务"
    : agentUpgradeTimedOut
      ? "升级超时，可重新下发"
      : "升级 Agent";

  const confirmDelete = async () => {
    if (await confirmDialog({
      title: "删除主机",
      description: "确定要删除此主机吗？删除后相关状态和配置会同步移除。",
      confirmText: "删除",
      tone: "destructive",
    })) onDelete(host.id);
  };

  return (
    <div className={className}>
      {onViewProbeLatency && (
        <Button
          variant="ghost"
          size="icon"
          className={buttonClassName}
          title="查看服务延迟图表"
          aria-label="查看服务延迟图表"
          onClick={() => onViewProbeLatency(host)}
        >
          <Activity className="h-3.5 w-3.5" />
        </Button>
      )}
      {/*
        不是自己的机器就不给改名和删除的入口。

        这一类是管理员授权他使用的：看得到（授权过才看得到）、能在上面建转发，
        但 hosts.update / hosts.delete 服务端都按 `userId === 自己` 挡着。
        留着按钮的话，点下去只会吃一句「无权操作此主机」—— 那不是提示，是绊脚石。
      */}
      {manageable && (
        <Button
          variant="ghost"
          size="icon"
          className={buttonClassName}
          title="编辑主机"
          aria-label="编辑主机"
          onClick={() => onEdit(host)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={buttonClassName}
            title="更多操作"
            aria-label="更多操作"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40 min-w-40">
          {onResetTraffic && (
            <DropdownMenuItem
              disabled={resetTrafficPending}
              onSelect={() => onResetTraffic(host)}
            >
              {resetTrafficPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              <span>{resetTrafficPending ? "正在重置流量" : "重置流量统计"}</span>
            </DropdownMenuItem>
          )}
          {onCorrectTraffic && (
            <DropdownMenuItem onSelect={() => onCorrectTraffic(host)}>
              <Gauge />
              <span>用量修正</span>
            </DropdownMenuItem>
          )}
          {/*
            「这台机器怎么计费」的入口就放在这台机器上。

            计费配置本来只能在「流量计费管理」那一页按转发组 / 隧道配，可商家是按台
            买机器、机房也是按台出账单的 —— 「这台一律按 X 元/GB」原来得给这台上的
            每个转发组各配一遍，漏一个就有一批流量悄悄不计费。
          */}
          {onEditBilling && (
            <DropdownMenuItem onSelect={() => onEditBilling(host)}>
              <Coins />
              <span>按量计费</span>
            </DropdownMenuItem>
          )}
          {/*
            升不了的人干脆别给这一项。

            原来是渲染出来再 disabled —— 对管理员是对的（机器离线时确实点不了，
            但过一会儿就能点）；对租户却是一个永远灰着的菜单项，因为下发升级
            本来就是管理员专属的接口。旁边「重置流量」「用量修正」都是没权限
            就不渲染，这一项跟上。
          */}
          {canUpgrade && (
            <DropdownMenuItem
              disabled={!isOnline}
              title={upgradeTitle}
              onSelect={() => onUpgrade(host)}
            >
              <Download />
              <span>升级 Agent</span>
            </DropdownMenuItem>
          )}
          {manageable && <DropdownMenuSeparator />}
          {manageable && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => void confirmDelete()}
            >
              <Trash2 />
              <span>删除主机</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function HostCard({
  host,
  onEdit,
  onDelete,
  onUpgrade,
  onResetTraffic,
  onCorrectTraffic,
  onEditBilling,
  onViewProbeLatency,
  resetTrafficPending = false,
  traffic = null,
  metrics: externalMetrics,
  canUpgrade,
  latestAgentVersion,
  refreshInterval,
  compact = false,
  dragHandle,
  sortableClassName,
}: HostCardProps) {
  const hasExternalMetrics = externalMetrics !== undefined;
  const { data: queriedMetrics } = trpc.hosts.metrics.useQuery(
    { hostId: host.id, limit: 2, live: !!refreshInterval },
    { enabled: !hasExternalMetrics, refetchInterval: hasExternalMetrics ? false : refreshInterval }
  );
  const metrics = hasExternalMetrics ? externalMetrics : queriedMetrics;
  const cachedMetrics = useMemo(() => readCachedHostMetrics(host.id), [host.id]);
  const displayMetrics = metrics === undefined || metrics === null || metrics.length === 0 ? cachedMetrics : metrics;
  const latestMetric = displayMetrics?.[0];
  const previousMetric = displayMetrics?.[1];
  const totalNetworkIn = traffic?.bytesIn == null ? null : Number(traffic.bytesIn);
  const totalNetworkOut = traffic?.bytesOut == null ? null : Number(traffic.bytesOut);
  const trafficLimit = Math.max(0, Number(host.trafficLimit || 0));
  const trafficMeasureMode = normalizeHostTrafficMeasureMode(host.trafficMeasureMode);
  const trafficMeasureModeLabel = HOST_TRAFFIC_MEASURE_MODE_LABELS[trafficMeasureMode];
  const trafficUsedBytes = hostTrafficUsedBytes(
    { bytesIn: totalNetworkIn, bytesOut: totalNetworkOut },
    trafficMeasureMode,
  );
  const trafficPercent = hostTrafficPercent(trafficUsedBytes, trafficLimit);
  const trafficProgress = trafficPercent === null ? 0 : Math.min(100, Math.max(0, trafficPercent));
  const trafficUsageLabel = trafficPercent === null
    ? `${formatBytes(trafficUsedBytes)} / ♾️`
    : `${formatBytes(trafficUsedBytes)} / ${formatBytes(trafficLimit)} (${trafficPercent}%)`;
  const trafficUsageTooltip = [
    `流量使用（${trafficMeasureModeLabel}）`,
    `入站 ${totalNetworkIn === null ? "--" : formatBytes(totalNetworkIn)} / 出站 ${totalNetworkOut === null ? "--" : formatBytes(totalNetworkOut)}`,
    trafficUsageLabel,
  ].join("\n");
  const memoryUsed = latestMetric?.memoryUsed == null ? null : Number(latestMetric.memoryUsed);
  const memoryTotal = host.memoryTotal == null ? null : Number(host.memoryTotal);
  const swapUsed = latestMetric?.swapUsed == null ? null : Number(latestMetric.swapUsed);
  const swapTotal = latestMetric?.swapTotal == null ? null : Number(latestMetric.swapTotal);
  const diskUsed = latestMetric?.diskUsed == null ? null : Number(latestMetric.diskUsed);
  const diskTotal = latestMetric?.diskTotal == null ? null : Number(latestMetric.diskTotal);
  const cpuUsage = Number(latestMetric?.cpuUsage ?? 0);
  const memoryUsage = Number(latestMetric?.memoryUsage ?? 0);
  const swapUsage = latestMetric?.swapUsage == null
    ? swapUsed !== null && swapTotal
      ? Math.round((swapUsed / swapTotal) * 100)
      : 0
    : Number(latestMetric.swapUsage);
  const diskUsage = Number(latestMetric?.diskUsage ?? 0);
  const hasSwapReport = latestMetric?.swapUsed != null || latestMetric?.swapTotal != null || latestMetric?.swapUsage != null;
  const memoryTooltip = [
    "内存使用详情",
    memoryUsed !== null && memoryTotal
      ? `RAM ${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)} (${memoryUsage}%)`
      : `RAM ${memoryUsage}%`,
    hasSwapReport
      ? `Swap ${formatBytes(swapUsed ?? 0)} / ${formatBytes(swapTotal ?? 0)} (${swapUsage}%)`
      : "Swap 未上报",
  ].join("\n");
  const networkSpeed = useMemo(() => {
    if (!latestMetric) return { in: null as number | null, out: null as number | null };
    if (latestMetric.networkSpeedIn != null || latestMetric.networkSpeedOut != null) {
      return {
        in: latestMetric.networkSpeedIn == null ? null : Number(latestMetric.networkSpeedIn),
        out: latestMetric.networkSpeedOut == null ? null : Number(latestMetric.networkSpeedOut),
      };
    }
    if (!previousMetric) return { in: null as number | null, out: null as number | null };
    const latestAt = new Date(latestMetric.recordedAt).getTime();
    const previousAt = new Date(previousMetric.recordedAt).getTime();
    const seconds = Math.max(1, (latestAt - previousAt) / 1000);
    const inDelta = Math.max(0, Number(latestMetric.networkIn || 0) - Number(previousMetric.networkIn || 0));
    const outDelta = Math.max(0, Number(latestMetric.networkOut || 0) - Number(previousMetric.networkOut || 0));
    return { in: inDelta / seconds, out: outDelta / seconds };
  }, [latestMetric, previousMetric]);
  const systemNetworkIn = metricBytesOrNull(latestMetric?.networkIn);
  const systemNetworkOut = metricBytesOrNull(latestMetric?.networkOut);
  const systemNetworkTotal = systemNetworkIn === null && systemNetworkOut === null ? null : (systemNetworkIn ?? 0) + (systemNetworkOut ?? 0);
  const currentTrafficInLabel = formatNetworkSpeed(networkSpeed.in);
  const currentTrafficOutLabel = formatNetworkSpeed(networkSpeed.out);
  const systemTrafficInLabel = formatOptionalBytes(systemNetworkIn);
  const systemTrafficOutLabel = formatOptionalBytes(systemNetworkOut);
  const isOnline = !!host.isOnline;
  /*
    机器离线了，这两个数就不再是「当前」。

    速率是拿最后两次采样算出来的，运行时间也是最后一次上报里的值 —— 机器一掉线
    它们就冻在那儿，可标题还写着「当前瞬时流量」。于是同一张卡上，红色的「离线」
    和「当前 4.09 KB/s」并排放着：看的人没法判断这机器是真在跑，还是这串数字是
    三天前的化石。

    数字照留（掉线前跑到哪儿是有用的线索，抹掉更糟），只把名字改对。
  */
  const lastReportedText = latestMetric?.recordedAt
    ? new Date(latestMetric.recordedAt).toLocaleString("zh-CN", { hour12: false })
    : "";
  const currentTrafficLabel = isOnline ? "当前" : "最后一次";
  const currentTrafficTitle = [
    isOnline ? "当前瞬时流量" : "最后一次上报时的瞬时流量 —— 机器已离线，这不是现在的速率",
    `下行 ${currentTrafficInLabel}`,
    `上行 ${currentTrafficOutLabel}`,
    !isOnline && lastReportedText ? `上报于 ${lastReportedText}` : "",
  ].filter(Boolean).join("\n");
  const systemTrafficTitle = [
    "系统累计流量（系统重启后重置）",
    `下行 ${systemTrafficInLabel}`,
    `上行 ${systemTrafficOutLabel}`,
    `合计 ${formatOptionalBytes(systemNetworkTotal)}`,
  ].join("\n");
  const renderTrafficRow = (Icon: typeof ArrowDownToLine, value: string) => (
    <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
      <span className="inline-flex shrink-0 items-center text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
      </span>
      <span className="min-w-0 truncate text-right font-medium tabular-nums" title={value}>{value}</span>
    </div>
  );
  const renderTrafficColumn = ({
    label,
    inValue,
    outValue,
    title,
    className = "",
  }: {
    label: string;
    inValue: string;
    outValue: string;
    title: string;
    className?: string;
  }) => (
    <div className={`min-w-0 ${className}`} title={title}>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Activity className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div className={compact ? "mt-1.5 space-y-1" : "mt-2 space-y-1.5"}>
        {renderTrafficRow(ArrowDownToLine, inValue)}
        {renderTrafficRow(ArrowUpFromLine, outValue)}
      </div>
    </div>
  );
  // 公网出口整形在起作用（或出了状况）时在流量下面加一行；关着、在观察时什么都不显示。
  const egressShapingText = hostEgressShapingCardText(host);
  const renderTrafficSplitBox = () => (
    <div className={`border-t border-[var(--fx-stroke-weak)] pt-2 ${trafficPanelClass}`}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] divide-x divide-[var(--fx-stroke-weak)]">
        {renderTrafficColumn({ label: currentTrafficLabel, inValue: currentTrafficInLabel, outValue: currentTrafficOutLabel, title: currentTrafficTitle, className: "pr-2" })}
        {renderTrafficColumn({ label: "累计", inValue: systemTrafficInLabel, outValue: systemTrafficOutLabel, title: systemTrafficTitle, className: "pl-2" })}
      </div>
      {egressShapingText ? (
        <p className="mt-1 truncate text-[11px] leading-snug text-muted-foreground" title={egressShapingText} data-host-egress-shaping="">
          {egressShapingText}
        </p>
      ) : null}
    </div>
  );
  const billingBadge = hostBillingBadge(host.trafficBilling);
  const remainingTimeLabel = formatRemainingTime(host.purchasedAt, host.stoppedAt);
  const hostName = String(host.name || "-").trim() || "-";
  const osInfoText = compactHostOsInfo(host.osInfo);
  const hostOs = parseHostOs(host.osInfo);
  const cpuUsageLabel = formatCpuPercent(latestMetric?.cpuUsage ?? 0, isOnline);
  const remainingTimeClass = remainingTimeLabel === "已到期"
    ? "border-destructive/30 bg-destructive/10 text-destructive"
    : remainingTimeLabel === "不足1天"
      ? "border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]"
      : "border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]";
  const agentNeedsUpdate = isAgentVersionBehind(host.agentVersion, latestAgentVersion);
  const agentUpgradeTimedOut = isAgentUpgradeTimedOut(host);
  const trafficUsageProgressClass = trafficLimit > 0
    ? metricUsageProgressClass(trafficProgress, isOnline)
    : isOnline
      ? "h-1.5 bg-muted [&>div]:bg-muted-foreground/30"
      : "h-1.5 bg-muted [&>div]:bg-muted-foreground/20";
  /*
    卡里不再套框。原来「主机信息」「流量」各是一个描边的浅灰盒子 —— 一张卡里三层框，
    框本身不带信息，只是在重复画边界（手册第一节）。现在信息区直接坐在卡上，
    流量区靠一条细线和上面分开。离线只把字退到 muted，不再整块涂灰。
  */
  const infoPanelClass = isOnline ? "" : "text-muted-foreground";
  const trafficPanelClass = isOnline ? "" : "text-muted-foreground";
  /*
    卡不再有最低高度。原来标准卡钉在 420px、紧凑卡 260px：一台只有三行指标的机器也得
    撑出一张 420px 的卡，底下 150px 是空的。卡多高由它说了多少决定。
  */
  const cardMinHeightClass = "";
  const compactMetricPanelClass = `border-t border-[var(--fx-stroke-weak)] pt-2 ${trafficPanelClass}`;
  const compactMetricItemClass = "grid min-w-0 grid-cols-[18px_minmax(0,1fr)_42px] items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-background/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
  const compactMetricItems = [
    {
      key: "cpu",
      label: "CPU",
      icon: Cpu,
      value: cpuUsage,
      valueLabel: cpuUsageLabel,
      progressClass: metricUsageProgressClass(cpuUsage, isOnline),
      tooltip: host.cpuInfo ? `CPU 使用率 ${cpuUsageLabel}\n${host.cpuInfo}` : `CPU 使用率 ${cpuUsageLabel}`,
    },
    {
      key: "memory",
      label: "内存",
      icon: MemoryStick,
      value: memoryUsage,
      valueLabel: `${memoryUsage}%`,
      progressClass: metricUsageProgressClass(memoryUsage, isOnline),
      tooltip: memoryTooltip,
    },
    {
      key: "disk",
      label: "磁盘",
      icon: HardDrive,
      value: diskUsage,
      valueLabel: `${diskUsage}%`,
      progressClass: metricUsageProgressClass(diskUsage, isOnline),
      tooltip: diskUsed !== null && diskTotal
        ? `磁盘使用率 ${diskUsage}%\n${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`
        : `磁盘使用率 ${diskUsage}%`,
    },
    {
      key: "traffic",
      label: "流量",
      icon: Activity,
      value: trafficProgress,
      valueLabel: trafficPercent === null ? "∞" : `${trafficPercent}%`,
      progressClass: trafficUsageProgressClass,
      tooltip: trafficUsageTooltip,
    },
  ];

  const addressRegionBlock = (regionCompact = false) => (
    <div className={`mt-0.5 min-w-0 space-y-1 ${isOnline ? "" : "opacity-70 grayscale"}`}>
      <p className="min-w-0 truncate font-mono text-xs leading-5" title={hostPrimaryAddressText(host)}>
        <span className="mr-1.5 text-muted-foreground">地址</span>
        {/* 排障第一件事就是复制这个地址，所以它要从 select-guard 里单独放出来。 */}
        <span className="selectable">{hostPrimaryAddressText(host)}</span>
      </p>
      <div className="flex min-w-0 items-center gap-1.5 text-xs leading-5">
        <span className="shrink-0 text-muted-foreground">国家/地区：</span>
        <HostRegionBadge host={host} compact={regionCompact} />
      </div>
      {/*
        这台机器是谁的。

        租户可以自助加机器，加完就出现在管理员这张列表里 —— 那是对的（面板是管理员
        在跑，出了事要能查、要能删），但不标出主人的话，管理员看到的是一台凭空多
        出来的陌生机器：不知道能不能动它，也不知道该找谁。

        服务端只给管理员算这个字段，而且自己建的不给（满屏自己的名字等于没标）。
        所以这里有值就显示，没值就不占地方。
      */}
      {host.ownerLabel ? (
        <div className="flex min-w-0 items-center gap-1.5 text-xs leading-5">
          <span className="shrink-0 text-muted-foreground">归属：</span>
          <span className="min-w-0 truncate" title={`这台机器由「${host.ownerLabel}」自己加进来的`}>
            {host.ownerLabel}
          </span>
        </div>
      ) : null}
      {/*
        这台机器上的转发是扣余额还是吃套餐流量。

        两条路互斥：转发找得到计费配置就按 GB 扣余额，找不到就记进用户的套餐流量额度。
        原来这个开关藏在编辑弹窗里，列表上一个字都没有 —— 「这台到底在不在计费」
        得点进去一台台看，而记错账的代价是真金白银，所以摆到卡片上。
      */}
      <div className="flex min-w-0 items-center gap-1.5 text-xs leading-5">
        <span className="shrink-0 text-muted-foreground">计费：</span>
        {billingBadge.metered ? (
          <span
            className="min-w-0 truncate rounded bg-[var(--fx-warn-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--fx-warn-text)]"
            title={billingBadge.title}
          >
            {billingBadge.label}
          </span>
        ) : (
          <span className="min-w-0 truncate text-muted-foreground" title={billingBadge.title}>
            {billingBadge.label}
          </span>
        )}
      </div>
    </div>
  );

  useEffect(() => {
    if (!metrics?.length) return;
    writeCachedHostMetrics(host.id, metrics);
  }, [host.id, metrics]);

  return (
    <Card className={`${cardMinHeightClass} select-guard host-card-shell ${dragHandle ? "group/sortable" : ""} ${sortableClassName || ""} bg-card transition-[min-height,background-color,box-shadow,opacity] duration-200 ease-out`}>
      <CardHeader className={compact ? "px-3.5 pb-2 pt-3.5" : "pb-2"}>
        {compact ? (
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
              {dragHandle}
            </div>
            <HostActionButtons
              host={host}
              onEdit={onEdit}
              onDelete={onDelete}
              onUpgrade={onUpgrade}
              onResetTraffic={onResetTraffic}
              onCorrectTraffic={onCorrectTraffic}
              onEditBilling={onEditBilling}
              onViewProbeLatency={onViewProbeLatency}
              resetTrafficPending={resetTrafficPending}
              canUpgrade={canUpgrade}
            />
          </div>
        ) : (
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
              {dragHandle}
            </div>
            <HostActionButtons
              host={host}
              onEdit={onEdit}
              onDelete={onDelete}
              onUpgrade={onUpgrade}
              onResetTraffic={onResetTraffic}
              onCorrectTraffic={onCorrectTraffic}
              onEditBilling={onEditBilling}
              onViewProbeLatency={onViewProbeLatency}
              resetTrafficPending={resetTrafficPending}
              canUpgrade={canUpgrade}
            />
          </div>
        )}
      </CardHeader>
      <CardContent className={`host-card-mode-content ${compact ? "host-card-mode-content-compact space-y-2 px-3.5 pb-3.5" : "host-card-mode-content-standard space-y-3"} ${isOnline ? "" : "text-muted-foreground"}`}>
        {compact ? (
          <div className="space-y-2">
            <div className={`min-w-0 px-0.5 py-1 ${infoPanelClass}`}>
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? "bg-[var(--fx-healthy)] shadow-[0_0_0_3px_var(--fx-healthy-soft)]" : "bg-[var(--fx-down)] shadow-[0_0_0_3px_var(--fx-down-soft)]"}`}
                  title={isOnline ? "在线" : "离线"}
                />
                <span className="selectable min-w-0 truncate text-sm font-semibold leading-5" title={hostName}>{hostName}</span>
                <span
                  className={`shrink-0 rounded-[5px] border px-1.5 py-0.5 font-mono text-[10.5px] font-normal leading-none text-muted-foreground ${
                    isOnline ? "border-[var(--fx-stroke-base)]" : "border-[var(--fx-stroke-weak)]"
                  }`}
                >
                  {host.agentVersion ? `v${host.agentVersion}` : "未上报"}
                </span>
                {agentNeedsUpdate && (
                  <Badge variant="outline" className="shrink-0 border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] px-1.5 py-0 text-[10px] text-[var(--fx-warn-text)]">
                    新版
                  </Badge>
                )}
                <FxpRuntimeBadge host={host} />
              </div>
              {host.agentUpgradeRequested && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${agentUpgradeTimedOut ? "border-destructive/30 text-destructive" : "border-primary/25 text-primary"}`}>
                    {agentUpgradeTimedOut ? "升级失败" : "升级中"}
                  </Badge>
                </div>
              )}
              {addressRegionBlock(true)}
            </div>
          </div>
        ) : (
          <div className={compact ? "space-y-1.5" : "space-y-2"}>
            <div className={`min-w-0 px-0.5 ${compact ? "py-1" : "py-1.5"} ${infoPanelClass}`}>
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? "bg-[var(--fx-healthy)] shadow-[0_0_0_3px_var(--fx-healthy-soft)]" : "bg-[var(--fx-down)] shadow-[0_0_0_3px_var(--fx-down-soft)]"}`}
                  title={isOnline ? "在线" : "离线"}
                />
                <span className="selectable min-w-0 truncate text-sm font-semibold leading-5" title={hostName}>{hostName}</span>
                <span
                  className={`shrink-0 rounded-[5px] border px-1.5 py-0.5 font-mono text-[10.5px] font-normal leading-none text-muted-foreground ${
                    isOnline ? "border-[var(--fx-stroke-base)]" : "border-[var(--fx-stroke-weak)]"
                  }`}
                >
                  {host.agentVersion ? `v${host.agentVersion}` : "未上报"}
                </span>
                {agentNeedsUpdate && (
                  <Badge variant="outline" className="shrink-0 border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] px-1.5 py-0 text-[10px] text-[var(--fx-warn-text)]">
                    新版
                  </Badge>
                )}
                <FxpRuntimeBadge host={host} />
              </div>
              {host.agentUpgradeRequested && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${agentUpgradeTimedOut ? "border-destructive/30 text-destructive" : "border-primary/25 text-primary"}`}>
                    {agentUpgradeTimedOut ? "升级失败" : "升级中"}
                  </Badge>
                </div>
              )}
              {addressRegionBlock(false)}
            </div>
            <div className={`flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap ${compact ? "text-xs" : "text-sm"}`}>
              <div className="flex shrink-0 items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                <span className={isOnline ? "" : "font-medium text-destructive"}>{isOnline ? "在线" : "离线"}</span>
              </div>
              {!compact && <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                <HostOsGlyph os={hostOs} className="h-3.5 w-3.5" />
                <span className="min-w-0 truncate" title={host.osInfo || ""}>{osInfoText}</span>
              </div>}
            </div>
          </div>
        )}

        {latestMetric ? (
          compact ? (
            <div className="space-y-2 border-t border-border/30 pt-2">
              <TooltipProvider delayDuration={120}>
                <div className={`${compactMetricPanelClass} space-y-1.5 text-xs`}>
                  {compactMetricItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Tooltip key={item.key}>
                        <TooltipTrigger asChild>
                          <div className={compactMetricItemClass} aria-label={item.tooltip} tabIndex={0}>
                            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <Progress value={item.value} className={item.progressClass} />
                            <span className="shrink-0 text-right font-semibold leading-none tabular-nums">{item.valueLabel}</span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent collisionPadding={12} className="max-w-[240px] whitespace-pre-line text-xs">
                          {item.tooltip}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </TooltipProvider>
              {renderTrafficSplitBox()}
              <div className="flex items-center gap-2 text-xs">
                <Clock className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">运行</span>
                {remainingTimeLabel && (
                  <span className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${remainingTimeClass}`}>
                    {remainingTimeLabel}
                  </span>
                )}
                <span className="ml-auto shrink-0 whitespace-nowrap text-right font-medium tabular-nums">{formatUptime(latestMetric.uptime)}</span>
              </div>
            </div>
          ) : (
          <div className="space-y-3 border-t border-border/30 pt-2">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><Cpu className="h-3 w-3" /> CPU</span>
                <span className="font-medium tabular-nums">{cpuUsageLabel}</span>
              </div>
              <p className="truncate text-[11px] text-muted-foreground" title={host.cpuInfo || ""}>
                {host.cpuInfo || "未上报 CPU 型号"}
              </p>
              <Progress value={latestMetric.cpuUsage ?? 0} className={metricUsageProgressClass(latestMetric.cpuUsage, isOnline)} />
            </div>
            <TooltipProvider delayDuration={120}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="space-y-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={memoryTooltip} tabIndex={0}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground flex items-center gap-1"><MemoryStick className="h-3 w-3" /> 内存</span>
                      <span className="max-w-[70%] truncate text-right font-medium tabular-nums">
                        {memoryUsed !== null && memoryTotal
                          ? `${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)} (${latestMetric.memoryUsage ?? 0}%)`
                          : `${latestMetric.memoryUsage ?? 0}%`}
                      </span>
                    </div>
                    <Progress value={latestMetric.memoryUsage ?? 0} className={metricUsageProgressClass(latestMetric.memoryUsage, isOnline)} />
                  </div>
                </TooltipTrigger>
                <TooltipContent collisionPadding={12} className="max-w-[260px] whitespace-pre-line text-xs">
                  {memoryTooltip}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><HardDrive className="h-3 w-3" /> 磁盘</span>
                <span className="max-w-[70%] truncate text-right font-medium tabular-nums">
                  {diskUsed !== null && diskTotal
                    ? `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)} (${latestMetric.diskUsage ?? 0}%)`
                    : `-- / -- (${latestMetric.diskUsage ?? 0}%)`}
                </span>
              </div>
              <Progress value={latestMetric.diskUsage ?? 0} className={metricUsageProgressClass(latestMetric.diskUsage, isOnline)} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><Activity className="h-3 w-3" /> 流量</span>
                <span className="max-w-[70%] truncate text-right font-medium tabular-nums" title={trafficUsageTooltip}>
                  {trafficUsageLabel}
                </span>
              </div>
              <Progress value={trafficProgress} className={trafficUsageProgressClass} />
            </div>
            <div className="pt-1">
              {renderTrafficSplitBox()}
            </div>
            <div className="flex items-center gap-2 text-xs pt-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span
                className="text-muted-foreground"
                title={isOnline ? "" : `最后一次上报时已经跑了这么久${lastReportedText ? `（上报于 ${lastReportedText}）` : ""}`}
              >
                {/* 离线时这个数也是冻住的，别让它看起来还在走。 */}
                {isOnline ? "运行时间" : "最后运行时长"}
              </span>
              {remainingTimeLabel && (
                <span className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${remainingTimeClass}`}>
                  {remainingTimeLabel}
                </span>
              )}
              <span className="ml-auto shrink-0 whitespace-nowrap text-right font-medium tabular-nums">{formatUptime(latestMetric.uptime)}</span>
            </div>
          </div>
          )
        ) : (
          <div className={`border-t border-border/30 text-center text-muted-foreground/60 ${compact ? "py-3" : "py-4"}`}>
            <p className="text-xs">暂无监控数据</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
