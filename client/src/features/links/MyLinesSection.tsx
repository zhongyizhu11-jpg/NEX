import { useMemo } from "react";
import { Signpost, Zap } from "lucide-react";
import { useLocation } from "wouter";

import EmptyState from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LineChain, type LineNode } from "@/features/rules/RouteBoard";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { formatBytes } from "@shared/formatBytes";
import { buildLineModel, type LineModel, type LineProbe, type LineTraffic } from "./myLines";

/*
  链路管理 › 我的线路：每条转发一张卡，卡里一条链 —— 入口 → 经过什么 → 落地 → （出口）。

  这是进链路管理第一眼看到的页签。它不替代隧道 / 转发链 / 转发组那几页（建和改还在那儿），
  只回答「我的每条线现在从哪进、经过谁、到哪落地、从哪出去、通不通、跑了多少」。
  数字来自现成的查询：rules.list（规则 + 出口）、rules.trafficSummary（最近探测 + 24h 流量）、
  rules.routeBoard（线路组当前路径各段）、hosts / tunnels / forwardGroups 的 options。
*/

export function LineCard({ line, onEdit, onDiagnose }: { line: LineModel; onEdit?: () => void; onDiagnose?: () => void }) {
  const nodes: LineNode[] = [
    { key: line.entry.key, role: "entry", name: line.entry.name, caption: <>{line.entry.caption}{line.entry.address ? <> · <span className="font-mono">{line.entry.address}</span></> : null}</>, health: line.entry.health, title: line.entry.title },
    ...line.hops.map((hop): LineNode => ({ key: hop.key, role: "relay", name: hop.name, caption: hop.caption, health: hop.health, title: hop.title })),
    { key: line.landing.key, role: "landing", name: line.landing.name, caption: <span className={line.subscription ? undefined : "font-mono"}>{line.landing.caption}</span>, health: line.landing.health, title: line.landing.title },
    ...(line.exit ? [{ key: line.exit.key, role: "landing" as const, name: line.exit.name, caption: line.exit.caption, health: line.exit.health, title: line.exit.title }] : []),
  ];
  const probe = line.probe;
  const latencyChip = probe && line.health !== "standby"
    ? probe.isTimeout
      ? <span className="fx-rb-chip" data-tone={line.health === "down" ? "down" : "off"} title={line.statusText}>不通</span>
      : probe.latencyMs !== null
        ? <span className="fx-rb-chip" data-tone={line.health === "healthy" ? (probe.latencyMs < 150 ? "ok" : probe.latencyMs < 300 ? "warn" : "down") : "off"} title={line.statusText}>端到端 {Math.round(probe.latencyMs)} ms</span>
        : null
    : null;
  return (
    <section className="fx-rb-path" data-health={line.health} data-active={line.health === "healthy" ? "" : undefined} data-testid="line-card" data-kind={line.kind}>
      <header className="fx-rb-path-head">
        <span className="fx-rb-path-title">
          <span className="fx-rb-node" data-health={line.health} title={line.statusText} style={{ minWidth: 0 }}>
            <span className="fx-rb-node-head"><i aria-hidden="true" /><b className="truncate">{line.name}</b></span>
          </span>
          <span className="fx-rb-meta">{line.kindLabel}</span>
          {line.subscription ? (
            <span className="fx-rule-mark" data-muted={line.subscription.visible ? undefined : ""} title={line.subscription.visible ? `以「${line.subscription.nodeName}」的身份出现在订阅里` : `绑定了「${line.subscription.nodeName}」，但设成了不进订阅`}>
              <Zap className="h-3 w-3" aria-hidden="true" />{line.subscription.visible ? "订阅" : "订阅已隐藏"}
            </span>
          ) : null}
          {line.owner ? <span className="fx-rb-meta">{line.owner}</span> : null}
        </span>
        <span className="fx-rb-path-stats">
          {latencyChip}
          {line.traffic ? <span className="fx-rb-meta" title="近 24 小时：入向 · 出向">24H ↓ {formatBytes(line.traffic.bytesIn)} · ↑ {formatBytes(line.traffic.bytesOut)}</span> : null}
          {onDiagnose ? <button type="button" className="fx-rb-open" onClick={onDiagnose}>诊断</button> : null}
          {onEdit ? <button type="button" className="fx-rb-open" onClick={onEdit}>编辑</button> : null}
        </span>
      </header>
      <LineChain nodes={nodes} segments={line.segments} flowing={line.health === "healthy"} />
      <p className="fx-rb-meta" data-testid="line-status">{line.statusText}</p>
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
    refetchInterval: pollingInterval("normal"),
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
    for (const row of ((summaryQuery.data || []) as any[])) {
      const ruleId = Number(row.ruleId || 0);
      if (ruleId <= 0) continue;
      const prevTraffic = trafficByRule.get(ruleId) || { bytesIn: 0, bytesOut: 0 };
      trafficByRule.set(ruleId, { bytesIn: prevTraffic.bytesIn + (Number(row.bytesIn) || 0), bytesOut: prevTraffic.bytesOut + (Number(row.bytesOut) || 0) });
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
      .map((rule) => buildLineModel(rule, { hostById, tunnelById, groupById, nodeNameById, routeStatusByRule, probeByRule, trafficByRule }))
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
  return (
    <div className="flex flex-col gap-3" data-testid="my-lines">
      {lines.map((line) => (
        <LineCard
          key={line.id}
          line={line}
          onEdit={() => setLocation(`/rules?edit=${line.id}`)}
          onDiagnose={() => setLocation(`/rules?diagnose=${line.id}`)}
        />
      ))}
    </div>
  );
}
