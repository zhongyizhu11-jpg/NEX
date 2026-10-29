import type { ReactNode } from "react";

import { EntityTag } from "@/components/entity/EntityCard";
import { cn } from "@/lib/utils";
import { formatAgo } from "@shared/dashboardAttention";
import { formatFailoverEndpoint } from "@shared/failoverTargets";
import { formatBytes } from "@shared/formatBytes";
import type { NetworkHealth } from "@shared/networkHealth";
import { ROUTE_MODE_INFO, routeWeightShares } from "@shared/routeGroup";
import { formatRouteScore, routeScoreGrade } from "@shared/routeScore";
import type { RoutePolicy } from "@shared/routePolicy";
import type { RouteSwitchSummary } from "@shared/routeSwitchSummary";

/*
  线路板：一条线路组画成几张「路径卡」，每张卡是一条链 —— 入口 ─ 中转… ─ 落地。

  原来的线路面板按行列：第 1 跳 · SG relay 03 · 中继 :25310 · 18ms，一行一跳，读得出、看不出。
  一条链最要紧的是「哪一段慢、哪一段断」，那得把段画出来：节点是方块，段是节点之间的线，
  线中间一枚药丸写这一段的延迟 —— 测到的写数字，没测到的写「未测」并染琥珀（说清楚这是不
  知道，不是通），断了的写「不通 ×3」染红。整条链的延迟是各段相加，有一段没测就写「≥」。

  每个节点下面写它此刻的速率：入口是这条规则的，中转是那台机上中继规则的，落地写最后一段的。
  只有流量真走的那条路径有数，备用路径写「空闲」—— 权重负载例外，每条都在走。

  在走的那条线上有两颗从左往右走的小点（和规则卡的路径条一个意思：有流量）。
  手机上（容器窄于 560px）链竖着排：节点一个接一个，段变成短竖线。
*/

export type RouteBoardRate = { inBps: number; outBps: number; connections: number; at: number } | null;

export type RouteBoardHop = {
  hostId: number;
  name: string;
  port: number | null;
  running: boolean | null;
  enabled: boolean | null;
  ok: boolean | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  probedAt: number | null;
  nextLabel: string | null;
  rate?: RouteBoardRate;
};

export type RouteBoardPath = {
  key: string;
  index: number;
  letter: string;
  name: string;
  hops: RouteBoardHop[];
  dest: { ip: string; port: number };
  probe: { ip: string; port: number } | null;
  weight: number;
  score: number | null;
  latencyMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  availabilityPct: number | null;
  healthy: boolean | null;
  down: boolean;
  downReason: string;
  connections: number | null;
  active: boolean;
  prewarming: boolean;
  probedAt?: number | null;
  /** 真实连接最近 10 分钟的拨号：成功 / 失败 / 慢、耗时折半均值；老 Agent 没有。 */
  dials?: { ok: number; failed: number; slow: number; dialMs: number; lastAt: number } | null;
};

/** 「建连 120 · 失败 3 · 慢 2 · 拨号 28ms」：有失败或慢的染琥珀，什么都没拨过不显示。 */
export function describeRouteDials(dials: RouteBoardPath["dials"]): { text: string; tone: "ok" | "warn" | "off"; title: string } | null {
  if (!dials || (dials.ok === 0 && dials.failed === 0)) return null;
  const parts = [`建连 ${dials.ok}`];
  if (dials.failed > 0) parts.push(`失败 ${dials.failed}`);
  if (dials.slow > 0) parts.push(`慢 ${dials.slow}`);
  if (dials.dialMs > 0) parts.push(`拨号 ${dials.dialMs} ms`);
  const bad = dials.failed > 0 || dials.slow > 0;
  return {
    text: parts.join(" · "),
    tone: bad ? "warn" : dials.ok > 0 ? "ok" : "off",
    title: `最近 10 分钟真实连接的拨号：拨通 ${dials.ok} 次${dials.failed > 0 ? `、拨不通 ${dials.failed} 次` : ""}${dials.slow > 0 ? `、拨得慢 ${dials.slow} 次（比探测延迟慢 3 倍以上）` : ""}${dials.dialMs > 0 ? `；拨号耗时约 ${dials.dialMs} ms` : ""}。拨不通和连续拨得慢都算一次失败，参与切换判定。`,
  };
}

export type RouteBoardEntry = { hostId: number; name: string; online: boolean | null; sourcePort: number };

/** 一段：from → to，延迟从哪来、通不通。 */
export type RouteSegment = {
  key: string;
  latencyMs: number | null;
  /** measured 测到的；failed 探不通；unknown 还没人探这一段（中继没报、没建中继、老 Agent）。 */
  state: "measured" | "failed" | "unknown";
  failures: number;
  /** Unix 毫秒 */
  at: number | null;
  /** 鼠标放上去那句：谁测的、测的是谁。 */
  title: string;
};

export type RouteChainSummary = {
  segments: RouteSegment[];
  /** 各段相加；有段没测时是已测段之和（partial = true）。 */
  totalMs: number | null;
  partial: boolean;
  broken: boolean;
};

const round = (value: number) => Math.round(value);

/**
 * 把一条路径拆成段。第一段是入口探拨号地址（第一跳中继的入口，没中转时就是落地）的结果；
 * 后面每一段是那台中转探它下一跳的结果。自定探测目标时入口探的不是第一跳，第一段算没测，
 * 整条链用入口探到的那个数。
 */
export function summarizeRouteChain(path: Pick<RouteBoardPath, "hops" | "latencyMs" | "probe" | "healthy" | "down" | "probedAt">): RouteChainSummary {
  const segments: RouteSegment[] = [];
  const firstTo = path.hops[0]?.name || "落地";
  const entryFailed = path.healthy === false || path.down;
  if (path.probe) {
    segments.push({ key: "entry", latencyMs: null, state: "unknown", failures: 0, at: null, title: `入口探的是自定目标 ${formatFailoverEndpoint(path.probe.ip, path.probe.port)}，不是 ${firstTo}` });
  } else if (path.latencyMs !== null && !entryFailed) {
    segments.push({ key: "entry", latencyMs: path.latencyMs, state: "measured", failures: 0, at: path.probedAt ?? null, title: `入口探 ${firstTo}` });
  } else if (entryFailed) {
    segments.push({ key: "entry", latencyMs: null, state: "failed", failures: 0, at: path.probedAt ?? null, title: `入口到 ${firstTo} 不通` });
  } else {
    segments.push({ key: "entry", latencyMs: null, state: "unknown", failures: 0, at: null, title: `入口还没探 ${firstTo}` });
  }
  path.hops.forEach((hop, index) => {
    const to = hop.nextLabel || path.hops[index + 1]?.name || "落地";
    if (hop.ok === true && hop.latencyMs !== null) {
      segments.push({ key: `hop-${index}`, latencyMs: hop.latencyMs, state: "measured", failures: 0, at: hop.probedAt, title: `${hop.name} 探 ${to}` });
    } else if (hop.ok === false) {
      segments.push({ key: `hop-${index}`, latencyMs: null, state: "failed", failures: hop.consecutiveFailures, at: hop.probedAt, title: `${hop.name} 到 ${to} 连续 ${hop.consecutiveFailures} 次不通` });
    } else {
      segments.push({ key: `hop-${index}`, latencyMs: null, state: "unknown", failures: 0, at: null, title: hop.port ? `${hop.name} 还没报它到 ${to} 的探测` : `${hop.name} 上的中继还没建好` });
    }
  });
  const measured = segments.filter((segment) => segment.state === "measured");
  const broken = segments.some((segment) => segment.state === "failed");
  let totalMs: number | null = measured.length > 0 ? measured.reduce((sum, segment) => sum + (segment.latencyMs || 0), 0) : null;
  let partial = measured.length !== segments.length;
  // 自定探测目标：入口探到的那个数就是整条链（或者至少是到探测目标）的延迟。
  if (path.probe && path.latencyMs !== null && !entryFailed) {
    totalMs = path.latencyMs;
    partial = false;
  }
  return { segments, totalMs, partial, broken };
}

export function formatRate(bps: number) {
  return `${formatBytes(Math.max(0, bps))}/s`;
}

function RateLine({ rate, idle }: { rate: RouteBoardRate | undefined; idle: boolean }) {
  if (idle) return <span className="fx-rb-rate fx-rb-rate-idle">空闲</span>;
  if (!rate) return <span className="fx-rb-rate fx-rb-rate-idle">—</span>;
  return (
    <span className="fx-rb-rate" title={`${rate.connections} 个连接 · ${formatAgo(Date.now() - rate.at)}报的`}>
      <span>↓ {formatRate(rate.inBps)}</span>
      <span>↑ {formatRate(rate.outBps)}</span>
    </span>
  );
}

function pathHealth(path: RouteBoardPath): NetworkHealth {
  if (path.down) return "down";
  if (path.prewarming) return "switching";
  if (path.healthy === null) return path.active ? "healthy" : "unknown";
  if (!path.healthy) return "degraded";
  return path.active ? "healthy" : "standby";
}

function hopHealth(hop: RouteBoardHop): NetworkHealth {
  if (hop.enabled === false || hop.running === false) return "down";
  if (hop.ok === false) return hop.consecutiveFailures >= 3 ? "down" : "degraded";
  if (hop.ok === true) return "healthy";
  return "unknown";
}

function Node({ role, name, caption, health, rate, idle, title }: {
  role: "entry" | "relay" | "landing";
  name: ReactNode;
  caption: ReactNode;
  health: NetworkHealth;
  rate: RouteBoardRate | undefined;
  idle: boolean;
  title?: string;
}) {
  return (
    <div className="fx-rb-node" data-role={role} data-health={health} title={title}>
      <span className="fx-rb-node-head">
        <i aria-hidden="true" />
        <b>{name}</b>
      </span>
      <span className="fx-rb-node-caption">{caption}</span>
      <RateLine rate={rate} idle={idle} />
    </div>
  );
}

function Segment({ segment, flowing }: { segment: RouteSegment; flowing: boolean }) {
  const label = segment.state === "measured"
    ? `${round(segment.latencyMs || 0)} ms`
    : segment.state === "failed"
      ? `不通${segment.failures > 0 ? ` ×${segment.failures}` : ""}`
      : "未测";
  return (
    <div className="fx-rb-link" data-state={segment.state} data-flowing={flowing ? "" : undefined} title={segment.title}>
      {flowing ? (<><i className="fx-rb-flow" /><i className="fx-rb-flow" /></>) : null}
      <span className="fx-rb-badge">{label}</span>
    </div>
  );
}

export function RoutePathCard({ path, entry, ruleRate = null, share, preferred, weighted, className, onOpen }: {
  path: RouteBoardPath;
  entry: RouteBoardEntry | null;
  /** 整条规则的速率：入口节点写它；没中转时落地也写它。 */
  ruleRate?: RouteBoardRate;
  share?: number | null;
  preferred?: boolean;
  weighted?: boolean;
  className?: string;
  onOpen?: () => void;
}) {
  const chain = summarizeRouteChain(path);
  const health = pathHealth(path);
  // 在走的那条（权重负载：每条）才有流量；别的写「空闲」。
  const carrying = path.active || !!weighted;
  const lastHopRate = path.hops.length > 0 ? path.hops[path.hops.length - 1].rate ?? null : ruleRate;
  const entryOffline = entry?.online === false;
  const segments = chain.segments;
  const nodes: ReactNode[] = [];
  nodes.push(
    <Node
      key="entry"
      role="entry"
      name={entry?.name || "入口"}
      caption={<>入口{entry?.sourcePort ? <> · <span className="font-mono">:{entry.sourcePort}</span></> : null}{entryOffline ? " · 离线" : ""}</>}
      health={entryOffline ? "down" : carrying ? "healthy" : "standby"}
      rate={ruleRate}
      idle={!carrying}
    />,
  );
  path.hops.forEach((hop, index) => {
    nodes.push(<Segment key={`seg-${index}`} segment={segments[index]} flowing={carrying && !chain.broken && health !== "down"} />);
    nodes.push(
      <Node
        key={`hop-${index}`}
        role="relay"
        name={hop.name}
        caption={<>中转{hop.port ? <> · 中继 <span className="font-mono">:{hop.port}</span></> : " · 中继还没建好"}{hop.enabled === false ? " · 已停用" : hop.running === false ? " · 没在跑" : ""}</>}
        health={hopHealth(hop)}
        rate={hop.rate}
        idle={!carrying}
      />,
    );
  });
  nodes.push(<Segment key="seg-last" segment={segments[segments.length - 1]} flowing={carrying && !chain.broken && health !== "down"} />);
  nodes.push(
    <Node
      key="landing"
      role="landing"
      name="落地"
      caption={<span className="font-mono">{formatFailoverEndpoint(path.dest.ip, path.dest.port) || "同规则目标"}</span>}
      health={path.down ? "down" : path.healthy === false ? "degraded" : carrying ? "healthy" : "standby"}
      rate={lastHopRate}
      idle={!carrying}
    />,
  );
  const totalLabel = chain.totalMs === null ? "整链 —" : `整链 ${chain.partial ? "≥ " : ""}${round(chain.totalMs)} ms`;
  const grade = routeScoreGrade(path.score);
  const dials = describeRouteDials(path.dials);
  return (
    <section className={cn("fx-rb-path", className)} data-health={health} data-active={path.active ? "" : undefined} data-testid="route-path-card">
      <header className="fx-rb-path-head">
        <span className="fx-rb-path-title">
          <span className="fx-rb-letter">{path.letter}</span>
          <b className="truncate">{path.name}</b>
          {path.active ? <EntityTag tone="path">在走</EntityTag> : null}
          {path.prewarming ? <EntityTag tone="path">预热中</EntityTag> : null}
          {preferred && !path.active ? <EntityTag>首选</EntityTag> : null}
          {!path.active && !path.down && !weighted ? <EntityTag tone="standby">备用</EntityTag> : null}
          {weighted && typeof share === "number" ? <EntityTag tone="standby">{share}%</EntityTag> : null}
          {path.down ? <span className="fx-rule-tag" data-tone="down" title={path.downReason}>断了{path.downReason ? ` · ${path.downReason}` : ""}</span> : null}
        </span>
        <span className="fx-rb-path-stats">
          <span className="fx-rb-chip" data-tone={chain.broken ? "down" : chain.partial && chain.totalMs !== null ? "warn" : chain.totalMs === null ? "off" : "ok"} title={chain.partial ? "有一段还没测到，这是已测各段相加" : "各段延迟相加"}>
            {totalLabel}
          </span>
          {path.score !== null ? (
            <span className={cn("fx-rb-score", `fx-rb-score-${grade.tone}`)} data-testid="route-score">{formatRouteScore(path.score)}</span>
          ) : null}
          {path.lossPct !== null && path.lossPct > 0 ? <span className="fx-rb-meta">丢包 {path.lossPct.toFixed(1)}%</span> : null}
          {path.availabilityPct !== null && path.availabilityPct < 100 ? <span className="fx-rb-meta">可用 {path.availabilityPct.toFixed(1)}%</span> : null}
          {path.connections !== null && path.connections > 0 ? <span className="fx-rb-meta">{path.connections} 连接</span> : null}
          {dials ? <span className="fx-rb-chip" data-tone={dials.tone} title={dials.title} data-testid="route-dials">{dials.text}</span> : null}
          {onOpen ? <button type="button" className="fx-rb-open" onClick={onOpen}>详情</button> : null}
        </span>
      </header>
      <div className="fx-rb-chain">{nodes}</div>
    </section>
  );
}

/** 卡片头上那枚「24h 切换 ×N」。 */
export function RouteSwitchChip({ switches, className }: { switches: RouteSwitchSummary; className?: string }) {
  if (switches.count24h === 0) return <span className={cn("fx-rb-chip", className)} data-tone="off">24h 没切过</span>;
  const title = [
    switches.lastAt ? `最近一次 ${formatAgo(Date.now() - switches.lastAt)}${switches.lastFromLabel && switches.lastToLabel ? `：${switches.lastFromLabel} → ${switches.lastToLabel}` : ""}` : "",
    switches.manual24h > 0 ? `其中人工指定 ${switches.manual24h} 次` : "",
    switches.flapping ? "一小时内切了好几次 / 切出去又切回来：线路在来回漂，看看切换保护" : "",
  ].filter(Boolean).join("\n");
  return (
    <span className={cn("fx-rb-chip", className)} data-tone={switches.flapping ? "warn" : "ok"} title={title} data-testid="route-switch-chip">
      24h 切换 ×{switches.count24h}{switches.flapping ? " · 来回漂" : switches.manual24h > 0 ? ` · 人工 ×${switches.manual24h}` : ""}
    </span>
  );
}

export type RouteBoardStatus = {
  paths: RouteBoardPath[];
  entry?: RouteBoardEntry | null;
  rate?: RouteBoardRate;
  switches?: RouteSwitchSummary | null;
  activeSince?: number | null;
};

/**
 * 一条线路组的全部路径卡：在走的排最前。weighted 时每条都带权重份额。
 */
export function RoutePathCards({ status, policy, className }: { status: RouteBoardStatus; policy: RoutePolicy; className?: string }) {
  const weighted = policy.mode === "weighted";
  const shares = routeWeightShares(status.paths);
  const ordered = weighted ? status.paths : [...status.paths].sort((left, right) => Number(right.active) - Number(left.active) || left.index - right.index);
  return (
    <div className={cn("fx-rb-paths", className)}>
      {ordered.map((path) => (
        <RoutePathCard
          key={path.key}
          path={path}
          entry={status.entry ?? null}
          ruleRate={status.rate ?? null}
          share={weighted ? shares[path.index] : null}
          preferred={policy.lines[path.index]?.preferred}
          weighted={weighted}
        />
      ))}
    </div>
  );
}

/** 线路板上一条规则的卡：规则名、入口、策略、切换次数、速率，下面是路径卡。 */
export function RouteBoardCard({ name, owner, status, policy, onOpen, onEdit }: {
  name: string;
  owner?: string | null;
  status: RouteBoardStatus;
  policy: RoutePolicy;
  onOpen: () => void;
  onEdit?: () => void;
}) {
  const info = ROUTE_MODE_INFO[policy.mode];
  const entry = status.entry ?? null;
  return (
    <article className="fx-rb-card" data-testid="route-board-card">
      <header className="fx-rb-card-head">
        <div className="fx-rb-card-title">
          <b className="truncate">{name}</b>
          <span className="fx-rb-card-sub">
            {entry ? <>{entry.name}<span className="font-mono">:{entry.sourcePort}</span></> : null}
            {owner ? ` · ${owner}` : ""}
            {` · ${info.template} · ${info.label}`}
            {` · ${status.paths.length} 条路径`}
          </span>
        </div>
        <div className="fx-rb-card-chips">
          {status.switches ? <RouteSwitchChip switches={status.switches} /> : null}
          {policy.pin ? <span className="fx-rb-chip" data-tone="warn">人工指定中</span> : null}
          {status.rate ? <span className="fx-rb-chip" data-tone="ok">↓ {formatRate(status.rate.inBps)} · ↑ {formatRate(status.rate.outBps)}{status.rate.connections > 0 ? ` · ${status.rate.connections} 连接` : ""}</span> : null}
          <button type="button" className="fx-rb-open" onClick={onOpen}>策略与记录</button>
          {onEdit ? <button type="button" className="fx-rb-open" onClick={onEdit}>编辑</button> : null}
        </div>
      </header>
      <RoutePathCards status={status} policy={policy} />
    </article>
  );
}
