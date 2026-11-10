import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

import { GroupedList, ListRow, ListSection } from "@/components/ios/GroupedList";
import { StatusDot } from "@/components/network/StatusDot";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LineChipButton } from "@/features/lines/LineUi";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatAgo } from "@shared/dashboardAttention";
import type { NetworkHealth } from "@shared/networkHealth";
import {
  ROUTE_DEST_SPREAD_LABELS,
  ROUTE_EVENT_KIND_LABELS,
  ROUTE_MODE_INFO,
  normalizeRouteEventKind,
  routeLineName,
  routeModeHint,
  type RouteDestSpread,
  type RouteEndpoint,
  type RouteGroupPolicy,
} from "@shared/routeGroup";
import { describeRoutePolicyReport, formatPolicyClock, type RoutePolicy } from "@shared/routePolicy";
import { formatRouteScore } from "@shared/routeScore";
import type { RouteSwitchSummary } from "@shared/routeSwitchSummary";
import type { RouteBoardEntry, RouteBoardRate } from "./RouteBoard";
import { ConditionRow, SentenceRow } from "./RoutePolicySheet";
import { Skeleton } from "@/components/ui/skeleton";
import { RouteLineDetail, RouteLineTools, useRouteLinePause, type RouteLineSwitch } from "./RouteLineOverview";
import { ROUTE_LINE_MODE_LABEL, routeLineSubtitle } from "./routeLineText";
import { useRouteLineEditor } from "./RouteLineInlineEditor";
import type { LineRuleRow } from "./routeLineOptions";

/*
  线路组面板：从规则卡上那个「主备 · 主线路 · 92 优」点进来。

  回答的还是那几件事，但按路径说，不按地址说：
    现在走哪条（以及这句话能信到什么程度）
    当前路径 —— 逐跳的延迟和中继状态，整条路的评分和四个指标
    备用路径 —— 每条的评分、健康、为什么用不了
    调度计划 —— 按什么选（此刻起作用的那一行高亮）、什么时候切
    最近切换 —— 什么时候、从哪条到哪条、为什么
  手动换线路只在第一页每条线路的状态胶囊上（「切到这条 / 交回自动」，RouteLineOverview）：2.3.499 起这里
  不再有「应急人工指定 · 强制走一条」，两处做同一件事。

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
  /** 到这一跳走的隧道（隧道段）；null = 普通中继。 */
  viaTunnel?: { id: number; name: string; mode?: string } | null;
  maintenance?: boolean;
  offline?: boolean | null;
  /** 节点熔断：几条线路都探不通它。 */
  tripped?: boolean;
  /** 这一段最近 20 次探测的成功率；没样本为 null。 */
  successPct?: number | null;
};

export type RouteStatusPath = {
  key: string;
  index: number;
  letter: string;
  name: string;
  hops: RouteStatusHop[];
  dest: RouteEndpoint;
  /** 落地叫什么：我的节点的名字，或者自己那台机器的名字；都不是为 null（界面写地址）。 */
  destName?: string | null;
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
  /** UDP 那一侧的健康（Agent 2.2.251 起）；老 Agent 没报就是 null。 */
  udpHealthy?: boolean | null;
  udpLatencyMs?: number | null;
  /** 沿途主机里最忙那台的负载（0–100，Agent 2.2.251 起回显，评分已按它扣过）；没有是 null。 */
  loadPct?: number | null;
  down: boolean;
  downReason: string;
  connections: number | null;
  samples: number;
  active: boolean;
  prewarming: boolean;
  /** 入口 Agent 最近一次探这条路径（Unix 毫秒）。 */
  probedAt?: number | null;
  /** 第几组（0 = 主线路那组）；老数据没有。 */
  tier?: number | null;
  /** 从哪条线路展开来的。 */
  lineKey?: string | null;
  paused?: boolean;
  /** 后面几段（中转各自探的）加起来；整条链 = latencyMs + 它。 */
  downstreamMs?: number;
  /** 真实连接最近 10 分钟的拨号。 */
  dials?: { ok: number; failed: number; slow: number; dialMs: number; lastAt: number } | null;
  /** 连着几次探不通。 */
  consecutiveFailures?: number;
};

/** 期望 vs 实际对账的一行差异（shared/routeSpecDrift）。 */
export type RouteSpecDriftField = { key: string; label: string; expected: string; actual: string };

export type RouteStatus = {
  ruleId: number;
  policy: RouteGroupPolicy;
  paths: RouteStatusPath[];
  activeIndex: number;
  activeSince: number | null;
  prewarmIndex: number;
  agentReportedAt: number | null;
  agentStale: boolean;
  /** 机器上跑的和面板配的对不上（Agent 2.2.253 起）：差在哪、按机器几点报的比；一致 / 老 Agent 是 null。 */
  drift?: { fields: RouteSpecDriftField[]; reportedAt: number } | null;
  /** 切换演练（server/routeDrill）：有没有正在进行的；没有就是 null。界面只拿它决定按钮写「演练」还是「结束演练」。 */
  drill?: { active: { lineKey: string; phase: "down" | "restoring" } | null } | null;
  /** tcp / udp / both */
  protocol?: string;
  /** 这条规则（入口）此刻的速率。 */
  rate?: RouteBoardRate;
  switches?: RouteSwitchSummary | null;
  entry?: RouteBoardEntry | null;
  /** cold / hot / aggregate / replicate */
  delivery?: string;
  /** 线路定义（分层候选）。 */
  lines?: Array<{ key: string; name: string; paused: boolean; layers: unknown[]; dests: unknown[]; weight: number; destSpread?: RouteDestSpread }>;
  /** 最近 10 分钟客户端连进来：拨通了一条路径的 / 一条都没拨通的。 */
  inbound?: { ok: number; failed: number } | null;
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
  /** 切换时新旧两条整条链的延迟、择优切过去前领先了多久（Agent 2.2.243 起）。 */
  fromChainMs?: number | null;
  toChainMs?: number | null;
  heldSeconds?: number | null;
  /** 哪台入口报的：一条转发组线路展开在好几台入口机上时才有（服务端 routeLineEvents）。 */
  entryHostName?: string | null;
  at: number;
};

// 线路质量曲线（recharts）展开详情时才下载；占位和它一样高，不跳版。
const RouteQualityHistory = lazy(() => import("./RouteQualityHistory").then((m) => ({ default: m.RouteQualityHistory })));

function RouteQualityHistoryPlaceholder() {
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-hidden="true">
      <Skeleton className="mx-1 h-5 w-24" />
      <Skeleton className="h-44 w-full" />
    </section>
  );
}

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
  nowMs?: number;
  timeZone?: string;
};

/* 线路详情的「异常明细」：上面已经有分层图和线路列表，这里只写结论、调度计划和最近切换，不再画路径。 */
export function RouteGroupPanel({ policy, status, events, nowMs, timeZone }: RouteGroupPanelProps) {
  const now = nowMs ?? Date.now();
  const report = describeRoutePolicyReport(policy, { nowMs: now, timeZone });
  const weighted = policy.mode === "weighted";
  const modeInfo = ROUTE_MODE_INFO[policy.mode];

  return (
    <div className="flex min-w-0 flex-col gap-[var(--fx-space-5)]">
      <div className="flex items-start gap-2.5 px-1">
        <StatusDot health={reportHealth[report.tone]} className="mt-1.5" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-secondary-type font-semibold text-foreground">{report.text}</p>
          {status?.drift ? (
            <p className="text-meta text-[var(--fx-down-text)]" data-testid="route-drift-note">
              机器上跑的不是面板里这份：{status.drift.fields.map((field) => `${field.label}（面板 ${field.expected} / 机器 ${field.actual}）`).join("；")}。
            </p>
          ) : null}
          {policy.divergence ? <p className="text-meta text-[var(--fx-warn-text)]">{policy.divergence}</p> : null}
          {report.note ? <p className="text-meta text-muted-foreground">{report.note}</p> : null}
          {status?.agentStale && status.agentReportedAt ? (
            <p className="text-meta text-[var(--fx-warn-text)]">评分是 {formatAgo(now - status.agentReportedAt)}报的，之后 Agent 没再上报。</p>
          ) : null}
        </div>
      </div>

      {policy.warnings.map((warning) => (
        <p key={warning} className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-meta text-[var(--fx-warn-text)]">
          {warning}
        </p>
      ))}

      <GroupedList>
        <ListSection
          header="调度计划"
          footer={weighted ? undefined : "从上往下，先对上的那一条说了算。它指的那条挂了，照样往下找 —— 选路和健康检查是两件事。"}
        >
          <SentenceRow label="策略" detail={`${modeInfo.template} · ${modeInfo.label}：${routeModeHint(policy.mode, policy.perSession)}`} />
          {(() => {
            // 「多落地」（2.3.501）：一次走一条线路时，选了多落地一起分的线路在这里列出来
            const delivery = status?.delivery;
            if (weighted || delivery === "aggregate" || delivery === "replicate") return null;
            const spreading = (status?.lines || [])
              .map((line, index) => ({ line, index }))
              .filter(({ line }) => !!line.destSpread && line.destSpread !== "one");
            if (spreading.length === 0) return null;
            return (
              <SentenceRow
                label="多落地"
                detail={spreading.map(({ line, index }) => `${routeLineName(line.name, index)} ${ROUTE_DEST_SPREAD_LABELS[line.destSpread || "one"].label}`).join("；")}
              />
            );
          })()}
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
                    {event.reasonText || event.score || event.entryHostName ? (
                      <span className="text-meta text-muted-foreground">
                        {event.entryHostName ? `${event.entryHostName}${event.reasonText || event.score ? " · " : ""}` : ""}
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
      </GroupedList>
    </div>
  );
}

export type RouteGroupSheetProps = Omit<RouteGroupPanelProps, "policy" | "status" | "events"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ruleId: number | null;
  /** 规则名，标题「广港hkt · 线路组」。 */
  subjectName: string;
  policy: RoutePolicy | null;
  /** 有规则本身，详情第一页的线路就能直接改；没有（转发组的子规则）就退回调用方给的 onEdit（打开整条规则的编辑框）。 */
  rule?: LineRuleRow | null;
  onEdit?: () => void;
  /** 面板打开时每隔多久刷一次状态（毫秒）；测试里传 0 关掉。 */
  refetchIntervalMs?: number;
  footer?: ReactNode;
  /** 能不能动手：就地改线路、暂停、点状态胶囊手动切换。 */
  canEdit: boolean;
  pending?: boolean;
  /** 手动指定（状态胶囊「切到这条」）；onDone 在存进库里之后调。 */
  onPin?: (index: number, durationSeconds: number | null, onDone?: () => void) => void;
  onUnpin?: (onDone?: () => void) => void;
};

export function RouteGroupSheet({
  open,
  onOpenChange,
  ruleId,
  subjectName,
  policy,
  rule,
  onEdit,
  refetchIntervalMs = 3_000,
  footer,
  canEdit,
  pending = false,
  onPin,
  onUnpin,
  ...panel
}: RouteGroupSheetProps) {
  const enabled = open && !!policy && !!ruleId;
  const linePause = useRouteLinePause(Number(ruleId) || 0);
  const statusQuery = trpc.rules.routeStatus.useQuery({ ruleId: Number(ruleId) }, { enabled, refetchInterval: refetchIntervalMs || false, staleTime: 5_000 });
  // 状态 3 秒一刷（数字要跟得上）；切换记录不会那么勤，10 秒够了
  const eventsQuery = trpc.rules.routeEvents.useQuery({ ruleId: Number(ruleId), limit: 20 }, { enabled, refetchInterval: refetchIntervalMs ? Math.max(refetchIntervalMs, 10_000) : false, staleTime: 5_000 });
  const [detailsOpen, setDetailsOpen] = useState(false);
  // 「添加备用线路 / 怎么切 / 高级策略」默认收着（照效果图 ①），点「线路」标题右边那行展开
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 机器上跑的和面板配的对不上：红条上的「重新下发」（不改配置，只再送一遍；几秒后状态刷过来就知道对没对上）
  const resync = trpc.lineDiagnostics.lineResync.useMutation({
    onSuccess: () => {
      toast.success("已重新下发，几秒后看红条消没消");
      void statusQuery.refetch();
    },
    onError: (error) => toast.error(error.message || "下发失败"),
  });
  /*
    关的那一下（130ms 的动画）调用方已经把规则清掉了，拿上一份接着画 —— 不然面板在
    动画里先塌成只剩标题再消失。
  */
  const [, setLocation] = useLocation();
  const last = useRef<{ subjectName: string; policy: RoutePolicy; rule: LineRuleRow | null } | null>(null);
  if (open && policy) last.current = { subjectName, policy, rule: rule ?? null };
  const shown = last.current;
  const status = (statusQuery.data as RouteStatus | null | undefined) ?? null;
  const events = (eventsQuery.data as RouteEvent[] | undefined) ?? [];
  const mode = shown?.policy.mode ?? "failover";
  const modeLabel = ROUTE_LINE_MODE_LABEL[mode] || ROUTE_LINE_MODE_LABEL.failover;
  // 手动换线路：点线路的状态胶囊「切到这条」= 人工指定（按权重分的没有「走哪条」，不给）
  const lineSwitch: RouteLineSwitch | undefined = shown && canEdit && onPin && onUnpin && shown.policy.mode !== "weighted"
    ? {
        pinIndex: shown.policy.pin ? shown.policy.pin.index : null,
        pinUntilMs: shown.policy.pin?.untilMs ?? null,
        pending,
        onPin,
        onUnpin,
        nowMs: panel.nowMs,
        timeZone: panel.timeZone,
      }
    : undefined;
  // 线路就在详情第一页改（没有单独的「编辑线路组」了）；只有拿不到规则本身时才退回去改整条规则
  const editing = useRouteLineEditor({
    rule: canEdit ? shown?.rule ?? null : null,
    enabled: open && !!policy,
    status,
    onPause: linePause.onPause,
    pausing: linePause.pausing,
    lineSwitch,
    settingsOpen,
  });
  const editRuleFallback = canEdit && !shown?.rule && !!onEdit;
  return (
    <Dialog open={open && !!policy} onOpenChange={(next) => { if (!next) { setDetailsOpen(false); setSettingsOpen(false); } onOpenChange(next); }}>
      {shown ? (
        // 打开时不把焦点放进去：第一个能聚焦的是主线路的名字，手机上一开键盘就弹出来
        <DialogContent className="gap-3 bg-[var(--fx-l0-page)] sm:max-w-xl" onOpenAutoFocus={(event) => event.preventDefault()}>
          <DialogHeader className="space-y-0.5 pr-10">
            <div className="fx-line-ui flex min-w-0 items-center justify-between gap-2">
              <DialogTitle className="min-w-0 truncate text-[19px] font-bold">{shown.subjectName} · 线路组</DialogTitle>
              {editRuleFallback ? (
                <LineChipButton className="shrink-0" onClick={onEdit} data-testid="route-line-edit-rule">
                  <Pencil className="h-3 w-3" aria-hidden="true" />改规则
                </LineChipButton>
              ) : null}
            </div>
            <DialogDescription className="truncate text-[12.5px]">{routeLineSubtitle(status, mode)}</DialogDescription>
          </DialogHeader>
          {!status ? (
            <p className="px-1 text-[12.5px] text-muted-foreground">在读线路状态…</p>
          ) : status.paths.length > 0 ? (
            <RouteLineDetail
              status={status}
              events={events}
              modeLabel={modeLabel}
              onPause={canEdit ? linePause.onPause : undefined}
              pausing={linePause.pausing}
              detailsOpen={detailsOpen}
              onToggleDetails={() => setDetailsOpen(!detailsOpen)}
              nowMs={panel.nowMs}
              timeZone={panel.timeZone}
              editor={editing.editor}
              lineSwitch={lineSwitch}
              settings={editing.editor ? { open: settingsOpen, onToggle: () => setSettingsOpen(!settingsOpen) } : undefined}
              onResync={canEdit && ruleId ? () => resync.mutate({ ruleId: Number(ruleId) }) : undefined}
              resyncing={resync.isPending}
            />
          ) : null}
          {detailsOpen || (status && status.paths.length === 0) ? (
            <div className="flex min-w-0 flex-col gap-3 border-t border-[var(--fx-stroke-weak)] pt-3" data-testid="route-line-detail-panel">
              <RouteGroupPanel {...panel} policy={shown.policy} status={status} events={events} />
              {status ? <RouteLineTools status={status} canDrill={!!canEdit} /> : null}
              <Suspense fallback={<RouteQualityHistoryPlaceholder />}>
                <RouteQualityHistory
                  ruleId={Number(ruleId) || 0}
                  enabled={enabled}
                  activeKey={(status?.paths || []).find((path) => path.active)?.key ?? null}
                />
              </Suspense>
              <div className="flex flex-wrap justify-end gap-2">
                {footer}
                {ruleId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onOpenChange(false);
                      setLocation(`/topology?rule=${Number(ruleId)}`);
                    }}
                  >
                    查看拓扑
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {editing.saveBar}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
