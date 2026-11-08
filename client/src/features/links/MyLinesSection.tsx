import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus, Signpost, X } from "lucide-react";
import { useLocation } from "wouter";

import EmptyState from "@/components/EmptyState";
import { StatusDot } from "@/components/network/StatusDot";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatRate } from "@/features/rules/RouteBoard";
import { TopologyCanvas, type TopologyCanvasHandle } from "@/features/topology/TopologyCanvas";
import { layoutTopology } from "@/features/topology/topologyLayout";
import { topologyRoleText } from "@/features/topology/topologyView";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { lineDetailHref } from "./lineLinks";
import { buildLineModel, type LineModel, type LineProbe, type LineRate, type LineTraffic } from "./myLines";
import {
  MY_LINES_LABEL_BAND,
  MY_LINES_LAYOUT_COMPACT,
  MY_LINES_MIN_SCALE,
  MY_LINES_TERMINAL_TIERS,
  buildMyLinesGraph,
  myLinesCanvasHeight,
  myLinesColumnLabels,
  myLinesLayoutFor,
  sortLinesForList,
} from "./myLinesGraph";

/*
  网络拓扑 › 我的线路：所有线路画在一张图上，一眼看完（和拓扑图同一张画布：滚轮 / 双指缩放、拖动、右上角「放下全图」）。

  图：入口 → 中转… → 落地 →（出口）分列；同一台主机、同一个组、同一个落地只画一个，几条线路共用的一段合成一条
  连线，线上骑延迟，有问题的染黄 / 红（myLinesGraph.ts）。图下面一行一条线路，不通的排最前：点一行就在图上
  高亮它走的路，并展开详情 / 诊断 / 编辑；点图上的节点或连线，下面只留经过那里的线路。

  这是看「我的每条线现在从哪进、经过谁、到哪落地、通不通、跑多快」的地方，建和改还在隧道 / 转发链 / 转发组
  那几页。数字来自现成的查询：rules.list（规则 + 出口）、rules.trafficSummary（最近探测 + 此刻速率）、
  rules.routeBoard（线路组当前路径各段、各跳速率、切换次数）、hosts / tunnels / forwardGroups 的 options。
*/

/** 线路名后面那一句：线路是什么、几条路径、绑了哪个节点、谁的。 */
function describeLine(line: LineModel) {
  const parts = [line.kindLabel];
  if (line.pathCount > 1) parts.push(`${line.pathCount} 条路径`);
  if (line.subscription) parts.push(line.subscription.visible ? `订阅「${line.subscription.nodeName}」` : "订阅已隐藏");
  if (line.owner) parts.push(line.owner);
  return parts.join("，");
}

/** 一行右边那枚：整链延迟 / 不通 / 未测 / 已停用。 */
export function lineLatencyChip(line: LineModel): { text: string; tone: "ok" | "down" | "off" } {
  const probe = line.probe;
  if (line.health === "standby") return { text: "已停用", tone: "off" };
  if (probe?.isTimeout) return { text: "整链不通", tone: "down" };
  if (probe && probe.latencyMs !== null) return { text: `整链 ${Math.round(probe.latencyMs)} ms`, tone: line.health === "down" ? "down" : "ok" };
  return { text: "整链未测", tone: "off" };
}

function lineChainText(line: LineModel) {
  return [line.entry.name, ...line.hops.map((hop) => hop.name), line.landing.name, ...(line.exit ? [line.exit.name] : [])].join(" → ");
}

function lineRateText(rate: LineRate | null) {
  if (!rate || (rate.inBps <= 0 && rate.outBps <= 0)) return null;
  return `↓ ${formatRate(rate.inBps)} · ↑ ${formatRate(rate.outBps)}`;
}

const CHIP_TONE: Record<"ok" | "down" | "off", string> = {
  ok: "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]",
  down: "bg-[var(--fx-down-soft)] text-[var(--fx-down-text)]",
  off: "bg-[var(--fx-l3-control-fill)] text-muted-foreground",
};

export function MyLineRow({ line, selected, onSelect, onEdit, onDiagnose, onOpenDetail }: {
  line: LineModel;
  selected: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onDiagnose?: () => void;
  onOpenDetail?: () => void;
}) {
  const chip = lineLatencyChip(line);
  const rate = lineRateText(line.rate);
  return (
    <li className={cn("border-b border-[var(--fx-stroke-weak)] last:border-b-0", selected && "bg-[var(--fx-l3-control-fill)]")} data-testid="my-line-row" data-health={line.health}>
      <button type="button" className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left" onClick={onSelect} aria-expanded={selected} title={line.statusText}>
        <StatusDot health={line.health} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{line.name}</span>
        <span className="hidden shrink-0 text-meta text-muted-foreground sm:inline">{describeLine(line)}</span>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", CHIP_TONE[chip.tone])}>{chip.text}</span>
      </button>
      {selected ? (
        <div className="flex flex-col gap-1.5 px-3 pb-3 text-meta text-muted-foreground" data-testid="my-line-detail">
          <span className="sm:hidden">{describeLine(line)}</span>
          <span className="break-words font-mono text-[11.5px] text-foreground">{lineChainText(line)}</span>
          <span>{line.statusText}{rate ? ` · ${rate}` : ""}{line.switches && line.switches.count24h > 0 ? ` · 24 小时切换 ${line.switches.count24h} 次` : ""}</span>
          <span className="flex gap-4 pt-0.5 font-semibold text-[var(--fx-accent)]">
            {onOpenDetail ? <button type="button" onClick={onOpenDetail} data-testid="line-open-detail">详情</button> : null}
            {onDiagnose ? <button type="button" onClick={onDiagnose}>诊断</button> : null}
            {onEdit ? <button type="button" onClick={onEdit}>编辑</button> : null}
          </span>
        </div>
      ) : null}
    </li>
  );
}

type Selection = { type: "line"; id: number } | { type: "node"; id: string } | { type: "edge"; id: string } | null;

export function MyLinesSection({ searchQuery = "", isAdmin = false }: { searchQuery?: string; isAdmin?: boolean }) {
  const [, setLocation] = useLocation();
  const rulesQuery = trpc.rules.list.useQuery(isAdmin ? { scope: "all" } : undefined, { staleTime: 15_000 });
  const hostsQuery = trpc.hosts.options.useQuery(undefined, { staleTime: 60_000 });
  const tunnelsQuery = trpc.tunnels.options.useQuery(undefined, { staleTime: 60_000, refetchOnWindowFocus: false });
  const groupsQuery = trpc.forwardGroups.options.useQuery(undefined, { staleTime: 60_000, refetchOnWindowFocus: false });
  const permissionQuery = trpc.proxySubscriptions.permission.useQuery(undefined, { staleTime: 60_000, refetchOnWindowFocus: false });
  const nodesQuery = trpc.proxySubscriptions.listNodes.useQuery(undefined, { enabled: !!permissionQuery.data?.allowed, staleTime: 60_000, refetchOnWindowFocus: false });
  const rules = (rulesQuery.data || []) as any[];
  const ruleIds = useMemo(() => rules.map((rule) => Number(rule.id)).filter((id) => id > 0), [rules]);
  const anyRoute = rules.some((rule) => !!rule.failoverEnabled);
  const boardQuery = trpc.rules.routeBoard.useQuery(isAdmin ? { scope: "all" } : undefined, {
    enabled: anyRoute,
    refetchInterval: pollingInterval("log"),
    staleTime: 5_000,
    placeholderData: (previous) => previous,
  });
  const summaryQuery = trpc.rules.trafficSummary.useQuery({ hours: 24, range: "24h", ruleIds }, {
    enabled: ruleIds.length > 0,
    refetchInterval: pollingInterval("log"),
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
  });

  const lines = useMemo(() => {
    const hostById = new Map<number, any>((hostsQuery.data || []).map((host: any) => [Number(host.id), host]));
    const tunnelById = new Map<number, any>(((tunnelsQuery.data || []) as any[]).map((tunnel) => [Number(tunnel.id), tunnel]));
    const groupById = new Map<number, any>(((groupsQuery.data || []) as any[]).map((group) => [Number(group.id), group]));
    const nodeNameById = new Map<number, string>(((nodesQuery.data || []) as any[]).map((node) => [Number(node.id), String(node.name || "")]));
    const routeStatusByRule = new Map<number, any>(((boardQuery.data || []) as any[]).map((item) => [Number(item.ruleId), item.status]));
    const probeByRule = new Map<number, LineProbe>();
    const trafficByRule = new Map<number, LineTraffic>();
    const rateByRule = new Map<number, LineRate | null>();
    for (const row of ((summaryQuery.data || []) as any[])) {
      const ruleId = Number(row.ruleId || 0);
      if (ruleId <= 0) continue;
      const prevTraffic = trafficByRule.get(ruleId) || { bytesIn: 0, bytesOut: 0 };
      trafficByRule.set(ruleId, { bytesIn: prevTraffic.bytesIn + (Number(row.bytesIn) || 0), bytesOut: prevTraffic.bytesOut + (Number(row.bytesOut) || 0) });
      if (row.liveRate && !rateByRule.get(ruleId)) rateByRule.set(ruleId, row.liveRate as LineRate);
      const at = row.latestLatencyAt || null;
      const prev = probeByRule.get(ruleId);
      const prevAt = prev?.at ? new Date(prev.at as any).getTime() : 0;
      const nextAt = at ? new Date(at).getTime() : 0;
      if (!prev || nextAt >= prevAt) {
        probeByRule.set(ruleId, {
          latencyMs: row.latestLatencyMs === null || row.latestLatencyMs === undefined ? null : Number(row.latestLatencyMs),
          isTimeout: !!row.latestLatencyIsTimeout,
          at,
          failure: row.latestProbeFailure || null,
        });
      }
    }
    const query = searchQuery.trim().toLowerCase();
    return rules
      .filter((rule) => !rule.pendingDelete && !(Number(rule.forwardGroupRuleId || 0) > 0 && !rule.isForwardGroupTemplate) && !(Number(rule.routeParentRuleId || 0) > 0))
      .map((rule) => buildLineModel(rule, { hostById, tunnelById, groupById, nodeNameById, routeStatusByRule, probeByRule, trafficByRule, rateByRule }))
      .filter((line) => !query || line.haystack.includes(query));
  }, [rules, hostsQuery.data, tunnelsQuery.data, groupsQuery.data, nodesQuery.data, boardQuery.data, summaryQuery.data, searchQuery]);

  // 量图那张卡有多宽：手机上换紧凑格子，画布高度也按宽度整张放下来算。
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  useEffect(() => {
    if (!frame) return;
    const update = () => setFrameWidth(frame.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);
  const metrics = myLinesLayoutFor(frameWidth || (typeof window !== "undefined" ? window.innerWidth : 0));
  const compact = metrics === MY_LINES_LAYOUT_COMPACT;

  const graph = useMemo(() => buildMyLinesGraph(lines), [lines]);
  const layout = useMemo(
    () => layoutTopology(
      graph.nodes.map((node) => ({ id: node.id, kind: graph.layoutKind.get(node.id) || "host" })),
      graph.edges,
      { ...metrics, terminalTiers: MY_LINES_TERMINAL_TIERS },
    ),
    [graph, metrics],
  );
  const columnLabels = useMemo(() => myLinesColumnLabels(layout.layers, graph.layoutKind), [layout, graph]);
  const lineNames = useMemo(() => new Map(lines.map((line) => [line.id, line.name])), [lines]);
  const [selection, setSelection] = useState<Selection>(null);
  const canvasRef = useRef<TopologyCanvasHandle | null>(null);

  // 选中的东西不在了（搜索换了、规则删了）就当没选
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph]);
  const edgeById = useMemo(() => new Map(graph.edges.map((edge) => [edge.id, edge])), [graph]);
  const active: Selection = selection && (
    selection.type === "line" ? graph.pathByLine.has(selection.id) : selection.type === "node" ? nodeById.has(selection.id) : edgeById.has(selection.id)
  ) ? selection : null;
  // 点了节点 / 连线：经过那里的线路；点了线路或没点：全部
  const throughIds = active?.type === "node" ? nodeById.get(active.id)!.ruleIds : active?.type === "edge" ? edgeById.get(active.id)!.ruleIds : null;
  const highlight = useMemo(() => {
    const ids = active?.type === "line" ? [active.id] : throughIds;
    if (!ids) return null;
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    for (const id of ids) {
      const path = graph.pathByLine.get(id);
      if (!path) continue;
      path.nodeIds.forEach((nodeId) => nodeIds.add(nodeId));
      path.edgeIds.forEach((edgeId) => edgeIds.add(edgeId));
    }
    return { nodeIds, edgeIds };
  }, [active, throughIds, graph]);
  const listed = useMemo(() => {
    const sorted = sortLinesForList(lines);
    return throughIds ? sorted.filter((line) => throughIds.includes(line.id)) : sorted;
  }, [lines, throughIds]);

  if (rulesQuery.isLoading) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="p-6 text-center text-sm text-muted-foreground">在读线路…</CardContent>
      </Card>
    );
  }
  if (lines.length === 0) {
    return (
      <EmptyState
        icon={<Signpost className="h-6 w-6" />}
        title={searchQuery ? "没有匹配的线路" : "还没有线路"}
        description="每条转发规则就是一条线路：从入口进、经过中转或隧道、到落地，再从出口出去。新建一条转发就有了。"
        actions={<Button type="button" onClick={() => setLocation("/rules?create=local")}>去新建转发</Button>}
      />
    );
  }
  const down = lines.filter((line) => line.health === "down").length;
  const standby = lines.filter((line) => line.health === "standby").length;
  const selectedLabel = active?.type === "node"
    ? nodeById.get(active.id)!.label
    : active?.type === "edge"
      ? `${nodeById.get(edgeById.get(active.id)!.from)?.label || "?"} → ${nodeById.get(edgeById.get(active.id)!.to)?.label || "?"}`
      : null;
  // 画布高度跟着图走：按宽度整张放下有多高就多高。手机上不封顶（竖着划滚的是页面，整张图都在页面里）；
  // 电脑上封顶 680，太高的在图里上下拖。
  const canvasHeight = myLinesCanvasHeight(layout, frameWidth, compact ? 2400 : 680);
  return (
    <div className="flex flex-col gap-3" data-testid="my-lines">
      {/* 缩放按钮放在图上面这一行：放在图里会压住最右边那列（落地 / 出口） */}
      <div className="flex items-center gap-2 px-1">
        <p className="min-w-0 flex-1 text-meta text-muted-foreground" data-testid="my-lines-summary">
          {lines.length} 条线路{down > 0 ? ` · ${down} 条不通` : ""}{standby > 0 ? ` · ${standby} 条停用` : ""} · 点线路、节点或连线看经过哪里
        </p>
        <div className="flex shrink-0 gap-1">
          <Button type="button" variant="outline" size="icon" className="h-7 w-7 bg-card" aria-label="缩小" title="缩小" onClick={() => canvasRef.current?.zoomBy(0.8)}><Minus className="h-3.5 w-3.5" /></Button>
          <Button type="button" variant="outline" size="icon" className="h-7 w-7 bg-card" aria-label="放大" title="放大" onClick={() => canvasRef.current?.zoomBy(1.25)}><Plus className="h-3.5 w-3.5" /></Button>
          <Button type="button" variant="outline" size="icon" className="h-7 w-7 bg-card" aria-label="放下全图" title="放下全图" onClick={() => canvasRef.current?.fit()}><Maximize2 className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      <div ref={setFrame} className="overflow-hidden rounded-[var(--fx-radius-card,16px)] border border-[var(--fx-stroke-weak)] bg-card" data-testid="my-lines-graph">
        <div style={{ height: canvasHeight }}>
          <TopologyCanvas
            ref={canvasRef}
            nodes={graph.nodes}
            edges={graph.edges}
            layout={layout}
            columnLabels={columnLabels}
            highlight={highlight}
            selectedId={active && active.type !== "line" ? active.id : null}
            ruleNames={lineNames}
            onSelectNode={(node) => setSelection({ type: "node", id: node.id })}
            onSelectEdge={(edge) => setSelection({ type: "edge", id: edge.id })}
            onClearSelection={() => setSelection(null)}
            nodeCaption={(node) => graph.captions.get(node.id) || topologyRoleText(node)}
            compact={compact}
            minReadableScale={MY_LINES_MIN_SCALE}
            topInset={MY_LINES_LABEL_BAND}
            touchAction={compact ? "pan-y" : "none"}
            className="h-full w-full"
          />
        </div>
      </div>
      <div className="overflow-hidden rounded-[var(--fx-radius-card,16px)] border border-[var(--fx-stroke-weak)] bg-card" data-testid="my-lines-list">
        {selectedLabel ? (
          <div className="flex items-center gap-2 border-b border-[var(--fx-stroke-weak)] px-3 py-2 text-meta">
            <span className="min-w-0 flex-1 truncate">经过「{selectedLabel}」的 {listed.length} 条线路</span>
            <button type="button" className="inline-flex items-center gap-1 font-semibold text-[var(--fx-accent)]" onClick={() => setSelection(null)} data-testid="my-lines-clear">
              <X className="h-3.5 w-3.5" aria-hidden="true" />全部线路
            </button>
          </div>
        ) : null}
        <ul>
          {listed.map((line) => (
            <MyLineRow
              key={line.id}
              line={line}
              selected={active?.type === "line" && active.id === line.id}
              onSelect={() => setSelection(active?.type === "line" && active.id === line.id ? null : { type: "line", id: line.id })}
              onEdit={() => setLocation(`/rules?edit=${line.id}`)}
              onDiagnose={() => setLocation(`/rules?diagnose=${line.id}`)}
              onOpenDetail={line.kind === "route" ? () => setLocation(lineDetailHref(line.id)) : undefined}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
