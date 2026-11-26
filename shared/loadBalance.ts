/**
 * 统一的负载均衡：分配方式 + 检测与切换（2026-11 用户要求「所有负载均衡统一成一套」）。
 *
 * 链路负载均衡（隧道多出口）、出口组、线路组都用这一套：同一个下拉框、同一组检测参数、同一句「实际效果」。
 * 转发组 / 入口组靠改 DNS 切换，只用得上检测参数和主备。
 *
 * 分配方式的值和数据库、Agent、FXP 里的一致，算法只有一份（lbcore，docs/dev/scheduler-spec.md）。
 * 库里老的值只在 normalizeBalanceStrategy 一处认：none（只用第一个出口）当主备，least_conn 当按负载。
 */
import { proxyLoadBalanceWeights } from "./linkWeights";
import { isAgentVersionAtLeast } from "./version";

export const BALANCE_STRATEGIES = [
  "auto",
  "fallback",
  "ip_hash",
  "latency",
  "least_load",
  "weighted",
  "round_robin",
  "random",
] as const;

export type BalanceStrategy = (typeof BALANCE_STRATEGIES)[number];

/*
  2.3.539（用户：「自动包含综合，其他方式单选，各自独立」）：最上面一个「自动」（综合看延迟、抖动、负载和带宽），
  其余各自独立，放在「其他方式」里单选。八种方式在 NEX 隧道（入口 FXP）和 GOST 链路（入口机 Agent 的本机代理）上都是真的那样分，
  坏了的出口所有方式都会自动避开。
*/
export const BALANCE_COMMON_STRATEGIES: readonly BalanceStrategy[] = ["auto"];
export const BALANCE_CUSTOM_STRATEGIES: readonly BalanceStrategy[] = ["latency", "fallback", "ip_hash", "least_load", "weighted", "round_robin", "random"];

/*
  每种方式一句话（全站唯一一份：出口组、链路负载均衡、线路组都显示这一句），说的是代码真实的做法（Agent 和 FXP 共用的
  lbcore）。量词用「个」，出口（台）和线路（条）都读得通；坏了的所有方式都会避开，这里不重复。
*/
export const BALANCE_STRATEGY_LABELS: Record<BalanceStrategy, { label: string; hint: string }> = {
  auto: { label: "自动", hint: "看延迟、抖动、丢包和忙闲，新连接给当下最合适的那个；变慢、变忙的马上少分" },
  fallback: { label: "主备", hint: "先用第一个，连不上才换下一个，恢复稳定后切回" },
  ip_hash: { label: "按访客固定", hint: "同一个访客一直走同一个，它坏了才换；适合要保持登录的服务" },
  latency: { label: "延迟优先", hint: "只在最快的几个里分，比最快的慢出门槛（默认 50 ms）的不分" },
  least_load: { label: "按负载", hint: "新连接给现在最闲的那个（看连接数，填了带宽的还看流量）" },
  weighted: { label: "按权重", hint: "按设定的比例分，例如 5 : 3 : 2；没填的按线路带宽" },
  round_robin: { label: "轮流", hint: "新连接一个一个轮着走" },
  random: { label: "随机", hint: "新连接随机挑一个能用的" },
};

/** 新建出口组 / 线路组默认的分配方式：自动（推荐），用户不用选也能用。 */
export const BALANCE_DEFAULT_STRATEGY: BalanceStrategy = "auto";

/**
 * 延迟优先开了「只走最快的一台」（BalanceDetect.fastestOnly）时那一句换成这句：分配方式还是延迟优先，只是不在
 * 「一样快」的几个里分，只走最快的一个（lbcore/fastest.go，GOST 出口组和 NEX 隧道一样）。
 */
const BALANCE_LATENCY_FASTEST_ONLY_HINT = "只走最快的一台，别的候补；快出门槛且稳 60 秒才换";

/** 那一句说明；perSession：只转 UDP 时说「新会话」。detect：给了而且开了「只走最快的一台」时，延迟优先说那一句。 */
export function balanceStrategyHint(strategy: BalanceStrategy, perSession = false, detect?: Pick<BalanceDetect, "fastestOnly"> | null) {
  const hint = strategy === "latency" && detect?.fastestOnly ? BALANCE_LATENCY_FASTEST_ONLY_HINT : BALANCE_STRATEGY_LABELS[strategy].hint;
  return perSession ? hint.replaceAll("新连接", "新会话").replace("连接数", "会话数") : hint;
}

/** 存的值 → 统一的分配方式。老的 none 当主备；least_conn 是更老的「按负载」；认不出的返回 null（界面上算没选）。 */
export function normalizeBalanceStrategy(value: unknown): BalanceStrategy | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "none") return "fallback";
  if (raw === "least_conn") return "least_load";
  return (BALANCE_STRATEGIES as readonly string[]).includes(raw) ? raw as BalanceStrategy : null;
}

/** 链路 / 出口组上存的分配方式 → 统一的分配方式；空的、认不出的按轮流（数据库的默认值）。 */
export function normalizeExitGroupStrategy(value: unknown): BalanceStrategy {
  return normalizeBalanceStrategy(value) ?? "round_robin";
}

/**
 * 每台出口分几份（按出口主机的线路带宽 hostBandwidthHintMbps 算，500M / 300M → [5, 3]）：按权重、按负载、自动、
 * 延迟优先在 GOST（入口机 Agent）和 Nginx 上用。不是这几种、只有一个出口、有一台不知道带宽或都一样时返回 null（一样大）。
 */
export function exitGroupWeights(strategy: unknown, bandwidthsMbps: readonly number[]): number[] | null {
  const normalized = normalizeExitGroupStrategy(strategy);
  if (normalized !== "weighted" && normalized !== "least_load" && normalized !== "auto" && normalized !== "latency") return null;
  return proxyLoadBalanceWeights(bandwidthsMbps);
}

/**
 * 交给 FXP 的每台出口的线路带宽（Mbps）：按负载、自动、延迟优先拿它算利用率（流量 ÷ 线路带宽），按访客固定按它加权。
 * 只要有一台不知道就都不给 —— 这时按负载只看连接数（FXP 那边也是要么全按带宽、要么一样大）。
 */
export function exitGroupCapacities(strategy: unknown, bandwidthsMbps: readonly number[]): number[] | null {
  const normalized = normalizeExitGroupStrategy(strategy);
  if (normalized !== "least_load" && normalized !== "ip_hash" && normalized !== "auto" && normalized !== "latency") return null;
  if (bandwidthsMbps.length < 2 || bandwidthsMbps.some((value) => !(value > 0))) return null;
  return bandwidthsMbps.map((value) => Math.floor(value));
}

/* ─────────────────────────── 检测与切换 ─────────────────────────── */

export const BALANCE_JITTER_ACTIONS = ["reduce", "switch", "ignore"] as const;
export type BalanceJitterAction = (typeof BALANCE_JITTER_ACTIONS)[number];
export const BALANCE_JITTER_ACTION_LABELS: Record<BalanceJitterAction, string> = {
  reduce: "少分",
  switch: "切走",
  ignore: "不管",
};

export type BalanceDetect = {
  /** 多久探一次出口机（秒）：入口探自己的出口机，决定坏了多快切走 */
  intervalSeconds: number;
  /**
   * 多久探一次规则目标（秒）：出口机连一下目标就断（有真实流量时直接读内核的往返时间，不另外连）。
   * 和上面分开（2.3.541 用户反馈）：目标是别人的机器，高防目标会把每秒都来连一下的出口 IP 拉黑，所以默认慢得多。
   */
  targetProbeSeconds: number;
  /** 连续几次不通算坏 */
  failThreshold: number;
  /** 坏了以后要连续通几次才算恢复 */
  recoverThreshold: number;
  /** 延迟优先：比最快的那台慢不到这么多毫秒算一样快（只对延迟优先起作用） */
  latencyMarginMs: number;
  /** 抖动（最近一段延迟上下浮动的幅度）超过多少毫秒算抖 */
  jitterMs: number;
  /** 抖动持续多久才处理（秒）：偶尔抖一下不动 */
  jitterHoldSeconds: number;
  /** 抖动大的时候：少分（最多降到 1/4）/ 切走 / 不管 */
  jitterAction: BalanceJitterAction;
  /** 刚恢复的 1 分钟内从一小份慢慢加到满份 */
  slowStart: boolean;
  /**
   * 延迟优先：只走最快的一台（只对延迟优先起作用，默认关）。按整链延迟只走最快的那台，别的候补；另一台要比它快出
   * latencyMarginMs 并且快两成、稳住 60 秒（BALANCE_FASTEST_HOLD_SECONDS）才换过去，在用的坏了马上换次快的。
   * 不算检测灵敏度的一部分：三档都是关，选哪一档都不改它（balanceSensitivityOf 不看它）。
   */
  fastestOnly: boolean;
  /**
   * 负载均衡看哪一段（2.3.556）：chain 整链 = 入口到出口 + 出口到目标（出口连不上目标就切走，默认）；tunnel 只看隧道 =
   * 只看入口到出口通不通、多快，不派「出口 → 目标」的探测、不因为目标连不上判出口坏、不拿真实连接去试目标。
   * 目标是高防、会拉黑连得勤的出口 IP 时可以选；代价是某台出口被目标拦了，流量照样会分过去。
   * 不算检测灵敏度的一部分（三档都是整链，选哪一档都不改它）。
   */
  scope: BalanceScope;
};

export const BALANCE_SCOPES = ["chain", "tunnel"] as const;
export type BalanceScope = (typeof BALANCE_SCOPES)[number];
export const BALANCE_SCOPE_LABELS: Record<BalanceScope, { label: string; hint: string }> = {
  chain: { label: "附加检查出口到目标", hint: "出口连不上目标时先不分给它；会让出口去连目标，高防目标可能拉黑连得勤的出口 IP" },
  tunnel: { label: "只看出口组", hint: "只按入口到各台出口通不通、多快来分；不碰目标" },
};

export const BALANCE_INTERVAL_CHOICES = [1, 2, 5, 10, 30] as const;
export const BALANCE_TARGET_PROBE_CHOICES = [5, 10, 30, 60] as const;

export const BALANCE_DETECT_LIMITS = {
  intervalSeconds: { min: 1, max: 60 },
  targetProbeSeconds: { min: 2, max: 300 },
  failThreshold: { min: 1, max: 10 },
  recoverThreshold: { min: 1, max: 10 },
  latencyMarginMs: { min: 10, max: 2000, step: 10 },
  jitterMs: { min: 5, max: 1000, step: 5 },
  jitterHoldSeconds: { min: 5, max: 600, step: 5 },
} as const;

/** 负载均衡（链路、出口组、线路组）的默认值。 */
export const DEFAULT_BALANCE_DETECT: BalanceDetect = {
  intervalSeconds: 10,
  targetProbeSeconds: 10,
  failThreshold: 2,
  recoverThreshold: 3,
  latencyMarginMs: 50,
  jitterMs: 30,
  jitterHoldSeconds: 30,
  jitterAction: "reduce",
  slowStart: true,
  fastestOnly: false,
  // 2.3.557 起默认只看出口组（入口到出口）；「出口到目标」是附加检查，要自己打开。老数据没有这一项也是关
  scope: "tunnel",
};

/** 「只走最快的一台」：另一台要连着快出门槛多久才换过去（lbcore.DefaultFastestHold）。不给调。 */
const BALANCE_FASTEST_HOLD_SECONDS = 60;

/*
  检测灵敏度三档（2.3.539）：大多数人只需要选一档，不用逐项调。「均衡」就是默认值；改过任何一项就显示「自定义」。
  探出口机的节奏 2 / 10 / 30 秒（2.3.544，用户：「灵敏度秒数依次改成 2 10 30」；以前 1 / 2 / 5），探目标 5 / 10 / 30 秒。
*/
export type BalanceSensitivity = "sensitive" | "balanced" | "stable";
export const BALANCE_SENSITIVITY_PRESETS: Record<BalanceSensitivity, { label: string; hint: string; detect: BalanceDetect }> = {
  sensitive: {
    label: "灵敏",
    hint: "适合游戏、实时通话",
    detect: { intervalSeconds: 2, targetProbeSeconds: 5, failThreshold: 2, recoverThreshold: 3, latencyMarginMs: 30, jitterMs: 20, jitterHoldSeconds: 15, jitterAction: "reduce", slowStart: true, fastestOnly: false, scope: "tunnel" },
  },
  balanced: {
    label: "均衡",
    hint: "大多数情况选它",
    detect: { ...DEFAULT_BALANCE_DETECT },
  },
  stable: {
    label: "稳定",
    hint: "偶尔波动不动，适合下载、长连接",
    detect: { intervalSeconds: 30, targetProbeSeconds: 30, failThreshold: 3, recoverThreshold: 5, latencyMarginMs: 80, jitterMs: 50, jitterHoldSeconds: 60, jitterAction: "reduce", slowStart: true, fastestOnly: false, scope: "tunnel" },
  },
};
export const BALANCE_SENSITIVITIES: readonly BalanceSensitivity[] = ["sensitive", "balanced", "stable"];

/** 抖动「少分」降到几分之一（FXP 的 fxpTargetReducedShare）。 */
const BALANCE_JITTER_REDUCED_SHARE = 0.25;
/** 主备切过去至少用多久（GOST 出口组的 minHoldSeconds；一小时切 3 次以上放慢是 Agent 内置的抖动抑制）—— 不给调。 */
export const BALANCE_MIN_HOLD_SECONDS = 60;

function clampInt(value: unknown, fallback: number, limits: { min: number; max: number }) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, number));
}

/** 任意输入（JSON 文本、对象、null）→ 完整、合法的检测参数；缺的项用 defaults 补。 */
export function normalizeBalanceDetect(value: unknown, defaults: BalanceDetect = DEFAULT_BALANCE_DETECT): BalanceDetect {
  let input: Record<string, unknown> = {};
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
    } catch {
      input = {};
    }
  } else if (value && typeof value === "object") {
    input = value as Record<string, unknown>;
  }
  const action = String(input.jitterAction ?? "").trim().toLowerCase();
  const rest = {
    intervalSeconds: clampInt(input.intervalSeconds, defaults.intervalSeconds, BALANCE_DETECT_LIMITS.intervalSeconds),
    failThreshold: clampInt(input.failThreshold, defaults.failThreshold, BALANCE_DETECT_LIMITS.failThreshold),
    recoverThreshold: clampInt(input.recoverThreshold, defaults.recoverThreshold, BALANCE_DETECT_LIMITS.recoverThreshold),
    latencyMarginMs: clampInt(input.latencyMarginMs, defaults.latencyMarginMs, BALANCE_DETECT_LIMITS.latencyMarginMs),
    jitterMs: clampInt(input.jitterMs, defaults.jitterMs, BALANCE_DETECT_LIMITS.jitterMs),
    jitterHoldSeconds: clampInt(input.jitterHoldSeconds, defaults.jitterHoldSeconds, BALANCE_DETECT_LIMITS.jitterHoldSeconds),
    jitterAction: (BALANCE_JITTER_ACTIONS as readonly string[]).includes(action) ? action as BalanceJitterAction : defaults.jitterAction,
    slowStart: typeof input.slowStart === "boolean" ? input.slowStart : defaults.slowStart,
    // 老数据没有这一项：关（defaults 的也是关）
    fastestOnly: typeof input.fastestOnly === "boolean" ? input.fastestOnly : defaults.fastestOnly,
    // 老数据没有这一项：用默认（2.3.557 起是只看出口组）
    scope: (BALANCE_SCOPES as readonly string[]).includes(String(input.scope ?? "")) ? input.scope as BalanceScope : defaults.scope,
  };
  const hasTarget = input.targetProbeSeconds !== undefined && input.targetProbeSeconds !== null && input.targetProbeSeconds !== "";
  const targetProbeSeconds = hasTarget
    ? clampInt(input.targetProbeSeconds, deriveTargetProbeSeconds(rest), BALANCE_DETECT_LIMITS.targetProbeSeconds)
    : deriveTargetProbeSeconds(rest);
  const { intervalSeconds, ...others } = rest;
  return { intervalSeconds, targetProbeSeconds, ...others };
}

/*
  老数据（2.3.541 以前存的）没有 targetProbeSeconds：其余各项正好是某一档就用那一档的目标间隔（仍显示那一档），
  否则按出口机间隔的 5 倍，至少 5 秒、最多 300 秒。
*/
function deriveTargetProbeSeconds(rest: Omit<BalanceDetect, "targetProbeSeconds">) {
  const preset = BALANCE_SENSITIVITIES.find((key) => {
    const detect = BALANCE_SENSITIVITY_PRESETS[key].detect;
    return (Object.keys(rest) as (keyof typeof rest)[]).every((field) => field === "fastestOnly" || field === "scope" || rest[field] === detect[field]);
  });
  if (preset) return BALANCE_SENSITIVITY_PRESETS[preset].detect.targetProbeSeconds;
  return Math.max(5, Math.min(BALANCE_DETECT_LIMITS.targetProbeSeconds.max, rest.intervalSeconds * 5));
}

/** 存库：和默认一样就存 null（以后改默认值时跟着走）。 */
export function serializeBalanceDetect(value: unknown, defaults: BalanceDetect = DEFAULT_BALANCE_DETECT): string | null {
  const detect = normalizeBalanceDetect(value, defaults);
  return balanceDetectEquals(detect, defaults) ? null : JSON.stringify(detect);
}

export function balanceDetectEquals(left: BalanceDetect, right: BalanceDetect) {
  return (Object.keys(DEFAULT_BALANCE_DETECT) as (keyof BalanceDetect)[]).every((key) => left[key] === right[key]);
}

/** 这组检测参数是哪一档；逐项改过（哪档都不是）返回 null。「只走最快的一台」不算灵敏度，不看它。 */
export function balanceSensitivityOf(detect: BalanceDetect): BalanceSensitivity | null {
  return BALANCE_SENSITIVITIES.find((key) => balanceDetectEquals(detect, { ...BALANCE_SENSITIVITY_PRESETS[key].detect, fastestOnly: detect.fastestOnly, scope: detect.scope })) ?? null;
}

/** 选一档灵敏度：换成那一档的检测参数，「只走最快的一台」留着原来的。 */
export function applyBalanceSensitivity(detect: BalanceDetect, sensitivity: BalanceSensitivity): BalanceDetect {
  return { ...BALANCE_SENSITIVITY_PRESETS[sensitivity].detect, fastestOnly: detect.fastestOnly, scope: detect.scope };
}

/** 坏了最多多少秒切走：最坏是刚探完就坏，等够「几次不通」轮探测。 */
export function balanceSwitchWithinSeconds(detect: BalanceDetect) {
  return Math.max(1, Math.ceil(detect.intervalSeconds * (detect.failThreshold + 0.5)));
}

function ratioText(weights: readonly number[]) {
  const usable = weights.map((weight) => Math.max(0, Math.round(Number(weight) || 0)));
  return usable.every((weight) => weight > 0) ? usable.join(" : ") : "";
}

/**
 * 「实际效果」那一句：改了数字就跟着变。
 * dns：转发组 / 入口组（靠改解析）。NEX 隧道（入口的 FXP）和 GOST 隧道（入口机 Agent 的本机代理）都是入口自己探、
 * 自己切，这句话对两种都成立；Nginx 隧道不经统一调度，界面上另写一句「基础支持」（nginxBalanceBasicSupportNote）。
 */
export function describeBalanceEffect(input: {
  strategy: unknown;
  detect: BalanceDetect;
  weights?: readonly number[];
  memberNames?: readonly string[];
  dns?: boolean;
}) {
  const { detect } = input;
  const strategy = normalizeBalanceStrategy(input.strategy);
  const parts: string[] = [];
  // 转发组 / 入口组靠改解析，只探入口，不探规则目标
  parts.push(input.dns
    ? `每 ${detect.intervalSeconds} 秒探一次，坏了约 ${balanceSwitchWithinSeconds(detect)} 秒内改解析`
    : detect.scope === "tunnel"
      ? `每 ${detect.intervalSeconds} 秒探一次出口机，出口机连不上约 ${balanceSwitchWithinSeconds(detect)} 秒内切走；不碰目标`
      : `每 ${detect.intervalSeconds} 秒探一次出口机，连不上约 ${balanceSwitchWithinSeconds(detect)} 秒内切走；附加：每 ${detect.targetProbeSeconds} 秒查一次出口到目标，连不上目标的出口先不分`);
  if (strategy === "weighted") {
    const ratio = ratioText(input.weights || []);
    const names = (input.memberNames || []).filter(Boolean);
    parts.push(ratio
      ? `新连接按 ${ratio} 分${names.length > 0 && names.length <= 4 ? `给 ${names.join("、")}` : ""}`
      : "新连接按线路带宽分（没填权重）");
  } else if (strategy === "latency" && detect.fastestOnly) {
    parts.push(`延迟优先：只走最快的一台，别的候补；快出 ${detect.latencyMarginMs}ms 且稳 ${BALANCE_FASTEST_HOLD_SECONDS} 秒才换`);
  } else if (strategy) {
    parts.push(BALANCE_STRATEGY_LABELS[strategy].hint);
  }
  if (detect.jitterAction !== "ignore") {
    const action = detect.jitterAction === "reduce" ? `把它降到 ${Math.round(1 / BALANCE_JITTER_REDUCED_SHARE)} 分之 1` : "切走";
    // 抖动这三项只有 NEX 隧道的 FXP 按它少分 / 切走；GOST 的抖动、丢包已经在自动 / 延迟优先的成本里
    parts.push(`抖动超过 ${detect.jitterMs}ms 持续 ${detect.jitterHoldSeconds} 秒，就${action}${input.dns ? "" : "（NEX 隧道）"}`);
  }
  parts.push(`恢复要连续通 ${detect.recoverThreshold} 次${detect.slowStart ? "，1 分钟内慢慢加回满份" : ""}`);
  return `${parts.join("；")}。`;
}

/** FXP 从这一版起：出口回报连目标的结果、入口当场换出口、按出口 + 目标打分，认 auto / latency。 */
export const FXP_TARGET_AWARE_VERSION = "2.2.142";

/** FXP 从这一版起：入口把每条规则每台出口的真实状态报给面板（forwardx-fxp/balance_report.go）。 */
export const FXP_BALANCE_REPORT_VERSION = "2.2.145";

/**
 * 统一调度要求的 Agent 版本：从这一版起，负载均衡都由 Agent 自己的调度器执行。
 *
 * GOST 链路的几台出口由入口机的本机代理挑、自己探、自己切（TCP 和 UDP），并报真实状态
 * （server/gostBalancePlan.ts、agent/failover_exit_group.go）。**没有老路可退**：入口机的 Agent 更老时，面板只下发
 * 主出口一台（单节点、没有选择器），链路和规则上标「需要升级 Agent」（server/tunnelBalanceAgent.ts）。以前 gost 自己的
 * 节点选择器那条路（面板排节点顺序、摘节点、防绕过的兜底节点）已经整个删掉。
 *
 * 版本门槛只有这一处，判断只用下面的 agentSupportsUnifiedBalance。
 */
export const UNIFIED_BALANCE_AGENT_VERSION = "2.2.264";

/** 这台主机的 Agent 能不能执行统一调度（版本不低于 UNIFIED_BALANCE_AGENT_VERSION；没报版本的算不能）。 */
export function agentSupportsUnifiedBalance(agentVersion: unknown): boolean {
  return isAgentVersionAtLeast(String(agentVersion ?? ""), UNIFIED_BALANCE_AGENT_VERSION);
}

/**
 * Nginx 隧道的负载均衡是「基础支持」：出口由入口机的 nginx upstream 自己分，不经 Agent 的统一调度。
 * 链路的负载均衡弹窗里原样写出来（和 NEX / GOST 差在哪、哪些设置对它不起作用）。不是 Nginx 隧道返回 null。
 */
export function nginxBalanceBasicSupportNote(mode: unknown): string | null {
  return String(mode ?? "").trim().toLowerCase() === "nginx_stream"
    ? "基础支持：出口由入口机的 nginx 自己分，只看出口机连不连得上，不看到目标通不通；检测灵敏度和手动指定对它不起作用。"
    : null;
}

/** 本机代理最多替几台出口挑（Agent 的 failoverMaxTargets）；超出的出口不下发（按顺序取前这么多台）。 */
export const GOST_BALANCE_MAX_EXITS = 20;

/** 交给 FXP 的检测参数（字段和 FXP 的 balanceDetectConfig 一样）。 */
export function balanceDetectForRuntime(value: unknown, defaults: BalanceDetect = DEFAULT_BALANCE_DETECT) {
  const detect = normalizeBalanceDetect(value, defaults);
  return { ...detect };
}

