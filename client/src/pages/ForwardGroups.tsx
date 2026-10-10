import WorkspaceHeader from "@/components/WorkspaceHeader";
import { NetworkPath } from "@/components/network/NetworkPath";
import { buildChainPath } from "@/features/links/chainPath";
import { GroupFailoverPolicyFields } from "@/features/links/GroupFailoverPolicyFields";
import { RoutePolicySheet } from "@/features/rules/RoutePolicySheet";
import { EntityActions } from "@/components/entity/EntityActions";
import { FAILOVER_TONE_CLASS, describeGroupPolicyDisplay } from "@/lib/failoverLineDisplay";
import { FormField } from "@/components/ui/form-field";
import DataSectionError from "@/components/DataSectionError";
import { sameNullableStringArray } from "@/lib/multiHopAddress";
import { hostSearchParts } from "@/lib/hostSearchParts";
import { formatLatencyTimeLabel } from "@/lib/latencyTimeLabel";
import { hostIpv6Address, hostPrivateAddress, normalizeConnectHostForHost, sameAddress } from "@/lib/multiHopAddress";
import { addressKey } from "@/lib/multiHopAddress";
import SectionTransition from "@/components/SectionTransition";
import DashboardLayout from "@/components/DashboardLayout";
import { DiagnoseDialog } from "@/components/DiagnoseDialog";
import EmptyState from "@/components/EmptyState";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import { LatencyRating } from "@/components/LatencyRating";
import { LatencyPeakCutToggle } from "@/components/LatencyPeakCutToggle";
import { LatencyStabilityStats } from "@/components/LatencyStabilityStats";
import {
  DEFAULT_LATENCY_TIME_RANGE_HOURS,
  filterLatencySeriesByTimeRange,
  latencyTimeRangeLabel,
  LatencyTimeRangeSelect,
  type LatencyTimeRangeHours,
} from "@/components/LatencyTimeRangeSelect";
import { PersistentPagination, usePersistentPageRequest, useServerPagination } from "@/components/PersistentPagination";
import { applyLatencyPeakCut, clipLatencyForChart, getLatencyStabilityStats, getLatencyYAxisMax, getLatencyYAxisTicks, isLatencySeriesCacheFresh, normalizeLatencyProbeCounts } from "@/lib/latencyChart";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OptimisticSwitch, Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import DataSectionLoading from "@/components/DataSectionLoading";
import HostStatusLabel from "@/components/HostStatusLabel";
import MultiHopEditor from "@/components/MultiHopEditor";
import { SortableDragHandle, SortableItem, SortableReorderContext, useOptimisticSortableOrder, useSortableReorder } from "@/components/SortableDragHandle";
import { pollingInterval } from "@/lib/polling";
import { buildLinkAvailabilityIndex } from "@shared/linkAvailability";
import { handoffManualTestResult } from "@/lib/manualTestCache";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  Activity,
  ArrowRightLeft,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Globe,
  GripVertical,
  Layers3,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Stethoscope,
  Trash2,
  XCircle,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { toast } from "sonner";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { MAX_FORWARD_GROUP_MEMBERS } from "@shared/forwardGroup";
import { describeGroupRoutePolicy, type GroupRoutePolicyOptions } from "@shared/routePolicy";
import { LinkTestProbeView, parseLinkTestMessage, type LinkTestPlannedSegment } from "@/components/LinkTestLatencySummary";
import { BandwidthAggregationSummary } from "@/components/BandwidthAggregationSummary";
import { addHostNodeMeta, addNodeMetaAliases, hostDisplayName } from "@/lib/linkTestNodeMeta";
import {
  trafficMultiplierFromInput,
  formatTrafficMultiplier,
  trafficMultiplierToInputValue,
} from "@shared/trafficMultiplier";
import {
  FORWARD_RULE_PROTOCOL_LABELS,
  FORWARD_TYPE_LABELS,
  FORWARD_TYPES,
  TUNNEL_PROTOCOLS,
  normalizeForwardProtocolSettings,
  normalizeForwardRuleProtocol,
  type ForwardRuleProtocol,
  type ForwardType,
} from "@shared/forwardTypes";
import {
  EXIT_GROUP_STRATEGY_LABELS,
  normalizeExitGroupStrategy,
  type ExitGroupStrategy,
} from "@shared/exitStrategy";
import {
  FORWARD_GROUP_HEALTH_CHECK_METHODS,
  FORWARD_GROUP_HEALTH_CHECK_METHOD_HINTS,
  FORWARD_GROUP_HEALTH_CHECK_METHOD_LABELS,
  healthCheckTargetNeedsPort,
  healthCheckTargetPlaceholder,
  normalizeForwardGroupHealthCheckMethod,
  type ForwardGroupHealthCheckMethod,
} from "@shared/forwardGroupHealthCheck";
import {
  BANDWIDTH_AGGREGATION_STRATEGIES,
  BANDWIDTH_AGGREGATION_STRATEGY_HINTS,
  BANDWIDTH_AGGREGATION_STRATEGY_LABELS,
  MAX_AGGREGATION_RECORD_SLOTS,
  MAX_MEMBER_BANDWIDTH_MBPS,
  MAX_MEMBER_WEIGHT,
  formatAggregationUtilization,
  formatBandwidthMbps,
  normalizeAggregationMinMembers,
  normalizeAggregationRecordSlots,
  normalizeBandwidthAggregationStrategy,
  normalizeMemberBandwidthMbps,
  normalizeMemberWeight,
  type BandwidthAggregationStrategy,
} from "@shared/bandwidthAggregation";

type GroupType = "host" | "tunnel";
type GroupMode = "port" | "failover" | "chain" | "entry" | "exit";
type FailoverStrategy = "fallback" | "round_robin" | "random" | "ip_hash";
type MemberForm = {
  key: string;
  memberType: GroupType;
  hostId: number | null;
  tunnelId: number | null;
  connectHost?: string | null;
  isEnabled: boolean;
  /** Declared uplink of this front VPS in Mbps. Entry groups only. */
  bandwidthMbps: string;
  /** Manual bandwidth aggregation weight. Entry groups only. */
  aggregationWeight: string;
};

type GroupForm = {
  name: string;
  groupMode: GroupMode;
  exitStrategy: ExitGroupStrategy;
  entryGroupId: number | null;
  groupType: GroupType;
  protocol: ForwardRuleProtocol;
  forwardType: ForwardType;
  proxyProtocolReceive: boolean;
  proxyProtocolSend: boolean;
  proxyProtocolVersion: 1 | 2;
  tcpFastOpen: boolean;
  zeroCopy: boolean;
  udpOverTcp: boolean;
  udpOverTcpPort: number;
  failoverEnabled: boolean;
  failoverStrategy: FailoverStrategy;
  failoverTargetsText: string;
  domain: string;
  recordType: "A" | "AAAA" | "CNAME";
  failoverSeconds: string;
  recoverSeconds: string;
  rateLimitMbps: string;
  trafficMultiplier: string;
  chinaHealthCheckEnabled: boolean;
  chinaHealthCheckTarget: string;
  chinaHealthCheckMethod: ForwardGroupHealthCheckMethod;
  telegramSwitchNotifyEnabled: boolean;
  ddnsAutoResolveEnabled: boolean;
  bandwidthAggregationEnabled: boolean;
  bandwidthAggregationStrategy: BandwidthAggregationStrategy;
  bandwidthAggregationSlots: string;
  bandwidthAggregationMinMembers: string;
  autoFailback: boolean;
  isEnabled: boolean;
  members: MemberForm[];
};

const makeDefaultForm = (): GroupForm => ({
  name: "",
  groupMode: "failover",
  exitStrategy: "round_robin",
  entryGroupId: null,
  groupType: "host",
  protocol: "both",
  forwardType: "iptables",
  proxyProtocolReceive: false,
  proxyProtocolSend: false,
  proxyProtocolVersion: 1,
  tcpFastOpen: false,
  zeroCopy: false,
  udpOverTcp: false,
  udpOverTcpPort: 0,
  failoverEnabled: false,
  failoverStrategy: "fallback",
  failoverTargetsText: "",
  domain: "",
  recordType: "A",
  failoverSeconds: "60",
  recoverSeconds: "120",
  rateLimitMbps: "0",
  trafficMultiplier: "1",
  chinaHealthCheckEnabled: false,
  chinaHealthCheckTarget: "",
  chinaHealthCheckMethod: "tcp",
  telegramSwitchNotifyEnabled: false,
  ddnsAutoResolveEnabled: true,
  bandwidthAggregationEnabled: false,
  bandwidthAggregationStrategy: "capacity",
  bandwidthAggregationSlots: "8",
  bandwidthAggregationMinMembers: "1",
  autoFailback: true,
  isEnabled: true,
  members: [],
});

function memberKey(memberType: GroupType, id: number) {
  return `${memberType}-${id}`;
}

function normalizeGroupMode(mode: unknown): GroupMode {
  const value = String(mode || "failover");
  return value === "port" || value === "chain" || value === "entry" || value === "exit" ? value : "failover";
}

function groupModeDisplayLabel(mode: unknown) {
  const normalized = normalizeGroupMode(mode);
  if (normalized === "port") return "端口转发";
  if (normalized === "chain") return "转发链";
  if (normalized === "entry") return "入口组";
  if (normalized === "exit") return "出口组";
  return "转发组";
}

function isCollectionMode(mode: GroupMode) {
  return mode === "entry" || mode === "exit";
}

function normalizeChinaHealthTargetInput(value: string, method: ForwardGroupHealthCheckMethod = "tcp") {
  const needsPort = healthCheckTargetNeedsPort(method);
  const target = value.trim().replace(/^(?:tcp|icmp|ping):\/\//i, "").replace(/\uFF1A/g, ":");
  if (!target) return "";
  if (target.length > 253 || /[\s'"<>/]/.test(target)) return undefined;
  let host = target;
  let port = 80;
  const bracketMatch = target.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketMatch) {
    host = bracketMatch[1]?.trim() || "";
    port = bracketMatch[2] ? Number(bracketMatch[2]) : 80;
  } else {
    const lastColon = target.lastIndexOf(":");
    if (lastColon > 0) {
      const maybeHost = target.slice(0, lastColon).trim();
      const maybePortText = target.slice(lastColon + 1);
      const maybePort = Number(maybePortText);
      const singleColonHostPort = target.indexOf(":") === lastColon;
      const nakedIpv6HostPort = !singleColonHostPort && isValidIpv6Address(maybeHost);
      if ((singleColonHostPort || nakedIpv6HostPort) && /^\d+$/.test(maybePortText) && Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
        host = maybeHost;
        port = maybePort;
      }
    }
  }
  host = unwrapBracketedHost(host).trim();
  // Ping ignores ports entirely, so a port left over from TCPing is stripped
  // rather than rejected as a malformed IPv6 address.
  if (!needsPort && host.includes(":") && !isValidIpv6Address(host)) {
    const trailingPort = host.match(/^(.*?):(\d+)$/);
    if (trailingPort && !isValidIpv6Address(trailingPort[1])) host = trailingPort[1].trim();
  }
  if (host.includes(":") && !isValidIpv6Address(host)) return undefined;
  if (!host || host.length > 253 || /[\s'"<>/]/.test(host)) return undefined;
  const bracketed = isValidIpv6Address(host) ? `[${host}]` : host;
  // Ping carries no port, so the stored target is the bare host.
  if (!needsPort) return bracketed;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return `${bracketed}:${port}`;
}
function unwrapBracketedHost(value: unknown) {
  const text = String(value || "").trim();
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1).trim() : text;
}

function isValidIpv6Address(value: unknown) {
  const text = unwrapBracketedHost(value);
  if (!text.includes(":")) return false;
  try {
    new URL(`http://[${text}]/`);
    return true;
  } catch {
    return false;
  }
}

function looksLikeIpv4(value: unknown) {
  const text = unwrapBracketedHost(value);
  const parts = text.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function looksLikeIpv6(value: unknown) {
  const text = unwrapBracketedHost(value);
  return text.includes(":") && /^[0-9a-fA-F:.]+$/.test(text);
}

function looksLikeIp(value: unknown) {
  return looksLikeIpv4(value) || looksLikeIpv6(value);
}

function forwardGroupRecordValueForHost(host: any, recordType: GroupForm["recordType"]) {
  const manual = String(host?.entryIp || "").trim();
  if (recordType === "AAAA") {
    if (looksLikeIpv6(manual)) return unwrapBracketedHost(manual);
    return unwrapBracketedHost(host?.ipv6 || (looksLikeIpv6(host?.ip) ? host?.ip : ""));
  }
  if (recordType === "CNAME") {
    if (manual && !looksLikeIp(manual)) return manual;
    return host?.ddnsEnabled ? String(host?.ddnsDomain || "").trim() : "";
  }
  if (looksLikeIpv4(manual)) return manual;
  return String(host?.ipv4 || (looksLikeIpv4(host?.ip) ? host?.ip : "") || "").trim();
}

function forwardGroupRecordRequirement(recordType: GroupForm["recordType"]) {
  if (recordType === "AAAA") return "IPv6";
  if (recordType === "CNAME") return "入口域名或 DDNS 域名";
  return "IPv4";
}

type ForwardGroupViewMode = "card" | "table";
type ForwardGroupsContentProps = {
  mode?: GroupMode;
  embedded?: boolean;
  viewMode?: ForwardGroupViewMode;
  onViewModeChange?: (viewMode: ForwardGroupViewMode) => void;
  hideHeaderActions?: boolean;
  createRequestKey?: number;
  editRequest?: { id: number; requestKey: number } | null;
  onEditRequestConsumed?: () => void;
  searchQuery?: string;
};

const FORWARD_GROUP_VIEW_MODE_STORAGE_KEY = "forwardx.forwardGroups.viewMode";

function getStoredForwardGroupViewMode(): ForwardGroupViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(FORWARD_GROUP_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storeForwardGroupViewMode(viewMode: ForwardGroupViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FORWARD_GROUP_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function sameNumberArray(a: number[], b: number[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function normalizeChainConnectHostsForHosts(
  raw: Array<string | null>,
  hostIds: number[],
  hosts: any[] | undefined,
  externalEntry = false,
): Array<string | null> {
  const base = [...raw].slice(0, hostIds.length);
  while (base.length < hostIds.length) base.push(null);
  if (hostIds.length > 0 && !externalEntry) base[0] = null;
  const hostById = new Map((hosts || []).map((host: any) => [Number(host.id), host]));
  return base.map((value, index) => {
    if (index === 0 && !externalEntry) return null;
    const host = hostById.get(Number(hostIds[index] || 0));
    return normalizeConnectHostForHost(value, host, null);
  });
}

function chainRoleLabel(index: number, total: number, hasExternalEntry = false) {
  if (hasExternalEntry) return index === total - 1 ? "出口" : "中转";
  if (index === 0) return "入口";
  if (index === total - 1) return "出口";
  return "中转";
}

function entryGroupDisplayText(group: any, groupsByMode: Record<GroupMode, any[]>) {
  const entryGroupId = Number(group?.entryGroupId || 0);
  if (!entryGroupId) return "";
  const entryGroup = groupsByMode.entry.find((item: any) => Number(item.id) === entryGroupId);
  if (!entryGroup) return `入口组 #${entryGroupId}`;
  return String(entryGroup.domain || entryGroup.name || `入口组 #${entryGroupId}`).trim();
}

function normalizeForwardGroupSearchText(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function forwardGroupSearchMatches(parts: unknown[], query: string) {
  const needle = normalizeForwardGroupSearchText(query);
  if (!needle) return true;
  return parts.some((part) => normalizeForwardGroupSearchText(part).includes(needle));
}

function forwardGroupMatchesSearchQuery(
  group: any,
  query: string,
  hosts: any[] | undefined,
  tunnels: any[] | undefined,
  groupsByMode: Record<GroupMode, any[]>,
) {
  const hostById = new Map((hosts || []).map((host: any) => [Number(host.id), host]));
  const tunnelById = new Map((tunnels || []).map((tunnel: any) => [Number(tunnel.id), tunnel]));
  const mode = normalizeGroupMode(group?.groupMode);
  const entryGroupText = entryGroupDisplayText(group, groupsByMode);
  const modeLabels: Record<GroupMode, string[]> = {
    port: ["端口转发", "port"],
    chain: ["转发链", "端口转发链", "chain"],
    failover: ["转发组", "故障转移", "failover"],
    entry: ["入口组", "entry"],
    exit: ["出口组", "exit"],
  };
  const memberParts = (Array.isArray(group?.members) ? group.members : []).flatMap((member: any) => {
    if (member?.memberType === "tunnel") {
      const tunnel = tunnelById.get(Number(member.tunnelId || 0));
      return [
        member.id,
        member.tunnelId,
        member.entryAddress,
        member.connectHost,
        tunnel?.id,
        tunnel?.name,
        tunnel?.listenPort,
        tunnel?.mode,
        getTunnelRouteText(tunnel, hosts),
      ];
    }
    const host = hostById.get(Number(member?.hostId || 0));
    return [
      member?.id,
      member?.hostId,
      member?.entryAddress,
      member?.connectHost,
      host?.name || (member?.hostId ? `host #${member.hostId}` : ""),
      ...hostSearchParts(host),
    ];
  });
  return forwardGroupSearchMatches([
    group?.id,
    group?.name,
    group?.domain,
    group?.recordType,
    group?.lastDdnsValue,
    group?.lastStatus,
    group?.lastMessage,
    group?.protocol,
    FORWARD_RULE_PROTOCOL_LABELS[normalizeForwardRuleProtocol(group?.protocol, "both")],
    group?.forwardType,
    (FORWARD_TYPE_LABELS as Record<string, string>)[String(group?.forwardType || "")],
    group?.groupType,
    group?.failoverStrategy,
    group?.trafficMultiplier,
    entryGroupText,
    ...(modeLabels[mode] || []),
    ...memberParts,
  ], query);
}

type GroupLatencyPoint = {
  label: string;
  fullLabel: string;
  latency: number;
  chartLatency: number;
  isTimeout: boolean;
  probeCount?: number;
  probeSuccesses?: number;
};

type GroupLatencySeriesDatum = {
  recordedAt: string | Date;
  latencyMs?: number | null;
  isTimeout?: boolean | null;
  probeCount?: number | null;
  probeSuccesses?: number | null;
};

const groupLatencySeriesCache = new Map<number, GroupLatencySeriesDatum[]>();
const groupLatencyAnimatedKeys = new Set<number>();

function ForwardGroupLatencyDialog({
  groupId,
  groupName,
  open,
  onOpenChange,
}: {
  groupId: number;
  groupName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [peakCutEnabled, setPeakCutEnabled] = useState(false);
  const [timeRangeHours, setTimeRangeHours] = useState<LatencyTimeRangeHours>(DEFAULT_LATENCY_TIME_RANGE_HOURS);
  const { data, isLoading, isFetching } = trpc.forwardGroups.latencySeries.useQuery(
    { groupId, hours: 24 },
    { enabled: open, refetchInterval: pollingInterval("slow", open), refetchOnMount: "always" }
  );
  const cachedData = groupLatencySeriesCache.get(groupId);
  const rawSeriesData = (data ?? cachedData) as GroupLatencySeriesDatum[] | undefined;
  const waitForFreshSeries = open && isFetching && !isLatencySeriesCacheFresh(rawSeriesData);
  const seriesData = waitForFreshSeries ? undefined : rawSeriesData;
  const rangedSeriesData = useMemo(
    () => filterLatencySeriesByTimeRange(seriesData, timeRangeHours),
    [seriesData, timeRangeHours],
  );

  useEffect(() => {
    if (data) groupLatencySeriesCache.set(groupId, data as GroupLatencySeriesDatum[]);
  }, [data, groupId]);

  const rawChartData = useMemo<GroupLatencyPoint[]>(() => {
    if (!rangedSeriesData.length) return [];
    return rangedSeriesData.map((d: GroupLatencySeriesDatum): GroupLatencyPoint => {
      const counts = normalizeLatencyProbeCounts(d);
      const latency = Number(d.latencyMs) || 0;
      return {
        label: formatLatencyTimeLabel(d.recordedAt),
        fullLabel: formatLatencyTimeLabel(d.recordedAt),
        latency: counts.isTimeout ? 0 : latency,
        chartLatency: counts.isTimeout ? 0 : clipLatencyForChart(latency),
        isTimeout: counts.isTimeout,
        probeCount: counts.probeCount,
        probeSuccesses: counts.probeSuccesses,
      };
    });
  }, [rangedSeriesData]);
  const chartData = useMemo<GroupLatencyPoint[]>(() => {
    if (!peakCutEnabled) return rawChartData;
    return applyLatencyPeakCut(rawChartData, [
      { dataKey: "latency", timeoutKey: "isTimeout" },
      { dataKey: "chartLatency", timeoutKey: "isTimeout" },
    ]) as GroupLatencyPoint[];
  }, [peakCutEnabled, rawChartData]);
  const stats = useMemo(() => {
    return getLatencyStabilityStats(chartData);
  }, [chartData]);
  const yMax = useMemo(() => getLatencyYAxisMax(Math.max(...chartData.filter((d) => !d.isTimeout).map((d) => d.chartLatency), 0), 120), [chartData]);
  const yTicks = useMemo(() => getLatencyYAxisTicks(yMax), [yMax]);
  const shouldAnimateChart = open && chartData.length > 0 && !groupLatencyAnimatedKeys.has(groupId);
  useEffect(() => {
    if (shouldAnimateChart) groupLatencyAnimatedKeys.add(groupId);
  }, [groupId, shouldAnimateChart]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[96svh] w-[calc(100vw-0.75rem)] max-w-[95vw] flex-col gap-3 overflow-hidden p-3 sm:max-w-3xl sm:p-6">
        <DialogHeader>
          <div className="flex flex-col gap-2 pr-9 sm:flex-row sm:items-start sm:justify-between sm:pr-10">
            <div className="min-w-0">
              <DialogTitle>{"\u8f6c\u53d1\u94fe\u5ef6\u8fdf - "}{groupName}</DialogTitle>
              <DialogDescription>{`最近 ${latencyTimeRangeLabel(timeRangeHours)} 链路逐跳探测汇总，纯 UDP 规则使用 Ping，其余规则使用 TCPing。`}</DialogDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2 self-start sm:justify-end">
              <LatencyTimeRangeSelect value={timeRangeHours} onChange={setTimeRangeHours} />
              <LatencyPeakCutToggle id={`forward-group-peak-cut-${groupId}`} checked={peakCutEnabled} onCheckedChange={setPeakCutEnabled} className="shrink-0" />
            </div>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
        <div className="h-[42svh] min-h-[220px] rounded-lg border border-border/60 bg-muted/20 p-2 sm:h-[260px] sm:p-3">
          {(isLoading || waitForFreshSeries) && !seriesData ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在加载延迟数据
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无延迟数据</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 10, left: -8, bottom: 0 }}>
                <defs>
                  <linearGradient id="forwardGroupLatencyGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-chart-2)" stopOpacity={0.38} />
                    <stop offset="95%" stopColor="var(--color-chart-2)" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.35} />
                <XAxis dataKey="label" stroke="var(--color-muted-foreground)" fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis stroke="var(--color-muted-foreground)" fontSize={11} tickLine={false} axisLine={false} width={42} domain={[0, yMax]} ticks={yTicks} tickFormatter={(value) => `${value}ms`} />
                <RTooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const item = payload[0].payload as GroupLatencyPoint;
                    return (
                      <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
                        <p className="font-medium">{item.fullLabel}</p>
                        <p className={item.isTimeout ? "text-destructive" : "text-foreground"}>
                          {item.isTimeout ? "\u8d85\u65f6/\u4e0d\u53ef\u8fbe" : `${item.latency}ms`}
                        </p>
                        {Number(item.probeCount) > 1 && Number(item.probeSuccesses) < Number(item.probeCount) ? (
                          <p className="text-muted-foreground">
                            丢包 {Number(item.probeCount) - Number(item.probeSuccesses)}/{Number(item.probeCount)}（{(((Number(item.probeCount) - Number(item.probeSuccesses)) / Number(item.probeCount)) * 100).toFixed(0)}%）
                          </p>
                        ) : null}
                      </div>
                    );
                  }}
                />
                <Area type="monotone" dataKey="chartLatency" stroke="var(--color-chart-2)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="url(#forwardGroupLatencyGradient)" dot={false} activeDot={{ r: 4, fill: "var(--color-chart-2)", stroke: "var(--color-background)", strokeWidth: 2 }} isAnimationActive={shouldAnimateChart} animationDuration={shouldAnimateChart ? 500 : 0} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <LatencyStabilityStats stats={stats} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ForwardGroupSelfTestDialog({
  groupId,
  groupName,
  group,
  entryGroup,
  hostById,
  open,
  onOpenChange,
}: {
  groupId: number;
  groupName: string;
  group?: any | null;
  entryGroup?: any | null;
  hostById?: Map<number, any>;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const [optimisticTesting, setOptimisticTesting] = useState(false);
  const [baselineTestId, setBaselineTestId] = useState(0);
  const manualTestRef = useRef(false);
  const { data: latest } = trpc.forwardGroups.latestTest.useQuery(
    { groupId, includeActive: optimisticTesting },
    { enabled: open, refetchInterval: pollingInterval("interactive", open), refetchOnWindowFocus: false }
  );
  const lastFailureToastKey = useRef("");
  const testMutation = trpc.forwardGroups.test.useMutation({
    onSuccess: async () => {
      await utils.forwardGroups.latestTest.invalidate({ groupId });
    },
    onError: (e) => {
      setOptimisticTesting(false);
      manualTestRef.current = false;
      toast.error(e.message || "诊断没发出去");
    },
  });
  const status = latest?.status as string | undefined;
  const isServerTesting = status === "pending" || status === "running";
  const isTesting = testMutation.isPending || optimisticTesting || isServerTesting;
  const isSuccess = status === "success";
  const isFailed = !!latest && !isTesting && !isSuccess;
  const parsedMessage = useMemo(() => parseLinkTestMessage(latest?.message), [latest?.message]);
  const latestTestId = Number(latest?.id) || 0;
  const hasFreshResult = latestTestId > baselineTestId;
  const linkTestNodeData = useMemo(() => {
    const meta: Record<string, any> = {};
    const members = [...(group?.members || [])]
      .filter((member: any) => member.isEnabled !== false)
      .sort((a: any, b: any) => Number(a.priority) - Number(b.priority));
    const entryMembers = entryGroup
      ? [...(entryGroup.members || [])]
        .filter((member: any) => member.memberType === "host" && member.isEnabled !== false)
        .sort((a: any, b: any) => Number(a.priority) - Number(b.priority))
      : [];
    [...entryMembers, ...members].forEach((member: any) => {
      const hostId = Number(member.hostId || 0);
      const host = hostById?.get(hostId);
      addHostNodeMeta(meta, host, [
        member.entryAddress,
        hostId ? `主机${hostId}` : "",
        hostId ? `主机 #${hostId}` : "",
      ]);
    });
    const firstEntryHost = hostById?.get(Number(entryMembers[0]?.hostId || 0));
    const firstHost = hostById?.get(Number(members[0]?.hostId || 0));
    const lastHost = hostById?.get(Number(members[members.length - 1]?.hostId || 0));
    const targetRemark = String(group?.remark || "").trim();
    const targetLabel = targetRemark || hostDisplayName(lastHost) || groupName;
    const targetMeta = targetLabel ? { label: targetLabel } : undefined;
    if (targetMeta) addNodeMetaAliases(meta, [targetLabel, "目标", "目的节点"], targetMeta);
    const plannedSegments: LinkTestPlannedSegment[] = [];
    const hopCount = (entryMembers.length > 0 ? 1 : 0) + Math.max(0, members.length - 1);
    if (entryMembers.length > 0 && members[0]) {
      const firstChainHost = hostById?.get(Number(members[0].hostId || 0));
      entryMembers.forEach((entryMember: any) => {
        const entryHostId = Number(entryMember.hostId || 0);
        const firstChainHostId = Number(members[0].hostId || 0);
        const entryHost = hostById?.get(Number(entryMember.hostId || 0));
        plannedSegments.push({
          from: hostDisplayName(entryHost) || `入口主机 #${entryMember.hostId || "-"}`,
          to: hostDisplayName(firstChainHost) || `主机 #${members[0].hostId || "-"}`,
          fromHostId: entryHostId || null,
          toHostId: firstChainHostId || null,
          hopIndex: 0,
          hopCount,
          fromMeta: meta[hostDisplayName(entryHost)] || meta[String(entryMember.hostId || "")],
          toMeta: meta[hostDisplayName(firstChainHost)] || meta[String(members[0].hostId || "")],
        });
      });
    }
    members.slice(0, -1).forEach((member: any, index: number) => {
      const fromHostId = Number(member.hostId || 0);
      const toHostId = Number(members[index + 1]?.hostId || 0);
      const fromHost = hostById?.get(Number(member.hostId || 0));
      const toHost = hostById?.get(Number(members[index + 1]?.hostId || 0));
      plannedSegments.push({
        from: hostDisplayName(fromHost) || `主机 #${member.hostId || "-"}`,
        to: hostDisplayName(toHost) || `主机 #${members[index + 1]?.hostId || "-"}`,
        fromHostId: fromHostId || null,
        toHostId: toHostId || null,
        hopIndex: index + (entryMembers.length > 0 ? 1 : 0),
        hopCount,
        fromMeta: meta[hostDisplayName(fromHost)] || meta[String(member.hostId || "")],
        toMeta: meta[hostDisplayName(toHost)] || meta[String(members[index + 1]?.hostId || "")],
      });
    });
    return {
      nodeMeta: meta,
      sourceLabel: hostDisplayName(firstEntryHost) || hostDisplayName(firstHost) || groupName,
      targetLabel,
      plannedSegments: plannedSegments.filter((segment) => segment.from && segment.to && segment.from.trim().toLowerCase() !== segment.to.trim().toLowerCase()),
    };
  }, [entryGroup?.members, group?.members, group?.remark, groupName, hostById]);

  useEffect(() => {
    if (!open) {
      setOptimisticTesting(false);
      setBaselineTestId(0);
      manualTestRef.current = false;
      lastFailureToastKey.current = "";
    }
  }, [open]);

  useEffect(() => {
    if (optimisticTesting && hasFreshResult && !isServerTesting && latest) {
      handoffManualTestResult(
        latest,
        (result) => utils.forwardGroups.latestTest.setData(
          { groupId, includeActive: false },
          result,
        ),
        () => setOptimisticTesting(false),
      );
    }
  }, [groupId, hasFreshResult, isServerTesting, latest, optimisticTesting, utils]);

  useEffect(() => {
    const message = parsedMessage.message.trim();
    if (!open || isTesting || !isFailed || !message || !manualTestRef.current || !hasFreshResult) return;
    const key = `${groupId}:${status}:${latest?.updatedAt || ""}:${message}`;
    if (lastFailureToastKey.current !== key) {
      lastFailureToastKey.current = key;
      manualTestRef.current = false;
      toast.error("诊断没通过", { description: message });
    }
  }, [groupId, hasFreshResult, isFailed, isTesting, latest?.updatedAt, open, parsedMessage.message, status]);

  useEffect(() => {
    if (!isTesting && isSuccess) manualTestRef.current = false;
  }, [isSuccess, isTesting]);

  const plannedSegmentCount = linkTestNodeData.plannedSegments?.length || 0;
  const probeDialogSizeClass = plannedSegmentCount >= 3 ? "sm:max-w-4xl" : plannedSegmentCount >= 2 ? "sm:max-w-3xl" : "sm:max-w-xl";

  return (
    <DiagnoseDialog
      open={open}
      onOpenChange={onOpenChange}
      subjectName={groupName}
      scope="沿着链一段段测到出口"
      sizeClassName={probeDialogSizeClass}
      testing={isTesting}
      lastRunAt={latest?.updatedAt ?? null}
      outcome={isSuccess ? "success" : status === "timeout" ? "timeout" : isFailed ? "failed" : null}
      failureReason={parsedMessage.message}
      onRun={() => {
        manualTestRef.current = true;
        setBaselineTestId(latestTestId);
        setOptimisticTesting(true);
        testMutation.mutate({ groupId });
      }}
    >
      <LinkTestProbeView
        parsed={parsedMessage}
        fallbackLatencyMs={latest?.latencyMs}
        isSuccess={isSuccess}
        isTesting={isTesting}
        sourceLabel={linkTestNodeData.sourceLabel}
        targetLabel={linkTestNodeData.targetLabel}
        nodeMeta={linkTestNodeData.nodeMeta}
        plannedSegments={linkTestNodeData.plannedSegments}
      />
    </DiagnoseDialog>
  );
}

export function ForwardGroupsContent({
  mode = "failover",
  embedded = false,
  viewMode: controlledViewMode,
  onViewModeChange,
  hideHeaderActions = false,
  createRequestKey,
  editRequest,
  onEditRequestConsumed,
  searchQuery = "",
}: ForwardGroupsContentProps) {
  const utils = trpc.useUtils();
  // Keep a same-scope fallback for older/database deployments where the
  // compact options projection can fail. An error should not masquerade as an
  // empty host list and disable creation indefinitely.
  const hostsOptionsQuery = trpc.hosts.options.useQuery(undefined, {
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const useHostsFallback = hostsOptionsQuery.isError
    || (hostsOptionsQuery.isFetched && (hostsOptionsQuery.data?.length ?? 0) === 0);
  const hostsFallbackQuery = trpc.hosts.list.useQuery(undefined, {
    enabled: useHostsFallback,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const hosts = (hostsOptionsQuery.data?.length ?? 0) > 0
    ? hostsOptionsQuery.data
    : hostsFallbackQuery.data ?? hostsOptionsQuery.data;
  const { data: tunnels } = trpc.tunnels.options.useQuery();
  const { data: settings } = trpc.system.getSettings.useQuery();
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<GroupForm>(makeDefaultForm());
  const savedMembersRef = useRef<Record<string, MemberForm[]>>({ host: [], tunnel: [] });
  const [dragMemberKey, setDragMemberKey] = useState<string | null>(null);
  const [internalViewMode, setInternalViewMode] = useState<ForwardGroupViewMode>(() => getStoredForwardGroupViewMode());
  const [latencyGroup, setLatencyGroup] = useState<{ id: number; name: string } | null>(null);
  const [testGroup, setTestGroup] = useState<{ id: number; name: string } | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<any | null>(null);
  // 点开故障转移策略面板的那个组。只存 id：面板跟着列表轮询刷新，不拿一份旧快照。
  const [policyGroupId, setPolicyGroupId] = useState<number | null>(null);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const lastCreateRequestKeyRef = useRef(createRequestKey ?? 0);
  const lastEditRequestKeyRef = useRef(0);
  const closeResetTimerRef = useRef<number | null>(null);
  const activeGroupMode = mode;
  const viewMode = controlledViewMode ?? internalViewMode;
  const groupPageRequest = usePersistentPageRequest(`forwardx.forwardGroups.${activeGroupMode}.page`);
  const groupPageFilterKey = `${activeGroupMode}:${searchQuery.trim()}`;
  const previousGroupPageFilterKey = useRef(groupPageFilterKey);
  useEffect(() => {
    if (previousGroupPageFilterKey.current === groupPageFilterKey) return;
    previousGroupPageFilterKey.current = groupPageFilterKey;
    groupPageRequest.setPage(1);
  }, [groupPageFilterKey, groupPageRequest.setPage]);
  const groupPageInput = {
    page: groupPageRequest.page,
    pageSize: 12,
    groupMode: activeGroupMode,
    search: searchQuery,
  } as const;
  const groupPageQuery = trpc.forwardGroups.listPage.useQuery(groupPageInput, {
    refetchInterval: pollingInterval("normal"),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const needsFullGroupList = showDialog || !!latencyGroup || !!testGroup || !!editRequest;
  const fullGroupQuery = trpc.forwardGroups.options.useQuery(undefined, {
    enabled: needsFullGroupList,
    refetchInterval: pollingInterval("normal"),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const pageGroups = (groupPageQuery.data?.items || []) as any[];
  const relatedPageGroups = (groupPageQuery.data?.relatedGroups || []) as any[];
  const groups = (fullGroupQuery.data || [...pageGroups, ...relatedPageGroups]) as any[];
  const isLoading = groupPageQuery.isLoading;
  const telegramSettingsLoaded = settings !== undefined;
  const telegramReady = telegramSettingsLoaded && !!settings?.telegram?.enabled && !!settings?.telegram?.configured;
  const forwardProtocolSettings = useMemo(
    () => normalizeForwardProtocolSettings(settings?.forwardProtocols),
    [settings?.forwardProtocols]
  );
  const availableForwardTypes = useMemo(
    () => FORWARD_TYPES.filter((type) => forwardProtocolSettings[type] !== false),
    [forwardProtocolSettings]
  );
  const deleteImpactQuery = trpc.forwardGroups.deleteImpact.useQuery(
    { id: Number(deleteGroup?.id || 0) },
    { enabled: !!deleteGroup },
  );

  const hostById = useMemo(() => new Map<number, any>((hosts || []).map((h: any) => [Number(h.id), h])), [hosts]);
  const tunnelById = useMemo(() => new Map<number, any>((tunnels || []).map((t: any) => [Number(t.id), t])), [tunnels]);
  const groupsByMode = useMemo(() => {
    const next: Record<GroupMode, any[]> = { port: [], failover: [], chain: [], entry: [], exit: [] };
    for (const group of groups || []) next[normalizeGroupMode(group.groupMode)].push(group);
    return next;
  }, [groups]);
  const usableEntryGroups = useMemo(() => groupsByMode.entry.filter((group: any) => group.isEnabled && String(group.domain || "").trim()), [groupsByMode.entry]);
  const entryGroupHostIds = (entryGroupId: number | null | undefined) => {
    const id = Number(entryGroupId || 0);
    if (!id) return [] as number[];
    const group = groupsByMode.entry.find((item: any) => Number(item.id) === id);
    return (group?.members || [])
      .filter((member: any) => member.memberType === "host" && member.isEnabled !== false)
      .map((member: any) => Number(member.hostId || 0))
      .filter((hostId: number) => hostId > 0);
  };
  const applyEntryGroupToChainForm = (prev: GroupForm, entryGroupId: number | null): GroupForm => {
    const excludedIds = new Set(entryGroupHostIds(entryGroupId));
    const members = excludedIds.size > 0
      ? prev.members.filter((member) => !excludedIds.has(Number(member.hostId || 0)))
      : prev.members;
    const hostIds = members.map((member) => Number(member.hostId || 0)).filter(Boolean);
    const normalizedConnectHosts = normalizeChainConnectHostsForHosts(
      members.map((item) => item.connectHost || null),
      hostIds,
      hosts,
      !!entryGroupId,
    );
    return {
      ...prev,
      entryGroupId,
      members: members.map((member, index) => ({
        ...member,
        connectHost: normalizedConnectHosts[index] || null,
      })),
    };
  };
  const rawVisibleGroups = pageGroups;
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const visibleGroups = rawVisibleGroups;
  const groupOrder = useOptimisticSortableOrder({
    items: visibleGroups,
    getId: (group: any) => Number(group.id),
  });
  const orderedVisibleGroups = groupOrder.items;
  const modeTotal = Number(groupPageQuery.data?.scopeTotalItems || 0);
  const groupConfigStateById = useMemo(() => buildLinkAvailabilityIndex({
    hosts,
    tunnels,
    groups,
    isTunnelSupported: (tunnel: any) => {
      const mode = String(tunnel?.mode || "").toLowerCase();
      return (TUNNEL_PROTOCOLS as readonly string[]).includes(mode)
        && forwardProtocolSettings[mode as keyof typeof forwardProtocolSettings] !== false;
    },
  }).groupAvailabilityById, [forwardProtocolSettings, groups, hosts, tunnels]);
  const getGroupConfigState = (group: any) => groupConfigStateById.get(Number(group?.id || 0)) || {
    status: "unavailable" as const,
    available: false,
    message: "转发组配置不可用。",
    source: "config" as const,
    usableHostIds: new Set<number>(),
    usableMemberIds: new Set<number>(),
  };
  const isGroupMemberActive = (group: any, member: any) => {
    if (!group || !member || group.isEnabled === false) return false;
    const state = getGroupConfigState(group);
    const memberId = Number(member.id || 0);
    if (memberId > 0 && state.usableMemberIds.size > 0) return state.usableMemberIds.has(memberId);
    return member.isEnabled !== false && state.available;
  };
  const activeCount = Number(groupPageQuery.data?.enabledItems || 0);
  const groupPagination = useServerPagination(orderedVisibleGroups, Number(groupPageQuery.data?.totalItems || 0), groupPageRequest, {
    pageSize: 12,
    isReady: !isLoading && !!groupPageQuery.data,
  });
  const pagedGroups = groupPagination.items;
  const testGroupDetail = useMemo(
    () => testGroup ? (groups || []).find((group: any) => Number(group.id) === Number(testGroup.id)) || null : null,
    [groups, testGroup?.id]
  );
  const testGroupEntryGroup = useMemo(
    () => testGroupDetail?.entryGroupId
      ? (groups || []).find((group: any) => Number(group.id) === Number(testGroupDetail.entryGroupId)) || null
      : null,
    [groups, testGroupDetail?.entryGroupId]
  );

  const resetForm = () => {
    setForm(makeDefaultForm());
    setEditingId(null);
    setDragMemberKey(null);
    setAdvancedSettingsOpen(false);
    savedMembersRef.current = { host: [], tunnel: [] };
  };

  const clearCloseResetTimer = () => {
    if (closeResetTimerRef.current !== null) {
      window.clearTimeout(closeResetTimerRef.current);
      closeResetTimerRef.current = null;
    }
  };

  const closeDialog = () => {
    setShowDialog(false);
    clearCloseResetTimer();
    closeResetTimerRef.current = window.setTimeout(() => {
      resetForm();
      closeResetTimerRef.current = null;
    }, 220);
  };

  const handleDialogOpenChange = (open: boolean) => {
    if (open) {
      clearCloseResetTimer();
      setShowDialog(true);
      return;
    }
    closeDialog();
  };

  useEffect(() => () => clearCloseResetTimer(), []);

  const openCreate = () => {
    clearCloseResetTimer();
    const initial = makeDefaultForm();
    setForm({
      ...initial,
      groupMode: activeGroupMode,
      groupType: "host" as const,
      forwardType: availableForwardTypes[0] || initial.forwardType,
      domain: activeGroupMode === "failover" || activeGroupMode === "entry" ? initial.domain : "",
      recordType: activeGroupMode === "chain" || activeGroupMode === "exit" ? "A" : initial.recordType,
    });
    setEditingId(null);
    setDragMemberKey(null);
    setAdvancedSettingsOpen(false);
    savedMembersRef.current = { host: [], tunnel: [] };
    setShowDialog(true);
  };

  useEffect(() => {
    if (createRequestKey === undefined || createRequestKey === lastCreateRequestKeyRef.current) return;
    lastCreateRequestKeyRef.current = createRequestKey;
    if (createRequestKey > 0) openCreate();
  }, [createRequestKey]);

  const openEdit = (group: any) => {
    clearCloseResetTimer();
    const groupMode = normalizeGroupMode(group.groupMode);
    const normalizedMembers = (group.members || []).reduce((acc: MemberForm[], member: any) => {
      if (member.memberType === "host") {
        const hostId = member.hostId ? Number(member.hostId) : null;
        if (!hostId) return acc;
        acc.push({
          key: memberKey("host", hostId),
          memberType: "host",
          hostId,
          tunnelId: null,
          connectHost: member.connectHost || null,
          isEnabled: !!member.isEnabled,
          bandwidthMbps: String(Math.max(0, Number(member.bandwidthMbps) || 0)),
          aggregationWeight: String(Math.max(0, Number(member.aggregationWeight) || 0)),
        });
        return acc;
      }

      if (groupMode !== "failover") return acc;

      const tunnel = tunnelById.get(Number(member.tunnelId || 0));
      const hostId = tunnel?.entryHostId ? Number(tunnel.entryHostId) : null;
      if (!hostId || acc.some((item) => item.hostId === hostId)) return acc;
      acc.push({
        key: memberKey("host", hostId),
        memberType: "host",
        hostId,
        tunnelId: null,
        connectHost: null,
        isEnabled: !!member.isEnabled,
        bandwidthMbps: "0",
        aggregationWeight: "0",
      });
      return acc;
    }, []);

    setForm({
      name: group.name || "",
      groupMode,
      exitStrategy: normalizeExitGroupStrategy(group.exitStrategy),
      entryGroupId: group.entryGroupId ? Number(group.entryGroupId) : null,
      groupType: "host",
      protocol: normalizeForwardRuleProtocol(group.protocol, "both"),
      forwardType: FORWARD_TYPES.includes(group.forwardType as ForwardType) ? group.forwardType : "iptables",
      proxyProtocolReceive: !!group.proxyProtocolReceive,
      proxyProtocolSend: !!group.proxyProtocolSend,
      proxyProtocolVersion: Number(group.proxyProtocolVersion) === 2 ? 2 : 1,
      // Realm 2.9.x no longer supports its legacy fast_open/zero_copy keys.
      // Keep old fields readable but never expose stale enabled state.
      tcpFastOpen: false,
      zeroCopy: false,
      udpOverTcp: !!group.udpOverTcp,
      udpOverTcpPort: Number(group.udpOverTcpPort || 0),
      failoverEnabled: false,
      failoverStrategy: "fallback" as const,
      failoverTargetsText: "",
      domain: group.domain || "",
      recordType: group.recordType || "A",
      failoverSeconds: String(Number(group.failoverSeconds || 60)),
      recoverSeconds: String(Number(group.recoverSeconds || 120)),
      rateLimitMbps: String(Math.max(0, Number(group.rateLimitMbps) || 0)),
      trafficMultiplier: String(trafficMultiplierToInputValue(group.trafficMultiplier)).replace(/\.?0+$/, ""),
      chinaHealthCheckEnabled: !!group.chinaHealthCheckEnabled,
      chinaHealthCheckTarget: group.chinaHealthCheckTarget || "",
      chinaHealthCheckMethod: normalizeForwardGroupHealthCheckMethod(group.chinaHealthCheckMethod),
      telegramSwitchNotifyEnabled: !!group.telegramSwitchNotifyEnabled,
      ddnsAutoResolveEnabled: group.ddnsAutoResolveEnabled !== false,
      bandwidthAggregationEnabled: !!group.bandwidthAggregationEnabled,
      bandwidthAggregationStrategy: normalizeBandwidthAggregationStrategy(group.bandwidthAggregationStrategy),
      bandwidthAggregationSlots: String(normalizeAggregationRecordSlots(group.bandwidthAggregationSlots)),
      bandwidthAggregationMinMembers: String(normalizeAggregationMinMembers(group.bandwidthAggregationMinMembers)),
      autoFailback: !!group.autoFailback,
      isEnabled: !!group.isEnabled,
      members: normalizedMembers,
    });
    setEditingId(Number(group.id));
    setAdvancedSettingsOpen(false);
    setShowDialog(true);
  };

  useEffect(() => {
    if (!editRequest || editRequest.requestKey === lastEditRequestKeyRef.current) return;
    const group = groups.find((item: any) => Number(item.id) === Number(editRequest.id));
    if (group) {
      lastEditRequestKeyRef.current = editRequest.requestKey;
      openEdit(group);
      onEditRequestConsumed?.();
    }
  }, [editRequest?.id, editRequest?.requestKey, groups, onEditRequestConsumed]);

  const createMutation = trpc.forwardGroups.create.useMutation({
    onSuccess: () => {
      utils.forwardGroups.options.invalidate();
      utils.forwardGroups.listPage.invalidate();
      utils.rules.list.invalidate();
      closeDialog();
      toast.success(`${currentModeMeta.title}已创建`);
    },
    onError: (e) => toast.error(e.message || "创建失败"),
  });

  const updateMutation = trpc.forwardGroups.update.useMutation({
    onSuccess: async (result) => {
      const updatedGroup = result?.group;
      const cachedGroups = utils.forwardGroups.options.getData();
      if (updatedGroup && cachedGroups) {
        utils.forwardGroups.options.setData(
          undefined,
          cachedGroups.map((group: any) => Number(group.id) === Number(updatedGroup.id)
            ? { ...group, ...updatedGroup }
            : group) as any,
        );
      }
      closeDialog();
      toast.success(`${currentModeMeta.title}已更新`);
      await Promise.all([
        utils.forwardGroups.options.invalidate(),
        utils.forwardGroups.listPage.invalidate(),
        utils.tunnels.list.invalidate(),
        utils.tunnels.options.invalidate(),
        utils.tunnels.listPage.invalidate(),
        utils.tunnels.mapItems.invalidate(),
        utils.tunnels.listAll.invalidate(),
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
        utils.rules.mapItems.invalidate(),
        utils.rules.listSummary.invalidate(),
        utils.trafficBilling.configs.invalidate(),
        utils.trafficBilling.storeResources.invalidate(),
      ]);
    },
    onError: (e) => toast.error(e.message || "更新失败"),
  });

  const toggleMutation = trpc.forwardGroups.toggle.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.forwardGroups.options.invalidate(),
        utils.forwardGroups.listPage.invalidate(),
        utils.tunnels.list.invalidate(),
        utils.tunnels.options.invalidate(),
        utils.tunnels.listPage.invalidate(),
        utils.tunnels.listAll.invalidate(),
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
        utils.rules.mapItems.invalidate(),
        utils.rules.listSummary.invalidate(),
      ]);
    },
  });

  const deleteMutation = trpc.forwardGroups.delete.useMutation({
    onSuccess: () => {
      utils.forwardGroups.options.invalidate();
      utils.forwardGroups.listPage.invalidate();
      utils.rules.list.invalidate();
      setDeleteGroup(null);
      toast.success("已删除，引用规则将同步清理");
    },
    onError: (e) => toast.error(e.message || "删除失败"),
  });

  const syncMutation = trpc.forwardGroups.sync.useMutation({
    onSuccess: () => {
      utils.forwardGroups.options.invalidate();
      utils.forwardGroups.listPage.invalidate();
      utils.rules.list.invalidate();
      toast.success("已同步链路成员规则");
    },
    onError: (e) => toast.error(e.message || "同步失败"),
  });

  const runFailoverMutation = trpc.forwardGroups.runFailover.useMutation({
    onSuccess: () => {
      utils.forwardGroups.options.invalidate();
      utils.forwardGroups.listPage.invalidate();
      toast.success("已执行一次故障转移检查");
    },
    onError: (e) => toast.error(e.message || "执行失败"),
  });

  /*
    故障转移策略面板上的两个手动操作，用的是现成的两个接口：
      换一个首选 = reorder（改成员顺序，一直有效），服务端改完立刻按新顺序重选一次；
      现在重新选 = sync（卡片上「同步」那个按钮做的事），不等观察时间直接挑最前面的健康成员。
    各自一份 mutation：共用 syncMutation 的话，成功提示会是「已同步链路成员规则」，答非所问。
  */
  const preferMemberMutation = trpc.forwardGroups.reorder.useMutation({
    onSuccess: () => {
      utils.forwardGroups.options.invalidate();
      utils.forwardGroups.listPage.invalidate();
      toast.success("成员顺序已改，已按新顺序重新选了一次");
    },
    onError: (e) => toast.error(e.message || "调整成员顺序失败"),
  });
  const reselectMutation = trpc.forwardGroups.sync.useMutation({
    onSuccess: () => {
      utils.forwardGroups.options.invalidate();
      utils.forwardGroups.listPage.invalidate();
      toast.success("已按成员顺序重新选了一次");
    },
    onError: (e) => toast.error(e.message || "重新选失败"),
  });

  const reorderGroupsMutation = trpc.forwardGroups.reorderGroups.useMutation({
    onError: (e) => toast.error(e.message || "排序保存失败"),
  });
  const groupReorderPending = reorderGroupsMutation.isPending;
  const groupSortable = useSortableReorder({
    items: pagedGroups,
    getId: (group: any) => Number(group.id),
    disabled: groupPageQuery.isPlaceholderData
      || !!normalizedSearchQuery
      || groupReorderPending
      || pagedGroups.length < 2,
    onReorder: (nextGroups) => {
      const requestId = groupOrder.begin(nextGroups);
      reorderGroupsMutation.mutate({
        groupMode: activeGroupMode,
        ids: nextGroups.map((group: any) => Number(group.id)),
        startIndex: (groupPagination.currentPage - 1) * groupPagination.pageSize,
      }, {
        onError: () => groupOrder.release(requestId),
        onSettled: () => groupOrder.resync(requestId, () => Promise.all([
          utils.forwardGroups.options.invalidate(),
          utils.forwardGroups.listPage.invalidate(),
        ])),
      });
    },
  });

  const effectiveGroupType = form.groupMode === "failover" || form.groupMode === "port" || form.groupMode === "chain" || isCollectionMode(form.groupMode) ? "host" : form.groupType;
  const availableMemberOptions = effectiveGroupType === "host"
    ? (hosts || []).map((h: any) => ({ id: Number(h.id), label: h.name, meta: h.entryIp || h.ip || "", host: h }))
    : (tunnels || []).map((t: any) => ({
      id: Number(t.id),
      label: t.name,
      meta: getTunnelRouteText(t, hosts),
    }));
  const showExitAddressColumns = form.groupMode === "exit" && effectiveGroupType === "host";
  // Entry groups running bandwidth aggregation get per-front-VPS uplink and
  // weight columns, so the member table gains two fields.
  const showAggregationColumns = form.groupMode === "entry"
    && form.bandwidthAggregationEnabled
    && effectiveGroupType === "host";
  const memberRowGridClass = showExitAddressColumns
    ? "sm:grid-cols-[auto_auto_minmax(8rem,1fr)_56px_56px_52px_36px]"
    : showAggregationColumns
      ? "sm:grid-cols-[auto_auto_minmax(8rem,1fr)_92px_72px_52px_36px]"
      : "sm:grid-cols-[auto_auto_minmax(8rem,1fr)_52px_36px]";
  const updateMemberField = (key: string, patch: Partial<MemberForm>) => {
    setForm((prev) => ({
      ...prev,
      members: prev.members.map((member) => (member.key === key ? { ...member, ...patch } : member)),
    }));
  };

  const addMember = (id: number) => {
    if (!id) return;
    if (form.groupMode === "port" && form.members.length >= 1) {
      toast.error("端口转发只能选择 1 台所属主机");
      return;
    }
    if ((form.groupMode === "chain" || isCollectionMode(form.groupMode)) && form.members.length >= MAX_FORWARD_GROUP_MEMBERS) {
      toast.error(form.groupMode === "chain"
        ? `转发链最多支持 ${MAX_FORWARD_GROUP_MEMBERS} 台主机`
        : `入口组/出口组最多支持 ${MAX_FORWARD_GROUP_MEMBERS} 台主机`);
      return;
    }
    const effectiveType = effectiveGroupType;
    const key = memberKey(effectiveType, id);
    if (form.members.some((m) => m.key === key)) {
      toast.error("成员已存在");
      return;
    }
    setForm({
      ...form,
      members: [
        ...form.members,
        {
          key,
          memberType: effectiveType,
          hostId: effectiveType === "host" ? id : null,
          tunnelId: effectiveType === "tunnel" ? id : null,
          connectHost: null,
          isEnabled: true,
          bandwidthMbps: "0",
          aggregationWeight: "0",
        },
      ],
    });
  };

  const setPortHost = (id: number) => {
    if (!id) return;
    setForm({
      ...form,
      members: [{
        key: memberKey("host", id),
        memberType: "host",
        hostId: id,
        tunnelId: null,
        connectHost: null,
        isEnabled: true,
        bandwidthMbps: "0",
        aggregationWeight: "0",
      }],
    });
  };

  const removeMember = (key: string) => {
    setForm({ ...form, members: form.members.filter((m) => m.key !== key) });
  };

  const updateExitMemberUsePrivate = (key: string, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      members: prev.members.map((member) => {
        if (member.key !== key) return member;
        const host = hostById.get(Number(member.hostId || 0));
        const privateAddr = hostPrivateAddress(host);
        if (checked && !privateAddr) {
          toast.error("该主机未配置隧道内网 IP");
          return member;
        }
        return { ...member, connectHost: checked ? privateAddr : null };
      }),
    }));
  };

  const updateExitMemberUseIpv6 = (key: string, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      members: prev.members.map((member) => {
        if (member.key !== key) return member;
        const host = hostById.get(Number(member.hostId || 0));
        const ipv6Addr = hostIpv6Address(host);
        if (checked && !ipv6Addr) {
          toast.error("该主机暂无IPv6");
          return member;
        }
        return { ...member, connectHost: checked ? ipv6Addr : null };
      }),
    }));
  };

  const updateChainMemberIds = (ids: number[]) => {
    setForm((prev) => {
      const rawConnectHosts = ids.map((id) => {
        const existing = prev.members.find((member) => member.key === memberKey("host", id));
        return existing?.connectHost || null;
      });
      const normalizedConnectHosts = normalizeChainConnectHostsForHosts(
        rawConnectHosts,
        ids,
        hosts,
        !!prev.entryGroupId,
      );
      const nextMembers = ids.map((id, index) => {
        const key = memberKey("host", id);
        const existing = prev.members.find((member) => member.key === key);
        return {
          ...(existing || {
            key,
            memberType: "host" as GroupType,
            hostId: id,
            tunnelId: null,
            isEnabled: true,
            bandwidthMbps: "0",
            aggregationWeight: "0",
          }),
          key,
          memberType: "host" as GroupType,
          hostId: id,
          tunnelId: null,
          connectHost: normalizedConnectHosts[index] || null,
          isEnabled: true,
        };
      });
      if (
        sameNumberArray(prev.members.map((member) => Number(member.hostId || 0)), ids)
        && sameNullableStringArray(prev.members.map((member) => member.connectHost || null), normalizedConnectHosts)
      ) {
        return prev;
      }
      return { ...prev, members: nextMembers };
    });
  };

  const updateChainConnectHosts = (connectHosts: Array<string | null>) => {
    setForm((prev) => {
      const hostIds = prev.members.map((member) => Number(member.hostId || 0)).filter(Boolean);
      const normalizedConnectHosts = normalizeChainConnectHostsForHosts(connectHosts, hostIds, hosts, !!prev.entryGroupId);
      if (sameNullableStringArray(prev.members.map((member) => member.connectHost || null), normalizedConnectHosts)) {
        return prev;
      }
      return {
        ...prev,
        members: prev.members.map((member, index) => ({
          ...member,
          connectHost: normalizedConnectHosts[index] || null,
        })),
      };
    });
  };

  const moveMember = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    const items = [...form.members];
    const from = items.findIndex((m) => m.key === fromKey);
    const to = items.findIndex((m) => m.key === toKey);
    if (from < 0 || to < 0) return;
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    setForm({ ...form, members: items });
  };

  const handleSubmit = () => {
    const isPortMode = form.groupMode === "port";
    const isFailoverMode = form.groupMode === "failover";
    const isChainGroup = form.groupMode === "chain";
    const isEntryGroup = form.groupMode === "entry";
    const isExitGroup = form.groupMode === "exit";
    const supportsChinaHealth = isFailoverMode || isEntryGroup;
    const supportsSwitchNotify = isFailoverMode || isEntryGroup;
    if (!form.name.trim()) return toast.error(isPortMode ? "请填写端口转发名称" : isChainGroup ? "请填写转发链名称" : "请填写组名称");
    if (isPortMode) {
      if (form.members.length !== 1) return toast.error("端口转发需要选择 1 台所属主机");
    } else if (isChainGroup) {
      const minChainMembers = form.entryGroupId ? 1 : 2;
      if (form.members.length < minChainMembers || form.members.length > MAX_FORWARD_GROUP_MEMBERS) {
        return toast.error(form.entryGroupId
          ? `转发链需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台主机`
          : `转发链需要配置 2-${MAX_FORWARD_GROUP_MEMBERS} 台主机`);
      }
    } else if (isEntryGroup || isExitGroup) {
      if (form.members.length < 1 || form.members.length > MAX_FORWARD_GROUP_MEMBERS) {
        return toast.error(isEntryGroup
          ? `入口组需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台主机`
          : `出口组需要配置 1-${MAX_FORWARD_GROUP_MEMBERS} 台主机`);
      }
    } else if (form.members.length === 0) {
      return toast.error("请至少添加一个成员");
    }
    if ((isFailoverMode || isEntryGroup) && !form.domain.trim()) {
      return toast.error(isEntryGroup ? "入口组需要指定入口域名" : "请填写 DDNS 域名");
    }
    if (isFailoverMode || isEntryGroup) {
      const missingRecordMembers = form.members
        .filter((member) => member.isEnabled !== false)
        .filter((member) => {
          if (member.memberType === "host") {
            const host = hostById.get(Number(member.hostId || 0));
            return !forwardGroupRecordValueForHost(host, form.recordType);
          }
          const tunnel = tunnelById.get(Number(member.tunnelId || 0));
          const host = hostById.get(Number(tunnel?.entryHostId || 0));
          return !forwardGroupRecordValueForHost(host, form.recordType);
        })
        .map((member) => memberLabel(member));
      if (missingRecordMembers.length > 0) {
        return toast.error(`${form.recordType} 记录需要成员配置${forwardGroupRecordRequirement(form.recordType)}：${missingRecordMembers.slice(0, 5).join("、")}`);
      }
    }
    const failoverSeconds = Number(form.failoverSeconds);
    const recoverSeconds = Number(form.recoverSeconds);
    if (!Number.isInteger(failoverSeconds) || failoverSeconds < 10 || failoverSeconds > 3600) {
      return toast.error("切换时间需为 10-3600 秒的整数");
    }
    if (!Number.isInteger(recoverSeconds) || recoverSeconds < 10 || recoverSeconds > 3600) {
      return toast.error("恢复观察需为 10-3600 秒的整数");
    }
    const trafficMultiplierValue = Number(form.trafficMultiplier);
    if ((isPortMode || isChainGroup || isFailoverMode) && (!Number.isFinite(trafficMultiplierValue) || trafficMultiplierValue < 0.01 || trafficMultiplierValue > 50)) {
      return toast.error("流量倍率必须在 0.01 - 50 之间");
    }
    const rateLimitMbps = Number(form.rateLimitMbps);
    if ((isPortMode || isChainGroup || isFailoverMode) && (!Number.isInteger(rateLimitMbps) || rateLimitMbps < 0 || rateLimitMbps > 1_000_000)) {
      return toast.error("限速必须为 0 - 1000000 之间的整数 Mbps");
    }
    const trafficMultiplier = trafficMultiplierFromInput(trafficMultiplierValue);
    const runtimeConfigSupported = isPortMode || isChainGroup || isFailoverMode;
    const runtimeTcpOptionsSupported = runtimeConfigSupported && form.protocol !== "udp";
    const chinaHealthTarget = normalizeChinaHealthTargetInput(form.chinaHealthCheckTarget, form.chinaHealthCheckMethod);
    if (supportsChinaHealth && form.chinaHealthCheckEnabled && chinaHealthTarget === undefined) {
      return toast.error("入口健康度检测目标格式不正确");
    }
    if (supportsSwitchNotify && form.telegramSwitchNotifyEnabled && telegramSettingsLoaded && !telegramReady) {
      return toast.error("请先在系统设置中配置并启用 Telegram 机器人");
    }
    const payload = {
      ...form,
      name: form.name.trim(),
      remark: null,
      entryGroupId: isChainGroup ? form.entryGroupId || null : null,
      groupType: "host" as const,
      exitStrategy: isExitGroup ? normalizeExitGroupStrategy(form.exitStrategy) : "round_robin",
      domain: isFailoverMode || isEntryGroup ? form.domain.trim() || null : null,
      recordType: isChainGroup || isExitGroup ? "A" : form.recordType,
      failoverSeconds,
      recoverSeconds,
      rateLimitMbps: runtimeConfigSupported ? rateLimitMbps : 0,
      trafficMultiplier: runtimeConfigSupported ? trafficMultiplier : 100,
      protocol: runtimeConfigSupported ? form.protocol : "both",
      forwardType: form.forwardType,
      proxyProtocolReceive: runtimeTcpOptionsSupported && (form.forwardType === "gost" || form.forwardType === "realm") && form.proxyProtocolReceive,
      proxyProtocolSend: runtimeTcpOptionsSupported && (form.forwardType === "gost" || form.forwardType === "realm") && form.proxyProtocolSend,
      proxyProtocolExitReceive: false,
      proxyProtocolExitSend: false,
      proxyProtocolVersion: runtimeConfigSupported && Number(form.proxyProtocolVersion) === 2 ? 2 : 1,
      tcpFastOpen: false,
      zeroCopy: false,
      udpOverTcp: false,
      udpOverTcpPort: null,
      failoverEnabled: false,
      failoverStrategy: "fallback" as const,
      failoverTargets: [],
      chinaHealthCheckEnabled: supportsChinaHealth && form.chinaHealthCheckEnabled,
      chinaHealthCheckTarget: supportsChinaHealth && form.chinaHealthCheckEnabled ? chinaHealthTarget || null : null,
      chinaHealthCheckMethod: form.chinaHealthCheckMethod,
      telegramSwitchNotifyEnabled: supportsSwitchNotify && form.telegramSwitchNotifyEnabled,
      ddnsAutoResolveEnabled: isEntryGroup ? form.ddnsAutoResolveEnabled : true,
      bandwidthAggregationEnabled: isEntryGroup && form.bandwidthAggregationEnabled,
      bandwidthAggregationStrategy: normalizeBandwidthAggregationStrategy(form.bandwidthAggregationStrategy),
      bandwidthAggregationSlots: normalizeAggregationRecordSlots(form.bandwidthAggregationSlots),
      bandwidthAggregationMinMembers: normalizeAggregationMinMembers(form.bandwidthAggregationMinMembers),
      members: form.members.map((member, index) => ({
        memberType: member.memberType,
        hostId: member.hostId,
        tunnelId: member.tunnelId,
        connectHost: isChainGroup || isExitGroup ? member.connectHost || null : null,
        isEnabled: isPortMode || isChainGroup ? true : member.isEnabled,
        priority: index,
        // Bandwidth aggregation is an entry group concept; other modes send 0.
        bandwidthMbps: isEntryGroup ? normalizeMemberBandwidthMbps(member.bandwidthMbps) : 0,
        aggregationWeight: isEntryGroup ? normalizeMemberWeight(member.aggregationWeight) : 0,
      })),
    };
    if (editingId) updateMutation.mutate({ id: editingId, ...payload });
    else createMutation.mutate(payload);
  };

  const renderGroupEnabledSwitch = (group: any) => {
    const groupId = Number(group?.id || 0);
    const enabled = !!group?.isEnabled;
    const resourceLabel = groupModeDisplayLabel(group?.groupMode);
    return (
      <OptimisticSwitch
        checked={enabled}
        disabled={!groupId}
        onCheckedChangeAsync={(checked) => toggleMutation.mutateAsync({ id: groupId, isEnabled: checked })}
        onToggleSuccess={(checked) => toast.success(`${resourceLabel}已${checked ? "开启" : "关闭"}`)}
        onToggleError={(error) => toast.error(error instanceof Error ? error.message : `切换${resourceLabel}状态失败`)}
        className="switch-compact"
        title={enabled ? "关闭后该资源及关联规则将停止下发和转发" : "开启后将恢复此前由该资源受控关闭的规则"}
        aria-label={`${enabled ? "停用" : "启用"}${group?.name || "链路资源"}`}
      />
    );
  };

  const groupStatusBadge = (group: any) => {
    const configState = getGroupConfigState(group);
    if (configState.status === "disabled") return <Badge variant="outline">停用</Badge>;
    if (configState.status === "available") return <Badge className="border-[color-mix(in_srgb,var(--fx-healthy)_20%,transparent)] bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)] hover:bg-[color-mix(in_srgb,var(--fx-healthy)_20%,transparent)] hover:text-[var(--fx-healthy-text)] dark:hover:bg-[color-mix(in_srgb,var(--fx-healthy)_20%,transparent)] dark:hover:text-[var(--fx-healthy-text)]">可用</Badge>;
    if (configState.status === "degraded") return <Badge className="border-[color-mix(in_srgb,var(--fx-warn)_25%,transparent)] bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)] hover:bg-[var(--fx-warn-soft)]">部分可用</Badge>;
    if (configState.status === "pending") return <Badge variant="secondary">等待检测</Badge>;
    return <Badge variant="destructive">不可用</Badge>;
  };

  const memberLabel = (member: any) => {
    if (member.memberType === "host") return hostById.get(Number(member.hostId))?.name || `主机 #${member.hostId}`;
    const tunnel = tunnelById.get(Number(member.tunnelId));
    return tunnel ? `${tunnel.name} / ${getTunnelRouteText(tunnel, hosts)}` : `隧道 #${member.tunnelId}`;
  };

  /*
    系统 DDNS 没开时，面板照样按顺序挑成员，但只记成「建议入口」，解析不改 —— 策略面板要照实
    说「建议」而不是「解析到」。设置还没加载出来时是 undefined，按开着说。
  */
  const groupPolicyOptions: GroupRoutePolicyOptions = {
    ddnsSwitching: settings?.ddns ? !!settings.ddns.enabled && settings.ddns.provider !== "disabled" : undefined,
    memberLabel: (member) => memberLabel(member),
  };

  /*
    编辑框里「故障转移」那一块下面那几句话：拿还没保存的表单走同一份模型算。按「有规则在用」
    来算 —— 编辑框要说的是「这样配会怎么做」；新建的组还没有规则，照实算的话「恢复后切回」那
    一句会变成「一直挑最前面在线的」，跟着勾选框一动不动。
  */
  const formGroupPolicy = showDialog && form.groupMode === "failover"
    ? describeGroupRoutePolicy({
      groupMode: "failover",
      isEnabled: form.isEnabled,
      domain: form.domain,
      recordType: form.recordType,
      failoverSeconds: form.failoverSeconds,
      recoverSeconds: form.recoverSeconds,
      autoFailback: form.autoFailback,
      chinaHealthCheckEnabled: form.chinaHealthCheckEnabled,
      chinaHealthCheckTarget: form.chinaHealthCheckTarget,
      chinaHealthCheckMethod: form.chinaHealthCheckMethod,
      templateRuleCount: 1,
      members: form.members.map((member, index) => ({
        memberType: member.memberType,
        hostId: member.hostId,
        tunnelId: member.tunnelId,
        priority: index,
        isEnabled: member.isEnabled,
      })),
    }, groupPolicyOptions)
    : null;

  /** 故障转移组的「解析 · HK entry 01」：点开是策略面板，和规则卡上的「主备 · 备用 1」同一个东西。 */
  const renderGroupPolicyBadge = (group: any) => {
    if (normalizeGroupMode(group.groupMode) !== "failover") return null;
    const display = describeGroupPolicyDisplay(group, groupPolicyOptions);
    if (!display) return null;
    return (
      <button
        type="button"
        className="inline-flex min-w-0 max-w-full shrink items-center rounded-[var(--fx-radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setPolicyGroupId(Number(group.id))}
        title={display.title}
        aria-label={`故障转移策略：${display.title}`}
      >
        <Badge
          variant="outline"
          className={cn("h-5 max-w-full cursor-pointer gap-1 px-1.5 text-[10px] font-medium", FAILOVER_TONE_CLASS[display.tone])}
        >
          <Globe className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{display.text}</span>
        </Badge>
      </button>
    );
  };

  const memberHealthTitle = (group: any, member: any) => {
    const active = isGroupMemberActive(group, member);
    const parts = [active ? "当前成员可用" : "当前成员不可用"];
    if (member.chinaHealthStatus && member.chinaHealthStatus !== "unknown") {
      parts.push(`国内 ${member.chinaHealthStatus}${member.chinaHealthLatencyMs ? ` / ${member.chinaHealthLatencyMs}ms` : ""}`);
    }
    return parts.join(" / ");
  };

  const groupKindBadge = (group: any) => {
    return null;
  };

  const groupRuntimeBadges = (group: any) => {
    const mode = normalizeGroupMode(group.groupMode);
    if (mode === "exit") {
      const strategy = normalizeExitGroupStrategy(group.exitStrategy);
      return (
        <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
          <Badge variant="secondary" className="h-5 rounded px-1.5 font-normal">
            {EXIT_GROUP_STRATEGY_LABELS[strategy]}
          </Badge>
        </div>
      );
    }
    if (mode !== "port" && mode !== "chain") return null;
    return (
      <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
        <Badge variant="secondary" className="h-5 rounded px-1.5 font-normal">{FORWARD_TYPE_LABELS[group.forwardType as ForwardType] || group.forwardType || "iptables"}</Badge>
        <Badge variant="secondary" className="h-5 rounded px-1.5 font-normal">倍率 {formatTrafficMultiplier(group.trafficMultiplier)}</Badge>
      </div>
    );
  };

  const groupMemberTitle = (group: any) => {
    const mode = normalizeGroupMode(group.groupMode);
    if (mode === "port") return "所属主机";
    if (mode === "chain") return "链路顺序";
    if (mode === "entry") return "入口主机";
    if (mode === "exit") return "出口主机";
    return "成员优先级";
  };

  const groupStatusMessage = (group: any) => {
    const templateRuleCount = Number(group.templateRuleCount || 0);
    const availabilityMessage = getGroupConfigState(group).message;
    return templateRuleCount > 0
      ? `${availabilityMessage}；已被 ${templateRuleCount} 条转发规则引用`
      : availabilityMessage;
  };

  const renderMemberConfigIcon = (group: any, member: any) => {
    if (isGroupMemberActive(group, member)) return <CheckCircle2 className="h-3 w-3 shrink-0" />;
    if (member.isEnabled === false) return <XCircle className="h-3 w-3 shrink-0" />;
    return null;
  };

  const groupDdnsText = (group: any) => {
    const mode = normalizeGroupMode(group.groupMode);
    if (mode === "port" || mode === "chain" || mode === "exit") return "不使用";
    return group.domain || "未配置";
  };

  const chainEntryText = (group: any) => {
    const entryGroupText = entryGroupDisplayText(group, groupsByMode);
    if (entryGroupText) return entryGroupText;
    return group.members?.[0]?.entryAddress || "第一台主机";
  };

  const memberConnectLabel = (member: any) => {
    const connectHost = String(member.connectHost || "").trim();
    if (!connectHost || member.memberType !== "host") return "";
    const host = hostById.get(Number(member.hostId || 0));
    if (hostPrivateAddress(host) && sameAddress(connectHost, hostPrivateAddress(host))) return "内网";
    if (hostIpv6Address(host) && sameAddress(connectHost, hostIpv6Address(host))) return "IPv6";
    return "指定地址";
  };

  const memberDecoratedLabel = (group: any, member: any, index: number) => {
    const prefix = normalizeGroupMode(group.groupMode) === "chain"
      ? `${chainRoleLabel(index, group.members?.length || 0, !!Number(group.entryGroupId || 0))} · `
      : "";
    const connectLabel = normalizeGroupMode(group.groupMode) === "exit" ? memberConnectLabel(member) : "";
    const suffix = connectLabel ? ` · ${connectLabel}` : "";
    return `${index + 1}. ${prefix}${memberLabel(member)}${suffix}`;
  };

  /**
   * 卡片底部的几条「名字 · 值」。
   *
   * 原来是两个带边框的小框，一个值一个框（手册「不要一个数一个小框」说的就是它），而且
   * 五种形态里一半是在重复上面已经写过的话：端口转发的「所属主机」就是成员那一块的标题和
   * 胶囊；「引用规则 N」状态那句已经写了「已被 N 条转发规则引用」；入口组、出口组的「用途 ·
   * 固定入口 / 固定出口」就是所在的那个 tab；出口组的「N 台主机」就是下面那几个胶囊；
   * 有入口组的转发链，「入口」就是路径的第一个节点。
   *
   * 只留上面没说过的：转发组、入口组的 DDNS 域名；转发链的链路延迟，没有入口组时再加一行
   * 入口地址（路径上画的是主机名，连的是这个地址）。和套餐卡、监控卡同一种小表：细线下两列。
   */
  const renderGroupFacts = (group: any) => {
    const mode = normalizeGroupMode(group.groupMode);
    const rows: Array<{ key: string; label: string; value: ReactNode; title?: string }> = [];
    if (mode === "failover" || mode === "entry") {
      rows.push({ key: "ddns", label: "DDNS", value: groupDdnsText(group), title: groupDdnsText(group) });
    }
    if (mode === "chain") {
      const entryAddress = String(group.members?.[0]?.entryAddress || "").trim();
      if (!entryGroupDisplayText(group, groupsByMode) && entryAddress) {
        rows.push({ key: "entry", label: "入口地址", value: entryAddress, title: entryAddress });
      }
      rows.push({ key: "latency", label: "链路延迟", value: renderChainLatencySummary(group) });
    }
    if (rows.length === 0) return null;
    return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-[var(--fx-stroke-weak)] pt-2 text-meta">
        {rows.map((row) => (
          <Fragment key={row.key}>
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 truncate text-right text-foreground" title={row.title}>{row.value}</dd>
          </Fragment>
        ))}
      </dl>
    );
  };

  /**
   * 一张转发组卡片。
   *
   * 原来这 95 行在文件里**一字不差地写了两遍** —— 一处给卡片视图，一处给表格
   * 视图在窄屏下的降级。任何改动都得改两处，而历史上总有一处会被忘掉。
   * 合成一个渲染函数，两处调用。
   */
  /**
   * 成员区。转发链走 Path，其余模式走胶囊。
   *
   * 分开是因为它们本来就不是一回事：**链是有顺序的，组是没有顺序的**。
   * 入口组、出口组、端口组里的成员谁先谁后无所谓，胶囊换行没有损失；
   * 而一条转发链的全部意义就在顺序上，胶囊一换行顺序就读断了。
   */
  const renderGroupMembers = (group: any) => {
    const members = Array.isArray(group.members) ? group.members : [];
    if (members.length === 0) {
      return <span className="text-meta text-muted-foreground">暂无成员</span>;
    }

    if (normalizeGroupMode(group.groupMode) === "chain") {
      const path = buildChainPath(
        members.map((member: any) => ({
          id: member.id,
          label: memberLabel(member),
          sublabel: memberConnectLabel(member) || undefined,
          active: isGroupMemberActive(group, member),
          enabled: member.isEnabled !== false,
        })),
        {
          externalEntryLabel: entryGroupDisplayText(group, groupsByMode),
          latencyMs: typeof group.latestLatencyMs === "number" ? group.latestLatencyMs : null,
          isTimeout: !!group.latestLatencyIsTimeout,
        },
      );
      return (
        <div title={path.title}>
          <NetworkPath nodes={path.nodes} edges={path.edges} orientation="vertical" />
        </div>
      );
    }

    return (
      <div className="flex flex-wrap gap-1.5">
        {members.map((member: any, index: number) => {
          const active = isGroupMemberActive(group, member);
          return (
            <span
              key={member.id}
              className="inline-flex max-w-full items-center gap-1 rounded-[var(--fx-radius-control)] border px-1.5 py-0.5 text-meta"
              /*
                语义色而不是 emerald-500：组里「在生效」的绿必须和主机页、
                链路页的绿是同一个绿，否则同一套系统里「正常」有三种颜色。
              */
              style={
                active
                  ? {
                      color: "var(--fx-healthy-text)",
                      backgroundColor: "var(--fx-healthy-soft)",
                      borderColor: "var(--fx-healthy-soft)",
                    }
                  : {
                      color: "var(--fx-text-secondary)",
                      backgroundColor: "transparent",
                      borderColor: "var(--fx-stroke-base)",
                    }
              }
              title={memberHealthTitle(group, member)}
            >
              {renderMemberConfigIcon(group, member)}
              <span className="truncate">{memberDecoratedLabel(group, member, index)}</span>
            </span>
          );
        })}
      </div>
    );
  };

  const renderForwardGroupCard = (group: any) => (
    <SortableItem key={group.id} id={Number(group.id)} disabled={groupSortable.disabled}>
      {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                <Card
                  {...itemProps}
                  className={cn(
                    "group/sortable relative action-card border-border/40 bg-card/60 transition-[box-shadow,opacity]",
                    isDragging && "opacity-55 ring-1 ring-primary/35",
                    isDropTarget && "ring-1 ring-primary/45",
                  )}
                >
                  <CardContent className="action-card-content space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="min-w-0 truncate font-medium">{group.name}</p>
                        {groupKindBadge(group)}
                        {groupStatusBadge(group)}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{groupStatusMessage(group)}</p>
                      {groupRuntimeBadges(group)}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <SortableDragHandle
                        dragHandleProps={handleProps}
                        visible={isDragging}
                        busy={groupReorderPending}
                        className="bg-card/70"
                      />
                      {renderGroupActions(group, true)}
                      {renderGroupEnabledSwitch(group)}
                    </div>
                  </div>

                  <div className="space-y-2 rounded-[var(--fx-radius-card)] bg-[var(--fx-l2-group)] p-2.5">
                    {/*
                      「解析 · HK entry 01」放在成员这一块的标题行上：它回答的就是「解析在哪个成员上」。
                      放在卡片标题行时，手机上名字 + 状态已经占满一行，它折到第二行，还被触屏
                      44px 的按钮高度撑出一大块空白。
                    */}
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <div className="shrink-0 text-meta text-muted-foreground">{groupMemberTitle(group)}</div>
                      {renderGroupPolicyBadge(group)}
                    </div>
                    {renderGroupMembers(group)}
                  </div>

                  {renderGroupFacts(group)}
                  </CardContent>
                </Card>
      )}
    </SortableItem>
  );

  const renderTableMembersSummary = (group: any) => {
    const members = Array.isArray(group.members) ? group.members : [];
    if (members.length === 0) return <span className="text-xs text-muted-foreground">暂无成员</span>;
    const visibleMembers = members.slice(0, 2);
    const hiddenCount = Math.max(0, members.length - visibleMembers.length);
    return (
      <div className="flex max-w-xs flex-wrap gap-1.5 overflow-hidden">
        {visibleMembers.map((member: any, index: number) => (
          <span
            key={member.id}
            className={`inline-flex max-w-[14rem] items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
              isGroupMemberActive(group, member)
                ? "border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]"
                : "border-border bg-muted/20 text-muted-foreground"
            }`}
            title={memberHealthTitle(group, member)}
          >
            {renderMemberConfigIcon(group, member)}
            <span className="truncate">{memberDecoratedLabel(group, member, index)}</span>
          </span>
        ))}
        {hiddenCount > 0 && (
          <span className="inline-flex items-center rounded border border-border bg-muted/20 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            +{hiddenCount}
          </span>
        )}
      </div>
    );
  };

  const renderChainLatencySummary = (group: any) => {
    if (group.groupMode !== "chain") return <span className="text-muted-foreground">--</span>;
    const latency = typeof group.latestLatencyMs === "number" && Number.isFinite(group.latestLatencyMs)
      ? Number(group.latestLatencyMs)
      : null;
    return <LatencyRating latencyMs={latency} isTimeout={!!group.latestLatencyIsTimeout} />;
  };

  /*
    转发组卡片、表格行上的操作。原来常驻四五个图标（转发链多出延迟、自测两个），读屏念出来
    一律是「……链路」—— 哪怕它是转发组、入口组。常用的带字放外面：转发链是「诊断 + 编辑」，
    其余只有「编辑」；同步、延迟记录收进 ···，删除永远最后、红色、隔一条线。
  */
  const renderGroupActions = (group: any, menuOnly = false) => {
    const resource = groupModeDisplayLabel(group.groupMode);
    const isChain = normalizeGroupMode(group.groupMode) === "chain";
    return (
      <EntityActions
        primary={[
          ...(isChain ? [{
            key: "test",
            label: "诊断",
            ariaLabel: `诊断${resource} ${group.name}：逐段自测`,
            icon: <Stethoscope className="h-3.5 w-3.5" />,
            onSelect: () => setTestGroup({ id: Number(group.id), name: group.name }),
          }] : []),
          { key: "edit", label: "编辑", ariaLabel: `编辑${resource} ${group.name}`, icon: <Pencil className="h-3.5 w-3.5" />, onSelect: () => openEdit(group) },
        ]}
        menu={[
          ...(isChain ? [{
            key: "latency",
            label: "延迟记录",
            ariaLabel: `查看${resource} ${group.name} 的延迟`,
            icon: <Activity className="h-3.5 w-3.5" />,
            onSelect: () => setLatencyGroup({ id: Number(group.id), name: group.name }),
          }] : []),
          {
            key: "sync",
            label: "同步",
            ariaLabel: `同步${resource} ${group.name}`,
            icon: <RefreshCw className="h-3.5 w-3.5" />,
            disabled: syncMutation.isPending,
            onSelect: () => syncMutation.mutate({ id: group.id }),
          },
          { key: "delete", label: "删除", ariaLabel: `删除${resource} ${group.name}`, icon: <Trash2 className="h-3.5 w-3.5" />, destructive: true, onSelect: () => setDeleteGroup(group) },
        ]}
        menuLabel={`${resource} ${group.name} 的更多操作`}
        menuOnly={menuOnly}
      />
    );
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  const handleViewModeChange = (nextViewMode: ForwardGroupViewMode) => {
    if (onViewModeChange) {
      onViewModeChange(nextViewMode);
    } else {
      setInternalViewMode(nextViewMode);
    }
    storeForwardGroupViewMode(nextViewMode);
  };
  const isPortMode = activeGroupMode === "port";
  const isChainMode = activeGroupMode === "chain";
  const runtimeConfigMode = isPortMode || isChainMode || activeGroupMode === "failover";
  const runtimeTcpOptionsSupported = runtimeConfigMode && form.protocol !== "udp";
  const runtimeProxyProtocolSupported = runtimeTcpOptionsSupported && (form.forwardType === "gost" || form.forwardType === "realm");
  const advancedSettingsConfigured = runtimeProxyProtocolSupported
    ? (form.proxyProtocolReceive || form.proxyProtocolSend)
    : false;
  const canManualCheck = activeGroupMode === "failover" || activeGroupMode === "entry";
  const modeMeta: Record<GroupMode, {
    title: string;
    description: string;
    addButtonText: string;
    loadingLabel: string;
    emptyTitle: string;
    emptyDescription: string;
    paginationItemName: string;
  }> = {
    port: {
      title: "端口转发",
      description: "管理可复用的单主机端口转发。",
      addButtonText: "添加端口转发",
      loadingLabel: "正在加载端口转发",
      emptyTitle: "暂无端口转发",
      emptyDescription: "创建后可在转发规则中直接选择使用",
      paginationItemName: "条端口转发",
    },
    failover: {
      title: "转发组",
      description: "管理多入口故障转移与负载分配。",
      addButtonText: "添加转发组",
      loadingLabel: "正在加载转发组",
      emptyTitle: "暂无转发组",
      emptyDescription: "创建后可在转发规则中使用",
      paginationItemName: "个转发组",
    },
    chain: {
      title: "转发链",
      description: "按顺序连接入口、中转和出口主机。",
      addButtonText: "添加转发链",
      loadingLabel: "正在加载转发链",
      emptyTitle: "暂无转发链",
      emptyDescription: "创建后可在转发规则中使用",
      paginationItemName: "条转发链",
    },
    entry: {
      title: "入口组",
      description: "管理共享入口域名的多台主机。",
      addButtonText: "添加入口组",
      loadingLabel: "正在加载入口组",
      emptyTitle: "暂无入口组",
      emptyDescription: "创建后可供隧道和转发链复用",
      paginationItemName: "个入口组",
    },
    exit: {
      title: "出口组",
      description: "管理隧道可复用的出口主机。",
      addButtonText: "添加出口组",
      loadingLabel: "正在加载出口组",
      emptyTitle: "暂无出口组",
      emptyDescription: "创建后可作为隧道出口使用",
      paginationItemName: "个出口组",
    },
  };
  const currentModeMeta = modeMeta[activeGroupMode];
  const pageTitle = currentModeMeta.title;
  const pageDescription = currentModeMeta.description;
  const addButtonText = currentModeMeta.addButtonText;
  const loadingLabel = currentModeMeta.loadingLabel;
  const emptyTitle = currentModeMeta.emptyTitle;
  const emptyDescription = currentModeMeta.emptyDescription;
  const paginationItemName = currentModeMeta.paginationItemName;
  const dialogTitle = editingId ? `编辑${currentModeMeta.title}` : `添加${currentModeMeta.title}`;
  const contentTransitionKey = `${activeGroupMode}-${normalizedSearchQuery || "all"}-${isLoading ? "loading" : visibleGroups.length > 0 ? `list-${viewMode}` : "empty"}`;

  return (
    <div className="space-y-6">
      <WorkspaceHeader level={embedded ? 2 : 1} title={pageTitle} description={pageDescription} actions={!hideHeaderActions && <>
          <Badge variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <Activity className="h-3 w-3 text-current" />
            <AnimatedStatValue
              value={`${activeCount} / ${modeTotal} ${activeGroupMode === "failover" || activeGroupMode === "entry" ? "健康" : "启用"}`}
              loading={isLoading || !groups}
              cacheKey={`forwardGroups.header.${activeGroupMode}.active`}
              fallbackValue={`0 / 0 ${activeGroupMode === "failover" || activeGroupMode === "entry" ? "健康" : "启用"}`}
            />
          </Badge>
          {canManualCheck && <Button variant="outline" className="gap-2" onClick={() => runFailoverMutation.mutate()} disabled={runFailoverMutation.isPending}>
            {runFailoverMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {activeGroupMode === "entry" ? "同步" : "检查"}
          </Button>}
          <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
            <Button
              variant={viewMode === "card" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              aria-label="卡片视图"
              aria-pressed={viewMode === "card"}
              onClick={() => handleViewModeChange("card")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              aria-label="列表视图"
              aria-pressed={viewMode === "table"}
              onClick={() => handleViewModeChange("table")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
          <Button onClick={openCreate} className="col-span-2 gap-2 sm:col-span-1">
            <Plus className="h-4 w-4" />
            {addButtonText}
          </Button>
        </>} />

      <SectionTransition transitionKey={contentTransitionKey}>
        {isLoading ? (
        <DataSectionLoading label={loadingLabel} />
      ) : visibleGroups.length > 0 ? (
        <>
        {viewMode === "card" ? (
          <SortableReorderContext sortable={groupSortable} ids={pagedGroups.map((group: any) => Number(group.id))} strategy="rect">
          <div className="standard-card-grid items-start gap-4">
            {pagedGroups.map((group: any) => renderForwardGroupCard(group))}
          </div>
          </SortableReorderContext>
        ) : (
          <>
          <SortableReorderContext sortable={groupSortable} ids={pagedGroups.map((group: any) => Number(group.id))} strategy="vertical" restrictToList>
          <div className="grid gap-3 sm:hidden">
            {pagedGroups.map((group: any) => renderForwardGroupCard(group))}
          </div>
          </SortableReorderContext>
          <Card className="hidden border-border/40 bg-card/60 sm:block">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[44px] px-2" aria-label="排序" />
                    <TableHead>状态</TableHead>
                    <TableHead>名称</TableHead>
                    <TableHead>成员/链路</TableHead>
                    <TableHead className="hidden md:table-cell">{activeGroupMode === "port" ? "所属主机" : activeGroupMode === "exit" ? "出口" : activeGroupMode === "entry" ? "DDNS" : "入口"}</TableHead>
                    <TableHead className="hidden md:table-cell">{isChainMode ? "链路延迟" : isCollectionMode(activeGroupMode) ? "用途" : "引用规则"}</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <SortableReorderContext sortable={groupSortable} ids={pagedGroups.map((group: any) => Number(group.id))} strategy="vertical" restrictToList>
                <TableBody>
                  {pagedGroups.map((group: any) => {
                    return (
                    <SortableItem key={group.id} id={Number(group.id)} disabled={groupSortable.disabled} itemKind="row">
                    {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                    <TableRow
                      {...itemProps}
                      className={cn(
                        "group/sortable h-[72px]",
                        isDragging && "opacity-55",
                        isDropTarget && "bg-primary/5",
                      )}
                    >
                      <TableCell className="w-[44px] px-2">
                        <SortableDragHandle
                          dragHandleProps={handleProps}
                          visible={isDragging}
                          busy={groupReorderPending}
                          className="mx-auto"
                        />
                      </TableCell>
                      <TableCell className="max-w-[13rem] py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {renderGroupEnabledSwitch(group)}
                          {groupStatusBadge(group)}
                          {renderGroupPolicyBadge(group)}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[13rem] py-3">
                        <div className="line-clamp-1 font-medium">{group.name}</div>
                        <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{groupStatusMessage(group)}</div>
                      </TableCell>
                      <TableCell className="py-3">
                        {renderTableMembersSummary(group)}
                      </TableCell>
                      <TableCell className="hidden max-w-[16rem] py-3 md:table-cell">
                        <div className="line-clamp-1 text-sm">{normalizeGroupMode(group.groupMode) === "port" ? ((group.members || []).length ? memberLabel((group.members || [])[0]) : "未选择") : normalizeGroupMode(group.groupMode) === "chain" ? chainEntryText(group) : normalizeGroupMode(group.groupMode) === "exit" ? `${(group.members || []).length} 台出口主机` : group.domain || "未配置域名"}</div>
                        <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{normalizeGroupMode(group.groupMode) === "port" ? "转发规则中直接选择" : normalizeGroupMode(group.groupMode) === "chain" ? "规则使用时监听入口端口" : normalizeGroupMode(group.groupMode) === "exit" ? "隧道出口组" : group.lastDdnsValue || "未切换"}</div>
                      </TableCell>
                      <TableCell className="hidden py-3 md:table-cell">{normalizeGroupMode(group.groupMode) === "chain" ? renderChainLatencySummary(group) : isCollectionMode(normalizeGroupMode(group.groupMode)) ? (normalizeGroupMode(group.groupMode) === "entry" ? "固定入口" : "固定出口") : Number(group.templateRuleCount || 0)}</TableCell>
                      <TableCell className="py-3 text-right">
                        <div className="flex justify-end">{renderGroupActions(group)}</div>
                      </TableCell>
                    </TableRow>
                    )}
                    </SortableItem>
                    );
                  })}
                </TableBody>
                </SortableReorderContext>
              </Table>
            </div>
          </CardContent>
        </Card>
          </>
        )}
          <PersistentPagination pagination={groupPagination} itemName={paginationItemName} />
        </>
      ) : groupPageQuery.error ? (
        /* 这几类转发组读失败时都不能说「暂无」：照着它重建会和还在跑的那些撞端口。 */
        <Card className="border-border/40 bg-card/60">
          <CardContent className="p-0">
            <DataSectionError
              className="border-0 bg-transparent"
              label={emptyTitle.replace(/^暂无/, "")}
              error={groupPageQuery.error}
              retrying={groupPageQuery.isFetching}
              onRetry={() => { void groupPageQuery.refetch(); }}
              minHeight="min-h-[260px]"
            />
          </CardContent>
        </Card>
      ) : (
        /*
          原来是一张卡里自己拼的大号居中块（80px 的灰方块套图标、18px 标题），和隧道、主机页的
          空状态不是一个样子；搜着东西没搜到时也照样说「暂无转发组 · 创建后可…」。
        */
        normalizedSearchQuery ? (
          <EmptyState
            className="min-h-[260px]"
            icon={<Layers3 />}
            title={`未找到匹配的${emptyTitle.replace(/^暂无/, "")}`}
            description="调整搜索内容或清空搜索"
          />
        ) : (
          <EmptyState className="min-h-[260px]" icon={<Layers3 />} title={emptyTitle} description={emptyDescription} />
        )
        )}
      </SectionTransition>

      <Dialog
        open={showDialog}
        onOpenChange={handleDialogOpenChange}
      >
        <DialogContent className={"flex max-h-[92svh] w-[calc(100vw-1rem)] max-w-[95vw] flex-col gap-3 overflow-hidden p-4 sm:p-5 " + (isChainMode || isPortMode ? "sm:max-w-xl" : "sm:max-w-2xl")}>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <div className={"grid gap-3 " + (isPortMode ? "sm:grid-cols-2" : isChainMode ? "sm:grid-cols-1" : "sm:grid-cols-2")}>
              <FormField className="space-y-2">
                <Label>{isPortMode ? "端口转发名称" : isChainMode ? "转发链名称" : "组名称"}</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={isPortMode ? "例如: 洛杉矶-备用入口" : isChainMode ? "例如: 华东-香港转发链" : activeGroupMode === "exit" ? "例如: Web 高可用出口" : "例如: Web 高可用入口"}
                />
              </FormField>

              {isPortMode && (
                <FormField className="space-y-2">
                  <Label>所属主机</Label>
                  <Select
                    value={form.members[0]?.hostId ? String(form.members[0].hostId) : ""}
                    onValueChange={(value) => setPortHost(Number(value))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="选择所属主机">
                        {form.members[0]?.hostId ? (
                          <HostStatusLabel
                            host={hostById.get(Number(form.members[0].hostId))}
                            label={memberLabel(form.members[0])}
                            className="min-w-0"
                            labelClassName="truncate"
                          />
                        ) : null}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {availableMemberOptions.map((item: any) => (
                        <SelectItem key={item.id} value={String(item.id)} textValue={item.label}>
                          <HostStatusLabel host={item.host} label={item.label} />
                        </SelectItem>
                      ))}
                      {availableMemberOptions.length === 0 && (
                        <SelectItem value="__empty" disabled>没有可选主机</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </FormField>
              )}

              {false && form.groupMode === "failover" && (
                <FormField className="space-y-2">
                  <Label>组类型</Label>
                  <Select
                    value={form.groupType}
                    onValueChange={(v) => {
                      const newType = v as GroupType;
                      savedMembersRef.current[form.groupType] = form.members;
                      const restored = savedMembersRef.current[newType] || [];
                      setForm({ ...form, groupType: newType, members: restored });
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="host">主机端口转发组</SelectItem>
                      <SelectItem value="tunnel">隧道转发组</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
              )}

              {isCollectionMode(form.groupMode) && (
                <label className="flex h-10 items-center justify-between rounded-md border border-border/60 px-3 sm:self-end">
                  <span className="text-sm">启用</span>
                  <Checkbox aria-label="启用" checked={form.isEnabled} onCheckedChange={(isEnabled) => setForm({ ...form, isEnabled })} />
                </label>
              )}
            </div>

            {form.groupMode === "exit" && (
              <FormField className="grid gap-2 rounded-md border border-border/60 bg-muted/15 p-3 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-center">
                <Label>出口策略</Label>
                <div className="space-y-1.5">
                  <Select
                    value={form.exitStrategy}
                    onValueChange={(value) => setForm({ ...form, exitStrategy: normalizeExitGroupStrategy(value) })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(EXIT_GROUP_STRATEGY_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {form.exitStrategy === "none"
                      ? "仅使用顺序第一台已启用主机。"
                      : form.exitStrategy === "fallback"
                        ? "按顺序优先使用主出口，故障时切换到下一台。"
                        : "按当前策略为新连接选择已启用的出口主机。"}
                  </p>
                </div>
              </FormField>
            )}

            {(form.groupMode === "failover" || form.groupMode === "entry") && (
              <>
                <div className={"grid gap-3 " + (form.groupMode === "entry" ? "sm:grid-cols-[minmax(0,1fr)_120px_140px]" : "sm:grid-cols-[minmax(0,1fr)_120px]")}>
                  <FormField className="space-y-2">
                    <Label>{form.groupMode === "entry" ? "入口域名" : "DDNS 域名"}</Label>
                    <Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="例如 app.example.com" />
                  </FormField>
                  <FormField className="space-y-2">
                    <Label>记录类型</Label>
                    <Select value={form.recordType} onValueChange={(v) => setForm({ ...form, recordType: v as GroupForm["recordType"] })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="A">A</SelectItem>
                        <SelectItem value="AAAA">AAAA</SelectItem>
                        <SelectItem value="CNAME">CNAME</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                  {form.groupMode === "entry" && (
                    <label className="flex h-10 items-center justify-between rounded-md border border-border/60 px-3 sm:self-end">
                      <span className="text-sm">自动解析</span>
                      <Checkbox aria-label="自动解析" checked={form.ddnsAutoResolveEnabled} onCheckedChange={(ddnsAutoResolveEnabled) => setForm({ ...form, ddnsAutoResolveEnabled })} />
                    </label>
                  )}
                </div>

                {form.groupMode === "entry" && (
                  <div className="space-y-3 rounded-md border border-border/60 p-3">
                    <label className="flex items-center justify-between gap-3">
                      <span className="space-y-1">
                        <span className="block text-sm font-medium">多入口带宽加权分流</span>
                        <span className="block text-xs text-muted-foreground">
                          按每台入口 VPS 的上行带宽分配解析份额，带宽大的入口承接更多客户端，整组总吞吐接近各入口之和。
                          单条连接仍然只走一台入口；要把一条连接拆开并行传输，请用隧道的「中转带宽叠加」。
                        </span>
                      </span>
                      <Checkbox
                        checked={form.bandwidthAggregationEnabled}
                        onCheckedChange={(bandwidthAggregationEnabled) => setForm({ ...form, bandwidthAggregationEnabled })}
                      />
                    </label>

                    {form.bandwidthAggregationEnabled && (
                      <div className="space-y-3 border-t border-border/60 pt-3">
                        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px_140px]">
                          <FormField className="space-y-2">
                            <Label>聚合策略</Label>
                            <Select
                              value={form.bandwidthAggregationStrategy}
                              onValueChange={(value) => setForm({ ...form, bandwidthAggregationStrategy: normalizeBandwidthAggregationStrategy(value) })}
                            >
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {BANDWIDTH_AGGREGATION_STRATEGIES.map((strategy) => (
                                  <SelectItem key={strategy} value={strategy}>
                                    {BANDWIDTH_AGGREGATION_STRATEGY_LABELS[strategy]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormField>
                          <FormField className="space-y-2">
                            <Label>解析条数</Label>
                            <Input
                              type="number"
                              min={1}
                              max={MAX_AGGREGATION_RECORD_SLOTS}
                              value={form.bandwidthAggregationSlots}
                              onChange={(e) => setForm({ ...form, bandwidthAggregationSlots: e.target.value })}
                              placeholder="8"
                            />
                          </FormField>
                          <FormField className="space-y-2">
                            <Label>最少健康前置</Label>
                            <Input
                              type="number"
                              min={1}
                              max={5}
                              value={form.bandwidthAggregationMinMembers}
                              onChange={(e) => setForm({ ...form, bandwidthAggregationMinMembers: e.target.value })}
                              placeholder="1"
                            />
                          </FormField>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {BANDWIDTH_AGGREGATION_STRATEGY_HINTS[form.bandwidthAggregationStrategy]}
                          {" 健康前置少于下限时自动退回等量分配。"}
                        </p>
                        {editingId ? (
                          <BandwidthAggregationSummary groupId={editingId} open={showDialog} />
                        ) : null}
                      </div>
                    )}
                  </div>
                )}

                {form.groupMode === "entry" && (
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,200px)]">
                  <div className="space-y-1.5">
                    <Input
                      aria-label="入口健康度检测目标"
                      disabled={!form.chinaHealthCheckEnabled}
                      value={form.chinaHealthCheckTarget}
                      onChange={(e) => setForm({ ...form, chinaHealthCheckTarget: e.target.value })}
                      placeholder={healthCheckTargetPlaceholder(form.chinaHealthCheckMethod)}
                    />
                    <Select
                      value={form.chinaHealthCheckMethod}
                      onValueChange={(value) => setForm({ ...form, chinaHealthCheckMethod: normalizeForwardGroupHealthCheckMethod(value) })}
                      disabled={!form.chinaHealthCheckEnabled}
                    >
                      <SelectTrigger aria-label="健康度检测方式"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {FORWARD_GROUP_HEALTH_CHECK_METHODS.map((method) => (
                          <SelectItem key={method} value={method}>
                            {FORWARD_GROUP_HEALTH_CHECK_METHOD_LABELS[method]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {FORWARD_GROUP_HEALTH_CHECK_METHOD_HINTS[form.chinaHealthCheckMethod]}
                      {healthCheckTargetNeedsPort(form.chinaHealthCheckMethod) ? " IPv6 格式：[地址]:端口。" : " IPv6 直接填地址。"}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="flex h-10 items-center justify-between rounded-md border border-border/60 px-3">
                      <span className="text-sm">入口健康度检测</span>
                      <Checkbox aria-label="入口健康度检测" checked={form.chinaHealthCheckEnabled} onCheckedChange={(chinaHealthCheckEnabled) => setForm({ ...form, chinaHealthCheckEnabled })} />
                    </label>
                    <label
                      className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                      title={telegramReady ? "仅在自动切换时发送 Telegram 告警。" : telegramSettingsLoaded ? "请先在系统设置中配置并启用 Telegram 机器人。" : "正在确认 Telegram 配置。"}
                    >
                      <span className="min-w-0">
                        <span className="block text-sm">切换告警</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {telegramReady ? "仅自动切换提醒" : telegramSettingsLoaded ? "需先配置 Telegram" : "正在确认配置"}
                        </span>
                      </span>
                      <Checkbox
                        checked={form.telegramSwitchNotifyEnabled}
                        disabled={telegramSettingsLoaded && !telegramReady && !form.telegramSwitchNotifyEnabled}
                        onCheckedChange={(telegramSwitchNotifyEnabled) => {
                          if (telegramSwitchNotifyEnabled && telegramSettingsLoaded && !telegramReady) {
                            toast.error("请先在系统设置中配置并启用 Telegram 机器人");
                            return;
                          }
                          setForm({ ...form, telegramSwitchNotifyEnabled });
                        }}
                      />
                    </label>
                  </div>
                </div>
                )}
              </>
            )}

            {form.groupMode === "chain" && (
              <FormField className="space-y-2">
                <Label>入口组</Label>
                <Select
                  value={form.entryGroupId ? String(form.entryGroupId) : "none"}
                  onValueChange={(value) => setForm((prev) => applyEntryGroupToChainForm(prev, value === "none" ? null : Number(value)))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择已保存入口组" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不使用入口组</SelectItem>
                    {usableEntryGroups.length === 0 ? (
                      <div className="px-2 py-4 text-center text-xs text-muted-foreground">暂无可用入口组</div>
                    ) : usableEntryGroups.map((group: any) => (
                      <SelectItem key={group.id} value={String(group.id)} textValue={group.name}>
                        <span className="inline-flex min-w-0 flex-col">
                          <span className="truncate">{group.name}</span>
                          <span className="truncate text-xs text-muted-foreground">{String(group.domain || "-")}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}

            {runtimeConfigMode && (
              <div className="space-y-2.5 border-t border-border/60 pt-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">运行配置</p>
                  <p id="forward-group-rate-limit-help" className="text-xs text-muted-foreground">0 表示不限速</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(132px,160px)_112px] sm:items-end">
                  <FormField className="space-y-2">
                    <Label>转发工具</Label>
                    <Select
                      value={form.forwardType}
                      disabled={availableForwardTypes.length === 0}
                      onValueChange={(value) => {
                        const forwardType = value as ForwardType;
                        const tcpSupported = form.protocol !== "udp";
                        setForm({
                          ...form,
                          forwardType,
                          proxyProtocolReceive: tcpSupported && (forwardType === "gost" || forwardType === "realm") && form.proxyProtocolReceive,
                          proxyProtocolSend: tcpSupported && (forwardType === "gost" || forwardType === "realm") && form.proxyProtocolSend,
                          tcpFastOpen: false,
                          zeroCopy: false,
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="选择转发工具" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableForwardTypes.map((type) => (
                          <SelectItem key={type} value={type}>{FORWARD_TYPE_LABELS[type]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  <div className="space-y-2">
                    <Label htmlFor="forward-group-rate-limit">资源限速</Label>
                    <div className="flex h-10 min-w-0 overflow-hidden rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
                      <Input
                        id="forward-group-rate-limit"
                        aria-describedby="forward-group-rate-limit-help"
                        className="h-10 min-w-0 flex-1 rounded-none border-0 bg-transparent px-3 tabular-nums focus-visible:border-0 focus-visible:ring-0"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={1000000}
                        step={1}
                        value={form.rateLimitMbps}
                        onChange={(event) => setForm({ ...form, rateLimitMbps: event.target.value })}
                        placeholder="0"
                      />
                      <span className="flex h-full shrink-0 items-center border-l border-border/60 bg-muted/50 px-2.5 text-xs text-muted-foreground">Mbps</span>
                    </div>
                  </div>
                  <FormField className="space-y-2">
                    <Label>流量倍率</Label>
                    <Input
                      className="tabular-nums"
                      type="number"
                      min={0.01}
                      max={50}
                      step={0.01}
                      value={form.trafficMultiplier}
                      onChange={(event) => setForm({ ...form, trafficMultiplier: event.target.value })}
                      placeholder="1"
                    />
                  </FormField>
                </div>
              </div>
            )}

            {runtimeConfigMode && (
              <div className="rounded-lg border border-border/60 bg-muted/20">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
                  onClick={() => setAdvancedSettingsOpen((open) => !open)}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium">高级设置</div>
                    <div className="text-xs text-muted-foreground">PROXY Protocol</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={advancedSettingsConfigured ? "secondary" : "outline"} className="h-5 px-1.5 text-[10px] font-normal">
                      {advancedSettingsConfigured ? "已配置" : "可选"}
                    </Badge>
                    <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${advancedSettingsOpen ? "rotate-90" : ""}`} />
                  </div>
                </button>
                {advancedSettingsOpen && (
                  <div className="space-y-3 border-t border-border/50 px-3 pb-3 pt-2">
                    <div className="space-y-2">
                      <FormField className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <Label className="text-sm">PROXY Protocol</Label>
                        <Select
                          value={String(form.proxyProtocolVersion)}
                          onValueChange={(value) => setForm({ ...form, proxyProtocolVersion: Number(value) === 2 ? 2 : 1 })}
                          disabled={!runtimeProxyProtocolSupported}
                        >
                          <SelectTrigger className="h-8 w-full sm:w-28"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">v1</SelectItem>
                            <SelectItem value="2">v2</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormField>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border/50 bg-background/55 px-2.5 py-2">
                          <span className="text-sm">接收 PROXY</span>
                          <Checkbox aria-label="接收 PROXY" checked={runtimeProxyProtocolSupported && form.proxyProtocolReceive} disabled={!runtimeProxyProtocolSupported} onCheckedChange={(checked) => setForm({ ...form, proxyProtocolReceive: checked })} />
                        </label>
                        <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border/50 bg-background/55 px-2.5 py-2">
                          <span className="text-sm">发送 PROXY</span>
                          <Checkbox aria-label="发送 PROXY" checked={runtimeProxyProtocolSupported && form.proxyProtocolSend} disabled={!runtimeProxyProtocolSupported} onCheckedChange={(checked) => setForm({ ...form, proxyProtocolSend: checked })} />
                        </label>
                      </div>
                      {!runtimeProxyProtocolSupported && <p className="text-xs text-muted-foreground">PROXY Protocol 仅支持 TCP 且转发工具为 GOST 或 Realm。</p>}
                    </div>

                  </div>
                )}
              </div>
            )}

            {!isPortMode && (
              <div className={form.groupMode === "chain" ? "space-y-2" : "space-y-3 rounded-lg border border-border/60 p-3"}>
                <Label>{form.groupMode === "chain" ? "链路主机顺序" : form.groupMode === "entry" ? "入口主机" : form.groupMode === "exit" ? "出口主机" : "成员优先级"}</Label>
                {form.groupMode === "chain" ? (
                  <MultiHopEditor
                    hosts={hosts || []}
                    initialHopIds={form.members.map((member) => Number(member.hostId || 0)).filter(Boolean)}
                    initialHopConnectHosts={form.members.map((member) => member.connectHost || null)}
                    maxHops={MAX_FORWARD_GROUP_MEMBERS}
                    externalEntry={!!form.entryGroupId}
                    excludedHostIds={entryGroupHostIds(form.entryGroupId)}
                    onChange={updateChainMemberIds}
                    onConnectHostsChange={updateChainConnectHosts}
                  />
                ) : (
                  <>
                    <div className="flex justify-end">
                      <Select onValueChange={(v) => addMember(Number(v))}>
                        <SelectTrigger aria-label="添加成员" className="w-full sm:w-64">
                          <SelectValue placeholder={effectiveGroupType === "host" ? "添加主机成员" : "添加隧道成员"} />
                        </SelectTrigger>
                        <SelectContent>
                          {availableMemberOptions.map((item: any) => (
                            <SelectItem key={item.id} value={String(item.id)} textValue={item.label}>
                              {effectiveGroupType === "host" ? (
                                <HostStatusLabel host={item.host} label={item.label} />
                              ) : (
                                <span>{item.label} {item.meta ? "/ " + item.meta : ""}</span>
                              )}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      {form.members.length > 0 && (
                        <>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/35 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                            <span className="font-medium text-foreground/70">开关说明</span>
                            {showExitAddressColumns && (
                              <>
                                <span>内网：使用该主机内网 IP</span>
                                <span>IPv6：使用该主机 IPv6</span>
                                <span>两者互斥，未配置时不可开启</span>
                              </>
                            )}
                            {showAggregationColumns && (
                              <>
                                <span>上行 Mbps：该前置的上行带宽，留空或 0 表示未知</span>
                                <span>权重：手动份额，0 表示按所选聚合策略自动计算</span>
                              </>
                            )}
                            <span>启用：关闭后该成员不参与当前组</span>
                          </div>
                          <div className={"hidden items-center gap-1.5 px-2.5 text-[11px] text-muted-foreground sm:grid " + memberRowGridClass}>
                            <span className="col-span-2">顺序</span>
                            <span>{effectiveGroupType === "host" ? "主机" : "隧道"}</span>
                            {showExitAddressColumns && (
                              <>
                                <span className="text-center">内网</span>
                                <span className="text-center">IPv6</span>
                              </>
                            )}
                            {showAggregationColumns && (
                              <>
                                <span className="text-center">上行 Mbps</span>
                                <span className="text-center">权重</span>
                              </>
                            )}
                            <span className="text-center">启用</span>
                            <span className="text-right">操作</span>
                          </div>
                        </>
                      )}
                      {form.members.map((member, index) => (
                        <div
                          key={member.key}
                          draggable
                          onDragStart={() => setDragMemberKey(member.key)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => {
                            if (dragMemberKey) moveMember(dragMemberKey, member.key);
                            setDragMemberKey(null);
                          }}
                          className={"flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-background/70 px-3 py-2 sm:grid sm:gap-1.5 " + memberRowGridClass}
                        >
                          <GripVertical className="h-4 w-4 cursor-grab text-muted-foreground" />
                          <span className="flex h-6 w-6 items-center justify-center rounded bg-muted text-xs">{index + 1}</span>
                          {member.memberType === "host" ? (
                            <HostStatusLabel
                              host={hostById.get(Number(member.hostId))}
                              label={memberLabel(member)}
                              className="min-w-0 flex-1 text-sm font-medium"
                              labelClassName="truncate"
                            />
                          ) : (
                            <div className="flex min-w-0 items-center gap-2">
                              <Route className="h-4 w-4 text-primary" />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">{memberLabel(member)}</p>
                              </div>
                            </div>
                          )}
                          {form.groupMode === "exit" && member.memberType === "host" && (
                            <>
                              <div className="flex h-7 w-[56px] items-center justify-center">
                                <Checkbox
                                  checked={!!hostPrivateAddress(hostById.get(Number(member.hostId || 0))) && sameAddress(member.connectHost, hostPrivateAddress(hostById.get(Number(member.hostId || 0))))}
                                  disabled={!hostPrivateAddress(hostById.get(Number(member.hostId || 0)))}
                                  onCheckedChange={(checked) => updateExitMemberUsePrivate(member.key, checked)}
                                  aria-label={"为" + memberLabel(member) + "使用内网IP"}
                                />
                              </div>
                              <div className="flex h-7 w-[56px] items-center justify-center">
                                <Checkbox
                                  checked={!!hostIpv6Address(hostById.get(Number(member.hostId || 0))) && sameAddress(member.connectHost, hostIpv6Address(hostById.get(Number(member.hostId || 0))))}
                                  disabled={!hostIpv6Address(hostById.get(Number(member.hostId || 0)))}
                                  onCheckedChange={(checked) => updateExitMemberUseIpv6(member.key, checked)}
                                  aria-label={"为" + memberLabel(member) + "使用IPv6转发"}
                                />
                              </div>
                            </>
                          )}
                          {showAggregationColumns && (
                            <>
                              <Input
                                type="number"
                                min={0}
                                max={MAX_MEMBER_BANDWIDTH_MBPS}
                                value={member.bandwidthMbps}
                                onChange={(e) => updateMemberField(member.key, { bandwidthMbps: e.target.value })}
                                className="h-7 w-[92px] text-center text-xs"
                                placeholder="0"
                                aria-label={memberLabel(member) + "的上行带宽 Mbps"}
                              />
                              <Input
                                type="number"
                                min={0}
                                max={MAX_MEMBER_WEIGHT}
                                value={member.aggregationWeight}
                                onChange={(e) => updateMemberField(member.key, { aggregationWeight: e.target.value })}
                                className="h-7 w-[72px] text-center text-xs"
                                placeholder="0"
                                aria-label={memberLabel(member) + "的聚合权重"}
                              />
                            </>
                          )}
                          <div className="flex h-7 w-[52px] items-center justify-center">
                            <Checkbox aria-label={`启用 ${memberLabel(member)}`} checked={member.isEnabled} onCheckedChange={(checked) => {
                              setForm({ ...form, members: form.members.map((m) => m.key === member.key ? { ...m, isEnabled: checked } : m) });
                            }} title={member.isEnabled ? "关闭后该成员不参与转发组切换" : "开启后该成员可参与转发组切换"} />
                          </div>
                          <div className="flex h-7 w-9 items-center justify-end">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={`移除成员 ${memberLabel(member)}`} onClick={() => removeMember(member.key)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                      {form.members.length === 0 && (
                        <EmptyState className="py-6" title="还没有成员" description="用上面的选择框把成员加进来。" />
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {form.groupMode === "failover" && (
              <div className="space-y-4">
                <GroupFailoverPolicyFields
                  value={form}
                  onChange={(patch) => setForm({ ...form, ...patch })}
                  policy={formGroupPolicy}
                  ddnsSwitching={groupPolicyOptions.ddnsSwitching}
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <label
                    className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                    title={telegramReady ? "仅在自动切换时发送 Telegram 告警。" : telegramSettingsLoaded ? "请先在系统设置中配置并启用 Telegram 机器人。" : "正在确认 Telegram 配置。"}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm">切换告警</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {telegramReady ? "仅自动切换提醒" : telegramSettingsLoaded ? "需先配置 Telegram" : "正在确认配置"}
                      </span>
                    </span>
                    <Checkbox
                      checked={form.telegramSwitchNotifyEnabled}
                      disabled={telegramSettingsLoaded && !telegramReady && !form.telegramSwitchNotifyEnabled}
                      onCheckedChange={(telegramSwitchNotifyEnabled) => {
                        if (telegramSwitchNotifyEnabled && telegramSettingsLoaded && !telegramReady) {
                          toast.error("请先在系统设置中配置并启用 Telegram 机器人");
                          return;
                        }
                        setForm({ ...form, telegramSwitchNotifyEnabled });
                      }}
                    />
                  </label>
                  <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
                    <span className="text-sm">启用</span>
                    <Checkbox aria-label="启用" checked={form.isEnabled} onCheckedChange={(isEnabled) => setForm({ ...form, isEnabled })} />
                  </label>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>取消</Button>
            <Button onClick={handleSubmit} disabled={isPending}>{isPending ? "保存中..." : editingId ? "保存" : "创建"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {latencyGroup && (
        <ForwardGroupLatencyDialog
          groupId={latencyGroup.id}
          groupName={latencyGroup.name}
          open={!!latencyGroup}
          onOpenChange={(open) => !open && setLatencyGroup(null)}
        />
      )}
      {testGroup && (
        <ForwardGroupSelfTestDialog
          groupId={testGroup.id}
          groupName={testGroup.name}
          group={testGroupDetail}
          entryGroup={testGroupEntryGroup}
          hostById={hostById}
          open={!!testGroup}
          onOpenChange={(open) => !open && setTestGroup(null)}
        />
      )}
      {(() => {
        const policyGroup = policyGroupId === null ? null : (groups || []).find((group: any) => Number(group.id) === policyGroupId) || null;
        const policy = policyGroup ? describeGroupRoutePolicy(policyGroup, groupPolicyOptions) : null;
        const groupId = Number(policyGroup?.id || 0);
        return (
          <RoutePolicySheet
            open={policyGroupId !== null}
            onOpenChange={(open) => !open && setPolicyGroupId(null)}
            subjectName={String(policyGroup?.name || "")}
            policy={policy}
            canEdit
            pending={preferMemberMutation.isPending || reselectMutation.isPending}
            onPrefer={(index) => {
              if (!policy || !groupId) return;
              // reorder 按给的次序把 priority 写成 0..n-1，所以要把全部成员都带上（停用的也算），只把选中的挪到最前。
              const memberIds = policy.lines.map((line) => line.memberId).filter((id): id is number => !!id);
              const chosen = policy.lines[index]?.memberId;
              if (!chosen) return;
              preferMemberMutation.mutate({ groupId, memberIds: [chosen, ...memberIds.filter((id) => id !== chosen)] });
            }}
            onReselect={() => groupId && reselectMutation.mutate({ id: groupId })}
            onEdit={() => {
              setPolicyGroupId(null);
              if (policyGroup) openEdit(policyGroup);
            }}
          />
        );
      })()}
      <Dialog open={!!deleteGroup} onOpenChange={(open) => !open && setDeleteGroup(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{normalizeGroupMode(deleteGroup?.groupMode) === "port" ? "删除端口转发" : normalizeGroupMode(deleteGroup?.groupMode) === "chain" ? "删除转发链" : normalizeGroupMode(deleteGroup?.groupMode) === "entry" ? "删除入口组" : normalizeGroupMode(deleteGroup?.groupMode) === "exit" ? "删除出口组" : "删除转发组"}</DialogTitle>
            <DialogDescription>
              确认删除 "{deleteGroup?.name}"？引用它的转发规则会被同步清理，已下发到 Agent 的运行状态也会刷新。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {deleteImpactQuery.isLoading ? (
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
                正在检查关联转发规则...
              </div>
            ) : deleteImpactQuery.data?.forwardRuleCount ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
                <p className="font-medium text-destructive">
                  当前{normalizeGroupMode(deleteGroup?.groupMode) === "port" ? "端口转发" : normalizeGroupMode(deleteGroup?.groupMode) === "chain" ? "转发链" : normalizeGroupMode(deleteGroup?.groupMode) === "entry" ? "入口组" : normalizeGroupMode(deleteGroup?.groupMode) === "exit" ? "出口组" : "转发组"}仍关联 {deleteImpactQuery.data.forwardRuleCount} 条转发规则
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  包含 {deleteImpactQuery.data.templateRuleCount || 0} 条用户规则和 {deleteImpactQuery.data.childRuleCount || 0} 条成员运行规则。
                </p>
                <div className="mt-2 max-h-44 space-y-1 overflow-auto text-xs text-muted-foreground">
                  {(deleteImpactQuery.data.forwardRules || []).map((rule: any) => (
                    <div key={rule.id} className="rounded border border-border/40 bg-background/60 px-2 py-1">
                      <span className="font-medium text-foreground">{rule.name}</span>
                      <span className="ml-2">:{rule.sourcePort} -&gt; {rule.targetIp}:{rule.targetPort}</span>
                    </div>
                  ))}
                  {deleteImpactQuery.data.forwardRuleCount > (deleteImpactQuery.data.forwardRules || []).length && (
                    <p>还有 {deleteImpactQuery.data.forwardRuleCount - (deleteImpactQuery.data.forwardRules || []).length} 条未显示。</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
                未发现关联转发规则。
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteGroup(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={!deleteGroup || deleteMutation.isPending || deleteImpactQuery.isLoading}
              onClick={() => deleteGroup && deleteMutation.mutate({ id: deleteGroup.id, confirmRules: true })}
            >
              {deleteMutation.isPending ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ForwardGroupsPage() {
  return (
    <DashboardLayout>
      <ForwardGroupsContent />
    </DashboardLayout>
  );
}
