/*
  流量异常的自动临时限速：存哪、心跳怎么叠上去、规则卡怎么看得到。判定和加 / 撤的时机在 trafficAnomaly.ts。

  - 不改规则自己的 rateLimitMbps：那是人手动设的（而且一设就成了「管理员管理的规则」）。临时限速另存一张表，
    下发时在规则这一级上取「手动的、临时的」里严的那个（combineRuleRateWithThrottle）。撤掉就是删这一行，
    手动的那个数从头到尾没被碰过。
  - 心跳读内存（这里的 throttles），不查库；落库只为面板重启后能收回（trafficAnomaly.ts 启动时读一遍）。
  - 规则卡要显示「异常自动限速，到 HH:MM」：规则列表接口用 withAnomalyThrottles 顺手带上。第一次用到时
    才从库里读一遍（开发面板不跑定时任务，也要看得到演示数据）。
*/
import { executeRaw, queryRaw, quoteDbIdentifier, rawEpochToDate } from "../dbRuntime";
import { ruleLimitRootId } from "../ruleLimits";
import { combineRuleRateWithThrottle, type AnomalyThrottle } from "../../shared/trafficAnomaly";

const TABLE = "traffic_anomaly_throttles";
const q = quoteDbIdentifier;

export type StoredAnomalyThrottle = AnomalyThrottle & { baselineMbps: number; thresholdMbps: number };

const throttles = new Map<number, StoredAnomalyThrottle>();
let loadPromise: Promise<void> | null = null;

function epochMs(value: unknown) {
  return rawEpochToDate(value)?.getTime() ?? 0;
}

/** 从库里读一遍（force：启动收回时重读）。读失败不抛：当作没有，下次再读。 */
export function loadAnomalyThrottles(force = false): Promise<void> {
  if (loadPromise && !force) return loadPromise;
  loadPromise = (async () => {
    const rows = await queryRaw<Record<string, unknown>>(`SELECT * FROM ${q(TABLE)}`);
    throttles.clear();
    for (const row of rows) {
      const ruleId = Number(row.ruleId);
      if (!(ruleId > 0)) continue;
      throttles.set(ruleId, {
        ruleId,
        mbps: Math.max(0, Number(row.mbps) || 0),
        baselineMbps: (Number(row.baselineDeciMbps) || 0) / 10,
        thresholdMbps: (Number(row.thresholdDeciMbps) || 0) / 10,
        appliedAt: epochMs(row.appliedAt),
        expiresAt: epochMs(row.expiresAt),
      });
    }
  })().catch((error) => {
    loadPromise = null;
    throw error;
  });
  return loadPromise;
}

/** 内存里的全部（含已过期、还没来得及撤的）。 */
export function listAnomalyThrottles(): StoredAnomalyThrottle[] {
  return Array.from(throttles.values());
}

export function getAnomalyThrottle(ruleId: number, nowMs = Date.now()): StoredAnomalyThrottle | null {
  const throttle = throttles.get(Number(ruleId));
  return throttle && throttle.expiresAt > nowMs ? throttle : null;
}

/**
 * 心跳下发用：规则这一级实际的限速（Mbps）。rootRuleId 是 ruleLimitRootId(rule)，manualMbps 是规则行上人设的那个数。
 * 过了到期时间的即使还没撤（定时任务一分钟一轮），这里也不再叠。
 */
export function anomalyAwareRuleMbps(rootRuleId: number, manualMbps: unknown, nowMs = Date.now()) {
  if (throttles.size === 0) return Math.max(0, Math.floor(Number(manualMbps) || 0));
  return combineRuleRateWithThrottle(manualMbps, throttles.get(Number(rootRuleId)), nowMs);
}

export async function saveAnomalyThrottle(throttle: StoredAnomalyThrottle) {
  // 同一条规则只留一行：先删再插，三种库都不用写各自的 upsert。
  await executeRaw(`DELETE FROM ${q(TABLE)} WHERE ${q("ruleId")} = ?`, [throttle.ruleId]);
  await executeRaw(
    `INSERT INTO ${q(TABLE)} (${["ruleId", "mbps", "baselineDeciMbps", "thresholdDeciMbps", "appliedAt", "expiresAt"].map(q).join(", ")}) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      throttle.ruleId,
      Math.max(1, Math.floor(throttle.mbps)),
      Math.round(Math.max(0, throttle.baselineMbps) * 10),
      Math.round(Math.max(0, throttle.thresholdMbps) * 10),
      Math.floor(throttle.appliedAt / 1000),
      Math.floor(throttle.expiresAt / 1000),
    ],
  );
  throttles.set(throttle.ruleId, { ...throttle });
}

export async function deleteAnomalyThrottle(ruleId: number) {
  await executeRaw(`DELETE FROM ${q(TABLE)} WHERE ${q("ruleId")} = ?`, [Number(ruleId)]);
  return throttles.delete(Number(ruleId));
}

type ThrottleView = { mbps: number; until: number };

/** 给规则列表的每一行带上 anomalyThrottle（没有就是 null）。读不到表时原样返回。 */
export async function withAnomalyThrottles<T>(value: T, nowMs = Date.now()): Promise<T> {
  try {
    await loadAnomalyThrottles();
  } catch {
    return value;
  }
  if (throttles.size === 0) return value;
  const decorate = (rule: Record<string, unknown>) => {
    const throttle = getAnomalyThrottle(ruleLimitRootId(rule), nowMs);
    const view: ThrottleView | null = throttle ? { mbps: throttle.mbps, until: throttle.expiresAt } : null;
    return view ? { ...rule, anomalyThrottle: view } : rule;
  };
  if (Array.isArray(value)) return value.map(decorate) as T;
  const items = (value as { items?: unknown } | null)?.items;
  if (Array.isArray(items)) return { ...(value as object), items: items.map(decorate) } as T;
  return value;
}

export function resetAnomalyThrottlesForTest() {
  throttles.clear();
  loadPromise = null;
}
