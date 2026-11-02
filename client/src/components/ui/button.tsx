import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/*
  四种按钮只有一种「重」：主按钮反黑。描边和幽灵按钮是白底 / 无底，悬停一层浅灰。
  焦点环、按下态、投影由 workspace.css 按 data-slot / data-variant 统一给，
  这里只定形状、颜色和尺寸。
*/
const buttonVariants = cva("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-[13.5px] font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50", {
  variants: {
    variant: {
      /*
        禁用态不再是「渐变兑一半」—— 半透明的天蓝渐变上一行白字谁也读不清。
        禁用就退成一块平的浅灰、灰字，和其它禁用控件一个样。
      */
      default: "border border-[var(--fx-primary-stroke)] bg-[var(--fx-primary-fill)] bg-[image:var(--fx-primary-gradient)] font-semibold text-[var(--fx-primary-text)] hover:bg-[image:var(--fx-primary-gradient-hover)] disabled:border-[var(--fx-stroke-weak)] disabled:bg-[var(--fx-l3-control-fill)] disabled:bg-[image:none] disabled:text-muted-foreground disabled:opacity-100",
      destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      outline: "border border-[var(--fx-stroke-base)] bg-[var(--fx-l1-surface)] text-foreground hover:bg-[var(--fx-hover)]",
      secondary: "bg-[var(--fx-l3-control-fill)] text-foreground hover:bg-[var(--fx-hover)]",
      ghost: "hover:bg-[var(--fx-hover)] hover:text-foreground",
      link: "text-primary underline-offset-4 hover:underline",
    },
    size: {
      default: "h-9 px-3.5 py-2",
      /* xs：卡片角上、行尾那种小按钮（28px 高），不再各处手写 h-7 px-2 text-xs */
      xs: "h-7 gap-1.5 rounded-md px-2.5 text-[12px]",
      sm: "h-8 rounded-md px-3 text-[13px]",
      lg: "h-10 rounded-md px-5 text-[14px]",
      icon: "h-9 w-9",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
})

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return <Comp data-slot="button" data-variant={variant || "default"} data-icon-button={size === "icon" ? "true" : undefined} className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
})
Button.displayName = "Button"

export { Button, buttonVariants }
