import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  LineBig,
  LineCard,
  LineChip,
  LineChipButton,
  LineDot,
  LineHint,
  LineKv,
  LineMs,
  LinePath,
  LinePill,
  LineRow,
  LineSec,
  LineTitle,
  type LineTone,
} from "@/features/lines/LineUi";
import { RouteBoardList } from "@/features/rules/RouteBoardList";
import { LINK_SPREAD_LABELS } from "@shared/linkTerms";
import { trpc } from "@/lib/trpc";

/*
  线路工作台（2.3.496，效果图 ④「所有线路一个入口」）：

    三个数   经过线路的机器在线几台、近 24 小时告警几次、自动恢复几次
    告警     此刻还在的问题（维护中、熔断、离线的中转）+ 最近几条：左边出了什么事，右边系统做了什么
    线路     一条线路一张卡（按状态排序）：在走哪条、整条链毫秒、用法标签；点开是线路详情

  节点池（NodePoolsSection，效果图 ⑤）是同一页的另一个页签：节点池、入口组、出口组合成一种卡。
*/

export function LineWorkspace({ searchQuery = "", isAdmin = false }: { searchQuery?: string; isAdmin?: boolean }) {
  const board = trpc.lineDiagnostics.lineWorkspace.useQuery({ hours: 24 }, { refetchInterval: 30_000, staleTime: 10_000 });
  const data = board.data;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="line-workspace">
      <LineTitle
        title="线路"
        sub={data ? `${data.lines} 条线路 · ${data.hosts.total} 台机器 · 近 ${data.hours} 小时` : "在读线路…"}
      />
      <LineCard className="grid grid-cols-3 gap-1.5 text-center" data-testid="line-workspace-stats">
        <div>
          <LineBig tone="text" size={26} value={data ? data.hosts.online : "—"} unit={<span className="text-muted-foreground">/{data ? data.hosts.total : "—"}</span>} />
          <div className="mt-1 text-[11.5px] text-muted-foreground">在线节点</div>
        </div>
        <div>
          <LineBig tone={data && data.alerts > 0 ? "down" : "text"} size={26} value={data ? data.alerts : "—"} />
          <div className="mt-1 text-[11.5px] text-muted-foreground">告警</div>
        </div>
        <div>
          <LineBig tone="ok" size={26} value={data ? data.recovered : "—"} />
          <div className="mt-1 text-[11.5px] text-muted-foreground">已自动恢复</div>
        </div>
      </LineCard>
      {data && data.recent.length > 0 ? (
        <LineCard className="px-3 py-1.5" data-testid="line-workspace-recent">
          {data.recent.map((item, index) => (
            <LineKv
              key={index}
              left={<><LineDot tone={item.tone as LineTone} /> <span className="truncate">{item.text}</span></>}
              right={item.action}
            />
          ))}
        </LineCard>
      ) : null}
      <div>
        <LineSec left="线路" right="按状态排序" />
        <RouteBoardList searchQuery={searchQuery} isAdmin={isAdmin} compact />
      </div>
    </div>
  );
}

type PoolRole = "relay" | "landing" | "any";
const ROLE_LABEL: Record<PoolRole, string> = { relay: "中转", landing: "落地", any: "通用" };

function countTone(usable: number, total: number): LineTone {
  if (total === 0 || usable === 0) return "down";
  return usable === total ? "ok" : "warn";
}

export type PoolGroupMode = "entry" | "exit" | "failover";

export function NodePoolsSection({ hosts, onOpenGroup, onCreateGroup }: {
  hosts: Array<{ id: number; name: string; isOnline?: boolean | null }>;
  /** 点入口组 / 出口组的卡：到它原来那一页打开编辑。 */
  onOpenGroup?: (mode: PoolGroupMode, groupId: number) => void;
  /** 「新建池」里选入口组 / 出口组 / 转发组：到对应那一页新建。 */
  onCreateGroup?: (mode: PoolGroupMode) => void;
}) {
  const utils = trpc.useUtils();
  const board = trpc.lineDiagnostics.poolBoard.useQuery(undefined, { staleTime: 15_000, refetchInterval: 30_000 });
  const refresh = () => {
    void utils.lineDiagnostics.poolBoard.invalidate();
    void utils.lineDiagnostics.nodePools.invalidate();
  };
  const save = trpc.lineDiagnostics.nodePoolSave.useMutation({
    onSuccess: (result: any) => {
      refresh();
      setEditing(null);
      toast.success(result?.reexpanded ? `已保存，${result.reexpanded} 条线路重新展开` : "已保存");
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = trpc.lineDiagnostics.nodePoolDelete.useMutation({
    onSuccess: () => { refresh(); setEditing(null); toast.success("已删掉"); },
    onError: (error) => toast.error(error.message),
  });
  const importGroup = trpc.lineDiagnostics.nodePoolImport.useMutation({
    onSuccess: (result: any) => { refresh(); toast.success(`导入了 ${result.members} 台机器`); },
    onError: (error) => toast.error(error.message),
  });
  const [editing, setEditing] = useState<{ id?: number; name: string; role: PoolRole; hostIds: number[] } | null>(null);
  const hostName = (id: number) => hosts.find((host) => host.id === id)?.name || `主机 ${id}`;
  const data = board.data;
  const entryGroups = data?.entryGroups || [];
  const exitGroups = data?.exitGroups || [];
  const nodePools = data?.nodePools || [];
  const importable = useMemo(() => ({
    entry: entryGroups.filter((group) => group.members.length > 0),
    exit: exitGroups.filter((group) => group.members.length > 0),
  }), [entryGroups, exitGroups]);
  const openPool = (pool: (typeof nodePools)[number]) => setEditing({ id: pool.id, name: pool.name, role: pool.role as PoolRole, hostIds: pool.hostIds });

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="node-pools">
      <LineTitle title="节点池" sub="一个池就是一层候选，线路里直接选池" />
      {board.isLoading ? <p className="px-1 text-[12.5px] text-muted-foreground">在读节点池…</p> : null}

      {nodePools.map((pool) => (
        <LineCard
          key={`p${pool.id}`}
          className="cursor-pointer hover:border-[var(--fx-stroke)]"
          role="button"
          tabIndex={0}
          onClick={() => openPool(pool)}
          onKeyDown={(event) => { if (event.key === "Enter") openPool(pool); }}
          data-testid="node-pool-card"
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <b className="truncate text-[14px]">{pool.name}</b>
              <LinePill tone="acc">{ROLE_LABEL[pool.role as PoolRole] || "中转"}</LinePill>
            </div>
            <LinePill tone={countTone(pool.usable, pool.total)}>{pool.usable}/{pool.total}</LinePill>
          </div>
          <div className="mt-[10px] flex flex-wrap gap-1.5">
            {pool.members.map((member) => (
              <LineChip key={member.hostId}>
                <LineDot tone={member.tone} />
                {member.name}
                {/* 和效果图一样：颜色只放在点上，状态字照常色 */}
                {member.state ? <span>{member.state}</span> : <LineMs value={member.latencyMs ?? undefined} />}
              </LineChip>
            ))}
          </div>
          <LineHint>用在 {pool.lines} 条线路{pool.pick ? ` · 挑法：${pool.pick}` : ""}</LineHint>
        </LineCard>
      ))}

      {entryGroups.map((group) => (
        <LineCard
          key={`e${group.id}`}
          className={onOpenGroup ? "cursor-pointer hover:border-[var(--fx-stroke)]" : undefined}
          onClick={() => onOpenGroup?.(group.mode, group.id)}
          title={group.domain ? `${group.name}（${group.domain}）` : group.name}
          data-testid="entry-pool-card"
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <b className="truncate text-[14px]">{group.domain || group.name}</b>
              <LinePill tone="acc">{group.mode === "failover" ? "入口 · 主备" : group.domain ? "入口 · DNS" : "入口"}</LinePill>
            </div>
            <LinePill tone={countTone(group.usable, group.total)}>{group.usable}/{group.total}</LinePill>
          </div>
          <div className="mt-2 flex flex-col gap-[5px]">
            {group.members.map((member) => {
              const bad = member.tone === "down";
              return (
                <LineRow key={member.memberId} bad={bad} className={bad ? "border-[var(--fx-down-text)] bg-[var(--fx-down-soft)]" : undefined}>
                  <LineDot tone={member.tone as LineTone} />
                  <LinePath bad={bad} className={bad ? "font-mono" : "font-mono text-foreground"} title={member.name}>{member.value}</LinePath>
                  <LinePill tone={bad ? "down" : member.tone === "warn" ? "warn" : "gray"}>{member.state}</LinePill>
                </LineRow>
              );
            })}
          </div>
          <LineHint>
            {group.mode === "failover"
              ? `${group.domain && group.autoDns && group.provider ? `${group.provider} · ` : ""}在用的坏了切到下一台${group.autoFailback ? "，恢复稳定后切回" : ""}`
              : group.autoDns && group.provider
                ? `${group.provider} · 坏了自动摘记录，恢复稳定后加回`
                : group.domain ? "没开自动解析：坏了不会摘记录" : "没有入口域名：成员各自用自己的地址"}
          </LineHint>
        </LineCard>
      ))}

      {exitGroups.map((group) => (
        <LineCard
          key={`x${group.id}`}
          className={onOpenGroup ? "cursor-pointer hover:border-[var(--fx-stroke)]" : undefined}
          onClick={() => onOpenGroup?.("exit", group.id)}
          data-testid="exit-pool-card"
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <b className="truncate text-[14px]">{group.name}</b>
              <LinePill tone="acc">出口</LinePill>
            </div>
            <LinePill tone={countTone(group.usable, group.total)}>{group.usable}/{group.total}</LinePill>
          </div>
          <div className="mt-[10px] flex flex-wrap gap-1.5">
            {group.members.map((member) => (
              <LineChip key={member.hostId} title={member.name}>
                {member.tone !== "ok" ? <LineDot tone={member.tone as LineTone} /> : null}
                {member.label}
                {member.state ? <span>{member.state}</span> : null}
              </LineChip>
            ))}
          </div>
          <LineHint>
            {group.members.some((member) => member.checked)
              ? `流媒体 / AI 按解锁结果自动分流，其余${group.strategy === "fallback" || group.strategy === "none" ? "按顺序走" : LINK_SPREAD_LABELS[group.strategy as keyof typeof LINK_SPREAD_LABELS]?.label || "轮流走"}`
              : "还没做过出口检测：到主机详情「流媒体 / AI 解锁」测一次，订阅里才能按解锁结果分流"}
          </LineHint>
        </LineCard>
      ))}

      {data && nodePools.length + entryGroups.length + exitGroups.length === 0 ? (
        <p className="px-1 text-[12.5px] text-muted-foreground">还没有池。建一个中转池，线路里一层直接选它；入口组、出口组也会在这里一起看。</p>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <LineChipButton variant="add" data-testid="node-pool-new">+ 新建池</LineChipButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="text-[11px]">节点池（线路里一层候选）</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setEditing({ name: "", role: "relay", hostIds: [] })}>中转池</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setEditing({ name: "", role: "landing", hostIds: [] })}>落地池</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setEditing({ name: "", role: "any", hostIds: [] })}>通用池</DropdownMenuItem>
            {onCreateGroup ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onCreateGroup("entry")}>入口组（DNS）</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onCreateGroup("exit")}>出口组</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onCreateGroup("failover")}>转发组（主备入口）</DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <LineChipButton disabled={importable.entry.length === 0} title={importable.entry.length === 0 ? "还没有入口组" : "把入口组的机器建成一个池"}>从入口组导入</LineChipButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {importable.entry.map((group) => (
              <DropdownMenuItem key={group.id} onSelect={() => importGroup.mutate({ groupId: group.id, role: "relay" })}>{group.domain || group.name} · {group.members.length} 台</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <LineChipButton disabled={importable.exit.length === 0} title={importable.exit.length === 0 ? "还没有出口组" : "把出口组的机器建成一个落地池"}>从出口组导入</LineChipButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {importable.exit.map((group) => (
              <DropdownMenuItem key={group.id} onSelect={() => importGroup.mutate({ groupId: group.id, role: "landing" })}>{group.name} · {group.members.length} 台</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        {editing ? (
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editing.id ? "编辑节点池" : "新建节点池"}</DialogTitle>
              <DialogDescription>线路里一层选这个池，就在这几台里按整条链的延迟挑。</DialogDescription>
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
                  <LineChip key={hostId}>
                    {hostName(hostId)}
                    <button type="button" aria-label={`去掉 ${hostName(hostId)}`} onClick={() => setEditing({ ...editing, hostIds: editing.hostIds.filter((id) => id !== hostId) })}><X className="h-3 w-3" /></button>
                  </LineChip>
                ))}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <LineChipButton variant="add"><Plus className="h-3 w-3" />加机器</LineChipButton>
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
              {editing.id ? (
                <Button type="button" variant="ghost" className="mr-auto text-[var(--fx-down-text)]" disabled={remove.isPending} onClick={() => remove.mutate({ id: editing.id! })}>删掉这个池</Button>
              ) : null}
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button>
              <Button type="button" disabled={!editing.name.trim() || editing.hostIds.length === 0 || save.isPending} onClick={() => save.mutate({ id: editing.id, name: editing.name.trim(), role: editing.role, hostIds: editing.hostIds })}>保存</Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
