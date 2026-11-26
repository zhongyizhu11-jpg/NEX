/*
  负载均衡的「状态」怎么说（2026-11 界面统一）：链路的负载均衡弹窗、线路组、规则卡都用这一套词和颜色。

    在用 / 备用 / 连不上 / 不稳 / 慢启动中 / 已指定 / 需要升级 Agent / 基础支持

  数据是入口真实上报的（server/balanceLive.ts → server/exitTargetHealth.ts 的 ExitTargetExitSummary）。
  不是「在用」的都要说原因（人话），能做点什么的再说一句该做什么；数字都带单位。这里只算文字和色调，
  画成什么样在 client/src/components/balance/BalanceStateRow.tsx。
*/
import type { BalanceStrategy } from "@shared/loadBalance";

export type BalanceStateKey = "active" | "standby" | "down" | "unstable" | "warming" | "pinned" | "upgrade" | "basic";

export const BALANCE_STATE_WORDS: Record<BalanceStateKey, string> = {
  active: "在用",
  standby: "备用",
  down: "连不上",
  unstable: "不稳",
  warming: "慢启动中",
  pinned: "已指定",
  upgrade: "需要升级 Agent",
  basic: "基础支持",
};

/** 色调用线路那套胶囊的（LinePill）：ok 绿、warn 琥珀、down 红、acc 强调色、gray 灰。 */
export type BalanceTone = "ok" | "warn" | "down" | "acc" | "gray";

export const BALANCE_STATE_TONE: Record<BalanceStateKey, BalanceTone> = {
  active: "ok",
  standby: "gray",
  down: "down",
  unstable: "warn",
  warming: "acc",
  pinned: "acc",
  upgrade: "warn",
  basic: "gray",
};

/** 状态点（StatusDot）用的健康度。 */
export function balanceStateHealth(state: BalanceStateKey): "healthy" | "degraded" | "down" | "standby" {
  const tone = BALANCE_STATE_TONE[state];
  if (tone === "ok" || tone === "acc") return "healthy";
  if (tone === "warn") return "degraded";
  if (tone === "down") return "down";
  return "standby";
}

const ms = (value: number) => `${Math.round(value)} ms`;

/** 一台出口的汇总（server/exitTargetHealth.ts 的 ExitTargetExitSummary，老面板没有的字段可以缺）。 */
export type ExitSummaryLike = {
  rules: number;
  down: number;
  /** 连不上的是哪几条规则（名字在 ExitRowContext.ruleNames 里） */
  downRuleIds?: number[];
  unstable: number;
  activeRules: number;
  medianMs: number | null;
  minMs?: number | null;
  maxMs?: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  slowerMs?: number | null;
  udpOk?: number;
  udpDown?: number;
  udpUnverified?: number;
  peerOutdated?: boolean;
  reason?: "target" | "exit" | null;
  share?: number | null;
  /** 两段：入口到这台出口、这台出口到目标（面板探的优先；没有时是入口自己报的，老 Agent / FXP 2.2.148 及更早没有） */
  exitMs?: number | null;
  targetMs?: number | null;
  /** 那两段是谁测的：panel 面板探测（和诊断一个口径）、agent 入口自己报的（弹窗写「Agent 自测」）；新面板没有数时是 null */
  exitMsSource?: "panel" | "agent" | null;
  targetMsSource?: "panel" | "agent" | null;
  /** 几条规则里这台到目标的延迟不知道 */
  targetLatencyUnknown?: number;
};

export type SwitchEventLike = { at: number; hostId: number; from: string; to: string; reason?: "target" | "exit" | null };

export type ExitRowContext = {
  online: boolean;
  /** 第几台（0 = 主出口） */
  index: number;
  strategy: BalanceStrategy;
  /** 入口真实上报的（false = 面板估的 / 还没有数据） */
  live: boolean;
  /** 指定了走哪台：这台就是 → pinned；指定了别的 → 这台备用 */
  pinHostId: number;
  hostId: number;
  /** 这条链路的负载均衡没生效（入口机 Agent 太旧）：只走主出口 */
  upgradeNeeded?: boolean;
  /** 刚恢复的慢慢加量开着（检测与切换的 slowStart） */
  slowStart?: boolean;
  events?: readonly SwitchEventLike[];
  nowMs?: number;
  /** downRuleIds 对应的规则名 */
  ruleNames?: Record<number, string>;
};

export type ExitRowView = {
  state: BalanceStateKey;
  /** 第二行：到目标多快、分到多少（没数据时 null） */
  detail: string | null;
  /** 不是在用时为什么（人话）；在用但 UDP 不通之类的也写在这 */
  reason: string | null;
  /** 能做点什么时的一句 */
  hint: string | null;
};

/** 慢启动：lbcore 的 DefaultSlowStart，刚恢复 60 秒内从一成加到满份（按访客固定、主备不加）。 */
const SLOW_START_MS = 60_000;

function recoveredAt(events: readonly SwitchEventLike[] | undefined, hostId: number) {
  const last = (events || []).filter((event) => event.hostId === hostId).sort((a, b) => b.at - a.at)[0];
  if (!last) return null;
  return (last.from === "down" || last.from === "unstable") && (last.to === "active" || last.to === "standby") ? last.at : null;
}

function latencyText(summary: ExitSummaryLike, live = false) {
  const low = summary.minMs ?? null;
  const high = summary.maxMs ?? null;
  /*
    两段：面板探的优先（链路定时探测的这台出口分支 + 出口机探目标，和规则卡、诊断一个口径）；面板没测到的那段是入口
    自己报的，标「Agent 自测」（FXP 报的到出口是建隧道握手的时间，比 TCPing 大一截）。
  */
  // 整句写全（界面翻译按整句的模板套，不拼半句）
  if (summary.exitMs != null) {
    const a = ms(summary.exitMs);
    const exitAgent = summary.exitMsSource === "agent";
    if (summary.targetMs == null) return exitAgent ? `到出口 ${a}（Agent 自测） · 到目标延迟未知` : `到出口 ${a} · 到目标延迟未知`;
    // 几条规则的目标远近不同（入口报的整链各条规则不一样）：写成范围，不取平均。面板的两段已经是中位数了，不再写范围
    if (summary.exitMsSource !== "panel" && low != null && high != null && high - low >= 5) return `整链 ${Math.round(low)}–${ms(high)}（到出口 ${a}）`;
    const b = ms(summary.targetMs);
    const total = ms(summary.exitMs + summary.targetMs);
    const targetAgent = summary.targetMsSource === "agent";
    const unknown = (summary.targetLatencyUnknown || 0) > 0 && summary.targetMsSource !== "panel" ? "（有规则到目标延迟未知）" : "";
    if (exitAgent && targetAgent) return `整链 ${total}（到出口 ${a} + 到目标 ${b}；两段都是 Agent 自测）${unknown}`;
    if (exitAgent) return `整链 ${total}（到出口 ${a} + 到目标 ${b}；到出口是 Agent 自测）${unknown}`;
    if (targetAgent) return `整链 ${total}（到出口 ${a} + 到目标 ${b}；到目标是 Agent 自测）${unknown}`;
    return `整链 ${total}（到出口 ${a} + 到目标 ${b}）${unknown}`;
  }
  // 面板测到了到目标、入口到这台出口那段还没测到
  if (summary.targetMs != null && summary.targetMsSource === "panel") return `到目标 ${ms(summary.targetMs)}（到出口那段还没测到）`;
  // 入口实时上报、两段都没有：出口机的 FXP 太旧（2.2.148 及更早），只报了出口到目标的中位数
  const legacy = live && summary.exitMsSource === null && summary.targetMsSource === null;
  // 几条规则的目标远近不同：写成范围，不取平均
  if (low != null && high != null && high - low >= 5) {
    return legacy ? `到目标 ${Math.round(low)}–${ms(high)}（出口机 FXP 太旧，没报到出口那段）` : `到目标 ${Math.round(low)}–${ms(high)}`;
  }
  if (summary.medianMs == null) return null;
  return legacy ? `到目标 ${ms(summary.medianMs)}（出口机 FXP 太旧，没报到出口那段）` : `到目标 ${ms(summary.medianMs)}`;
}

function udpNote(summary: ExitSummaryLike): { reason: string; hint: string | null } | null {
  if ((summary.udpDown || 0) > 0) return { reason: "UDP 探活没回，UDP 新会话先不给它（TCP 照常）", hint: null };
  if (summary.peerOutdated) return { reason: "出口机的 FXP 版本旧，不回 UDP 探活，UDP 只能跟着 TCP 判断", hint: "升级这台出口机的 Agent" };
  if ((summary.udpUnverified || 0) > 0) return { reason: "UDP 还没验证过，暂时跟着 TCP 判断", hint: null };
  return null;
}

/** 连不上的是哪几条规则：名字都知道时写名字（「广港hkt/2、广港Sg/2」），否则写「N 条规则」。 */
function downRulesText(summary: ExitSummaryLike, ruleNames?: Record<number, string>): string {
  const names = (summary.downRuleIds || []).map((id) => ruleNames?.[id]).filter((name): name is string => !!name);
  return names.length > 0 && names.length === summary.down ? names.join("、") : `${summary.down} 条规则`;
}

/**
 * 指定的出口对哪些规则没生效、为什么：连不上的写规则名 +「不通」，来回断还在观察的写「刚恢复，在观察」；
 * 都生效或没数据是 null。live：入口实时上报的（估的数据不下「在观察」的结论）。
 */
export function pinBypassText(summary: ExitSummaryLike | null | undefined, ruleNames?: Record<number, string>, live = true): string | null {
  if (!summary || summary.rules <= 0) return null;
  if (summary.down > 0) return `${downRulesText(summary, ruleNames)}不通`;
  const observing = live ? summary.rules - summary.activeRules - summary.down : 0;
  return observing > 0 ? "刚恢复，在观察" : null;
}

/** 一台出口此刻的状态、原因、该做什么。 */
export function exitRowView(summary: ExitSummaryLike | null | undefined, ctx: ExitRowContext): ExitRowView {
  const hasData = !!summary && summary.rules > 0;
  const parts: string[] = [];
  if (hasData) {
    const latency = latencyText(summary!, ctx.live);
    if (latency) parts.push(latency);
    if (summary!.jitterMs != null && summary!.jitterMs >= 1) parts.push(`抖动 ${ms(summary!.jitterMs)}`);
    if (summary!.share != null && summary!.activeRules > 0) parts.push(`分到 ${Math.round(summary!.share * 100)}%`);
    if (summary!.slowerMs != null) parts.push(`比平时慢 ${ms(summary!.slowerMs)}`);
  }
  const detail = parts.length > 0 ? parts.join(" · ") : null;
  const view = (state: BalanceStateKey, reason: string | null = null, hint: string | null = null): ExitRowView => ({ state, detail, reason, hint });

  if (!ctx.online) return view("down", "出口机离线（面板收不到它的 Agent）", "检查这台机器和它的 Agent");
  if (ctx.upgradeNeeded) {
    return ctx.index === 0 ? view("active", "负载均衡没生效，只走主出口") : view("upgrade", "入口机的 Agent 太旧，还不会分到这台", "升级入口机的 Agent");
  }
  if (ctx.pinHostId > 0) {
    /*
      指定只在「指定的那台对这条规则能用」时生效（agent/failover_pick.go 的 exitPinPickLocked）：它到某条规则的目标连不上、
      或入口连不上它，那条规则照常按分法走别的出口。以前这里不看数据，一律写「已指定 / 已指定走别的出口」——
      用户面板（2026-11-26）：指定 jinx(39.9y)，「广港hkt/2」的高防目标从它连不上，实际在走 Jinx(29.9y)，
      弹窗却写「1 台在用、其余备用」，规则卡上又写「经 Jinx(29.9y)」，两边对不上。
    */
    if (ctx.hostId === ctx.pinHostId) {
      // 没断、入口却没让它扛的规则：来回断、刚放回还在观察（agent/failover_exit_flap.go）
      const observing = hasData && ctx.live ? summary!.rules - summary!.activeRules - summary!.down : 0;
      if (hasData && summary!.down <= 0 && observing > 0) return view("pinned", "来回断，先观察几分钟再走它");
      if (!hasData || summary!.down <= 0) return view("pinned");
      const which = downRulesText(summary!, ctx.ruleNames);
      const exit = summary!.reason === "exit";
      const hint = exit ? "检查出口机防火墙和隧道端口" : "检查它到目标的网络";
      return summary!.activeRules > 0
        ? view("pinned", `${which}${exit ? "连不上这台" : "到目标不通"}，暂走别的出口`, hint)
        : view("down", `${exit ? "入口连不上这台" : "到目标不通"}，已暂走别的出口`, hint);
    }
    // 入口实时上报里这台还在扛规则：是替指定的那台不通的规则在走（指定能用时别的出口报的都是备用）
    if (hasData && ctx.live && summary!.activeRules > 0) {
      return view("active", `代指定出口走 ${summary!.activeRules} 条规则`);
    }
    return view("standby", "已指定走别的出口");
  }
  if (hasData && summary!.down > 0) {
    const which = downRulesText(summary!, ctx.ruleNames);
    /*
      这台只对某几条规则连不上、别的规则还在走它（用户面板：hep ix 对「广港hkt/2」的高防目标连不上 30 分钟，
      另外两条规则照走）：这台还是「在用」，原因里写清是哪条；全都不走它了才是「连不上」。
    */
    if (summary!.activeRules > 0) {
      return summary!.reason === "exit"
        ? view("active", `${which}入口连不上这台出口机（已切走），别的规则照走`, "检查出口机的防火墙和隧道端口")
        : view("active", `${which}到目标连不上（已切走），别的规则照走`, "检查这台出口到那条规则目标的网络");
    }
    const count = summary!.rules > 1 && summary!.down < summary!.rules ? `（${which}）` : "";
    return summary!.reason === "exit"
      ? view("down", `入口连不上这台出口机${count}，已切走`, "检查出口机的防火墙和隧道端口")
      : view("down", `这台连不上目标${count}，已切走`, "检查这台出口到目标的网络");
  }
  if (hasData && summary!.unstable > 0) {
    const loss = summary!.lossPct != null && summary!.lossPct >= 10 ? `丢包 ${Math.round(summary!.lossPct)}%` : null;
    const jitter = summary!.jitterMs != null ? `抖动 ${ms(summary!.jitterMs)}` : null;
    const what = summary!.reason === "exit" ? "入口到这台出口机" : "到目标";
    return view("unstable", `${what}${loss || jitter || "不稳"}，新连接少分给它`);
  }
  const udp = hasData ? udpNote(summary!) : null;
  const active = hasData
    ? summary!.activeRules > 0
    // 还没有入口上报：主备只有第一台在用，其余方式都分
    : ctx.strategy === "fallback" ? ctx.index === 0 : true;
  if (!active) return view("standby", udp?.reason ?? null, udp?.hint ?? null);
  const since = recoveredAt(ctx.events, ctx.hostId);
  const warming = ctx.slowStart !== false && since != null && (ctx.nowMs ?? Date.now()) - since < SLOW_START_MS
    && ctx.strategy !== "fallback" && ctx.strategy !== "ip_hash";
  if (warming) return view("warming", "刚恢复，1 分钟内慢慢加到满份");
  return view("active", udp?.reason ?? null, udp?.hint ?? null);
}

const STATE_OF_EVENT: Record<string, BalanceStateKey> = { active: "active", standby: "standby", down: "down", unstable: "unstable" };

export type SwitchEventView = { time: string; from: string; to: string; toState: BalanceStateKey; why: string };

/** 「最近切换」一行：几点、谁、从什么到什么、为什么。 */
export function switchEventView(event: SwitchEventLike, nowMs = Date.now()): SwitchEventView {
  const date = new Date(event.at);
  const sameDay = new Date(nowMs).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const toState = STATE_OF_EVENT[event.to] ?? "standby";
  const from = BALANCE_STATE_WORDS[STATE_OF_EVENT[event.from] ?? "standby"];
  let why: string;
  if (event.to === "down" || event.to === "unstable") {
    why = event.reason === "exit" ? "入口连不上出口机" : event.reason === "target" ? "到目标不行" : "探测没通过";
  } else if (event.from === "down" || event.from === "unstable") {
    why = "恢复了";
  } else {
    why = event.to === "active" ? "开始分流量" : "流量分给了别的出口";
  }
  return { time: sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`, from, to: BALANCE_STATE_WORDS[toState], toState, why };
}

/** 同一台出口同一次变化在 TCP、UDP 两条规则上各报一次：2 秒内一样的算一条（新的在前）。 */
export function dedupeSwitchEvents<T extends SwitchEventLike>(events: readonly T[]): T[] {
  const out: T[] = [];
  for (const event of [...events].sort((a, b) => b.at - a.at)) {
    if (out.some((kept) => kept.hostId === event.hostId && kept.from === event.from && kept.to === event.to && Math.abs(kept.at - event.at) < 2_000)) continue;
    out.push(event);
  }
  return out;
}
