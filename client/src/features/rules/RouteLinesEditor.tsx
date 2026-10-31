import { useMemo, useState, type ReactNode, type Ref } from "react";
import { ChevronDown, X } from "lucide-react";

import { SortableItem, SortableReorderContext, useSortableReorder } from "@/components/SortableDragHandle";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  LineBadge,
  LineChip,
  LineChipButton,
  LineIconButton,
  LineMs,
  LinePath,
  LineRow,
  LineZapGlyph,
} from "@/features/lines/LineUi";
import { cn } from "@/lib/utils";
import { formatFailoverEndpoint, parseFailoverEndpoint } from "@shared/failoverTargets";
import { MAX_ROUTE_HOPS, MAX_ROUTE_PATHS, defaultRoutePathName, describeRouteIssue, type RoutePath } from "@shared/routeGroup";
import { MAX_LAYER_CANDIDATES, MAX_LINE_DESTS, expandRouteLines, newRouteLayer, newRouteLine, type RouteLayer, type RouteLine } from "@shared/routeLines";
import { segmentKey, useSegmentLatency } from "./segmentLatency";

/*
  编辑线路组（2.3.496，照效果图 ②「编辑：主线路 + 有序备用」）：

    主线路一张卡：入口 / 中转（几跳就几行：中转 1、中转 2…）/ 落地。一跳里可以放几个候选（机器、隧道混着放，
    或者一个节点池），有两个以上才出「最低延迟 / 按顺序」——只有一个时没得挑（2.3.498）。两个加号分开叫：
    「+ 并列」是同一跳再放一个（或把这一跳换成节点池），「+ 后面再接中转」在最后一跳下面，串下一跳。「可跳过」（这一跳全坏了就直连下一跳）不再给勾：和加一条不经它的备用线路是一回事，
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
export type RouteLinePool = { id: number; name: string; role: string; members: Array<{ hostId: number; name: string; online: boolean; maintenance: boolean }> };
export type RouteLineTunnel = { id: number; name: string; entryHostId: number; exitHostId: number; mode?: string | null; relayMode?: string | null };
export type RouteLineNode = { id: number; name: string; address: string; port: number; protocol?: string };

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
}) {
  const hostName = (id: number) => hosts.find((host) => host.id === id)?.name || `主机 ${id}`;
  // 打开就有数（效果图里每个候选后面的毫秒）：最近一轮探测的每一段，点 ⚡ 测出来的盖掉它。
  const { latencyOf, testingKey, test, lastRun } = useSegmentLatency({ ruleId: ruleId ?? null, entryHostId });
  const [openKey, setOpenKey] = useState<string | null>(() => (startCollapsed ? null : lines[0]?.key ?? null));

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

  /** 一条线路此刻怎么走（每层挑中的那个）：Po0 → jinx(39.9y) → 落地。 */
  const lineText = (line: RouteLine) => {
    const parts = [entryName];
    for (const layer of line.layers) {
      const candidates = candidatesOf(layer);
      if (layer.kind === "pool") parts.push(pools.find((pool) => pool.id === layer.poolId)?.name || "节点池");
      else if (candidates[0]) parts.push(candidates[0].kind === "tunnel" ? `隧道 ${hostName(candidates[0].to)}` : candidates[0].label);
      if (candidates.length > 1 && layer.kind !== "pool") parts[parts.length - 1] += ` 等 ${candidates.length} 个`;
    }
    parts.push("落地");
    return parts.join(" → ");
  };

  const testButton = (line: RouteLine, lineIndex: number) => (
    <LineIconButton
      aria-label={`逐段测一下${lineIndex === 0 ? "主线路" : `备 ${lineIndex}`}`}
      title="测一下：逐段测延迟"
      disabled={!entryHostId || testingKey !== null}
      onClick={() => testLine(line)}
      data-testid="route-line-test"
    >
      <LineZapGlyph className={cn(testingKey === line.key && "animate-pulse text-[var(--fx-accent)]")} />
    </LineIconButton>
  );

  const addHopMenu = (lineIndex: number, previousHost: number, label: string) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <LineChipButton variant="add" data-testid="route-line-add-layer">{label}</LineChipButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {/* 节点池放最前：一个池就是这一跳的一组候选，池里加减机器，用它的线路跟着变 */}
        {relayPools.length > 0 ? <DropdownMenuLabel className="text-[11px]">节点池（池里挑最快的）</DropdownMenuLabel> : null}
        {relayPools.map((pool) => (
          <DropdownMenuItem key={`p${pool.id}`} onSelect={() => addLayer(lineIndex, newRouteLayer({ kind: "pool", poolId: pool.id }))}>{pool.name} · {pool.members.length} 台</DropdownMenuItem>
        ))}
        {allowTunnels && tunnels.some((tunnel) => tunnel.entryHostId === previousHost) ? (<><DropdownMenuSeparator /><DropdownMenuLabel className="text-[11px]">隧道（从上一个节点出发）</DropdownMenuLabel></>) : null}
        {allowTunnels ? tunnels.filter((tunnel) => tunnel.entryHostId === previousHost).map((tunnel) => (
          <DropdownMenuItem key={`t${tunnel.id}`} onSelect={() => addLayer(lineIndex, newRouteLayer({ kind: "tunnel", tunnelIds: [tunnel.id] }))}>{tunnel.name} → {hostName(tunnel.exitHostId)}</DropdownMenuItem>
        )) : null}
        {relayPools.length > 0 || (allowTunnels && tunnels.some((tunnel) => tunnel.entryHostId === previousHost)) ? <DropdownMenuSeparator /> : null}
        <DropdownMenuLabel className="text-[11px]">机器</DropdownMenuLabel>
        {hosts.filter((host) => host.id !== entryHostId).map((host) => (
          <DropdownMenuItem key={`h${host.id}`} onSelect={() => addLayer(lineIndex, newRouteLayer({ kind: "hosts", hostIds: [host.id] }))}>{host.name}{host.isOnline === false ? "（离线）" : ""}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  /** 一条线路的全部内容（主线路那张卡、备用点开后）。 */
  const renderLayers = (line: RouteLine, lineIndex: number) => {
    let previousHost = entryHostId || 0;
    return (
      <div className="mt-[10px] grid min-w-0 grid-cols-[44px_minmax(0,1fr)] items-start gap-x-2 gap-y-[6px] text-[12.5px]">
        <span className="pt-[6px] text-[12px] text-muted-foreground">入口</span>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {entryPrefix ? <span className="text-[11px] text-muted-foreground">{entryPrefix}</span> : null}
          <LineChip>{entryName}</LineChip>
        </div>
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
          const last = layerIndex === line.layers.length - 1;
          const canAddCandidate = total < MAX_LAYER_CANDIDATES && (addableHosts.length > 0 || addableTunnels.length > 0);
          const label = line.layers.length > 1 ? `中转 ${layerIndex + 1}` : "中转";
          // 有得挑（两个以上候选、或者一个池）才问怎么挑
          const choosable = !!pool || total > 1;
          const canChain = last && allowHops && line.layers.length < MAX_ROUTE_HOPS;
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
          return (
            <div key={`layer-${layerIndex}`} className="contents">
              <span className="pt-[6px] text-[12px] text-muted-foreground">{label}</span>
              <div className="flex min-w-0 flex-col">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="route-line-layer">
                  {pool ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <LineChipButton variant="sel">池 · {pool.name}</LineChipButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        {relayPools.filter((item) => item.id !== pool.id).map((item) => (
                          <DropdownMenuItem key={`swap${item.id}`} onSelect={() => replaceLayer(lineIndex, layerIndex, newRouteLayer({ kind: "pool", poolId: item.id, pick: layer.pick }))}>换成 {item.name} · {item.members.length} 台</DropdownMenuItem>
                        ))}
                        {relayPools.length > 1 ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuItem onSelect={() => removeLayer(lineIndex, layerIndex)}>去掉这个中转</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                  {candidates.map((candidate, index) => (
                    pool ? (
                      <LineChip key={`${candidate.kind}${candidate.id}`} variant="default">
                        <span className="truncate">{candidate.label}</span>
                        {candidate.state ? <span className="text-[10.5px] text-[var(--fx-warn-text)]">{candidate.state}</span> : null}
                        <LineMs value={measured[index]} />
                      </LineChip>
                    ) : (
                      <DropdownMenu key={`${candidate.kind}${candidate.id}`}>
                        <DropdownMenuTrigger asChild>
                          <LineChipButton variant={index === chosen ? "sel" : "default"} title={candidate.hint}>
                            <span className="truncate">{candidate.label}</span>
                            {candidate.state ? <span className="text-[10.5px] font-normal text-[var(--fx-warn-text)]">{candidate.state}</span> : null}
                            <LineMs value={measured[index]} />
                          </LineChipButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          {index > 0 && layer.pick === "order" ? <DropdownMenuItem onSelect={() => moveFirst(candidate)}>排到最前</DropdownMenuItem> : null}
                          <DropdownMenuItem onSelect={() => removeCandidate(candidate)}>去掉 {candidate.label}</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  ))}
                  {!pool && (canAddCandidate || relayPools.length > 0) ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <LineChipButton variant="add" aria-label={`${label}再并列一个`} title="同一跳再并列一台（或一条隧道、或换成节点池）：几个里自动挑整条链最快的" data-testid="route-line-add-candidate">+ 并列</LineChipButton>
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
                {choosable || layer.skippable || canChain ? (
                  <div className="mt-[6px] flex min-w-0 flex-wrap items-center gap-[10px] text-[11.5px] text-muted-foreground">
                    {/* 小下拉而不是 Select：手机上 Select 被统一撑到 34px / 15px，这里要和效果图一样只占一行小字 */}
                    {choosable ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
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
                    ) : null}
                    {layer.skippable ? (
                      <LineChipButton
                        onClick={() => setLayer(lineIndex, layerIndex, { skippable: false })}
                        title="这一跳全坏了就直连下一跳（老配置里勾的）；点一下取消，要绕开它就加一条不经它的备用线路"
                        aria-label={`${label}可跳过，点一下取消`}
                      >
                        可跳过<X className="h-3 w-3" aria-hidden="true" />
                      </LineChipButton>
                    ) : null}
                    {canChain ? addHopMenu(lineIndex, previousHost, "+ 后面再接中转") : null}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
        {line.layers.length === 0 && allowHops ? (
          <>
            <span className="pt-[6px] text-[12px] text-muted-foreground">中转</span>
            {/* 先说现在是什么（直连），再给加的按钮：以前只有一个虚线的「+ 经过中转」，看不出有没有中转 */}
            <div className="flex min-w-0 flex-wrap items-center gap-2 pt-[3px]">
              <span className="text-[12px] text-muted-foreground">不经中转，入口直连落地</span>
              {addHopMenu(lineIndex, previousHost, "+ 加中转")}
            </div>
          </>
        ) : null}
        <span className="pt-[6px] text-[12px] text-muted-foreground">落地</span>
        <DestEditor
          line={line}
          mainAddress={mainAddress}
          nodeOptions={nodeOptions}
          latency={latencyOf(segmentKey(previousHost, "dest"))}
          onChange={(dests) => setLine(lineIndex, { dests })}
        />
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
            <div className="flex min-w-0 items-center gap-2 border-t border-dashed border-[var(--fx-stroke-weak)] pt-2">
              <Input
                value={line.name}
                onChange={(event) => setLine(lineIndex, { name: event.target.value.slice(0, 40) })}
                placeholder={isMain ? "主线路" : defaultRoutePathName(lineIndex)}
                aria-label={isMain ? "主线路的名字" : `备 ${lineIndex} 的名字`}
                className="h-7 min-w-0 flex-1 text-[12.5px]"
              />
              {testButton(line, lineIndex)}
              {isMain ? null : (
                <button
                  type="button"
                  className="shrink-0 text-[11.5px] text-[var(--fx-down-text)] hover:underline"
                  onClick={() => { onChange(lines.filter((_, index) => index !== lineIndex)); setOpenKey(null); }}
                >
                  删掉这条
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
      {backups.length === 0 ? <p className="mx-1 mt-[7px] text-[11.5px] text-muted-foreground">还没有备用：主线路坏了没处可切。加一条经别的机器、别的隧道或别的落地的。</p> : null}
      <SortableReorderContext sortable={sortable} strategy="vertical" restrictToList>
        <div className="mt-[7px] flex flex-col gap-[7px]">
          {backups.map((line, position) => {
            const lineIndex = position + 1;
            return (
              <SortableItem key={line.key} id={line.key}>
                {({ itemProps, handleProps: { ref: handleRef, ...handleProps } }) => (
                  <div {...itemProps} data-testid="route-line">
                    {lineBlock(line, lineIndex, (
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
                    ))}
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
      <div className="mb-1 mt-[9px] flex flex-wrap items-center gap-1.5">
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
      </div>
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

function DestEditor({ line, mainAddress, nodeOptions, latency, onChange }: {
  line: RouteLine;
  mainAddress: string;
  nodeOptions: RouteLineNode[];
  latency: number | null | undefined;
  onChange: (dests: RouteLine["dests"]) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dests = line.dests.length > 0 ? line.dests : [{ dest: null, destNodeId: null }];
  const label = (item: RouteLine["dests"][number]) => {
    if (item.destNodeId) return nodeOptions.find((node) => node.id === item.destNodeId)?.name || `节点 #${item.destNodeId}`;
    if (item.dest) return formatFailoverEndpoint(item.dest.ip, item.dest.port);
    return mainAddress || "规则目标";
  };
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
              <LineChipButton variant="add" data-testid="route-line-dest-add">+ 选节点</LineChipButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
              {nodeOptions.length > 0 ? <DropdownMenuLabel className="text-[11px]">我的节点</DropdownMenuLabel> : null}
              {nodeOptions.map((node) => (
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
export function useRouteLinesPreview(lines: RouteLine[] | null | undefined, context: { entryHostId: number | null; pools: RouteLinePool[]; tunnels: RouteLineTunnel[] }) {
  return useMemo(() => {
    if (!lines || lines.length === 0) return { paths: [] as RoutePath[], issues: new Map<string, string>() };
    return expandForPreview(lines, context);
  }, [lines, context.entryHostId, context.pools, context.tunnels]);
}

export function expandForPreview(lines: RouteLine[], context: { entryHostId: number | null; pools: RouteLinePool[]; tunnels: RouteLineTunnel[] }) {
  return expandRouteLines(lines, {
    entryHostId: context.entryHostId,
    poolMembers: (poolId) => context.pools.find((pool) => pool.id === poolId)?.members.map((member) => member.hostId) ?? null,
    hostUsable: () => true,
    tunnel: (tunnelId) => {
      const tunnel = context.tunnels.find((item) => item.id === tunnelId);
      return tunnel ? { id: tunnel.id, entryHostId: tunnel.entryHostId, exitHostId: tunnel.exitHostId, name: tunnel.name, usable: true } : null;
    },
  });
}
