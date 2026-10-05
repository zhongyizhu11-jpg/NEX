import { NetworkOverview } from "@/components/network/NetworkOverview";
import type { NetworkMapData } from "@/features/network/networkMapData";
import { useNetworkMapModelFromData, type NetworkMapModel } from "@/features/network/networkMapModel";
import { buildOverviewEdges, bundleOverviewEdges, overviewCounts } from "@/features/network/networkOverview";
import { describeNetworkHealth } from "@shared/networkHealth";
import type { OverviewMapStyle } from "@/components/network/NetworkOverview";
import type { ForwardMapLink } from "@shared/forwardMapLinks";

/**
 * 首页的「概览」：这个账号看得到的主机，按真实位置摆在一张裁到它们范围的世界底图上，主机之间的
 * 隧道和转发合成一条线（components/network/NetworkOverview）。标题行右边一枚状态胶囊
 * （全部正常 / N 台离线 / N 条降级 / N 条中断），图例在卡片底下一行：线路几条、转发几条、
 * 画成降级 / 中断的线几条、几台主机。
 *
 * 这个文件整个由首页的 NetworkMapSlot lazy 进来（模型、中文地名表、点阵都不进首屏包）；数据是 Slot
 * 早就发出去的那几条请求。一台主机都没有时整块不出现：那是「快速开始」的事。
 */
export { buildNetworkMapModel, useNetworkMapModel } from "@/features/network/networkMapModel";
export type { NetworkMapModel } from "@/features/network/networkMapModel";

/** Slot lazy 进来的卡片：拿 Slot 已经取到的数据建模型（数据没变不重算） */
export default function NetworkMapSection({ data, onOpen }: { data: NetworkMapData; onOpen: (href: string) => void }) {
  const model = useNetworkMapModelFromData(data);
  // PREVIEW-ONLY: ?map=… 切底图样式出截图，挑定后删掉
  const mapStyle = ((typeof location !== "undefined" && new URLSearchParams(location.search).get("map")) || "plain") as OverviewMapStyle;
  if (model.nodes.length === 0) return null;
  return <NetworkOverviewSection model={model} forwardLinks={data.forwardLinks} onOpen={onOpen} mapStyle={mapStyle} />;
}

/** 卡片本身：拿到模型就能画，node 里 renderToStaticMarkup 也能测 */
export function NetworkOverviewSection({ model, forwardLinks, onOpen, mapStyle = "plain" }: {
  model: NetworkMapModel;
  forwardLinks: readonly ForwardMapLink[];
  onOpen: (href: string) => void;
  mapStyle?: OverviewMapStyle;
}) {
  const counts = overviewCounts(model, forwardLinks);
  const drawable = model.links.length + forwardLinks.length;
  // 图例按画出来的线数：同一对主机之间合成一条，降级 / 中断各几条（转发指向掉线主机的也算降级）
  const bundles = bundleOverviewEdges(buildOverviewEdges(model, forwardLinks));
  const lines = {
    warn: bundles.filter((bundle) => bundle.tone === "warn").length,
    down: bundles.filter((bundle) => bundle.tone === "down").length,
  };
  const offlineHosts = model.nodes.filter((node) => describeNetworkHealth(node.health).token === "down").length;
  const verdict = counts.down > 0
    ? { tone: "down", text: `${counts.down} 条中断` }
    : counts.degraded > 0
      ? { tone: "warn", text: `${counts.degraded} 条降级` }
      : offlineHosts > 0
        ? { tone: "warn", text: `${offlineHosts} 台离线` }
        : { tone: "ok", text: "全部正常" };

  return (
    <section aria-label="概览" className="fx-netmap-card fx-card-face flex min-w-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 pb-2.5 pt-3.5">
        <span className="shrink-0 whitespace-nowrap text-primary-type font-semibold text-foreground">概览</span>
        {drawable > 0 || counts.tunnels > 0 ? (
          <span className="fx-overview-verdict tabular-nums" data-tone={verdict.tone}>
            <span aria-hidden="true" className="fx-overview-verdict-dot" />
            {verdict.text}
          </span>
        ) : null}
      </div>
      <div className="fx-overview-canvas mx-2.5" data-map-style={mapStyle}>
        <NetworkOverview model={model} forwardLinks={forwardLinks} onOpen={onOpen} mapStyle={mapStyle} />
      </div>
      <div className="fx-overview-legend">
        <span><span aria-hidden="true" className="fx-overview-swatch" data-tone="ok" />线路 <b>{counts.tunnels}</b> · 转发 <b>{counts.forwards}</b></span>
        {lines.warn > 0 ? <span className="text-[var(--fx-warn-text)]"><span aria-hidden="true" className="fx-overview-swatch" data-tone="warn" />降级 <b>{lines.warn}</b></span> : null}
        {lines.down > 0 ? <span className="text-[var(--fx-down-text)]"><span aria-hidden="true" className="fx-overview-swatch" data-tone="down" />中断 <b>{lines.down}</b></span> : null}
        <span className="ml-auto">{model.nodes.length} 台主机</span>
      </div>
      {model.hiddenLinkCount > 0 ? (
        <div className="px-4 pb-3 text-meta tabular-nums text-muted-foreground">{model.hiddenLinkCount} 条隧道经过你看不到的主机，没有画出来</div>
      ) : drawable === 0 ? (
        <div className="px-4 pb-3 text-meta text-muted-foreground">还没有连线。建一条隧道，或者把转发指向另一台主机，这里就会连起来。</div>
      ) : null}
    </section>
  );
}
