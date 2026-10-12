import { cn } from "@/lib/utils";

/**
 * NEX 隧道卡片上的链路整形一行字（面板在 tunnels.list 里给的 linkShapingStatus，
 * 是 FXP 报上来的，见 forwardx-fxp/link_shaper.go）。
 *
 * 只在真的在整形或出了状况时显示：学到的限速点、正在找、暂停。平时「在观察、没遇到
 * 限速」什么都不显示，免得每张卡片都多一行。
 *
 * 过期的上报（stale）也不显示：关掉整形、把隧道换成别的协议之后 FXP 就不再报了，
 * 那条「正在找限速点」不能一直挂在卡片上（见 server/tunnelLinkShapingView.ts）。
 */

export type LinkShapingStatusItem = {
  direction?: string | null;
  state?: string | null;
  rateMbps?: number | null;
  learnedMbps?: number | null;
  hostName?: string | null;
  /** 面板判定这条上报已经过期（关了整形、换了协议、机器离线都会这样），不是实时状态。 */
  stale?: boolean | null;
};

export function tunnelLinkShapingText(tunnel: { linkShapingStatus?: LinkShapingStatusItem[] | null } | null | undefined) {
  const items = Array.isArray(tunnel?.linkShapingStatus) ? tunnel!.linkShapingStatus! : [];
  const parts: string[] = [];
  for (const item of items) {
    if (item?.stale) continue;
    const direction = item?.direction === "down" ? "出口→入口" : "入口→出口";
    const state = String(item?.state || "");
    const learned = Number(item?.learnedMbps || 0);
    const rate = Number(item?.rateMbps || 0);
    if (state === "shaping" && learned > 0) {
      parts.push(`${direction} ${learned} Mbit/s`);
    } else if (state === "shaping" && rate > 0) {
      parts.push(`${direction} 正在找限速点（${rate} Mbit/s）`);
    } else if (state === "paused") {
      parts.push(`${direction} 暂停（不像限速器）`);
    }
  }
  return parts.length > 0 ? `链路整形：${parts.join(" · ")}` : "";
}

export function TunnelLinkShapingNotice({
  tunnel,
  className,
  as: Tag = "p",
}: {
  tunnel: { linkShapingStatus?: LinkShapingStatusItem[] | null } | null | undefined;
  className?: string;
  as?: "p" | "span";
}) {
  const text = tunnelLinkShapingText(tunnel);
  if (!text) return null;
  return (
    <Tag className={cn("mt-1 block text-[11px] leading-snug text-muted-foreground", className)} title={text} data-link-shaping="">
      {text}
    </Tag>
  );
}
