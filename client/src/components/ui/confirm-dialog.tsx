import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/useMobile";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ConfirmTone = "default" | "destructive";

export type ConfirmOptions = {
  title?: string;
  description: ReactNode;
  /**
   * 说明和按钮之间的那块：键值表（主机 / Agent 版本 / 目标版本）、要删的那串 Token、
   * 「只清展示数据不动套餐」那种黄底提示。原来有 7 处确认弹窗就为了放这么一块表而手写整个 Dialog。
   */
  details?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** onConfirm 跑着的时候确认按钮上写的字；不给就是「处理中…」。 */
  confirmPendingText?: string;
  /**
   * 不给时按 confirmText 猜：含「删除 / 移除 / 清空 / 重置」就按破坏性画（红按钮、手机操作表红字）。
   * 明确传了就听传的。
   */
  tone?: ConfirmTone;
  /**
   * 点「确认」之后要做的事。返回 Promise 时弹窗**保持打开**、确认按钮换成 pending 文案并禁用、
   * ESC / 点遮罩 / 取消都按不动；成功了才关（resolve true），失败了留在原地把错误写在按钮上方，
   * 用户能重试或取消。不给的话点确认就关，和以前一样（resolve true 由调用方自己去发请求）。
   */
  onConfirm?: () => void | Promise<unknown>;
};

type PendingConfirm = Required<Pick<ConfirmOptions, "title" | "confirmText" | "cancelText" | "confirmPendingText" | "tone">> & {
  description: ReactNode;
  details?: ReactNode;
  onConfirm?: () => void | Promise<unknown>;
  resolve: (confirmed: boolean) => void;
};

const ConfirmDialogContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

const DEFAULT_CONFIRM_TITLE = "确认操作";
const DEFAULT_PENDING_TEXT = "处理中…";

/** 删除、移除、清空、重置都回不了头：没明说语气的，按确认按钮上的字猜。 @public */
export function inferConfirmTone(confirmText: string, explicit?: ConfirmTone): ConfirmTone {
  if (explicit) return explicit;
  return /删除|移除|清空|重置/.test(confirmText) ? "destructive" : "default";
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String((error as { message?: unknown } | null)?.message || "");
  const text = raw.replace(/\s+/g, " ").trim();
  return text || "操作失败，请重试";
}

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  // onConfirm 正在跑 / 上一次跑失败的原因。两者都只属于当前这一次确认，换一次确认就清掉。
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const close = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    setBusy(false);
    setFailure(null);
    current?.resolve(confirmed);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    pendingRef.current?.resolve(false);
    return new Promise<boolean>((resolve) => {
      const confirmText = options.confirmText || "确认";
      const next: PendingConfirm = {
        title: options.title || DEFAULT_CONFIRM_TITLE,
        description: options.description,
        details: options.details,
        confirmText,
        cancelText: options.cancelText || "取消",
        confirmPendingText: options.confirmPendingText || DEFAULT_PENDING_TEXT,
        tone: inferConfirmTone(confirmText, options.tone),
        onConfirm: options.onConfirm,
        resolve,
      };
      pendingRef.current = next;
      setPending(next);
      setBusy(false);
      setFailure(null);
    });
  }, []);

  /*
    点「确认」：没有 onConfirm 就直接关（老行为）；有的话等它跑完再关。
    等待期间如果 confirm() 又被叫了一次（pendingRef 换人了），这次的结果就不再碰弹窗 ——
    否则会把别人新开的确认框关掉。
  */
  const runConfirm = useCallback(() => {
    const current = pendingRef.current;
    if (!current) return;
    if (!current.onConfirm) {
      close(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    let result: void | Promise<unknown>;
    try {
      result = current.onConfirm();
    } catch (error) {
      setBusy(false);
      setFailure(errorText(error));
      return;
    }
    Promise.resolve(result).then(
      () => { if (pendingRef.current === current) close(true); },
      (error: unknown) => {
        if (pendingRef.current !== current) return;
        setBusy(false);
        setFailure(errorText(error));
      },
    );
  }, [close]);

  const contextValue = useMemo(() => confirm, [confirm]);
  const isMobile = useIsMobile();
  const confirmLabel = busy ? pending?.confirmPendingText || DEFAULT_PENDING_TEXT : pending?.confirmText || "确认";
  const failureNode = failure ? (
    <p role="alert" className="text-xs leading-5 text-destructive">{failure}</p>
  ) : null;

  return (
    <ConfirmDialogContext.Provider value={contextValue}>
      {children}
      {/* 请求在路上时 ESC / 点遮罩 / 右上角 × 都不关：关了用户就不知道那一下到底成没成 */}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open && !busy) close(false); }}>
        {isMobile ? (
          /*
            手机上是 iOS 的 Action Sheet，不是缩小版的对话框。

            差别不只是长相。确认框的全部内容就是一个问题和两个答案，而桌面版为此
            摆了一个图标方块、一个左对齐标题、一段说明和两个右下角的小按钮 ——
            在 5 英寸的屏幕上，那两个小按钮正好落在拇指够不到的地方，而「删除」
            和「取消」挨着，误触的代价不对称。

            iOS 的答案：说明居中、小字；两个答案是两条撑满宽度的大行，破坏性的
            那条用红字；「取消」单独一块，和上面隔开一道缝 —— 那道缝就是防误触。
          */
          <DialogContent
            className="fx-action-sheet gap-0 border-0 bg-transparent p-0 shadow-none"
            /*
              不要把焦点自动放到第一个按钮上 —— 而第一个按钮正好是那个红色的
              「删除」。Radix 默认这么做，结果是弹出来之后随手一个回车/空格就
              执行了破坏性操作，而且屏幕上还套着一圈焦点框，看着像已经选中了。

              iOS 的操作表也不预选任何一项：两个答案都要手动点。
            */
            onOpenAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => { if (busy) event.preventDefault(); }}
            onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
          >
            <div className="rounded-[var(--fx-radius-modal)] bg-[var(--fx-l1-surface)] text-center">
              <div className="flex flex-col gap-1 px-6 py-4">
                <DialogTitle className="text-secondary-type font-semibold text-foreground">
                  {pending?.title || DEFAULT_CONFIRM_TITLE}
                </DialogTitle>
                <DialogDescription asChild>
                  <div className="text-meta leading-relaxed text-muted-foreground">{pending?.description}</div>
                </DialogDescription>
                {pending?.details ? <div className="pt-2 text-left text-sm">{pending.details}</div> : null}
                {failureNode}
              </div>
              <button
                type="button"
                onClick={runConfirm}
                disabled={busy}
                aria-busy={busy || undefined}
                className="w-full border-t border-[var(--fx-stroke-weak)] px-6 py-3.5 text-primary-type font-semibold outline-none focus-visible:bg-[var(--fx-hover)] disabled:opacity-60"
                style={pending?.tone === "destructive" ? { color: "var(--fx-down)" } : undefined}
              >
                {confirmLabel}
              </button>
            </div>
            {/* 隔开的这道缝就是防误触：「取消」不该紧挨着「删除」 */}
            <button
              type="button"
              onClick={() => close(false)}
              disabled={busy}
              className="mt-2 w-full rounded-[var(--fx-radius-modal)] bg-[var(--fx-l1-surface)] px-6 py-3.5 text-primary-type font-semibold text-foreground outline-none focus-visible:bg-[var(--fx-hover)] disabled:opacity-60"
            >
              {pending?.cancelText || "取消"}
            </button>
          </DialogContent>
        ) : (
        <DialogContent
          className="max-w-md"
          onInteractOutside={(event) => { if (busy) event.preventDefault(); }}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        >
          <DialogHeader className="gap-3 pr-8">
            <div className={`flex h-10 w-10 items-center justify-center rounded-md ${
              pending?.tone === "destructive"
                ? "bg-destructive/10 text-destructive"
                : "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]"
            }`}>
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="space-y-1.5 text-left">
              <DialogTitle>{pending?.title || DEFAULT_CONFIRM_TITLE}</DialogTitle>
              <DialogDescription asChild>
                <div className="text-sm leading-6 text-muted-foreground">{pending?.description}</div>
              </DialogDescription>
            </div>
          </DialogHeader>
          {pending?.details ? <div className="text-sm">{pending.details}</div> : null}
          {failureNode}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => close(false)} disabled={busy}>{pending?.cancelText || "取消"}</Button>
            <Button
              variant={pending?.tone === "destructive" ? "destructive" : "default"}
              onClick={runConfirm}
              disabled={busy}
              aria-busy={busy || undefined}
              className="gap-2"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
        )}
      </Dialog>
    </ConfirmDialogContext.Provider>
  );
}

/**
 * 「键 → 值」的事实表，放进 confirm 的 details 槽：主机 / Agent / 目标版本那种一行一对。
 * 原来 Hosts、AgentTokenManager、Telegram、DeepSeek 各画各的，这里统一成一个灰底卡。
 */
export function ConfirmFacts({ rows, className }: {
  rows: readonly { label: ReactNode; value: ReactNode; mono?: boolean }[];
  className?: string;
}) {
  return (
    <div className={`space-y-3 rounded-lg border border-border/40 bg-muted/20 p-3 text-sm ${className || ""}`}>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center justify-between gap-3">
          <span className="shrink-0 text-muted-foreground">{row.label}</span>
          <span className={`min-w-0 truncate ${row.mono ? "font-mono" : "font-medium"}`}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export function useConfirmDialog() {
  const confirm = useContext(ConfirmDialogContext);
  if (!confirm) {
    throw new Error("useConfirmDialog must be used within ConfirmDialogProvider");
  }
  return confirm;
}
