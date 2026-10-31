import { useMemo } from "react";
import { ArrowLeftRight, Layers, ShieldCheck, type LucideIcon } from "lucide-react";
import { useLocation } from "wouter";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  LINK_OVERVIEW_CATEGORY_LABELS,
  LINK_OVERVIEW_KIND_LABELS,
  type LinkOverviewCategory,
  type LinkOverviewItem,
} from "@shared/linkOverview";
import { LINK_TERM_HINTS } from "@shared/linkTerms";

/*
  链路管理「链路总览」页签的下半部分：组和隧道里几条一起用的地方，按三个词各一栏（shared/linkOverview.ts）。

  只读。每一项的「编辑」跳到它原来那页并直接打开编辑框（/tunnels?tab=…&edit=）。线路组不在这里列：
  上半部分就是线路（LineWorkspace，2.3.499 起「线路」页签并进来了），再列一遍是重复。
*/

const CATEGORIES: Array<{ key: LinkOverviewCategory; icon: LucideIcon; hint: string }> = [
  { key: "failover", icon: ShieldCheck, hint: LINK_TERM_HINTS.failover },
  { key: "loadBalance", icon: ArrowLeftRight, hint: LINK_TERM_HINTS.loadBalance },
  { key: "splitConnection", icon: Layers, hint: LINK_TERM_HINTS.splitConnection },
];

export function LinkOverviewSection({ searchQuery = "" }: { searchQuery?: string }) {
  const [, setLocation] = useLocation();
  const overviewQuery = trpc.tunnels.linkOverview.useQuery(undefined, { staleTime: 15_000 });
  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const data = overviewQuery.data;
    const match = (item: LinkOverviewItem) => item.kind !== "route_group" && (!query
      || [item.name, item.how, LINK_OVERVIEW_KIND_LABELS[item.kind], ...item.members].join(" ").toLowerCase().includes(query));
    return {
      failover: (data?.failover || []).filter(match),
      loadBalance: (data?.loadBalance || []).filter(match),
      splitConnection: (data?.splitConnection || []).filter(match),
    };
  }, [overviewQuery.data, searchQuery]);

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {CATEGORIES.map(({ key, icon: Icon, hint }) => {
        const items = filtered[key];
        return (
          <Card key={key} className="border-border bg-card">
            <CardContent className="flex flex-col gap-2 p-4 sm:pt-4">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  {LINK_OVERVIEW_CATEGORY_LABELS[key]}
                </p>
                <span className="text-xs tabular-nums text-muted-foreground">{overviewQuery.isLoading ? "…" : items.length}</span>
              </div>
              <p className="text-xs text-muted-foreground">{hint}</p>
              {overviewQuery.isLoading ? null : items.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  {searchQuery ? "没有匹配的" : "还没有"}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {items.map((item) => (
                    <li key={item.key} className={cn("flex items-center gap-2 rounded-md border px-2.5 py-1.5", !item.enabled && "opacity-60")}>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-medium" title={item.name}>{item.name}</span>
                          <Badge variant="secondary" className="h-4 shrink-0 rounded px-1 text-[10px] font-normal">{LINK_OVERVIEW_KIND_LABELS[item.kind]}</Badge>
                          {!item.enabled ? <span className="shrink-0 text-[10px] text-muted-foreground">已停用</span> : null}
                        </div>
                        <p className="truncate text-[11px] leading-tight text-muted-foreground" title={[item.how, ...item.members].join(" · ")}>
                          {item.how}{item.members.length > 0 ? ` · ${item.members.join("、")}` : ""}
                        </p>
                        {item.note ? <p className="text-[11px] leading-tight text-[var(--fx-warn-text)]">{item.note}</p> : null}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        data-compact-touch=""
                        className="h-7 shrink-0 px-2 text-xs"
                        onClick={() => setLocation(item.href)}
                      >
                        编辑
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
