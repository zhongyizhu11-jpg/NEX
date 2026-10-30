import { useMemo, useState } from "react";
import { Download, Gauge } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  LineBadge,
  LineBig,
  LineCard,
  LineChipButton,
  LineDot,
  LineIconButton,
  LinePath,
  LinePauseGlyph,
  LinePill,
  LinePlayGlyph,
  LineRow,
  LineSec,
  formatLineMs,
  type LineTone,
} from "@/features/lines/LineUi";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatFailoverEndpoint } from "@shared/failoverTargets";
import { describeRouteIssue, normalizeRouteDelivery, normalizeRouteEventKind, type RouteMode } from "@shared/routeGroup";
import type { RouteEvent, RouteStatus, RouteStatusHop, RouteStatusPath } from "./RouteGroupSheet";

/*
  线路详情（2.3.496，照效果图 ①「规则卡点开：线路组运行中」）：

    大数字    整条链此刻多少毫秒 + 坏了几秒内切走
    分层图    入口 → 隧道 / 中转 → 落地 → 目标，一列一层，在走的那条实线加粗、别的虚线，段上写毫秒；
              下面一行写这条是几点开始走的、整条链多少、为什么是它
    线路      主 / 备 N 一行一条：使用中 / 待命 / 不通 ×N（划掉），右边暂停
    连接      客户端 → 入口 → … → 落地，每段最近 10 分钟的成功率，坏的那段标红写原因；
              下面三个按钮：最近切换、暂停这条、异常明细（展开原来那份详细面板）

  数据都来自 rules.routeStatus / rules.routeEvents，这里只画。
*/

type Hop = RouteStatusHop;
type Path = RouteStatusPath;

const round = (value: number) => Math.round(value * 10) / 10;

/** 整条链：入口这一段（入口 Agent 探的）+ 后面各段（各中转探的）。没探到 = null。 */
export function chainLatency(path: Path | null | undefined): number | null {
  if (!path || path.latencyMs === null || path.latencyMs === undefined) return null;
  return round(Number(path.latencyMs) + Number(path.downstreamMs || 0));
}

/** 线路卡、副标题、工作台 chip 上那几个字。 */
export const ROUTE_LINE_MODE_LABEL: Record<RouteMode, string> = {
  failover: "主备顺序",
  smart: "整链最优",
  weighted: "按权重",
  scheduled: "按时段",
  hybrid: "按时段 · 择优",
  manual: "人工指定",
};

/** 坏了几秒内切走：异常持续够久才切，最少按 5 秒说（探测本身也要一轮）。 */
export function routeSwitchSeconds(policy: { failoverSeconds?: number | null } | null | undefined) {
  return Math.max(5, Math.round(Number(policy?.failoverSeconds || 0)));
}

/** 「线路」那一行右边：这条规则按什么切。 */
export function routeLineSwitchSummary(status: RouteStatus) {
  if (normalizeRouteDelivery(status.delivery) === "aggregate") return "主线路那组一起分担";
  const back = status.policy.autoFailback === false ? "不自动切回" : "恢复后切回";
  switch (status.policy.mode) {
    case "weighted": return "按权重分 · 坏了先跳过";
    case "smart": return `挑整链最快的 · ${back}`;
    case "scheduled":
    case "hybrid": return "按时段首选 · 坏了往下切";
    case "manual": return "走指定那条 · 坏了临时切";
    default: return `按顺序切换 · ${back}`;
  }
}

export type RouteLineGroup = {
  key: string;
  /** 0 = 主线路，1.. = 备 N */
  index: number;
  name: string;
  paths: Path[];
  /** 行上画哪一条：在走的那条，没有就第一条。 */
  shown: Path;
  active: boolean;
  paused: boolean;
  allDown: boolean;
  reason: string;
  failures: number;
};

/** 同一条线路展开的几条路径算一行，按线路顺序（tier）排。 */
export function routeLineGroups(status: RouteStatus): RouteLineGroup[] {
  const groups: Array<Omit<RouteLineGroup, "index" | "shown" | "active" | "paused" | "allDown" | "reason" | "failures"> & { tier: number }> = [];
  for (const path of status.paths) {
    const key = path.lineKey || path.key;
    let group = groups.find((item) => item.key === key);
    if (!group) {
      group = { key, name: path.name, tier: typeof path.tier === "number" ? path.tier : groups.length, paths: [] };
      groups.push(group);
    }
    group.paths.push(path);
  }
  return groups
    .sort((a, b) => a.tier - b.tier)
    .map((group, index) => {
      const activePath = group.paths.find((path) => path.active) || null;
      const allDown = group.paths.every((path) => path.down);
      return {
        key: group.key,
        index,
        name: group.name,
        paths: group.paths,
        shown: activePath || group.paths[0],
        active: !!activePath,
        paused: group.paths.every((path) => !!path.paused),
        allDown,
        reason: group.paths.find((path) => path.downReason)?.downReason || "",
        failures: Math.max(0, ...group.paths.map((path) => Number(path.consecutiveFailures || 0))),
      };
    });
}

export function lineBadgeText(index: number) {
  return index === 0 ? "主" : `备 ${index}`;
}

export function lineLongName(index: number) {
  return index === 0 ? "主线路" : `备 ${index}`;
}

/** 行上的那条链：Po0 → 隧道 Jinx → 落地。 */
export function routePathText(status: RouteStatus, path: Path, options: { tunnelPrefix?: boolean } = {}) {
  const hops = path.hops.map((hop) => (hop.viaTunnel && options.tunnelPrefix !== false ? `隧道 ${hop.name}` : hop.name));
  return [status.entry?.name || "入口", ...hops, "落地"].join(" → ");
}

function destLabel(path: Path) {
  return path.dest?.ip ? formatFailoverEndpoint(path.dest.ip, path.dest.port) : "规则目标";
}

/** 副标题：整链最优 · 3 条线路 · 1 条故障已避开。 */
export function routeLineSubtitle(status: RouteStatus | null, mode: RouteMode) {
  const parts = [ROUTE_LINE_MODE_LABEL[mode] || ROUTE_LINE_MODE_LABEL.failover];
  if (!status) return parts.join(" · ");
  const groups = routeLineGroups(status);
  parts.push(`${groups.length} 条线路`);
  const down = groups.filter((group) => group.allDown && !group.paused).length;
  const anyActive = groups.some((group) => group.active);
  if (down > 0) parts.push(anyActive ? `${down} 条故障已避开` : `${down} 条故障`);
  const paused = groups.filter((group) => group.paused).length;
  if (paused > 0) parts.push(`${paused} 条暂停`);
  return parts.join(" · ");
}

function clockText(ms: number, timeZone?: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone }).format(new Date(ms));
  } catch {
    return new Date(ms).toTimeString().slice(0, 8);
  }
}

function shortClock(ms: number, timeZone?: string) {
  return clockText(ms, timeZone).slice(0, 5);
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

// ---------------------------------------------------------------- 大数字

export function RouteLineHero({ status }: { status: RouteStatus }) {
  const active = status.paths.find((path) => path.active) || status.paths[0];
  const total = chainLatency(active);
  return (
    <LineCard
      className="grid grid-cols-[1fr_auto_1fr] items-end gap-1.5 border-l-[3px] border-l-[var(--fx-accent)] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--fx-accent)_7%,var(--fx-l1-surface)),var(--fx-l1-surface))]"
      data-testid="route-line-hero"
    >
      <div className="min-w-0">
        {total === null ? <LineBig value={<span className="font-sans text-[22px] font-semibold tracking-normal text-muted-foreground">未测</span>} /> : <LineBig value={formatLineMs(total)} unit="ms" />}
        <div className="mt-1 text-[11.5px] text-muted-foreground">整链延迟（测到落地）</div>
      </div>
      <div aria-hidden className="pb-4 text-[20px] text-[var(--fx-accent)]">+</div>
      <div className="min-w-0 text-right">
        <LineBig value={routeSwitchSeconds(status.policy)} unit="s 内" />
        <div className="mt-1 text-[11.5px] text-muted-foreground">故障自动切走</div>
      </div>
    </LineCard>
  );
}

// ---------------------------------------------------------------- 分层图

type DiagramNode = { key: string; label: string; sub: string; hot: boolean; tone: "ok" | "warn" | "down"; width: number };

const DIAGRAM_WIDTH = 350;
const ROW_GAP = 74;
const BOX_HEIGHT = 26;
const X_ENTRY = 26;
const X_LANDING = 271;
const X_TARGET = 334;

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

export function RouteLineDiagram({ status, modeLabel, timeZone }: { status: RouteStatus; modeLabel: string; timeZone?: string }) {
  const paths = status.paths;
  const active = paths.find((path) => path.active) || null;
  const layout = useMemo(() => {
    const maxHops = Math.max(0, ...paths.map((path) => path.hops.length));
    const columns: DiagramNode[][] = [];
    const entryLabel = fitLabel(status.entry?.name || "入口", 64);
    columns.push([{
      key: "entry",
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
        const label = fitLabel(hop.name, 72);
        const state = hop.maintenance ? "维护" : hop.offline ? "离线" : hop.tripped ? "熔断" : "";
        nodes.push({
          key,
          label: label.text,
          sub: hop.viaTunnel ? "隧道出口" : "中转",
          hot,
          tone: hopTone(hop),
          width: Math.max(50, Math.ceil(label.width) + 16),
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
      const key = `d${destLabel(path)}`;
      const existing = landings.find((node) => node.key === key);
      if (existing) {
        if (path.active) existing.hot = true;
        if (!path.down) existing.tone = "ok";
        continue;
      }
      landings.push({ key, label: "落地", sub: "", hot: !!path.active, tone: path.down ? "down" : "ok", width: 50 });
    }
    if (landings.length > 1) landings.forEach((node, index) => { node.label = `落地 ${index + 1}`; node.width = 58; });
    columns.push(landings);
    return columns;
  }, [paths, status.entry?.name, status.entry?.online]);

  const maxRows = Math.max(1, ...layout.map((column) => column.length));
  const height = Math.max(150, 76 + (maxRows - 1) * ROW_GAP);
  const center = height / 2;
  const hopColumns = layout.length - 2;
  // 入口名字长（Po0(200M)）时框更宽：往右挪，别让左边被裁掉。
  const entryX = Math.max(X_ENTRY, layout[0][0].width / 2 + 2);
  const colX = (index: number) => {
    if (index === 0) return entryX;
    if (index === layout.length - 1) return X_LANDING;
    if (hopColumns === 1) return Math.max(153, entryX + 92);
    return entryX + ((X_LANDING - entryX) * index) / (hopColumns + 1);
  };
  const nodeAt = (column: number, key: string) => {
    const nodes = layout[column];
    const position = Math.max(0, nodes.findIndex((node) => node.key === key));
    return { node: nodes[position], y: center + (position - (nodes.length - 1) / 2) * ROW_GAP };
  };

  type Edge = { key: string; x1: number; y1: number; x2: number; y2: number; ms: number | null; hot: boolean };
  const edges = new Map<string, Edge>();
  for (const path of paths) {
    const stops = [
      { column: 0, key: "entry" },
      ...path.hops.map((hop, index) => ({ column: index + 1, key: `h${hop.hostId}` })),
      { column: layout.length - 1, key: `d${destLabel(path)}` },
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
        <span className="absolute -translate-x-1/2" style={{ left: `${(X_LANDING / DIAGRAM_WIDTH) * 100}%` }}>落地</span>
        <span className="absolute right-1">目标</span>
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
          {layout[landingColumn].map((node) => {
            const { y } = nodeAt(landingColumn, node.key);
            return (
              <path
                key={`t-${node.key}`}
                d={`M${X_LANDING + node.width / 2} ${y} C${X_LANDING + node.width / 2 + 14} ${y} ${X_TARGET - 20} ${center} ${X_TARGET - 8} ${center}`}
                stroke={node.hot ? "var(--fx-accent)" : "var(--fx-stroke)"}
                strokeWidth={node.hot ? 3 : 1.6}
                strokeDasharray={node.hot ? undefined : "4 4"}
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
                <rect x={left} y={topY} width={node.width} height={BOX_HEIGHT} rx={7} fill="var(--fx-l1-surface)" stroke={node.hot ? "var(--fx-accent)" : "var(--fx-stroke-weak)"} strokeWidth={node.hot ? 1.6 : 1} />
                <text x={x} y={y + 4} fontWeight={node.hot ? 700 : 400} fill="var(--fx-text)">{node.label}</text>
                {node.sub ? <text x={x} y={topY + BOX_HEIGHT + 13} fontSize="9" fill="var(--fx-text-muted)" fontFamily="inherit" style={{ fontFamily: "var(--fx-font-sans, system-ui, sans-serif)" }}>{node.sub}</text> : null}
                <circle cx={left + node.width - 4} cy={topY + 2} r={3} fill={DOT_FILL[node.tone]} />
              </g>
            );
          }))}
          <circle cx={X_TARGET} cy={center} r={7} fill="var(--fx-l1-surface)" stroke={active ? "var(--fx-accent)" : "var(--fx-stroke)"} strokeWidth={1.6} />
        </g>
      </svg>
      <div className="mt-2 truncate whitespace-nowrap border-t border-dashed border-[var(--fx-stroke-weak)] pt-2 font-mono text-[11px] text-muted-foreground" data-testid="route-line-log">
        {active ? (
          <>
            {status.activeSince ? `${clockText(status.activeSince, timeZone)} ` : ""}
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

// ---------------------------------------------------------------- 线路

export function RouteLineList({ status, onPause, pausing = false }: { status: RouteStatus; onPause?: (lineKey: string, paused: boolean) => void; pausing?: boolean }) {
  const groups = routeLineGroups(status);
  return (
    <div className="flex flex-col gap-[7px]" data-testid="route-line-list">
      {groups.map((group) => {
        const bad = (group.allDown && !group.active) || group.paused;
        const pill: { tone: LineTone; text: string; dot?: boolean } = group.paused
          ? { tone: "gray", text: "已暂停" }
          : group.active
            ? { tone: "ok", text: "使用中", dot: true }
            : group.allDown
              ? { tone: "down", text: group.failures >= 2 ? `不通 ×${group.failures}` : group.reason ? shortIssue(group.reason) : "不通" }
              : { tone: "gray", text: "待命" };
        const text = routePathText(status, group.shown);
        return (
          <LineRow key={group.key} on={group.active} data-testid="route-line-row">
            <LineBadge main={group.index === 0}>{lineBadgeText(group.index)}</LineBadge>
            <LinePath bad={bad} title={`${group.name}：${text} · ${destLabel(group.shown)}${group.paths.length > 1 ? `（这条线路组合出 ${group.paths.length} 条路径）` : ""}`}>
              {text}
            </LinePath>
            <LinePill tone={pill.tone} dot={pill.dot} title={group.allDown && group.reason ? describeRouteIssue(group.reason) : undefined}>{pill.text}</LinePill>
            {onPause ? (
              <LineIconButton
                aria-label={group.paused ? `恢复线路 ${group.name}` : `暂停线路 ${group.name}`}
                title={group.paused ? "恢复这条" : "暂停这条"}
                disabled={pausing}
                onClick={() => onPause(group.key, !group.paused)}
              >
                {group.paused ? <LinePlayGlyph /> : <LinePauseGlyph />}
              </LineIconButton>
            ) : null}
          </LineRow>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- 连接 · 按段

type Stage = { label: string; pct: number | null; why: string | null };

export function routeStages(status: RouteStatus, path: Path): { nodes: string[]; stages: Stage[] } {
  const nodes = ["客户端", status.entry?.name || "入口", ...path.hops.map((hop) => hop.name), "落地"];
  const inbound = status.inbound && status.inbound.ok + status.inbound.failed > 0 ? round((status.inbound.ok / (status.inbound.ok + status.inbound.failed)) * 100) : null;
  const dials = path.dials;
  const first = dials && dials.ok + dials.failed > 0 ? round((dials.ok / (dials.ok + dials.failed)) * 100) : null;
  const why = (pct: number | null, failing: boolean) => (failing ? "连不上" : pct !== null && pct < 95 ? "建连失败多" : null);
  const firstLabel = path.hops.length === 0 ? "落地拨号" : path.hops[0].viaTunnel ? "隧道" : "中转";
  const stages: Stage[] = [
    { label: "入站", pct: inbound, why: inbound !== null && inbound < 95 ? "拨不通路径" : null },
    { label: firstLabel, pct: first, why: why(first, false) },
    ...path.hops.map((hop, index) => {
      const next = path.hops[index + 1];
      const pct = hop.successPct ?? null;
      return { label: next ? (next.viaTunnel ? "隧道" : "中转") : "落地拨号", pct, why: why(pct, hop.ok === false && (hop.consecutiveFailures || 0) >= 2) };
    }),
  ];
  return { nodes, stages };
}

function stageTone(stage: Stage): "ok" | "warn" | "down" | "none" {
  if (stage.pct === null) return stage.why ? "down" : "none";
  if (stage.why || stage.pct < 80) return "down";
  if (stage.pct < 95) return "warn";
  return "ok";
}

export function RouteStageStrip({ status }: { status: RouteStatus }) {
  const path = status.paths.find((item) => item.active) || status.paths[0];
  if (!path) return null;
  const { nodes, stages } = routeStages(status, path);
  return (
    <div className="flex min-w-0 items-end text-[11px]" data-testid="route-stage-strip">
      {nodes.map((node, index) => (
        <div key={index} className="contents">
          <span className="max-w-[4.75rem] shrink-0 truncate whitespace-nowrap rounded-[8px] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] px-[6px] py-[5px] font-mono text-[10.5px]">{node}</span>
          {index < stages.length ? (() => {
            const stage = stages[index];
            const tone = stageTone(stage);
            return (
              <div className="min-w-0 flex-1 px-[2px] text-center">
                <div className="truncate text-[9.5px] text-muted-foreground">{stage.label}</div>
                <div className={cn("font-mono font-bold", tone === "down" ? "text-[var(--fx-down-text)]" : tone === "warn" ? "text-[var(--fx-warn-text)]" : tone === "ok" ? "text-[var(--fx-healthy-text)]" : "text-muted-foreground")}>
                  {stage.pct === null ? "—" : `${stage.pct}%`}
                </div>
                <div className={cn(
                  "mx-[2px] mb-[9px] mt-[3px] h-[2px] rounded-[2px]",
                  tone === "down" ? "bg-[repeating-linear-gradient(90deg,var(--fx-down-text)_0_5px,transparent_5px_8px)]" : tone === "warn" ? "bg-[var(--fx-warn-text)]" : tone === "ok" ? "bg-[var(--fx-healthy-text)]" : "bg-[var(--fx-stroke-weak)]",
                )} />
                <div className="-mt-[6px] h-0 whitespace-nowrap text-[9.5px] text-[var(--fx-down-text)]">{tone === "down" ? stage.why : ""}</div>
              </div>
            );
          })() : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 最近切换（底部第一个 chip）

/** 最近一次切换说成一句：19:31 切到 备 1 · 19:36 已切回 / 19:31 自动切到 备 1 / 24 小时没切过。 */
export function routeSwitchChip(status: RouteStatus, events: RouteEvent[], nowMs: number, timeZone?: string): { tone: LineTone; text: string } {
  const groups = routeLineGroups(status);
  const lineOf = (key: string | null) => {
    if (!key) return -1;
    const group = groups.find((item) => item.paths.some((path) => path.key === key) || item.key === key);
    return group ? group.index : -1;
  };
  const switches = events
    .filter((event) => normalizeRouteEventKind(event.kind) === "switch" && nowMs - event.at <= 24 * 3600_000)
    .sort((a, b) => b.at - a.at);
  const activeLine = groups.find((group) => group.active)?.index ?? -1;
  const latest = switches[0];
  if (!latest) return { tone: "ok", text: activeLine > 0 ? `在走 ${lineLongName(activeLine)}` : "24 小时没切过" };
  const manual = /^pin|panel:/i.test(String(latest.reason || ""));
  const to = lineOf(latest.toKey);
  if (activeLine > 0 && to === activeLine) {
    return { tone: "warn", text: `${shortClock(latest.at, timeZone)} ${manual ? "手动" : "自动"}切到 ${lineLongName(activeLine)}` };
  }
  if (activeLine === 0 && to === 0) {
    const away = switches.find((event) => event.at < latest.at && lineOf(event.toKey) > 0);
    if (away) return { tone: "ok", text: `${shortClock(away.at, timeZone)} 切到 ${lineLongName(lineOf(away.toKey))} · ${shortClock(latest.at, timeZone)} 已切回` };
    return { tone: "ok", text: `${shortClock(latest.at, timeZone)} 换到 主线路` };
  }
  return { tone: "ok", text: `${shortClock(latest.at, timeZone)} 切到 ${to >= 0 ? lineLongName(to) : latest.toLabel || "另一条"}` };
}

// ---------------------------------------------------------------- 整屏

export function RouteLineDetail({
  status,
  events,
  modeLabel,
  onPause,
  pausing = false,
  detailsOpen,
  onToggleDetails,
  nowMs,
  timeZone,
}: {
  status: RouteStatus;
  events: RouteEvent[];
  modeLabel: string;
  onPause?: (lineKey: string, paused: boolean) => void;
  pausing?: boolean;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  nowMs?: number;
  timeZone?: string;
}) {
  const now = nowMs ?? Date.now();
  const groups = routeLineGroups(status);
  const activeGroup = groups.find((group) => group.active) || null;
  const pausable = !!activeGroup && !activeGroup.paused && groups.filter((group) => !group.paused).length > 1;
  const chip = routeSwitchChip(status, events, now, timeZone);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="route-line-overview">
      <RouteLineHero status={status} />
      <RouteLineDiagram status={status} modeLabel={modeLabel} timeZone={timeZone} />
      <div>
        <LineSec left="线路" right={routeLineSwitchSummary(status)} />
        <RouteLineList status={status} onPause={onPause} pausing={pausing} />
      </div>
      <div>
        <LineSec left="连接 · 最近 10 分钟" right={<span title="入站：客户端连进来后拨通一条路径的比例；第二段：入口真实拨号的成功率；后面每段：中转探下一跳（近 20 次）">精确到哪一段</span>} />
        <LineCard className="px-2 py-3">
          <RouteStageStrip status={status} />
          <div className="mt-4 flex flex-wrap gap-1.5">
            <span className="inline-flex items-center gap-[5px] rounded-full border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] px-[10px] py-[5px] text-[11.5px]" data-testid="route-line-switch-chip">
              <LineDot tone={chip.tone} />{chip.text}
            </span>
            {onPause ? (
              <LineChipButton
                disabled={!pausable || pausing}
                title={pausable ? `暂停 ${lineLongName(activeGroup!.index)}，马上切到下一条` : "没有别的线路可切，不能暂停"}
                onClick={() => {
                  if (!activeGroup) return;
                  onPause(activeGroup.key, true);
                }}
                data-testid="route-line-pause-active"
              >
                暂停这条
              </LineChipButton>
            ) : null}
            <LineChipButton variant={detailsOpen ? "sel" : "default"} aria-expanded={detailsOpen} onClick={onToggleDetails} data-testid="route-line-details">
              异常明细
            </LineChipButton>
          </div>
        </LineCard>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 暂停、导出、逐段测带宽

/** 线路组弹窗里暂停 / 恢复一条线路。 */
export function useRouteLinePause(ruleId: number) {
  const utils = trpc.useUtils();
  const pause = trpc.lineDiagnostics.linePause.useMutation({
    onSuccess: (_data, variables) => {
      void utils.rules.routeStatus.invalidate({ ruleId });
      void utils.rules.routeEvents.invalidate({ ruleId });
      void utils.rules.routeBoard.invalidate();
      toast.success(variables.paused ? "已暂停，在走它的连接马上切到下一条" : "已恢复，探通后重新参与");
    },
    onError: (error) => toast.error(error.message),
  });
  return { onPause: (lineKey: string, paused: boolean) => pause.mutate({ ruleId, lineKey, paused }), pausing: pause.isPending };
}

export function RouteLineTools({ status }: { status: RouteStatus }) {
  const utils = trpc.useUtils();
  const [runId, setRunId] = useState<string | null>(null);
  const active = status.paths.find((path) => path.active) || status.paths[0];
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
