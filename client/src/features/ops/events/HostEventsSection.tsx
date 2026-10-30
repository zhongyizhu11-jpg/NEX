import { Link } from "wouter";

import { Section } from "@/components/hosts/HostDetailDialog";
import { trpc } from "@/lib/trpc";

import { EventRow, type OpsEventItem } from "./EventRow";
import { useMinuteNow } from "./useNow";

/*
  主机详情里的「最近动态」：这台机器最近 3 条事件（断线 / 恢复、重启、上面规则出错……）。
  行里不再画主机标签 —— 整节都是这台机器的。「查看全部」带着 ?host= 去监控 › 事件。
*/
export default function HostEventsSection({ host }: { host: any }) {
  const hostId = Number(host?.id || 0);
  const now = useMinuteNow();
  const query = trpc.ops.events.recent.useQuery({ limit: 3, hostId }, {
    enabled: hostId > 0,
    staleTime: 15_000,
  });
  if (hostId <= 0) return null;
  const items = (query.data ?? []) as OpsEventItem[];

  return (
    <Section
      title="最近动态"
      action={items.length > 0 ? (
        <Link href={`/insights?tab=events&host=${hostId}`} className="text-meta font-medium text-primary underline-offset-2 hover:underline">查看全部</Link>
      ) : null}
    >
      {query.isLoading ? (
        <div className="text-meta text-muted-foreground">正在读取…</div>
      ) : query.isError ? (
        <div className="text-meta text-muted-foreground">
          没读到这台主机的动态。
          <button type="button" className="ml-1 underline underline-offset-2 hover:text-foreground" onClick={() => { void query.refetch(); }}>重试</button>
        </div>
      ) : items.length === 0 ? (
        <div className="text-meta text-muted-foreground">这台主机还没有记录到事件。</div>
      ) : (
        /* 详情弹窗里本来就是一块面，这里不再套圆角框，行也不留左右内边距，和上面几节的键值行对齐 */
        <div className="flex min-w-0 flex-col divide-y divide-[var(--fx-stroke-weak)]">
          {items.map((event) => <EventRow key={event.id} event={event} now={now} showHost={false} className="px-0 py-1.5" />)}
        </div>
      )}
    </Section>
  );
}
