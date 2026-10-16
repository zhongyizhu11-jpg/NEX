/*
  「这台机器是不是被墙了」的判定，和「现在能不能自动换」的判定。纯函数，不碰库、不碰时间。

  ── 一轮怎么算失败 ──
  探测由主机自己的 Agent 做（向大陆目标发 TCP 连接或 ping），结果随 tcping 上报回面板。
  一轮失败要同时满足：
    1. 这一轮里**每一个**目标都失败了（只要有一个通，就不是被墙 —— 可能只是某个目标自己挂了）；
    2. 主机此刻对面板是在线的（心跳新鲜）。离线时面板什么都不做：可能是面板自己的网络问题，
       也可能是机器宕了，换 IP 解决不了，还白花钱。（第 2 条由调用方在进来之前判断。）
  任何一次成功都把连续失败数清零。

  Agent 的探测周期由它自己定（取所有探测服务里最短的间隔），可能比这里的检测间隔短。
  所以「一轮」按时间切：距上一轮记账不到检测间隔的 80%，失败只先攒着，不加计数 ——
  阈值 5、间隔 60 秒，意思就是「连续大约 5 分钟全部不通」。
*/
import type { IpChangeState } from "../../shared/ipChange";

export type ProbeOutcome = { index: number; ok: boolean };

export type ProbeRoundInput = {
  /** 配置里一共几个目标。 */
  targetCount: number;
  /** 这次上报里认得出的结果（已经按目标对上号）。 */
  results: ProbeOutcome[];
  /** 本轮已经攒下的失败目标（上次 pending 时返回的 window）。 */
  window: ReadonlySet<number>;
  consecutiveFailures: number;
  lastCheckAt: Date | null;
  checkIntervalSeconds: number;
  now: Date;
};

export type ProbeRoundResult =
  | { kind: "ignored" }
  | { kind: "pending"; window: Set<number> }
  | { kind: "success" | "failure-round"; consecutiveFailures: number; lastCheckAt: Date; window: Set<number>; recorded: boolean };

/** 两轮记账之间至少隔多久（检测间隔的 80%，给 Agent 周期的抖动留余地）。 */
export function minRoundGapMs(checkIntervalSeconds: number) {
  return Math.max(1, checkIntervalSeconds) * 1000 * 0.8;
}

export function evaluateProbeRound(input: ProbeRoundInput): ProbeRoundResult {
  const targetCount = Math.max(0, Math.floor(input.targetCount));
  const results = input.results.filter((item) => Number.isInteger(item.index) && item.index >= 0 && item.index < targetCount);
  if (targetCount === 0 || results.length === 0) return { kind: "ignored" };
  const now = input.now;
  const gapOk = !input.lastCheckAt || now.getTime() - input.lastCheckAt.getTime() >= minRoundGapMs(input.checkIntervalSeconds);

  if (results.some((item) => item.ok)) {
    /*
      成功立刻清零，不等间隔。recorded 表示要不要写库：计数本来就是 0 且离上次记账还没到间隔的，
      不必每个 Agent 周期都写一次库。
    */
    const recorded = input.consecutiveFailures > 0 || gapOk;
    return { kind: "success", consecutiveFailures: 0, lastCheckAt: recorded ? now : (input.lastCheckAt || now), window: new Set(), recorded };
  }

  const window = new Set(input.window);
  for (const item of results) window.add(item.index);
  const allFailed = window.size >= targetCount;
  if (!allFailed || !gapOk) return { kind: "pending", window };
  return {
    kind: "failure-round",
    consecutiveFailures: Math.max(0, Math.floor(input.consecutiveFailures)) + 1,
    lastCheckAt: now,
    window: new Set(),
    recorded: true,
  };
}

/** 这些状态是换 IP 流程自己的，探测结果不去改它们（只更新计数）。 */
const STICKY_STATES = new Set<IpChangeState>(["changing", "cooldown", "uncertain", "error", "disabled"]);

export function nextDetectionState(current: IpChangeState, consecutiveFailures: number): IpChangeState {
  if (STICKY_STATES.has(current)) return current;
  return consecutiveFailures > 0 ? "failing" : "healthy";
}

export type AutoChangeBlockCode =
  | "disabled"
  | "auto-off"
  | "below-threshold"
  | "state"
  | "host-offline"
  | "in-flight"
  | "cooldown"
  | "daily-cap"
  | "no-account";

export type AutoChangeDecision =
  | { ok: true }
  | { ok: false; code: AutoChangeBlockCode; reason: string };

export type AutoChangeInput = {
  enabled: boolean;
  autoEnabled: boolean;
  state: IpChangeState;
  consecutiveFailures: number;
  failureThreshold: number;
  hostOnline: boolean;
  inFlight: boolean;
  hasAccount: boolean;
  cooldownMinutes: number;
  maxChangesPerDay: number;
  /** 最近一次尝试（成功或失败、手动或自动）开始的时间。 */
  lastAttemptAt: Date | null;
  /** 过去 24 小时里尝试了几次（手动和自动都算）。 */
  attemptsLast24h: number;
  now: Date;
};

export function cooldownUntil(lastAttemptAt: Date | null, cooldownMinutes: number) {
  if (!lastAttemptAt) return null;
  return new Date(lastAttemptAt.getTime() + Math.max(0, cooldownMinutes) * 60_000);
}

export function decideAutoChange(input: AutoChangeInput): AutoChangeDecision {
  if (!input.enabled) return { ok: false, code: "disabled", reason: "这台主机没有启用自动换 IP" };
  if (!input.autoEnabled) return { ok: false, code: "auto-off", reason: "没有打开自动更换" };
  if (input.consecutiveFailures < input.failureThreshold) {
    return { ok: false, code: "below-threshold", reason: `连续失败 ${input.consecutiveFailures} 轮，未到阈值 ${input.failureThreshold}` };
  }
  if (input.state === "changing" || input.inFlight) return { ok: false, code: "in-flight", reason: "正在更换中" };
  if (input.state === "uncertain") return { ok: false, code: "state", reason: "上一次更换结果不确定，需要管理员确认后「重置状态」" };
  if (input.state === "error") return { ok: false, code: "state", reason: "上一次更换出错，需要管理员处理后「重置状态」" };
  if (input.state === "disabled") return { ok: false, code: "disabled", reason: "这台主机没有启用自动换 IP" };
  if (!input.hostOnline) return { ok: false, code: "host-offline", reason: "主机对面板离线，不做任何操作" };
  if (!input.hasAccount) return { ok: false, code: "no-account", reason: "没有配置云账号" };
  const until = cooldownUntil(input.lastAttemptAt, input.cooldownMinutes);
  if (until && until.getTime() > input.now.getTime()) {
    return { ok: false, code: "cooldown", reason: `冷却中，${until.toISOString()} 之后才会再次自动更换` };
  }
  if (input.attemptsLast24h >= input.maxChangesPerDay) {
    return { ok: false, code: "daily-cap", reason: `过去 24 小时已更换 ${input.attemptsLast24h} 次，达到每日上限 ${input.maxChangesPerDay}` };
  }
  return { ok: true };
}
