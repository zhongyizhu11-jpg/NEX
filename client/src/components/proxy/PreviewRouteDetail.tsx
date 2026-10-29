import { trpc } from "@/lib/trpc";
import { ArrowRight } from "lucide-react";
import { ExitHostPanel } from "./ExitQualityView";

/*
  订阅内容 › 点开一条：这条线路怎么走（入口 → 中转 → 落地），以及落地出去以后的情况。

  订阅里一排「Po0(200M) → HK」「po0(300M) → HK」，名字差不多，分不清哪条走隧道、哪条是转发链、
  线路组现在走哪条路径。数据：proxySubscriptions.previewRoute（server/subscriptionRouteView）
  和 proxySubscriptions.exitCheck（落地出口，和节点菜单「出口检测」同一份）。点开才取。
*/

type Hop = { name: string; role: "entry" | "relay" | "exit"; online: boolean | null; note?: string; address?: string };

const ROLE_LABELS: Record<Hop["role"] | "landing", string> = { entry: "入口", relay: "中转", exit: "出口", landing: "落地" };

function Stop({ hop, role }: { hop: Pick<Hop, "name" | "online" | "note" | "address">; role: Hop["role"] | "landing" }) {
  const dot = hop.online === false ? "var(--fx-down)" : hop.online === true ? "var(--fx-healthy)" : "var(--fx-text-muted)";
  return (
    <span className="inline-flex min-w-0 max-w-full flex-col rounded-md border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] px-2 py-1" title={hop.online === false ? `${hop.name} 离线` : undefined}>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="text-[10.5px] text-muted-foreground">{ROLE_LABELS[role]}</span>
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dot }} />
        <span className="truncate font-medium">{hop.name}</span>
      </span>
      {hop.address || hop.note ? <span className="truncate font-mono text-[10.5px] text-muted-foreground">{hop.address || hop.note}</span> : null}
    </span>
  );
}

function Arrow() {
  return <ArrowRight aria-hidden="true" className="h-3 w-3 shrink-0 self-center text-muted-foreground" />;
}

export function PreviewRouteDetail({ ruleId, nodeId, direct, address }: { ruleId: number; nodeId: number; direct: boolean; address: string }) {
  const routeQuery = trpc.proxySubscriptions.previewRoute.useQuery({ ruleId }, { enabled: !direct && ruleId > 0, staleTime: 30_000, refetchOnWindowFocus: false });
  const route = routeQuery.data;
  const landingNodeId = route?.landing.nodeId || nodeId;
  const exitQuery = trpc.proxySubscriptions.exitCheck.useQuery({ nodeId: landingNodeId || 1 }, { enabled: landingNodeId > 0, staleTime: 30_000, refetchOnWindowFocus: false });
  const exit = exitQuery.data;
  return (
    <div className="space-y-2.5 border-t border-[var(--fx-stroke-weak)] px-2.5 pb-2.5 pt-2" data-testid="preview-route">
      {direct ? (
        <div className="flex flex-wrap items-stretch gap-1.5">
          <Stop role="entry" hop={{ name: "客户端", online: null, note: "直接连" }} />
          <Arrow />
          <Stop role="landing" hop={{ name: exit?.subject.name || "落地", online: exit?.host ? exit.host.online : null, address }} />
        </div>
      ) : routeQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">正在读这条线路……</p>
      ) : routeQuery.error ? (
        <p className="text-xs text-[var(--fx-down-text)]">{routeQuery.error.message}</p>
      ) : route ? (
        <>
          <div className="flex flex-wrap items-stretch gap-1.5" data-testid="preview-route-chain">
            <Stop role="entry" hop={route.entry} />
            {route.hops.map((hop, index) => (
              <span key={`${hop.name}-${index}`} className="contents">
                <Arrow />
                <Stop role={hop.role} hop={hop} />
              </span>
            ))}
            <Arrow />
            <Stop role="landing" hop={{ name: route.landing.name, online: exit?.host ? exit.host.online : null, address: route.landing.address }} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {route.kindLabel}{route.note ? ` · ${route.note}` : ""}
            {route.ruleName ? ` · 转发「${route.ruleName}」` : ""}
          </p>
        </>
      ) : null}

      <div className="space-y-1.5">
        <p className="text-meta font-medium text-muted-foreground">落地出口</p>
        {landingNodeId <= 0 ? (
          <p className="text-xs text-muted-foreground">这条转发的目标没绑「我的节点」，看不了落地出口。</p>
        ) : exitQuery.isLoading ? (
          <p className="text-xs text-muted-foreground">正在读……</p>
        ) : exit?.host ? (
          <ExitHostPanel host={exit.host} targets={exit.targets} compact />
        ) : exit ? (
          <p className="text-xs text-muted-foreground">落地 {exit.subject.address} 不在装了 Agent 的机器上，测不了出口。</p>
        ) : null}
      </div>
    </div>
  );
}
