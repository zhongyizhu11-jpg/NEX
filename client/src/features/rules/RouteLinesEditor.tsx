import { useMemo, useState, type ReactNode, type Ref } from "react";
import { ChevronDown } from "lucide-react";

import { SortableItem, SortableReorderContext, useSortableReorder } from "@/components/SortableDragHandle";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  LineBadge,
  LineCard,
  LineChip,
  LineChipButton,
  LineIconButton,
  LineMs,
  LinePath,
  LineRow,
  LineSec,
  LineZapGlyph,
} from "@/features/lines/LineUi";
import { cn } from "@/lib/utils";
import { formatFailoverEndpoint, parseFailoverEndpoint } from "@shared/failoverTargets";
import { MAX_ROUTE_HOPS, MAX_ROUTE_PATHS, defaultRoutePathName, describeRouteIssue, type RoutePath } from "@shared/routeGroup";
import { MAX_LAYER_CANDIDATES, MAX_LINE_DESTS, expandRouteLines, newRouteLayer, newRouteLine, type RouteLayer, type RouteLine } from "@shared/routeLines";
import { segmentKey, useSegmentLatency } from "./segmentLatency";

/*
  编辑线路组（2.3.496，照效果图 ②「编辑：主线路 + 有序备用」）：

    主线路一张卡：入口 / 第 N 层 / 落地，一层里几个候选（机器、隧道可以混着放，或者一个节点池），
    按整条链的延迟挑（「最低延迟」）或按顺序；「可跳过」= 这一层全坏了就直连下一层。
    下面是有序的备用：一行一条，拖动排序，点开改；右边小闪电逐段测、勾掉就不参与（线路详情里是状态胶囊和
    立刻生效的暂停，见 renderLineStatus）。
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
}) {
  const hostName = (id: number) => hosts.find((host) => host.id === id)?.name || `主机 ${id}`;
  // 打开就有数（效果图里每个候选后面的毫秒）：最近一轮探测的每一段，点 ⚡ 测出来的盖掉它。
  const { latencyOf, testingKey, test, lastRun } = useSegmentLatency({ ruleId: ruleId ?? null, entryHostId });
  const [openKey, setOpenKey] = useState<string | null>(null);

  const setLine = (index: number, patch: Partial<RouteLine>) => onChange(lines.map((line, position) => (position === index ? { ...line, ...patch } : line)));
  const setLayer = (lineIndex: number, layerIndex: number, patch: Partial<RouteLayer>) => {
    const line = lines[lineIndex];
    setLine(lineIndex, { layers: line.layers.map((layer, position) => (position === layerIndex ? { ...layer, ...patch } : layer)) });
  };
  const removeLayer = (lineIndex: number, layerIndex: number) => setLine(lineIndex, { layers: lines[lineIndex].layers.filter((_, position) => position !== layerIndex) });
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
  const relayPoolHostIds = new Set(pools.filter((pool) => pool.role !== "landing").flatMap((pool) => pool.members.map((member) => member.hostId)));
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
        <DropdownMenuLabel className="text-[11px]">机器</DropdownMenuLabel>
        {hosts.filter((host) => host.id !== entryHostId).map((host) => (
          <DropdownMenuItem key={`h${host.id}`} onSelect={() => addLayer(lineIndex, newRouteLayer({ kind: "hosts", hostIds: [host.id] }))}>{host.name}{host.isOnline === false ? "（离线）" : ""}</DropdownMenuItem>
        ))}
        {pools.length > 0 ? (<><DropdownMenuSeparator /><DropdownMenuLabel className="text-[11px]">节点池</DropdownMenuLabel></>) : null}
        {pools.map((pool) => (
          <DropdownMenuItem key={`p${pool.id}`} onSelect={() => addLayer(lineIndex, newRouteLayer({ kind: "pool", poolId: pool.id }))}>{pool.name} · {pool.members.length} 台</DropdownMenuItem>
        ))}
        {allowTunnels && tunnels.some((tunnel) => tunnel.entryHostId === previousHost) ? (<><DropdownMenuSeparator /><DropdownMenuLabel className="text-[11px]">隧道（从上一个节点出发）</DropdownMenuLabel></>) : null}
        {allowTunnels ? tunnels.filter((tunnel) => tunnel.entryHostId === previousHost).map((tunnel) => (
          <DropdownMenuItem key={`t${tunnel.id}`} onSelect={() => addLayer(lineIndex, newRouteLayer({ kind: "tunnel", tunnelIds: [tunnel.id] }))}>{tunnel.name} → {hostName(tunnel.exitHostId)}</DropdownMenuItem>
        )) : null}
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
              <span className="pt-[6px] text-[12px] text-muted-foreground">第 {layerIndex + 1} 层</span>
              <div className="flex min-w-0 flex-col">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="route-line-layer">
                  {pool ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <LineChipButton variant="sel">池 · {pool.name}</LineChipButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem onSelect={() => removeLayer(lineIndex, layerIndex)}>去掉这一层</DropdownMenuItem>
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
                  {!pool && total < MAX_LAYER_CANDIDATES && (addableHosts.length > 0 || addableTunnels.length > 0) ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <LineChipButton variant="add" className="min-w-[30px] justify-center" aria-label={`第 ${layerIndex + 1} 层再加一个候选`}>+</LineChipButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                        {addableTunnels.length > 0 ? <DropdownMenuLabel className="text-[11px]">隧道（从上一个节点出发）</DropdownMenuLabel> : null}
                        {addableTunnels.map((tunnel) => (
                          <DropdownMenuItem key={`t${tunnel.id}`} onSelect={() => setLayer(lineIndex, layerIndex, { tunnelIds: [...layer.tunnelIds, tunnel.id] })}>{tunnel.name} → {hostName(tunnel.exitHostId)}</DropdownMenuItem>
                        ))}
                        {addableTunnels.length > 0 && addableHosts.length > 0 ? <DropdownMenuSeparator /> : null}
                        {addableHosts.length > 0 ? <DropdownMenuLabel className="text-[11px]">机器</DropdownMenuLabel> : null}
                        {addableHosts.map((host) => (
                          <DropdownMenuItem key={`h${host.id}`} onSelect={() => setLayer(lineIndex, layerIndex, { hostIds: [...layer.hostIds, host.id], kind: "hosts" })}>{host.name}{host.isOnline === false ? "（离线）" : ""}</DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                <div className="mt-[6px] flex min-w-0 flex-wrap items-center gap-[10px] text-[11.5px] text-muted-foreground">
                  {/* 小下拉而不是 Select：手机上 Select 被统一撑到 34px / 15px，这里要和效果图一样只占一行小字 */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className="inline-flex items-center gap-1 rounded-[8px] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] px-2 py-[3px] text-[11.5px] leading-[1.3] text-foreground" aria-label={`第 ${layerIndex + 1} 层怎么挑`}>
                        {layer.pick === "order" ? "按顺序" : "最低延迟"}
                        <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onSelect={() => setLayer(lineIndex, layerIndex, { pick: "best" })}>最低延迟</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setLayer(lineIndex, layerIndex, { pick: "order" })}>按顺序</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <label className="flex items-center gap-1.5" title="这一层全坏了就直连下一层">
                    <Checkbox checked={layer.skippable} onCheckedChange={(checked) => setLayer(lineIndex, layerIndex, { skippable: !!checked })} aria-label={`第 ${layerIndex + 1} 层可跳过`} />
                    可跳过
                  </label>
                  {last && allowHops && line.layers.length < MAX_ROUTE_HOPS ? addHopMenu(lineIndex, previousHost, "+ 再加一层") : null}
                </div>
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

  const main = lines[0];

  return (
    <section className="fx-line-ui flex min-w-0 flex-col" aria-label="线路" data-testid="route-lines">
      {main ? (
        <LineCard data-testid="route-line">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <LineBadge main>主</LineBadge>
              <input
                value={main.name}
                onChange={(event) => setLine(0, { name: event.target.value.slice(0, 40) })}
                placeholder="主线路"
                aria-label="主线路的名字"
                className="min-w-0 flex-1 rounded-md bg-transparent text-[14px] font-bold outline-none focus:bg-[var(--fx-l2-group)] focus:px-1"
              />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {renderLineStatus?.(main, 0)}
              {testButton(main, 0)}
            </div>
          </div>
          {renderLayers(main, 0)}
        </LineCard>
      ) : null}

      <LineSec left="备用线路" right={backups.length > 1 ? "拖动排序" : undefined} />
      {backups.length === 0 ? <p className="mx-1 mb-2 text-[11.5px] text-muted-foreground">还没有备用：主线路坏了没处可切。加一条经别的机器、别的隧道或别的落地的。</p> : null}
      <SortableReorderContext sortable={sortable} strategy="vertical" restrictToList>
        <div className="flex flex-col gap-[7px]">
          {backups.map((line, position) => {
            const lineIndex = position + 1;
            const open = openKey === line.key;
            const lineStatus = renderLineStatus?.(line, lineIndex) ?? null;
            return (
              <SortableItem key={line.key} id={line.key}>
                {({ itemProps, handleProps: { ref: handleRef, ...handleProps } }) => (
                  <div {...itemProps} data-testid="route-line">
                    <LineRow className={cn(open && "rounded-b-none border-b-transparent")}>
                      <button
                        type="button"
                        ref={handleRef as Ref<HTMLButtonElement>}
                        {...handleProps}
                        className="fx-compact-touch -ml-0.5 shrink-0 cursor-grab touch-none px-0.5 text-[14px] leading-none tracking-[-2px] text-muted-foreground/50 active:cursor-grabbing"
                        aria-label={`拖动备 ${lineIndex} 排序`}
                      >
                        ⋮⋮
                      </button>
                      <LineBadge>备 {lineIndex}</LineBadge>
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1 text-left"
                        aria-expanded={open}
                        onClick={() => setOpenKey(open ? null : line.key)}
                        title="点开改这条"
                      >
                        <LinePath bad={line.paused}>{lineText(line)}</LinePath>
                        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
                      </button>
                      {lineStatus}
                      {testButton(line, lineIndex)}
                      {lineStatus ? null : (
                        <Checkbox checked={!line.paused} onCheckedChange={(checked) => setLine(lineIndex, { paused: !checked })} aria-label={`备 ${lineIndex} 参与切换`} title="勾掉 = 暂停这条，保存后生效" />
                      )}
                    </LineRow>
                    {open ? (
                      <div className="rounded-b-[12px] border border-t-0 border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] px-[10px] pb-[10px]">
                        <div className="flex min-w-0 items-center gap-2 border-t border-dashed border-[var(--fx-stroke-weak)] pt-2">
                          <Input
                            value={line.name}
                            onChange={(event) => setLine(lineIndex, { name: event.target.value.slice(0, 40) })}
                            placeholder={defaultRoutePathName(lineIndex)}
                            aria-label={`备 ${lineIndex} 的名字`}
                            className="h-7 min-w-0 flex-1 text-[12.5px]"
                          />
                          <button
                            type="button"
                            className="shrink-0 text-[11.5px] text-[var(--fx-down-text)] hover:underline"
                            onClick={() => { onChange(lines.filter((_, index) => index !== lineIndex)); setOpenKey(null); }}
                          >
                            删掉这条
                          </button>
                        </div>
                        {renderLayers(line, lineIndex)}
                      </div>
                    ) : null}
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
