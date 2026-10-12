import { useMemo, useState } from "react";
import { Activity, Loader2 } from "lucide-react";

import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import EmptyState from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { groupEventsByDay } from "@shared/opsEvents";

import { EventRow, type OpsEventItem } from "./EventRow";
import { useMinuteNow } from "./useNow";

/*
  监控 › 事件：面板里发生过的事，一句一行，按天分组，新的在上。

  筛选只有两样：全部 / 只看警告，和「哪台主机」。点一行里的主机标签等于选中那台。
  主机详情里「最近动态」的「查看全部」带着 ?host=<id> 跳过来，这里读一次当初始筛选。
  一页 50 条，「加载更多」按 id 往下翻；保留 90 天，再早的每天清掉。
*/

type LevelFilter = "all" | "warn";

const LEVEL_OPTIONS: Array<{ value: LevelFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "warn", label: "只看警告" },
];

function initialHostFilter(): string {
  try {
    const value = Number(new URLSearchParams(window.location.search).get("host"));
    return Number.isInteger(value) && value > 0 ? String(value) : "all";
  } catch {
    return "all";
  }
}

export default function EventsTab(_props: Record<string, never>) {
  const [level, setLevel] = useState<LevelFilter>("all");
  const [hostFilter, setHostFilter] = useState<string>(initialHostFilter);
  const now = useMinuteNow();
  const hostsQuery = trpc.hosts.options.useQuery(undefined, { staleTime: 60_000 });
  const hostId = hostFilter === "all" ? null : Number(hostFilter);

  const eventsQuery = trpc.ops.events.list.useInfiniteQuery(
    { minLevel: level, hostId, limit: 50 },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      refetchInterval: pollingInterval("slow"),
      placeholderData: (previous) => previous,
    },
  );

  const items = useMemo<OpsEventItem[]>(
    () => (eventsQuery.data?.pages ?? []).flatMap((page) => page.items as OpsEventItem[]),
    [eventsQuery.data?.pages],
  );
  const groups = useMemo(() => groupEventsByDay(items, now), [items, now]);

  const hostOptions = useMemo(
    () => ((hostsQuery.data ?? []) as any[])
      .map((host) => ({ id: Number(host.id), name: String(host.name || host.ip || `#${host.id}`) }))
      .filter((host) => host.id > 0),
    [hostsQuery.data],
  );
  // 从主机详情跳过来、但那台主机已经删了：下拉里补一项，免得筛选框显示成空白
  const selectedMissing = hostId !== null && !hostOptions.some((host) => host.id === hostId);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className={segmentedControlClassName} role="group" aria-label="级别">
          <div className="grid grid-cols-2 gap-1">
            {LEVEL_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={level === option.value}
                onClick={() => setLevel(option.value)}
                className={segmentedOptionClassName(level === option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <Select value={hostFilter} onValueChange={setHostFilter}>
          <SelectTrigger className="h-9 w-full sm:w-56" aria-label="主机">
            <SelectValue placeholder="全部主机" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部主机</SelectItem>
            {selectedMissing ? <SelectItem value={hostFilter}>主机 #{hostFilter}</SelectItem> : null}
            {hostOptions.map((host) => (
              <SelectItem key={host.id} value={String(host.id)}>{host.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {eventsQuery.isLoading ? (
        <DataSectionLoading label="正在读取事件" />
      ) : eventsQuery.isError && items.length === 0 ? (
        <DataSectionError
          label="事件"
          error={eventsQuery.error}
          onRetry={() => { void eventsQuery.refetch(); }}
          retrying={eventsQuery.isFetching}
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<Activity className="h-5 w-5" />}
          title={level === "warn" ? "没有警告" : "还没有事件"}
          description={
            level === "warn" || hostId !== null
              ? "换个筛选条件看看。"
              : "主机断线和恢复、规则出错、用户流量用完或到期、管理员登录，都会记在这里，保留 90 天。"
          }
          actions={level === "warn" || hostId !== null ? (
            <Button variant="outline" size="sm" onClick={() => { setLevel("all"); setHostFilter("all"); }}>
              看全部事件
            </Button>
          ) : undefined}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-5">
          {groups.map((group) => (
            <section key={group.key} className="flex min-w-0 flex-col">
              <h2 className="fx-list-section-header">{group.label}</h2>
              <div className="fx-grouped-list overflow-hidden rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)]">
                {group.items.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    now={now}
                    showHost={hostId === null}
                    onHostClick={(id) => setHostFilter(String(id))}
                  />
                ))}
              </div>
            </section>
          ))}
          {eventsQuery.hasNextPage ? (
            <Button
              variant="outline"
              className="w-full sm:w-auto sm:self-center"
              disabled={eventsQuery.isFetchingNextPage}
              onClick={() => { void eventsQuery.fetchNextPage(); }}
            >
              {eventsQuery.isFetchingNextPage ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              加载更多
            </Button>
          ) : (
            <div className="text-center text-meta text-muted-foreground">只保留最近 90 天</div>
          )}
        </div>
      )}
    </div>
  );
}
