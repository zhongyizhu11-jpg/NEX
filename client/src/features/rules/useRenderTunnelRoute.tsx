/*
  从 client/src/pages/Rules.tsx 第 5583-5619 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { getTunnelExitNames, getTunnelHopIds, getTunnelRouteText, tunnelHopHostName } from "@/lib/tunnelDisplay";
import { ArrowRight } from "lucide-react";
import { Fragment } from "react";

export type UseRenderTunnelRouteContext = {
  forwardGroupById: Map<number, any>;
  getForwardGroupSelectName: (group: any) => string;
  hosts: Array<any> | undefined;
};

export type UseRenderTunnelRouteResult = {
  renderTunnelRoute: any /* 原类型 (tunnel: any, compact?: boolean) => JSX.Element… 引用了拿不到的 JSX，手动收拾 */;
};

export function useRenderTunnelRoute(ctx: UseRenderTunnelRouteContext): UseRenderTunnelRouteResult {
  const { forwardGroupById, getForwardGroupSelectName, hosts } = ctx;
  const renderTunnelRoute = (tunnel: any, compact = false) => {
    const hopIds = getTunnelHopIds(tunnel);
    const exitGroup = Number(tunnel?.exitGroupId || 0) > 0
      ? forwardGroupById.get(Number(tunnel.exitGroupId))
      : null;
    const exitGroupName = exitGroup ? getForwardGroupSelectName(exitGroup) : "";
    const exitNames = exitGroupName ? getTunnelExitNames(tunnel, hosts) : [];
    const routeTitle = getTunnelRouteText(tunnel, hosts, exitGroupName);
    return (
      <div
        className={`flex min-w-0 items-center gap-1.5 text-xs ${compact ? "flex-wrap" : "whitespace-nowrap"}`}
        title={routeTitle}
      >
        {hopIds.map((hostId: number, index: number) => (
          <Fragment key={`${tunnel?.id || "tunnel"}-${hostId}-${index}`}>
            {index > 0 && <ArrowRight className="h-3 w-3 shrink-0" />}
            <span
              className={exitGroupName && index === hopIds.length - 1
                ? (compact ? "min-w-0 max-w-full break-words" : "min-w-0 truncate")
                : (compact ? "max-w-[8rem] truncate" : "truncate")}
            >
              {exitGroupName && index === hopIds.length - 1 ? (
                <>
                  {exitGroupName}
                  {exitNames.length > 0 && (
                    <span className="text-muted-foreground">
                      {"\uFF1B\u51FA\u53E3\uFF1A"}{exitNames.join(" / ")}
                    </span>
                  )}
                </>
              ) : tunnelHopHostName(tunnel, hostId, hosts)}
            </span>
          </Fragment>
        ))}
      </div>
    );
  };
  return { renderTunnelRoute };
}
