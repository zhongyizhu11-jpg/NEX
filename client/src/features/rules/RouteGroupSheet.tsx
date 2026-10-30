import { useRef, type ReactNode } from "react";
import { useLocation } from "wouter";

import { GroupedList, ListRow, ListSection } from "@/components/ios/GroupedList";
import { StatusDot } from "@/components/network/StatusDot";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatAgo } from "@shared/dashboardAttention";
import type { NetworkHealth } from "@shared/networkHealth";
import {
  ROUTE_EVENT_KIND_LABELS,
  ROUTE_GROUP_FORWARDX_AGENT_VERSION,
  ROUTE_GROUP_UDP_AGENT_VERSION,
  ROUTE_MODE_INFO,
  normalizeRouteEventKind,
  routeModeHint,
  routePathLetter,
  type RouteEndpoint,
  type RouteGroupPolicy,
} from "@shared/routeGroup";
import { describeRoutePolicyReport, formatPolicyClock, type RoutePolicy } from "@shared/routePolicy";
import { formatRouteScore } from "@shared/routeScore";
import type { RouteSwitchSummary } from "@shared/routeSwitchSummary";
import { isAgentVersionBehind } from "@shared/version";
import { RoutePathCards, RouteSwitchChip, type RouteBoardEntry, type RouteBoardRate } from "./RouteBoard";
import { ConditionRow, PinSection, SentenceRow } from "./RoutePolicySheet";
import { RouteQualityHistory } from "./RouteQualityHistory";
import { RouteLineDiagram, RouteLineHero, RouteLineList, RouteLineTools, RouteStageStrip, routeLineSwitchSummary, useRouteLinePause } from "./RouteLineOverview";

/*
  线路组面板：从规则卡上那个「主备 · 主线路 · 92 优」点进来。

  回答的还是那几件事，但按路径说，不按地址说：
    现在走哪条（以及这句话能信到什么程度）
    当前路径 —— 逐跳的延迟和中继状态，整条路的评分和四个指标
    备用路径 —— 每条的评分、健康、为什么用不了
    调度计划 —— 按什么选（此刻起作用的那一行高亮）、什么时候切
    最近切换 —— 什么时候、从哪条到哪条、为什么
  最后是应急的「强制走 / 交回自动」。

  判断在 shared/routePolicy，数字来自 rules.routeStatus（入口 Agent 每次心跳带评分，中转机
  一分钟报一次它那一跳），历史来自 rules.routeEvents。这里只管画。
*/

export type RouteStatusHop = {
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
  /** 这一跳的中继规则此刻的速率；流量没走到这一跳时为空。 */
  rate?: RouteBoardRate;
};

export type RouteStatusPath = {
  key: string;
  index: number;
  letter: string;
  name: string;
  hops: RouteStatusHop[];
  dest: RouteEndpoint;
  dial: RouteEndpoint | null;
  issue: string | null;
  weight: number;
  probe: RouteEndpoint | null;
  score: number | null;
  grade: { label: string; tone: string };
  latencyMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  availabilityPct: number | null;
  healthy: boolean | null;
  down: boolean;
  downReason: string;
  connections: number | null;
  samples: number;
  active: boolean;
  prewarming: boolean;
  /** 入口 Agent 最近一次探这条路径（Unix 毫秒）。 */
  probedAt?: number | null;
};

export type RouteStatus = {
  ruleId: number;
  policy: RouteGroupPolicy;
  paths: RouteStatusPath[];
  activeIndex: number;
  activeSince: number | null;
  prewarmIndex: number;
  agentReportedAt: number | null;
  agentStale: boolean;
  agentVersion: string | null;
  agentSupportsScores: boolean;
  /** UDP、TCP+UDP 和 NEX 隧道的线路组：调度所在那台的 Agent 会不会调度（2.2.199 起）。其余永远是 true。 */
  agentSupportsProtocol?: boolean;
  /** 哪一样要新 Agent 才调度：NEX 隧道、UDP（含 TCP+UDP），都不是时为 null。 */
  schedulerNeed?: "forwardx" | "udp" | null;
  /** tcp / udp / both */
  protocol?: string;
  requiredAgentVersion: string;
  /** 这条规则（入口）此刻的速率。 */
  rate?: RouteBoardRate;
  switches?: RouteSwitchSummary | null;
  entry?: RouteBoardEntry | null;
};

export type RouteEvent = {
  id: number;
  kind: string;
  fromKey: string | null;
  toKey: string | null;
  fromLabel: string | null;
  toLabel: string | null;
  reason: string | null;
  reasonText: string;
  score: number | null;
  latencyMs: number | null;
  at: number;
};

const reportHealth: Record<ReturnType<typeof describeRoutePolicyReport>["tone"], NetworkHealth> = {
  normal: "healthy",
  deviated: "degraded",
  warn: "down",
  muted: "unknown",
};

export type RouteGroupPanelProps = {
  policy: RoutePolicy;
  status: RouteStatus | null;
  events: RouteEvent[];
  canEdit: boolean;
  pending?: boolean;
  onPin?: (index: number, durationSeconds: number | null) => void;
  onUnpin?: () => void;
  nowMs?: number;
  timeZone?: string;
  /** 线路组弹窗给：暂停线路、导出、逐段测带宽（要 tRPC，纯展示时不给）。 */
  lineActions?: { onPause?: (lineKey: string, paused: boolean) => void; pausing?: boolean };
};

export function RouteGroupPanel({ policy, status, events, canEdit, pending = false, onPin, onUnpin, nowMs, timeZone, lineActions }: RouteGroupPanelProps) {
  const now = nowMs ?? Date.now();
  const report = describeRoutePolicyReport(policy, { nowMs: now, timeZone });
  const paths = status?.paths || [];
  const activePath = paths.find((path) => path.active) || null;
  const others = paths.filter((path) => !path.active);
  const weighted = policy.mode === "weighted";
  const modeInfo = ROUTE_MODE_INFO[policy.mode];

  return (
    <div className="flex min-w-0 flex-col gap-[var(--fx-space-5)]">
      <div className="flex items-start gap-2.5 px-1">
        <StatusDot health={reportHealth[report.tone]} className="mt-1.5" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-secondary-type font-semibold text-foreground">{report.text}</p>
          {policy.divergence ? <p className="text-meta text-[var(--fx-warn-text)]">{policy.divergence}</p> : null}
          {report.note ? <p className="text-meta text-muted-foreground">{report.note}</p> : null}
          {status?.agentStale && status.agentReportedAt ? (
            <p className="text-meta text-[var(--fx-warn-text)]">评分是 {formatAgo(now - status.agentReportedAt)}报的，之后 Agent 没再上报。</p>
          ) : null}
        </div>
      </div>

      {policy.warnings
        /*
          「Agent 早于 2.2.199」那几句是拿调用方给的机器算的（规则所在的机器）；隧道规则的调度
          跑在出口机上，只有 status 读的是对的那台 —— 有 status 就以它为准，下面单独说。
        */
        .filter((warning) => !status || ![ROUTE_GROUP_UDP_AGENT_VERSION, ROUTE_GROUP_FORWARDX_AGENT_VERSION].some((version) => warning.includes(version)))
        .map((warning) => (
          <p key={warning} className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-meta text-[var(--fx-warn-text)]">
            {warning}
          </p>
        ))}
      {status && status.agentSupportsProtocol === false ? (
        <p className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-meta text-[var(--fx-warn-text)]">
          {status.schedulerNeed === "forwardx"
            ? <>隧道出口的 Agent{status.agentVersion ? `（${status.agentVersion}）` : ""}早于 {status.requiredAgentVersion}，还不会调度 NEX 隧道：升级之前这条规则全部走 {policy.lines[0]?.label || routePathLetter(0)}、不切换。</>
            : <>调度这条线路组的机器上 Agent{status.agentVersion ? `（${status.agentVersion}）` : ""}早于 {status.requiredAgentVersion}，还不会调度 UDP：升级之前这条规则全部走 {policy.lines[0]?.label || routePathLetter(0)}、不切换。</>}
        </p>
      ) : status && !status.agentSupportsScores ? (
        <p className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-meta text-[var(--fx-warn-text)]">
          调度这条线路组的机器上 Agent{status.agentVersion ? `（${status.agentVersion}）` : ""}早于 {status.requiredAgentVersion}：没有评分、不预热预检、不按权重分，只按主备顺序切。升级 Agent 后这些才生效。
        </p>
      ) : null}
      {status && policy.strategy === "ip_hash" && status.protocol !== "udp" && status.agentSupportsProtocol !== false
        && !!status.agentVersion && isAgentVersionBehind(status.agentVersion, ROUTE_GROUP_UDP_AGENT_VERSION) ? (
          <p className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-meta text-[var(--fx-warn-text)]">
            调度这条线路组的机器上 Agent（{status.agentVersion}）早于 {ROUTE_GROUP_UDP_AGENT_VERSION}：按访客固定读不到访客地址，所有访客都落在同一条路径上。升级 Agent 后才按访客分。
          </p>
        ) : null}

      {/* 线路总览（2.3.496）：大数字、分层图、线路列表（可暂停）、按段成功率、导出和逐段测带宽。 */}
      {status && status.paths.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="route-line-overview">
          {(status as any).agentSupportsLines === false && status.paths.some((path: any) => typeof path.tier === "number") ? (
            <p className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-meta text-[var(--fx-warn-text)]">
              调度这条线路的机器上 Agent{status.agentVersion ? `（${status.agentVersion}）` : ""}早于 2.2.243：还不会按「主线路那组先挑」和整条链的延迟选，也不会改完马上探。升级 Agent 后生效，之前照旧按顺序切。
            </p>
          ) : null}
          <RouteLineHero status={status} />
          <RouteLineDiagram status={status} />
          <div className="flex items-center justify-between px-1 pt-1 text-meta font-semibold text-muted-foreground">
            <span>线路</span>
            <span className="font-normal">{routeLineSwitchSummary(status)}</span>
          </div>
          <RouteLineList status={status} onPause={canEdit ? lineActions?.onPause : undefined} pausing={lineActions?.pausing} />
          <div className="flex items-center justify-between px-1 pt-1 text-meta font-semibold text-muted-foreground">
            <span>连接 · 按段</span>
            <span className="font-normal">精确到哪一段</span>
          </div>
          <RouteStageStrip status={status} />
          {lineActions ? <RouteLineTools status={status} /> : null}
        </div>
      ) : null}

      {/* 路径卡：一条路径一张，在走的排最前；每张是一条链，段上写延迟，节点下写速率。 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="text-meta font-semibold text-muted-foreground">{weighted ? "路径（每条都在走）" : "路径"}</span>
          {status?.switches ? <RouteSwitchChip switches={status.switches} /> : null}
        </div>
        {!status ? (
          <p className="px-1 text-meta text-muted-foreground">在读线路状态…</p>
        ) : (
          <RoutePathCards status={status} policy={policy} />
        )}
        {status && activePath && activePath.hops.length > 0 ? (
          <p className="px-1 text-meta text-muted-foreground">每一段的延迟是上一个节点探它下一跳的结果；「未测」是那台中转还没报、不是通。整链是各段相加。</p>
        ) : null}
        {status && others.some((path) => path.down) ? (
          <p className="px-1 text-meta text-muted-foreground">用不了的路径会被跳过，恢复并稳定一阵后重新参与。</p>
        ) : null}
      </div>

      <GroupedList>
        <ListSection
          header="调度计划"
          footer={weighted ? undefined : "从上往下，先对上的那一条说了算。它指的那条挂了，照样往下找 —— 选路和健康检查是两件事。"}
        >
          <SentenceRow label="策略" detail={`${modeInfo.template} · ${modeInfo.label}：${routeModeHint(policy.mode, policy.perSession)}`} />
          {policy.conditions.map((condition) => <ConditionRow key={condition.key} condition={condition} />)}
          {policy.guards.map((guard) => (
            <SentenceRow key={guard.key} label={guard.label} detail={guard.value} />
          ))}
        </ListSection>

        <ListSection header="最近切换" footer={events.length > 0 ? "最多显示最近 20 条。切换和计划切换未执行也会发 Telegram（规则开了异常提醒时）。" : undefined}>
          {events.length === 0 ? (
            <ListRow label="还没有记录" detail="切换、线路异常、预检不过都会记在这里" />
          ) : (
            events.map((event) => {
              const kind = normalizeRouteEventKind(event.kind);
              const title = kind ? ROUTE_EVENT_KIND_LABELS[kind] : event.kind;
              const movement = event.fromLabel && event.toLabel
                ? `${event.fromLabel} → ${event.toLabel}`
                : event.toLabel || event.fromLabel || "";
              const failed = kind === "precheck_failed" || kind === "unhealthy" || kind === "issue" || kind === "flap_hold" || kind === "slow_dial";
              return (
                <div key={event.id} className="fx-list-row flex w-full min-w-0 items-start gap-3 px-4 py-3" data-testid="route-event">
                  <span className="w-[4.5rem] shrink-0 font-mono text-meta tabular-nums text-muted-foreground">{formatPolicyClock(event.at, now, timeZone)}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cn("text-secondary-type", failed ? "text-[var(--fx-warn-text)]" : "text-foreground")}>
                      {title}
                      {movement ? <span className="text-muted-foreground">　{movement}</span> : null}
                    </span>
                    {event.reasonText || event.score ? (
                      <span className="text-meta text-muted-foreground">
                        {event.reasonText}
                        {event.score ? `${event.reasonText ? " · " : ""}评分 ${formatRouteScore(event.score)}` : ""}
                        {kind === "precheck_failed" ? " · 继续使用原路径" : ""}
                      </span>
                    ) : null}
                  </span>
                </div>
              );
            })
          )}
        </ListSection>

        {!weighted && canEdit && onPin && onUnpin ? (
          <PinSection
            policy={policy}
            pending={pending}
            onPin={onPin}
            onUnpin={onUnpin}
            nowMs={now}
            timeZone={timeZone}
            header={policy.mode === "manual" ? "手动指定" : "应急人工指定"}
            footer={policy.mode === "manual"
              ? "手动主备一直走你指定的那条；换一条在这里换。它挂了才临时往下切，恢复后再回来。"
              : "应急用：压过时段表和评分，到点自动交回。指定的那条要是挂了，仍然会往下切 —— 不会为了守着它把连接送进死路。"}
          />
        ) : null}
      </GroupedList>
    </div>
  );
}

export type RouteGroupSheetProps = Omit<RouteGroupPanelProps, "policy" | "status" | "events"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ruleId: number | null;
  /** 规则名，标题下面那一行。 */
  subjectName: string;
  policy: RoutePolicy | null;
  onEdit?: () => void;
  /** 面板打开时每隔多久刷一次状态（毫秒）；测试里传 0 关掉。 */
  refetchIntervalMs?: number;
  footer?: ReactNode;
};

export function RouteGroupSheet({
  open,
  onOpenChange,
  ruleId,
  subjectName,
  policy,
  onEdit,
  refetchIntervalMs = 3_000,
  footer,
  ...panel
}: RouteGroupSheetProps) {
  const enabled = open && !!policy && !!ruleId;
  const linePause = useRouteLinePause(Number(ruleId) || 0);
  const statusQuery = trpc.rules.routeStatus.useQuery({ ruleId: Number(ruleId) }, { enabled, refetchInterval: refetchIntervalMs || false, staleTime: 5_000 });
  const eventsQuery = trpc.rules.routeEvents.useQuery({ ruleId: Number(ruleId), limit: 20 }, { enabled, refetchInterval: refetchIntervalMs || false, staleTime: 5_000 });
  /*
    关的那一下（130ms 的动画）调用方已经把规则清掉了，拿上一份接着画 —— 不然面板在
    动画里先塌成只剩标题再消失。
  */
  const [, setLocation] = useLocation();
  const last = useRef<{ subjectName: string; policy: RoutePolicy } | null>(null);
  if (open && policy) last.current = { subjectName, policy };
  const shown = last.current;
  return (
    <Dialog open={open && !!policy} onOpenChange={onOpenChange}>
      {shown ? (
        <DialogContent className="bg-[var(--fx-l0-page)] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>线路组</DialogTitle>
            <DialogDescription className="truncate">{shown.subjectName}</DialogDescription>
          </DialogHeader>
          <RouteGroupPanel
            {...panel}
            lineActions={linePause}
            policy={shown.policy}
            status={(statusQuery.data as RouteStatus | null | undefined) ?? null}
            events={(eventsQuery.data as RouteEvent[] | undefined) ?? []}
          />
          <RouteQualityHistory
            ruleId={Number(ruleId) || 0}
            enabled={enabled}
            activeKey={((statusQuery.data as RouteStatus | null | undefined)?.paths || []).find((path) => path.active)?.key ?? null}
          />
          <DialogFooter>
            {footer}
            {ruleId ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onOpenChange(false);
                  setLocation(`/topology?rule=${Number(ruleId)}`);
                }}
              >
                查看拓扑
              </Button>
            ) : null}
            {onEdit ? (
              <Button type="button" variant="outline" onClick={onEdit}>
                编辑线路组
              </Button>
            ) : null}
            <Button type="button" onClick={() => onOpenChange(false)}>
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
