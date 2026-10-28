import { useMemo, useState } from "react";
import { GitBranch, Route } from "lucide-react";
import { useLocation } from "wouter";

import EmptyState from "@/components/EmptyState";
import { StatusDot } from "@/components/network/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FAILOVER_TONE_CLASS, describeFailoverLineDisplay } from "@/lib/failoverLineDisplay";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ROUTE_MODE_INFO, describeRoutePath, routeGroupOf, routePathLetter, type RouteGroup } from "@shared/routeGroup";
import { describeRoutePolicy, pinUntilSeconds } from "@shared/routePolicy";
import { RouteGroupSheet } from "./RouteGroupSheet";

/*
  链路管理页的「线路组」页签：所有开了线路组的转发规则一处看全。

  规则页上线路组藏在每条规则的徽标后面，要一条条点；这里一行一条：入口在哪台机、哪种策略、
  几条路径各经过谁、现在走哪条。点「查看」进的是和规则页同一块线路面板。线路组是规则的一部分，
  不是独立对象，所以「编辑」打开的就是那条规则的编辑框（/rules?edit=<id>），改完回来接着看。
*/

type RouteGroupRow = {
  rule: any;
  group: RouteGroup;
  hostName: string;
  entry: string;
  display: ReturnType<typeof describeFailoverLineDisplay>;
};

export function RouteGroupsSection({ searchQuery = "", isAdmin = false }: { searchQuery?: string; isAdmin?: boolean }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  // 只拉开了主备的规则：以前拉全部规则再在这里按 failoverEnabled 丢掉绝大多数。
  const rulesQuery = trpc.rules.list.useQuery(isAdmin ? { scope: "all", failoverOnly: true } : { failoverOnly: true }, { staleTime: 15_000 });
  const hostsQuery = trpc.hosts.options.useQuery(undefined, { staleTime: 60_000 });
  const [openRuleId, setOpenRuleId] = useState<number | null>(null);
  const hostById = useMemo(() => new Map<number, any>((hostsQuery.data || []).map((host: any) => [Number(host.id), host])), [hostsQuery.data]);
  const hostName = (hostId: number) => String(hostById.get(hostId)?.name || `主机 ${hostId}`);

  const pinMutation = trpc.rules.update.useMutation({
    onSuccess: (_data, variables) => {
      utils.rules.list.invalidate();
      utils.rules.listPage.invalidate();
      utils.rules.routeStatus.invalidate({ ruleId: Number(variables.id) });
      utils.rules.routeEvents.invalidate({ ruleId: Number(variables.id) });
      toast.success(variables.failoverPinnedIndex === null || variables.failoverPinnedIndex === undefined
        ? "已交回自动"
        : `已强制走路径 ${routePathLetter(variables.failoverPinnedIndex)}`);
    },
    onError: (error) => toast.error(error.message || "操作失败"),
  });

  const rows = useMemo<RouteGroupRow[]>(() => {
    const query = searchQuery.trim().toLowerCase();
    return (rulesQuery.data || []).flatMap((rule: any) => {
      const group = routeGroupOf(rule);
      if (!group) return [];
      const host = hostById.get(Number(rule.hostId));
      const name = String(host?.name || `主机 ${rule.hostId}`);
      const entry = `${name}:${rule.sourcePort}`;
      const haystack = [rule.name, name, ...group.paths.flatMap((path) => [path.name, ...path.hops.map(hostName)])].join(" ").toLowerCase();
      if (query && !haystack.includes(query)) return [];
      return [{ rule, group, hostName: name, entry, display: describeFailoverLineDisplay(rule, host) }];
    });
  }, [rulesQuery.data, hostById, searchQuery]);

  const openRule = rows.find((row) => Number(row.rule.id) === openRuleId) || null;
  const openPolicy = openRule ? describeRoutePolicy(openRule.rule, { host: hostById.get(Number(openRule.rule.hostId)) }) : null;

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

  const pathText = (row: RouteGroupRow, index: number) => describeRoutePath(row.group.paths[index], row.rule, hostName);

  return (
    <>
      {/* 手机上一张卡一条；桌面是一张表。同一份数据两种排法，不是两份数据。 */}
      <div className="flex flex-col gap-3 sm:hidden">
        {rows.map((row) => (
          <Card key={row.rule.id} className="border-border bg-card">
            <CardContent className="flex flex-col gap-2 p-4">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.rule.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{row.entry}</p>
                </div>
                {row.display ? (
                  <Badge variant="outline" className={cn("h-5 shrink-0 gap-1 px-1.5 text-[10px] font-medium", FAILOVER_TONE_CLASS[row.display.tone])}>
                    <GitBranch className="h-3 w-3" aria-hidden="true" />
                    {row.display.text}
                  </Badge>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{ROUTE_MODE_INFO[row.group.policy.mode].template} · {ROUTE_MODE_INFO[row.group.policy.mode].label}</p>
              <ul className="flex flex-col gap-1 text-xs">
                {row.group.paths.map((path, index) => (
                  <li key={path.key} className="flex min-w-0 items-center gap-2">
                    <StatusDot health={path.issue ? "down" : row.display?.policy.lines[index]?.active ? "healthy" : "standby"} />
                    <span className="shrink-0 font-semibold">{routePathLetter(index)}</span>
                    <span className="min-w-0 truncate">{path.name} · {pathText(row, index)}</span>
                  </li>
                ))}
              </ul>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setLocation(`/rules?edit=${Number(row.rule.id)}`)}>编辑</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setOpenRuleId(Number(row.rule.id))}>查看</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="hidden border-border bg-card sm:block">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>规则</TableHead>
                  <TableHead>入口</TableHead>
                  <TableHead className="hidden md:table-cell">策略</TableHead>
                  <TableHead>路径</TableHead>
                  <TableHead>现在走</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.rule.id} className="h-[60px]">
                    <TableCell className="py-3">
                      <span className="block max-w-[14rem] truncate text-sm font-medium">{row.rule.name}</span>
                      {isAdmin && row.rule.userName ? <span className="block text-xs text-muted-foreground">{row.rule.userName}</span> : null}
                    </TableCell>
                    <TableCell className="py-3 font-mono text-xs">{row.entry}</TableCell>
                    <TableCell className="hidden py-3 text-xs md:table-cell">
                      <span className="block">{ROUTE_MODE_INFO[row.group.policy.mode].template}</span>
                      <span className="block text-muted-foreground">{ROUTE_MODE_INFO[row.group.policy.mode].label}</span>
                    </TableCell>
                    <TableCell className="py-3">
                      <ul className="flex flex-col gap-0.5 text-xs">
                        {row.group.paths.map((path, index) => (
                          <li key={path.key} className="flex min-w-0 items-center gap-1.5">
                            <span className={cn("w-3 shrink-0 font-semibold", path.issue && "text-destructive")}>{routePathLetter(index)}</span>
                            <span className="max-w-[22rem] truncate" title={pathText(row, index)}>{pathText(row, index)}</span>
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                    <TableCell className="py-3">
                      {row.display ? (
                        <button type="button" className="rounded-[var(--fx-radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setOpenRuleId(Number(row.rule.id))} title={row.display.title}>
                          <Badge variant="outline" className={cn("h-5 cursor-pointer gap-1 px-1.5 text-[10px] font-medium", FAILOVER_TONE_CLASS[row.display.tone])}>
                            <GitBranch className="h-3 w-3" aria-hidden="true" />
                            {row.display.text}
                          </Badge>
                        </button>
                      ) : null}
                    </TableCell>
                    <TableCell className="py-3 text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button type="button" variant="ghost" size="sm" onClick={() => setLocation(`/rules?edit=${Number(row.rule.id)}`)}>编辑</Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setOpenRuleId(Number(row.rule.id))}>查看</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <RouteGroupSheet
        open={openRuleId !== null}
        onOpenChange={(open) => !open && setOpenRuleId(null)}
        ruleId={openRuleId}
        subjectName={String(openRule?.rule.name || "")}
        policy={openPolicy}
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
