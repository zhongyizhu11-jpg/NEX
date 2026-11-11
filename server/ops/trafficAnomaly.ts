/*
  流量异常检测（默认关）：某条规则、某个用户的流量突然暴涨，或某条规则上单个来源 IP 的连接数暴涨时，
  记一条事件、发给管理员；可选给规则临时限速，到时间或恢复后自动撤掉。判定算法在 shared/trafficAnomaly.ts。

  数据都是现成的，不让 Agent 多报任何东西：
  - 「现在跑多快」：规则实时速率（server/ruleLiveRates.ts，Agent 几秒一次的流量上报算出来的，只在内存）。
  - 「平时跑多快」：traffic_stat_buckets（30 分钟一档、留 72 小时）。只给「现在超过绝对下限」的对象查，
    查到的基线缓存 30 分钟 —— 平时大部分规则连下限都不到，一次库都不用查。
  - 单 IP 连接数：在线 IP 的内存快照（server/ops/onlineIps.ts，Agent 扩展通道默认 60 秒一轮）。
    只有规则对外的那个端口、每个端口最多 256 个 IP，粒度一分钟 —— 够看「一个 IP 开了几千个连接」，
    不够做精细的连接审计。

  - 关着时零开销：定时任务每分钟读一次设置（走 getAllSettings 的缓存）就返回。
  - 判定状态只在内存：面板重启后从头计时、冷却从头算（宁可重启后多报一次）。正在限速的规则例外 ——
    启动时从 traffic_anomaly_throttles 读回来，按「正在告警」接着管，到点照样撤；功能已经关了就当场撤掉。
  - 自动限速只动规则（转发组 / 线路组按根规则，所有成员一起），不动用户、主机；人手动设的限速不覆盖、不撤，
    见 trafficAnomalyThrottles.ts。
*/
import * as db from "../db";
import { queryRaw, quoteDbIdentifier, rawEpochToDate } from "../dbRuntime";
import { appendPanelLog } from "../_core/panelLogger";
import { getAllSettings, setSettings } from "../repositories/settingsRepository";
import { TRAFFIC_BUCKET_MINUTES } from "../repositories/metricsRepository";
import { listRuleLiveRates, type RuleLiveRate } from "../ruleLiveRates";
import { refreshRuleLimitAgents } from "../ruleLimits";
import { sendAdminAlert, type AdminAlertMessage } from "../resourceAlertNotifier";
import { createNonOverlappingScheduledTask } from "../scheduledTask";
import { recordPanelEvent, type PanelEventInput } from "./panelEvents";
import { onlineSnapshots } from "./onlineIps";
import type { OnlineIpRow } from "./onlineIpsCore";
import {
  deleteAnomalyThrottle,
  getAnomalyThrottle,
  listAnomalyThrottles,
  loadAnomalyThrottles,
  saveAnomalyThrottle,
  type StoredAnomalyThrottle,
} from "./trafficAnomalyThrottles";
import {
  DEFAULT_TRAFFIC_ANOMALY_CONFIG,
  TRAFFIC_BASELINE_LOOKBACK_HOURS,
  computeTrafficBaseline,
  dominantMbps,
  emptyAnomalyState,
  formatAnomalyDuration,
  formatMbps,
  formatThrottleUntil,
  isAnomalyStateIdle,
  judgeAnomalySample,
  normalizeTrafficAnomalyConfig,
  shouldApplyThrottle,
  trafficAnomalyThreshold,
  trafficThrottleMbps,
  type AnomalyState,
  type AnomalyTransition,
  type TrafficAnomalyConfig,
  type TrafficBaseline,
  type TrafficBucketSample,
} from "../../shared/trafficAnomaly";

const q = quoteDbIdentifier;
const KEY_PREFIX = "ops.trafficAnomaly.";
const CONFIG_KEYS: Array<keyof TrafficAnomalyConfig> = [
  "enabled",
  "sensitivity",
  "multiplier",
  "minMbps",
  "sustainMinutes",
  "ipConnThreshold",
  "autoThrottle",
  "throttleMinutes",
  "cooldownMinutes",
];
const TICK_MS = 60_000;
const BASELINE_TTL_MS = 30 * 60_000;
const MAX_STATES = 20_000;
/** 一轮最多发这么多条（被打的时候一下来几百个 IP，不能把时间线和 Telegram 刷满），多出来的只写日志。 */
const MAX_NOTIFY_PER_TICK = 10;

// ---------------- 设置 ----------------

export async function readTrafficAnomalyConfig(): Promise<TrafficAnomalyConfig> {
  const settings = await getAllSettings().catch(() => ({} as Record<string, string | null>));
  const raw: Partial<Record<keyof TrafficAnomalyConfig, unknown>> = {};
  for (const key of CONFIG_KEYS) {
    const value = settings[`${KEY_PREFIX}${key}`];
    if (value !== undefined && value !== null && value !== "") raw[key] = value;
  }
  return normalizeTrafficAnomalyConfig({ ...DEFAULT_TRAFFIC_ANOMALY_CONFIG, ...raw });
}

export async function saveTrafficAnomalyConfig(input: Partial<TrafficAnomalyConfig>): Promise<TrafficAnomalyConfig> {
  const current = await readTrafficAnomalyConfig();
  const next = normalizeTrafficAnomalyConfig({ ...current, ...input });
  const map: Record<string, string> = {};
  for (const key of CONFIG_KEYS) map[`${KEY_PREFIX}${key}`] = String(next[key]);
  await setSettings(map);
  if (!next.enabled) states.clear();
  // 关掉检测或关掉自动限速：正在限的当场撤掉，不留一条没人管的限速。
  if (!next.enabled || !next.autoThrottle) await revokeAllAnomalyThrottles("settings");
  return next;
}

// ---------------- 依赖（测试里换掉） ----------------

export type TrafficAnomalyDeps = {
  liveRates: (nowMs: number) => Map<number, Pick<RuleLiveRate, "inBps" | "outBps">>;
  onlineRows: (nowMs: number) => OnlineIpRow[];
  /** 规则限速变了：通知相关机器重算（成员、中转跳、隧道两头）。 */
  refreshRule: (ruleId: number, reason: string) => Promise<void>;
  sendAlert: (message: AdminAlertMessage) => Promise<void>;
  recordEvent: (event: PanelEventInput) => Promise<unknown>;
};

const defaultDeps: TrafficAnomalyDeps = {
  liveRates: (nowMs) => listRuleLiveRates(nowMs),
  onlineRows: (nowMs) => onlineSnapshots.live(nowMs),
  refreshRule: async (ruleId, reason) => {
    const rule = await db.getForwardRuleById(ruleId);
    if (rule) await refreshRuleLimitAgents(rule, reason);
  },
  sendAlert: (message) => sendAdminAlert(message, { email: false }),
  recordEvent: (event) => recordPanelEvent(event),
};

let deps: TrafficAnomalyDeps = defaultDeps;

export function setTrafficAnomalyDepsForTest(override: Partial<TrafficAnomalyDeps> | null) {
  deps = override ? { ...defaultDeps, ...override } : defaultDeps;
}

// ---------------- 状态 ----------------

type ObjectState = AnomalyState & {
  /** 管理员在设置里手动撤掉了这一轮的限速：直到恢复都不再自动加。 */
  noThrottle?: boolean;
};

const states = new Map<string, ObjectState>();
const baselineCache = new Map<string, { at: number; baseline: TrafficBaseline | null }>();
let globalFirstBucket: { at: number; value: number | null } | null = null;

function putState(key: string, state: ObjectState) {
  states.delete(key);
  states.set(key, state);
  while (states.size > MAX_STATES) {
    const oldest = states.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    states.delete(oldest);
  }
}

export function resetTrafficAnomalyStateForTest() {
  states.clear();
  baselineCache.clear();
  globalFirstBucket = null;
}

export function getTrafficAnomalyStateForTest(key: string) {
  return states.get(key) ?? null;
}

// ---------------- 读库 ----------------

type RuleMeta = {
  id: number;
  userId: number;
  name: string;
  hostId: number;
  forwardGroupRuleId: number;
  routeParentRuleId: number;
  rateLimitMbps: number;
  createdAt: number;
  pendingDelete: boolean;
};

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "t";
}

function epochSec(value: unknown) {
  const date = rawEpochToDate(value);
  return date ? Math.floor(date.getTime() / 1000) : 0;
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

async function chunked<T>(ids: number[], load: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) out.push(...await load(ids.slice(i, i + 200)));
  return out;
}

async function loadRuleMeta(ids: number[]): Promise<Map<number, RuleMeta>> {
  const unique = Array.from(new Set(ids.filter((id) => id > 0)));
  const rows = await chunked(unique, (chunk) => queryRaw<Record<string, unknown>>(
    `SELECT ${["id", "userId", "name", "hostId", "forwardGroupRuleId", "routeParentRuleId", "rateLimitMbps", "createdAt", "pendingDelete"].map(q).join(", ")}
       FROM ${q("forward_rules")} WHERE ${q("id")} IN (${placeholders(chunk.length)})`,
    chunk,
  ));
  const out = new Map<number, RuleMeta>();
  for (const row of rows) {
    const id = Number(row.id);
    out.set(id, {
      id,
      userId: Number(row.userId) || 0,
      name: String(row.name || "").trim().slice(0, 60) || `#${id}`,
      hostId: Number(row.hostId) || 0,
      forwardGroupRuleId: Number(row.forwardGroupRuleId) || 0,
      routeParentRuleId: Number(row.routeParentRuleId) || 0,
      rateLimitMbps: Math.max(0, Number(row.rateLimitMbps) || 0),
      createdAt: epochSec(row.createdAt),
      pendingDelete: truthy(row.pendingDelete),
    });
  }
  return out;
}

/** 和 ruleLimitRootId 同一口径：成员归模板、中转跳归父规则。 */
function rootIdOf(meta: RuleMeta) {
  return meta.forwardGroupRuleId || meta.routeParentRuleId || meta.id;
}

async function loadUsers(ids: number[]) {
  const unique = Array.from(new Set(ids.filter((id) => id > 0)));
  const rows = await chunked(unique, (chunk) => queryRaw<Record<string, unknown>>(
    `SELECT ${q("id")}, ${q("username")}, ${q("name")}, ${q("createdAt")} FROM ${q("users")} WHERE ${q("id")} IN (${placeholders(chunk.length)})`,
    chunk,
  ));
  return new Map(rows.map((row) => [Number(row.id), {
    name: String(row.name || row.username || "").trim().slice(0, 60) || `用户 #${row.id}`,
    createdAt: epochSec(row.createdAt),
  }]));
}

/** 面板最早的一档分桶：刚升级、刚换库时分桶是空的，这时候所有老规则的「平时」都是 0，不能拿来判。 */
async function firstBucketAt(nowMs: number) {
  if (globalFirstBucket && nowMs - globalFirstBucket.at < BASELINE_TTL_MS) return globalFirstBucket.value;
  const rows = await queryRaw<Record<string, unknown>>(
    `SELECT MIN(${q("bucketStart")}) AS ${q("firstAt")} FROM ${q("traffic_stat_buckets")} WHERE ${q("bucketMinutes")} = ?`,
    [TRAFFIC_BUCKET_MINUTES],
  );
  const value = Number(rows[0]?.firstAt) > 0 ? Number(rows[0]?.firstAt) : null;
  globalFirstBucket = { at: nowMs, value };
  return value;
}

/** 根规则 → 分桶（成员规则的分桶记在成员 id 上，按模板加总）。 */
async function loadRuleBuckets(rootIds: number[], sinceSec: number) {
  const out = new Map<number, TrafficBucketSample[]>();
  const rows = await chunked(rootIds, (chunk) => queryRaw<Record<string, unknown>>(
    `SELECT b.${q("ruleId")} AS ${q("ruleId")}, fr.${q("forwardGroupRuleId")} AS ${q("parentId")}, b.${q("bucketStart")} AS ${q("bucketStart")},
            SUM(b.${q("bytesIn")}) AS ${q("bytesIn")}, SUM(b.${q("bytesOut")}) AS ${q("bytesOut")}
       FROM ${q("traffic_stat_buckets")} b
       LEFT JOIN ${q("forward_rules")} fr ON fr.${q("id")} = b.${q("ruleId")}
      WHERE b.${q("bucketMinutes")} = ? AND b.${q("bucketStart")} >= ?
        AND (b.${q("ruleId")} IN (${placeholders(chunk.length)}) OR fr.${q("forwardGroupRuleId")} IN (${placeholders(chunk.length)}))
      GROUP BY b.${q("ruleId")}, fr.${q("forwardGroupRuleId")}, b.${q("bucketStart")}`,
    [TRAFFIC_BUCKET_MINUTES, sinceSec, ...chunk, ...chunk],
  ));
  const wanted = new Set(rootIds);
  for (const row of rows) {
    const parentId = Number(row.parentId) || 0;
    const rootId = parentId > 0 && wanted.has(parentId) ? parentId : Number(row.ruleId);
    if (!wanted.has(rootId)) continue;
    const list = out.get(rootId) || [];
    list.push({ bucketStart: Number(row.bucketStart), bytesIn: Number(row.bytesIn) || 0, bytesOut: Number(row.bytesOut) || 0 });
    out.set(rootId, list);
  }
  return out;
}

async function loadUserBuckets(userIds: number[], sinceSec: number) {
  const out = new Map<number, TrafficBucketSample[]>();
  const rows = await chunked(userIds, (chunk) => queryRaw<Record<string, unknown>>(
    `SELECT ${q("userId")}, ${q("bucketStart")}, SUM(${q("bytesIn")}) AS ${q("bytesIn")}, SUM(${q("bytesOut")}) AS ${q("bytesOut")}
       FROM ${q("traffic_stat_buckets")}
      WHERE ${q("bucketMinutes")} = ? AND ${q("bucketStart")} >= ? AND ${q("userId")} IN (${placeholders(chunk.length)})
      GROUP BY ${q("userId")}, ${q("bucketStart")}`,
    [TRAFFIC_BUCKET_MINUTES, sinceSec, ...chunk],
  ));
  for (const row of rows) {
    const userId = Number(row.userId);
    const list = out.get(userId) || [];
    list.push({ bucketStart: Number(row.bucketStart), bytesIn: Number(row.bytesIn) || 0, bytesOut: Number(row.bytesOut) || 0 });
    out.set(userId, list);
  }
  return out;
}

/** 给一批对象拿基线：缓存里有、没过 30 分钟的直接用，其余一次查齐。 */
async function baselinesFor(
  kind: "rule" | "user",
  candidates: Array<{ id: number; createdAt: number }>,
  nowMs: number,
): Promise<Map<number, TrafficBaseline | null>> {
  const out = new Map<number, TrafficBaseline | null>();
  const missing: Array<{ id: number; createdAt: number }> = [];
  for (const item of candidates) {
    const cached = baselineCache.get(`${kind}:${item.id}`);
    if (cached && nowMs - cached.at < BASELINE_TTL_MS) out.set(item.id, cached.baseline);
    else missing.push(item);
  }
  if (missing.length === 0) return out;
  const nowSec = Math.floor(nowMs / 1000);
  const first = await firstBucketAt(nowMs);
  const sinceSec = nowSec - TRAFFIC_BASELINE_LOOKBACK_HOURS * 3600;
  const ids = missing.map((item) => item.id);
  const buckets = kind === "rule" ? await loadRuleBuckets(ids, sinceSec) : await loadUserBuckets(ids, sinceSec);
  for (const item of missing) {
    // 面板一档分桶都没有：连「平时」都无从谈起，谁都不判。
    const baseline = first === null
      ? null
      : computeTrafficBaseline(buckets.get(item.id) || [], { nowSec, historyStart: Math.max(item.createdAt, first) });
    baselineCache.set(`${kind}:${item.id}`, { at: nowMs, baseline });
    out.set(item.id, baseline);
  }
  if (baselineCache.size > MAX_STATES) {
    for (const [key, entry] of baselineCache) if (nowMs - entry.at >= BASELINE_TTL_MS) baselineCache.delete(key);
  }
  return out;
}

// ---------------- 临时限速 ----------------

async function revokeThrottle(ruleId: number, reason: string) {
  const removed = await deleteAnomalyThrottle(ruleId);
  appendPanelLog("info", `[TrafficAnomaly] throttle revoked rule=${ruleId} reason=${reason}`);
  if (removed) await deps.refreshRule(ruleId, "traffic-anomaly-throttle").catch((error) => {
    appendPanelLog("warn", `[TrafficAnomaly] refresh after revoke rule=${ruleId} failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export async function revokeAllAnomalyThrottles(reason: string) {
  await loadAnomalyThrottles().catch(() => undefined);
  for (const throttle of listAnomalyThrottles()) await revokeThrottle(throttle.ruleId, reason);
}

/** 管理员在设置里手动撤掉：这一轮告警直到恢复都不再自动加回来。 */
export async function releaseAnomalyThrottle(ruleId: number) {
  await loadAnomalyThrottles().catch(() => undefined);
  const state = states.get(`rule:${ruleId}`);
  if (state) state.noThrottle = true;
  await revokeThrottle(ruleId, "manual");
}

async function applyThrottle(meta: RuleMeta, threshold: number, baseline: number | null, config: TrafficAnomalyConfig, nowMs: number) {
  const mbps = trafficThrottleMbps(threshold);
  // 人手动设的限速已经不比它松：不加，也就永远不会去撤它。
  if (!shouldApplyThrottle(meta.rateLimitMbps, mbps)) return { applied: null, manualStricter: true };
  const throttle: StoredAnomalyThrottle = {
    ruleId: meta.id,
    mbps,
    baselineMbps: baseline ?? 0,
    thresholdMbps: threshold,
    appliedAt: nowMs,
    expiresAt: nowMs + config.throttleMinutes * 60_000,
  };
  await saveAnomalyThrottle(throttle);
  appendPanelLog("warn", `[TrafficAnomaly] throttle applied rule=${meta.id} mbps=${mbps} until=${new Date(throttle.expiresAt).toISOString()}`);
  await deps.refreshRule(meta.id, "traffic-anomaly-throttle").catch((error) => {
    appendPanelLog("warn", `[TrafficAnomaly] refresh after throttle rule=${meta.id} failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { applied: throttle, manualStricter: false };
}

/**
 * 启动时收回：面板重启前加上的临时限速，功能还开着就接着管（按正在告警恢复状态），到点照样撤；
 * 已经过期、或者检测 / 自动限速已经关了，当场撤掉。由 startTrafficAnomalyJob 调用；开发面板不跑。
 */
export async function recoverAnomalyThrottlesOnStartup(nowMs = Date.now()) {
  await loadAnomalyThrottles(true);
  const pending = listAnomalyThrottles();
  if (pending.length === 0) return { kept: 0, revoked: 0 };
  const config = await readTrafficAnomalyConfig();
  const existing = await loadRuleMeta(pending.map((item) => item.ruleId));
  let kept = 0;
  let revoked = 0;
  for (const throttle of pending) {
    const meta = existing.get(throttle.ruleId);
    if (!config.enabled || !config.autoThrottle || throttle.expiresAt <= nowMs || !meta || meta.pendingDelete) {
      await revokeThrottle(throttle.ruleId, "startup");
      revoked += 1;
      continue;
    }
    putState(`rule:${throttle.ruleId}`, {
      ...emptyAnomalyState(),
      firing: true,
      firedAt: throttle.appliedAt,
      threshold: throttle.thresholdMbps || throttle.mbps,
      baseline: throttle.baselineMbps,
      lastNotifiedAt: throttle.appliedAt,
      lastSampleAt: null,
    });
    // 重启这段时间里 Agent 可能拿到过一份不带临时限速的配置：推一次，按现在内存里的重算。
    await deps.refreshRule(throttle.ruleId, "traffic-anomaly-throttle").catch(() => undefined);
    kept += 1;
  }
  appendPanelLog("info", `[TrafficAnomaly] startup throttle recovery kept=${kept} revoked=${revoked}`);
  return { kept, revoked };
}

// ---------------- 文案 ----------------

function shanghaiTime(ms: number) {
  return formatThrottleUntil(ms);
}

type Subject = { kind: "rule"; meta: RuleMeta } | { kind: "user"; userId: number; name: string } | { kind: "ip"; meta: RuleMeta; ip: string };

function subjectLabel(subject: Subject) {
  if (subject.kind === "user") return `用户 ${subject.name}`;
  return `规则「${subject.meta.name}」`;
}

function describeFire(subject: Subject, transition: Extract<AnomalyTransition, { kind: "fire" }>, config: TrafficAnomalyConfig, throttleNote: string) {
  const label = subjectLabel(subject);
  const lasting = formatAnomalyDuration(transition.durationMs);
  if (subject.kind === "ip") {
    return {
      message: `${label}上来源 IP ${subject.ip} 同时开着 ${Math.round(transition.value)} 个连接，超过 ${Math.round(transition.threshold)} 个，已持续 ${lasting}`,
      alert: {
        title: `NEX 连接数异常：${subject.meta.name}`,
        marker: "🟠",
        fields: [
          ["规则", `${subject.meta.name} (#${subject.meta.id})`],
          ["来源 IP", subject.ip],
          ["连接数", `${Math.round(transition.value)}（阈值 ${Math.round(transition.threshold)}）`],
          ["持续", lasting],
        ],
        logLabel: `ip-surge rule=${subject.meta.id}`,
      } satisfies AdminAlertMessage,
    };
  }
  const baseline = transition.baseline ?? 0;
  const ratio = baseline > 0 ? `，约 ${Math.round(transition.value / baseline)} 倍` : "";
  return {
    message: `${label}的流量突增：现在 ${formatMbps(transition.value)}，平时约 ${formatMbps(baseline)}${ratio}，已持续 ${lasting}${throttleNote}`,
    alert: {
      title: `NEX 流量异常：${subject.kind === "rule" ? subject.meta.name : subject.name}`,
      marker: "🟠",
      fields: [
        [subject.kind === "rule" ? "规则" : "用户", subject.kind === "rule" ? `${subject.meta.name} (#${subject.meta.id})` : `${subject.name} (#${subject.userId})`],
        ["现在", `${formatMbps(transition.value)}（较大的一向）`],
        ["平时", `${formatMbps(baseline)}（异常线 ${formatMbps(transition.threshold)}，${config.multiplier} 倍）`],
        ["持续", lasting],
        ...(throttleNote ? [["处理", throttleNote.replace(/^；/, "")] as [string, string]] : []),
      ],
      logLabel: `traffic-surge ${subject.kind}=${subject.kind === "rule" ? subject.meta.id : subject.userId}`,
    } satisfies AdminAlertMessage,
  };
}

function describeRecover(subject: Subject, transition: Extract<AnomalyTransition, { kind: "recover" }>, throttleNote: string) {
  const label = subjectLabel(subject);
  const lasting = formatAnomalyDuration(transition.durationMs);
  if (subject.kind === "ip") {
    return {
      message: `${label}上来源 IP ${subject.ip} 的连接数回落到 ${Math.round(transition.value)} 个（持续 ${lasting}，最多 ${Math.round(transition.peak)} 个）`,
      alert: {
        title: `NEX 连接数恢复：${subject.meta.name}`,
        marker: "🟢",
        fields: [
          ["规则", `${subject.meta.name} (#${subject.meta.id})`],
          ["来源 IP", subject.ip],
          ["连接数", `${Math.round(transition.value)}（最多 ${Math.round(transition.peak)}）`],
          ["异常持续", lasting],
        ],
        logLabel: `ip-recover rule=${subject.meta.id}`,
      } satisfies AdminAlertMessage,
    };
  }
  return {
    message: `${label}的流量回落到 ${formatMbps(transition.value)}（突增持续 ${lasting}，最高 ${formatMbps(transition.peak)}）${throttleNote}`,
    alert: {
      title: `NEX 流量恢复：${subject.kind === "rule" ? subject.meta.name : subject.name}`,
      marker: "🟢",
      fields: [
        [subject.kind === "rule" ? "规则" : "用户", subject.kind === "rule" ? `${subject.meta.name} (#${subject.meta.id})` : `${subject.name} (#${subject.userId})`],
        ["现在", formatMbps(transition.value)],
        ["期间最高", formatMbps(transition.peak)],
        ["异常持续", lasting],
        ...(throttleNote ? [["处理", throttleNote.replace(/^，/, "")] as [string, string]] : []),
      ],
      logLabel: `traffic-recover ${subject.kind}=${subject.kind === "rule" ? subject.meta.id : subject.userId}`,
    } satisfies AdminAlertMessage,
  };
}

// ---------------- 一轮 ----------------

type Rate = { inBps: number; outBps: number };

function addRate(map: Map<number, Rate>, id: number, rate: Rate) {
  const current = map.get(id) || { inBps: 0, outBps: 0 };
  current.inBps += Math.max(0, Number(rate.inBps) || 0);
  current.outBps += Math.max(0, Number(rate.outBps) || 0);
  map.set(id, current);
}

/** 由定时任务每分钟调一次；测试直接调。 */
export async function runTrafficAnomalyTick(nowMs = Date.now()) {
  const config = await readTrafficAnomalyConfig();
  if (!config.enabled) {
    states.clear();
    if (listAnomalyThrottles().length > 0) await revokeAllAnomalyThrottles("disabled");
    return;
  }
  const judgeOptions = { sustainMs: config.sustainMinutes * 60_000, cooldownMs: config.cooldownMinutes * 60_000, nowMs };
  let notifyBudget = MAX_NOTIFY_PER_TICK;
  const emit = async (transition: AnomalyTransition, event: Omit<PanelEventInput, "message">, text: { message: string; alert: AdminAlertMessage }) => {
    const allowed = transition.notify && notifyBudget > 0;
    if (transition.notify) notifyBudget -= 1;
    if (!allowed) {
      appendPanelLog("info", `[TrafficAnomaly] ${transition.kind} (silent) ${text.message}`);
      return;
    }
    await deps.recordEvent({ ...event, message: text.message });
    await deps.sendAlert(text.alert).catch(() => undefined);
  };

  // 1. 此刻的速率，按根规则 / 用户加总。线路组中转跳不算（和入口报的是同一股流量）。
  const live = deps.liveRates(nowMs);
  const onlineRows = config.ipConnThreshold > 0 ? deps.onlineRows(nowMs) : [];
  const throttled = listAnomalyThrottles();
  const metaIds = new Set<number>([...live.keys(), ...onlineRows.map((row) => row.ruleId), ...throttled.map((item) => item.ruleId)]);
  for (const key of states.keys()) {
    const [kind, id] = key.split(":");
    if (kind === "rule" || kind === "ip") metaIds.add(Number(id));
  }
  if (metaIds.size === 0) return;
  const meta = await loadRuleMeta([...metaIds]);
  const rootIds = new Set<number>();
  for (const item of meta.values()) rootIds.add(rootIdOf(item));
  const missingRoots = [...rootIds].filter((id) => !meta.has(id));
  if (missingRoots.length > 0) for (const [id, item] of await loadRuleMeta(missingRoots)) meta.set(id, item);

  const ruleRates = new Map<number, Rate>();
  for (const [ruleId, rate] of live) {
    const item = meta.get(ruleId);
    if (!item || item.pendingDelete || item.routeParentRuleId > 0) continue;
    addRate(ruleRates, rootIdOf(item), rate);
  }
  const userRates = new Map<number, Rate>();
  for (const [rootId, rate] of ruleRates) {
    const root = meta.get(rootId);
    if (root && root.userId > 0) addRate(userRates, root.userId, rate);
  }

  // 2. 到期 / 规则没了的临时限速：撤掉。到期但还在告警的，要再连续超线那么久才重新限。
  for (const throttle of throttled) {
    const root = meta.get(throttle.ruleId);
    if (root && !root.pendingDelete && throttle.expiresAt > nowMs) continue;
    await revokeThrottle(throttle.ruleId, root && !root.pendingDelete ? "expired" : "rule-gone");
    const state = states.get(`rule:${throttle.ruleId}`);
    if (state) state.overSince = null;
  }

  // 3. 规则和用户。只给「超过绝对下限、还没在告警」的查基线。
  const ruleCandidates = new Set<number>(ruleRates.keys());
  const userCandidates = new Set<number>(userRates.keys());
  for (const key of states.keys()) {
    const [kind, id] = key.split(":");
    if (kind === "rule") ruleCandidates.add(Number(id));
    if (kind === "user") userCandidates.add(Number(id));
  }
  const valueOf = (rate: Rate | undefined) => (rate ? dominantMbps(rate.inBps, rate.outBps) : 0);
  const needRuleBaseline = [...ruleCandidates].filter((id) => valueOf(ruleRates.get(id)) >= config.minMbps && !states.get(`rule:${id}`)?.firing);
  const needUserBaseline = [...userCandidates].filter((id) => valueOf(userRates.get(id)) >= config.minMbps && !states.get(`user:${id}`)?.firing);
  const ruleBaselines = needRuleBaseline.length > 0
    ? await baselinesFor("rule", needRuleBaseline.map((id) => ({ id, createdAt: meta.get(id)?.createdAt ?? 0 })), nowMs)
    : new Map<number, TrafficBaseline | null>();
  const users = await loadUsers([...userCandidates]);
  const userBaselines = needUserBaseline.length > 0
    ? await baselinesFor("user", needUserBaseline.map((id) => ({ id, createdAt: users.get(id)?.createdAt ?? 0 })), nowMs)
    : new Map<number, TrafficBaseline | null>();

  for (const ruleId of ruleCandidates) {
    const key = `rule:${ruleId}`;
    const root = meta.get(ruleId);
    const previous = states.get(key);
    const value = valueOf(ruleRates.get(ruleId));
    if (!root || root.pendingDelete) {
      states.delete(key);
      continue;
    }
    if (!previous && value < config.minMbps) continue;
    const baseline = ruleBaselines.get(ruleId)?.baselineMbps ?? null;
    const { state, transition } = judgeAnomalySample(previous ?? emptyAnomalyState(), {
      value,
      threshold: trafficAnomalyThreshold(baseline, config),
      baseline,
    }, judgeOptions);
    const next: ObjectState = { ...state, noThrottle: previous?.noThrottle };
    const subject: Subject = { kind: "rule", meta: root };
    if (transition?.kind === "fire") {
      next.noThrottle = false;
      let note = "";
      let applied: StoredAnomalyThrottle | null = null;
      if (config.autoThrottle) {
        const result = await applyThrottle(root, transition.threshold, transition.baseline, config, nowMs);
        applied = result.applied;
        if (applied) note = `；已自动限速到 ${applied.mbps} Mbps，${shanghaiTime(applied.expiresAt)} 自动撤掉`;
        else if (result.manualStricter) note = `；这条规则已有更严的手动限速（${root.rateLimitMbps} Mbps），没有再加`;
      }
      await emit(transition, {
        kind: "rule.traffic_surge",
        level: "warn",
        ruleId,
        userId: root.userId || null,
        hostId: root.hostId || null,
        data: {
          scope: "rule",
          valueMbps: transition.value,
          baselineMbps: transition.baseline,
          thresholdMbps: transition.threshold,
          multiplier: config.multiplier,
          sustainMinutes: config.sustainMinutes,
          throttle: applied ? { mbps: applied.mbps, until: applied.expiresAt } : null,
        },
      }, describeFire(subject, transition, config, note));
    } else if (transition?.kind === "recover") {
      const hadThrottle = !!getAnomalyThrottle(ruleId, nowMs);
      if (hadThrottle) await revokeThrottle(ruleId, "recovered");
      next.noThrottle = false;
      await emit(transition, {
        kind: "rule.traffic_surge.recovered",
        level: "info",
        ruleId,
        userId: root.userId || null,
        hostId: root.hostId || null,
        data: { scope: "rule", valueMbps: transition.value, peakMbps: transition.peak, durationSeconds: Math.round(transition.durationMs / 1000), throttleRevoked: hadThrottle },
      }, describeRecover(subject, transition, hadThrottle ? "，临时限速已撤掉" : ""));
    } else if (
      next.firing && config.autoThrottle && !next.noThrottle && next.threshold !== null
      && next.overSince !== null && nowMs - next.overSince >= judgeOptions.sustainMs - 5_000
      && !getAnomalyThrottle(ruleId, nowMs)
    ) {
      // 限速到期撤掉后还是一直超线：再限一轮（冷却里，不另发事件，规则卡上看得到）。
      await applyThrottle(root, next.threshold, next.baseline, config, nowMs);
    }
    if (isAnomalyStateIdle(next, nowMs, judgeOptions.cooldownMs) && !getAnomalyThrottle(ruleId, nowMs)) states.delete(key);
    else putState(key, next);
  }

  for (const userId of userCandidates) {
    const key = `user:${userId}`;
    const previous = states.get(key);
    const value = valueOf(userRates.get(userId));
    if (!previous && value < config.minMbps) continue;
    const baseline = userBaselines.get(userId)?.baselineMbps ?? null;
    const { state, transition } = judgeAnomalySample(previous ?? emptyAnomalyState(), {
      value,
      threshold: trafficAnomalyThreshold(baseline, config),
      baseline,
    }, judgeOptions);
    const subject: Subject = { kind: "user", userId, name: users.get(userId)?.name || `用户 #${userId}` };
    if (transition?.kind === "fire") {
      await emit(transition, {
        kind: "user.traffic_surge",
        level: "warn",
        userId,
        data: { scope: "user", valueMbps: transition.value, baselineMbps: transition.baseline, thresholdMbps: transition.threshold, multiplier: config.multiplier, sustainMinutes: config.sustainMinutes },
      }, describeFire(subject, transition, config, ""));
    } else if (transition?.kind === "recover") {
      await emit(transition, {
        kind: "user.traffic_surge.recovered",
        level: "info",
        userId,
        data: { scope: "user", valueMbps: transition.value, peakMbps: transition.peak, durationSeconds: Math.round(transition.durationMs / 1000) },
      }, describeRecover(subject, transition, ""));
    }
    if (isAnomalyStateIdle(state, nowMs, judgeOptions.cooldownMs)) states.delete(key);
    else putState(key, state);
  }

  // 4. 单 IP 连接数：同一条（根）规则上同一个 IP，几台入口机加起来。
  if (config.ipConnThreshold > 0) {
    const conns = new Map<string, { rootId: number; ip: string; conns: number }>();
    for (const row of onlineRows) {
      const item = meta.get(row.ruleId);
      if (!item || item.pendingDelete) continue;
      const rootId = rootIdOf(item);
      const key = `ip:${rootId}:${row.ip}`;
      const entry = conns.get(key) || { rootId, ip: row.ip, conns: 0 };
      entry.conns += Math.max(0, Number(row.conns) || 0);
      conns.set(key, entry);
    }
    const keys = new Set<string>([...conns.keys()].filter((key) => (conns.get(key)?.conns ?? 0) >= config.ipConnThreshold));
    for (const key of states.keys()) if (key.startsWith("ip:")) keys.add(key);
    for (const key of keys) {
      const [, rootText, ...ipParts] = key.split(":");
      const rootId = Number(rootText);
      const ip = ipParts.join(":");
      const root = meta.get(rootId);
      if (!root || root.pendingDelete) {
        states.delete(key);
        continue;
      }
      const { state, transition } = judgeAnomalySample(states.get(key) ?? emptyAnomalyState(), {
        value: conns.get(key)?.conns ?? 0,
        threshold: config.ipConnThreshold,
      }, judgeOptions);
      const subject: Subject = { kind: "ip", meta: root, ip };
      if (transition?.kind === "fire") {
        await emit(transition, {
          kind: "rule.ip_conn_surge",
          level: "warn",
          ruleId: rootId,
          userId: root.userId || null,
          hostId: root.hostId || null,
          data: { scope: "ip", ip, conns: transition.value, threshold: transition.threshold, sustainMinutes: config.sustainMinutes },
        }, describeFire(subject, transition, config, ""));
      } else if (transition?.kind === "recover") {
        await emit(transition, {
          kind: "rule.ip_conn_surge.recovered",
          level: "info",
          ruleId: rootId,
          userId: root.userId || null,
          hostId: root.hostId || null,
          data: { scope: "ip", ip, conns: transition.value, peak: transition.peak, durationSeconds: Math.round(transition.durationMs / 1000) },
        }, describeRecover(subject, transition, ""));
      }
      if (isAnomalyStateIdle(state, nowMs, judgeOptions.cooldownMs)) states.delete(key);
      else putState(key, state);
    }
  }
}

/** 设置页底下那一小块「正在限速」：哪几条、限到多少、什么时候撤。 */
export async function listActiveAnomalyThrottles(nowMs = Date.now()) {
  await loadAnomalyThrottles().catch(() => undefined);
  const active = listAnomalyThrottles().filter((item) => item.expiresAt > nowMs);
  if (active.length === 0) return [];
  const meta = await loadRuleMeta(active.map((item) => item.ruleId));
  return active
    .map((item) => ({
      ruleId: item.ruleId,
      ruleName: meta.get(item.ruleId)?.name || `#${item.ruleId}`,
      mbps: item.mbps,
      manualMbps: meta.get(item.ruleId)?.rateLimitMbps ?? 0,
      appliedAt: item.appliedAt,
      until: item.expiresAt,
    }))
    .sort((a, b) => a.until - b.until);
}

// ---------------- 定时任务 ----------------

let started = false;

/** 由 server/scheduler.ts 的 startScheduler() 调一次（开发面板不跑 scheduler，也就不跑这个）。 */
export function startTrafficAnomalyJob() {
  if (started) return;
  started = true;
  // 收回立刻做：上一次运行留下的临时限速，功能关了就别再多限一分钟。
  void recoverAnomalyThrottlesOnStartup().catch((error) => {
    appendPanelLog("warn", `[TrafficAnomaly] startup throttle recovery failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const task = createNonOverlappingScheduledTask("traffic anomaly detection", () => runTrafficAnomalyTick(), { slowTaskMs: 20_000 });
  // 启动后先等两分钟：Agent 还没重连、实时速率还是空的，这时判不出什么。
  const startTimer = setTimeout(() => {
    void task();
    const timer = setInterval(() => { void task(); }, TICK_MS);
    timer.unref?.();
  }, 2 * 60_000);
  startTimer.unref?.();
}
