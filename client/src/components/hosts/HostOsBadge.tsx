import type { CSSProperties } from "react";
import { Server } from "lucide-react";

import { describeNetworkHealth, type NetworkHealth } from "@shared/networkHealth";
import { parseHostOs, type HostOsIdentity } from "@shared/hostOs";
import { cn } from "@/lib/utils";
import { OS_LOGOS } from "./osLogos";

/**
 * 主机的「系统」标识：发行版图标、发行版 + 版本、Agent 版本。
 *
 * 图标用品牌色画在一块同色 12% 的淡底上，像手机里的 App 图标 —— 一列主机扫下来，
 * 先认出「这台是 Debian、那台是 Ubuntu」，再读名字。认不出的发行版和没上报的，
 * 用通用的服务器图标、灰底，不硬猜一个 Linux 企鹅。
 *
 * 颜色走两个局部变量 --fx-os / --fx-os-dark：深色下换成 osLogos 里的 darkColor
 * （AlmaLinux 的黑、CentOS 的深蓝在炭灰底上会消失）。
 */

export function hostOsOf(host: any): HostOsIdentity {
  return parseHostOs(host?.osInfo);
}

function osStyle(os: HostOsIdentity): CSSProperties | undefined {
  const logo = OS_LOGOS[os.family];
  if (!logo) return undefined;
  return { "--fx-os": logo.color, "--fx-os-dark": logo.darkColor ?? logo.color } as CSSProperties;
}

/** 只有图标本身，给详情里的「系统」一行、旧大卡的系统一行用。 */
export function HostOsGlyph({ os, className }: { os: HostOsIdentity; className?: string }) {
  const logo = OS_LOGOS[os.family];
  if (!logo) {
    return <Server className={cn("h-4 w-4 shrink-0 text-muted-foreground", className)} aria-hidden="true" />;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("h-4 w-4 shrink-0 text-[var(--fx-os)] dark:text-[var(--fx-os-dark)]", className)}
      style={osStyle(os)}
    >
      <path d={logo.path} fill="currentColor" />
    </svg>
  );
}

const AVATAR_SIZES = {
  sm: { box: "h-8 w-8 rounded-[9px]", glyph: "h-[17px] w-[17px]", dot: "h-2 w-2" },
  md: { box: "h-10 w-10 rounded-[11px]", glyph: "h-[21px] w-[21px]", dot: "h-2.5 w-2.5" },
  lg: { box: "h-11 w-11 rounded-[12px]", glyph: "h-6 w-6", dot: "h-2.5 w-2.5" },
} as const;

/**
 * 发行版图标 + 淡底方块。传了 health 就在右下角挂一枚状态点（带一圈卡片底色的描边，
 * 和图标分开）—— 列表卡上它顶替原来名字左边那枚点，状态一眼还是看得到。
 */
export function HostOsAvatar({
  os,
  health,
  size = "md",
  className,
}: {
  os: HostOsIdentity;
  health?: NetworkHealth;
  size?: keyof typeof AVATAR_SIZES;
  className?: string;
}) {
  const logo = OS_LOGOS[os.family];
  const dims = AVATAR_SIZES[size];
  const descriptor = health ? describeNetworkHealth(health) : null;
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        dims.box,
        logo
          ? "bg-[color-mix(in_srgb,var(--fx-os)_12%,transparent)] dark:bg-[color-mix(in_srgb,var(--fx-os-dark)_16%,transparent)]"
          : "bg-[var(--fx-l2-group)]",
        className,
      )}
      style={osStyle(os)}
      title={os.full || "系统未上报"}
    >
      <HostOsGlyph os={os} className={dims.glyph} />
      {descriptor ? (
        <span
          role="img"
          aria-label={descriptor.label}
          className={cn(
            "absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-card",
            dims.dot,
            health === "switching" && "fx-dot-pulse",
          )}
          style={{ backgroundColor: `var(--fx-${descriptor.token})` }}
        />
      ) : null}
    </span>
  );
}
