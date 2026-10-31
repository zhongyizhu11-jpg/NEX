import { useMemo, useState } from "react";
import { Route } from "lucide-react";
import { useLocation } from "wouter";

import EmptyState from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { routeGroupOf, type RouteGroup } from "@shared/routeGroup";
import { describeRoutePolicy, pinUntilSeconds, type RoutePolicy } from "@shared/routePolicy";
import { RouteBoardCard } from "./RouteBoard";
import { RouteGroupSheet, type RouteStatus } from "./RouteGroupSheet";
import { ROUTE_LINE_MODE_LABEL, chainLatency, routeLandingName, routeLineGroups } from "./routeLineText";
import { LineBig, LineCard, LineChip, LinePill, formatLineMs, type LineTone } from "@/features/lines/LineUi";
import { formatBytes } from "@shared/formatBytes";
import { normalizeRouteDelivery } from "@shared/routeGroup";
import type { ForwardGroupOptionRow, HostOptionRow, LineRuleRow } from "./routeLineOptions";

/*
  线路板：所有开了线路组的转发规则一处看全，每条一张卡，卡里一条路径一条链：
  入口 ─ 中转… ─ 落地，段上写延迟、节点下写速率、在走的那条流着小点。

  挂在链路管理页的「线路总览」里（原来那里是一张表：规则 / 入口 / 策略 / 路径 / 现在走，
  一眼看得出有几条、看不出哪段慢）。Open-Box 的「代理 · 策略」页把每个策略画成一条链，
  用户看了说「很明白」，就按那个意思画。

  数字来自 rules.routeBoard（和规则卡上线路面板读的 rules.routeStatus 是同一份，只是一次拿全），
  策略（首选、时段、人工指定）仍从规则本身算（shared/routePolicy）。线路直接在详情第一页改；
  转发组的子规则拿不到规则本身，详情里「改规则」打开的是那条规则的编辑框（/rules?edit=<id>）。
*/

type RouteBoardRow = { rule: LineRuleRow; group: RouteGroup; policy: RoutePolicy; host: HostOptionRow | undefined };

/** 线路工作台的紧凑卡（2.3.496，效果图 ④）：名字、在走哪条、整条链毫秒、用法标签；点开是线路详情。 */
type CompactInfo = { entryPool: { count: number; dns: boolean } | null; trafficBytes: number };

/** 卡片排序：有问题的在前（全坏 → 走备用 → 暂停），正常的在后，同档按名字。 */
export function lineCardRank(status: RouteStatus) {
  const groups = routeLineGroups(status);
  const active = groups.find((group) => group.active);
  if (groups.length > 0 && groups.every((group) => group.allDown)) return 0;
  if (active && active.index > 0) return 1;
  if (!active) return 2;
  return 3;
}

function LineCompactCard({ name, owner, status, info, onOpen }: { name: string; owner: string | null; status: RouteStatus; info: CompactInfo; onOpen: () => void }) {
  const groups = routeLineGroups(status);
  const activeGroup = groups.find((group) => group.active) || null;
  const active = status.paths.find((path) => path.active) || null;
  const allDown = groups.length > 0 && groups.every((group) => group.allDown);
  const total = chainLatency(active);
  const lineIndex = activeGroup ? activeGroup.index : -1;
  const tone: LineTone = allDown ? "down" : lineIndex > 0 ? "warn" : lineIndex === 0 ? "ok" : "gray";
  const pill = allDown ? "全部故障" : lineIndex > 0 ? `走备 ${lineIndex}` : lineIndex === 0 ? "主线路" : "还没报";
  const hops = active ? active.hops.map((hop) => (hop.viaTunnel ? `隧道 ${hop.name}` : hop.name)) : [];
  const entry = info.entryPool ? `入口池 ×${info.entryPool.count}` : status.entry?.name || "入口";
  const main = groups[0];
  const suffix = allDown
    ? (groups[0]?.reason || "都不通")
    : lineIndex > 0
      ? (main?.paused ? "主线路暂停" : main?.reason ? `主线路${/维护/.test(main.reason) ? "维护" : "故障"}` : "主线路故障")
      : groups.length > 1 ? `备用 ${groups.length - 1}` : "";
  const chain = active ? [entry, ...hops, routeLandingName(active)].join(" → ") : "调度这条线路的 Agent 还没上报";
  const delivery = normalizeRouteDelivery(status.delivery);
  const mainCount = status.paths.filter((path) => (typeof path.tier === "number" ? path.tier : path.index) === 0).length;
  const chips = [
    ROUTE_LINE_MODE_LABEL[status.policy.mode] || "主备顺序",
    delivery === "hot" ? "切换不断连" : delivery === "aggregate" ? (mainCount > 1 ? `聚合 ${mainCount} 条` : "聚合（只有 1 条）") : delivery === "replicate" ? "复制双发" : null,
    info.entryPool?.dns ? "DNS 入口池" : null,
    info.trafficBytes > 0 ? formatBytes(info.trafficBytes) : null,
  ].filter((chip): chip is string => !!chip);
  return (
    <LineCard className="cursor-pointer p-3 hover:border-[var(--fx-stroke)]" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }} data-testid="line-compact-card">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <b className="min-w-0 truncate text-[14px]">{name}{owner ? <span className="ml-1.5 text-[11.5px] font-normal text-muted-foreground">{owner}</span> : null}</b>
        <LinePill tone={tone} dot>{pill}</LinePill>
      </div>
      <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[12px] text-muted-foreground">{chain}{active && suffix ? ` · ${suffix}` : ""}</span>
        {total === null
          ? <span className="shrink-0 text-[12px] text-muted-foreground">未测</span>
          : <LineBig size={20} tone={tone === "ok" ? "acc" : tone} value={formatLineMs(total)} unit="ms" className="shrink-0" />}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {chips.map((chip) => <LineChip key={chip}>{chip}</LineChip>)}
      </div>
    </LineCard>
  );
}

export function RouteBoardList({ searchQuery = "", isAdmin = false, compact = false }: { searchQuery?: string; isAdmin?: boolean; compact?: boolean }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  // 只拉开了主备的规则：以前拉全部规则再在这里按 failoverEnabled 丢掉绝大多数。
  const rulesQuery = trpc.rules.list.useQuery(isAdmin ? { scope: "all", failoverOnly: true } : { failoverOnly: true }, { staleTime: 15_000 });
  const hostsQuery = trpc.hosts.options.useQuery(undefined, { staleTime: 60_000 });
  // 线路板的数字几秒就变（速率、评分），十秒刷一次；每条规则要查几张表，再快就是白打库。
  const boardQuery = trpc.rules.routeBoard.useQuery(isAdmin ? { scope: "all" } : undefined, {
    refetchInterval: pollingInterval("log"),
    staleTime: 5_000,
    placeholderData: (previous) => previous,
  });
  const [openRuleId, setOpenRuleId] = useState<number | null>(null);
  const hostById = useMemo(() => new Map<number, HostOptionRow>(((hostsQuery.data || []) as HostOptionRow[]).map((host) => [Number(host.id), host])), [hostsQuery.data]);
  const hostName = (hostId: number) => String(hostById.get(hostId)?.name || `主机 ${hostId}`);

  const pinMutation = trpc.rules.update.useMutation({
    onSuccess: (_data, variables) => {
      utils.rules.list.invalidate();
      utils.rules.listPage.invalidate();
      utils.rules.routeStatus.invalidate({ ruleId: Number(variables.id) });
      utils.rules.routeEvents.invalidate({ ruleId: Number(variables.id) });
      utils.rules.routeBoard.invalidate();
      toast.success(variables.failoverPinnedIndex === null || variables.failoverPinnedIndex === undefined
        ? "已交回自动"
        : "已手动指定：调度这条线路的机器收到就切过去");
    },
    onError: (error) => toast.error(error.message || "操作失败"),
  });

  const boardByRule = useMemo(() => new Map((boardQuery.data || []).map((item) => [Number(item.ruleId), item])), [boardQuery.data]);
  // 紧凑卡要的：近 24 小时流量（端口转发资源算它几台成员规则的合计）、入口是不是一个入口池。
  const groupsQuery = trpc.forwardGroups.options.useQuery(undefined, { enabled: compact, staleTime: 60_000, refetchOnWindowFocus: false });
  const allRules = (rulesQuery.data || []) as LineRuleRow[];
  const childIdsByTemplate = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const rule of allRules) {
      const parent = Number(rule.forwardGroupRuleId || 0);
      if (parent > 0) map.set(parent, [...(map.get(parent) || []), Number(rule.id)]);
    }
    return map;
  }, [allRules]);
  const trafficRuleIds = useMemo(() => (compact ? allRules.map((rule) => Number(rule.id)).filter((id) => id > 0).slice(0, 500) : []), [compact, allRules]);
  const trafficQuery = trpc.rules.trafficSummary.useQuery({ hours: 24, range: "24h", ruleIds: trafficRuleIds }, { enabled: compact && trafficRuleIds.length > 0, staleTime: 30_000, refetchOnWindowFocus: false });
  const trafficByRule = useMemo(() => {
    const map = new Map<number, number>();
    for (const row of trafficQuery.data || []) map.set(Number(row.ruleId), (map.get(Number(row.ruleId)) || 0) + Number(row.bytesIn || 0) + Number(row.bytesOut || 0));
    return map;
  }, [trafficQuery.data]);
  const compactInfo = (rule: LineRuleRow): CompactInfo => {
    const templateChildren = childIdsByTemplate.get(Number(rule.id)) || [];
    const trafficBytes = (trafficByRule.get(Number(rule.id)) || 0) + templateChildren.reduce((sum, id) => sum + (trafficByRule.get(id) || 0), 0);
    const group = Number(rule.forwardGroupId || 0) > 0 ? ((groupsQuery.data || []) as ForwardGroupOptionRow[]).find((item) => Number(item.id) === Number(rule.forwardGroupId)) : null;
    const members = group ? (group.members || []).filter((member) => member.isEnabled !== false && member.isEnabled !== 0).length : 0;
    return { trafficBytes, entryPool: group && members > 1 ? { count: members, dns: !!group.domain } : null };
  };

  const rows = useMemo<RouteBoardRow[]>(() => {
    const query = searchQuery.trim().toLowerCase();
    return allRules.flatMap((rule): RouteBoardRow[] => {
      const group = routeGroupOf(rule);
      if (!group) return [];
      const host = hostById.get(Number(rule.hostId));
      const name = String(host?.name || `主机 ${rule.hostId}`);
      const haystack = [rule.name, name, ...group.paths.flatMap((path) => [path.name, ...path.hops.map(hostName)])].join(" ").toLowerCase();
      if (query && !haystack.includes(query)) return [];
      const policy = describeRoutePolicy(rule, { host });
      if (!policy) return [];
      return [{ rule, group, policy, host }];
    });
  }, [rulesQuery.data, hostById, searchQuery]);

  const openRule = rows.find((row) => Number(row.rule.id) === openRuleId) || null;

  if (rulesQuery.isLoading) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="p-6 text-center text-sm text-muted-foreground">在读线路组…</CardContent>
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Route className="h-6 w-6" />}
        title={searchQuery ? "没有匹配的线路组" : "还没有线路组"}
        description="线路组是转发规则的一部分：一个入口后面挂几条路径（可以经过中转），出问题自动换，也能定时、择优、按权重分流。在规则的编辑框里勾上「线路组」就有了。"
        actions={<Button type="button" onClick={() => setLocation("/rules")}>去转发规则</Button>}
      />
    );
  }

  return (
    <>
      {/* 线路工作台的小卡在宽屏上排两列（手机上一列，和效果图一样） */}
      <div className={cn(compact ? "grid grid-cols-1 gap-3 xl:grid-cols-2" : "flex flex-col gap-3")} data-testid="route-board-list">
        {(compact
          ? [...rows].sort((a, b) => {
            const sa = boardByRule.get(Number(a.rule.id))?.status as RouteStatus | undefined;
            const sb = boardByRule.get(Number(b.rule.id))?.status as RouteStatus | undefined;
            const ra = sa ? lineCardRank(sa) : 4;
            const rb = sb ? lineCardRank(sb) : 4;
            return ra - rb || String(a.rule.name || "").localeCompare(String(b.rule.name || ""), "zh-CN");
          })
          : rows).map((row) => {
          const board = boardByRule.get(Number(row.rule.id));
          const status = (board?.status as RouteStatus | undefined) || null;
          return status && compact ? (
            <LineCompactCard
              key={row.rule.id}
              name={String(row.rule.name || "")}
              owner={isAdmin && row.rule.userName ? String(row.rule.userName) : null}
              status={status}
              info={compactInfo(row.rule)}
              onOpen={() => setOpenRuleId(Number(row.rule.id))}
            />
          ) : status ? (
            <RouteBoardCard
              key={row.rule.id}
              name={String(row.rule.name || "")}
              owner={isAdmin && row.rule.userName ? String(row.rule.userName) : null}
              status={status}
              policy={row.policy}
              onOpen={() => setOpenRuleId(Number(row.rule.id))}
              onEdit={() => setLocation(`/rules?edit=${Number(row.rule.id)}`)}
            />
          ) : (
            <Card key={row.rule.id} className="border-border bg-card">
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.rule.name}</p>
                  <p className="truncate text-meta text-muted-foreground">{boardQuery.isLoading ? "在读线路状态…" : "读不到线路状态"}</p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setOpenRuleId(Number(row.rule.id))}>查看</Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <RouteGroupSheet
        open={openRuleId !== null}
        onOpenChange={(open) => !open && setOpenRuleId(null)}
        ruleId={openRuleId}
        subjectName={String(openRule?.rule.name || "")}
        policy={openRule?.policy ?? null}
        rule={openRule && !Number(openRule.rule.forwardGroupRuleId || 0) ? openRule.rule : undefined}
        canEdit
        pending={pinMutation.isPending}
        onPin={(index, durationSeconds) => openRule && pinMutation.mutate({
          id: Number(openRule.rule.id),
          failoverPinnedIndex: index,
          failoverPinnedUntil: pinUntilSeconds(durationSeconds),
        })}
        onUnpin={() => openRule && pinMutation.mutate({ id: Number(openRule.rule.id), failoverPinnedIndex: null, failoverPinnedUntil: null })}
        onEdit={() => { const id = openRuleId; setOpenRuleId(null); if (id) setLocation(`/rules?edit=${id}`); }}
      />
    </>
  );
}
