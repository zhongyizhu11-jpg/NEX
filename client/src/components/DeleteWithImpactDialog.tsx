import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type DeleteImpactRule = {
  id: number | string;
  name: string;
  sourcePort?: number | string | null;
  targetIp?: string | null;
  targetPort?: number | string | null;
};

export type DeleteImpactData = {
  forwardRuleCount?: number | null;
  forwardRules?: DeleteImpactRule[] | null;
} | null | undefined;

/**
 * 「删除之前先看会牵连什么」的确认框：隧道、转发组删掉之后引用它们的规则会被清理 / 解绑，
 * 所以弹窗一开就去查 deleteImpact，列出前几条受影响的规则，查完之前「确认删除」不能点。
 *
 * Tunnels 和 ForwardGroups 原来各有一份几乎逐字相同的实现（加载态、红框列表、「还有 N 条未显示」），
 * 这里合成一个：只有标题、说明和「当前 X 仍关联」里的 X 是参数；转发组多出来的那句
 * 「包含 N 条用户规则和 M 条成员运行规则」走 impactExtra。
 *
 * pending 时 ESC / 点遮罩 / 取消都按不动，成功了由调用方的 onSuccess 关（之前是点下去先关再发请求，
 * 失败了用户什么都没看到）。
 */
export function DeleteWithImpactDialog({
  open,
  onOpenChange,
  title,
  description,
  entityLabel,
  impactQuery,
  impactExtra,
  pending = false,
  onConfirm,
  confirmText = "确认删除",
  pendingText = "删除中...",
  cancelText = "取消",
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** 「当前{entityLabel}仍关联 N 条转发规则」里的那个词：链路 / 端口转发 / 转发链 / 转发组…… */
  entityLabel: string;
  /** deleteImpact 那个查询：只用 isLoading 和 data。 */
  impactQuery: { isLoading: boolean; data?: DeleteImpactData };
  /** 受影响数字下面再补一句（转发组：用户规则 / 成员运行规则各多少）。 */
  impactExtra?: ReactNode;
  pending?: boolean;
  onConfirm: () => void;
  confirmText?: string;
  pendingText?: string;
  cancelText?: string;
  className?: string;
}) {
  const data = impactQuery.data;
  const rules = data?.forwardRules || [];
  const count = Number(data?.forwardRuleCount || 0);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && pending) return; onOpenChange(next); }}>
      <DialogContent className={cn("sm:max-w-lg", className)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {impactQuery.isLoading ? (
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
              正在检查关联转发规则...
            </div>
          ) : count ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
              <p className="font-medium text-destructive">
                当前{entityLabel}仍关联 {count} 条转发规则
              </p>
              {impactExtra}
              <div className="mt-2 max-h-44 space-y-1 overflow-auto text-xs text-muted-foreground">
                {rules.map((rule) => (
                  <div key={rule.id} className="rounded border border-border/40 bg-background/60 px-2 py-1">
                    <span className="font-medium text-foreground">{rule.name}</span>
                    <span className="ml-2">:{rule.sourcePort} -&gt; {rule.targetIp}:{rule.targetPort}</span>
                  </div>
                ))}
                {count > rules.length && (
                  <p>还有 {count - rules.length} 条未显示。</p>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
              未发现关联转发规则。
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>{cancelText}</Button>
          <Button
            variant="destructive"
            disabled={pending || impactQuery.isLoading}
            onClick={onConfirm}
          >
            {pending ? pendingText : confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
