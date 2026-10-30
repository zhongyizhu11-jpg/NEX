import { useMemo, useState } from "react";
import { ChevronDown, Signpost } from "lucide-react";
import { useLocation } from "wouter";

import EmptyState from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatRate, type RouteSegment } from "@/features/rules/RouteBoard";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { buildLineModel, type LineHop, type LineModel, type LineProbe, type LineRate, type LineTraffic } from "./myLines";

/*
  网络拓扑 › 我的线路：泳道图。整块是点阵画布，三列（入口 / 中转 / 落地，配了出口再多一列）
  上下对齐；每条线一条半透明泳道，泳道左上角一枚标题框（名字、几条路径、整链延迟、切换次数、
  收起箭头）；泳道里节点是白卡 —— 空心圆环 + 名字、角色（入口写延迟）、↓ ↑ 此刻速率；
  节点之间一条虚线，线中间骑一枚延迟药丸（没单独探测的段不骑）。

  这是看「我的每条线现在从哪进、经过谁、到哪落地、通不通、跑多快」的地方，建和改还在
  隧道 / 转发链 / 转发组那几页。数字来自现成的查询：rules.list（规则 + 出口）、
  rules.trafficSummary（最近探测 + 此刻速率）、rules.routeBoard（线路组当前路径各段、各跳速率、
  切换次数）、hosts / tunnels / forwardGroups 的 options。
*/

const PLANNED_SEGMENT: RouteSegment = { key: "planned", latencyMs: null, state: "planned", failures: 0, at: null, title: "这一段没有单独的探测，整条线的延迟看泳道头" };

function LaneNode({ hop, role, caption, rate, title }: { hop: LineHop; role: "entry" | "relay" | "landing" | "exit"; caption: string; rate: LineRate | null; title?: string }) {
  return (
    <div className="fx-lane-node" data-health={hop.health} data-role={role} title={[hop.title, title].filter(Boolean).join("\n") || undefined}>
      <span className="fx-lane-node-head"><i aria-hidden="true" /><b>{hop.name}</b></span>
      <span className="fx-lane-node-caption">{caption}</span>
      <span className="fx-lane-node-rate" title={rate ? `${rate.connections} 个连接` : "此刻没有流量"}>
        <span>↓ {rate ? formatRate(rate.inBps) : "—"}</span>
        <span>↑ {rate ? formatRate(rate.outBps) : "—"}</span>
      </span>
    </div>
  );
}

function LaneSegment({ segment, flowing }: { segment: RouteSegment; flowing: boolean }) {
  const pill = segment.state === "measured" && segment.latencyMs !== null
    ? `${Math.round(segment.latencyMs)} ms`
    : segment.state === "failed"
      ? `不通${segment.failures > 0 ? ` ×${segment.failures}` : ""}`
      : segment.state === "unknown"
        ? "未测"
        : null;
  return (
    <span className="fx-lane-seg" data-state={segment.state} data-flow={flowing && segment.state !== "failed" ? "" : undefined} title={segment.title}>
      <i aria-hidden="true" />
      {pill ? <span className="fx-lane-pill">{pill}</span> : null}
    </span>
  );
}

/** 泳道头上「N 个候选，M 个分流组」那一句，这里写线路是什么、几条路径、绑了哪个节点。 */
function describeLine(line: LineModel) {
  const parts = [line.kindLabel];
  if (line.pathCount > 1) parts.push(`${line.pathCount} 条路径`);
  if (line.subscription) parts.push(line.subscription.visible ? `订阅「${line.subscription.nodeName}」` : "订阅已隐藏");
  if (line.owner) parts.push(line.owner);
  return parts.join("，");
}

export function LineCard({ line, onEdit, onDiagnose, withExitColumn = !!line.exit }: { line: LineModel; onEdit?: () => void; onDiagnose?: () => void; withExitColumn?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const probe = line.probe;
  const flowing = line.health === "healthy" && !!line.rate && (line.rate.inBps > 0 || line.rate.outBps > 0);
  // 节点之间的段：线路组有线路板各段；别的线路只有端到端一个数 —— 只有一段时就写在那一段上，
  // 多段时每段只画线不骑药丸，整条线的延迟在泳道头。
  const gaps = line.hops.length + 1;
  const segments: RouteSegment[] = Array.from({ length: gaps }, (_, index) => {
    const own = line.segments[index];
    if (own) return { ...own, key: `${own.key}-${index}` };
    if (gaps === 1 && probe && line.health !== "standby") {
      if (probe.isTimeout) return { key: "e2e", latencyMs: null, state: "failed", failures: 0, at: null, title: `入口探落地不通（${line.statusText}）` };
      if (probe.latencyMs !== null && line.health === "healthy") return { key: "e2e", latencyMs: probe.latencyMs, state: "measured", failures: 0, at: null, title: "入口探落地（端到端）" };
    }
    return { ...PLANNED_SEGMENT, key: `planned-${index}` };
  });
  const latencyChip = line.health === "standby"
    ? <span className="fx-lane-chip" data-tone="off">已停用</span>
    : probe?.isTimeout
      ? <span className="fx-lane-chip" data-tone="down" title={line.statusText}>整链不通</span>
      : probe && probe.latencyMs !== null
        ? <span className="fx-lane-chip" data-tone={line.health === "down" ? "down" : undefined} title={line.statusText}>整链 {Math.round(probe.latencyMs)} ms</span>
        : <span className="fx-lane-chip" data-tone="off" title={line.statusText}>整链未测</span>;
  const entryCaption = probe && probe.latencyMs !== null && !probe.isTimeout && line.health !== "standby" ? `入口，${Math.round(probe.latencyMs)} ms` : line.entry.caption;
  const lineRate = line.rate;
  return (
    <section className="fx-lane" data-health={line.health} data-collapsed={collapsed ? "" : undefined} data-testid="line-card" data-kind={line.kind}>
      <header className="fx-lane-head">
        <span className="fx-lane-title" title={line.statusText}>
          <b className="truncate">{line.name}</b>
          <span className="fx-lane-sub">{describeLine(line)}</span>
          {latencyChip}
          {line.switches && line.switches.count24h > 0 ? (
            <button type="button" className="fx-lane-link" onClick={onDiagnose} title={line.switches.lastFromLabel && line.switches.lastToLabel ? `最近一次：${line.switches.lastFromLabel} → ${line.switches.lastToLabel}` : undefined} data-testid="route-switch-chip">
              {line.switches.flapping ? "来回切换" : line.switches.manual24h > 0 ? "经手动切换" : "经切换"} ×{line.switches.count24h}
            </button>
          ) : null}
          <button type="button" className="fx-lane-toggle" aria-label={collapsed ? "展开这条线路" : "收起这条线路"} aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", collapsed && "-rotate-90")} aria-hidden="true" />
          </button>
        </span>
        <span className="fx-lane-actions">
          {onDiagnose ? <button type="button" className="fx-lane-link" onClick={onDiagnose}>诊断</button> : null}
          {onEdit ? <button type="button" className="fx-lane-link" onClick={onEdit}>编辑</button> : null}
        </span>
      </header>
      {collapsed ? null : (
        <div className="fx-lane-row" data-exit={withExitColumn ? "" : undefined} data-testid="line-chain">
          <div className="fx-lane-cell" data-col="entry">
            <LaneNode hop={line.entry} role="entry" caption={entryCaption} rate={line.entry.rate ?? lineRate} title={line.entry.address ? `${line.entry.caption} · ${line.entry.address}` : line.entry.caption} />
          </div>
          <div className="fx-lane-cell fx-lane-middle" data-col="relay">
            {line.hops.map((hop, index) => (
              <span key={hop.key} className="contents">
                <LaneSegment segment={segments[index]} flowing={flowing} />
                <LaneNode hop={hop} role="relay" caption={hop.caption} rate={hop.rate ?? lineRate} />
              </span>
            ))}
            <LaneSegment segment={segments[gaps - 1]} flowing={flowing} />
          </div>
          <div className="fx-lane-cell" data-col="landing">
            <LaneNode hop={line.landing} role="landing" caption={`落地，${line.landing.caption}`} rate={line.hops.length > 0 ? line.hops[line.hops.length - 1].rate ?? lineRate : lineRate} />
          </div>
          {withExitColumn ? (
            <div className="fx-lane-cell fx-lane-exit" data-col="exit">
              {line.exit ? (
                <>
                  <LaneSegment segment={{ ...PLANNED_SEGMENT, key: "exit", title: "落地从这里出去，不单独探" }} flowing={flowing && line.exit.health !== "down"} />
                  <LaneNode hop={line.exit} role="exit" caption={line.exit.caption} rate={lineRate} />
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      <span className="sr-only" data-testid="line-status">{line.statusText}</span>
    </section>
  );
}

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
  const withExitColumn = lines.some((line) => !!line.exit);
  return (
    <div className="fx-lanes" data-testid="my-lines">
      <div className="fx-lane-row fx-lanes-cols" data-exit={withExitColumn ? "" : undefined} aria-hidden="true">
        <span className="fx-lane-cell" data-col="entry">入口</span>
        <span className="fx-lane-cell" data-col="relay">中转</span>
        <span className="fx-lane-cell" data-col="landing">落地</span>
        {withExitColumn ? <span className="fx-lane-cell" data-col="exit">出口</span> : null}
      </div>
      {lines.map((line) => (
        <LineCard
          key={line.id}
          line={line}
          withExitColumn={withExitColumn}
          onEdit={() => setLocation(`/rules?edit=${line.id}`)}
          onDiagnose={() => setLocation(`/rules?diagnose=${line.id}`)}
        />
      ))}
    </div>
  );
}
