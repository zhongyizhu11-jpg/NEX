import { useCallback, useEffect, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * 表单有没有被改过：打开时记一份快照，之后和当前表单比。
 *
 * 快照不在打开那一帧立刻记，而是等一帧（rAF）：openEdit 一般是先 setForm 再 setShow，两者同批提交，
 * 读到的已经是回填好的表单；但有的页面在 effect 里还会再补一刀（按选中的主机改默认端口之类），
 * 不等一帧就会把那一刀算成「用户改过」，关的时候白问一句「放弃修改？」。
 *
 * 比的是序列化后的字符串（默认 JSON.stringify）：表单都是纯数据，深比较够用，也不用给每个页面写 isEqual。
 */
export function useFormDirty<T>(open: boolean, value: T, serialize: (value: T) => string = (v) => JSON.stringify(v)): boolean {
  const [baseline, setBaseline] = useState<string | null>(null);
  const openedAtRef = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;
  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;
  useEffect(() => {
    if (!open) {
      setBaseline(null);
      return;
    }
    openedAtRef.current = Date.now();
    const schedule = typeof requestAnimationFrame === "function"
      ? (fn: () => void) => { const id = requestAnimationFrame(fn); return () => cancelAnimationFrame(id); }
      : (fn: () => void) => { const id = setTimeout(fn, 0); return () => clearTimeout(id); };
    return schedule(() => setBaseline(serializeRef.current(valueRef.current)));
  }, [open]);
  const current = open ? serialize(value) : "";
  // 打开后头一秒多里表单还在被程序回填（查询回来后按资源改默认值、规范化字段）：这段时间里的变化都当作新的基线，
  // 不算用户改过。代价是用户在这一秒内就改了又立刻关，不会被问 —— 比起每次关都白问一句，这个更好。
  useEffect(() => {
    if (!open || baseline === null || current === baseline) return;
    if (Date.now() - openedAtRef.current < FORM_DIRTY_SETTLE_MS) setBaseline(current);
  }, [open, baseline, current]);
  return open && baseline !== null && current !== baseline;
}

const FORM_DIRTY_SETTLE_MS = 1200;

/**
 * 「没保存就关」的那道门：ESC、点遮罩、右上角 ×、底部「取消」都走 requestClose。
 *
 *   - pending 时一律不关：请求在路上，关了用户不知道成没成；
 *   - dirty 时先问「放弃修改？」，点了「放弃修改」才真关；
 *   - 其余直接关。
 *
 * 问的那一下用的是全局那个确认框，它关掉时的「点外面」事件会落到这个弹窗上（ForwardGroups 之前踩过），
 * 所以确认框开着、以及它关掉之后的 300ms 内，这里对 onOpenChange(false) 不响应。
 */
export function useDialogCloseGuard({ open, onOpenChange, dirty = false, pending = false }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dirty?: boolean;
  pending?: boolean;
}) {
  const confirmDialog = useConfirmDialog();
  const askingRef = useRef(false);
  const releaseTimerRef = useRef<number | null>(null);
  const stateRef = useRef({ dirty, pending, onOpenChange });
  stateRef.current = { dirty, pending, onOpenChange };

  useEffect(() => () => {
    if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
  }, []);

  const requestClose = useCallback(() => {
    const { dirty: isDirty, pending: isPending, onOpenChange: setOpen } = stateRef.current;
    if (isPending || askingRef.current) return;
    if (!isDirty) {
      setOpen(false);
      return;
    }
    askingRef.current = true;
    void confirmDialog({
      title: "放弃修改？",
      description: "这里有还没保存的改动，关掉就没了。",
      confirmText: "放弃修改",
      cancelText: "继续编辑",
      tone: "destructive",
    }).then((discard) => {
      if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = window.setTimeout(() => {
        askingRef.current = false;
        releaseTimerRef.current = null;
      }, 300);
      if (discard) stateRef.current.onOpenChange(false);
    });
  }, [confirmDialog]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (next) {
      stateRef.current.onOpenChange(true);
      return;
    }
    requestClose();
  }, [requestClose]);

  // open 变回 false（保存成功直接关）时把门复位，下次打开别带着上一次的「正在问」
  useEffect(() => {
    if (!open) askingRef.current = false;
  }, [open]);

  return { requestClose, handleOpenChange };
}

export type FormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** 弹窗说明。读屏要、Radix 也要（dialogDescriptions.test 守着）；视觉上不想要就传 descriptionProps={{ className: "sr-only" }}。 */
  description: ReactNode;
  descriptionProps?: Omit<ComponentProps<typeof DialogDescription>, "children"> & { [attribute: `data-${string}`]: string | undefined };
  /** 表单主体，放在可滚动的那一块里。 */
  children: ReactNode;
  /** 点提交 / 在输入框里按回车。校验不过自己 toast 或设 blocker，别在这里 throw。 */
  onSubmit: () => void;
  submitText?: string;
  /** pending 时提交按钮上的字；默认「处理中...」。 */
  pendingText?: string;
  cancelText?: string;
  /** 请求在路上：提交按钮禁用并转圈，ESC / 遮罩 / 取消都按不动。 */
  pending?: boolean;
  /** 还缺什么：写在按钮旁边（aria-live），同时禁用提交。和 Rules 的 submitBlocker 一个意思。 */
  blocker?: string | null;
  /** blocker 之外的禁用条件（比如必填项没填却不想说话）。 */
  submitDisabled?: boolean;
  /** 表单改过没有：改过就在关之前问「放弃修改？」。用 useFormDirty 算。 */
  dirty?: boolean;
  /** 提交按钮前面的图标；pending 时换成转圈。 */
  submitIcon?: ReactNode;
  /** 页头下面、滚动区上面钉住的一条（页签之类）。 */
  toolbar?: ReactNode;
  /** 页脚左边的东西（提示、次要按钮）。 */
  footerStart?: ReactNode;
  /** DialogContent 的 className：宽度、高度上限都从这里给。 */
  className?: string;
  bodyClassName?: string;
  /** 不渲染页脚（极少数自己画按钮的）。 */
  hideFooter?: boolean;
};

/**
 * 表单弹窗的壳：页头（标题 + 说明）+ 可滚动的主体 + 钉住的页脚，整个包在一个真 <form> 里。
 *
 * 为什么要壳：全站 70 多个表单弹窗几乎没有一个是 <form>，输入框里按回车没反应；没有一个在关之前问
 * 「没保存的改动怎么办」，点一下遮罩表单就没了；pending 时能不能关各处不一样。壳把这三件事统一了：
 *   - <form onSubmit>：回车提交，提交按钮是 type="submit"，取消是 type="button"；
 *   - useDialogCloseGuard：pending 不关、dirty 先问；
 *   - blocker 一句话写在按钮旁边并禁用提交，不用 toast 打断。
 * 页头页脚 shrink-0、主体 min-h-0 flex-1 overflow-y-auto：矮屏上只有主体滚，按钮永远看得见。
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  descriptionProps,
  children,
  onSubmit,
  submitText = "保存",
  pendingText = "处理中...",
  cancelText = "取消",
  pending = false,
  blocker = null,
  submitDisabled = false,
  dirty = false,
  submitIcon,
  toolbar,
  footerStart,
  className,
  bodyClassName,
  hideFooter = false,
}: FormDialogProps) {
  const { requestClose, handleOpenChange } = useDialogCloseGuard({ open, onOpenChange, dirty, pending });
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || blocker || submitDisabled) return;
    onSubmit();
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={cn("flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0", className)}>
        <form className="flex min-h-0 flex-1 flex-col" noValidate onSubmit={handleSubmit}>
          <DialogHeader className="px-4 pt-4 sm:px-6 sm:pt-6">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription {...descriptionProps}>{description}</DialogDescription>
          </DialogHeader>
          {toolbar ? <div className="shrink-0 px-4 pt-4 sm:px-6">{toolbar}</div> : null}
          <div className={cn("min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6", bodyClassName)}>
            {children}
          </div>
          {hideFooter ? null : (
            <DialogFooter className="px-4 pb-4 sm:items-center sm:px-6 sm:pb-6">
              {/* 按钮点不了就在旁边说一句缺什么；提交中不说，那时按钮自己写着 pendingText */}
              {footerStart}
              <p className="min-h-5 text-xs text-muted-foreground sm:mr-auto" aria-live="polite">
                {!pending && blocker ? blocker : ""}
              </p>
              <Button type="button" variant="outline" onClick={requestClose} disabled={pending}>
                {cancelText}
              </Button>
              <Button type="submit" disabled={pending || !!blocker || submitDisabled} className={submitIcon || pending ? "gap-2" : undefined}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : submitIcon}
                {pending ? pendingText : submitText}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
