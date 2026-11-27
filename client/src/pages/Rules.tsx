
import { readStoredViewMode, writeStoredViewMode } from "@/lib/viewModeStorage";
import { FormField } from "@/components/ui/form-field";
import EmptyState from "@/components/EmptyState";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import { InlineLinkCreator } from "@/features/links/InlineLinkCreator";
import { describeLinkKind, linkKindForRouteMode, linkKindRequiresAdmin } from "@/features/links/inlineLinkDraft";
import FilterToolbar from "@/components/FilterToolbar";
import { SearchToggle } from "@/components/ListControls";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLastShown } from "@/components/useDialogTarget";
import { usePanelFlags } from "@/hooks/usePanelFlags";
import SectionTransition from "@/components/SectionTransition";
import { forwardGroupModeOf, isUserspaceForwardType } from "@shared/forwardTypes";
import { prefetchReactGlobe } from "@/lib/reactGlobeLoader";

import { formatBytes } from "@shared/formatBytes";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import DashboardLayout from "@/components/DashboardLayout";
import { DiagnoseSubjectActions } from "@/components/DiagnoseDialog";
import { PersistentPagination, usePersistentPageRequest, useServerPagination } from "@/components/PersistentPagination";
import { SortableDragHandle, SortableItem, SortableReorderContext, useOptimisticSortableOrder } from "@/components/SortableDragHandle";
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
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useDialogCloseGuard, useFormDirty } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { segmentedOptionClassName } from "@/components/ui/segmented";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OptimisticSwitch, Switch } from "@/components/ui/switch";
import { Tabs } from "@/components/ui/tabs";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import type { FilterChipItem } from "@/components/ui/filter-chips";
import { useCompactLayout } from "@/hooks/useCompactLayout";
import { TableColumnResizeHandle, TableColumnSettingsMenu, useTableColumnSettings, type TableColumnMeta } from "@/components/TableColumnSettings";
import type { TableColumnPreference } from "@shared/uiPreferences";
import { useUiTheme } from "@/hooks/useUiTheme";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { isLinkProbeFresh } from "@shared/linkProbePolicy";
import { timestampMillis } from "@shared/timestamp";
import { formatAgo } from "@shared/dashboardAttention";
import { latencyTagTone } from "@/lib/latencyLevel";

import { chunkBatchItems } from "@/lib/batchOperations";
import { RULE_TRANSFER_FILE_KIND, RULE_TRANSFER_FILE_VERSION, RULE_TRANSFER_MAX_IMPORT_COUNT, normalizeFailoverStrategy, type RuleTransferFileRule } from "@/lib/ruleTransfer";
import { getEntryAddressFamily as addressFamily, type EntryAddressFamily } from "@/lib/ruleEntryDisplay";
import { cn } from "@/lib/utils";
import { autoForwardRuleName, resolveForwardRuleName } from "@shared/forwardRuleName";
import { DEFAULT_RULE_EGRESS_FORM, RuleEgressSection, useEgressEntryCapabilities, type RuleEgressFormValue } from "@/components/rules/RuleEgressSection";
import { RuleFormCollapsible } from "@/components/rules/RuleFormCollapsible";
import { RuleLimitsForm, newRuleLimitsForm, ruleLimitsChanges, ruleLimitsSummary, type RuleLimitsFormValue } from "@/components/rules/RuleLimitsForm";
import { RuleLimitSummary } from "@/components/rules/RuleLimitSummary";
import { RuleGroupManagerDialog } from "@/components/rules/PersonalRuleGroups";
import { personalRuleGroupRank, type PersonalRuleGroup } from "@shared/ruleGroups";
import { hasRuleLimits } from "@shared/ruleLimits";
import { ADMIN_MANAGED_RULE_MESSAGE, isAdminManagedRule, normalizeRuleLimitReason } from "@shared/ruleLimits";
import { ruleEgressShapeError, ssEgressTunnelModeSupported, ruleEgressSwitchesForwardType, RULE_EGRESS_TYPE_LABELS, ruleEgressProtocolOf, ruleEgressUsesInbound, ruleEgressUsesLink, SS_EGRESS_UDP_SUPPORTED } from "@shared/ssEgress";
import { VLESS_EGRESS_UDP_SUPPORTED } from "@shared/vlessEgress";
import { sniRuleFormBlocker } from "@shared/tlsInbound";
import {
  BILLING_TIME_ZONE,
} from "@shared/billingTime";
import { parseFailoverTargets } from "@shared/failoverTargets";
import { RouteGroupSheet } from "@/features/rules/RouteGroupSheet";
import { LineDetailFromUrl } from "@/features/links/LineDetailFromUrl";
import { RouteMiniChain, routeBoardActiveChain } from "@/features/rules/RouteBoard";
import { buildRuleCardDerivedProps, ruleCardPropsEqual, type RuleCardDerivedProps, type RuleCardDerivedSources } from "@/features/rules/ruleCardProps";
import { routeGroupPayload, type RouteGroupDraft, type RouteHostOption } from "@/features/rules/RouteGroupFields";
import { expandForPreview, type RouteLinePool, type RouteLineTunnel } from "@/features/rules/RouteLinesEditor";
import { newRouteLine } from "@shared/routeLines";
import { routeHostOptionsOf, routeLinePoolsOf, routeLineTunnelsOf, routeNodeOptionLabel, routeNodeOptionsOf } from "@/features/rules/routeLineOptions";
import { RuleLineGroupField } from "@/features/rules/RuleLineGroupField";
import { docsUrl } from "@/lib/docsLinks";
import { ROUTE_MODE_HINTS, type RuleRouteTab } from "@/features/rules/routeModeHints";
import { describeRoutePolicy, pinUntilSeconds } from "@shared/routePolicy";
import { newRouteGroupDraft, routeGroupTunnelModeSupported, validateRouteGroup } from "@shared/routeGroup";
import { forwardRuleFormBlocker, isAdvancedSectionBlocker, isForwardRuleSourcePortRequired, type ForwardRuleFormContext } from "@shared/forwardRuleForm";
/*
  端口策略以前在这个文件里另抄了一份，而且和服务端漂了：服务端的策略支持
  多段 ranges（套餐发的端口段就是这么下来的），这边完全不认；「不限制」时
  服务端说「不限制」，这边说「1-65535」—— 听着像有限制。合并那一步这边还是
  逐个端口试 1..65535，实测 2.042ms，服务端的区间求交是 0.007ms。
*/
import { describePortPolicy, portPolicyFrom } from "@shared/portPolicy";
import { PORT_RANGE_FORWARD_TYPES, forwardTypeSupportsPortRange, formatRuleTargetPort, isPortRangeRule, parsePortSpec, portRangeUnsupportedReason, ruleSourcePortEnd } from "@shared/portRange";
import { RuleBatchAddDialog } from "@/components/rules/RuleBatchAddDialog";
import { Plus, ArrowRightLeft, ArrowRight, Filter, CheckCircle2, ChevronDown, ChevronRight, XCircle, Loader2, Shuffle, AlertCircle, Copy, Search, Network, ClipboardCopy, ListPlus, Layers3, LayoutGrid, List, Rows3, GitBranch, Globe, RotateCcw, X, Check, Folder, FolderCog } from "lucide-react";

import { FORWARD_TYPES, FORWARD_TYPE_LABELS, formatForwardRuleProtocol, type ForwardType, type ForwardProtocolKey } from "@shared/forwardTypes";
import { ruleLatencyProbeMethodForRule } from "@shared/latencyProbe";
import { formatTrafficMultiplier } from "@shared/trafficMultiplier";
import {
  formatHostAddressWithPort,
  getHostEntryAddress,
  getHostEntryAddresses,
  hostAutoIpv4,
  hostAutoIpv6,
  hostDdnsDomain,
  pushUniqueHostEntryAddress,
  type HostEntryAddress,
} from "@shared/hostEntryAddress";
import { Fragment, lazy, memo, Suspense, useState, useMemo, useEffect, useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { useWarmLazyChunks } from "@/lib/lazyWarm";
import { DialogLoadingFallback } from "@/components/ui/dialog-loading";
import { useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { useLocation, useSearch } from "wouter";
import { getTunnelHopIds, getTunnelRouteText } from "@/lib/tunnelDisplay";
import { StatusDot } from "@/components/network/StatusDot";
import { describeNetworkHealth } from "@shared/networkHealth";
import { Sparkline } from "@/components/charts/Sparkline";
import { HeaderSpark, HeaderStatusChips } from "@/components/HeaderStatusChips";
import {
  decideRuleFlowLayout,
  ruleVisualHealth,
} from "@/features/rules/ruleFlow";
import { resolveForwardRuleNotRunningReason, resolveForwardRuleVisualStatus, resolveForwardRuleStopReason } from "@/lib/forwardRuleStatus";
import { buildLinkAvailabilityIndex } from "@shared/linkAvailability";
import { useUrlTab } from "@/hooks/useUrlTab";
import { useIsMobile } from "@/hooks/useMobile";
import { useStableRows } from "@/lib/stableRows";
import { formatEntryBridgeNote } from "@shared/ruleEntryBridge";
import { useSelfTestLinkTestNodeData } from "../features/rules/useSelfTestLinkTestNodeData";
import { useTrafficByRule } from "../features/rules/useTrafficByRule";
import { useRuleTransferDisplay } from "../features/rules/useRuleTransferDisplay";
import { useRuleEntryAddresses } from "../features/rules/useRuleEntryAddresses";
import { useRuleTransferResources } from "../features/rules/useRuleTransferResources";
import { useRenderTunnelRoute } from "../features/rules/useRenderTunnelRoute";
import { useRuleVisualStatuses } from "../features/rules/useRuleVisualStatuses";
import { useRuleTrafficCells } from "../features/rules/useRuleTrafficCells";
import { useRuleSourceBadges } from "../features/rules/useRuleSourceBadges";
import { useRuleWarningBadges } from "../features/rules/useRuleWarningBadges";
import { useRuleTableTransferCells } from "../features/rules/useRuleTableTransferCells";
import { useRuleStateBadges } from "../features/rules/useRuleStateBadges";
import { useRuleTrafficSeries } from "../features/rules/useRuleTrafficSeries";
import { useRuleSelectOptionHelpers } from "../features/rules/useRuleSelectOptionHelpers";
import { useRuleTransferResourceLists } from "../features/rules/useRuleTransferResourceLists";
import { useRuleBatchManageState } from "../features/rules/useRuleBatchManageState";
import { useRuleBatchManage } from "../features/rules/useRuleBatchManage";
import { useRuleTableColumns } from "../features/rules/useRuleTableColumns";
import { useRuleGridRendering } from "../features/rules/useRuleGridRendering";
import { useRuleViewHandlers } from "../features/rules/useRuleViewHandlers";
import { useRuleActionsRenderer } from "../features/rules/useRuleActionsRenderer";
import { useRuleRouteBadge } from "../features/rules/useRuleRouteBadge";
import { useRuleEntryModeFields } from "../features/rules/useRuleEntryModeFields";
import { useRuleEntryExpansion } from "../features/rules/useRuleEntryExpansion";
import { useRuleSorting } from "../features/rules/useRuleSorting";
import { useRuleFilterCounts } from "../features/rules/useRuleFilterCounts";
import { useRulePortCheck } from "../features/rules/useRulePortCheck";
import { useRuleMainBackup } from "../features/rules/useRuleMainBackup";
import { useRuleRouteModeTabs } from "../features/rules/useRuleRouteModeTabs";
import { useRuleFormOpeners } from "../features/rules/useRuleFormOpeners";
import { useRuleProtocolSupport } from "../features/rules/useRuleProtocolSupport";
import { useRuleCreateCapabilities } from "../features/rules/useRuleCreateCapabilities";
// 懒加载的弹窗：页面闲下来先把 JS 热进缓存（lib/lazyWarm.ts），点开时不用再等一次网络往返
const loadSelfTestDialog = () => import("@/features/rules/SelfTestDialog");
const SelfTestDialog = lazy(loadSelfTestDialog);
const RuleTrafficGlobe = lazy(() => import("@/features/rules/RuleTrafficGlobe"));
const loadRuleBatchManageDialog = () => import("@/features/rules/RuleBatchManageDialog");
const RuleBatchManageDialog = lazy(loadRuleBatchManageDialog);

/** 探测是多久以前的：「18 分钟前」。 */
export const formatProbeAge = (at: unknown) => formatAgo(Date.now() - timestampMillis(at));
// 延迟详情里的曲线图要用 recharts（约 100 kB gzip）；只有点开某条规则的延迟才需要，不跟规则页一起下
// 精简布局：延迟记录并进诊断框当一页
const loadTcpingDetailBody = () => import("@/components/rules/TcpingDetailDialog").then((module) => ({ default: module.TcpingDetailBody }));
const TcpingDetailBody = lazy(loadTcpingDetailBody);
const loadRuleConnectionsBody = () => import("@/components/rules/RuleConnectionsBody").then((module) => ({ default: module.RuleConnectionsBody }));
const RuleConnectionsBody = lazy(loadRuleConnectionsBody);

/** 换隧道后旧入口还在替这条规则转发（服务端带的 entryBridges）：卡片上说一句，到点自己消失。 */
export function entryBridgeNotes(rule: any): string[] {
  const bridges = Array.isArray(rule?.entryBridges) ? rule.entryBridges : [];
  return bridges.map((bridge: any) => formatEntryBridgeNote(bridge));
}

/*
  对话框开着的时候，背后的列表不跟着重渲染。

  新建 / 编辑规则的表单状态（form）挂在整页组件上，于是在对话框里每敲一个字，
  整页几十张规则卡都跟着重算一遍：手机档（CPU 降速 4 倍）实测每个字一个
  95～130 ms 的长任务，按键到画面更新的中位数 144 ms、最慢 272 ms，打字
  明显跟不上手。这几个对话框都是模态的，背后被遮着、也点不到，那段时间
  列表没必要跟着变 —— 冻住，关掉对话框时再一次性追上。

  只拦父组件带来的重渲染：卡片内部自己的状态（菜单开合、各自订阅的数据）
  照常更新。刚冻住的那一次也直接跳过 —— 那一刻屏幕上的就是最新的。
*/
const FreezeWhile = memo(
  function FreezeWhile({ render }: { frozen: boolean; render: () => ReactNode }) {
    return <>{render()}</>;
  },
  (_previous, next) => next.frozen,
);

function clearRuleTrafficStatCaches() {
  if (typeof window === "undefined") return;
  try {
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith("forwardx.stat.rules.traffic."))
      .forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Local UI cache only; ignore storage failures.
  }
}

export type RuleProtocol = "tcp" | "udp" | "both";
export type RuleRouteMode = "local" | "tunnel" | "chain" | "group";

export function isForwardGroupBackedRouteModeValue(mode: RuleRouteMode, forwardGroupId?: number | null) {
  return mode === "chain" || mode === "group" || (mode === "local" && Number(forwardGroupId || 0) > 0);
}

export type RuleFormData = {
  hostId: number | null;
  name: string;
  routeMode: RuleRouteMode;
  forwardType: ForwardType;
  protocol: "tcp" | "udp" | "both";
  tunnelId: number | null;
  forwardGroupId: number | null;
  sourcePort: number;
  targetIp: string;
  targetPort: number;
  /**
   * 两个端口框里的原文（能写端口段 20000-20100，shared/portRange.ts）；null = 按数字显示、单端口。
   * 段尾不另存一个字段：从原文解析（portSpanEndFromText），原文就是唯一的出处，两份不会对不上。
   */
  sourcePortText: string | null;
  targetPortText: string | null;
  /**
   * 目标选的是「我的节点」：记节点 id，保存时作为 proxyNodeId 显式绑定；节点地址变了，
   * 面板把目标改过去（server/proxyNodeFollow.ts）。手改目标地址就解开。
   */
  targetNodeId: number | null;
  telegramErrorNotifyEnabled: boolean;
  /** 规则专属域名开关（shared/ruleEntryDomain.ts）：关掉订阅直接用入口地址。缺省开。 */
  entryDomainEnabled: boolean;
  failoverEnabled: boolean;
  /**
   * 线路组：路径清单 + 调度策略，整份一个字段（shared/routeGroup）。
   *
   * 上一版这里是十个 failover* 字段各存各的（备用地址文本、探测目标、时段表、钉子、
   * 择优、几个秒数……），提交时再拼回去。它们本来就是一件事的十个面 —— 一份 RouteGroup
   * 存着，编辑器整份改、提交整份发，和服务端、Agent 说的是同一个模型。
   */
  routeGroup: RouteGroupDraft | null;
  /**
   * 入口方式：port = 自己占一个端口；sni = 挂到主机的共享 TLS 入站上，按 SNI 分流
   * （shared/tlsInbound.ts）。sni 时没有源端口，协议固定 TCP，不支持线路组。端口转发页签是直连
   * （或经端口转发资源），隧道 / 转发链 / 转发组页签是经它们走（Agent 2.2.255 起）。
   */
  entryMode: "port" | "sni";
  tlsInboundId: number | null;
  /** SNI 域名，一行一个；提交时由服务端规整（小写、IDNA、去重排序）。 */
  sniNamesText: string;
  /** Shadowsocks 出口（shared/ssEgress.ts）：只在端口转发（gost）上有。 */
  egress: RuleEgressFormValue;
  /** 单条规则限额（shared/ruleLimits.ts）：只有管理员看得到、改得了。 */
  limits: RuleLimitsFormValue;
};

type ProxyProtocolVersion = 1 | 2;

export const defaultForm: RuleFormData = {
  hostId: null,
  name: "",
  routeMode: "local",
  forwardType: "iptables",
  protocol: "both",
  tunnelId: null,
  forwardGroupId: null,
  sourcePort: 0,
  targetIp: "",
  targetPort: 0,
  sourcePortText: null,
  targetPortText: null,
  targetNodeId: null,
  telegramErrorNotifyEnabled: false,
  // 新建规则默认不用专属域名，要用再在「更多设置」里打开。
  entryDomainEnabled: false,
  failoverEnabled: false,
  routeGroup: null,
  entryMode: "port",
  tlsInboundId: null,
  sniNamesText: "",
  egress: DEFAULT_RULE_EGRESS_FORM,
  limits: newRuleLimitsForm(),
};

const gostTunnelModes = new Set(["tls", "wss", "tcp", "mtls", "mwss", "mtcp"]);
const nginxTunnelModes = new Set(["nginx_stream"]);
export const unsupportedProtocolTitle = "当前转发方式已停用，请编辑并切换到可用资源";
export const revokedResourceTitle = "资源授权已失效，请编辑规则并选择当前有权限的端口转发或隧道";
export const desktopRuleTypeLabels = {
  local: "端口转发",
  tunnel: "隧道转发",
  chain: "转发链",
  group: "转发组",
} as const;
export const ruleTypeDescriptions = {
  local: "使用已保存端口转发",
  tunnel: "通过隧道出口转发",
  chain: "按转发链顺序转发",
  group: "使用转发组入口",
} as const;

export type RuleViewMode = "card" | "table" | "globe";
export type RuleCardSize = "standard" | "compact";
export type RuleDisplayMode = RuleCardSize | "table" | "globe";
export type RulePageSize = 12 | 24 | 36 | 48;
export type RuleGroupType = keyof typeof desktopRuleTypeLabels;
type RuleGroupCollapsedState = Partial<Record<RuleGroupType, boolean>>;
export type RuleCategory = "all" | "local" | "tunnel" | "chain" | "group";
export type RuleCategoryCounts = Record<RuleCategory, number>;
export type RuleTransferScopeType = Exclude<RuleCategory, "all">;
export type RuleResourceFilter = "all" | `${RuleTransferScopeType}` | `${RuleTransferScopeType}:${number}`;
// state：批量启用 / 暂停 / 重启（上游 2.3.292），和删除、复制一样交给服务端任务（RuleBatchJobWidget 看进度）
export type RuleBatchManageMode = "copy" | "edit" | "export" | "import" | "group" | "state";
export type BatchEditFormData = Pick<RuleFormData, "routeMode" | "forwardType" | "tunnelId" | "forwardGroupId" | "targetIp" | "targetPort">;

const RULE_CATEGORIES = ["all", "local", "tunnel", "chain", "group"] as const;
export const ruleTransferScopeLabels: Record<RuleTransferScopeType, string> = {
  local: "端口转发",
  tunnel: "隧道",
  chain: "转发链",
  group: "转发组",
};

export const ruleTransferScopeOptions: Array<{ value: RuleTransferScopeType; label: string }> = [
  { value: "local", label: "端口转发" },
  { value: "tunnel", label: "隧道" },
  { value: "chain", label: "转发链" },
  { value: "group", label: "转发组" },
];
export const importRuleTransferScopeOptions = ruleTransferScopeOptions;

export function parseRuleResourceFilter(value: unknown): { type: RuleTransferScopeType | null; id: number | null } {
  const raw = String(value || "").trim();
  if (!raw || raw === "all") return { type: null, id: null };
  const [type, idText] = raw.split(":", 2);
  if (!(ruleTransferScopeOptions as readonly { value: string }[]).some((item) => item.value === type)) {
    return { type: null, id: null };
  }
  const id = idText ? Number(idText) : 0;
  return {
    type: type as RuleTransferScopeType,
    id: Number.isInteger(id) && id > 0 ? id : null,
  };
}

export function normalizeRuleResourceFilter(value: unknown): RuleResourceFilter {
  const parsed = parseRuleResourceFilter(value);
  if (!parsed.type) return "all";
  return parsed.id ? `${parsed.type}:${parsed.id}` : parsed.type;
}

const RULE_VIEW_MODE_STORAGE_KEY = "forwardx.rules.viewMode";
const RULE_CARD_SIZE_STORAGE_KEY = "forwardx.rules.cardSize";
const RULE_PAGE_SIZE_STORAGE_KEY = "forwardx.rules.pageSize";
const RULE_GROUP_COLLAPSED_STORAGE_KEY = "forwardx.rules.groupCollapsed";
const RULE_CATEGORY_STORAGE_KEY = "forwardx.rules.category";
const RULE_FILTER_USER_STORAGE_KEY = "forwardx.rules.filterUser";
const RULE_FILTER_RESOURCE_STORAGE_KEY = "forwardx.rules.filterResource";
/** 个人分组筛选（按账号记）："" = 全部，"0" = 未分组，数字 = 那个组。 */
const RULE_FILTER_PERSONAL_GROUP_STORAGE_KEY = "forwardx.rules.filterPersonalGroup";
const RULE_SORT_BY_PERSONAL_GROUP_STORAGE_KEY = "forwardx.rules.sortByPersonalGroup";
const RULE_TABLE_GROUP_COLUMN_STORAGE_KEY = "forwardx.rules.tableGroupColumn";
/*
  规则列表视图的「列设置」（上游 2.3.287，components/TableColumnSettings.tsx）：显示哪些列、顺序、列宽按账号存。
  key 和下面 ruleTableColumns 里的一一对应（标准 / 精简各有几列不一样，存在同一份偏好里，没有的列忽略）。
  规则名、操作两列必须显示，钉在头尾。
*/
const RULE_TABLE_COLUMN_LABELS: Record<string, string> = {
  rule: "规则",
  personalGroups: "分组",
  resource: "所属资源",
  entry: "转发入口",
  exit: "转发出口",
  protocol: "协议",
  total: "累计",
  traffic: "流量",
  latency: "延迟",
  enabled: "开关",
  actions: "操作",
};
function ruleTableColumnMeta(keys: string[]): TableColumnMeta[] {
  return keys.map((key) => ({
    key,
    label: RULE_TABLE_COLUMN_LABELS[key] ?? key,
    required: key === "rule" || key === "actions",
    pin: key === "rule" ? "start" as const : key === "actions" ? "end" as const : undefined,
    minWidth: key === "rule" ? 120 : key === "actions" ? 100 : 48,
  }));
}
const RULE_TABLE_COLUMNS_STANDARD = ruleTableColumnMeta(["rule", "personalGroups", "resource", "entry", "exit", "traffic", "latency", "enabled", "actions"]);
const RULE_TABLE_COLUMNS_COMPACT = ruleTableColumnMeta(["rule", "personalGroups", "resource", "entry", "exit", "protocol", "total", "latency", "actions"]);
/** 账号上还没存过列设置、本机原来记着「不显示分组列」时，照它来。 */
const LEGACY_HIDDEN_GROUP_COLUMN_PREFERENCE: TableColumnPreference = { order: [], hidden: ["personalGroups"], widths: {} };
/** 默认八、九列加起来约 1016px，表格最小宽度原来写死 1000：拖宽、藏列以后按这个比例跟着变。 */
export const RULE_TABLE_MIN_WIDTH_RATIO = 1000 / 1016;
const EMPTY_PERSONAL_RULE_GROUPS: PersonalRuleGroup[] = [];
/** 卡片上的分组名拼成一个字符串传给 memo 的卡片（数组每轮都是新的，会让卡片白重画）；分组名里打不出这个字符。 */
const PERSONAL_GROUP_NAME_SEPARATOR = "\u001f";

function parseStoredPersonalGroupFilter(value: string): number | null {
  if (value === "") return null;
  const id = Math.floor(Number(value));
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

/**
 * 规则卡 / 深空行名字旁边的分组标签。拿的是拼好的名字串（见 PERSONAL_GROUP_NAME_SEPARATOR），只画前 max 个，
 * 后面写「+N」，悬停看全部 —— 卡片上地方小，和链路、协议挤在同一行。
 */
function RuleCardGroupChips({ names, max = 1 }: { names: string; max?: number }) {
  if (!names) return null;
  const list = names.split(PERSONAL_GROUP_NAME_SEPARATOR);
  return (
    <span data-rule-personal-groups="" className="inline-flex min-w-0 shrink-0 items-center gap-1" title={`所属分组：${list.join("、")}`}>
      {list.slice(0, max).map((name) => (
        <Badge key={name} variant="outline" className="h-[18px] min-w-0 max-w-[6.5rem] gap-1 px-1.5 text-[10.5px] font-normal text-muted-foreground">
          <Folder className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{name}</span>
        </Badge>
      ))}
      {list.length > max ? <Badge variant="secondary" className="h-[18px] shrink-0 px-1.5 text-[10.5px] font-normal">+{list.length - max}</Badge> : null}
    </span>
  );
}
const RULE_SORT_CATEGORY_ORDER: RuleTransferScopeType[] = ["local", "tunnel", "chain", "group"];
const RULE_SORT_CATEGORY_RANK = new Map<RuleTransferScopeType, number>(
  RULE_SORT_CATEGORY_ORDER.map((category, index) => [category, index]),
);
export const RULE_PAGE_SIZE_OPTIONS: RulePageSize[] = [12, 24, 36, 48];
export const EMPTY_RULE_CATEGORY_COUNTS: RuleCategoryCounts = { all: 0, local: 0, tunnel: 0, chain: 0, group: 0 };
const RULE_CATEGORY_COUNTS_CACHE_PREFIX = "forwardx.rules.categoryCounts.";

export function normalizeRuleCategoryCounts(value: unknown): RuleCategoryCounts {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const count = (key: RuleCategory) => Math.max(0, Math.floor(Number(source[key]) || 0));
  const local = count("local");
  const tunnel = count("tunnel");
  const chain = count("chain");
  const group = count("group");
  return {
    all: Math.max(0, Math.floor(Number(source.all) || local + tunnel + chain + group)),
    local,
    tunnel,
    chain,
    group,
  };
}

export function readCachedRuleCategoryCounts(cacheKey: string): RuleCategoryCounts | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${RULE_CATEGORY_COUNTS_CACHE_PREFIX}${cacheKey}`);
    return raw ? normalizeRuleCategoryCounts(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeCachedRuleCategoryCounts(cacheKey: string, counts: RuleCategoryCounts) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${RULE_CATEGORY_COUNTS_CACHE_PREFIX}${cacheKey}`, JSON.stringify(counts));
  } catch {
    // Local UI cache only; ignore storage failures.
  }
}

export function ruleCategoryCountsEqual(a: RuleCategoryCounts, b: RuleCategoryCounts) {
  return RULE_CATEGORIES.every((category) => a[category] === b[category]);
}

function getStoredRuleViewMode(): RuleViewMode {
  return readStoredViewMode<RuleViewMode>(RULE_VIEW_MODE_STORAGE_KEY, ["table", "globe", "card"], "card");
}

export function storeRuleViewMode(viewMode: RuleViewMode) {
  writeStoredViewMode(RULE_VIEW_MODE_STORAGE_KEY, viewMode);
}

function getDefaultRuleCardSize(): RuleCardSize {
  return "standard";
}

function getStoredRuleCardSize(): RuleCardSize {
  const fallback = getDefaultRuleCardSize();
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(RULE_CARD_SIZE_STORAGE_KEY);
    return value === "compact" || value === "standard" ? value : fallback;
  } catch {
    return fallback;
  }
}

export function storeRuleCardSize(cardSize: RuleCardSize) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RULE_CARD_SIZE_STORAGE_KEY, cardSize);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function getStoredRulePageSize(fallback: RulePageSize = 12): RulePageSize {
  if (typeof window === "undefined") return fallback;
  try {
    const value = Number(window.localStorage.getItem(RULE_PAGE_SIZE_STORAGE_KEY)) as RulePageSize;
    return RULE_PAGE_SIZE_OPTIONS.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function storeRulePageSize(pageSize: RulePageSize) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RULE_PAGE_SIZE_STORAGE_KEY, String(pageSize));
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function getStoredRuleGroupCollapsed(): RuleGroupCollapsedState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(RULE_GROUP_COLLAPSED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const next: RuleGroupCollapsedState = {};
    (["local", "tunnel", "chain", "group"] as RuleGroupType[]).forEach((type) => {
      if (typeof parsed[type] === "boolean") next[type] = parsed[type];
    });
    return next;
  } catch {
    return {};
  }
}

export function storeRuleGroupCollapsed(state: RuleGroupCollapsedState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RULE_GROUP_COLLAPSED_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function getStoredString(key: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value || fallback;
  } catch {
    return fallback;
  }
}

export function storeString(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function ruleFilterStorageKey(key: string, user: { id?: number; role?: string } | null | undefined) {
  const identity = user?.id ? `${String(user.role || "user")}-${Number(user.id)}` : "guest";
  return `${key}.${identity}`;
}

function getRuleForwardGroupKind(rule: any, forwardGroupById: Map<number, any>): "local" | "chain" | "group" | null {
  const groupId = Number(rule?.forwardGroupId || 0);
  if (!groupId) return null;
  const group = forwardGroupById.get(groupId);
  const mode = forwardGroupModeOf(group);
  if (mode === "port") return "local";
  return mode === "chain" ? "chain" : "group";
}

export function getRuleCategory(rule: any, forwardGroupById: Map<number, any>): Exclude<RuleCategory, "all"> {
  const groupKind = getRuleForwardGroupKind(rule, forwardGroupById);
  if (groupKind) return groupKind;
  return rule.forwardType === "gost" && rule.tunnelId ? "tunnel" : "local";
}

export function getRuleDisplayType(rule: any, forwardGroupById: Map<number, any>): RuleGroupType {
  return getRuleCategory(rule, forwardGroupById);
}

export type RuleFilterState = {
  filterUser: string;
  filterResource: RuleResourceFilter;
  ruleCategory: RuleCategory;
  searchQuery: string;
  isAdmin: boolean;
  userId?: number | null;
  hostById: Map<number, any>;
  tunnelById: Map<number, any>;
  userById: Map<number, any>;
  forwardGroupById: Map<number, any>;
  getRuleEntryHostId: (rule: any) => number;
};

type RuleSortableRenderState = {
  itemProps: any;
  handleProps: any;
  isDragging: boolean;
  isDropTarget: boolean;
};

function RuleGroupItems({
  open,
  className,
  children,
  layout,
}: {
  open: boolean;
  className: string;
  children: ReactNode;
  layout?: boolean;
}) {
  return (
    <div
      aria-hidden={!open}
      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
    >
      <AutoAnimateContainer layout={layout} className={`min-h-0 overflow-hidden ${className}`}>
        {children}
      </AutoAnimateContainer>
    </div>
  );
}

/** 换进来的第一帧先画这么多张卡，其余随后补（见 ruleCardsHydrated）。手机一屏 4 张紧凑卡。 */
export const INITIAL_RULE_CARD_BUDGET = 6;

/** 还没轮到画的卡先占着位：和紧凑卡差不多高，补上时列表不跳。 */
function RuleCardPlaceholder() {
  return <div className="fx-rule-card-placeholder" aria-hidden="true" />;
}

/*
  ─── 规则卡：单独一个 React.memo 组件 ───

  以前卡片是 RulesContent 里的一个 renderRuleCard 闭包，页面上随便哪条查询轮询回来（规则列表、
  流量、线路板……每几秒一条），整页连同每一张卡都重画一遍：一屏几十张卡，手机上一次就是上百毫秒。
  现在卡片只认传进来的 props，props 没变就不重画，一次轮询只改了一条规则，就只重画那一张。

  props 分三类，都要求「没变就是同一个值」：
    · rule：没变的那条规则拿到的还是上一轮的对象（规则行里有 Date，光靠 React Query 的结构共享
      做不到，见下面 rules 那里的 useStableRows）；
    · 这张卡自己的派生值（状态、线路组、流量数字、探测结果……）：父组件按规则算好
      （features/rules/ruleCardProps.ts 的 buildRuleCardDerivedProps），传原始值（数字、字符串、布尔），
      对象一律拆开；走势线是数组，按内容比（ruleCardPropsEqual）；和「现在几点」有关的（探测过没过期、
      多久以前、到没到期、线路组「几点起」）也在那里按当下算好，卡片自己不读时钟 —— 不然没重画的卡
      会一直停在上次的「3 分钟前」；
    · page：一页共用的那一包（布局、身份、主机 / 隧道 / 线路组表……），变了所有卡一起重画。
      page.ui 是一个引用永远不变的转发器，调过去的是父组件这一轮最新的函数（见 RulesContent 里的
      ruleCardUi）：卡片里点「编辑」「开关」拿到的总是最新的状态，不会是这张卡上次画时的旧闭包。
      ui.* 读到的页面数据都列在 page.helperInputs 里，它们一变 page 就换引用。
*/
export type RuleCardRule = any;
/** 主机 / 隧道 / 转发组这些资源行在页面里还是宽类型（仓储层带 any）；抽出去的批量管理 hook / 弹窗用这个名字指它们，别再散落 any。 */
export type RuleResourceRow = any;
/** 当前登录用户（auth.me 的返回行）；抽出去的 hook 用这个名字，不再各写一个 any。 */
export type RulePageUser = ReturnType<typeof useAuth>["user"];
type RuleCardTone = "ok" | "warn" | "down" | "off";

type RuleTransferDisplay = {
  entryAddresses: Array<{ label: string; value: string; text: string; copyable: boolean }>;
  targetAddress: string;
  entryTitle: string;
};

export type RuleCardUi = {
  isRuleSupported: (rule: RuleCardRule) => boolean;
  getRuleProtocolKey: (rule: RuleCardRule) => ForwardProtocolKey | null;
  protocolUnsupportedLabel: (protocolKey: ForwardProtocolKey | null | undefined) => string;
  getRuleTransferDisplay: (rule: RuleCardRule) => RuleTransferDisplay;
  getRuleHopNames: (rule: RuleCardRule) => string[];
  getRuleResourceName: (rule: RuleCardRule) => string;
  getRuleOwnerName: (rule: RuleCardRule) => string;
  renderAdminManagedBadge: (rule: RuleCardRule) => ReactNode;
  renderSniRuleBadge: (rule: RuleCardRule) => ReactNode;
  renderEgressBadge: (rule: RuleCardRule) => ReactNode;
  renderKernelForwardWarningBadge: (rule: RuleCardRule) => ReactNode;
  renderPortWarningBadge: (rule: RuleCardRule) => ReactNode;
  renderTunnelFxpIssueBadge: (rule: RuleCardRule) => ReactNode;
  renderSubscriptionBadge: (rule: RuleCardRule) => ReactNode;
  renderSubscriptionMark: (rule: RuleCardRule) => ReactNode;
  renderRuleActions: (rule: RuleCardRule) => ReactNode;
  renderRuleEnabledSwitch: (rule: RuleCardRule) => ReactNode;
  copyEntryAddress: (rule: RuleCardRule, entryValue?: string) => void;
  copyTargetAddress: (text: string) => void;
  toggleEntryAddresses: (ruleId: number) => void;
  toggleRuleLines: (ruleId: number) => void;
  openRulePolicy: (ruleId: number) => void;
  openEdit: (rule: RuleCardRule) => void;
  toggleRuleEnabled: (rule: RuleCardRule, checked: boolean) => Promise<void>;
};

type RuleCardPage = {
  compact: boolean;
  compactLayout: boolean;
  isAdmin: boolean;
  ruleReorderPending: boolean;
  forwardGroupById: Map<number, RuleCardRule>;
  ui: RuleCardUi;
  /** ui.* 读到的页面数据：卡片不直接用，放在这里是为了它们一变 page 就换引用、所有卡跟着重画。 */
  helperInputs: readonly unknown[];
};

type RuleCardProps = RuleCardDerivedProps & {
  rule: RuleCardRule;
  sortable?: RuleSortableRenderState;
  page: RuleCardPage;
  /** 这条规则在当前登录的人的哪几个分组里：名字按组的顺序拼成一串（见 PERSONAL_GROUP_NAME_SEPARATOR），不在任何组是 ""。 */
  personalGroupNames: string;
};

const RULE_TONE_COLOR: Record<RuleCardTone, string> = {
  ok: "var(--fx-primary-fill)",
  warn: "var(--fx-warn)",
  down: "var(--fx-down)",
  off: "var(--fx-text-muted)",
};

const splitBytes = (bytes: number) => {
  const [value, unit] = formatBytes(bytes).split(" ");
  return { value: value || "0", unit: unit || "B" };
};

const ruleRowKey = (rule: { id?: unknown }) => Number(rule?.id);
const EMPTY_TLS_INBOUND_OPTIONS: never[] = [];

/** 规则卡的转发器：每个方法调的都是 ref 这一刻指着的那份（父组件每轮渲染重新指一次）。 */
function createRuleCardUiDispatcher(ref: { current: RuleCardUi | null }): RuleCardUi {
  const latest = () => {
    if (!ref.current) throw new Error("规则卡的转发器还没接上");
    return ref.current;
  };
  return {
    isRuleSupported: (rule) => latest().isRuleSupported(rule),
    getRuleProtocolKey: (rule) => latest().getRuleProtocolKey(rule),
    protocolUnsupportedLabel: (protocolKey) => latest().protocolUnsupportedLabel(protocolKey),
    getRuleTransferDisplay: (rule) => latest().getRuleTransferDisplay(rule),
    getRuleHopNames: (rule) => latest().getRuleHopNames(rule),
    getRuleResourceName: (rule) => latest().getRuleResourceName(rule),
    getRuleOwnerName: (rule) => latest().getRuleOwnerName(rule),
    renderAdminManagedBadge: (rule) => latest().renderAdminManagedBadge(rule),
    renderSniRuleBadge: (rule) => latest().renderSniRuleBadge(rule),
    renderEgressBadge: (rule) => latest().renderEgressBadge(rule),
    renderKernelForwardWarningBadge: (rule) => latest().renderKernelForwardWarningBadge(rule),
    renderPortWarningBadge: (rule) => latest().renderPortWarningBadge(rule),
    renderTunnelFxpIssueBadge: (rule) => latest().renderTunnelFxpIssueBadge(rule),
    renderSubscriptionBadge: (rule) => latest().renderSubscriptionBadge(rule),
    renderSubscriptionMark: (rule) => latest().renderSubscriptionMark(rule),
    renderRuleActions: (rule) => latest().renderRuleActions(rule),
    renderRuleEnabledSwitch: (rule) => latest().renderRuleEnabledSwitch(rule),
    copyEntryAddress: (rule, entryValue) => latest().copyEntryAddress(rule, entryValue),
    copyTargetAddress: (text) => latest().copyTargetAddress(text),
    toggleEntryAddresses: (ruleId) => latest().toggleEntryAddresses(ruleId),
    toggleRuleLines: (ruleId) => latest().toggleRuleLines(ruleId),
    openRulePolicy: (ruleId) => latest().openRulePolicy(ruleId),
    openEdit: (rule) => latest().openEdit(rule),
    toggleRuleEnabled: (rule, checked) => latest().toggleRuleEnabled(rule, checked),
  };
}

/*
  规则卡（「玻璃 · 大数字」那版样稿，用户选的方向，按他们的要求收紧到一屏四张）：

    ● 名字                                        ··· [开关]
      资源 · 经 跳点 · 工具 · 协议
    113 GB   ～～走势线～～          近 24H
                                    ↓ 2.76 GB · ↑ 3.42 GB
    ─────────────────────────────────────────────
    192.0.2.21:443  →  10.10.3.88:443        [46 ms]

  卡不描边，坐在浅灰页面上靠一层很淡的投影成形；左上角一抹状态色的光（--fx-rule-tone）。
  状态点在名字左边（用户定的）。第一版卡头还有一枚类型图标格，用户看图说「图标不要」，去掉了；
  类型仍由分组标题上的小图标格和卡上那抹光的色调说。
  大数字是累计总量：一张卡最值得一眼看到的数。走势线是近 24 小时逐时字节，只画形状。
  地址一行等宽字、不截断；右端一枚小标签：延迟，或者切了线 / 出错 / 停用这些更要紧的话。
*/
/*
  规则卡和「深空」主题下的规则行共用的派生值：状态色、副标题、延迟标签、线路组那枚、告警徽标……
  两种画法只是排版不同，显示的内容和判断必须一模一样，所以算在一处。不是 hook（里面没有 hook），
  只是一段从 props 推出来的纯计算，外加几枚现成的小 JSX。
*/
function deriveRuleView({
  rule,
  page,
  visualState,
  visualTitle,
  visualConfirmed,
  visualPinBypassed,
  failover,
  totalIn,
  totalOut,
  dailyIn,
  dailyOut,
  routeBoard,
  probe,
  entriesExpanded: entriesOpen,
  linesOpen,
}: RuleCardProps) {
  const { ui, compact, compactLayout } = page;
  const visual = { state: visualState, title: visualTitle, confirmed: visualConfirmed, pinBypassed: visualPinBypassed };
  const supported = ui.isRuleSupported(rule);
  const protocolKey = ui.getRuleProtocolKey(rule);
  const category = getRuleCategory(rule, page.forwardGroupById) as RuleGroupType;
  // 状态点：通的就是绿（画点的三处也用同一个 ruleVisualHealth）
  const health = !supported || rule.resourceAccessAllowed === false ? "down" : ruleVisualHealth(visual);
  const healthToken = describeNetworkHealth(health).token;
  /*
    色调（走势线、左上角那抹光、地址行的箭头）：指定的出口连不上、已切到别的出口（pinBypassed），或者在用的出口刚坏、
    正在切（confirmed 的橙色），是琥珀 —— 点照样绿，卡上也不写原因，只用走势线提醒（用户 2026-11-27）。线路组切了线同理。
  */
  const tone: RuleCardTone = healthToken === "down"
    ? "down"
    : healthToken === "standby"
      ? "off"
      : healthToken === "warn" || visual.confirmed || visual.pinBypassed || (failover && failover.tone === "warn")
        ? "warn"
        : "ok";
  const toneColor = RULE_TONE_COLOR[tone];

  const { entryAddresses, targetAddress, entryTitle } = ui.getRuleTransferDisplay(rule);
  const primaryEntry = entryAddresses[0];
  const extraEntries = Math.max(0, entryAddresses.length - 1);
  const entriesExpanded = extraEntries > 0 && entriesOpen;
  const hops = decideRuleFlowLayout(category) === "flow" && category !== "group" ? ui.getRuleHopNames(rule) : [];
  const forwardLabel = FORWARD_TYPE_LABELS[rule?.forwardType as ForwardType] || "";
  const subtitleParts = [
    ui.getRuleResourceName(rule),
    hops.length > 0 ? `经 ${hops.join(" / ")}` : "",
    forwardLabel,
    formatForwardRuleProtocol(rule.protocol),
    !compact && page.isAdmin ? ui.getRuleOwnerName(rule) : "",
  ].filter(Boolean);
  const subtitle = subtitleParts.join(" · ");

  const big = splitBytes(totalIn + totalOut);
  const dailyBytes = dailyIn + dailyOut;

  // 地址行右端那枚小标签：切了线 / 出错 / 停用比延迟要紧，有就换掉延迟。
  const hasLineRows = !!failover && !!routeBoard;
  const linesExpanded = hasLineRows && linesOpen;
  // 有线路行可展开时点这枚是展开 / 收起；没有（线路板还没数据）就照旧直接进线路组
  const onFailoverPill = () => (hasLineRows ? ui.toggleRuleLines(Number(rule.id)) : ui.openRulePolicy(Number(rule.id)));
  // 线路组一律写在地址行左边那枚（择优 · 2 条 / 主备 · 主线路），右端的标签照旧是延迟 / 状态：
  // 以前择优、切换中会顶掉右端的延迟，两种线路组的卡就长得不一样（用户 2026-11-03 对比图）。
  let tag: ReactNode = null;
  /*
    灰点（没在运行、也没停用）的规则：名字后面跟一枚标签写原因 —— Agent 报的失败原因（「监听没起来」「运行时没装」），
    或者还在等什么（「等待 Agent 应用」）；悬停看原文。以前灰点旁边什么都没有，只能去日志里找（2026-11 走查）。
    放在名字那一行、紧挨着灰点：地址行右端那一格放不下这几个字，会把地址挤到第二行、整张卡变高。
    窄的时候标签先缩（「等待 Ag…」，悬停看全文），名字后缩。
  */
  const notRunning = supported ? resolveForwardRuleNotRunningReason(visual, rule?.portWarnings) : null;
  const notRunningTag = notRunning
    ? <span className="fx-rule-tag min-w-[4.5em] shrink-[4]" data-tone={notRunning.tone} title={notRunning.detail} data-rule-not-running="">{notRunning.label}</span>
    : null;
  if (visual.state === "error") {
    tag = <span className="fx-rule-tag" data-tone="down" title={visual.title}>{visual.title}</span>;
  } else if (visual.state === "disabled") {
    const stop = resolveForwardRuleStopReason(rule);
    tag = <span className="fx-rule-tag" data-tone="off" title={stop?.detail || "规则已停用"}>{stop?.label || "已停用"}</span>;
  } else {
    // 线路组：卡上写当前路径的整链延迟（线路板各段相加），不是出口直探目标的那个数。
    const activeChain = failover ? routeBoardActiveChain(routeBoard) : null;
    if (activeChain && activeChain.totalMs !== null && !activeChain.broken) {
      const ms = Math.round(activeChain.totalMs);
      tag = <span className="fx-rule-tag" data-tone={latencyTagTone(ms)} title={activeChain.partial ? `整链 ≥ ${ms} ms：当前路径已测各段相加（有一段还没测到）` : `整链 ${ms} ms：当前路径各段延迟相加`}>{activeChain.partial ? "≥ " : ""}{ms} ms</span>;
    } else if (activeChain?.broken) {
      tag = <span className="fx-rule-tag" data-tone="down" title="当前路径有一段不通">不通</span>;
    } else if (probe.at && probe.stale) {
      // 过期的探测：灰掉并写明多久以前，不再把三天前的 12 ms 画成绿的。
      const text = probe.isTimeout ? "超时" : probe.ms !== null ? `${Math.round(probe.ms)} ms` : "";
      if (text) tag = <span className="fx-rule-tag" data-tone="off" title={`整链 ${text}：${probe.ageText}测的，已过期；··· › 诊断 重新测`}>{text} · {probe.ageText}</span>;
    } else if (probe.at) {
      if (probe.isTimeout) {
        tag = <span className="fx-rule-tag" data-tone="down" title="最近一次测试超时">超时</span>;
      } else if (probe.ms !== null) {
        const ms = probe.ms;
        // 一律是整链（入口→在用出口→目标）：悬停写明来历（入口实时两段各多少 / 定时探测 / 最近一次诊断）；只有一段时写「≥」
        tag = <span className="fx-rule-tag" data-tone={latencyTagTone(ms)} title={probe.liveTitle || `整链 ${Math.round(ms)} ms`}>{probe.atLeast ? "≥ " : ""}{ms} ms</span>;
      }
    }
    // 精简的列表行：这个位置固定是延迟（用户 2026-10-21 圈的），没测过也占着，写「未测试」
    if (!tag && compactLayout) {
      tag = <span className="fx-rule-tag" data-tone="off" title="还没测过延迟：··· › 诊断 测一次">未测试</span>;
    }
  }
  const failoverAside = failover ? (
    <button
      type="button"
      className="fx-rule-foot-link"
      data-tone={failover.tone === "normal" ? undefined : failover.tone === "warn" ? "warn" : "off"}
      title={hasLineRows ? (linesExpanded ? "收起线路" : `${failover.title}（点开看线路）`) : failover.title}
      aria-label={`线路组：${failover.title}`}
      aria-expanded={hasLineRows ? linesExpanded : undefined}
      onClick={onFailoverPill}
    >
      <GitBranch className="h-3 w-3" aria-hidden="true" />
      {failover.text}
    </button>
  ) : null;

  const alerts = [
    ui.renderAdminManagedBadge(rule),
    ui.renderSniRuleBadge(rule),
    ui.renderEgressBadge(rule),
    ui.renderKernelForwardWarningBadge(rule),
    // 原因已经写在地址行右端那枚标签上了（见上面 notRunning），红色徽标不再重复一遍
    notRunning?.fromWarning ? null : ui.renderPortWarningBadge(rule),
    rule?.tunnelId ? ui.renderTunnelFxpIssueBadge(rule) : null,
    ui.renderSubscriptionBadge(rule),
    !supported ? (
      <Badge key="unsupported" variant="outline" className="h-5 border-destructive/30 px-1.5 text-[11px] text-destructive">
        {ui.protocolUnsupportedLabel(protocolKey)} 不支持
      </Badge>
    ) : null,
  ].filter(Boolean);

  return {
    ui, compact, compactLayout, visual, supported, protocolKey, category, health, tone, toneColor,
    entryAddresses, targetAddress, entryTitle, primaryEntry, extraEntries, entriesExpanded,
    subtitle, big, dailyBytes, hasLineRows, linesExpanded, tag, notRunningTag, failoverAside, alerts,
  };
}

const RuleCard = memo(function RuleCard(props: RuleCardProps) {
  const { rule, sortable, page, totalIn, totalOut, hasTotal, dailyIn, dailyOut, spark, routeBoard, failover } = props;
  const {
    ui, compact, visual, supported, tone, toneColor,
    entryAddresses, targetAddress, entryTitle, primaryEntry, extraEntries, entriesExpanded,
    subtitle, big, dailyBytes, linesExpanded, tag, notRunningTag, failoverAside, alerts,
  } = deriveRuleView(props);
  return (
    <Card
      {...(sortable?.itemProps || {})}
      className={cn(
        "group/sortable fx-rule-card relative action-card transition-[box-shadow,opacity]",
        !supported && "opacity-70",
        sortable?.isDragging && "opacity-55 ring-1 ring-primary/35",
        sortable?.isDropTarget && "ring-1 ring-primary/45",
      )}
      data-tone={tone}
      data-size={compact ? "compact" : "standard"}
      style={{ ...(sortable?.itemProps?.style || {}), "--fx-rule-tone": toneColor } as CSSProperties}
      title={!supported ? unsupportedProtocolTitle : undefined}
    >
      <CardContent className="fx-rule-card-body action-card-content">
        <div className="fx-rule-head">
          <div className="fx-rule-title">
            <div className="fx-rule-name">
              {/* 状态点在名字左边（用户定的），图标格不要了（用户看了图说「图标不要」） */}
              <span className="fx-rule-dot">
                {supported ? (
                  <span title={visual.title} className="inline-flex">
                    <StatusDot health={ruleVisualHealth(visual)} size="large" label={visual.title} />
                  </span>
                ) : <StatusDot health="down" size="large" label={unsupportedProtocolTitle} />}
              </span>
              <span className="truncate" title={rule.name} data-no-translate="">{rule.name}</span>
              {notRunningTag}
              {ui.renderSubscriptionMark(rule)}
            </div>
            {/* 链路 · 工具 · 协议和分组标签同一行（上游 2.3.287）；还是这一个 .fx-rule-sub，精简布局的网格认的是它 */}
            {props.personalGroupNames ? (
              <div className="fx-rule-sub flex items-center gap-1.5" title={`${subtitle} · 分组：${props.personalGroupNames.split(PERSONAL_GROUP_NAME_SEPARATOR).join("、")}`}>
                <span className="min-w-0 truncate">{subtitle}</span>
                <RuleCardGroupChips names={props.personalGroupNames} />
              </div>
            ) : (
              <div className="fx-rule-sub" title={subtitle}>{subtitle}</div>
            )}
          </div>
          <div className="fx-rule-head-actions">
            {ui.renderRuleActions(rule)}
            {ui.renderRuleEnabledSwitch(rule)}
            {/* 拖动手柄放最右边（iOS 列表编辑态的位置）：原来在「···」左边，正是拇指上下滑的地方，一碰就成了拖（用户 2026-11-03） */}
            {sortable && (
              <SortableDragHandle
                dragHandleProps={sortable.handleProps}
                visible={sortable.isDragging}
                busy={page.ruleReorderPending}
                className="bg-card/70"
              />
            )}
          </div>
        </div>

        <div className="fx-rule-big">
          <div
            className="fx-rule-num"
            title={hasTotal ? `累计入向 ${formatBytes(totalIn)} / 出向 ${formatBytes(totalOut)}` : "还没有流量"}
          >
            <b>{big.value}</b><small>{big.unit}</small>
          </div>
          <Sparkline
            values={spark}
            width={96}
            height={28}
            stroke={toneColor}
            className="fx-rule-spark"
            title={spark.some((value) => value > 0) ? "近 24 小时逐时流量走势" : undefined}
          />
          <div className="fx-rule-day">
            <span>近 24H</span>
            <span className="fx-rule-day-val" title="近 24 小时入向 · 出向">
              {dailyBytes > 0 ? `↓ ${formatBytes(dailyIn)} · ↑ ${formatBytes(dailyOut)}` : "没有流量"}
            </span>
          </div>
        </div>

        {alerts.length > 0 ? (
          <div className="fx-rule-alerts">{alerts}</div>
        ) : null}
        {/* 到期那一下（props.expiryPassed 翻过去）这张卡会重画，RuleLimitSummary 按当下时间判断「已于…到期」 */}
        <RuleLimitSummary rule={rule} />
        {(rule.protocolBlockReason || rule.resourceAccessAllowed === false) && (
          <div className="line-clamp-2 text-[11px] leading-4 text-destructive">
            {rule.protocolBlockReason || revokedResourceTitle}
          </div>
        )}
        {rule.entryDomainError ? (
          <div className="line-clamp-1 text-[11px] leading-4 text-[var(--fx-warn-text)]" title={String(rule.entryDomainError)}>
            规则域名未同步：{String(rule.entryDomainError)}（面板会自动重试）
          </div>
        ) : null}
        {(() => {
          const stop = !rule.protocolBlockReason && rule.resourceAccessAllowed !== false ? resolveForwardRuleStopReason(rule) : null;
          return stop?.autoResume ? (
            <div className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">{stop.detail}</div>
          ) : null;
        })()}
        {entryBridgeNotes(rule).map((note) => (
          <div key={note} className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">{note}</div>
        ))}

        <div className="fx-rule-path" title={`${entryAddresses.map((entry) => entry.text).join(" / ")} → ${targetAddress}`}>
          {/* 入口和目标都是点一下就复制（用户要的）；小复制图标常驻，不用悬停才显出来 */}
          {primaryEntry && !entriesExpanded ? (
            <span className="fx-rule-addr-group">
              <button
                type="button"
                onClick={() => primaryEntry.copyable && ui.copyEntryAddress(rule, primaryEntry.value)}
                disabled={!primaryEntry.copyable}
                className="fx-rule-addr"
                title={primaryEntry.copyable ? entryTitle : primaryEntry.text}
              >
                <span className="truncate">{primaryEntry.text}</span>
                {primaryEntry.copyable ? <Copy className="fx-rule-addr-copy" aria-hidden="true" /> : null}
              </button>
              {extraEntries > 0 ? (
                <button
                  type="button"
                  className="fx-rule-addr-more"
                  onClick={() => ui.toggleEntryAddresses(Number(rule.id))}
                  aria-expanded={false}
                  title={`展开全部 ${entryAddresses.length} 个入口地址`}
                >
                  +{extraEntries}
                </button>
              ) : null}
            </span>
          ) : null}
          {primaryEntry && entriesExpanded ? (
            <span className="fx-rule-addr-list">
              {entryAddresses.map((entry) => (
                <button
                  key={`${entry.label}:${entry.value}`}
                  type="button"
                  onClick={() => entry.copyable && ui.copyEntryAddress(rule, entry.value)}
                  disabled={!entry.copyable}
                  className="fx-rule-addr"
                  title={entry.copyable ? `${entryTitle} (${entry.label})` : entry.text}
                >
                  <span className="fx-rule-addr-label">{entry.label}</span>
                  <span className="truncate">{entry.text}</span>
                  {entry.copyable ? <Copy className="fx-rule-addr-copy" aria-hidden="true" /> : null}
                </button>
              ))}
              <button
                type="button"
                className="fx-rule-addr-more"
                onClick={() => ui.toggleEntryAddresses(Number(rule.id))}
                aria-expanded={true}
                title="收起"
              >
                收起
              </button>
            </span>
          ) : null}
          <span className="fx-rule-path-to">
            <ArrowRight className="fx-rule-path-arrow" aria-hidden="true" />
            <button
              type="button"
              onClick={() => ui.copyTargetAddress(targetAddress)}
              className="fx-rule-addr"
              title={`复制目标地址: ${targetAddress}`}
            >
              <span className="truncate">{targetAddress}</span>
              <Copy className="fx-rule-addr-copy" aria-hidden="true" />
            </button>
          </span>
          <span className="fx-rule-path-end">
            {failoverAside}
            {tag}
          </span>
        </div>
        {linesExpanded && failover?.policy && routeBoard ? (
          <RouteMiniChain
            className="mt-1.5"
            status={routeBoard}
            policy={failover.policy}
            onOpen={() => ui.openRulePolicy(Number(rule.id))}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}, ruleCardPropsEqual);

/*
  「深空」主题下的规则行（用户 2026-11-05 选的商业化方向 B：一整块面板里一行一条，不是一张张大卡）。

  手机：三行 —— ● 名字 · 副标题 ……… 延迟 ··· [开关] / 入口 → 目标 ……… 累计 / 一条贴满整行的走势。
  桌面：一行一条的表格 —— 名字 | 入口 → 目标 | 延迟 | 近 24 小时走势 | 近 24 小时 ↓↑ | 累计 | 操作。
  内容、判断、按钮和规则卡完全一样（deriveRuleView），只是排法不同；告警、限速、到期这些附加信息
  有才出现，在行的最下面另起一行。排法全在 themes/official/deepspace/theme.css 的 .fx-ds-rule*。
*/
const RuleRow = memo(function RuleRow(props: RuleCardProps) {
  const { rule, sortable, page, totalIn, totalOut, hasTotal, dailyIn, dailyOut, spark, routeBoard, failover } = props;
  const {
    ui, visual, supported, tone, toneColor, category,
    entryAddresses, targetAddress, entryTitle, primaryEntry, extraEntries,
    subtitle, big, dailyBytes, linesExpanded, tag, notRunningTag, failoverAside, alerts,
  } = deriveRuleView(props);
  const stop = !rule.protocolBlockReason && rule.resourceAccessAllowed !== false ? resolveForwardRuleStopReason(rule) : null;
  const notes = [
    ...(rule.protocolBlockReason || rule.resourceAccessAllowed === false ? [{ key: "block", tone: "down", text: String(rule.protocolBlockReason || revokedResourceTitle) }] : []),
    ...(rule.entryDomainError ? [{ key: "domain", tone: "warn", text: `规则域名未同步：${String(rule.entryDomainError)}（面板会自动重试）` }] : []),
    ...(stop?.autoResume ? [{ key: "stop", tone: "off", text: stop.detail }] : []),
    ...entryBridgeNotes(rule).map((note) => ({ key: note, tone: "off", text: note })),
  ];
  return (
    <div
      {...(sortable?.itemProps || {})}
      className={cn(
        "group/sortable fx-ds-rule",
        !supported && "opacity-70",
        sortable?.isDragging && "opacity-55 ring-1 ring-primary/35",
        sortable?.isDropTarget && "ring-1 ring-primary/45",
      )}
      data-tone={tone}
      style={{ ...(sortable?.itemProps?.style || {}), "--fx-rule-tone": toneColor } as CSSProperties}
      title={!supported ? unsupportedProtocolTitle : undefined}
    >
      <div className="fx-ds-rule-id">
        <span className="fx-ds-rule-dot">
          {supported ? (
            <span title={visual.title} className="inline-flex">
              <StatusDot health={ruleVisualHealth(visual)} label={visual.title} />
            </span>
          ) : <StatusDot health="down" label={unsupportedProtocolTitle} />}
        </span>
        <div className="fx-ds-rule-names">
          <div className="fx-ds-rule-name">
            <span className="fx-ds-rule-kind" data-kind={category}>{desktopRuleTypeLabels[category as RuleGroupType] || "转发"}</span>
            <span className="truncate" title={rule.name} data-no-translate="">{rule.name}</span>
            {notRunningTag}
            {ui.renderSubscriptionMark(rule)}
            <RuleCardGroupChips names={props.personalGroupNames} />
          </div>
          <div className="fx-ds-rule-sub" title={subtitle}>{subtitle}</div>
        </div>
      </div>

      <div className="fx-ds-rule-path" title={`${entryAddresses.map((entry) => entry.text).join(" / ")} → ${targetAddress}`}>
        {primaryEntry ? (
          <button
            type="button"
            onClick={() => primaryEntry.copyable && ui.copyEntryAddress(rule, primaryEntry.value)}
            disabled={!primaryEntry.copyable}
            className="fx-ds-rule-addr"
            title={primaryEntry.copyable ? entryTitle : primaryEntry.text}
          >
            <span className="truncate">{primaryEntry.text}</span>
          </button>
        ) : null}
        {extraEntries > 0 ? (
          <button
            type="button"
            className="fx-ds-rule-more"
            onClick={() => ui.toggleEntryAddresses(Number(rule.id))}
            title={`共 ${entryAddresses.length} 个入口地址`}
          >
            +{extraEntries}
          </button>
        ) : null}
        <ArrowRight className="fx-ds-rule-arrow" aria-hidden="true" />
        <button
          type="button"
          onClick={() => ui.copyTargetAddress(targetAddress)}
          className="fx-ds-rule-addr"
          title={`复制目标地址: ${targetAddress}`}
        >
          <span className="truncate">{targetAddress}</span>
        </button>
      </div>

      <div className="fx-ds-rule-lat">
        {failoverAside}
        {tag}
      </div>

      <Sparkline
        values={spark}
        width={240}
        height={22}
        stroke={toneColor}
        className="fx-ds-rule-spark"
        title={spark.some((value) => value > 0) ? "近 24 小时逐时流量走势" : undefined}
      />

      <div className="fx-ds-rule-day" title="近 24 小时入向 · 出向">
        {dailyBytes > 0 ? `↓ ${formatBytes(dailyIn)} · ↑ ${formatBytes(dailyOut)}` : "近 24H 没有流量"}
      </div>

      <div className="fx-ds-rule-total" title={hasTotal ? `累计入向 ${formatBytes(totalIn)} / 出向 ${formatBytes(totalOut)}` : "还没有流量"}>
        <b>{big.value}</b><small>{big.unit}</small>
      </div>

      <div className="fx-ds-rule-actions">
        {ui.renderRuleActions(rule)}
        {ui.renderRuleEnabledSwitch(rule)}
        {sortable && (
          <SortableDragHandle
            dragHandleProps={sortable.handleProps}
            visible={sortable.isDragging}
            busy={page.ruleReorderPending}
          />
        )}
      </div>

      {alerts.length > 0 || notes.length > 0 || hasRuleLimits(rule) || rule.anomalyThrottle ? (
        <div className="fx-ds-rule-extra">
          {alerts.length > 0 ? <div className="fx-rule-alerts">{alerts}</div> : null}
          <RuleLimitSummary rule={rule} />
          {notes.map((note) => (
            <div key={note.key} className="fx-ds-rule-note" data-tone={note.tone}>{note.text}</div>
          ))}
        </div>
      ) : null}
      {linesExpanded && failover?.policy && routeBoard ? (
        <RouteMiniChain
          className="fx-ds-rule-extra"
          status={routeBoard}
          policy={failover.policy}
          onOpen={() => ui.openRulePolicy(Number(rule.id))}
        />
      ) : null}
    </div>
  );
}, ruleCardPropsEqual);

function RuleRouteTransition({
  transitionKey: _transitionKey,
  className,
  children,
}: {
  transitionKey: string;
  className?: string;
  children: ReactNode;
}) {
  return <div className={className}>{children}</div>;
}

function RuleCardModeTransition({
  mode,
  className,
  children,
}: {
  mode: RuleCardSize;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();
  const mountedModeRef = useRef<RuleCardSize | null>(null);

  useEffect(() => {
    if (mountedModeRef.current === null) {
      mountedModeRef.current = mode;
      return;
    }
    if (mountedModeRef.current === mode) return;
    mountedModeRef.current = mode;
    const element = ref.current;
    if (!element || reduceMotion || typeof element.animate !== "function") return;

    // 液态玻璃下不动透明度：这层半透明的那 140ms 里，里面玻璃卡的模糊会消失（见 theme-liquid-glass.css「进场动画」）。
    const glass = document.documentElement.getAttribute("data-ui-theme") === "liquid-glass";
    const animation = element.animate(
      [
        { ...(glass ? {} : { opacity: 0.9 }), transform: "translate3d(0, 4px, 0)" },
        { ...(glass ? {} : { opacity: 1 }), transform: "translate3d(0, 0, 0)" },
      ],
      { duration: 140, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    return () => animation.cancel();
  }, [mode, reduceMotion]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

function addRuleSearchPart(parts: string[], value: unknown) {
  const text = String(value ?? "").trim();
  if (text) parts.push(text);
}

function addRuleSearchPort(parts: string[], port: unknown, label: string) {
  const text = String(port ?? "").trim();
  if (!text || text === "0") return;
  addRuleSearchPart(parts, text);
  addRuleSearchPart(parts, `${label}${text}`);
  addRuleSearchPart(parts, `:${text}`);
}

function addRuleSearchHostParts(parts: string[], host: any | null | undefined, port?: number | string) {
  if (!host) return;
  addRuleSearchPart(parts, host.name);
  addRuleSearchPart(parts, host.displayRemark);
  addRuleSearchPart(parts, host.remark);
  addRuleSearchPart(parts, host.description);
  addRuleSearchPart(parts, host.hostname);
  addRuleSearchPart(parts, host.ip);
  addRuleSearchPart(parts, host.ipv4);
  addRuleSearchPart(parts, host.ipv6);
  addRuleSearchPart(parts, host.entryIp);
  addRuleSearchPart(parts, host.tunnelEntryIp);
  addRuleSearchPart(parts, host.ddnsDomain);
  addRuleSearchPart(parts, host.geoCountryName);
  addRuleSearchPart(parts, host.geoRegion);
  getHostEntryAddresses(host).forEach((entry) => {
    addRuleSearchPart(parts, entry.label);
    addRuleSearchPart(parts, entry.value);
    if (port !== undefined) addRuleSearchPart(parts, formatAddressWithPort(entry.value, port));
  });
}

function addRuleSearchUserParts(parts: string[], owner: any | null | undefined) {
  if (!owner) return;
  addRuleSearchPart(parts, owner.name);
  addRuleSearchPart(parts, owner.username);
  addRuleSearchPart(parts, owner.displayRemark);
  addRuleSearchPart(parts, owner.email);
  addRuleSearchPart(parts, owner.id ? `用户 #${owner.id}` : "");
}

function addRuleSearchTunnelParts(parts: string[], tunnel: any | null | undefined, filters: RuleFilterState) {
  if (!tunnel) return;
  addRuleSearchPart(parts, tunnel.name);
  addRuleSearchPart(parts, tunnel.mode);
  addRuleSearchPart(parts, tunnel.id ? `隧道 #${tunnel.id}` : "");
  try {
    addRuleSearchPart(parts, getTunnelRouteText(tunnel, Array.from(filters.hostById.values())));
  } catch {
    // Ignore route text failures; individual hop names are still indexed below.
  }
  getTunnelHopIds(tunnel).forEach((hostId: number) => {
    addRuleSearchHostParts(parts, filters.hostById.get(Number(hostId)), undefined);
  });
}

function addRuleSearchForwardGroupParts(parts: string[], group: any | null | undefined, filters: RuleFilterState, port?: number | string) {
  if (!group) return;
  addRuleSearchPart(parts, group.name);
  addRuleSearchPart(parts, group.domain);
  addRuleSearchPart(parts, group.remark);
  addRuleSearchPart(parts, group.displayRemark);
  addRuleSearchPart(parts, group.description);
  addRuleSearchPart(parts, group.id ? `${getForwardGroupKindLabel(group)} #${group.id}` : "");
  addRuleSearchPart(parts, getForwardGroupKindLabel(group));
  addRuleSearchPart(parts, desktopRuleTypeLabels[getRuleForwardGroupKind({ forwardGroupId: group.id }, filters.forwardGroupById) || "group"]);
  if (group.domain && port !== undefined) addRuleSearchPart(parts, formatAddressWithPort(group.domain, port));

  const entryGroup = isForwardChainGroup(group) && Number(group.entryGroupId || 0) > 0
    ? filters.forwardGroupById.get(Number(group.entryGroupId))
    : null;
  if (entryGroup) addRuleSearchForwardGroupParts(parts, entryGroup, filters, port);

  (group.members || []).forEach((member: any) => {
    addRuleSearchPart(parts, member.entryAddress);
    addRuleSearchPart(parts, member.connectHost);
    if (member.entryAddress && port !== undefined) addRuleSearchPart(parts, formatAddressWithPort(member.entryAddress, port));
    if (Number(member.hostId || 0) > 0) addRuleSearchHostParts(parts, filters.hostById.get(Number(member.hostId)), port);
    if (Number(member.tunnelId || 0) > 0) addRuleSearchTunnelParts(parts, filters.tunnelById.get(Number(member.tunnelId)), filters);
  });
}

function buildRuleSearchText(rule: any, filters: RuleFilterState) {
  const parts: string[] = [];
  const sourcePort = Number(rule?.sourcePort || 0);
  const targetPort = Number(rule?.targetPort || 0);
  const targetIp = String(rule?.targetIp || "").trim();
  const category = getRuleCategory(rule, filters.forwardGroupById);
  const group = rule?.forwardGroupId ? filters.forwardGroupById.get(Number(rule.forwardGroupId)) : null;
  const tunnel = rule?.tunnelId ? filters.tunnelById.get(Number(rule.tunnelId)) : null;
  const entryHostId = filters.getRuleEntryHostId(rule);

  addRuleSearchPart(parts, rule?.name);
  addRuleSearchPart(parts, rule?.id ? `规则 #${rule.id}` : "");
  addRuleSearchPart(parts, desktopRuleTypeLabels[category]);
  addRuleSearchPart(parts, ruleTypeDescriptions[category]);
  addRuleSearchPart(parts, rule?.forwardType);
  addRuleSearchPart(parts, FORWARD_TYPE_LABELS[rule?.forwardType as ForwardType]);
  addRuleSearchPart(parts, formatForwardRuleProtocol(rule?.protocol));
  addRuleSearchPart(parts, rule?.protocol);
  addRuleSearchPort(parts, sourcePort, "入口端口");
  addRuleSearchPort(parts, targetPort, "目标端口");
  addRuleSearchPart(parts, targetIp);
  if (targetIp && targetPort > 0) addRuleSearchPart(parts, formatAddressWithPort(targetIp, targetPort));
  if (sourcePort > 0 && targetIp && targetPort > 0) addRuleSearchPart(parts, `${sourcePort}->${formatAddressWithPort(targetIp, targetPort)}`);

  const storedHostId = Number(rule?.hostId || 0);
  if (!entryHostId || entryHostId === storedHostId) {
    addRuleSearchHostParts(parts, filters.hostById.get(storedHostId), sourcePort);
  } else {
    addRuleSearchHostParts(parts, filters.hostById.get(entryHostId), sourcePort);
  }
  addRuleSearchTunnelParts(parts, tunnel, filters);
  addRuleSearchForwardGroupParts(parts, group, filters, sourcePort);
  addRuleSearchUserParts(parts, filters.userById.get(Number(rule?.userId || 0)));

  parseFailoverTargets(rule?.failoverTargets).forEach((target) => {
    addRuleSearchPart(parts, target.targetIp);
    addRuleSearchPort(parts, target.targetPort, "备用端口");
    if (target.targetIp && target.targetPort > 0) addRuleSearchPart(parts, formatAddressWithPort(target.targetIp, target.targetPort));
  });

  return parts.join("\n").toLowerCase();
}

function isRuleSearchMatch(rule: any, filters: RuleFilterState) {
  const tokens = String(filters.searchQuery || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const searchText = buildRuleSearchText(rule, filters);
  return tokens.every((token) => searchText.includes(token));
}
export function isForwardRuleVisibleByFilters(rule: any, filters: RuleFilterState) {
  if (filters.isAdmin) {
    if (filters.filterUser === "self" && Number(rule.userId) !== Number(filters.userId)) {
      return false;
    }
    if (filters.filterUser !== "all" && filters.filterUser !== "self" && Number(rule.userId) !== Number(filters.filterUser)) {
      return false;
    }
  }
  const resourceFilter = parseRuleResourceFilter(filters.filterResource);
  if (resourceFilter.type) {
    const group = rule?.forwardGroupId ? filters.forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const resourceType = getRuleCategory(rule, filters.forwardGroupById);
    if (resourceType !== resourceFilter.type) return false;
    if (resourceFilter.id) {
      const resourceId = resourceType === "tunnel"
        ? Number(rule?.tunnelId || 0)
        : Number(rule?.forwardGroupId || 0);
      if (resourceId !== resourceFilter.id || (resourceType !== "tunnel" && !group)) return false;
    }
  }
  if (filters.ruleCategory !== "all") {
    if (getRuleCategory(rule, filters.forwardGroupById) !== filters.ruleCategory) return false;
  }
  if (!isRuleSearchMatch(rule, filters)) return false;
  return true;
}

export function getTunnelDisplay(tunnel: any | null | undefined, showNginxLabel = true) {
  const mode = String(tunnel?.mode || "").toLowerCase();
  if (mode === "forwardx") {
    return {
      shortLabel: "NEX",
      badgeLabel: "隧道 / NEX",
      toolLabel: "NEX 加密隧道",
    };
  }
  if (gostTunnelModes.has(mode)) {
    return {
      shortLabel: "GOST",
      badgeLabel: "隧道 / GOST",
      toolLabel: "GOST 隧道",
    };
  }
  if (nginxTunnelModes.has(mode)) {
    if (!showNginxLabel) {
      return {
        shortLabel: "\u96a7\u9053",
        badgeLabel: "\u96a7\u9053",
        toolLabel: "\u96a7\u9053\u8f6c\u53d1",
      };
    }
    return {
      shortLabel: "Nginx",
      badgeLabel: "\u96a7\u9053 / Nginx",
      toolLabel: "Nginx Stream \u96a7\u9053",
    };
  }
  return {
    shortLabel: mode ? mode.toUpperCase() : "隧道",
    badgeLabel: mode ? `隧道 / ${mode.toUpperCase()}` : "隧道",
    toolLabel: "隧道转发",
  };
}

// 入口地址推导已移到 shared，服务端生成客户端订阅时复用同一实现，
// 保证订阅里的节点地址和面板上显示的入口地址永远一致。
export type EntryAddress = HostEntryAddress;
export const pushUniqueEntryAddress = pushUniqueHostEntryAddress;
export const formatAddressWithPort = formatHostAddressWithPort;
/** 规则卡上的入口地址：端口段写成 `地址:20000-20100`（shared/portRange.ts）。 */
/** 端口框原文里的段尾（20000-20100 → 20100）；单端口、没写完或写错都是 0。 */
function portSpanEndFromText(text: string | null): number {
  const spec = text ? parsePortSpec(text) : null;
  return spec && !("error" in spec) && spec.end > spec.start ? spec.end : 0;
}

export const formatRuleEntryAddress = (host: string, rule: { sourcePort?: unknown; sourcePortEnd?: unknown }) => (
  isPortRangeRule(rule)
    ? `${formatAddressWithPort(host, Number(rule.sourcePort))}-${ruleSourcePortEnd(rule)}`
    : formatAddressWithPort(host, Number(rule.sourcePort))
);

export function isForwardChainGroup(group: any | null | undefined) {
  return forwardGroupModeOf(group) === "chain";
}

export function getForwardGroupRouteLabel(group: any | null | undefined) {
  const mode = forwardGroupModeOf(group);
  if (mode === "port") return "端口转发";
  if (mode === "chain") return "转发链";
  return "转发组";
}

// GOST、Nginx、NEX 隧道都能挂线路组：调度器在隧道出口机上。
export function isGostTunnelForMainBackup(tunnel: any | null | undefined) {
  return routeGroupTunnelModeSupported(tunnel?.mode);
}

export function isForwardGroupMainBackupTunnelSupported(group: any | null | undefined, tunnelById: Map<number, any>) {
  if (!group || isForwardChainGroup(group) || String(group?.groupType || "") !== "tunnel") return false;
  const tunnelMembers = (Array.isArray(group.members) ? group.members : [])
    .filter((member: any) => member?.isEnabled !== false && Number(member?.tunnelId || 0) > 0);
  if (tunnelMembers.length === 0) return false;
  return tunnelMembers.every((member: any) => isGostTunnelForMainBackup(tunnelById.get(Number(member.tunnelId))));
}

type LiteralAddressFamily = "ipv4" | "ipv6";

function isKernelForwardType(type: unknown) {
  const text = String(type || "").trim().toLowerCase();
  return text === "iptables" || text === "nftables";
}

function familyLabel(family: EntryAddressFamily) {
  if (family === "ipv4") return "IPv4";
  if (family === "ipv6") return "IPv6";
  if (family === "hostname") return "域名";
  return "未知协议族";
}

function literalFamilySet(value: unknown) {
  const family = addressFamily(value);
  const families = new Set<LiteralAddressFamily>();
  if (family === "ipv4" || family === "ipv6") families.add(family);
  return families;
}

function addLiteralHostFamily(families: Set<LiteralAddressFamily>, value: unknown) {
  const family = addressFamily(value);
  if (family === "ipv4" || family === "ipv6") families.add(family);
}

function hostDdnsFamily(host: any | null | undefined): LiteralAddressFamily | null {
  const ipVersion = String(host?.ddnsIpVersion || "").trim().toLowerCase();
  const recordType = String(host?.ddnsRecordType || "").trim().toUpperCase();
  if (ipVersion === "ipv6" || recordType === "AAAA") return "ipv6";
  if (ipVersion === "ipv4" || recordType === "A") return "ipv4";
  return null;
}

function hostEntryFamilies(host: any | null | undefined) {
  const families = new Set<LiteralAddressFamily>();
  const manualEntry = String(host?.entryIp || "").trim();
  if (manualEntry) {
    addLiteralHostFamily(families, manualEntry);
  } else if (hostDdnsDomain(host)) {
    // 双栈 DDNS（A + AAAA）的域名两族都能解析
    if (String(host?.ddnsIpVersion || "").trim().toLowerCase() === "dual") {
      families.add("ipv4");
      families.add("ipv6");
    } else {
      const ddnsFamily = hostDdnsFamily(host);
      if (ddnsFamily) families.add(ddnsFamily);
    }
  } else {
    addLiteralHostFamily(families, hostAutoIpv4(host) || hostAutoIpv6(host) || host?.ip);
  }
  return families;
}
function warningHostName(host: any | null | undefined, fallback: string) {
  return String(host?.name || fallback).trim();
}

function resolveChainConnectHostForWarning(member: any, host: any | null | undefined) {
  const stored = String(member?.connectHost || "").trim();
  const publicAddr = getHostEntryAddress(host);
  const privateAddr = String(host?.tunnelEntryIp || "").trim();
  const ipv6Addr = String(host?.ipv6 || "").trim();
  if (stored && privateAddr && stored === privateAddr) return privateAddr;
  if (stored && ipv6Addr && stored === ipv6Addr) return ipv6Addr;
  return publicAddr || stored;
}

export function enabledHostMembers(group: any | null | undefined) {
  return [...(group?.members || [])]
    .filter((member: any) => member?.memberType !== "tunnel" && member?.isEnabled !== false && Number(member?.hostId || 0) > 0)
    .sort((a: any, b: any) => Number(a.priority || 0) - Number(b.priority || 0));
}

function lookupHostForWarning(hosts: any[] | undefined, hostById: Map<number, any> | undefined, hostId: number) {
  if (!Number.isFinite(hostId) || hostId <= 0) return null;
  return hostById?.get(hostId) || (hosts || []).find((host: any) => Number(host.id) === hostId) || null;
}

function kernelFamilyWarning(toolLabel: string, fromLabel: string, sourceFamilies: Set<LiteralAddressFamily>, targetLabel: string, targetFamily: EntryAddressFamily) {
  if (targetFamily !== "ipv4" && targetFamily !== "ipv6") return null;
  const families = Array.from(sourceFamilies);
  if (families.length === 0) return null;
  if (!families.includes(targetFamily)) {
    return `${toolLabel} 属于内核 NAT/防火墙规则，不能把 ${familyLabel(families[0])} 入口直接转成 ${familyLabel(targetFamily)} 目标；${fromLabel} 到 ${targetLabel} 需要改用 realm/socat/gost 等用户态转发，或把两端统一到同一协议族。`;
  }
  if (families.length > 1) {
    const otherFamily = families.find((family) => family !== targetFamily);
    if (otherFamily) {
      return `${toolLabel} 属于内核 NAT/防火墙规则，${fromLabel} 同时暴露 IPv4/IPv6，但 ${targetLabel} 只明确为 ${familyLabel(targetFamily)}；使用 ${familyLabel(otherFamily)} 入口访问时可能不通，跨 IPv4/IPv6 建议改用用户态转发。`;
    }
  }
  return null;
}

type KernelForwardWarningInput = {
  rule: any;
  host?: any | null;
  group?: any | null;
  hosts?: any[];
  hostById?: Map<number, any>;
  forwardGroupById?: Map<number, any>;
};

function buildKernelChainForwardWarning(input: Required<Pick<KernelForwardWarningInput, "rule">> & Omit<KernelForwardWarningInput, "rule"> & { group: any; toolLabel: string }) {
  const { rule, group, hosts, hostById, forwardGroupById, toolLabel } = input;
  const members = enabledHostMembers(group);
  if (members.length === 0) return null;
  const getHost = (hostId: number) => lookupHostForWarning(hosts, hostById, hostId);
  const firstMember = members[0];
  const firstHost = getHost(Number(firstMember.hostId || 0));
  const entryGroup = Number(group?.entryGroupId || 0) > 0 ? forwardGroupById?.get(Number(group.entryGroupId)) : null;
  const entryMembers = entryGroup && forwardGroupModeOf(entryGroup) === "entry" ? enabledHostMembers(entryGroup) : [];
  const firstConnectHost = resolveChainConnectHostForWarning(firstMember, firstHost);
  let inboundFamilies = entryMembers.length > 0 ? literalFamilySet(firstConnectHost) : hostEntryFamilies(firstHost);

  if (entryMembers.length > 0) {
    const firstConnectFamily = addressFamily(firstConnectHost);
    const firstName = warningHostName(firstHost, `主机${Number(firstMember.hostId || 0) || ""}`);
    for (const entryMember of entryMembers) {
      const entryHost = getHost(Number(entryMember.hostId || 0));
      const entryName = warningHostName(entryHost, `入口主机${Number(entryMember.hostId || 0) || ""}`);
      const warning = kernelFamilyWarning(
        toolLabel,
        `${entryName} 入口`,
        hostEntryFamilies(entryHost),
        `${firstName} 连接地址`,
        firstConnectFamily,
      );
      if (warning) return warning;
    }
    if (inboundFamilies.size === 0) inboundFamilies = hostEntryFamilies(firstHost);
  }

  for (let index = 0; index < members.length - 1; index++) {
    const current = members[index];
    const next = members[index + 1];
    const currentHost = getHost(Number(current.hostId || 0));
    const nextHost = getHost(Number(next.hostId || 0));
    const nextConnectHost = resolveChainConnectHostForWarning(next, nextHost);
    const currentName = warningHostName(currentHost, `主机${Number(current.hostId || 0) || ""}`);
    const nextName = warningHostName(nextHost, `主机${Number(next.hostId || 0) || ""}`);
    const warning = kernelFamilyWarning(
      toolLabel,
      `${currentName} 入口`,
      inboundFamilies,
      `${nextName} 连接地址`,
      addressFamily(nextConnectHost),
    );
    if (warning) return warning;
    inboundFamilies = literalFamilySet(nextConnectHost);
    if (inboundFamilies.size === 0) inboundFamilies = hostEntryFamilies(nextHost);
  }

  const lastMember = members[members.length - 1];
  const lastHost = getHost(Number(lastMember.hostId || 0));
  return kernelFamilyWarning(
    toolLabel,
    `${warningHostName(lastHost, `主机${Number(lastMember.hostId || 0) || ""}`)} 入口`,
    inboundFamilies,
    `最终目标 ${String(rule?.targetIp || "").trim() || "-"}`,
    addressFamily(rule?.targetIp),
  );
}

export function buildKernelForwardWarning({ rule, host, group, hosts = [], hostById, forwardGroupById }: KernelForwardWarningInput) {
  const forwardType = String(rule?.forwardType || "").trim().toLowerCase();
  if (!isKernelForwardType(forwardType)) return null;
  const toolLabel = FORWARD_TYPE_LABELS[forwardType as ForwardType] || forwardType;
  const activeGroup = group || (Number(rule?.forwardGroupId || 0) > 0 ? forwardGroupById?.get(Number(rule.forwardGroupId)) : null);
  if (activeGroup && isForwardChainGroup(activeGroup)) {
    return buildKernelChainForwardWarning({ rule, group: activeGroup, hosts, hostById, forwardGroupById, toolLabel });
  }
  if (activeGroup && forwardGroupModeOf(activeGroup) === "failover" && activeGroup.groupType === "host") {
    for (const member of enabledHostMembers(activeGroup)) {
      const memberHost = lookupHostForWarning(hosts, hostById, Number(member.hostId || 0));
      const warning = kernelFamilyWarning(
        toolLabel,
        `${warningHostName(memberHost, `成员主机${Number(member.hostId || 0) || ""}`)} 入口`,
        hostEntryFamilies(memberHost),
        `最终目标 ${String(rule?.targetIp || "").trim() || "-"}`,
        addressFamily(rule?.targetIp),
      );
      if (warning) return warning;
    }
    return null;
  }
  const entryHost = host || lookupHostForWarning(hosts, hostById, Number(rule?.hostId || 0));
  if (!entryHost) return null;
  return kernelFamilyWarning(
    toolLabel,
    `${warningHostName(entryHost, "入口主机")} 入口`,
    hostEntryFamilies(entryHost),
    `目标 ${String(rule?.targetIp || "").trim() || "-"}`,
    addressFamily(rule?.targetIp),
  );
}
function isSelectableForwardRuleGroup(group: any | null | undefined) {
  const mode = forwardGroupModeOf(group);
  return mode === "port" || mode === "failover" || mode === "chain";
}

export function getForwardGroupKindLabel(group: any | null | undefined) {
  const mode = forwardGroupModeOf(group);
  if (mode === "port") return "端口转发";
  if (mode === "chain") return "转发链";
  if (mode === "entry") return "入口组";
  if (mode === "exit") return "出口组";
  return group?.groupType === "tunnel" ? "隧道组" : "主机组";
}

export type RuleTargetGeo = {
  address: string;
  resolvedAddress: string;
  geoCountryCode: string;
  geoCountryName: string | null;
  geoRegion: string | null;
  geoEmoji: string | null;
  geoLatitudeMicro: number | null;
  geoLongitudeMicro: number | null;
};

export function normalizeAddressKey(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
}

export function ruleGlobeRouteHostIds(rule: any, tunnelById: Map<number, any>, forwardGroupById: Map<number, any>) {
  const group = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
  if (group && isForwardChainGroup(group)) {
    return [...(group.members || [])]
      .filter((member: any) => member.memberType !== "tunnel" && member.isEnabled !== false)
      .sort((a: any, b: any) => Number(a.priority) - Number(b.priority))
      .map((member: any) => Number(member.hostId || 0))
      .filter((id: number) => Number.isFinite(id) && id > 0);
  }
  if (rule.forwardType === "gost" && rule.tunnelId) {
    return getTunnelHopIds(tunnelById.get(Number(rule.tunnelId)));
  }
  if (group && group.groupType === "tunnel") {
    const member = [...(group.members || [])]
      .filter((item: any) => item.isEnabled !== false)
      .sort((a: any, b: any) => Number(a.priority) - Number(b.priority))
      .find((item: any) => Number(item.tunnelId || 0) > 0);
    const tunnel = member ? tunnelById.get(Number(member.tunnelId)) : null;
    const hopIds = getTunnelHopIds(tunnel);
    if (hopIds.length > 0) return hopIds;
  }
  if (group && group.groupType !== "tunnel") {
    const member = [...(group.members || [])]
      .filter((item: any) => item.memberType !== "tunnel" && item.isEnabled !== false)
      .sort((a: any, b: any) => Number(a.priority) - Number(b.priority))
      .find((item: any) => Number(item.hostId || 0) > 0);
    if (member) return [Number(member.hostId)];
  }
  return [Number(rule.hostId || 0)].filter((id) => id > 0);
}

export function routeModeOptionClass(active: boolean, disabled = false) {
  return segmentedOptionClassName(active, disabled, "gap-1.5 px-3");
}

export function normalizeRuleProtocol(value: unknown): RuleProtocol {
  return value === "tcp" || value === "udp" || value === "both" ? value : "both";
}

export function normalizeRuleForwardType(value: unknown): ForwardType {
  return FORWARD_TYPES.includes(value as ForwardType) ? (value as ForwardType) : "iptables";
}

export function getForwardGroupRuleForwardType(group: any | null | undefined, fallback: ForwardType | undefined = "iptables"): ForwardType {
  if (!group) return fallback || "iptables";
  if (!isForwardChainGroup(group) && String(group?.groupType || "") === "tunnel") return "gost";
  return normalizeRuleForwardType(group?.forwardType || fallback);
}

export function normalizePositiveRuleNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRuleTransferSeconds(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(3600, Math.max(10, Math.round(parsed))) : fallback;
}

export function normalizeProxyProtocolVersion(value: unknown): ProxyProtocolVersion {
  return Number(value) === 2 ? 2 : 1;
}

function exportRuleForTransfer(rule: any): RuleTransferFileRule {
  return {
    name: String(rule?.name || "导入规则"),
    forwardType: normalizeRuleForwardType(rule?.forwardType),
    protocol: normalizeRuleProtocol(rule?.protocol),
    sourcePort: Number(rule?.sourcePort || 0),
    targetIp: String(rule?.targetIp || ""),
    targetPort: Number(rule?.targetPort || 0),
    isEnabled: rule?.isEnabled !== false,
    telegramErrorNotifyEnabled: Boolean(rule?.telegramErrorNotifyEnabled),
    proxyProtocolReceive: Boolean(rule?.proxyProtocolReceive),
    proxyProtocolSend: Boolean(rule?.proxyProtocolSend),
    proxyProtocolExitReceive: Boolean(rule?.proxyProtocolExitReceive),
    proxyProtocolExitSend: Boolean(rule?.proxyProtocolExitSend),
    proxyProtocolVersion: normalizeProxyProtocolVersion(rule?.proxyProtocolVersion),
    tcpFastOpen: Boolean(rule?.tcpFastOpen),
    zeroCopy: Boolean(rule?.zeroCopy),
    udpOverTcp: Boolean(rule?.udpOverTcp),
    udpOverTcpPort: Number(rule?.udpOverTcpPort || 0),
    failoverEnabled: Boolean(rule?.failoverEnabled),
    failoverStrategy: normalizeFailoverStrategy(rule?.failoverStrategy),
    failoverTargets: parseFailoverTargets(rule?.failoverTargets),
    failoverSeconds: normalizeRuleTransferSeconds(rule?.failoverSeconds, 60),
    recoverSeconds: normalizeRuleTransferSeconds(rule?.recoverSeconds, 120),
    autoFailback: rule?.autoFailback !== false,
  };
}

export function downloadRuleTransferFiles(
  rules: readonly any[],
  scope: Record<string, unknown>,
  fileNameBase: string,
) {
  const chunks = chunkBatchItems(rules, RULE_TRANSFER_MAX_IMPORT_COUNT);
  chunks.forEach((chunk, index) => {
    const payload = {
      kind: RULE_TRANSFER_FILE_KIND,
      version: RULE_TRANSFER_FILE_VERSION,
      exportedAt: new Date().toISOString(),
      scope,
      rules: chunk.map(exportRuleForTransfer),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const partSuffix = chunks.length > 1 ? `-part-${index + 1}-of-${chunks.length}` : "";
    anchor.href = url;
    anchor.download = `${fileNameBase}${partSuffix}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  return chunks.length;
}

function RulesContent() {
  const confirmDialog = useConfirmDialog();
  const { user } = useAuth();
  // 自测、批量管理、延迟详情、连接监控这几个弹窗谁都能点开；3D 地球太大，不预热
  useWarmLazyChunks([loadSelfTestDialog, loadRuleBatchManageDialog, loadTcpingDetailBody, loadRuleConnectionsBody]);
  // 精简布局（compact.css 收的是组件打了 data-fx-help 的说明；规则框里这几行是条件渲染，由这个开关管）。
  const compactLayout = useCompactLayout();
  const uiTheme = useUiTheme();
  /*
    规则卡的转发器（见 RuleCard 前面的说明和 renderRuleCard 上面那段）：引用一直不变，调过去的是
    ruleCardUiRef 这一轮指向的最新函数。放在最前面，是因为下面的 renderRuleActions / renderRuleEnabledSwitch
    里「编辑」「开关」也经它调：卡片没重画时，按钮上挂着的闭包是旧的，经它一转就还是最新的状态。
  */
  const ruleCardUiRef = useRef<RuleCardUi | null>(null);
  const ruleCardUi = useMemo(() => createRuleCardUiDispatcher(ruleCardUiRef), []);
  const hideRuleFormHints = true;
  const [, setLocation] = useLocation();
  const search = useSearch();
  const isMobile = useIsMobile();
  // 手机 + 精简：搜索行收成分类条右边一枚图标（ListControls.tsx），点开才占一行
  const [phoneSearchOpen, setPhoneSearchOpen] = useState(false);
  const utils = trpc.useUtils();
  /*
    改了规则（目标、端口、启停……）之后，改之前测的那次延迟就不算数了：记下改的时刻，比它旧的探测不显示，
    等服务端给出改完之后测的那一次（2.3.559 起只有这一个时间戳，没有另存的探测缓存 / 上次状态）。
  */
  const [ruleEditedAt, setRuleEditedAt] = useState<ReadonlyMap<number, number>>(() => new Map());
  const invalidateRuleProbeStatuses = useCallback((ruleIds: Iterable<number> | undefined) => {
    if (!ruleIds) return;
    const ids = Array.from(new Set(Array.from(ruleIds)
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)));
    if (ids.length === 0) return;
    const now = Date.now();
    setRuleEditedAt((previous) => {
      const next = new Map(previous);
      ids.forEach((id) => next.set(id, now));
      return next;
    });
  }, []);
  const [secondaryQueriesReady, setSecondaryQueriesReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSecondaryQueriesReady(true), 300);
    return () => window.clearTimeout(timer);
  }, []);
  /*
    几张「选项」表（主机 / 隧道 / 转发组）的 staleTime 放到 30 秒：在页面间来回切时每次挂载都重取一遍，
    每条回来都把整页重画一次，手机上切进转发页之后要卡上一秒（2026-11-03 剖析）。挂着的时候照常轮询。
  */
  const { data: hosts, isFetched: hostsFetched } = trpc.hosts.options.useQuery(undefined, {
    // 规则的状态要跟着机器在不在线走：掉线了这一页得在半分钟内看得到。
    refetchInterval: pollingInterval("slow"),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  // 共享 TLS 入站（SNI 分流）：能挂规则的（usable）加上自己规则挂着的（只用来显示）。
  const { data: tlsInboundOptionsData } = trpc.tlsInbounds.listForUser.useQuery(undefined, {
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  // 没数据时也给同一个空数组：写成解构默认值 = [] 每次渲染都是新的，tlsInboundById 跟着每轮重建，规则卡的 memo 就全废了
  const tlsInboundOptions = tlsInboundOptionsData ?? EMPTY_TLS_INBOUND_OPTIONS;
  const tlsInboundById = useMemo(
    () => new Map((tlsInboundOptions as any[]).map((inbound: any) => [Number(inbound.id), inbound] as const)),
    [tlsInboundOptions],
  );
  // 规则页只拿隧道名称 / 归属来展示和选择，一分钟刷一次就够；隧道页和表单里就地新建隧道都会直接 invalidate。
  const { data: tunnels } = trpc.tunnels.options.useQuery(undefined, {
    refetchInterval: pollingInterval("minute"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const { data: users } = trpc.users.options.useQuery(undefined, {
    enabled: user?.role === "admin" && secondaryQueriesReady,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const { data: forwardGroups, isFetched: forwardGroupsFetched, isError: forwardGroupsError } = trpc.forwardGroups.options.useQuery(undefined, {
    refetchInterval: pollingInterval("normal"),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  // 协议开关、专属域名、Telegram 是否就绪：从 publicInfo 读，不再为这几项拉整份 getSettings。
  const panelFlags = usePanelFlags();
  const systemSettingsFetched = panelFlags.settled;
  /*
    规则专属域名此刻能不能用（设置 → DDNS 启用了服务商、填了后缀）。不能用时对话框里不显示
    「专属域名」开关：一个开了也没效果的开关只会让人以为哪里坏了。值照样随表单提交，功能
    之后开启时按规则上存的来。
  */
  const ruleEntryDomainAvailable = panelFlags.ruleEntryDomainActive;
  const { data: wallet, isLoading: walletLoading } = trpc.billing.me.useQuery(undefined, {
    enabled: user?.role !== "admin" && secondaryQueriesReady,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
  const { data: trafficBilling, isLoading: trafficBillingLoading } = trpc.trafficBilling.status.useQuery(undefined, {
    enabled: user?.role !== "admin" && secondaryQueriesReady,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  const [showDialog, setShowDialog] = useState(false);
  /*
    「＋ 新建线路」展开的那个迷你表单开着没有。

    建任何一条规则都要先有线路，而线路一直只能在别的页面建 —— 对话框里那句
    「暂无可用隧道，请先在链路管理中创建隧道」就是这条断路的原样记录：它告诉你
    走不通，但不给出路。跳出去再回来，填了一半的端口和目标地址也没了。
  */
  const [inlineLinkOpen, setInlineLinkOpen] = useState(false);

  /**
   * 「＋ 新建…」分成两半：按钮放在「使用隧道」那一行的右边，展开的迷你表单放在选择器底下。
   *
   * 按钮原来自己占一行，而且触屏上被全局规则顶到 44px 高 —— 手机上一个「＋ 新建隧道」
   * 连同间距就吃掉 52px。放进标签行之后不占高度；它本来就是「这一栏的另一种填法」，和标签站在一起
   * 正合适。
   *
   * 四种走法共用这一套，不按 routeMode 各写一遍 —— 「哪种转发要哪种线路」
   * 已经在 inlineLinkDraft 里写成了一张表。
   */
  const inlineLinkBlockedForTenant = (kind: NonNullable<ReturnType<typeof linkKindForRouteMode>>) =>
    linkKindRequiresAdmin(kind) && user?.role !== "admin";
  const renderInlineLinkTrigger = (routeMode: string) => {
    const kind = linkKindForRouteMode(routeMode);
    if (!kind || inlineLinkBlockedForTenant(kind) || inlineLinkOpen) return null;
    return (
      <Button type="button" variant="ghost" size="sm" className="fx-compact-touch h-7 gap-1 px-2 text-meta font-medium" onClick={() => setInlineLinkOpen(true)}>
        <Plus className="h-3.5 w-3.5" />
        {describeLinkKind(kind).label}
      </Button>
    );
  };
  const renderInlineLinkBody = (routeMode: string) => {
    const kind = linkKindForRouteMode(routeMode);
    if (!kind) return null;

    if (inlineLinkBlockedForTenant(kind)) {
      /*
        租户建不了转发组（服务端是 adminProcedure）。给他一个点下去必然 403 的
        按钮比不给更糟 —— 所以只在真的没线路可选时说一句该找谁。
      */
      const emptyForTenant = routeMode === "local"
        ? availablePortForwardGroups.length === 0
        : routeMode === "chain"
          ? availableForwardChainGroups.length === 0
          : availableFailoverForwardGroups.length === 0;
      if (!emptyForTenant) return null;
      return <p className="text-meta text-muted-foreground">还没有可用线路，需要管理员先分配。</p>;
    }

    if (inlineLinkOpen) {
      return (
        <InlineLinkCreator
          kind={kind}
          hosts={(hosts || []) as any}
          onCancel={() => setInlineLinkOpen(false)}
          onCreated={({ id, entryHostId }) => {
            setInlineLinkOpen(false);
            if (kind === "tunnel") {
              setForm((previous: any) => ({ ...previous, tunnelId: id, hostId: entryHostId ?? previous.hostId }));
            } else {
              setForm((previous: any) => ({ ...previous, forwardGroupId: id, hostId: null, tunnelId: null }));
            }
          }}
        />
      );
    }

    return null;
  };
  const [editingId, setEditingId] = useState<number | null>(null);
  // 编辑时规则原来的限额：提交只带改过的那几项（见 ruleLimitsChanges）。
  const [editingLimitBaseline, setEditingLimitBaseline] = useState<RuleCardRule | null>(null);
  const [editingOriginalProtocol, setEditingOriginalProtocol] = useState<RuleProtocol | null>(null);
  const [legacyLocalRuleEditId, setLegacyLocalRuleEditId] = useState<number | null>(null);
  // 主备策略面板开着的是哪条规则。存 id 不存整行：强制走之后列表会刷新，面板要跟着新数据走。
  const [policyRuleId, setPolicyRuleId] = useState<number | null>(null);
  const [showCopyDialog, setShowCopyDialog] = useState(false);
  const [form, setForm] = useState<RuleFormData>(defaultForm);
  const filterResourceStorageKey = ruleFilterStorageKey(RULE_FILTER_RESOURCE_STORAGE_KEY, user);
  const filterUserStorageKey = ruleFilterStorageKey(RULE_FILTER_USER_STORAGE_KEY, user);
  const ruleCategoryStorageKey = ruleFilterStorageKey(RULE_CATEGORY_STORAGE_KEY, user);
  const [filterResource, setFilterResource] = useState<RuleResourceFilter>(() => (
    normalizeRuleResourceFilter(getStoredString(filterResourceStorageKey, "all"))
  ));
  const [ruleResourceMenuOpen, setRuleResourceMenuOpen] = useState(false);
  const [ruleResourceMenuType, setRuleResourceMenuType] = useState<RuleTransferScopeType>(
    parseRuleResourceFilter(getStoredString(filterResourceStorageKey, "all")).type || "local",
  );
  const [filterUser, setFilterUser] = useState<string>(() => getStoredString(filterUserStorageKey, "self"));
  /*
    个人分组（上游 2.3.287，components/rules/PersonalRuleGroups.tsx）：筛选按账号记；组本身也只是自己的 ——
    管理员切到「所有用户」照样只看得到自己的组，筛出来的是所有人的规则里放进了自己组的那些。
  */
  const filterPersonalGroupStorageKey = ruleFilterStorageKey(RULE_FILTER_PERSONAL_GROUP_STORAGE_KEY, user);
  const [personalGroupFilter, setPersonalGroupFilter] = useState<number | null>(() => (
    parseStoredPersonalGroupFilter(getStoredString(filterPersonalGroupStorageKey, ""))
  ));
  const handlePersonalGroupFilterChange = useCallback((value: number | null) => {
    setPersonalGroupFilter(value);
    storeString(filterPersonalGroupStorageKey, value === null ? "" : String(value));
  }, [filterPersonalGroupStorageKey]);
  const [ruleSortByGroup, setRuleSortByGroup] = useState(() => getStoredString(RULE_SORT_BY_PERSONAL_GROUP_STORAGE_KEY, "") === "1");
  /*
    列设置按账号存（components/TableColumnSettings.tsx）。「列表显示分组列」原来记在本机：账号上还没存过列设置时，
    照本机那个值决定分组列显不显示；以后 ··· 菜单里那一项和「列设置」改的是同一份。
  */
  const [legacyRuleGroupColumnHidden] = useState(() => getStoredString(RULE_TABLE_GROUP_COLUMN_STORAGE_KEY, "1") === "0");
  const ruleColumnSettings = useTableColumnSettings(
    "rules",
    compactLayout ? RULE_TABLE_COLUMNS_COMPACT : RULE_TABLE_COLUMNS_STANDARD,
    legacyRuleGroupColumnHidden ? LEGACY_HIDDEN_GROUP_COLUMN_PREFERENCE : null,
  );
  const showRuleGroupColumn = ruleColumnSettings.columns.some((column) => column.key === "personalGroups" && column.visible);
  const [ruleGroupManagerOpen, setRuleGroupManagerOpen] = useState(false);
  const previousFilterIdentity = useRef(filterResourceStorageKey);
  useEffect(() => {
    if (previousFilterIdentity.current === filterResourceStorageKey) return;
    previousFilterIdentity.current = filterResourceStorageKey;
    const nextResource = normalizeRuleResourceFilter(getStoredString(filterResourceStorageKey, "all"));
    const nextUser = user?.role === "admin" ? getStoredString(filterUserStorageKey, "self") : "self";
    setFilterResource(nextResource);
    setRuleResourceMenuType(parseRuleResourceFilter(nextResource).type || "local");
    setFilterUser(nextUser);
    // 换了账号：上一个人的分组 id 在这个人这里没有意义
    setPersonalGroupFilter(parseStoredPersonalGroupFilter(getStoredString(filterPersonalGroupStorageKey, "")));
  }, [filterPersonalGroupStorageKey, filterResourceStorageKey, filterUserStorageKey, user?.role]);
  const [ruleSearchQuery, setRuleSearchQuery] = useState((() => {
    // 从别处（网络拓扑的详情面板）带着 ?q= 跳过来：先按它搜一遍。
    try {
      return new URLSearchParams(window.location.search).get("q") || "";
    } catch {
      return "";
    }
  }));
  const [ruleCategory, setRuleCategory] = useUrlTab<RuleCategory>({
    values: RULE_CATEGORIES,
    defaultValue: "all",
    storageKey: ruleCategoryStorageKey,
  });
  const [viewMode, setViewMode] = useState<RuleViewMode>(() => getStoredRuleViewMode());
  const [ruleCardSize, setRuleCardSize] = useState<RuleCardSize>(() => getStoredRuleCardSize());
  /*
    精简布局（桌面）：规则就是一张表（用户 2026-10-21 定的「条状」，照着老版本的表格样稿）；
    记住的卡片视图不动，回到标准布局还是卡片。3D 图照旧可切。手机上没有表，走两行的列表行（compact.css）。
  */
  const effectiveViewMode: RuleViewMode = isMobile ? "card" : compactLayout && viewMode !== "globe" ? "table" : viewMode;
  /*
    手机上原来被写死成 standard —— 而 standard 卡在 390px 的屏幕上有 850px 高，
    一屏连一条规则都放不下。紧凑卡本来就是为这种宽度做的，这里改成手机默认紧凑。
  */
  const effectiveRuleCardSize: RuleCardSize = isMobile ? "compact" : ruleCardSize;
  const [rulePageSize, setRulePageSize] = useState<RulePageSize>(() =>
    getStoredRulePageSize(getStoredRuleCardSize() === "compact" ? 24 : 12)
  );
  const [ruleGroupCollapsed, setRuleGroupCollapsed] = useState<RuleGroupCollapsedState>(() => getStoredRuleGroupCollapsed());
  const selectedRulesQuery = useMemo(() => {
    if (user?.role !== "admin") return undefined;
    const input: { userId?: number; scope?: "self" | "all"; hostId?: number } = {};
    if (filterUser === "all") {
      input.scope = "all";
    } else if (filterUser === "self") {
      input.userId = Number(user.id);
    } else {
      input.userId = Number(filterUser);
    }
    return Object.keys(input).length ? input : undefined;
  }, [filterUser, user?.id, user?.role]);
  const effectiveRulesQuery = selectedRulesQuery || undefined;
  /*
    分组栏那一份：自己的组（按顺序、带规则数）和「全部 / 未分组」的数字，数的范围跟着用户筛选走。
    卡片、表格的分组标签、筛选下拉、批量管理都用这一份，不各查各的。
  */
  const personalGroupsQuery = trpc.rules.personalGroups.useQuery(effectiveRulesQuery, {
    refetchInterval: pollingInterval("slow"),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
  });
  const personalGroups = personalGroupsQuery.data?.groups || EMPTY_PERSONAL_RULE_GROUPS;
  const personalGroupRankById = useMemo(
    () => new Map(personalGroups.map((group, index) => [Number(group.id), index])),
    [personalGroups],
  );
  // 选中的组没了（在别的标签页、别的设备上删了）：退回「全部」，不留一个永远是空的列表。
  useEffect(() => {
    if (!personalGroupsQuery.data || personalGroupsQuery.isPlaceholderData || !personalGroupFilter) return;
    if (!personalGroupsQuery.data.groups.some((group) => Number(group.id) === personalGroupFilter)) handlePersonalGroupFilterChange(null);
  }, [handlePersonalGroupFilterChange, personalGroupFilter, personalGroupsQuery.data, personalGroupsQuery.isPlaceholderData]);
  // 一个组都没有时「按分组排序」没有意义，照原来的顺序排
  const personalGroupSortActive = ruleSortByGroup && personalGroups.length > 0;
  const toggleRuleSortByGroup = () => {
    const next = !ruleSortByGroup;
    setRuleSortByGroup(next);
    storeString(RULE_SORT_BY_PERSONAL_GROUP_STORAGE_KEY, next ? "1" : "");
  };
  const toggleRuleGroupColumn = () => {
    const next = !showRuleGroupColumn;
    ruleColumnSettings.toggle("personalGroups", next);
    storeString(RULE_TABLE_GROUP_COLUMN_STORAGE_KEY, next ? "1" : "0");
  };
  const personalGroupNamesOf = (rule: { personalGroupIds?: number[] | null }) => {
    const ids = rule?.personalGroupIds;
    if (!ids || ids.length === 0) return "";
    const set = new Set(ids.map(Number));
    return personalGroups.filter((group) => set.has(Number(group.id))).map((group) => group.name).join(PERSONAL_GROUP_NAME_SEPARATOR);
  };
  /*
    管理员在「用户」筛选里选中了某个人：新建 / 复制 / 导入的规则归他（server/ruleOperationOwner.ts），
    端口提示、端口检查、随机端口也按他的权限和套餐端口段来。编辑不改归属。
  */
  const createOwnerUserId = user?.role === "admin" && filterUser !== "self" && filterUser !== "all"
    && Number(filterUser) > 0 && Number(filterUser) !== Number(user?.id)
    ? Number(filterUser)
    : undefined;
  const selectedScopeQueryEnabled = false as boolean;
  const [portStatus, setPortStatus] = useState<"idle" | "checking" | "available" | "used">("idle");
  /*
    「更多设置」默认收起。

    这几项（转发工具、异常提醒、限速等）都有能用的默认值 —— 不管它们
    也能把一条转发建出来。和真正要填的两项并排放着，等于让每个新手都当一次选择题：
    「转发工具这三个我该选哪个？」而正确答案通常是「别动」。

    收起不等于藏：折叠条上挂着当前值的摘要（见 advancedSummary），而且缺口指向
    里面的控件时会自动展开 —— 读到一句自己看不见的提示，比什么都不说更糟。
  */
  const [showAdvanced, setShowAdvanced] = useState(false);
  // 「出口」「线路组」也折起来（RuleFormCollapsible），默认收起，折叠条上写着现在的状态。
  const [showEgress, setShowEgress] = useState(false);
  const [showRouteGroup, setShowRouteGroup] = useState(false);
  const [portRangeError, setPortRangeError] = useState<string | null>(null);
  const [batchAddOpen, setBatchAddOpen] = useState(false);
  const latestPortCheckRef = useRef(0);
  const batchState = useRuleBatchManageState();
  const { exportScopeType, importScopeType, exportResourceId, setExportResourceId, importResourceId, setImportResourceId, importResourceSearch, importManualText } = batchState;
  const rulePageRequest = usePersistentPageRequest("forwardx.rules.page");
  const rulePageResource = parseRuleResourceFilter(filterResource);
  const rulePageFilterKey = [filterUser, filterResource, ruleCategory, ruleSearchQuery.trim(), rulePageSize, personalGroupFilter ?? "all", personalGroupSortActive ? "group" : "default"].join(":");
  const previousRulePageFilterKey = useRef(rulePageFilterKey);
  useEffect(() => {
    if (previousRulePageFilterKey.current === rulePageFilterKey) return;
    previousRulePageFilterKey.current = rulePageFilterKey;
    rulePageRequest.setPage(1);
  }, [rulePageFilterKey, rulePageRequest.setPage]);
  const rulePageQuery = trpc.rules.listPage.useQuery({
    ...(effectiveRulesQuery || {}),
    page: rulePageRequest.page,
    pageSize: rulePageSize,
    resourceType: rulePageResource.type,
    resourceId: rulePageResource.id,
    category: ruleCategory,
    search: ruleSearchQuery,
    personalGroupId: personalGroupFilter,
    sortBy: personalGroupSortActive ? "personalGroup" : undefined,
    // 顺带带回这一页的当日流量汇总：卡片要等它才画，单独再要一次就多一轮往返（见下面 dailyTrafficSummary 的 initialData）
    withTrafficSummary24h: true,
  }, {
    refetchInterval: pollingInterval("normal"),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const isRuleGlobeView = effectiveViewMode === "globe";
  const ruleMapQuery = trpc.rules.mapItems.useInfiniteQuery({
    ...(effectiveRulesQuery || {}),
    limit: 100,
    resourceType: rulePageResource.type,
    resourceId: rulePageResource.id,
    category: ruleCategory,
    search: ruleSearchQuery,
    personalGroupId: personalGroupFilter,
  }, {
    enabled: isRuleGlobeView,
    initialCursor: 0,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const mapRules = useMemo<any[]>(
    () => ruleMapQuery.data?.pages.flatMap((page) => page.items as any[]) || [],
    [ruleMapQuery.data?.pages],
  );
  useEffect(() => {
    if (!isRuleGlobeView || !ruleMapQuery.hasNextPage || ruleMapQuery.isFetchingNextPage) return;
    const loadNextPage = () => void ruleMapQuery.fetchNextPage();
    let idleHandle: number | undefined;
    let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | undefined;
    if ("requestIdleCallback" in window) {
      idleHandle = window.requestIdleCallback(loadNextPage, { timeout: 1_500 });
    } else {
      timeoutHandle = globalThis.setTimeout(loadNextPage, 120);
    }
    return () => {
      if (idleHandle !== undefined && "cancelIdleCallback" in window) window.cancelIdleCallback(idleHandle);
      if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
    };
  }, [isRuleGlobeView, ruleMapQuery.fetchNextPage, ruleMapQuery.hasNextPage, ruleMapQuery.isFetchingNextPage]);
  const needsFullRuleList = showCopyDialog;
  const fullRulesQuery = trpc.rules.list.useQuery(effectiveRulesQuery as any, {
    enabled: needsFullRuleList,
    refetchInterval: pollingInterval("normal"),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData: any) => previousData,
  });
  useEffect(() => {
    if (!showCopyDialog) return;
    void fullRulesQuery.refetch();
  }, [showCopyDialog]);
  const {
    data: ruleListSummary,
    isLoading: ruleListSummaryInitialLoading,
    isPlaceholderData: ruleListSummaryPlaceholder,
  } = trpc.rules.listSummary.useQuery({
    ...(effectiveRulesQuery || {}),
    resourceType: rulePageResource.type,
    resourceId: rulePageResource.id,
    category: ruleCategory,
    search: ruleSearchQuery,
    personalGroupId: personalGroupFilter,
  }, {
    enabled: secondaryQueriesReady,
    // 页头的统计数字：30 秒一轮；增删改、启停后各自 invalidate，不等这一轮。
    refetchInterval: pollingInterval("slow"),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const ruleListSummaryLoading = ruleListSummaryInitialLoading || ruleListSummaryPlaceholder;
  const [stableRuleListSummary, setStableRuleListSummary] = useState<any | null>(null);
  useEffect(() => {
    if (!ruleListSummary || ruleListSummaryPlaceholder) return;
    setStableRuleListSummary(ruleListSummary);
  }, [ruleListSummary, ruleListSummaryPlaceholder]);
  // The batch-management dialog may load a separate full rule list, but it
  // must never replace the paged list rendered underneath the dialog.
  /*
    规则行里有 Date（createdAt / updatedAt / 到期时间……），React Query 的结构共享认不出来：每轮询一次
    每条规则都成了新对象，memo 的规则卡一张都比不上。内容没变的沿用上一轮的对象（lib/stableRows.ts）。
  */
  const rules = useStableRows((isRuleGlobeView ? mapRules : rulePageQuery.data?.items) as any[] | undefined, ruleRowKey);
  /*
    规则卡上直接画线路组的迷你链（在走哪条、哪段慢）：一次拿全部线路组的状态，十秒一刷。
    只有列表里有线路组规则时才拉；没有就不花这一次查询。
  */
  const anyRouteGroupRule = useMemo(() => (rules || []).some((rule: any) => !!rule?.failoverEnabled), [rules]);
  const routeBoardQuery = trpc.rules.routeBoard.useQuery(user?.role === "admin" ? { scope: "all" } : undefined, {
    enabled: anyRouteGroupRule,
    refetchInterval: pollingInterval("log"),
    staleTime: 5_000,
    placeholderData: (previous: any) => previous,
  });
  const routeBoardByRule = useMemo(() => new Map<number, any>(((routeBoardQuery.data || []) as any[]).map((item) => [Number(item.ruleId), item.status])), [routeBoardQuery.data]);
  const isLoading = isRuleGlobeView
    ? ruleMapQuery.isLoading
    : rulePageQuery.isLoading;
  const ruleListDataReady = isRuleGlobeView
    ? ruleMapQuery.data !== undefined && !ruleMapQuery.isPlaceholderData
    : rulePageQuery.data !== undefined && !rulePageQuery.isPlaceholderData;
  const selectedScopeRules = undefined;

  const walletBalanceKnown = wallet?.balanceCents !== undefined && wallet?.balanceCents !== null;
  const manuallyPaused = (user as any)?.forwardAccessPauseReason === "manual";
  const hasTrafficBillingBalance = !manuallyPaused && !!trafficBilling?.enabled && !!trafficBilling?.hasUsableResources && walletBalanceKnown && Number(wallet?.balanceCents || 0) > 0;
  // 权限检查：管理员、有 canAddRules 权限，或本地已确认流量计费余额可用
  const canAdd = user?.role === "admin" || user?.canAddRules === true || hasTrafficBillingBalance;
  const rulePermissionLoading = user?.role !== "admin" && user?.canAddRules !== true && (!secondaryQueriesReady || walletLoading || trafficBillingLoading);

  const createMutation = trpc.rules.create.useMutation({
    onSuccess: (data) => {
      utils.rules.list.invalidate();
      utils.rules.listPage.invalidate();
      utils.rules.mapItems.invalidate();
      utils.rules.listSummary.invalidate();
      setShowDialog(false);
      resetForm();
      const msg = data.sourcePort ? `规则已创建，源端口 ${data.sourcePort}` : "规则已创建";
      toast.success(msg);
      /**
       * 面板替人多做了一步，就得说出来。
       *
       * 目标正好是他自己的落地节点时会自动加进订阅 —— 不说的话，他下次在客户端里
       * 看到一条没印象的线路，只会以为是别处出了错。
       */
      if ((data as any).autoBoundProxyNodeName) {
        utils.proxySubscriptions.preview.invalidate();
        void utils.proxySubscriptions.targetMismatchRuleIds.invalidate();
        utils.proxySubscriptions.listNodes.invalidate();
        toast.info(`已顺手加进订阅：${(data as any).autoBoundProxyNodeName}`, {
          description: "目标正好是你的落地节点。不想要的话，去订阅管理的「预览订阅」里关掉。",
        });
      }
    },
    onError: (err) => toast.error(err.message || "创建失败"),
  });

  /*
    主备策略面板里的「强制走 / 交回自动」。

    不复用编辑框那个 updateMutation：它成功后会关编辑框、清表单、说「规则已更新」。
    这里只传钉子那两个字段 —— 服务端会整份重新归一化主备配置，并当场推给 Agent
    （这两件事上一版都没有：只传钉子会直接报错，改了也要等五分钟一次的对账）。
  */
  const pinMutation = trpc.rules.update.useMutation({
    onSuccess: (_data, variables) => {
      utils.rules.list.invalidate();
      utils.rules.listPage.invalidate();
      utils.rules.mapItems.invalidate();
      // 只说做了什么，不说「已生效」：机器离线时要等它连上才会照做。
      toast.success(variables.failoverPinnedIndex === null || variables.failoverPinnedIndex === undefined
        ? "已交回自动"
        : "已手动指定：调度这条线路的机器收到就切过去");
    },
    onError: (error) => toast.error(error.message || "操作失败"),
  });
  const routeLandingCredentialCheck = trpc.rules.routeLandingCredentialCheck.useMutation();
  const updateMutation = trpc.rules.update.useMutation({
    onSuccess: (data, variables) => {
      invalidateRuleProbeStatuses([Number(variables.id)]);
      utils.rules.list.invalidate();
      utils.rules.listPage.invalidate();
      utils.rules.mapItems.invalidate();
      utils.rules.listSummary.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("规则已更新");
      /**
       * 改目标会连带改动订阅里那条线路 —— 这种事不能悄悄发生。
       *
       * 解绑那一条尤其要说：不说的话，客户端里一条线路就这么没了，而他只改了个目标。
       */
      const binding = (data as any)?.proxyNodeBinding;
      if (binding) {
        utils.proxySubscriptions.preview.invalidate();
        void utils.proxySubscriptions.targetMismatchRuleIds.invalidate();
        utils.proxySubscriptions.listNodes.invalidate();
        if (binding.kind === "released") {
          toast.info(`已从订阅里摘掉「${binding.previousName}」这条线路`, {
            description: "目标换了，不再通向那个落地节点。留着的话客户端会拿着它的凭据去连新目标。",
          });
        } else if (binding.kind === "rebound") {
          toast.info(`订阅里这条线路已改成「${binding.name}」`, {
            description: `新目标正好是它。原来绑的是「${binding.previousName}」。`,
          });
        } else if (binding.kind === "bound") {
          toast.info(`已顺手加进订阅：${binding.name}`, {
            description: "新目标正好是你的落地节点。不想要的话，去订阅管理的「订阅内容」里关掉。",
          });
        }
      }
    },
    onError: (err) => toast.error(err.message || "更新失败"),
  });

  const deleteMutation = trpc.rules.delete.useMutation({
    onSuccess: (_data, variables) => {
      invalidateRuleProbeStatuses([Number(variables.id)]);
      utils.rules.list.invalidate();
      utils.rules.listPage.invalidate();
      utils.rules.mapItems.invalidate();
      utils.rules.listSummary.invalidate();
      // 删掉的规则的分组关系服务端已经清了，分组上的数字跟着刷新
      void utils.rules.personalGroups.invalidate();
      toast.success("规则已删除");
    },
    onError: (err) => toast.error(err.message || "删除失败"),
  });

  const reorderRulesMutation = trpc.rules.reorder.useMutation({
    onError: (err) => toast.error(err.message || "排序保存失败"),
  });
  const ruleReorderPending = reorderRulesMutation.isPending;

  // tab：打开时先停在哪一页（表格里点「详细」直接看延迟记录）
  const [selfTestRule, setSelfTestRule] = useState<{ id: number; name: string; isForwardChain?: boolean; chainKernel?: boolean; probeMethod?: "tcping" | "ping"; tab?: string } | null>(null);

  const toggleMutation = trpc.rules.toggle.useMutation({
    onSuccess: async (_data, variables) => {
      invalidateRuleProbeStatuses([Number(variables.id)]);
      await Promise.all([
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
        utils.rules.mapItems.invalidate(),
        utils.rules.listSummary.invalidate(),
        utils.auth.me.invalidate(),
        utils.billing.me.invalidate(),
      ]);
    },
  });

  const isTrafficBillingRule = (rule: any) => {
    if (!trafficBilling?.enabled) return false;
    const resourceIds = trafficBilling.usableResourceIds || { hostIds: [], tunnelIds: [], forwardGroupIds: [] };
    if (rule.forwardGroupId) {
      return (resourceIds.forwardGroupIds || []).map(Number).includes(Number(rule.forwardGroupId));
    }
    if (rule.tunnelId) {
      return (resourceIds.tunnelIds || []).map(Number).includes(Number(rule.tunnelId));
    }
    return (resourceIds.hostIds || []).map(Number).includes(Number(rule.hostId));
  };

  const toggleRuleEnabled = async (rule: any, checked: boolean) => {
    const id = Number(rule?.id || 0);
    if (!id) throw new Error("规则不存在");
    if (
      checked &&
      user?.role !== "admin" &&
      trafficBilling?.enabled &&
      isTrafficBillingRule(rule) &&
      walletBalanceKnown &&
      Number(wallet?.balanceCents || 0) <= 0
    ) {
      throw new Error("流量计费余额不足，请充值后再启用规则");
    }
    await toggleMutation.mutateAsync({ id, isEnabled: checked });
  };

  const renderRuleEnabledSwitch = (rule: any) => {
    const supported = isRuleSupported(rule);
    const resourceAccessAllowed = rule.resourceAccessAllowed !== false;
    const enabled = resourceAccessAllowed && !!rule.isEnabled;
    // 管理员管理的规则（替用户建的 / 设了限额的）：主人只能看，开关也是只读的。
    if (user?.role !== "admin" && isAdminManagedRule(rule)) {
      return (
        <span className="inline-flex shrink-0" title={ADMIN_MANAGED_RULE_MESSAGE}>
          <Switch checked={enabled && !normalizeRuleLimitReason(rule.ruleLimitReason)} disabled className="switch-compact" aria-label={`规则 ${rule.name || ""} 由管理员管理，仅可查看`} />
        </span>
      );
    }
    const title = enabled ? "关闭后该转发规则将停止下发和转发" : "开启后该转发规则将重新下发并恢复转发";
    const content = supported && resourceAccessAllowed ? (
      <OptimisticSwitch
        checked={enabled}
        onCheckedChangeAsync={(checked) => ruleCardUi.toggleRuleEnabled(rule, checked)}
        onToggleSuccess={(checked) => toast.success(checked ? "规则已开启" : "规则已关闭")}
        onToggleError={(error) => toast.error(error instanceof Error ? error.message : "切换规则状态失败")}
        className="switch-compact"
        title={title}
        aria-label={`${enabled ? "停用" : "启用"}转发规则 ${rule.name || ""}`}
      />
    ) : (
      <span className="inline-flex shrink-0" title={resourceAccessAllowed ? unsupportedProtocolTitle : revokedResourceTitle}>
        <Switch checked={false} disabled className="switch-compact" aria-label={resourceAccessAllowed ? "当前协议不支持，规则已停用" : "资源授权已失效，规则已停用"} />
      </span>
    );
    return supported && resourceAccessAllowed ? content : renderUnsupportedHint(content, resourceAccessAllowed ? unsupportedProtocolTitle : revokedResourceTitle);
  };

  const isLegacyLocalRuleEdit = editingId !== null && legacyLocalRuleEditId === editingId;

  // 获取当前选中主机的端口区间
  const useRuleProtocolSupportResult = useRuleProtocolSupport({ form, isLegacyLocalRuleEdit, hosts, panelFlags, tunnels });
  const { isRuleSupported, isProtocolEnabled, getTunnelProtocolKey, supportedTunnels, availableTunnels, aggregateTunnels, plainTunnels, selectedTunnel, selectedTunnelIsAggregate, routeTab, selectedHost, nginxTunnelEnabled, forwardTypeDisplayLabel, getRuleProtocolKey, protocolUnsupportedLabel } = useRuleProtocolSupportResult;
  // 允许哪些端口由服务端说了算，界面只负责显示。
  //
  // 这里原来自己照着算了一份：主机策略直接和隧道范围求交。服务端用的是
  // combineHostPortPolicyWithRange —— 隧道范围恰好等于主机范围时，它会保留
  // 主机的完整策略，而求交会把主机白名单里那些额外端口吃掉。实测：主机
  // 22600-22600 + 白名单 23001、隧道 22600-22600，端口 23001 服务端放行、
  // 界面拒绝，而且界面**拒绝时根本不会去问服务端**，用户就被硬拦在一个
  // 自己有权用的端口上。界面这份还完全不知道套餐端口段的存在。
  // isForwardGroupRouteMode 在下面才声明，这里照抄它的判定式（两个变量都已经
  // 在上面了），避免为了一个查询把一大段 useMemo 往上搬。
  const portPolicyForGroup = isForwardGroupBackedRouteModeValue(form.routeMode, form.forwardGroupId)
    || (isLegacyLocalRuleEdit && form.routeMode === "local");
  const entryPortPolicyQuery = trpc.rules.entryPortPolicy.useQuery(
    {
      ...(portPolicyForGroup
        ? { forwardGroupId: Number(form.forwardGroupId) }
        : {
          hostId: Number(form.hostId),
          tunnelId: form.routeMode === "tunnel" ? form.tunnelId ?? null : null,
        }),
      userId: editingId ? undefined : createOwnerUserId,
    },
    {
      enabled: portPolicyForGroup
        ? Number(form.forwardGroupId) > 0
        : Number(form.hostId) > 0,
      staleTime: 30_000,
    },
  );
  const selectedEntryPortPolicy = useMemo(
    // 还没拿到就先当作不限制：真正的把关在服务端，界面不该凭猜测拦人。
    () => entryPortPolicyQuery.data?.policy ?? portPolicyFrom(null),
    [entryPortPolicyQuery.data],
  );
  const sourcePortRangeText = useMemo(() => describePortPolicy(selectedEntryPortPolicy), [selectedEntryPortPolicy]);
  const portStatusHint = useMemo(() => {
    if (portStatus === "used") {
      return {
        type: "used" as const,
        text: portRangeError && /范围/.test(portRangeError) ? "超范围" : "不可用",
        title: portRangeError || "端口已被占用",
      };
    }
    if (portStatus === "available") {
      return {
        type: "available" as const,
        text: "可用",
        title: `允许端口范围: ${sourcePortRangeText}`,
      };
    }
    return null;
  }, [portRangeError, portStatus, sourcePortRangeText]);
  const tunnelById = useMemo(() => {
    const map = new Map<number, any>();
    (tunnels || []).forEach((tunnel: any) => map.set(Number(tunnel.id), tunnel));
    return map;
  }, [tunnels]);
  /**
   * 这条转发在不在客户端订阅里。
   *
   * 订阅和转发是同一件事的两面，可是这一页原来完全不提订阅：一条转发被订阅引用着，
   * 在这里看不出来 —— 改目标、停用、删掉，都会让别人客户端里的那条线路跟着变，
   * 而操作的人毫不知情。所以在行上标一个字，并说清楚点它会去哪。
   */
  const subscriptionPermission = trpc.proxySubscriptions.permission.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const subscriptionAllowed = !!subscriptionPermission.data?.allowed;
  const proxyNodesQuery = trpc.proxySubscriptions.listNodes.useQuery(undefined, {
    enabled: subscriptionAllowed,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  /** 规则表单「选我的节点」：自己的、启用着、有地址和端口的节点。 */
  // 落地池的池节点带着池（2.3.500）：目标选它就是在池里几台分（server/landingRouteTarget.ts）
  const targetNodeOptions = useMemo(() => routeNodeOptionsOf((proxyNodesQuery.data || []) as any[]), [proxyNodesQuery.data]);
  const proxyNodeNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const node of (proxyNodesQuery.data || []) as any[]) {
      map.set(Number(node.id), String(node.name || ""));
    }
    return map;
  }, [proxyNodesQuery.data]);
  /**
   * 绑定已经对不上的那些转发。
   *
   * 判断放在服务端（它才有全部规则和主机地址，能认出「串两跳」这种正常拓扑不误报），
   * 这里只把结论标到行上 —— 要改目标或者换节点的人在这一页，提示也该在这一页。
   */
  // 只要规则 id（targetMismatchRuleIds），不拉整份订阅预览；它单独发请求（main.tsx 的 isolatedQueryPaths），不拖同批的流量汇总。
  // 订阅页改了节点也会让这个结论变：每次进规则页都后台刷一次（不挡首屏，staleTime 0），不用到处去失效它。
  const targetMismatchQuery = trpc.proxySubscriptions.targetMismatchRuleIds.useQuery(undefined, {
    enabled: subscriptionAllowed,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const driftedRuleIds = useMemo(() => new Set<number>((targetMismatchQuery.data || []).map(Number)), [targetMismatchQuery.data]);
  const hostById = useMemo(() => {
    const map = new Map<number, any>();
    (hosts || []).forEach((host: any) => map.set(Number(host.id), host));
    return map;
  }, [hosts]);
  const userById = useMemo(() => {
    const map = new Map<number, any>();
    (users || []).forEach((item: any) => map.set(Number(item.id), item));
    return map;
  }, [users]);
  const ruleOperationOwner = createOwnerUserId ? userById.get(createOwnerUserId) : null;
  const ruleOperationOwnerLabel = ruleOperationOwner?.name || ruleOperationOwner?.username || (createOwnerUserId ? `用户 #${createOwnerUserId}` : "");
  const forwardGroupById = useMemo(() => {
    const map = new Map<number, any>();
    (forwardGroups || []).forEach((group: any) => map.set(Number(group.id), group));
    // Ordinary users receive ACL-filtered supporting entry groups nested on
    // their chain. Merge those display-only records into the lookup without
    // adding them to selectable resource lists.
    (forwardGroups || []).forEach((group: any) => {
      const entryGroup = group?.entryGroup;
      const entryGroupId = Number(entryGroup?.id || group?.entryGroupId || 0);
      if (entryGroupId > 0 && entryGroup && !map.has(entryGroupId)) map.set(entryGroupId, entryGroup);
    });
    return map;
  }, [forwardGroups]);
  const linkAvailabilityIndex = useMemo(() => buildLinkAvailabilityIndex({
    hosts,
    tunnels,
    groups: forwardGroups,
    isTunnelSupported: (tunnel: any) => isProtocolEnabled(getTunnelProtocolKey(tunnel)),
  }), [forwardGroups, getTunnelProtocolKey, hosts, isProtocolEnabled, tunnels]);
  const tunnelAvailabilityById = linkAvailabilityIndex.tunnelAvailabilityById;
  const groupAvailabilityById = linkAvailabilityIndex.groupAvailabilityById;
  const getRuleEntryHostIdForSort = useCallback((rule: any) => {
    const group = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    if (group) {
      const member = [...(group.members || [])]
        .filter((item: any) => item.isEnabled !== false)
        .sort((a: any, b: any) => Number(a.priority) - Number(b.priority))
        .find((item: any) => Number(item.hostId || 0) > 0 || Number(item.tunnelId || 0) > 0);
      if (Number(member?.hostId || 0) > 0) return Number(member.hostId);
      if (Number(member?.tunnelId || 0) > 0) {
        const tunnel = tunnelById.get(Number(member.tunnelId));
        if (Number(tunnel?.entryHostId || 0) > 0) return Number(tunnel.entryHostId);
      }
    }
    const tunnel = rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    if (Number(tunnel?.entryHostId || 0) > 0) return Number(tunnel.entryHostId);
    return Number(rule.hostId || 0);
  }, [forwardGroupById, tunnelById]);
  const availableForwardGroups = useMemo(
    // 挂了入口组的端口转发（2.3.438 起）自己没有成员，入口是入口组里的主机
    () => (forwardGroups || []).filter((group: any) => isSelectableForwardRuleGroup(group) && group.isEnabled
      && ((group.members || []).length > 0 || (forwardGroupModeOf(group) === "port" && Number(group.entryGroupId || 0) > 0))),
    [forwardGroups]
  );
  const availablePortForwardGroups = useMemo(
    () => availableForwardGroups.filter((group: any) => forwardGroupModeOf(group) === "port"),
    [availableForwardGroups]
  );
  const availableForwardChainGroups = useMemo(
    () => availableForwardGroups.filter((group: any) => isForwardChainGroup(group)),
    [availableForwardGroups]
  );
  const useRuleTransferResourceListsResult = useRuleTransferResourceLists({ availableForwardGroups, forwardGroups, tunnels, filterResource, setFilterResource, filterResourceStorageKey, availablePortForwardGroups, supportedTunnels, availableForwardChainGroups, exportScopeType, importScopeType });
  const { availableFailoverForwardGroups, exportResources, importResources, getRuleFilterResources } = useRuleTransferResourceListsResult;
  useEffect(() => {
    const firstId = exportResources[0]?.id;
    if (!firstId) {
      if (exportResourceId) setExportResourceId("");
      return;
    }
    if (!exportResources.some((item: any) => String(item.id) === exportResourceId)) {
      setExportResourceId(String(firstId));
    }
  }, [exportResourceId, exportResources]);
  useEffect(() => {
    const firstId = importResources[0]?.id;
    if (!firstId) {
      if (importResourceId) setImportResourceId("");
      return;
    }
    if (!importResources.some((item: any) => String(item.id) === importResourceId)) {
      setImportResourceId(String(firstId));
    }
  }, [importResourceId, importResources]);
  const selectedForwardGroup = useMemo(() => {
    if (!form.forwardGroupId) return null;
    return forwardGroupById.get(Number(form.forwardGroupId)) || null;
  }, [form.forwardGroupId, forwardGroupById]);
  const routeModeLocked = false;
  const isForwardGroupRouteMode = isForwardGroupBackedRouteModeValue(form.routeMode, form.forwardGroupId)
    || (isLegacyLocalRuleEdit && form.routeMode === "local");
  const useRuleCreateCapabilitiesResult = useRuleCreateCapabilities({ form, isForwardGroupRouteMode, selectedForwardGroup, user, isProtocolEnabled, trafficBilling, hosts, availablePortForwardGroups, hasTrafficBillingBalance, tlsInboundOptions, availableTunnels, availableForwardChainGroups, availableFailoverForwardGroups, tlsInboundById, supportedTunnels });
  const { canUseLocalForward, canUseGost, canUseSavedLocalForward, availableTrafficBillingHosts, usableForwardTypes, canUseBillingHostLocalForward, canUseForwardChain, canUseFailoverGroup, canUseSniInbound, usableTlsInbounds, effectiveRouteForwardType, isSniEntryMode, sniChoices, selectedTlsInbound, sniRouteKind, trafficBillingHostIds, trafficBillingTunnelIds, trafficBillingForwardGroupIds, sniAvailableForTab, canCreateRule } = useRuleCreateCapabilitiesResult;

  /*
    表单的打开 / 切页签这几个函数原来写在上面（创建 / 更新 mutation 之后），但它们读的 canUseLocalForward、
    availablePortForwardGroups、selectedTunnel 这些值都要到这里才算出来，以前靠闭包晚绑定才能用。
    挪到依赖之后，抽成 hook 时才不会在声明前取值。
  */
  const useRuleFormOpenersResult = useRuleFormOpeners({ form, setInlineLinkOpen, canUseLocalForward, canUseGost, canUseSavedLocalForward, availablePortForwardGroups, availableForwardChainGroups, availableFailoverForwardGroups, aggregateTunnels, plainTunnels, selectedTunnel, availableTrafficBillingHosts, selectedForwardGroup, usableForwardTypes, latestPortCheckRef, setPortStatus, setPortRangeError, setForm, selectedTunnelIsAggregate, setEditingId, setEditingLimitBaseline, setEditingOriginalProtocol, setLegacyLocalRuleEditId, canUseBillingHostLocalForward, supportedTunnels, canUseForwardChain, canUseFailoverGroup, setShowDialog, canUseSniInbound, usableTlsInbounds, forwardGroups, setShowAdvanced, setShowEgress, setShowRouteGroup });
  const { resetForm, openCreate, openEdit, setRouteMode, selectRouteTab } = useRuleFormOpenersResult;


  /*
    创建按钮为什么点不了 —— 一处算，到处用（判断在 shared/forwardRuleForm）。

    原来这个判断只长在按钮的 disabled 上，于是按钮灰着但不说缺什么：用户盯着
    一张看起来填满了的表，无从下手。（曾经更糟：有一版把必填的「规则名称」
    标成了「选填」，照着标签留空的人只会得到一个灰按钮和零解释。）

    所以这里返回「还差什么」的那句话本身，null 表示可以提交。按钮和提示语读
    同一个值，不可能再各说各话 —— 谁改了判断，提示会跟着变。

    顺序按用户填表的顺序来（线路 → 源端口 → 目标 → 名称），只报第一个缺口：
    一次列三条缺失反而没人读。
  */
  /*
    端口段（shared/portRange.ts）：入口写成 20000-20100 时，这条规则能不能用段、为什么不能，
    和服务端保存时同一句话。用户态转发不让选，而不是替他开几百个监听。
  */
  const formSourcePortEnd = portSpanEndFromText(form.sourcePortText);
  const formTargetPortEnd = portSpanEndFromText(form.targetPortText);
  const formIsPortRange = form.sourcePort > 0 && formSourcePortEnd > form.sourcePort;
  // 批量添加建的是直连主机的规则：管理员能挑所有主机，别人只有按量计费的主机。
  const batchAddHosts = useMemo(() => (user?.role === "admin" ? (hosts || []) : availableTrafficBillingHosts), [user?.role, hosts, availableTrafficBillingHosts]);
  const portRangeBlocker = useMemo(() => (formIsPortRange
    ? portRangeUnsupportedReason({
      forwardType: effectiveRouteForwardType,
      tunnelId: form.routeMode === "tunnel" ? form.tunnelId || 1 : null,
      forwardGroupId: isForwardGroupRouteMode ? form.forwardGroupId || 1 : null,
      // 「端口转发」资源（port 模式的转发组）可以用端口段；转发链、主备转发组不行。
      // 「端口转发」这一栏选的都是 port 模式的资源（还没选、或老规则迁移时也按它算）。
      portForwardGroup: isForwardGroupRouteMode && (form.routeMode === "local" || forwardGroupModeOf(selectedForwardGroup) === "port"),
      tlsInboundId: form.entryMode === "sni" ? 1 : null,
      failoverEnabled: form.failoverEnabled,
      egressType: form.egress.egressType,
    })
    : null), [formIsPortRange, effectiveRouteForwardType, form.routeMode, form.tunnelId, form.forwardGroupId, form.entryMode, form.failoverEnabled, form.egress.egressType, isForwardGroupRouteMode, selectedForwardGroup]);
  const ruleFormContext = useMemo<ForwardRuleFormContext>(() => ({
    editing: editingId !== null,
    usesForwardGroup: isForwardGroupRouteMode,
    canUseLocalForward,
    canUseForwardChain,
    canUseFailoverGroup,
    canUseGost,
    portStatus,
    portRangeBlocker,
  }), [
    editingId, isForwardGroupRouteMode, canUseLocalForward,
    canUseForwardChain, canUseFailoverGroup, canUseGost, portStatus, portRangeBlocker,
  ]);
  /*
    Shadowsocks 出口（shared/ssEgress.ts）：只在「端口转发」这条路上出现（直连主机 / gost 的端口转发资源）。
    选了出口，协议固定 TCP、线路组关掉；直连主机的规则转发工具切到 gost。端口转发资源的工具由资源决定，
    不是 gost 也能选：这一条规则下发时改用 gost 跑（server/ssEgress.ts 的 ruleEgressRuntimeView），库里不变。
  */
  /*
    走隧道（含叠加）也能接出口：SS 客户端跑在隧道的出口机上（入口 → 隧道 → 出口机 → SS 落地 → 目标），
    Nginx 隧道不行。这时「谁去连落地」是隧道出口机：能力、不能当落地的主机都按它算。
  */
  const egressViaTunnel = form.routeMode === "tunnel" && !!selectedTunnel && ssEgressTunnelModeSupported(selectedTunnel.mode);
  const egressSectionVisible = (form.routeMode === "local" || egressViaTunnel) && !isSniEntryMode;
  const egressActive = egressSectionVisible && form.egress.egressType !== "none";
  const egressEntryHostIds = useMemo(() => {
    const ids = new Set<number>();
    if (egressViaTunnel) {
      const hops = Array.isArray(selectedTunnel?.hopHostIds) ? selectedTunnel.hopHostIds : [];
      for (const id of [selectedTunnel?.exitHostId, hops.length >= 2 ? hops[hops.length - 1] : 0]) {
        if (Number(id || 0) > 0) ids.add(Number(id));
      }
      return Array.from(ids);
    }
    if (form.hostId) ids.add(Number(form.hostId));
    for (const member of (selectedForwardGroup?.members || []) as any[]) {
      if (Number(member?.hostId || 0) > 0) ids.add(Number(member.hostId));
    }
    return Array.from(ids);
  }, [egressViaTunnel, selectedTunnel, form.hostId, selectedForwardGroup]);
  const egressBlockedReason = useMemo<string | null>(() => {
    if (!egressSectionVisible) return null;
    if (egressViaTunnel) return null;
    if (isLegacyLocalRuleEdit) return "旧版端口转发规则请先迁移到新版端口转发，再设置出口。";
    // 端口转发资源不是 gost 也能开出口：这一条规则下发时改用 gost（见 egressRuntimeNote）。
    if (isForwardGroupRouteMode) return null;
    if (!usableForwardTypes.includes("gost")) return "出口需要 gost 转发，当前账号不能用 gost。";
    return null;
  }, [egressSectionVisible, egressViaTunnel, isLegacyLocalRuleEdit, isForwardGroupRouteMode, selectedForwardGroup, effectiveRouteForwardType, usableForwardTypes]);
  const egressRuntimeNote = useMemo<string | null>(() => {
    if (!isForwardGroupRouteMode || !selectedForwardGroup) return null;
    if (!ruleEgressSwitchesForwardType(form.egress.egressType, effectiveRouteForwardType)) return null;
    const label = FORWARD_TYPE_LABELS[effectiveRouteForwardType] || effectiveRouteForwardType;
    return `这个端口转发用的是 ${label}，${label} 不会 Shadowsocks / VLESS：开了出口的这一条规则改用 gost 转发，端口、计数、限速照旧；其它规则不受影响，改回「直接连接」就恢复成 ${label}。`;
  }, [isForwardGroupRouteMode, selectedForwardGroup, form.egress.egressType, effectiveRouteForwardType]);
  const egressCapabilities = useEgressEntryCapabilities(egressEntryHostIds, egressActive, egressViaTunnel ? "隧道出口机" : "入口主机");
  const egressBlocker = useMemo<string | null>(() => {
    if (!egressActive) return null;
    if (egressBlockedReason) return egressBlockedReason;
    const shapeError = ruleEgressShapeError({
      egressType: form.egress.egressType,
      forwardType: effectiveRouteForwardType,
      protocol: form.protocol,
      egressUdp: form.egress.egressUdp,
      forwardGroupMode: isForwardGroupRouteMode ? forwardGroupModeOf(selectedForwardGroup) : null,
      failoverEnabled: false,
      // VLESS Reality 出口不接隧道（shared/ssEgress.ts）：走隧道时把隧道带上，让形态检查说清楚。
      tunnelId: egressViaTunnel ? form.tunnelId : null,
      tunnelMode: egressViaTunnel ? selectedTunnel?.mode : null,
    });
    if (shapeError) return shapeError;
    const egressVless = ruleEgressProtocolOf(form.egress.egressType) === "vless";
    if (ruleEgressUsesInbound(form.egress.egressType) && !form.egress.egressInboundId) return `请选择落地主机上的${egressVless ? " VLESS Reality " : " Shadowsocks "}入站`;
    if (ruleEgressUsesLink(form.egress.egressType) && !form.egress.egressLink.trim() && !form.egress.egressLinkMasked) return "请粘贴外部 Shadowsocks 或 VLESS Reality 链接";
    if (egressVless && !egressCapabilities.loading && !egressCapabilities.vless) return egressCapabilities.vlessReason || "入口主机的 Agent 需要升级才能用 VLESS Reality 出口";
    // UDP 走 Shadowsocks 出口要每台入口机都报了能力（服务端保存时同样会拦）；VLESS 的 UDP 只看上面的 Agent 版本。
    if (!egressVless && form.egress.egressUdp && !egressCapabilities.loading && !egressCapabilities.udp) return egressCapabilities.udpReason || "入口主机还不支持 UDP 走出口";
    return null;
  }, [egressActive, egressBlockedReason, form.egress, form.protocol, form.tunnelId, egressViaTunnel, selectedTunnel, effectiveRouteForwardType, isForwardGroupRouteMode, selectedForwardGroup, egressCapabilities]);
  const submitBlocker = useMemo<string | null>(
    () => (isSniEntryMode
      ? (form.routeMode === "tunnel" && !form.tunnelId
        ? "还没选隧道"
        : (form.routeMode === "chain" || form.routeMode === "group") && !form.forwardGroupId
        ? "还没选转发链 / 转发组"
        : form.tlsInboundId && !sniChoices.some((choice) => Number(choice.inbound.id) === Number(form.tlsInboundId))
        ? "这个共享 TLS 入站不在所选隧道 / 转发资源的入口主机上，请重新选择"
        : sniRuleFormBlocker(form, selectedTlsInbound, undefined, sniRouteKind))
      : forwardRuleFormBlocker(form, ruleFormContext) || egressBlocker),
    [form, ruleFormContext, isSniEntryMode, selectedTlsInbound, egressBlocker, sniChoices, sniRouteKind],
  );
  const sourcePortRequired = isForwardRuleSourcePortRequired(ruleFormContext);
  /*
    折叠条上写清楚里面现在是什么样 —— 折起来就看不见的话，那叫藏，不叫收纳。
    只列「有内容可说」的：转发工具总是有值，其余填了/开了才出现。
  */
  const advancedSummary = useMemo(() => {
    const parts: string[] = [];
    const toolLabel = FORWARD_TYPE_LABELS[effectiveRouteForwardType] || effectiveRouteForwardType;
    if (toolLabel) parts.push(String(toolLabel));
    if (form.telegramErrorNotifyEnabled) parts.push("异常提醒");
    // 专属域名新建时默认关，打开了才值得写出来。
    if (ruleEntryDomainAvailable && form.entryDomainEnabled) parts.push("专属域名");
    const limits = user?.role === "admin" ? ruleLimitsSummary(form.limits) : null;
    if (limits) parts.push(limits);
    return parts;
  }, [effectiveRouteForwardType, form.telegramErrorNotifyEnabled, form.entryDomainEnabled, form.limits, ruleEntryDomainAvailable, user?.role]);
  /** 线路组的入口机器：路径里的中转不能是它自己。隧道转发的入口是隧道的出口机（调度在那儿）。 */
  const routeEntryHostId = useMemo(() => {
    if (form.routeMode === "tunnel" && form.tunnelId) {
      const tunnel = (supportedTunnels as any[]).find((item) => Number(item.id) === Number(form.tunnelId));
      return Number(tunnel?.exitHostId || 0) || null;
    }
    return form.hostId ? Number(form.hostId) : null;
  }, [form.routeMode, form.tunnelId, form.hostId, supportedTunnels]);
  const routeHostOptions = useMemo<RouteHostOption[]>(() => routeHostOptionsOf(hosts as any[]), [hosts]);
  // 线路编辑：节点池、能当一段的隧道（入口在哪台、出口到哪台），入口叫什么；隧道规则把入口前面那段如实写出来。
  const nodePoolsQuery = trpc.nodePools.list.useQuery(undefined, { enabled: !!form.failoverEnabled, staleTime: 30_000, refetchOnWindowFocus: false });
  const routeLinePools = useMemo<RouteLinePool[]>(() => routeLinePoolsOf(nodePoolsQuery.data as any[]), [nodePoolsQuery.data]);
  const routeLineTunnels = useMemo<RouteLineTunnel[]>(() => routeLineTunnelsOf(tunnels as any[]), [tunnels]);
  const routeEntryName = useMemo(() => {
    const host = (hosts || []).find((item: any) => Number(item.id) === Number(routeEntryHostId || 0)) as any;
    return host ? String(host.name || `主机 ${host.id}`) : "入口";
  }, [hosts, routeEntryHostId]);
  // 隧道规则：隧道入口那台在调度器前面，不拿来当中转建议
  const routeUpstreamHostIds = useMemo(() => {
    if (form.routeMode !== "tunnel" || !form.tunnelId) return [] as number[];
    const tunnel = (supportedTunnels as any[]).find((item) => Number(item.id) === Number(form.tunnelId));
    const id = Number(tunnel?.entryHostId || 0);
    return id > 0 ? [id] : [];
  }, [form.routeMode, form.tunnelId, supportedTunnels]);
  const routeEntryPrefix = useMemo(() => {
    if (form.routeMode !== "tunnel" || !form.tunnelId) return null;
    const tunnel = (supportedTunnels as any[]).find((item) => Number(item.id) === Number(form.tunnelId));
    if (!tunnel) return null;
    const entry = (hosts || []).find((item: any) => Number(item.id) === Number(tunnel.entryHostId)) as any;
    return `${entry?.name || "入口"} → 隧道 ${tunnel.name || tunnel.id} →`;
  }, [form.routeMode, form.tunnelId, supportedTunnels, hosts]);
  /*
    转发组（故障转移组）上的规则由模板复制到每台入口机上，中继要按入口机各建一份，这一版先
    不支持经过中转 —— 编辑器里不给「经过中转」的按钮，提交时也拦。
  */
  const routeHopsAllowed = form.routeMode !== "group";
  /*
    编辑框里的「此刻」：拿还没保存的线路组走和线路面板同一份模型算一遍。协议、转发方式、
    是不是走隧道都带上：UDP 的探测、按访客固定、Agent 版本这几句提醒要靠它们。PROXY 头的
    开关不在这个表单里，编辑时取这条规则存着的值。
  */
  const editingStoredRule = useMemo(
    () => (editingId !== null ? (rules || []).find((rule: any) => Number(rule.id) === editingId) : null),
    [editingId, rules],
  );
  // 编辑线路组那个框里算「此刻」用的规则字段（框和草稿在 features/rules/RuleLineGroupField.tsx）
  const routePolicyRule = useMemo(() => ({
    targetIp: form.targetIp,
    targetPort: form.targetPort,
    forwardType: effectiveRouteForwardType,
    protocol: form.protocol,
    tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null,
    tunnelMode: form.routeMode === "tunnel" ? selectedTunnel?.mode : null,
    proxyProtocolSend: editingStoredRule?.proxyProtocolSend,
    proxyProtocolExitSend: editingStoredRule?.proxyProtocolExitSend,
  }), [form.targetIp, form.targetPort, form.protocol, form.routeMode, form.tunnelId, selectedTunnel, effectiveRouteForwardType, editingStoredRule]);
  const advancedBlocked = isAdvancedSectionBlocker(submitBlocker);
  const advancedOpen = showAdvanced || advancedBlocked;
  // 出口开着却还缺东西（没选入站、入口机撑不起……）时自己展开：看不见的提示比什么都不说更糟。
  const egressOpen = showEgress || (egressActive && !!egressBlocker);
  const egressSummary = egressActive
    ? `${RULE_EGRESS_TYPE_LABELS[form.egress.egressType]}${form.egress.egressUdp ? " · TCP+UDP" : ""}`
    : RULE_EGRESS_TYPE_LABELS.none;

  const useRuleRouteModeTabsResult = useRuleRouteModeTabs({ canUseLocalForward, routeModeLocked, form, canUseGost, plainTunnels, aggregateTunnels, routeTab, canUseForwardChain, canUseFailoverGroup });
  const { routeModeTabItems } = useRuleRouteModeTabsResult;
  useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get("create") !== "local") return;
    if (rulePermissionLoading || !hostsFetched || !systemSettingsFetched) return;
    params.delete("create");
    const nextSearch = params.toString();
    setLocation(`/rules${nextSearch ? `?${nextSearch}` : ""}`, { replace: true });
    if (!canAdd) {
      toast.error("当前账号没有添加转发规则的权限");
      return;
    }
    openCreate("local");
  }, [search, setLocation, rulePermissionLoading, hostsFetched, systemSettingsFetched, canAdd, canUseLocalForward, canUseSavedLocalForward, canUseBillingHostLocalForward, availablePortForwardGroups, availableTrafficBillingHosts, usableForwardTypes]);

  /*
    /rules?edit=<规则 id>：从别处（链路管理的线路总览）直接打开这条规则的编辑框。
    规则不一定在当前这一页里，所以按 id 单独取；取不到（删了、不是自己的）就说一声。
  */
  useEffect(() => {
    const params = new URLSearchParams(search);
    const editId = Number(params.get("edit") || 0);
    if (!Number.isInteger(editId) || editId <= 0) return;
    if (rulePermissionLoading || !hostsFetched || !systemSettingsFetched || !(forwardGroupsFetched || forwardGroupsError)) return;
    params.delete("edit");
    const nextSearch = params.toString();
    setLocation(`/rules${nextSearch ? `?${nextSearch}` : ""}`, { replace: true });
    void utils.rules.getById.fetch({ id: editId }).then((rule) => {
      if (rule) openEdit(rule);
      else toast.error("这条规则不存在，或者你没有权限编辑");
    }, () => toast.error("读取规则失败"));
  }, [search, setLocation, rulePermissionLoading, hostsFetched, systemSettingsFetched, forwardGroupsFetched, forwardGroupsError]);

  /*
    /rules?diagnose=<规则 id>：从「我的线路」直接打开这条规则的诊断框（延迟测试那一页）。
  */
  useEffect(() => {
    const params = new URLSearchParams(search);
    const diagnoseId = Number(params.get("diagnose") || 0);
    if (!Number.isInteger(diagnoseId) || diagnoseId <= 0) return;
    if (rulePermissionLoading || !hostsFetched || !systemSettingsFetched || !(forwardGroupsFetched || forwardGroupsError)) return;
    params.delete("diagnose");
    const nextSearch = params.toString();
    setLocation(`/rules${nextSearch ? `?${nextSearch}` : ""}`, { replace: true });
    void utils.rules.getById.fetch({ id: diagnoseId }).then((rule) => {
      if (!rule) {
        toast.error("这条规则不存在，或者你没有权限查看");
        return;
      }
      setSelfTestRule({
        id: Number(rule.id),
        name: String(rule.name || ""),
        isForwardChain: getRuleCategory(rule, forwardGroupById) === "chain",
        chainKernel: !isUserspaceForwardType((rule as any).forwardType),
        probeMethod: ruleLatencyProbeMethodForRule(rule),
      });
    }, () => toast.error("读取规则失败"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, setLocation, rulePermissionLoading, hostsFetched, systemSettingsFetched, forwardGroupsFetched, forwardGroupsError]);

  const useRuleMainBackupResult = useRuleMainBackup({ panelFlags, form, selectedForwardGroup, effectiveRouteForwardType, selectedTunnel, tunnelById, user, usableForwardTypes, routeModeLocked, isSniEntryMode, egressActive, canUseFailoverGroup, setRouteMode, canUseGost, selectedHost, hosts, hostById, forwardGroupById });
  const { canUseMainBackup, telegramBotReady, selectedForwardGroupIsChain, mainBackupDisabledText, kernelForwardWarning, routeGroupSectionVisible, routeGroupSummary, canAutoSwitchMainBackupToGost, mainBackupBlock } = useRuleMainBackupResult;
  const useRulePortCheckResult = useRulePortCheck({ latestPortCheckRef, form, isForwardGroupRouteMode, setPortRangeError, setPortStatus, utils, editingId, createOwnerUserId, formSourcePortEnd, selectedEntryPortPolicy, usableForwardTypes, setForm, availablePortForwardGroups, availableForwardChainGroups, availableFailoverForwardGroups, selectedForwardGroup, isLegacyLocalRuleEdit, canUseMainBackup, systemSettingsFetched, telegramBotReady });
  const { handleRandomPort } = useRulePortCheckResult;

  /*
    「重置统计」和「删除规则」都走共享的确认框：请求在路上时弹窗留着、按钮写「重置中...」，
    成功了才关。原来这两处各自手写一个 Dialog，就是因为 useConfirmDialog 没有 pending 态和 details 槽。
  */
  const confirmResetTraffic = (target: { scope: "all" } | { scope: "rule"; rule: any }) => {
    if (target.scope === "all" && visibleRuleIdsForMetrics.length === 0) return;
    void confirmDialog({
      title: target.scope === "all" ? "重置全部规则数据" : "重置规则数据",
      description: target.scope === "all"
        ? `确认重置当前列表中 ${visibleRuleIdsForMetrics.length} 条规则的所有统计数据？`
        : `确认重置规则 "${target.rule?.name || ""}" 的所有统计数据？`,
      details: (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--fx-warn)_20%,transparent)] bg-[var(--fx-warn-soft)] p-3 text-xs leading-5 text-[var(--fx-warn-text)]">
          这里只清除规则页面展示的统计数据，不会清除用户套餐已用流量、余额或流量按量计费记录。
        </div>
      ),
      confirmText: "确认重置",
      confirmPendingText: "重置中...",
      onConfirm: () => resetTrafficMutation.mutateAsync(target.scope === "rule"
        ? { scope: "rule", ruleId: Number(target.rule?.id || 0) }
        : { scope: "all", ruleIds: visibleRuleIdsForMetrics }),
    });
  };
  const confirmDeleteRule = (rule: any) => {
    void confirmDialog({
      title: "删除转发规则",
      description: `确认删除 "${rule?.name}"？`,
      confirmText: "删除",
      confirmPendingText: "删除中...",
      onConfirm: () => deleteMutation.mutateAsync({ id: rule.id }),
    });
  };

  const handleSubmit = async () => {
    const submitForwardType = effectiveRouteForwardType;
    /*
      缺什么由 submitBlocker 说了算 —— 按钮的禁用、footer 的提示、这里的拦截，
      三处读同一个值。原来这里另写了一份七段 if，和按钮那份各自演化，结果是
      「按钮亮着、点下去说缺目标端口」这种自相矛盾。
    */
    if (submitBlocker) {
      toast.error(submitBlocker);
      return;
    }
    // 单条规则限额：管理员才发，而且只发改过的那几项（没动就一项都不带，规则不会因此变成管理员管理）。
    let limitPayload: Record<string, unknown> = {};
    if (user?.role === "admin") {
      try {
        limitPayload = ruleLimitsChanges(form.limits, editingId ? editingLimitBaseline : undefined);
      } catch (error) {
        setShowAdvanced(true);
        toast.error(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (form.routeMode === "local" && !isProtocolEnabled(form.forwardType)) {
      toast.error(unsupportedProtocolTitle);
      return;
    }
    if (form.routeMode === "tunnel" && !isProtocolEnabled(getTunnelProtocolKey(selectedTunnel))) {
      toast.error(unsupportedProtocolTitle);
      return;
    }
    if (isForwardGroupRouteMode && !isProtocolEnabled(effectiveRouteForwardType)) {
      toast.error(unsupportedProtocolTitle);
      return;
    }
    if (form.routeMode === "group" && !selectedForwardGroupIsChain && selectedForwardGroup?.groupType === "tunnel" && !isProtocolEnabled("gost")) {
      toast.error(unsupportedProtocolTitle);
      return;
    }
    if (form.telegramErrorNotifyEnabled && !telegramBotReady) {
      toast.error("请先在系统设置中配置并启用 Telegram 机器人，再开启异常TG提醒");
      return;
    }
    if (isSniEntryMode) {
      // 共享 TLS 入站：没有源端口、不查端口占用，名字由服务端规整并检查冲突。
      const sniPayload = {
        name: resolveForwardRuleName(form.name, form).slice(0, 128),
        forwardType: sniRouteKind === "tunnel" ? "gost" as ForwardType : sniRouteKind === "group" ? effectiveRouteForwardType : form.forwardType,
        // 走法：直连不带；经隧道 / 转发资源时带上（编辑时服务端只认原值，换走法要新建）。
        tunnelId: sniRouteKind === "tunnel" ? form.tunnelId : null,
        forwardGroupId: sniRouteKind === "group" ? form.forwardGroupId : null,
        protocol: "tcp" as const,
        targetIp: form.targetIp,
        targetPort: form.targetPort,
        tlsInboundId: Number(form.tlsInboundId),
        sniNames: form.sniNamesText,
        telegramErrorNotifyEnabled: form.telegramErrorNotifyEnabled,
        failoverEnabled: false,
      };
      if (editingId) updateMutation.mutate(Object.assign({ id: editingId }, sniPayload, limitPayload));
      else createMutation.mutate(Object.assign({}, sniPayload, limitPayload, { name: form.name, sourcePort: 0, userId: createOwnerUserId }));
      return;
    }
    if (form.failoverEnabled) {
      if (!canUseMainBackup) {
        toast.error(mainBackupDisabledText || "当前规则类型不支持线路组");
        return;
      }
      if (!form.routeGroup) {
        toast.error("线路组还没有路径");
        return;
      }
      // 和服务端落库前跑的是同一份校验，所以「面板收下了、机器上不生效」不会发生在这一层。
      const routeGroupError = validateRouteGroup(form.routeGroup, {
        entryHostId: routeEntryHostId,
        hostIds: new Set(routeHostOptions.map((host) => host.id)),
        hasRuleTarget: !!form.targetIp.trim() && form.targetPort > 0,
        rejectDuplicates: !!form.routeGroup.lines?.length,
      });
      if (routeGroupError) {
        toast.error(routeGroupError);
        return;
      }
      if (!routeHopsAllowed && form.routeGroup.paths.some((path) => path.hops.length > 0)) {
        toast.error("转发组上的规则暂不支持经过中转的路径");
        return;
      }
    }
    /*
      整份线路组发上去；时段表、指定按模式归零在 routeGroupPayload 里（换了模式之后界面上那份
      还留着，改回来就在，但发上去会被服务端拒绝）。没开线路组就发 null：服务端清掉路径、
      收回中转机上的中继。
    */
    const failoverPayload = {
      failoverEnabled: canUseMainBackup ? form.failoverEnabled : false,
      routeGroup: canUseMainBackup && form.failoverEnabled && form.routeGroup ? routeGroupPayload(form.routeGroup) : null,
    };
    if (!isForwardGroupRouteMode && portStatus === "used") {
      toast.error("源端口已被占用，请更换端口或使用随机分配");
      return;
    }
    if (!editingId && !isForwardGroupRouteMode && form.sourcePort > 0 && portStatus !== "available") {
      toast.error("请等待端口可用后再保存");
      return;
    }
    if (kernelForwardWarning) {
      toast.warning(kernelForwardWarning);
    }
    /*
      线路组里的落地和订阅节点凭据不一样：切到那个落地后订阅会连不上（2026-11 用户要求保存时提醒）。
      查不了（网络错）不拦，照常保存。
    */
    if (failoverPayload.routeGroup && form.targetNodeId && (form.routeGroup?.lines?.length ?? 0) > 0) {
      const check = await routeLandingCredentialCheck.mutateAsync({
        proxyNodeId: form.targetNodeId,
        lines: (form.routeGroup?.lines || []).map((line) => ({
          name: line.name,
          dests: line.dests.map((item) => ({ dest: item.dest ?? null, destNodeId: item.destNodeId ?? null })),
        })),
      }).catch(() => null);
      const issues = check?.issues || [];
      if (issues.length > 0) {
        const listed = issues.slice(0, 4).map((issue) => `${issue.line} → ${issue.landing}${issue.reason === "unknown" ? "（不是节点，没法确认）" : ""}`).join("；");
        const confirmed = await confirmDialog({
          title: "有落地和订阅节点的凭据不一样",
          description: `${listed}${issues.length > 4 ? ` 等 ${issues.length} 个` : ""}。线路切到这些落地时，订阅里的客户端会连不上。建议把这几台建成一个落地池，线路落地选这个池（凭据自动一致）。`,
          confirmText: "仍然保存",
          cancelText: "返回修改",
        });
        if (!confirmed) return;
      }
    }
    if (editingId && editingOriginalProtocol === "both" && form.protocol !== "both") {
      const confirmed = await confirmDialog({
        title: "确认缩小协议范围",
        description: `当前规则同时转发 TCP 和 UDP。保存后将只保留 ${form.protocol.toUpperCase()}，另一协议的监听会被停止。`,
        confirmText: "继续保存",
      });
      if (!confirmed) return;
    }
    /*
      出口：端口转发这条路上照表单发；别的路（隧道 / 转发链 / 转发组）编辑时发「直接连接」把旧出口清掉，新建时不发。
      外部链接不改就不发（服务端保留原来加密存着的那条）。
    */
    const egressPayload = egressSectionVisible
      ? {
        egressType: form.egress.egressType,
        egressInboundId: ruleEgressUsesInbound(form.egress.egressType) ? form.egress.egressInboundId : null,
        egressLink: ruleEgressUsesLink(form.egress.egressType) && form.egress.egressLink.trim() ? form.egress.egressLink.trim() : undefined,
        egressUdp: form.egress.egressType !== "none" && form.egress.egressUdp,
      }
      : editingId ? { egressType: "none" as const } : {};
    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        hostId: isForwardGroupRouteMode ? undefined : form.hostId!,
        // 更新接口要求名称非空；清空名称时和新建一样按目标自动生成，而不是报错。
        name: resolveForwardRuleName(form.name, form).slice(0, 128),
        forwardType: submitForwardType,
        protocol: form.protocol,
        gostMode: "direct" as const,
        gostRelayHost: null,
        gostRelayPort: null,
        tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null,
        forwardGroupId: isForwardGroupRouteMode ? form.forwardGroupId : null,
        sourcePort: form.sourcePort,
        sourcePortEnd: formIsPortRange ? formSourcePortEnd : null,
        isEnabled: portStatus === "available" ? true : undefined,
        targetIp: form.targetIp,
        targetPort: form.targetPort,
        targetPortEnd: formTargetPortEnd > form.targetPort ? formTargetPortEnd : null,
        ...(form.targetNodeId ? { proxyNodeId: form.targetNodeId } : {}),
        telegramErrorNotifyEnabled: form.telegramErrorNotifyEnabled,
        entryDomainEnabled: form.entryDomainEnabled,
        ...failoverPayload,
        ...egressPayload,
        ...limitPayload,
      });
    } else {
      createMutation.mutate({
        userId: createOwnerUserId,
        hostId: isForwardGroupRouteMode ? undefined : form.hostId!,
        name: form.name,
        forwardType: submitForwardType,
        protocol: form.protocol,
        gostMode: "direct" as const,
        gostRelayHost: null,
        gostRelayPort: null,
        tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null,
        forwardGroupId: isForwardGroupRouteMode ? form.forwardGroupId : null,
        sourcePort: form.sourcePort,
        ...(formIsPortRange ? { sourcePortEnd: formSourcePortEnd } : {}),
        targetIp: form.targetIp,
        targetPort: form.targetPort,
        ...(formTargetPortEnd > form.targetPort ? { targetPortEnd: formTargetPortEnd } : {}),
        ...(form.targetNodeId ? { proxyNodeId: form.targetNodeId } : {}),
        telegramErrorNotifyEnabled: form.telegramErrorNotifyEnabled,
        entryDomainEnabled: form.entryDomainEnabled,
        ...failoverPayload,
        ...egressPayload,
        ...limitPayload,
      });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  // 编辑规则的弹窗：改过没保存就关要先问「放弃修改？」；请求在路上时不许关（ui/form-dialog）
  const ruleFormDirty = useFormDirty(showDialog, form);
  const ruleDialogGuard = useDialogCloseGuard({
    open: showDialog,
    dirty: ruleFormDirty,
    pending: isPending,
    onOpenChange: (open) => {
      if (!open) resetForm();
      setShowDialog(open);
    },
  });

  const useRuleFilterCountsResult = useRuleFilterCounts({ filterUser, filterResource, ruleCategory, ruleSearchQuery, user, hostById, tunnelById, userById, forwardGroupById, getRuleEntryHostIdForSort, rules, selectedScopeQueryEnabled, selectedScopeRules, ruleListDataReady, rulePageQuery });
  const { ruleCategoryCountsReady, ruleCategoryCounts, filteredRules, selectedScopedRules, ruleFilterCacheScope, scopedRulesReady, filteredRulesPrimed, baseScopedRules, ruleFilters } = useRuleFilterCountsResult;
  const ruleCategoryItems = useMemo<FilterChipItem<RuleCategory>[]>(() => [
    { value: "all", label: "全部", count: ruleCategoryCountsReady ? ruleCategoryCounts.all : null },
    { value: "local", label: desktopRuleTypeLabels.local, count: ruleCategoryCountsReady ? ruleCategoryCounts.local : null },
    { value: "tunnel", label: desktopRuleTypeLabels.tunnel, count: ruleCategoryCountsReady ? ruleCategoryCounts.tunnel : null },
    { value: "chain", label: desktopRuleTypeLabels.chain, count: ruleCategoryCountsReady ? ruleCategoryCounts.chain : null },
    { value: "group", label: desktopRuleTypeLabels.group, count: ruleCategoryCountsReady ? ruleCategoryCounts.group : null },
  ], [ruleCategoryCounts, ruleCategoryCountsReady]);
  const ruleCategoryTabItems = useMemo<SlidingTabItem<RuleCategory>[]>(
    () => ruleCategoryItems.map((item) => ({ value: item.value, label: item.label, badge: item.count ?? undefined })),
    [ruleCategoryItems],
  );
  const visibleRuleIdsForMetrics = useMemo(() => (
    Array.from(new Set(filteredRules.map((rule: any) => Number(rule.id)).filter((id: number) => Number.isInteger(id) && id > 0)))
      .sort((a, b) => a - b)
  ), [filteredRules]);
  const selfTestRuleDetail = useMemo(() => {
    if (!selfTestRule) return null;
    return [...(rules || []), ...(selectedScopedRules || [])]
      .find((rule: any) => Number(rule.id) === Number(selfTestRule.id)) || null;
  }, [rules, selectedScopedRules, selfTestRule?.id]);
  const selfTestTargetAddress = useMemo(() => {
    const target = String(selfTestRuleDetail?.targetIp || "").trim();
    return target ? normalizeAddressKey(target) : "";
  }, [selfTestRuleDetail?.targetIp]);
  const ruleGlobeTargetAddresses = useMemo(() => (
    Array.from(new Set(
      filteredRules
        .map((rule: any) => String(rule.targetIp || "").trim())
        .filter(Boolean)
        .map((address: string) => normalizeAddressKey(address))
    )).slice(0, 100)
  ), [filteredRules]);
  const ruleTargetGeoAddresses = useMemo(() => (
    Array.from(new Set([
      ...(effectiveViewMode === "globe" ? ruleGlobeTargetAddresses : []),
      selfTestTargetAddress,
    ].filter(Boolean))).slice(0, 100)
  ), [effectiveViewMode, ruleGlobeTargetAddresses, selfTestTargetAddress]);
  const { data: ruleTargetGeoRows, isFetched: ruleTargetGeoFetched, isError: ruleTargetGeoError } = trpc.rules.targetGeoBatch.useQuery(
    { targets: ruleTargetGeoAddresses },
    {
      enabled: ruleTargetGeoAddresses.length > 0,
      staleTime: 24 * 60 * 60 * 1000,
      refetchOnWindowFocus: false,
    }
  );
  const targetGeoLookupReady = effectiveViewMode !== "globe" || ruleGlobeTargetAddresses.length === 0 || ruleTargetGeoFetched || ruleTargetGeoError;
  const targetGeoByAddress = useMemo(() => {
    const map = new Map<string, RuleTargetGeo>();
    (ruleTargetGeoRows || []).forEach((row: any) => {
      if (!row?.target || !row.geo) return;
      map.set(normalizeAddressKey(row.target), row.geo as RuleTargetGeo);
    });
    return map;
  }, [ruleTargetGeoRows]);
  const trafficRangeLabel = "近 24h";
  /*
    累计（total）和近 24h 是两份不同的数（服务端分开算、分开缓存），合不成一个查询。
    累计这份只用来显示卡上的总字节，实时速率、延迟都从 24h 那份取，所以它 30 秒一轮就够。
  */
  const { data: totalTrafficSummary } = trpc.rules.trafficSummary.useQuery(
    { hours: 24, range: "total", ruleIds: visibleRuleIdsForMetrics },
    {
      enabled: secondaryQueriesReady && visibleRuleIdsForMetrics.length > 0,
      refetchInterval: pollingInterval("slow"),
      staleTime: 5000,
      refetchOnWindowFocus: false,
      placeholderData: (previousData) => previousData,
    }
  );
  /*
    列表接口已经把这一页的当日汇总带回来了（withTrafficSummary24h）：规则 id 对得上就直接当这条查询的初始数据，
    卡片不用再等一轮往返；之后照常按 pollingInterval 刷新。对不上（客户端又筛掉了几条、翻页中的旧数据）就照旧去取。
  */
  const listPageTrafficSummary = useMemo(() => {
    const data = rulePageQuery.data as { items?: Array<{ id?: unknown }>; trafficSummary24h?: unknown[] } | undefined;
    if (!data?.trafficSummary24h || rulePageQuery.isPlaceholderData) return undefined;
    const pageIds = Array.from(new Set((data.items || []).map((rule) => Number(rule.id)).filter((id) => Number.isInteger(id) && id > 0))).sort((a, b) => a - b);
    return pageIds.join(",") === visibleRuleIdsForMetrics.join(",") ? data.trafficSummary24h : undefined;
  }, [rulePageQuery.data, rulePageQuery.isPlaceholderData, visibleRuleIdsForMetrics]);
  const {
    data: dailyTrafficSummary,
    isFetched: dailyTrafficSummaryNetworkFetched,
    isPlaceholderData: dailyTrafficSummaryIsPlaceholder,
  } = trpc.rules.trafficSummary.useQuery(
    { hours: 24, range: "24h", ruleIds: visibleRuleIdsForMetrics },
    {
      enabled: visibleRuleIdsForMetrics.length > 0,
      /*
        卡片上「经哪台出口」、整链延迟、红绿状态要跟得上（用户 2026-11-26：高防时通时断，卡片还写着经一台已经被拦的
        出口）：3 秒一刷。服务端只缓存字节和定时探测那份（5 秒，rules.traffic.ts），在用出口、两段延迟是每次请求
        从内存现算的，所以这里刷得勤不会多打数据库。页面在后台时 react-query 自己停。
      */
      refetchInterval: pollingInterval("active"),
      staleTime: 2000,
      refetchOnWindowFocus: false,
      initialData: listPageTrafficSummary as any,
      initialDataUpdatedAt: listPageTrafficSummary ? rulePageQuery.dataUpdatedAt : undefined,
      placeholderData: (previousData) => previousData,
    }
  );
  // 「这一页的汇总到了」：网络取到过，或者用的是列表顺带的那份（不是翻页时沿用的上一页占位）
  const dailyTrafficSummaryFetched = dailyTrafficSummaryNetworkFetched || (dailyTrafficSummary !== undefined && !dailyTrafficSummaryIsPlaceholder);
  const [stableTotalTrafficSummaryRows, setStableTotalTrafficSummaryRows] = useState<any[]>([]);
  const [stableDailyTrafficSummaryRows, setStableDailyTrafficSummaryRows] = useState<any[]>([]);
  const resetTrafficMutation = trpc.rules.resetTraffic.useMutation({
    onSuccess: async (_data, variables) => {
      invalidateRuleProbeStatuses(
        variables.scope === "rule" && variables.ruleId
          ? [Number(variables.ruleId)]
          : variables.ruleIds,
      );
      clearRuleTrafficStatCaches();
      setStableTotalTrafficSummaryRows([]);
      setStableDailyTrafficSummaryRows([]);
      await Promise.all([
        utils.rules.trafficSummary.invalidate(),
        utils.rules.traffic.invalidate(),
        utils.rules.trafficSeries.invalidate(),
        utils.rules.trafficSeriesBatch.invalidate(),
        utils.dashboard.trafficTotals.invalidate(),
        utils.dashboard.trafficSeries.invalidate(),
        utils.dashboard.trafficBreakdown.invalidate(),
      ]);
      toast.success("规则统计数据已重置");
    },
    onError: (err) => toast.error(err.message || "重置数据失败"),
  });
  useEffect(() => {
    if (visibleRuleIdsForMetrics.length === 0) {
      setStableTotalTrafficSummaryRows([]);
      return;
    }
    if (totalTrafficSummary) {
      setStableTotalTrafficSummaryRows(totalTrafficSummary);
    }
  }, [totalTrafficSummary, visibleRuleIdsForMetrics.length]);
  useEffect(() => {
    if (visibleRuleIdsForMetrics.length === 0) {
      setStableDailyTrafficSummaryRows([]);
      return;
    }
    if (dailyTrafficSummary) {
      setStableDailyTrafficSummaryRows(dailyTrafficSummary);
    }
  }, [dailyTrafficSummary, visibleRuleIdsForMetrics.length]);
  const totalTrafficSummaryRows = visibleRuleIdsForMetrics.length === 0 ? [] : totalTrafficSummary ?? stableTotalTrafficSummaryRows;
  const dailyTrafficSummaryRows = visibleRuleIdsForMetrics.length === 0 ? [] : dailyTrafficSummary ?? stableDailyTrafficSummaryRows;
  const useTrafficByRuleResult = useTrafficByRule({ dailyTrafficSummaryRows });
  const { trafficByRule } = useTrafficByRuleResult;
  const probeByRule = useMemo(() => {
    const map = new Map<number, NonNullable<ReturnType<typeof trafficByRule.get>>>();
    for (const ruleId of visibleRuleIdsForMetrics) {
      const row = trafficByRule.get(ruleId);
      if (!row) continue;
      const editedAt = ruleEditedAt.get(ruleId) || 0;
      if (editedAt > 0 && timestampMillis(row.latestLatencyAt) < editedAt) continue;
      map.set(ruleId, row);
    }
    return map;
  }, [ruleEditedAt, trafficByRule, visibleRuleIdsForMetrics]);
  const hasForwardGroupRules = useMemo(
    () => filteredRules.some((rule: any) => Number(rule.forwardGroupId || 0) > 0),
    [filteredRules],
  );
  const ruleStatusReady = filteredRules.length === 0 || (
    dailyTrafficSummaryFetched
    && (!hasForwardGroupRules || forwardGroupsFetched || forwardGroupsError)
  );
  const useRuleTrafficSeriesResult = useRuleTrafficSeries({ dailyTrafficSummaryRows, secondaryQueriesReady, visibleRuleIdsForMetrics, effectiveViewMode, totalTrafficSummaryRows });
  const { dailyTrafficByRule, totalTrafficByRule, sparkByRule, dailySpark } = useRuleTrafficSeriesResult;
  const pageDailyTrafficTotals = useMemo(() => {
    let bytesIn = 0;
    let bytesOut = 0;
    let connections = 0;
    dailyTrafficSummaryRows.forEach((t: any) => {
      bytesIn += Number(t.bytesIn) || 0;
      bytesOut += Number(t.bytesOut) || 0;
      connections += Number(t.connections) || 0;
    });
    return { bytesIn, bytesOut, connections };
  }, [dailyTrafficSummaryRows]);
  const effectiveRuleListSummary = ruleListSummary ?? stableRuleListSummary;
  const dailyTrafficTotals = effectiveRuleListSummary?.dailyTraffic || pageDailyTrafficTotals;
  const compareRulesBySavedOrder = useCallback((a: any, b: any) => {
    // 按分组排序：和服务端同一个名次（所在组里最靠前那个组的顺序，未分组最后），同名次里照原来的排
    if (personalGroupSortActive) {
      const groupCompare = personalRuleGroupRank(a.personalGroupIds, personalGroupRankById) - personalRuleGroupRank(b.personalGroupIds, personalGroupRankById);
      if (groupCompare !== 0) return groupCompare;
    }
    const aCategory = getRuleCategory(a, forwardGroupById);
    const bCategory = getRuleCategory(b, forwardGroupById);
    if (ruleCategory === "all") {
      const categoryCompare = (RULE_SORT_CATEGORY_RANK.get(aCategory) ?? 99) - (RULE_SORT_CATEGORY_RANK.get(bCategory) ?? 99);
      if (categoryCompare !== 0) return categoryCompare;
    }
    const aSortOrder = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
    const bSortOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number.MAX_SAFE_INTEGER;
    if (aSortOrder !== bSortOrder) return aSortOrder - bSortOrder;
    const createdCompare = new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    if (createdCompare !== 0) return createdCompare;
    return Number(b.id || 0) - Number(a.id || 0);
  }, [forwardGroupById, personalGroupRankById, personalGroupSortActive, ruleCategory]);
  const sortedFilteredRules = useMemo(() => {
    return [...filteredRules].sort(compareRulesBySavedOrder);
  }, [compareRulesBySavedOrder, filteredRules]);
  const ruleOrder = useOptimisticSortableOrder({
    items: sortedFilteredRules,
    getId: (rule: any) => Number(rule.id),
  });
  const orderedFilteredRules = ruleOrder.items;
  const trafficTotalsCacheScope = useMemo(
    () => [
      ruleFilterCacheScope,
      filterResource,
      ruleCategory,
      ruleSearchQuery.trim() || "search-all",
    ].join("."),
    [filterResource, ruleCategory, ruleFilterCacheScope, ruleSearchQuery],
  );
  const hasActiveUserFilter = user?.role === "admin" && filterUser !== "self";
  const hasActiveRuleFilter = hasActiveUserFilter || filterResource !== "all" || ruleCategory !== "all" || ruleSearchQuery.trim().length > 0 || personalGroupFilter !== null;
  const rulesHeaderLoading = isLoading || !rules || !scopedRulesReady || !filteredRulesPrimed;
  const dailyTrafficTotalsLoading = rulesHeaderLoading || !secondaryQueriesReady || ruleListSummaryLoading;
  const [stableRulePageMeta, setStableRulePageMeta] = useState({ activeItems: 0, totalItems: 0, scopeTotalItems: 0, runningItems: 0, stalledItems: 0, pausedItems: 0 });
  useEffect(() => {
    if (!rulePageQuery.data || rulePageQuery.isPlaceholderData) return;
    setStableRulePageMeta({
      activeItems: Math.max(0, Number(rulePageQuery.data.activeItems) || 0),
      totalItems: Math.max(0, Number(rulePageQuery.data.totalItems) || 0),
      scopeTotalItems: Math.max(0, Number(rulePageQuery.data.scopeTotalItems) || 0),
      runningItems: Math.max(0, Number(rulePageQuery.data.runningItems) || 0),
      stalledItems: Math.max(0, Number(rulePageQuery.data.stalledItems) || 0),
      pausedItems: Math.max(0, Number(rulePageQuery.data.pausedItems) || 0),
    });
  }, [rulePageQuery.data, rulePageQuery.isPlaceholderData]);
  const rulePageMeta = rulePageQuery.data ?? stableRulePageMeta;
  const ruleScopeTotal = Math.max(0, Number(rulePageMeta.scopeTotalItems) || 0);
  const activeCount = Math.max(0, Number(rulePageMeta.activeItems) || 0);
  /*
    页头那一行状态点按「在不在跑」数，和首页同一口径（服务端 forwardRuleStatusCountsSql）：
    运行中 = 启用且在跑；未运行 = 启用但没在跑（灰点那几条）；已暂停 = 主人被暂停转发；已停用 = 开关关着。
    以前写「运行 N」，N 其实是启用的条数（首页说 4 条没在跑，这里却写运行 7）。
  */
  const runningRuleCount = Math.max(0, Number(rulePageMeta.runningItems) || 0);
  const stalledRuleCount = Math.max(0, Number(rulePageMeta.stalledItems) || 0);
  const pausedRuleCount = Math.max(0, Number(rulePageMeta.pausedItems) || 0);
  const filteredRuleTotal = Math.max(0, Number(rulePageMeta.totalItems) || 0);
  const rulePagination = useServerPagination(isRuleGlobeView ? [] : orderedFilteredRules, filteredRuleTotal, rulePageRequest, {
    pageSize: rulePageSize,
    isReady: !isLoading && !!rulePageQuery.data,
  });
  const pagedRules = rulePagination.items;
  /**
   * 能不能拖：不在地球视图、没按资源筛、没在搜索。管理员看「全部用户」时，这一页的规则只要都是同一个人的
   * 也能拖（单人自用的面板就是这样）；混着几个人的不给拖，免得把别人的顺序一起挪了。
   */
  // 按个人分组筛 / 排的时候也不给拖：这一页不是那个分类的连续一段，拖完存回去的顺序会把别的规则挤乱。
  const useRuleSortingResult = useRuleSorting({ effectiveViewMode, filterResource, ruleSearchQuery, personalGroupFilter, personalGroupSortActive, user, filterUser, ruleCategory, pagedRules, rulePageQuery, ruleReorderPending, ruleOrder, reorderRulesMutation, rulePagination, utils, forwardGroupById, uiTheme });
  const { ruleSortingEnabled, desktopRuleGroups, ruleGroupSortables, ruleGroupSortingEnabled, ruleCardVisible, shouldGroupRuleCards, ruleSortable } = useRuleSortingResult;

  const useRuleSelectOptionHelpersResult = useRuleSelectOptionHelpers({ hosts, trafficBillingHostIds, trafficBillingTunnelIds, tunnelAvailabilityById, trafficBilling, trafficBillingForwardGroupIds });
  const { isTrafficBillingForwardGroup, getForwardGroupSelectName, renderTrafficMultiplierBadge, renderTrafficBillingResourceBadge, getHostName, getTunnelSelectName, getTunnelSelectText, renderTunnelSelectLabel, getHostOptionText, renderHostStatusLabel } = useRuleSelectOptionHelpersResult;
  const getForwardGroupSelectText = (group: any) => {
    const mode = forwardGroupModeOf(group);
    const billingText = isTrafficBillingForwardGroup(group) ? " / 按量计费资源" : "";
    if (isForwardChainGroup(group) || mode === "port") {
      const memberCount = mode === "port" ? forwardGroupDisplayMembers(group).length : Number(group?.members?.length || 0);
      const entryText = mode === "port" && memberCount > 1 ? ` / ${memberCount} 台入口` : "";
      return [getForwardGroupSelectName(group), formatTrafficMultiplier((group as any)?.trafficMultiplier)].join(" / ") + entryText + billingText;
    }
    return `${getForwardGroupSelectName(group)} / ${getForwardGroupKindLabel(group)} / ${group?.members?.length || 0} 成员${billingText}`;
  };
  const getForwardGroupConfigStatus = useCallback((group: any): "available" | "degraded" | "pending" | "unavailable" | "disabled" => (
    groupAvailabilityById.get(Number(group?.id || 0))?.status || "unavailable"
  ), [groupAvailabilityById]);
  // 下面 resolveRuleVisualStatus 在 ruleVisualStatuses 的 useMemo 里渲染时就会被调用，
  // 这个 const 必须定义在它前面：放在后面就是「Cannot access ... before initialization」（2.3.488 整页白屏）。
  /**
   * 这条规则经过的机器里掉线了的（名字）。入口机自己、隧道从入口到出口的每一跳、转发链的每台成员。
   * 转发组（多入口）不在这里管：组的运行状态已经按「几台在跑」分档了。
   */
  const getRuleOfflineHostNames = (rule: any): string[] => {
    const category = getRuleCategory(rule, forwardGroupById);
    const ids: number[] = [];
    if (category === "tunnel") {
      const tunnel = tunnelById.get(Number(rule?.tunnelId || 0));
      if (tunnel) ids.push(...getTunnelHopIds(tunnel));
    } else if (category === "chain") {
      const group = forwardGroupById.get(Number(rule?.forwardGroupId || 0));
      for (const member of (Array.isArray(group?.members) ? group.members : [])) ids.push(Number(member?.hostId || 0));
    } else if (!rule?.forwardGroupId) {
      ids.push(Number(rule?.hostId || 0));
    }
    const names: string[] = [];
    for (const id of new Set(ids.filter((id) => id > 0))) {
      const host = hostById.get(id);
      if (host && host.isOnline === false) names.push(String(host.name || `主机 #${id}`));
    }
    return names;
  };
  const useRuleVisualStatusesResult = useRuleVisualStatuses({ probeByRule, trafficByRule, forwardGroupById, getForwardGroupConfigStatus, forwardGroupsFetched, forwardGroupsError, getRuleOfflineHostNames, hosts, tunnels, filteredRules });
  const { ruleVisualStatuses, resolveRuleVisualStatus } = useRuleVisualStatusesResult;
  const getForwardGroupStatusText = (group: any) => {
    const status = getForwardGroupConfigStatus(group);
    if (status === "disabled") return "已停用";
    if (status === "available") return "可用";
    if (status === "degraded") return "部分可用";
    if (status === "pending") return "等待检测";
    return "不可用";
  };
  const renderForwardGroupSelectStatusDot = (group: any) => {
    const status = getForwardGroupConfigStatus(group);
    if (status === "disabled") return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden="true" />;
    if (status === "available") {
      return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" aria-hidden="true" />;
    }
    if (status === "unavailable") {
      return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-destructive/70 shadow-sm shadow-destructive/40" aria-hidden="true" />;
    }
    if (status === "degraded") return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--fx-warn)] shadow-sm" aria-hidden="true" />;
    return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--fx-warn)] shadow-sm" aria-hidden="true" />;
  };
  const renderForwardGroupSelectLabel = (group: any) => {
    const mode = forwardGroupModeOf(group);
    const memberCount = mode === "port" ? forwardGroupDisplayMembers(group).length : Number(group?.members?.length || 0);
    return (
      <span className="inline-flex min-w-0 items-center gap-2" title={`${getForwardGroupStatusText(group)} / ${getForwardGroupSelectText(group)}`}>
        {renderForwardGroupSelectStatusDot(group)}
        <span className="min-w-0 truncate">{getForwardGroupSelectName(group)}</span>
        {(isForwardChainGroup(group) || mode === "port") && renderTrafficMultiplierBadge((group as any).trafficMultiplier)}
        {renderTrafficBillingResourceBadge(isTrafficBillingForwardGroup(group))}
        {(mode === "failover" || (mode === "port" && memberCount > 1)) && (
          <span className="shrink-0 rounded border border-border/50 bg-background/60 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
            {memberCount} {mode === "port" ? "台入口" : "成员"}
          </span>
        )}
        <span className="sr-only">{getForwardGroupStatusText(group)}</span>
      </span>
    );
  };
  const useRenderTunnelRouteResult = useRenderTunnelRoute({ forwardGroupById, getForwardGroupSelectName, hosts });
  const { renderTunnelRoute } = useRenderTunnelRouteResult;

  const getRuleEntryHost = (rule: any) => {
    const directHost = hosts?.find((h: any) => Number(h.id) === Number(rule.hostId));
    if (directHost) return directHost;
    const tunnel = rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    if (tunnel && Number(tunnel.entryHostId) === Number(rule.hostId)) {
      return tunnel.entryHost || null;
    }
    return null;
  };

  const getRuleEntryHostName = (rule: any) => {
    const entryHost = getRuleEntryHost(rule);
    return entryHost?.name || getHostName(Number(rule.hostId));
  };

  const useSelfTestLinkTestNodeDataResult = useSelfTestLinkTestNodeData({ selfTestRuleDetail, selfTestRule, hosts, tunnelById, forwardGroupById, trafficByRule, getRuleEntryHost, targetGeoByAddress, getRuleEntryHostName });
  const { selfTestLinkTestNodeData } = useSelfTestLinkTestNodeDataResult;


  const useRuleTransferResourcesResult = useRuleTransferResources({ hosts, importResources, importScopeType, importResourceSearch, importResourceId, tunnelAvailabilityById, getForwardGroupConfigStatus, importManualText });
  const { selectedImportResource, manualImportValidation, filteredImportResources, renderTransferResourceOption } = useRuleTransferResourcesResult;

  const batchManage = useRuleBatchManage({ ...batchState, personalGroupFilter, ruleCategory, ruleSearchQuery, canUseSavedLocalForward, canUseGost, canUseForwardChain, canUseFailoverGroup, showCopyDialog, setShowCopyDialog, createOwnerUserId, telegramBotReady, canAdd, availablePortForwardGroups, supportedTunnels, availableForwardChainGroups, availableFailoverForwardGroups, invalidateRuleProbeStatuses, utils, fullRulesQuery, confirmDialog, selectedScopeQueryEnabled, selectedScopedRules, needsFullRuleList, baseScopedRules, ruleFilters, isRuleSupported, hosts, tunnels, forwardGroupById, tunnelById, nginxTunnelEnabled, selectedImportResource, user, manualImportValidation });
  const { openCopyDialog, transferSourceRules } = batchManage;
  const batchDialogLoaded = useLastShown(showCopyDialog, showCopyDialog ? true : null) ?? false;
  const getRuleOwnerName = (rule: any) => {
    const owner = userById.get(Number(rule.userId));
    return owner?.name || owner?.username || `用户 #${rule.userId}`;
  };

  /** 获取主机入口展示地址：优先展示自定义域名 / DDNS，最后回退自动检测 IP */
  const getForwardGroupName = (groupId: number) => {
    const group = forwardGroupById.get(Number(groupId));
    return group?.name || `${getForwardGroupRouteLabel(group)} #${groupId}`;
  };
  const getRuleResourceName = (rule: any) => {
    const forwardGroupId = Number(rule?.forwardGroupId || 0);
    if (forwardGroupId > 0) return getForwardGroupName(forwardGroupId);

    const tunnelId = Number(rule?.tunnelId || 0);
    if (tunnelId > 0) {
      return getTunnelSelectName(tunnelById.get(tunnelId) || { id: tunnelId });
    }

    return getRuleEntryHostName(rule);
  };
  const getForwardGroupMemberLabel = (member: any) => {
    if (member.memberType === "host") {
      return member.hostId ? getHostName(member.hostId) : "主机成员";
    }
    const tunnel = member.tunnelId ? tunnelById.get(Number(member.tunnelId)) : null;
    return tunnel ? `${tunnel.name} / ${getTunnelRouteText(tunnel, hosts)}` : member.tunnelId ? `隧道 #${member.tunnelId}` : "隧道成员";
  };
  const entryDomainForForwardGroup = (group: any | null | undefined) => {
    if (!group) return "";
    if (isForwardChainGroup(group) && group.entryGroupId) {
      const entryGroup = forwardGroupById.get(Number(group.entryGroupId)) || group.entryGroup;
      return String(entryGroup?.domain || "").trim();
    }
    return "";
  };

  const getRuleEntry = (rule: any): string => {
    return getRuleEntries(rule)[0]?.value || getHostEntryAddress(getRuleEntryHost(rule));
  };

  const getRuleEntries = (rule: any): EntryAddress[] => {
    const tunnel = rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    const tunnelEntries = getTunnelEntryAddresses(tunnel);
    const entries = tunnelEntries.length > 0 ? tunnelEntries : getHostEntryAddresses(getRuleEntryHost(rule));
    /*
      规则专属域名发布成功过（值非空）就排第一个：订阅里给客户端的就是它，复制也该复制它。
      原来的入口地址留在后面（卡片上是「+N」和悬停提示），换线路时对得上是哪台机器。
      规则上关了开关的不显示：订阅已经改回入口地址，不等 DNS 那边删完（和订阅组装同一口径）。
    */
    const entryDomain = String(rule?.entryDomain || "").trim();
    if (rule?.entryDomainEnabled === false || !entryDomain || !String(rule?.entryDomainValue || "").trim()) return entries;
    const rows: EntryAddress[] = [];
    pushUniqueEntryAddress(rows, "规则域名", entryDomain);
    for (const entry of entries) pushUniqueEntryAddress(rows, entry.label, entry.value);
    return rows;
  };

  const getTunnelEntryHostForDisplay = (tunnel: any | null | undefined, hostId: number) => {
    const id = Number(hostId || 0);
    return (hosts || []).find((host: any) => Number(host.id) === id)
      || (Array.isArray(tunnel?.hopHosts) ? tunnel.hopHosts.find((host: any) => Number(host?.id) === id) : null)
      || (Number(tunnel?.entryHost?.id || 0) === id ? tunnel.entryHost : null)
      || (Number(tunnel?.exitHost?.id || 0) === id ? tunnel.exitHost : null)
      || (Array.isArray(tunnel?.entryGroup?.members)
        ? tunnel.entryGroup.members.find((member: any) => Number(member?.host?.id || 0) === id)?.host
        : null);
  };

  const useRuleEntryAddressesResult = useRuleEntryAddresses({ forwardGroupById, getTunnelEntryHostForDisplay, hosts, tunnelById, entryDomainForForwardGroup });
  const { getTunnelEntryAddresses, getForwardChainEntryAddresses, getForwardGroupEntryAddresses, portEntryGroupOf, forwardGroupDisplayMembers } = useRuleEntryAddressesResult;

  /*
    卡片上入口只写第一个地址（专属域名排第一），后面的挤成「+N」。用户要挑着复制 IP 或域名，
    所以「+N」是个开关：点开把每个地址各自列一行，各带复制；再点收起。按规则 id 记，翻页不丢。
  */
  /*
    规则卡上线路组的 A / B 线路行平时收着（和别的卡一样高），点「择优 · 2 条」「主备 · 主线路」那枚才展开；
    展开后点哪一行进线路组编辑（用户 2026-11-03）。
  */
  const useRuleEntryExpansionResult = useRuleEntryExpansion({ tlsInboundById, forwardGroupById, getForwardChainEntryAddresses, getForwardGroupEntryAddresses, getRuleEntry });
  const { copyEntryAddress, copyTargetAddress, toggleEntryAddresses, toggleRuleLines, expandedEntryRuleIds, expandedLineRuleIds } = useRuleEntryExpansionResult;

  /*
    规则的状态点和主机、隧道、首页「需要关注」用同一枚 StatusDot：运行中是绿，不再是
    一颗会呼吸的青色。上一版三页三种点（青色脉冲 / 红 70% / 灰 30%），同一个「正常」
    在隧道页是绿、在规则页是青，眼睛每换一页要重新学一次。「待确认」走词汇表里的
    unknown（灰）：还没等到 Agent 回话不等于出了问题，琥珀留给真的降级。
  */
  const renderResolvedStatusDot = (visual: ReturnType<typeof resolveForwardRuleVisualStatus>) => (
    <span title={visual.title} className="inline-flex">
      <StatusDot health={ruleVisualHealth(visual)} size="large" label={visual.title} />
    </span>
  );

  const renderStatusDot = (rule: any) => {
    const visual = ruleVisualStatuses.get(Number(rule.id)) || resolveRuleVisualStatus(rule);
    return renderResolvedStatusDot(visual);
  };

  /** 表格里灰点的规则：名字下面一行写为什么没在运行（和卡片地址行右端那枚同一句），悬停看原文。 */
  const useRuleStateBadgesResult = useRuleStateBadges({ ruleVisualStatuses, resolveRuleVisualStatus, user, tlsInboundById });
  const { renderNotRunningReason, renderAdminManagedBadge, renderSniRuleBadge, renderEgressBadge } = useRuleStateBadgesResult;

  /** 两种入口方式。编辑时定死（要换就新建规则）。 */
  const useRuleEntryModeFieldsResult = useRuleEntryModeFields({ editingId, form, latestPortCheckRef, setPortStatus, setPortRangeError, setForm, sniChoices, usableForwardTypes, canUseSavedLocalForward, availablePortForwardGroups, canUseBillingHostLocalForward, availableTrafficBillingHosts, sniAvailableForTab, tlsInboundById, sniRouteKind, forwardGroupById, submitBlocker, selectedTlsInbound });
  const { renderEntryModeSwitch, renderSniEntryFields } = useRuleEntryModeFieldsResult;

  const useRuleTransferDisplayResult = useRuleTransferDisplay({ tlsInboundById, forwardGroupById, entryDomainForForwardGroup, getForwardChainEntryAddresses, getForwardGroupEntryAddresses, getRuleEntries, tunnelById, hosts, trafficByRule, hostById });
  const { getRuleTransferDisplay, getRuleHopNames } = useRuleTransferDisplayResult;

  /*
    卡片上的路径条：入口（资源名 + 地址）── 经过什么 ── 目标。

    替掉原来那一行等宽字 `入口 ⧉ → 目标`：358px 的屏上两个地址各剩十来个字符，读不出
    从哪到哪。现在两头各自一个节点，名字在上地址在下，中间那条线的颜色就是这条规则的
    状态，线中间的小药丸写转发工具和协议；隧道 / 转发链的中继画成线上的小圆点，名字写在
    药丸里。资源名从卡头的第二行挪到了这里 —— 它本来就是「入口」。
  */
  const useRuleTableTransferCellsResult = useRuleTableTransferCells({ getRuleTransferDisplay, copyEntryAddress, copyTargetAddress, forwardTypeDisplayLabel });
  const { renderForwardToolBadge, renderTableTransferEntry, renderTableTransferExit } = useRuleTableTransferCellsResult;

  const getRuleKernelForwardWarning = (rule: any) => buildKernelForwardWarning({
    rule,
    host: getRuleEntryHost(rule),
    group: rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null,
    hosts: hosts || [],
    hostById,
    forwardGroupById,
  });

  // 走的 NEX 隧道上有节点的 FXP 握不上当前协议：规则 tcping 能通、流量全超时，要直接标出来。
  const useRuleWarningBadgesResult = useRuleWarningBadges();
  const { renderKernelForwardWarningBadge, renderTunnelFxpIssueBadge, renderPortWarningBadge } = useRuleWarningBadgesResult;
  /**
   * 「在订阅里」这一小块。没绑就什么都不显示 —— 大多数转发跟订阅无关，
   * 给每一行都挂个「未加入订阅」只是噪音。
   */
  const useRuleSourceBadgesResult = useRuleSourceBadges({ subscriptionAllowed, proxyNodeNameById, driftedRuleIds, hostById, setPolicyRuleId });
  const { renderSubscriptionBadge, renderFailoverLineBadge, renderSubscriptionMark } = useRuleSourceBadgesResult;

  /**
   * 线路徽标。
   *
   * `hideRoute` 给那些**卡上已经画了 Flow** 的地方用：Flow 里已经有
   * `入口 → HK entry 01 → JP exit 02 → 目标` 这条完整路径，这里再写一遍
   * 「HK entry 01 → / Multi-exit group；出口：…」就是同一件事说两遍 ——
   * 实测一张隧道规则卡因此从 264px 涨到 435px，多出来的全是重复。
   *
   * 徽标本身要留：它说的是「用什么转发」，不是「经过哪儿」，Flow 回答不了。
   */
  const useRuleRouteBadgeResult = useRuleRouteBadge({ tunnelById, forwardGroupById, getRuleKernelForwardWarning, renderKernelForwardWarningBadge, renderTunnelFxpIssueBadge, renderPortWarningBadge, nginxTunnelEnabled, forwardTypeDisplayLabel, renderSubscriptionBadge, renderForwardToolBadge, hosts, renderTunnelRoute });
  const { renderUnsupportedHint, renderRouteBadge } = useRuleRouteBadgeResult;

  const useRuleTrafficCellsResult = useRuleTrafficCells({ dailyTrafficByRule, totalTrafficByRule, probeByRule });
  const { renderTableRuleDailyTraffic, renderTableRuleTotalTraffic, renderTableRuleLatency } = useRuleTrafficCellsResult;

  /*
    规则卡、表格行上的操作。原来五个图标常驻（延迟、自测、重置、编辑、删除）—— 十二条规则
    就是六十个图标，而且得记住听诊器是「自测」、转圈的箭头是「重置统计」。常用的两个带字
    放外面，其余收进 ···；删除永远在菜单最后、红色、隔一条线。
  */
  /*
    卡片右上角只有一个 ···（menuOnly），表格行保留「诊断 / 编辑」常驻 + ···。
    原来卡片底部还有一行「诊断 / 编辑 / ···」—— 和右上角的 ··· 是同一组操作画了两遍，
    每张卡为此多 60px，十六条规则要翻九屏。
  */
  // 延迟记录、导出故障包、查看拓扑都在「诊断」框里（页签和底部按钮），菜单里不再单列。
  // tableCompact：精简的表里操作列只放「开关 · 编辑 · ···」（和老版本表格样稿一致），诊断进 ··· 第一项
  const useRuleActionsRendererResult = useRuleActionsRenderer({ forwardGroupById, resetTrafficMutation, user, setSelfTestRule, ruleCardUi, confirmResetTraffic, confirmDeleteRule });
  const { renderRuleActions } = useRuleActionsRendererResult;

  const useRuleViewHandlersResult = useRuleViewHandlers({ setViewMode, setRuleCardSize, effectiveViewMode, effectiveRuleCardSize, setRuleCategory, filterResource, setFilterResource, filterResourceStorageKey, setRuleResourceMenuType, setFilterUser, filterUserStorageKey, setRuleResourceMenuOpen, setRuleSearchQuery, handlePersonalGroupFilterChange, user, setRulePageSize, setRuleGroupCollapsed });
  const { displayMode, toggleRuleGroupCollapsed, handleDisplayModeChange, handleRuleCategoryChange, handleFilterUserChange, handleFilterResourceChange, handleRulePageSizeChange, clearRuleFilters } = useRuleViewHandlersResult;

  /*
    「深空」主题：规则不画成一张张卡，画成一整块面板里的一行行（RuleRow）；四种网格换成同一个列表容器。
    手机「全部」分组外面那层（一组一组的 section）照旧是普通的竖排，列表容器只套在每组的行外面。
  */
  const useRuleGridRenderingResult = useRuleGridRendering({ uiTheme, effectiveRuleCardSize, effectiveViewMode, displayMode, ruleCategory, ruleGroupCollapsed, toggleRuleGroupCollapsed });
  const { groupedRuleMobileGridClass, groupedRuleCardGridClass, sortableRuleMobileGridClass, sortableRuleCardGridClass, denseRuleRows, ruleContentTransitionKey, renderRuleGroupHeader, groupedRuleMobileSectionsClass, renderRuleGroupIcon } = useRuleGridRenderingResult;

  /*
    表格的列定义只写一遍（标准布局重构工作包一）：colgroup、表头、单元格三处都从这一个数组出。
    原来 13～14 列手写三遍、最小宽度 1610～1764px，1366 宽的屏幕必定横滚。现在：
    - 状态点并进「规则」列名字前面；协议、所属人并进名字下面那行小字
    - 「链路」徽章并进「所属资源」
    - 累计 / 24H 合成一列「流量」
    八列 + 可选的排序手柄，列宽合计 1016px（table-fixed 下列宽之和就是表格的实际宽度），1366 宽、侧栏展开时内容区约 1100px，不横滚；table-fixed 下 col 的宽度是比例，窗口够宽时按比例放大。
    这套并列只在精简布局下用；标准布局照旧原来那 13～14 列（数组的另一支），一列一件事。
  */
  const useRuleTableColumnsResult = useRuleTableColumns({ compactLayout, isRuleSupported, getRuleProtocolKey, user, getRuleOwnerName, renderStatusDot, forwardGroupById, renderNotRunningReason, protocolUnsupportedLabel, renderAdminManagedBadge, personalGroupSortActive, toggleRuleSortByGroup, personalGroups, getRuleResourceName, renderRouteBadge, renderFailoverLineBadge, renderTableTransferEntry, renderTableTransferExit, totalTrafficByRule, dailyTrafficByRule, setSelfTestRule, renderTableRuleDailyTraffic, renderTableRuleTotalTraffic, renderTableRuleLatency, renderRuleEnabledSwitch, renderRuleActions, ruleColumnSettings, ruleSortingEnabled });
  const { shownRuleTableColumns, ruleTableMinWidth, ruleTableColumnCount } = useRuleTableColumnsResult;
  const renderRuleTableRow = (rule: any, sortable?: RuleSortableRenderState) => {
    const supported = isRuleSupported(rule);
    return (
      <TableRow
        key={rule.id}
        {...(sortable?.itemProps || {})}
        className={cn(
          "group/sortable animate-in fade-in-0 duration-150",
          !supported && "opacity-70",
          sortable?.isDragging && "opacity-55",
          sortable?.isDropTarget && "bg-primary/5",
        )}
        title={!supported ? unsupportedProtocolTitle : undefined}
      >
        {sortable && (
          <TableCell className="w-[44px] px-2 py-2">
            <SortableDragHandle
              dragHandleProps={sortable.handleProps}
              visible={sortable.isDragging}
              busy={ruleReorderPending}
              className="mx-auto"
            />
          </TableCell>
        )}
        {shownRuleTableColumns.map((column) => (
          <TableCell key={column.key} className={cn("px-3 py-2", column.cellClassName)}>
            {column.cell(rule)}
          </TableCell>
        ))}
      </TableRow>
    );
  };

  /** 「全部」里一组规则卡：这一组能拖就包一层拖拽（手机竖着拖，桌面按格子拖），不能拖照旧。 */
  const renderRuleGroupItems = (group: (typeof desktopRuleGroups)[number], collapsed: boolean, mobile: boolean) => {
    const sortable = ruleGroupSortables[group.type];
    if (!ruleGroupSortingEnabled(group.type)) {
      return (
        <RuleGroupItems open={!collapsed} layout={false} className={mobile ? groupedRuleMobileGridClass : groupedRuleCardGridClass}>
          {group.rules.map((rule) => (ruleCardVisible(rule) ? renderRuleCard(rule) : <RuleCardPlaceholder key={rule.id} />))}
        </RuleGroupItems>
      );
    }
    // 外层只管折叠；带 rule-card-grid-static 的网格会把子元素的 transform 锁死，拖不动，这里用普通网格。
    return (
      <RuleGroupItems open={!collapsed} layout={false} className="">
        <SortableReorderContext
          sortable={sortable}
          ids={group.rules.map((rule) => Number(rule.id))}
          strategy={mobile ? "vertical" : "rect"}
          restrictToList={mobile}
        >
          <div className={mobile ? sortableRuleMobileGridClass : sortableRuleCardGridClass}>
            {group.rules.map((rule) => (
              <SortableItem key={rule.id} id={Number(rule.id)} disabled={sortable.disabled}>
                {(state) => (ruleCardVisible(rule) ? renderRuleCard(rule, state) : <RuleCardPlaceholder />)}
              </SortableItem>
            ))}
          </div>
        </SortableReorderContext>
      </RuleGroupItems>
    );
  };

  /*
    规则卡本身是模块级的 RuleCard（React.memo，见文件前面那段说明）。这里只做两件事：
      · ruleCardUi：引用永远不变的转发器，调到的是这一轮渲染里最新的那些函数（ruleCardUiRef 每轮重新指一次）。
        卡片没重画时，它上面「编辑」「开关」这些按钮拿着的也还是最新的 openEdit / toggleRuleEnabled。
      · renderRuleCard：按这条规则把 RuleCard 要的派生值算好（原始值），和 ruleCardPage 一起交给它。
  */
  ruleCardUiRef.current = {
    isRuleSupported,
    getRuleProtocolKey,
    protocolUnsupportedLabel,
    getRuleTransferDisplay,
    getRuleHopNames,
    getRuleResourceName,
    getRuleOwnerName,
    renderAdminManagedBadge,
    renderSniRuleBadge,
    renderEgressBadge,
    renderKernelForwardWarningBadge: (rule) => renderKernelForwardWarningBadge(getRuleKernelForwardWarning(rule)),
    renderPortWarningBadge,
    renderTunnelFxpIssueBadge: (rule) => renderTunnelFxpIssueBadge(tunnelById.get(Number(rule.tunnelId))),
    renderSubscriptionBadge: (rule) => renderSubscriptionBadge(rule, "card"),
    renderSubscriptionMark,
    renderRuleActions: (rule) => renderRuleActions(rule, true),
    renderRuleEnabledSwitch,
    copyEntryAddress: (rule, entryValue) => { void copyEntryAddress(rule, entryValue); },
    copyTargetAddress: (text) => { void copyTargetAddress(text); },
    toggleEntryAddresses,
    toggleRuleLines,
    openRulePolicy: (ruleId) => setPolicyRuleId(ruleId),
    openEdit,
    toggleRuleEnabled,
  };
  const ruleCardIsAdmin = user?.role === "admin";
  const ruleCardCompact = effectiveRuleCardSize === "compact";
  const ruleCardResetPending = resetTrafficMutation.isPending;
  const ruleCardResetVariables = resetTrafficMutation.variables;
  const ruleCardPage = useMemo<RuleCardPage>(() => ({
    compact: ruleCardCompact,
    compactLayout,
    isAdmin: ruleCardIsAdmin,
    ruleReorderPending,
    forwardGroupById,
    ui: ruleCardUi,
    helperInputs: [
      hosts,
      hostById,
      tunnelById,
      tlsInboundById,
      userById,
      subscriptionAllowed,
      proxyNodeNameById,
      driftedRuleIds,
      isRuleSupported,
      getRuleProtocolKey,
      protocolUnsupportedLabel,
      ruleCardResetPending,
      ruleCardResetVariables,
    ],
  }), [
    compactLayout,
    driftedRuleIds,
    forwardGroupById,
    getRuleProtocolKey,
    hostById,
    hosts,
    isRuleSupported,
    protocolUnsupportedLabel,
    proxyNodeNameById,
    ruleCardCompact,
    ruleCardIsAdmin,
    ruleCardResetPending,
    ruleCardResetVariables,
    ruleCardUi,
    ruleReorderPending,
    subscriptionAllowed,
    tlsInboundById,
    tunnelById,
    userById,
  ]);

  const ruleCardSources: RuleCardDerivedSources = {
    visualDisplay: (ruleId) => ruleVisualStatuses.get(ruleId),
    resolveVisual: resolveRuleVisualStatus,
    hostById,
    routeBoardByRule,
    totalTrafficByRule,
    dailyTrafficByRule,
    sparkByRule,
    probeByRule,
    expandedEntryRuleIds,
    expandedLineRuleIds,
    isProbeFresh: isLinkProbeFresh,
    probeAgeText: formatProbeAge,
  };
  const RuleItem = denseRuleRows ? RuleRow : RuleCard;
  const renderRuleCard = (rule: RuleCardRule, sortable?: RuleSortableRenderState) => (
    <RuleItem
      key={rule.id}
      rule={rule}
      sortable={sortable}
      page={ruleCardPage}
      personalGroupNames={personalGroupNamesOf(rule)}
      {...buildRuleCardDerivedProps(rule, ruleCardSources)}
    />
  );

  /*
    「新建规则」放在搜索栏那一行的最右边（用户要的位置）：搜索、筛选、新建都是「对这个列表
    做事」，并排一行；页头只剩视图切换和 ···。手机上按钮带字，不缩成一个「＋」。
  */
  // 精简：「新建规则」上到页头右边，桌面上分类条和筛选行并排（fx-list-controls）；手机上搜索行收成分类条右边一枚图标。
  // 标准布局下这一页整页按原来的样子（页面根带 data-fx-std-page，compact.css 让出去）。
  const mergeListControls = compactLayout;
  const collapsePhoneSearch = compactLayout && isMobile;
  // 手机 + 标准：页头右边那个「···」压在走势线上不好看（用户圈出来的），挪到下面状态点那一行的右边、不描边
  const overflowInHeader = mergeListControls || !isMobile;
  const showSearchRow = !collapsePhoneSearch || phoneSearchOpen || ruleSearchQuery.length > 0;
  const createRuleAction = (
        rulePermissionLoading ? (
          <Button disabled className="fx-row-action h-9 shrink-0 gap-1.5 rounded-full px-3.5">
            <Loader2 className="h-4 w-4 animate-spin" />
            权限加载中
          </Button>
        ) : canAdd ? (
          <Button
            onClick={() => openCreate()}
            className="fx-row-action h-9 shrink-0 gap-1.5 rounded-full px-3.5"
            disabled={!canCreateRule}
            aria-label="新建规则"
            title={!canCreateRule ? "暂无可用转发资源" : "新建规则"}
          >
            <Plus className="h-4 w-4" />
            新建规则
          </Button>
        ) : (
          <Button disabled className="fx-row-action h-9 shrink-0 gap-1.5 rounded-full px-3.5" aria-label="新建规则" title="需要管理员授权后才能新建规则">
            <Plus className="h-4 w-4" />
            新建规则
          </Button>
        )
  );

  /* 页头右边的「···」（批量管理、重置数据）：桌面 / 精简在标题那一行右边，手机 + 标准挪到状态点那一行右边（不描边） */
  const ruleOverflowMenu = (variant: "outline" | "ghost") => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant={variant} size="icon" aria-label="更多规则操作"><span aria-hidden="true">•••</span></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setBatchAddOpen(true)} disabled={!canAdd || batchAddHosts.length === 0}><ListPlus className="h-4 w-4" />批量添加</DropdownMenuItem>
              <DropdownMenuItem onSelect={openCopyDialog} disabled={!transferSourceRules.length && !canAdd}><ClipboardCopy className="h-4 w-4" />批量管理</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRuleGroupManagerOpen(true)}><FolderCog className="h-4 w-4" />管理分组</DropdownMenuItem>
              <DropdownMenuItem onSelect={toggleRuleSortByGroup} disabled={personalGroups.length === 0}>
                {personalGroupSortActive ? <Check className="h-4 w-4" /> : <span className="h-4 w-4" aria-hidden="true" />}按分组排序
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={toggleRuleGroupColumn}>
                {showRuleGroupColumn ? <Check className="h-4 w-4" /> : <span className="h-4 w-4" aria-hidden="true" />}列表显示分组列
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => confirmResetTraffic({ scope: "all" })} disabled={visibleRuleIdsForMetrics.length === 0 || resetTrafficMutation.isPending}><RotateCcw className="h-4 w-4" />重置数据</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
  );

  return (
    <div className="space-y-6" data-fx-std-page={compactLayout ? undefined : ""} data-fx-compact-page={compactLayout ? "" : undefined}>
      <RuleBatchAddDialog
        open={batchAddOpen}
        onOpenChange={setBatchAddOpen}
        hosts={batchAddHosts}
        forwardTypes={usableForwardTypes}
        ownerUserId={createOwnerUserId}
        onCreated={() => {
          void utils.rules.list.invalidate();
          void utils.rules.listPage.invalidate();
          void utils.rules.mapItems.invalidate();
          void utils.rules.listSummary.invalidate();
        }}
      />
      {/*
        data-fx-std-page：标准布局下这一页整页按原来的标准画（compact.css 让出去）；精简下不带，
        分类条和搜索那一行并排、筛选下拉收进一个按钮、「新建规则」上到页头右边。
      */}
      <WorkspaceHeader title="转发规则" status={
          /*
            页头（第三轮样稿）：标题下一行「5 / 5 已启用」，再一行状态点「● 运行中 3 · ● 未运行 2 · ● 已停用 0」；
            标题右边一条近 24H 的小走势，走势下面是这 24 小时的进出总数。
            原来页头下面还有一条三格的累计 / 24H 统计带，手机第一屏为此让出 130px。
          */
          <span className="text-meta tabular-nums text-muted-foreground">
            <AnimatedStatValue
              as="span"
              value={`${activeCount} / ${filteredRuleTotal} 已启用`}
              loading={rulesHeaderLoading}
              cacheKey={`rules.header.active.${trafficTotalsCacheScope}`}
              fallbackValue="0 / 0 已启用"
            />
          </span>
      } chips={
          <HeaderStatusChips items={[
            { key: "running", label: "运行中", count: runningRuleCount, tone: "healthy" },
            { key: "stalled", label: "未运行", count: stalledRuleCount, tone: "warn" },
            { key: "paused", label: "已暂停", count: pausedRuleCount, tone: "warn", onlyWhenPresent: true },
            { key: "disabled", label: "已停用", count: Math.max(0, filteredRuleTotal - activeCount), tone: "off" },
          ]} />
      } chipsAside={overflowInHeader ? undefined : ruleOverflowMenu("ghost")} aside={
          <HeaderSpark values={dailySpark.values} title="近 24 小时流量走势" caption={<>
            {"近 24H ↓ "}
            <AnimatedStatValue as="span" value={formatBytes(dailyTrafficTotals.bytesIn)} loading={dailyTrafficTotalsLoading} fallbackValue="0 B"
              cacheKey={`rules.traffic.${trafficTotalsCacheScope}.daily.bytesIn`} />
            {" · ↑ "}
            <AnimatedStatValue as="span" value={formatBytes(dailyTrafficTotals.bytesOut)} loading={dailyTrafficTotalsLoading} fallbackValue="0 B"
              cacheKey={`rules.traffic.${trafficTotalsCacheScope}.daily.bytesOut`} />
          </>} />
      } actions={<>
          <ViewModeToggle className="sm:hidden md:flex"
            value={displayMode}
            onChange={handleDisplayModeChange}
            items={[
              /* 精简下桌面只有表和 3D 图两种（卡片那两档是标准布局的） */
              ...(compactLayout ? [] : [
                { value: "compact" as const, label: "精简卡片", icon: Rows3 },
                { value: "standard" as const, label: "标准卡片", icon: LayoutGrid },
              ]),
              { value: "table", label: "列表", icon: List },
              { value: "globe", label: "3D 流量转发图", icon: Globe, onHover: prefetchReactGlobe },
            ]}
          />
          {effectiveViewMode === "table" && !isMobile ? <TableColumnSettingsMenu settings={ruleColumnSettings} /> : null}

          {overflowInHeader ? ruleOverflowMenu("outline") : null}
          {mergeListControls ? createRuleAction : null}
      </>} />

      <FreezeWhile frozen={showDialog || showCopyDialog} render={() => <>
      {!canAdd && !rulePermissionLoading && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--fx-warn-soft)] border border-[color-mix(in_srgb,var(--fx-warn)_20%,transparent)] text-sm text-[var(--fx-warn-text)]">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>当前账号没有添加转发规则的权限</span>
        </div>
      )}

      {(user?.role === "admin" || ruleScopeTotal > 0 || hasActiveRuleFilter || (rules && rules.length > 0)) && (
        <div className="fx-list-controls space-y-3">
          {/*
            第一行：分类条，和主机管理、链路管理顶上那条一样的分段条（2026-10-09 用户要统一）；
            第二行：小搜索框、筛选、最右边「新建规则」。
            这里的 Tabs 只管分类条本身，不带 TabsContent：列表下面照旧按 ruleCategory 过滤。
          */}
          <div className="fx-tabs-row">
          <Tabs value={ruleCategory} onValueChange={handleRuleCategoryChange}>
            <SlidingTabsList
              items={ruleCategoryTabItems}
              activeValue={ruleCategory}
              ariaLabel="转发规则分类"
            />
          </Tabs>
          {collapsePhoneSearch ? (
            <SearchToggle
              open={phoneSearchOpen}
              active={ruleSearchQuery.length > 0 || hasActiveUserFilter || filterResource !== "all" || personalGroupFilter !== null}
              onToggle={() => setPhoneSearchOpen((value) => !value)}
            />
          ) : null}
          </div>
          {showSearchRow ? (
          <FilterToolbar
            activeCount={Number(hasActiveUserFilter) + Number(filterResource !== "all") + Number(personalGroupFilter !== null)}
            collapsed={mergeListControls}
            action={mergeListControls ? undefined : createRuleAction}
            search={
            <div className="relative w-full">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={ruleSearchQuery}
                onChange={(event) => setRuleSearchQuery(event.target.value)}
                aria-label="搜索转发规则" placeholder="搜索端口、IP、备注"
                className="fx-search-pill w-full pr-9"
              />
              {ruleSearchQuery ? (
                <button
                  type="button"
                  aria-label="清空搜索"
                  className="absolute right-2 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => setRuleSearchQuery("")}
                >
                  <XCircle className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          }>
            {user?.role === "admin" && (
              <Select value={filterUser} onValueChange={handleFilterUserChange}>
                <SelectTrigger aria-label="按用户筛选规则" className="h-8 w-full text-xs sm:w-[160px]">
                  <SelectValue placeholder="我的规则" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="self">我的规则</SelectItem>
                  <SelectItem value="all">所有用户</SelectItem>
                  {(users || []).map((item: any) => (
                    <SelectItem key={item.id} value={String(item.id)}>
                      {item.name || item.username}
                      {item.displayRemark ? ` · ${item.displayRemark}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <DropdownMenu open={ruleResourceMenuOpen} onOpenChange={setRuleResourceMenuOpen} modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 w-full justify-between px-3 text-xs font-normal sm:w-[190px]"
                >
                  {(() => {
                    const selected = parseRuleResourceFilter(filterResource);
                    if (!selected.type) return "所有链路";
                    if (!selected.id) return `全部${ruleTransferScopeLabels[selected.type]}`;
                    const resource = getRuleFilterResources(selected.type).find((item: any) => Number(item.id) === selected.id);
                    return resource?.name || `${ruleTransferScopeLabels[selected.type]} #${selected.id}`;
                  })()}
                  <ChevronRight className="h-3.5 w-3.5 rotate-90 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[min(34rem,calc(100vw-2rem))] p-1">
                <div className="grid min-h-[13rem] grid-cols-[8.5rem_minmax(0,1fr)]">
                  <div className="border-r border-border/60 p-1">
                    <button
                      type="button"
                      onClick={() => handleFilterResourceChange("all")}
                      className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs transition-colors ${filterResource === "all" ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                    >
                      <LayoutGrid className="h-3.5 w-3.5" />
                      全部
                    </button>
                    {ruleTransferScopeOptions.map((option) => {
                      const Icon = option.value === "local" ? ArrowRightLeft : option.value === "tunnel" ? Network : option.value === "chain" ? GitBranch : Layers3;
                      const active = ruleResourceMenuType === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onMouseEnter={() => setRuleResourceMenuType(option.value)}
                          onFocus={() => setRuleResourceMenuType(option.value)}
                          onClick={() => setRuleResourceMenuType(option.value)}
                          className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs transition-colors ${active ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {option.label}
                          <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      );
                    })}
                  </div>
                  <div className="min-w-0 p-1">
                    <button
                      type="button"
                      onClick={() => handleFilterResourceChange(ruleResourceMenuType)}
                      className={`flex h-8 w-full items-center rounded px-2 text-left text-xs font-medium transition-colors ${filterResource === ruleResourceMenuType ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                    >
                      全部{ruleTransferScopeLabels[ruleResourceMenuType]}
                    </button>
                    <div className="mt-1 max-h-64 overflow-y-auto">
                      {getRuleFilterResources(ruleResourceMenuType).length > 0 ? getRuleFilterResources(ruleResourceMenuType).map((resource: any) => {
                        const value = `${ruleResourceMenuType}:${Number(resource.id)}` as RuleResourceFilter;
                        const detail = ruleResourceMenuType === "tunnel"
                          ? getTunnelRouteText(resource, hosts || [])
                          : resource?.domain || resource?.displayRemark || resource?.remark || resource?.description || "";
                        return (
                          <button
                            key={value}
                            type="button"
                            onClick={() => handleFilterResourceChange(value)}
                            className={`flex min-h-9 w-full flex-col justify-center rounded px-2 text-left transition-colors ${filterResource === value ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                          >
                            <span className="truncate text-xs font-medium">{resource?.name || `${ruleTransferScopeLabels[ruleResourceMenuType]} #${resource?.id}`}</span>
                            {detail ? <span className="truncate text-[11px] text-muted-foreground">{detail}</span> : null}
                          </button>
                        );
                      }) : (
                        <div className="px-2 py-6 text-center text-xs text-muted-foreground">暂无可筛选的{ruleTransferScopeLabels[ruleResourceMenuType]}</div>
                      )}
                    </div>
                  </div>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
            {/* 个人分组：全部 → 自己的组（按管理分组里的顺序）→ 未分组；旁边那枚是「管理分组」 */}
            <div className="flex w-full items-center gap-1.5 sm:w-auto">
              <Select
                value={personalGroupFilter === null ? "all" : String(personalGroupFilter)}
                onValueChange={(value) => handlePersonalGroupFilterChange(value === "all" ? null : Number(value))}
              >
                <SelectTrigger aria-label="按个人分组筛选规则" className="h-8 min-w-0 flex-1 text-xs sm:w-[150px] sm:flex-none">
                  <SelectValue placeholder="全部分组" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部分组{personalGroupsQuery.data ? ` · ${personalGroupsQuery.data.total}` : ""}</SelectItem>
                  {personalGroups.map((group) => (
                    <SelectItem key={group.id} value={String(group.id)}>{group.name} · {group.count}</SelectItem>
                  ))}
                  <SelectItem value="0">未分组{personalGroupsQuery.data ? ` · ${personalGroupsQuery.data.ungrouped}` : ""}</SelectItem>
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" title="管理分组" aria-label="管理分组" onClick={() => setRuleGroupManagerOpen(true)}>
                <FolderCog className="h-4 w-4" />
              </Button>
            </div>
            <Select value={String(rulePageSize)} onValueChange={handleRulePageSizeChange}>
              <SelectTrigger aria-label="每页数量" className="h-8 w-full text-xs sm:w-[120px]">
                <SelectValue placeholder="每页数量" />
              </SelectTrigger>
              <SelectContent>
                {RULE_PAGE_SIZE_OPTIONS.map((pageSize) => (
                  <SelectItem key={pageSize} value={String(pageSize)}>
                    每页 {pageSize} 条
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterToolbar>
          ) : null}
        </div>
      )}

      <SectionTransition transitionKey={ruleContentTransitionKey}>
      {isLoading || !ruleStatusReady || (filteredRules.length === 0 && !scopedRulesReady) ? (
        // 列表还没就绪（刚换进来、换页、换筛选）时不能画「没有匹配的规则」：那一帧是空的，不是真没有（用户 2026-11-03 录屏）
        <DataSectionLoading label={isLoading || !scopedRulesReady ? "正在加载转发规则" : "正在加载规则状态"} />
      ) : filteredRules.length > 0 ? (
        <>
          {effectiveViewMode === "globe" ? (
            (!hosts || !tunnels || !forwardGroups) ? (
              <DataSectionLoading label="正在加载转发流量地图" />
            ) : (
              <Suspense fallback={<DataSectionLoading label="正在加载转发流量地图" />}><RuleTrafficGlobe
                rules={filteredRules}
                hosts={hosts || []}
                tunnels={tunnels || []}
                forwardGroups={forwardGroups || []}
                trafficByRule={trafficByRule}
                trafficRangeLabel={trafficRangeLabel}
                targetGeoByAddress={targetGeoByAddress}
                targetGeoLookupReady={targetGeoLookupReady}
                onEditRule={openEdit}
              /></Suspense>
            )
          ) : effectiveViewMode === "card" ? (
            <RuleCardModeTransition mode={effectiveRuleCardSize}>
              {shouldGroupRuleCards ? (
                <AutoAnimateContainer className="space-y-5">
                  {desktopRuleGroups.map((group) => {
                    const collapsed = !!ruleGroupCollapsed[group.type];
                    return (
                      <section key={group.type} className="space-y-2">
                        {renderRuleGroupHeader(group)}
                        {renderRuleGroupItems(group, collapsed, false)}
                      </section>
                    );
                  })}
                </AutoAnimateContainer>
              ) : (
                <SortableReorderContext sortable={ruleSortable} ids={pagedRules.map((rule: any) => Number(rule.id))} strategy="rect">
                  <div className={sortableRuleCardGridClass}>
                    {pagedRules.map((rule: any) => (
                      <SortableItem key={rule.id} id={Number(rule.id)} disabled={ruleSortable.disabled}>
                        {(sortable) => (ruleCardVisible(rule) ? renderRuleCard(rule, ruleSortingEnabled ? sortable : undefined) : <RuleCardPlaceholder />)}
                      </SortableItem>
                    ))}
                  </div>
                </SortableReorderContext>
              )}
            </RuleCardModeTransition>
          ) : (
            <>
              <RuleCardModeTransition mode={effectiveRuleCardSize} className="sm:hidden">
                {shouldGroupRuleCards ? (
                  <AutoAnimateContainer layout={false} className={groupedRuleMobileSectionsClass}>
                    {desktopRuleGroups.map((group) => {
                      const collapsed = !!ruleGroupCollapsed[group.type];
                      return (
                        <section key={group.type} className="space-y-2">
                          {renderRuleGroupHeader(group)}
                          {renderRuleGroupItems(group, collapsed, true)}
                        </section>
                      );
                    })}
                  </AutoAnimateContainer>
                ) : (
                  <SortableReorderContext sortable={ruleSortable} ids={pagedRules.map((rule: any) => Number(rule.id))} strategy="vertical" restrictToList>
                    <div className={sortableRuleMobileGridClass}>
                      {pagedRules.map((rule: any) => (
                        <SortableItem key={rule.id} id={Number(rule.id)} disabled={ruleSortable.disabled}>
                          {(sortable) => (ruleCardVisible(rule) ? renderRuleCard(rule, ruleSortingEnabled ? sortable : undefined) : <RuleCardPlaceholder />)}
                        </SortableItem>
                      ))}
                    </div>
                  </SortableReorderContext>
                )}
              </RuleCardModeTransition>
              <Card className="hidden border-border bg-card sm:block">
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table className="fx-rules-table table-fixed" style={{ minWidth: ruleTableMinWidth }}>
                      <colgroup>
                        {ruleSortingEnabled && <col className="w-[44px]" />}
                        {shownRuleTableColumns.map((column) => <col key={column.key} style={{ width: column.width }} />)}
                      </colgroup>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          {ruleSortingEnabled && <TableHead className="w-[44px] px-2" aria-label="排序" />}
                          {shownRuleTableColumns.map((column) => (
                            <TableHead key={column.key} className={cn("relative whitespace-nowrap", column.headClassName)}>
                              {column.head}
                              {column.key !== "actions" ? (
                                <TableColumnResizeHandle settings={ruleColumnSettings} column={column.resolved} label={RULE_TABLE_COLUMN_LABELS[column.key] ?? column.key} />
                              ) : null}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      {shouldGroupRuleCards ? (
                        <TableBody>
                          {desktopRuleGroups.map((group) => {
                            const collapsed = !!ruleGroupCollapsed[group.type];
                            return (
                              <Fragment key={group.type}>
                                <TableRow className="border-border/40 bg-muted/35 hover:bg-muted/50">
                                  <TableCell colSpan={ruleTableColumnCount} className="p-1">
                                    {renderRuleGroupHeader(group, true)}
                                  </TableCell>
                                </TableRow>
                                {!collapsed && group.rules.map((rule: any) => renderRuleTableRow(rule))}
                              </Fragment>
                            );
                          })}
                        </TableBody>
                      ) : (
                        <SortableReorderContext sortable={ruleSortable} ids={pagedRules.map((rule: any) => Number(rule.id))} strategy="vertical" restrictToList>
                          <TableBody>
                            {pagedRules.map((rule: any) => (
                              <SortableItem key={rule.id} id={Number(rule.id)} disabled={ruleSortable.disabled} itemKind="row">
                                {(sortable) => renderRuleTableRow(rule, ruleSortingEnabled ? sortable : undefined)}
                              </SortableItem>
                            ))}
                          </TableBody>
                        </SortableReorderContext>
                      )}
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
          <PersistentPagination pagination={rulePagination} itemName="条规则" />
        </>
      ) : (
        <Card className="border-border bg-card">
          <CardContent className="p-0">
            {/*
              列表没读到时不能画成「暂无转发规则」。转发页是这套面板的主页，那句话意味着
              「你的转发全没了」—— 看到的人第一反应是去重建，而实际上一条都没少。
            */}
            {rulePageQuery.error && !rules ? (
              <DataSectionError
                className="border-0 bg-transparent"
                label="转发规则"
                error={rulePageQuery.error}
                retrying={rulePageQuery.isFetching}
                onRetry={() => { void rulePageQuery.refetch(); }}
                minHeight="min-h-[260px]"
              />
            ) : (rules && rules.length > 0) || ruleScopeTotal > 0 || hasActiveRuleFilter ? (
              <EmptyState icon={<Filter className="h-10 w-10 mb-3 opacity-30" />} title={<>没有匹配的规则</>} description={<>尝试调整筛选条件</>} actions={<>{hasActiveRuleFilter && (
                  <Button type="button" variant="outline" className="gap-2" onClick={clearRuleFilters}>
                    <XCircle className="h-4 w-4" />
                    清除筛选
                  </Button>
                )}</>} />
            ) : (
              <EmptyState icon={<ArrowRightLeft className="h-8 w-8 opacity-40" />} title={<>暂无转发规则</>} description={<>
                  {canCreateRule
                    ? "创建第一条转发规则"
                    : "当前账号没有可用的转发资源"}
                </>} actions={<>{canAdd && canCreateRule && (
                  <Button onClick={() => openCreate()} variant="outline" className="mt-4 gap-2">
                    <Plus className="h-4 w-4" />
                    创建第一条规则
                  </Button>
                )}</>} />
            )}
          </CardContent>
        </Card>
      )}
      </SectionTransition>
      </>} />

      {selfTestRule && (
        <Suspense fallback={<DialogLoadingFallback />}>
        <SelfTestDialog
          ruleId={selfTestRule.id}
          ruleName={selfTestRule.name}
          sourceLabel={selfTestLinkTestNodeData.sourceLabel}
          targetLabel={selfTestLinkTestNodeData.targetLabel}
          nodeMeta={selfTestLinkTestNodeData.nodeMeta}
          plannedSegments={selfTestLinkTestNodeData.plannedSegments}
          current={trafficByRule.get(Number(selfTestRule.id)) ?? null}
          open={!!selfTestRule}
          onOpenChange={(v) => { if (!v) setSelfTestRule(null); }}
          initialTab={selfTestRule.tab}
          extraTabs={[{
            key: "history",
            label: "延迟记录",
            content: (
              <Suspense fallback={<DataSectionLoading />}>
                <TcpingDetailBody ruleId={selfTestRule.id} isForwardChain={!!selfTestRule.isForwardChain} chainKernel={!!selfTestRule.chainKernel} probeMethod={selfTestRule.probeMethod} active={!!selfTestRule} />
              </Suspense>
            ),
          }, {
            key: "connections",
            label: "连接",
            content: (
              <Suspense fallback={<DataSectionLoading />}>
                <RuleConnectionsBody ruleId={selfTestRule.id} active={!!selfTestRule} />
              </Suspense>
            ),
          }]}
          actions={<DiagnoseSubjectActions kind="rule" id={Number(selfTestRule.id)} onLeave={() => setSelfTestRule(null)} />}
        />
        </Suspense>
      )}

      {/*
        ── 线路就地新建 ────────────────────────────────────────────

        以前这里写的是「暂无可用隧道，请先在链路管理中创建隧道」——
        它告诉你走不通，但不给出路。第一次用面板的人在这一步必然卡住：
        他想做的是「把这个端口转出去」，而面板要求他先理解「隧道」是一个
        需要去另一页单独创建的对象。这是实现结构泄漏到了操作流程里。

        现在不管有没有可用线路，选择器下面都有一个「＋ 新建…」，点开就地填，
        建完自动选中，接着填端口。不跳页 —— 跳出去再回来，填了一半的端口和
        目标地址就没了。
      */}
      <Dialog open={showDialog} onOpenChange={ruleDialogGuard.handleOpenChange}>
        <DialogContent className="flex max-h-[96svh] w-[calc(100vw-1rem)] flex-col gap-3 overflow-hidden p-4 sm:max-w-2xl sm:p-5">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑规则" : "添加转发规则"}</DialogTitle>
            {!editingId && createOwnerUserId ? (
              <DialogDescription data-testid="rule-owner-hint">新规则归属：{ruleOperationOwnerLabel}（按他的权限和套餐检查，建好后他只能查看）</DialogDescription>
            ) : null}
          </DialogHeader>
          <div className="min-h-0 flex-1 scroll-pb-28 space-y-3 overflow-y-auto pb-5 pr-1">
            <Tabs
              value={routeTab}
              onValueChange={(value) => selectRouteTab(value as RuleRouteTab)}
              className="space-y-3"
            >
              <SlidingTabsList
                items={routeModeTabItems}
                activeValue={routeTab}
                ariaLabel="转发规则类型"
                minItemWidthRem={5.75}
              />
            </Tabs>
            {/* 选中的走法一句话说清楚适合什么（features/rules/routeModeHints）。编辑时走法定了，不再说。 */}
            {!editingId && !hideRuleFormHints && (
              <p className="-mt-1 text-meta leading-5 text-muted-foreground" data-testid="route-mode-hint">
                {ROUTE_MODE_HINTS[routeTab]}
              </p>
            )}
            {(sniAvailableForTab(form.routeMode) || isSniEntryMode) && renderEntryModeSwitch()}

            <RuleRouteTransition
              transitionKey={`rule-route-${form.routeMode}-${isForwardGroupRouteMode ? "resource" : "direct"}`}
              className="space-y-3"
            >
              {/*
                线路这一块不再套框。原来是「描边 + 灰底」的一个框，里面再放迷你表单的灰块 ——
                白色面板里一个灰框套一个灰块。它和下面的端口、目标本来就是同一张表单。
              */}
              {form.routeMode === "tunnel" && (
                <div className="space-y-2">
                    <FormField className="space-y-1.5">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <Label>{selectedTunnelIsAggregate ? "使用叠加" : "使用隧道"}</Label>
                        {/* 隧道的类型（GOST / NEX）下拉框里已经写着，不再另起一个徽标重复一遍；叠加在链路管理里建 */}
                        {selectedTunnelIsAggregate ? null : renderInlineLinkTrigger("tunnel")}
                      </div>
                      <Select
                        value={form.tunnelId ? String(form.tunnelId) : undefined}
                        disabled={availableTunnels.length === 0}
                        onValueChange={(v) => {
                          const nextTunnelId = Number(v);
                          const tunnel = nextTunnelId ? tunnels?.find((t: any) => t.id === nextTunnelId) : null;
                          setForm({
                            ...form,
                            tunnelId: nextTunnelId,
                            hostId: tunnel ? tunnel.entryHostId : null,
                          });
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder={selectedTunnelIsAggregate ? "请选择叠加" : "请选择隧道"} /></SelectTrigger>
                        <SelectContent>
                          {availableTunnels.map((t: any) => (
                            <SelectItem key={t.id} value={String(t.id)} textValue={getTunnelSelectText(t)}>
                              {renderTunnelSelectLabel(t)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                  {renderInlineLinkBody("tunnel")}
                  {selectedTunnel && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {renderTunnelRoute(selectedTunnel, true)}
                      <code className="rounded bg-background/60 px-1.5 py-0.5">:{selectedTunnel.listenPort}</code>
                    </div>
                  )}
                </div>
              )}

              {isForwardGroupRouteMode && !(form.routeMode === "local" && isSniEntryMode) && (
                <div className="space-y-2">
                    <FormField className="space-y-1.5">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <Label className="min-w-0 truncate">{form.routeMode === "local" ? (isLegacyLocalRuleEdit ? "迁移到新版端口转发" : "使用端口转发") : form.routeMode === "chain" ? "使用转发链" : "使用转发组"}</Label>
                        <div className="flex shrink-0 items-center gap-1">
                          {/*
                            转发工具（gost / realm / iptables）下拉框里没有写，所以留着，但只是标签行尾一个
                            小标记 —— 原来是和下拉框一样高的一块，手机上独占一行，看上去像能点的控件。
                          */}
                          <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground">
                            {form.routeMode === "local" ? <ArrowRightLeft className="h-3 w-3" /> : form.routeMode === "chain" ? <GitBranch className="h-3 w-3" /> : <Layers3 className="h-3 w-3" />}
                            {isLegacyLocalRuleEdit && !selectedForwardGroup ? "待选择" : FORWARD_TYPE_LABELS[effectiveRouteForwardType] || effectiveRouteForwardType}
                          </Badge>
                          {renderInlineLinkTrigger(form.routeMode)}
                        </div>
                      </div>
                      <Select
                        value={form.forwardGroupId ? String(form.forwardGroupId) : undefined}
                        disabled={(form.routeMode === "local" ? availablePortForwardGroups : form.routeMode === "chain" ? availableForwardChainGroups : availableFailoverForwardGroups).length === 0}
                        onValueChange={(v) => {
                          const nextGroupId = Number(v);
                          const group = nextGroupId ? forwardGroupById.get(nextGroupId) : null;
                          setForm({
                            ...form,
                            forwardGroupId: nextGroupId,
                            forwardType: getForwardGroupRuleForwardType(group, form.forwardType),
                            hostId: null,
                            tunnelId: null,
                            failoverEnabled: isForwardChainGroup(group) ? false : form.failoverEnabled,
                          });
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder={form.routeMode === "local" ? "请选择端口转发" : form.routeMode === "chain" ? "请选择转发链" : "请选择转发组"} /></SelectTrigger>
                        <SelectContent>
                          {(form.routeMode === "local" ? availablePortForwardGroups : form.routeMode === "chain" ? availableForwardChainGroups : availableFailoverForwardGroups).map((group: any) => (
                            <SelectItem key={group.id} value={String(group.id)} textValue={getForwardGroupSelectText(group)}>
                              {renderForwardGroupSelectLabel(group)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                  {isLegacyLocalRuleEdit && form.routeMode === "local" && (
                    <p className="text-xs text-[var(--fx-warn-text)]">
                      旧版端口转发规则需要选择新版端口转发，保存后会保留当前目标地址和端口配置。
                    </p>
                  )}
                  {renderInlineLinkBody(form.routeMode)}
                  {selectedForwardGroup && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {portEntryGroupOf(selectedForwardGroup) && <span>入口组 · {String(portEntryGroupOf(selectedForwardGroup)?.name || "")}</span>}
                      {forwardGroupDisplayMembers(selectedForwardGroup).slice(0, 4).map((member: any, index: number) => (
                        <span key={member.id} className="rounded bg-background/60 px-1.5 py-0.5">
                          {index + 1}. {getForwardGroupMemberLabel(member)}
                        </span>
                      ))}
                      {forwardGroupDisplayMembers(selectedForwardGroup).length > 4 && <span>+{forwardGroupDisplayMembers(selectedForwardGroup).length - 4}</span>}
                    </div>
                  )}
                </div>
              )}

              {isSniEntryMode && renderSniEntryFields()}

              {form.routeMode === "local" && !isForwardGroupRouteMode && !isSniEntryMode && (
                <div className="space-y-2">
                    <FormField className="space-y-1.5">
                      <Label>使用按量计费资源</Label>
                      <Select
                        value={form.hostId ? String(form.hostId) : undefined}
                        disabled={availableTrafficBillingHosts.length === 0}
                        onValueChange={(v) => {
                          const nextHostId = Number(v);
                          latestPortCheckRef.current += 1;
                          setPortStatus("idle");
                          setPortRangeError(null);
                          setForm({
                            ...form,
                            hostId: nextHostId,
                            tunnelId: null,
                            forwardGroupId: null,
                          });
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder="请选择按量计费资源" /></SelectTrigger>
                        <SelectContent>
                          {availableTrafficBillingHosts.map((host: any) => (
                            <SelectItem key={host.id} value={String(host.id)} textValue={getHostOptionText(host)}>
                              {renderHostStatusLabel(host)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                  {availableTrafficBillingHosts.length === 0 && (
                    <p className="text-xs text-[var(--fx-warn-text)]">暂无可用按量计费资源，请确认资源授权和余额。</p>
                  )}
                  {selectedHost && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {renderHostStatusLabel(selectedHost)}
                      <span className="rounded bg-background/60 px-1.5 py-0.5">端口 {sourcePortRangeText}</span>
                    </div>
                  )}
                </div>
              )}
            </RuleRouteTransition>
            {/*
              字段顺序按「线路 → 端口 → 出口 → 名称」排：先是这条转发在哪走（上面的线路块），
              再是进来的端口和出去的地址，最后才是名字。
              原来「规则名称」排在第二，但它既不是这条转发「走哪儿」也不是「去哪儿」，
              是最后才需要想的东西；端口和目标才是。现在它也不再必填 —— 留空由服务端
              按目标地址生成，占位符里直接显示会生成成什么，不用猜。

              手机上「目标端口」和「协议」并排：两个都是几个字的短值，各占一整行时右边
              大半行是空的。源端口和目标地址照旧占满一行 —— 地址会很长，源端口旁边还有
              随机按钮。
            */}
            <div className="grid grid-cols-2 gap-x-2 gap-y-3 sm:gap-3">
              {!isSniEntryMode && (
              <FormField className="col-span-2 space-y-1.5 sm:col-span-1">
              <div className="flex items-center justify-between gap-2">
              <Label className="flex items-baseline gap-1.5">
              源端口
              {sourcePortRequired
              ? <span className="text-destructive">*</span>
              : hideRuleFormHints ? null : <span className="text-xs font-normal text-muted-foreground">留空随机分配</span>}
              </Label>
              {/* 精简布局：范围写进输入框占位里，超范围时下面一行红字直接说能用哪些。 */}
              {hideRuleFormHints ? null : (
              <span className="truncate text-xs text-muted-foreground" title={`允许端口范围: ${sourcePortRangeText}`}>
              {sourcePortRangeText}
              </span>
              )}
              </div>
              <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
              <Input
              type="text"
              placeholder={hideRuleFormHints && sourcePortRangeText !== "不限制"
                ? `${sourcePortRangeText}${sourcePortRequired ? "" : "，留空随机"}`
                : sourcePortRequired ? "例如 8080" : "留空随机分配"}
              value={form.sourcePortText ?? (form.sourcePort ? String(form.sourcePort) : "")}
              onChange={(e) => {
              latestPortCheckRef.current += 1;
              setPortRangeError(null);
              setPortStatus("idle");
              // 能写端口段 20000-20100（shared/portRange.ts）；原文留着，写到一半的「20000-」不会被吞掉。
              const text = e.target.value;
              const spec = parsePortSpec(text);
              const parsed = spec && !("error" in spec) ? spec : null;
              setForm({
                ...form,
                sourcePortText: text,
                sourcePort: parsed ? parsed.start : parseInt(text) || 0,
              });
              }}
              className={`pr-24 ${
              portStatus === "used" ? "border-destructive" :
              portStatus === "available" ? "border-[var(--fx-healthy)]" : ""
              }`}
              />
              {portStatus === "used" && (
              <div className="absolute right-2.5 top-1/2 inline-flex max-w-[5.5rem] -translate-y-1/2 items-center gap-1 text-[11px] font-medium text-destructive" title={portStatusHint?.title}>
              <XCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{portStatusHint?.text || "不可用"}</span>
              </div>
              )}
              {portStatus === "available" && !portRangeBlocker && (
              <div className="absolute right-2.5 top-1/2 inline-flex max-w-[5.5rem] -translate-y-1/2 items-center gap-1 text-[11px] font-medium text-[var(--fx-healthy-text)]" title={portStatusHint?.title}>
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{portStatusHint?.text || "可用"}</span>
              </div>
              )}
              </div>
              <Button
              type="button"
              variant="outline"
              size="icon"
              className="fx-compact-touch h-[34px] w-10 shrink-0 md:h-10"
              onClick={handleRandomPort}
              title="随机分配端口"
              disabled={isForwardGroupRouteMode ? !form.forwardGroupId : !form.hostId}
              >
              <Shuffle className="h-4 w-4" />
              </Button>
              </div>
              {formIsPortRange ? (
              <p className={cn("flex flex-wrap items-center gap-x-2 text-meta", portRangeBlocker || (portStatus === "used" && portRangeError) ? "text-destructive" : "text-muted-foreground")}>
              <span>{portRangeBlocker || (portStatus === "used" && portRangeError) || `端口段 · ${formSourcePortEnd - form.sourcePort + 1} 个端口 → ${form.targetPort ? (form.targetPort === form.sourcePort ? "目标同端口" : `目标 ${formatRuleTargetPort({ ...form, sourcePortEnd: formSourcePortEnd })}`) : "目标写起点或同样长的段"}`}</span>
              {portRangeBlocker && !forwardTypeSupportsPortRange(effectiveRouteForwardType) && form.routeMode === "local" && !isForwardGroupRouteMode && !routeModeLocked && usableForwardTypes.includes("nftables") ? (
              <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => setForm((prev) => ({ ...prev, forwardType: "nftables", tunnelId: null }))}>改用 nftables</button>
              ) : null}
              </p>
              ) : null}
              </FormField>
              )}
              <FormField className={isSniEntryMode ? "col-span-2 space-y-1.5" : "col-span-2 space-y-1.5 sm:col-span-1"}>
              <div className="flex items-center justify-between gap-2">
              <Label>目标地址 <span className="text-destructive">*</span></Label>
              {/*
                转发到自己的节点：原来要先去节点页抄地址和端口再回来填。这里直接列出来，选一个就把
                目标地址 / 端口填好（地址用的是节点对外的入口地址，和自动绑定节点用的是同一个值）。
              */}
              {!isSniEntryMode && targetNodeOptions.length > 0 ? (
              <Select
              value=""
              onValueChange={(value) => {
                const node = targetNodeOptions.find((item) => String(item.id) === value);
                if (node) setForm((prev) => ({ ...prev, targetIp: node.address, targetPort: node.port, targetPortText: null, targetNodeId: node.id }));
              }}
              >
              <SelectTrigger className="h-7 w-auto gap-1 border-dashed px-2 text-meta" aria-label="选我的节点作为目标">
              <SelectValue placeholder="选我的节点" />
              </SelectTrigger>
              <SelectContent align="end">
              {targetNodeOptions.map((node) => (
              <SelectItem key={node.id} value={String(node.id)}>
              {node.landingPool
                ? `${routeNodeOptionLabel(node)} · ${node.protocol}`
                : `${node.name} · ${node.protocol} · ${node.address}:${node.port}`}
              </SelectItem>
              ))}
              </SelectContent>
              </Select>
              ) : null}
              </div>
              <Input
              placeholder="例如: 10.0.0.1 或 example.com"
              value={form.targetIp}
              onChange={(e) => setForm({ ...form, targetIp: e.target.value, targetNodeId: null })}
              />
              {form.targetNodeId ? (
              <p className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground" data-testid="target-node-chip">
              <span className="inline-flex min-w-0 items-center gap-1 rounded-[var(--fx-radius-control)] bg-[var(--fx-healthy-soft)] px-1.5 py-0.5 text-[var(--fx-healthy-text)]">
              <span className="truncate">{targetNodeOptions.find((node) => node.id === form.targetNodeId)?.landingPool ? "目标是落地池" : "目标是我的节点"}「{proxyNodeNameById.get(form.targetNodeId) || `#${form.targetNodeId}`}」</span>
              <button type="button" className="rounded-full p-0.5 hover:bg-black/10" aria-label="不再跟随节点" onClick={() => setForm({ ...form, targetNodeId: null })}>
              <X className="h-3 w-3" />
              </button>
              </span>
              <span className="min-w-0 truncate">
              {targetNodeOptions.find((node) => node.id === form.targetNodeId)?.landingPool
                ? "保存后在池里几台分（gost 等转发）；只能指向一台的转发跟着首选那台，坏了换"
                : "节点地址变了，目标自动跟着改，订阅里就是这条"}
              </span>
              </p>
              ) : null}
              </FormField>
              <FormField className="space-y-1.5">
              <Label>目标端口 <span className="text-destructive">*</span></Label>
              <Input
              type="text"
              placeholder={formIsPortRange ? `如 ${form.sourcePort}（同端口）` : "例如: 80"}
              value={form.targetPortText ?? (form.targetPort ? String(form.targetPort) : "")}
              onChange={(e) => {
                // 端口段时写目标起点，或同样长的一段（30000-30100）；长度对不上提交时会说。
                const text = e.target.value;
                const spec = parsePortSpec(text);
                const parsed = spec && !("error" in spec) ? spec : null;
                setForm({
                  ...form,
                  targetPortText: text,
                  targetPort: parsed ? parsed.start : parseInt(text) || 0,
                  targetNodeId: null,
                });
              }}
              />
              </FormField>
              <FormField className="space-y-1.5">
              <Label>协议</Label>
              {/*
                开了出口时协议就决定 UDP 走不走出口：TCP+UDP 时 UDP 也经出口从落地出去，TCP 时只转 TCP
                （UDP 绝不绕过出口直连，所以没有单独的 UDP）。入口机撑不起 UDP 出口时 TCP+UDP 选不了。
              */}
              <Select
              value={isSniEntryMode ? "tcp" : egressActive ? (form.egress.egressUdp ? "both" : "tcp") : form.protocol}
              disabled={isSniEntryMode}
              onValueChange={(v) => setForm((prev) => (egressActive
                ? { ...prev, protocol: v === "both" ? "both" : "tcp", egress: { ...prev.egress, egressUdp: v === "both" } }
                : { ...prev, protocol: v as any }))}
              >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
              <SelectItem value="tcp">TCP</SelectItem>
              {egressActive ? null : <SelectItem value="udp">UDP</SelectItem>}
              <SelectItem
                value="both"
                disabled={egressActive && !form.egress.egressUdp && (ruleEgressProtocolOf(form.egress.egressType) === "vless"
                  // VLESS 的 UDP 经本机桥接走 xudp，不看 ssEgressUdp 能力（Agent 版本不够时出口一段另有提示）。
                  ? !VLESS_EGRESS_UDP_SUPPORTED
                  : !SS_EGRESS_UDP_SUPPORTED || (!egressCapabilities.loading && !egressCapabilities.udp))}
              >TCP+UDP</SelectItem>
              </SelectContent>
              </Select>
              </FormField>
            </div>
            {/* 警告留在外面：折进「更多设置」就等于折没了，而它恰恰是要被看见的。 */}
            {kernelForwardWarning && (
              <div className="rounded-md border border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] px-3 py-2 text-sm text-[var(--fx-warn-text)]">
                <div className="flex min-w-0 items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 leading-5">{kernelForwardWarning}</span>
                </div>
              </div>
            )}
            {/*
              主备线路放在外面，不折进「更多设置」。

              它原来在「更多设置」里，而「更多设置」默认收起、折叠条上也不写它 —— 用户专门来找
              「主备怎么用」，第一步就找不到。它的开关也从一个下拉框（不使用 / 主备模式 - 自上而下 /
              轮询模式 - 依次轮换 / 随机模式 - 随机选择 / 哈希模式 - IP哈希）改成一个勾：绝大多数人
              要的就是「主线路挂了自动换备用」，分配方式挪进了里面的「高级设置」。

              勾是复选框不是开关：要点「保存」才生效（见 switchVsCheckbox.test）。
            */}
            {egressSectionVisible && (
              <RuleFormCollapsible
                title="出口"
                summary={egressActive && egressBlocker ? `${egressSummary} · 还缺设置` : egressSummary}
                warn={egressActive && !!egressBlocker}
                open={egressOpen}
                onOpenChange={setShowEgress}
                testId="rule-egress-collapsible"
              >
              <RuleEgressSection
                value={form.egress}
                isAdmin={user?.role === "admin"}
                entryHostIds={egressEntryHostIds}
                viaTunnel={egressViaTunnel}
                blockedReason={egressBlockedReason}
                runtimeNote={egressRuntimeNote}
                onChange={(patch) => setForm((prev) => ({
                  ...prev,
                  // UDP 走不走出口跟着协议（上面的下拉框）；这里换出口方式时会清掉它，协议跟着回到 TCP。
                  ...(patch.egressUdp !== undefined ? { protocol: patch.egressUdp ? "both" : "tcp" } : {}),
                  egress: { ...prev.egress, ...patch },
                }))}
                onEgressEnabled={() => setForm((prev) => ({
                  ...prev,
                  // 出口是 gost 的转发链做的：直连主机的规则切到 gost；端口转发资源的工具由资源决定，不是 gost 的下发时自动换成 gost。
                  // 走隧道的规则照旧走这条隧道，SS 客户端在出口机上。
                  forwardType: isForwardGroupRouteMode ? prev.forwardType : "gost",
                  tunnelId: egressViaTunnel ? prev.tunnelId : null,
                  protocol: "tcp",
                  failoverEnabled: false,
                }))}
              />
              </RuleFormCollapsible>
            )}
            {routeGroupSectionVisible && (
            <RuleFormCollapsible
              title="线路组"
              summary={routeGroupSummary}
              open={showRouteGroup}
              onOpenChange={setShowRouteGroup}
              testId="failover-section"
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <Checkbox
                  id="rule-failover-enabled"
                  checked={form.failoverEnabled}
                  disabled={!canUseMainBackup}
                  onCheckedChange={(checked) => {
                    const nextEnabled = checked === true && canUseMainBackup;
                    setForm({
                      ...form,
                      forwardType: nextEnabled && canAutoSwitchMainBackupToGost ? "gost" : form.forwardType,
                      failoverEnabled: nextEnabled,
                      // 勾上时给一份草稿（主线路 + 一条空备用）；勾掉时留着，再勾回来还在。
                      // 协议不动：TCP、UDP、TCP+UDP 都能走线路组。
                      // 勾上时的草稿：只有主线路（就是现在这条路，入口直连目标），备用由用户加 —— 不再放一条和主线路一样的空备用。
                      routeGroup: nextEnabled ? (form.routeGroup ?? (() => {
                        const draft = newRouteGroupDraft({ timezone: BILLING_TIME_ZONE });
                        const lines = [newRouteLine(0)];
                        return { ...draft, lines, paths: expandForPreview(lines, { entryHostId: routeEntryHostId, pools: routeLinePools, tunnels: routeLineTunnels, nodes: targetNodeOptions, ruleTargetNodeId: form.targetNodeId ?? null }).paths };
                      })()) : form.routeGroup,
                    });
                  }}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <Label htmlFor="rule-failover-enabled" className="text-sm font-medium">开启线路组</Label>
                    <a
                      href={docsUrl("/guide/failover")}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-meta text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      怎么用？
                    </a>
                  </div>
                  <p className={cn("text-meta leading-5 text-muted-foreground", hideRuleFormHints && "hidden")}>
                    一个入口后面挂几条路径（可以经过中转），出问题自动换，也能定时、择优、按权重分流
                    {canAutoSwitchMainBackupToGost && !form.failoverEnabled ? "（勾上后转发工具会换成 GOST，切换要靠它）" : ""}
                  </p>
                  {/*
                    用不了的时候把原因和出路摆出来：原因只说用户听得懂的，能一键改好的直接给按钮。
                    放在标题这一栏里，和「主备线路」四个字左对齐。
                  */}
                  {mainBackupBlock && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="text-meta leading-5 text-[var(--fx-warn-text)]">{mainBackupBlock.reason}</p>
                      {mainBackupBlock.fix && (
                        <Button type="button" variant="outline" size="sm" className="fx-compact-touch h-7 text-meta" onClick={mainBackupBlock.fix.run}>
                          {mainBackupBlock.fix.label}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {/* 线路组就在这一页里改（和线路详情第一页是同一个编辑器），跟着规则一起保存 */}
              {form.failoverEnabled && form.routeGroup && (
                <RuleLineGroupField
                  canOpenTunnels={user?.role === "admin"}
                  value={form.routeGroup}
                  onChange={(routeGroup) => setForm((current) => ({ ...current, routeGroup }))}
                  hosts={routeHostOptions}
                  pools={routeLinePools}
                  tunnels={routeLineTunnels}
                  nodeOptions={targetNodeOptions}
                  ruleTargetNodeId={form.targetNodeId ?? null}
                  entryHostId={routeEntryHostId}
                  entryName={routeEntryName}
                  entryPrefix={routeEntryPrefix}
                  upstreamHostIds={routeUpstreamHostIds}
                  allowHops={routeHopsAllowed}
                  // 隧道规则在出口机上选路；端口转发资源（带转发组）每台成员机各跑一份、入口不是同一台：都放不了隧道段。
                  allowTunnels={routeHopsAllowed && form.routeMode !== "tunnel" && Number(form.forwardGroupId || 0) <= 0}
                  mainAddress={form.targetIp.trim() && form.targetPort > 0 ? `${form.targetIp.trim()}:${form.targetPort}` : ""}
                  policyRule={routePolicyRule}
                  entryHost={routeEntryHostId ? hostById.get(routeEntryHostId) : undefined}
                  protocol={form.protocol}
                  scheduleTimeZone={BILLING_TIME_ZONE}
                  ruleId={editingId}
                />
              )}
            </RuleFormCollapsible>
            )}
            {/* 规则名称放在外面：改名是常事，折进「更多设置」每次都要先展开才找得到。留空照样自动生成。 */}
            <FormField className="space-y-2">
              <Label className="flex items-baseline gap-1.5">规则名称{hideRuleFormHints ? null : <span className="text-xs font-normal text-muted-foreground">留空自动生成</span>}</Label>
              <Input
                placeholder={autoForwardRuleName(form) || "例如: Web 服务转发"}
                maxLength={128}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </FormField>
            {/*
              要填的和可以不管的，不该并排放在同一片方格里。

              上面是「这条转发走哪儿、去哪儿」—— 真正要填的东西；这里面四项都有
              能用的默认值，不动也能建出来。分开之后第一屏只剩该填的，而不是让人
              每次都当一次选择题（「转发工具这三个我该选哪个」，而答案通常是别动）。
            */}
            <div className="fx-rule-collapsible rounded-md border border-border/60 bg-muted/15">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                onClick={() => setShowAdvanced(!advancedOpen)}
                aria-expanded={advancedOpen}
              >
                <span className="shrink-0 font-medium">更多设置</span>
                {/* 折起来也得看得见里面是什么 —— 收纳不是藏。 */}
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {advancedSummary.join(" · ")}
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                />
              </button>
              {advancedOpen && (
              <div className="space-y-3 border-t border-border/60 p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {!isForwardGroupRouteMode && form.routeMode === "local" && (
              <FormField className="space-y-2">
              <Label>转发工具</Label>
              {!routeModeLocked && form.routeMode === "local" ? (
              <Select
              value={form.forwardType}
              onValueChange={(v) => setForm({
              ...form,
              forwardType: v as any,
              tunnelId: null,
              })}
              >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
              {usableForwardTypes.map((t) => (
              <SelectItem key={t} value={t} disabled={formIsPortRange && !forwardTypeSupportsPortRange(t)}>{FORWARD_TYPE_LABELS[t]}</SelectItem>
              ))}
              </SelectContent>
              </Select>
              ) : (
              <div className="flex h-10 items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-3 text-sm">
              <span className="truncate">{FORWARD_TYPE_LABELS[effectiveRouteForwardType] || effectiveRouteForwardType}</span>
              <Badge variant="outline" className="shrink-0 text-[11px]">
              {isForwardGroupRouteMode ? "上级决定" : "已锁定"}
              </Badge>
              </div>
              )}
              {formIsPortRange ? (
              <p className="text-meta text-muted-foreground">端口段只能用 {PORT_RANGE_FORWARD_TYPES.join(" / ")}：别的工具一个端口一个监听。</p>
              ) : null}
              </FormField>
              )}
            </div>
            {/* 异常提醒是可选的通知设置，不该和必填字段并排同级。 */}
            <FormField className={`flex min-h-10 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between${telegramBotReady ? "" : " opacity-60"}`}>
            <div className="min-w-0 space-y-0.5">
            <Label className="text-sm font-medium">异常TG提醒</Label>
            <p className={cn("text-xs text-muted-foreground", hideRuleFormHints && telegramBotReady && "hidden")}>
            {telegramBotReady ? "规则运行异常时提醒已绑定 Telegram 的管理员。" : "请先在系统设置中配置并启用 TG 机器人。"}
            </p>
            </div>
            <Checkbox
            checked={telegramBotReady && form.telegramErrorNotifyEnabled}
            disabled={!telegramBotReady}
            onCheckedChange={(checked) => setForm({ ...form, telegramErrorNotifyEnabled: checked })}
            />
            </FormField>
            {/*
              规则专属域名（shared/ruleEntryDomain.ts）按规则开关：不是每条转发都需要固定域名。
              只在功能可用时显示（见 ruleEntryDomainAvailable）。
            */}
            {ruleEntryDomainAvailable && (
            <FormField className="flex min-h-10 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-0.5">
            <Label className="text-sm font-medium">专属域名</Label>
            <p className={cn("text-xs text-muted-foreground", hideRuleFormHints && "hidden")}>
            开着时订阅里用固定域名 r&lt;规则ID&gt;.&lt;后缀&gt;，换隧道 / 换入口不用刷新订阅；关掉就直接用入口地址。
            </p>
            </div>
            <Checkbox
            checked={form.entryDomainEnabled}
            onCheckedChange={(checked) => setForm({ ...form, entryDomainEnabled: checked })}
            />
            </FormField>
            )}
            {user?.role === "admin" && (
            <RuleLimitsForm
            value={form.limits}
            onChange={(limits) => setForm((prev) => ({ ...prev, limits }))}
            ownerLabel={!editingId && createOwnerUserId ? ruleOperationOwnerLabel : null}
            />
            )}
              </div>
              )}
            </div>
          </div>
          {/*
            这里原来有一块「流量将经过」的竖排预览（入口 → 线路上每一台 → 目标），钉在按钮上方。
            在手机上它有 208px 高，比整个表单可见区域的一半还多，而且它说的事上面都已经写了：
            选中的线路下面那一行就是「HK entry 01 → JP exit 02 :24001」，缺什么由按钮旁边那句
            「还缺目标地址」说。用户在真机上看过之后要求去掉。
          */}
          <DialogFooter className="shrink-0 gap-2 border-t border-border/60 pt-3 sm:items-center sm:justify-between">
            {/*
              按钮点不了就在旁边说一句缺什么。手册：到达边界要 disabled 对应控件，
              而不是点了没反应 —— 但光 disabled 还不够，得说得出为什么。
              提交中不显示，那时候按钮自己写着「处理中...」。
            */}
            <p className="min-h-5 text-xs text-muted-foreground sm:mr-auto" aria-live="polite">
              {!isPending && submitBlocker ? submitBlocker : ""}
            </p>
            <Button variant="outline" onClick={ruleDialogGuard.requestClose}>
              取消
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isPending || !!submitBlocker}
            >
              {isPending ? "处理中..." : editingId ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RuleGroupManagerDialog open={ruleGroupManagerOpen} onOpenChange={setRuleGroupManagerOpen} ruleScope={effectiveRulesQuery} />

      {/* 批量管理弹窗按需加载：第一次打开后一直挂着（state 在页面上，关掉再开不丢，也留得住关闭动画） */}
      {batchDialogLoaded ? (
        <Suspense fallback={<DialogLoadingFallback open={showCopyDialog} />}>
          <RuleBatchManageDialog
            state={batchState}
            handle={batchManage}
            page={{ showCopyDialog, setShowCopyDialog, setRuleGroupManagerOpen, personalGroups, canAdd, forwardTypeDisplayLabel, supportedTunnels, forwardGroupById, canUseSavedLocalForward, canUseGost, canUseForwardChain, canUseFailoverGroup, getTunnelSelectText, renderTunnelSelectLabel, getForwardGroupSelectText, renderForwardGroupSelectLabel, renderTunnelRoute, selectedImportResource, filteredImportResources, renderTransferResourceOption, getForwardGroupMemberLabel, renderRuleGroupIcon }}
          />
        </Suspense>
      ) : null}


      {(() => {
        const policyRule = policyRuleId === null ? null : (rules || []).find((rule: any) => Number(rule.id) === policyRuleId);
        // 隧道规则的调度器在隧道出口：Agent 版本那几句按出口机说，NEX 隧道要知道隧道类型。
        const policyTunnel = policyRule?.tunnelId ? tunnelById.get(Number(policyRule.tunnelId)) : null;
        const policy = policyRule ? describeRoutePolicy(
          { ...policyRule, tunnelMode: policyRule.tunnelMode ?? policyTunnel?.mode },
          { host: hostById.get(Number(policyTunnel?.exitHostId || policyRule.hostId)) },
        ) : null;
        return (
          <RouteGroupSheet
            open={policyRuleId !== null}
            onOpenChange={(open) => !open && setPolicyRuleId(null)}
            ruleId={policyRuleId}
            subjectName={String(policyRule?.name || "")}
            policy={policy}
            rule={policyRule && !Number(policyRule.forwardGroupRuleId || 0) ? policyRule : undefined}
            canEdit
            pending={pinMutation.isPending}
            onPin={(index, durationSeconds, onDone) => pinMutation.mutate({
              id: Number(policyRule.id),
              failoverPinnedIndex: index,
              failoverPinnedUntil: pinUntilSeconds(durationSeconds),
            }, { onSuccess: () => onDone?.() })}
            onUnpin={(onDone) => pinMutation.mutate({ id: Number(policyRule.id), failoverPinnedIndex: null, failoverPinnedUntil: null }, { onSuccess: () => onDone?.() })}
            onEdit={() => {
              setPolicyRuleId(null);
              openEdit(policyRule);
            }}
          />
        );
      })()}
      {/* /rules?line=<规则 id>：线路详情的深链（拓扑、订阅、线路概览都这么跳过来），自己按 id 取规则 */}
      <LineDetailFromUrl />
    </div>
  );
}
export default function RulesPage() {
  return (
    <DashboardLayout>
      <RulesContent />
    </DashboardLayout>
  );
}
