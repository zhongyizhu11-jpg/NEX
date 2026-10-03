import { NetworkOverview } from "@/components/network/NetworkOverview";
import type { NetworkMapData } from "@/features/network/networkMapData";
import { useNetworkMapModelFromData, type NetworkMapModel } from "@/features/network/networkMapModel";
import { overviewCounts } from "@/features/network/networkOverview";
import type { ForwardMapLink } from "@shared/forwardMapLinks";

/**
 * 首页的「概览」：这个账号看得到的主机，按大致的地理位置摆在一张白底的图上，主机之间的隧道和
 * 转发各连一条线（components/network/NetworkOverview）。标题行右边是图例：隧道几条、转发几条，
 * 有断了的再写一个红色的「中断 N」。
 *
 * 这个文件整个由首页的 NetworkMapSlot lazy 进来（模型、中文地名表都不进首屏包）；数据是 Slot
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

const swatch = (color: string, width = "2px") => ({ background: color, height: width });

/** 卡片本身：拿到模型就能画，node 里 renderToStaticMarkup 也能测 */
export function NetworkOverviewSection({ model, forwardLinks, onOpen }: {
  model: NetworkMapModel;
  forwardLinks: readonly ForwardMapLink[];
  onOpen: (href: string) => void;
}) {
  const counts = overviewCounts(model, forwardLinks);
  const drawable = model.links.length + forwardLinks.length;

  return (
    <section aria-label="概览" className="fx-netmap-card fx-card-face flex min-w-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 pt-3.5">
        <span className="shrink-0 whitespace-nowrap text-primary-type font-semibold text-foreground">概览</span>
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-0.5 text-meta text-[var(--fx-text-secondary)]">
          <span className="tabular-nums">{model.nodes.length} 台主机</span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="w-3.5 rounded-full" style={swatch("var(--fx-accent)")} />
            隧道 <span className="font-medium tabular-nums text-foreground">{counts.tunnels}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="w-3.5 rounded-full" style={swatch("var(--fx-text-secondary)", "1.5px")} />
            转发 <span className="font-medium tabular-nums text-foreground">{counts.forwards}</span>
          </span>
          {counts.down > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-[var(--fx-down-text)]">
              中断 <span className="font-medium tabular-nums">{counts.down}</span>
            </span>
          ) : null}
        </span>
      </div>
      <div className="px-2 pb-1 pt-1">
        <NetworkOverview model={model} forwardLinks={forwardLinks} onOpen={onOpen} />
      </div>
      {model.hiddenLinkCount > 0 ? (
        <div className="px-4 pb-3 text-meta tabular-nums text-muted-foreground">{model.hiddenLinkCount} 条隧道经过你看不到的主机，没有画出来</div>
      ) : drawable === 0 ? (
        <div className="px-4 pb-3 text-meta text-muted-foreground">还没有连线。建一条隧道，或者把转发指向另一台主机，这里就会连起来。</div>
      ) : null}
    </section>
  );
}
