import { useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RouteBoardList } from "@/features/rules/RouteBoardList";
import { formatAgo } from "@shared/dashboardAttention";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/*
  线路工作台（2.3.496）：所有线路一个入口。

  上面是故障看板（照 ZeroForwarder 的「在线节点 / 告警 / 已自动恢复」）：经过线路的机器在线几台、
  近 24 小时线路告警几次、自动恢复几次，下面几条最近的。再下面一条线路一张紧凑卡，点开是线路面板。
  节点池（NodePoolsSection）是同一页的另一个页签：一个池就是线路里的一层候选。
*/

export function LineWorkspace({ searchQuery = "", isAdmin = false }: { searchQuery?: string; isAdmin?: boolean }) {
  const board = trpc.lineDiagnostics.lineWorkspace.useQuery({ hours: 24 }, { refetchInterval: 30_000, staleTime: 10_000 });
  const data = board.data;
  return (
    <div className="flex flex-col gap-3" data-testid="line-workspace">
      <div className="grid grid-cols-3 gap-2 rounded-[var(--fx-radius-card,14px)] bg-[var(--fx-l1-surface)] px-3 py-3 text-center">
        <div>
          <div className="font-mono text-2xl font-bold">{data ? data.hosts.online : "—"}<small className="text-sm font-medium text-muted-foreground">/{data ? data.hosts.total : "—"}</small></div>
          <div className="text-[11.5px] text-muted-foreground">在线节点</div>
        </div>
        <div>
          <div className={cn("font-mono text-2xl font-bold", data && data.alerts > 0 ? "text-[var(--fx-down-text)]" : "")}>{data ? data.alerts : "—"}</div>
          <div className="text-[11.5px] text-muted-foreground">近 24 小时告警</div>
        </div>
        <div>
          <div className="font-mono text-2xl font-bold text-[var(--fx-healthy-text)]">{data ? data.recovered : "—"}</div>
          <div className="text-[11.5px] text-muted-foreground">已自动恢复</div>
        </div>
      </div>
      {data && data.recent.length > 0 ? (
        <div className="divide-y divide-[var(--fx-stroke-weak)] rounded-[var(--fx-radius-card,14px)] bg-[var(--fx-l1-surface)] px-3" data-testid="line-workspace-recent">
          {data.recent.slice(0, 6).map((item, index) => (
            <div key={index} className="flex min-w-0 items-center justify-between gap-3 py-2 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <i className={cn("h-2 w-2 shrink-0 rounded-full", item.tone === "down" ? "bg-[var(--fx-down-text)]" : item.tone === "warn" ? "bg-[var(--fx-warn-text)]" : "bg-[var(--fx-healthy-text)]")} />
                <span className="truncate"><b className="font-medium">{item.ruleName}</b> <span className="text-muted-foreground">{item.text}</span></span>
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{formatAgo(Date.now() - item.at)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {data && data.hosts.maintenance + data.hosts.tripped > 0 ? (
        <p className="px-1 text-meta text-muted-foreground">
          {data.hosts.maintenance > 0 ? `${data.hosts.maintenance} 台维护中` : ""}
          {data.hosts.maintenance > 0 && data.hosts.tripped > 0 ? " · " : ""}
          {data.hosts.tripped > 0 ? `${data.hosts.tripped} 台熔断（几条线路都探不通它），经过它们的线路已避开` : ""}
        </p>
      ) : null}
      <RouteBoardList searchQuery={searchQuery} isAdmin={isAdmin} compact />
    </div>
  );
}

type PoolRole = "relay" | "landing" | "any";
const ROLE_LABEL: Record<PoolRole, string> = { relay: "中转", landing: "落地", any: "通用" };

export function NodePoolsSection({ hosts, groups }: {
  hosts: Array<{ id: number; name: string; isOnline?: boolean | null }>;
  /** 入口组、出口组、转发组：放在同一页看，也能导入成池。 */
  groups: Array<{ id: number; name: string; groupMode: string; members?: Array<{ hostId?: number | null; isEnabled?: unknown }> }>;
}) {
  const utils = trpc.useUtils();
  const pools = trpc.lineDiagnostics.nodePools.useQuery(undefined, { staleTime: 15_000 });
  const save = trpc.lineDiagnostics.nodePoolSave.useMutation({
    onSuccess: (result: any) => {
      void utils.lineDiagnostics.nodePools.invalidate();
      setEditing(null);
      toast.success(result?.reexpanded ? `已保存，${result.reexpanded} 条线路重新展开` : "已保存");
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = trpc.lineDiagnostics.nodePoolDelete.useMutation({ onSuccess: () => void utils.lineDiagnostics.nodePools.invalidate(), onError: (error) => toast.error(error.message) });
  const importGroup = trpc.lineDiagnostics.nodePoolImport.useMutation({
    onSuccess: (result: any) => { void utils.lineDiagnostics.nodePools.invalidate(); toast.success(`导入了 ${result.members} 台机器`); },
    onError: (error) => toast.error(error.message),
  });
  const [editing, setEditing] = useState<{ id?: number; name: string; role: PoolRole; hostIds: number[] } | null>(null);
  const hostName = (id: number) => hosts.find((host) => host.id === id)?.name || `主机 ${id}`;
  const groupModeLabel = (mode: string) => (mode === "entry" ? "入口组" : mode === "exit" ? "出口组" : mode === "chain" ? "转发链" : mode === "port" ? "端口转发" : "转发组");
  const hostGroups = useMemo(() => groups.filter((group) => (group.members || []).some((member) => Number(member.hostId || 0) > 0)), [groups]);

  return (
    <div className="flex flex-col gap-3" data-testid="node-pools">
      <p className="px-1 text-meta text-muted-foreground">一个池就是线路里的一层候选：线路编辑里「经过中转」选它，面板按整条链的延迟在池里挑。池里加减机器，用到它的线路自动重新展开。</p>
      {(pools.data || []).map((pool: any) => (
        <div key={pool.id} className="rounded-[var(--fx-radius-card,14px)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] px-3.5 py-3" data-testid="node-pool-card">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <b className="truncate text-sm">{pool.name}</b>
              <span className="shrink-0 rounded-full bg-[var(--fx-accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--fx-accent)]">{ROLE_LABEL[pool.role as PoolRole] || "中转"}</span>
            </div>
            <span className="shrink-0 rounded-full bg-[var(--fx-healthy-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--fx-healthy-text)]">
              {pool.members.filter((member: any) => member.online && !member.maintenance && !member.tripped).length}/{pool.members.length}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {pool.members.map((member: any) => (
              <span key={member.hostId} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--fx-stroke-weak)] px-2.5 py-1 text-xs">
                <i className={cn("h-1.5 w-1.5 rounded-full", member.maintenance ? "bg-[var(--fx-warn-text)]" : !member.online || member.tripped ? "bg-[var(--fx-down-text)]" : "bg-[var(--fx-healthy-text)]")} />
                {member.name}
                {member.maintenance ? <span className="text-[10.5px] text-[var(--fx-warn-text)]">维护</span> : member.tripped ? <span className="text-[10.5px] text-[var(--fx-down-text)]">熔断</span> : !member.online ? <span className="text-[10.5px] text-muted-foreground">离线</span> : null}
              </span>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
            <span>用在 {pool.usedBy} 条线路</span>
            <span className="flex gap-1">
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing({ id: pool.id, name: pool.name, role: pool.role, hostIds: pool.hostIds })}>编辑</Button>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" aria-label={`删掉节点池 ${pool.name}`} onClick={() => remove.mutate({ id: pool.id })}><Trash2 className="h-3.5 w-3.5" /></Button>
            </span>
          </div>
        </div>
      ))}
      {pools.data && pools.data.length === 0 ? <p className="px-1 text-meta text-muted-foreground">还没有节点池。</p> : null}
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1 rounded-full text-xs" onClick={() => setEditing({ name: "", role: "relay", hostIds: [] })} data-testid="node-pool-new"><Plus className="h-3.5 w-3.5" />新建池</Button>
        {hostGroups.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-8 rounded-full text-xs">从入口组 / 出口组导入</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
              {hostGroups.map((group) => (
                <DropdownMenuItem key={group.id} onSelect={() => importGroup.mutate({ groupId: group.id, role: group.groupMode === "exit" ? "landing" : "relay" })}>
                  {group.name} · {groupModeLabel(group.groupMode)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        {editing ? (
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editing.id ? "编辑节点池" : "新建节点池"}</DialogTitle>
              <DialogDescription>线路里一层选这个池，就在这几台里挑。</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <Input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value.slice(0, 60) })} placeholder="例如：香港中转池" aria-label="节点池名字" />
              <Select value={editing.role} onValueChange={(value) => setEditing({ ...editing, role: value as PoolRole })}>
                <SelectTrigger aria-label="节点池用途"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="relay">中转</SelectItem>
                  <SelectItem value="landing">落地</SelectItem>
                  <SelectItem value="any">通用</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex flex-wrap gap-1.5">
                {editing.hostIds.map((hostId) => (
                  <span key={hostId} className="inline-flex items-center gap-1 rounded-full border border-[var(--fx-stroke-weak)] px-2.5 py-1 text-xs">
                    {hostName(hostId)}
                    <button type="button" aria-label={`去掉 ${hostName(hostId)}`} onClick={() => setEditing({ ...editing, hostIds: editing.hostIds.filter((id) => id !== hostId) })}><X className="h-3 w-3" /></button>
                  </span>
                ))}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--fx-stroke-weak)] px-2.5 py-1 text-xs text-muted-foreground"><Plus className="h-3 w-3" />加机器</button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                    {hosts.filter((host) => !editing.hostIds.includes(host.id)).map((host) => (
                      <DropdownMenuItem key={host.id} onSelect={() => setEditing({ ...editing, hostIds: [...editing.hostIds, host.id] })}>{host.name}{host.isOnline === false ? "（离线）" : ""}</DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button>
              <Button type="button" disabled={!editing.name.trim() || editing.hostIds.length === 0 || save.isPending} onClick={() => save.mutate({ id: editing.id, name: editing.name.trim(), role: editing.role, hostIds: editing.hostIds })}>保存</Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
