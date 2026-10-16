import { protectedProcedure, router } from "../_core/trpc";
import {
  MAX_FAILOVER_TARGETS,
  formatFailoverEndpoint,
  parseFailoverEndpoint,
  parseFailoverTargets,
  type FailoverTarget,
} from "@shared/failoverTargets";
import {
  MAX_FAILOVER_SCHEDULE_WINDOWS,
  parseFailoverSchedule,
  serializeFailoverSchedule,
  validateFailoverSchedule,
} from "@shared/failoverSchedule";
import { readFailoverPin } from "@shared/failoverPin";
import { normalizeExitGroupStrategy } from "@shared/exitStrategy";
import {
  MAX_ROUTE_HOPS,
  MAX_ROUTE_PATHS,
  ROUTE_GUARD_LIMITS,
  ROUTE_MODES,
  ROUTE_SPREADS,
  ROUTE_SWITCH_MODES,
  newRoutePathKey,
  normalizeRouteSpread,
  normalizeRouteSwitchMode,
  parseRoutePaths,
  routeGroupForwardTypeSupported,
  routeGroupOf,
  routeGroupTunnelModeSupported,
  routePathLabel,
  routeTemplateGuards,
  serializeRoutePaths,
  validateRouteGroup,
  type RouteGroup,
  type RouteGroupPolicy,
  type RoutePath,
} from "@shared/routeGroup";
import { legacyFailoverColumns, retireRouteRelayRulesForRule, syncRouteRelayRulesForRule } from "../routeGroups";
import { getLinkAccessScope } from "../linkAccessView";
import { timestampMillis } from "@shared/timestamp";
import { dbBool } from "../repositories/repositoryUtils";
import { z } from "zod";
import { planProxyNodeBinding } from "@shared/proxyNodeAutoBind";
import { isIP } from "node:net";
import * as db from "../db";
import { handleTrafficBillingShortfall } from "../trafficBillingRuleBlock";
import { pushAgentRefresh } from "../agentEvents";
import { forwardTypeSchema } from "./schemas";
import {
  pushTunnelEndpointRefresh,
  refreshUserForwardEndpoints,
  requireHostUseAccess,
  requireTunnelUseOrTrafficBillingAccess,
} from "./helpers";
import { requireRuleProtocolEnabled } from "../forwardProtocolSettings";
import { combineHostPortPolicyWithRange, combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom } from "@shared/portPolicy";
import { assertTenantListenPortAllowed, assertTenantListenPortAllowedOnHosts } from "../tenantListenPortGuard";
import { isTelegramBotReady } from "../telegramReady";
import { resolveForwardRuleName } from "@shared/forwardRuleName";
import {
  combineHostPortReservations,
  releaseHostPortReservations,
  reserveAvailableHostPortOnHosts,
  reserveSpecificHostPort,
  reserveSpecificHostPortOnHosts,
  reservedHostPorts,
  runWithHeldHostPortReservations,
  tryReserveHostPort,
  type HostPortReservation,
} from "../portReservations";
import { ensureTunnelListenerPortPolicy, reserveTunnelExitPort, usesSharedTunnelPrimaryListener } from "../repositories/tunnelRepository";
import { trafficBillingUserLockKey, withKeyedTaskLock, withTrafficBillingUserLock } from "../keyedTaskLock";
import { mapWithConcurrency } from "../asyncPool";
import { reserveRuleCreateQuota, type RuleQuotaReservation } from "../ruleQuotaReservations";
import { assertRuleTargetsAllowedForActor } from "../ruleTargetPolicy";
import {
  assertSniRuleTargetNotLoop,
  isSniRule,
  requireTlsInboundHostAccess,
  requireTlsInboundRunnable,
  reserveSniBackendPort,
  SNI_RULE_FORWARD_TYPES,
  validateSniRuleNames,
} from "../tlsInbounds";
import { parseSniNameJson } from "@shared/tlsInbound";
import { forwardGroupModeOf } from "@shared/forwardTypes";
import { RULE_EGRESS_TYPES, ruleEgressShapeError, ruleHasEgress } from "@shared/ssEgress";
import {
  hasEgressInput,
  resolveRuleEgressColumns,
  ruleEgressColumnsOf,
  type RuleEgressColumns,
  type RuleEgressInput,
} from "../ssEgress";
import {
  applyRuleEntryBridgeSwitch,
  entryBridgeAwarePortError,
  prepareRuleEntryBridgeSwitch,
  refreshRuleEntryBridgeHosts,
} from "../ruleEntryBridges";

/**
 * 规则行上的协议封禁三列永远写 false。
 *
 * 真正生效的封禁只有**主机**那一层：下发给 Agent 的策略一律按 rule.hostId 去查主机
 * （见 agentHeartbeatRoute 的 protocolPolicyFromHost / getHostProtocolPolicy），规则
 * 自己的这三列全仓库没有任何地方读过。
 *
 * 那为什么不干脆不写？因为老库里可能存着 true。哪天有人把下发那一路接到规则这一层，
 * 那些沉睡的 true 会毫无征兆地生效 —— 一条早就正常跑着的转发突然开始拦 HTTP，而
 * 界面上没有任何开关能解释它。写死 false 就是不让这件事发生。
 *
 * 想给单条规则加协议封禁的话，得先把下发那一路接上，不能只往这三列里填值。
 * server/ruleProtocolBlock.test.ts 盯着这件事。
 */
const RULE_PROTOCOL_BLOCK_COLUMNS = { blockHttp: false, blockSocks: false, blockTls: false } as const;

const targetHostSchema = z.string().min(1).max(253).refine(
  (v) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(v.trim()),
  "请输入有效的 IP 地址或域名"
);

const failoverTargetSchema = z.object({
  targetIp: z.string().max(253).optional().default(""),
  targetPort: z.number().int().min(0).max(65535).optional().default(0),
  // 这条出站的健康探测目标，选填。见 shared/failoverTargets 里的说明。
  probeIp: z.string().max(253).optional(),
  probePort: z.number().int().min(0).max(65535).optional(),
});
const strictFailoverTargetSchema = z.object({
  targetIp: targetHostSchema,
  targetPort: z.number().int().min(1).max(65535),
});
const strictProbeTargetSchema = z.object({
  probeIp: targetHostSchema,
  probePort: z.number().int().min(1).max(65535),
});
const failoverStrategySchema = z.enum(["fallback", "round_robin", "random", "ip_hash"]);
// GOST、Nginx、NEX 隧道：调度器在出口机上（shared/routeGroup 的 ROUTE_GROUP_TUNNEL_MODES）。
function isMainBackupGostTunnelMode(mode: unknown) {
  return routeGroupTunnelModeSupported(mode);
}

const failoverScheduleInputSchema = z.object({
  timezone: z.string().min(1).max(64),
  windows: z.array(z.object({
    days: z.array(z.number().int().min(0).max(6)).max(7),
    from: z.string().max(5),
    to: z.string().max(5),
    targetIndex: z.number().int().min(0).max(MAX_FAILOVER_TARGETS),
  })).max(MAX_FAILOVER_SCHEDULE_WINDOWS),
});

const routeEndpointInputSchema = z.object({
  ip: targetHostSchema,
  port: z.number().int().min(1).max(65535),
});

/**
 * 线路组（shared/routeGroup）：一个入口 + 多条路径 + 一个调度策略。
 *
 * 界面整份提交；没传的参数沿用库里的，库里也没有就按模式的模板预填。老的 failover*
 * 字段照常收（Telegram 机器人、老界面、只改钉子的那一次保存都还走它们），落库时由线路组
 * 推导出来，见 normalizeFailoverInput。
 */
const routePathInputSchema = z.object({
  key: z.string().max(32).optional(),
  name: z.string().max(40).optional(),
  hops: z.array(z.number().int().positive()).max(MAX_ROUTE_HOPS).optional(),
  dest: routeEndpointInputSchema.nullable().optional(),
  weight: z.number().int().min(ROUTE_GUARD_LIMITS.weight.min).max(ROUTE_GUARD_LIMITS.weight.max).optional(),
  probe: routeEndpointInputSchema.nullable().optional(),
});

const routeGroupInputSchema = z.object({
  paths: z.array(routePathInputSchema).min(1).max(MAX_ROUTE_PATHS),
  mode: z.enum(ROUTE_MODES),
  spread: z.enum(ROUTE_SPREADS).optional(),
  schedule: failoverScheduleInputSchema.nullable().optional(),
  pin: z.object({
    index: z.number().int().min(0).max(MAX_ROUTE_PATHS),
    untilMs: z.number().int().min(0).nullable().optional(),
  }).nullable().optional(),
  failureThreshold: z.number().int().min(ROUTE_GUARD_LIMITS.failureThreshold.min).max(ROUTE_GUARD_LIMITS.failureThreshold.max).optional(),
  failoverSeconds: z.number().int().min(ROUTE_GUARD_LIMITS.failoverSeconds.min).max(ROUTE_GUARD_LIMITS.failoverSeconds.max).optional(),
  recoverSeconds: z.number().int().min(ROUTE_GUARD_LIMITS.recoverSeconds.min).max(ROUTE_GUARD_LIMITS.recoverSeconds.max).optional(),
  minHoldSeconds: z.number().int().min(ROUTE_GUARD_LIMITS.minHoldSeconds.min).max(ROUTE_GUARD_LIMITS.minHoldSeconds.max).optional(),
  autoFailback: z.boolean().optional(),
  scoreMargin: z.number().int().min(ROUTE_GUARD_LIMITS.scoreMargin.min).max(ROUTE_GUARD_LIMITS.scoreMargin.max).optional(),
  scoreHoldSeconds: z.number().int().min(ROUTE_GUARD_LIMITS.scoreHoldSeconds.min).max(ROUTE_GUARD_LIMITS.scoreHoldSeconds.max).optional(),
  prewarmSeconds: z.number().int().min(ROUTE_GUARD_LIMITS.prewarmSeconds.min).max(ROUTE_GUARD_LIMITS.prewarmSeconds.max).optional(),
  switchMode: z.enum(ROUTE_SWITCH_MODES).optional(),
});

type RouteGroupInput = z.infer<typeof routeGroupInputSchema>;

const failoverInputShape = {
  failoverEnabled: z.boolean().optional(),
  failoverStrategy: failoverStrategySchema.optional(),
  failoverTargets: z.array(failoverTargetSchema).max(MAX_FAILOVER_TARGETS).optional(),
  /** 主线路的探测目标（`地址:端口`），留空就探出站地址本身。 */
  failoverProbeTarget: z.string().max(300).nullable().optional(),
  /** 时段表：某几个时段里优先走哪一条出站。 */
  failoverSchedule: failoverScheduleInputSchema.nullable().optional(),
  /** 线路组整份：传了它，上面的老字段只当补充（钉子、时段表）。null = 退回老式主备。 */
  routeGroup: routeGroupInputSchema.nullable().optional(),
  failoverMinHoldSeconds: z.number().int().min(0).max(86400).optional(),
  /** 人工指定优先走第几条出站；null = 交回自动。 */
  failoverPinnedIndex: z.number().int().min(0).max(MAX_FAILOVER_TARGETS).nullable().optional(),
  /** 钉到什么时候（Unix 秒）；null = 一直钉着。 */
  failoverPinnedUntil: z.number().int().min(0).nullable().optional(),
  /** 按实测延迟自动择优。 */
  failoverPreferFastest: z.boolean().optional(),
  failoverSeconds: z.number().int().min(10).max(3600).optional(),
  recoverSeconds: z.number().int().min(10).max(3600).optional(),
  autoFailback: z.boolean().optional(),
} as const;

const proxyProtocolVersionSchema = z.union([z.literal(1), z.literal(2)]);

const proxyProtocolInputShape = {
  proxyProtocolReceive: z.boolean().optional(),
  proxyProtocolSend: z.boolean().optional(),
  proxyProtocolExitReceive: z.boolean().optional(),
  proxyProtocolExitSend: z.boolean().optional(),
  proxyProtocolVersion: proxyProtocolVersionSchema.optional(),
} as const;

const transportTuningInputShape = {
  tcpFastOpen: z.boolean().optional(),
  zeroCopy: z.boolean().optional(),
  udpOverTcp: z.boolean().optional(),
  udpOverTcpPort: z.number().int().min(0).max(65535).nullable().optional(),
} as const;

async function requireRuleTelegramNotifyReady(enabled?: boolean) {
  if (!enabled) return;
  if (!(await isTelegramBotReady())) {
    throw new Error("请先在系统设置中配置并启用 Telegram 机器人，再开启异常TG提醒");
  }
}

const FAILOVER_INPUT_KEYS = Object.keys(failoverInputShape);

type FailoverInput = {
  failoverEnabled?: boolean;
  failoverStrategy?: z.infer<typeof failoverStrategySchema>;
  failoverTargets?: Array<{ targetIp?: string; targetPort?: number; probeIp?: string; probePort?: number }>;
  failoverProbeTarget?: string | null;
  failoverSchedule?: unknown;
  failoverMinHoldSeconds?: number;
  failoverPinnedIndex?: number | null;
  failoverPinnedUntil?: number | null;
  failoverPreferFastest?: boolean;
  failoverSeconds?: number;
  recoverSeconds?: number;
  autoFailback?: boolean;
  routeGroup?: RouteGroupInput | null;
};

/** 归一化时要知道的上下文：编辑的是哪一行、入口在哪台机器、主人能用哪些主机。 */
export type NormalizeFailoverContext = {
  /** 编辑时库里的那一行：没传 routeGroup 而它有 routePaths 时，路径照旧，只换这次改的字段。 */
  rule?: any | null;
  /** 调度层所在的机器（直连规则是入口机，GOST 隧道规则是出口机）：路径的中转不能是它。 */
  entryHostId?: number | null;
  /** 主人能用的主机；不给就不查（管理员）。 */
  hostIds?: Set<number> | null;
  targetIp?: unknown;
  targetPort?: unknown;
  /** 转发组模板不跑在任何一台机器上，路径不能带中转。 */
  allowHops?: boolean;
};

/** 主线路的探测目标：`地址:端口`，留空存 null。填错必须报错，不能默默当成没填。 */
function normalizeMainProbeTarget(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const parsed = parseFailoverEndpoint(text);
  if (!parsed) return null;
  if ("error" in parsed) throw new Error(`主线路探测目标：${parsed.error}`);
  const checked = strictProbeTargetSchema.safeParse({ probeIp: parsed.host, probePort: parsed.port });
  if (!checked.success) throw new Error("主线路探测目标的地址或端口格式不正确");
  return formatFailoverEndpoint(checked.data.probeIp, checked.data.probePort);
}

/**
 * 时段表落库前的校验。
 *
 * 两处必须报错、不能默默收下：
 *
 *   · **时段表只对主备模式生效**。轮询/随机/IP 哈希本来就不存在「首选是谁」，
 *     收下一张永远不会被读的表，等于告诉用户「排好了」而什么都不会发生。
 *   · **首选的出站得真的存在**。指向第 5 条而一共只配了 3 条，到点之后时段表
 *     静默失效 —— 而这正是它唯一该干活的时刻。
 */
function normalizeFailoverScheduleInput(input: FailoverInput, backupCount: number): string | null {
  const schedule = parseFailoverSchedule(input.failoverSchedule as any);
  const error = validateFailoverSchedule(schedule, {
    strategy: input.failoverStrategy || "fallback",
    backupCount,
  });
  if (error) throw new Error(error);
  return serializeFailoverSchedule(schedule);
}

/** 库里存的是 Date（或秒），入参统一用 Unix 秒。 */
function epochSecondsOf(value: unknown): number | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value as any);
  const seconds = Math.floor(date.getTime() / 1000);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * 人工钉住某一条出站。
 *
 * 钉住的是「排到最前」，不是「只许走它」—— 钉住的那条挂了仍然按优先级往下找。运维
 * 想要的是「现在走 B」，不是「B 死了也守着 B」，后者等于用一个应急开关制造一次故障。
 *
 * 指向不存在的出站一律当成没钉：宁可交回自动，也不能让一条规则因为一个坏值走不通。
 * 期限已经过去的也一样 —— 存一个从一开始就过期的钉子没有任何意义。
 *
 * 只有主备（fallback）才存：轮询、随机、哈希本来就没有「首选是谁」，Agent 也不看
 * 这一项。存着的话面板上写着「强制走 备用 1」，机器上什么都没发生。
 */
function normalizeFailoverPinInput(input: FailoverInput, backupCount: number, enabled: boolean) {
  /*
    读法交给 shared/failoverPin。上一版在这里 Number(input.failoverPinnedIndex)：
    前端传 null 表示「自动」，Number(null) 是 0 —— 每一条从界面新建的主备规则都被
    存成「钉在主线路、一直钉着」。另一处：已经过去的期限被当成「没填期限」，
    过期的钉子一保存就复活成永久的。
  */
  const pin = enabled && (input.failoverStrategy || "fallback") === "fallback"
    ? readFailoverPin(
      { failoverPinnedIndex: input.failoverPinnedIndex, failoverPinnedUntil: input.failoverPinnedUntil },
      { lineCount: backupCount + 1 },
    )
    : null;
  if (!pin) return { failoverPinnedIndex: null, failoverPinnedUntil: null };
  return { failoverPinnedIndex: pin.index, failoverPinnedUntil: pin.untilMs ? new Date(pin.untilMs) : null };
}

/**
 * 编辑时，主备里哪些字段该沿用库里的值、哪些该换成这次传上来的。
 *
 * 「没传」（undefined）是沿用，「传了 null」是清空 —— 上一版一律写成
 * `input.x ?? rule.x`，而 `??` 把 null 也当成没传：在编辑框里把「强制走」改回
 * 「自动」、删光时段表、清空主线路探测目标，保存之后三样都原样留着。其中钉子最要命：
 * 它压过时段表和自动择优，解不开就等于这两样永远不生效。
 *
 * 钉子的序号和期限是一对：传了其中一个，两个都以这次为准（期限传 null 就是一直钉着）。
 */
function mergeFailoverClearableFields(input: FailoverInput, rule: any) {
  const pinProvided = input.failoverPinnedIndex !== undefined || input.failoverPinnedUntil !== undefined;
  return {
    failoverProbeTarget: input.failoverProbeTarget !== undefined ? input.failoverProbeTarget : rule?.failoverProbeTarget,
    failoverSchedule: input.failoverSchedule !== undefined ? input.failoverSchedule : parseFailoverSchedule(rule?.failoverSchedule),
    failoverPinnedIndex: pinProvided ? input.failoverPinnedIndex ?? null : rule?.failoverPinnedIndex,
    failoverPinnedUntil: pinProvided ? input.failoverPinnedUntil ?? null : epochSecondsOf(rule?.failoverPinnedUntil),
  };
}

/**
 * 这次编辑有没有碰主备 —— 碰了就要整份重新归一化。
 *
 * 上一版只看策略、出站、切换/恢复时间和「恢复后切回」这几个字段。只改时段表或只改
 * 钉子的一次保存不会触发归一化，原样的入参（时段表是个对象、期限是个秒数）就直接
 * 顺着 `...input` 写进了库。
 */
function failoverFieldsProvided(input: FailoverInput) {
  return FAILOVER_INPUT_KEYS.some((key) => (input as any)[key] !== undefined);
}

/**
 * 协议不再限制：TCP、UDP、TCP+UDP 都能调度（UDP 按会话，Agent 2.2.199 起）。第二个参数
 * 留着只为调用处不用改；转发方式的限制在 requireMainBackupAllowed。
 */
export function normalizeFailoverInput(input: FailoverInput, _protocol?: string | null, context: NormalizeFailoverContext = {}) {
  const enabled = !!input.failoverEnabled;
  const targets: FailoverTarget[] = [];
  /*
    线路组：传了 routeGroup 就按它；没传但库里这一行已经是线路组（routePaths 有值），
    路径照旧、只换这次改的字段 —— 只改钉子的那一次保存不能把路径抹掉。传 null 是明确
    退回老式主备。
  */
  const storedPaths = context.rule ? parseRoutePaths(context.rule.routePaths) : [];
  const usesRouteGroup = enabled && (input.routeGroup ? true : input.routeGroup === undefined && storedPaths.length > 0);
  if (usesRouteGroup) return normalizeRouteGroupInput(input, context, storedPaths);
  if (enabled) {
    for (const target of input.failoverTargets || []) {
      const targetIp = String(target.targetIp || "").trim();
      const targetPort = Number(target.targetPort || 0);
      if (!targetIp && !targetPort) continue;
      if (!targetIp || !targetPort) {
        throw new Error("备用线路需要同时填写地址和端口，完全空白的行可以保留");
      }
      const parsed = strictFailoverTargetSchema.safeParse({ targetIp, targetPort });
      if (!parsed.success) throw new Error("备用线路地址或端口格式不正确");
      const probeIp = String(target.probeIp || "").trim();
      const probePort = Number(target.probePort || 0);
      if (probeIp || probePort) {
        const probe = strictProbeTargetSchema.safeParse({ probeIp, probePort });
        // 填错的探测地址一定要报出来。默默丢掉的话这条出站会退回探自己，而用户
        // 以为已经在探端到端了 —— 正是他想修的那个盲区，又悄悄回来了。
        if (!probe.success) throw new Error("备用线路的探测地址或端口格式不正确");
        targets.push({ ...parsed.data, probeIp: probe.data.probeIp, probePort: probe.data.probePort });
      } else {
        targets.push(parsed.data);
      }
      if (targets.length >= MAX_FAILOVER_TARGETS) break;
    }
  }
  if (enabled && targets.length === 0) {
    throw new Error("开启主备模式后至少需要配置一个备用线路");
  }
  return {
    failoverEnabled: enabled,
    failoverStrategy: input.failoverStrategy || "fallback",
    failoverTargets: enabled ? JSON.stringify(targets) : null,
    failoverProbeTarget: enabled ? normalizeMainProbeTarget(input.failoverProbeTarget) : null,
    failoverSchedule: enabled ? normalizeFailoverScheduleInput(input, targets.length) : null,
    failoverMinHoldSeconds: enabled ? Math.max(0, Math.floor(Number(input.failoverMinHoldSeconds || 0))) : 0,
    ...normalizeFailoverPinInput(input, targets.length, enabled),
    // 自动择优只在主备模式下有意义：轮询/随机/哈希本来就不存在「首选是谁」。
    failoverPreferFastest: enabled && (input.failoverStrategy || "fallback") === "fallback"
      ? !!input.failoverPreferFastest
      : false,
    failoverSeconds: input.failoverSeconds ?? 60,
    recoverSeconds: input.recoverSeconds ?? 120,
    autoFailback: input.autoFailback ?? true,
    // 老式主备（或者关掉了）：路径清单清掉，failover* 列重新成为真源。
    routeMode: null,
    routePaths: null,
  };
}

function clampGuard(value: unknown, field: keyof typeof ROUTE_GUARD_LIMITS, fallback: number) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  const limit = ROUTE_GUARD_LIMITS[field];
  return Math.min(limit.max, Math.max(limit.min, number));
}

function sameEndpoint(left: { ip: string; port: number } | null | undefined, right: { ip: string; port: number } | null | undefined) {
  if (!left || !right) return !left && !right;
  return left.ip === right.ip && Number(left.port) === Number(right.port);
}

/**
 * 线路组落库前的归一化：路径 + 策略 → routePaths / routeMode 那几列，外加推导出来的老列。
 *
 * 校验用 shared 那一份（validateRouteGroup）：客户端提交前跑的是同一个函数，「面板收下了、
 * 机器上不生效」这种分家不会发生在这一层。中转在中转机上要建中继规则，那是保存之后的事
 * （syncRouteRelayRulesForRule），这里只把路径存下来。
 */
function normalizeRouteGroupInput(input: FailoverInput, context: NormalizeFailoverContext, storedPaths: RoutePath[]) {
  const rule = context.rule || null;
  const target = {
    targetIp: context.targetIp !== undefined ? context.targetIp : rule?.targetIp,
    targetPort: context.targetPort !== undefined ? context.targetPort : rule?.targetPort,
  };
  const nowMs = Date.now();
  const storedGroup = rule && storedPaths.length > 0 ? routeGroupOf({ ...rule, failoverEnabled: true }, { nowMs }) : null;
  let paths: RoutePath[];
  let policy: RouteGroupPolicy;
  const routeGroup = input.routeGroup;
  if (routeGroup) {
    const storedByKey = new Map(storedPaths.map((path) => [path.key, path]));
    const usedKeys = new Set<string>();
    const drafted: RoutePath[] = routeGroup.paths.map((raw) => {
      let key = String(raw.key || "").trim().toLowerCase();
      if (!key || usedKeys.has(key)) {
        do key = newRoutePathKey(); while (usedKeys.has(key) || storedByKey.has(key));
      }
      usedKeys.add(key);
      const hops = Array.from(new Set((raw.hops || []).map((hop) => Math.floor(Number(hop))).filter((hop) => hop > 0)));
      const dest = raw.dest ? { ip: String(raw.dest.ip).trim(), port: Number(raw.dest.port) } : null;
      const stored = storedByKey.get(key);
      const unchanged = !!stored
        && stored.hops.length === hops.length
        && stored.hops.every((hop, index) => hop === hops[index])
        && sameEndpoint(stored.dest, dest);
      return {
        key,
        name: String(raw.name || "").trim().slice(0, 40),
        hops,
        dest,
        weight: raw.weight ?? stored?.weight ?? 50,
        probe: raw.probe ? { ip: String(raw.probe.ip).trim(), port: Number(raw.probe.port) } : null,
        // 拨号地址由保存后的同步解析；中转和落地没动的路径先沿用上次的，Agent 不用等一轮。
        dial: unchanged ? stored!.dial : null,
        issue: unchanged ? stored!.issue : null,
      };
    });
    paths = parseRoutePaths(drafted);
    const mode = routeGroup.mode;
    const base = storedGroup?.policy;
    const template = routeTemplateGuards(mode);
    const pin = routeGroup.pin === undefined
      ? (base?.pin ?? null)
      : routeGroup.pin
        ? readFailoverPin(
          { failoverPinnedIndex: routeGroup.pin.index, failoverPinnedUntil: routeGroup.pin.untilMs ? Math.floor(routeGroup.pin.untilMs / 1000) : null },
          { nowMs, lineCount: paths.length },
        )
        : null;
    const schedule = routeGroup.schedule === undefined ? (base?.schedule ?? null) : parseFailoverSchedule(routeGroup.schedule as any);
    policy = {
      mode,
      spread: normalizeRouteSpread(routeGroup.spread ?? base?.spread),
      schedule: mode === "scheduled" || mode === "hybrid" ? schedule : null,
      pin: mode === "weighted" ? null : pin,
      failureThreshold: clampGuard(routeGroup.failureThreshold ?? base?.failureThreshold, "failureThreshold", template.failureThreshold),
      failoverSeconds: clampGuard(routeGroup.failoverSeconds ?? base?.failoverSeconds, "failoverSeconds", template.failoverSeconds),
      recoverSeconds: clampGuard(routeGroup.recoverSeconds ?? base?.recoverSeconds, "recoverSeconds", template.recoverSeconds),
      minHoldSeconds: clampGuard(routeGroup.minHoldSeconds ?? base?.minHoldSeconds, "minHoldSeconds", template.minHoldSeconds),
      autoFailback: routeGroup.autoFailback ?? base?.autoFailback ?? template.autoFailback,
      scoreMargin: clampGuard(routeGroup.scoreMargin ?? base?.scoreMargin, "scoreMargin", template.scoreMargin),
      scoreHoldSeconds: clampGuard(routeGroup.scoreHoldSeconds ?? base?.scoreHoldSeconds, "scoreHoldSeconds", template.scoreHoldSeconds),
      prewarmSeconds: clampGuard(routeGroup.prewarmSeconds ?? base?.prewarmSeconds, "prewarmSeconds", template.prewarmSeconds),
      switchMode: normalizeRouteSwitchMode(routeGroup.switchMode ?? base?.switchMode),
    };
  } else {
    /*
      老字段更新到线路组规则上：钉子、时段表、切换保护这些照单收，路径和模式照旧。
      编辑那条路把没传的字段用库里的值补齐了再传进来，而库里那几列本来就是从线路组
      推导出来的，所以这里读到的要么是这次改的，要么和线路组一致。
    */
    paths = storedPaths;
    const base = storedGroup!.policy;
    const usesSchedule = base.mode === "scheduled" || base.mode === "hybrid";
    policy = {
      ...base,
      schedule: usesSchedule ? parseFailoverSchedule(input.failoverSchedule as any) : null,
      pin: base.mode === "weighted"
        ? null
        : readFailoverPin(
          { failoverPinnedIndex: input.failoverPinnedIndex, failoverPinnedUntil: input.failoverPinnedUntil },
          { nowMs, lineCount: paths.length },
        ),
      minHoldSeconds: clampGuard(input.failoverMinHoldSeconds, "minHoldSeconds", base.minHoldSeconds),
      failoverSeconds: clampGuard(input.failoverSeconds, "failoverSeconds", base.failoverSeconds),
      recoverSeconds: clampGuard(input.recoverSeconds, "recoverSeconds", base.recoverSeconds),
      autoFailback: input.autoFailback ?? base.autoFailback,
    };
  }
  if (context.allowHops === false && paths.some((path) => path.hops.length > 0)) {
    throw new Error("转发组模板的线路不支持中转：模板本身不跑在任何一台机器上");
  }
  const group: RouteGroup = { paths, policy };
  const error = validateRouteGroup(group, {
    entryHostId: context.entryHostId ?? (rule ? Number(rule.hostId) : null),
    hostIds: context.hostIds ?? null,
    hasRuleTarget: !!String(target.targetIp || "").trim() && Number(target.targetPort) > 0,
  });
  if (error) throw new Error(error);
  return {
    failoverEnabled: true,
    ...legacyFailoverColumns(group, target),
    routeMode: policy.mode,
    routePaths: serializeRoutePaths(paths),
    routeSwitchMode: policy.switchMode,
    routeFailureThreshold: policy.failureThreshold,
    routeScoreMargin: policy.scoreMargin,
    routeScoreHoldSeconds: policy.scoreHoldSeconds,
    routePrewarmSeconds: policy.prewarmSeconds,
  };
}

/** 非管理员能把哪些主机当中转：他有权使用的那些。管理员不限（返回 null 表示不查）。 */
async function routeHostIdsForActor(actor: { id: number; role: string }) {
  if (actor.role === "admin") return null;
  const scope = await getLinkAccessScope(actor);
  if (!scope) return new Set<number>();
  return new Set<number>(scope.useHostIds || scope.hostIds);
}

/**
 * 调度层跑在哪台机器上：隧道规则在隧道的出口机（GOST、Nginx 隧道由出口的 gost / nginx 拨它，
 * NEX 隧道由出口的 FXP 拨它），端口转发在规则所在的机器。
 */
export function routeEntryHostId(hostId: number, tunnel: any | null | undefined) {
  if (!tunnel) return hostId;
  return Number(tunnel.exitHostId || hostId);
}

/**
 * 调度器实际跑在哪几台机器上，和 server/agentHeartbeatRoute.ts 的 routeSchedulerHostIds 同一个
 * 口径：直连规则是规则所在的机器；隧道（GOST、Nginx、NEX）是主出口加上开着的负载均衡
 * 出口 —— 停用的出口节点、负载均衡关掉后还留着的节点都不算。多出口时每个出口各跑一个调度器，
 * 需要新 Agent 的调度（UDP、NEX 隧道）要每一台都够版本才下发。
 */
export function routeSchedulerHostIds(hostId: number, tunnel: any | null | undefined, exitNodes: readonly any[] = []): number[] {
  const primary = routeEntryHostId(hostId, tunnel);
  if (!tunnel) return [primary];
  const ids = [primary];
  if (dbBool(tunnel.loadBalanceEnabled) && normalizeExitGroupStrategy(tunnel.loadBalanceStrategy) !== "none") {
    for (const node of exitNodes) {
      if (!node || !dbBool(node.isEnabled, true) || Number(node.hostId) <= 0 || Number(node.listenPort) <= 0) continue;
      ids.push(Number(node.hostId));
    }
  }
  return Array.from(new Set(ids.filter((id) => id > 0)));
}

/**
 * 保存之后把路径落实到中转机上（缺的建、多的收），见 server/routeGroups.ts。
 * 没有中转、也没有历史中继规则的规则什么都不做 —— 绝大多数规则。
 */
async function syncRouteGroupAfterSave(ruleId: number, reason: string) {
  const rule = await db.getForwardRuleById(ruleId);
  if (!rule) return;
  const hasHops = parseRoutePaths((rule as any).routePaths).some((path) => path.hops.length > 0);
  if (!hasHops) {
    const relays = await db.getRouteRelayRules(ruleId);
    if (relays.length === 0) return;
  }
  await syncRouteRelayRulesForRule(ruleId, { reason });
}

/** 人工指定变了就记一条：切换历史里「谁在什么时候把它钉到 B」和 Agent 报的切换排在一起。 */
async function recordRoutePinChange(rule: any, data: Record<string, unknown>) {
  if (!dbBool(data.failoverEnabled ?? rule?.failoverEnabled)) return;
  const nowMs = Date.now();
  const before = readFailoverPin(rule, { nowMs });
  const after = readFailoverPin(
    { failoverPinnedIndex: data.failoverPinnedIndex, failoverPinnedUntil: data.failoverPinnedUntil },
    { nowMs },
  );
  if (!!before === !!after && before?.index === after?.index && (before?.untilMs ?? null) === (after?.untilMs ?? null)) return;
  const paths = parseRoutePaths(data.routePaths ?? rule?.routePaths);
  const label = (index: number) => paths[index] ? routePathLabel(paths[index], index) : (index === 0 ? "主线路" : `备用 ${index}`);
  await db.insertForwardRuleRouteEvent({
    ruleId: Number(rule.id),
    kind: after ? "pinned" : "unpinned",
    fromKey: before ? paths[before.index]?.key ?? null : null,
    toKey: after ? paths[after.index]?.key ?? null : null,
    fromLabel: before ? label(before.index) : null,
    toLabel: after ? label(after.index) : null,
    reason: after
      ? (after.untilMs ? `panel: 人工指定，到 ${new Date(after.untilMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 为止` : "panel: 人工指定，直到手动取消")
      : "panel: 交回自动",
  }).catch(() => undefined);
}

export function normalizeProxyProtocolInput(input: {
  proxyProtocolReceive?: boolean;
  proxyProtocolSend?: boolean;
  proxyProtocolExitReceive?: boolean;
  proxyProtocolExitSend?: boolean;
  proxyProtocolVersion?: number;
  failoverEnabled?: boolean;
}, protocol?: string | null, forwardType?: string | null, isForwardChain?: boolean, options?: { clearUnsupported?: boolean; tunnelRoute?: boolean }) {
  const clearUnsupported = options?.clearUnsupported ?? false;
  const protocolSupported = !protocol || protocol === "tcp" || protocol === "both";
  const forwardTypeSupported = forwardType === "gost" || forwardType === "realm";
  const tunnelRoute = !!options?.tunnelRoute;
  const receive = !isForwardChain && protocolSupported && forwardTypeSupported && dbBool(input.proxyProtocolReceive);
  const send = !isForwardChain && protocolSupported && forwardTypeSupported && dbBool(input.proxyProtocolSend);
  const tunnelProxySupported = tunnelRoute && forwardType === "gost";
  const exitReceive = tunnelProxySupported && !isForwardChain && protocolSupported && dbBool(input.proxyProtocolExitReceive);
  const exitSend = tunnelProxySupported && !isForwardChain && protocolSupported && dbBool(input.proxyProtocolExitSend);
  const version = Number(input.proxyProtocolVersion) === 2 ? 2 : 1;
  if (!receive && !send && !exitReceive && !exitSend) {
    if (clearUnsupported) return {
      proxyProtocolReceive: false,
      proxyProtocolSend: false,
      proxyProtocolExitReceive: false,
      proxyProtocolExitSend: false,
      proxyProtocolVersion: 1,
    };
    if ((dbBool(input.proxyProtocolReceive) || dbBool(input.proxyProtocolSend) || dbBool(input.proxyProtocolExitReceive) || dbBool(input.proxyProtocolExitSend)) && protocol && protocol !== "tcp" && protocol !== "both") {
      throw new Error("PROXY Protocol 仅支持 TCP 协议");
    }
    if ((dbBool(input.proxyProtocolReceive) || dbBool(input.proxyProtocolSend) || dbBool(input.proxyProtocolExitReceive) || dbBool(input.proxyProtocolExitSend)) && !forwardTypeSupported) {
      throw new Error("PROXY Protocol 仅支持 GOST 端口转发、GOST 隧道和自定义加密隧道");
    }
    return {
      proxyProtocolReceive: false,
      proxyProtocolSend: false,
      proxyProtocolExitReceive: false,
      proxyProtocolExitSend: false,
      proxyProtocolVersion: 1,
    };
  }
  return {
    proxyProtocolReceive: receive,
    proxyProtocolSend: send,
    proxyProtocolExitReceive: exitReceive,
    proxyProtocolExitSend: exitSend,
    proxyProtocolVersion: version,
  };
}
export function normalizeTransportTuningInput(input: {
  tcpFastOpen?: boolean;
  zeroCopy?: boolean;
  udpOverTcp?: boolean;
  udpOverTcpPort?: number | null;
}, protocol?: string | null, forwardType?: string | null, isForwardChain?: boolean, options?: { clearUnsupported?: boolean; tunnelRoute?: boolean; forwardxTunnel?: boolean }) {
  const clearUnsupported = options?.clearUnsupported ?? false;
  const protocolSupported = !protocol || protocol === "tcp" || protocol === "both";
  const udpOverTcpProtocolSupported = protocol === "udp" || protocol === "both";
  const tunnelRoute = !!options?.tunnelRoute;
  const forwardxTunnel = !!options?.forwardxTunnel;
  // Realm 2.9.x removed the network.fast_open and network.zero_copy options
  // (the old TOML keys are silently ignored). Keep the database columns for
  // migration compatibility, but never advertise or persist these options for
  // Realm. NEX's own TFO implementation remains supported below.
  const fastOpenSupported = !isForwardChain && protocolSupported
    && forwardType === "gost" && tunnelRoute && forwardxTunnel;
  const zeroCopySupported = false;
  const udpOverTcpSupported = !isForwardChain && udpOverTcpProtocolSupported && forwardType === "gost" && tunnelRoute && forwardxTunnel;
  const tcpFastOpen = fastOpenSupported && dbBool(input.tcpFastOpen);
  const zeroCopy = zeroCopySupported && dbBool(input.zeroCopy);
  const udpOverTcp = udpOverTcpSupported && dbBool(input.udpOverTcp);
  if (dbBool(input.udpOverTcp) && !udpOverTcpSupported && !clearUnsupported) {
    if (protocol !== "udp" && protocol !== "both") {
      throw new Error("UDP 混淆仅支持 UDP 或 TCP+UDP 规则");
    }
    throw new Error("UDP 混淆仅支持 NEX 自定义加密隧道的 UDP/TCP+UDP 规则");
  }
  if (!tcpFastOpen && !zeroCopy && !udpOverTcp) {
    if (clearUnsupported) return { tcpFastOpen: false, zeroCopy: false, udpOverTcp: false, udpOverTcpPort: null };
    if ((dbBool(input.tcpFastOpen) || dbBool(input.zeroCopy)) && protocol && protocol !== "tcp" && protocol !== "both") {
      throw new Error("TCP Fast Open 和 zero-copy 仅支持 TCP 协议");
    }
    if (dbBool(input.tcpFastOpen) && !fastOpenSupported) {
      throw new Error("当前转发方式不支持 TCP Fast Open");
    }
    if (dbBool(input.zeroCopy) && !zeroCopySupported) {
      throw new Error("当前转发方式不支持 zero-copy");
    }
  }
  return { tcpFastOpen, zeroCopy, udpOverTcp, udpOverTcpPort: null };
}

function tunnelRuntimeOptionInput(tunnel: any | null | undefined) {
  if (!tunnel) return {};
  return {
    proxyProtocolReceive: dbBool(tunnel.proxyProtocolReceive),
    proxyProtocolSend: dbBool(tunnel.proxyProtocolSend),
    proxyProtocolExitReceive: dbBool(tunnel.proxyProtocolExitReceive),
    proxyProtocolExitSend: dbBool(tunnel.proxyProtocolExitSend),
    proxyProtocolVersion: Number(tunnel.proxyProtocolVersion) === 2 ? 2 : 1,
    tcpFastOpen: dbBool(tunnel.tcpFastOpen),
    zeroCopy: false,
    udpOverTcp: dbBool(tunnel.udpOverTcp),
    udpOverTcpPort: null,
  };
}

function normalizeRuleTargetIp(input: string, _options: { tunnelId?: number | null }) {
  return String(input || "").trim();
}

/**
 * Managed GOST/Nginx tunnels share the tunnel listener for the first active
 * rule. Additional rules need their own exit listener. Keep this decision in
 * one place when allocating the rule's bookkeeping port; the Agent uses the
 * same lowest-id primary convention.
 */
async function preferredSharedTunnelListenPort(tunnel: any, ruleId = 0, enabled = true) {
  if (!usesSharedTunnelPrimaryListener(tunnel)) return null;
  const tunnelId = Number(tunnel?.id || 0);
  const listenPort = Number(tunnel?.listenPort || 0);
  if (tunnelId <= 0 || listenPort <= 0 || !dbBool(enabled, true)) return null;
  const rules = await db.getForwardRulesByTunnel(tunnelId);
  const activeIds = (rules as any[])
    .filter((candidate) => (
      candidate
      && !dbBool(candidate.isForwardGroupTemplate)
      && !dbBool(candidate.pendingDelete)
      && dbBool(candidate.isEnabled)
      && String(candidate.forwardType || "").trim().toLowerCase() === "gost"
      && (!ruleId || Number(candidate.id) !== ruleId)
    ))
    .map((candidate) => Number(candidate.id || 0))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (ruleId > 0) activeIds.push(ruleId);
  const primaryId = activeIds.length > 0 ? Math.min(...activeIds) : 0;
  // A new rule is primary only when no other active rule already owns this
  // tunnel. Existing rules are primary when they are the lowest active id.
  if (ruleId > 0 ? primaryId !== ruleId : activeIds.length > 0) return null;
  return listenPort;
}

function normalizeAddressToken(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isLoopbackAddress(value: unknown) {
  const target = normalizeAddressToken(value);
  if (!target) return false;
  if (target === "localhost" || target === "ip6-localhost") return true;
  if (target === "0.0.0.0" || target === "::" || target === "0:0:0:0:0:0:0:0") return true;
  if (target === "::1" || target === "0:0:0:0:0:0:0:1") return true;
  // Browsers and DNS libraries also accept non-dotted IPv4 forms. Normalize
  // 32-bit decimal/hex forms before applying the loopback check so 127.0.0.1
  // cannot be disguised as 2130706433 or 0x7f000001.
  if (/^(?:0x[0-9a-f]+|\d+)$/.test(target)) {
    const value32 = target.startsWith("0x") ? Number.parseInt(target.slice(2), 16) : Number(target);
    if (Number.isSafeInteger(value32) && value32 >= 0 && value32 <= 0xffffffff) {
      const firstOctet = Math.floor(value32 / 0x1000000);
      if (firstOctet === 127) return true;
    }
  }
  if (isIP(target) === 4) return target.startsWith("127.");
  return false;
}

function hostAddressTokens(host: any) {
  return new Set(
    [
      host?.ip,
      host?.ipv4,
      host?.ipv6,
      host?.entryIp,
      host?.tunnelEntryIp,
      host?.ddnsDomain,
    ]
      .map(normalizeAddressToken)
      .filter(Boolean),
  );
}

function assertNoDirectSelfForwardLoop(options: {
  host?: any;
  sourcePort: number;
  targetIp: unknown;
  targetPort: number;
  tunnelId?: number | null;
}) {
  const sourcePort = Number(options.sourcePort || 0);
  const targetPort = Number(options.targetPort || 0);
  if (sourcePort <= 0 || sourcePort !== targetPort) return;
  if (Number(options.tunnelId || 0) > 0) return;
  const target = normalizeAddressToken(options.targetIp);
  if (!target) return;
  if (isLoopbackAddress(target) || hostAddressTokens(options.host).has(target)) {
    throw new Error(`禁止将本机 ${sourcePort} 端口转发回自身同端口，这会造成转发死循环`);
  }
}

/**
 * 挂在转发组 / 端口转发上的规则，每台入口主机都要查一遍死循环：端口转发能挂多台入口（2.3.437 起）
 * 或入口组后，目标可能正好是第二台入口自己，只查默认那台（第一台）就漏了（Codex 在 #121 指出）。
 */
async function assertNoGroupSelfForwardLoop(groupId: number, options: { sourcePort: number; targetIp: unknown; targetPort: number }) {
  for (const hostId of await db.getForwardGroupRuleEntryHostIds(groupId)) {
    assertNoDirectSelfForwardLoop({ host: await db.getHostById(hostId), ...options, tunnelId: null });
  }
}

function normalizeLockedForwardType(value: unknown) {
  const parsed = forwardTypeSchema.safeParse(String(value || ""));
  return parsed.success ? parsed.data : "iptables";
}

function lockedForwardTypeForGroup(group: any, fallback: unknown = "iptables") {
  const groupMode = String(group?.groupMode || "failover");
  const groupType = String(group?.groupType || "host");
  if (groupMode !== "chain" && groupType === "tunnel") return "gost";
  return normalizeLockedForwardType(group?.forwardType || fallback);
}

async function forwardGroupTunnelMembersSupportMainBackup(group: any) {
  const members = Array.isArray(group?.members) ? group.members : [];
  const tunnelMembers = members.filter((member: any) => dbBool(member?.isEnabled, true) && Number(member?.tunnelId || 0) > 0);
  if (tunnelMembers.length === 0) return false;
  for (const member of tunnelMembers) {
    const tunnel = await db.getTunnelById(Number(member.tunnelId));
    if (!isMainBackupGostTunnelMode((tunnel as any)?.mode)) return false;
  }
  return true;
}

/**
 * 这次要写的值和库里的一样吗。
 *
 * 钉住的期限是 Date，要写的和库里读出来的各是各的对象，`!==` 永远说「变了」——
 * 按时刻比。其余字段照旧严格相等。
 */
function sameStoredValue(next: unknown, current: unknown) {
  if (next instanceof Date || current instanceof Date) {
    if (next == null || current == null) return next == null && current == null;
    return timestampMillis(next) === timestampMillis(current);
  }
  return next === current;
}

/** 线路组那几列：改了要推给 Agent，而且能热更新（换规格不重启转发）。 */
const ROUTE_RULE_COLUMNS = [
  "routeMode",
  "routePaths",
  "routeSwitchMode",
  "routeFailureThreshold",
  "routeScoreMargin",
  "routeScoreHoldSeconds",
  "routePrewarmSeconds",
] as const;

function isFailoverHotUpdate(input: Record<string, unknown>, rule: any, nextHostId: number, nextTunnelId: number | null) {
  const changedFields = [
    "sourcePort",
    "targetIp",
    "targetPort",
    "forwardType",
    "protocol",
    "gostMode",
    "gostRelayHost",
    "gostRelayPort",
    "tunnelId",
    "tunnelExitPort",
    "hostId",
    "failoverEnabled",
    "failoverStrategy",
    "failoverTargets",
    "failoverProbeTarget",
    "failoverSchedule",
    "failoverMinHoldSeconds",
    "failoverPinnedIndex",
    "failoverPinnedUntil",
    "failoverPreferFastest",
    "failoverSeconds",
    "recoverSeconds",
    "autoFailback",
    ...ROUTE_RULE_COLUMNS,
  ].filter((field) => input[field] !== undefined && !sameStoredValue(input[field], rule?.[field]));
  if (changedFields.length === 0) return false;
  if (!dbBool(rule?.isEnabled) || !dbBool(rule?.isRunning) || !dbBool(rule?.failoverEnabled)) return false;
  if (input.failoverEnabled === false) return false;
  if (String(input.forwardType ?? rule.forwardType) !== "gost") return false;
  if (String(input.protocol ?? rule.protocol) !== "tcp") return false;
  if (Number(nextHostId) !== Number(rule.hostId)) return false;
  if (Number(nextTunnelId || 0) !== Number(rule.tunnelId || 0)) return false;

  const hotFields = new Set([
    "targetIp",
    "targetPort",
    "failoverStrategy",
    "failoverTargets",
    "failoverProbeTarget",
    "failoverSchedule",
    "failoverMinHoldSeconds",
    "failoverPinnedIndex",
    "failoverPinnedUntil",
    "failoverPreferFastest",
    "failoverSeconds",
    "recoverSeconds",
    "autoFailback",
    ...ROUTE_RULE_COLUMNS,
  ]);
  return changedFields.every((field) => hotFields.has(field));
}

export function requireMainBackupAllowed(options: {
  enabled?: boolean;
  protocol?: string | null;
  forwardType?: string | null;
  tunnelId?: number | null;
  tunnelMode?: string | null;
  isTunnelRoute?: boolean;
  isPortForwardGroup?: boolean;
  isAdmin: boolean;
}) {
  if (!options.enabled) return;
  if (!routeGroupForwardTypeSupported(options.forwardType)) {
    throw new Error("线路组要用 gost、realm、socat 或 nginx 转发：iptables / nftables 在内核里改写目的地，调度器插不进去");
  }
  const isTunnelRoute = !!options.isTunnelRoute || Number(options.tunnelId || 0) > 0;
  if (isTunnelRoute && options.tunnelMode !== undefined && !isMainBackupGostTunnelMode(options.tunnelMode)) {
    throw new Error("这种隧道用不了线路组：换一条 GOST、Nginx 或 NEX 隧道就可以");
  }
  if (!options.isAdmin && !isTunnelRoute && !options.isPortForwardGroup) {
    throw new Error("普通用户的普通端口转发不支持主备线路，请使用 GOST 隧道转发或联系管理员");
  }
}

async function requireForwardAccessReady(userId: number, options?: { allowTrafficBillingRecovery?: boolean }) {
  const check = await db.ensureUserForwardAccessReady(userId, options);
  if (!check.allowed) {
    throw new Error(check.message || "转发权限已暂停，请续费后再启用规则");
  }
  return check.user || await db.getUserById(userId);
}

/**
 * 编辑之后规则是启用的、操作者又不是管理员：和开关那条路（toggleForwardRuleForActor）同一套检查。
 * 不查的话，被暂停或已到期的用户把「启用」塞进一次编辑里提交，规则就又跑起来了。
 */
async function requireForwardAccessForEnabledRule(userId: number, isTrafficBillingResource: boolean) {
  const owner = await requireForwardAccessReady(userId, { allowTrafficBillingRecovery: isTrafficBillingResource });
  if (owner?.expiresAt && new Date(owner.expiresAt) <= new Date()) {
    throw new Error("套餐已到期，请续费后再启用规则");
  }
}

/**
 * 线路组的中转要在每台中转机上占一个端口（一跳一条中继规则），这些端口算进用户的端口配额
 * （maxPorts），不算规则数。以前完全不算：一条规则最多能在别人的中转机上开出几十个监听。
 *
 * 只在这次要**多开**中继时才拦：已经超额的老规则改个名字不该被卡住。
 */
export async function assertRouteRelayPortQuota(
  actor: { id: number; role: string },
  routePaths: unknown,
  ruleId: number | null,
) {
  if (actor.role === "admin") return;
  const hopCount = parseRoutePaths(routePaths).reduce((sum, path) => sum + path.hops.length, 0);
  if (hopCount === 0) return;
  const user = await db.getUserById(actor.id);
  const maxPorts = Number((user as any)?.maxPorts || 0);
  if (maxPorts <= 0) return;
  const existing = ruleId
    ? (await db.getRouteRelayRules(ruleId) as any[]).filter((row) => !dbBool(row?.pendingDelete)).length
    : 0;
  const extra = Math.max(0, hopCount - existing);
  if (extra === 0) return;
  const used = await db.getUserPortCount(actor.id);
  const selfPort = ruleId ? 0 : 1;
  if (used + selfPort + extra > maxPorts) {
    throw new Error(`线路组的中转要在中转机上各占一个端口（这次还需要 ${extra} 个），超出了您的端口配额：已用 ${used}/${maxPorts}`);
  }
}

/**
 * 走计费资源的规则，余额不足不许启用 / 新建。
 *
 * ruleShape 传入时按上报流量时计费用的同一套规则判断（转发组 → 隧道 → 入口主机）。
 * 只看隧道本身的话，一条隧道没配计费、入口主机配了的规则会被漏掉：上报流量时它按
 * 主机计费，余额为 0 被停，用户又能随手打开，白跑一段。
 */
async function requireTrafficBillingBalanceForRule(
  userId: number,
  isTrafficBillingRule: boolean,
  message = "流量计费余额不足，请充值后再使用该计费资源",
  ruleShape?: { forwardGroupId?: number | null; tunnelId?: number | null; hostId?: number | null },
) {
  if (!isTrafficBillingRule && ruleShape && await db.getTrafficBillingEnabledForWrite()) {
    isTrafficBillingRule = !!(await db.findTrafficBillingResourceForRule({
      forwardGroupId: ruleShape.forwardGroupId ?? null,
      tunnelId: ruleShape.tunnelId ?? null,
      hostId: ruleShape.hostId ?? null,
    }));
  }
  if (!isTrafficBillingRule) return;
  const user = await db.getUserById(userId);
  if (Number((user as any)?.balanceCents || 0) <= 0) {
    throw new Error(message);
  }
}

function requireForwardTypeAllowedForActor(
  actor: { role: string; allowedForwardTypes?: string | null },
  forwardType: string,
) {
  if (actor.role === "admin") return;
  const allowedRaw = actor.allowedForwardTypes;
  if (allowedRaw === null || allowedRaw === undefined) return;
  const allowed = new Set(allowedRaw.split(",").map((value) => value.trim()).filter(Boolean));
  if (!allowed.has(forwardType)) {
    throw new Error(`您没有使用 ${forwardType} 转发方式的权限，请联系管理员`);
  }
}

async function prepareDirectRuleRouteForActor(
  actor: { id: number; role: string; allowedForwardTypes?: string | null },
  input: { forwardType: string; tunnelId?: number | null; hostId?: number | null },
) {
  requireForwardTypeAllowedForActor(actor, input.forwardType);
  if (input.tunnelId && input.forwardType !== "gost") {
    throw new Error("隧道转发必须使用已创建的隧道协议，请先创建隧道后再选择使用。");
  }
  const tunnelId = input.forwardType === "gost" ? Number(input.tunnelId || 0) || null : null;
  const actorContext = { user: actor };
  let hostId = Number(input.hostId || 0);
  let selectedTunnelForRule: any = null;
  let isTrafficBillingRule = false;
  if (tunnelId) {
    const access = await requireTunnelUseOrTrafficBillingAccess(actorContext, tunnelId);
    selectedTunnelForRule = access.tunnel;
    isTrafficBillingRule = !!access.isTrafficBillingResource;
    if (!dbBool(selectedTunnelForRule.isEnabled)) throw new Error("所选隧道已停用");
    const entryHostId = Number(selectedTunnelForRule.entryHostId || 0);
    if (hostId > 0 && hostId !== entryHostId) {
      throw new Error("所选隧道的入口 Agent 必须与规则所属主机一致");
    }
    hostId = entryHostId;
  } else {
    if (!hostId) throw new Error("请选择所属主机");
    const access = await requireHostUseAccess(actorContext, hostId);
    isTrafficBillingRule = !!access.isTrafficBillingResource;
    if (actor.role !== "admin" && !isTrafficBillingRule) {
      throw new Error("普通端口转发请先创建转发组或转发链后再新增规则。");
    }
  }

  let currentUser = await db.getUserById(actor.id);
  if (actor.role !== "admin") {
    currentUser = await requireForwardAccessReady(actor.id, { allowTrafficBillingRecovery: isTrafficBillingRule });
    await requireTrafficBillingBalanceForRule(actor.id, isTrafficBillingRule, undefined, { tunnelId, hostId });
    // 走计费隧道时权限来自余额（上面两步已确认）：套餐超额暂停期间账户 canAddRules 为 false，
    // 但计费操作仍然放行。
    if (String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx" && !(currentUser as any)?.canAddRules && !isTrafficBillingRule) {
      throw new Error("无权使用 NEX 加密隧道");
    }
    if (currentUser?.expiresAt && new Date(currentUser.expiresAt) <= new Date()) {
      throw new Error("您的账户已到期，无法添加或启用规则");
    }
  }
  return { currentUser, hostId, tunnelId, selectedTunnelForRule, isTrafficBillingRule };
}

async function forwardGroupTrafficBillingCandidates(group: any) {
  const candidates: Array<{ resourceType: "host" | "tunnel" | "forward_group"; resourceId: number; member: boolean }> = [];
  const groupId = Number((group as any).id || 0);
  if (groupId > 0) candidates.push({ resourceType: "forward_group", resourceId: groupId, member: false });
  const pending = [group];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const current = pending.shift();
    const currentId = Number(current?.id || 0);
    if (currentId <= 0 || visited.has(currentId)) continue;
    visited.add(currentId);
    const members = Array.isArray(current?.members) ? current.members : [];
    for (const member of members) {
      if (!dbBool(member?.isEnabled, true)) continue;
      const resourceType = member.memberType === "tunnel" ? "tunnel" : member.memberType === "host" ? "host" : null;
      const resourceId = resourceType === "tunnel" ? Number(member.tunnelId || 0) : resourceType === "host" ? Number(member.hostId || 0) : 0;
      if (!resourceType || resourceId <= 0) continue;
      candidates.push({ resourceType, resourceId, member: true });
    }
    const entryGroupId = Number(current?.entryGroupId || 0);
    if (entryGroupId > 0 && !visited.has(entryGroupId)) {
      const entryGroup = await db.getForwardGroupById(entryGroupId);
      if (entryGroup) pending.push(entryGroup);
    }
  }
  return Array.from(new Map(candidates.map((candidate) => [
    `${candidate.resourceType}:${candidate.resourceId}`,
    candidate,
  ])).values());
}

async function requireForwardGroupUseAccess(
  ctx: { user: { id: number; role: string } },
  forwardGroupId: number,
) {
  if (ctx.user.role === "admin") return { isTrafficBillingResource: false };
  const [group, snapshot] = await Promise.all([
    db.getForwardGroupById(forwardGroupId),
    db.getTrafficBillingAccessSnapshot(ctx.user.id),
  ]);
  if (!group) throw new Error("转发组不存在");
  if (snapshot.status === "failed") throw new Error("流量计费授权状态暂时无法确认，请稍后重试");
  let isTrafficBillingResource = false;
  let rootIsTrafficBillingResource = false;
  for (const candidate of await forwardGroupTrafficBillingCandidates(group)) {
    const state = db.trafficBillingSnapshotResourceState(snapshot, candidate.resourceType, candidate.resourceId);
    if (!state.active) continue;
    isTrafficBillingResource = true;
    if (!candidate.member) rootIsTrafficBillingResource = true;
    if (state.usable) continue;
    if (candidate.member) {
      throw new Error("转发组包含需要额外授权的流量计费成员，请联系管理员授权");
    }
    throw new Error("您没有使用该转发计费资源的权限，请联系管理员授权");
  }
  if (!rootIsTrafficBillingResource) {
    const hasPermission = await db.checkUserForwardGroupPermission(ctx.user.id, forwardGroupId);
    if (!hasPermission) throw new Error("无权使用该转发组");
  }
  return { isTrafficBillingResource };
}

async function assertRulePortWithinEntryPolicy(options: {
  hostId: number;
  sourcePort: number;
  tunnelId?: number | null;
  tunnel?: any;
  actor?: { id: number; role?: string | null };
}) {
  const port = Number(options.sourcePort || 0);
  if (!port) return;
  let policy = portPolicyFrom(null);
  let listenHost: any = null;
  if (Number(options.tunnelId || 0) > 0) {
    const tunnel = options.tunnel || await db.getTunnelById(Number(options.tunnelId));
    const entryHost = await db.getHostById(Number((tunnel as any)?.entryHostId || options.hostId));
    listenHost = entryHost;
    policy = combineHostPortPolicyWithRange(
      entryHost as any,
      (tunnel as any)?.portRangeStart,
      (tunnel as any)?.portRangeEnd,
    );
  } else {
    const host = await db.getHostById(Number(options.hostId));
    listenHost = host;
    policy = portPolicyFrom(host as any);
  }
  if (!isPortAllowedByPolicy(port, policy)) {
    throw new Error(portPolicyErrorMessage(policy, "入口端口"));
  }
  // 端口策略默认不限制，普通用户在共享主机上仍不能占系统端口/面板端口。
  if (options.actor) assertTenantListenPortAllowed({ actor: options.actor, host: listenHost, port, label: "入口端口" });
}

async function assertRulePortWithinUserPlanRange(options: {
  userId: number;
  hostId: number;
  sourcePort: number;
  tunnelId?: number | null;
}) {
  const port = Number(options.sourcePort || 0);
  if (!port) return;
  const planRange = await db.getUserPlanPortRange(
    Number(options.userId),
    Number(options.hostId),
    Number(options.tunnelId || 0) || undefined,
  );
  if (planRange && !db.isPortAllowedByUserPlanRange(port, planRange)) {
    const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
    throw new Error(`套餐端口必须在 ${ranges} 区间内`);
  }
}

async function assertForwardGroupPortWithinUserPlanRange(options: {
  userId: number;
  forwardGroupId: number;
  sourcePort: number;
}) {
  const port = Number(options.sourcePort || 0);
  if (!port) return;
  const planRange = await db.getUserForwardGroupPlanPortRange(
    Number(options.userId),
    Number(options.forwardGroupId),
  );
  if (planRange && !db.isPortAllowedByUserPlanRange(port, planRange)) {
    const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
    throw new Error(`套餐端口必须在 ${ranges} 区间内`);
  }
}

async function settleTrafficBillingForDeletedRule(rule: any) {
  const billed = await withTrafficBillingUserLock(rule.userId, async () => {
    const billingResource = await db.findTrafficBillingResourceForRule(rule);
    const fallback = db.trafficBillingResourceCandidatesForRule(rule)[0];
    const resource = billingResource || fallback;
    const result = resource
      ? await db.settleTrafficBillingRuleOnDelete({
        userId: Number(rule.userId),
        ruleId: Number(rule.id),
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
      })
      : null;
    // Keep settlement and the state transition under the same user lock so a
    // traffic report cannot create fresh unsettled usage between them.
    await db.markForwardRulePendingDelete(Number(rule.id));
    return result;
  });
  if (billed && Number(billed.balanceAfterCents) < 0) {
    const shortfall = await handleTrafficBillingShortfall(Number(rule.userId), "delete-settlement-negative");
    if (shortfall.accountPaused) await refreshUserForwardEndpoints(Number(rule.userId), "traffic-billing-delete-balance-negative");
  }
  return billed;
}

async function refreshPendingTemplateChildren(childRules: any[], reason: string) {
  const refreshedTunnelIds = new Set<number>();
  for (const child of childRules) {
    const tunnelId = Number((child as any).tunnelId || 0);
    if (tunnelId > 0 && !refreshedTunnelIds.has(tunnelId)) {
      refreshedTunnelIds.add(tunnelId);
      const tunnel = await db.getTunnelById(tunnelId);
      if (tunnel) await pushTunnelEndpointRefresh(tunnel, reason);
    }
  }
  const hostIds = Array.from(new Set(childRules
    .map((child: any) => Number(child.hostId || 0))
    .filter((hostId: number) => hostId > 0)));
  for (const hostId of hostIds) pushAgentRefresh(hostId, reason);
}

async function markTemplateChildrenPendingDelete(
  templateRuleId: number,
  reason: string,
  options: { deferRefresh?: boolean } = {},
) {
  const childRules = await db.getForwardGroupChildRulesForTemplate(templateRuleId);
  for (const child of childRules as any[]) {
    await settleTrafficBillingForDeletedRule(child);
    const tunnelId = Number((child as any).tunnelId || 0);
    if (tunnelId) {
      await db.updateTunnel(tunnelId, { isRunning: false } as any);
    }
  }
  if (!options.deferRefresh) await refreshPendingTemplateChildren(childRules as any[], reason);
  return childRules;
}

/**
 * 转发建好之后，认一认它是不是通往自己某个落地节点的 —— 是就直接进订阅。
 *
 * 订阅和转发本来就是同一件事的两面：一条转发把入口机的端口接到落地机上，订阅里
 * 那条中转线路描述的就是这件事。原来这两件事要分两处做 —— 在转发页建规则，再去
 * 订阅页的预览弹窗里把它绑到落地节点上。**不绑就不进订阅，而转发页上完全看不出
 * 少了这一步**：转发跑得好好的，客户端里却没有这条线路。
 *
 * 认的规矩全在 shared/proxyNodeAutoBind.ts 里，核心是宁可不认：地址端口要完全
 * 相同、停用的不认、认出多个一个都不认。认错的后果是订阅里那条中转指向了一台
 * 不该指的落地机，比不认严重得多。
 *
 * 失败一律吞掉：这是锦上添花的一步，不能因为它让建转发这件事整个失败。
 *
 * 保存之后还要把绑定重新对一遍。
 *
 * 绑定声明的是「这条转发通向那个落地节点」。它只在保存那一刻成立过 —— 之后目标能改，
 * 而绑定一直留着。留错了不只是少一条线路：订阅里那条节点**带着这个落地的凭据**
 * （uuid、Reality 公钥、SNI），地址却写的是转发入口；入口现在通向别处，客户端就会把
 * 这套凭据递给那台别的机器。
 *
 * 三件事：
 *
 * 1. 新建、或改了目标而这条还没绑 → 认一次（原来就有的行为）。
 * 2. 已经绑着、又改了目标 → **只在原来是字面相符时**重新对：那种绑定是面板自己认出
 *    来的，面板有责任让它继续为真。新目标正好是另一个节点就改绑，谁都不是就解绑。
 * 3. 原来就不是字面相符（串两跳、一边域名一边 IP）→ 一个字都不动。那是他自己搭的
 *    拓扑，我们没有判断权。
 */
type ProxyNodeBindingChange =
  | { kind: "bound"; id: number; name: string }
  | { kind: "rebound"; id: number; name: string; previousName: string }
  | { kind: "released"; previousName: string }
  | null;

async function autoBindProxyNodeForRule(input: {
  ruleId: number;
  userId: number;
  targetIp: unknown;
  targetPort: number;
  boundNodeId?: number;
  isCreate: boolean;
  targetChanged?: boolean;
  /** 改动之前的目标。判断「原来是不是字面相符」要用它。 */
  previousTargetIp?: unknown;
  previousTargetPort?: unknown;
}): Promise<ProxyNodeBindingChange> {
  try {
    const boundNodeId = Number(input.boundNodeId || 0);
    // 自己的 + 别人分享给自己的，都算「我的线路」。
    const candidates = await db.getProxyNodesForSubscription(Number(input.userId)) as any[];
    const nameById = new Map<number, string>(
      candidates.map((node) => [Number(node.id), String(node.name || "落地节点")]),
    );
    const bound = boundNodeId > 0
      ? candidates.find((node) => Number(node.id) === boundNodeId)
      : undefined;
    const plan = planProxyNodeBinding({
      isCreate: input.isCreate,
      targetChanged: input.targetChanged,
      boundNodeId,
      boundNodePlace: bound ? { address: bound.address, port: bound.port } : null,
      previousTarget: { targetIp: input.previousTargetIp, targetPort: input.previousTargetPort },
      nextTarget: { targetIp: input.targetIp, targetPort: input.targetPort },
      candidates: candidates.map((node) => ({
        id: Number(node.id),
        address: String(node.address || ""),
        port: Number(node.port || 0),
        isEnabled: node.isEnabled !== false,
        sharedFrom: !!node.sharedFrom,
      })),
    });
    const previousName = nameById.get(boundNodeId) || "落地节点";

    if (plan.action === "none") return null;
    if (plan.action === "release") {
      // 留着的话订阅里这条会带着原来那个落地的凭据，指向已经换掉的新目标。
      await db.updateForwardRule(Number(input.ruleId), { proxyNodeId: null } as any);
      console.info(`[Subscription] released stale binding rule=${input.ruleId} node=${boundNodeId}`);
      return { kind: "released", previousName };
    }
    await db.updateForwardRule(Number(input.ruleId), {
      proxyNodeId: plan.nodeId,
      // 自动认出来的默认就进订阅 —— 认出来却不放进去，等于什么也没做。
      proxyNodeVisible: true,
    } as any);
    const name = nameById.get(plan.nodeId) || "落地节点";
    if (plan.action === "rebind") {
      console.info(`[Subscription] rebound rule=${input.ruleId} proxy node ${boundNodeId} -> ${plan.nodeId}`);
      return { kind: "rebound", id: plan.nodeId, name, previousName };
    }
    console.info(`[Subscription] auto-bound rule=${input.ruleId} to proxy node=${plan.nodeId}`);
    return { kind: "bound", id: plan.nodeId, name };
  } catch (error) {
    console.warn("[Subscription] binding reconcile failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function deleteForwardRuleForActor(
  actor: { id: number; role: string },
  ruleId: number,
  options: { reasonPrefix?: string } = {},
) {
  return withKeyedTaskLock(`rule:${ruleId}`, async () => {
    const rule = await db.getForwardRuleById(ruleId);
    if (!rule || dbBool((rule as any).pendingDelete)) throw new Error("规则不存在或已删除");
    if (actor.role !== "admin" && rule.userId !== actor.id) throw new Error("无权操作此规则");
    if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接删除");
    if (Number((rule as any).routeParentRuleId || 0) > 0) throw new Error("线路组的中转规则由面板维护，不能直接删除");
    const reasonPrefix = String(options.reasonPrefix || "forward-rule").trim() || "forward-rule";
    let chargedCents = 0;
    let balanceAfterCents: number | null = null;
    const collectBilling = (billed: any) => {
      if (!billed) return;
      chargedCents += Math.max(0, Number(billed.amountCents || 0));
      if (Number.isFinite(Number(billed.balanceAfterCents))) balanceAfterCents = Number(billed.balanceAfterCents);
    };

    if ((rule as any).isForwardGroupTemplate) {
      const childRules = await db.getForwardGroupChildRulesForTemplate(ruleId);
      for (const child of childRules as any[]) {
        collectBilling(await settleTrafficBillingForDeletedRule(child));
        const childTunnelId = Number((child as any).tunnelId || 0);
        if (childTunnelId > 0) {
          const tunnel = await db.getTunnelById(childTunnelId);
          await db.updateTunnel(childTunnelId, { isRunning: false } as any);
          if (tunnel) await pushTunnelEndpointRefresh(tunnel, `${reasonPrefix}-group-deleted`);
        }
        pushAgentRefresh(Number(child.hostId), `${reasonPrefix}-group-deleted`);
      }
      collectBilling(await settleTrafficBillingForDeletedRule(rule));
      await db.runForwardGroupFailover(Number((rule as any).forwardGroupId || 0));
      // Templates never run on an Agent, so they cannot receive a runtime stop ACK.
      // Their managed children remain pending until each Agent confirms removal.
      await db.finalizeForwardRuleDelete(ruleId);
      return { success: true, rule, childRules, chargedCents, balanceAfterCents };
    }

    collectBilling(await settleTrafficBillingForDeletedRule(rule));
    // 线路组：中转机上的中继规则跟着走，切换记录一并清掉。
    await retireRouteRelayRulesForRule(ruleId, { reason: `${reasonPrefix}-deleted` });
    // 换隧道后留在旧入口的桥接一起删，那几台机器随即撤掉监听。
    await refreshRuleEntryBridgeHosts(ruleId, `${reasonPrefix}-deleted`, { deleteBridges: true });
    if ((rule as any).tunnelId) {
      const tunnel = await db.getTunnelById((rule as any).tunnelId);
      await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
      if (tunnel) await pushTunnelEndpointRefresh(tunnel, `${reasonPrefix}-deleted`);
    }
    pushAgentRefresh(rule.hostId, `${reasonPrefix}-deleted`);
    return { success: true, rule, childRules: [] as any[], chargedCents, balanceAfterCents };
  });
}

export async function toggleForwardRuleForActor(
  actor: { id: number; role: string },
  ruleId: number,
  isEnabled: boolean,
  options: { reasonPrefix?: string } = {},
) {
  return withKeyedTaskLock(`rule:${ruleId}`, async () => {
    let sourcePortReservation: HostPortReservation | null = null;
    let tunnelExitPortReservation: HostPortReservation | null = null;
    try {
      const rule = await db.getForwardRuleById(ruleId);
      // 待删除的规则只等 Agent 确认停掉后清理，不能再被打开。
      if (!rule || dbBool((rule as any).pendingDelete)) throw new Error("规则不存在");
      if (actor.role !== "admin" && rule.userId !== actor.id) throw new Error("无权操作此规则");
      if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接开关");
      if (Number((rule as any).routeParentRuleId || 0) > 0) throw new Error("线路组的中转规则由面板维护，不能直接开关");
      if ((rule as any).isForwardGroupTemplate) {
        if (actor.role !== "admin") {
          const groupId = Number((rule as any).forwardGroupId || 0);
          if (isEnabled) {
            if (!groupId) throw new Error("转发组不存在");
            const access = await requireForwardGroupUseAccess({ user: actor }, groupId);
            const owner = await requireForwardAccessReady(actor.id, { allowTrafficBillingRecovery: access.isTrafficBillingResource });
            await requireTrafficBillingBalanceForRule(actor.id, access.isTrafficBillingResource);
            if (owner.expiresAt && new Date(owner.expiresAt) <= new Date()) {
              throw new Error("套餐已到期，请续费后再启用规则");
            }
            await assertForwardGroupPortWithinUserPlanRange({
              userId: actor.id,
              forwardGroupId: groupId,
              sourcePort: Number(rule.sourcePort),
            });
            await assertTenantListenPortAllowedOnHosts({
              actor,
              hostIds: await db.getForwardGroupRuleEntryHostIds(groupId),
              port: Number(rule.sourcePort),
              label: "入口端口",
            });
          }
        }
        if (isEnabled) {
          const groupId = Number((rule as any).forwardGroupId || 0);
          const group = await db.validateForwardGroupRuleConfig(groupId, {
            sourcePort: rule.sourcePort,
            protocol: (rule as any).protocol,
            excludeTemplateRuleId: rule.id,
          });
          const isForwardChain = (group as any).groupMode === "chain";
          const isPortGroup = (group as any).groupMode === "port";
          const groupIsTunnel = !isForwardChain && (group as any).groupType === "tunnel";
          const groupTunnelSupportsFailover = groupIsTunnel ? await forwardGroupTunnelMembersSupportMainBackup(group) : true;
          requireMainBackupAllowed({
            enabled: isForwardChain || (groupIsTunnel && !groupTunnelSupportsFailover) ? false : (rule as any).failoverEnabled,
            protocol: (rule as any).protocol,
            forwardType: !isForwardChain && (group as any).groupType === "tunnel" ? "gost" : (rule as any).forwardType,
            isTunnelRoute: groupIsTunnel,
            isPortForwardGroup: isPortGroup,
            isAdmin: actor.role === "admin",
          });
          await db.updateForwardRule(ruleId, { isEnabled: true, isRunning: false, disabledByUser: false, disabledByTunnel: false, disabledByGroup: false, protocolBlockReason: null } as any);
        } else {
          await db.toggleForwardRule(ruleId, false);
        }
        await db.syncForwardGroupRules(Number((rule as any).forwardGroupId));
        await db.runForwardGroupFailover(Number((rule as any).forwardGroupId));
        return { success: true, rule };
      }

      await requireRuleProtocolEnabled(rule);
      let toggleTunnelForRule: any = null;
      const reasonPrefix = String(options.reasonPrefix || "forward-rule").trim() || "forward-rule";
      if ((rule as any).tunnelId) {
        toggleTunnelForRule = await db.getTunnelById((rule as any).tunnelId);
        await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
      }
      if (isEnabled) {
        requireMainBackupAllowed({
          enabled: (rule as any).failoverEnabled,
          protocol: (rule as any).protocol,
          forwardType: (rule as any).forwardType,
          tunnelId: (rule as any).tunnelId,
          tunnelMode: toggleTunnelForRule?.mode,
          isAdmin: actor.role === "admin",
        });
        // 共享 TLS 入站上的规则：sourcePort 是本机回环端口，不受对外端口策略管；换成入站自己的检查。
        const sniInbound = isSniRule(rule) ? await db.getTlsInboundById(Number((rule as any).tlsInboundId)) : null;
        if (isSniRule(rule)) {
          if (!sniInbound) throw new Error("这条规则挂的共享 TLS 入站已不存在，请编辑规则换一个入站");
          await requireTlsInboundRunnable(sniInbound);
        } else {
          await assertRulePortWithinEntryPolicy({
            hostId: Number(rule.hostId),
            sourcePort: Number(rule.sourcePort),
            tunnelId: Number((rule as any).tunnelId || 0) || null,
            actor,
          });
        }
        if (actor.role !== "admin") {
          if (!isSniRule(rule)) {
            await assertRulePortWithinUserPlanRange({
              userId: actor.id,
              hostId: Number(rule.hostId),
              sourcePort: Number(rule.sourcePort),
              tunnelId: Number((rule as any).tunnelId || 0) || null,
            });
          }
          const activeTunnelId = Number((rule as any).tunnelId || 0);
          const actorContext = { user: actor };
          const resourceAccess = activeTunnelId
            ? await requireTunnelUseOrTrafficBillingAccess(actorContext, activeTunnelId)
            : isSniRule(rule)
            ? await requireTlsInboundHostAccess(actor, Number(rule.hostId))
            : await requireHostUseAccess(actorContext, rule.hostId);
          const owner = await requireForwardAccessReady(actor.id, { allowTrafficBillingRecovery: !!resourceAccess.isTrafficBillingResource });
          await requireTrafficBillingBalanceForRule(actor.id, !!resourceAccess.isTrafficBillingResource, undefined, {
            tunnelId: activeTunnelId || null,
            hostId: Number(rule.hostId),
          });
          if (owner.expiresAt && new Date(owner.expiresAt) <= new Date()) {
            throw new Error("套餐已到期，请续费后再启用规则");
          }
        }
        // 隧道挂了入口组时，组里每台主机也在这个端口上监听，都要查、都要占住。
        sourcePortReservation = await reserveSpecificHostPortOnHosts({
          hostIds: await db.forwardRuleListenHostIds(rule.hostId, (rule as any).tunnelId),
          port: Number(rule.sourcePort),
          protocol: (rule as any).protocol,
          isUsed: (hostId, port) => db.isPortUsedOnHost(hostId, port, Number(rule.id), (rule as any).protocol, undefined, false),
        });
        if (!sourcePortReservation) {
          throw await entryBridgeAwarePortError(
            await db.forwardRuleListenHostIds(rule.hostId, (rule as any).tunnelId),
            Number(rule.sourcePort),
            [Number(rule.id)],
            `端口 ${rule.sourcePort} 已被占用，请更换端口后再启用`,
          );
        }
        // 出口端口同理：停用期间它不算占用，可能已被别的规则/隧道拿走。重新预留一次，
        // 端口变了就写回（和 rules.update 的启用路径一致）。
        let nextTunnelExitPort: number | null = null;
        if (toggleTunnelForRule) {
          const exit = await db.getHostById(Number(toggleTunnelForRule.exitHostId)) as any;
          const listenerRepair = usesSharedTunnelPrimaryListener(toggleTunnelForRule)
            ? await ensureTunnelListenerPortPolicy(toggleTunnelForRule, {
              hostId: Number(toggleTunnelForRule.exitHostId),
              syncSharedPrimaryRule: true,
            })
            : null;
          if (usesSharedTunnelPrimaryListener(toggleTunnelForRule) && !listenerRepair) {
            throw new Error("出口 Agent 已无可用隧道监听端口");
          }
          const sharedListenPort = await preferredSharedTunnelListenPort(toggleTunnelForRule, Number(rule.id), true);
          if (listenerRepair?.reservation && Number(sharedListenPort || 0) === listenerRepair.port) {
            tunnelExitPortReservation = listenerRepair.reservation;
          } else {
            listenerRepair?.reservation.release();
          }
          if (!tunnelExitPortReservation) {
            tunnelExitPortReservation = await reserveTunnelExitPort({
              hostId: Number(toggleTunnelForRule.exitHostId),
              preferredStart: exit?.portRangeStart,
              preferredEnd: exit?.portRangeEnd,
              currentPort: sharedListenPort ?? Number((rule as any).tunnelExitPort || 0),
              excludeRuleIds: [Number(rule.id)],
              allowSameTunnelListener: Number(sharedListenPort || 0) > 0,
              excludeTunnelId: Number(toggleTunnelForRule.id),
              protocol: "both",
            });
          }
          if (!tunnelExitPortReservation) throw new Error("出口 Agent 已无可用隧道端口");
          nextTunnelExitPort = tunnelExitPortReservation.port;
        }
        await db.updateForwardRule(ruleId, {
          isEnabled: true,
          isRunning: false,
          disabledByUser: false,
          disabledByTunnel: false,
          disabledByGroup: false,
          protocolBlockReason: null,
          ...(nextTunnelExitPort && nextTunnelExitPort !== Number((rule as any).tunnelExitPort || 0) ? { tunnelExitPort: nextTunnelExitPort } : {}),
        } as any);
        if (toggleTunnelForRule && String((rule as any).forwardType || "") === "gost") {
          // 映射校正自己按出口逐个预留；主端口的预留先放掉，免得同端口的映射被当成别人在用。
          tunnelExitPortReservation?.release();
          tunnelExitPortReservation = null;
          await db.reconcileForwardRuleTunnelExits(
            { ...rule, isEnabled: true, tunnelExitPort: nextTunnelExitPort ?? (rule as any).tunnelExitPort },
            toggleTunnelForRule,
          );
        }
      } else {
        await db.toggleForwardRule(ruleId, false);
      }
      // 写库之后再通知隧道各端：先推的话 Agent 可能拉到开关之前的配置。
      if (toggleTunnelForRule) await pushTunnelEndpointRefresh(toggleTunnelForRule, `${reasonPrefix}-toggled`);
      pushAgentRefresh(Number(rule.hostId), `${reasonPrefix}-${isEnabled ? "enabled" : "disabled"}`);
      // 换隧道后留在旧入口的桥接跟着规则开关：停用时撤、启用时（没到期的话）接着转。
      await refreshRuleEntryBridgeHosts(ruleId, `${reasonPrefix}-${isEnabled ? "enabled" : "disabled"}`);
      // 中转机上的中继规则跟着入口这条开关。
      await syncRouteGroupAfterSave(ruleId, `${reasonPrefix}-${isEnabled ? "enabled" : "disabled"}`);
      return { success: true, rule };
    } finally {
      sourcePortReservation?.release();
      tunnelExitPortReservation?.release();
    }
  });
}

export async function createDirectForwardRuleForActor(
  actor: { id: number; role: string; allowedForwardTypes?: string | null },
  input: any,
  options: { reasonPrefix?: string; egress?: RuleEgressInput } = {},
) {
  await requireRuleTelegramNotifyReady(!!input.telegramErrorNotifyEnabled);
  // 出口字段不能跟着入参一起展开进规则行（外部链接要先解析加密）。没走 tRPC 的调用方传进来的也一并摘掉。
  input = { ...input };
  const strippedEgress = takeEgressInput(input);
  const egressInput: RuleEgressInput = options.egress || strippedEgress;
  /*
    名字留空就替用户起一个。

    放在这个 helper 里而不是 tRPC 那一层，是因为它是导出的：面板的创建走它，
    Telegram 机器人建规则也走它。搁在调用方就得每个调用方各补一遍，漏一个
    就会写进一条空名字的规则 —— 这正是第一版犯的错（当时只改了转发组那条路，
    隧道那条照样落库空名，toast 还报成功）。
  */
  input = { ...input, name: resolveForwardRuleName(input.name, input) };
  const {
    currentUser,
    hostId,
    tunnelId,
    selectedTunnelForRule,
    isTrafficBillingRule,
  } = await prepareDirectRuleRouteForActor(actor, input);
  requireMainBackupAllowed({
    enabled: input.failoverEnabled,
    protocol: input.protocol,
    forwardType: input.forwardType,
    tunnelId,
    tunnelMode: selectedTunnelForRule?.mode,
    isAdmin: actor.role === "admin",
  });
  await requireRuleProtocolEnabled({ forwardType: input.forwardType, tunnelId }, selectedTunnelForRule);
  const egressColumns = egressRequested(egressInput)
    ? await resolveRuleEgressColumns(egressInput, {
      actor,
      entryHostIds: [hostId],
      forwardType: String(input.forwardType || ""),
      protocol: String(input.protocol || "both"),
      tunnelId,
      failoverEnabled: !!input.failoverEnabled,
      targetIp: input.targetIp,
    })
    : null;
  if (!isTrafficBillingRule && Number((currentUser as any)?.trafficLimit || 0) > 0 && Number((currentUser as any)?.trafficUsed || 0) >= Number((currentUser as any)?.trafficLimit || 0)) {
    throw new Error("您的流量已用完，无法添加规则");
  }
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  const entryPolicy = selectedTunnelForRule
    ? combineHostPortPolicyWithRange(
      host as any,
      (selectedTunnelForRule as any).portRangeStart,
      (selectedTunnelForRule as any).portRangeEnd,
    )
    : portPolicyFrom(host as any);
  const planRange = actor.role !== "admin"
    ? await db.getUserPlanPortRange(actor.id, hostId, tunnelId ?? undefined)
    : null;
  const effectivePolicy = planRange
    ? combinePortPolicies(entryPolicy, portPolicyFrom({
      portRanges: planRange.ranges,
    }))
    : entryPolicy;

  let sourcePort = Number(input.sourcePort || 0);
  let sourcePortReservation: HostPortReservation | null = null;
  let tunnelExitPortReservation: HostPortReservation | null = null;
  let quotaReservation: RuleQuotaReservation | null = null;
  // 规则在哪些主机上监听：隧道挂了入口组时，除了入口机还有组里每台启用的主机。
  const listenHostIds = tunnelId ? await db.tunnelRuleListenHostIds(selectedTunnelForRule, hostId) : [hostId];
  try {
    if (sourcePort === 0) {
      let randomRangeStart = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeStart : null;
      let randomRangeEnd = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeEnd : null;
      sourcePortReservation = await reserveAvailableHostPortOnHosts({
        hostIds: listenHostIds,
        protocol: input.protocol,
        // 挑的端口要在每台监听主机上都空着：把其他主机上已占用的端口一并排除。
        findPort: async (reservedPorts) => db.findAvailablePort(
          hostId,
          randomRangeStart,
          randomRangeEnd,
          input.protocol,
          [...reservedPorts, ...await db.usedPortsOnOtherListenHosts(hostId, listenHostIds, [], input.protocol)],
          [],
          planRange?.ranges || [],
        ),
        isUsed: (listenHostId, port) => db.isPortUsedOnHost(listenHostId, port, undefined, input.protocol),
      });
      if (!sourcePortReservation) throw new Error("该主机端口区间内已无可用端口");
      sourcePort = sourcePortReservation.port;
    } else {
      if (!isPortAllowedByPolicy(sourcePort, effectivePolicy)) throw new Error(portPolicyErrorMessage(effectivePolicy, "源端口"));
      assertTenantListenPortAllowed({ actor, host, port: sourcePort, label: "源端口" });
      sourcePortReservation = tryReserveHostPort(hostId, sourcePort, input.protocol);
      if (!sourcePortReservation) throw new Error(`端口 ${sourcePort} 正在被其他请求分配，请稍后重试`);
      const used = await db.isPortUsedOnHost(hostId, sourcePort, undefined, input.protocol);
      if (used) {
        sourcePortReservation.release();
        sourcePortReservation = null;
        throw await entryBridgeAwarePortError([hostId], sourcePort, [], `端口 ${sourcePort} 已被其他规则占用`);
      }
      const otherListenHostIds = listenHostIds.filter((listenHostId) => listenHostId !== hostId);
      if (otherListenHostIds.length > 0) {
        const groupReservation = await reserveSpecificHostPortOnHosts({
          hostIds: otherListenHostIds,
          port: sourcePort,
          protocol: input.protocol,
          isUsed: (listenHostId, port) => db.isPortUsedOnHost(listenHostId, port, undefined, input.protocol),
        });
        if (!groupReservation) {
          sourcePortReservation.release();
          sourcePortReservation = null;
          throw await entryBridgeAwarePortError(otherListenHostIds, sourcePort, [], `端口 ${sourcePort} 已被隧道入口组内其他主机上的规则占用或正在分配`);
        }
        sourcePortReservation = combineHostPortReservations([sourcePortReservation, groupReservation]);
      }
    }

    quotaReservation = await reserveRuleCreateQuota({
      userId: actor.id,
      maxRules: Number(currentUser?.maxRules || 0),
      maxPorts: Number(currentUser?.maxPorts || 0),
      getRuleCount: () => db.getUserRuleCount(actor.id),
      getPortCount: () => db.getUserPortCount(actor.id),
    });
    let tunnelExitPort: number | null = null;
    assertNoDirectSelfForwardLoop({ host, sourcePort, targetIp: input.targetIp, targetPort: input.targetPort, tunnelId });
    if (tunnelId) {
      const tunnel = selectedTunnelForRule;
      if (!dbBool(tunnel.isEnabled)) throw new Error("所选隧道已停用");
      if (Number(tunnel.entryHostId) !== hostId) throw new Error("所选隧道的入口 Agent 必须与规则所属主机一致");
      const exit = await db.getHostById(tunnel.exitHostId);
      // The primary managed GOST rule must point at the same listener that the
      // tunnel service binds. Legacy rows may contain a high/unrestricted port
      // after a NAT range was introduced; repair the tunnel first rather than
      // merely assigning a new bookkeeping port to the rule.
      const listenerRepair = usesSharedTunnelPrimaryListener(tunnel)
        ? await ensureTunnelListenerPortPolicy(tunnel, {
          hostId: Number(tunnel.exitHostId),
          syncSharedPrimaryRule: true,
        })
        : null;
      if (usesSharedTunnelPrimaryListener(tunnel) && !listenerRepair) {
        throw new Error("出口 Agent 已无可用隧道监听端口");
      }
      const sharedListenPort = await preferredSharedTunnelListenPort(tunnel, 0, input.isEnabled !== false);
      // Reuse the reservation acquired while repairing the listener when this
      // new rule is the shared primary. Secondary rules must release it and
      // allocate an independent exit port.
      if (listenerRepair?.reservation && Number(sharedListenPort || 0) === listenerRepair.port) {
        tunnelExitPortReservation = listenerRepair.reservation;
      } else {
        listenerRepair?.reservation.release();
      }
      if (!tunnelExitPortReservation) {
        tunnelExitPortReservation = await reserveTunnelExitPort({
          hostId: Number(tunnel.exitHostId),
          preferredStart: (exit as any)?.portRangeStart,
          preferredEnd: (exit as any)?.portRangeEnd,
          currentPort: sharedListenPort,
          // The configured nginx listener belongs to this tunnel and may be
          // reused by its primary rule; other resources remain conflicts.
          allowSameTunnelListener: Number(sharedListenPort || 0) > 0,
          excludeTunnelId: Number(tunnel.id),
          protocol: "both",
        });
      }
      if (!tunnelExitPortReservation) throw new Error("出口 Agent 已无可用隧道端口");
      tunnelExitPort = tunnelExitPortReservation.port;
    }
    const runtimeOptionInput = tunnelId ? tunnelRuntimeOptionInput(selectedTunnelForRule) : input;
    const proxyProtocol = normalizeProxyProtocolInput(runtimeOptionInput, input.protocol, input.forwardType, false, { tunnelRoute: !!tunnelId, clearUnsupported: !!tunnelId });
    const transportTuning = normalizeTransportTuningInput(runtimeOptionInput, input.protocol, input.forwardType, false, { tunnelRoute: !!tunnelId, forwardxTunnel: String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx", clearUnsupported: !!tunnelId });
    const failoverColumns = normalizeFailoverInput(input, input.protocol, {
      entryHostId: routeEntryHostId(hostId, selectedTunnelForRule),
      hostIds: await routeHostIdsForActor(actor),
      targetIp: input.targetIp,
      targetPort: input.targetPort,
    });
    await assertRuleTargetsAllowedForActor(actor, { targetIp: input.targetIp, ...failoverColumns }, { hostId, tunnel: selectedTunnelForRule });
    await assertRouteRelayPortQuota(actor, failoverColumns.routePaths, null);
    const { routeGroup: _routeGroupInput, ...ruleInput } = input;
    const id = await db.createForwardRule({
      ...ruleInput,
      ...failoverColumns,
      ...proxyProtocol,
      ...transportTuning,
      telegramErrorNotifyEnabled: !!input.telegramErrorNotifyEnabled,
      ...RULE_PROTOCOL_BLOCK_COLUMNS,
      sourcePort,
      hostId,
      targetIp: normalizeRuleTargetIp(input.targetIp, { tunnelId }),
      gostMode: "direct",
      gostRelayHost: null,
      gostRelayPort: null,
      tunnelId,
      tunnelExitPort,
      ...(egressColumns || {}),
      userId: actor.id,
    });
    await quotaReservation.release();
    quotaReservation = null;
    // 走 Shadowsocks 出口的规则不自动绑订阅（目标不是落地节点本身）。
    const autoBound = egressColumns && egressColumns.egressType !== "none" ? null : await autoBindProxyNodeForRule({
      ruleId: Number(id),
      userId: actor.id,
      targetIp: input.targetIp,
      targetPort: Number(input.targetPort),
      boundNodeId: Number((input as any).proxyNodeId || 0),
      isCreate: true,
    });
    if (tunnelId) {
      const tunnel = await db.getTunnelById(tunnelId);
      // Mapping reconciliation has its own reservation scope. Release the
      // primary allocation after the rule row exists so a same-port mapping
      // is not mistaken for an unrelated in-flight allocation.
      tunnelExitPortReservation?.release();
      tunnelExitPortReservation = null;
      if (tunnel) await db.reconcileForwardRuleTunnelExits({ ...input, id, hostId, tunnelExitPort, sourcePort, tunnelId }, tunnel);
      await db.updateTunnel(tunnelId, { isRunning: false } as any);
      if (tunnel) await pushTunnelEndpointRefresh(tunnel, `${options.reasonPrefix || "forward-rule"}-created`);
    } else {
      pushAgentRefresh(hostId, `${options.reasonPrefix || "forward-rule"}-created`);
    }
    await syncRouteGroupAfterSave(Number(id), `${options.reasonPrefix || "forward-rule"}-created`);
    /**
     * 自动加进订阅这件事要说出来。
     *
     * 面板替人做了一步，就得让他知道做了什么 —— 否则下次他在客户端里看到一条
     * 没印象的线路，只会以为是别的地方出了错。名字一并带回去，界面直接报出来。
     */
    return {
      id,
      sourcePort,
      autoBoundProxyNodeId: autoBound?.kind === "bound" ? autoBound.id : null,
      autoBoundProxyNodeName: autoBound?.kind === "bound" ? autoBound.name : null,
    };
  } finally {
    await quotaReservation?.release();
    tunnelExitPortReservation?.release();
    sourcePortReservation?.release();
  }
}

/*
  ── 共享 TLS 入站（SNI 分流）上的规则 ─────────────────────────────────────

  这类规则没有自己的对外端口：客户端连的是入站端口（通常 443），Agent 按 SNI 把连接交给
  规则。规则行的 sourcePort 是面板在这台主机上分的回环端口（见 server/tlsInbounds.ts 开头
  的说明），所以端口策略、套餐端口段这些「对外端口」的限制都不适用，换成入站自己的检查：
  入站启用着、Agent 版本够、名字在白名单里、名字没被别人占。

  走自己的一条路，不混进下面那一千多行的通用分支：入口方式定了就不能互相切换（要换就新建），
  能改的只有名字、目标、转发工具、SNI 和同一台主机上的另一个入站。
*/
const sniNamesInputSchema = z.union([z.string().max(20000), z.array(z.string().max(300)).max(256)]);

function sniRuleProxyProtocolColumns(input: { proxyProtocolSend?: boolean; proxyProtocolVersion?: number }, forwardType: string) {
  // 入站把客户端的真实地址用 PROXY 头交给规则（见心跳那边 SNI 规则的视图），规则自己只需要「往目标发」。
  const proxyProtocol = normalizeProxyProtocolInput(
    { proxyProtocolSend: input.proxyProtocolSend, proxyProtocolVersion: input.proxyProtocolVersion },
    "tcp",
    forwardType,
    false,
  );
  return { ...proxyProtocol, proxyProtocolReceive: false, proxyProtocolExitReceive: false, proxyProtocolExitSend: false };
}

function assertSniRuleForwardType(forwardType: string) {
  if (!(SNI_RULE_FORWARD_TYPES as readonly string[]).includes(forwardType)) {
    throw new Error(`共享 TLS 入站规则不支持转发工具 ${forwardType}`);
  }
}

async function requireSniRuleOwnerReady(
  actor: { id: number; role: string },
  hostId: number,
  isTrafficBillingRule: boolean,
) {
  if (actor.role === "admin") return db.getUserById(actor.id);
  const currentUser = await requireForwardAccessReady(actor.id, { allowTrafficBillingRecovery: isTrafficBillingRule });
  await requireTrafficBillingBalanceForRule(actor.id, isTrafficBillingRule, undefined, { tunnelId: null, hostId });
  if (currentUser?.expiresAt && new Date(currentUser.expiresAt) <= new Date()) {
    throw new Error("您的账户已到期，无法添加或启用规则");
  }
  return currentUser;
}

export async function createSniForwardRuleForActor(
  actor: { id: number; role: string; allowedForwardTypes?: string | null },
  input: any,
  options: { reasonPrefix?: string } = {},
) {
  await requireRuleTelegramNotifyReady(!!input.telegramErrorNotifyEnabled);
  if (Number(input.tunnelId || 0) > 0 || Number(input.forwardGroupId || 0) > 0) {
    throw new Error("共享 TLS 入站规则不能同时使用隧道或转发组");
  }
  if (input.failoverEnabled) throw new Error("共享 TLS 入站规则暂不支持主备线路 / 线路组");
  const inbound = await db.getTlsInboundById(Number(input.tlsInboundId));
  if (!inbound) throw new Error("共享 TLS 入站不存在");
  const hostId = inbound.hostId;
  const forwardType = String(input.forwardType || "iptables");
  assertSniRuleForwardType(forwardType);
  requireForwardTypeAllowedForActor(actor, forwardType);
  const access = await requireTlsInboundHostAccess(actor, hostId);
  const host = await requireTlsInboundRunnable(inbound);
  await requireRuleProtocolEnabled({ forwardType, tunnelId: null });
  const currentUser = await requireSniRuleOwnerReady(actor, hostId, !!access.isTrafficBillingResource);
  if (actor.role !== "admin" && !access.isTrafficBillingResource
    && Number((currentUser as any)?.trafficLimit || 0) > 0
    && Number((currentUser as any)?.trafficUsed || 0) >= Number((currentUser as any)?.trafficLimit || 0)) {
    throw new Error("您的流量已用完，无法添加规则");
  }
  const names = await validateSniRuleNames({ inbound, names: input.sniNames });
  await assertRuleTargetsAllowedForActor(actor, { targetIp: input.targetIp }, { hostId, tunnel: null });
  assertSniRuleTargetNotLoop({ host, inboundPort: inbound.port, targetIp: input.targetIp, targetPort: Number(input.targetPort) });
  const name = resolveForwardRuleName(input.name, { targetIp: input.targetIp, targetPort: input.targetPort });

  let quotaReservation: RuleQuotaReservation | null = null;
  let backendReservation: HostPortReservation | null = null;
  try {
    if (actor.role !== "admin") {
      quotaReservation = await reserveRuleCreateQuota({
        userId: actor.id,
        maxRules: Number(currentUser?.maxRules || 0),
        // 不占对外端口，端口额度不算它（getUserPortCount 也把它排除了）。
        maxPorts: 0,
        getRuleCount: () => db.getUserRuleCount(actor.id),
        getPortCount: () => db.getUserPortCount(actor.id),
      });
    }
    backendReservation = await reserveSniBackendPort(hostId);
    if (!backendReservation) throw new Error("这台主机上已无可分配的内部端口");
    const sourcePort = backendReservation.port;
    const id = await db.withDatabaseTransaction(async () => {
      const createdId = await db.createForwardRule({
        hostId,
        name,
        forwardType,
        protocol: "tcp",
        gostMode: "direct",
        gostRelayHost: null,
        gostRelayPort: null,
        tunnelId: null,
        tunnelExitPort: null,
        forwardGroupId: null,
        sourcePort,
        targetIp: normalizeRuleTargetIp(input.targetIp, { tunnelId: null }),
        targetPort: Number(input.targetPort),
        isEnabled: input.isEnabled !== false,
        telegramErrorNotifyEnabled: !!input.telegramErrorNotifyEnabled,
        // 专属域名指向的是主机地址，SNI 规则的入口是用户自己的域名，用不上。
        entryDomainEnabled: false,
        ...RULE_PROTOCOL_BLOCK_COLUMNS,
        ...sniRuleProxyProtocolColumns(input, forwardType),
        tcpFastOpen: false,
        zeroCopy: false,
        udpOverTcp: false,
        udpOverTcpPort: null,
        failoverEnabled: false,
        tlsInboundId: inbound.id,
        sniNames: JSON.stringify(names),
        userId: actor.id,
      } as any);
      await db.replaceRuleSniNames(Number(createdId), inbound.id, names);
      return Number(createdId);
    });
    await quotaReservation?.release();
    quotaReservation = null;
    pushAgentRefresh(hostId, `${options.reasonPrefix || "forward-rule"}-sni-created`);
    return { id, sourcePort: 0, tlsInboundId: inbound.id, sniNames: names, autoBoundProxyNodeId: null, autoBoundProxyNodeName: null };
  } finally {
    await quotaReservation?.release();
    backendReservation?.release();
  }
}

export async function updateSniForwardRuleForActor(
  actor: { id: number; role: string; allowedForwardTypes?: string | null },
  rule: any,
  input: any,
) {
  if (Number(input.tunnelId || 0) > 0 || Number(input.forwardGroupId || 0) > 0 || input.tlsInboundId === null) {
    throw new Error("共享 TLS 入站规则不能改成其他入口方式，如需更换请新建规则");
  }
  if (input.hostId !== undefined && input.hostId !== null && Number(input.hostId) !== Number(rule.hostId)) {
    throw new Error("共享 TLS 入站规则不能换主机，如需更换请新建规则");
  }
  if (input.failoverEnabled) throw new Error("共享 TLS 入站规则暂不支持主备线路 / 线路组");
  await requireRuleTelegramNotifyReady(input.telegramErrorNotifyEnabled);
  const nextInboundId = Number(input.tlsInboundId || rule.tlsInboundId);
  const inbound = await db.getTlsInboundById(nextInboundId);
  if (!inbound) throw new Error("共享 TLS 入站不存在");
  if (inbound.hostId !== Number(rule.hostId)) {
    throw new Error("只能换到同一台主机上的另一个共享 TLS 入站，如需更换主机请新建规则");
  }
  const inboundChanged = inbound.id !== Number(rule.tlsInboundId);
  const forwardType = String(input.forwardType ?? rule.forwardType);
  assertSniRuleForwardType(forwardType);
  if (forwardType !== rule.forwardType) requireForwardTypeAllowedForActor(actor, forwardType);
  const access = await requireTlsInboundHostAccess(actor, inbound.hostId);
  const nextEnabled = input.isEnabled === undefined ? dbBool(rule.isEnabled) : input.isEnabled === true;
  if (inboundChanged || (nextEnabled && !dbBool(rule.isEnabled))) await requireTlsInboundRunnable(inbound);
  if (nextEnabled && !dbBool(rule.isEnabled)) await requireSniRuleOwnerReady(actor, inbound.hostId, !!access.isTrafficBillingResource);
  if (forwardType !== rule.forwardType) await requireRuleProtocolEnabled({ forwardType, tunnelId: null });
  const names = input.sniNames !== undefined || inboundChanged
    ? await validateSniRuleNames({
      inbound,
      names: input.sniNames !== undefined ? input.sniNames : parseSniNameJson(rule.sniNames),
      excludeRuleId: Number(rule.id),
    })
    : parseSniNameJson(rule.sniNames);
  const targetIp = input.targetIp !== undefined ? normalizeRuleTargetIp(input.targetIp, { tunnelId: null }) : rule.targetIp;
  const targetPort = Number(input.targetPort ?? rule.targetPort);
  await assertRuleTargetsAllowedForActor(actor, { targetIp }, { hostId: inbound.hostId, tunnel: null });
  const host = await db.getHostById(inbound.hostId);
  assertSniRuleTargetNotLoop({ host, inboundPort: inbound.port, backendPort: Number(rule.sourcePort), targetIp, targetPort });

  const data: Record<string, unknown> = {
    forwardType,
    protocol: "tcp",
    targetIp,
    targetPort,
    tlsInboundId: inbound.id,
    sniNames: JSON.stringify(names),
    ...sniRuleProxyProtocolColumns({
      proxyProtocolSend: input.proxyProtocolSend ?? dbBool(rule.proxyProtocolSend),
      proxyProtocolVersion: input.proxyProtocolVersion ?? Number(rule.proxyProtocolVersion || 1),
    }, forwardType),
  };
  if (input.name !== undefined) data.name = resolveForwardRuleName(input.name, { targetIp, targetPort });
  if (input.telegramErrorNotifyEnabled !== undefined) data.telegramErrorNotifyEnabled = !!input.telegramErrorNotifyEnabled;
  if (input.isEnabled !== undefined && nextEnabled !== dbBool(rule.isEnabled)) {
    data.isEnabled = nextEnabled;
    data.disabledByUser = !nextEnabled;
    if (nextEnabled) {
      data.disabledByTunnel = false;
      data.disabledByGroup = false;
      data.protocolBlockReason = null;
    }
  }
  const runtimeChanged = ["forwardType", "protocol", "targetIp", "targetPort", "proxyProtocolSend", "proxyProtocolVersion", "isEnabled"]
    .some((field) => data[field] !== undefined && !sameStoredValue(data[field], rule[field]));
  const routingChanged = inboundChanged || JSON.stringify(names) !== JSON.stringify(parseSniNameJson(rule.sniNames));
  if (runtimeChanged) data.isRunning = false;
  await db.withDatabaseTransaction(async () => {
    await db.updateForwardRule(Number(rule.id), data as any);
    await db.replaceRuleSniNames(Number(rule.id), inbound.id, names);
  });
  if (runtimeChanged || routingChanged) pushAgentRefresh(Number(rule.hostId), "forward-rule-sni-updated");
  return { success: true, reset: runtimeChanged, hotUpdated: !runtimeChanged && routingChanged, proxyNodeBinding: null };
}

/*
  ── Shadowsocks 出口（shared/ssEgress.ts、server/ssEgress.ts）───────────────

  出口只改「入口机怎么去连目标」：gost 不直拨目标，而是经一跳 ss 节点让落地去连。所以它只挂在
  gost 的直连规则、以及端口转发资源（gost）的规则上；规则的其余部分（端口、计数、限速、权限）
  走原来的流程不变。这里的几样东西是把出口这一小块从入参里拿出来、单独校验、单独落库。
*/
const egressInputShape = {
  egressType: z.enum(RULE_EGRESS_TYPES).optional(),
  egressInboundId: z.number().int().positive().nullable().optional(),
  /** 外部 ss:// 链接原文。编辑时不改链接就不传（或原样传回界面上打码的那条）。 */
  egressLink: z.string().max(4096).nullable().optional(),
  egressUdp: z.boolean().optional(),
};

/** 把出口那几项从入参对象上摘下来（原来的流程会把入参整个展开进 createForwardRule）。 */
function takeEgressInput(input: Record<string, any>): RuleEgressInput {
  const egress: RuleEgressInput = {
    egressType: input.egressType,
    egressInboundId: input.egressInboundId,
    egressLink: input.egressLink,
    egressUdp: input.egressUdp,
  };
  delete input.egressType;
  delete input.egressInboundId;
  delete input.egressLink;
  delete input.egressUdp;
  return egress;
}

function egressRequested(egress: RuleEgressInput) {
  return egress.egressType !== undefined && egress.egressType !== "none";
}

type RuleEgressUpdatePlan = { columns: RuleEgressColumns };

/**
 * 编辑规则时出口那一块：按保存后的形态（转发工具、协议、隧道、转发组、线路组）先校验，
 * 主流程成功之后再落库（applyRuleEgressUpdate）。没碰出口、规则也没出口时回 null。
 * 没碰出口但规则带着出口时，只查形态：改成 realm / 挂上隧道之类会让出口失效的改动要拦下来。
 */
async function planRuleEgressUpdate(actor: { id: number; role: string }, input: any, egress: RuleEgressInput): Promise<RuleEgressUpdatePlan | null> {
  const rule = await db.getForwardRuleById(Number(input.id)) as any;
  if (!rule) return null;
  const touched = hasEgressInput(egress);
  if (!touched && !ruleHasEgress(rule)) return null;
  if (isSniRule(rule) || input.tlsInboundId) {
    if (egressRequested(egress)) throw new Error("共享 TLS 入站上的规则不能使用 Shadowsocks 出口");
    return null;
  }
  const forwardGroupId = input.forwardGroupId !== undefined ? Number(input.forwardGroupId || 0) : Number(rule.forwardGroupId || 0);
  const group = forwardGroupId > 0 ? await db.getForwardGroupById(forwardGroupId) as any : null;
  const groupMode = group ? forwardGroupModeOf(group) : null;
  const requestedForwardType = String(input.forwardType ?? rule.forwardType);
  const forwardType = group ? lockedForwardTypeForGroup(group, requestedForwardType) : requestedForwardType;
  const tunnelId = forwardType === "gost" ? Number(input.tunnelId !== undefined ? input.tunnelId : rule.tunnelId) || null : null;
  const protocol = String(input.protocol ?? rule.protocol);
  const failoverEnabled = input.failoverEnabled !== undefined ? !!input.failoverEnabled : dbBool(rule.failoverEnabled);
  const egressType = egress.egressType ?? rule.egressType;
  if (!touched) {
    const shapeError = ruleEgressShapeError({
      egressType, forwardType, protocol, egressUdp: rule.egressUdp, tunnelId, forwardGroupMode: groupMode, failoverEnabled,
    });
    if (shapeError) throw new Error(`${shapeError}（这条规则在用 Shadowsocks 出口；要换转发方式请先把出口改成「直接连接」）`);
    return null;
  }
  const entryHostIds = group
    ? (await db.getForwardGroupRuleEntryHostIds(forwardGroupId)).map(Number)
    : [Number(input.hostId ?? rule.hostId)];
  const columns = await resolveRuleEgressColumns(egress, {
    actor,
    entryHostIds,
    forwardType,
    protocol,
    tunnelId,
    forwardGroupMode: groupMode,
    failoverEnabled,
    targetIp: input.targetIp ?? rule.targetIp,
    current: rule,
  });
  return columns ? { columns } : null;
}

/** 主流程保存成功后把出口那几列写上；端口转发资源的模板要同步一遍子规则，直连规则催入口机重算。 */
async function applyRuleEgressUpdate(ruleId: number, plan: RuleEgressUpdatePlan) {
  const rule = await db.getForwardRuleById(ruleId) as any;
  if (!rule) return false;
  const before = ruleEgressColumnsOf(rule);
  const next = plan.columns;
  const same = before.egressType === next.egressType
    && Number(before.egressInboundId || 0) === Number(next.egressInboundId || 0)
    && String(before.egressConfigJson || "") === String(next.egressConfigJson || "")
    && before.egressUdp === next.egressUdp;
  if (same) return false;
  await db.updateForwardRule(ruleId, { ...next, isRunning: false } as any);
  if (dbBool(rule.isForwardGroupTemplate) && Number(rule.forwardGroupId || 0) > 0) {
    await db.syncForwardGroupRules(Number(rule.forwardGroupId));
  } else {
    pushAgentRefresh(Number(rule.hostId), "forward-rule-egress-updated");
  }
  return true;
}

export const crudRulesRouter = router({
  create: protectedProcedure
    .input(z.object({
      hostId: z.number().optional(),
      // 留空由服务端按目标地址兜底生成，见 resolveForwardRuleName。
      name: z.string().max(128).optional(),
      forwardType: forwardTypeSchema.default("iptables"),
      protocol: z.enum(["tcp", "udp", "both"]).default("both"),
      gostMode: z.enum(["direct", "reverse"]).default("direct"),
      gostRelayHost: z.string().max(128).nullable().optional(),
      gostRelayPort: z.number().int().min(1).max(65535).nullable().optional(),
      tunnelId: z.number().nullable().optional(),
      forwardGroupId: z.number().nullable().optional(),
      sourcePort: z.number().int().min(0).max(65535), // 0 = 随机分配
      targetIp: z.string().min(1).max(253).refine(
        (v) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(v.trim()),
        "请输入有效的 IP 地址或域名"
      ),
      targetPort: z.number().int().min(1).max(65535),
      isEnabled: z.boolean().optional().default(true),
      telegramErrorNotifyEnabled: z.boolean().optional().default(false),
      // 规则专属域名开关（shared/ruleEntryDomain.ts）：不传按列缺省开着。
      entryDomainEnabled: z.boolean().optional(),
      // 共享 TLS 入站（SNI 分流）：给了就走 createSniForwardRuleForActor，sourcePort 被忽略。
      tlsInboundId: z.number().int().positive().nullable().optional(),
      sniNames: sniNamesInputSchema.optional(),
      ...failoverInputShape,
      ...proxyProtocolInputShape,
      ...transportTuningInputShape,
      ...egressInputShape,
    }))
    .mutation(async ({ input, ctx }) => {
      const egressInput = takeEgressInput(input as any);
      if (input.tlsInboundId) {
        if (egressRequested(egressInput)) throw new Error("共享 TLS 入站上的规则不能使用 Shadowsocks 出口");
        return createSniForwardRuleForActor(ctx.user, input);
      }
      // 转发组这条路自己落库，同样兜底一次；直连那条在
      // createDirectForwardRuleForActor 里兜。两处都调同一个函数。
      const ruleName = resolveForwardRuleName(input.name, input);
      await requireRuleTelegramNotifyReady(input.telegramErrorNotifyEnabled);
      // 权限检查：管理员或有 canAddRules 权限的用户
      let currentUser = await db.getUserById(ctx.user.id);
      if (input.forwardGroupId) {
        const forwardGroupId = Number(input.forwardGroupId);
        return withKeyedTaskLock(`forward-group:${forwardGroupId}`, async () => {
        const groupReservations: HostPortReservation[] = [];
        let quotaReservation: RuleQuotaReservation | null = null;
        try {
        const randomSourcePort = input.sourcePort === 0;
        let sourcePort = input.sourcePort;
        let planRange: Awaited<ReturnType<typeof db.getUserForwardGroupPlanPortRange>> = null;
        let groupAccess = { isTrafficBillingResource: false };
        if (ctx.user.role !== "admin") {
          groupAccess = await requireForwardGroupUseAccess(ctx, forwardGroupId);
          currentUser = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: groupAccess.isTrafficBillingResource });
          if (currentUser?.expiresAt && new Date(currentUser.expiresAt) <= new Date()) {
            throw new Error("您的账户已到期，无法添加规则");
          }
          planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, forwardGroupId);
          if (sourcePort > 0 && planRange && !db.isPortAllowedByUserPlanRange(sourcePort, planRange)) {
            const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
            throw new Error(`套餐端口必须在 ${ranges} 内`);
          }
        }
        const entryHostIds = await db.getForwardGroupRuleEntryHostIds(forwardGroupId);
        if (!randomSourcePort) {
          await assertTenantListenPortAllowedOnHosts({ actor: ctx.user, hostIds: entryHostIds, port: sourcePort, label: "入口端口" });
        }
        const reserveEntryPort = async (port: number) => {
          const reservations: HostPortReservation[] = [];
          try {
            for (const entryHostId of entryHostIds) {
              const reservation = await reserveSpecificHostPort({
                hostId: entryHostId,
                port,
                protocol: input.protocol,
                isUsed: (candidate) => db.isPortUsedOnHost(entryHostId, candidate, undefined, input.protocol),
              });
              if (!reservation) {
                releaseHostPortReservations(reservations);
                return null;
              }
              reservations.push(reservation);
            }
            return reservations;
          } catch (error) {
            releaseHostPortReservations(reservations);
            throw error;
          }
        };
        if (randomSourcePort) {
          const unavailablePorts = new Set(entryHostIds.flatMap((hostId) => reservedHostPorts(hostId, input.protocol)));
          for (let attempt = 0; attempt < 256; attempt += 1) {
            const availablePort = await db.findAvailableForwardGroupPort(
              forwardGroupId,
              undefined,
              planRange,
              input.protocol,
              unavailablePorts,
            );
            if (!availablePort) break;
            unavailablePorts.add(availablePort);
            const reservations = await reserveEntryPort(availablePort);
            if (!reservations) continue;
            sourcePort = availablePort;
            groupReservations.push(...reservations);
            break;
          }
          if (sourcePort === 0) throw new Error("转发组入口端口区间内已无可用端口");
        } else {
          const reservations = await reserveEntryPort(sourcePort);
          if (!reservations) throw new Error(`入口 Agent 端口 ${sourcePort} 已被占用或正在分配`);
          groupReservations.push(...reservations);
        }
        const group = await db.validateForwardGroupRuleConfig(forwardGroupId, { sourcePort, protocol: input.protocol });
        const isForwardChain = (group as any).groupMode === "chain";
        const isPortGroup = (group as any).groupMode === "port";
        if (ctx.user.role !== "admin") {
          await requireTrafficBillingBalanceForRule(ctx.user.id, groupAccess.isTrafficBillingResource);
        }
        const hostId = await db.getForwardGroupDefaultHostId(forwardGroupId);
        const forwardType = lockedForwardTypeForGroup(group, input.forwardType);
        requireForwardTypeAllowedForActor(ctx.user, forwardType);
        const groupIsTunnel = !isForwardChain && (group as any).groupType === "tunnel";
        if (!isForwardChain && !groupIsTunnel) {
          await assertNoGroupSelfForwardLoop(forwardGroupId, { sourcePort, targetIp: input.targetIp, targetPort: input.targetPort });
        }
        const groupTunnelSupportsFailover = groupIsTunnel ? await forwardGroupTunnelMembersSupportMainBackup(group) : true;
        const groupSupportsFailover = !isForwardChain && routeGroupForwardTypeSupported(forwardType) && (!groupIsTunnel || groupTunnelSupportsFailover);
        const createFailoverEnabled = groupSupportsFailover ? input.failoverEnabled : false;
        requireMainBackupAllowed({
          enabled: createFailoverEnabled,
          protocol: input.protocol,
          forwardType,
          isTunnelRoute: groupIsTunnel,
          isPortForwardGroup: isPortGroup,
          isAdmin: ctx.user.role === "admin",
        });
        if (ctx.user.role !== "admin") {
          quotaReservation = await reserveRuleCreateQuota({
            userId: ctx.user.id,
            maxRules: Number(currentUser?.maxRules || 0),
            maxPorts: Number(currentUser?.maxPorts || 0),
            getRuleCount: () => db.getUserRuleCount(ctx.user.id),
            getPortCount: () => db.getUserPortCount(ctx.user.id),
          });
        }
        await requireRuleProtocolEnabled({ forwardType, tunnelId: null });
        // Shadowsocks 出口：只有端口转发资源（gost）上能挂，入口是组里的每台成员主机。
        const templateEgressColumns = egressRequested(egressInput)
          ? await resolveRuleEgressColumns(egressInput, {
            actor: ctx.user,
            entryHostIds: entryHostIds.map(Number),
            forwardType,
            protocol: input.protocol,
            forwardGroupMode: forwardGroupModeOf(group),
            failoverEnabled: !!createFailoverEnabled,
            targetIp: input.targetIp,
          })
          : null;
        const templateFailoverColumns = normalizeFailoverInput({
          ...input,
          failoverEnabled: createFailoverEnabled,
          failoverTargets: createFailoverEnabled ? input.failoverTargets : [],
          failoverProbeTarget: createFailoverEnabled ? input.failoverProbeTarget : null,
          failoverSchedule: createFailoverEnabled ? input.failoverSchedule : null,
          failoverMinHoldSeconds: createFailoverEnabled ? input.failoverMinHoldSeconds : 0,
          failoverPinnedIndex: createFailoverEnabled ? input.failoverPinnedIndex : null,
          failoverPinnedUntil: createFailoverEnabled ? input.failoverPinnedUntil : null,
          failoverPreferFastest: createFailoverEnabled ? input.failoverPreferFastest : false,
          routeGroup: createFailoverEnabled ? input.routeGroup : null,
        }, input.protocol, { allowHops: false, targetIp: input.targetIp, targetPort: input.targetPort });
        await assertRuleTargetsAllowedForActor(ctx.user, { targetIp: input.targetIp, ...templateFailoverColumns }, { forwardGroupId });
        const createTemplateRule = () => db.createForwardRule({
          hostId,
          name: ruleName,
          forwardType,
          protocol: input.protocol,
          gostMode: "direct",
          gostRelayHost: null,
          gostRelayPort: null,
          tunnelId: null,
          tunnelExitPort: null,
          forwardGroupId,
          forwardGroupRuleId: null,
          forwardGroupMemberId: null,
          isForwardGroupTemplate: true,
          sourcePort,
          targetIp: normalizeRuleTargetIp(input.targetIp, { tunnelId: forwardType === "gost" && !isForwardChain && (group as any).groupType === "tunnel" ? 1 : null }),
          targetPort: input.targetPort,
          isEnabled: input.isEnabled,
          telegramErrorNotifyEnabled: !!input.telegramErrorNotifyEnabled,
          entryDomainEnabled: input.entryDomainEnabled ?? true,
          ...RULE_PROTOCOL_BLOCK_COLUMNS,
          ...normalizeProxyProtocolInput(
            input,
            input.protocol,
            forwardType,
            isForwardChain,
            { tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel", clearUnsupported: true },
          ),
          ...normalizeTransportTuningInput(
            input,
            input.protocol,
            forwardType,
            isForwardChain,
            { tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel", forwardxTunnel: false, clearUnsupported: true },
          ),
          ...templateFailoverColumns,
          ...(templateEgressColumns || {}),
          isRunning: false,
          userId: ctx.user.id,
        } as any);
        let id = 0;
        // 同步子规则时，这些入口端口是本请求自己占着的（见 runWithHeldHostPortReservations）。
        if (isForwardChain) {
          id = await runWithHeldHostPortReservations(groupReservations, () => db.withForwardGroupSyncTransaction(forwardGroupId, createTemplateRule));
        } else {
          id = await createTemplateRule();
          await runWithHeldHostPortReservations(groupReservations, () => db.syncForwardGroupRules(forwardGroupId));
        }
        await quotaReservation?.release();
        quotaReservation = null;
        await db.runForwardGroupFailover(forwardGroupId);
        return { id, sourcePort };
        } finally {
          await quotaReservation?.release();
          releaseHostPortReservations(groupReservations);
        }
        });
      }

      return createDirectForwardRuleForActor(ctx.user, input, { egress: egressInput });
    }),
  update: protectedProcedure
    .input(z.object({
      id: z.number(),
      hostId: z.number().optional(),
      name: z.string().min(1).max(128).optional(),
      forwardType: forwardTypeSchema.optional(),
      protocol: z.enum(["tcp", "udp", "both"]).optional(),
      gostMode: z.enum(["direct", "reverse"]).optional(),
      gostRelayHost: z.string().max(128).nullable().optional(),
      gostRelayPort: z.number().int().min(1).max(65535).nullable().optional(),
      tunnelId: z.number().nullable().optional(),
      tunnelExitPort: z.number().int().min(1).max(65535).nullable().optional(),
      forwardGroupId: z.number().nullable().optional(),
      sourcePort: z.number().int().min(0).max(65535).optional(),
      targetIp: z.string().min(1).max(253).refine(
        (v) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(v.trim()),
        "请输入有效的 IP 地址或域名"
      ).optional(),
      targetPort: z.number().int().min(1).max(65535).optional(),
      telegramErrorNotifyEnabled: z.boolean().optional(),
      // 规则专属域名开关：改了由仓库层通知同步（关 → 域名进待删表、订阅立刻退回入口地址；开 → 重新发布）。
      entryDomainEnabled: z.boolean().optional(),
      tlsInboundId: z.number().int().positive().nullable().optional(),
      sniNames: sniNamesInputSchema.optional(),
      ...failoverInputShape,
      ...proxyProtocolInputShape,
      ...transportTuningInputShape,
      ...egressInputShape,
      isEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // 出口那一块单独校验、主流程成功后单独落库（见 planRuleEgressUpdate）。
      const egressInput = takeEgressInput(input as any);
      const egressPlan = await planRuleEgressUpdate(ctx.user, input, egressInput);
      const egressActiveAfterSave = egressPlan ? egressPlan.columns.egressType !== "none" : ruleHasEgress(await db.getForwardRuleById(input.id));
      const updateResult = await withKeyedTaskLock(`rule:${input.id}`, async () => {
      const heldReservations: HostPortReservation[] = [];
      // Keep the primary tunnel-exit reservation separate from source-port
      // reservations. It is released immediately after the rule row is
      // written, before the mapping reconciler acquires its own reservations.
      // Holding both would make a same-port mapping look externally busy and
      // could cause needless port churn on every edit.
      let tunnelExitPortReservationForUpdate: HostPortReservation | null = null;
      let tunnelExitPortReservationForConversion: HostPortReservation | null = null;
      const reserveRulePort = async (
        hostId: number,
        port: number,
        protocol: "tcp" | "udp" | "both",
        excludeRuleIds: number | number[],
        tunnelId?: number | null,
      ) => {
        // 隧道挂了入口组时，组里每台主机也在这个端口上监听：每台都要查、都要占住。
        const listenHostIds = tunnelId ? await db.forwardRuleListenHostIds(hostId, tunnelId) : [Number(hostId)];
        let primary: HostPortReservation | null = null;
        for (const listenHostId of listenHostIds) {
          const existing = heldReservations.find((reservation) => (
            reservation.hostId === Number(listenHostId)
            && reservation.port === Number(port)
            && reservation.protocol === protocol
          ));
          const reservation = existing || await reserveSpecificHostPort({
            hostId: listenHostId,
            port,
            protocol,
            isUsed: (candidate) => db.isPortUsedOnHost(listenHostId, candidate, excludeRuleIds, protocol, undefined, false),
          });
          // 占不到就返回 null，调用方随即报错；这次已占到的留在 heldReservations 里，由 finally 统一释放。
          if (!reservation) return null;
          if (!existing) heldReservations.push(reservation);
          primary ||= reservation;
        }
        return primary;
      };
      const reserveForwardGroupEntryPorts = async (
        groupId: number,
        port: number,
        protocol: "tcp" | "udp" | "both",
        excludeRuleIds: number[],
      ) => {
        const hostIds = await db.getForwardGroupRuleEntryHostIds(groupId);
        const outcomes = await Promise.allSettled(hostIds.map((hostId) => (
          reserveRulePort(hostId, port, protocol, excludeRuleIds)
        )));
        const failed = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult | undefined;
        if (failed) throw failed.reason;
        if (outcomes.some((outcome) => outcome.status === "fulfilled" && !outcome.value)) {
          throw new Error(`Port ${port} is already used or being allocated on a forward-group entry host`);
        }
      };
      try {
      const rule = await db.getForwardRuleById(input.id);
      // 待删除的规则只等 Agent 确认停掉后清理；改它（尤其是 isEnabled 等字段）会让它复活。
      if (!rule || dbBool((rule as any).pendingDelete)) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作此规则");
      if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接修改");
      if (Number((rule as any).routeParentRuleId || 0) > 0) throw new Error("线路组的中转规则由面板维护，不能直接修改");
      if (isSniRule(rule)) return updateSniForwardRuleForActor(ctx.user, rule, input) as any;
      if (input.tlsInboundId) throw new Error("已有规则不能改成共享 TLS 入站，请新建一条规则");
      await requireRuleTelegramNotifyReady(input.telegramErrorNotifyEnabled);

      if (input.sourcePort === 0) {
        const nextProtocol = input.protocol ?? (rule as any).protocol;
        const childRules = (rule as any).isForwardGroupTemplate
          ? await db.getForwardGroupChildRulesForTemplate(Number(rule.id))
          : [];
        const excludeRuleIds = [
          Number(rule.id),
          ...(childRules as any[]).map((child: any) => Number(child.id)),
        ].filter((id) => Number.isInteger(id) && id > 0);
        const nextForwardGroupId = input.forwardGroupId !== undefined
          ? Number(input.forwardGroupId || 0)
          : (rule as any).isForwardGroupTemplate
            ? Number((rule as any).forwardGroupId || 0)
            : 0;

        if (nextForwardGroupId > 0) {
          let planRange: Awaited<ReturnType<typeof db.getUserForwardGroupPlanPortRange>> = null;
          if (ctx.user.role !== "admin") {
            await requireForwardGroupUseAccess(ctx, nextForwardGroupId);
            planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, nextForwardGroupId);
          }
          const entryHostIds = await db.getForwardGroupRuleEntryHostIds(nextForwardGroupId);
          const unavailablePorts = new Set(entryHostIds.flatMap((hostId) => reservedHostPorts(hostId, nextProtocol)));
          let selectedPort = 0;
          for (let attempt = 0; attempt < 256; attempt += 1) {
            const candidate = await db.findAvailableForwardGroupPort(
              nextForwardGroupId,
              Number(rule.id),
              planRange,
              nextProtocol,
              unavailablePorts,
            );
            if (!candidate) break;
            unavailablePorts.add(candidate);
            const candidateReservations: HostPortReservation[] = [];
            let reservedEveryEntry = true;
            try {
              for (const hostId of entryHostIds) {
                const reservation = await reserveSpecificHostPort({
                  hostId,
                  port: candidate,
                  protocol: nextProtocol,
                  isUsed: (port) => db.isPortUsedOnHost(hostId, port, excludeRuleIds, nextProtocol, undefined, false),
                });
                if (!reservation) {
                  reservedEveryEntry = false;
                  break;
                }
                candidateReservations.push(reservation);
              }
            } catch (error) {
              releaseHostPortReservations(candidateReservations);
              throw error;
            }
            if (!reservedEveryEntry) {
              releaseHostPortReservations(candidateReservations);
              continue;
            }
            heldReservations.push(...candidateReservations);
            selectedPort = candidate;
            break;
          }
          if (!selectedPort) throw new Error("转发组入口端口区间内已无可用端口");
          input.sourcePort = selectedPort;
        } else {
          const nextForwardType = input.forwardType ?? (rule as any).forwardType;
          const nextTunnelId = nextForwardType === "gost"
            ? Number(input.tunnelId !== undefined ? input.tunnelId : (rule as any).tunnelId) || null
            : null;
          let nextHostId = Number(input.hostId ?? (rule as any).hostId);
          let rangeStart: number | null | undefined;
          let rangeEnd: number | null | undefined;
          let planRange: Awaited<ReturnType<typeof db.getUserPlanPortRange>> = null;
          if (nextTunnelId) {
            const { tunnel } = await requireTunnelUseOrTrafficBillingAccess(ctx, nextTunnelId);
            nextHostId = Number((tunnel as any).entryHostId || 0);
            rangeStart = (tunnel as any).portRangeStart;
            rangeEnd = (tunnel as any).portRangeEnd;
          } else {
            await requireHostUseAccess(ctx, nextHostId);
          }
          if (ctx.user.role !== "admin") {
            planRange = await db.getUserPlanPortRange(ctx.user.id, nextHostId, nextTunnelId || undefined);
          }
          // 隧道挂了入口组时，随机挑的端口要在入口机和组里每台主机上都空着，并一起占住。
          const listenHostIds = nextTunnelId ? await db.forwardRuleListenHostIds(nextHostId, nextTunnelId) : [nextHostId];
          const reservation = await reserveAvailableHostPortOnHosts({
            hostIds: listenHostIds,
            protocol: nextProtocol,
            findPort: async (reservedPorts) => db.findAvailablePort(
              nextHostId,
              rangeStart,
              rangeEnd,
              nextProtocol,
              [...reservedPorts, ...await db.usedPortsOnOtherListenHosts(nextHostId, listenHostIds, excludeRuleIds, nextProtocol)],
              excludeRuleIds,
              planRange?.ranges || [],
            ),
            isUsed: (listenHostId, port) => db.isPortUsedOnHost(listenHostId, port, excludeRuleIds, nextProtocol, undefined, false),
            maxAttempts: 256,
          });
          if (!reservation) throw new Error("入口 Agent 端口区间内已无可用端口");
          // 按主机拆开登记：后面 reserveRulePort 按「主机 + 端口」认自己已经占着的预留。
          heldReservations.push(...(reservation.parts || [reservation]));
          input.sourcePort = reservation.port;
        }
      }

      if ((rule as any).isForwardGroupTemplate) {
        const groupId = Number((rule as any).forwardGroupId || 0);
        if (input.forwardGroupId === null) {
          if (!groupId) throw new Error("Forward group does not exist");
          const childRules = await db.getForwardGroupChildRulesForTemplate(input.id);
          const excludeRuleIds = [
            Number(rule.id),
            ...(childRules as any[]).map((child: any) => Number(child.id)),
          ].filter((id) => Number.isInteger(id) && id > 0);
          const nextForwardType = input.forwardType ?? (rule as any).forwardType;
          const requestedTunnelId = nextForwardType === "gost"
            ? Number(input.tunnelId !== undefined ? input.tunnelId : (rule as any).tunnelId) || null
            : null;
          const route = await prepareDirectRuleRouteForActor(
            {
              id: ctx.user.id,
              role: ctx.user.role,
              allowedForwardTypes: (ctx.user as any).allowedForwardTypes,
            },
            {
              forwardType: nextForwardType,
              tunnelId: requestedTunnelId,
              hostId: input.hostId !== undefined
                ? Number(input.hostId)
                : requestedTunnelId
                  ? null
                  : Number((rule as any).hostId),
            },
          );
          const nextTunnelId = route.tunnelId;
          const selectedTunnelForRule = route.selectedTunnelForRule;
          const nextHostId = route.hostId;

          const nextProtocol = input.protocol ?? (rule as any).protocol;
          const nextSourcePort = Number(input.sourcePort ?? (rule as any).sourcePort);
          const nextMainBackupEnabled = false;
          requireMainBackupAllowed({
            enabled: nextMainBackupEnabled,
            protocol: nextProtocol,
            forwardType: nextForwardType,
            tunnelId: nextTunnelId,
            isAdmin: ctx.user.role === "admin",
          });
          await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardType, tunnelId: nextTunnelId }, selectedTunnelForRule);
          await assertRulePortWithinEntryPolicy({
            hostId: nextHostId,
            sourcePort: nextSourcePort,
            tunnelId: nextTunnelId,
            tunnel: selectedTunnelForRule,
            actor: ctx.user,
          });
          if (ctx.user.role !== "admin") {
            const planRange = await db.getUserPlanPortRange(ctx.user.id, nextHostId, nextTunnelId || undefined);
            if (planRange && !db.isPortAllowedByUserPlanRange(nextSourcePort, planRange)) {
              const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
              throw new Error(`套餐端口必须在 ${ranges} 区间内`);
            }
          }
          const sourceReservation = await reserveRulePort(nextHostId, nextSourcePort, nextProtocol, excludeRuleIds, nextTunnelId);
          if (!sourceReservation) throw new Error(`Port ${nextSourcePort} is already used or being allocated`);
          if (!nextTunnelId) {
            const host = await db.getHostById(nextHostId);
            assertNoDirectSelfForwardLoop({
              host,
              sourcePort: nextSourcePort,
              targetIp: input.targetIp ?? (rule as any).targetIp,
              targetPort: Number(input.targetPort ?? (rule as any).targetPort),
              tunnelId: nextTunnelId,
            });
          }

          let tunnelExitPort: number | null = null;
          if (nextTunnelId) {
            const tunnel = selectedTunnelForRule;
            const exit = await db.getHostById(tunnel.exitHostId);
            const existingExitPort = Number((rule as any).tunnelExitPort || 0);
            const listenerRepair = usesSharedTunnelPrimaryListener(tunnel)
              ? await ensureTunnelListenerPortPolicy(tunnel, {
                hostId: Number(tunnel.exitHostId),
                syncSharedPrimaryRule: true,
              })
              : null;
            if (usesSharedTunnelPrimaryListener(tunnel) && !listenerRepair) {
              throw new Error("Tunnel exit agent has no available listener port");
            }
            const sharedListenPort = await preferredSharedTunnelListenPort(
              tunnel,
              Number(rule.id),
              input.isEnabled !== undefined ? dbBool(input.isEnabled) : dbBool((rule as any).isEnabled),
            );
            let exitReservation: HostPortReservation | null = null;
            if (listenerRepair?.reservation && Number(sharedListenPort || 0) === listenerRepair.port) {
              exitReservation = listenerRepair.reservation;
            } else {
              listenerRepair?.reservation.release();
            }
            if (!exitReservation) {
              exitReservation = await reserveTunnelExitPort({
                hostId: Number(tunnel.exitHostId),
                preferredStart: (exit as any)?.portRangeStart,
                preferredEnd: (exit as any)?.portRangeEnd,
                currentPort: sharedListenPort ?? existingExitPort,
                reservedPorts: [],
                excludeRuleIds,
                allowSameTunnelListener: Number(sharedListenPort || 0) > 0,
                excludeTunnelId: Number(tunnel.id),
                protocol: "both",
              });
            }
            if (!exitReservation) throw new Error("Tunnel exit agent has no available port");
            tunnelExitPortReservationForConversion = exitReservation;
            tunnelExitPort = exitReservation.port;
          }

          const failoverData = normalizeFailoverInput({
            failoverEnabled: false,
            failoverTargets: [],
          }, nextProtocol);
          const data: any = {
            name: input.name ?? (rule as any).name,
            hostId: nextHostId,
            forwardType: nextForwardType,
            protocol: nextProtocol,
            gostMode: "direct",
            gostRelayHost: null,
            gostRelayPort: null,
            tunnelId: nextTunnelId,
            tunnelExitPort,
            forwardGroupId: null,
            forwardGroupRuleId: null,
            forwardGroupMemberId: null,
            isForwardGroupTemplate: false,
            sourcePort: nextSourcePort,
            targetIp: normalizeRuleTargetIp(input.targetIp ?? (rule as any).targetIp, { tunnelId: nextTunnelId }),
            targetPort: Number(input.targetPort ?? (rule as any).targetPort),
            telegramErrorNotifyEnabled: input.telegramErrorNotifyEnabled ?? (rule as any).telegramErrorNotifyEnabled,
            entryDomainEnabled: input.entryDomainEnabled ?? (rule as any).entryDomainEnabled ?? true,
            ...RULE_PROTOCOL_BLOCK_COLUMNS,
            ...normalizeProxyProtocolInput({}, nextProtocol, nextForwardType, false, { clearUnsupported: true, tunnelRoute: !!nextTunnelId }),
            ...normalizeTransportTuningInput({}, nextProtocol, nextForwardType, false, {
              clearUnsupported: true,
              tunnelRoute: !!nextTunnelId,
              forwardxTunnel: String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx",
            }),
            ...failoverData,
            isEnabled: input.isEnabled !== undefined ? dbBool(input.isEnabled) : dbBool((rule as any).isEnabled),
            isRunning: false,
            pendingDelete: false,
          };
          if (dbBool(data.isEnabled)) {
            data.disabledByUser = false;
            data.disabledByTunnel = false;
            data.disabledByGroup = false;
            data.protocolBlockReason = null;
          }
          await assertRuleTargetsAllowedForActor(ctx.user, data, { hostId: nextHostId, tunnel: nextTunnelId ? selectedTunnelForRule : null });

          await db.updateForwardRule(input.id, data);
          // Let the mapping reconciler acquire endpoint reservations itself;
          // retaining this primary reservation would make a matching mapping
          // appear busy and can rotate its port unnecessarily.
          tunnelExitPortReservationForConversion?.release();
          tunnelExitPortReservationForConversion = null;
          if (nextTunnelId && selectedTunnelForRule) {
            await db.reconcileForwardRuleTunnelExits({ ...rule, ...data, id: input.id, tunnelId: nextTunnelId, tunnelExitPort }, selectedTunnelForRule);
            await db.updateTunnel(nextTunnelId, { isRunning: false } as any);
          } else {
            await db.clearForwardRuleTunnelExits(input.id);
          }
          const retiredChildren = await markTemplateChildrenPendingDelete(
            input.id,
            "forward-group-rule-converted",
            { deferRefresh: true },
          );
          await refreshPendingTemplateChildren(retiredChildren as any[], "forward-group-rule-converted");
          if (nextTunnelId && selectedTunnelForRule) {
            await pushTunnelEndpointRefresh(selectedTunnelForRule, "forward-group-rule-converted");
          } else {
            pushAgentRefresh(nextHostId, "forward-group-rule-converted");
          }
          await db.runForwardGroupFailover(groupId);
          return { success: true, reset: true };
        }
        if (!groupId) throw new Error("转发组不存在");
        const activeGroupId = input.forwardGroupId === undefined ? groupId : Number(input.forwardGroupId || 0);
        if (!activeGroupId) throw new Error("转发组不存在");
        const groupChanged = activeGroupId !== groupId;
        let groupAccess = { isTrafficBillingResource: false };
        if (ctx.user.role !== "admin") {
          groupAccess = await requireForwardGroupUseAccess(ctx, activeGroupId);
          if (input.isEnabled !== undefined ? input.isEnabled : dbBool((rule as any).isEnabled)) {
            await requireForwardAccessForEnabledRule(ctx.user.id, groupAccess.isTrafficBillingResource);
          }
          const nextSourcePort = input.sourcePort ?? rule.sourcePort;
          const planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, activeGroupId);
          if (planRange && !db.isPortAllowedByUserPlanRange(nextSourcePort, planRange)) {
            const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
            throw new Error(`套餐端口必须在 ${ranges} 内`);
          }
        }
        const group = await db.validateForwardGroupRuleConfig(activeGroupId, {
          sourcePort: input.sourcePort ?? rule.sourcePort,
          protocol: input.protocol ?? (rule as any).protocol,
          excludeTemplateRuleId: rule.id,
        });
        const isForwardChain = (group as any).groupMode === "chain";
        const isPortGroup = (group as any).groupMode === "port";
        if (ctx.user.role !== "admin" && (input.isEnabled === true || dbBool((rule as any).isEnabled))) {
          await requireTrafficBillingBalanceForRule(ctx.user.id, groupAccess.isTrafficBillingResource);
        }
        const nextForwardType = lockedForwardTypeForGroup(group, input.forwardType ?? (rule as any).forwardType);
        const groupRouteChanged = groupChanged
          || String(nextForwardType) !== String((rule as any).forwardType);
        if (groupRouteChanged) {
          requireForwardTypeAllowedForActor(ctx.user, nextForwardType);
        }
        const nextProtocol = input.protocol ?? (rule as any).protocol;
        const childRules = await db.getForwardGroupChildRulesForTemplate(input.id);
        await reserveForwardGroupEntryPorts(
          activeGroupId,
          Number(input.sourcePort ?? (rule as any).sourcePort),
          nextProtocol,
          [Number(rule.id), ...(childRules as any[]).map((child: any) => Number(child.id))].filter(Boolean),
        );
        const groupIsTunnel = !isForwardChain && (group as any).groupType === "tunnel";
        const groupTunnelSupportsFailover = groupIsTunnel ? await forwardGroupTunnelMembersSupportMainBackup(group) : true;
        const groupSupportsFailover = !isForwardChain && routeGroupForwardTypeSupported(nextForwardType) && (!groupIsTunnel || groupTunnelSupportsFailover);
        const nextMainBackupEnabled = groupChanged ? false : (groupSupportsFailover ? input.failoverEnabled ?? (rule as any).failoverEnabled : false);
        requireMainBackupAllowed({
          enabled: nextMainBackupEnabled,
          protocol: nextProtocol,
          forwardType: nextForwardType,
          isTunnelRoute: groupIsTunnel,
          isPortForwardGroup: isPortGroup,
          isAdmin: ctx.user.role === "admin",
        });
        await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardType, tunnelId: null });
        const activeHostId = await db.getForwardGroupDefaultHostId(activeGroupId);
        if (!isForwardChain && !groupIsTunnel) {
          await assertNoGroupSelfForwardLoop(activeGroupId, {
            sourcePort: Number(input.sourcePort ?? (rule as any).sourcePort),
            targetIp: input.targetIp ?? (rule as any).targetIp,
            targetPort: Number(input.targetPort ?? (rule as any).targetPort),
          });
        }
        const clearable = mergeFailoverClearableFields(input, rule);
        /*
          routeGroup 只是传输用的字段，不是列：混在 data 里 Drizzle 会拿一个不存在的字段去
          更新。而且它得交给 normalizeFailoverInput，否则这次保存会照着老的 failover* 列
          重算，把用户刚编辑的路径抹成 null。
        */
        const { routeGroup: _routeGroupInput, ...inputColumns } = input;
        const data: any = {
          ...inputColumns,
          ...(groupChanged || isForwardChain || isPortGroup || !nextMainBackupEnabled || failoverFieldsProvided(input)
            ? normalizeFailoverInput({
                failoverEnabled: nextMainBackupEnabled,
                failoverStrategy: groupChanged ? "fallback" : input.failoverStrategy ?? (rule as any).failoverStrategy ?? "fallback",
                failoverTargets: nextMainBackupEnabled && !groupChanged ? (input.failoverTargets ?? parseFailoverTargets((rule as any).failoverTargets)) : [],
                failoverProbeTarget: nextMainBackupEnabled && !groupChanged ? clearable.failoverProbeTarget : null,
                failoverSchedule: nextMainBackupEnabled && !groupChanged ? clearable.failoverSchedule : null,
                failoverMinHoldSeconds: nextMainBackupEnabled && !groupChanged ? (input.failoverMinHoldSeconds ?? Number((rule as any).failoverMinHoldSeconds || 0)) : 0,
                failoverPinnedIndex: nextMainBackupEnabled && !groupChanged ? clearable.failoverPinnedIndex : null,
                failoverPinnedUntil: nextMainBackupEnabled && !groupChanged ? clearable.failoverPinnedUntil : null,
                failoverPreferFastest: nextMainBackupEnabled && !groupChanged ? (input.failoverPreferFastest ?? !!(rule as any).failoverPreferFastest) : false,
                failoverSeconds: groupChanged ? 60 : input.failoverSeconds ?? (rule as any).failoverSeconds,
                recoverSeconds: groupChanged ? 120 : input.recoverSeconds ?? (rule as any).recoverSeconds,
                autoFailback: groupChanged ? true : input.autoFailback ?? (rule as any).autoFailback,
                routeGroup: nextMainBackupEnabled && !groupChanged ? input.routeGroup : null,
              }, nextProtocol, {
                rule: groupChanged ? null : rule,
                // 转发组的模板规则不跑在任何一台机器上，路径不能带中转（和新建时同一条口径）。
                allowHops: false,
                targetIp: input.targetIp ?? (rule as any).targetIp,
                targetPort: input.targetPort ?? (rule as any).targetPort,
              })
            : {}),
          ...(input.targetIp !== undefined ? { targetIp: normalizeRuleTargetIp(input.targetIp, { tunnelId: !isForwardChain && (group as any).groupType === "tunnel" ? 1 : null }) } : {}),
          forwardType: nextForwardType,
          ...(groupChanged ? normalizeProxyProtocolInput({}, nextProtocol, nextForwardType, isForwardChain, { clearUnsupported: true, tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel" }) : normalizeProxyProtocolInput(
            { ...rule, ...input },
            nextProtocol,
            nextForwardType,
            isForwardChain,
            { clearUnsupported: true, tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel" },
          )),
          ...(groupChanged ? normalizeTransportTuningInput({}, nextProtocol, nextForwardType, isForwardChain, { clearUnsupported: true, tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel", forwardxTunnel: false }) : normalizeTransportTuningInput(
            { ...rule, ...input },
            nextProtocol,
            nextForwardType,
            isForwardChain,
            {
              clearUnsupported: true,
              tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel",
              forwardxTunnel: false,
            },
          )),
          gostMode: "direct",
          gostRelayHost: null,
          gostRelayPort: null,
          tunnelId: null,
          tunnelExitPort: null,
          hostId: activeHostId,
          forwardGroupId: activeGroupId,
          forwardGroupRuleId: null,
          forwardGroupMemberId: null,
          isForwardGroupTemplate: true,
        };
        delete data.id;
        const watchedFields = ["sourcePort", "targetIp", "targetPort", "forwardType", "protocol", "proxyProtocolReceive", "proxyProtocolSend", "proxyProtocolExitReceive", "proxyProtocolExitSend", "proxyProtocolVersion", "tcpFastOpen", "zeroCopy", "udpOverTcp", "udpOverTcpPort", "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverProbeTarget", "failoverSchedule", "failoverMinHoldSeconds", "failoverPinnedIndex", "failoverPinnedUntil", "failoverPreferFastest", "failoverSeconds", "recoverSeconds", "autoFailback"] as const;
        const keyFieldChanged = watchedFields.some((field) => data[field] !== undefined && data[field] !== (rule as any)[field]);
        if (dbBool(data.isEnabled)) {
          data.disabledByUser = false;
          data.disabledByTunnel = false;
          data.disabledByGroup = false;
          data.protocolBlockReason = null;
        }
        if (keyFieldChanged || groupChanged || data.isEnabled !== undefined) data.isRunning = false;
        await assertRuleTargetsAllowedForActor(ctx.user, { ...rule, ...data }, { forwardGroupId: activeGroupId });
        // 同步子规则时，新入口端口是本请求自己占着的（见 runWithHeldHostPortReservations）。
        await runWithHeldHostPortReservations(heldReservations, async () => {
        if (!groupChanged && isForwardChain) {
          await db.withForwardGroupSyncTransaction(
            activeGroupId,
            () => db.updateForwardRule(input.id, data),
          );
        } else {
          if (groupChanged) await markTemplateChildrenPendingDelete(input.id, "forward-group-rule-route-changed");
          await db.updateForwardRule(input.id, data);
          if (groupChanged) {
            await db.syncForwardGroupRules(groupId);
            await db.runForwardGroupFailover(groupId);
          }
          await db.syncForwardGroupRules(activeGroupId);
        }
        });
        await db.runForwardGroupFailover(activeGroupId);
        return { success: true, reset: keyFieldChanged || groupChanged };
      }

      if (input.forwardGroupId !== undefined && input.forwardGroupId !== null) {
        const groupId = Number(input.forwardGroupId);
        const sourcePort = Number(input.sourcePort ?? (rule as any).sourcePort);
        if (!groupId) throw new Error("请选择转发链或转发组");
        let groupAccess = { isTrafficBillingResource: false };
        if (ctx.user.role !== "admin") {
          groupAccess = await requireForwardGroupUseAccess(ctx, groupId);
          if (input.isEnabled !== undefined ? input.isEnabled : dbBool((rule as any).isEnabled)) {
            await requireForwardAccessForEnabledRule(ctx.user.id, groupAccess.isTrafficBillingResource);
          }
          const planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, groupId);
          if (planRange && !db.isPortAllowedByUserPlanRange(sourcePort, planRange)) {
            const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
            throw new Error(`套餐端口必须在 ${ranges} 内`);
          }
          await assertTenantListenPortAllowedOnHosts({
            actor: ctx.user,
            hostIds: await db.getForwardGroupRuleEntryHostIds(groupId),
            port: sourcePort,
            label: "入口端口",
          });
        }
        const group = await db.validateForwardGroupRuleConfig(groupId, {
          sourcePort,
          protocol: input.protocol ?? (rule as any).protocol,
          excludeTemplateRuleId: rule.id,
        });
        const isForwardChain = (group as any).groupMode === "chain";
        const isPortGroup = (group as any).groupMode === "port";
        if (ctx.user.role !== "admin" && (input.isEnabled === true || dbBool((rule as any).isEnabled))) {
          await requireTrafficBillingBalanceForRule(ctx.user.id, groupAccess.isTrafficBillingResource);
        }
        const nextForwardType = lockedForwardTypeForGroup(group, input.forwardType ?? (rule as any).forwardType);
        requireForwardTypeAllowedForActor(ctx.user, nextForwardType);
        const nextProtocol = input.protocol ?? (rule as any).protocol;
        await reserveForwardGroupEntryPorts(groupId, sourcePort, nextProtocol, [Number(rule.id)]);
        const nextMainBackupEnabled = false;
        requireMainBackupAllowed({
          enabled: nextMainBackupEnabled,
          protocol: nextProtocol,
          forwardType: nextForwardType,
          isTunnelRoute: !isForwardChain && (group as any).groupType === "tunnel",
          isAdmin: ctx.user.role === "admin",
        });
        await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardType, tunnelId: null });
        const hostId = await db.getForwardGroupDefaultHostId(groupId);
        if (!isForwardChain && (group as any).groupType !== "tunnel") {
          await assertNoGroupSelfForwardLoop(groupId, {
            sourcePort,
            targetIp: input.targetIp ?? (rule as any).targetIp,
            targetPort: Number(input.targetPort ?? (rule as any).targetPort),
          });
        }
        const data: any = {
          name: input.name ?? (rule as any).name,
          hostId,
          forwardType: nextForwardType,
          protocol: nextProtocol,
          gostMode: "direct",
          gostRelayHost: null,
          gostRelayPort: null,
          tunnelId: null,
          tunnelExitPort: null,
          forwardGroupId: groupId,
          forwardGroupRuleId: null,
          forwardGroupMemberId: null,
          isForwardGroupTemplate: true,
          sourcePort,
          targetIp: normalizeRuleTargetIp(input.targetIp ?? (rule as any).targetIp, { tunnelId: !isForwardChain && (group as any).groupType === "tunnel" ? 1 : null }),
          targetPort: Number(input.targetPort ?? (rule as any).targetPort),
          telegramErrorNotifyEnabled: input.telegramErrorNotifyEnabled ?? (rule as any).telegramErrorNotifyEnabled,
          entryDomainEnabled: input.entryDomainEnabled ?? (rule as any).entryDomainEnabled ?? true,
          ...RULE_PROTOCOL_BLOCK_COLUMNS,
          ...normalizeProxyProtocolInput(
            {},
            nextProtocol,
            nextForwardType,
            isForwardChain,
            { clearUnsupported: true, tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel" },
          ),
          ...normalizeTransportTuningInput(
            {},
            nextProtocol,
            nextForwardType,
            isForwardChain,
            { clearUnsupported: true, tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel", forwardxTunnel: false },
          ),
          ...normalizeFailoverInput({
            failoverEnabled: false,
            failoverTargets: [],
          }, nextProtocol),
          isEnabled: input.isEnabled !== undefined ? dbBool(input.isEnabled) : dbBool((rule as any).isEnabled),
          isRunning: false,
          pendingDelete: false,
        };
        if (dbBool(data.isEnabled)) {
          data.disabledByUser = false;
          data.disabledByTunnel = false;
          data.disabledByGroup = false;
          data.protocolBlockReason = null;
        }
        await assertRuleTargetsAllowedForActor(ctx.user, data, { forwardGroupId: groupId });
        await db.updateForwardRule(input.id, data);
        await db.clearForwardRuleTunnelExits(input.id);
        // 变成转发组模板之后没有线路组了：中转机上的中继规则收回。
        await syncRouteGroupAfterSave(input.id, "forward-rule-route-changed");
        if ((rule as any).tunnelId) {
          const oldTunnel = await db.getTunnelById((rule as any).tunnelId);
          await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
          if (oldTunnel) await pushTunnelEndpointRefresh(oldTunnel, "forward-rule-route-changed");
        } else if (Number((rule as any).hostId || 0) > 0) {
          pushAgentRefresh(Number((rule as any).hostId), "forward-rule-route-changed");
        }
        await runWithHeldHostPortReservations(heldReservations, () => db.syncForwardGroupRules(groupId));
        await db.runForwardGroupFailover(groupId);
        return { success: true, reset: true };
      }
      // 如果修改了源端口，检查端口区间和占用
      let selectedTunnelForRule: any = null;
      let nextTunnelIdForRule: number | null = null;
      let nextForwardTypeForRule = rule.forwardType;
      let nextHostIdForRule = Number(input.hostId ?? rule.hostId);
      {
        const nextForwardType = input.forwardType ?? rule.forwardType;
        nextForwardTypeForRule = nextForwardType;
        nextTunnelIdForRule = nextForwardType === "gost"
          ? (input.tunnelId !== undefined ? input.tunnelId : (rule as any).tunnelId)
          : null;
        if (nextTunnelIdForRule) {
          const access = await requireTunnelUseOrTrafficBillingAccess(ctx, nextTunnelIdForRule);
          selectedTunnelForRule = access.tunnel;
           if (!dbBool(selectedTunnelForRule.isEnabled)) throw new Error("Selected tunnel is disabled");
          nextHostIdForRule = Number(selectedTunnelForRule.entryHostId);
          if (ctx.user.role !== "admin" && String(selectedTunnelForRule.mode).toLowerCase() === "forwardx") {
            const owner = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: !!access.isTrafficBillingResource });
            await requireTrafficBillingBalanceForRule(ctx.user.id, !!access.isTrafficBillingResource);
            if (!(owner as any)?.canAddRules && !access.isTrafficBillingResource) {
              throw new Error("No permission to use custom encrypted tunnels");
            }
          }
        }
      }
      const nextIsTunnelForward = nextForwardTypeForRule === "gost" && Number(nextTunnelIdForRule || 0) > 0;
      const routeChanged = String(nextForwardTypeForRule) !== String((rule as any).forwardType) || Number(nextTunnelIdForRule || 0) !== Number((rule as any).tunnelId || 0);
      const directRouteChanged = routeChanged || Number(nextHostIdForRule) !== Number((rule as any).hostId);
      if (directRouteChanged) {
        requireForwardTypeAllowedForActor(ctx.user, nextForwardTypeForRule);
      }
      await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardTypeForRule, tunnelId: nextTunnelIdForRule }, selectedTunnelForRule);
      const requestedMainBackupEnabled = input.failoverEnabled ?? (rule as any).failoverEnabled;
      const nextProtocolForRule = input.protocol ?? (rule as any).protocol;
      // 线路组不卡协议（TCP / UDP / TCP+UDP 都能调度，UDP 按会话，Agent 2.2.199 起）：换了路由就清掉，
      // 否则——只在转发方式支持线路组（gost / realm / socat / nginx）时保留用户的开关，隧道形态是否允许
      // 再由下面的 requireMainBackupAllowed 判（和新建同一条）；内核转发（iptables / nftables）的老行里
      // 可能残留 failoverEnabled，这里把它当成「关」而不是报错——routePolicy.ts 也是这么跟用户说的
      // （「保存一次时它会被关掉」）。
      // 2.3.439 前这里卡的是 protocol === "tcp"，表单默认 TCP+UDP，于是每次编辑隧道规则都把线路组悄悄清空。
      const nextMainBackupEnabled = routeChanged || !routeGroupForwardTypeSupported(nextForwardTypeForRule)
        ? false
        : requestedMainBackupEnabled;
      requireMainBackupAllowed({
        enabled: nextMainBackupEnabled,
        protocol: nextProtocolForRule,
        forwardType: nextForwardTypeForRule,
        tunnelId: nextTunnelIdForRule,
        tunnelMode: selectedTunnelForRule?.mode,
        isAdmin: ctx.user.role === "admin",
      });
       const nextRuleEnabled = input.isEnabled !== undefined
         ? dbBool(input.isEnabled)
         : dbBool((rule as any).isEnabled);
      if (!nextTunnelIdForRule) {
        const access = await requireHostUseAccess(ctx, nextHostIdForRule);
        // 和新建（prepareDirectRuleRouteForActor）同一条：普通用户不能直接在主机上开普通端口转发。
        // 只在换了主机 / 转发方式 / 从隧道改成直连时拦，原样留着的老规则改目标、改名字不受影响。
        if (ctx.user.role !== "admin" && !access.isTrafficBillingResource && directRouteChanged) {
          throw new Error("普通端口转发请先创建转发组或转发链后再新增规则。");
        }
        if (ctx.user.role !== "admin" && nextRuleEnabled) {
          await requireTrafficBillingBalanceForRule(ctx.user.id, !!access.isTrafficBillingResource);
        }
      }

      if (nextRuleEnabled && ctx.user.role !== "admin") {
        const activeTunnelId = Number(nextTunnelIdForRule || 0);
        const resourceAccess = activeTunnelId
          ? await requireTunnelUseOrTrafficBillingAccess(ctx, activeTunnelId)
          : await requireHostUseAccess(ctx, nextHostIdForRule);
        const owner = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: !!resourceAccess.isTrafficBillingResource });
        await requireTrafficBillingBalanceForRule(ctx.user.id, !!resourceAccess.isTrafficBillingResource, undefined, {
          tunnelId: activeTunnelId || null,
          hostId: nextHostIdForRule,
        });
        if (owner.expiresAt && new Date(owner.expiresAt) <= new Date()) {
          throw new Error("套餐已到期，请续费后再启用规则");
        }
      }

      const nextSourcePortForRule = input.sourcePort ?? rule.sourcePort;
      if (!nextTunnelIdForRule) {
        const host = await db.getHostById(nextHostIdForRule);
        assertNoDirectSelfForwardLoop({
          host,
          sourcePort: nextSourcePortForRule,
          targetIp: input.targetIp ?? (rule as any).targetIp,
          targetPort: Number(input.targetPort ?? (rule as any).targetPort),
          tunnelId: nextTunnelIdForRule,
        });
      }
      const shouldCheckSourcePort = input.sourcePort !== undefined
        || input.protocol !== undefined
        || Number(nextHostIdForRule) !== Number(rule.hostId)
        || Number(nextTunnelIdForRule || 0) !== Number((rule as any).tunnelId || 0);
      if (shouldCheckSourcePort) {
        const host = await db.getHostById(nextHostIdForRule);
        if (host) {
          let effectivePolicy = selectedTunnelForRule
            ? combineHostPortPolicyWithRange(
              host as any,
              (selectedTunnelForRule as any).portRangeStart,
              (selectedTunnelForRule as any).portRangeEnd,
            )
            : portPolicyFrom(host as any);
          if (!isPortAllowedByPolicy(nextSourcePortForRule, effectivePolicy)) {
            throw new Error(portPolicyErrorMessage(effectivePolicy, "源端口"));
          }
          assertTenantListenPortAllowed({ actor: ctx.user, host, port: nextSourcePortForRule, label: "源端口" });
          if (ctx.user.role !== "admin") {
            const planRange = await db.getUserPlanPortRange(ctx.user.id, nextHostIdForRule, nextTunnelIdForRule || undefined);
            if (planRange) {
              effectivePolicy = combinePortPolicies(effectivePolicy, portPolicyFrom({
                portRanges: planRange.ranges,
              }));
            }
            if (planRange && !isPortAllowedByPolicy(nextSourcePortForRule, effectivePolicy)) {
              const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
              throw new Error(`套餐端口必须在 ${ranges} 区间内`);
            }
          }
          const sourceReservation = await reserveRulePort(nextHostIdForRule, nextSourcePortForRule, nextProtocolForRule, rule.id, nextTunnelIdForRule);
          if (!sourceReservation) {
            throw await entryBridgeAwarePortError(
              await db.forwardRuleListenHostIds(nextHostIdForRule, nextTunnelIdForRule),
              nextSourcePortForRule,
              [rule.id],
              `端口 ${nextSourcePortForRule} 已被其他规则占用`,
            );
          }
        }
      }

      const { id, routeGroup: _routeGroupInput, ...data } = input;
      (data as any).hostId = nextHostIdForRule;
      if (input.targetIp !== undefined) (data as any).targetIp = normalizeRuleTargetIp(input.targetIp, { tunnelId: nextTunnelIdForRule });
      if (
        failoverFieldsProvided(input) ||
        routeChanged ||
        nextMainBackupEnabled !== requestedMainBackupEnabled
      ) {
        const clearable = mergeFailoverClearableFields(input, rule);
        Object.assign(data as any, normalizeFailoverInput({
          failoverEnabled: nextMainBackupEnabled,
          failoverStrategy: routeChanged ? "fallback" : input.failoverStrategy ?? (rule as any).failoverStrategy ?? "fallback",
          failoverTargets: nextMainBackupEnabled && !routeChanged ? (input.failoverTargets ?? parseFailoverTargets((rule as any).failoverTargets)) : [],
          failoverProbeTarget: nextMainBackupEnabled && !routeChanged ? clearable.failoverProbeTarget : null,
          failoverSchedule: nextMainBackupEnabled && !routeChanged ? clearable.failoverSchedule : null,
          failoverMinHoldSeconds: nextMainBackupEnabled && !routeChanged ? (input.failoverMinHoldSeconds ?? Number((rule as any).failoverMinHoldSeconds || 0)) : 0,
          failoverPinnedIndex: nextMainBackupEnabled && !routeChanged ? clearable.failoverPinnedIndex : null,
          failoverPinnedUntil: nextMainBackupEnabled && !routeChanged ? clearable.failoverPinnedUntil : null,
          failoverPreferFastest: nextMainBackupEnabled && !routeChanged ? (input.failoverPreferFastest ?? !!(rule as any).failoverPreferFastest) : false,
          failoverSeconds: routeChanged ? 60 : input.failoverSeconds ?? (rule as any).failoverSeconds,
          recoverSeconds: routeChanged ? 120 : input.recoverSeconds ?? (rule as any).recoverSeconds,
          autoFailback: routeChanged ? true : input.autoFailback ?? (rule as any).autoFailback,
          routeGroup: nextMainBackupEnabled && !routeChanged ? input.routeGroup : null,
        }, nextProtocolForRule, {
          rule: routeChanged ? null : rule,
          entryHostId: routeEntryHostId(Number(nextHostIdForRule), selectedTunnelForRule),
          hostIds: await routeHostIdsForActor(ctx.user),
          targetIp: (data as any).targetIp ?? (rule as any).targetIp,
          targetPort: input.targetPort ?? (rule as any).targetPort,
        }));
        await recordRoutePinChange(rule, data as any);
      }
      if (
        input.proxyProtocolReceive !== undefined ||
        input.proxyProtocolSend !== undefined ||
        input.proxyProtocolExitReceive !== undefined ||
        input.proxyProtocolExitSend !== undefined ||
        input.proxyProtocolVersion !== undefined ||
        input.tcpFastOpen !== undefined ||
        input.zeroCopy !== undefined ||
        input.udpOverTcp !== undefined ||
        input.udpOverTcpPort !== undefined ||
        input.protocol !== undefined ||
        input.forwardType !== undefined ||
        input.failoverEnabled !== undefined ||
        routeChanged
      ) {
        /*
          隧道规则的这些开关以隧道为准（和新建时一样取隧道的，见 tunnelRuntimeOptionInput）。换到另一条
          隧道时也要取新隧道的：以前换线路一律清空，换过去的规则和直接建在那条隧道上的不一样
          （比如入口不开 TCP Fast Open）。只有换成不走隧道时才清空。
        */
        const proxySource = nextTunnelIdForRule && selectedTunnelForRule
          ? tunnelRuntimeOptionInput(selectedTunnelForRule)
          : routeChanged
          ? {}
          : {
              proxyProtocolReceive: input.proxyProtocolReceive ?? (rule as any).proxyProtocolReceive,
              proxyProtocolSend: input.proxyProtocolSend ?? (rule as any).proxyProtocolSend,
              proxyProtocolExitReceive: input.proxyProtocolExitReceive ?? (rule as any).proxyProtocolExitReceive,
              proxyProtocolExitSend: input.proxyProtocolExitSend ?? (rule as any).proxyProtocolExitSend,
              proxyProtocolVersion: input.proxyProtocolVersion ?? (rule as any).proxyProtocolVersion,
              failoverEnabled: nextMainBackupEnabled,
            };
        Object.assign(data as any, normalizeProxyProtocolInput({
          ...proxySource,
          failoverEnabled: nextMainBackupEnabled,
        }, input.protocol ?? (rule as any).protocol, nextForwardTypeForRule, false, { clearUnsupported: true, tunnelRoute: !!nextTunnelIdForRule }));
      }
      if (
        input.tcpFastOpen !== undefined ||
        input.zeroCopy !== undefined ||
        input.udpOverTcp !== undefined ||
        input.udpOverTcpPort !== undefined ||
        input.protocol !== undefined ||
        input.forwardType !== undefined ||
        routeChanged
      ) {
        const transportSource = nextTunnelIdForRule && selectedTunnelForRule
          ? tunnelRuntimeOptionInput(selectedTunnelForRule)
          : routeChanged
          ? {}
          : {
              tcpFastOpen: input.tcpFastOpen ?? (rule as any).tcpFastOpen,
              zeroCopy: input.zeroCopy ?? (rule as any).zeroCopy,
              udpOverTcp: input.udpOverTcp ?? (rule as any).udpOverTcp,
              udpOverTcpPort: input.udpOverTcpPort ?? (rule as any).udpOverTcpPort,
            };
        const transportTuning = normalizeTransportTuningInput(transportSource, input.protocol ?? (rule as any).protocol, nextForwardTypeForRule, false, {
          clearUnsupported: true,
          tunnelRoute: !!nextTunnelIdForRule,
          forwardxTunnel: String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx",
        });
        Object.assign(data as any, transportTuning);
      }
      if ((data.forwardType ?? rule.forwardType) !== "gost") {
        (data as any).gostMode = "direct";
        (data as any).gostRelayHost = null;
        (data as any).gostRelayPort = null;
        (data as any).tunnelId = null;
        (data as any).tunnelExitPort = null;
        if ((data.forwardType ?? rule.forwardType) !== "realm") {
          (data as any).proxyProtocolReceive = false;
          (data as any).proxyProtocolSend = false;
        }
        (data as any).proxyProtocolExitReceive = false;
        (data as any).proxyProtocolExitSend = false;
        if (!(data as any).proxyProtocolReceive && !(data as any).proxyProtocolSend) {
          (data as any).proxyProtocolVersion = 1;
        }
      } else {
        (data as any).gostMode = "direct";
        (data as any).gostRelayHost = null;
        (data as any).gostRelayPort = null;
        const nextTunnelId = data.tunnelId !== undefined ? data.tunnelId : (rule as any).tunnelId;
        if (nextTunnelId) {
          const tunnel = selectedTunnelForRule ?? (await requireTunnelUseOrTrafficBillingAccess(ctx, nextTunnelId)).tunnel;
           if (!dbBool(tunnel.isEnabled)) throw new Error("所选隧道已停用");
          if (Number(tunnel.entryHostId) !== Number(nextHostIdForRule)) {
            throw new Error("所选隧道的入口 Agent 必须与规则所属主机一致");
          }
          const sameTunnel = Number(nextTunnelId) === Number((rule as any).tunnelId || 0);
          const existingExitPort = Number((rule as any).tunnelExitPort || 0);
          // Disabling an existing rule is a state change, not a request to
          // move its data-plane listener. In particular, a primary managed
          // GOST rule intentionally shares tunnel.listenPort. Passing
          // `enabled=false` to preferredSharedTunnelListenPort removes that
          // sharing exemption, so a one-port NAT range would report "no
          // available port" (or silently rotate the stored port) merely when
          // the user toggles the rule off.  Keep the old value as the next
          // enable's preference; the enabled path below will revalidate it
          // against the current NAT policy and repair it when necessary.
          const preserveDisabledExitPort = !nextRuleEnabled
            && sameTunnel
            && !routeChanged
            && existingExitPort > 0;
          if (preserveDisabledExitPort) {
            (data as any).tunnelExitPort = existingExitPort;
          } else {
            const exit = await db.getHostById(tunnel.exitHostId);
            // Repair a stale tunnel listener before assigning this rule's exit
            // port. Otherwise the rule could be pointed at a newly allocated
            // NAT port while the tunnel runtime keeps listening on the old one.
            const listenerRepair = usesSharedTunnelPrimaryListener(tunnel)
              ? await ensureTunnelListenerPortPolicy(tunnel, {
                hostId: Number(tunnel.exitHostId),
                syncSharedPrimaryRule: true,
              })
              : null;
            if (usesSharedTunnelPrimaryListener(tunnel) && !listenerRepair) {
              throw new Error("出口 Agent 已无可用隧道监听端口");
            }
            const sharedListenPort = await preferredSharedTunnelListenPort(
              tunnel,
              Number(rule.id),
              nextRuleEnabled,
            );
            let reservation: HostPortReservation | null = null;
            if (listenerRepair?.reservation && Number(sharedListenPort || 0) === listenerRepair.port) {
              reservation = listenerRepair.reservation;
            } else {
              listenerRepair?.reservation.release();
            }
            if (!reservation) {
              reservation = await reserveTunnelExitPort({
                hostId: Number(tunnel.exitHostId),
                preferredStart: (exit as any)?.portRangeStart,
                preferredEnd: (exit as any)?.portRangeEnd,
                currentPort: sharedListenPort ?? (sameTunnel ? existingExitPort : 0),
                excludeRuleIds: [Number(rule.id)],
                allowSameTunnelListener: Number(sharedListenPort || 0) > 0,
                excludeTunnelId: Number(tunnel.id),
                protocol: "both",
              });
            }
            if (!reservation) throw new Error("出口 Agent 已无可用隧道端口");
            tunnelExitPortReservationForUpdate = reservation;
            (data as any).tunnelExitPort = reservation.port;
          }
        } else {
          (data as any).tunnelExitPort = null;
          await db.clearForwardRuleTunnelExits(id);
        }
      }
       if (dbBool(data.isEnabled)) {
        const sourcePort = Number(data.sourcePort ?? rule.sourcePort);
        await assertRulePortWithinEntryPolicy({
          hostId: nextHostIdForRule,
          sourcePort,
          tunnelId: nextTunnelIdForRule,
          tunnel: selectedTunnelForRule,
          actor: ctx.user,
        });
        if (ctx.user.role !== "admin") {
          await assertRulePortWithinUserPlanRange({
            userId: ctx.user.id,
            hostId: nextHostIdForRule,
            sourcePort,
            tunnelId: nextTunnelIdForRule,
          });
        }
        const sourceReservation = await reserveRulePort(nextHostIdForRule, sourcePort, nextProtocolForRule, rule.id, nextTunnelIdForRule);
        if (!sourceReservation) {
          throw await entryBridgeAwarePortError(
            await db.forwardRuleListenHostIds(nextHostIdForRule, nextTunnelIdForRule),
            sourcePort,
            [rule.id],
            `端口 ${sourcePort} 已被占用，请更换端口后再启用`,
          );
        }
        (data as any).disabledByUser = false;
        (data as any).disabledByTunnel = false;
        (data as any).disabledByGroup = false;
        (data as any).protocolBlockReason = null;
      }
      await assertRuleTargetsAllowedForActor(ctx.user, { ...rule, ...data }, {
        hostId: nextHostIdForRule,
        tunnel: nextTunnelIdForRule ? selectedTunnelForRule : null,
      });
      await assertRouteRelayPortQuota(ctx.user, (data as any).routePaths !== undefined ? (data as any).routePaths : (rule as any).routePaths, Number(rule.id));
      // 关键字段变更时重置 isRunning
      const watchedFields: string[] = [
        "sourcePort",
        "targetIp",
        "targetPort",
        "forwardType",
        "protocol",
        "gostMode",
        "gostRelayHost",
        "gostRelayPort",
        "tunnelId",
        "tunnelExitPort",
        "hostId",
        "proxyProtocolReceive",
        "proxyProtocolSend",
        "proxyProtocolExitReceive",
        "proxyProtocolExitSend",
        "proxyProtocolVersion",
        "tcpFastOpen",
        "zeroCopy",
        "udpOverTcp",
        "udpOverTcpPort",
        "failoverEnabled",
        "failoverStrategy",
        "failoverTargets",
        /*
          下面这几样上一版不在这张单子里：只改它们的一次保存不推给 Agent。Agent 连着
          事件流时整轮对账是五分钟一次，配置变更全靠这一推 —— 于是「强制走 备用 1」
          点下去，最长五分钟后机器才照做，而这正是应急时用的按钮。它们都是能热更新的
          （见 isFailoverHotUpdate），推过去不会重启转发。
        */
        "failoverProbeTarget",
        "failoverSchedule",
        "failoverMinHoldSeconds",
        "failoverPinnedIndex",
        "failoverPinnedUntil",
        "failoverPreferFastest",
        "failoverSeconds",
        "recoverSeconds",
        "autoFailback",
        ...ROUTE_RULE_COLUMNS,
      ];
      const keyFieldChanged = watchedFields.some((f) => {
        const v = (data as any)[f];
        return v !== undefined && !sameStoredValue(v, (rule as any)[f]);
      });
      const failoverHotUpdate = keyFieldChanged
        && isFailoverHotUpdate(data as any, rule as any, nextHostIdForRule, nextTunnelIdForRule);
      const oldHostIdForRule = Number(rule.hostId);
      const hostChanged = Number(oldHostIdForRule) !== Number(nextHostIdForRule);
      // 换到别的入口主机：旧入口上的老端口先占住，写库后在那里留一条到新入口的临时桥接
      // （server/ruleEntryBridges），客户端不刷新订阅也不断。
      const entryBridgePlan = await prepareRuleEntryBridgeSwitch({
        rule,
        nextHostId: Number(nextHostIdForRule),
        nextTunnelId: nextTunnelIdForRule ? Number(nextTunnelIdForRule) : null,
        reservations: heldReservations,
      });
      const affectedTunnelIds = new Set<number>();
      if (keyFieldChanged && !failoverHotUpdate) {
        (data as any).isRunning = false;
        if ((rule as any).tunnelId) affectedTunnelIds.add((rule as any).tunnelId);
        if ((data as any).tunnelId) affectedTunnelIds.add((data as any).tunnelId);
        for (const affectedTunnelId of affectedTunnelIds) {
          await db.updateTunnel(affectedTunnelId, { isRunning: false } as any);
        }
      }
      await db.updateForwardRule(id, data);
      /**
       * 改完目标之后再认一次。
       *
       * 只在「改了目标、而且这条还没绑」时认 —— 手动解绑过的人不会顺手改目标，
       * 所以不会被面板又绑回去；已经绑着别的节点的更不动，那是他明确选过的。
       */
      // 走 Shadowsocks 出口的规则不自动绑订阅：它的目标不是「我的某个落地节点」，绑上去订阅里就是一条错的线路。
      const bindingChange = egressActiveAfterSave ? null : await autoBindProxyNodeForRule({
        ruleId: Number(id),
        userId: Number((rule as any).userId || ctx.user.id),
        targetIp: data.targetIp ?? (rule as any).targetIp,
        targetPort: Number(data.targetPort ?? (rule as any).targetPort),
        boundNodeId: Number((rule as any).proxyNodeId || 0),
        isCreate: false,
        previousTargetIp: (rule as any).targetIp,
        previousTargetPort: (rule as any).targetPort,
        targetChanged: String(data.targetIp ?? (rule as any).targetIp) !== String((rule as any).targetIp)
          || Number(data.targetPort ?? (rule as any).targetPort) !== Number((rule as any).targetPort),
      });
      // The mapping reconciler performs its own per-endpoint reservation. Do
      // not leave the primary reservation held while it runs; release is
      // idempotent and the finalizer below still covers error paths.
      tunnelExitPortReservationForUpdate?.release();
      tunnelExitPortReservationForUpdate = null;
      if ((data.forwardType ?? rule.forwardType) === "gost") {
        const activeTunnelId = Number(nextTunnelIdForRule || 0);
        if (activeTunnelId) {
          const tunnel = selectedTunnelForRule ?? await db.getTunnelById(activeTunnelId);
          if (tunnel) {
            await db.reconcileForwardRuleTunnelExits(
              { ...rule, ...data, id, tunnelId: activeTunnelId, tunnelExitPort: (data as any).tunnelExitPort ?? (rule as any).tunnelExitPort },
              tunnel,
            );
          }
        } else {
          await db.clearForwardRuleTunnelExits(id);
        }
      } else {
        await db.clearForwardRuleTunnelExits(id);
      }
      // 桥接要在通知旧入口之前落库：旧入口下一次心跳就该拿到「撤规则 + 起桥接」，中间不留空档。
      await applyRuleEntryBridgeSwitch(entryBridgePlan, "forward-rule-entry-bridge");
      // 规则和出口映射都写完之后再通知隧道各端（推送会顺带作废出口机缓存的稳定心跳计划）：
      // 先推的话，Agent 或心跳缓存可能在写入前就按旧规则算好配置，出口机之后不会再被提醒。
      for (const affectedTunnelId of affectedTunnelIds) {
        const affectedTunnel = await db.getTunnelById(affectedTunnelId);
        if (affectedTunnel) await pushTunnelEndpointRefresh(affectedTunnel, "forward-rule-updated");
      }
      if (keyFieldChanged) {
        if (hostChanged) {
          pushAgentRefresh(oldHostIdForRule, "forward-rule-updated-old-host");
          pushAgentRefresh(Number(nextHostIdForRule), "forward-rule-updated-new-host");
        } else if (!nextTunnelIdForRule) {
          pushAgentRefresh(Number(nextHostIdForRule), "forward-rule-updated");
        } else if (failoverHotUpdate) {
          const tunnel = await db.getTunnelById(nextTunnelIdForRule);
          if (tunnel) await pushTunnelEndpointRefresh(tunnel, "forward-rule-failover-hot-update");
          else pushAgentRefresh(Number(nextHostIdForRule), "forward-rule-failover-hot-update");
        }
      }
      // 线路组的中转：缺的建、多的收、dial 写回，再推一次入口（见 server/routeGroups.ts）。
      await syncRouteGroupAfterSave(id, "forward-rule-updated");
      return {
        success: true,
        reset: keyFieldChanged && !failoverHotUpdate,
        hotUpdated: failoverHotUpdate,
        // 订阅那边的绑定跟着目标变了没有；界面据此说一句，别让它悄悄发生。
        proxyNodeBinding: bindingChange
          ? {
            kind: bindingChange.kind,
            name: bindingChange.kind === "released" ? "" : bindingChange.name,
            previousName: bindingChange.kind === "bound" ? "" : bindingChange.previousName,
          }
          : null,
      };
      } finally {
        tunnelExitPortReservationForUpdate?.release();
        tunnelExitPortReservationForConversion?.release();
        releaseHostPortReservations(heldReservations);
      }
    });
      if (egressPlan) await applyRuleEgressUpdate(Number(input.id), egressPlan);
      return updateResult;
    }),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => deleteForwardRuleForActor(ctx.user, input.id)),
  deleteBatch: protectedProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      const ids = Array.from(new Set(input.ids.map(Number)));
      const results = await mapWithConcurrency(ids, 8, async (id) => {
        try {
          await deleteForwardRuleForActor(ctx.user, id, { reasonPrefix: "batch-forward-rule" });
          return { id, success: true as const };
        } catch (error) {
          return {
            id,
            success: false as const,
            error: error instanceof Error ? error.message : String(error || "删除失败"),
          };
        }
      });
      const deletedIds = results.filter((item) => item.success).map((item) => item.id);
      const failures = results.filter((item): item is Extract<typeof item, { success: false }> => !item.success);
      return {
        success: failures.length === 0,
        requested: ids.length,
        deletedIds,
        failures,
      };
    }),
  toggle: protectedProcedure
    .input(z.object({ id: z.number(), isEnabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => toggleForwardRuleForActor(ctx.user, input.id, input.isEnabled))
});
