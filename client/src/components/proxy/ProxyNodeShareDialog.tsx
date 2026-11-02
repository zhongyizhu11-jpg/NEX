import { useEffect, useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

/** 要分享的那一份凭据。多用户入站会派生出好几行，各自分给谁是分开的。 */
export type ProxyNodeShareTarget = { id: number; label: string };

/**
 * 从节点这边发起分享：挑人，而不是绕到用户页去一个个挑节点。
 *
 * 只给管理员用 —— 要选人就得先能列用户，而用户清单本来就只有管理员看得到。
 */
export function ProxyNodeShareDialog({
  open,
  onOpenChange,
  targets,
  title = "分享这个节点",
  credentialMode = "shared",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: ProxyNodeShareTarget[];
  title?: string;
  /**
   * 这个节点分享出去的是哪种凭据。两种的后果差得很远，说明必须跟着变：
   * per-recipient 一人一份，取消只断他一个；shared 是同一份抄给大家，收回
   * 的唯一办法是换掉它，届时所有人都要重拉订阅。
   */
  credentialMode?: "per-recipient" | "shared";
}) {
  const utils = trpc.useUtils();
  /**
   * 按 id 的内容而不是数组身份来记忆。
   *
   * 调用方通常是 `shareNode ? [{ ... }] : []` 这样现场构造的，每次渲染都是新数组；
   * 直接拿它当依赖，下面那个「打开时填入现状」的 effect 每帧都会重跑一次 setState，
   * 于是渲染 → setState → 渲染，停不下来。
   */
  const nodeIdsKey = targets.map((target) => Number(target.id)).join(",");
  const nodeIds = useMemo(
    () => (nodeIdsKey ? nodeIdsKey.split(",").map(Number) : []),
    [nodeIdsKey],
  );

  const usersQuery = trpc.users.options.useQuery(undefined, { enabled: open });
  const sharesQuery = trpc.proxySubscriptions.nodeShares.useQuery(
    { nodeIds },
    { enabled: open && nodeIds.length > 0 },
  );
  const setShares = trpc.proxySubscriptions.setNodeShares.useMutation();

  const [selection, setSelection] = useState<Record<number, number[]>>({});
  const [keyword, setKeyword] = useState("");
  const [saving, setSaving] = useState(false);

  // 每次打开都从服务端的现状重来：上次关掉时没保存的勾选不该留到下一次。
  useEffect(() => {
    if (!open) return;
    const next: Record<number, number[]> = {};
    for (const id of nodeIds) next[id] = [];
    for (const row of sharesQuery.data || []) next[Number(row.nodeId)] = row.userIds.map(Number);
    setSelection(next);
    setKeyword("");
  }, [open, sharesQuery.data, nodeIds]);

  const candidates = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    return (usersQuery.data || []).filter((user: any) => {
      if (!text) return true;
      return [user.name, user.username, user.email]
        .some((value: any) => String(value || "").toLowerCase().includes(text));
    });
  }, [usersQuery.data, keyword]);

  const toggle = (nodeId: number, userId: number) => {
    setSelection((prev) => {
      const current = prev[nodeId] || [];
      return {
        ...prev,
        [nodeId]: current.includes(userId)
          ? current.filter((id) => id !== userId)
          : [...current, userId],
      };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      for (const nodeId of nodeIds) {
        await setShares.mutateAsync({ nodeId, userIds: selection[nodeId] || [] });
      }
      await utils.proxySubscriptions.nodeShares.invalidate();
      await utils.proxySubscriptions.listNodes.invalidate();
      await utils.proxyInbounds.list.invalidate();
      toast.success("分享已保存");
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error?.message || "保存分享失败");
    } finally {
      setSaving(false);
    }
  };

  const total = nodeIds.reduce((sum, id) => sum + (selection[id]?.length || 0), 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          {credentialMode === "per-recipient" ? (
            <>
              选中的人，订阅里会直接多出这个节点，<span className="font-medium text-foreground">每人一份独立凭据</span>：
              取消分享时只吊销他那一份，同一个端口上别人照常。节点仍然是你的，他改不了也删不掉；
              流量记在你名下 —— 面板按端口计量，几个人的量混在一起，拆不开。
            </>
          ) : (
            <>
              选中的人，订阅里会直接多出这个节点。<span className="font-medium text-foreground">这个端口只有一份凭据</span>，
              分给几个人就是几个人共用同一份，想收回只能把它换掉，届时所有人都要重拉订阅。
              节点仍然是你的；流量记在你名下，按端口计量，拆不开。
            </>
          )}
        </p>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-8"
            placeholder="搜索用户"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {targets.map((target) => (
            <div key={target.id} className="space-y-1.5">
              {/* 单凭据时不显示小标题：没有第二份可选，标题只是噪音。 */}
              {targets.length > 1 ? (
                <p className="text-[11px] font-medium text-muted-foreground">{target.label}</p>
              ) : null}
              {candidates.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  没有匹配的用户。
                </p>
              ) : (
                candidates.map((user: any) => {
                  const picked = (selection[Number(target.id)] || []).includes(Number(user.id));
                  return (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => toggle(Number(target.id), Number(user.id))}
                      className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                        picked ? "border-primary/60 bg-primary/5" : "hover:bg-muted/50"
                      }`}
                    >
                      <Check className={`h-3.5 w-3.5 shrink-0 ${picked ? "text-primary" : "text-transparent"}`} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm leading-tight">
                          {user.name || user.username}
                          <span className="ml-1.5 text-[11px] text-muted-foreground">{user.username}</span>
                        </p>
                      </div>
                      {/* 没有订阅权限的人，分享给他也拿不到 —— 事先标出来，别让人以为分完就完了。 */}
                      {!user.allowProxySubscription ? (
                        <Badge variant="outline" size="sm" className="shrink-0 font-normal text-[var(--fx-warn-text)]">
                          无订阅权限
                        </Badge>
                      ) : null}
                      {!user.accountEnabled ? (
                        <Badge variant="outline" size="sm" className="shrink-0 font-normal text-muted-foreground">
                          已停用
                        </Badge>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          ))}
        </div>

        <DialogFooter className="shrink-0 items-center border-t pt-3 sm:justify-between">
          <span className="text-xs text-muted-foreground">已选 {total} 人</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
