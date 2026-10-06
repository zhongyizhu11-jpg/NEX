import { NetworkOverview } from "@/components/network/NetworkOverview";
import type { NetworkMapData } from "@/features/network/networkMapData";
import { useNetworkMapModelFromData, type NetworkMapModel } from "@/features/network/networkMapModel";
import { buildOverviewEdges, clusterOverview, clusterOverviewBundles, overviewCounts, projectOverview } from "@/features/network/networkOverview";
import { describeNetworkHealth } from "@shared/networkHealth";
import type { ForwardMapLink } from "@shared/forwardMapLinks";

/**
 * 首页的「概览」：这个账号看得到的主机，按真实经纬度落在一张裁到它们范围的矢量世界底图上（挨太近的合成一个点），主机之间的
 * 隧道和转发合成一条线（components/network/NetworkOverview）。标题行右边一枚状态胶囊
 * （全部正常 / N 台离线 / N 条降级 / N 条中断，按隧道数），图例在卡片底下一行：只说线的画法
 * （正常 / 降级 / 中断，图上有才列）和几台主机，总数看页头。
 *
 * 这个文件整个由首页的 NetworkMapSlot lazy 进来（模型、中文地名表、国界底图都不进首屏包）；数据是 Slot
 * 早就发出去的那几条请求。一台主机都没有时整块不出现：那是「快速开始」的事。
 */
export { buildNetworkMapModel, useNetworkMapModel } from "@/features/network/networkMapModel";
export type { NetworkMapModel } from "@/features/network/networkMapModel";

/** Slot lazy 进来的卡片：拿 Slot 已经取到的数据建模型（数据没变不重算） */
export default function NetworkMapSection({ data, onOpen }: { data: NetworkMapData; onOpen: (href: string) => void }) {
  const model = useNetworkMapModelFromData(data);
  if (model.nodes.length === 0) return null;
  return <NetworkOverviewSection model={model} forwardLinks={data.forwardLinks} onOpen={onOpen} />;
}

/** 卡片本身：拿到模型就能画，node 里 renderToStaticMarkup 也能测 */
export function NetworkOverviewSection({ model, forwardLinks, onOpen }: {
  model: NetworkMapModel;
  forwardLinks: readonly ForwardMapLink[];
  onOpen: (href: string) => void;
}) {
  const counts = overviewCounts(model, forwardLinks);
  const drawable = model.links.length + forwardLinks.length;
  // 图例按真正画出来的线：同城的主机合成一个点，两头都在一个点里的线不画（状态进了点的颜色），
  // 图例也别提它。合点只看城市名，和画布宽度无关，这里按一个固定尺寸算一遍就够
  const placed = clusterOverview(projectOverview(model.nodes, 800, 340));
  const { bundles } = clusterOverviewBundles(buildOverviewEdges(model, forwardLinks), placed);
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
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 whitespace-nowrap text-primary-type font-semibold text-foreground">概览</span>
          <span className="truncate text-meta tabular-nums text-muted-foreground">{model.nodes.length} 台主机 · {placed.length} 个地点</span>
        </span>
        {drawable > 0 || counts.tunnels > 0 ? (
          <span className="fx-overview-verdict tabular-nums" data-tone={verdict.tone}>
            <span aria-hidden="true" className="fx-overview-verdict-dot" />
            {verdict.text}
          </span>
        ) : null}
      </div>
      <div className="fx-overview-canvas mx-2.5">
        <NetworkOverview model={model} forwardLinks={forwardLinks} onOpen={onOpen} />
      </div>
      {/*
        图例只说线的画法，不再自己数一遍：总数在页头（N 条线路 · N 条转发），状态在右上角的胶囊，
        三处各数各的只会对不上（2.3.410 真机上「1 条中断」和「中断 2」并排）。
      */}
      <div className="fx-overview-legend">
        <span><span aria-hidden="true" className="fx-overview-swatch" data-tone="ok" />正常</span>
        {lines.warn > 0 ? <span className="text-[var(--fx-warn-text)]"><span aria-hidden="true" className="fx-overview-swatch" data-tone="warn" />降级</span> : null}
        {lines.down > 0 ? <span className="text-[var(--fx-down-text)]"><span aria-hidden="true" className="fx-overview-swatch" data-tone="down" />中断</span> : null}
      </div>
      {model.hiddenLinkCount > 0 ? (
        <div className="px-4 pb-3 text-meta tabular-nums text-muted-foreground">{model.hiddenLinkCount} 条隧道经过你看不到的主机，没有画出来</div>
      ) : drawable === 0 ? (
        <div className="px-4 pb-3 text-meta text-muted-foreground">还没有连线。建一条隧道，或者把转发指向另一台主机，这里就会连起来。</div>
      ) : null}
    </section>
  );
}
