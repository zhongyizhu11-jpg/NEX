/**
 * 节点排序：订阅默认按面板里的顺序排，这里上下挪。
 * 没做拖拽：节点通常十来个，上下按钮在手机上比拖拽可靠得多。
 */

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export default function ProxyNodeReorderDialog({
  open,
  onOpenChange,
  nodes,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: Array<{ id: number; name: string; sharedFrom?: boolean }>;
  onSaved?: () => void;
}) {
  const [order, setOrder] = useState<Array<{ id: number; name: string }>>([]);
  useEffect(() => {
    if (open) setOrder(nodes.filter((node) => !node.sharedFrom).map((node) => ({ id: node.id, name: node.name })));
  }, [open, nodes]);
  const reorder = trpc.proxySubscriptions.reorderNodes.useMutation({
    onSuccess: () => {
      toast.success("顺序已保存");
      onOpenChange(false);
      onSaved?.();
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const move = (index: number, delta: number) => {
    setOrder((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>节点顺序</DialogTitle>
          <DialogDescription className="text-xs">订阅默认按这个顺序排（令牌上选了别的排序时不看它）。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {order.map((node, index) => (
            <div key={node.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
              <span className="w-6 text-xs text-muted-foreground">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => move(index, -1)} disabled={index === 0} aria-label="上移"><ArrowUp className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => move(index, 1)} disabled={index === order.length - 1} aria-label="下移"><ArrowDown className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
        </div>
        <DialogFooter className="shrink-0 border-t pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => reorder.mutate({ ids: order.map((node) => node.id) })} disabled={reorder.isPending}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
