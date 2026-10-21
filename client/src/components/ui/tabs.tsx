import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.List>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(({ className, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn("inline-flex h-9 items-center justify-center gap-0.5 rounded-md bg-[var(--fx-l3-control-fill)] p-[3px] text-muted-foreground", className)} {...props} />
))
TabsList.displayName = TabsPrimitive.List.displayName

/*
  选中项和页面上的分类条（workspace.css 的 .workspace-tab）一个样：主色渐变底、主色上的字，跟着「默认配色」换。
  原来是白底加投影，和分类条摆在同一屏里像两套控件（2026-10-21 用户在手机上圈出来）。
*/
const TabsTrigger = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger ref={ref} className={cn("inline-flex h-full items-center justify-center whitespace-nowrap rounded-[6px] px-3 py-1 text-[13px] font-medium transition-all hover:text-foreground focus-visible:outline-none focus-visible:shadow-[var(--fx-focus-ring)] disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-[image:var(--fx-primary-gradient)] data-[state=active]:font-semibold data-[state=active]:text-[var(--fx-primary-text)] data-[state=active]:hover:text-[var(--fx-primary-text)] data-[state=active]:shadow-none", className)} {...props} />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("tab-content-enter mt-2 focus-visible:outline-none", className)} {...props} />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
