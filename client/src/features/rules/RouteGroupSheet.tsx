import { useRef, type ReactNode } from "react";
import { useLocation } from "wouter";

import { EntityTag } from "@/components/entity/EntityCard";
import { GroupedList, ListRow, ListSection } from "@/components/ios/GroupedList";
import { StatusDot } from "@/components/network/StatusDot";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatAgo } from "@shared/dashboardAttention";
import { formatFailoverEndpoint } from "@shared/failoverTargets";
import type { NetworkHealth } from "@shared/networkHealth";
import {
  ROUTE_EVENT_KIND_LABELS,
  ROUTE_GROUP_FORWARDX_AGENT_VERSION,
  ROUTE_GROUP_UDP_AGENT_VERSION,
  ROUTE_MODE_INFO,
  normalizeRouteEventKind,
  routeModeHint,
  routePathLetter,
  routeWeightShares,
  type RouteEndpoint,
  type RouteGroupPolicy,
} from "@shared/routeGroup";
import { describeRoutePolicyReport, formatPolicyClock, type RoutePolicy } from "@shared/routePolicy";
import { formatRouteScore, routeScoreGrade } from "@shared/routeScore";
import { isAgentVersionBehind } from "@shared/version";
import { ConditionRow, PinSection, SentenceRow } from "./RoutePolicySheet";
import { RouteQualityHistory } from "./RouteQualityHistory";

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

/** 评分等级的颜色，和状态点一套：优良绿、较差黄、不可用红；还没评分不染色。 */
const gradeClass: Record<ReturnType<typeof routeScoreGrade>["tone"], string> = {
  healthy: "text-[var(--fx-healthy-text)]",
  warn: "text-[var(--fx-warn-text)]",
  down: "text-destructive",
  standby: "text-muted-foreground",
};

function ScoreTag({ score }: { score: number | null }) {
  return (
    <span className={cn("shrink-0 font-mono text-xs font-semibold tabular-nums", gradeClass[routeScoreGrade(score).tone])} data-testid="route-score">
      {formatRouteScore(score)}
    </span>
  );
}

function pathHealth(path: RouteStatusPath): NetworkHealth {
  if (path.down) return "down";
  if (path.prewarming) return "switching";
  if (path.healthy === null) return path.active ? "healthy" : "unknown";
  if (!path.healthy) return "degraded";
  return path.active ? "healthy" : "standby";
}

function hopHealth(hop: RouteStatusHop): NetworkHealth {
  if (hop.enabled === false || hop.running === false) return "down";
  if (hop.ok === false) return hop.consecutiveFailures >= 3 ? "down" : "degraded";
  if (hop.ok === true) return "healthy";
  return "unknown";
}

/** 「入口 → HK01 → JP01 → 10.95.0.10:443」 */
function pathChain(path: RouteStatusPath): string {
  return ["入口", ...path.hops.map((hop) => hop.name), formatFailoverEndpoint(path.dest.ip, path.dest.port) || "落地"].join(" → ");
}

function metric(label: string, value: string | null) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="font-mono text-sm tabular-nums text-foreground">{value ?? "—"}</span>
    </span>
  );
}

function PathMetrics({ path }: { path: RouteStatusPath }) {
  return (
    <div className="fx-list-row grid grid-cols-4 gap-2 px-4 py-3" data-testid="path-metrics">
      {metric("延迟", path.latencyMs === null ? null : `${Math.round(path.latencyMs)}ms`)}
      {metric("丢包", path.lossPct === null ? null : `${path.lossPct.toFixed(1)}%`)}
      {metric("抖动", path.jitterMs === null ? null : `${Math.round(path.jitterMs)}ms`)}
      {metric("可用率", path.availabilityPct === null ? null : `${path.availabilityPct.toFixed(1)}%`)}
    </div>
  );
}

function HopRows({ path }: { path: RouteStatusPath }) {
  return (
    <>
      {path.hops.map((hop, index) => (
        <ListRow
          key={`${hop.hostId}-${index}`}
          icon={<StatusDot health={hopHealth(hop)} />}
          label={`第 ${index + 1} 跳 · ${hop.name}`}
          detail={(
            <>
              {hop.port ? <span className="font-mono">中继 :{hop.port}</span> : "中继还没建好"}
              {hop.running === false && hop.enabled !== false ? " · 中继没在跑" : null}
              {hop.enabled === false ? " · 中继已停用" : null}
              {hop.ok === false ? ` · 到${hop.nextLabel || "下一跳"}连续 ${hop.consecutiveFailures} 次不通` : null}
              {hop.ok === true && hop.nextLabel ? ` · 到${hop.nextLabel}` : null}
            </>
          )}
          value={hop.latencyMs === null ? (hop.ok === null ? "等探测" : "—") : `${Math.round(hop.latencyMs)}ms`}
        />
      ))}
      <ListRow
        icon={<StatusDot health={path.down ? "down" : path.healthy === false ? "degraded" : path.healthy ? "healthy" : "unknown"} />}
        label={path.hops.length > 0 ? "落地" : "直连落地"}
        detail={<span className="font-mono">{formatFailoverEndpoint(path.dest.ip, path.dest.port) || "同规则目标"}</span>}
        value={path.latencyMs === null ? "—" : `${Math.round(path.latencyMs)}ms`}
      />
    </>
  );
}

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
};

export function RouteGroupPanel({ policy, status, events, canEdit, pending = false, onPin, onUnpin, nowMs, timeZone }: RouteGroupPanelProps) {
  const now = nowMs ?? Date.now();
  const report = describeRoutePolicyReport(policy, { nowMs: now, timeZone });
  const paths = status?.paths || [];
  const activePath = paths.find((path) => path.active) || null;
  const others = paths.filter((path) => !path.active);
  const weighted = policy.mode === "weighted";
  const shares = routeWeightShares(paths);
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

      <GroupedList>
        <ListSection
          header={weighted ? "路径" : "当前路径"}
          footer={weighted ? "权重负载没有「当前」：每条新连接各走各的。" : activePath && activePath.hops.length > 0 ? "每一跳的延迟是那台中转探它下一跳的结果；整条路的延迟是入口探到底的结果。" : undefined}
        >
          {!status ? (
            <ListRow label="在读线路状态" detail="稍等" />
          ) : weighted ? (
            paths.map((path) => (
              <ListRow
                key={path.key}
                icon={<StatusDot health={pathHealth(path)} />}
                label={`${path.letter} ${path.name}`}
                detail={<>{pathChain(path)}{path.down && path.downReason ? <span className="text-[var(--fx-warn-text)]"> · {path.downReason}</span> : null}</>}
                value={<span className="flex items-center gap-2"><span className="text-meta text-muted-foreground">{policy.strategy === "weighted" ? `${shares[path.index]}%` : ""}</span><ScoreTag score={path.score} /></span>}
              />
            ))
          ) : activePath ? (
            <>
              <ListRow
                icon={<StatusDot health={pathHealth(activePath)} />}
                label={`${activePath.letter} ${activePath.name}`}
                detail={pathChain(activePath)}
                trailing={(
                  <span className="flex items-center gap-2">
                    {activePath.connections !== null && activePath.connections > 0 ? <span className="text-meta text-muted-foreground">{activePath.connections} 连接</span> : null}
                    <ScoreTag score={activePath.score} />
                  </span>
                )}
              />
              <HopRows path={activePath} />
              <PathMetrics path={activePath} />
            </>
          ) : (
            <ListRow icon={<StatusDot health="unknown" />} label="还不知道现在走哪条" detail={report.text} />
          )}
        </ListSection>

        {!weighted ? (
          <ListSection header="备用路径" footer={others.some((path) => path.down) ? "用不了的路径会被跳过，恢复并稳定一阵后重新参与。" : undefined}>
            {!status ? (
              <ListRow label="在读线路状态" />
            ) : others.length === 0 ? (
              <ListRow label="没有别的路径" detail="线路组里只剩这一条" />
            ) : (
              others.map((path) => {
                const line = policy.lines[path.index];
                return (
                  <ListRow
                    key={path.key}
                    icon={<StatusDot health={pathHealth(path)} />}
                    label={`${path.letter} ${path.name}`}
                    detail={(
                      <>
                        {pathChain(path)}
                        {path.down && path.downReason ? <span className="text-[var(--fx-warn-text)]"> · {path.downReason}</span> : null}
                        {!path.down && path.latencyMs !== null ? ` · ${Math.round(path.latencyMs)}ms` : null}
                        {!path.down && path.lossPct !== null && path.lossPct > 0 ? ` · 丢包 ${path.lossPct.toFixed(1)}%` : null}
                      </>
                    )}
                    trailing={(
                      <span className="flex items-center gap-1.5">
                        {line?.preferred ? <EntityTag>首选</EntityTag> : null}
                        {path.prewarming ? <EntityTag tone="path">预热中</EntityTag> : null}
                        <ScoreTag score={path.score} />
                      </span>
                    )}
                  />
                );
              })
            )}
          </ListSection>
        ) : null}

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
              const failed = kind === "precheck_failed" || kind === "unhealthy" || kind === "issue";
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
  refetchIntervalMs = 10_000,
  footer,
  ...panel
}: RouteGroupSheetProps) {
  const enabled = open && !!policy && !!ruleId;
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
        <DialogContent className="bg-[var(--fx-l0-page)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>线路组</DialogTitle>
            <DialogDescription className="truncate">{shown.subjectName}</DialogDescription>
          </DialogHeader>
          <RouteGroupPanel
            {...panel}
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
