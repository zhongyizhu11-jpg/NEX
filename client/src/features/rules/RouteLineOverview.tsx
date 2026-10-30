import { useMemo, useState } from "react";
import { Download, Gauge, Pause, Play } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatFailoverEndpoint } from "@shared/failoverTargets";
import { ROUTE_DELIVERY_INFO, describeRouteIssue, normalizeRouteDelivery } from "@shared/routeGroup";
import type { RouteStatus, RouteStatusPath } from "./RouteGroupSheet";

/*
  线路面板的上半截（2.3.496，照 ZeroForwarder 的「最优延迟 + 自动切换」那一屏）：

    大数字    整条链此刻多少毫秒、坏了多久能切走
    分层图    入口 → 中转 / 隧道 → 落地，一列一层，在走的那条加粗，别的虚线，段上写毫秒
    线路      主 / 备 N 一行一条：使用中 / 待命 / 故障（划掉），右边暂停
    按段      入口拨第一跳的真实成功率，后面每段是中转探下一跳的成功率；坏的那段标红写原因
    工具      导出（JSON，交给技术支持或 AI）、逐段测带宽（相邻两台自己的机器之间 iperf3）

  数据都来自 rules.routeStatus（server/routeStatusView.ts），这里只画。
*/

type Path = Omit<RouteStatusPath, "hops"> & {
  tier?: number | null;
  lineKey?: string | null;
  paused?: boolean;
  downstreamMs?: number;
  dials?: { ok: number; failed: number; slow: number; dialMs: number; lastAt: number } | null;
  hops: Array<RouteStatusPath["hops"][number] & { viaTunnel?: { id: number; name: string } | null; successPct?: number | null; maintenance?: boolean; offline?: boolean | null; tripped?: boolean }>;
};

const round = (value: number) => Math.round(value * 10) / 10;

export function chainLatency(path: Path | null | undefined): number | null {
  if (!path || path.latencyMs === null || path.latencyMs === undefined) return null;
  return round(Number(path.latencyMs) + Number(path.downstreamMs || 0));
}

function destLabel(path: Path) {
  return path.dest?.ip ? formatFailoverEndpoint(path.dest.ip, path.dest.port) : "落地";
}

/** 线路行右边的徽章只放几个字（节点名截短），完整原因在 title 里。状态里的原因已经是说人话的那句。 */
function shortIssue(reason: string) {
  const text = describeRouteIssue(reason);
  const scoped = /^(.+?)\s+(离线|维护中|熔断)/.exec(text);
  if (scoped) {
    const name = scoped[1].length > 6 ? `${scoped[1].slice(0, 5)}…` : scoped[1];
    return `${name} ${scoped[2]}`;
  }
  return text.length > 8 ? `${text.slice(0, 7)}…` : text;
}

/** 「线路」那一行右边：这条规则按什么切。 */
export function routeLineSwitchSummary(status: RouteStatus) {
  if (normalizeRouteDelivery((status as any).delivery) === "aggregate") return "主线路那组一起分担";
  switch (status.policy.mode) {
    case "weighted": return "按权重分";
    case "smart": return "主线路那组里挑最好的";
    case "scheduled": return "按时段首选 · 坏了往下切";
    case "hybrid": return "按时段首选 · 预检过了才切";
    case "manual": return "走指定那条 · 坏了临时切";
    default: return "按顺序切换 · 恢复后切回";
  }
}

const DIAGRAM_LABEL_MAX = 70;
const DIAGRAM_SUB_MAX = 76;

/** SVG 里没法量字，按字估：中文一个字一格，其余半格多一点（9.5px 字号）。 */
function fitDiagramText(text: string, max: number, size = 9.5) {
  const charWidth = (ch: string) => (/[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? size : size * 0.6);
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = charWidth(ch);
    if (width + w > max) return { text: `${out}…`, width: width + size * 0.6 };
    width += w;
    out += ch;
  }
  return { text: out, width };
}

export function RouteLineHero({ status }: { status: RouteStatus }) {
  const paths = status.paths as unknown as Path[];
  const active = paths.find((path) => path.active) || paths[0];
  const total = chainLatency(active);
  const delivery = normalizeRouteDelivery((status as any).delivery);
  const switchSeconds = Math.max(5, Number(status.policy.failoverSeconds || 0));
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2 rounded-[var(--fx-radius-card,14px)] border-l-[3px] border-[var(--fx-accent)] bg-[var(--fx-l1-surface)] px-4 py-3" data-testid="route-line-hero">
      <div>
        <div className="font-mono text-[30px] font-bold leading-none tracking-tight text-[var(--fx-accent)]">
          {total === null ? <span className="font-sans text-lg font-semibold text-muted-foreground">未测</span> : <>{total}<small className="ml-0.5 text-xs font-medium">ms</small></>}
        </div>
        <div className="mt-1 text-[11.5px] text-muted-foreground">整链延迟（测到落地）</div>
      </div>
      <div aria-hidden className="h-9 w-px self-center bg-[var(--fx-stroke-weak)]" />
      <div className="text-right">
        <div className="font-mono text-[30px] font-bold leading-none tracking-tight text-[var(--fx-accent)]">{switchSeconds}<small className="ml-0.5 text-xs font-medium">s 内</small></div>
        <div className="mt-1 text-[11.5px] text-muted-foreground">故障切走 · {ROUTE_DELIVERY_INFO[delivery].label}</div>
      </div>
    </div>
  );
}

/** 分层图：一列一层。节点按列去重，同一台机器在同一列只画一次。 */
export function RouteLineDiagram({ status }: { status: RouteStatus }) {
  const paths = status.paths as unknown as Path[];
  const layout = useMemo(() => {
    const maxHops = Math.max(0, ...paths.map((path) => path.hops.length));
    const columns: Array<Array<{ key: string; label: string; sub: string; tone: string }>> = [];
    columns.push([{ key: "entry", label: status.entry?.name || "入口", sub: "入口", tone: status.entry?.online === false ? "down" : "ok" }]);
    for (let k = 0; k < maxHops; k += 1) {
      const nodes: Array<{ key: string; label: string; sub: string; tone: string }> = [];
      for (const path of paths) {
        const hop = path.hops[k];
        if (!hop) continue;
        const key = `h${hop.hostId}`;
        if (nodes.some((node) => node.key === key)) continue;
        nodes.push({ key, label: hop.name, sub: hop.viaTunnel ? `隧道 ${hop.viaTunnel.name}` : "中转", tone: hop.maintenance ? "warn" : hop.offline || hop.tripped ? "down" : "ok" });
      }
      columns.push(nodes);
    }
    const landings: Array<{ key: string; label: string; sub: string; tone: string }> = [];
    for (const path of paths) {
      const key = `d${destLabel(path)}`;
      if (landings.some((node) => node.key === key)) continue;
      landings.push({ key, label: path.dest?.ip || "落地", sub: path.dest?.ip ? `落地 :${path.dest.port}` : "规则目标", tone: "ok" });
    }
    columns.push(landings);
    return columns.map((column) => column.map((node) => {
      const label = fitDiagramText(node.label, DIAGRAM_LABEL_MAX);
      return { ...node, label: label.text, sub: fitDiagramText(node.sub, DIAGRAM_SUB_MAX, 8).text, boxWidth: Math.max(44, Math.ceil(label.width) + 14) };
    }));
  }, [paths, status.entry?.name, status.entry?.online]);
  const width = 340;
  const rowHeight = 46;
  const height = Math.max(110, Math.max(...layout.map((column) => column.length)) * rowHeight + 24);
  // 第一列和最后一列往里收半个最宽的框，框不会被裁掉。
  const halfWidest = (column: typeof layout[number] | undefined) => Math.max(22, ...(column || []).map((node) => node.boxWidth / 2)) + 2;
  const left = halfWidest(layout[0]);
  const right = halfWidest(layout[layout.length - 1]);
  const colX = (index: number) => left + (index * (width - left - right)) / Math.max(1, layout.length - 1);
  const nodeY = (column: number, key: string) => {
    const nodes = layout[column];
    const position = Math.max(0, nodes.findIndex((node) => node.key === key));
    const span = nodes.length;
    return 12 + ((position + 0.5) * (height - 24)) / Math.max(1, span);
  };
  const pathPoints = (path: Path) => {
    const points: Array<{ x: number; y: number; ms: number | null }> = [{ x: colX(0), y: nodeY(0, "entry"), ms: null }];
    path.hops.forEach((hop, index) => points.push({ x: colX(index + 1), y: nodeY(index + 1, `h${hop.hostId}`), ms: index === 0 ? path.latencyMs : path.hops[index - 1].latencyMs }));
    const last = layout.length - 1;
    points.push({ x: colX(last), y: nodeY(last, `d${destLabel(path)}`), ms: path.hops.length === 0 ? path.latencyMs : path.hops[path.hops.length - 1].latencyMs });
    return points;
  };
  const ordered = [...paths].sort((a, b) => Number(a.active) - Number(b.active));
  const active = paths.find((path) => path.active) || null;
  return (
    <div className="rounded-[var(--fx-radius-card,14px)] bg-[var(--fx-l1-surface)] px-2 py-2" data-testid="route-line-diagram">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="线路分层图" className="block">
        {ordered.map((path) => {
          const points = pathPoints(path);
          const d = points.map((point, index) => (index === 0 ? `M${point.x} ${point.y}` : `C${(points[index - 1].x + point.x) / 2} ${points[index - 1].y} ${(points[index - 1].x + point.x) / 2} ${point.y} ${point.x} ${point.y}`)).join(" ");
          const isActive = path.active;
          const broken = path.down || path.paused;
          return (
            <g key={path.key}>
              <path d={d} fill="none" stroke={isActive ? "var(--fx-accent)" : broken ? "var(--fx-down-text)" : "var(--fx-stroke)"} strokeOpacity={isActive ? 1 : 0.55} strokeWidth={isActive ? 2.6 : 1.4} strokeDasharray={isActive ? undefined : "4 4"} />
              {points.slice(1).map((point, index) => (point.ms !== null && point.ms !== undefined ? (
                <text key={index} x={(points[index].x + point.x) / 2} y={(points[index].y + point.y) / 2 - 5} textAnchor="middle" fontSize="9.5" fontFamily="ui-monospace,monospace" fill={isActive ? "var(--fx-accent)" : "var(--fx-text-muted)"} fontWeight={isActive ? 700 : 400}>{Math.round(Number(point.ms))}</text>
              ) : null))}
            </g>
          );
        })}
        {layout.map((column, columnIndex) => column.map((node) => {
          const x = colX(columnIndex);
          const y = nodeY(columnIndex, node.key);
          return (
            <g key={`${columnIndex}-${node.key}`}>
              <rect x={x - node.boxWidth / 2} y={y - 11} width={node.boxWidth} height={22} rx={6} fill="var(--fx-l1-surface)" stroke={node.tone === "down" ? "var(--fx-down-text)" : node.tone === "warn" ? "var(--fx-warn-text)" : "var(--fx-stroke)"} strokeWidth={1.2} />
              <text x={x} y={y + 3.5} textAnchor="middle" fontSize="9.5" fontWeight={600} fill="var(--fx-text)">{node.label}</text>
              <text x={x} y={y + 20} textAnchor="middle" fontSize="8" fill="var(--fx-text-muted)">{node.sub}</text>
            </g>
          );
        }))}
      </svg>
      {active ? (
        <p className="truncate border-t border-dashed border-[var(--fx-stroke-weak)] px-1 pt-1.5 font-mono text-[11px] text-muted-foreground">
          <b className="text-foreground">{[status.entry?.name || "入口", ...active.hops.map((hop) => hop.name), destLabel(active)].join(" → ")}</b>
          {chainLatency(active) !== null ? <span className="text-[var(--fx-healthy-text)]"> {chainLatency(active)} ms</span> : null}
          {(status.policy.mode === "smart" || status.policy.mode === "hybrid") ? " 整链最优" : ""}
        </p>
      ) : null}
    </div>
  );
}

/** 线路列表：按线路分组（同一条线路展开的几条路径算一行），右边暂停（onPause 由线路组弹窗给）。 */
export function RouteLineList({ status, onPause, pausing = false }: { status: RouteStatus; onPause?: (lineKey: string, paused: boolean) => void; pausing?: boolean }) {
  const paths = status.paths as unknown as Path[];
  const groups: Array<{ key: string; name: string; tier: number; paths: Path[] }> = [];
  for (const path of paths) {
    const key = path.lineKey || path.key;
    let group = groups.find((item) => item.key === key);
    if (!group) {
      group = { key, name: path.name, tier: typeof path.tier === "number" ? path.tier : groups.length, paths: [] };
      groups.push(group);
    }
    group.paths.push(path);
  }
  return (
    <div className="flex flex-col gap-1.5" data-testid="route-line-list">
      {groups.map((group, index) => {
        const active = group.paths.some((path) => path.active);
        const paused = group.paths.every((path) => path.paused);
        const allDown = group.paths.every((path) => path.down);
        const reason = group.paths.find((path) => path.downReason)?.downReason || "";
        const summary = group.paths[0];
        const via = summary.hops.map((hop) => (hop.viaTunnel ? `隧道 ${hop.viaTunnel.name}` : hop.name));
        return (
          <div key={group.key} className={cn("flex min-w-0 items-center gap-2 rounded-xl border bg-[var(--fx-l1-surface)] px-2.5 py-2", active ? "border-[var(--fx-accent)] ring-2 ring-[var(--fx-accent-soft)]" : "border-[var(--fx-stroke-weak)]")}>
            <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold", index === 0 ? "bg-[var(--fx-accent)] text-white" : "bg-[var(--fx-l2-group)] text-muted-foreground")}>{index === 0 ? "主" : `备 ${index}`}</span>
            <span className={cn("min-w-0 flex-1 truncate text-xs", (allDown || paused) && "text-muted-foreground line-through")}>
              {[status.entry?.name || "入口", ...via, destLabel(summary)].join(" → ")}
              {group.paths.length > 1 ? <span className="ml-1 text-[11px] no-underline">（{group.paths.length} 条组合）</span> : null}
            </span>
            <span className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
              paused ? "bg-[var(--fx-l2-group)] text-muted-foreground" : active ? "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]" : allDown ? "bg-[var(--fx-down-soft)] text-[var(--fx-down-text)]" : "bg-[var(--fx-l2-group)] text-muted-foreground",
            )} title={allDown ? describeRouteIssue(reason) : undefined}>
              {paused ? "已暂停" : active ? "使用中" : allDown ? (reason ? shortIssue(reason) : "故障") : "待命"}
            </span>
            {onPause ? (
              <button
                type="button"
                className="fx-compact-touch inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--fx-stroke-weak)] text-muted-foreground hover:text-foreground disabled:opacity-40"
                aria-label={paused ? `恢复线路 ${group.name}` : `暂停线路 ${group.name}`}
                title={paused ? "恢复" : "暂停这条"}
                disabled={pausing}
                onClick={() => onPause(group.key, !paused)}
              >
                {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** 按段成功率：在走的那条路径，从入口到落地一段一段。 */
export function RouteStageStrip({ status }: { status: RouteStatus }) {
  const paths = status.paths as unknown as Path[];
  const path = paths.find((item) => item.active) || paths[0];
  if (!path) return null;
  const nodes = [status.entry?.name || "入口", ...path.hops.map((hop) => hop.name), "落地"];
  const dials = path.dials;
  const first = dials && dials.ok + dials.failed > 0 ? round((dials.ok / (dials.ok + dials.failed)) * 100) : null;
  const stages: Array<{ label: string; pct: number | null; why: string | null }> = [
    { label: path.hops.length === 0 ? "拨落地" : path.hops[0].viaTunnel ? "隧道" : "拨中转", pct: first, why: first !== null && first < 95 ? "拨号失败多" : null },
    ...path.hops.map((hop, index) => {
      const pct = hop.successPct ?? null;
      const next = path.hops[index + 1];
      return { label: next ? (next.viaTunnel ? "隧道" : "中转") : "落地拨号", pct, why: hop.ok === false ? "连不上" : pct !== null && pct < 95 ? "丢包" : null };
    }),
  ];
  const tone = (pct: number | null) => (pct === null ? "text-muted-foreground" : pct >= 98 ? "text-[var(--fx-healthy-text)]" : pct >= 90 ? "text-[var(--fx-warn-text)]" : "text-[var(--fx-down-text)]");
  return (
    <div className="rounded-[var(--fx-radius-card,14px)] bg-[var(--fx-l1-surface)] px-2 py-2.5" data-testid="route-stage-strip">
      <div className="flex min-w-0 items-end">
        {nodes.map((node, index) => (
          <div key={index} className="contents">
            <span className="shrink-0 truncate rounded-md border border-[var(--fx-stroke-weak)] px-1.5 py-1 font-mono text-[10.5px]" style={{ maxWidth: "4.6rem" }}>{node}</span>
            {index < stages.length ? (
              <div className="min-w-0 flex-1 px-0.5 text-center">
                <div className="text-[9.5px] text-muted-foreground">{stages[index].label}</div>
                <div className={cn("font-mono text-[11px] font-bold", tone(stages[index].pct))}>{stages[index].pct === null ? "—" : `${stages[index].pct}%`}</div>
                <div className={cn("mx-0.5 mb-2 h-0.5 rounded", stages[index].why ? "bg-[repeating-linear-gradient(90deg,var(--fx-down-text)_0_5px,transparent_5px_8px)]" : stages[index].pct === null ? "bg-[var(--fx-stroke-weak)]" : "bg-[var(--fx-healthy-text)]")} />
                {stages[index].why ? <div className="-mt-1.5 text-[9.5px] text-[var(--fx-down-text)]">{stages[index].why}</div> : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <p className="mt-1.5 px-0.5 text-[10.5px] text-muted-foreground">第一段是入口真实拨号的成功率（近 10 分钟），后面每段是中转探下一跳的成功率（近 20 次）。</p>
    </div>
  );
}

/** 线路组弹窗里暂停 / 恢复一条线路。 */
export function useRouteLinePause(ruleId: number) {
  const utils = trpc.useUtils();
  const pause = trpc.lineDiagnostics.linePause.useMutation({
    onSuccess: () => void utils.rules.routeStatus.invalidate({ ruleId }),
    onError: (error) => toast.error(error.message),
  });
  return { onPause: (lineKey: string, paused: boolean) => pause.mutate({ ruleId, lineKey, paused }), pausing: pause.isPending };
}

/** 导出 / 逐段测带宽。 */
export function RouteLineTools({ status }: { status: RouteStatus }) {
  const utils = trpc.useUtils();
  const [runId, setRunId] = useState<string | null>(null);
  const active = (status.paths as unknown as Path[]).find((path) => path.active) || (status.paths[0] as unknown as Path | undefined);
  const start = trpc.lineDiagnostics.segmentSpeedStart.useMutation({
    onSuccess: (run: any) => setRunId(String(run.runId)),
    onError: (error) => toast.error(error.message),
  });
  const run = trpc.lineDiagnostics.segmentSpeedStatus.useQuery({ runId: runId || "" }, {
    enabled: !!runId,
    refetchInterval: (query) => ((query.state.data as any)?.status === "running" ? 1500 : false),
  });
  const [exporting, setExporting] = useState(false);
  const exportLine = async () => {
    setExporting(true);
    try {
      const file = await utils.lineDiagnostics.lineExport.fetch({ ruleId: status.ruleId, format: "json", hours: 168 });
      const blob = new Blob([file.body], { type: file.contentType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  };
  const data = run.data as any;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1 rounded-full text-xs" disabled={!active || start.isPending || data?.status === "running"} onClick={() => active && start.mutate({ ruleId: status.ruleId, pathKey: active.key })} data-testid="route-line-speed">
          <Gauge className="h-3.5 w-3.5" />{data?.status === "running" ? "测带宽中…" : "逐段测带宽"}
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1 rounded-full text-xs" disabled={exporting} onClick={() => void exportLine()} data-testid="route-line-export">
          <Download className="h-3.5 w-3.5" />导出 7 天记录
        </Button>
      </div>
      {data?.segments ? (
        <div className="flex flex-col gap-0.5 rounded-xl bg-[var(--fx-l1-surface)] px-3 py-2 text-xs" data-testid="route-line-speed-result">
          {data.segments.map((segment: any, index: number) => (
            <div key={index} className={cn("flex items-center justify-between gap-2", data.slowest === index && "font-semibold text-[var(--fx-warn-text)]")}>
              <span className="truncate">{segment.from.name} → {segment.to.name}</span>
              <span className="shrink-0 font-mono">
                {segment.status === "done" ? `${Math.round(segment.mbps)} Mbps${data.slowest === index ? " · 最慢" : ""}` : segment.status === "skipped" ? "测不了" : segment.status === "error" ? "失败" : "…"}
              </span>
            </div>
          ))}
          {data.segments.filter((segment: any) => segment.error && segment.status !== "skipped").map((segment: any, index: number) => (
            <p key={`e${index}`} className="text-[11px] text-[var(--fx-warn-text)]">{segment.from.name} → {segment.to.name}：{segment.error}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
