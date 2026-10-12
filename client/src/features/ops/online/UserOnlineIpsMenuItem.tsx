import { useSyncExternalStore } from "react";
import { Users2 } from "lucide-react";
import { formatAgo } from "@shared/dashboardAttention";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { useOpsFeatures } from "../useOpsFeatures";
import { LiveIpRowItem, OutdatedAgentNotice, limitText, regionText, useOnlineIpsWatch } from "./onlineIpParts";

/*
  用户管理每行 ··· 菜单里的「在线 IP」（#6）。

  菜单项和对话框分开放：菜单关上时 Radix 会把菜单内容整个卸掉，对话框要是长在菜单项里，
  点下去的同一瞬间就跟着没了。所以菜单项只往一个小仓库里写「要看谁」，对话框由
  UserOnlineIpsDialogHost 画 —— 它挂在用户管理页上（菜单外面），一直在。
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

export default function UserOnlineIpsMenuItem({ user }: { user: any }) {
  const id = Number(user?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return (
    <DropdownMenuItem onSelect={() => setTarget({ id, name: String(user?.name || user?.username || `用户 #${id}`) })}>
      <Users2 />
      <span>在线 IP</span>
    </DropdownMenuItem>
  );
}

/** 挂在用户管理页（菜单外面）的对话框。别的主题下什么也不画。 */
export function UserOnlineIpsDialogHost() {
  const enabled = useOpsFeatures();
  const target = useSyncExternalStore(subscribe, () => current, () => null);
  if (!enabled) return null;
  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) setTarget(null); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{target ? `${target.name} 的在线 IP` : "在线 IP"}</DialogTitle>
          <DialogDescription>此刻连着的设备，和最近 24 小时用过的 IP。</DialogDescription>
        </DialogHeader>
        {target ? <UserOnlineIpsBody userId={target.id} onNavigate={() => setTarget(null)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function UserOnlineIpsBody({ userId, onNavigate }: { userId: number; onNavigate: () => void }) {
  useOnlineIpsWatch(true);
  const query = trpc.ops.onlineIps.forUser.useQuery({ userId }, { refetchInterval: pollingInterval("fast") });
  const data = query.data;
  if (query.isLoading) return <DataSectionLoading label="正在读取" minHeight="min-h-[120px]" />;
  if (query.error && !data) return <DataSectionError label="在线 IP" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} minHeight="min-h-[120px]" />;
  if (!data) return null;
  const earlier = data.recent.filter((item) => !item.online);
  return (
    <div className="flex max-h-[65vh] min-w-0 flex-col gap-3 overflow-y-auto">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] font-semibold text-foreground">在线 {limitText(data.onlineCount, data.limit)}</span>
        <span className="text-[12.5px] text-muted-foreground">24 小时内用过 {data.distinct24h} 个 IP</span>
      </div>
      {data.atLimit ? (
        <p className="rounded-[var(--fx-radius-surface)] bg-[var(--fx-down-soft)] px-3 py-2 text-[12.5px] text-[var(--fx-down-text)]">
          已经到了设备上限，再有新设备连进来会被拒绝。
        </p>
      ) : null}
      <OutdatedAgentNotice hosts={data.outdatedHosts} minVersion="2.2.216" />

      <section className="min-w-0">
        <h4 className="text-meta font-medium text-muted-foreground">现在连着</h4>
        {data.rows.length === 0 ? (
          <p className="py-3 text-[13px] text-muted-foreground">现在没有设备在连。</p>
        ) : (
          <ul className="divide-y divide-[var(--fx-stroke-weak)]">
            {data.rows.map((row) => <LiveIpRowItem key={`${row.hostId}-${row.port}-${row.ip}`} row={row} onNavigate={onNavigate} />)}
          </ul>
        )}
      </section>

      {earlier.length > 0 ? (
        <section className="min-w-0">
          <h4 className="text-meta font-medium text-muted-foreground">24 小时内用过</h4>
          <ul className="divide-y divide-[var(--fx-stroke-weak)]">
            {earlier.map((item) => (
              <li key={item.ip} className="flex min-w-0 items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate font-mono text-[13px]">{item.ip}</span>
                <span className="min-w-0 truncate text-right text-[12.5px] text-muted-foreground">
                  {regionText(item.region)} · {formatAgo(Date.now() - item.lastSeenAt * 1000)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
