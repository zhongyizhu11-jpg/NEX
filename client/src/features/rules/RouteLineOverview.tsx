import { useState, type ReactNode } from "react";
import { Download, Gauge } from "lucide-react";
import { toast } from "sonner";

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
  lineChipClass,
  type LineTone,
} from "@/features/lines/LineUi";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { describeRouteIssue, normalizeRouteEventKind } from "@shared/routeGroup";
import { formatPolicyClock } from "@shared/routePolicy";
import type { RouteEvent, RouteStatus, RouteStatusPath } from "./RouteGroupSheet";
import { RouteLineDiagram } from "./RouteLineDiagram";
import {
  chainLatency,
  lineBadgeText,
  lineLongName,
  lineShortClock,
  lineShortIssue,
  roundMs,
  routeDestLabel,
  routeLineGroups,
  routeLandingName,
  routeLineSwitchSummary,
  routePathText,
  routeSwitchSeconds,
  type RouteLineGroup,
} from "./routeLineText";

/*
  线路详情（2.3.496，照效果图 ①「规则卡点开：线路组运行中」）：

    大数字    整条链此刻多少毫秒 + 坏了几秒内切走
    分层图    入口 → 隧道 / 中转 → 落地（RouteLineDiagram.tsx）
    线路      能改的时候就是编辑器本身（2.3.498 起没有单独的「编辑线路组」框，RouteLineInlineEditor.tsx），
              每条线路后面照样是使用中 / 待命 / 不通 ×N 和立刻生效的暂停；只能看的时候一行一条（划掉的是坏了的）
    连接      客户端 → 入口 → … → 落地，每段最近 10 分钟的成功率，坏的那段标红写原因；
              下面一行：最近切换、异常明细（展开原来那份详细面板）；暂停在线路列表每一行上

  数据都来自 rules.routeStatus / rules.routeEvents，这里只画；几句共用的字在 routeLineText.ts。
*/

type Path = RouteStatusPath;

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

// ---------------------------------------------------------------- 线路

/** 一条线路此刻的状态胶囊：已暂停 / 使用中 / 不通 ×N（或原因）/ 待命；人工指定了这条，后面带「指定」。 */
function routeLinePill(group: RouteLineGroup, pinned = false): { tone: LineTone; text: string; dot?: boolean } {
  const tag = pinned ? " · 指定" : "";
  if (group.paused) return { tone: "gray", text: "已暂停" };
  if (group.active) return { tone: "ok", text: `使用中${tag}`, dot: true };
  if (group.allDown) return { tone: "down", text: `${group.failures >= 2 ? `不通 ×${group.failures}` : group.reason ? lineShortIssue(group.reason) : "不通"}${tag}` };
  return { tone: "gray", text: `待命${tag}` };
}

/**
 * 手动换线路（2.3.498）：点状态胶囊就能「切到这条」，走的是人工指定（压过时段表和评分，到点交回自动；
 * 指定的那条挂了照样往下切）。以前要点开「异常明细」找「强制走一条」，用户问「想手动换怎么办」。
 * 按权重分的线路组没有「走哪条」，不给。
 */
export type RouteLineSwitch = {
  /** 现在钉在第几条路径（status.paths[].index）；null = 没指定。 */
  pinIndex: number | null;
  pinUntilMs: number | null;
  pending: boolean;
  onPin: (pathIndex: number, durationSeconds: number | null) => void;
  onUnpin: () => void;
  nowMs?: number;
  timeZone?: string;
};

/** 手动指定最长多久（防手滑多打一个 0）：30 天，再久就选「不限时」。 */
const MAX_PIN_MINUTES = 30 * 24 * 60;

/** 填的时长换成秒；不合法（空、0、负数、超过 30 天）返回 null。 */
export function pinDurationSeconds(amount: string, unit: "min" | "hour"): number | null {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  const minutes = unit === "hour" ? value * 60 : value;
  if (minutes < 1 || minutes > MAX_PIN_MINUTES) return null;
  return Math.round(minutes * 60);
}

/**
 * 点状态胶囊弹出来的小框：时长自己填（几分钟 / 几小时），或者不限时（2.3.498，原来一排五个固定时长，
 * 用户嫌多）。菜单里放输入框：输入框自己吞掉按键，不然菜单的「按字母跳到菜单项」会把焦点抢走。
 */
function LineSwitchMenu({ group, pill, lineSwitch }: { group: RouteLineGroup; pill: ReactNode; lineSwitch: RouteLineSwitch }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<"min" | "hour">("hour");
  const [forever, setForever] = useState(false);
  const pinnedHere = lineSwitch.pinIndex !== null && group.paths.some((path) => path.index === lineSwitch.pinIndex);
  const until = lineSwitch.pinUntilMs ? `，到 ${formatPolicyClock(lineSwitch.pinUntilMs, lineSwitch.nowMs ?? Date.now(), lineSwitch.timeZone)} 交回自动` : "，直到交回自动";
  const head = pinnedHere
    ? `已指定走这条${until}`
    : group.paused
      ? "这条暂停着：先恢复才能切过去"
      : group.active
        ? "正在走这条：钉住它，自动选择就不会把它换走"
        : "切到这条：压过自动选择，到点交回自动";
  const seconds = forever ? null : pinDurationSeconds(amount, unit);
  const canPin = !pinnedHere && !group.paused;
  const pin = () => {
    if (!forever && seconds === null) return;
    lineSwitch.onPin(group.shown.index, seconds);
    setOpen(false);
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="shrink-0 rounded-full" aria-label={`手动切换：${group.name}`} title="点一下：切到这条 / 交回自动" data-testid="route-line-switch">
          {pill}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="fx-line-ui w-64 p-3">
        <p className="text-[11.5px] leading-[1.45] text-muted-foreground">{head}</p>
        {canPin ? (
          <div className="mt-2.5 flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-[12.5px]">
              <span className="shrink-0">走</span>
              <Input
                type="number"
                inputMode="decimal"
                min={1}
                value={amount}
                disabled={forever}
                onChange={(event) => setAmount(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") pin();
                }}
                aria-label="切过去走多久"
                className="h-8 w-16 text-center text-[13px]"
                data-testid="route-line-pin-amount"
              />
              {(["min", "hour"] as const).map((option) => (
                <LineChipButton key={option} variant={unit === option ? "sel" : "default"} disabled={forever} onClick={() => setUnit(option)} aria-pressed={unit === option}>
                  {option === "min" ? "分钟" : "小时"}
                </LineChipButton>
              ))}
            </div>
            <label className="flex w-fit items-center gap-2 text-[11.5px] text-muted-foreground">
              <Checkbox checked={forever} onCheckedChange={(checked) => setForever(!!checked)} aria-label="不限时，直到交回自动" />
              不限时，直到交回自动
            </label>
            {group.allDown && !group.active ? (
              <p className="text-[11px] leading-[1.45] text-[var(--fx-warn-text)]">现在不通：指定了也会先往下切，通了再切过来。</p>
            ) : null}
            <Button type="button" size="sm" className="h-8 w-full rounded-[10px]" disabled={lineSwitch.pending || (!forever && seconds === null)} onClick={pin} data-testid="route-line-pin">
              {group.active ? "钉住这条" : "切过去"}
            </Button>
          </div>
        ) : null}
        {lineSwitch.pinIndex !== null ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 h-8 w-full rounded-[10px]"
            disabled={lineSwitch.pending}
            onClick={() => { lineSwitch.onUnpin(); setOpen(false); }}
            data-testid="route-line-unpin"
          >
            交回自动
          </Button>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 状态胶囊（能手动换时点它切到这条）+ 暂停 / 恢复（点了立刻生效，不用保存）。只读的线路行和编辑器的每条线路共用。 */
function LineStatusControls({ group, onPause, pausing = false, lineSwitch }: { group: RouteLineGroup; onPause?: (lineKey: string, paused: boolean) => void; pausing?: boolean; lineSwitch?: RouteLineSwitch }) {
  const pinned = !!lineSwitch && lineSwitch.pinIndex !== null && group.paths.some((path) => path.index === lineSwitch.pinIndex);
  const pill = routeLinePill(group, pinned);
  const pillNode = <LinePill tone={pill.tone} dot={pill.dot} title={group.allDown && group.reason ? describeRouteIssue(group.reason) : undefined} testId="route-line-state">{pill.text}</LinePill>;
  return (
    <>
      {lineSwitch ? <LineSwitchMenu group={group} pill={pillNode} lineSwitch={lineSwitch} /> : pillNode}
      {onPause ? (
        <LineIconButton
          aria-label={group.paused ? `恢复线路 ${group.name}` : `暂停线路 ${group.name}`}
          title={group.paused ? "恢复这条（马上生效）" : "暂停这条（马上生效）"}
          disabled={pausing}
          onClick={() => onPause(group.key, !group.paused)}
          data-testid="route-line-pause"
        >
          {group.paused ? <LinePlayGlyph /> : <LinePauseGlyph />}
        </LineIconButton>
      ) : null}
    </>
  );
}

/**
 * 编辑器里一条线路后面那组（RouteLinesEditor 的 renderLineStatus）。还没保存的新线路没有状态，返回 null ——
 * 编辑器看到 null 才照旧给「参与切换」的勾，所以这里是函数不是组件（组件元素永远不是 null）。
 */
export function routeLineStatusControls(status: RouteStatus | null, lineKey: string, onPause?: (lineKey: string, paused: boolean) => void, pausing = false, lineSwitch?: RouteLineSwitch): ReactNode {
  const group = status ? routeLineGroups(status).find((item) => item.key === lineKey) : undefined;
  return group ? <LineStatusControls group={group} onPause={onPause} pausing={pausing} lineSwitch={lineSwitch} /> : null;
}

export function RouteLineList({ status, onPause, pausing = false, lineSwitch }: { status: RouteStatus; onPause?: (lineKey: string, paused: boolean) => void; pausing?: boolean; lineSwitch?: RouteLineSwitch }) {
  const groups = routeLineGroups(status);
  return (
    <div className="flex flex-col gap-[7px]" data-testid="route-line-list">
      {groups.map((group) => {
        const bad = (group.allDown && !group.active) || group.paused;
        const text = routePathText(status, group.shown);
        return (
          <LineRow key={group.key} on={group.active} data-testid="route-line-row">
            <LineBadge main={group.index === 0}>{lineBadgeText(group.index)}</LineBadge>
            <LinePath bad={bad} title={`${group.name}：${text} · ${routeDestLabel(group.shown)}${group.paths.length > 1 ? `（这条线路组合出 ${group.paths.length} 条路径）` : ""}`}>
              {text}
            </LinePath>
            <LineStatusControls group={group} onPause={onPause} pausing={pausing} lineSwitch={lineSwitch} />
          </LineRow>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- 连接 · 按段

type Stage = { label: string; pct: number | null; why: string | null };

export function routeStages(status: RouteStatus, path: Path): { nodes: string[]; stages: Stage[] } {
  const nodes = ["客户端", status.entry?.name || "入口", ...path.hops.map((hop) => hop.name), routeLandingName(path)];
  const inbound = status.inbound && status.inbound.ok + status.inbound.failed > 0 ? roundMs((status.inbound.ok / (status.inbound.ok + status.inbound.failed)) * 100) : null;
  const dials = path.dials;
  const first = dials && dials.ok + dials.failed > 0 ? roundMs((dials.ok / (dials.ok + dials.failed)) * 100) : null;
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
    return { tone: "warn", text: `${lineShortClock(latest.at, timeZone)} ${manual ? "手动" : "自动"}切到 ${lineLongName(activeLine)}` };
  }
  if (activeLine === 0 && to === 0) {
    const away = switches.find((event) => event.at < latest.at && lineOf(event.toKey) > 0);
    if (away) return { tone: "ok", text: `${lineShortClock(away.at, timeZone)} 切到 ${lineLongName(lineOf(away.toKey))} · ${lineShortClock(latest.at, timeZone)} 已切回` };
    return { tone: "ok", text: `${lineShortClock(latest.at, timeZone)} 换到 主线路` };
  }
  return { tone: "ok", text: `${lineShortClock(latest.at, timeZone)} 切到 ${to >= 0 ? lineLongName(to) : latest.toLabel || "另一条"}` };
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
  editor,
  lineSwitch,
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
  /** 能改的时候：线路这一节直接是编辑器（不再另开「编辑线路组」）；没给就是只读的线路列表。 */
  editor?: ReactNode;
  /** 手动换线路（点状态胶囊）；只读列表用，编辑器里的由编辑器自己带。 */
  lineSwitch?: RouteLineSwitch;
}) {
  const now = nowMs ?? Date.now();
  const chip = routeSwitchChip(status, events, now, timeZone);
  return (
    <div className="fx-line-ui flex min-w-0 flex-col gap-3" data-testid="route-line-overview">
      <RouteLineHero status={status} />
      <RouteLineDiagram status={status} modeLabel={modeLabel} timeZone={timeZone} />
      <div>
        <LineSec left="线路" right={routeLineSwitchSummary(status)} />
        {editor ?? <RouteLineList status={status} onPause={onPause} pausing={pausing} lineSwitch={lineSwitch} />}
      </div>
      <div>
        <LineSec left="连接 · 最近 10 分钟" right={<span title="入站：客户端连进来后拨通一条路径的比例；第二段：入口真实拨号的成功率；后面每段：中转探下一跳（近 20 次）">精确到哪一段</span>} />
        <LineCard className="px-2 py-3">
          <RouteStageStrip status={status} />
          {/*
            最近一次切换 + 异常明细排一行。「暂停这条」去掉了：上面线路列表里每一行都有暂停键，
            两个地方做同一件事反而让人犹豫该点哪个。
          */}
          <div className="mt-4 flex min-w-0 items-center justify-between gap-2">
            <span className={lineChipClass("default", "min-w-0")} data-testid="route-line-switch-chip">
              <LineDot tone={chip.tone} /><span className="truncate">{chip.text}</span>
            </span>
            <LineChipButton className="shrink-0" variant={detailsOpen ? "sel" : "default"} aria-expanded={detailsOpen} onClick={onToggleDetails} data-testid="route-line-details">
              异常明细
            </LineChipButton>
          </div>
        </LineCard>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 暂停、导出、逐段测带宽

/** 线路详情里暂停 / 恢复一条线路（马上生效）；onDone 在成功后调（编辑器拿它把编辑稿里的暂停也改了）。 */
export function useRouteLinePause(ruleId: number) {
  const utils = trpc.useUtils();
  const pause = trpc.lineDiagnostics.linePause.useMutation({
    onSuccess: (_data, variables) => {
      void utils.rules.routeStatus.invalidate({ ruleId });
      void utils.rules.routeEvents.invalidate({ ruleId });
      void utils.rules.routeBoard.invalidate();
      void utils.rules.list.invalidate();
      toast.success(variables.paused ? "已暂停，在走它的连接马上切到下一条" : "已恢复，探通后重新参与");
    },
    onError: (error) => toast.error(error.message),
  });
  return {
    onPause: (lineKey: string, paused: boolean, onDone?: () => void) => pause.mutate({ ruleId, lineKey, paused }, { onSuccess: () => onDone?.() }),
    pausing: pause.isPending,
  };
}

export function RouteLineTools({ status }: { status: RouteStatus }) {
  const utils = trpc.useUtils();
  const [runId, setRunId] = useState<string | null>(null);
  const active = status.paths.find((path) => path.active) || status.paths[0];
  const start = trpc.lineDiagnostics.segmentSpeedStart.useMutation({
    onSuccess: (run) => setRunId(String(run.runId)),
    onError: (error) => toast.error(error.message),
  });
  const run = trpc.lineDiagnostics.segmentSpeedStatus.useQuery({ runId: runId || "" }, {
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1500 : false),
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
  const data = run.data;
  return (
    <div className="fx-line-ui flex flex-col gap-1.5">
      {/* 和线路详情里别的小块一样大（以前是 Button，手机上被撑到 44px 高） */}
      <div className="flex flex-wrap gap-1.5">
        <LineChipButton disabled={!active || start.isPending || data?.status === "running"} onClick={() => active && start.mutate({ ruleId: status.ruleId, pathKey: active.key })} data-testid="route-line-speed">
          <Gauge className="h-3.5 w-3.5" />{data?.status === "running" ? "测带宽中…" : "逐段测带宽"}
        </LineChipButton>
        <LineChipButton disabled={exporting} onClick={() => void exportLine()} data-testid="route-line-export">
          <Download className="h-3.5 w-3.5" />导出 7 天记录
        </LineChipButton>
      </div>
      {data?.segments ? (
        <div className="flex flex-col gap-0.5 rounded-xl bg-[var(--fx-l1-surface)] px-3 py-2 text-xs" data-testid="route-line-speed-result">
          {data.segments.map((segment, index) => (
            <div key={index} className={cn("flex items-center justify-between gap-2", data.slowest === index && "font-semibold text-[var(--fx-warn-text)]")}>
              <span className="truncate">{segment.from.name} → {segment.to.name}</span>
              <span className="shrink-0 font-mono">
                {segment.status === "done" ? `${segment.mbps === null ? "—" : Math.round(segment.mbps)} Mbps${data.slowest === index ? " · 最慢" : ""}` : segment.status === "skipped" ? "测不了" : segment.status === "error" ? "失败" : "…"}
              </span>
            </div>
          ))}
          {data.segments.filter((segment) => segment.error && segment.status !== "skipped").map((segment, index) => (
            <p key={`e${index}`} className="text-[11px] text-[var(--fx-warn-text)]">{segment.from.name} → {segment.to.name}：{segment.error}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
