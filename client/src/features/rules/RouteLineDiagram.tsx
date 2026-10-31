import { useMemo } from "react";

import { LineCard, formatLineMs } from "@/features/lines/LineUi";
import type { RouteStatus, RouteStatusHop } from "./RouteGroupSheet";
import { chainLatency, lineClockText, routeDestLabel, routeLandingName, routePathText } from "./routeLineText";

/*
  线路详情里的分层图（效果图 ①，2.3.497 从 RouteLineOverview.tsx 拆出来）：入口 → 隧道 / 中转 → 落地，
  一列一层，在走的那条实线加粗、别的虚线，段上写毫秒；下面一行写这条是几点开始走的、整条链多少、为什么是它。
  落地是最后一列、一直画到卡片右边（2.3.498 起：后面那个「目标」小圆点去掉了，多出来的地方给落地写全名）。
*/

type Hop = RouteStatusHop;

type DiagramNode = { key: string; label: string; sub: string; hot: boolean; tone: "ok" | "warn" | "down"; width: number; /** 全名（框里放不下时截断，悬停看全的） */ title: string };

const DIAGRAM_WIDTH = 350;
const ROW_GAP = 74;
const BOX_HEIGHT = 26;
const X_ENTRY = 26;
/** 落地框的右边（右边留 2px，框描边不被裁）。 */
const RIGHT_EDGE = DIAGRAM_WIDTH - 2;

const columnWidth = (nodes: readonly DiagramNode[]) => Math.max(0, ...nodes.map((node) => node.width));

/** SVG 里没法量字，按字估：等宽 11px，拉丁 6.6px 一个，中文 11px。 */
function fitLabel(text: string, maxWidth: number) {
  const charWidth = (ch: string) => (/[⺀-鿿＀-￯]/.test(ch) ? 11 : 6.6);
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = charWidth(ch);
    if (width + w > maxWidth) return { text: `${out}…`, width: width + 6.6 };
    width += w;
    out += ch;
  }
  return { text: out, width };
}

function hopTone(hop: Hop): "ok" | "warn" | "down" {
  if (hop.maintenance) return "warn";
  if (hop.offline || hop.tripped || hop.ok === false) return "down";
  return "ok";
}

const DOT_FILL = { ok: "var(--fx-healthy-text)", warn: "var(--fx-warn-text)", down: "var(--fx-down-text)" } as const;

/**
 * 每一列里每个节点放在第几行（相对入口那一行，负的在上、正的在下，单位是一行的高度）。
 *
 * 入口、落地在中间那一行。某条线路跳过一列中转（直连、或者跳数比别人少）时，它的线从中间
 * 直直穿过这一列 —— 这一列的节点就不能放在中间，不然在走的直连线正好压在中转框上，看着像
 * 「经过了它」，两段延迟也落在那条粗线上。这种列：排在跳过那条线路之前的节点放上面，之后的
 * 放下面；没有线路跳过的列照旧上下居中。
 *
 * paths：每条线路依次经过的中转（节点 key）；columns：每一列的节点 key（第 0 列入口、最后一列落地）。
 */
export function diagramRowOffsets(paths: ReadonlyArray<{ hopKeys: readonly string[] }>, columns: ReadonlyArray<readonly string[]>): number[][] {
  const centered = (keys: readonly string[]) => keys.map((_, index) => index - (keys.length - 1) / 2);
  return columns.map((keys, column) => {
    if (column === 0 || column === columns.length - 1) return centered(keys);
    const skipIndex = paths.findIndex((path) => path.hopKeys.length < column);
    if (skipIndex < 0) return centered(keys);
    const firstPathOf = (key: string) => paths.findIndex((path) => path.hopKeys[column - 1] === key);
    const above = keys.filter((key) => firstPathOf(key) < skipIndex);
    const below = keys.filter((key) => firstPathOf(key) > skipIndex);
    return keys.map((key) => {
      const up = above.indexOf(key);
      return up >= 0 ? up - above.length : below.indexOf(key) + 1;
    });
  });
}

export function RouteLineDiagram({ status, modeLabel, timeZone }: { status: RouteStatus; modeLabel: string; timeZone?: string }) {
  const paths = status.paths;
  const active = paths.find((path) => path.active) || null;
  const diagram = useMemo(() => {
    const maxHops = Math.max(0, ...paths.map((path) => path.hops.length));
    // 只有一列中转时中间空得多，名字给宽一点（「jinx(39.9y)」不用截）；列多了就紧着来（最多 5 列也得排得下）
    const hopMaxWidth = maxHops <= 1 ? 84 : maxHops === 2 ? 54 : maxHops === 3 ? 38 : 26;
    const hopMinBox = maxHops >= 4 ? 42 : 50;
    // 两列之间至少留这么宽，段上的毫秒才有地方写
    const minGap = maxHops <= 1 ? 30 : maxHops === 2 ? 24 : 14;
    const columns: DiagramNode[][] = [];
    const entryName = status.entry?.name || "入口";
    const entryLabel = fitLabel(entryName, maxHops >= 3 ? 44 : 64);
    columns.push([{
      key: "entry",
      title: entryName,
      label: entryLabel.text,
      sub: "",
      hot: true,
      tone: status.entry?.online === false ? "down" : "ok",
      width: Math.max(40, Math.ceil(entryLabel.width) + 16),
    }]);
    for (let column = 0; column < maxHops; column += 1) {
      const nodes: DiagramNode[] = [];
      for (const path of paths) {
        const hop = path.hops[column];
        if (!hop) continue;
        const key = `h${hop.hostId}`;
        const existing = nodes.find((node) => node.key === key);
        const hot = !!path.active;
        if (existing) {
          if (hot) existing.hot = true;
          continue;
        }
        const label = fitLabel(hop.name, hopMaxWidth);
        const state = hop.maintenance ? "维护" : hop.offline ? "离线" : hop.tripped ? "熔断" : "";
        nodes.push({
          key,
          title: hop.name,
          label: label.text,
          sub: hop.viaTunnel ? "隧道出口" : "中转",
          hot,
          tone: hopTone(hop),
          width: Math.max(hopMinBox, Math.ceil(label.width) + 16),
          ...(state ? { sub: `${hop.viaTunnel ? "隧道出口" : "中转"} · ${state}` } : {}),
        });
      }
      // 不在走的那几台标「待命」（坏了的已经写了原因）。
      for (const node of nodes) if (!node.hot && node.tone === "ok") node.sub = `${node.sub} · 待命`;
      for (const node of nodes) if (node.hot && node.sub.endsWith("· 待命")) node.sub = node.sub.replace(" · 待命", "");
      columns.push(nodes);
    }
    const landings: DiagramNode[] = [];
    for (const path of paths) {
      const key = `d${routeDestLabel(path)}`;
      const existing = landings.find((node) => node.key === key);
      if (existing) {
        if (path.active) existing.hot = true;
        if (!path.down) existing.tone = "ok";
        continue;
      }
      // 框里写落地的名字（我的节点 / 自己的机器，没有就写地址），不只写「落地」两个字；悬停看完整地址
      const name = routeLandingName(path);
      const title = path.destName ? `${path.destName}（${routeDestLabel(path)}）` : routeDestLabel(path);
      landings.push({ key, title, label: name, sub: "", hot: !!path.active, tone: path.down ? "down" : "ok", width: 50 });
    }
    // 两个落地名字一样（同一个域名不同端口）：带上端口才分得清
    for (const node of landings) {
      const same = landings.filter((other) => other.label === node.label);
      if (same.length > 1) {
        const port = /:(\d+)$/.exec(node.title.replace(/）$/, ""))?.[1];
        if (port) node.label = `${node.label}:${port}`;
      }
    }
    // 落地拿入口、中转排完剩下的宽度（「hkboil.ddos.top」整个写得下），最多 160、最少 38
    const used = columns.reduce((sum, nodes) => sum + columnWidth(nodes), 0) + minGap * (maxHops + 1);
    const landingMaxWidth = Math.min(160, Math.max(38, RIGHT_EDGE - 2 - used - 16));
    for (const node of landings) {
      const fitted = fitLabel(node.label, landingMaxWidth);
      node.label = fitted.text;
      node.width = Math.max(50, Math.ceil(fitted.width) + 16);
    }
    columns.push(landings);

    /*
      每列的中心：入口靠左（名字长、框宽就往右挪，别被裁掉），落地那列最宽的框贴着右边，
      中转列在两者之间按框宽排，列与列之间的空一样宽。
    */
    const entryWidth = columns[0][0].width;
    const entryX = Math.max(X_ENTRY, entryWidth / 2 + 2);
    const landingWidth = columnWidth(landings);
    const landingX = RIGHT_EDGE - landingWidth / 2;
    const hopWidths = columns.slice(1, -1).map(columnWidth);
    const free = landingX - landingWidth / 2 - (entryX + entryWidth / 2) - hopWidths.reduce((sum, width) => sum + width, 0);
    const gap = free / (hopWidths.length + 1);
    const xs = [entryX];
    let cursor = entryX + entryWidth / 2;
    for (const width of hopWidths) {
      cursor += gap;
      xs.push(cursor + width / 2);
      cursor += width;
    }
    xs.push(landingX);
    return { columns, xs };
  }, [paths, status.entry?.name, status.entry?.online]);
  const layout = diagram.columns;

  const offsets = diagramRowOffsets(
    paths.map((path) => ({ hopKeys: path.hops.map((hop) => `h${hop.hostId}`) })),
    layout.map((column) => column.map((node) => node.key)),
  );
  const allOffsets = offsets.flat();
  const minOffset = Math.min(0, ...allOffsets);
  const maxOffset = Math.max(0, ...allOffsets);
  // 上下各留半行；不到 150 高时上下补齐，中间那一行（入口、落地）跟着往下挪
  const natural = 76 + (maxOffset - minOffset) * ROW_GAP;
  const height = Math.max(150, natural);
  const center = 38 + (height - natural) / 2 - minOffset * ROW_GAP;
  const hopColumns = layout.length - 2;
  const colX = (index: number) => diagram.xs[index];
  const nodeAt = (column: number, key: string) => {
    const nodes = layout[column];
    const position = Math.max(0, nodes.findIndex((node) => node.key === key));
    return { node: nodes[position], y: center + (offsets[column]?.[position] ?? 0) * ROW_GAP };
  };

  type Edge = { key: string; x1: number; y1: number; x2: number; y2: number; ms: number | null; hot: boolean };
  const edges = new Map<string, Edge>();
  for (const path of paths) {
    const stops = [
      { column: 0, key: "entry" },
      ...path.hops.map((hop, index) => ({ column: index + 1, key: `h${hop.hostId}` })),
      { column: layout.length - 1, key: `d${routeDestLabel(path)}` },
    ];
    stops.slice(1).forEach((stop, index) => {
      const from = stops[index];
      const a = nodeAt(from.column, from.key);
      const b = nodeAt(stop.column, stop.key);
      const ms = index === 0 ? path.latencyMs : path.hops[index - 1]?.latencyMs ?? null;
      const key = `${from.column}:${from.key}>${stop.column}:${stop.key}`;
      const edge: Edge = { key, x1: colX(from.column) + a.node.width / 2 - 2, y1: a.y, x2: colX(stop.column) - b.node.width / 2, y2: b.y, ms: ms ?? null, hot: !!path.active };
      const existing = edges.get(key);
      if (!existing || (edge.hot && !existing.hot)) edges.set(key, edge);
      else if (existing.ms === null && edge.ms !== null) existing.ms = edge.ms;
    });
  }
  const ordered = Array.from(edges.values()).sort((a, b) => Number(a.hot) - Number(b.hot));
  /*
    中间那一行是直线，在走的粗线从同一个点往上（或往下）拐：直线上的数字放到粗线的另一边，
    不然三条线路时「1.0」「2.0」正好压在粗线上。
  */
  const labelBelow = (edge: Edge) => {
    if (edge.hot) return false;
    const hot = ordered.find((other) => other.hot && (
      (Math.abs(other.x1 - edge.x1) < 1 && Math.abs(other.y1 - edge.y1) < 1)
      || (Math.abs(other.x2 - edge.x2) < 1 && Math.abs(other.y2 - edge.y2) < 1)
    ));
    if (!hot) return false;
    const otherY = Math.abs(hot.y1 - edge.y1) < 1 ? hot.y2 : hot.y1;
    return otherY < edge.y1;
  };
  const landingColumn = layout.length - 1;
  const total = chainLatency(active);

  return (
    <LineCard className="px-[10px] py-3" data-testid="route-line-diagram">
      <div className="relative h-4 text-[11px] text-muted-foreground">
        <span className="absolute left-1">入口</span>
        {layout.slice(1, -1).map((column, index) => {
          const tunnels = column.filter((node) => node.sub.startsWith("隧道")).length;
          const label = tunnels === column.length ? "隧道" : tunnels > 0 ? "隧道 / 中转" : "中转";
          return (
            <span key={index} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${(colX(index + 1) / DIAGRAM_WIDTH) * 100}%` }}>
              {hopColumns > 1 ? `${label} ${index + 1}` : label}
            </span>
          );
        })}
        <span className="absolute -translate-x-1/2" style={{ left: `${(colX(landingColumn) / DIAGRAM_WIDTH) * 100}%` }}>落地</span>
      </div>
      <svg viewBox={`0 0 ${DIAGRAM_WIDTH} ${height}`} width="100%" role="img" aria-label="线路分层图" className="mt-1 block">
        <g fill="none" strokeLinecap="round">
          {ordered.map((edge) => {
            const dx = (edge.x2 - edge.x1) * 0.43;
            return (
              <path
                key={edge.key}
                d={`M${edge.x1} ${edge.y1} C${edge.x1 + dx} ${edge.y1} ${edge.x2 - dx} ${edge.y2} ${edge.x2} ${edge.y2}`}
                stroke={edge.hot ? "var(--fx-accent)" : "var(--fx-stroke)"}
                strokeWidth={edge.hot ? 3 : 1.6}
                strokeDasharray={edge.hot ? undefined : "4 4"}
              />
            );
          })}
        </g>
        <g fontFamily="var(--fx-font-mono, ui-monospace, monospace)" fontSize="10" textAnchor="middle">
          {ordered.map((edge) => {
            if (edge.ms === null || edge.ms === undefined) return null;
            const straight = Math.abs(edge.y1 - edge.y2) < 1;
            const top = Math.min(edge.y1, edge.y2);
            const y = straight ? (labelBelow(edge) ? edge.y1 + 13 : edge.y1 - 6) : top < center ? top + 6 : Math.max(edge.y1, edge.y2) + 2;
            return (
              <text key={`ms-${edge.key}`} x={(edge.x1 + edge.x2) / 2} y={y} fill={edge.hot ? "var(--fx-accent)" : "var(--fx-text-muted)"} fontWeight={edge.hot ? 700 : 400}>
                {formatLineMs(Number(edge.ms))}
              </text>
            );
          })}
        </g>
        <g fontSize="11" fontFamily="var(--fx-font-mono, ui-monospace, monospace)" textAnchor="middle">
          {layout.map((column, columnIndex) => column.map((node) => {
            const x = colX(columnIndex);
            const { y } = nodeAt(columnIndex, node.key);
            const left = x - node.width / 2;
            const topY = y - BOX_HEIGHT / 2;
            return (
              <g key={`${columnIndex}-${node.key}`}>
                <title>{node.sub ? `${node.title} · ${node.sub}` : node.title}</title>
                <rect x={left} y={topY} width={node.width} height={BOX_HEIGHT} rx={7} fill="var(--fx-l1-surface)" stroke={node.hot ? "var(--fx-accent)" : "var(--fx-stroke-weak)"} strokeWidth={node.hot ? 1.6 : 1} />
                <text x={x} y={y + 4} fontWeight={node.hot ? 700 : 400} fill="var(--fx-text)">{node.label}</text>
                {node.sub ? <text x={x} y={topY + BOX_HEIGHT + 13} fontSize="9" fill="var(--fx-text-muted)" fontFamily="inherit" style={{ fontFamily: "var(--fx-font-sans, system-ui, sans-serif)" }}>{node.sub}</text> : null}
                <circle cx={left + node.width - 4} cy={topY + 2} r={3} fill={DOT_FILL[node.tone]} />
              </g>
            );
          }))}
        </g>
      </svg>
      <div className="mt-2 truncate whitespace-nowrap border-t border-dashed border-[var(--fx-stroke-weak)] pt-2 font-mono text-[11px] text-muted-foreground" data-testid="route-line-log">
        {active ? (
          <>
            {status.activeSince ? `${lineClockText(status.activeSince, timeZone)} ` : ""}
            <b className="font-semibold text-foreground">{routePathText(status, active, { tunnelPrefix: false })}</b>
            {total !== null ? <span className="text-[var(--fx-healthy-text)]"> {formatLineMs(total)} ms</span> : null}
            {" "}{modeLabel}
          </>
        ) : (
          <span>{status.agentReportedAt ? "Agent 还没报在走哪条" : "调度这条线路的 Agent 还没上报"}</span>
        )}
      </div>
    </LineCard>
  );
}
