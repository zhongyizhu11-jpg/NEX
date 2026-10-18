/**
 * 按带宽排序解析 (bandwidth-ranked entry records) —— 入口组的选项，2.3.454 前叫「多入口带宽加权分流」。
 *
 * 实际做的事（server/bandwidthAggregation.ts applyAggregationToDdnsValues）：入口域名照旧解析出
 * 全部健康入口，只是按带宽 / 权重 / 剩余带宽把它们排个先后。很多客户端和运营商 DNS 优先用排在前面的
 * 地址，所以大带宽的入口通常会接到更多客户端，但 DNS 给不出准确的比例 —— 以前的说法（按带宽分配
 * 解析份额、总吞吐接近各入口之和）说过头了。下面的英文说明是最初的设计，保留作背景。
 *
 * Not to be confused with the tunnel's relay bandwidth aggregation, which
 * splits a single connection across several relays. This module distributes
 * *different* clients across entry hosts by capacity; one connection still
 * rides one entry.
 *
 * An entry group gathers several front VPS hosts behind one entry domain. By
 * default every healthy member is published, so client connections land on an
 * arbitrary member and the usable throughput is roughly that of a single VPS.
 *
 * Aggregation mode adds a capacity model on top of that: every member declares
 * an uplink bandwidth, the panel derives a weight per member, and the entry
 * records are emitted so that the share of client connections a member receives
 * tracks the bandwidth it can actually carry. The aggregate throughput of the
 * group then approaches the sum of its members instead of the smallest one.
 *
 * This module holds the pure math and normalization. It has no database or
 * network dependency so both the panel server and the browser can use it.
 */

export const BANDWIDTH_AGGREGATION_STRATEGIES = [
  "weighted",
  "equal",
  "capacity",
  "adaptive",
] as const;

export type BandwidthAggregationStrategy = (typeof BANDWIDTH_AGGREGATION_STRATEGIES)[number];

export const BANDWIDTH_AGGREGATION_STRATEGY_LABELS: Record<BandwidthAggregationStrategy, string> = {
  weighted: "按权重 - 权重高的排前面",
  equal: "不分先后 - 不看带宽",
  capacity: "按带宽 - 带宽大的排前面",
  adaptive: "按剩余带宽 - 现在闲的排前面",
};

export const BANDWIDTH_AGGREGATION_STRATEGY_HINTS: Record<BandwidthAggregationStrategy, string> = {
  weighted: "按每个入口手动设置的权重排先后。",
  equal: "不看带宽，所有健康入口一视同仁，适合同规格机器。",
  capacity: "按每个入口的线路带宽排先后，带宽大的在前。",
  adaptive: "在带宽的基础上扣掉实时已用带宽，现在剩余带宽多的排前面。",
};

/** Largest weight a single member may carry. Keeps record expansion bounded. */
export const MAX_MEMBER_WEIGHT = 100;
/** Largest declared uplink per member, in Mbps (100 Gbps). */
export const MAX_MEMBER_BANDWIDTH_MBPS = 100_000;
/** Upper bound for the emitted weighted record slot count. */
export const MAX_AGGREGATION_RECORD_SLOTS = 32;
/** Default slot budget used when a group does not pin one. */
export const DEFAULT_AGGREGATION_RECORD_SLOTS = 8;

export function normalizeBandwidthAggregationStrategy(value: unknown): BandwidthAggregationStrategy {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (BANDWIDTH_AGGREGATION_STRATEGIES as readonly string[]).includes(normalized)
    ? normalized as BandwidthAggregationStrategy
    : "capacity";
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Declared uplink bandwidth of one front VPS, in Mbps. `0` means unknown. */
export function normalizeMemberBandwidthMbps(value: unknown) {
  return clampInteger(value, 0, MAX_MEMBER_BANDWIDTH_MBPS, 0);
}

/** Manual weight of one front VPS. `0` means "derive it from bandwidth". */
export function normalizeMemberWeight(value: unknown) {
  return clampInteger(value, 0, MAX_MEMBER_WEIGHT, 0);
}

export function normalizeAggregationRecordSlots(value: unknown) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AGGREGATION_RECORD_SLOTS;
  return Math.min(MAX_AGGREGATION_RECORD_SLOTS, Math.max(1, parsed));
}

/** Minimum healthy members required before aggregation stays engaged. */
export function normalizeAggregationMinMembers(value: unknown) {
  return clampInteger(value, 1, 5, 1);
}

export type BandwidthAggregationMemberInput = {
  memberId: number;
  /** Address published for this member, e.g. an A record value. */
  value: string;
  /** Declared uplink capacity in Mbps. */
  bandwidthMbps?: number | null;
  /** Manual weight override. `0`/null falls back to the strategy default. */
  weight?: number | null;
  /** Measured throughput of the member right now, in Mbps. */
  usedMbps?: number | null;
  healthy?: boolean;
  label?: string | null;
};

export type BandwidthAggregationMemberPlan = {
  memberId: number;
  value: string;
  label: string;
  healthy: boolean;
  /** Declared uplink capacity in Mbps, `0` when the operator left it blank. */
  bandwidthMbps: number;
  /** Effective capacity used for the math, after the unknown-capacity fallback. */
  effectiveBandwidthMbps: number;
  /** Measured throughput in Mbps. */
  usedMbps: number;
  /** Capacity still available on this member, in Mbps. */
  availableMbps: number;
  /** Fraction of the member's capacity currently in use, 0..1. */
  utilization: number;
  /** Relative weight after strategy normalization. */
  weight: number;
  /** Share of new connections this member should receive, 0..1. */
  share: number;
  /** How many published record slots this member occupies. */
  recordSlots: number;
  /** Share of a group rate limit budget assigned to this member, in Mbps. */
  rateLimitMbps: number;
};

export type BandwidthAggregationPlan = {
  enabled: boolean;
  strategy: BandwidthAggregationStrategy;
  /** Members that carry traffic, ordered by descending share. */
  members: BandwidthAggregationMemberPlan[];
  /** Healthy member count. */
  healthyCount: number;
  /** Sum of the healthy members' declared capacity, in Mbps. */
  aggregateCapacityMbps: number;
  /** Sum of the healthy members' measured throughput, in Mbps. */
  aggregateUsedMbps: number;
  /** Capacity still free across the healthy members, in Mbps. */
  aggregateAvailableMbps: number;
  /** Aggregate utilization across healthy members, 0..1. */
  utilization: number;
  /** Record values in weighted publish order, ready for the DDNS provider. */
  recordValues: string[];
  /**
   * True when aggregation was requested but could not engage, e.g. too few
   * healthy members. The caller keeps its plain multi-entry behaviour.
   */
  degraded: boolean;
  /** Human readable reason, empty when aggregation engaged normally. */
  reason: string;
};

/**
 * Capacity assumed for a member that declares no bandwidth. Using the median of
 * the members that did declare one keeps a single blank entry from collapsing
 * or dominating the distribution.
 */
function fallbackCapacityMbps(declared: number[]) {
  const known = declared.filter((value) => value > 0).sort((left, right) => left - right);
  if (known.length === 0) return 100;
  const middle = Math.floor(known.length / 2);
  return known.length % 2 === 1 ? known[middle] : Math.round((known[middle - 1] + known[middle]) / 2);
}

function rawWeightFor(
  strategy: BandwidthAggregationStrategy,
  member: { weight: number; effectiveBandwidthMbps: number; availableMbps: number },
) {
  if (member.weight > 0 && strategy !== "equal") return member.weight;
  switch (strategy) {
    case "equal":
      return 1;
    case "weighted":
      // No manual weight set: fall back to an equal share rather than zero so
      // the member still carries traffic.
      return 1;
    case "adaptive":
      // Headroom drives the split. A saturated member keeps a small floor so it
      // recovers share once its throughput drops again.
      return Math.max(member.availableMbps, member.effectiveBandwidthMbps * 0.05);
    case "capacity":
    default:
      return member.effectiveBandwidthMbps;
  }
}

/**
 * Convert fractional shares into whole record slots using the largest-remainder
 * method, so the emitted slots stay proportional and always sum to `slots`.
 */
export function allocateRecordSlots(shares: number[], slots: number) {
  const total = shares.reduce((sum, share) => sum + Math.max(0, share), 0);
  const budget = Math.max(0, Math.floor(slots));
  if (shares.length === 0 || budget <= 0 || total <= 0) return shares.map(() => 0);
  if (budget <= shares.length) {
    // Not enough slots for everyone: hand them to the largest shares first.
    const order = shares
      .map((share, index) => ({ share, index }))
      .sort((left, right) => right.share - left.share || left.index - right.index);
    const out = shares.map(() => 0);
    for (let i = 0; i < budget; i += 1) out[order[i].index] = 1;
    return out;
  }
  // Guarantee one slot each, then distribute the remainder proportionally.
  const remaining = budget - shares.length;
  const exact = shares.map((share) => (Math.max(0, share) / total) * remaining);
  const base = exact.map((value) => Math.floor(value));
  let assigned = base.reduce((sum, value) => sum + value, 0);
  const remainders = exact
    .map((value, index) => ({ remainder: value - Math.floor(value), index }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let i = 0; assigned < remaining && i < remainders.length; i += 1) {
    base[remainders[i].index] += 1;
    assigned += 1;
  }
  return base.map((value) => value + 1);
}

/**
 * Interleave the per-member record slots so the published list alternates
 * between members instead of listing one member's slots back to back. Resolvers
 * that only hand out a prefix of the record set then still see every member.
 */
export function interleaveRecordValues(entries: Array<{ value: string; slots: number }>) {
  const pending = entries.map((entry) => ({ value: entry.value, left: Math.max(0, Math.floor(entry.slots)) }));
  const out: string[] = [];
  let remaining = pending.reduce((sum, entry) => sum + entry.left, 0);
  while (remaining > 0) {
    let progressed = false;
    for (const entry of pending) {
      if (entry.left <= 0) continue;
      out.push(entry.value);
      entry.left -= 1;
      remaining -= 1;
      progressed = true;
    }
    if (!progressed) break;
  }
  return out;
}

export type BandwidthAggregationOptions = {
  enabled?: boolean;
  strategy?: unknown;
  /** Total published record slots. Defaults to `DEFAULT_AGGREGATION_RECORD_SLOTS`. */
  recordSlots?: unknown;
  /** Minimum healthy members before aggregation engages. */
  minHealthyMembers?: unknown;
  /** Group-wide rate limit in Mbps, split across members. `0` disables it. */
  rateLimitMbps?: number | null;
  /** Records that must be unique, e.g. CNAME. Forces one slot per member. */
  singleValuePerMember?: boolean;
};

/**
 * Build the aggregation plan for one entry group.
 *
 * Unhealthy members are dropped from the distribution but still reported so the
 * UI can show why the aggregate capacity fell.
 */
export function buildBandwidthAggregationPlan(
  members: BandwidthAggregationMemberInput[],
  options: BandwidthAggregationOptions = {},
): BandwidthAggregationPlan {
  const strategy = normalizeBandwidthAggregationStrategy(options.strategy);
  const enabled = options.enabled !== false;
  const minHealthy = normalizeAggregationMinMembers(options.minHealthyMembers);
  const slots = options.singleValuePerMember
    ? Math.max(1, members.length)
    : normalizeAggregationRecordSlots(options.recordSlots);
  const rateLimitMbps = Math.max(0, Math.floor(Number(options.rateLimitMbps) || 0));

  const declared = members.map((member) => normalizeMemberBandwidthMbps(member.bandwidthMbps));
  const fallbackCapacity = fallbackCapacityMbps(declared);

  const prepared = members.map((member, index) => {
    const bandwidthMbps = declared[index];
    const effectiveBandwidthMbps = bandwidthMbps > 0 ? bandwidthMbps : fallbackCapacity;
    const usedMbps = Math.max(0, Math.round(Number(member.usedMbps) || 0));
    return {
      memberId: Number(member.memberId || 0),
      value: String(member.value || "").trim(),
      label: String(member.label || "").trim() || String(member.value || "").trim(),
      healthy: member.healthy !== false,
      bandwidthMbps,
      effectiveBandwidthMbps,
      usedMbps,
      availableMbps: Math.max(0, effectiveBandwidthMbps - usedMbps),
      utilization: effectiveBandwidthMbps > 0
        ? Math.min(1, usedMbps / effectiveBandwidthMbps)
        : 0,
      weight: normalizeMemberWeight(member.weight),
    };
  }).filter((member) => !!member.value);

  const healthy = prepared.filter((member) => member.healthy);
  const aggregateCapacityMbps = healthy.reduce((sum, member) => sum + member.effectiveBandwidthMbps, 0);
  const aggregateUsedMbps = healthy.reduce((sum, member) => sum + member.usedMbps, 0);
  const aggregateAvailableMbps = Math.max(0, aggregateCapacityMbps - aggregateUsedMbps);
  const utilization = aggregateCapacityMbps > 0
    ? Math.min(1, aggregateUsedMbps / aggregateCapacityMbps)
    : 0;

  const degraded = enabled && healthy.length < minHealthy;
  const reason = !enabled
    ? ""
    : healthy.length === 0
      ? "没有健康的前置主机，带宽聚合暂停"
      : degraded
        ? `健康前置 ${healthy.length} 台少于聚合下限 ${minHealthy} 台，暂按等量分配`
        : "";

  // When aggregation is off or degraded, every healthy member still gets an
  // equal share so the entry group keeps working exactly as before.
  const useWeights = enabled && !degraded && healthy.length > 0;
  const rawWeights = healthy.map((member) => (useWeights ? Math.max(0, rawWeightFor(strategy, member)) : 1));
  const rawTotal = rawWeights.reduce((sum, weight) => sum + weight, 0);
  const shares = rawWeights.map((weight) => (rawTotal > 0 ? weight / rawTotal : 1 / Math.max(1, healthy.length)));
  const allocatedSlots = allocateRecordSlots(shares, options.singleValuePerMember ? healthy.length : slots);

  const healthyPlans: BandwidthAggregationMemberPlan[] = healthy.map((member, index) => ({
    memberId: member.memberId,
    value: member.value,
    label: member.label,
    healthy: true,
    bandwidthMbps: member.bandwidthMbps,
    effectiveBandwidthMbps: member.effectiveBandwidthMbps,
    usedMbps: member.usedMbps,
    availableMbps: member.availableMbps,
    utilization: member.utilization,
    weight: Math.round(shares[index] * 1000) / 10,
    share: shares[index],
    recordSlots: allocatedSlots[index] ?? 0,
    rateLimitMbps: rateLimitMbps > 0 ? Math.max(1, Math.round(rateLimitMbps * shares[index])) : 0,
  }));

  const unhealthyPlans: BandwidthAggregationMemberPlan[] = prepared
    .filter((member) => !member.healthy)
    .map((member) => ({
      memberId: member.memberId,
      value: member.value,
      label: member.label,
      healthy: false,
      bandwidthMbps: member.bandwidthMbps,
      effectiveBandwidthMbps: member.effectiveBandwidthMbps,
      usedMbps: member.usedMbps,
      availableMbps: member.availableMbps,
      utilization: member.utilization,
      weight: 0,
      share: 0,
      recordSlots: 0,
      rateLimitMbps: 0,
    }));

  const ordered = [...healthyPlans].sort((left, right) => right.share - left.share || left.memberId - right.memberId);
  const recordValues = interleaveRecordValues(ordered.map((member) => ({
    value: member.value,
    slots: options.singleValuePerMember ? Math.min(1, member.recordSlots) : member.recordSlots,
  })));

  return {
    enabled,
    strategy,
    members: [...ordered, ...unhealthyPlans],
    healthyCount: healthy.length,
    aggregateCapacityMbps,
    aggregateUsedMbps,
    aggregateAvailableMbps,
    utilization,
    recordValues,
    degraded,
    reason,
  };
}

/** Format a Mbps figure for display, switching to Gbps past 1000 Mbps. */
export function formatBandwidthMbps(value: number | null | undefined) {
  const mbps = Math.max(0, Math.round(Number(value) || 0));
  if (mbps <= 0) return "-";
  if (mbps < 1000) return `${mbps} Mbps`;
  const gbps = mbps / 1000;
  return `${gbps >= 10 ? gbps.toFixed(0) : gbps.toFixed(1)} Gbps`;
}

/** Format a 0..1 utilization ratio as a percentage string. */
export function formatAggregationUtilization(value: number | null | undefined) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio <= 0) return "0%";
  return `${Math.min(100, Math.round(ratio * 100))}%`;
}
