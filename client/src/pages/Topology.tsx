import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Crosshair, ExternalLink, Maximize2, Minus, Network, Plus, Search, X, XCircle } from "lucide-react";
import { useLocation, useSearch } from "wouter";

import DataSectionError from "@/components/DataSectionError";
import EmptyState from "@/components/EmptyState";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/_core/hooks/useAuth";
import { useIsMobile } from "@/hooks/useMobile";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  TOPOLOGY_EDGE_KIND_LABELS,
  TOPOLOGY_STATUS_LABELS,
  type TopologyEdge,
  type TopologyEdgeKind,
  type TopologyGraph,
  type TopologyGroupRef,
  type TopologyNode,
  type TopologyRuleRef,
  type TopologyStatus,
  type TopologyTunnelRef,
} from "@shared/networkTopology";
import { TOPOLOGY_KIND_COLORS, TopologyCanvas, type TopologyCanvasHandle } from "@/features/topology/TopologyCanvas";
import { MyLinesSection } from "@/features/links/MyLinesSection";
import { layoutTopology, topologyColumnLabels } from "@/features/topology/topologyLayout";
import {
  TOPOLOGY_EDGE_KINDS,
  filterTopology,
  parseTopologyFocus,
  topologyFocusHref,
  topologyFocusSets,
  topologyRoleText,
  topologySearchMatches,
  topologyStatusCounts,
  type TopologyFocus,
} from "@/features/topology/topologyView";

/*
  网络拓扑：按链路看整个面板 —— 入口 → 中转… → 出口 / 落地 → 目标。

  和首页地图的分工：地图按地理位置摆主机，只画主机之间的线；这一页按「流量先后」分列，
  外部目标、落地入站、入口组都画出来，点一下就知道哪些规则、隧道、转发链用着它。
  深链接 ?rule= / ?tunnel= / ?group= 打开时直接聚焦那一条的路径（规则、隧道、转发组页上的
  「查看拓扑」就是这么跳过来的）。
*/

const KIND_STORAGE_KEY = "forwardx.topology.kinds";
const TARGETS_STORAGE_KEY = "forwardx.topology.showTargets";
/** 两种看法：拓扑图（所有节点画在一张图上）/ 我的线路（每条转发一条链）。记住上次选的。 */
const VIEW_STORAGE_KEY = "forwardx.topology.view";
type TopologyView = "graph" | "lines";

function readStoredView(): TopologyView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "lines" ? "lines" : "graph";
  } catch {
    return "graph";
  }
}

const STATUS_DOT: Record<TopologyStatus, string> = {
  running: "bg-[var(--fx-healthy-text)]",
  degraded: "bg-[var(--fx-warn-text)]",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/50",
};

const GROUP_SECTION_BY_MODE: Record<string, string> = { chain: "chains", port: "ports", failover: "groups", entry: "entries", exit: "exits" };
const GROUP_MODE_LABELS: Record<string, string> = { chain: "转发链", port: "端口转发", failover: "转发组", entry: "入口组", exit: "出口组" };
const RULE_KIND_LABELS: Record<TopologyRuleRef["kind"], string> = { direct: "端口转发", tunnel: "隧道转发", chain: "转发链", group: "转发组", route: "线路组" };

function readStoredKinds(): Set<TopologyEdgeKind> {
  try {
    const raw = window.localStorage.getItem(KIND_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const kinds = parsed.filter((kind): kind is TopologyEdgeKind => (TOPOLOGY_EDGE_KINDS as readonly string[]).includes(kind));
        if (kinds.length > 0) return new Set(kinds);
      }
    }
  } catch {
    // 隐私模式、存储被清：按默认全开。
  }
  return new Set(TOPOLOGY_EDGE_KINDS);
}

function readStoredBool(key: string, fallback: boolean) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 存不了就只在这一页生效。
  }
}

function StatusDot({ status }: { status: TopologyStatus }) {
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", STATUS_DOT[status])} aria-label={TOPOLOGY_STATUS_LABELS[status]} />;
}

type Selection = { type: "node" | "edge"; id: string } | null;

function ResourceRow({ status, title, meta, onFocus, href, onNavigate }: {
  status: TopologyStatus;
  title: string;
  meta: string;
  onFocus: () => void;
  href: string | null;
  onNavigate: (href: string) => void;
}) {
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
      <StatusDot status={status} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="truncate text-meta text-muted-foreground">{meta}</p>
      </div>
      <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={onFocus} aria-label={`聚焦 ${title}`}>
        <Crosshair className="h-3.5 w-3.5" />聚焦
      </Button>
      {href ? (
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => onNavigate(href)} aria-label={`打开 ${title}`}>
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </li>
  );
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="px-2 text-meta font-semibold text-muted-foreground">{title}</h3>
      <ul className="space-y-0.5">{children}</ul>
    </section>
  );
}

export default function TopologyPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const isMobile = useIsMobile();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const focus = useMemo(() => parseTopologyFocus(search), [search]);
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [kinds, setKinds] = useState<Set<TopologyEdgeKind>>(readStoredKinds);
  const [showTargets, setShowTargets] = useState(() => readStoredBool(TARGETS_STORAGE_KEY, true));
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const canvasRef = useRef<TopologyCanvasHandle | null>(null);
  const [view, setViewState] = useState<TopologyView>(readStoredView);
  const setView = (next: TopologyView) => {
    setViewState(next);
    setSelection(null);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // 存不了就只在这次有效
    }
  };

  const graphQuery = trpc.topology.graph.useQuery(
    isAdmin && ownerFilter !== "all" ? { userId: Number(ownerFilter) } : undefined,
    { enabled: view === "graph", refetchInterval: pollingInterval("slow"), staleTime: 10_000, placeholderData: (previous) => previous },
  );
  const graph = graphQuery.data as (TopologyGraph & { owners: Array<{ id: number; label: string }> }) | undefined;

  const visible = useMemo(
    () => (graph ? filterTopology(graph, { kinds, showTargets }) : { nodes: [] as TopologyNode[], edges: [] as TopologyEdge[] }),
    [graph, kinds, showTargets],
  );
  const layout = useMemo(() => layoutTopology(visible.nodes, visible.edges), [visible]);
  const nodeById = useMemo(() => new Map(visible.nodes.map((node) => [node.id, node])), [visible.nodes]);
  const columnLabels = useMemo(
    () => topologyColumnLabels(layout.layers, (id) => nodeById.get(id) || { kind: "host" }),
    [layout, nodeById],
  );
  const ruleById = useMemo(() => new Map((graph?.rules || []).map((rule) => [rule.id, rule])), [graph]);
  const tunnelById = useMemo(() => new Map((graph?.tunnels || []).map((tunnel) => [tunnel.id, tunnel])), [graph]);
  const groupById = useMemo(() => new Map((graph?.groups || []).map((group) => [group.id, group])), [graph]);
  const ruleNames = useMemo(() => new Map((graph?.rules || []).map((rule) => [rule.id, rule.name])), [graph]);

  const focusSets = useMemo(() => (graph ? topologyFocusSets({ edges: visible.edges, rules: graph.rules }, focus) : null), [graph, visible.edges, focus]);
  const searchMatches = useMemo(() => (graph ? topologySearchMatches({ nodes: visible.nodes, rules: graph.rules }, query) : null), [graph, visible.nodes, query]);
  const highlight = useMemo(() => {
    if (focusSets) return focusSets;
    if (!searchMatches) return null;
    const edgeIds = new Set(visible.edges.filter((edge) => searchMatches.has(edge.from) || searchMatches.has(edge.to)).map((edge) => edge.id));
    return { nodeIds: searchMatches, edgeIds };
  }, [focusSets, searchMatches, visible.edges]);
  const counts = useMemo(() => topologyStatusCounts(visible.edges), [visible.edges]);

  // 聚焦的东西换了：放大到合适位置交给画布（重新适应窗口）。
  useEffect(() => {
    canvasRef.current?.fit("readable");
  }, [focus?.type, focus?.id]);

  const setFocus = (next: TopologyFocus) => {
    setLocation(topologyFocusHref(next), { replace: true });
  };
  const toggleKind = (kind: TopologyEdgeKind) => {
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      if (next.size === 0) return current;
      store(KIND_STORAGE_KEY, JSON.stringify(Array.from(next)));
      return next;
    });
  };

  // 只是换一种看法（不存什么配置），所以用立即生效的开关。
  const toggleShowTargets = (checked: boolean) => {
    setShowTargets(checked);
    store(TARGETS_STORAGE_KEY, checked ? "1" : "0");
  };

  const focusLabel = (() => {
    if (!focus) return null;
    if (focus.type === "rule") return `规则 · ${ruleById.get(focus.id)?.name || `#${focus.id}`}`;
    if (focus.type === "tunnel") return `隧道 · ${tunnelById.get(focus.id)?.name || `#${focus.id}`}`;
    return `${GROUP_MODE_LABELS[groupById.get(focus.id)?.groupMode || ""] || "组"} · ${groupById.get(focus.id)?.name || `#${focus.id}`}`;
  })();

  const ruleHref = (rule: TopologyRuleRef) => `/rules?q=${encodeURIComponent(rule.name)}`;
  const tunnelHref = (tunnel: TopologyTunnelRef) => (isAdmin ? `/tunnels?tab=tunnels&q=${encodeURIComponent(tunnel.name)}` : null);
  const groupHref = (group: TopologyGroupRef) => (isAdmin ? `/tunnels?tab=${GROUP_SECTION_BY_MODE[group.groupMode] || "groups"}&q=${encodeURIComponent(group.name)}` : null);

  const selectedNode = selection?.type === "node" ? nodeById.get(selection.id) : undefined;
  const selectedEdge = selection?.type === "edge" ? visible.edges.find((edge) => edge.id === selection.id) : undefined;
  const panelRuleIds = selectedNode?.ruleIds || selectedEdge?.ruleIds || [];
  const panelTunnelIds = selectedNode ? selectedNode.tunnelIds : selectedEdge?.tunnelId ? [selectedEdge.tunnelId] : [];
  const panelGroupIds = selectedNode ? selectedNode.groupIds : selectedEdge?.groupId ? [selectedEdge.groupId] : [];

  const navigate = (href: string) => setLocation(href);

  const panel = selectedNode || selectedEdge ? (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden" data-testid="topology-panel">
      <div className="flex shrink-0 items-start justify-between gap-2 px-2">
        <div className="min-w-0">
          {selectedNode ? (
            <>
              <p className="truncate text-base font-semibold">{selectedNode.label}</p>
              <p className="text-meta text-muted-foreground">
                {topologyRoleText(selectedNode)}
                {selectedNode.sublabel ? ` · ${selectedNode.sublabel}` : ""}
                {selectedNode.online === null ? "" : selectedNode.online ? " · 在线" : " · 离线"}
              </p>
            </>
          ) : selectedEdge ? (
            <>
              <p className="truncate text-base font-semibold">{TOPOLOGY_EDGE_KIND_LABELS[selectedEdge.kind]}{selectedEdge.label ? ` · ${selectedEdge.label}` : ""}</p>
              <p className="text-meta text-muted-foreground">
                {nodeById.get(selectedEdge.from)?.label} → {nodeById.get(selectedEdge.to)?.label}
              </p>
              <p className="text-meta text-muted-foreground">
                {TOPOLOGY_STATUS_LABELS[selectedEdge.status]}
                {selectedEdge.protocol ? ` · ${selectedEdge.protocol.toUpperCase()}` : ""}
                {selectedEdge.port ? ` · 端口 ${selectedEdge.port}` : ""}
                {selectedEdge.latencyMs !== null ? ` · ${selectedEdge.latencyMs} ms` : ""}
              </p>
            </>
          ) : null}
        </div>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="关闭详情" onClick={() => setSelection(null)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain pb-2">
        {panelRuleIds.length > 0 ? (
          <PanelSection title={`转发规则 · ${panelRuleIds.length}`}>
            {panelRuleIds.map((id) => ruleById.get(id)).filter((rule): rule is TopologyRuleRef => !!rule).map((rule) => (
              <ResourceRow
                key={`rule-${rule.id}`}
                status={rule.status}
                title={rule.name}
                meta={`${RULE_KIND_LABELS[rule.kind]}${rule.sourcePort ? ` · 入口 :${rule.sourcePort}` : ""}${rule.target ? ` → ${rule.target}` : ""}${rule.pathCount > 1 ? ` · ${rule.pathCount} 条路径` : ""} · ${TOPOLOGY_STATUS_LABELS[rule.status]}`}
                onFocus={() => setFocus({ type: "rule", id: rule.id })}
                href={ruleHref(rule)}
                onNavigate={navigate}
              />
            ))}
          </PanelSection>
        ) : null}
        {panelTunnelIds.length > 0 ? (
          <PanelSection title={`隧道 · ${panelTunnelIds.length}`}>
            {panelTunnelIds.map((id) => tunnelById.get(id)).filter((tunnel): tunnel is TopologyTunnelRef => !!tunnel).map((tunnel) => (
              <ResourceRow
                key={`tunnel-${tunnel.id}`}
                status={tunnel.status}
                title={tunnel.name}
                meta={`${tunnel.mode.toUpperCase()}${tunnel.latencyMs !== null ? ` · ${tunnel.latencyMs} ms` : ""} · ${TOPOLOGY_STATUS_LABELS[tunnel.status]}`}
                onFocus={() => setFocus({ type: "tunnel", id: tunnel.id })}
                href={tunnelHref(tunnel)}
                onNavigate={navigate}
              />
            ))}
          </PanelSection>
        ) : null}
        {panelGroupIds.length > 0 ? (
          <PanelSection title={`转发链 / 组 · ${panelGroupIds.length}`}>
            {panelGroupIds.map((id) => groupById.get(id)).filter((group): group is TopologyGroupRef => !!group).map((group) => (
              <ResourceRow
                key={`group-${group.id}`}
                status={group.status}
                title={group.name}
                meta={`${GROUP_MODE_LABELS[group.groupMode] || "组"}${group.domain ? ` · ${group.domain}` : ""} · ${TOPOLOGY_STATUS_LABELS[group.status]}`}
                onFocus={() => setFocus({ type: "group", id: group.id })}
                href={groupHref(group)}
                onNavigate={navigate}
              />
            ))}
          </PanelSection>
        ) : null}
        {panelRuleIds.length + panelTunnelIds.length + panelGroupIds.length === 0 ? (
          <p className="px-2 text-meta text-muted-foreground">没有规则、隧道或组经过这里。</p>
        ) : null}
      </div>
    </div>
  ) : null;

  const owners = graph?.owners || [];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <WorkspaceHeader
        title="网络拓扑"
        description="入口 → 中转 → 出口 / 落地 → 目标。滚轮缩放、拖动平移，点节点或连线看哪些规则、隧道、转发链在用它。"
        status={view === "graph" && graph ? `${visible.nodes.length} 个节点 · ${visible.edges.length} 条连线${counts.failed + counts.degraded > 0 ? ` · ${counts.failed + counts.degraded} 条异常` : ""}` : undefined}
      />

      <div className="inline-flex h-9 w-full items-center gap-0.5 self-start rounded-md bg-[var(--fx-l3-control-fill)] p-[3px] sm:w-auto" role="tablist" aria-label="怎么看" data-testid="topology-view-switch">
        {([["graph", "拓扑图"], ["lines", "我的线路"]] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            onClick={() => setView(value)}
            className={cn(
              "inline-flex h-full flex-1 items-center justify-center whitespace-nowrap rounded-[6px] px-4 text-[13px] font-medium text-muted-foreground transition-all hover:text-foreground sm:flex-none",
              view === value && "bg-[image:var(--fx-primary-gradient)] font-semibold text-[var(--fx-primary-text)] hover:text-[var(--fx-primary-text)]",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "lines" ? (
        <div className="flex flex-col gap-3">
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索线路"
              placeholder="搜索规则名、主机、地址、落地节点"
              className="fx-search-pill w-full pr-9"
            />
            {query ? (
              <button type="button" aria-label="清空搜索" className="absolute right-2 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:text-foreground" onClick={() => setQuery("")}>
                <XCircle className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <MyLinesSection searchQuery={query.trim().toLowerCase()} isAdmin={isAdmin} />
        </div>
      ) : (
      <>

      <div className="flex flex-col gap-2" data-testid="topology-toolbar">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索节点或规则"
              placeholder="搜索主机、地址、规则名、端口"
              className="fx-search-pill w-full pr-9"
            />
            {query ? (
              <button type="button" aria-label="清空搜索" className="absolute right-2 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:text-foreground" onClick={() => setQuery("")}>
                <XCircle className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {isAdmin ? (
              <Select value={ownerFilter} onValueChange={(value) => { setOwnerFilter(value); setSelection(null); }}>
                <SelectTrigger aria-label="按用户筛选" className="h-8 w-full text-xs sm:w-[170px]">
                  <SelectValue placeholder="全部用户" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部用户</SelectItem>
                  {owners.map((owner) => (
                    <SelectItem key={owner.id} value={String(owner.id)}>{owner.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={showTargets}
                onCheckedChange={toggleShowTargets}
                aria-label="显示外部目标"
                className="switch-compact"
              />
              外部目标
            </label>
          </div>
        </div>
        <div className="fx-chip-scroller min-w-0 items-center" role="group" aria-label="连线种类">
          {TOPOLOGY_EDGE_KINDS.map((kind) => {
            const active = kinds.has(kind);
            return (
              <button key={kind} type="button" aria-pressed={active} className={cn("fx-chip", active && "fx-chip-on")} onClick={() => toggleKind(kind)}>
                <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: TOPOLOGY_KIND_COLORS[kind] }} aria-hidden="true" />
                <span>{TOPOLOGY_EDGE_KIND_LABELS[kind]}</span>
              </button>
            );
          })}
        </div>
        {focusLabel ? (
          <div className="flex items-center gap-2">
            <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs text-foreground">
              <Crosshair className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">聚焦：{focusLabel}</span>
              {!focusSets && graph ? <span className="text-muted-foreground">（当前筛选下看不到它）</span> : null}
            </span>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setFocus(null)}>取消聚焦</Button>
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-3 lg:flex-row">
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-[var(--fx-radius-card,12px)] border border-border bg-[var(--fx-l1-surface,var(--color-card))]">
          {graphQuery.isError && !graph ? (
            <DataSectionError label="网络拓扑" error={graphQuery.error} onRetry={() => graphQuery.refetch()} retrying={graphQuery.isFetching} />
          ) : !graph ? (
            <Skeleton className="h-[60svh] w-full" />
          ) : visible.nodes.length === 0 ? (
            <EmptyState
              icon={<Network className="h-6 w-6" />}
              title="还没有可画的链路"
              description={graph.nodes.length > 0 ? "当前筛选把连线都藏起来了，打开几种连线试试。" : "建好转发规则、隧道或转发链以后，这里会按入口到目标画出来。"}
              className="min-h-[50svh]"
            />
          ) : (
            <>
              <TopologyCanvas
                ref={canvasRef}
                nodes={visible.nodes}
                edges={visible.edges}
                layout={layout}
                columnLabels={columnLabels}
                highlight={highlight}
                selectedId={selection?.id || null}
                ruleNames={ruleNames}
                onSelectNode={(node) => setSelection({ type: "node", id: node.id })}
                onSelectEdge={(edge) => setSelection({ type: "edge", id: edge.id })}
                onClearSelection={() => setSelection(null)}
                className="h-[62svh] min-h-[360px] w-full lg:h-[calc(100svh-17rem)]"
              />
              <div className="absolute right-2 top-2 flex flex-col gap-1">
                <Button type="button" variant="outline" size="icon" className="h-8 w-8 bg-card" aria-label="放大" onClick={() => canvasRef.current?.zoomBy(1.25)}><Plus className="h-4 w-4" /></Button>
                <Button type="button" variant="outline" size="icon" className="h-8 w-8 bg-card" aria-label="缩小" onClick={() => canvasRef.current?.zoomBy(0.8)}><Minus className="h-4 w-4" /></Button>
                <Button type="button" variant="outline" size="icon" className="h-8 w-8 bg-card" aria-label="适应窗口" title="适应窗口" onClick={() => canvasRef.current?.fit()}><Maximize2 className="h-4 w-4" /></Button>
              </div>
            </>
          )}
          {graph && visible.nodes.length > 0 ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="topology-legend">
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#0284c7]" />入口</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#7c3aed]" />中转</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#d97706]" />出口</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#059669]" />落地</span>
              <span>虚线 = 已停用 · 细虚线 = 线路组备用路径 · 流动 = 此刻有流量 · 红 = 异常 · 橙 = 部分异常 · 越粗规则越多</span>
            </div>
          ) : null}
        </div>
        {panel && !isMobile ? (
          <aside className="flex w-full shrink-0 flex-col rounded-[var(--fx-radius-card,12px)] border border-border bg-card p-2 lg:max-h-[calc(100svh-17rem)] lg:w-80 lg:overflow-hidden">
            {panel}
          </aside>
        ) : null}
      </div>

      {panel && isMobile ? (
        <div
          className="fixed inset-x-0 z-40 flex max-h-[55svh] flex-col rounded-t-2xl border-t border-border bg-card px-2 pb-3 pt-2 shadow-[0_-8px_24px_rgba(0,0,0,0.12)]"
          style={{ bottom: "var(--forwardx-mobile-bottom-inset, 0px)" }}
          role="dialog"
          aria-label="拓扑详情"
        >
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />
          {panel}
        </div>
      ) : null}
      </>
      )}
    </div>
  );
}
