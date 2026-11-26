import { ruleChainLatency, ruleTargetLatency, ruleTunnelOf, tunnelExitLatency } from "./ruleLatencyView";
import { appendPanelLog } from "./_core/panelLogger";
import { dbBool } from "./repositories/repositoryUtils";
import { ExitTargetPushDebouncer } from "./exitTargetPush";
import { getForwardRulesByIds } from "./repositories/forwardRuleRepository";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import { getRuleLatencyFloors } from "./repositories/metricsRepository";
import { getHostNamesByIds } from "./repositories/hostRepository";
import { getTunnelEntryHostIds, getTunnelExitNodesByTunnelIds, getTunnelsByIds } from "./repositories/tunnelRepository";
import { type BalanceDetect, DEFAULT_BALANCE_DETECT, normalizeBalanceDetect, normalizeExitGroupStrategy } from "../shared/loadBalance";
import { liveBalanceForRule, liveBalanceForTunnel, type LiveExit, type LiveRuleReport } from "./balanceLive";

/*
  负载均衡链路：每台出口「连得上规则的目标吗」（2026-11，用户：「规则都这样了，链路负载均衡还是没切机器」）。

  以前规则的端到端探测只从主出口测、只用来显示红点。三台出口里一台到落地丢包，负载均衡照样往它那儿分。

  现在面板给负载均衡链路上的每台出口都下发一条快速探测（线路组「下一跳」那条通道，Agent 2.2.258 起会探，
  2.2.259 起多报中位数 / 抖动 / 丢包，见 agent/route_hop_probe.go），按链路的「检测与切换」节奏探规则的目标，
  翻转立刻报。面板在这里记下来：

    · 规则卡、链路卡的弹窗上写清楚是哪台出口连不上、抖、丢包；
    · GOST 隧道没法在一条连接里换出口：连不上目标的出口从这条规则的出口列表里摘掉（热更新，不断连接），
      恢复后加回；全都连不上时不摘（那是目标的问题，摘光等于断服）。
    · NEX 隧道（FXP 2.2.142 起）入口自己会当场换出口，这里只用来显示。

  只记在内存里：面板重启后 Agent 下一次全量（30 秒内）就补上。90 秒没报算过期，当不知道。
*/

export const EXIT_TARGET_STALE_MS = 90_000;
/** 老 Agent（不报 intervalMs）连不上以后最久多久探一次：最长退避 60 秒 + 10% 抖动。 */
export const EXIT_TARGET_LEGACY_MAX_INTERVAL_MS = 66_000;
/** 「连不上」多旧算旧：超过「两倍探测间隔 + 这么多」。要盖住 Agent 30 秒一次的全量（不翻转时只有它带新的 ageMs）。 */
export const EXIT_TARGET_PROBE_SLACK_MS = 40_000;
const UNSTABLE_LOSS_PCT = 10;

export type ExitTargetReport = {
  ruleId: number;
  down: boolean;
  latencyMs?: number | null;
  medianMs?: number | null;
  jitterMs?: number | null;
  lossPct?: number | null;
  samples?: number | null;
  /** Agent 2.2.260 起：这条路的最低延迟、来源（traffic = 真实连接的内核 RTT，probe = 主动探测）、活跃连接数 */
  minMs?: number | null;
  source?: string | null;
  conns?: number | null;
  /**
   * 2.2.264 之后的 Agent 起：这条结论是多久前探出来的（毫秒）、现在多久探一次（含连不上以后的退避）。面板拿它判断
   * 「连不上」是不是已经旧了（exitTargetDownStale）。老 Agent 不报。
   */
  ageMs?: number | null;
  intervalMs?: number | null;
};

export type ExitTargetState = {
  ruleId: number;
  tunnelId: number;
  hostId: number;
  hostName: string;
  down: boolean;
  latencyMs: number | null;
  medianMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  samples: number;
  at: number;
  changedAt: number;
  /** 按链路的「检测与切换」算出来的：抖动 / 丢包超过门槛 */
  unstable: boolean;
  /** GOST 隧道（不能少分，只能摘掉连不上的） */
  gost: boolean;
  minMs?: number | null;
  source?: "traffic" | "probe" | null;
  conns?: number | null;
  /**
   * 抖动从什么时候起一直超过门槛（null = 现在没超）。「持续多久才处理」（jitterHoldSeconds）按它算。
   * 不带这个字段（undefined）= 调用方没记持续时间，只按这一次的数判断。
   */
  jitterSince?: number | null;
  /**
   * 现在这条结论（通 / 不通）最晚是什么时候探出来的（面板的时刻）。Agent 报了 ageMs 就是「收到的时刻 − ageMs」；
   * 老 Agent：翻转那一份是刚探的，全量那几份只知道「最多一个最长退避之前探过」（EXIT_TARGET_LEGACY_MAX_INTERVAL_MS）。
   * 不带（测试手搭的）当成 at。
   */
  probedAt?: number;
  /** Agent 现在多久探一次（含退避，毫秒）；null / 不带 = 老 Agent，不知道 */
  probeIntervalMs?: number | null;
};

/*
  按规则分开放（规则 → 出口机 → 状态）：查一条规则的各台出口直接取，不用把所有规则的状态扫一遍
  （以前是一张平的表，每条规则每次下发、每次汇总都从头扫到尾）。
*/
const statesByRule = new Map<number, Map<number, ExitTargetState>>();
/** 最近一次收到报告时链路的样子（出口顺序、分配方式、手动指定）。 */
const tunnelMetaById = new Map<number, { tunnel: TunnelRow; order: number[]; at: number }>();

function getState(ruleId: number, hostId: number) {
  return statesByRule.get(Number(ruleId))?.get(Number(hostId));
}

function putState(state: ExitTargetState) {
  let byHost = statesByRule.get(state.ruleId);
  if (!byHost) {
    byHost = new Map();
    statesByRule.set(state.ruleId, byHost);
  }
  byHost.set(state.hostId, state);
}

function* allStates() {
  for (const byHost of statesByRule.values()) yield* byHost.values();
}

/*
  每台出口到每条规则目标的「平时水平」（2.3.536，用户：「延迟抖动的判断方法不准」）。

  固定门槛判不准：目标近的规则平时 7ms，目标远的平时 200ms，同一个「抖动超过 30ms」对谁都不合适。这里按
  （规则, 出口）记一个平时值，每 5 分钟更新一次：
    · 平时延迟 = 这条路的最低延迟（用户：「一般规则延迟记录的最小延迟是平时正常延迟」—— 最低延迟就是路程本身，
      高出来的都是排队、抖动）。量到更低的马上跟下来；量到的最低值比平时高，只按约 6 小时的时间常数慢慢往上跟
      （路由真的换远了，几个小时后平时值跟上；一阵子拥堵不会把平时值带歪）。
    · 平时抖动：头一小时取平均，之后同样约 6 小时平滑（偏离太多的那次先按 3 倍封顶再算）。
  判断时跟它比：抖动要同时超过「检测与切换」的门槛和「平时的 2 倍 + 5ms」才算不稳；延迟比平时高出「延迟差多少
  才换」那么多，弹窗写「比平时慢」。

  只记在内存里，每 10 分钟存一份到设置表（面板重启后接着用）。超过 3 天没更新的丢掉。
*/
export type ExitTargetBaseline = { normalMs: number; jitterMs: number; samples: number; updatedAt: number };
const BASELINE_STEP_MS = 5 * 60_000;
const BASELINE_READY_SAMPLES = 6;
const BASELINE_WARMUP_SAMPLES = 12;
const BASELINE_ALPHA = 5 / 360;
const BASELINE_MAX_AGE_MS = 3 * 24 * 3600_000;
const BASELINE_SAVE_EVERY_MS = 10 * 60_000;
const BASELINE_SETTING_KEY = "exitTargetBaselines";
const BASELINE_MAX_ENTRIES = 6000;
const baselines = new Map<string, ExitTargetBaseline>();
let baselinesLoaded = false;
let baselinesSavedAt = 0;
let baselinesDirty = false;

async function loadBaselines() {
  if (baselinesLoaded) return;
  baselinesLoaded = true;
  try {
    const raw = await getSetting(BASELINE_SETTING_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, [number, number, number, number]> : {};
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value) || value.length < 4) continue;
      const [normalMs, jitterMs, samples, updatedAt] = value.map(Number);
      if (![normalMs, jitterMs, samples, updatedAt].every(Number.isFinite) || now - updatedAt > BASELINE_MAX_AGE_MS) continue;
      if (!baselines.has(key)) baselines.set(key, { normalMs, jitterMs, samples, updatedAt });
    }
  } catch {
    // 读不到 / 坏了：从头记
  }
}

async function saveBaselinesIfDue(nowMs: number) {
  if (!baselinesDirty || nowMs - baselinesSavedAt < BASELINE_SAVE_EVERY_MS) return;
  baselinesSavedAt = nowMs;
  baselinesDirty = false;
  const entries = Array.from(baselines.entries())
    .filter(([, value]) => nowMs - value.updatedAt <= BASELINE_MAX_AGE_MS)
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, BASELINE_MAX_ENTRIES);
  const payload: Record<string, [number, number, number, number]> = {};
  for (const [key, value] of entries) {
    payload[key] = [Math.round(value.normalMs * 10) / 10, Math.round(value.jitterMs * 10) / 10, value.samples, value.updatedAt];
  }
  await setSetting(BASELINE_SETTING_KEY, JSON.stringify(payload)).catch(() => { baselinesDirty = true; });
}

/*
  从转发规则的延迟记录起步（用户：「一般规则延迟记录的最小延迟是平时正常延迟」）：这台机器以前就在测这条规则
  （主出口一直在测）的，拿它最近 24 小时记录里的最低延迟当平时延迟，马上就能用，不用等半小时。
  每个（规则, 出口）只查一次；查不到的照常自己攒。
*/
// 值是哪一刻查的：半小时后清掉（pruneExitTargetMemory），之后这对（规则, 出口）还在报的话再查一次。
const baselineSeedTried = new Map<string, number>();
const BASELINE_SEED_WINDOW_MS = 24 * 3600_000;

async function seedBaselinesFromRuleRecords(hostId: number, ruleIds: number[], nowMs: number) {
  const missing = ruleIds.filter((ruleId) => {
    const key = stateKey(ruleId, hostId);
    return !baselines.has(key) && !baselineSeedTried.has(key);
  });
  if (missing.length === 0) return;
  for (const ruleId of missing) baselineSeedTried.set(stateKey(ruleId, hostId), nowMs);
  const floors = await getRuleLatencyFloors(hostId, missing, new Date(nowMs - BASELINE_SEED_WINDOW_MS)).catch(() => new Map<number, number>());
  for (const [ruleId, floor] of floors) {
    const key = stateKey(ruleId, hostId);
    if (baselines.has(key)) continue;
    // 抖动没有可靠的历史（以前那套记录算不准抖动），先记 0：不稳只按门槛判，攒起来后再跟
    baselines.set(key, { normalMs: floor, jitterMs: 0, samples: BASELINE_READY_SAMPLES, updatedAt: nowMs });
    baselinesDirty = true;
  }
}

/** 这台出口到这条规则目标的平时水平；还没攒够（半小时）返回 null。 */
/** 入口上报的真实延迟也拿来攒「平时延迟」（2.3.539：出口不再另外测目标之后，平时值从这里来）。 */
export async function noteLiveBaselines(reports: LiveRuleReport[], nowMs = Date.now()) {
  if (reports.length === 0) return;
  await loadBaselines();
  for (const report of reports) {
    for (const exit of report.exits) {
      if (exit.hostId <= 0 || exit.state === "down" || exit.medianMs == null) continue;
      updateExitTargetBaseline({
        ruleId: report.ruleId, tunnelId: report.tunnelId, hostId: exit.hostId, hostName: exit.hostName,
        down: false, latencyMs: exit.medianMs, medianMs: exit.medianMs, jitterMs: exit.jitterMs, lossPct: exit.lossPct,
        samples: exit.samples, at: nowMs, changedAt: nowMs, unstable: exit.state === "unstable", gost: report.source === "agent",
      }, nowMs);
    }
  }
  await saveBaselinesIfDue(nowMs);
}

export function exitTargetBaseline(ruleId: number, hostId: number): ExitTargetBaseline | null {
  const value = baselines.get(stateKey(ruleId, hostId));
  return value && value.samples >= BASELINE_READY_SAMPLES ? value : null;
}

/** 拿一次新的结果更新平时值（每 5 分钟最多一次；连不上的、样本太少的不算）。 */
export function updateExitTargetBaseline(state: ExitTargetState, nowMs: number) {
  const median = state.medianMs ?? state.latencyMs;
  if (state.down || median == null || (state.samples || 0) < 5) return;
  // 这一次的最低延迟：Agent 2.2.260 起报 minMs（窗口里最低的一次 / 真实连接的最小 RTT），老的没有就拿中位数
  const floor = state.minMs != null && state.minMs > 0 ? Math.min(state.minMs, median) : median;
  const key = stateKey(state.ruleId, state.hostId);
  const current = baselines.get(key);
  if (current && nowMs - current.updatedAt < BASELINE_STEP_MS) return;
  const jitter = state.jitterMs ?? 0;
  if (!current || nowMs - current.updatedAt > BASELINE_MAX_AGE_MS) {
    baselines.set(key, { normalMs: floor, jitterMs: jitter, samples: 1, updatedAt: nowMs });
  } else {
    const samples = current.samples + 1;
    const alpha = samples <= BASELINE_WARMUP_SAMPLES ? 1 / samples : BASELINE_ALPHA;
    const cappedJitter = Math.min(jitter, current.jitterMs * 3 + 5);
    // 更低的马上跟下来；头一小时就是取最低，之后更高的才慢慢往上跟（先按 3 倍封顶）
    const normalMs = floor <= current.normalMs
      ? floor
      : samples <= BASELINE_WARMUP_SAMPLES
        ? current.normalMs
        : current.normalMs + (Math.min(floor, current.normalMs * 3 + 5) - current.normalMs) * BASELINE_ALPHA;
    baselines.set(key, {
      normalMs,
      jitterMs: current.jitterMs + (cappedJitter - current.jitterMs) * alpha,
      samples: Math.min(samples, 100000),
      updatedAt: nowMs,
    });
  }
  baselinesDirty = true;
}

/** 只给测试用：放一份链路的出口顺序 */
export function setExitTargetTunnelMetaForTest(tunnel: TunnelRow, order: number[]) {
  tunnelMetaById.set(Number(tunnel.id), { tunnel, order, at: Date.now() });
}

/** 只给测试用：不管攒没攒够都返回 */
export function peekExitTargetBaselineForTest(ruleId: number, hostId: number) {
  return baselines.get(stateKey(ruleId, hostId)) || null;
}

/** 只给测试用 */
export function setExitTargetBaselineForTest(ruleId: number, hostId: number, value: ExitTargetBaseline | null) {
  if (value) baselines.set(stateKey(ruleId, hostId), value);
  else baselines.delete(stateKey(ruleId, hostId));
}

function stateKey(ruleId: number, hostId: number) {
  return `${ruleId}:${hostId}`;
}

function finiteOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 链路换了拓扑（server/tunnelTopologyChange.ts）：这条链路上各规则的出口快速探测状态、「每台都连不上」的记账、摘除记忆和
 * 记下的出口顺序都是旧路线的，整段忘掉。不忘的话换完出口的头 90 秒里规则卡的「经 xxx」、诊断从哪台测还按旧出口算。
 */
export function forgetExitTargetTunnel(tunnelId: number, ruleIds: readonly number[] = []) {
  for (const ruleId of ruleIds) {
    statesByRule.delete(Number(ruleId));
    allDownByRule.delete(Number(ruleId));
    excludedMemoByRule.delete(Number(ruleId));
  }
  if (Number(tunnelId) > 0) tunnelMetaById.delete(Number(tunnelId));
}

/** 只给测试用 */
export function resetExitTargetStates() {
  statesByRule.clear();
  allDownByRule.clear();
  tunnelMetaById.clear();
  excludedMemoByRule.clear();
  lastFlipAt.clear();
  flipPushesInstance?.clear();
  lastPrunedAt = 0;
  baselines.clear();
  baselineSeedTried.clear();
  baselinesLoaded = true;
  baselinesDirty = false;
}

/** 只给测试用：直接放一条状态（不走数据库校验） */
export function setExitTargetStateForTest(state: ExitTargetState) {
  putState(state);
}

type TunnelRow = {
  id: number;
  mode?: string | null;
  balancePinHostId?: number | null;
  entryHostId?: number | null;
  entryGroupId?: number | null;
  exitHostId?: number | null;
  loadBalanceEnabled?: unknown;
  loadBalanceStrategy?: string | null;
  balanceDetect?: string | null;
};

/** 这条链路是不是「几台出口一起分」的负载均衡。 */
export function tunnelBalancesExits(tunnel: TunnelRow | null | undefined) {
  return !!tunnel && dbBool(tunnel.loadBalanceEnabled);
}

/** 链路的检测参数（没设 = 默认值）。 */
export function tunnelBalanceDetect(tunnel: TunnelRow | null | undefined): BalanceDetect {
  return normalizeBalanceDetect(tunnel?.balanceDetect ?? null, DEFAULT_BALANCE_DETECT);
}

/**
 * 给 Agent 的快速探测规格（和线路组「下一跳」同一种）：出口机探规则目标。
 * 节拍用 targetProbeSeconds（默认 10 秒），不用探出口机的 intervalSeconds：目标是别人的机器，高防目标会把每一两秒
 * 就连一下的出口 IP 拉黑（2.3.541 用户反馈）。Agent 对 passive 规格最多认 300 秒（agent/route_hop_probe.go）。
 */
export function exitTargetProbeSpec(detect: BalanceDetect) {
  const intervalMs = Math.max(1000, detect.targetProbeSeconds * 1000);
  return {
    intervalMs,
    timeoutMs: Math.min(5000, Math.max(1500, intervalMs)),
    failThreshold: detect.failThreshold,
    recoverOks: detect.recoverThreshold,
    // Agent 2.2.260 起：有到这个目标的真实连接就读内核记的 RTT，不再新建连接去探（老 Agent 不认这个字段）
    passive: true,
  };
}

/**
 * 不稳：丢包 ≥ 10%，或者抖动同时超过门槛和「平时的 2 倍 + 5ms」（还没有平时值时只看门槛）。
 * 一条路平时就晃 40ms，门槛 30ms 时它不该一直挂着「不稳」；平时 2ms 突然晃到 40ms 才是真抖。
 */
export function exitTargetUnstable(
  state: Pick<ExitTargetState, "jitterMs" | "lossPct" | "samples"> & Partial<Pick<ExitTargetState, "jitterSince" | "at">>,
  detect: BalanceDetect,
  baseline?: Pick<ExitTargetBaseline, "jitterMs"> | null,
) {
  if (detect.jitterAction === "ignore") return false;
  if ((state.samples || 0) < 5) return false;
  if ((state.lossPct ?? 0) >= UNSTABLE_LOSS_PCT) return true;
  if (!exitTargetJittery(state, detect, baseline)) return false;
  /*
    抖动要持续「持续多久才处理」（jitterHoldSeconds，默认 30 秒）才算不稳（C3）：界面上一直有这一项，以前这里
    没看它 —— 一次抖动大的样本就把这台标成不稳，延迟优先马上把它排到后面，下一次样本正常又排回来。
    丢包不等：它本来就是最近一段样本的比例，不是单次的数。
  */
  if (state.jitterSince === undefined) return true;
  return state.jitterSince !== null
    && (state.at ?? Date.now()) - state.jitterSince >= Math.max(0, detect.jitterHoldSeconds) * 1000;
}

/** 这一次的抖动超没超：同时超过门槛和「平时的 2 倍 + 5ms」（不管持续了多久）。 */
function exitTargetJittery(
  state: Pick<ExitTargetState, "jitterMs" | "samples">,
  detect: BalanceDetect,
  baseline?: Pick<ExitTargetBaseline, "jitterMs"> | null,
) {
  if (detect.jitterAction === "ignore" || (state.samples || 0) < 5) return false;
  const jitter = state.jitterMs ?? 0;
  if (jitter <= detect.jitterMs) return false;
  return !baseline || jitter > baseline.jitterMs * 2 + 5;
}

/**
 * 收一台机器报上来的快速探测：只认「这条规则走负载均衡链路、这台机器是它的出口之一」的。
 * 其余的（线路组下一跳那些）原样留给 routeGroups.ingestRouteHopFastReports。
 */
export async function ingestExitTargetReports(input: {
  hostId: number;
  hostName: string;
  results: readonly ExitTargetReport[];
  nowMs?: number;
}) {
  const hostId = Number(input.hostId);
  const nowMs = input.nowMs ?? Date.now();
  const reports = (input.results || []).filter((report) => Number(report.ruleId) > 0).slice(0, 2048);
  if (reports.length === 0 || hostId <= 0) return { recorded: 0, flipped: [] as number[] };
  await loadBaselines();
  await seedBaselinesFromRuleRecords(hostId, Array.from(new Set(reports.map((report) => Number(report.ruleId)))), nowMs);
  const rules = await getForwardRulesByIds(Array.from(new Set(reports.map((report) => Number(report.ruleId))))) as Array<{ id: number; tunnelId?: number | null; pendingDelete?: unknown; routeParentRuleId?: number | null }>;
  const ruleById = new Map(rules.map((rule) => [Number(rule.id), rule]));
  const tunnelIds = Array.from(new Set(rules.map((rule) => Number(rule.tunnelId || 0)).filter((id) => id > 0)));
  if (tunnelIds.length === 0) return { recorded: 0, flipped: [] as number[] };
  const [tunnels, exitNodes] = await Promise.all([
    getTunnelsByIds(tunnelIds) as Promise<TunnelRow[]>,
    getTunnelExitNodesByTunnelIds(tunnelIds) as Promise<Array<{ tunnelId: number; hostId: number; isEnabled?: unknown }>>,
  ]);
  const tunnelById = new Map(tunnels.map((tunnel) => [Number(tunnel.id), tunnel]));
  const exitHostsByTunnel = new Map<number, Set<number>>();
  for (const tunnel of tunnels) exitHostsByTunnel.set(Number(tunnel.id), new Set([Number(tunnel.exitHostId || 0)]));
  for (const node of exitNodes) exitHostsByTunnel.get(Number(node.tunnelId))?.add(Number(node.hostId));
  // 记下链路的出口顺序和分配方式：规则卡、诊断要知道「现在实际走哪台」（ruleActiveExit），不想每次再查库
  for (const tunnel of tunnels) {
    const order = [Number(tunnel.exitHostId || 0), ...exitNodes
      .filter((node) => Number(node.tunnelId) === Number(tunnel.id) && dbBool(node.isEnabled ?? true))
      .map((node) => Number(node.hostId))]
      .filter((hostId, index, list) => hostId > 0 && list.indexOf(hostId) === index);
    tunnelMetaById.set(Number(tunnel.id), { tunnel, order, at: nowMs });
  }
  let hostName = String(input.hostName || "").trim();
  if (!hostName) hostName = (await getHostNamesByIds([hostId])).get(hostId) || `主机 ${hostId}`;
  let recorded = 0;
  const flipped: number[] = [];
  // 入口机 → 这一轮要它重新拿配置的理由里最急的那个（见 exitTargetPush.ts）。
  const refreshRequests = new Map<number, { urgent: boolean; notBefore: number }>();
  const entryHostIdsByTunnel = new Map<number, number[]>();
  const entryHostIdsOf = async (tunnel: TunnelRow) => {
    const tunnelId = Number(tunnel.id);
    const cached = entryHostIdsByTunnel.get(tunnelId);
    if (cached) return cached;
    // 入口是入口组：组里每台都替这条链路监听，都要推
    const list = await getTunnelEntryHostIds(tunnel).catch(() => [Number(tunnel.entryHostId || 0)].filter((id) => id > 0));
    entryHostIdsByTunnel.set(tunnelId, list);
    return list;
  };
  for (const report of reports) {
    const rule = ruleById.get(Number(report.ruleId));
    if (!rule || dbBool(rule.pendingDelete) || Number(rule.routeParentRuleId || 0) > 0) continue;
    const tunnel = tunnelById.get(Number(rule.tunnelId || 0));
    if (!tunnel || !tunnelBalancesExits(tunnel) || !exitHostsByTunnel.get(Number(tunnel.id))?.has(hostId)) continue;
    const previous = getState(Number(rule.id), hostId);
    const detect = tunnelBalanceDetect(tunnel);
    const next: ExitTargetState = {
      ruleId: Number(rule.id),
      tunnelId: Number(tunnel.id),
      hostId,
      hostName,
      down: !!report.down,
      latencyMs: finiteOrNull(report.latencyMs),
      medianMs: finiteOrNull(report.medianMs),
      jitterMs: finiteOrNull(report.jitterMs),
      lossPct: finiteOrNull(report.lossPct),
      samples: Math.max(0, Math.round(Number(report.samples) || 0)),
      at: nowMs,
      changedAt: previous?.changedAt ?? nowMs,
      unstable: false,
      gost: String(tunnel.mode || "").toLowerCase() !== "forwardx",
      minMs: finiteOrNull(report.minMs),
      source: report.source === "traffic" ? "traffic" : report.source === "probe" ? "probe" : null,
      conns: finiteOrNull(report.conns),
    };
    const ageMs = finiteOrNull(report.ageMs);
    const intervalMs = finiteOrNull(report.intervalMs);
    next.probeIntervalMs = intervalMs != null && intervalMs > 0 ? intervalMs : null;
    if (ageMs != null) next.probedAt = nowMs - Math.min(ageMs, EXIT_TARGET_FORGET_MS);
    else if (!previous || previous.down !== next.down) next.probedAt = previous ? nowMs : nowMs - EXIT_TARGET_LEGACY_MAX_INTERVAL_MS;
    else next.probedAt = Math.max(previous.probedAt ?? previous.at, nowMs - EXIT_TARGET_LEGACY_MAX_INTERVAL_MS);
    const baseline = exitTargetBaseline(Number(rule.id), hostId);
    next.jitterSince = exitTargetJittery(next, detect, baseline) ? (previous?.jitterSince ?? nowMs) : null;
    next.unstable = exitTargetUnstable(next, detect, baseline);
    const wasBad = !!previous && (previous.down || previous.unstable);
    const isBad = next.down || next.unstable;
    updateExitTargetBaseline(next, nowMs);
    if (!previous || previous.down !== next.down || wasBad !== isBad) next.changedAt = nowMs;
    putState(next);
    recorded += 1;
    if (previous && previous.down !== next.down) {
      flipped.push(Number(rule.id));
      appendPanelLog(next.down ? "warn" : "info", `[LoadBalance] rule=${rule.id} 出口 ${hostName} ${next.down ? "连不上目标" : "到目标恢复"}（tunnel=${tunnel.id}）`);
    }
    // NEX 隧道入口自己会换出口，不用推；下面只管 GOST。
    if (String(tunnel.mode || "").toLowerCase() === "forwardx") continue;
    const ruleId = Number(rule.id);
    const exitIds = Array.from(exitHostsByTunnel.get(Number(tunnel.id)) || []).filter((id) => id > 0);
    // 「每台都连不上」刚结束：记下时刻，在这之前探出来的「连不上」从此算旧的（exitTargetDownStale）
    noteExitTargetAllDown(ruleId, exitIds, nowMs);
    /*
      要不要让入口重新拿配置，看「下发出去的东西变没变」，不看「这台出口翻没翻」（C2 / C3）：
        · 摘掉的出口变了（exitTargetExcludedHostIds 的结果）。每台都连不上时一台都不摘，这时候各台再怎么
          翻，下发的都是同一份 —— 以前每翻一次推一次。
        · 面板重启后第一次听到的就是「连不上」（没有上一次的状态可比）：以前要等它再翻一次才推，那台有问题
          的出口要在轮转里多待到下一次整份心跳。现在没记过的当成「一台都没摘」，和重启后下发的那份一致，
          一比就知道要推。
    */
    const excluded = exitIds.length > 1 ? Array.from(exitTargetExcludedHostIds(ruleId, exitIds, nowMs)).sort((left, right) => left - right) : [];
    const excludedKey = excluded.join(",");
    const previousExcludedKey = excludedMemoByRule.get(ruleId)?.key ?? "";
    excludedMemoByRule.set(ruleId, { key: excludedKey, at: nowMs });
    let urgent = false;
    let notBefore = 0;
    let push = false;
    if (excludedKey !== previousExcludedKey) {
      push = true;
      const before = new Set(previousExcludedKey ? previousExcludedKey.split(",").map(Number) : []);
      const after = new Set(excluded);
      for (const exitHostId of new Set([...before, ...after])) {
        if (before.has(exitHostId) === after.has(exitHostId)) continue;
        const flipKey = stateKey(ruleId, exitHostId);
        // 30 秒内的前几次翻转（不含这一次）
        const recent = (lastFlipAt.get(flipKey) || []).filter((at) => nowMs - at < EXIT_TARGET_FLIP_REPEAT_MS);
        const lastAt = recent[recent.length - 1] || 0;
        lastFlipAt.set(flipKey, [...recent, nowMs].slice(-4));
        if (after.has(exitHostId)) {
          // 这条规则的这台出口头一回连不上：马上推（一台入口一秒最多一次）。30 秒内又翻的走合并。
          if (recent.length === 0) urgent = true;
        } else if (recent.length <= 1) {
          /*
            摘掉以后头一回恢复：马上加回去。出口那边已经连着探通 RecoverOks 次才报「通了」，入口加回去还有慢启动，
            不用再等。以前这里一律等到离上一次翻转满 30 秒 —— 实验室里断 10 秒又恢复的出口，Agent 9 秒内就报了恢复，
            GOST 还是过了 30 秒才分到它（NEX 隧道 9 秒）。
          */
          urgent = true;
        } else {
          // 30 秒里已经摘了又放、又摘了（来回翻）：等它离上一次翻转满 30 秒再加回去，别跟着它来回热更新。
          notBefore = Math.max(notBefore, lastAt + EXIT_TARGET_FLIP_REPEAT_MS);
        }
      }
    }
    if (!push) continue;
    for (const entryHostId of await entryHostIdsOf(tunnel)) {
      const current = refreshRequests.get(entryHostId);
      // 一台入口这一轮有好几个理由：有一个要紧急就紧急；都不急时按最早能发的那个。
      refreshRequests.set(entryHostId, current
        ? { urgent: current.urgent || urgent, notBefore: Math.min(current.notBefore, notBefore) }
        : { urgent, notBefore });
    }
  }
  for (const [entryHostId, request] of refreshRequests) flipPushes().request(entryHostId, request);
  pruneExitTargetMemory(nowMs);
  await saveBaselinesIfDue(nowMs);
  return { recorded, flipped };
}

/**
 * 一条链路每台出口到目标的情况（链路卡上点「负载均衡 ×N」的弹窗用）：每台出口取它在各条规则上最差的那次，
 * 再数一数几条规则连不上 / 不稳。
 */
type ExitTargetExitSummary = {
  hostId: number;
  /** 有数据的规则条数 */
  rules: number;
  /** 只有这台连不上的规则条数（每台都连不上的算目标的问题，不记在这里） */
  down: number;
  /** 是哪几条规则连不上（弹窗写名字：这台给别的规则还在用时，不能笼统写「连不上」） */
  downRuleIds: number[];
  /** 只有这台不稳的规则条数 */
  unstable: number;
  /** 各条规则到目标延迟的中位数（不取最差：目标远的那条规则每台都慢，不是出口的问题） */
  medianMs: number | null;
  /** 各条规则到目标延迟的最小 / 最大（规则的目标远近不同，弹窗写成 10–212ms） */
  minMs: number | null;
  maxMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  /** 按现在的分配方式会分到流量的规则条数（NEX 隧道是面板按同一套规则估的，GOST 是真实的节点顺序） */
  activeRules: number;
  /** 平时到目标的延迟 = 这条路的最低延迟（各条规则平时值的中位数；还没攒够半小时为 null） */
  baselineMs: number | null;
  /** 有平时值的规则条数（几条规则目标远近不同时，弹窗不写数字，写「跟平时差不多」） */
  baselineRules: number;
  /** 比平时慢多少（只在超过「延迟差多少才换」时给，取各条规则里最多的） */
  slowerMs: number | null;
  /** 数据从哪来：traffic = 真实连接的内核 RTT，probe = 主动探测（多数规则是哪种就写哪种） */
  source: "traffic" | "probe" | null;
  /**
   * UDP 那一侧（只有入口真实上报、规则转 UDP 时有）：几条规则里 UDP 探活在回 / 不通 / 从没回过。三个都是 0 = 没有 UDP 规则
   * 或者没报（GOST 的 UDP 跟着出口机走，不单独报）。
   */
  udpOk: number;
  udpDown: number;
  udpUnverified: number;
  /** 出口机的 FXP 版本过旧（不回 UDP 探活包）：弹窗写「对端版本过旧」 */
  peerOutdated: boolean;
  /** 连不上 / 不稳是哪一段的问题（入口真实上报才有）：exit = 入口连不上这台出口机，target = 出口到目标不行 */
  reason?: "target" | "exit" | null;
  /** 新连接分给它的比例（0–1，各条规则的平均；入口真实上报、这段时间有新连接时才有） */
  share?: number | null;
  /**
   * 整链的两段（各条规则的中位数）：入口到这台出口、这台出口到目标。面板探的优先（链路定时探测的出口分支、出口机探目标，
   * 和规则卡、诊断一个口径）；面板没测到才是入口自己报的（source = agent，弹窗写「Agent 自测」）。
   */
  exitMs?: number | null;
  targetMs?: number | null;
  exitMsSource?: "panel" | "agent" | null;
  targetMsSource?: "panel" | "agent" | null;
  /** 几条规则里这台到目标的延迟不知道（入口调度器按最慢的那台算它）：弹窗写「到目标延迟未知」 */
  targetLatencyUnknown?: number;
};

export type ExitTargetTunnelSummary = {
  exits: ExitTargetExitSummary[];
  /** 每台出口都连不上 / 都不稳的规则：问题在目标那边 */
  targetIssues: Array<{ ruleId: number; kind: "down" | "unstable" }>;
  /** 一句话：现在怎么走 */
  how: string | null;
  /** 数据是入口真实上报的（true），还是面板按出口的探测估的（false / 没有） */
  live?: boolean;
  /** 最近的切换记录（新的在前，最多 10 条；只有真实上报时有） */
  events?: Array<{ at: number; ruleId: number; hostId: number; hostName: string; from: string; to: string; reason: "target" | "exit" | null; text: string }>;
  /** downRuleIds 里的规则叫什么（路由层补上） */
  ruleNames?: Record<number, string>;
};

const middle = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** 打分：到目标延迟 + 抖动（和 FXP 的「延迟优先」一样）；没数据返回 null。 */
function exitTargetScore(state: ExitTargetState | undefined) {
  if (!state || state.down) return null;
  const median = state.medianMs ?? state.latencyMs;
  return median == null ? null : median + (state.jitterMs ?? 0);
}

/*
  GOST「延迟优先」谁排第一、什么时候换，由入口机的本机代理自己定（Agent 的自动择优：整链延迟明显更好、而且持续够久
  才换，带最短驻留和抖动抑制）。面板以前在这里给 gost 排节点顺序、记「上一次最快的是谁」、换了就催入口重新拿配置，
  那一套连同 gost 的节点选择器一起删掉了。
*/

/*
  每条 GOST 规则上一次算出来「该摘掉哪几台」（出口机号排好序拼起来）：变了才让入口重新拿配置。
  lastFlipAt：某条规则的某台出口最近几次进 / 出这个名单的时刻（最多 4 个），30 秒内又翻的不再紧急推（见 exitTargetPush.ts）。
*/
const excludedMemoByRule = new Map<number, { key: string; at: number }>();
const lastFlipAt = new Map<string, number[]>();
const EXIT_TARGET_FLIP_REPEAT_MS = 30_000;
// 用到时才建：exitTargetPush → agentEvents 那一串模块会绕回来引用这个文件，模块加载时还拿不到这个类。
let flipPushesInstance: ExitTargetPushDebouncer | null = null;
function flipPushes() {
  if (!flipPushesInstance) flipPushesInstance = new ExitTargetPushDebouncer();
  return flipPushesInstance;
}

/** 只给测试用：换掉真正发推送的那一下，返回原来的。 */
export function setExitTargetPushDebouncerForTest(debouncer: ExitTargetPushDebouncer) {
  const previous = flipPushes();
  flipPushesInstance = debouncer;
  return previous;
}

/*
  清理（C3）：这几张表以前只进不出 —— 规则删了、链路拆了、出口换了，它们的状态一直留在内存里，
  面板跑得越久扫得越慢。半小时没再报过的（规则 / 链路 / 出口已经不在，或者不再走负载均衡）清掉；
  每分钟最多清一次。平时值（baselines）另有三天的期限，不在这里清。
*/
const EXIT_TARGET_FORGET_MS = 30 * 60_000;
const EXIT_TARGET_PRUNE_EVERY_MS = 60_000;
let lastPrunedAt = 0;

export function pruneExitTargetMemory(nowMs = Date.now(), force = false) {
  if (!force && nowMs - lastPrunedAt < EXIT_TARGET_PRUNE_EVERY_MS) return;
  lastPrunedAt = nowMs;
  const gone = (at: number) => nowMs - at > EXIT_TARGET_FORGET_MS;
  for (const [ruleId, byHost] of statesByRule) {
    for (const [hostId, state] of byHost) {
      if (!gone(state.at)) continue;
      byHost.delete(hostId);
      lastFlipAt.delete(stateKey(ruleId, hostId));
    }
    if (byHost.size === 0) statesByRule.delete(ruleId);
  }
  for (const [tunnelId, meta] of tunnelMetaById) if (gone(meta.at)) tunnelMetaById.delete(tunnelId);
  for (const [ruleId, memo] of excludedMemoByRule) if (gone(memo.at)) excludedMemoByRule.delete(ruleId);
  for (const [key, times] of lastFlipAt) if (gone(times[times.length - 1] || 0)) lastFlipAt.delete(key);
  for (const [key, at] of baselineSeedTried) if (gone(at)) baselineSeedTried.delete(key);
  for (const [ruleId, memo] of allDownByRule) if (gone(memo.at)) allDownByRule.delete(ruleId);
  flipPushesInstance?.prune(EXIT_TARGET_FORGET_MS);
}

/** 只给测试用：内存里各张表现在有多少条。 */
export function exitTargetMemorySizeForTest() {
  let stateCount = 0;
  for (const byHost of statesByRule.values()) stateCount += byHost.size;
  return { states: stateCount, tunnels: tunnelMetaById.size, seeds: baselineSeedTried.size, excluded: excludedMemoByRule.size };
}

/**
 * 一条规则按现在的分配方式会走哪几台（链路弹窗「怎么走」用）。
 * NEX 隧道：入口的 FXP 自己挑，面板拿不到它每次挑了谁，这里按同一套规则估（不含入口到出口那一段）。
 * GOST：主备 / 延迟优先是真实的节点顺序；其余是随机 / 轮流，摘掉连不上的。
 * 延迟优先开了「只走最快的一台」（detect.fastestOnly）：两种都只有分数最好的那一台（入口的 lbcore.Fastest；
 * 这里不估「稳住 60 秒才换」那一段，入口报了真实状态就以入口的为准）。
 */
function activeExitsForRule(input: {
  strategy: string;
  gost: boolean;
  ordered: readonly number[];
  fresh: Map<number, ExitTargetState>;
  detect: BalanceDetect;
  allDown: boolean;
  pinHostId: number;
  ruleId: number;
}): number[] {
  const { strategy, gost, ordered, fresh, detect } = input;
  if (input.pinHostId > 0 && ordered.includes(input.pinHostId)) return [input.pinHostId];
  const usable = input.allDown ? [...ordered] : ordered.filter((hostId) => fresh.get(hostId)?.down !== true);
  if (usable.length === 0) return [];
  const dropUnstable = (list: number[]) => {
    if (gost || detect.jitterAction !== "switch") return list;
    const stable = list.filter((hostId) => fresh.get(hostId)?.unstable !== true);
    return stable.length > 0 ? stable : list;
  };
  if (strategy === "fallback") return [usable[0]];
  if (strategy === "latency") {
    const candidates = dropUnstable(usable);
    const scores = candidates.map((hostId) => exitTargetScore(fresh.get(hostId)));
    const known = scores.filter((score): score is number => score != null);
    // GOST：入口机的本机代理一次只走整链最好的那一台（这里只是入口还没报真实状态时的估计）
    const single = gost || detect.fastestOnly;
    if (known.length === 0) return single ? [candidates[0]] : candidates;
    const best = Math.min(...known);
    if (single) return [candidates[scores.indexOf(best)]];
    return candidates.filter((_, index) => scores[index] != null && (scores[index] as number) - best <= detect.latencyMarginMs);
  }
  return gost ? usable : dropUnstable(usable);
}

function describeHow(input: { strategy: string; gost: boolean; pinned: boolean; active: number[]; total: number; names: (ids: number[]) => string; marginMs: number; fastestOnly?: boolean }) {
  const { strategy, active, names } = input;
  if (active.length === 0) return null;
  if (input.pinned) return `手动指定：只走 ${names(active)}`;
  const rest = input.total - active.length;
  const restText = rest > 0 ? `，${rest} 台备用` : "";
  switch (strategy) {
    case "fallback":
      return `主备：走 ${names(active)}${restText}`;
    case "latency":
      if (input.fastestOnly && active.length === 1) return `延迟优先：只走 ${names(active)}（最快）${restText}`;
      return active.length === 1
        ? `延迟优先：走 ${names(active)}（到目标最快）${restText}`
        : `延迟优先：${names(active)}（差不到 ${input.marginMs}ms，按负载分）${restText}`;
    case "auto":
      return `自动：分给 ${names(active)}，按延迟、抖动和负载挑${restText}`;
    case "least_load":
      return `按负载：分给 ${names(active)}，谁闲给谁${restText}`;
    case "weighted":
      return `按权重：分给 ${names(active)}${restText}`;
    case "round_robin":
      return `轮流：${names(active)} 一台一个连接${restText}`;
    case "random":
      return `随机：在 ${names(active)} 之间随机分${restText}`;
    case "ip_hash":
      return `按访客固定：同一个访客一直走同一台（${names(active)}）${restText}`;
    default:
      return `分给 ${names(active)}${restText}`;
  }
}

/**
 * 链路弹窗：每台出口到目标的情况 + 现在怎么走。
 * 每台出口都连不上（或都不稳）的规则单独列出来，不算到哪台出口头上 —— 那是目标的问题；延迟取各条规则的中位数，
 * 不取最差（以前一条规则的目标在国外，三台出口都显示 200ms、全标「不稳定」）。
 */
export function exitTargetSummaryForTunnel(
  tunnel: TunnelRow | null | undefined,
  orderedExitHostIds: readonly number[],
  options: { nowMs?: number; pinOnline?: boolean; hostNames?: Map<number, string> } = {},
): ExitTargetTunnelSummary {
  const nowMs = options.nowMs ?? Date.now();
  const tunnelId = Number(tunnel?.id || 0);
  const exitIds = orderedExitHostIds.map(Number).filter((id) => id > 0);
  const detect = tunnelBalanceDetect(tunnel);
  const strategy = normalizeExitGroupStrategy(tunnel?.loadBalanceStrategy);
  const gost = String(tunnel?.mode || "").toLowerCase() !== "forwardx";
  const pinHostId = options.pinOnline === false ? 0 : Number(tunnel?.balancePinHostId || 0);
  // 入口报了真实状态：直接用
  const lives = liveBalanceForTunnel(tunnelId, nowMs);
  if (lives.length > 0) {
    return exitTargetSummaryFromLive(lives, exitIds, { strategy, gost, detect, pinHostId, hostNames: options.hostNames });
  }
  const byRule = new Map<number, Map<number, ExitTargetState>>();
  for (const state of allStates()) {
    if (state.tunnelId !== tunnelId || nowMs - state.at > EXIT_TARGET_STALE_MS || !exitIds.includes(state.hostId)) continue;
    const map = byRule.get(state.ruleId) || new Map<number, ExitTargetState>();
    map.set(state.hostId, state);
    byRule.set(state.ruleId, map);
  }
  const perExit = new Map(exitIds.map((hostId) => [hostId, {
    rules: 0, down: 0, downRules: [] as number[], unstable: 0, medians: [] as number[], jitters: [] as number[], losses: [] as number[], activeRules: 0,
    baselines: [] as number[], slower: 0, traffic: 0, probe: 0,
  }]));
  const targetIssues: ExitTargetTunnelSummary["targetIssues"] = [];
  const hows = new Map<string, number>();
  const names = (ids: number[]) => ids.map((id) => options.hostNames?.get(id) || `主机 ${id}`).join("、");
  for (const [ruleId, fresh] of byRule) {
    const reporting = Array.from(fresh.values());
    const allDown = reporting.length >= 2 && reporting.length === exitIds.length && reporting.every((state) => state.down);
    const allUnstable = !allDown && reporting.length >= 2 && reporting.length === exitIds.length && reporting.every((state) => state.down || state.unstable);
    if (allDown) targetIssues.push({ ruleId, kind: "down" });
    else if (allUnstable) targetIssues.push({ ruleId, kind: "unstable" });
    for (const state of reporting) {
      const entry = perExit.get(state.hostId);
      if (!entry) continue;
      entry.rules += 1;
      if (state.down && !allDown) {
        entry.down += 1;
        entry.downRules.push(ruleId);
      } else if (state.unstable && !allDown && !allUnstable) entry.unstable += 1;
      const median = state.medianMs ?? state.latencyMs;
      if (!state.down && median != null) entry.medians.push(median);
      const baseline = exitTargetBaseline(ruleId, state.hostId);
      if (baseline) {
        entry.baselines.push(baseline.normalMs);
        if (!state.down && median != null && median - baseline.normalMs > detect.latencyMarginMs) {
          entry.slower = Math.max(entry.slower, median - baseline.normalMs);
        }
      }
      if (state.source === "traffic") entry.traffic += 1;
      else if (state.source === "probe") entry.probe += 1;
      if (!state.down && state.jitterMs != null) entry.jitters.push(state.jitterMs);
      if (state.lossPct != null) entry.losses.push(state.lossPct);
    }
    // 每台都连不上的规则：入口怎么挑都一样，不算「怎么走」
    if (allDown) continue;
    const active = activeExitsForRule({ strategy, gost, ordered: exitIds, fresh, detect, allDown, pinHostId, ruleId });
    for (const hostId of active) {
      const entry = perExit.get(hostId);
      if (entry) entry.activeRules += 1;
    }
    const how = describeHow({ strategy, gost, pinned: pinHostId > 0 && exitIds.includes(pinHostId), active, total: exitIds.length, names, marginMs: detect.latencyMarginMs, fastestOnly: detect.fastestOnly });
    if (how) hows.set(how, (hows.get(how) || 0) + 1);
  }
  let how: string | null = null;
  if (hows.size > 0) {
    const sorted = Array.from(hows.entries()).sort((left, right) => right[1] - left[1]);
    const counted = sorted.reduce((sum, [, count]) => sum + count, 0);
    how = sorted[0][0] + (sorted.length > 1 ? `（${counted} 条规则里 ${sorted[0][1]} 条）` : "");
  } else if (exitIds.length > 0) {
    // 还没有探测数据：按配置说
    const active = pinHostId > 0 && exitIds.includes(pinHostId) ? [pinHostId] : strategy === "fallback" ? [exitIds[0]] : [...exitIds];
    how = describeHow({ strategy: strategy === "latency" ? "auto" : strategy, gost, pinned: pinHostId > 0 && exitIds.includes(pinHostId), active, total: exitIds.length, names, marginMs: detect.latencyMarginMs });
    if (strategy === "latency") how = `延迟优先：还在测每台到目标的延迟，测出来之前分给 ${names(active)}`;
  }
  return {
    exits: exitIds.map((hostId) => {
      const entry = perExit.get(hostId)!;
      return {
        hostId,
        rules: entry.rules,
        down: entry.down,
        downRuleIds: entry.downRules,
        unstable: entry.unstable,
        medianMs: middle(entry.medians),
        minMs: entry.medians.length > 0 ? Math.min(...entry.medians) : null,
        maxMs: entry.medians.length > 0 ? Math.max(...entry.medians) : null,
        jitterMs: middle(entry.jitters),
        lossPct: middle(entry.losses),
        activeRules: entry.activeRules,
        baselineMs: middle(entry.baselines),
        baselineRules: entry.baselines.length,
        slowerMs: entry.slower > 0 ? entry.slower : null,
        source: entry.traffic + entry.probe === 0 ? null : entry.traffic >= entry.probe ? "traffic" : "probe",
        // 面板探的两段（出口机探目标的就是 medians）
        ...panelOrAgentLegs(tunnelId, hostId, { exitMs: [], targetMs: [], panelTargetMs: entry.medians }),
        udpOk: 0,
        udpDown: 0,
        udpUnverified: 0,
        peerOutdated: false,
      };
    }),
    targetIssues,
    how,
  };
}

const LIVE_STATE_TEXT: Record<string, string> = { active: "在用", standby: "备用", down: "连不上", unstable: "不稳" };

function liveEventText(event: { hostName: string; from: string; to: string; reason: "target" | "exit" | null }) {
  const why = event.reason === "exit" ? "（出口机连不上）" : event.reason === "target" ? "（到目标）" : "";
  if (event.to === "down") return `${event.hostName} 连不上${why}，已切走`;
  if (event.to === "unstable") return `${event.hostName} 不稳${why}`;
  if (event.from === "down" || event.from === "unstable") return `${event.hostName} 恢复${event.to === "active" ? "，开始分流量" : ""}`;
  if (event.to === "active") return `开始走 ${event.hostName}`;
  if (event.to === "standby") return `${event.hostName} 转为备用`;
  return `${event.hostName}：${LIVE_STATE_TEXT[event.from] || event.from} → ${LIVE_STATE_TEXT[event.to] || event.to}`;
}

/** 链路弹窗：用入口上报的真实状态算每台出口、怎么走、最近的切换。 */
function exitTargetSummaryFromLive(
  lives: LiveRuleReport[],
  exitIds: number[],
  options: { strategy: string; gost: boolean; detect: BalanceDetect; pinHostId: number; hostNames?: Map<number, string> },
): ExitTargetTunnelSummary {
  const ids = [...exitIds];
  for (const live of lives) for (const exit of live.exits) if (exit.hostId > 0 && !ids.includes(exit.hostId)) ids.push(exit.hostId);
  const nameOf = (hostId: number) => options.hostNames?.get(hostId)
    || lives.flatMap((live) => live.exits).find((exit) => exit.hostId === hostId)?.hostName
    || `主机 ${hostId}`;
  const names = (hostIds: number[]) => hostIds.map(nameOf).join("、");
  const perExit = new Map(ids.map((hostId) => [hostId, {
    rules: 0, down: 0, downRules: [] as number[], unstable: 0, medians: [] as number[], jitters: [] as number[], losses: [] as number[], activeRules: 0,
    baselines: [] as number[], slower: 0, picks: 0, udpOk: 0, udpDown: 0, udpUnverified: 0, peerOutdated: false,
    reason: null as "target" | "exit" | null, shares: [] as number[],
    exitMs: [] as number[], targetMs: [] as number[], targetUnknown: 0, panelTargetMs: [] as number[],
  }]));
  const tunnelId = Number(lives[0]?.tunnelId || 0);
  const targetIssues: ExitTargetTunnelSummary["targetIssues"] = [];
  const hows = new Map<string, number>();
  const pinned = options.pinHostId > 0 && ids.includes(options.pinHostId);
  for (const live of lives) {
    const exits = live.exits.filter((exit) => exit.hostId > 0);
    const allDown = exits.length >= 2 && exits.every((exit) => exit.state === "down" && exit.reason === "target");
    const allBad = !allDown && exits.length >= 2 && exits.every((exit) => (exit.state === "down" || exit.state === "unstable") && exit.reason === "target");
    if (allDown) targetIssues.push({ ruleId: live.ruleId, kind: "down" });
    else if (allBad) targetIssues.push({ ruleId: live.ruleId, kind: "unstable" });
    for (const exit of exits) {
      const entry = perExit.get(exit.hostId);
      if (!entry) continue;
      entry.rules += 1;
      if (exit.state === "down" && !allDown) {
        entry.down += 1;
        entry.downRules.push(live.ruleId);
      } else if (exit.state === "unstable" && !allDown && !allBad) entry.unstable += 1;
      if (exit.state === "active") entry.activeRules += 1;
      if (exit.state === "active" && exit.share != null) entry.shares.push(exit.share);
      // 出口机本身连不上比到目标不行更要紧：有一条规则报 exit 就写 exit
      if ((exit.state === "down" || exit.state === "unstable") && exit.reason && entry.reason !== "exit") entry.reason = exit.reason;
      entry.picks += exit.picks;
      if (exit.udpState === "ok") entry.udpOk += 1;
      else if (exit.udpState === "down") entry.udpDown += 1;
      else if (exit.udpState === "unverified") entry.udpUnverified += 1;
      entry.peerOutdated ||= exit.peerOutdated;
      if (exit.state !== "down" && exit.medianMs != null) entry.medians.push(exit.medianMs);
      if (exit.state !== "down" && exit.exitMs != null) entry.exitMs.push(exit.exitMs);
      if (exit.targetMs != null) entry.targetMs.push(exit.targetMs);
      // 面板自己探的这台出口到这条规则目标（快速探测优先，再是规则的定时探测）：和诊断同一口径
      const panelState = statesByRule.get(Number(live.ruleId))?.get(exit.hostId);
      const panelTarget = panelState && !panelState.down && Date.now() - panelState.at <= EXIT_TARGET_STALE_MS
        ? panelState.medianMs ?? panelState.latencyMs
        : ruleTargetLatency(live.ruleId, exit.hostId)?.ms ?? null;
      if (exit.state !== "down" && panelTarget != null) entry.panelTargetMs.push(panelTarget);
      if (exit.targetLatencyUnknown) entry.targetUnknown += 1;
      if (exit.state !== "down" && exit.jitterMs != null) entry.jitters.push(exit.jitterMs);
      if (exit.lossPct != null) entry.losses.push(exit.lossPct);
      const baseline = exitTargetBaseline(live.ruleId, exit.hostId);
      if (baseline) {
        entry.baselines.push(baseline.normalMs);
        if (exit.state !== "down" && exit.medianMs != null && exit.medianMs - baseline.normalMs > options.detect.latencyMarginMs) {
          entry.slower = Math.max(entry.slower, exit.medianMs - baseline.normalMs);
        }
      }
    }
    if (allDown) continue;
    const active = exits.filter((exit) => exit.state === "active");
    if (active.length === 0) continue;
    // 只数能用、在待命的；连不上的那台下面一行已经写了，不算「备用」
    const rest = exits.filter((exit) => exit.state === "standby").length;
    const restText = rest > 0 ? `，${rest} 台备用` : "";
    const totalPicks = active.reduce((sum, exit) => sum + exit.picks, 0);
    const label = describeHow({ strategy: options.strategy, gost: options.gost, pinned, active: active.map((exit) => exit.hostId), total: exits.length, names, marginMs: options.detect.latencyMarginMs })?.split("：")[0] || "分配";
    let how: string;
    if (pinned) how = `手动指定：只走 ${names(active.map((exit) => exit.hostId))}`;
    // 延迟优先「只走最快的一台」：入口报的唯一一台 active 就是它（其余 standby，见 lbcore/fastest.go）
    else if (active.length === 1 && options.strategy === "latency" && options.detect.fastestOnly) how = `${label}：只走 ${active[0].hostName}（最快）${restText}`;
    else if (active.length === 1) how = `${label}：走 ${active[0].hostName}${restText}`;
    else if (totalPicks >= 10) {
      /*
        比例优先用入口报的 share（最近这段时间新连接分给谁）：GOST 的 picks 是代理起来以后的累计数，拿它算出来的是
        「一直以来」的比例，刚换过分配方式、刚摘过一台时和现在对不上。FXP 的 picks 就是这段时间的，两种算法结果一样。
      */
      const shareTotal = active.every((exit) => exit.share != null) ? active.reduce((sum, exit) => sum + Number(exit.share), 0) : 0;
      const percent = (exit: (typeof active)[number]) => Math.round((shareTotal > 0 ? Number(exit.share) / shareTotal : exit.picks / totalPicks) * 100);
      how = `${label}：${active.map((exit) => `${exit.hostName} ${percent(exit)}%`).join("、")}${restText}`;
    } else how = `${label}：分给 ${names(active.map((exit) => exit.hostId))}${restText}`;
    hows.set(how, (hows.get(how) || 0) + 1);
  }
  let how: string | null = null;
  if (hows.size > 0) {
    const sorted = Array.from(hows.entries()).sort((left, right) => right[1] - left[1]);
    const counted = sorted.reduce((sum, [, count]) => sum + count, 0);
    how = sorted[0][0] + (sorted.length > 1 ? `（${counted} 条规则里 ${sorted[0][1]} 条）` : "");
  }
  const events = lives
    .flatMap((live) => live.events.map((event) => ({ ...event, ruleId: live.ruleId })))
    .sort((left, right) => right.at - left.at)
    .slice(0, 10)
    .map((event) => ({ ...event, hostName: event.hostId > 0 ? nameOf(event.hostId) : event.hostName, text: liveEventText({ ...event, hostName: event.hostId > 0 ? nameOf(event.hostId) : event.hostName }) }));
  return {
    exits: ids.map((hostId) => {
      const entry = perExit.get(hostId)!;
      return {
        hostId,
        rules: entry.rules,
        down: entry.down,
        downRuleIds: entry.downRules,
        unstable: entry.unstable,
        medianMs: middle(entry.medians),
        minMs: entry.medians.length > 0 ? Math.min(...entry.medians) : null,
        maxMs: entry.medians.length > 0 ? Math.max(...entry.medians) : null,
        jitterMs: middle(entry.jitters),
        lossPct: middle(entry.losses),
        activeRules: entry.activeRules,
        baselineMs: middle(entry.baselines),
        baselineRules: entry.baselines.length,
        slowerMs: entry.slower > 0 ? entry.slower : null,
        source: entry.rules === 0 ? null : entry.picks > 0 ? "traffic" : "probe",
        udpOk: entry.udpOk,
        udpDown: entry.udpDown,
        udpUnverified: entry.udpUnverified,
        peerOutdated: entry.peerOutdated,
        reason: entry.reason,
        share: entry.shares.length > 0 ? entry.shares.reduce((sum, value) => sum + value, 0) / entry.shares.length : null,
        /*
          两段先用面板探的（链路定时探测的这台出口分支、出口机探目标），和规则卡、诊断一个口径；面板一段都没测到才用
          入口自己报的（FXP 的 exitMs 是建隧道握手的时间，比 TCPing 大），弹窗上写「Agent 自测」。
        */
        ...panelOrAgentLegs(tunnelId, hostId, entry),
        targetLatencyUnknown: entry.targetUnknown,
      };
    }),
    targetIssues,
    how,
    live: true,
    events,
  };
}

function panelOrAgentLegs(
  tunnelId: number,
  hostId: number,
  entry: { exitMs: number[]; targetMs: number[]; panelTargetMs: number[] },
): { exitMs: number | null; targetMs: number | null; exitMsSource: "panel" | "agent" | null; targetMsSource: "panel" | "agent" | null } {
  const panelExit = tunnelExitLatency(tunnelId, hostId)?.ms ?? null;
  const panelTarget = middle(entry.panelTargetMs);
  const agentExit = middle(entry.exitMs);
  const agentTarget = middle(entry.targetMs);
  return {
    exitMs: panelExit ?? agentExit,
    targetMs: panelTarget ?? agentTarget,
    exitMsSource: panelExit != null ? "panel" : agentExit != null ? "agent" : null,
    targetMsSource: panelTarget != null ? "panel" : agentTarget != null ? "agent" : null,
  };
}

/** 一条规则各台出口到目标的情况（只要新鲜的）。 */
export function exitTargetStatesForRule(ruleId: number, nowMs = Date.now()): ExitTargetState[] {
  const out: ExitTargetState[] = [];
  for (const state of statesByRule.get(Number(ruleId))?.values() || []) {
    if (nowMs - state.at <= EXIT_TARGET_STALE_MS) out.push(state);
  }
  return out.sort((left, right) => left.hostId - right.hostId);
}

/**
 * 这条规则现在实际走哪台出口（2.3.537，用户：「切走了，ping 延迟显示的节点路径可以实时吗」）。
 * 流量没走主出口时给：规则卡的「经 xxx」、延迟、诊断的路径都换成在用的那台。主出口在用时返回 null（照旧按主出口显示）。
 *
 * 2.3.539（用户：「这个没生效吧」）：以前只认「主出口的快速探测报连不上」这一种，下面几种都漏了，卡上照旧
 * 「经 主出口 · 超时」：
 *   - 主出口被目标的高防时通时不通：快速探测只到「不稳」（丢包），没到「连不上」，可入口已经把它摘了；
 *   - 主出口的 Agent 太老、没报快速探测：只有它那条一分钟一次的普通探测在超时（primaryTimeout）；
 *   - 手动指定了别的出口、延迟优先挑了别的出口。
 * 现在按入口实际的挑法（activeExitsForRule）算：挑出来的里面没有主出口，就写在用的那几台。
 */
export function ruleActiveExit(ruleId: number, tunnelId: number, nowMs = Date.now(), options: { primaryTimeout?: boolean } = {}): {
  primaryHostId: number;
  hostIds: number[];
  names: string[];
  latencyMs: number | null;
  at: number;
} | null {
  // 入口报了真实状态（FXP 2.2.145 / Agent 2.2.262 起）：直接用，不再按下面的办法估。
  // 这时 hostIds[0] 是扛流量最多的那台（可能就是主出口），和规则卡上的延迟、「经」是同一台。
  const live = liveBalanceForRule(ruleId, nowMs);
  if (live && live.tunnelId === Number(tunnelId)) return activeExitFromLive(live);
  const meta = tunnelMetaById.get(Number(tunnelId));
  if (!meta || meta.order.length < 2 || !tunnelBalancesExits(meta.tunnel)) return null;
  const fresh = new Map(exitTargetUsableStatesForRule(ruleId, nowMs).map((state) => [state.hostId, state]));
  const primaryHostId = meta.order[0];
  // 主出口没报快速探测（Agent 老），它的普通探测又在超时：当它连不上
  if (!fresh.has(primaryHostId) && options.primaryTimeout) {
    const others = Array.from(fresh.values());
    const template = others[0];
    if (template) fresh.set(primaryHostId, { ...template, hostId: primaryHostId, hostName: `主机 ${primaryHostId}`, down: true, unstable: false, latencyMs: null, medianMs: null });
  }
  const reporting = meta.order.filter((hostId) => fresh.has(hostId));
  if (reporting.length > 0 && reporting.every((hostId) => fresh.get(hostId)?.down === true)) return null;
  const strategy = normalizeExitGroupStrategy(meta.tunnel.loadBalanceStrategy);
  const gost = String(meta.tunnel.mode || "").toLowerCase() !== "forwardx";
  const pinHostId = Number(meta.tunnel.balancePinHostId || 0);
  const active = activeExitsForRule({
    strategy,
    gost,
    ordered: meta.order,
    fresh,
    detect: tunnelBalanceDetect(meta.tunnel),
    allDown: false,
    pinHostId,
    ruleId,
  });
  if (active.length === 0 || active.includes(primaryHostId)) return null;
  // 只写有数据、连得上的（手动指定的那台没数据也写：那是用户自己选的）
  const shown = active.filter((hostId) => (fresh.has(hostId) && fresh.get(hostId)?.down !== true) || hostId === pinHostId);
  if (shown.length === 0) return null;
  const states = shown.map((hostId) => fresh.get(hostId)).filter((state): state is ExitTargetState => !!state);
  const latencies = states.map((state) => state.medianMs ?? state.latencyMs).filter((value): value is number => value != null);
  return {
    primaryHostId,
    hostIds: shown,
    names: shown.map((hostId) => fresh.get(hostId)?.hostName || `主机 ${hostId}`),
    latencyMs: latencies.length > 0 ? Math.min(...latencies) : null,
    at: states.length > 0 ? Math.max(...states.map((state) => state.at)) : nowMs,
  };
}

/*
  入口上报的真实状态 → 现在是哪台出口在扛流量（规则卡的延迟、「经」、诊断从哪台测，三处同一台）。

  2.3.540 以前只在「在用的里面没有主出口」时才换，主出口也在用（自动、轮询分给几台）时卡上照旧是最近一次诊断
  （主出口那条路径）的数，同一个目标的两条规则一条写「经 3 台出口 · 10 ms」、一条写「经 hep ix · 4 ms」，口径不一样。
  现在只要入口报了：
    - 扛流量的那台 = 在用的里面最近分到最多的（入口报的 share；一样多 / 这阵子没有新连接时取整链延迟低的，
      再一样取配置里靠前的）；
    - 卡上的延迟 = 它的整链延迟（入口实时探测：入口到它 + 它到目标），诊断也从它测；
    - hostIds 是在用的那几台，扛流量的排第一（「经」写一台的名字或「N 台出口」）。
  一台在用的都没有返回 null（照旧按主出口显示）。
*/
function liveCarryingExit(live: LiveRuleReport): LiveExit | null {
  const active = live.exits.filter((exit) => exit.state === "active" && exit.hostId > 0);
  if (active.length === 0) return null;
  const order = new Map(live.exits.map((exit, index) => [exit, index]));
  // 到目标不知道的那台，它的 medianMs 只是下限：比延迟时排在知道的后面（和入口调度器的悲观算法一个意思）
  const latency = (exit: LiveExit) => (exit.medianMs ?? 1e9) + (exit.targetLatencyUnknown ? 1e6 : 0);
  return [...active].sort((left, right) => (right.share ?? -1) - (left.share ?? -1)
    || latency(left) - latency(right)
    || Number(order.get(left)) - Number(order.get(right)))[0];
}

function activeExitFromLive(live: LiveRuleReport) {
  const primary = live.exits[0];
  const carrying = liveCarryingExit(live);
  if (!primary || !carrying) return null;
  const active = [carrying, ...live.exits.filter((exit) => exit !== carrying && exit.state === "active" && exit.hostId > 0)];
  return {
    primaryHostId: primary.hostId,
    hostIds: active.map((exit) => exit.hostId),
    names: active.map((exit) => exit.hostName),
    latencyMs: carrying.medianMs,
    at: live.at,
    carrying,
  };
}

/**
 * 规则卡整链的两段（都是面板探的，server/ruleLatencyView.ts）：在用的那台出口、入口到它、它到目标、分到多少。
 * 悬停那句由界面拼：「整链 9 ms = 入口到 hep ix 6 ms + hep ix 到目标 3 ms（面板探测，18:48）」。
 */
type RuleChainLatencyView = {
  exitHostId: number;
  exitName: string;
  exitMs: number;
  targetMs: number;
  /** 最近新连接分给它的比例（0–1，入口实时上报的）；不知道是 null */
  share: number | null;
};

/*
  旧的「连不上」不拿来摘出口（实验室实测，Agent 2.2.264、GOST 三出口）：三台出口一起断了一阵（都在 Agent 的退避里，
  最长一分钟才探一次），恢复后先探到的那台一报「通了」，另外两台手里还是故障时那份「连不上」—— 面板当场把这两台
  好好的出口摘掉，半分钟后它们各自探到了才放回。
  算旧（当不知道，不摘）的两种：
    a. 这条规则「每台出口都连不上」结束之后，还没再探过的（探的时刻早于结束的时刻）：那份结论是故障期间的；
    b. 离探出来已经超过「两倍探测间隔（含退避）+ EXIT_TARGET_PROBE_SLACK_MS」：Agent 那边早该又探过了，没报新的
       就说明这份不可信（老 Agent 不报间隔，按最长退避算）。
  「每台都连不上」= 报上来的出口里没有一台是通的、而且至少两台不通（只有一台报过算不上「都」）。
*/
const allDownByRule = new Map<number, { down: boolean; endedAt: number; at: number }>();

/** 收到一份报告后更新「这条规则是不是每台出口都连不上」；从「是」变成「不是」的那一刻记下来。返回是不是刚结束。 */
export function noteExitTargetAllDown(ruleId: number, exitHostIds: readonly number[], nowMs = Date.now()) {
  const fresh = new Map(exitTargetStatesForRule(ruleId, nowMs).map((state) => [state.hostId, state]));
  const reported = exitHostIds.map((hostId) => fresh.get(Number(hostId))).filter((state): state is ExitTargetState => !!state);
  const down = !reported.some((state) => !state.down) && reported.filter((state) => state.down).length >= 2;
  const previous = allDownByRule.get(Number(ruleId));
  const ended = !!previous?.down && !down;
  allDownByRule.set(Number(ruleId), { down, endedAt: ended ? nowMs : previous?.endedAt ?? 0, at: nowMs });
  return ended;
}

/** 这份「连不上」是不是旧的（见上）。通的那份不在这里判。 */
export function exitTargetDownStale(state: Pick<ExitTargetState, "down" | "at" | "probedAt" | "probeIntervalMs">, nowMs = Date.now(), allDownEndedAt = 0) {
  if (!state.down) return false;
  const probedAt = state.probedAt ?? state.at;
  if (allDownEndedAt > 0 && probedAt < allDownEndedAt) return true;
  const interval = state.probeIntervalMs != null && state.probeIntervalMs > 0 ? state.probeIntervalMs : EXIT_TARGET_LEGACY_MAX_INTERVAL_MS;
  return nowMs - probedAt > 2 * interval + EXIT_TARGET_PROBE_SLACK_MS;
}

/** 一条规则各台出口到目标的情况，拿来摘出口 / 估「现在走哪台」用的：新鲜的，旧的「连不上」去掉（当不知道）。 */
export function exitTargetUsableStatesForRule(ruleId: number, nowMs = Date.now()): ExitTargetState[] {
  const endedAt = allDownByRule.get(Number(ruleId))?.endedAt ?? 0;
  return exitTargetStatesForRule(ruleId, nowMs).filter((state) => !exitTargetDownStale(state, nowMs, endedAt));
}

/**
 * GOST 隧道这条规则该摘掉哪几台出口：新鲜的、报「连不上」的（旧的「连不上」不算，见 exitTargetDownStale）。
 * 全都连不上（或剩下的没一台确认能通）时一台都不摘 —— 那是目标本身的问题，摘光等于直接断服。
 */
export function exitTargetExcludedHostIds(ruleId: number, exitHostIds: readonly number[], nowMs = Date.now()): Set<number> {
  const fresh = new Map(exitTargetUsableStatesForRule(ruleId, nowMs).map((state) => [state.hostId, state]));
  const down = exitHostIds.filter((hostId) => fresh.get(Number(hostId))?.down === true);
  if (down.length === 0 || down.length >= exitHostIds.length) return new Set();
  const remainingKnownGood = exitHostIds.some((hostId) => !down.includes(hostId) && fresh.get(Number(hostId))?.down === false);
  return remainingKnownGood ? new Set(down.map(Number)) : new Set();
}

type RuleExitTargetSummary = {
  total: number;
  reporting: number;
  bad: Array<{ hostId: number; hostName: string; reason: "down" | "unstable"; medianMs: number | null; jitterMs: number | null; lossPct: number | null; exitUnreachable?: boolean }>;
  allBad: boolean;
};

/**
 * 给规则的流量 / 延迟汇总行补上「各台出口到目标」：exitTargetTotal（报上来的出口数，≥2 才有）、
 * exitTargetOk（其中连得上的）、exitTargetNote（规则卡上那一句，没问题时 null）。只用内存里的状态，不查库。
 */
type RuleExitTargetFields = {
  exitTargetTotal: number | null;
  exitTargetOk: number | null;
  exitTargetNote: string | null;
  /** 主出口切走了：现在实际走的出口（名字、主机 id） */
  exitTargetVia: string[] | null;
  exitTargetViaHostIds: number[] | null;
  /** 卡上的延迟是面板探的两段相加（入口→在用出口 + 在用出口→目标）：哪台、两段各多少。没有是 null */
  latestLatencyChain?: RuleChainLatencyView | null;
  /** 卡上延迟从哪来（metricsRepository 的 RuleLatencySource）：panel 两段相加、exit-target 只有在用出口探目标那段 */
  latestLatencySource?: string | null;
};

/** 规则卡那几项（经哪台、延迟、几台里几台有问题），用入口上报的真实状态算。 */
function ruleExitTargetFieldsFromLive(live: LiveRuleReport, nowMs = Date.now()): RuleExitTargetFields & Record<string, unknown> {
  const via = activeExitFromLive(live);
  const freshDownHostIds = new Set(exitTargetStatesForRule(live.ruleId, nowMs)
    .filter((state) => state.down && !exitTargetDownStale(state, nowMs))
    .map((state) => state.hostId));
  const bad = live.exits
    .filter((exit) => exit.state === "down" || exit.state === "unstable")
    .map((exit) => ({
      hostId: exit.hostId,
      hostName: exit.hostName,
      reason: (exit.state === "down" ? "down" : "unstable") as "down" | "unstable",
      medianMs: exit.medianMs,
      jitterMs: exit.jitterMs,
      lossPct: exit.lossPct,
      exitUnreachable: exit.reason === "exit",
    }));
  const total = live.exits.length;
  // 出口机本身连不上（不是到目标的问题）也算坏；全坏了才说「目标的问题」—— 要都是到目标不行才这么说
  const allTargetBad = bad.length >= total && live.exits.every((exit) => exit.reason !== "exit");
  const summary: RuleExitTargetSummary = { total, reporting: total, bad, allBad: allTargetBad };
  return {
    exitTargetTotal: total,
    // 入口还没切走、快速探测已经说连不上的，不算「连得上」
    exitTargetOk: live.exits.filter((exit) => exit.state !== "down" && !freshDownHostIds.has(exit.hostId)).length,
    exitTargetNote: describeRuleExitTargetSummary(summary, live.source === "agent"),
    exitTargetVia: via ? via.names : null,
    exitTargetViaHostIds: via ? via.hostIds : null,
  };
}

/**
 * 规则卡的延迟（一个口径：和诊断一样是面板探的几段）：
 *   1. 在用那台出口（入口实时上报里扛流量最多的；没上报用估的在用 / 主出口）两段都测到了 → 整链 = 入口到它 + 它到目标；
 *   2. 缺一段 → 留着规则自己的定时探测（metricsRepository 已经填了），再没有是最近一次诊断。
 * 入口实时上报里的延迟（FXP 的 exitMs 是建隧道握手的时间）不拿来当卡上的数。
 */
function ruleChainFields(
  row: { ruleId: number | string; latestLatencyIsTimeout?: unknown },
  inUse: { tunnelId: number; hostId: number; name: string; share: number | null } | null,
  nowMs: number,
): Record<string, unknown> {
  if (!inUse || !(inUse.hostId > 0)) return { latestLatencyChain: null };
  const states = exitTargetStatesForRule(Number(row.ruleId), nowMs);
  /*
    在用的这台，几秒一次的快速探测已经说它连不上目标（2.3.555，用户面板：高防刚拦掉 jinx(39.9y)，卡片还拿它一分钟一次的
    定时探测里上一次成功的数写「经 jinx(39.9y) · 14 ms」、绿色，诊断却超时）：不再拿旧的成功数顶，写成超时 ——
    别的出口还连得上时 forwardRuleStatus 显示橙色并写明是哪台，入口几秒内就会切走。
  */
  const inUseDown = states.find((item) => item.hostId === inUse.hostId && item.down && !exitTargetDownStale(item, nowMs));
  if (inUseDown) {
    return {
      latestLatencyChain: null,
      latestLatencyMs: null,
      latestLatencyIsTimeout: true,
      latestLatencyAt: new Date(inUseDown.at),
      latestProbeFailure: null,
      latestLatencySource: "exit-target",
    };
  }
  const state = states.find((item) => item.hostId === inUse.hostId && !item.down);
  const chain = ruleChainLatency({
    ruleId: row.ruleId,
    tunnelId: inUse.tunnelId,
    exitHostId: inUse.hostId,
    targetStateMs: state ? state.medianMs ?? state.latencyMs : null,
    targetStateAt: state?.at ?? null,
    nowMs,
  });
  if (!chain) return { latestLatencyChain: null };
  return {
    latestLatencyMs: Math.round(chain.totalMs),
    latestLatencyIsTimeout: false,
    latestLatencyAt: new Date(chain.at),
    latestProbeFailure: null,
    latestLatencySource: "panel",
    latestLatencyChain: {
      exitHostId: chain.exitHostId,
      exitName: inUse.name || state?.hostName || "",
      exitMs: Math.round(chain.exitMs * 10) / 10,
      targetMs: Math.round(chain.targetMs * 10) / 10,
      share: inUse.share,
    } satisfies RuleChainLatencyView,
  };
}

/**
 * 负载均衡的规则此刻有没有一台出口连得上目标（2.3.555）：入口实时上报里有在用的、而且快速探测没说它连不上；没有实时上报时
 * 看快速探测里有没有一台通的。订阅「自动隐藏不通的节点」用：规则的定时端到端探测是从主出口测的，主出口被目标的高防拦了
 * 就连着超时，可流量照样在别的出口上走 —— 以前节点会被从订阅里藏掉（用户：「有时订阅又不通」）。
 * 不是负载均衡的规则（没有这两样数据）返回 null，调用方照旧按探测判断。
 */
export function ruleHasReachableExit(ruleId: number, nowMs = Date.now()): boolean | null {
  const states = exitTargetStatesForRule(Number(ruleId), nowMs);
  const downHosts = new Set(states.filter((state) => state.down && !exitTargetDownStale(state, nowMs)).map((state) => state.hostId));
  const live = liveBalanceForRule(Number(ruleId), nowMs);
  if (live) return live.exits.some((exit) => exit.state === "active" && exit.hostId > 0 && !downHosts.has(exit.hostId));
  if (states.length === 0) return null;
  return states.some((state) => !downHosts.has(state.hostId));
}

export function withRuleExitTargets<T extends { ruleId: number | string }>(rows: T[], nowMs = Date.now()): Array<T & RuleExitTargetFields> {
  return rows.map((row) => {
    const live = liveBalanceForRule(Number(row.ruleId), nowMs);
    if (live) {
      const carrying = liveCarryingExit(live);
      const chain = ruleChainFields(row, carrying ? { tunnelId: live.tunnelId, hostId: carrying.hostId, name: carrying.hostName, share: carrying.share } : null, nowMs);
      /*
        两段没测全、规则自己的定时探测是主出口那条的超时，可入口报着流量在别的出口上走：别写「超时」（那等于说转发断了），
        空着等面板测到；入口报的握手延迟不拿来顶。
      */
      const neutral = !("latestLatencyMs" in chain) && carrying && (row as { latestLatencyIsTimeout?: unknown }).latestLatencyIsTimeout === true
        ? { latestLatencyMs: null, latestLatencyIsTimeout: false, latestProbeFailure: null, latestLatencySource: "live" }
        : {};
      return { ...row, ...ruleExitTargetFieldsFromLive(live, nowMs), ...neutral, ...chain } as T & RuleExitTargetFields;
    }
    const fresh = exitTargetStatesForRule(Number(row.ruleId), nowMs);
    if (fresh.length === 0) {
      // 没有负载均衡的数据：在用的就是主出口（规则定时探测上报时记下的那台）
      const known = ruleTunnelOf(row.ruleId);
      const chain = ruleChainFields(row, known ? { tunnelId: known.tunnelId, hostId: known.primaryHostId, name: "", share: null } : null, nowMs);
      return { ...row, exitTargetTotal: null, exitTargetOk: null, exitTargetNote: null, exitTargetVia: null, exitTargetViaHostIds: null, ...chain };
    }
    /*
      流量没走主出口（连不上、不稳被摘、手动指定、延迟优先挑了别的）：规则的「最新延迟」换成在用那台到目标的延迟
      （规则的普通探测是主出口测的，它连不上时一直超时，拿它显示等于说转发断了，可流量照走）。
    */
    const primaryTimeout = (row as { latestLatencyIsTimeout?: unknown }).latestLatencyIsTimeout === true;
    const via = ruleActiveExit(Number(row.ruleId), fresh[0].tunnelId, nowMs, { primaryTimeout });
    const viaFields: Partial<Record<string, unknown>> = via
      ? {
        exitTargetVia: via.names,
        exitTargetViaHostIds: via.hostIds,
        ...(via.latencyMs != null ? {
          latestLatencyMs: Math.round(via.latencyMs),
          latestLatencyIsTimeout: false,
          latestLatencyAt: new Date(via.at),
          latestProbeFailure: null,
          // 在用那台出口探目标的数：只有出口到目标那一段，卡上写「≥」
          latestLatencySource: "exit-target",
        } : {}),
      }
      : { exitTargetVia: null, exitTargetViaHostIds: null };
    // 两段都测到了就是整链（盖过上面那个只有出口到目标的数）
    const primaryHostId = ruleTunnelOf(row.ruleId)?.primaryHostId || 0;
    const inUseHostId = via ? via.hostIds[0] : primaryHostId;
    Object.assign(viaFields, ruleChainFields(row, inUseHostId > 0 ? {
      tunnelId: fresh[0].tunnelId,
      hostId: inUseHostId,
      name: via ? via.names[0] : fresh.find((state) => state.hostId === inUseHostId)?.hostName || "",
      share: null,
    } : null, nowMs));
    // 只有一台出口报了：没法说「几台里几台有问题」，只给在用的出口
    if (fresh.length < 2) return { ...row, ...viaFields, exitTargetTotal: null, exitTargetOk: null, exitTargetNote: null } as T & RuleExitTargetFields;
    const bad = fresh.filter((state) => state.down || state.unstable).map((state) => ({
      hostId: state.hostId,
      hostName: state.hostName,
      reason: (state.down ? "down" : "unstable") as "down" | "unstable",
      medianMs: state.medianMs ?? state.latencyMs,
      jitterMs: state.jitterMs,
      lossPct: state.lossPct,
    }));
    const summary: RuleExitTargetSummary = { total: fresh.length, reporting: fresh.length, bad, allBad: bad.length > 0 && bad.length >= fresh.length };
    return {
      ...row,
      ...viaFields,
      exitTargetTotal: fresh.length,
      exitTargetOk: fresh.filter((state) => !state.down).length,
      exitTargetNote: describeRuleExitTargetSummary(summary, fresh.some((state) => state.gost)),
    } as T & RuleExitTargetFields;
  });
}

/**
 * 规则卡上那一句话。没有问题返回 null。
 * gost：GOST 隧道只能把连不上的出口摘掉，抖动、丢包没法少分，只写出来。
 */
function describeRuleExitTargetSummary(summary: RuleExitTargetSummary | null, gost = false): string | null {
  if (!summary || summary.bad.length === 0) return null;
  if (summary.allBad) return `${summary.total} 台出口都连不好目标：多半是目标本身的问题，换出口没用`;
  const parts = summary.bad.map((item) => {
    if (item.reason === "down") return item.exitUnreachable ? `连不上 ${item.hostName} 这台出口机，已切走` : `${item.hostName} 连不上目标，已切走`;
    const detail = item.lossPct && item.lossPct >= UNSTABLE_LOSS_PCT ? `丢包 ${Math.round(item.lossPct)}%` : `抖动 ${Math.round(item.jitterMs ?? 0)}ms`;
    return gost ? `${item.hostName} 到目标${detail}` : `${item.hostName} 到目标${detail}，已少分`;
  });
  return `${summary.total} 台出口里 ${parts.join("；")}`;
}
