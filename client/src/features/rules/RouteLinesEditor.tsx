import { Fragment, useMemo, useState, type ReactNode, type Ref } from "react";
import { ChevronDown, X } from "lucide-react";

import { SortableItem, SortableReorderContext, useSortableReorder } from "@/components/SortableDragHandle";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  LineBadge,
  LineChip,
  LineChipButton,
  LineDot,
  LineMs,
  LinePath,
  LineRow,
  LineZapGlyph,
} from "@/features/lines/LineUi";
import { cn } from "@/lib/utils";
import { formatFailoverEndpoint, parseFailoverEndpoint } from "@shared/failoverTargets";
import { MAX_ROUTE_HOPS, MAX_ROUTE_PATHS, defaultRoutePathName, describeRouteIssue, type RoutePath } from "@shared/routeGroup";
import { MAX_LAYER_CANDIDATES, MAX_LINE_DESTS, expandRouteLines, newRouteLayer, newRouteLine, type RouteLayer, type RouteLine } from "@shared/routeLines";
import { routeNodeOptionLabel } from "./routeLineOptions";
import { segmentKey, useSegmentLatency } from "./segmentLatency";

/*
  编辑线路组（2.3.496，照效果图 ②「编辑：主线路 + 有序备用」）：

    每条线路收着是一行，点开是一条竖着的链：入口 ● → 中转 ● （几跳就几个：中转 1、中转 2…）→ 落地 ●。
    一跳里可以放几台候选（机器、隧道混着放），并列的几台放在一个胶囊里（「Jinx / jinx(39.9y)」），有两台以上才出
    「最低延迟 / 按顺序」——只有一台时没得挑；或者这一跳是一个节点池：平时一个「池 · 名字 · N 台」，点开一列看池里
    每台（2.3.498）。两个加号分开叫：「+ 加中转」在链上最后一个中转和落地之间，串下一跳，只加一台（或一条隧道）；
    「+ 并列」在那一跳里，再放一台，或者把这一跳换成节点池（池就是一组现成的并列机器）。「可跳过」（这一跳全坏了就直连下一跳）不再给勾：和加一条不经它的备用线路是一回事，
    备用线路排第几、状态、暂停都看得见；老配置里勾过的照常生效，这里显示「可跳过 ×」，点一下取消。
    下面是有序的备用：一行一条，拖动排序；整行点一下展开来改，小闪电（逐段测）在展开的那块里 —— 收着的行上
    只留路径和状态，省地方（2.3.498，以前每行还挂着 ▾ 和 ⚡，路径被挤得只剩半截）。勾掉就不参与
    （线路详情里是状态胶囊和立刻生效的暂停，见 renderLineStatus）。
    再下面一个「添加备用线路」菜单：空白的、直连落地、经某台机器、经某个节点池。

  chip 上的毫秒：打开就是最近一轮探测的，右上角小闪电逐段测的盖掉它（server/lineSegmentLatency.ts）——
  保存前就知道每段多快。数从 segmentLatency.ts 的 context 来，编辑器自己不碰接口。
  展开成具体路径（Agent 认的那种）在服务端做；这里同一套函数做一份预览（钉子、时段表按它数）。
*/

export type RouteLineHost = { id: number; name: string; isOnline?: boolean | null };
export type RouteLinePool = {
  id: number;
  name: string;
  role: string;
  members: Array<{ hostId: number; name: string; online: boolean; maintenance: boolean }>;
  /** 落地池：开着的成员（2.3.500）。 */
  landingMembers?: number[];
};
export type RouteLineTunnel = { id: number; name: string; entryHostId: number; exitHostId: number; mode?: string | null; relayMode?: string | null };
export type RouteLineNode = {
  id: number;
  name: string;
  address: string;
  port: number;
  protocol?: string;
  /** 落地池的池节点：选了它，落地就是池里的几台（展开成一台一条路径）。 */
  landingPool?: { id: number; name: string; members: number; ready: number } | null;
};

type Candidate = { kind: "tunnel" | "host"; id: number; label: string; to: number; state: string; hint?: string };

export function RouteLinesEditor({
  lines,
  onChange,
  hosts,
  pools,
  tunnels,
  nodeOptions,
  entryHostId,
  entryName,
  entryPrefix,
  mainAddress,
  allowHops,
  allowTunnels,
  previewPaths,
  ruleId,
  upstreamHostIds = [],
  renderLineStatus,
  activeLineKey = null,
  startCollapsed = false,
  arrange = true,
  ruleTargetNodeId = null,
}: {
  lines: RouteLine[];
  onChange: (lines: RouteLine[]) => void;
  hosts: RouteLineHost[];
  pools: RouteLinePool[];
  tunnels: RouteLineTunnel[];
  nodeOptions: RouteLineNode[];
  /** 调度器所在的机器（直连规则是入口机，隧道规则是隧道出口）。 */
  entryHostId: number | null;
  entryName: string;
  /** 隧道规则：入口前面那段（「Po0 → 隧道 华南-香港 →」），只读，如实画出来。 */
  entryPrefix?: string | null;
  mainAddress: string;
  allowHops: boolean;
  allowTunnels: boolean;
  previewPaths: RoutePath[];
  ruleId?: number | null;
  /** 入口前面的机器（隧道规则的隧道入口）：流量已经从它那儿过来了，不拿来当中转建议。 */
  upstreamHostIds?: number[];
  /**
   * 线路详情里直接改（2.3.498）：每条线路此刻的状态（使用中 / 待命 / 不通）和立刻生效的暂停。给了、而且这条
   * 线路有状态，就用它代替备用行上「参与切换」那个要保存才生效的勾；还没保存的新线路返回 null，照旧是勾。
   */
  renderLineStatus?: (line: RouteLine, index: number) => ReactNode;
  /** 此刻在走的那条（线路详情里）：那一行描强调色的边，和只读列表一样一眼看出走的是哪条。 */
  activeLineKey?: string | null;
  /** 线路详情里：主线路也收成一行，点开才改。规则表单里新建时主线路一上来是展开的，好直接填。 */
  startCollapsed?: boolean;
  /**
   * 「+ 添加备用线路」和备用行前面的拖动排序（⋮⋮）出不出：线路详情里收在「线路」标题右边那个下拉里
   * （2.3.499，照效果图 ①：平时只看到线路几行）；一条备用都没有时「添加」照样出。
   */
  arrange?: boolean;
  /** 规则目标绑着的节点（落地池的池节点时，「规则目标」那个落地写成「池 · 名字 · N 台」）。 */
  ruleTargetNodeId?: number | null;
}) {
  const hostName = (id: number) => hosts.find((host) => host.id === id)?.name || `主机 ${id}`;
  // 打开就有数（效果图里每个候选后面的毫秒）：最近一轮探测的每一段，点 ⚡ 测出来的盖掉它。
  const { latencyOf, testingKey, test, lastRun } = useSegmentLatency({ ruleId: ruleId ?? null, entryHostId });
  const [openKey, setOpenKey] = useState<string | null>(() => (startCollapsed ? null : lines[0]?.key ?? null));
  /** 展开着的节点池（「线路 key:第几跳」）：点池那个 chip 看池里有哪几台。 */
  const [openPools, setOpenPools] = useState<ReadonlySet<string>>(() => new Set());
  const togglePool = (key: string) => setOpenPools((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const setLine = (index: number, patch: Partial<RouteLine>) => onChange(lines.map((line, position) => (position === index ? { ...line, ...patch } : line)));
  const setLayer = (lineIndex: number, layerIndex: number, patch: Partial<RouteLayer>) => {
    const line = lines[lineIndex];
    setLine(lineIndex, { layers: line.layers.map((layer, position) => (position === layerIndex ? { ...layer, ...patch } : layer)) });
  };
  const removeLayer = (lineIndex: number, layerIndex: number) => setLine(lineIndex, { layers: lines[lineIndex].layers.filter((_, position) => position !== layerIndex) });
  /** 这一跳整个换掉（换成节点池、换成另一个池）。 */
  const replaceLayer = (lineIndex: number, layerIndex: number, layer: RouteLayer) => setLine(lineIndex, { layers: lines[lineIndex].layers.map((item, position) => (position === layerIndex ? layer : item)) });
  const addLayer = (lineIndex: number, layer: RouteLayer) => setLine(lineIndex, { layers: [...lines[lineIndex].layers, layer] });

  const backups = lines.slice(1);
  const sortable = useSortableReorder({
    items: backups,
    getId: (line) => line.key,
    onReorder: (next) => onChange([lines[0], ...next]),
  });

  /** 一层的候选（隧道在前、机器在后，和展开时按顺序挑的顺序一样）。 */
  const candidatesOf = (layer: RouteLayer): Candidate[] => {
    if (layer.kind === "pool") {
      const pool = pools.find((item) => item.id === layer.poolId);
      return (pool?.members || []).map((member) => ({ kind: "host" as const, id: member.hostId, label: member.name, to: member.hostId, state: member.maintenance ? "维护" : member.online ? "" : "离线" }));
    }
    return [
      ...layer.tunnelIds.map((id) => {
        const tunnel = tunnels.find((item) => item.id === id);
        if (!tunnel) return { kind: "tunnel" as const, id, label: `隧道 ${id}`, to: 0, state: "不在了" };
        // 和效果图一样写「隧道 出口机」；同一台出口机有好几条隧道时再带上隧道名，免得分不清
        const shared = tunnels.filter((item) => item.exitHostId === tunnel.exitHostId).length > 1;
        return { kind: "tunnel" as const, id, label: shared ? `隧道 ${tunnel.name} · ${hostName(tunnel.exitHostId)}` : `隧道 ${hostName(tunnel.exitHostId)}`, to: tunnel.exitHostId, state: "", hint: `隧道「${tunnel.name}」：走这条隧道到出口机 ${hostName(tunnel.exitHostId)}` };
      }),
      ...layer.hostIds.map((id) => ({ kind: "host" as const, id, label: hostName(id), to: id, state: hosts.find((host) => host.id === id)?.isOnline === false ? "离线" : "" })),
    ];
  };

  /** 小闪电：这条线路每层第一个候选连起来，逐段测。 */
  const testLine = (line: RouteLine) => {
    if (!entryHostId) return;
    const hops: number[] = [];
    const hopVia: Array<number | null> = [];
    for (const layer of line.layers) {
      const first = candidatesOf(layer).find((candidate) => candidate.to > 0 && !hops.includes(candidate.to));
      if (first) { hops.push(first.to); hopVia.push(first.kind === "tunnel" ? first.id : null); }
    }
    const destCandidate = line.dests[0] || null;
    const dest = destCandidate?.dest || (() => {
      const parsed = parseFailoverEndpoint(mainAddress);
      return parsed && !("error" in parsed) ? { ip: parsed.host, port: parsed.port } : null;
    })();
    test(line.key, { entryHostId, hops, hopVia, dest });
  };

  const mainHopIds = new Set(lines[0]?.layers.flatMap((layer) => layer.hostIds) || []);
  // 「经 X」的建议：不是入口、不是入口前面那台、在线、主线路里没用；中转池里的排前面
  // 能当中转的池（只当落地用的不出现在选中转的菜单里）
  const relayPools = pools.filter((pool) => pool.role !== "landing");
  const relayPoolHostIds = new Set(relayPools.flatMap((pool) => pool.members.map((member) => member.hostId)));
  const quickHosts = hosts
    .filter((host) => host.id !== entryHostId && !upstreamHostIds.includes(host.id) && host.isOnline !== false && !mainHopIds.has(host.id))
    .sort((left, right) => Number(relayPoolHostIds.has(right.id)) - Number(relayPoolHostIds.has(left.id)))
    .slice(0, 5);
  /** 加一条备用（落地和主线路一样）；open = 加完直接展开它，接着挑中转、落地。 */
  const addBackup = (layers: RouteLayer[], open = false) => {
    if (lines.length >= MAX_ROUTE_PATHS) return;
    const line = newRouteLine(lines.length, { name: defaultRoutePathName(lines.length), layers, dests: lines[0]?.dests || [] });
    onChange([...lines, line]);
    if (open) setOpenKey(line.key);
  };

  /** 一条线路此刻怎么走（每层挑中的那个）：Po0 → jinx(39.9y) → 落地。（收起那一行就这样写，并列的框只在展开后画） */
  const lineText = (line: RouteLine) => {
    const parts = [entryName];
    for (const layer of line.layers) {
      const candidates = candidatesOf(layer);
      if (layer.kind === "pool") parts.push(pools.find((pool) => pool.id === layer.poolId)?.name || "节点池");
      else if (candidates[0]) parts.push(candidates[0].kind === "tunnel" ? `隧道 ${hostName(candidates[0].to)}` : candidates[0].label);
      if (candidates.length > 1 && layer.kind !== "pool") parts[parts.length - 1] += ` 等 ${candidates.length} 个`;
    }
    parts.push(destText(line));
    return parts.join(" → ");
  };
  /** 一行里落地怎么写：选了落地池（或者规则目标就是池）写池名，别的写「落地」。 */
  const destText = (line: RouteLine) => {
    const nodeId = line.dests[0]?.destNodeId || (line.dests.length === 0 ? ruleTargetNodeId : null);
    const node = nodeId ? nodeOptions.find((option) => option.id === nodeId) : null;
    return node?.landingPool ? node.name : "落地";
  };

  const testButton = (line: RouteLine, lineIndex: number) => (
    <LineChipButton
      className="shrink-0"
      aria-label={`逐段测一下${lineIndex === 0 ? "主线路" : `备 ${lineIndex}`}`}
      title="逐段测延迟：每一段的毫秒写在节点后面"
      disabled={!entryHostId || testingKey !== null}
      onClick={() => testLine(line)}
      data-testid="route-line-test"
    >
      <LineZapGlyph className={cn("h-3 w-3", testingKey === line.key && "animate-pulse text-[var(--fx-accent)]")} />
      {testingKey === line.key ? "测着…" : "测一下"}
    </LineChipButton>
  );

  const addHopMenu = (lineIndex: number, previousHost: number, label: string) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <LineChipButton variant="add" data-testid="route-line-add-layer">{label}</LineChipButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {/* 加中转只加一台（或一条隧道）：要一组就加完再「+ 并列」，或者在「+ 并列」里换成节点池 */}
        {allowTunnels && tunnels.some((tunnel) => tunnel.entryHostId === previousHost) ? <DropdownMenuLabel className="text-[11px]">隧道（从上一个节点出发）</DropdownMenuLabel> : null}
        {allowTunnels ? tunnels.filter((tunnel) => tunnel.entryHostId === previousHost).map((tunnel) => (
          <DropdownMenuItem key={`t${tunnel.id}`} onSelect={() => addLayer(lineIndex, newRouteLayer({ kind: "tunnel", tunnelIds: [tunnel.id] }))}>{tunnel.name} → {hostName(tunnel.exitHostId)}</DropdownMenuItem>
        )) : null}
        {allowTunnels && tunnels.some((tunnel) => tunnel.entryHostId === previousHost) ? <DropdownMenuSeparator /> : null}
        <DropdownMenuLabel className="text-[11px]">机器</DropdownMenuLabel>
        {hosts.filter((host) => host.id !== entryHostId).map((host) => (
          <DropdownMenuItem key={`h${host.id}`} onSelect={() => addLayer(lineIndex, newRouteLayer({ kind: "hosts", hostIds: [host.id] }))}>{host.name}{host.isOnline === false ? "（离线）" : ""}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  /**
   * 链上的一个点：左边圆点（竖线把它们串起来）、名字（入口 / 中转 / 落地），右边内容。
   * 入口是空心点，中转是描边点，落地是实心点 —— 一眼看出从哪儿、经哪儿、到哪儿。
   */
  const chainNode = (label: string, kind: "start" | "hop" | "end", children: ReactNode, key?: string) => (
    <div key={key} className="relative grid min-w-0 grid-cols-[11px_34px_minmax(0,1fr)] items-start gap-x-2" data-testid="route-line-node">
      <span
        aria-hidden
        className={cn(
          // 圆点排在竖线后面，同是定位元素、后画的盖在上面：不用 z-index
          "relative mt-[6px] h-[11px] w-[11px] rounded-full border-2 bg-[var(--fx-l1-surface)]",
          kind === "start" ? "border-[var(--fx-stroke)]" : kind === "end" ? "border-[var(--fx-accent)] bg-[var(--fx-accent)]" : "border-[var(--fx-accent)]",
        )}
      />
      <span className="pt-[3px] text-[12px] text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-col">{children}</div>
    </div>
  );

  /** 一条线路展开后的样子：入口 ● → 中转 ● → 落地 ●，一条竖线串起来；「+ 加中转」就在最后一个中转和落地之间。 */
  const renderLayers = (line: RouteLine, lineIndex: number) => {
    let previousHost = entryHostId || 0;
    return (
      <div className="relative mt-[10px] flex min-w-0 flex-col gap-[8px] text-[12.5px]" data-testid="route-line-chain">
        <span aria-hidden className="pointer-events-none absolute bottom-[12px] left-[5px] top-[12px] w-px bg-[var(--fx-stroke)]" />
        {chainNode("入口", "start", (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {entryPrefix ? <span className="text-[11px] text-muted-foreground">{entryPrefix}</span> : null}
            <LineChip>{entryName}</LineChip>
          </div>
        ))}
        {line.layers.map((layer, layerIndex) => {
          const from = previousHost;
          const candidates = candidatesOf(layer);
          const measured = candidates.map((candidate) => latencyOf(segmentKey(from, candidate.to)));
          // 「最低延迟」时测过的里最快的那个高亮；按顺序（或者都没测）是第一个。
          let chosen = 0;
          if (layer.pick === "best") {
            let best = Number.POSITIVE_INFINITY;
            measured.forEach((value, index) => { if (typeof value === "number" && value < best) { best = value; chosen = index; } });
          }
          if (candidates[chosen]?.to) previousHost = candidates[chosen].to;
          const pool = layer.kind === "pool" ? pools.find((item) => item.id === layer.poolId) : null;
          const total = layer.tunnelIds.length + layer.hostIds.length;
          const addableHosts = hosts.filter((host) => host.id !== entryHostId && !layer.hostIds.includes(host.id));
          const addableTunnels = allowTunnels ? tunnels.filter((tunnel) => tunnel.entryHostId === from && !layer.tunnelIds.includes(tunnel.id)) : [];
          const canAddCandidate = total < MAX_LAYER_CANDIDATES && (addableHosts.length > 0 || addableTunnels.length > 0);
          const label = line.layers.length > 1 ? `中转 ${layerIndex + 1}` : "中转";
          const removeCandidate = (candidate: Candidate) => {
            const tunnelIds = candidate.kind === "tunnel" ? layer.tunnelIds.filter((id) => id !== candidate.id) : layer.tunnelIds;
            const hostIds = candidate.kind === "host" ? layer.hostIds.filter((id) => id !== candidate.id) : layer.hostIds;
            if (tunnelIds.length + hostIds.length === 0) removeLayer(lineIndex, layerIndex);
            else setLayer(lineIndex, layerIndex, { tunnelIds, hostIds, kind: hostIds.length > 0 ? "hosts" : "tunnel" });
          };
          const moveFirst = (candidate: Candidate) => {
            if (candidate.kind === "tunnel") setLayer(lineIndex, layerIndex, { tunnelIds: [candidate.id, ...layer.tunnelIds.filter((id) => id !== candidate.id)] });
            else setLayer(lineIndex, layerIndex, { hostIds: [candidate.id, ...layer.hostIds.filter((id) => id !== candidate.id)] });
          };
          // 怎么挑（两个以上候选、或者一个池才有）
          const pickMenu = (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                {/* 小下拉而不是 Select：手机上 Select 被统一撑到 34px / 15px，这里只占一行小字 */}
                <button type="button" className="inline-flex items-center gap-1 rounded-[8px] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] px-2 py-[3px] text-[11.5px] leading-[1.3] text-foreground" aria-label={`${label}怎么挑`}>
                  {layer.pick === "order" ? "按顺序" : "最低延迟"}
                  <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => setLayer(lineIndex, layerIndex, { pick: "best" })}>最低延迟（整条链最快的那个）</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setLayer(lineIndex, layerIndex, { pick: "order" })}>按顺序（前面的坏了才用后面的）</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
          const skipChip = layer.skippable ? (
            <LineChipButton
              onClick={() => setLayer(lineIndex, layerIndex, { skippable: false })}
              title="这一跳全坏了就直连下一跳（老配置里勾的）；点一下取消，要绕开它就加一条不经它的备用线路"
              aria-label={`${label}可跳过，点一下取消`}
            >
              可跳过<X className="h-3 w-3" aria-hidden="true" />
            </LineChipButton>
          ) : null;
          const poolKey = `${line.key}:${layerIndex}`;
          const poolOpen = openPools.has(poolKey);
          const picked = candidates[chosen];

          if (pool) {
            /*
              节点池这一跳：平时一个「池 · 名字 · N 台」，旁边小字写挑中的那台；点开是一列，池里每台一行
              （状态、毫秒，挑中的高亮）—— 一眼分得清哪几台是池里的（以前池里的机器和别的候选混在一排 chip 里）。
              怎么挑、换别的池、去掉这一跳收在展开框底下。
            */
            return chainNode(label, "hop", (
              <>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="route-line-layer">
                  <LineChipButton variant="sel" aria-expanded={poolOpen} onClick={() => togglePool(poolKey)} title={poolOpen ? "收起" : "看池里有哪几台"} data-testid="route-line-pool">
                    <span className="truncate">池 · {pool.name} · {candidates.length} 台</span>
                    <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", poolOpen && "rotate-180")} aria-hidden="true" />
                  </LineChipButton>
                  {!poolOpen && picked ? (
                    <span className="inline-flex min-w-0 items-center gap-1 text-[11.5px] text-muted-foreground">
                      <span className="truncate">{layer.pick === "order" ? "先用" : "最快"} {picked.label}</span>
                      <LineMs value={measured[chosen]} />
                    </span>
                  ) : null}
                  {skipChip}
                </div>
                {poolOpen ? (
                  <div className="mt-1.5 rounded-[10px] border border-[var(--fx-stroke-weak)] px-2.5 py-1" data-testid="route-line-pool-members">
                    {candidates.length === 0 ? <p className="py-1 text-[11.5px] text-muted-foreground">池里还没有机器：到「节点池」页加</p> : null}
                    {candidates.map((candidate, index) => (
                      <div key={`${candidate.kind}${candidate.id}`} className="flex min-w-0 items-center gap-2 py-[4px] text-[12.5px]">
                        <LineDot tone={candidate.state === "维护" ? "warn" : candidate.state ? "down" : "ok"} />
                        <span className={cn("min-w-0 flex-1 truncate", index === chosen ? "font-semibold text-[var(--fx-accent)]" : "text-foreground")}>{candidate.label}</span>
                        {candidate.state ? <span className="shrink-0 text-[11px] text-[var(--fx-warn-text)]">{candidate.state}</span> : <LineMs value={measured[index]} />}
                      </div>
                    ))}
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-3 border-t border-dashed border-[var(--fx-stroke-weak)] py-1.5 text-[11.5px] text-muted-foreground">
                      {pickMenu}
                      {relayPools.length > 1 ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button type="button" className="inline-flex items-center gap-0.5 hover:text-foreground">换别的池<ChevronDown className="h-3 w-3" aria-hidden="true" /></button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start">
                            {relayPools.filter((item) => item.id !== pool.id).map((item) => (
                              <DropdownMenuItem key={`swap${item.id}`} onSelect={() => replaceLayer(lineIndex, layerIndex, newRouteLayer({ kind: "pool", poolId: item.id, pick: layer.pick }))}>{item.name} · {item.members.length} 台</DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                      <button type="button" className="text-[var(--fx-down-text)] hover:underline" onClick={() => removeLayer(lineIndex, layerIndex)}>去掉这一跳</button>
                    </div>
                  </div>
                ) : null}
              </>
            ), `layer-${layerIndex}`);
          }

          /*
            并列的几台放进一个胶囊：「隧道 Jinx 0.8 / jinx(39.9y) 1.0」—— 一个胶囊就是这一跳挑一台（挑中的那台加粗），
            竖链上的点是一跳接一跳，「并」和「串」一眼分开（用户给的写法）。只有一台时就是普通的胶囊。点胶囊里某一台：
            排到最前 / 去掉。「+ 并列」再放一台，或者把这一跳换成节点池（池就是一组现成的并列机器）。
          */
          const grouped = candidates.length > 1;
          const candidateMenu = (candidate: Candidate, index: number) => (
            <DropdownMenuContent align="start" className="w-56">
              {index > 0 && layer.pick === "order" ? <DropdownMenuItem onSelect={() => moveFirst(candidate)}>排到最前</DropdownMenuItem> : null}
              <DropdownMenuItem onSelect={() => removeCandidate(candidate)}>去掉 {candidate.label}</DropdownMenuItem>
            </DropdownMenuContent>
          );
          const candidateBody = (candidate: Candidate, index: number) => (
            <>
              <span className="truncate">{candidate.label}</span>
              {candidate.state ? <span className="text-[10.5px] font-normal text-[var(--fx-warn-text)]">{candidate.state}</span> : null}
              <LineMs value={measured[index]} />
            </>
          );
          return chainNode(label, "hop", (
            <>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="route-line-layer">
                  {grouped ? (
                    <div className="inline-flex min-w-0 max-w-full flex-wrap items-center rounded-[12px] border border-[var(--fx-accent)] bg-[var(--fx-accent-soft)] px-[3px] py-[1px]" data-grouped="true">
                      {candidates.map((candidate, index) => (
                        <Fragment key={`${candidate.kind}${candidate.id}`}>
                          {index > 0 ? <span aria-hidden className="px-[1px] text-[11.5px] text-muted-foreground">/</span> : null}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                title={candidate.hint}
                                className={cn(
                                  "inline-flex min-w-0 items-center gap-[5px] whitespace-nowrap rounded-full px-[6px] py-[2px] text-[11.5px] leading-[1.3]",
                                  index === chosen ? "font-semibold text-[var(--fx-accent)]" : "text-foreground",
                                )}
                              >
                                {candidateBody(candidate, index)}
                              </button>
                            </DropdownMenuTrigger>
                            {candidateMenu(candidate, index)}
                          </DropdownMenu>
                        </Fragment>
                      ))}
                    </div>
                  ) : candidates.map((candidate, index) => (
                    <DropdownMenu key={`${candidate.kind}${candidate.id}`}>
                      <DropdownMenuTrigger asChild>
                        <LineChipButton variant="sel" title={candidate.hint}>{candidateBody(candidate, index)}</LineChipButton>
                      </DropdownMenuTrigger>
                      {candidateMenu(candidate, index)}
                    </DropdownMenu>
                  ))}
                  {canAddCandidate || relayPools.length > 0 ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <LineChipButton variant="add" aria-label={`${label}再并列一个`} title="这一跳再并列一台机器、一条隧道，或者换成节点池：几个里自动挑整条链最快的" data-testid="route-line-add-candidate">+ 并列</LineChipButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                        {relayPools.length > 0 ? <DropdownMenuLabel className="text-[11px]">换成节点池（池里挑最快的）</DropdownMenuLabel> : null}
                        {relayPools.map((item) => (
                          <DropdownMenuItem key={`p${item.id}`} onSelect={() => replaceLayer(lineIndex, layerIndex, newRouteLayer({ kind: "pool", poolId: item.id, pick: layer.pick }))}>{item.name} · {item.members.length} 台</DropdownMenuItem>
                        ))}
                        {relayPools.length > 0 && canAddCandidate ? <DropdownMenuSeparator /> : null}
                        {canAddCandidate && addableTunnels.length > 0 ? <DropdownMenuLabel className="text-[11px]">并列一条隧道（从上一个节点出发）</DropdownMenuLabel> : null}
                        {(canAddCandidate ? addableTunnels : []).map((tunnel) => (
                          <DropdownMenuItem key={`t${tunnel.id}`} onSelect={() => setLayer(lineIndex, layerIndex, { tunnelIds: [...layer.tunnelIds, tunnel.id] })}>{tunnel.name} → {hostName(tunnel.exitHostId)}</DropdownMenuItem>
                        ))}
                        {canAddCandidate && addableTunnels.length > 0 && addableHosts.length > 0 ? <DropdownMenuSeparator /> : null}
                        {canAddCandidate && addableHosts.length > 0 ? <DropdownMenuLabel className="text-[11px]">并列一台机器</DropdownMenuLabel> : null}
                        {(canAddCandidate ? addableHosts : []).map((host) => (
                          <DropdownMenuItem key={`h${host.id}`} onSelect={() => setLayer(lineIndex, layerIndex, { hostIds: [...layer.hostIds, host.id], kind: "hosts" })}>{host.name}{host.isOnline === false ? "（离线）" : ""}</DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                {grouped || layer.skippable ? (
                  <div className="mt-[6px] flex min-w-0 flex-wrap items-center gap-[10px]">
                    {grouped ? pickMenu : null}
                    {skipChip}
                  </div>
                ) : null}
            </>
          ), `layer-${layerIndex}`);
        })}
        {/* 「+ 加中转」在链上：最后一个中转和落地之间（没有中转时就在入口和落地之间，前面写一句「直连」） */}
        {allowHops && line.layers.length < MAX_ROUTE_HOPS ? (
          <div className="relative grid min-w-0 grid-cols-[11px_34px_minmax(0,1fr)] items-center gap-x-2">
            <span aria-hidden />
            <span aria-hidden />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {line.layers.length === 0 ? <span className="text-[12px] text-muted-foreground">入口直连落地</span> : null}
              {addHopMenu(lineIndex, previousHost, "+ 加中转")}
            </div>
          </div>
        ) : null}
        {chainNode("落地", "end", (
          <DestEditor
            line={line}
            mainAddress={mainAddress}
            nodeOptions={nodeOptions}
            pools={pools}
            hostName={hostName}
            ruleTargetNodeId={ruleTargetNodeId}
            latency={latencyOf(segmentKey(previousHost, "dest"))}
            onChange={(dests) => setLine(lineIndex, { dests })}
          />
        ))}
      </div>
    );
  };

  /** 一条线路：收着是一行（主 / 备 N、路径、状态），点开下面接着它的编辑块。 */
  const lineBlock = (line: RouteLine, lineIndex: number, handle: ReactNode) => {
    const isMain = lineIndex === 0;
    const open = openKey === line.key;
    const lineStatus = renderLineStatus?.(line, lineIndex) ?? null;
    const badge = isMain ? "主" : `备 ${lineIndex}`;
    return (
      <>
        <LineRow on={line.key === activeLineKey && !open} className={cn(open && "rounded-b-none border-b-transparent")}>
          {handle}
          <LineBadge main={isMain}>{badge}</LineBadge>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center text-left"
            aria-expanded={open}
            aria-label={`${open ? "收起" : "展开改"}${isMain ? "主线路" : badge}：${lineText(line)}`}
            onClick={() => setOpenKey(open ? null : line.key)}
            title={open ? "收起" : "点一下展开：改这条、测一下"}
            data-testid="route-line-open"
          >
            <LinePath bad={line.paused}>{lineText(line)}</LinePath>
          </button>
          {lineStatus}
          {lineStatus || isMain ? null : (
            <Checkbox checked={!line.paused} onCheckedChange={(checked) => setLine(lineIndex, { paused: !checked })} aria-label={`备 ${lineIndex} 参与切换`} title="勾掉 = 暂停这条，保存后生效" />
          )}
        </LineRow>
        {open ? (
          <div className="rounded-b-[12px] border border-t-0 border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] px-[10px] pb-[10px]">
            {/* 名字像标题一样摆着，点一下就能改（以前是一整个输入框，太重）；右边测一下、删除 */}
            <div className="flex min-w-0 items-center gap-2 border-t border-dashed border-[var(--fx-stroke-weak)] pt-2">
              <input
                value={line.name}
                onChange={(event) => setLine(lineIndex, { name: event.target.value.slice(0, 40) })}
                placeholder={isMain ? "主线路" : defaultRoutePathName(lineIndex)}
                aria-label={isMain ? "主线路的名字" : `备 ${lineIndex} 的名字`}
                title="点一下改名字"
                className="min-w-0 flex-1 rounded-[6px] bg-transparent px-1 py-[3px] text-[13px] font-semibold outline-none hover:bg-[var(--fx-l2-group)] focus:bg-[var(--fx-l2-group)]"
              />
              {testButton(line, lineIndex)}
              {isMain ? null : (
                <button
                  type="button"
                  className="shrink-0 px-1 text-[11.5px] text-[var(--fx-down-text)] hover:underline"
                  onClick={() => { onChange(lines.filter((_, index) => index !== lineIndex)); setOpenKey(null); }}
                >
                  删除
                </button>
              )}
            </div>
            {renderLayers(line, lineIndex)}
          </div>
        ) : null}
      </>
    );
  };

  const main = lines[0];

  return (
    <section className="fx-line-ui flex min-w-0 flex-col" aria-label="线路" data-testid="route-lines">
      {/*
        主线路和备用一样收成一行（2.3.498）：主 / 备 N、整条链怎么走、此刻的状态和暂停；整行点一下展开来改，
        名字、⚡（逐段测）、中转、落地都在展开的那块里。主线路排第一、不能拖、不能删。
      */}
      {main ? <div data-testid="route-line">{lineBlock(main, 0, null)}</div> : null}
      {backups.length === 0 ? (
        <p className="mx-1 mt-[7px] text-[11.5px] text-muted-foreground">
          {/* 主线路自己就展开成好几条（落地池的几台、一层里几个候选）：坏了在它们之间切，只是没有另一条路 */}
          {main && previewPaths.filter((path) => path.lineKey === main.key).length > 1
            ? `主线路在 ${previewPaths.filter((path) => path.lineKey === main.key).length} 条路径里切；想再多一层保险，加一条经别的机器或别的落地的备用。`
            : "还没有备用：主线路坏了没处可切。加一条经别的机器、别的隧道或别的落地的。"}
        </p>
      ) : null}
      <SortableReorderContext sortable={sortable} strategy="vertical" restrictToList>
        <div className="mt-[7px] flex flex-col gap-[7px]">
          {backups.map((line, position) => {
            const lineIndex = position + 1;
            return (
              <SortableItem key={line.key} id={line.key}>
                {({ itemProps, handleProps: { ref: handleRef, ...handleProps } }) => (
                  <div {...itemProps} data-testid="route-line">
                    {lineBlock(line, lineIndex, arrange ? (
                      <button
                        type="button"
                        ref={handleRef as Ref<HTMLButtonElement>}
                        {...handleProps}
                        className="fx-compact-touch -ml-0.5 shrink-0 cursor-grab touch-none px-0.5 text-[14px] leading-none tracking-[-2px] text-muted-foreground/50 active:cursor-grabbing"
                        aria-label={`拖动备 ${lineIndex} 排序`}
                        title="拖动排序"
                      >
                        ⋮⋮
                      </button>
                    ) : null)}
                  </div>
                )}
              </SortableItem>
            );
          })}
        </div>
      </SortableReorderContext>
      {/*
        加备用线路：一个按钮一个菜单。以前是「+ 添加备用」后面跟一排「经 X」「直连落地」小块，
        一换行就是两行按钮，也看不出它们是在加备用。
      */}
      {/* 线路详情里收在「线路」标题的下拉里；一条备用都没有时照样出（上面那句提示要能点得到） */}
      {arrange || backups.length === 0 ? <div className="mb-1 mt-[9px] flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <LineChipButton variant="add" disabled={lines.length >= MAX_ROUTE_PATHS} data-testid="route-line-add">
              {lines.length >= MAX_ROUTE_PATHS ? `最多 ${MAX_ROUTE_PATHS} 条` : "+ 添加备用线路"}
            </LineChipButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            <DropdownMenuItem onSelect={() => addBackup([], true)}>空白的，加完展开自己挑中转和落地</DropdownMenuItem>
            {allowHops && (main?.layers.length || 0) > 0 ? (
              <DropdownMenuItem onSelect={() => addBackup([])}>入口直连落地（不经中转）</DropdownMenuItem>
            ) : null}
            {allowHops && quickHosts.length > 0 ? (<><DropdownMenuSeparator /><DropdownMenuLabel className="text-[11px]">经一台中转</DropdownMenuLabel></>) : null}
            {allowHops ? quickHosts.map((host) => (
              <DropdownMenuItem key={host.id} onSelect={() => addBackup([newRouteLayer({ kind: "hosts", hostIds: [host.id] })])}>经 {host.name}</DropdownMenuItem>
            )) : null}
            {allowHops && pools.length > 0 ? (<><DropdownMenuSeparator /><DropdownMenuLabel className="text-[11px]">经一个节点池（池里挑最快的）</DropdownMenuLabel></>) : null}
            {allowHops ? pools.filter((pool) => pool.role !== "landing").map((pool) => (
              <DropdownMenuItem key={`p${pool.id}`} onSelect={() => addBackup([newRouteLayer({ kind: "pool", poolId: pool.id })])}>经 {pool.name} · {pool.members.length} 台</DropdownMenuItem>
            )) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div> : null}
      {lastRun && lastRun.totalMs !== null ? (
        <p className="mx-1 mt-1 text-[11.5px] text-muted-foreground" data-testid="route-line-test-total">
          刚测的这条整链约 <b className="font-mono text-foreground">{Math.round(lastRun.totalMs)} ms</b>
          {lastRun.viaTunnel ? "（隧道段按两头机器直连测）" : ""}
        </p>
      ) : null}
      {(lastRun?.errors || []).map((item, index) => (
        <p key={index} className="mx-1 text-[11.5px] text-[var(--fx-warn-text)]">{item.from} → {item.to}：{describeRouteIssue(item.error)}</p>
      ))}
      {!allowHops ? <p className="mx-1 mt-1 text-[11.5px] text-muted-foreground">转发组上的规则暂不支持经过中转。</p> : null}
    </section>
  );
}

function DestEditor({ line, mainAddress, nodeOptions, pools = [], hostName = (id) => `主机 ${id}`, ruleTargetNodeId = null, latency, onChange }: {
  line: RouteLine;
  mainAddress: string;
  nodeOptions: RouteLineNode[];
  ruleTargetNodeId?: number | null;
  /** 落地池的成员（落地选了池节点时，chip 的菜单里列出池里开着的几台）。 */
  pools?: RouteLinePool[];
  hostName?: (hostId: number) => string;
  latency: number | null | undefined;
  onChange: (dests: RouteLine["dests"]) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dests = line.dests.length > 0 ? line.dests : [{ dest: null, destNodeId: null }];
  const label = (item: RouteLine["dests"][number]) => {
    if (item.destNodeId) {
      const node = nodeOptions.find((option) => option.id === item.destNodeId);
      return node ? routeNodeOptionLabel(node) : `节点 #${item.destNodeId}`;
    }
    if (item.dest) return formatFailoverEndpoint(item.dest.ip, item.dest.port);
    // 规则目标是落地池的池节点：写池，不写首选那一台的地址（实际在池里几台分）
    const target = ruleTargetNodeId ? nodeOptions.find((option) => option.id === ruleTargetNodeId) : null;
    if (target?.landingPool) return routeNodeOptionLabel(target);
    return mainAddress || "规则目标";
  };
  // 落地池（2.3.500）单列一组：选了就是在池里几台分，坏了切
  const poolNodes = nodeOptions.filter((node) => !!node.landingPool);
  const plainNodes = nodeOptions.filter((node) => !node.landingPool);
  const commit = () => {
    const text = draft.replace(/\s+/g, "");
    if (!text) { setTyping(false); return; }
    const parsed = parseFailoverEndpoint(text);
    if (!parsed || "error" in parsed) {
      setError("格式是 地址:端口");
      return;
    }
    setError(null);
    setDraft("");
    setTyping(false);
    const next = line.dests.length > 0 ? line.dests : [];
    if (next.length >= MAX_LINE_DESTS) return;
    onChange([...next, { dest: { ip: parsed.host, port: parsed.port }, destNodeId: null }]);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {dests.map((item, index) => (
          line.dests.length > 0 ? (
            <DropdownMenu key={index}>
              <DropdownMenuTrigger asChild>
                <LineChipButton variant={index === 0 ? "sel" : "default"} data-testid="route-line-dest">
                  <span className="truncate">{label(item)}</span>
                  {index === 0 ? <LineMs value={latency} /> : null}
                </LineChipButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {(() => {
                  // 落地池：列出池里开着的几台（一台一条路径，在这几台里分 / 坏了切）
                  const node = item.destNodeId ? nodeOptions.find((option) => option.id === item.destNodeId) : null;
                  const pool = node?.landingPool ? pools.find((entry) => entry.id === node.landingPool!.id) : null;
                  if (!node?.landingPool) return null;
                  const members = pool?.landingMembers || [];
                  return (
                    <>
                      <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground" data-testid="route-line-dest-pool-members">
                        {members.length > 0 ? `在这 ${members.length} 台里分：${members.map(hostName).join("、")}` : "池里还没有开着的机器"}
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                    </>
                  );
                })()}
                <DropdownMenuItem onSelect={() => onChange(line.dests.filter((_, position) => position !== index))}>
                  {line.dests.length === 1 ? "改回规则目标" : `去掉 ${label(item)}`}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <LineChip key={index} variant="sel" title="规则自己的目标" data-testid="route-line-dest">
              <span className="truncate">{label(item)}</span>
              <LineMs value={latency} />
            </LineChip>
          )
        ))}
        {dests.length < MAX_LINE_DESTS || line.dests.length === 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <LineChipButton
                variant="add"
                data-testid="route-line-dest-add"
                title={line.dests.length === 0 ? "换一个落地：选我的节点，或填 IP:端口" : "同一个落地位置再并列一个：几个里挑最快的"}
              >
                {line.dests.length === 0 ? "换落地" : "+ 并列"}
              </LineChipButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
              {poolNodes.length > 0 ? <DropdownMenuLabel className="text-[11px]">落地池</DropdownMenuLabel> : null}
              {poolNodes.map((node) => (
                <DropdownMenuItem key={node.id} data-testid="route-line-dest-pool" onSelect={() => onChange([...line.dests, { dest: null, destNodeId: node.id }].slice(0, MAX_LINE_DESTS))}>
                  <span className="min-w-0 truncate">{node.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{node.landingPool!.ready}/{node.landingPool!.members} 台</span>
                </DropdownMenuItem>
              ))}
              {poolNodes.length > 0 && plainNodes.length > 0 ? <DropdownMenuSeparator /> : null}
              {plainNodes.length > 0 ? <DropdownMenuLabel className="text-[11px]">我的节点</DropdownMenuLabel> : null}
              {plainNodes.map((node) => (
                <DropdownMenuItem key={node.id} onSelect={() => onChange([...line.dests, { dest: { ip: node.address, port: node.port }, destNodeId: node.id }].slice(0, MAX_LINE_DESTS))}>
                  {node.name} · {node.address}:{node.port}
                </DropdownMenuItem>
              ))}
              {nodeOptions.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={() => setTyping(true)}>填 IP:端口…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {typing ? (
        <Input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); commit(); }
            if (event.key === "Escape") { event.preventDefault(); setTyping(false); setDraft(""); setError(null); }
          }}
          placeholder="落地地址：IP:端口"
          aria-label="落地地址"
          className="h-7 min-w-0 font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
      ) : null}
      {error ? <p className="text-[11.5px] text-[var(--fx-warn-text)]">{error}</p> : null}
    </div>
  );
}

/** 编辑框的预览：按同一套函数展开（没有实测延迟，顺序按写的来）。 */
type PreviewContext = {
  entryHostId: number | null;
  pools: RouteLinePool[];
  tunnels: RouteLineTunnel[];
  /** 节点选项（落地池的池节点带着池）：落地选了池节点，预览也按池里开着的几台展开。 */
  nodes?: RouteLineNode[];
  /** 规则目标绑着的节点（是池节点时「规则目标」就是这个池）。 */
  ruleTargetNodeId?: number | null;
};

export function useRouteLinesPreview(lines: RouteLine[] | null | undefined, context: PreviewContext) {
  return useMemo(() => {
    if (!lines || lines.length === 0) return { paths: [] as RoutePath[], issues: new Map<string, string>() };
    return expandForPreview(lines, context);
  }, [lines, context.entryHostId, context.pools, context.tunnels, context.nodes, context.ruleTargetNodeId]);
}

export function expandForPreview(lines: RouteLine[], context: PreviewContext) {
  return expandRouteLines(lines, {
    entryHostId: context.entryHostId,
    ruleTargetNodeId: context.ruleTargetNodeId ?? null,
    landingPool: (nodeId) => {
      const node = context.nodes?.find((item) => item.id === nodeId);
      if (!node?.landingPool) return null;
      const pool = context.pools.find((item) => item.id === node.landingPool!.id);
      return { poolId: node.landingPool.id, name: node.landingPool.name, members: (pool?.landingMembers || []).map((hostId) => ({ hostId, dest: null })) };
    },
    poolMembers: (poolId) => context.pools.find((pool) => pool.id === poolId)?.members.map((member) => member.hostId) ?? null,
    hostUsable: () => true,
    tunnel: (tunnelId) => {
      const tunnel = context.tunnels.find((item) => item.id === tunnelId);
      return tunnel ? { id: tunnel.id, entryHostId: tunnel.entryHostId, exitHostId: tunnel.exitHostId, name: tunnel.name, usable: true } : null;
    },
  });
}
