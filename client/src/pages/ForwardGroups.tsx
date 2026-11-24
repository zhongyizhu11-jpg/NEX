import { useLocation } from "wouter";
import { readStoredViewMode, writeStoredViewMode } from "@/lib/viewModeStorage";
import { usePanelFlags } from "@/hooks/usePanelFlags";
import { useFaultBundleExport } from "@/components/links/useFaultBundleExport";
import { MemberScheduleButton } from "@/components/links/MemberScheduleButton";
import { MemberDdnsLinesButton, type DdnsLineOptions } from "@/components/links/MemberDdnsLinesButton";
import { GroupDdnsLineSummary, groupHasDdnsLineSummary } from "@/components/links/GroupDdnsLineSummary";
import {
  DDNS_LINE_FALLBACK_LABELS,
  DDNS_LINE_FALLBACK_MODES,
  ddnsLineProviderOf,
  normalizeDdnsLineFallback,
  parseDdnsLines,
  type DdnsLineFallbackMode,
  type DdnsLineRef,
} from "@shared/ddnsLines";
import { describeMemberSchedule, groupModeSupportsMemberSchedule, memberEnabledIntent, parseMemberSchedule, type MemberActiveSchedule } from "@shared/memberSchedule";
import { ResourceTrafficLine } from "@/components/links/ResourceTrafficLine";
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
import { formatLatencyTimeLabel } from "@/lib/latencyTimeLabel";
import { hostIpv6Address, hostPrivateAddress, normalizeConnectHostForHost, sameAddress } from "@/lib/multiHopAddress";
import SectionTransition from "@/components/SectionTransition";
import { DiagnoseSubjectActions } from "@/components/DiagnoseDialog";
import EmptyState from "@/components/EmptyState";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import { LatencyRating, getLatencyRating } from "@/components/LatencyRating";
import { StatusDot } from "@/components/network/StatusDot";
import { useCompactLayout } from "@/hooks/useCompactLayout";
import { formatBytes } from "@shared/formatBytes";
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
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
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
import { OptimisticSwitch } from "@/components/ui/switch";
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
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Globe,
  GripVertical,
  Layers3,
  LayoutGrid,
  List,
  Loader2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Stethoscope,
  Trash2,
  XCircle,
  Clock,
  FileJson,
} from "lucide-react";
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { toast } from "sonner";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { MAX_FORWARD_GROUP_MEMBERS } from "@shared/forwardGroup";
import { LoadBalanceFields } from "@/features/links/LoadBalanceFields";
import { exitManualWeights, exitStrategyNote } from "@/lib/exitGroupBalance";
import { type BalanceDetect, type BalanceStrategy, BALANCE_DEFAULT_STRATEGY, DEFAULT_BALANCE_DETECT, normalizeBalanceDetect, normalizeBalanceStrategy, normalizeExitGroupStrategy, UNIFIED_BALANCE_AGENT_VERSION } from "@shared/loadBalance";
import { describeGroupRoutePolicy, type GroupRoutePolicyOptions } from "@shared/routePolicy";
import { BandwidthAggregationSummary } from "@/components/BandwidthAggregationSummary";
import {
  trafficMultiplierFromInput,
  formatTrafficMultiplier,
  trafficMultiplierToInputValue,
} from "@shared/trafficMultiplier";
import {
  FORWARD_TYPE_LABELS,
  FORWARD_TYPES,
  TUNNEL_PROTOCOLS,
  normalizeForwardRuleProtocol,
  type ForwardRuleProtocol,
  type ForwardType,
} from "@shared/forwardTypes";
import {
  FORWARD_GROUP_HEALTH_CHECK_METHODS,
  FORWARD_GROUP_HEALTH_CHECK_METHOD_HINTS,
  FORWARD_GROUP_HEALTH_CHECK_METHOD_LABELS,
  defaultHealthCheckPort,
  healthCheckTargetNeedsPort,
  healthCheckTargetPlaceholder,
  normalizeForwardGroupHealthCheckMethod,
  type ForwardGroupHealthCheckMethod,
} from "@shared/forwardGroupHealthCheck";
import { LatencyHistoryDayStrip } from "@/components/LatencyHistoryDays";
import { describeMemberLive, memberIssueLines, summarizeGroupLive, type MemberLiveTone } from "@/lib/forwardGroupMemberLive";
import {
  BANDWIDTH_AGGREGATION_STRATEGIES,
  BANDWIDTH_AGGREGATION_STRATEGY_HINTS,
  BANDWIDTH_AGGREGATION_STRATEGY_LABELS,
  MAX_MEMBER_BANDWIDTH_MBPS,
  MAX_MEMBER_WEIGHT,
  normalizeAggregationMinMembers,
  normalizeAggregationRecordSlots,
  normalizeBandwidthAggregationStrategy,
  normalizeMemberBandwidthMbps,
  normalizeMemberWeight,
  type BandwidthAggregationStrategy,
} from "@shared/bandwidthAggregation";
import { ddnsWeightRecordTypeSupported } from "@shared/ddnsWeights";

// 延迟曲线按需加载：recharts 不跟着组列表一起下，点开延迟弹窗才取。
const GroupLatencyAreaChart = lazy(() => import("@/components/charts/LatencyLineCharts").then((m) => ({ default: m.GroupLatencyAreaChart })));
// 诊断框只在点了「诊断」之后才要，和规则、链路页一样抽成模块懒加载（components/forwardGroups/ForwardGroupSelfTestDialog）。
const ForwardGroupSelfTestDialog = lazy(() => import("@/components/forwardGroups/ForwardGroupSelfTestDialog"));

/** MySQL 会把布尔返回成 0 / 1 或 "0" / "1"。 */
const dbFlag = (value: unknown) => value === true || value === 1 || value === "1";

type GroupType = "host" | "tunnel";
type GroupMode = "port" | "failover" | "chain" | "entry" | "exit";
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
  /** 可用时段（线路按时间段启用）。转发组、入口组、出口组才有。 */
  activeSchedule?: MemberActiveSchedule | null;
  /** 分到的运营商线路（分线路解析）。转发组、入口组才有；没有 = 只在默认线路。 */
  ddnsLines?: DdnsLineRef[];
};

type GroupForm = {
  name: string;
  groupMode: GroupMode;
  /** 出口组的分配方式；新建时是空的，要人自己挑（统一负载均衡，2026-11） */
  exitStrategy: BalanceStrategy | null;
  /** 出口组的「检测与切换」（shared/loadBalance.ts） */
  balanceDetect: BalanceDetect;
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
  domain: string;
  recordType: "A" | "AAAA" | "CNAME";
  /** 双栈 DDNS：A 组同时发 AAAA、AAAA 组同时发 A，跟着同一批成员（server/forwardGroupDualStackDdns.ts） */
  ddnsDualStack: boolean;
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
  /** 分线路解析：线路成员全挂时改用默认线路的健康成员，还是删掉这条线路的记录。 */
  ddnsLineFallback: DdnsLineFallbackMode;
  /** 入口组按服务商的记录权重发布（带宽聚合的份额换成权重）。 */
  ddnsWeightEnabled: boolean;
  /** 外部观察：让别的机器探成员对外的入口端口；peerObserverHostIds 是额外指定的观察主机。 */
  peerProbeEnabled: boolean;
  peerObserverHostIds: number[];
  autoFailback: boolean;
  isEnabled: boolean;
  members: MemberForm[];
};

const makeDefaultForm = (): GroupForm => ({
  name: "",
  groupMode: "failover",
  // 新建出口组直接是「自动 · 推荐」+「均衡」：什么都不用改就能用（2026-11 界面统一）
  exitStrategy: BALANCE_DEFAULT_STRATEGY,
  balanceDetect: { ...DEFAULT_BALANCE_DETECT },
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
  domain: "",
  recordType: "A",
  ddnsDualStack: false,
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
  ddnsLineFallback: "default",
  ddnsWeightEnabled: false,
  peerProbeEnabled: true,
  peerObserverHostIds: [],
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

/** 组里存的观察主机清单（JSON 数组）读成数字数组。 */
function parseObserverHostIds(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter((id) => Number.isInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

function isCollectionMode(mode: GroupMode) {
  return mode === "entry" || mode === "exit";
}

function normalizeChinaHealthTargetInput(value: string, method: ForwardGroupHealthCheckMethod = "tcp") {
  const needsPort = healthCheckTargetNeedsPort(method);
  const target = value.trim().replace(/^(?:tcp|udp|icmp|ping):\/\//i, "").replace(/\uFF1A/g, ":");
  if (!target) return "";
  if (target.length > 253 || /[\s'"<>/]/.test(target)) return undefined;
  let host = target;
  // 没写端口按方法补：TCPing 80、UDP 53。
  let port = defaultHealthCheckPort(method);
  const bracketMatch = target.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketMatch) {
    host = bracketMatch[1]?.trim() || "";
    port = bracketMatch[2] ? Number(bracketMatch[2]) : defaultHealthCheckPort(method);
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
  /** 跟着 createRequestKey 一起来的预填值（「按目标新建」替用户选好的出口策略）。 */
  createPreset?: { exitStrategy?: BalanceStrategy };
  /**
   * 新建框打开以后调用，外面把请求清掉。有了它，页签刚挂载时带着的请求也照样打开
   * （「按目标新建」是先切页签、再发请求的，这一块是新挂载的）。
   */
  onCreateRequestConsumed?: () => void;
  editRequest?: { id: number; requestKey: number } | null;
  onEditRequestConsumed?: () => void;
  searchQuery?: string;
};

const FORWARD_GROUP_VIEW_MODE_STORAGE_KEY = "forwardx.forwardGroups.viewMode";

function getStoredForwardGroupViewMode(): ForwardGroupViewMode {
  return readStoredViewMode<ForwardGroupViewMode>(FORWARD_GROUP_VIEW_MODE_STORAGE_KEY, ["table", "card"], "card");
}

function storeForwardGroupViewMode(viewMode: ForwardGroupViewMode) {
  writeStoredViewMode(FORWARD_GROUP_VIEW_MODE_STORAGE_KEY, viewMode);
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

const MEMBER_LIVE_DOT_COLOR: Record<MemberLiveTone, string> = {
  healthy: "var(--fx-healthy)",
  degraded: "var(--fx-warn)",
  down: "var(--fx-down)",
  off: "var(--fx-stroke-strong, var(--fx-text-muted))",
  unknown: "var(--fx-text-muted)",
};

/** 成员胶囊前那颗点：此刻怎么样（forwardGroupMemberLive）。 */
function MemberLiveDot({ tone }: { tone: MemberLiveTone }) {
  return (
    <i
      aria-hidden="true"
      data-tone={tone}
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: MEMBER_LIVE_DOT_COLOR[tone], opacity: tone === "off" ? 0.55 : 1 }}
    />
  );
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

type GroupLatencyPoint = {
  label: string;
  fullLabel: string;
  latency: number;
  chartLatency: number;
  isTimeout: boolean;
  probeCount?: number;
  probeSuccesses?: number;
  atMs?: number;
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

/*
  转发链的延迟记录（图、稳定性统计、近 30 天色块），没有对话框外壳：并进「诊断」框当一页
  （DiagnoseDialog extraTabs，2.3.506 起和规则、隧道一样；原来是单独的「延迟记录」弹窗）。
*/
function ForwardGroupLatencyBody({ groupId, active }: { groupId: number; active: boolean }) {
  const open = active;
  const [peakCutEnabled, setPeakCutEnabled] = useState(false);
  const [timeRangeHours, setTimeRangeHours] = useState<LatencyTimeRangeHours>(DEFAULT_LATENCY_TIME_RANGE_HOURS);
  const { data, isLoading, isFetching } = trpc.forwardGroups.latencySeries.useQuery(
    { groupId, hours: 24 },
    { enabled: open, refetchInterval: pollingInterval("slow", open), refetchOnMount: "always" }
  );
  const { data: counterStatistics } = trpc.forwardGroups.probeStatistics.useQuery(
    { groupId, hours: timeRangeHours },
    { enabled: open, refetchInterval: pollingInterval("slow", open), refetchOnMount: "always" },
  );
  // 近 30 天按天的色块（一天一行的汇总，见 shared/latencyHistory.ts）。
  const history = trpc.forwardGroups.latencyHistory.useQuery({ groupId }, { enabled: open, staleTime: 60_000, refetchOnWindowFocus: false });
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
        atMs: new Date(d.recordedAt).getTime(),
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
    return getLatencyStabilityStats(chartData, counterStatistics ?? null);
  }, [chartData, counterStatistics]);
  const yMax = useMemo(() => getLatencyYAxisMax(Math.max(...chartData.filter((d) => !d.isTimeout).map((d) => d.chartLatency), 0), 120), [chartData]);
  const yTicks = useMemo(() => getLatencyYAxisTicks(yMax), [yMax]);
  const shouldAnimateChart = open && chartData.length > 0 && !groupLatencyAnimatedKeys.has(groupId);
  useEffect(() => {
    if (shouldAnimateChart) groupLatencyAnimatedKeys.add(groupId);
  }, [groupId, shouldAnimateChart]);

  return (
    <div className="min-w-0 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <p className="min-w-0 text-meta text-muted-foreground">{`最近 ${latencyTimeRangeLabel(timeRangeHours)} 链路逐跳探测汇总，纯 UDP 规则使用 Ping，其余规则使用 TCPing。`}</p>
          <div className="flex flex-wrap items-center gap-2 self-start sm:justify-end">
            <LatencyTimeRangeSelect value={timeRangeHours} onChange={setTimeRangeHours} />
            <LatencyPeakCutToggle id={`forward-group-peak-cut-${groupId}`} checked={peakCutEnabled} onCheckedChange={setPeakCutEnabled} className="shrink-0" />
          </div>
        </div>
        <div className="h-[42svh] min-h-[220px] rounded-lg border border-border/60 bg-muted/20 p-2 sm:h-[260px] sm:p-3">
          {(isLoading || waitForFreshSeries) && !seriesData ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在加载延迟数据
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无延迟数据</div>
          ) : (
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在加载延迟数据</div>}>
              <GroupLatencyAreaChart chartData={chartData} yMax={yMax} yTicks={yTicks} animate={shouldAnimateChart} />
            </Suspense>
          )}
        </div>
        <LatencyStabilityStats
          stats={stats}
          counterStatistics={counterStatistics ?? null}
          description="统计各跳实际的 TCP / Ping 探测（含已上报的备用路径），不等于端到端业务丢包。"
        />
        <LatencyHistoryDayStrip summaries={history.data} loading={history.isLoading} />
    </div>
  );
}

export function ForwardGroupsContent({
  mode = "failover",
  embedded = false,
  viewMode: controlledViewMode,
  onViewModeChange,
  hideHeaderActions = false,
  createRequestKey,
  createPreset,
  onCreateRequestConsumed,
  editRequest,
  onEditRequestConsumed,
  searchQuery = "",
}: ForwardGroupsContentProps) {
  const utils = trpc.useUtils();
  const faultBundle = useFaultBundleExport();
  // 精简布局：卡片和隧道链路那一页同一种（名字 + 一行说明 + 成员一行 + 右下一枚状态 / 延迟标签）
  const compactLayout = useCompactLayout();
  const [, setTopologyLocation] = useLocation();
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
  // 协议开关、Telegram、DDNS 是否就绪：从 publicInfo 读，不再拉整份 getSettings。
  const panelFlags = usePanelFlags();
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<GroupForm>(makeDefaultForm());
  const savedMembersRef = useRef<Record<string, MemberForm[]>>({ host: [], tunnel: [] });
  const [dragMemberKey, setDragMemberKey] = useState<string | null>(null);
  const [internalViewMode, setInternalViewMode] = useState<ForwardGroupViewMode>(() => getStoredForwardGroupViewMode());
  const [testGroup, setTestGroup] = useState<{ id: number; name: string } | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<any | null>(null);
  // 点开故障转移策略面板的那个组。只存 id：面板跟着列表轮询刷新，不拿一份旧快照。
  const [policyGroupId, setPolicyGroupId] = useState<number | null>(null);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  // 外面会在用完后清掉请求（onCreateRequestConsumed）时，挂载时就带着的请求也要处理；否则沿用老规矩，只认挂载后的新请求。
  const lastCreateRequestKeyRef = useRef(onCreateRequestConsumed ? 0 : createRequestKey ?? 0);
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
  const needsFullGroupList = showDialog || !!testGroup || !!editRequest;
  const fullGroupQuery = trpc.forwardGroups.options.useQuery(undefined, {
    enabled: needsFullGroupList,
    refetchInterval: pollingInterval("normal"),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const pageGroups = (groupPageQuery.data?.items || []) as any[];
  const relatedPageGroups = (groupPageQuery.data?.relatedGroups || []) as any[];
  // 全量列表只在它开着（会刷新）时用：关掉后缓存不再刷新，下次点「编辑」会拿旧的成员 / 启用状态填表（2.3.535）
  const groups = ((needsFullGroupList ? fullGroupQuery.data : undefined) || [...pageGroups, ...relatedPageGroups]) as any[];
  // 2.3.497：组的成员可以跟着节点池（线路 → 节点池页设）；编辑时提示一下，并能就地取消跟随。
  // 2.3.499：组回到分类条上各自一页，卡上也写跟着哪个池（以前只有节点池页上看得见）。
  const editingPoolId = editingId ? Number(groups.find((group) => Number(group.id) === editingId)?.poolId || 0) || null : null;
  const anyFollowsPool = groups.some((group) => Number(group.poolId || 0) > 0);
  const followedPoolQuery = trpc.nodePools.list.useQuery(undefined, { enabled: anyFollowsPool || (showDialog && !!editingPoolId), staleTime: 30_000, refetchOnWindowFocus: false });
  const poolNameOf = (poolId: number) => ((followedPoolQuery.data || []) as Array<{ id: number; name: string }>).find((pool) => Number(pool.id) === poolId)?.name || `节点池 ${poolId}`;
  const followedPoolName = editingPoolId ? poolNameOf(editingPoolId) : "";
  const unfollowPool = trpc.forwardGroups.followPool.useMutation({
    onSuccess: () => {
      void utils.forwardGroups.invalidate();
      void utils.nodePools.board.invalidate();
      toast.success("不再跟着节点池，成员留着现在这些");
    },
    onError: (error) => toast.error(error.message),
  });
  const isLoading = groupPageQuery.isLoading;
  const telegramSettingsLoaded = panelFlags.loaded;
  const telegramReady = telegramSettingsLoaded && panelFlags.telegramBotReady;
  const forwardProtocolSettings = panelFlags.forwardProtocols;
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
    if (editRequest && editRequest.requestKey === lastEditRequestKeyRef.current) onEditRequestConsumed?.();
    clearCloseResetTimer();
    closeResetTimerRef.current = window.setTimeout(() => {
      resetForm();
      closeResetTimerRef.current = null;
    }, 220);
  };

  // 保存前「关闭整个组？」那个确认框开着时，点它算点在编辑框外面，编辑框会跟着关掉 —— 这段时间不让它关
  const confirmOpenRef = useRef(false);
  const handleDialogOpenChange = (open: boolean) => {
    if (open) {
      clearCloseResetTimer();
      setShowDialog(true);
      return;
    }
    if (confirmOpenRef.current) return;
    closeDialog();
  };

  useEffect(() => () => clearCloseResetTimer(), []);

  const openCreate = (preset?: { exitStrategy?: BalanceStrategy }) => {
    clearCloseResetTimer();
    const initial = makeDefaultForm();
    setForm({
      ...initial,
      groupMode: activeGroupMode,
      groupType: "host" as const,
      forwardType: availableForwardTypes[0] || initial.forwardType,
      domain: activeGroupMode === "failover" || activeGroupMode === "entry" ? initial.domain : "",
      recordType: activeGroupMode === "chain" || activeGroupMode === "exit" ? "A" : initial.recordType,
      ...(activeGroupMode === "exit" && preset?.exitStrategy ? { exitStrategy: preset.exitStrategy } : {}),
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
    if (createRequestKey > 0) {
      openCreate(createPreset);
      onCreateRequestConsumed?.();
    }
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
          // 被时段停着的也算「开着」：不然存一次就把时段停用变成了手动停用。
          isEnabled: memberEnabledIntent(member),
          activeSchedule: parseMemberSchedule(member.activeSchedule),
          bandwidthMbps: String(Math.max(0, Number(member.bandwidthMbps) || 0)),
          aggregationWeight: String(Math.max(0, Number(member.aggregationWeight) || 0)),
          ddnsLines: parseDdnsLines(member.ddnsLines),
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
        isEnabled: memberEnabledIntent(member),
        activeSchedule: parseMemberSchedule(member.activeSchedule),
        bandwidthMbps: "0",
        aggregationWeight: "0",
        ddnsLines: parseDdnsLines(member.ddnsLines),
      });
      return acc;
    }, []);

    setForm({
      name: group.name || "",
      groupMode,
      // 老的「只用第一个」在统一的下拉框里是「主备」（坏了自动换下一台）
      exitStrategy: (normalizeBalanceStrategy(group.exitStrategy) ?? normalizeExitGroupStrategy(group.exitStrategy)) as BalanceStrategy,
      balanceDetect: normalizeBalanceDetect(group.balanceDetect),
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
      domain: group.domain || "",
      recordType: group.recordType || "A",
      ddnsDualStack: !!group.ddnsDualStack,
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
      ddnsLineFallback: normalizeDdnsLineFallback(group.ddnsLineFallback),
      ddnsWeightEnabled: !!group.ddnsWeightEnabled,
      peerProbeEnabled: group.peerProbeEnabled === undefined || group.peerProbeEnabled === null ? true : !!group.peerProbeEnabled,
      peerObserverHostIds: parseObserverHostIds(group.peerObserverHostIds),
      autoFailback: !!group.autoFailback,
      isEnabled: !!group.isEnabled,
      members: normalizedMembers,
    });
    setEditingId(Number(group.id));
    setAdvancedSettingsOpen(false);
    setShowDialog(true);
  };

  /*
    外面要打开某个组的编辑框（节点池页点组卡、/tunnels?edit=）。请求留到编辑框关掉才清：链路管理的分区
    切换动画按「加载中 / 有列表」换 key，这一份组件加载完会被换成新的一份 —— 打开时就清掉的话，新的
    那份拿不到请求，编辑框跟着旧的那份一起没了（以前从节点池页点组卡只切了页签、不开编辑框）。
  */
  useEffect(() => {
    if (!editRequest || editRequest.requestKey === lastEditRequestKeyRef.current) return;
    // 等全量列表这一次刷新完：缓存里可能是旧的，拿它填表再保存会把旧状态写回去
    if (fullGroupQuery.isFetching) return;
    const group = groups.find((item: any) => Number(item.id) === Number(editRequest.id));
    if (group) {
      lastEditRequestKeyRef.current = editRequest.requestKey;
      openEdit(group);
    }
  }, [editRequest?.id, editRequest?.requestKey, groups, fullGroupQuery.isFetching]);

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
  // 出口组「按权重」：每台多一个权重框（不填 = 按线路带宽自动算）
  const showExitWeightColumn = showExitAddressColumns && form.exitStrategy === "weighted";
  // Entry groups running bandwidth aggregation get per-front-VPS uplink and
  // weight columns, so the member table gains two fields.
  const showAggregationColumns = form.groupMode === "entry"
    && form.bandwidthAggregationEnabled
    && effectiveGroupType === "host";
  const showScheduleColumn = groupModeSupportsMemberSchedule(form.groupMode);
  // 运营商线路（分线路解析）：发布 DDNS 的转发组、入口组才有；服务商不支持时这一列照样在，按钮置灰说原因。
  const showLineColumn = (form.groupMode === "failover" || form.groupMode === "entry") && effectiveGroupType === "host";
  const memberRowGridClass = form.groupMode === "port"
    ? "sm:grid-cols-[auto_auto_minmax(8rem,1fr)_36px]"
    : showExitAddressColumns
    ? showExitWeightColumn
      ? "sm:grid-cols-[auto_auto_minmax(8rem,1fr)_56px_56px_64px_44px_52px_36px]"
      : "sm:grid-cols-[auto_auto_minmax(8rem,1fr)_56px_56px_44px_52px_36px]"
    : showAggregationColumns
      ? showLineColumn
        ? "sm:grid-cols-[auto_auto_minmax(8rem,1fr)_92px_72px_44px_44px_52px_36px]"
        : "sm:grid-cols-[auto_auto_minmax(8rem,1fr)_92px_72px_44px_52px_36px]"
      : showScheduleColumn
        ? showLineColumn
          ? "sm:grid-cols-[auto_auto_minmax(8rem,1fr)_44px_44px_52px_36px]"
          : "sm:grid-cols-[auto_auto_minmax(8rem,1fr)_44px_52px_36px]"
        : "sm:grid-cols-[auto_auto_minmax(8rem,1fr)_52px_36px]";
  const ddnsLinesQuery = trpc.forwardGroups.ddnsLines.useQuery({ domain: null }, {
    enabled: showDialog && showLineColumn,
    staleTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  // 入口组「按权重解析」：现在的服务商不支持时置灰并写明原因
  const ddnsWeightSupportQuery = trpc.forwardGroups.ddnsWeightSupport.useQuery(undefined, {
    enabled: showDialog && form.groupMode === "entry" && form.bandwidthAggregationEnabled,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const ddnsLineOptions: DdnsLineOptions = ddnsLinesQuery.data
    ? {
      available: ddnsLinesQuery.data.supported,
      reason: ddnsLinesQuery.data.reason,
      lines: ddnsLinesQuery.data.lines,
      defaultLine: ddnsLinesQuery.data.defaultLine,
    }
    : {
      available: false,
      reason: ddnsLinesQuery.error ? `读取 DNS 服务商的线路失败：${ddnsLinesQuery.error.message}` : "正在读取 DNS 服务商的线路",
      lines: [],
      defaultLine: null,
    };
  const ddnsLineRoot = ddnsLinesQuery.data?.rootDomain || "";
  const ddnsLineProviderLabel = ddnsLinesQuery.data?.providerLabel || "DNS 服务商";
  const formDomain = form.domain.trim().toLowerCase().replace(/\.+$/, "");
  const ddnsLineDomainWarning = ddnsLineRoot && formDomain && formDomain !== ddnsLineRoot && !formDomain.endsWith(`.${ddnsLineRoot}`)
    ? `入口域名不在 ${ddnsLineProviderLabel} 的主域名 ${ddnsLineRoot} 下，分线路记录写不进去`
    : "";
  const formHasDdnsLines = showLineColumn && form.members.some((member) => (member.ddnsLines?.length ?? 0) > 0);
  // 换过 DDNS 服务商：成员上还留着别家的线路，这些不生效（成员等于只在默认线路）。
  const currentLineProvider = ddnsLinesQuery.data?.supported ? ddnsLinesQuery.data.provider : null;
  const formHasForeignDdnsLines = !!currentLineProvider && formHasDdnsLines
    && form.members.some((member) => (member.ddnsLines || []).some((line) => ddnsLineProviderOf(line) !== currentLineProvider));
  const updateMemberField = (key: string, patch: Partial<MemberForm>) => {
    setForm((prev) => ({
      ...prev,
      members: prev.members.map((member) => (member.key === key ? { ...member, ...patch } : member)),
    }));
  };

  const addMember = (id: number) => {
    if (!id) return;
    if ((form.groupMode === "port" || form.groupMode === "chain" || isCollectionMode(form.groupMode)) && form.members.length >= MAX_FORWARD_GROUP_MEMBERS) {
      toast.error(form.groupMode === "port"
        ? `端口转发最多支持 ${MAX_FORWARD_GROUP_MEMBERS} 台入口主机`
        : form.groupMode === "chain"
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

  const confirmDialog = useConfirmDialog();
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
      if (!form.entryGroupId && (form.members.length < 1 || form.members.length > MAX_FORWARD_GROUP_MEMBERS)) return toast.error(`端口转发需要选择 1-${MAX_FORWARD_GROUP_MEMBERS} 台入口主机，或者挂一个入口组`);
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
      entryGroupId: isChainGroup || isPortMode ? form.entryGroupId || null : null,
      groupType: "host" as const,
      exitStrategy: isExitGroup ? normalizeExitGroupStrategy(form.exitStrategy) : "round_robin",
      ...(isExitGroup ? { balanceDetect: form.balanceDetect } : {}),
      domain: isFailoverMode || isEntryGroup ? form.domain.trim() || null : null,
      recordType: isChainGroup || isExitGroup ? "A" : form.recordType,
      ddnsDualStack: (isFailoverMode || isEntryGroup) && form.recordType !== "CNAME" && form.ddnsDualStack,
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
      chinaHealthCheckEnabled: supportsChinaHealth && form.chinaHealthCheckEnabled,
      chinaHealthCheckTarget: supportsChinaHealth && form.chinaHealthCheckEnabled ? chinaHealthTarget || null : null,
      chinaHealthCheckMethod: form.chinaHealthCheckMethod,
      telegramSwitchNotifyEnabled: supportsSwitchNotify && form.telegramSwitchNotifyEnabled,
      ddnsAutoResolveEnabled: isEntryGroup ? form.ddnsAutoResolveEnabled : true,
      bandwidthAggregationEnabled: isEntryGroup && form.bandwidthAggregationEnabled,
      bandwidthAggregationStrategy: normalizeBandwidthAggregationStrategy(form.bandwidthAggregationStrategy),
      bandwidthAggregationSlots: normalizeAggregationRecordSlots(form.bandwidthAggregationSlots),
      bandwidthAggregationMinMembers: normalizeAggregationMinMembers(form.bandwidthAggregationMinMembers),
      ddnsLineFallback: normalizeDdnsLineFallback(form.ddnsLineFallback),
      ddnsWeightEnabled: isEntryGroup && form.bandwidthAggregationEnabled && form.ddnsWeightEnabled,
      peerProbeEnabled: supportsChinaHealth ? form.peerProbeEnabled : true,
      peerObserverHostIds: supportsChinaHealth ? form.peerObserverHostIds : [],
      // 端口转发挂了入口组：入口全由入口组定，不带自己的成员
      members: (isPortMode && form.entryGroupId ? [] : form.members).map((member, index) => ({
        memberType: member.memberType,
        hostId: member.hostId,
        tunnelId: member.tunnelId,
        connectHost: isChainGroup || isExitGroup ? member.connectHost || null : null,
        isEnabled: isPortMode || isChainGroup ? true : member.isEnabled,
        priority: index,
        // Bandwidth aggregation is an entry group concept; other modes send 0.
        bandwidthMbps: isEntryGroup ? normalizeMemberBandwidthMbps(member.bandwidthMbps) : 0,
        // 出口组「按权重」：每台填的份数（全部填了才按它分，有空的就按线路带宽算，server 见 exitManualWeights）
        aggregationWeight: isEntryGroup || (isExitGroup && form.exitStrategy === "weighted") ? normalizeMemberWeight(member.aggregationWeight) : 0,
        activeSchedule: groupModeSupportsMemberSchedule(form.groupMode) ? member.activeSchedule || null : null,
        // 服务商暂不支持线路时也原样带回去：换回原来的服务商后配置还在（服务端只看当前服务商的线路）。
        ddnsLines: isFailoverMode || isEntryGroup ? member.ddnsLines || [] : null,
      })),
    };
    if (!editingId) {
      createMutation.mutate(payload);
      return;
    }
    /*
      存的时候顺手把整个入口组 / 出口组关了：用它的链路全部跟着停（2.3.535，用户反馈停用两台出口、保存后
      出口组被关、链路全断）。原来开着、这次要关，先问一句，写清楚会停几条链路。
    */
    type GroupLite = { id?: unknown; isEnabled?: unknown };
    const editingGroup = (pageGroups as GroupLite[]).find((group) => Number(group.id) === editingId)
      || (groups as GroupLite[]).find((group) => Number(group.id) === editingId);
    const wasEnabled = editingGroup ? editingGroup.isEnabled !== false && editingGroup.isEnabled !== 0 && editingGroup.isEnabled !== "0" : false;
    if ((isEntryGroup || isExitGroup) && wasEnabled && !form.isEnabled) {
      const linkCount = ((tunnels || []) as Array<{ exitGroupId?: unknown; entryGroupId?: unknown }>)
        .filter((tunnel) => Number(isExitGroup ? tunnel?.exitGroupId : tunnel?.entryGroupId) === editingId).length;
      confirmOpenRef.current = true;
      void confirmDialog({
        title: `关闭${isExitGroup ? "出口组" : "入口组"}「${form.name.trim()}」？`,
        description: linkCount > 0
          ? `顶部「启用」没勾：保存后这个组停用，用它的 ${linkCount} 条链路和上面的规则全部停止。只是想停某台机器，去勾掉那一台的「启用」。`
          : "顶部「启用」没勾：保存后这个组停用。只是想停某台机器，去勾掉那一台的「启用」。",
        confirmText: "关闭并保存",
        cancelText: "返回修改",
        tone: "destructive",
      }).then((ok) => {
        // 确认框关掉的那一下的「点外面」事件过去之后再放开
        window.setTimeout(() => { confirmOpenRef.current = false; }, 300);
        if (ok) updateMutation.mutate({ id: editingId, ...payload });
      });
      return;
    }
    updateMutation.mutate({ id: editingId, ...payload });
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
    if (configState.status === "available") return <Badge tone="up" className="border-[color-mix(in_srgb,var(--fx-healthy)_20%,transparent)]">可用</Badge>;
    if (configState.status === "degraded") return <Badge tone="warn" className="border-[color-mix(in_srgb,var(--fx-warn)_25%,transparent)]">部分可用</Badge>;
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
    ddnsSwitching: panelFlags.loaded ? panelFlags.ddnsEnabled : undefined,
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
          className={cn("h-5 max-w-full cursor-pointer gap-1 px-1.5 text-[11px] font-medium", FAILOVER_TONE_CLASS[display.tone])}
        >
          <Globe className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{display.text}</span>
        </Badge>
      </button>
    );
  };

  /** 转发组的域名此刻解析到的成员（describeGroupPolicyDisplay 说的那个）；不是转发组或还没解析是 0。 */
  const resolvedMemberId = (group: any) => {
    if (normalizeGroupMode(group.groupMode) !== "failover") return 0;
    const display = describeGroupPolicyDisplay(group, groupPolicyOptions);
    return display && display.policy.report.kind === "resolved" ? Number(group.activeMemberId || 0) : 0;
  };

  /** 胶囊里的内容：点（或停用 / 时段外图标）、名字、延迟或状态短字、「解析」标。 */
  const renderMemberPillInner = (group: any, member: any, label: string) => {
    const live = describeMemberLive(group, member);
    const resolved = resolvedMemberId(group) === Number(member.id);
    return (
      <>
        {live && live.tone !== "off" ? <MemberLiveDot tone={live.tone} /> : renderMemberConfigIcon(group, member)}
        <span className="truncate">{label}</span>
        {live?.note ? <span className="shrink-0 font-mono text-[10.5px] tabular-nums opacity-80">{live.note}</span> : null}
        {resolved ? <span className="shrink-0 rounded-sm bg-[var(--fx-healthy-soft)] px-1 text-[11px] font-semibold leading-4 text-[var(--fx-healthy-text)]" data-testid="member-resolved">解析</span> : null}
      </>
    );
  };

  const renderGroupLiveSummary = (group: any) => {
    const summary = summarizeGroupLive(group, Array.isArray(group.members) ? group.members : []);
    if (!summary) return null;
    const color = summary.tone === "ok" ? "var(--fx-healthy-text)" : summary.tone === "warn" ? "var(--fx-warn-text)" : "var(--fx-down-text)";
    return <span className="shrink-0 text-meta font-medium tabular-nums" style={{ color }} title={summary.title} data-testid="group-live-summary">{summary.text}</span>;
  };

  const memberHealthTitle = (group: any, member: any) => {
    const active = isGroupMemberActive(group, member);
    const live = describeMemberLive(group, member);
    const parts = [active ? "配置可用" : "配置不可用"];
    if (live) parts.push(`此刻：${live.title}`);
    if (resolvedMemberId(group) === Number(member.id)) parts.push("域名正解析到它");
    if (parseMemberSchedule(member.activeSchedule)) {
      parts.push(`${dbFlag(member.scheduleSuspended) ? "时段外暂停，" : ""}可用时段 ${describeMemberSchedule(member.activeSchedule)}`);
    }
    return parts.join(" / ");
  };

  const groupRuntimeBadges = (group: any) => {
    const mode = normalizeGroupMode(group.groupMode);
    // 出口组卡上不再挂「按负载 - 新连接给现在最闲的那条…」那一长条：手机上一行放不下、被截断，
    // 怎么分在编辑框里看得到（用户 2026-11-03 圈掉的）。
    if (mode === "exit") return null;
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
    if (mode === "port") return "入口主机";
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
    // 时段外暂停的成员用时钟，和手动停用（叉）分开：它到点会自己回来。
    if (dbFlag(member.scheduleSuspended)) return <Clock className="h-3 w-3 shrink-0" />;
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
   * 五种形态里一半是在重复上面已经写过的话：端口转发的「入口主机」就是成员那一块的标题和
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
    if (normalizeGroupMode(group.groupMode) === "port" && Number(group.entryGroupId || 0) > 0) {
      // 挂了入口组（2.3.438 起）：入口是入口组里的主机，画入口组的名字和它的成员
      const entryGroup = groupsByMode.entry.find((item: any) => Number(item.id) === Number(group.entryGroupId));
      const entryMembers = entryGroup
        ? (entryGroup.members || []).filter((member: any) => member.memberType === "host" && member.isEnabled !== false)
        : [];
      return (
        <div className="space-y-1.5">
          <div className="text-meta text-muted-foreground">入口组 · {entryGroupDisplayText(group, groupsByMode)}</div>
          {!entryGroup ? (
            <span className="text-meta text-[var(--fx-warn-text)]">入口组不存在或不可见</span>
          ) : entryMembers.length === 0 ? (
            <span className="text-meta text-muted-foreground">入口组没有已启用主机</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {entryMembers.map((member: any, index: number) => (
                <span
                  key={member.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-[var(--fx-radius-control)] border px-1.5 py-0.5 text-meta"
                  style={isGroupMemberActive(entryGroup, member)
                    ? { color: "var(--fx-healthy-text)", backgroundColor: "var(--fx-healthy-soft)", borderColor: "var(--fx-healthy-soft)" }
                    : { color: "var(--fx-text-secondary)", backgroundColor: "transparent", borderColor: "var(--fx-stroke-base)" }}
                  title={memberHealthTitle(entryGroup, member)}
                >
                  {renderMemberPillInner(entryGroup, member, `${index + 1}. ${memberLabel(member)}`)}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }
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
      // 精简布局：三站以内横着画一行（和隧道链路卡一样）：注脚和段上的字不画，挤在一行里会叠在一起；
      // 整条链的延迟在右边那枚标签上。多了照旧竖排。
      const oneRow = compactLayout && path.nodes.length <= 3;
      return (
        <div title={path.title}>
          <NetworkPath
            nodes={oneRow ? path.nodes.map((node) => ({ ...node, sublabel: undefined })) : path.nodes}
            edges={oneRow ? path.edges.map((edge) => ({ ...edge, via: undefined, latencyMs: undefined })) : path.edges}
            orientation={oneRow ? "horizontal" : "vertical"}
          />
        </div>
      );
    }

    const issues = memberIssueLines(group, members, (member: any) => memberLabel(member));
    return (
      <>
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
              {renderMemberPillInner(group, member, memberDecoratedLabel(group, member, index))}
            </span>
          );
        })}
      </div>
      {/* 不正常的成员直接写原因（悬停在手机上看不到） */}
      {issues.map((issue) => (
        <p key={issue.text} className="mt-1 text-meta leading-5" style={{ color: issue.tone === "down" ? "var(--fx-down-text)" : "var(--fx-warn-text)" }} data-testid="group-member-issue">{issue.text}</p>
      ))}
      </>
    );
  };

  /*
    精简布局下的转发组 / 转发链 / 入口组 / 出口组卡：和隧道链路卡同一套结构和样式（fx-tunnel-card，
    compact.css 把它排成两行：名字 · 说明 · 累计 · 操作 / 成员 · 标签）。以前链路管理里只有隧道链路是精简的，
    切到别的页签又回到大卡（用户 2026-11-03）。
  */
  const GROUP_TONE_COLOR: Record<"ok" | "warn" | "down" | "off", string> = {
    ok: "var(--fx-primary-fill)",
    warn: "var(--fx-warn)",
    down: "var(--fx-down)",
    off: "var(--fx-text-muted)",
  };
  const renderCompactGroupCard = (
    group: Parameters<typeof getGroupConfigState>[0],
    { itemProps, handleProps, isDragging, isDropTarget }: Parameters<Parameters<typeof SortableItem>[0]["children"]>[0],
  ) => {
    const state = getGroupConfigState(group);
    const mode = normalizeGroupMode(group.groupMode);
    const tone: "ok" | "warn" | "down" | "off" = state.status === "available" ? "ok" : state.status === "degraded" ? "warn" : state.status === "unavailable" ? "down" : "off";
    const health = tone === "ok" ? "healthy" : tone === "warn" ? "degraded" : tone === "down" ? "down" : "standby";
    const statusText = ({ available: "可用", degraded: "部分可用", pending: "等待检测", unavailable: "不可用", disabled: "停用" } as Record<string, string>)[state.status] || "不可用";
    const members = Array.isArray(group.members) ? group.members : [];
    const usable = members.filter((member: unknown) => isGroupMemberActive(group, member)).length;
    const multiplier = Number(group.trafficMultiplier ?? 1);
    const subtitle = [
      groupModeDisplayLabel(group.groupMode),
      mode === "port" || mode === "chain" ? (FORWARD_TYPE_LABELS[group.forwardType as ForwardType] || group.forwardType || "iptables") : "",
      (mode === "port" || mode === "chain") && Number.isFinite(multiplier) && multiplier !== 1 ? `倍率 ${formatTrafficMultiplier(group.trafficMultiplier)}` : "",
      Number(group.poolId || 0) > 0 ? `跟着「${poolNameOf(Number(group.poolId))}」` : "",
    ].filter(Boolean).join(" · ");
    const latency = mode === "chain" && typeof group.latestLatencyMs === "number" && Number.isFinite(group.latestLatencyMs) ? Number(group.latestLatencyMs) : null;
    const rating = latency !== null && tone !== "down" ? getLatencyRating(latency) : null;
    const ratingTone = !rating ? null : rating.label === "优秀" ? "healthy" : rating.label === "良好" ? "ok" : rating.label === "一般" ? "warn" : "down";
    const tagTone = ratingTone || (tone === "ok" ? "healthy" : tone === "warn" ? "warn" : tone === "down" ? "down" : "off");
    const tagText = rating && latency !== null
      ? `${Math.round(latency)} ms`
      : tone === "ok" && members.length > 0 && mode !== "chain" ? `${usable}/${members.length} 可用` : statusText;
    const summary = group.trafficSummary;
    return (
      <Card
        {...itemProps}
        className={cn(
          "group/sortable relative fx-rule-card fx-tunnel-card action-card border-border bg-card transition-[box-shadow,opacity]",
          isDragging && "opacity-55 ring-1 ring-primary/35",
          isDropTarget && "ring-1 ring-primary/45",
        )}
        data-tone={tone}
        style={{ ...(itemProps?.style || {}), "--fx-rule-tone": GROUP_TONE_COLOR[tone] } as CSSProperties}
        title={state.message}
      >
        <CardContent className="fx-rule-card-body action-card-content">
          <div className="fx-rule-head">
            <div className="fx-rule-title">
              <div className="fx-rule-name">
                <span className="fx-rule-dot"><StatusDot health={health} size="large" label={state.message} /></span>
                <span className="truncate">{group.name}</span>
              </div>
              <div className="fx-rule-sub" title={subtitle}>{subtitle}</div>
            </div>
            <div className="fx-rule-head-actions">
              {renderGroupActions(group, true)}
              {renderGroupEnabledSwitch(group)}
              <SortableDragHandle
                dragHandleProps={handleProps}
                visible={isDragging}
                busy={groupReorderPending}
                className="bg-card/70"
              />
            </div>
          </div>
          <div className="fx-tunnel-route">{renderGroupMembers(group)}</div>
          <div className="fx-tunnel-meta">
            {summary ? (
              <>
                <span className="fx-tunnel-bytes fx-rule-num" title={`累计 ${formatBytes(summary.totalBytes)} · 入向 ${formatBytes(summary.bytesIn)} · 出向 ${formatBytes(summary.bytesOut)}`}>
                  <b>{formatBytes(summary.totalBytes).replace(/\s*[A-Za-z]+$/, "")}</b><small>{(formatBytes(summary.totalBytes).match(/[A-Za-z]+$/) || [""])[0]}</small>
                </span>
                <span className="fx-tunnel-rules text-meta text-muted-foreground">{summary.ruleCount} 条规则</span>
              </>
            ) : null}
            <span className="fx-rule-tag fx-tunnel-latency-tag" data-tone={tagTone} title={state.message}>{tagText}</span>
          </div>
        </CardContent>
      </Card>
    );
  };

  const renderForwardGroupCard = (group: any) => compactLayout ? (
    <SortableItem key={group.id} id={Number(group.id)} disabled={groupSortable.disabled}>
      {(sortable) => renderCompactGroupCard(group, sortable)}
    </SortableItem>
  ) : (
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
                        {groupStatusBadge(group)}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{groupStatusMessage(group)}</p>
                      {groupRuntimeBadges(group)}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {renderGroupActions(group, true)}
                      {renderGroupEnabledSwitch(group)}
                      <SortableDragHandle
                        dragHandleProps={handleProps}
                        visible={isDragging}
                        busy={groupReorderPending}
                        className="bg-card/70"
                      />
                    </div>
                  </div>

                  <div className="space-y-2 rounded-[var(--fx-radius-card)] bg-[var(--fx-l2-group)] p-2.5">
                    {/*
                      「解析 · HK entry 01」放在成员这一块的标题行上：它回答的就是「解析在哪个成员上」。
                      放在卡片标题行时，手机上名字 + 状态已经占满一行，它折到第二行，还被触屏
                      44px 的按钮高度撑出一大块空白。
                    */}
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-meta text-muted-foreground">{groupMemberTitle(group)}</span>
                        {normalizeGroupMode(group.groupMode) !== "chain" ? renderGroupLiveSummary(group) : null}
                      </div>
                      {renderGroupPolicyBadge(group)}
                    </div>
                    {renderGroupMembers(group)}
                    {group.peerProbe?.outdatedHosts?.length ? (
                      <p className="text-meta text-[var(--fx-warn-text)]" title="外部观察要让别的机器替面板去探成员的入口端口，Agent 太旧的机器当不了观察点" data-testid="group-peer-probe-outdated">
                        需要升级 Agent：{group.peerProbe.outdatedHosts.map((host: { name: string }) => host.name).join("、")} 还当不了外部观察的观察点
                      </p>
                    ) : null}
                    {Number(group.poolId || 0) > 0 ? (
                      <p className="text-meta text-[var(--fx-accent)]" title="池里加减机器，这个组的成员跟着加减；在节点池页或编辑框里改" data-testid="group-follows-pool">
                        成员跟着节点池「{poolNameOf(Number(group.poolId))}」
                      </p>
                    ) : null}
                  </div>

                  {renderGroupFacts(group)}
                  <ResourceTrafficLine summary={group.trafficSummary} />
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
            {renderMemberPillInner(group, member, memberDecoratedLabel(group, member, index))}
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
          /*
            转发链的延迟记录、故障包、拓扑都在「诊断」框里（页签和底部按钮，2.3.506 起和规则、隧道一样），
            菜单里不再单列；别的组没有诊断框，故障包和拓扑照旧在菜单里。
          */
          ...(isChain ? [] : [{
            key: "fault-bundle",
            label: "导出故障包",
            ariaLabel: `导出${resource} ${group.name} 的故障包（诊断结论、脱敏配置、沿线主机状态）`,
            icon: <FileJson className="h-3.5 w-3.5" />,
            disabled: faultBundle.pending,
            onSelect: () => { void faultBundle.exportBundle("forwardGroup", Number(group.id)); },
          }, {
            key: "topology",
            label: "查看拓扑",
            ariaLabel: `在网络拓扑里查看${resource} ${group.name}`,
            icon: <Network className="h-3.5 w-3.5" />,
            onSelect: () => setTopologyLocation(`/topology?group=${Number(group.id)}`),
          }]),
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
      description: "管理可复用的端口转发：一台或多台入口主机同时监听，直连同一个目标。",
      addButtonText: "添加端口转发",
      loadingLabel: "正在加载端口转发",
      emptyTitle: "暂无端口转发",
      emptyDescription: "创建后可在转发规则中直接选择使用",
      paginationItemName: "条端口转发",
    },
    failover: {
      title: "转发组",
      description: "多台入口主备：入口域名始终指向一台健康的入口，坏了自动换。",
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
      {/* 嵌在链路管理的分类条底下时，这个二级页头和选中的那一格同名：精简布局下整块不要（data-fx-compact-hide） */}
      <div data-fx-compact-hide={embedded && hideHeaderActions ? "" : undefined}>
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
          <ViewModeToggle
            value={viewMode}
            onChange={handleViewModeChange}
            items={[
              { value: "card", label: "卡片视图", icon: LayoutGrid },
              { value: "table", label: "列表视图", icon: List },
            ]}
          />
          <Button onClick={() => openCreate()} className="col-span-2 gap-2 sm:col-span-1">
            <Plus className="h-4 w-4" />
            {addButtonText}
          </Button>
        </>} />
      </div>

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
                    <TableHead className="hidden md:table-cell">{activeGroupMode === "port" ? "入口主机" : activeGroupMode === "exit" ? "出口" : activeGroupMode === "entry" ? "DDNS" : "入口"}</TableHead>
                    {/* 入口组 / 出口组没有这一列：原来打印的「固定入口 / 固定出口」就是所在的分类条，说了两遍 */}
                    {isCollectionMode(activeGroupMode) ? null : <TableHead className="hidden md:table-cell">{isChainMode ? "链路延迟" : "引用规则"}</TableHead>}
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
                        "group/sortable fx-table-row h-[72px]",
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
                        <div className="line-clamp-1 text-sm">{normalizeGroupMode(group.groupMode) === "port" ? (Number(group.entryGroupId || 0) > 0 ? `入口组 · ${entryGroupDisplayText(group, groupsByMode)}` : (group.members || []).length > 1 ? `${(group.members || []).length} 台入口主机` : (group.members || []).length ? memberLabel((group.members || [])[0]) : "未选择") : normalizeGroupMode(group.groupMode) === "chain" ? chainEntryText(group) : normalizeGroupMode(group.groupMode) === "exit" ? `${(group.members || []).length} 台出口主机` : group.domain || "未配置域名"}</div>
                        <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{normalizeGroupMode(group.groupMode) === "port" ? "转发规则中直接选择" : normalizeGroupMode(group.groupMode) === "chain" ? "规则使用时监听入口端口" : normalizeGroupMode(group.groupMode) === "exit" ? "隧道出口组" : group.lastDdnsValue || "未切换"}</div>
                        {groupHasDdnsLineSummary(group) ? <GroupDdnsLineSummary compact group={group} memberLabel={memberLabel} /> : null}
                      </TableCell>
                      {isCollectionMode(activeGroupMode) ? null : (
                        <TableCell className="hidden py-3 md:table-cell">{normalizeGroupMode(group.groupMode) === "chain" ? renderChainLatencySummary(group) : Number(group.templateRuleCount || 0)}</TableCell>
                      )}
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
            {/* 读屏要的：没有 Description Radix 会在控制台告警，读屏也只念标题。视觉上标题已经够了，所以 sr-only。 */}
            <DialogDescription className="sr-only">
              {isPortMode ? "填写端口转发的名称、入口与目标" : isChainMode ? "填写转发链的名称、入口与各跳主机" : "填写转发组的名称、成员与策略"}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <div className={"grid gap-3 " + (isPortMode || isChainMode ? "sm:grid-cols-1" : "sm:grid-cols-2")}>
              <FormField className="space-y-2">
                <Label>{isPortMode ? "端口转发名称" : isChainMode ? "转发链名称" : "组名称"}</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={isPortMode ? "例如: 洛杉矶-备用入口" : isChainMode ? "例如: 华东-香港转发链" : activeGroupMode === "exit" ? "例如: Web 高可用出口" : "例如: Web 高可用入口"}
                />
              </FormField>

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
                <LoadBalanceFields
                  strategy={form.exitStrategy}
                  onStrategyChange={(exitStrategy) => setForm({ ...form, exitStrategy })}
                  detect={form.balanceDetect}
                  onDetectChange={(balanceDetect) => setForm({ ...form, balanceDetect })}
                  note={exitStrategyNote(form.exitStrategy, form.members, hostById)}
                  {...exitManualWeights(form.members, hostById)}
                />
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
                {/*
                  双栈（上游 2.3.294）：成员挑选、健康、切换照旧按上面的记录类型；另一族跟着同一批成员发，
                  切走一台机器两族一起切 —— 只切 A 不切 AAAA，双栈客户端会继续连到坏机器上。
                */}
                {form.recordType !== "CNAME" && (
                  <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
                    <span className="space-y-1">
                      <span className="block text-sm font-medium">{form.recordType === "AAAA" ? "同时发 IPv4（A）" : "同时发 IPv6（AAAA）"}</span>
                      <span data-fx-help="" className="block text-xs text-muted-foreground">
                        按上面选中的成员，把它们的{form.recordType === "AAAA" ? " IPv4 " : " IPv6 "}也发成同名记录；没有这一族地址的成员少一条，全都没有时清空这一族。
                      </span>
                    </span>
                    <Checkbox aria-label="双栈 DDNS" checked={form.ddnsDualStack} onCheckedChange={(ddnsDualStack) => setForm({ ...form, ddnsDualStack })} />
                  </label>
                )}

                <div className="space-y-2 rounded-md border border-border/60 p-3" data-testid="group-peer-probe">
                  <label className="flex items-center justify-between gap-3">
                    <span className="space-y-1">
                      <span className="block text-sm font-medium">外部观察</span>
                      <span data-fx-help="" className="block text-xs text-muted-foreground">
                        让组里别的成员替面板去连每个成员对外的入口端口。成员自己报告正常、但两台别的机器持续连不上它，照样从解析里拿掉；
                        面板连不上它的 Agent、别的机器却连得上，就继续留着。观察点要 Agent {UNIFIED_BALANCE_AGENT_VERSION} 以上；没有可用的观察点时只看成员自己的报告。
                      </span>
                    </span>
                    <Checkbox aria-label="外部观察" checked={form.peerProbeEnabled} onCheckedChange={(peerProbeEnabled) => setForm({ ...form, peerProbeEnabled })} />
                  </label>
                  {form.peerProbeEnabled ? (
                    <div className="space-y-2 border-t border-border/60 pt-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">额外的观察主机</span>
                        {form.peerObserverHostIds.length === 0 ? <span className="text-xs text-muted-foreground">没有指定（成员之间互相看）</span> : null}
                        {form.peerObserverHostIds.map((hostId) => (
                          <Badge key={hostId} variant="secondary" className="h-6 gap-1 rounded px-1.5 font-normal">
                            {hostById.get(hostId)?.name || `主机 ${hostId}`}
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground"
                              aria-label={`移除观察主机 ${hostById.get(hostId)?.name || hostId}`}
                              onClick={() => setForm({ ...form, peerObserverHostIds: form.peerObserverHostIds.filter((id) => id !== hostId) })}
                            >
                              ×
                            </button>
                          </Badge>
                        ))}
                      </div>
                      {form.peerObserverHostIds.length < 8 ? (
                        <Select
                          value=""
                          onValueChange={(value) => {
                            const hostId = Number(value);
                            if (hostId > 0 && !form.peerObserverHostIds.includes(hostId)) setForm({ ...form, peerObserverHostIds: [...form.peerObserverHostIds, hostId] });
                          }}
                        >
                          <SelectTrigger aria-label="添加观察主机" className="h-8 w-full sm:w-64"><SelectValue placeholder="添加观察主机（成员少、或者想从别的网络看）" /></SelectTrigger>
                          <SelectContent>
                            {(hosts || [])
                              .filter((host: { id: number }) => !form.peerObserverHostIds.includes(Number(host.id)) && !form.members.some((member) => Number(member.hostId) === Number(host.id)))
                              .map((host: { id: number; name: string }) => <SelectItem key={host.id} value={String(host.id)}>{host.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {formHasDdnsLines && (
                  <div className="space-y-2 rounded-md border border-border/60 p-3">
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] sm:items-center">
                      <span className="space-y-1">
                        <span className="block text-sm font-medium">分线路解析</span>
                        <span data-fx-help="" className="block text-xs text-muted-foreground">
                          分了线路的成员只解析给对应运营商的用户（例如电信 → 一台、联通 → 另一台），没分的留在默认线路。
                          一条线路的成员全不可用时怎么办：
                        </span>
                      </span>
                      <Select value={form.ddnsLineFallback} onValueChange={(value) => setForm({ ...form, ddnsLineFallback: normalizeDdnsLineFallback(value) })}>
                        <SelectTrigger aria-label="线路成员全不可用时"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {DDNS_LINE_FALLBACK_MODES.map((mode) => (
                            <SelectItem key={mode} value={mode}>{DDNS_LINE_FALLBACK_LABELS[mode]}{mode === "default" ? "（推荐）" : ""}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {ddnsLinesQuery.data && !ddnsLinesQuery.data.supported ? (
                      <p className="text-xs text-[var(--fx-warn)]">{ddnsLinesQuery.data.reason}；成员上的线路配置先保留，暂不生效，组照旧只发布默认线路。</p>
                    ) : null}
                    {ddnsLineDomainWarning ? <p className="text-xs text-[var(--fx-warn)]">{ddnsLineDomainWarning}</p> : null}
                    {formHasForeignDdnsLines ? (
                      <p className="text-xs text-[var(--fx-warn)]">有成员勾的是换服务商之前的线路（标着「已不可用」），这些线路不生效、成员只在默认线路，请按 {ddnsLineProviderLabel} 的线路重新勾选。</p>
                    ) : null}
                  </div>
                )}
                {editingId && groupHasDdnsLineSummary(groups.find((group) => Number(group.id) === editingId) || {}) ? (
                  <GroupDdnsLineSummary group={groups.find((group) => Number(group.id) === editingId)} memberLabel={memberLabel} />
                ) : null}

                {form.groupMode === "entry" && (
                  <div className="space-y-3 rounded-md border border-border/60 p-3">
                    <label className="flex items-center justify-between gap-3">
                      <span className="space-y-1">
                        <span className="block text-sm font-medium">按带宽排序解析</span>
                        <span data-fx-help="" className="block text-xs text-muted-foreground">
                          入口域名照旧解析出全部健康入口，面板按带宽给它们排先后并显示占用率。
                          DNS 的多条记录没有顺序，解析器会自己轮换，所以它现在不改变客户端被分到哪一台。
                          要按比例分连接，用订阅里的「负载均衡」组；要把一条连接拆开同时走几台，用隧道中转的「单连接叠加」。
                        </span>
                      </span>
                      <Checkbox
                        checked={form.bandwidthAggregationEnabled}
                        onCheckedChange={(bandwidthAggregationEnabled) => setForm({ ...form, bandwidthAggregationEnabled })}
                      />
                    </label>

                    {form.bandwidthAggregationEnabled && (
                      <div className="space-y-3 border-t border-border/60 pt-3">
                        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
                          <FormField className="space-y-2">
                            <Label>排序依据</Label>
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
                          {" 健康入口少于下限时不排序。"}
                        </p>
                        {editingId ? (
                          <BandwidthAggregationSummary groupId={editingId} open={showDialog} />
                        ) : null}
                        {(() => {
                          // 按权重解析：把上面算出来的份额写成 DNS 服务商的记录权重，解析时真的按比例返回。
                          const weightSupport = ddnsWeightSupportQuery.data;
                          const typeReason = ddnsWeightRecordTypeSupported(form.recordType) ? null : "CNAME 一个名字只能有一条记录，没有按比例一说，用不了按权重解析";
                          const disabledReason = typeReason || (weightSupport && !weightSupport.supported ? weightSupport.reason : null);
                          return (
                            <label className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
                              <span className="space-y-1">
                                <span className="block text-sm font-medium">按权重解析</span>
                                <span data-fx-help="" className="block text-xs text-muted-foreground">
                                  把上面的份额写成 DNS 服务商的记录权重，解析时按比例返回各个入口（腾讯云 DNSPod、阿里云 DNS、华为云 DNS 支持；只管默认线路）。
                                </span>
                                {disabledReason ? <span className="block text-xs text-[var(--fx-warn-text)]" data-testid="ddns-weight-unsupported">{disabledReason}</span> : null}
                              </span>
                              <Checkbox
                                aria-label="按权重解析"
                                checked={form.ddnsWeightEnabled && !disabledReason}
                                disabled={!!disabledReason}
                                onCheckedChange={(ddnsWeightEnabled) => setForm({ ...form, ddnsWeightEnabled })}
                              />
                            </label>
                          );
                        })()}
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

            {(form.groupMode === "chain" || form.groupMode === "port") && (
              <FormField className="space-y-2">
                <Label>{form.groupMode === "port" ? "入口组（可选）" : "入口组"}</Label>
                {form.groupMode === "port" && (
                  <p data-fx-help="" className="text-xs text-muted-foreground">挂上入口组就用组里的主机当入口，隧道 / 转发链共用同一个组，组里加减主机这里自动跟着变；不挂就在下面指定主机。</p>
                )}
                <Select
                  value={form.entryGroupId ? String(form.entryGroupId) : "none"}
                  onValueChange={(value) => setForm((prev) => applyEntryGroupToChainForm(prev, value === "none" ? null : Number(value)))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择已保存入口组" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{form.groupMode === "port" ? "不使用入口组，指定主机" : "不使用入口组"}</SelectItem>
                    {usableEntryGroups.length === 0 ? (
                      <div className="px-2 py-4 text-center text-xs text-muted-foreground">暂无可用入口组</div>
                    ) : usableEntryGroups.map((group: any) => (
                      <SelectItem key={group.id} value={String(group.id)} textValue={group.name}>
                        <span className="fx-select-two inline-flex min-w-0 flex-col">
                          <span className="truncate">{group.name}</span>
                          <span className="fx-select-sub truncate text-xs text-muted-foreground">{String(group.domain || "-")}</span>
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
                  <p data-fx-help="" id="forward-group-rate-limit-help" className="text-xs text-muted-foreground">0 表示不限速</p>
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
                    <Badge variant={advancedSettingsConfigured ? "secondary" : "outline"} className="h-5 px-1.5 text-[11px] font-normal">
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

            {/*
              端口转发的入口主机和转发组的成员用同一张列表（2.3.437 起端口转发能挂多台入口主机，
              poouo/Forwardx#15）：每台都同时监听规则的入口端口、转到同一个目标，所以没有「启用」
              开关那一列 —— 不想让哪台转就把它移掉。
            */}
            {!(form.groupMode === "port" && form.entryGroupId) && (
              <div className={form.groupMode === "chain" ? "space-y-2" : "space-y-3 rounded-lg border border-border/60 p-3"}>
                {/* 标题和「添加成员」放一行（省一行高：3 台出口的出口组在笔记本上不用滚） */}
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <Label>{form.groupMode === "chain" ? "链路主机顺序" : form.groupMode === "port" || form.groupMode === "entry" ? "入口主机" : form.groupMode === "exit" ? "出口主机" : "成员优先级"}</Label>
                  {form.groupMode !== "chain" ? (
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
                  ) : null}
                </div>
                {editingPoolId ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-[var(--fx-accent)]/30 bg-[var(--fx-accent-soft)] px-3 py-2 text-xs leading-[1.5]" data-testid="group-follows-pool">
                    <span className="min-w-0 flex-1">
                      成员跟着节点池「{followedPoolName}」：机器的加减以池为准，这里只改每台的地址、带宽、权重和时段。
                    </span>
                    <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2 text-xs" disabled={unfollowPool.isPending} onClick={() => unfollowPool.mutate({ groupId: editingId!, poolId: null })}>
                      不跟了
                    </Button>
                  </div>
                ) : null}
                {form.groupMode === "port" && (
                  <p data-fx-help="" className="text-xs text-muted-foreground">选一台或多台主机，每台都在规则的入口端口上监听、转到同一个目标；加减主机后已有规则自动跟着下发。</p>
                )}
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
                    <div className="space-y-2">
                      {form.members.length > 0 && (
                        <>
                          {/* 有鼠标的宽屏上说明挪到表头的悬停里（省两行，3 台成员的组不用滚）；触屏照旧写出来 */}
                          {form.groupMode !== "port" && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/35 px-2.5 py-1.5 text-[11px] text-muted-foreground [@media(hover:hover)_and_(min-width:640px)]:hidden">
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
                                <span>权重：手动排序比重，0 表示按所选排序依据自动计算</span>
                              </>
                            )}
                            {showLineColumn && <span>线路：按运营商分线路解析，不分 = 只在默认线路</span>}
                            {showScheduleColumn && <span>时段：只在设定的时段使用这个成员，时段外自动暂停</span>}
                            <span>启用：关闭后该成员不参与当前组</span>
                          </div>}
                          <div className={"hidden items-center gap-1.5 px-2.5 text-[11px] text-muted-foreground sm:grid " + memberRowGridClass}>
                            <span className="col-span-2">顺序</span>
                            <span>{effectiveGroupType === "host" ? "主机" : "隧道"}</span>
                            {showExitAddressColumns && (
                              <>
                                <span className="text-center" title="使用该主机内网 IP（和 IPv6 互斥，未配置时不可开启）">内网</span>
                                <span className="text-center" title="使用该主机 IPv6（和内网互斥，未配置时不可开启）">IPv6</span>
                                {showExitWeightColumn && <span className="text-center">权重</span>}
                              </>
                            )}
                            {showAggregationColumns && (
                              <>
                                <span className="text-center" title="该前置的上行带宽，留空或 0 表示未知">上行 Mbps</span>
                                <span className="text-center">权重</span>
                              </>
                            )}
                            {showLineColumn && <span className="text-center" title="按运营商分线路解析，不分 = 只在默认线路">线路</span>}
                            {showScheduleColumn && <span className="text-center" title="只在设定的时段使用这个成员，时段外自动暂停">时段</span>}
                            {form.groupMode !== "port" && <span className="text-center" title="关闭后该成员不参与当前组">启用</span>}
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
                          {/* ↑↓：手机上拖不动，点着调顺序（2.3.534）；电脑上照样能拖 */}
                          <span className="flex items-center">
                            <GripVertical className="hidden h-4 w-4 cursor-grab text-muted-foreground sm:block" />
                            {form.members.length > 1 ? (
                              <span className="fx-lb-move">
                                <button type="button" aria-label={`上移 ${memberLabel(member)}`} disabled={index === 0} onClick={() => moveMember(member.key, form.members[index - 1].key)}>
                                  <ChevronUp className="h-4 w-4" />
                                </button>
                                <button type="button" aria-label={`下移 ${memberLabel(member)}`} disabled={index === form.members.length - 1} onClick={() => moveMember(member.key, form.members[index + 1].key)}>
                                  <ChevronDown className="h-4 w-4" />
                                </button>
                              </span>
                            ) : null}
                          </span>
                          <span className="flex h-6 w-6 items-center justify-center rounded bg-muted text-xs">{index + 1}</span>
                          {member.memberType === "host" ? (
                            <HostStatusLabel
                              host={hostById.get(Number(member.hostId))}
                              label={memberLabel(member)}
                              // 手机上一行：拖动 + 序号 + 名字占满，后面的输入框换到下一行（以前名字被挤成 0 宽，只剩一个圆点）
                              className="min-w-0 flex-1 basis-[calc(100%-6.5rem)] text-sm font-medium sm:basis-auto"
                              labelClassName="truncate"
                            />
                          ) : (
                            <div className="flex min-w-0 flex-1 basis-[calc(100%-6.5rem)] items-center gap-2 sm:basis-auto">
                              <Route className="h-4 w-4 text-primary" />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">{memberLabel(member)}</p>
                              </div>
                            </div>
                          )}
                          {form.groupMode === "exit" && member.memberType === "host" && (
                            <>
                              {/* 手机上没有表头：勾选框旁边直接写它是什么（sm 起表头在上面，这几个字收起） */}
                              <label className="flex h-7 items-center justify-center gap-1.5 sm:w-[56px]">
                                <Checkbox
                                  checked={!!hostPrivateAddress(hostById.get(Number(member.hostId || 0))) && sameAddress(member.connectHost, hostPrivateAddress(hostById.get(Number(member.hostId || 0))))}
                                  disabled={!hostPrivateAddress(hostById.get(Number(member.hostId || 0)))}
                                  onCheckedChange={(checked) => updateExitMemberUsePrivate(member.key, checked)}
                                  aria-label={"为" + memberLabel(member) + "使用内网IP"}
                                />
                                <span className="text-xs text-muted-foreground sm:hidden">内网</span>
                              </label>
                              <label className="flex h-7 items-center justify-center gap-1.5 sm:w-[56px]">
                                <Checkbox
                                  checked={!!hostIpv6Address(hostById.get(Number(member.hostId || 0))) && sameAddress(member.connectHost, hostIpv6Address(hostById.get(Number(member.hostId || 0))))}
                                  disabled={!hostIpv6Address(hostById.get(Number(member.hostId || 0)))}
                                  onCheckedChange={(checked) => updateExitMemberUseIpv6(member.key, checked)}
                                  aria-label={"为" + memberLabel(member) + "使用IPv6转发"}
                                />
                                <span className="text-xs text-muted-foreground sm:hidden">IPv6</span>
                              </label>
                              {showExitWeightColumn && (
                                <label className="flex items-center justify-center gap-1.5 sm:w-[64px]">
                                  <span className="text-xs text-muted-foreground sm:hidden">权重</span>
                                  <Input
                                    type="number"
                                    min={0}
                                    max={MAX_MEMBER_WEIGHT}
                                    value={member.aggregationWeight === "0" ? "" : member.aggregationWeight}
                                    onChange={(e) => updateMemberField(member.key, { aggregationWeight: e.target.value })}
                                    className="h-7 w-[56px] text-center text-xs"
                                    placeholder="自动"
                                    aria-label={memberLabel(member) + "的权重"}
                                  />
                                </label>
                              )}
                            </>
                          )}
                          {showAggregationColumns && (
                            <>
                              <label className="flex items-center gap-1.5">
                              <span className="text-xs text-muted-foreground sm:hidden">上行</span>
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
                              </label>
                              <label className="flex items-center gap-1.5">
                              <span className="text-xs text-muted-foreground sm:hidden">权重</span>
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
                              </label>
                            </>
                          )}
                          {showLineColumn && <div className="flex h-7 w-[44px] items-center justify-center">
                            <MemberDdnsLinesButton
                              value={member.ddnsLines}
                              memberLabel={memberLabel(member)}
                              options={ddnsLineOptions}
                              onChange={(ddnsLines) => updateMemberField(member.key, { ddnsLines })}
                            />
                          </div>}
                          {showScheduleColumn && <div className="flex h-7 w-[44px] items-center justify-center">
                            <MemberScheduleButton
                              value={member.activeSchedule || null}
                              memberLabel={memberLabel(member)}
                              onChange={(activeSchedule) => updateMemberField(member.key, { activeSchedule })}
                            />
                          </div>}
                          {form.groupMode !== "port" && <label className="flex h-7 items-center justify-center gap-1.5 sm:w-[52px]">
                            <Checkbox aria-label={`启用 ${memberLabel(member)}`} checked={member.isEnabled} onCheckedChange={(checked) => {
                              setForm({ ...form, members: form.members.map((m) => m.key === member.key ? { ...m, isEnabled: checked } : m) });
                            }} title={member.isEnabled ? "关闭后该成员不参与转发组切换" : "开启后该成员可参与转发组切换"} />
                            <span className="text-xs text-muted-foreground sm:hidden">启用</span>
                          </label>}
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
      {testGroup && (
        <Suspense fallback={null}>
        <ForwardGroupSelfTestDialog
          groupId={testGroup.id}
          groupName={testGroup.name}
          group={testGroupDetail}
          entryGroup={testGroupEntryGroup}
          hostById={hostById}
          open={!!testGroup}
          onOpenChange={(open) => !open && setTestGroup(null)}
          extraTabs={[{ key: "history", label: "延迟记录", content: <ForwardGroupLatencyBody groupId={testGroup.id} active={!!testGroup} /> }]}
          actions={<DiagnoseSubjectActions kind="forwardGroup" id={testGroup.id} onLeave={() => setTestGroup(null)} />}
        />
        </Suspense>
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
