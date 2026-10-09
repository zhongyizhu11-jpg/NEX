import { useFormFieldId } from "@/components/ui/form-field";
import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { useOverlayContainer } from "@/components/ui/overlay-root"

const SELECT_OPEN_ATTR = "forwardxSelectOpen"

function markSelectOpen() {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {}
  const count = Number(document.body.dataset[SELECT_OPEN_ATTR] || "0") + 1
  document.body.dataset[SELECT_OPEN_ATTR] = String(count)
  return () => {
    const nextCount = Number(document.body.dataset[SELECT_OPEN_ATTR] || "1") - 1
    if (nextCount > 0) {
      document.body.dataset[SELECT_OPEN_ATTR] = String(nextCount)
    } else {
      delete document.body.dataset[SELECT_OPEN_ATTR]
    }
  }
}

const Select = ({ open, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) => {
  const [internalOpen, setInternalOpen] = React.useState(Boolean(defaultOpen))
  const isOpen = open ?? internalOpen

  React.useEffect(() => {
    if (!isOpen) return
    return markSelectOpen()
  }, [isOpen])

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }, [onOpenChange])

  return <SelectPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={handleOpenChange} {...props} />
}
Select.displayName = SelectPrimitive.Root.displayName
const SelectGroup = SelectPrimitive.Group
const SelectValue = SelectPrimitive.Value

const SelectTrigger = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>>(({ className, children, ...props }, ref) => {
  const fieldId = useFormFieldId();
  return (
  <SelectPrimitive.Trigger data-slot="select-trigger" id={fieldId} ref={ref} className={cn("flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-[14px] placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1", className)} {...props}>
    {children}
    <SelectPrimitive.Icon asChild><ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
  );
})
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const SelectPortal = ({ container, ...props }: React.ComponentProps<typeof SelectPrimitive.Portal>) => {
  const overlayContainer = useOverlayContainer()
  return <SelectPrimitive.Portal container={container ?? overlayContainer} {...props} />
}
SelectPortal.displayName = SelectPrimitive.Portal.displayName

/*
  弹出列表的高度上限交给 Viewport 自己，不再靠 flex 收缩。

  以前是 Content 写 max-h-96 + overflow-hidden、Viewport 写 flex:1 + 高度等于触发器高度，
  指望浏览器把 Viewport 收缩到 Content 的上限里再让它自己滚。Chrome 这么算，iOS 的 WebKit
  不这么算：Viewport 撑成全部选项的高度，被 Content 裁掉一截，Viewport 自己没有可滚的余量，
  Radix 的滚动锁又把触摸滑动拦下了 —— 结果就是 iPhone 上「测试类型」最后一项滑不出来
  （2026-10-09 用户反馈）。现在 Viewport 直接带 max-height（24rem 和屏幕剩余高度取小），
  自己就是滚动容器，哪个引擎都一样。

  手机上底部还有一条悬浮的标签栏，列表往下弹时给它让出 96px，免得最后几项被盖住。
*/
const SELECT_LIST_MAX_H = "min(24rem,var(--radix-select-content-available-height,24rem))"
function defaultCollisionPadding() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return 8
  return window.matchMedia("(max-width: 767px)").matches ? { top: 8, right: 8, bottom: 96, left: 8 } : 8
}

const SelectContent = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Content>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>>(({ className, children, position = "popper", collisionPadding, ...props }, ref) => (
  <SelectPortal>
    <SelectPrimitive.Content ref={ref} collisionPadding={collisionPadding ?? (position === "popper" ? defaultCollisionPadding() : undefined)} className={cn("relative z-[var(--fx-z-in-overlay-base)] min-w-[8rem] overflow-hidden rounded-lg border border-[var(--fx-stroke-weak)] bg-popover text-popover-foreground shadow-[var(--fx-elevation-popover)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2", position === "popper" ? "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1" : "max-h-96", className)} position={position} {...props}>
      <SelectPrimitive.Viewport className={cn("p-1 overscroll-contain [-webkit-overflow-scrolling:touch]", position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)] max-h-[calc(min(24rem,var(--radix-select-content-available-height,24rem))-2px)]")}>{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPortal>
))
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectItem = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Item>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item ref={ref} className={cn("relative flex w-full cursor-default select-none items-center rounded-[6px] py-1.5 pl-8 pr-2 text-[13.5px] outline-none focus:bg-[var(--fx-hover)] focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className)} {...props}>
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center"><SelectPrimitive.ItemIndicator><Check className="h-3.5 w-3.5" strokeWidth={2.5} /></SelectPrimitive.ItemIndicator></span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem, SelectPortal }
