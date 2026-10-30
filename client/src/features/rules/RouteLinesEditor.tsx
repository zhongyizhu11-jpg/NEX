import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X, Zap } from "lucide-react";

import { SortableDragHandle, SortableItem, SortableReorderContext, useSortableReorder } from "@/components/SortableDragHandle";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatFailoverEndpoint, parseFailoverEndpoint } from "@shared/failoverTargets";
import { MAX_ROUTE_HOPS, MAX_ROUTE_PATHS, defaultRoutePathName, describeRouteIssue, type RoutePath } from "@shared/routeGroup";
import { MAX_LAYER_CANDIDATES, MAX_LINE_DESTS, expandRouteLines, newRouteLayer, newRouteLine, type RouteLayer, type RouteLine } from "@shared/routeLines";

/*
  线路编辑（2.3.496）：主线路一张卡，下面是有序的备用；每条线路几层候选，落地也可以放几个。

  照 ZeroForwarder 的「端点组是一层候选、转发链是多层顺序」：一层里放几台机器（或一个节点池、
  一条隧道），面板按整条链的延迟挑；可以设「可跳过」—— 这一层全坏了就直连下一层。主线路就是
  现在这条路（没加层 = 入口直连落地），备用按顺序候着，拖动排序，暂停的不参与。

  右上角的小闪电：保存前逐段测一下（server/lineSegmentLatency.ts），毫秒数直接写在机器名旁边。
  展开成具体路径（Agent 认的那种）在服务端做；这里同一套函数做一份预览，用来数「组合出几条」。
*/

export type RouteLineHost = { id: number; name: string; isOnline?: boolean | null };
export type RouteLinePool = { id: number; name: string; role: string; members: Array<{ hostId: number; name: string; online: boolean; maintenance: boolean }> };
export type RouteLineTunnel = { id: number; name: string; entryHostId: number; exitHostId: number; mode?: string | null };
export type RouteLineNode = { id: number; name: string; address: string; port: number; protocol?: string };

type LatencyMap = Map<string, number | null>;

const segmentKey = (from: number, to: number | "dest") => `${from}>${to}`;

function chipClass(selected: boolean) {
  return cn(
    "inline-flex h-7 max-w-full items-center gap-1 rounded-full border px-2.5 text-xs",
    selected ? "border-[var(--fx-accent)] bg-[var(--fx-accent-soft)] font-medium text-[var(--fx-accent-strong,var(--fx-accent))]" : "border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)]",
  );
}

function Ms({ value }: { value: number | null | undefined }) {
  if (value === undefined) return null;
  return <span className={cn("font-mono text-[10.5px] font-semibold", value === null ? "text-[var(--fx-down-text)]" : "text-[var(--fx-healthy-text)]")}>{value === null ? "×" : Math.round(value)}</span>;
}

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
}) {
  const hostName = (id: number) => hosts.find((host) => host.id === id)?.name || `主机 ${id}`;
  const [latency, setLatency] = useState<LatencyMap>(new Map());
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const start = trpc.lineDiagnostics.segmentLatencyStart.useMutation();
  const status = trpc.lineDiagnostics.segmentLatencyStatus.useQuery({ runId: runId || "" }, {
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.done ? false : 1000),
  });
  useEffect(() => {
    const data = status.data;
    if (!data) return;
    setLatency((previous) => {
      const next = new Map(previous);
      for (const segment of data.segments) {
        if (segment.status === "running" || segment.status === "pending") continue;
        next.set(segmentKey(segment.from.hostId, segment.to.hostId ?? "dest"), segment.latencyMs);
      }
      return next;
    });
    if (data.done) setTestingKey(null);
  }, [status.data]);

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

  /** 小闪电：这条线路的第一种组合（每层第一个候选）逐段测。 */
  const testLine = async (line: RouteLine) => {
    if (!entryHostId) return;
    const hops: number[] = [];
    const hopVia: Array<number | null> = [];
    for (const layer of line.layers) {
      if (layer.kind === "tunnel") {
        const tunnel = tunnels.find((item) => item.id === layer.tunnelIds[0]);
        if (tunnel) { hops.push(tunnel.exitHostId); hopVia.push(tunnel.id); }
      } else {
        const candidates = layer.kind === "pool" ? (pools.find((pool) => pool.id === layer.poolId)?.members.map((member) => member.hostId) || []) : layer.hostIds;
        // 一层里每个候选都测：这一段就有每台机器各自的毫秒数。
        const first = candidates.find((id) => !hops.includes(id));
        if (first) { hops.push(first); hopVia.push(null); }
      }
    }
    const destCandidate = line.dests[0] || null;
    const dest = destCandidate?.dest || (() => {
      const parsed = parseFailoverEndpoint(mainAddress);
      return parsed && !("error" in parsed) ? { ip: parsed.host, port: parsed.port } : null;
    })();
    setTestingKey(line.key);
    try {
      const result = await start.mutateAsync({ ruleId: ruleId || undefined, entryHostId, hops, hopVia, dest });
      setRunId(result.runId);
    } catch {
      setTestingKey(null);
    }
  };

  const pathCount = (line: RouteLine) => previewPaths.filter((path) => path.lineKey === line.key).length;
  const mainHopIds = new Set(lines[0]?.layers.flatMap((layer) => layer.hostIds) || []);
  const quickHosts = hosts.filter((host) => host.id !== entryHostId && host.isOnline !== false && !mainHopIds.has(host.id)).slice(0, 4);
  const addBackup = (layers: RouteLayer[]) => {
    if (lines.length >= MAX_ROUTE_PATHS) return;
    onChange([...lines, newRouteLine(lines.length, { name: defaultRoutePathName(lines.length), layers, dests: lines[0]?.dests || [] })]);
  };

  const renderLine = (line: RouteLine, lineIndex: number, handle?: { handleProps: any }) => {
    const main = lineIndex === 0;
    const count = pathCount(line);
    let previousHost = entryHostId || 0;
    return (
      <div
        className={cn("flex min-w-0 flex-col gap-2 rounded-[var(--fx-radius-control)] border bg-[var(--fx-l1-surface)] px-3 py-2.5", main ? "border-[var(--fx-accent)]/50" : "border-[var(--fx-stroke-weak)]", line.paused && "opacity-60")}
        data-testid="route-line"
      >
        <div className="flex min-w-0 items-center gap-2">
          {handle ? <SortableDragHandle dragHandleProps={handle.handleProps} visible /> : null}
          <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold", main ? "bg-[var(--fx-accent)] text-white" : "bg-[var(--fx-l2-group)] text-muted-foreground")}>{main ? "主" : `备 ${lineIndex}`}</span>
          <Input
            value={line.name}
            onChange={(event) => setLine(lineIndex, { name: event.target.value.slice(0, 40) })}
            placeholder={defaultRoutePathName(lineIndex)}
            aria-label={`线路 ${lineIndex + 1} 的名字`}
            className="h-7 min-w-0 flex-1 text-sm"
          />
          {count > 1 ? <span className="shrink-0 text-[11px] text-muted-foreground">组合 {count} 条</span> : null}
          <button
            type="button"
            className="fx-compact-touch inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--fx-stroke-weak)] text-muted-foreground hover:text-foreground disabled:opacity-40"
            aria-label={`逐段测一下线路 ${lineIndex + 1}`}
            title="逐段测延迟"
            disabled={!entryHostId || testingKey !== null}
            onClick={() => void testLine(line)}
            data-testid="route-line-test"
          >
            <Zap className={cn("h-3.5 w-3.5", testingKey === line.key && "animate-pulse text-[var(--fx-accent)]")} />
          </button>
          {!main ? (
            <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
              <Checkbox checked={!line.paused} onCheckedChange={(checked) => setLine(lineIndex, { paused: !checked })} aria-label={`线路 ${lineIndex + 1} 启用`} />
              启用
            </label>
          ) : null}
          {!main ? (
            <Button type="button" variant="ghost" size="icon" className="fx-compact-touch h-7 w-7 shrink-0 text-muted-foreground" aria-label={`删掉线路 ${lineIndex + 1}`} onClick={() => onChange(lines.filter((_, position) => position !== lineIndex))}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>

        <div className="grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5 text-xs">
          <span className="pt-1.5 text-muted-foreground">入口</span>
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {entryPrefix ? <span className="text-[11px] text-muted-foreground">{entryPrefix}</span> : null}
            <span className={chipClass(false)}>{entryName}</span>
          </div>
          {line.layers.map((layer, layerIndex) => {
            const from = previousHost;
            const options = layer.kind === "pool"
              ? (pools.find((pool) => pool.id === layer.poolId)?.members || []).map((member) => ({ id: member.hostId, name: member.name, state: member.maintenance ? "维护" : member.online ? "" : "离线" }))
              : layer.kind === "tunnel"
                ? layer.tunnelIds.map((id) => ({ id, name: tunnels.find((tunnel) => tunnel.id === id)?.name || `隧道 ${id}`, state: "" }))
                : layer.hostIds.map((id) => ({ id, name: hostName(id), state: hosts.find((host) => host.id === id)?.isOnline === false ? "离线" : "" }));
            const firstHost = layer.kind === "tunnel" ? tunnels.find((tunnel) => tunnel.id === layer.tunnelIds[0])?.exitHostId : options[0]?.id;
            if (firstHost) previousHost = firstHost;
            const addable = hosts.filter((host) => host.id !== entryHostId && !layer.hostIds.includes(host.id));
            const addableTunnels = tunnels.filter((tunnel) => !layer.tunnelIds.includes(tunnel.id));
            return (
              <div key={`layer-${layerIndex}`} className="contents">
                <span className="pt-1.5 text-muted-foreground">{layer.kind === "tunnel" ? "隧道" : `第 ${layerIndex + 1} 层`}</span>
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-1">
                    {layer.kind === "pool" ? <span className={chipClass(true)}>池 · {pools.find((pool) => pool.id === layer.poolId)?.name || `#${layer.poolId}`}</span> : null}
                    {options.map((option, optionIndex) => (
                      <span key={`${option.id}-${optionIndex}`} className={chipClass(optionIndex === 0 && layer.kind !== "pool")}>
                        <span className="truncate">{option.name}</span>
                        {option.state ? <span className="text-[10.5px] text-[var(--fx-warn-text)]">{option.state}</span> : null}
                        <Ms value={layer.kind === "tunnel" ? latency.get(segmentKey(from, tunnels.find((tunnel) => tunnel.id === option.id)?.exitHostId || 0)) : latency.get(segmentKey(from, option.id))} />
                        {layer.kind !== "pool" ? (
                          <button
                            type="button"
                            className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                            aria-label={`去掉 ${option.name}`}
                            onClick={() => {
                              const nextIds = layer.kind === "tunnel" ? layer.tunnelIds.filter((id) => id !== option.id) : layer.hostIds.filter((id) => id !== option.id);
                              if (nextIds.length === 0) removeLayer(lineIndex, layerIndex);
                              else setLayer(lineIndex, layerIndex, layer.kind === "tunnel" ? { tunnelIds: nextIds } : { hostIds: nextIds });
                            }}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        ) : null}
                      </span>
                    ))}
                    {layer.kind !== "pool" && (layer.kind === "tunnel" ? layer.tunnelIds.length : layer.hostIds.length) < MAX_LAYER_CANDIDATES ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button type="button" className={cn(chipClass(false), "border-dashed text-muted-foreground")} aria-label="这一层再加一个候选"><Plus className="h-3 w-3" /></button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                          {layer.kind === "tunnel"
                            ? addableTunnels.map((tunnel) => <DropdownMenuItem key={tunnel.id} onSelect={() => setLayer(lineIndex, layerIndex, { tunnelIds: [...layer.tunnelIds, tunnel.id] })}>{tunnel.name}</DropdownMenuItem>)
                            : addable.map((host) => <DropdownMenuItem key={host.id} onSelect={() => setLayer(lineIndex, layerIndex, { hostIds: [...layer.hostIds, host.id] })}>{host.name}{host.isOnline === false ? "（离线）" : ""}</DropdownMenuItem>)}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                    <button type="button" className="rounded-full p-1 text-muted-foreground hover:text-foreground" aria-label={`删掉第 ${layerIndex + 1} 层`} onClick={() => removeLayer(lineIndex, layerIndex)}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  {layer.kind !== "tunnel" && (options.length > 1 || layer.kind === "pool") ? (
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <Select value={layer.pick} onValueChange={(value) => setLayer(lineIndex, layerIndex, { pick: value as RouteLayer["pick"] })}>
                        <SelectTrigger className="h-6 w-auto gap-1 px-2 text-[11px]" aria-label={`第 ${layerIndex + 1} 层怎么挑`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="best">按整链延迟挑</SelectItem>
                          <SelectItem value="order">按顺序（前面优先）</SelectItem>
                        </SelectContent>
                      </Select>
                      <label className="flex items-center gap-1">
                        <Checkbox checked={layer.skippable} onCheckedChange={(checked) => setLayer(lineIndex, layerIndex, { skippable: !!checked })} aria-label={`第 ${layerIndex + 1} 层可跳过`} />
                        可跳过（都坏了直连下一层）
                      </label>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          {allowHops && line.layers.length < MAX_ROUTE_HOPS ? (
            <>
              <span />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={cn(chipClass(false), "w-fit border-dashed text-muted-foreground")} data-testid="route-line-add-layer">
                    <Plus className="h-3 w-3" />{line.layers.length === 0 ? "经过中转" : "再加一层"}
                  </button>
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
                  {allowTunnels && tunnels.length > 0 ? (<><DropdownMenuSeparator /><DropdownMenuLabel className="text-[11px]">隧道（从上一个节点出发）</DropdownMenuLabel></>) : null}
                  {allowTunnels ? tunnels.filter((tunnel) => tunnel.entryHostId === previousHost).map((tunnel) => (
                    <DropdownMenuItem key={`t${tunnel.id}`} onSelect={() => addLayer(lineIndex, newRouteLayer({ kind: "tunnel", tunnelIds: [tunnel.id], pick: "order" }))}>{tunnel.name} → {hostName(tunnel.exitHostId)}</DropdownMenuItem>
                  )) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
          <span className="pt-1.5 text-muted-foreground">落地</span>
          <DestEditor
            line={line}
            mainAddress={mainAddress}
            nodeOptions={nodeOptions}
            latency={latency.get(segmentKey(previousHost, "dest"))}
            onChange={(dests) => setLine(lineIndex, { dests })}
          />
        </div>
      </div>
    );
  };

  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label="线路" data-testid="route-lines">
      {lines[0] ? renderLine(lines[0], 0) : null}
      <div className="flex items-center justify-between px-1 pt-1 text-meta text-muted-foreground">
        <span>备用线路</span>
        {backups.length > 1 ? <span>拖动排序</span> : null}
      </div>
      {backups.length === 0 ? <p className="px-1 text-meta text-muted-foreground">还没有备用：主线路坏了没处可切。加一条经别的机器、别的隧道或别的落地的。</p> : null}
      <SortableReorderContext sortable={sortable} strategy="vertical" restrictToList>
        <div className="flex flex-col gap-2">
          {backups.map((line, position) => (
            <SortableItem key={line.key} id={line.key}>
              {({ itemProps, handleProps }) => (
                <div {...itemProps}>{renderLine(line, position + 1, { handleProps })}</div>
              )}
            </SortableItem>
          ))}
        </div>
      </SortableReorderContext>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={cn(chipClass(false), "border-dashed text-muted-foreground")} disabled={lines.length >= MAX_ROUTE_PATHS} onClick={() => addBackup([])} data-testid="route-line-add">
          <Plus className="h-3 w-3" />添加备用
        </button>
        {allowHops ? quickHosts.map((host) => (
          <button key={host.id} type="button" className={chipClass(false)} disabled={lines.length >= MAX_ROUTE_PATHS} onClick={() => addBackup([newRouteLayer({ kind: "hosts", hostIds: [host.id] })])}>
            经 {host.name}
          </button>
        )) : null}
        {allowHops && (lines[0]?.layers.length || 0) > 0 ? (
          <button type="button" className={chipClass(false)} disabled={lines.length >= MAX_ROUTE_PATHS} onClick={() => addBackup([])}>直连落地</button>
        ) : null}
      </div>
      {status.data && status.data.done && status.data.totalMs !== null ? (
        <p className="px-1 text-meta text-muted-foreground" data-testid="route-line-test-total">
          刚测的这条整链约 <b className="font-mono text-foreground">{Math.round(Number(status.data.totalMs))} ms</b>
          {status.data.segments.some((segment) => segment.viaTunnel) ? "（隧道段按两头机器直连测）" : ""}
        </p>
      ) : null}
      {status.data?.done ? status.data.segments.filter((segment) => segment.error).map((segment, index) => (
        <p key={index} className="px-1 text-meta text-[var(--fx-warn-text)]">{segment.from.name} → {segment.to.name}：{describeRouteIssue(segment.error)}</p>
      )) : null}
      {!allowHops ? <p className="px-1 text-meta text-muted-foreground">转发组上的规则暂不支持经过中转。</p> : null}
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
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dests = line.dests.length > 0 ? line.dests : [{ dest: null, destNodeId: null }];
  const label = (item: RouteLine["dests"][number]) => {
    if (item.destNodeId) return nodeOptions.find((node) => node.id === item.destNodeId)?.name || `节点 #${item.destNodeId}`;
    if (item.dest) return formatFailoverEndpoint(item.dest.ip, item.dest.port);
    return mainAddress ? `同目标 ${mainAddress}` : "同规则目标";
  };
  const commit = () => {
    const text = draft.replace(/\s+/g, "");
    if (!text) return;
    const parsed = parseFailoverEndpoint(text);
    if (!parsed || "error" in parsed) {
      setError("格式是 地址:端口");
      return;
    }
    setError(null);
    setDraft("");
    const next = line.dests.length > 0 ? line.dests : [];
    if (next.length >= MAX_LINE_DESTS) return;
    onChange([...next, { dest: { ip: parsed.host, port: parsed.port }, destNodeId: null }]);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {dests.map((item, index) => (
          <span key={index} className={chipClass(index === 0)} data-testid="route-line-dest">
            <span className="truncate font-mono text-[11px]">{label(item)}</span>
            {index === 0 ? <Ms value={latency} /> : null}
            {line.dests.length > 0 ? (
              <button type="button" className="rounded-full p-0.5 text-muted-foreground hover:text-foreground" aria-label={`去掉落地 ${label(item)}`} onClick={() => onChange(line.dests.filter((_, position) => position !== index))}>
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {dests.length < MAX_LINE_DESTS ? (
        <div className="flex min-w-0 items-center gap-1">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }}
            placeholder={line.dests.length === 0 ? "换个落地：IP:端口" : "再加一个落地"}
            aria-label="落地地址"
            className="h-7 min-w-0 flex-1 font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
          />
          {nodeOptions.length > 0 ? (
            <Select value="" onValueChange={(selected) => {
              const node = nodeOptions.find((item) => String(item.id) === selected);
              if (!node) return;
              onChange([...line.dests, { dest: { ip: node.address, port: node.port }, destNodeId: node.id }].slice(0, MAX_LINE_DESTS));
            }}>
              <SelectTrigger className="h-7 w-auto shrink-0 gap-1 border-dashed px-2 text-xs" aria-label="落地选我的节点"><SelectValue placeholder="选节点" /></SelectTrigger>
              <SelectContent align="end">
                {nodeOptions.map((node) => <SelectItem key={node.id} value={String(node.id)}>{node.name} · {node.address}:{node.port}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-meta text-[var(--fx-warn-text)]">{error}</p> : null}
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
