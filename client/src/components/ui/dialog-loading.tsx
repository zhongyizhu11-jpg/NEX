import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

/*
  懒加载弹窗第一次打开、JS 还在路上时的占位。

  以前这些 Suspense 的 fallback 是 null：点一下什么都不出现，网络慢时像点了没反应，用户会再点一次。
  现在一帧之内先弹出一个带转圈的空弹窗，JS 到了换成真的（lib/lazyWarm.ts 还会在页面闲时把 JS 先拉回来，
  多数时候根本走不到这里）。标题 / 说明按全站规矩都有，只是读屏才念得到。
*/
export function DialogLoadingFallback({ open = true }: { open?: boolean }) {
  return (
    <Dialog open={open}>
      <DialogContent className="flex min-h-[12rem] items-center justify-center sm:max-w-md" aria-busy="true">
        <DialogTitle className="sr-only">加载中</DialogTitle>
        <DialogDescription className="sr-only">正在加载这个弹窗，请稍候。</DialogDescription>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          加载中…
        </div>
      </DialogContent>
    </Dialog>
  );
}
