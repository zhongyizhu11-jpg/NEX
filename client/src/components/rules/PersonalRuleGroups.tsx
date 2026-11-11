import { useEffect, useState } from "react";
import { Folder, FolderPlus, Loader2, Pencil, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SortableDragHandle, SortableItem, SortableReorderContext, useOptimisticSortableOrder, useSortableReorder } from "@/components/SortableDragHandle";
import {
  MAX_PERSONAL_RULE_GROUPS,
  MAX_PERSONAL_RULE_GROUP_CHANGE,
  PERSONAL_RULE_GROUP_NAME_MAX,
  type PersonalRuleGroup,
} from "@shared/ruleGroups";

/*
  转发规则的「个人分组」（上游 2.3.287 / 2.3.290；接口 rules.personalGroups / savePersonalGroup / …）。

  这里放三样，规则页（pages/Rules.tsx）拼起来用：
    · RulePersonalGroupBadges：卡片、表格里那几枚分组标签（纯展示，组表由页面那一份查询给）；
    · RuleGroupManagerDialog：「管理分组」—— 新增、改名、拖动排序、删除，点进一个组勾选规则；
    · useRefreshPersonalRuleGroups：改完以后要一起刷新的那几条查询。
  批量管理里的「调整分组」直接写在规则页的批量弹窗里：它用的是弹窗里已经加载好的那份全量规则。

  组只属于当前登录的人：管理员看「所有用户」时看到、能改的仍然只是自己的组（服务端从会话里取主人）。
*/

/** 「谁的规则」那一档，和规则页的用户筛选同一个意思；只影响数哪些规则、列出哪些规则，不影响是谁的组。 */
export type PersonalRuleGroupScope = { userId?: number; scope?: "self" | "all" } | undefined;

const EMPTY_GROUPS: PersonalRuleGroup[] = [];

/** 改完分组以后要刷新的：组表本身，以及带着 personalGroupIds 的几条规则列表。 */
export function useRefreshPersonalRuleGroups() {
  const utils = trpc.useUtils();
  return async () => {
    await Promise.all([
      utils.rules.personalGroups.invalidate(),
      utils.rules.list.invalidate(),
      utils.rules.listPage.invalidate(),
      utils.rules.mapItems.invalidate(),
      utils.rules.listSummary.invalidate(),
    ]);
  };
}

/**
 * 一条规则的分组标签。只画，不查：页面上一份组表给所有卡片共用（每张卡各查一次就是几十个请求）。
 * 一个组都不在就什么都不画（表格里传 emptyPlaceholder 画一个「—」占住格子）。
 * 名字太多时只画前 maxVisible 个，后面写「+N」，悬停看全部。
 */
export function RulePersonalGroupBadges({ groupIds, groups, maxVisible = 2, emptyPlaceholder = false, className }: {
  groupIds?: readonly number[] | null;
  groups: readonly { id: number; name: string }[];
  maxVisible?: number;
  emptyPlaceholder?: boolean;
  className?: string;
}) {
  const ids = new Set((groupIds || []).map(Number));
  const assigned = groups.filter((group) => ids.has(Number(group.id)));
  if (assigned.length === 0) return emptyPlaceholder ? <span className="text-xs text-muted-foreground">—</span> : null;
  const names = assigned.map((group) => group.name).join("、");
  return (
    <span data-rule-personal-groups="" className={cn("inline-flex min-w-0 max-w-full shrink-0 items-center gap-1 align-middle", className)} title={`所属分组：${names}`}>
      {assigned.slice(0, maxVisible).map((group) => (
        <Badge key={group.id} variant="outline" className="h-5 min-w-0 max-w-[7rem] gap-1 px-1.5 text-[11px] font-normal text-muted-foreground">
          <Folder className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{group.name}</span>
        </Badge>
      ))}
      {assigned.length > maxVisible ? (
        <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[11px] font-normal">+{assigned.length - maxVisible}</Badge>
      ) : null}
    </span>
  );
}

/**
 * 新增 / 编辑一个组：名字，加上「这个组里有哪些规则」的勾选列表（搜索、分页）。
 *
 * 只记这次动过的规则（changes），保存时作为 addRuleIds / removeRuleIds 一起交上去：列表是分页加载的，
 * 拿「当前这一页勾着的」去覆盖整组会把别的页上的成员冲掉。翻页、搜索都不丢已经改过的勾。
 */
function RuleGroupEditorDialog({ group, ruleScope, onClose }: {
  group: PersonalRuleGroup | null;
  ruleScope: PersonalRuleGroupScope;
  onClose: () => void;
}) {
  const [name, setName] = useState(group?.name || "");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [changes, setChanges] = useState<Record<number, boolean>>({});
  const refresh = useRefreshPersonalRuleGroups();
  const query = trpc.rules.listPage.useQuery(
    { ...(ruleScope || {}), page, pageSize: 20, category: "all", search },
    { staleTime: 10_000, refetchOnWindowFocus: false, placeholderData: (previous) => previous },
  );
  const save = trpc.rules.savePersonalGroup.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success(group ? "分组已更新" : "分组已创建");
      onClose();
    },
    onError: (error) => toast.error(error.message),
  });
  const items = (query.data?.items || []) as Array<{ id: number; name: string; sourcePort?: number; targetIp?: string; targetPort?: number; personalGroupIds?: number[] }>;
  const changeCount = Object.keys(changes).length;
  const totalPages = query.data?.totalPages ?? 1;
  const currentPage = query.data?.page ?? page;
  const submit = () => save.mutate({
    id: group?.id,
    name: name.trim(),
    addRuleIds: Object.entries(changes).filter(([, selected]) => selected).map(([id]) => Number(id)),
    removeRuleIds: Object.entries(changes).filter(([, selected]) => !selected).map(([id]) => Number(id)),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{group ? "编辑分组" : "新增分组"}</DialogTitle>
          <DialogDescription>勾选加入，取消勾选移出；翻页和搜索不会丢掉已改的勾选，点「保存」一起生效。不影响其他分组。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="space-y-2">
            <Label htmlFor="rule-group-editor-name">分组名</Label>
            <Input id="rule-group-editor-name" autoFocus value={name} disabled={save.isPending} maxLength={PERSONAL_RULE_GROUP_NAME_MAX} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="搜索规则" placeholder="搜索规则名称、端口或目标地址" value={search} className="pl-9" disabled={save.isPending}
              onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
          </div>
          <div className="space-y-1 rounded-md border border-border/60 p-2" aria-busy={query.isFetching}>
            {items.map((rule) => {
              const original = group ? !!rule.personalGroupIds?.includes(group.id) : false;
              const selected = changes[rule.id] ?? original;
              return (
                <label key={rule.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/40">
                  <Checkbox
                    checked={selected}
                    // 一次最多改 500 条（服务端同一个上限）：到了上限，已经改过的还能改回去，没改过的先不让勾。
                    disabled={save.isPending || (!(rule.id in changes) && changeCount >= MAX_PERSONAL_RULE_GROUP_CHANGE)}
                    onCheckedChange={(checked) => setChanges((current) => {
                      const next = { ...current };
                      if (checked === original) delete next[rule.id];
                      else next[rule.id] = checked;
                      return next;
                    })}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{rule.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">:{rule.sourcePort} → {rule.targetIp}:{rule.targetPort}</span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">#{rule.id}</span>
                </label>
              );
            })}
            {query.isLoading ? <p className="p-3 text-center text-sm text-muted-foreground">加载中…</p> : null}
            {query.isError ? <Button type="button" variant="ghost" className="w-full" onClick={() => void query.refetch()}>没读到规则，重试</Button> : null}
            {!query.isLoading && !query.isError && items.length === 0 ? <p className="p-3 text-center text-sm text-muted-foreground">没有匹配的规则</p> : null}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="outline" size="sm" disabled={save.isPending || currentPage <= 1 || query.isFetching} onClick={() => setPage(Math.max(1, currentPage - 1))}>上一页</Button>
            <span className="text-xs tabular-nums text-muted-foreground">{currentPage} / {totalPages}{changeCount > 0 ? ` · 已改 ${changeCount} 条` : ""}</span>
            <Button type="button" variant="outline" size="sm" disabled={save.isPending || currentPage >= totalPages || query.isFetching} onClick={() => setPage(currentPage + 1)}>下一页</Button>
          </div>
        </div>
        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>取消</Button>
          <Button type="button" disabled={save.isPending || !name.trim()} onClick={submit}>
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 「管理分组」：组的列表（拖动排序、改名 / 勾规则、删除）和「新增分组」。 */
export function RuleGroupManagerDialog({ open, onOpenChange, ruleScope }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ruleScope: PersonalRuleGroupScope;
}) {
  const query = trpc.rules.personalGroups.useQuery(ruleScope, { enabled: open, staleTime: 5_000 });
  const groups = query.data?.groups || EMPTY_GROUPS;
  const refresh = useRefreshPersonalRuleGroups();
  const confirm = useConfirmDialog();
  // undefined = 没在编辑；null = 新增；一个组 = 编辑它
  const [editing, setEditing] = useState<PersonalRuleGroup | null | undefined>(undefined);
  useEffect(() => { if (!open) setEditing(undefined); }, [open]);
  const remove = trpc.rules.deletePersonalGroup.useMutation({
    onSuccess: async () => { await refresh(); toast.success("分组已删除，规则都还在"); },
    onError: (error) => toast.error(error.message),
  });
  const reorder = trpc.rules.reorderPersonalGroups.useMutation({ onError: (error) => toast.error(error.message) });
  const pending = remove.isPending || reorder.isPending;
  const order = useOptimisticSortableOrder({ items: groups, getId: (group) => Number(group.id) });
  const sortable = useSortableReorder({
    items: order.items,
    getId: (group) => Number(group.id),
    disabled: pending || groups.length < 2,
    onReorder: (next) => {
      const request = order.begin(next);
      reorder.mutate({ ids: next.map((group) => Number(group.id)) }, {
        onError: () => order.release(request),
        onSettled: () => order.resync(request, refresh),
      });
    },
  });
  return (
    <Dialog open={open} onOpenChange={(value) => !pending && editing === undefined && onOpenChange(value)}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>管理分组</DialogTitle>
          <DialogDescription>分组只有你自己看得见，用来整理规则；不影响转发、授权和计费。删除分组不会删除规则。</DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{groups.length} / {MAX_PERSONAL_RULE_GROUPS} 个分组 · 拖动左侧手柄排序</span>
          <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={pending || groups.length >= MAX_PERSONAL_RULE_GROUPS} onClick={() => setEditing(null)}>
            <FolderPlus className="h-4 w-4" />新增分组
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {query.isError ? <Button type="button" variant="outline" className="w-full" onClick={() => void query.refetch()}>没读到分组，重试</Button> : null}
          {query.isLoading ? <p className="py-6 text-center text-sm text-muted-foreground">加载中…</p> : null}
          {!query.isLoading && !query.isError && groups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有分组。点「新增分组」建一个，再勾上要放进去的规则。</p>
          ) : null}
          <SortableReorderContext sortable={sortable} ids={order.items.map((group) => Number(group.id))} strategy="vertical" restrictToList>
            {order.items.map((group) => (
              <SortableItem key={group.id} id={Number(group.id)} disabled={sortable.disabled}>
                {({ itemProps, handleProps, isDragging }) => (
                  <div {...itemProps} className={cn("flex items-center gap-2 rounded-md border border-border/60 bg-background p-2", isDragging && "opacity-60")}>
                    <SortableDragHandle dragHandleProps={handleProps} visible busy={pending} />
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm" title={group.name}>{group.name}</span>
                    <Badge variant="secondary" className="tabular-nums" title="组里的规则数">{group.count}</Badge>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={pending} title="编辑分组（改名、勾选规则）" aria-label={`编辑分组 ${group.name}`} onClick={() => setEditing(group)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={pending} title="删除分组" aria-label={`删除分组 ${group.name}`}
                      onClick={async () => {
                        if (await confirm({
                          title: "删除分组",
                          description: `删除「${group.name}」？只移除这个分组和它的归属关系，组里的规则和规则的其他分组都会保留。`,
                          confirmText: "删除",
                          tone: "destructive",
                        })) remove.mutate({ id: group.id });
                      }}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                )}
              </SortableItem>
            ))}
          </SortableReorderContext>
        </div>
        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
      {editing !== undefined ? (
        <RuleGroupEditorDialog key={editing?.id ?? "new"} group={editing} ruleScope={ruleScope} onClose={() => setEditing(undefined)} />
      ) : null}
    </Dialog>
  );
}
