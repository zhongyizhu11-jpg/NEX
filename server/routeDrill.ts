/*
  切换演练（2.3.524）。

  主备配好了，平时看不出来有没有用，出事那天才知道。演练就是「让面板把某条线路当成挂了 N 秒」：
  面板往入口 Agent 下发的这条路径上加一个 down 提示（和中转探测发现中间断了、节点维护时用的是同一个
  提示位，server/routeTargetHints/down.ts），Agent 收到就按真挂了处理 —— 记事件、重新选路、按「怎么切」
  决定旧连接断不断；N 秒后提示撤掉，Agent 看到恢复、按规则切回。机器上的转发本身一直没动过。

  面板这边从 Agent 随心跳报回来的东西算报告：
    · 切了没、几秒切完：Agent 的 switch 事件（occurredAt 是机器的时刻）；事件丢了就退回看评分快照里
      的「现在走哪条」什么时候变的。
    · 连接断没断：评分快照里那条路径上挂着的连接数，切换前一刻和切完之后最少剩多少。
    · 切回了没、几秒切回：撤掉提示之后那次切回演练那条的 switch。

  全部在内存里：面板重启就当没演练过（提示跟着消失，Agent 下一次心跳拿到没提示的规格自己恢复），
  报告只留一小时给界面看；长期的记录在切换记录里（kind = drill 的两条：开始、结束）。
*/
import { appendPanelLog } from "./_core/panelLogger";
import { pushAgentRefresh } from "./agentEvents";
import * as db from "./db";
import { routePathLabel, type RoutePath } from "../shared/routeGroup";
import { getRouteStatus, type RouteAgentStats, type RouteHopHint } from "./routeGroupStats";

export const ROUTE_DRILL_MIN_SECONDS = 10;
export const ROUTE_DRILL_MAX_SECONDS = 600;
export const ROUTE_DRILL_DEFAULT_SECONDS = 60;
/** 撤掉提示之后等它切回多久；过了就按「没切回」收尾（最短驻留、人工指定都可能压着不切）。 */
export const ROUTE_DRILL_RESTORE_WAIT_MS = 90_000;
/** 报告留给界面看多久。 */
export const ROUTE_DRILL_REPORT_TTL_MS = 60 * 60 * 1000;
/** 下发给 Agent 的提示原因（Agent 报事件时会写成 relay down: drill；界面用 describeRouteIssue 翻）。 */
export const ROUTE_DRILL_HINT_REASON = "drill";

export type RouteDrillPhase = "down" | "restoring";

export type RouteDrillActiveView = {
  subjectRuleId: number;
  entryHostId: number;
  entryHostName: string | null;
  lineKey: string;
  lineLabel: string;
  seconds: number;
  startedAt: number;
  /** 提示撤掉的时刻（计划的；提前结束了就是实际的）。 */
  endsAt: number;
  phase: RouteDrillPhase;
  /** 演练前走的是不是这条 */
  wasActive: boolean;
  switchedAt: number | null;
  switchMs: number | null;
  switchedToLabel: string | null;
};

export type RouteDrillReport = {
  ruleId: number;
  subjectRuleId: number;
  entryHostId: number;
  entryHostName: string | null;
  lineKey: string;
  lineLabel: string;
  seconds: number;
  startedAt: number;
  endedAt: number;
  finishedAt: number;
  wasActive: boolean;
  activeBeforeLabel: string | null;
  switched: boolean;
  switchMs: number | null;
  switchedToLabel: string | null;
  /** null = 不适用（演练前就没走这条，谈不上切回）。 */
  restored: boolean | null;
  restoreMs: number | null;
  connectionsBefore: number | null;
  connectionsAfter: number | null;
  /** 演练期间 Agent 报的切换 / 健康事件条数。 */
  events: number;
  /** 提前结束的 */
  stoppedEarly: boolean;
  /** 写进切换记录的那一句（机器可读，routeDrillReportReason）；界面用 describeRouteDrillReason 翻成人话。 */
  reason: string;
};

export type RouteDrillView = {
  active: RouteDrillActiveView | null;
  reports: RouteDrillReport[];
};

type ActiveDrill = {
  ruleId: number;
  subjectRuleId: number;
  entryHostId: number;
  entryHostName: string | null;
  lineKey: string;
  lineLabel: string;
  pathKeys: Set<string>;
  pathIndexes: Set<number>;
  labelOf: (index: number) => string | null;
  seconds: number;
  startedAt: number;
  endsAt: number;
  endedAt: number | null;
  phase: RouteDrillPhase;
  wasActive: boolean;
  activeBeforeLabel: string | null;
  switchedAt: number | null;
  switchedToLabel: string | null;
  restoredAt: number | null;
  connectionsBefore: number | null;
  connectionsAfter: number | null;
  events: number;
  stoppedEarly: boolean;
  schedulerHostIds: number[];
  timer: ReturnType<typeof setTimeout> | null;
};

const drills = new Map<number, ActiveDrill>();
const reports = new Map<number, RouteDrillReport>();
let clock: () => number = () => Date.now();

export type RouteDrillSubject = {
  /** 真跑着、报着的那条规则（端口转发是展开的子规则）。 */
  rule: { id: number | string; hostId?: number | string | null };
  paths: readonly RoutePath[];
  entryHostName?: string | null;
  schedulerHostIds: number[];
};

export type StartRouteDrillInput = {
  /** 用户点的那条（端口转发是模板）。 */
  ruleId: number;
  lineKey: string;
  lineLabel: string;
  seconds: number;
  subjects: RouteDrillSubject[];
  /**
   * 安全检查用：界面上那份状态里每条路径现在能不能走。演练那条线路之外至少要有一条能走的，
   * 不然演练就是真的断流。
   */
  statusPaths?: ReadonlyArray<{ key: string; lineKey?: string | null; down: boolean; paused?: boolean; healthy: boolean | null }>;
};

function pathBelongs(path: Pick<RoutePath, "key" | "lineKey">, lineKey: string) {
  return (path.lineKey || path.key) === lineKey;
}

export function clampRouteDrillSeconds(value: unknown) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return ROUTE_DRILL_DEFAULT_SECONDS;
  return Math.min(ROUTE_DRILL_MAX_SECONDS, Math.max(ROUTE_DRILL_MIN_SECONDS, number));
}

/**
 * 开始演练：每个 subject（端口转发一台成员机一条）各登记一份，马上推一次心跳让入口 Agent 拿到提示。
 * 返回登记了几份；哪里不能演练就抛错（界面原样显示）。
 */
export async function startRouteDrill(input: StartRouteDrillInput) {
  const nowMs = clock();
  const seconds = clampRouteDrillSeconds(input.seconds);
  if (input.subjects.length === 0) throw new Error("这条线路还没在任何一台机器上跑起来，没法演练");
  for (const subject of input.subjects) {
    if (drills.has(Number(subject.rule.id))) throw new Error("正在演练，等它结束（或先提前结束）再来");
  }
  if (input.statusPaths) {
    if (!input.statusPaths.some((path) => pathBelongs(path, input.lineKey))) throw new Error("这条线路不在了");
    const others = input.statusPaths.filter((path) => !pathBelongs(path, input.lineKey));
    if (others.length === 0) throw new Error("只有这一条线路，没有可以切过去的");
    if (!others.some((path) => !path.down && !path.paused && path.healthy !== false)) {
      throw new Error("别的线路现在都不通（或暂停着），演练会真的断流：先让一条备用通了再试");
    }
  }
  let started = 0;
  for (const subject of input.subjects) {
    const subjectId = Number(subject.rule.id);
    const indexes = new Set<number>();
    const keys = new Set<string>();
    subject.paths.forEach((path, index) => {
      if (pathBelongs(path, input.lineKey)) {
        indexes.add(index);
        keys.add(path.key);
      }
    });
    if (indexes.size === 0) continue;
    const labelOf = (index: number) => (subject.paths[index] ? routePathLabel(subject.paths[index], index) : null);
    const agent = getRouteStatus(subjectId, nowMs).agent;
    const activeIndex = agent ? agent.activeIndex : -1;
    const wasActive = activeIndex >= 0 && indexes.has(activeIndex);
    const connectionsBefore = agent
      ? Array.from(indexes).reduce<number | null>((sum, index) => {
        const target = agent.targets.find((item) => item.index === index);
        return target && typeof target.connections === "number" ? (sum ?? 0) + target.connections : sum;
      }, null)
      : null;
    const drill: ActiveDrill = {
      ruleId: input.ruleId,
      subjectRuleId: subjectId,
      entryHostId: Number(subject.rule.hostId || 0),
      entryHostName: subject.entryHostName ?? null,
      lineKey: input.lineKey,
      lineLabel: input.lineLabel,
      pathKeys: keys,
      pathIndexes: indexes,
      labelOf,
      seconds,
      startedAt: nowMs,
      endsAt: nowMs + seconds * 1000,
      endedAt: null,
      phase: "down",
      wasActive,
      activeBeforeLabel: activeIndex >= 0 ? labelOf(activeIndex) : null,
      switchedAt: null,
      switchedToLabel: null,
      restoredAt: null,
      connectionsBefore,
      connectionsAfter: null,
      events: 0,
      stoppedEarly: false,
      schedulerHostIds: subject.schedulerHostIds.length > 0 ? subject.schedulerHostIds : [Number(subject.rule.hostId || 0)],
      timer: null,
    };
    drill.timer = setTimeout(() => { void endRouteDrill(subjectId, { early: false }); }, seconds * 1000);
    drill.timer.unref?.();
    drills.set(subjectId, drill);
    reports.delete(subjectId);
    started += 1;
    for (const hostId of drill.schedulerHostIds) if (hostId > 0) pushAgentRefresh(hostId, "route-drill-start", { urgent: true });
    appendPanelLog("info", `[RouteDrill] rule=${input.ruleId} subject=${subjectId} 开始演练：${input.lineLabel} 当成挂了 ${seconds} 秒（之前${wasActive ? "正走这条" : "没走这条"}）`);
  }
  if (started === 0) throw new Error("这条线路不在了");
  await db.insertForwardRuleRouteEvent({
    ruleId: input.ruleId,
    kind: "drill",
    fromKey: null,
    toKey: input.lineKey,
    fromLabel: null,
    toLabel: input.lineLabel,
    reason: `drill: start; seconds=${seconds}`,
    score: null,
    latencyMs: null,
  }).catch(() => undefined);
  return { started, seconds };
}

/** 撤掉提示（到点了，或用户提前结束）：推一次心跳让 Agent 看到恢复，然后等它切回。 */
export async function endRouteDrill(subjectRuleId: number, options: { early: boolean }) {
  const drill = drills.get(Number(subjectRuleId));
  if (!drill || drill.phase !== "down") return false;
  const nowMs = clock();
  if (drill.timer) clearTimeout(drill.timer);
  drill.phase = "restoring";
  drill.endedAt = nowMs;
  drill.endsAt = nowMs;
  drill.stoppedEarly = options.early;
  for (const hostId of drill.schedulerHostIds) if (hostId > 0) pushAgentRefresh(hostId, "route-drill-end", { urgent: true });
  // 演练前就没走这条：撤掉提示后没有「切回」可等，直接收尾；走着的，等它切回（或等够了按没切回算）。
  if (!drill.wasActive) {
    await finalizeRouteDrill(drill);
    return true;
  }
  drill.timer = setTimeout(() => { void finalizeRouteDrill(drill); }, ROUTE_DRILL_RESTORE_WAIT_MS);
  drill.timer.unref?.();
  return true;
}

/** 用户点「提前结束」：这条规则（端口转发含它所有子规则）上在进行的演练都收。 */
export async function stopRouteDrillForRule(ruleId: number) {
  let stopped = 0;
  for (const drill of Array.from(drills.values())) {
    if (drill.ruleId !== Number(ruleId) && drill.subjectRuleId !== Number(ruleId)) continue;
    if (await endRouteDrill(drill.subjectRuleId, { early: true })) stopped += 1;
  }
  return stopped;
}

async function finalizeRouteDrill(drill: ActiveDrill) {
  if (drills.get(drill.subjectRuleId) !== drill) return;
  if (drill.timer) clearTimeout(drill.timer);
  drill.timer = null;
  drills.delete(drill.subjectRuleId);
  const nowMs = clock();
  const endedAt = drill.endedAt ?? nowMs;
  const base: Omit<RouteDrillReport, "reason"> = {
    ruleId: drill.ruleId,
    subjectRuleId: drill.subjectRuleId,
    entryHostId: drill.entryHostId,
    entryHostName: drill.entryHostName,
    lineKey: drill.lineKey,
    lineLabel: drill.lineLabel,
    seconds: drill.seconds,
    startedAt: drill.startedAt,
    endedAt,
    finishedAt: nowMs,
    wasActive: drill.wasActive,
    activeBeforeLabel: drill.activeBeforeLabel,
    switched: drill.switchedAt !== null,
    switchMs: drill.switchedAt !== null ? Math.max(0, drill.switchedAt - drill.startedAt) : null,
    switchedToLabel: drill.switchedToLabel,
    restored: drill.wasActive ? drill.restoredAt !== null : null,
    restoreMs: drill.wasActive && drill.restoredAt !== null ? Math.max(0, drill.restoredAt - endedAt) : null,
    connectionsBefore: drill.connectionsBefore,
    connectionsAfter: drill.connectionsAfter,
    events: drill.events,
    stoppedEarly: drill.stoppedEarly,
  };
  const report: RouteDrillReport = { ...base, reason: routeDrillReportReason(base) };
  reports.set(drill.subjectRuleId, report);
  appendPanelLog("info", `[RouteDrill] rule=${drill.ruleId} subject=${drill.subjectRuleId} 演练结束：${report.reason}`);
  await db.insertForwardRuleRouteEvent({
    ruleId: drill.subjectRuleId,
    kind: "drill",
    fromKey: drill.lineKey,
    toKey: null,
    fromLabel: drill.lineLabel,
    toLabel: drill.switchedToLabel,
    reason: report.reason,
    score: null,
    latencyMs: report.switchMs,
  }).catch(() => undefined);
}

/**
 * 报告写进切换记录的那一句（机器可读，界面用 describeRouteReason 翻成人话）：
 *   drill: done; seconds=60; was=active; switched=2100; to=备用 1; restored=3400; conns=3/3
 * switched / restored 是毫秒，没发生写 none，不适用写 n/a。
 */
export function routeDrillReportReason(report: Omit<RouteDrillReport, "reason">) {
  const parts = [
    "drill: done",
    `seconds=${report.seconds}`,
    `was=${report.wasActive ? "active" : "standby"}`,
    `switched=${report.switched && report.switchMs !== null ? report.switchMs : "none"}`,
    ...(report.switchedToLabel ? [`to=${report.switchedToLabel}`] : []),
    `restored=${report.restored === null ? "n/a" : report.restored && report.restoreMs !== null ? report.restoreMs : "none"}`,
    ...(report.connectionsBefore !== null ? [`conns=${report.connectionsBefore}/${report.connectionsAfter ?? report.connectionsBefore}`] : []),
    ...(report.stoppedEarly ? ["early"] : []),
  ];
  return parts.join("; ");
}

/** 这条规则（真跑着的那条）此刻该标成「演练中」的路径：和中转断了的提示合在一起下发 / 显示。 */
export function routeDrillHints(subjectRuleId: number, nowMs = clock()): Map<string, RouteHopHint> {
  const hints = new Map<string, RouteHopHint>();
  const drill = drills.get(Number(subjectRuleId));
  if (!drill || drill.phase !== "down" || nowMs >= drill.endsAt) return hints;
  for (const key of drill.pathKeys) hints.set(key, { down: true, hopIndex: 0, reason: ROUTE_DRILL_HINT_REASON });
  return hints;
}

/** 中转探测的提示 + 演练的提示（演练压过它：那条本来就要标成不可用）。 */
export function withRouteDrillHints(subjectRuleId: number, hints: Map<string, RouteHopHint>, nowMs = clock()) {
  const drill = routeDrillHints(subjectRuleId, nowMs);
  if (drill.size === 0) return hints;
  const merged = new Map(hints);
  for (const [key, hint] of drill) merged.set(key, hint);
  return merged;
}

/** 这台机器上有没有在演练的规则：有的话评分快照每份都收（平时半分钟一份）。 */
export function hasRouteDrillOnHost(hostId: number) {
  for (const drill of drills.values()) if (drill.schedulerHostIds.includes(Number(hostId)) || drill.entryHostId === Number(hostId)) return true;
  return false;
}

export function isRouteDrillActive(subjectRuleId: number) {
  return drills.has(Number(subjectRuleId));
}

/**
 * Agent 报的切换事件（failoverLineReports 入库那一刻叫一次）：演练那条被切走 = 切完了；撤掉提示后切回
 * 演练那条 = 恢复了。
 */
export function noteRouteDrillAgentEvent(subjectRuleId: number, event: { kind: string; fromIndex: number; toIndex: number; atMs: number }) {
  const drill = drills.get(Number(subjectRuleId));
  if (!drill) return;
  drill.events += 1;
  if (event.kind !== "switch") return;
  if (drill.phase === "down") {
    if (drill.switchedAt === null && event.toIndex >= 0 && !drill.pathIndexes.has(event.toIndex) && (drill.pathIndexes.has(event.fromIndex) || drill.wasActive)) {
      drill.switchedAt = Math.max(drill.startedAt, event.atMs);
      drill.switchedToLabel = drill.labelOf(event.toIndex);
    }
    return;
  }
  if (drill.restoredAt === null && drill.pathIndexes.has(event.toIndex)) {
    drill.restoredAt = Math.max(drill.endedAt ?? drill.startedAt, event.atMs);
    void finalizeRouteDrill(drill);
  }
}

/**
 * 评分快照（每次心跳）：事件丢了就靠它看「现在走哪条」什么时候变的；切完之后盯着演练那条上还剩几个连接。
 */
export function noteRouteDrillAgentStats(stats: Pick<RouteAgentStats, "ruleId" | "activeIndex" | "activeSince" | "targets" | "reportedAt">) {
  const drill = drills.get(Number(stats.ruleId));
  if (!drill) return;
  const onDrilled = stats.activeIndex >= 0 && drill.pathIndexes.has(stats.activeIndex);
  if (drill.phase === "down") {
    if (drill.switchedAt === null && drill.wasActive && stats.activeIndex >= 0 && !onDrilled) {
      drill.switchedAt = Math.max(drill.startedAt, stats.activeSince > drill.startedAt ? stats.activeSince : stats.reportedAt);
      drill.switchedToLabel = drill.labelOf(stats.activeIndex);
    }
  } else if (drill.restoredAt === null && drill.wasActive && onDrilled && stats.activeSince >= (drill.endedAt ?? drill.startedAt)) {
    drill.restoredAt = stats.activeSince;
    void finalizeRouteDrill(drill);
    return;
  }
  if (drill.switchedAt !== null || !drill.wasActive) {
    const remaining = Array.from(drill.pathIndexes).reduce<number | null>((sum, index) => {
      const target = stats.targets.find((item) => item.index === index);
      return target && typeof target.connections === "number" ? (sum ?? 0) + target.connections : sum;
    }, null);
    if (remaining !== null) drill.connectionsAfter = drill.connectionsAfter === null ? remaining : Math.min(drill.connectionsAfter, remaining);
  }
}

function activeView(drill: ActiveDrill): RouteDrillActiveView {
  return {
    subjectRuleId: drill.subjectRuleId,
    entryHostId: drill.entryHostId,
    entryHostName: drill.entryHostName,
    lineKey: drill.lineKey,
    lineLabel: drill.lineLabel,
    seconds: drill.seconds,
    startedAt: drill.startedAt,
    endsAt: drill.endsAt,
    phase: drill.phase,
    wasActive: drill.wasActive,
    switchedAt: drill.switchedAt,
    switchMs: drill.switchedAt !== null ? Math.max(0, drill.switchedAt - drill.startedAt) : null,
    switchedToLabel: drill.switchedToLabel,
  };
}

/** 给 routeStatus：这几条（端口转发是几台成员机上的子规则）正在演练的和最近一小时的报告。 */
export function routeDrillView(subjectRuleIds: readonly number[], nowMs = clock()): RouteDrillView | null {
  const ids = subjectRuleIds.map(Number);
  const active = ids.map((id) => drills.get(id)).filter((drill): drill is ActiveDrill => !!drill).sort((left, right) => left.startedAt - right.startedAt);
  const recent = ids.map((id) => reports.get(id)).filter((report): report is RouteDrillReport => !!report && nowMs - report.finishedAt <= ROUTE_DRILL_REPORT_TTL_MS)
    .sort((left, right) => right.finishedAt - left.finishedAt);
  if (active.length === 0 && recent.length === 0) return null;
  return { active: active.length > 0 ? activeView(active[0]) : null, reports: recent };
}

/** 测试 / 开发面板用：换时钟、清空、直接塞一份进行中的演练或一份报告。 */
export const routeDrillInternals = {
  setClock(next: (() => number) | null) {
    clock = next || (() => Date.now());
  },
  reset() {
    for (const drill of drills.values()) if (drill.timer) clearTimeout(drill.timer);
    drills.clear();
    reports.clear();
  },
  seedActive(view: RouteDrillActiveView & { ruleId: number; pathKeys: string[]; pathIndexes: number[] }) {
    drills.set(view.subjectRuleId, {
      ruleId: view.ruleId,
      subjectRuleId: view.subjectRuleId,
      entryHostId: view.entryHostId,
      entryHostName: view.entryHostName,
      lineKey: view.lineKey,
      lineLabel: view.lineLabel,
      pathKeys: new Set(view.pathKeys),
      pathIndexes: new Set(view.pathIndexes),
      labelOf: () => null,
      seconds: view.seconds,
      startedAt: view.startedAt,
      endsAt: view.endsAt,
      endedAt: view.phase === "restoring" ? view.endsAt : null,
      phase: view.phase,
      wasActive: view.wasActive,
      activeBeforeLabel: view.wasActive ? view.lineLabel : null,
      switchedAt: view.switchedAt,
      switchedToLabel: view.switchedToLabel,
      restoredAt: null,
      connectionsBefore: null,
      connectionsAfter: null,
      events: 0,
      stoppedEarly: false,
      schedulerHostIds: [view.entryHostId],
      timer: null,
    });
    // 开发面板塞进来的也到点自己收（不然进度条走完一直挂着）
    const seeded = drills.get(view.subjectRuleId)!;
    if (seeded.phase === "down") {
      seeded.timer = setTimeout(() => { void endRouteDrill(view.subjectRuleId, { early: false }); }, Math.max(0, view.endsAt - clock()));
      seeded.timer.unref?.();
    }
  },
  seedReport(report: Omit<RouteDrillReport, "reason"> & { reason?: string }) {
    reports.set(report.subjectRuleId, { ...report, reason: report.reason || routeDrillReportReason(report) });
  },
  /** 到点了（测试里不用等真计时器）。 */
  async fireTimer(subjectRuleId: number) {
    const drill = drills.get(Number(subjectRuleId));
    if (!drill) return;
    if (drill.phase === "down") await endRouteDrill(subjectRuleId, { early: false });
    else await finalizeRouteDrill(drill);
  },
};
