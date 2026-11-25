import { useRef, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { clipboardNeedsManualCopy } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useCopyWithToast } from "@/components/useCopyWithToast";

/**
 * 只给看一次（或带着凭据）的那段东西：API 令牌、商城对接令牌、Agent 安装命令。
 *
 * 这种弹窗**不能被顺手关掉**。原来 API 令牌和商城令牌的弹窗按 ESC、点一下遮罩就没了，
 * 而令牌库里只存哈希，关掉就真的再也看不到 —— 用户只能吊销重建。所以这里把
 * onInteractOutside / onEscapeKeyDown 都拦下，出去的路只剩明确点一下「我已保存」（或右上角的 ×）。
 *
 * 之前六处各画各的：代码块样式、复制按钮位置、http 下的剪贴板提示、「别外发」那句，没有两处一样。
 * 收成一个组件之后每处只填文案。
 *
 *   - secret 为 undefined 时不画代码块（加载中、拿不到），由 beforeSecret 说明情况；
 *   - 代码块 select-all + break-all：一键复制失败时手指一按就能整段选中；
 *   - onCopy 给了就用它（Agent Token 那边复制前要先确认「会接管在线主机」），否则走共享的复制 + toast。
 */
export function SecretRevealDialog({
  open,
  onOpenChange,
  title,
  description,
  secret,
  secretLabel,
  copyLabel = "复制",
  copiedMessage = "已复制",
  onCopy,
  warning = "这段内容就是凭据本身，谁拿到谁就能用，别转发给别人。",
  acknowledgeLabel = "我已保存",
  onAcknowledge,
  beforeSecret,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** 要展示的密钥 / 命令。undefined 表示还没有（加载中、拿不到），这时不画代码块。 */
  secret?: string;
  /** 代码块上面的小标题，没有就不画。 */
  secretLabel?: ReactNode;
  copyLabel?: string;
  /** 复制成功的 toast 文案。 */
  copiedMessage?: string;
  /** 自己接管复制（比如复制前要先确认）；不给就走共享的复制 + toast。 */
  onCopy?: (secret: string) => void | Promise<void>;
  /** 「别外发」那句。传 null 不显示。 */
  warning?: ReactNode | null;
  acknowledgeLabel?: string;
  /** 点「我已保存」时额外要做的（清状态）；弹窗本身会关。 */
  onAcknowledge?: () => void;
  /** 画在代码块上面（地址选择、告警、加载中的说明）。 */
  beforeSecret?: ReactNode;
  /** 画在代码块下面（其他平台的命令等）。 */
  children?: ReactNode;
  className?: string;
}) {
  const codeRef = useRef<HTMLElement | null>(null);
  const copy = useCopyWithToast();
  const close = () => {
    onAcknowledge?.();
    onOpenChange(false);
  };
  const handleCopy = () => {
    if (!secret) return;
    if (onCopy) return void onCopy(secret);
    void copy(secret, { success: copiedMessage, element: codeRef.current });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn("flex max-h-[92svh] flex-col overflow-hidden sm:max-w-lg", className)}
        /* 只显示一次的东西不许被 ESC / 点遮罩顺手关掉；右上角的 × 和底部按钮是明确动作，照常能关。 */
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {beforeSecret}
          {secret !== undefined ? (
            <div className="space-y-2">
              {secretLabel ? <p className="text-sm font-medium">{secretLabel}</p> : null}
              <code
                ref={codeRef}
                className="block select-all whitespace-pre-wrap break-all rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5"
              >
                {secret}
              </code>
              <Button className="w-full gap-2" disabled={!secret} onClick={handleCopy}>
                <Copy className="h-4 w-4" />
                {copyLabel}
              </Button>
              {secret && clipboardNeedsManualCopy() ? (
                <p className="text-xs text-muted-foreground">
                  当前是 http 访问，没有剪贴板 API，只能走旧办法，有些浏览器（iOS 尤其）会拒绝。
                  一键复制不成时，长按上面这段选中即可。
                </p>
              ) : null}
            </div>
          ) : null}
          {children}
          {warning ? <p className="text-xs text-[var(--fx-warn-text)]">{warning}</p> : null}
        </div>
        <DialogFooter className="shrink-0">
          <Button onClick={close}>{acknowledgeLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
