import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { cn } from "@/lib/utils"
import { X } from "lucide-react"
import { useOverlayContainer } from "@/components/ui/overlay-root"

const LOCK_RELEASE_DELAY_MS = 360
const MOTION_LOCK_RELEASE_DELAY_MS = 520

const Dialog = ({ open, defaultOpen, onOpenChange, modal = true, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) => {
  const [internalOpen, setInternalOpen] = React.useState(Boolean(defaultOpen))
  const isOpen = open ?? internalOpen
  const lockActiveRef = React.useRef(false)
  const releaseTimerRef = React.useRef<number | null>(null)
  const motionReleaseTimerRef = React.useRef<number | null>(null)

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }, [onOpenChange])

  const markMotionLocked = React.useCallback(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return
    if (motionReleaseTimerRef.current !== null) {
      window.clearTimeout(motionReleaseTimerRef.current)
      motionReleaseTimerRef.current = null
    }
    document.body.dataset.dialogMotionLock = "true"
    document.body.dataset.dialogMotionLockUntil = String(Date.now() + MOTION_LOCK_RELEASE_DELAY_MS)
  }, [])

  const releaseMotionLock = React.useCallback(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return
    document.body.dataset.dialogMotionLockUntil = String(Date.now() + MOTION_LOCK_RELEASE_DELAY_MS)
    if (motionReleaseTimerRef.current !== null) window.clearTimeout(motionReleaseTimerRef.current)
    motionReleaseTimerRef.current = window.setTimeout(() => {
      motionReleaseTimerRef.current = null
      const lockUntil = Number(document.body.dataset.dialogMotionLockUntil || "0")
      if (Date.now() >= lockUntil && !document.body.dataset.dialogScrollLock) {
        delete document.body.dataset.dialogMotionLock
        delete document.body.dataset.dialogMotionLockUntil
      }
    }, MOTION_LOCK_RELEASE_DELAY_MS)
  }, [])

  const releaseScrollLock = React.useCallback(() => {
    if (!lockActiveRef.current || typeof document === "undefined") return
    const nextCount = Number(document.body.dataset.dialogScrollLock || "1") - 1
    if (nextCount > 0) {
      document.body.dataset.dialogScrollLock = String(nextCount)
    } else {
      delete document.body.dataset.dialogScrollLock
      releaseMotionLock()
    }
    lockActiveRef.current = false
  }, [releaseMotionLock])

  React.useLayoutEffect(() => {
    if (!modal || typeof document === "undefined") return
    if (isOpen) {
      markMotionLocked()
      if (releaseTimerRef.current !== null) {
        window.clearTimeout(releaseTimerRef.current)
        releaseTimerRef.current = null
      }
      if (!lockActiveRef.current) {
        const count = Number(document.body.dataset.dialogScrollLock || "0") + 1
        document.body.dataset.dialogScrollLock = String(count)
        lockActiveRef.current = true
      }
      return
    }
    if (lockActiveRef.current && releaseTimerRef.current === null) {
      releaseTimerRef.current = window.setTimeout(() => {
        releaseTimerRef.current = null
        releaseScrollLock()
      }, LOCK_RELEASE_DELAY_MS)
    }
  }, [isOpen, markMotionLocked, modal, releaseScrollLock])

  React.useLayoutEffect(() => () => {
    if (releaseTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    if (motionReleaseTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(motionReleaseTimerRef.current)
      motionReleaseTimerRef.current = null
    }
    releaseScrollLock()
    releaseMotionLock()
  }, [releaseMotionLock, releaseScrollLock])

  return <DialogPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={handleOpenChange} modal={modal} {...props} />
}
Dialog.displayName = DialogPrimitive.Root.displayName
const DialogPortal = ({ container, ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) => {
  const overlayContainer = useOverlayContainer()
  return <DialogPrimitive.Portal container={container ?? overlayContainer} {...props} />
}
DialogPortal.displayName = DialogPrimitive.Portal.displayName

const DialogOverlay = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Overlay>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay ref={ref} className={cn("dialog-overlay fixed inset-0 z-[var(--fx-z-in-overlay-base)] overflow-hidden", className)} {...props} />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <div className="dialog-positioner fixed inset-0 z-[var(--fx-z-in-overlay-base)] grid place-items-center p-3 pointer-events-none sm:p-6">
      {/*
        默认可滚，不是默认裁掉。

        原来这里是 `max-h-[92svh] overflow-hidden`：内容一超过屏高就直接切掉，而且
        **没有任何办法滑到下面**。真机上「添加用户」那个弹窗最后一个「取消」按钮就
        卡在屏幕边缘外，手指怎么划都不动 —— 表单填完了提交不了。全站 94 个弹窗里
        只有 1 个自己加了滚动容器，剩下的在矮屏幕上都是这个下场。

        改成 overflow-y-auto 之后，自己已经管好滚动的那 25 个弹窗不受影响：它们在
        className 里显式传了 overflow-hidden，tailwind-merge 会让后传的那个赢。
        这里只是把「没人管」时的默认从裁切改成可滚。
      */}
      <DialogPrimitive.Content ref={ref} data-forwardx-dialog-content="" className={cn("dialog-panel pointer-events-auto grid max-h-[92svh] w-[calc(100vw-1.5rem)] max-w-lg gap-5 overflow-y-auto overflow-x-hidden overscroll-contain rounded-[var(--fx-radius-modal)] p-4 sm:w-full sm:p-6", className)} {...props}>
        {children}
        {/*
          关闭按钮跟着内容滚，没有钉住。

          试过在网格第一行塞一个 0 高的 sticky 壳子把它钉在滚动区顶上，量下来
          代价是全部 94 个弹窗的标题上方多出 17px 的缝，而且「×」会浮到标题上面
          去 —— 那一行 gap 吃不掉：负 margin 只能压扁行高，压不掉行与行之间的
          gap。为钉一个按钮把所有弹窗的间距改一遍不划算。
          滚上去之后还有 ESC、点遮罩、底部的取消三条路可以关。
        */}
        <DialogPrimitive.Close data-fx-dialog-close="" className="absolute right-3.5 top-3.5 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--fx-hover)] hover:text-foreground focus:outline-none focus-visible:shadow-[var(--fx-focus-ring)] disabled:pointer-events-none">
          <X className="h-4 w-4" />
          <span className="sr-only">关闭</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </div>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

// shrink-0：DialogContent 是 flex 列，内容一超高，浏览器会连页头页脚一起压扁 ——
// 压到比自身内容还矮时，里面的东西就溢出自己的盒子、画到相邻内容上。表现是
// 标签行盖住说明文字、保存按钮压在正文上。页头页脚本来就不该被压。
const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div data-slot="dialog-header" className={cn("flex shrink-0 flex-col space-y-2 pr-8 text-left", className)} {...props} />
)
DialogHeader.displayName = "DialogHeader"

// gap-2 而不是 sm:space-x-2：原来的写法只在桌面端给间距，手机上按钮竖排时
// 两个按钮之间一点缝都没有，糊成一整块。gap 横竖都管。
const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  /*
    手机上原来是 flex-col-reverse —— 两个整宽按钮竖着排，实测这一块 137px，
    而 393×760 的屏幕上整个对话框才 730px。按钮并排之后是 56px，省下的 80px
    直接还给表单字段（原来「协议」那一栏是被这块footer压出屏幕外的）。

    竖排本来是为了窄屏放得下长按钮文案，但这里的文案是「创建」「取消」两个字，
    并排绰绰有余；真放不下时 flex-wrap 会自己折回去。
  */
  <div data-slot="dialog-footer" className={cn("flex shrink-0 flex-row flex-wrap items-center justify-end gap-2 border-t border-[var(--fx-stroke-weak)] pt-4", className)} {...props} />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title data-slot="dialog-title" ref={ref} className={cn("text-[17px] font-semibold leading-snug tracking-tight", className)} {...props} />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description data-slot="dialog-description" ref={ref} className={cn("text-[13px] leading-relaxed text-muted-foreground", className)} {...props} />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export { Dialog, DialogPortal, DialogOverlay,   DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription }
