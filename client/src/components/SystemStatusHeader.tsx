import { Activity, ArrowRight, ArrowRightLeft, Route, Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SummaryStrip, type SummaryItem } from "@/components/entity/SummaryStrip";
import { countAttentionDegraded, type DashboardAttention } from "@shared/dashboardAttention";
import { cn } from "@/lib/utils";

/** Health reflects current API data; status colors are reserved for actual conditions. */

export type SystemHealth = {
  hosts: { total: number; online: number; offline: number; neverConnected: number };
  links: { total: number; healthy: number; unhealthy: number; degraded?: number };
  forwards: { total: number; running: number; stalled: number; paused?: number; disabled: number };
  issues: number;
  /** 这几个数背后具体是谁。首页下面那块「需要关注」画的就是它 */
  attention?: DashboardAttention;
  /** 在线主机此刻的连接数相加；reported = 其中真报了的台数（旧 Agent 不报） */
  connections?: { tcp: number; udp: number; reported: number };
};

/** 首页那一格的补充行：手机上只放得下一个数，TCP 优先；桌面两个都给，完整的挂在 title 上。 */
export function connectionsHint(connections: { tcp: number; udp: number }) {
  const tcp = `TCP ${connections.tcp.toLocaleString("zh-CN")}`;
  const udp = `UDP ${connections.udp.toLocaleString("zh-CN")}`;
  return {
    full: `${tcp} · ${udp}`,
    node: (
      <>
        <span className="sm:hidden">{tcp}</span>
        <span className="hidden sm:inline">{tcp} · {udp}</span>
      </>
    ),
  };
}

type Props = {
  health?: SystemHealth;
  loading?: boolean;
  isAdmin: boolean;
  onRetry?: () => void;
  /** 「查看需要关注」按钮：有异常时跳到下面那块列表 */
  onOpenAttention?: () => void;
};

/**
 * 首页最上面那一块：现在系统是否正常。
 *
 * 结论按「最该先看到哪个」退档：有异常说异常；没有异常但有降级，说降级 ——
 * 不能在下面列表里挂着琥珀色的同时写「运行正常」；都没有才说正常。
 * 「还没接入」的主机两边都不算：那是一步没做完，不是出了事，它只进下面的列表。
 */
function headline(health: SystemHealth) {
  const issues = Math.max(0, Number(health.issues) || 0);
  if (issues > 0) return { text: `${issues} 处需要关注`, tone: "warn" as const };
  const degraded = health.attention
    ? countAttentionDegraded(health.attention.totals)
    : Math.max(0, Number(health.links.degraded) || 0);
  if (degraded > 0) return { text: `${degraded} 处降级`, tone: "warn" as const };
  return { text: "运行正常", tone: "healthy" as const };
}

/**
 * 一张卡：一行三个数（主机 / 线路 / 转发）加一行结论。
 *
 * 2026-09-27 第三轮：用户说「主页大卡片还需要重构」。原来统计行是一张卡、结论又是一条带框的行，
 * 两张卡说一件事；现在合成一张，结论靠一条弱线和读数分开，卡矮了一截。
 *
 * 上一版是「运行概况」标题 + 一句说明 + 三张带框的小卡 + 右边一块三色渐变的结论面板，
 * 手机上整块 250px，而它说的只有两件事：几个数、有没有事。现在数字走 SummaryStrip
 * 那种不画框的统计行，结论是一行字：绿点「运行正常」，或者琥珀点「N 处需要关注」加
 * 一个「查看」。哪几处出了事，下面「需要关注」逐条列，这里不再解释。
 */
export default function SystemStatusHeader({ health, loading, isAdmin, onRetry, onOpenAttention }: Props) {
  const empty = !!health && health.hosts.total === 0 && health.links.total === 0 && health.forwards.total === 0;
  const verdict = health && !empty ? headline(health) : null;
  const linkDegraded = Math.max(0, Number(health?.links.degraded) || 0);
  const forwardPaused = Math.max(0, Number(health?.forwards.paused) || 0);
  /*
    「连接」这一格：管理员一直有（和「主机」一样，数的是机器）；租户只在他的机器真报了
    连接数时才有 —— 大多数租户没有自己的机器，给他画一个永远是 0 的格子是噪音。
    一台都没报（全是旧 Agent）时管理员那格画「—」，不画一个假的 0。
  */
  const connections = health?.connections;
  const connectionsReported = !!connections && connections.reported > 0;
  const showConnections = isAdmin || connectionsReported;
  const connectionsHintParts = connectionsReported ? connectionsHint(connections) : null;

  const items: SummaryItem[] = [
    ...(isAdmin ? [{
      key: "hosts",
      label: "主机",
      icon: Server,
      iconTone: "sky" as const,
      value: health?.hosts.total ?? "—",
      hint: health ? (health.hosts.offline > 0 ? `${health.hosts.offline} 离线` : `${health.hosts.online} 在线`) : null,
      hintTone: health ? (health.hosts.offline > 0 ? "warn" : "healthy") : undefined,
    } satisfies SummaryItem] : []),
    {
      key: "links",
      label: "线路",
      icon: Route,
      iconTone: "violet" as const,
      value: health?.links.total ?? "—",
      hint: health
        ? health.links.unhealthy > 0
          ? `${health.links.unhealthy} 异常`
          : linkDegraded > 0
            ? `${linkDegraded} 降级`
            : `${health.links.healthy} 正常`
        : null,
      hintTone: health ? (health.links.unhealthy > 0 ? "down" : linkDegraded > 0 ? "warn" : "healthy") : undefined,
    },
    {
      key: "forwards",
      label: "转发",
      icon: ArrowRightLeft,
      iconTone: "teal" as const,
      value: health?.forwards.total ?? "—",
      hint: health
        ? health.forwards.stalled > 0
          ? `${health.forwards.stalled} 未运行`
          : forwardPaused > 0 && !isAdmin
            ? `${forwardPaused} 已暂停`
            : `${health.forwards.running} 运行中`
        : null,
      hintTone: health
        ? (health.forwards.stalled > 0 ? "warn" : forwardPaused > 0 && !isAdmin ? "warn" : "healthy")
        : undefined,
    },
    ...(showConnections ? [{
      key: "connections",
      label: "连接",
      icon: Activity,
      iconTone: "orange" as const,
      value: connectionsReported ? connections.tcp + connections.udp : "—",
      hint: connectionsHintParts ? connectionsHintParts.node : health ? "等待 Agent 上报" : null,
      title: connectionsHintParts ? connectionsHintParts.full : undefined,
    } satisfies SummaryItem] : []),
  ];

  const verdictTone: "healthy" | "warn" | "muted" = loading && !health ? "muted" : !health ? "warn" : empty ? "muted" : verdict?.tone ?? "muted";
  const verdictTitle = loading && !health ? "检查中" : !health ? "暂时无法读取状态" : empty ? "准备好，开始你的第一条连接" : verdict?.text;
  const verdictDetail = empty
    ? (isAdmin ? "先接入主机，再配置线路，最后创建转发规则。" : "获得可用线路后，就可以创建转发规则。需要资源权限时请联系管理员。")
    : null;

  return (
    <section className="system-health fx-overview-card fx-card-face flex min-w-0 flex-col" aria-label="运行状态">
      <SummaryStrip items={items} loading={!!loading && !health} ariaLabel="主机、线路、转发、连接数量" embedded />
      <div
        className="system-health-verdict flex min-w-0 items-center gap-3 rounded-[var(--fx-radius-card)] border border-[var(--fx-stroke-weak)] px-3.5 py-2.5"
        data-tone={verdictTone}
        role="status"
      >
        <span
          aria-hidden="true"
          className={cn("h-2.5 w-2.5 shrink-0 rounded-full", verdictTone === "muted" && "bg-[var(--fx-standby)]")}
          style={verdictTone === "muted" ? undefined : {
            backgroundColor: `var(--fx-${verdictTone})`,
            boxShadow: `0 0 0 3px var(--fx-${verdictTone}-soft)`,
          }}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-primary-type font-semibold tracking-tight text-foreground">{verdictTitle}</span>
          {verdictDetail ? <span className="text-meta text-muted-foreground">{verdictDetail}</span> : null}
        </span>
        {!loading && !health && onRetry ? (
          <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry}>重新读取</Button>
        ) : verdict && verdict.tone !== "healthy" && onOpenAttention ? (
          <Button variant="ghost" size="sm" className="shrink-0 gap-1 px-2 text-[var(--fx-accent)] hover:text-[var(--fx-accent)]" onClick={onOpenAttention}>
            查看
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </section>
  );
}
