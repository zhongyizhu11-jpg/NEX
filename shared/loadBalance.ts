/**
 * 统一的负载均衡：分配方式 + 检测与切换（2026-11 用户要求「所有负载均衡统一成一套」）。
 *
 * 链路负载均衡（隧道多出口）、出口组、线路组线路里的几个落地都用这一套：同一个下拉框、同一组检测参数、
 * 同一句「实际效果」。转发组 / 入口组靠改 DNS 切换，只用得上其中几项（见 BALANCE_DNS_STRATEGIES）。
 *
 * 分配方式的值和数据库、Agent、FXP 里的一致（老的五种照旧，新加 auto / latency）：
 *
 *   常用    auto（自动）、fallback（主备）、ip_hash（按访客固定）
 *   自定义  latency（延迟优先）、least_load（按负载）、weighted（按权重）、round_robin（轮流）、random（随机）
 *
 * 老值 none（只用第一个出口）在界面上显示成主备：坏了自动换下一台，比原来只用第一台更好。
 */

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

export const BALANCE_COMMON_STRATEGIES: readonly BalanceStrategy[] = ["auto", "fallback", "ip_hash"];
export const BALANCE_CUSTOM_STRATEGIES: readonly BalanceStrategy[] = ["latency", "least_load", "weighted", "round_robin", "random"];
/** 转发组靠 DNS 切换：DNS 只能指向「当前这一台」，分不了连接。 */
export const BALANCE_DNS_STRATEGIES: readonly BalanceStrategy[] = ["fallback"];

export const BALANCE_STRATEGY_LABELS: Record<BalanceStrategy, { label: string; hint: string }> = {
  auto: { label: "自动", hint: "看延迟、抖动、负载和带宽，新连接给最好的那台" },
  fallback: { label: "主备", hint: "按顺序用第一台，坏了或一直抖才换下一台" },
  ip_hash: { label: "按访客固定", hint: "同一个 IP 一直走同一台，适合要保持登录的服务" },
  latency: { label: "延迟优先", hint: "只看延迟和抖动，最快最稳的那台多分" },
  least_load: { label: "按负载", hint: "新连接给现在最闲的那台" },
  weighted: { label: "按权重", hint: "按每台的权重分，例如 5 : 3 : 2" },
  round_robin: { label: "轮流", hint: "新连接一台一台轮着走" },
  random: { label: "随机", hint: "新连接随机挑一台能用的" },
};

/** 存的值 → 统一的分配方式。老的 none 当主备；least_conn 是更老的「按负载」；认不出的返回 null（界面上算没选）。 */
export function normalizeBalanceStrategy(value: unknown): BalanceStrategy | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "none") return "fallback";
  if (raw === "least_conn") return "least_load";
  return (BALANCE_STRATEGIES as readonly string[]).includes(raw) ? raw as BalanceStrategy : null;
}

export function balanceStrategyLabel(value: unknown) {
  const strategy = normalizeBalanceStrategy(value);
  return strategy ? BALANCE_STRATEGY_LABELS[strategy].label : "未选择";
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
  /** 多久探一次（秒） */
  intervalSeconds: number;
  /** 连续几次不通算坏 */
  failThreshold: number;
  /** 坏了以后要连续通几次才算恢复 */
  recoverThreshold: number;
  /** 比最快的那台慢多少毫秒就少分 */
  latencyMarginMs: number;
  /** 抖动（最近一段延迟上下浮动的幅度）超过多少毫秒算抖 */
  jitterMs: number;
  /** 抖动持续多久才处理（秒）：偶尔抖一下不动 */
  jitterHoldSeconds: number;
  /** 抖动大的时候：少分（最多降到 1/4）/ 切走 / 不管 */
  jitterAction: BalanceJitterAction;
  /** 刚恢复的 1 分钟内从一小份慢慢加到满份 */
  slowStart: boolean;
};

export const BALANCE_INTERVAL_CHOICES = [1, 2, 5, 10, 30] as const;

export const BALANCE_DETECT_LIMITS = {
  intervalSeconds: { min: 1, max: 60 },
  failThreshold: { min: 1, max: 10 },
  recoverThreshold: { min: 1, max: 10 },
  latencyMarginMs: { min: 10, max: 2000, step: 10 },
  jitterMs: { min: 5, max: 1000, step: 5 },
  jitterHoldSeconds: { min: 5, max: 600, step: 5 },
} as const;

/** 负载均衡（链路、出口组、线路组）的默认值。 */
export const DEFAULT_BALANCE_DETECT: BalanceDetect = {
  intervalSeconds: 2,
  failThreshold: 2,
  recoverThreshold: 3,
  latencyMarginMs: 50,
  jitterMs: 30,
  jitterHoldSeconds: 30,
  jitterAction: "reduce",
  slowStart: true,
};

/** 转发组 / 入口组（靠 DNS）默认 30 秒探一次：DNS 本身要等缓存过期，探得再快也快不了多少。 */
export const DEFAULT_DNS_BALANCE_DETECT: BalanceDetect = {
  ...DEFAULT_BALANCE_DETECT,
  intervalSeconds: 30,
};

/** 抖动「少分」最多降到几分之一。 */
export const BALANCE_JITTER_REDUCED_SHARE = 0.25;
/** 切过去至少用多久、原来那台稳定多久才回满份、一小时切几次以上放慢 —— 内置，不给调。 */
export const BALANCE_ANTI_FLAP = { minHoldSeconds: 60, failbackStableSeconds: 300, maxSwitchesPerHour: 3, slowedHoldSeconds: 300 } as const;
/** 判断用最近多少次探测。 */
export const BALANCE_WINDOW_SAMPLES = 30;

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
  return {
    intervalSeconds: clampInt(input.intervalSeconds, defaults.intervalSeconds, BALANCE_DETECT_LIMITS.intervalSeconds),
    failThreshold: clampInt(input.failThreshold, defaults.failThreshold, BALANCE_DETECT_LIMITS.failThreshold),
    recoverThreshold: clampInt(input.recoverThreshold, defaults.recoverThreshold, BALANCE_DETECT_LIMITS.recoverThreshold),
    latencyMarginMs: clampInt(input.latencyMarginMs, defaults.latencyMarginMs, BALANCE_DETECT_LIMITS.latencyMarginMs),
    jitterMs: clampInt(input.jitterMs, defaults.jitterMs, BALANCE_DETECT_LIMITS.jitterMs),
    jitterHoldSeconds: clampInt(input.jitterHoldSeconds, defaults.jitterHoldSeconds, BALANCE_DETECT_LIMITS.jitterHoldSeconds),
    jitterAction: (BALANCE_JITTER_ACTIONS as readonly string[]).includes(action) ? action as BalanceJitterAction : defaults.jitterAction,
    slowStart: typeof input.slowStart === "boolean" ? input.slowStart : defaults.slowStart,
  };
}

/** 存库：和默认一样就存 null（以后改默认值时跟着走）。 */
export function serializeBalanceDetect(value: unknown, defaults: BalanceDetect = DEFAULT_BALANCE_DETECT): string | null {
  const detect = normalizeBalanceDetect(value, defaults);
  return balanceDetectEquals(detect, defaults) ? null : JSON.stringify(detect);
}

export function balanceDetectEquals(left: BalanceDetect, right: BalanceDetect) {
  return (Object.keys(DEFAULT_BALANCE_DETECT) as (keyof BalanceDetect)[]).every((key) => left[key] === right[key]);
}

/** 坏了最多多少秒切走：最坏是刚探完就坏，等够「几次不通」轮探测。 */
export function balanceSwitchWithinSeconds(detect: BalanceDetect) {
  return Math.max(1, Math.ceil(detect.intervalSeconds * (detect.failThreshold + 0.5)));
}

/** 折叠时那一行：「每 2 秒探一次 · 2 次不通算坏 · 抖动超过 30ms 少分」。 */
export function describeBalanceDetectShort(detect: BalanceDetect) {
  const jitter = detect.jitterAction === "ignore"
    ? "不看抖动"
    : `抖动超过 ${detect.jitterMs}ms ${BALANCE_JITTER_ACTION_LABELS[detect.jitterAction]}`;
  return `每 ${detect.intervalSeconds} 秒探一次 · ${detect.failThreshold} 次不通算坏 · ${jitter}`;
}

function ratioText(weights: readonly number[]) {
  const usable = weights.map((weight) => Math.max(0, Math.round(Number(weight) || 0)));
  return usable.every((weight) => weight > 0) ? usable.join(" : ") : "";
}

/**
 * 「实际效果」那一句：改了数字就跟着变。
 * dns：转发组 / 入口组；gost：GOST 隧道（不能当场换出口，约 5～10 秒自动摘掉）。
 */
export function describeBalanceEffect(input: {
  strategy: unknown;
  detect: BalanceDetect;
  weights?: readonly number[];
  memberNames?: readonly string[];
  dns?: boolean;
  gost?: boolean;
}) {
  const { detect } = input;
  const strategy = normalizeBalanceStrategy(input.strategy);
  const parts: string[] = [];
  parts.push(`每 ${detect.intervalSeconds} 秒探一次，坏了约 ${balanceSwitchWithinSeconds(detect)} 秒内${input.dns ? "改解析" : "切走"}`);
  if (input.gost && !input.dns) parts.push("GOST 隧道不能在一条连接里当场换出口，连不上目标的出口约 5～10 秒内自动摘掉");
  if (strategy === "weighted") {
    const ratio = ratioText(input.weights || []);
    const names = (input.memberNames || []).filter(Boolean);
    parts.push(ratio
      ? `新连接按 ${ratio} 分${names.length > 0 && names.length <= 4 ? `给 ${names.join("、")}` : ""}`
      : "新连接按线路带宽分（没填权重）");
  } else if (strategy) {
    parts.push(BALANCE_STRATEGY_LABELS[strategy].hint);
  }
  if (detect.jitterAction !== "ignore") {
    const action = detect.jitterAction === "reduce" ? `把它降到 ${Math.round(1 / BALANCE_JITTER_REDUCED_SHARE)} 分之 1` : "切走";
    parts.push(`抖动超过 ${detect.jitterMs}ms 持续 ${detect.jitterHoldSeconds} 秒，就${action}`);
  }
  parts.push(`恢复要连续通 ${detect.recoverThreshold} 次${detect.slowStart ? "，1 分钟内慢慢加回满份" : ""}`);
  return `${parts.join("；")}。`;
}

/** FXP 从这一版起：出口回报连目标的结果、入口当场换出口、按出口 + 目标打分，认 auto / latency。 */
export const FXP_TARGET_AWARE_VERSION = "2.2.142";

/** FXP 从这一版起：入口把每条规则每台出口的真实状态报给面板（forwardx-fxp/balance_report.go）。 */
export const FXP_BALANCE_REPORT_VERSION = "2.2.145";

/** Agent 从这一版起：GOST 链路几台出口由入口机的本机代理挑、自己切，并报真实状态（agent/balance_report.go）。 */
export const GOST_BALANCE_PROXY_AGENT_VERSION = "2.2.262";

/** 交给 FXP 的检测参数（字段和 FXP 的 balanceDetectConfig 一样）。 */
export function balanceDetectForRuntime(value: unknown, defaults: BalanceDetect = DEFAULT_BALANCE_DETECT) {
  const detect = normalizeBalanceDetect(value, defaults);
  return { ...detect };
}

/**
 * 交给老 FXP 的分配方式：2.2.142 之前的 FXP 不认识 auto / latency（会当轮流），换成最接近的「按负载」。
 */
export function balanceStrategyForLegacyRuntime(value: unknown): Exclude<BalanceStrategy, "auto" | "latency"> {
  const strategy = normalizeBalanceStrategy(value) ?? "round_robin";
  return strategy === "auto" || strategy === "latency" ? "least_load" : strategy;
}
