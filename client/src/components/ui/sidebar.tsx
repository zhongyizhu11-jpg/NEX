import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Slot } from "@radix-ui/react-slot"
import { cn } from "@/lib/utils"
import { PanelLeft } from "lucide-react"
import { Button } from "./button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip"
import { useIsMobile } from "@/hooks/useMobile"
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "./dialog"

const SIDEBAR_COOKIE_NAME = "sidebar:state"
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const SIDEBAR_WIDTH = "var(--fx-sidebar-width, 16rem)"
const SIDEBAR_WIDTH_MOBILE = "var(--forwardx-mobile-sidebar-width, min(16.5rem, calc(100vw - 3.5rem)))"
const SIDEBAR_WIDTH_ICON = "3rem"
const SIDEBAR_KEYBOARD_SHORTCUT = "b"

type SidebarContext = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContext | null>(null)

function getInitialSidebarOpen(defaultOpen: boolean) {
  if (typeof document === "undefined") return defaultOpen

  const cookie = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${SIDEBAR_COOKIE_NAME}=`))
  const value = cookie?.slice(SIDEBAR_COOKIE_NAME.length + 1)
  if (value === "true") return true
  if (value === "false") return false
  return defaultOpen
}

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }
  return context
}

const SidebarProvider = React.forwardRef<HTMLDivElement, React.ComponentProps<"div"> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}>(({ defaultOpen = true, open: openProp, onOpenChange: setOpenProp, className, style, children, ...props }, ref) => {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)
  const [_open, _setOpen] = React.useState(() => getInitialSidebarOpen(defaultOpen))
  const open = openProp ?? _open
  const setOpen = React.useCallback((value: boolean | ((value: boolean) => boolean)) => {
    const openState = typeof value === "function" ? value(open) : value
    if (setOpenProp) {
      setOpenProp(openState)
    } else {
      _setOpen(openState)
    }
    document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
  }, [setOpenProp, open])

  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen, setOpenMobile])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        if (document.querySelector('[role="dialog"][data-state="open"]:not([data-mobile-sidebar])')) return
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [toggleSidebar])

  const state = isMobile ? "expanded" : open ? "expanded" : "collapsed"
  const contextValue = React.useMemo<SidebarContext>(() => ({
    state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar,
  }), [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar])

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delayDuration={0}>
        <div
          ref={ref}
          className={cn("group/sidebar-wrapper flex min-h-svh w-full", className)}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  )
})
SidebarProvider.displayName = "SidebarProvider"

const Sidebar = React.forwardRef<HTMLDivElement, React.ComponentProps<"div"> & {
  side?: "left" | "right"
  variant?: "sidebar" | "floating" | "inset"
  collapsible?: "offcanvas" | "icon" | "none"
}>(({ side = "left", variant = "sidebar", collapsible = "offcanvas", className, children, ...props }, ref) => {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar()
  const mobileTriggerRef = React.useRef<HTMLElement | null>(null)

  if (collapsible === "none") {
    return (
      <div
        className={cn("flex h-full flex-col bg-sidebar text-sidebar-foreground", className)}
        style={{ width: SIDEBAR_WIDTH }}
        ref={ref}
        {...props}
      >
        {children}
      </div>
    )
  }

  if (isMobile) {
    return (
      <Dialog open={openMobile} onOpenChange={setOpenMobile}>
        <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-mobile-sidebar="true"
          aria-describedby={undefined}
          className={cn(
            "fixed inset-y-0 z-[var(--fx-z-in-overlay-base)] flex h-dvh max-h-dvh flex-col overflow-hidden bg-sidebar text-sidebar-foreground outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-200 data-[state=closed]:duration-150",
            side === "left" ? "left-0 data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left" : "right-0 data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
            className
          )}
          style={{ width: SIDEBAR_WIDTH_MOBILE }}
          ref={ref}
          onOpenAutoFocus={() => { mobileTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            // Another dialog may have been opened from a navigation action.
            if (document.querySelector('[data-forwardx-dialog-content][data-state="open"]')) return
            if (mobileTriggerRef.current?.isConnected) mobileTriggerRef.current.focus()
            else document.querySelector<HTMLElement>('[data-sidebar="trigger"]')?.focus()
          }}
          {...props}
        >
          <DialogTitle className="sr-only">全部导航</DialogTitle>
          {children}
        </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    )
  }

  const isCollapsed = state === "collapsed"
  const collapsibleIsIcon = isCollapsed && collapsible === "icon"
  const collapsibleIsOffcanvas = isCollapsed && collapsible === "offcanvas"

  // Calculate spacer width
  let spacerWidth: string = SIDEBAR_WIDTH
  if (collapsibleIsOffcanvas) {
    spacerWidth = "0px"
  } else if (collapsibleIsIcon) {
    if (variant === "floating" || variant === "inset") {
      spacerWidth = `calc(${SIDEBAR_WIDTH_ICON} + 1rem)` // theme(spacing.4) = 1rem
    } else {
      spacerWidth = SIDEBAR_WIDTH_ICON
    }
  }

  // Calculate fixed sidebar width
  let fixedWidth: string = SIDEBAR_WIDTH
  if (collapsibleIsIcon) {
    if (variant === "floating" || variant === "inset") {
      fixedWidth = `calc(${SIDEBAR_WIDTH_ICON} + 1rem + 2px)`
    } else {
      fixedWidth = SIDEBAR_WIDTH_ICON
    }
  }

  // Calculate fixed sidebar position offset
  let sideOffset: string | undefined
  if (collapsibleIsOffcanvas) {
    sideOffset = `-${SIDEBAR_WIDTH}`
  }

  return (
    <div
      ref={ref}
      className="group peer hidden md:block text-sidebar-foreground"
      data-state={state}
      data-collapsible={isCollapsed ? collapsible : ""}
      data-variant={variant}
      data-side={side}
    >
      {/* Spacer div - takes up space in the flex layout to push content */}
      <div
        className={cn(
          "duration-200 relative h-svh bg-transparent transition-[width] ease-linear",
          side === "right" && "rotate-180"
        )}
        style={{ width: spacerWidth }}
      />
      {/* Fixed sidebar - actually visible */}
      <div
        className={cn(
          "duration-200 fixed inset-y-0 z-10 hidden h-svh transition-[left,right,width] ease-linear md:flex",
          side === "left" ? "left-0" : "right-0",
          variant === "floating" || variant === "inset"
            ? "p-2"
            : "border-r",
          className
        )}
        style={{
          width: fixedWidth,
          ...(sideOffset ? (side === "left" ? { left: sideOffset } : { right: sideOffset }) : {}),
        }}
      >
        <div
          data-sidebar="sidebar"
          className={cn(
            "flex h-full w-full flex-col bg-transparent",
            (variant === "floating" || variant === "inset") && "rounded-lg border border-sidebar-border/70 shadow"
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
})
Sidebar.displayName = "Sidebar"

const SidebarTrigger = React.forwardRef<React.ComponentRef<typeof Button>, React.ComponentProps<typeof Button>>(({ className, onClick, ...props }, ref) => {
  const { toggleSidebar, isMobile, openMobile, open } = useSidebar()
  return (
    <Button ref={ref} data-sidebar="trigger" aria-expanded={isMobile ? openMobile : open} variant="ghost" size="icon" className={cn("h-7 w-7", className)} onClick={(event) => { onClick?.(event); if (!event.defaultPrevented) toggleSidebar() }} {...props}>
      <PanelLeft />
      <span className="sr-only">切换导航栏</span>
    </Button>
  )
})
SidebarTrigger.displayName = "SidebarTrigger"

const SidebarInset = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(({ className, ...props }, ref) => {
  return <div ref={ref} className={cn("relative flex min-h-svh flex-1 flex-col bg-transparent", className)} {...props} />
})
SidebarInset.displayName = "SidebarInset"

const SidebarHeader = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(({ className, ...props }, ref) => {
  return <div ref={ref} data-sidebar="header" className={cn("flex shrink-0 flex-col gap-2 p-2", className)} {...props} />
})
SidebarHeader.displayName = "SidebarHeader"

const SidebarFooter = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(({ className, ...props }, ref) => {
  return <div ref={ref} data-sidebar="footer" className={cn("flex shrink-0 flex-col gap-2 p-2", className)} {...props} />
})
SidebarFooter.displayName = "SidebarFooter"

const SidebarContent = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(({ className, ...props }, ref) => {
  return <div ref={ref} data-sidebar="content" className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden", className)} {...props} />
})
SidebarContent.displayName = "SidebarContent"

const SidebarGroup = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(({ className, ...props }, ref) => {
  return <div ref={ref} data-sidebar="group" className={cn("relative flex w-full min-w-0 shrink-0 flex-col p-2", className)} {...props} />
})
SidebarGroup.displayName = "SidebarGroup"

const SidebarGroupLabel = React.forwardRef<HTMLDivElement, React.ComponentProps<"div"> & { asChild?: boolean }>(({ className, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "div"
  return <Comp ref={ref} data-sidebar="group-label" className={cn("duration-200 flex h-7 shrink-0 items-center rounded-md px-2.5 text-xs font-medium text-sidebar-foreground/70 outline-none transition-[margin,opa] ease-linear [&>svg]:size-4 [&>svg]:shrink-0", "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0", className)} {...props} />
})
SidebarGroupLabel.displayName = "SidebarGroupLabel"

const SidebarMenu = React.forwardRef<HTMLUListElement, React.ComponentProps<"ul">>(({ className, ...props }, ref) => (
  <ul ref={ref} data-sidebar="menu" className={cn("flex w-full min-w-0 flex-col gap-1", className)} {...props} />
))
SidebarMenu.displayName = "SidebarMenu"

const SidebarMenuItem = React.forwardRef<HTMLLIElement, React.ComponentProps<"li">>(({ className, ...props }, ref) => (
  <li ref={ref} data-sidebar="menu-item" className={cn("group/menu-item relative", className)} {...props} />
))
SidebarMenuItem.displayName = "SidebarMenuItem"

const sidebarMenuButtonVariants = (variant: "default" | "outline" = "default", size: "default" | "sm" | "lg" = "default") => {
  return cn(
    "peer/menu-button flex w-full items-center gap-2.5 overflow-hidden rounded-md px-2.5 py-1.5 text-left text-sm outline-none transition-[width,height,padding,background-color,box-shadow] hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:shadow-[var(--fx-focus-ring)] active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-[[data-sidebar=menu-action]]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent/70 data-[active=true]:text-sidebar-accent-foreground data-[active=true]:shadow-none data-[state=open]:hover:bg-sidebar-accent/70 data-[state=open]:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:!size-9 group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!p-0 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
    variant === "outline" && "bg-background shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))]",
    size === "sm" && "text-xs",
    size === "lg" && "text-sm group-data-[collapsible=icon]:!p-0",
  )
}

const SidebarMenuButton = React.forwardRef<HTMLButtonElement, React.ComponentProps<"button"> & {
  asChild?: boolean
  isActive?: boolean
  tooltip?: string | React.ComponentProps<typeof TooltipContent>
  variant?: "default" | "outline"
  size?: "default" | "sm" | "lg"
}>(({ asChild = false, isActive = false, variant = "default", size = "default", tooltip, className, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  const { isMobile, state } = useSidebar()
  const button = <Comp ref={ref} data-sidebar="menu-button" data-size={size} data-active={isActive} className={cn(sidebarMenuButtonVariants(variant, size), className)} {...props} />

  if (!tooltip) return button

  const tooltipProps = typeof tooltip === "string" ? { children: tooltip } : tooltip

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={state !== "collapsed" || isMobile} {...tooltipProps} />
    </Tooltip>
  )
})
SidebarMenuButton.displayName = "SidebarMenuButton"

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
}
