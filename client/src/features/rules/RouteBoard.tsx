import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { formatFailoverEndpoint } from "@shared/failoverTargets";
import { formatBytes } from "@shared/formatBytes";
import type { NetworkHealth } from "@shared/networkHealth";
import { routeWeightShares } from "@shared/routeGroup";
import { ROUTE_SCORE_LOAD_FROM_PCT, ROUTE_SCORE_LOAD_FULL_PCT, ROUTE_SCORE_LOAD_MAX_PENALTY, routeLoadPenalty } from "@shared/routeScore";
import type { RoutePolicy } from "@shared/routePolicy";
import type { RouteSwitchSummary } from "@shared/routeSwitchSummary";

/*
  线路板的数据和几样小件：一条路径拆成段（入口 ─ 中转… ─ 落地）、整链延迟、规则卡上的迷你链，
  以及路径上「UDP 不通」「负载 85%」那几枚胶囊怎么说。

  一条链最要紧的是「哪一段慢、哪一段断」：测到的段写数字，没测到的写「未测」（说清楚这是不
  知道，不是通），探不通的算断。整条链的延迟是各段相加，有一段没测就写「≥」。

  原来这里还有一条路径一张的「路径卡」：线路详情第一页换成分层图和线路列表（RouteLineOverview）、
  异常明细里也不再画以后，它就没人用了，已经删掉。
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
  /** UDP 那一侧的健康（Agent 2.2.251 起）：TCP+UDP 规则两侧分开判；老 Agent 没报就是 null / 缺省。 */
  udpHealthy?: boolean | null;
  udpLatencyMs?: number | null;
  /** 沿途主机里最忙那台的负载（0–100），评分已经按它扣过；老 Agent 没有。 */
  loadPct?: number | null;
};

/**
 * 「UDP 不通」/「仅 UDP 通」：TCP+UDP 规则两侧结论不一致时在路径行上标一枚小胶囊；一致、或者老 Agent
 * 没报 UDP 那一侧，什么都不显示。断了的路径两侧都不通，交给「断了」那枚说。
 */
export function describeRouteUdpSplit(path: Pick<RouteBoardPath, "healthy" | "udpHealthy" | "udpLatencyMs" | "down">): { text: string; title: string } | null {
  if (path.down || path.healthy === null || path.udpHealthy === null || path.udpHealthy === undefined) return null;
  if (path.healthy && !path.udpHealthy) {
    return { text: "UDP 不通", title: "TCP 探测通、UDP 端口探不通：TCP 连接照常走这条，UDP 会话会避开它" };
  }
  if (!path.healthy && path.udpHealthy) {
    const latency = typeof path.udpLatencyMs === "number" && path.udpLatencyMs > 0 ? `（${Math.round(path.udpLatencyMs)} ms）` : "";
    return { text: "仅 UDP 通", title: `TCP 探测不通、UDP 端口探得通${latency}：UDP 会话还能走这条，TCP 连接不走` };
  }
  return null;
}

/**
 * 「负载 85%」那枚药丸：沿途有一台机器忙到 70% 以上才显示（70% 以下评分不扣，没什么可说的）。
 * 95% 起染红，之间琥珀；title 里写扣了几分。没到门槛或老 Agent 没报返回 null。
 */
export function describeRouteLoad(loadPct: number | null | undefined): { text: string; title: string; tone: "warn" | "down"; penalty: number } | null {
  if (loadPct === null || loadPct === undefined || !Number.isFinite(loadPct) || loadPct < ROUTE_SCORE_LOAD_FROM_PCT) return null;
  const penalty = Math.round(routeLoadPenalty(loadPct) * 10) / 10;
  const pct = Math.round(loadPct);
  return {
    text: `负载 ${pct}%`,
    title: `沿途最忙的主机负载 ${pct}%（CPU 和带宽占用取大），评分扣 ${penalty} 分：${ROUTE_SCORE_LOAD_FROM_PCT}% 起扣，${ROUTE_SCORE_LOAD_FULL_PCT}% 扣满 ${ROUTE_SCORE_LOAD_MAX_PENALTY} 分`,
    tone: loadPct >= ROUTE_SCORE_LOAD_FULL_PCT ? "down" : "warn",
    penalty,
  };
}

export type RouteBoardEntry = { hostId: number; name: string; online: boolean | null; sourcePort: number };

/** 一段：from → to，延迟从哪来、通不通。 */
export type RouteSegment = {
  key: string;
  latencyMs: number | null;
  /** measured 测到的；failed 探不通；unknown 还没人探这一段（中继没报、没建中继、老 Agent）；planned 这一段没有单独的探测（「我的线路」里的隧道段）。 */
  state: "measured" | "failed" | "unknown" | "planned";
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

/** 当前在走的那条路径的整链摘要（规则卡上的延迟标签用），没有线路板数据或没有在走的路径时为 null。 */
export function routeBoardActiveChain(status: RouteBoardStatus | null | undefined): RouteChainSummary | null {
  const active = status?.paths?.find((path) => path.active) || null;
  return active ? summarizeRouteChain(active) : null;
}

export function formatRate(bps: number) {
  return `${formatBytes(Math.max(0, bps))}/s`;
}

function pathHealth(path: RouteBoardPath): NetworkHealth {
  if (path.down) return "down";
  if (path.prewarming) return "switching";
  if (path.healthy === null) return path.active ? "healthy" : "unknown";
  if (!path.healthy) return "degraded";
  return path.active ? "healthy" : "standby";
}

export type RouteBoardStatus = {
  paths: RouteBoardPath[];
  entry?: RouteBoardEntry | null;
  rate?: RouteBoardRate;
  switches?: RouteSwitchSummary | null;
  activeSince?: number | null;
};

/**
 * 规则卡上的迷你链：一条路径一行，「A 主线路 ● HK ─ 23 ─ SG ─ 29 ─ 落地 · 在走」。
 * 规则卡上只要一眼看出走的哪条、哪段慢；点一下进线路组面板。
 */
export function RouteMiniChain({ status, policy, onOpen, className }: { status: RouteBoardStatus; policy: RoutePolicy; onOpen?: () => void; className?: string }) {
  const weighted = policy.mode === "weighted";
  const shares = routeWeightShares(status.paths);
  const entryName = status.entry?.name || "入口";
  return (
    <ul className={cn("fx-rb-mini", className)} data-testid="route-mini-chain">
      {status.paths.map((path) => {
        const chain = summarizeRouteChain(path);
        const health = pathHealth(path);
        const stops: string[] = [entryName, ...path.hops.map((hop) => hop.name), "落地"];
        const parts: ReactNode[] = [];
        stops.forEach((stop, index) => {
          if (index > 0) {
            const segment = chain.segments[index - 1];
            parts.push(
              <i key={`seg-${index}`} className="fx-rb-mini-seg" data-state={segment?.state || "unknown"}>
                {segment?.state === "measured" ? `${round(segment.latencyMs || 0)}` : segment?.state === "failed" ? "✕" : "·"}
              </i>,
            );
          }
          parts.push(<span key={`stop-${index}`} className="fx-rb-mini-stop">{stop}</span>);
        });
        const udpSplit = describeRouteUdpSplit(path);
        const state = (weighted
          ? `${shares[path.index]}%`
          : path.active ? "在走" : path.down ? "断了" : path.prewarming ? "预热中" : "备用") + (udpSplit ? ` · ${udpSplit.text}` : "");
        const total = chain.totalMs === null ? "" : `${chain.partial ? "≥" : ""}${round(chain.totalMs)} ms`;
        const row = (
          <>
            <span className="fx-rb-mini-letter" data-active={path.active ? "" : undefined}>{path.letter}</span>
            <i className="fx-rb-mini-dot" data-health={health} aria-hidden="true" />
            <span className="fx-rb-mini-chain">{parts}</span>
            <span className="fx-rb-mini-end">{total ? <span className="font-mono">{total}</span> : null}<span data-active={path.active ? "" : undefined}>{state}</span></span>
          </>
        );
        return (
          <li key={path.key} data-active={path.active ? "" : undefined} data-health={health}>
            {onOpen ? <button type="button" className="fx-rb-mini-row" onClick={onOpen} title={`路径 ${path.letter} ${path.name}：点开线路组`}>{row}</button> : <span className="fx-rb-mini-row">{row}</span>}
          </li>
        );
      })}
    </ul>
  );
}
