import { useMemo, useState } from "react";
import { Route } from "lucide-react";
import { useLocation } from "wouter";

import EmptyState from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { routeGroupOf, routePathLetter, type RouteGroup } from "@shared/routeGroup";
import { describeRoutePolicy, pinUntilSeconds, type RoutePolicy } from "@shared/routePolicy";
import { RouteBoardCard } from "./RouteBoard";
import { RouteGroupSheet, type RouteStatus } from "./RouteGroupSheet";

/*
  链路管理页的「线路组」页签 —— 线路板：所有开了线路组的转发规则一处看全，每条一张卡，
  卡里一条路径一条链：入口 ─ 中转… ─ 落地，段上写延迟、节点下写速率、在走的那条流着小点。

  原来这里是一张表（规则 / 入口 / 策略 / 路径 / 现在走），一眼看得出有几条、看不出哪段慢。
  Open-Box 的「代理 · 策略」页把每个策略画成一条链，用户看了说「很明白」，就按那个意思画。

  数字来自 rules.routeBoard（和规则卡上线路面板读的 rules.routeStatus 是同一份，只是一次拿全），
  策略（首选、时段、人工指定）仍从规则本身算（shared/routePolicy）。线路组是规则的一部分，
  「编辑」打开的就是那条规则的编辑框（/rules?edit=<id>）。
*/

type RouteBoardRow = { rule: any; group: RouteGroup; policy: RoutePolicy; host: any };

export function RouteGroupsSection({ searchQuery = "", isAdmin = false }: { searchQuery?: string; isAdmin?: boolean }) {
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
  const hostById = useMemo(() => new Map<number, any>((hostsQuery.data || []).map((host: any) => [Number(host.id), host])), [hostsQuery.data]);
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
        : `已强制走路径 ${routePathLetter(variables.failoverPinnedIndex)}`);
    },
    onError: (error) => toast.error(error.message || "操作失败"),
  });

  const boardByRule = useMemo(() => new Map<number, any>(((boardQuery.data as any[]) || []).map((item) => [Number(item.ruleId), item])), [boardQuery.data]);

  const rows = useMemo<RouteBoardRow[]>(() => {
    const query = searchQuery.trim().toLowerCase();
    return (rulesQuery.data || []).flatMap((rule: any): RouteBoardRow[] => {
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
      <div className="flex flex-col gap-3" data-testid="route-board">
        {rows.map((row) => {
          const board = boardByRule.get(Number(row.rule.id));
          const status = (board?.status as RouteStatus | undefined) || null;
          return status ? (
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
