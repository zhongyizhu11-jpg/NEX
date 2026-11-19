/*
  入口组「按权重解析」：把带宽聚合算出来的份额写成 DNS 服务商的记录权重，解析时真的按比例返回各个入口。

  以前的「按带宽排序解析」只是把记录排个先后 —— 一个名字下的多条记录在 DNS 里是无序的集合，排序到不了
  客户端（见 shared/bandwidthAggregation.ts 开头）。真正能按比例分的只有服务商自己的记录权重：

    腾讯云 DNSPod   记录的 Weight（0～100，0 = 关闭）
    阿里云 DNS      同名 A / AAAA 记录的「权重配置」（SetDNSSLBStatus 打开，UpdateDNSSLBWeight 设 1～100）
    华为云 DNS      记录集的 weight（0～1000）：一个值一个记录集，各带各的权重
    Cloudflare      普通 DNS 记录没有权重（那是它的 Load Balancing 产品）—— 不支持
    Webhook         面板只把值交给你的接口 —— 不支持

  这里是界面和服务端共用的纯逻辑：哪家支持、份额怎么换成权重、权重变多少才值得重写一次记录。
*/

import type { BandwidthAggregationPlan } from "./bandwidthAggregation";

export const DDNS_WEIGHT_MIN = 1;
export const DDNS_WEIGHT_MAX = 100;

export const DDNS_WEIGHT_PROVIDERS = ["tencentcloud", "aliyun", "huaweicloud"] as const;
export type DdnsWeightProvider = (typeof DDNS_WEIGHT_PROVIDERS)[number];

export type DdnsWeightSupport = {
  supported: boolean;
  provider: DdnsWeightProvider | null;
  /** 不支持时给人看的一句话。 */
  reason: string | null;
};

const UNSUPPORTED_REASONS: Record<string, string> = {
  cloudflare: "Cloudflare 的普通 DNS 记录没有权重（按比例分流是它单独收费的 Load Balancing），用不了按权重解析",
  webhook: "Webhook 方式面板只把入口地址交给你的接口，记录权重不归面板管，用不了按权重解析",
  disabled: "系统 DDNS 没有启用，用不了按权重解析",
};

/** 现在的 DDNS 服务商能不能按记录权重发布。只看是哪一家；凭据填没填全由服务端另外判断。 */
export function ddnsWeightSupportForProvider(provider: unknown, enabled: unknown = true): DdnsWeightSupport {
  const name = String(provider || "disabled").trim().toLowerCase();
  if (enabled === false || name === "disabled" || !name) return { supported: false, provider: null, reason: UNSUPPORTED_REASONS.disabled };
  if ((DDNS_WEIGHT_PROVIDERS as readonly string[]).includes(name)) return { supported: true, provider: name as DdnsWeightProvider, reason: null };
  return { supported: false, provider: null, reason: UNSUPPORTED_REASONS[name] || "当前 DDNS 服务商不支持记录权重，用不了按权重解析" };
}

/** 记录类型能不能带权重：CNAME 一个名字只能有一条，没有「按比例」可言。 */
export function ddnsWeightRecordTypeSupported(recordType: unknown) {
  const type = String(recordType || "A").trim().toUpperCase();
  return type === "A" || type === "AAAA";
}

export type DdnsWeights = Record<string, number>;

/**
 * 聚合计划的份额换成记录权重：份额最大的入口是 100，其余按比例（最小 1）。
 * 聚合没生效（没开、健康入口不够下限）、要发布的值不足两条、或者有值在计划里找不到成员时返回 null ——
 * 这一轮不带权重，按原来的方式发布。
 */
export function ddnsWeightsFromAggregationPlan(plan: Pick<BandwidthAggregationPlan, "enabled" | "degraded" | "members"> | null | undefined, values: readonly string[]): DdnsWeights | null {
  if (!plan || !plan.enabled || plan.degraded) return null;
  const wanted = Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
  if (wanted.length < 2) return null;
  const shareByValue = new Map<string, number>();
  for (const member of plan.members) {
    if (!member.healthy || !(member.share > 0)) continue;
    // 两个成员发布同一个值（同一台机器挂了两次）时份额相加。
    shareByValue.set(member.value, (shareByValue.get(member.value) || 0) + member.share);
  }
  if (wanted.some((value) => !shareByValue.has(value))) return null;
  const largest = Math.max(...wanted.map((value) => shareByValue.get(value) || 0));
  if (!(largest > 0)) return null;
  const weights: DdnsWeights = {};
  for (const value of wanted) {
    const scaled = Math.round(((shareByValue.get(value) || 0) / largest) * DDNS_WEIGHT_MAX);
    weights[value] = Math.min(DDNS_WEIGHT_MAX, Math.max(DDNS_WEIGHT_MIN, scaled));
  }
  return weights;
}

/**
 * 两份权重算不算「一样」：值的集合相同，而且每个值的权重差不超过 tolerance。
 * 「按剩余带宽」的份额跟着实时流量动，tolerance 给它留一点死区，免得流量一抖就改一次解析。
 */
export function ddnsWeightsEqual(left: DdnsWeights | null | undefined, right: DdnsWeights | null | undefined, tolerance = 0) {
  if (!left || !right) return !left && !right;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => key in right && Math.abs(Number(left[key]) - Number(right[key])) <= tolerance);
}

/** 「按剩余带宽」时权重变化不到这么多（满分 100）就不重写记录。 */
export const DDNS_WEIGHT_ADAPTIVE_TOLERANCE = 15;

/** 组里存的「上一次按权重发出去的是什么」（ddnsWeightState，JSON）。 */
export type DdnsWeightState = {
  provider: string;
  domain: string;
  recordType: string;
  weights: DdnsWeights;
};

export function parseDdnsWeightState(raw: unknown): DdnsWeightState | null {
  if (!raw) return null;
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<DdnsWeightState>;
    const weights: DdnsWeights = {};
    for (const [key, weight] of Object.entries(item.weights || {})) {
      const number = Math.round(Number(weight));
      if (key && Number.isFinite(number) && number >= DDNS_WEIGHT_MIN && number <= DDNS_WEIGHT_MAX) weights[key] = number;
    }
    if (Object.keys(weights).length === 0) return null;
    return {
      provider: String(item.provider || ""),
      domain: String(item.domain || "").trim().toLowerCase(),
      recordType: String(item.recordType || "A").trim().toUpperCase(),
      weights,
    };
  } catch {
    return null;
  }
}

/** 状态消息里的那句：1.2.3.4=100、5.6.7.8=40。 */
export function describeDdnsWeights(weights: DdnsWeights, order: readonly string[] = Object.keys(weights)) {
  return order.filter((value) => value in weights).map((value) => `${value}=${weights[value]}`).join("、");
}
