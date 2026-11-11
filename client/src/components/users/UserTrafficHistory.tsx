import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { BarChart3 } from "lucide-react";

import { formatBytes } from "@shared/formatBytes";
import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const UserTrafficHistoryChart = lazy(() => import("./UserTrafficHistoryChart"));

/*
  用户管理每行 ··· 菜单里的「流量历史」（只给管理员，用户管理页本身就只有管理员进得来）：
  这个用户最近 30 / 90 天每天的上传 / 下载、合计，和这段时间用量最多的 10 条规则。

  读的是 server/userTrafficHistory.ts 从已有流量桶汇总出来的日表，不新增采集；功能上线之前的日子没有数据。
  菜单项和对话框分开放（和「在线 IP」同一个做法）：菜单关上时 Radix 会卸掉菜单内容，对话框得挂在菜单外面。
*/

type Target = { id: number; name: string } | null;
let current: Target = null;
const listeners = new Set<() => void>();

function setTarget(next: Target) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function UserTrafficHistoryMenuItem({ user }: { user: any }) {
  const id = Number(user?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return (
    <DropdownMenuItem onSelect={() => setTarget({ id, name: String(user?.name || user?.username || `用户 #${id}`) })}>
      <BarChart3 />
      <span>流量历史</span>
    </DropdownMenuItem>
  );
}

function Body({ userId }: { userId: number }) {
  const [days, setDays] = useState<30 | 90>(30);
  const query = trpc.userTrafficHistory.daily.useQuery({ userId, days }, { staleTime: 60_000, refetchOnWindowFocus: false, placeholderData: (previous) => previous });
  const data = query.data;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="时间范围">
          {([30, 90] as const).map((value) => (
            <button key={value} type="button" aria-pressed={days === value} className={cn("fx-chip", days === value && "fx-chip-on")} onClick={() => setDays(value)}>
              最近 {value} 天
            </button>
          ))}
        </div>
        {data ? (
          <span className="text-meta text-muted-foreground tabular-nums">
            上传 {formatBytes(data.totals.bytesIn)} · 下载 {formatBytes(data.totals.bytesOut)} · 合计 {formatBytes(data.totals.bytesIn + data.totals.bytesOut)}
          </span>
        ) : null}
      </div>
      {query.isLoading ? <DataSectionLoading label="正在读取流量历史" /> : null}
      {query.isError && !data ? <DataSectionError label="流量历史" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} /> : null}
      {data ? (
        <>
          <Suspense fallback={<Skeleton className="h-[220px] w-full" />}>
            <UserTrafficHistoryChart days={data.days} />
          </Suspense>
          <div className="space-y-1">
            <p className="text-meta font-medium text-foreground">用量最多的规则</p>
            {data.topRules.length === 0 ? (
              <p className="text-meta text-muted-foreground">这段时间没有流量。</p>
            ) : (
              <ol className="flex flex-col divide-y divide-[var(--fx-stroke-weak)]" data-testid="user-traffic-top-rules">
                {data.topRules.map((rule, index) => (
                  <li key={rule.ruleId} className="flex min-w-0 items-center gap-2 py-1.5 text-sm">
                    <span className="w-5 shrink-0 text-right text-meta text-muted-foreground tabular-nums">{index + 1}</span>
                    <span className={cn("min-w-0 flex-1 truncate", rule.deleted && "text-muted-foreground")}>{rule.name}</span>
                    <span className="shrink-0 text-meta tabular-nums text-muted-foreground">↑ {formatBytes(rule.bytesIn)} · ↓ {formatBytes(rule.bytesOut)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            按面板计费时区按天汇总，今天的数字最多晚几分钟。上传 = 入站（客户端发出），下载 = 出站（回给客户端），不含倍率。
            {data.recordedSince ? ` 日记录从 ${data.recordedSince} 开始，之前的日子没有数据。` : " 还没有日记录：流量桶每 10 分钟汇总一次。"}
          </p>
        </>
      ) : null}
    </div>
  );
}

/** 挂在用户管理页（菜单外面）的对话框。 */
export function UserTrafficHistoryDialogHost() {
  const target = useSyncExternalStore(subscribe, () => current, () => null);
  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) setTarget(null); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{target ? `${target.name} 的流量历史` : "流量历史"}</DialogTitle>
          <DialogDescription>每天的上传 / 下载，以及这段时间用量最多的规则。</DialogDescription>
        </DialogHeader>
        {target ? <Body userId={target.id} /> : null}
      </DialogContent>
    </Dialog>
  );
}
