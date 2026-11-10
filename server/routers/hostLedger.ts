import { z } from "zod";
import { adminProcedure } from "../_core/trpc";
import { getHosts, nextHostBillingExpiry } from "../repositories/hostRepository";
import { getHostTrafficSummary } from "../repositories/metricsRepository";
import { getHostRateBuckets } from "../hostRateBuckets";
import { hostTrafficUsedBytes } from "../../shared/hostTrafficQuota";
import {
  buildHostLedgerRow,
  HOST_COST_CURRENCIES,
  HOST_COST_MAX_CENTS,
  hostP95Period,
  normalizeHostBandwidthBilling,
  normalizeHostCostCents,
  normalizeHostCostCurrency,
  summarizeHostLedger,
} from "../../shared/hostLedger";

/*
  主机账本（trpc.hosts.ledger）和主机表单里那几项费用字段。

  只给管理员：机器的费用、到期、计费方式本来就只有管理员能填（hosts.create / update 里
  租户传的计费字段一律被丢掉），账本也就只有管理员看。

  账本只读：到期时间读 stoppedAt（「周期顺延」的机器过了期还没被定时任务推过去时，这里按同一个
  nextHostBillingExpiry 往后推一期给人看，不写库）；已用量读 host_traffic_counters，和主机卡片、
  流量提醒、流量故障转移同一个口径（hostTrafficUsedBytes）。
*/

const costCentsSchema = z.number().int().min(0).max(HOST_COST_MAX_CENTS);

/** 挂进 hosts.create / hosts.update 的入参（都是可选的，不传就不改）。 */
export const hostCostInputShape = {
  /** 每期费用（分）；0 = 没填。 */
  costCents: costCentsSchema.optional(),
  costCurrency: z.enum(HOST_COST_CURRENCIES).optional(),
  bandwidthBilling: z.enum(["fixed", "p95"]).optional(),
  /** 95 单价（分 / Mbps / 月），币种跟 costCurrency。 */
  p95PriceCents: costCentsSchema.optional(),
};

const HOST_COST_FIELDS = ["costCents", "costCurrency", "bandwidthBilling", "p95PriceCents"] as const;

/**
 * 收敛 create / update 里传进来的费用字段（原地改 data）。
 * 不是管理员就全部丢掉，和同一个表单里的到期时间、套餐流量一个待遇。
 */
export function applyHostCostInput(data: Record<string, unknown>, isAdmin: boolean) {
  if (!isAdmin) {
    for (const field of HOST_COST_FIELDS) delete data[field];
    return data;
  }
  if (data.costCents !== undefined) data.costCents = normalizeHostCostCents(data.costCents);
  if (data.costCurrency !== undefined) data.costCurrency = normalizeHostCostCurrency(data.costCurrency);
  if (data.bandwidthBilling !== undefined) data.bandwidthBilling = normalizeHostBandwidthBilling(data.bandwidthBilling);
  if (data.p95PriceCents !== undefined) data.p95PriceCents = normalizeHostCostCents(data.p95PriceCents);
  return data;
}

function timeMs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * 账本上的「下次到期」。
 *
 * 开了「周期顺延」的机器，过了 stoppedAt 之后由定时任务（extendDueHostBillingPeriods）往后推；
 * 推之前的那一小会儿，账本上不该显示「已过期」—— 照同一个算法往后推到未来那一期，只用来展示。
 */
export function hostLedgerExpiryMs(host: Record<string, unknown>, nowMs: number): number | null {
  const stoppedAtMs = timeMs(host.stoppedAt);
  if (stoppedAtMs === null) return null;
  if (host.expiryHandling !== "extend_cycle" || stoppedAtMs > nowMs) return stoppedAtMs;
  let next = new Date(stoppedAtMs);
  for (let guard = 0; guard < 1200 && next.getTime() <= nowMs; guard += 1) {
    next = nextHostBillingExpiry(next, host.billingCycleMonths, host.billingMonth, host.billingDay);
  }
  return next.getTime();
}

export async function loadHostLedger(nowMs = Date.now()) {
  const hosts = await getHosts() as Array<Record<string, unknown> & { id: number; name: string }>;
  const ids = hosts.map((host) => Number(host.id));
  const counters = await getHostTrafficSummary(ids);
  const counterByHost = new Map(counters.map((row) => [Number(row.hostId), row]));
  const p95Hosts = hosts.filter((host) => normalizeHostBandwidthBilling(host.bandwidthBilling) === "p95");
  // 每台的账单日可能不同，一次按最早的那个周期起点查齐。
  const since = p95Hosts.reduce((earliest, host) => Math.min(earliest, hostP95Period(host.billingDay, nowMs).startMs), nowMs);
  const buckets = p95Hosts.length > 0
    ? await getHostRateBuckets(p95Hosts.map((host) => Number(host.id)), Math.floor(since / 1000))
    : new Map();
  const rows = hosts.map((host) => {
    const counter = counterByHost.get(Number(host.id));
    return buildHostLedgerRow({
      host,
      expiresAtMs: hostLedgerExpiryMs(host, nowMs),
      usedBytes: hostTrafficUsedBytes(counter, host.trafficMeasureMode),
      // 计数器没清过零就从它第一次建起算；一条都还没报过的机器没有起点。
      counterStartMs: counter && counter.id ? timeMs(counter.resetAt) ?? timeMs(counter.createdAt) : null,
      rateBuckets: buckets.get(Number(host.id)) ?? null,
      nowMs,
    });
  });
  return { rows, summary: summarizeHostLedger(rows), generatedAt: nowMs };
}

export const hostLedgerProcedures = {
  /** 主机管理 →「账本」页签：每台一行 + 顶上的合计。 */
  ledger: adminProcedure.query(() => loadHostLedger()),
};
