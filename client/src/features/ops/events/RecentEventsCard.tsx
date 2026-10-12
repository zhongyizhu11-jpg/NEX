import { ChevronRight } from "lucide-react";
import { Link } from "wouter";

import { Button } from "@/components/ui/button";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";

import { EventRow, type OpsEventItem } from "./EventRow";
import { useMinuteNow } from "./useNow";

/*
  首页「最近动态」（管理员，跟在「需要关注」后面）：最新 8 条事件。

  「需要关注」说的是此刻还没好的事；这里说的是刚刚发生过的事 —— 半夜断了二十分钟又自己好了的
  那台机器，早上在「需要关注」里已经看不到，在这里还看得到。

  第一次加载不画骨架：首页上面已经有好几块在加载，这一块晚一点出来不碍事。
*/
export default function RecentEventsCard(_props: Record<string, never>) {
  const now = useMinuteNow();
  const query = trpc.ops.events.recent.useQuery({ limit: 8 }, {
    refetchInterval: pollingInterval("slow"),
    staleTime: 15_000,
  });
  if (query.isLoading) return null;
  const items = (query.data ?? []) as OpsEventItem[];

  return (
    <section className="flex min-w-0 flex-col" aria-labelledby="ops-recent-events-title">
      <div className="flex min-w-0 items-end justify-between gap-3">
        <h2 id="ops-recent-events-title" className="fx-list-section-header">最近动态</h2>
        <Link
          href="/insights?tab=events"
          className="inline-flex items-center gap-0.5 px-1 pb-1.5 text-meta font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          全部
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>
      <div className="fx-grouped-list overflow-hidden rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)]">
        {query.isError ? (
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-secondary-type text-muted-foreground">最近动态没读到</span>
            <Button variant="outline" size="sm" onClick={() => { void query.refetch(); }} disabled={query.isFetching}>重试</Button>
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-3 text-secondary-type text-muted-foreground">
            还没有事件。主机断线、规则出错、用户到期这类事发生后会出现在这里。
          </div>
        ) : (
          items.map((event) => <EventRow key={event.id} event={event} now={now} />)
        )}
      </div>
    </section>
  );
}
