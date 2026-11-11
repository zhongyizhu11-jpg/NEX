/*
  主机探测服务的「三网视图」：把打了运营商标签（电信 / 联通 / 移动）的探测服务按运营商分组，
  看每台主机到三网的当前 RTT、失败率和 24 小时走势。

  只是换个角度看已有的探测数据（host_probe_service_stats），不新增采集，也不改 Agent 协议：
  服务上多一个可选的 carrier 字段（ct / cu / cm），其余照旧。

  语义上要说清楚的两件事：
    · Ping 的失败叫「丢包」，TCPing 的失败叫「TCP 失败」（连接没建立），两者不是一回事；
    · 探的是一个固定目标，目标不回（ICMP 限速、维护、换地址）不等于这家运营商整体断了。
*/

export const PROBE_CARRIERS = ["ct", "cu", "cm"] as const;
export type ProbeCarrier = (typeof PROBE_CARRIERS)[number];

export const PROBE_CARRIER_LABELS: Record<ProbeCarrier, string> = { ct: "电信", cu: "联通", cm: "移动" };

/** 三条线在图上的颜色（主题令牌，换主题跟着变）。 */
export const PROBE_CARRIER_COLORS: Record<ProbeCarrier, string> = {
  ct: "var(--fx-chart-1)",
  cu: "var(--fx-cat-orange)",
  cm: "var(--fx-chart-5)",
};

export function normalizeProbeCarrier(value: unknown): ProbeCarrier | null {
  const text = String(value ?? "").trim().toLowerCase();
  return (PROBE_CARRIERS as readonly string[]).includes(text) ? (text as ProbeCarrier) : null;
}

/**
 * 「上海三网」默认方案（ludehonghaha 2.3.293 验证过的那一组）：电信、移动用 Ping，联通用 TCPing 53 ——
 * 上海联通那台 DNS 不回 ICMP，Ping 它会一直「丢包」，看起来像联通断了。
 */
export const SHANGHAI_CARRIER_PRESET: ReadonlyArray<{ carrier: ProbeCarrier; name: string; method: "ping" | "tcping"; targetIp: string; targetPort: number | null }> = [
  { carrier: "ct", name: "上海电信 Ping", method: "ping", targetIp: "202.96.209.5", targetPort: null },
  { carrier: "cu", name: "上海联通 TCPing", method: "tcping", targetIp: "210.22.84.3", targetPort: 53 },
  { carrier: "cm", name: "上海移动 Ping", method: "ping", targetIp: "211.136.150.66", targetPort: null },
];
export const SHANGHAI_PRESET_INTERVAL_SECONDS = 60;

export const CARRIER_VIEW_HOURS = 24;
/** 小走势一格多宽：30 分钟，24 小时 48 格。 */
export const CARRIER_TREND_BUCKET_SECONDS = 30 * 60;
/** 「当前」RTT 只认最近 15 分钟内的样本，再老的不算当前。 */
export const CARRIER_CURRENT_MAX_AGE_SECONDS = 15 * 60;

export type CarrierServiceRef = {
  id: number;
  name: string;
  carrier: ProbeCarrier;
  method: string;
  targetIp: string;
  targetPort: number | null;
  isEnabled: boolean;
};

/** 探测序列的一个桶（hostProbeServiceRepository.getHostProbeServiceSeries 的一行）。 */
export type CarrierSeriesRow = {
  serviceId: number;
  hostId: number;
  latencyMs: number | null;
  probeCount: number;
  probeSuccesses: number;
  /** 秒 */
  at: number;
};

export type CarrierPoint = {
  /** 桶起点（秒） */
  t: number;
  latencyMs: number | null;
  /** 0~100；这一格没有样本是 null。 */
  failPct: number | null;
};

export type CarrierHostSummary = {
  hostId: number;
  serviceId: number;
  /** 最近 15 分钟内最后一个有延迟的样本。 */
  currentMs: number | null;
  /** 24 小时平均 RTT（按成功次数加权）。 */
  avgMs: number | null;
  /** 24 小时的失败率（Ping 是丢包，TCPing 是 TCP 失败），0~100。 */
  failPct: number | null;
  probes: number;
  failKind: "loss" | "tcpFail";
  trend: CarrierPoint[];
  lastAt: number | null;
};

export type CarrierGroup = {
  carrier: ProbeCarrier;
  services: CarrierServiceRef[];
  hosts: CarrierHostSummary[];
};

export function carrierFailKind(method: string): "loss" | "tcpFail" {
  return method === "ping" ? "loss" : "tcpFail";
}

export const CARRIER_FAIL_LABELS: Record<"loss" | "tcpFail", string> = { loss: "丢包", tcpFail: "TCP 失败" };

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

/**
 * 把一组探测服务 + 它们 24 小时的序列整理成三网视图：每个运营商一组，组里每个（服务, 主机）一行，
 * 带当前 RTT、24 小时失败率和按 30 分钟一格的小走势。没打运营商标签的服务不出现。
 * 纯函数：数据由 server/routers/probeCarrier.ts 取好传进来。
 */
export function buildCarrierView(
  services: ReadonlyArray<{ id: number; name: string; carrier?: unknown; method: string; targetIp: string; targetPort?: number | null; isEnabled?: boolean }>,
  rows: readonly CarrierSeriesRow[],
  now: number,
  options: { hours?: number; bucketSeconds?: number } = {},
): CarrierGroup[] {
  const hours = options.hours ?? CARRIER_VIEW_HOURS;
  const bucket = options.bucketSeconds ?? CARRIER_TREND_BUCKET_SECONDS;
  const since = now - hours * 3600;
  const firstBucket = Math.floor(since / bucket) * bucket;
  const bucketCount = Math.max(1, Math.floor((Math.floor(now / bucket) * bucket - firstBucket) / bucket) + 1);
  const tagged = services
    .map((service) => ({ service, carrier: normalizeProbeCarrier(service.carrier) }))
    .filter((item): item is { service: (typeof services)[number]; carrier: ProbeCarrier } => !!item.carrier);
  const byService = new Map(tagged.map((item) => [Number(item.service.id), item]));

  type Acc = { serviceId: number; hostId: number; buckets: Map<number, { latSum: number; latWeight: number; probes: number; ok: number }>; last: { at: number; ms: number } | null; lastAt: number | null };
  const series = new Map<string, Acc>();
  for (const row of rows) {
    if (!byService.has(Number(row.serviceId)) || row.at < since || row.at > now + 60) continue;
    const key = `${row.serviceId}:${row.hostId}`;
    const acc = series.get(key) || { serviceId: Number(row.serviceId), hostId: Number(row.hostId), buckets: new Map(), last: null, lastAt: null };
    const slot = Math.floor(row.at / bucket) * bucket;
    const cell = acc.buckets.get(slot) || { latSum: 0, latWeight: 0, probes: 0, ok: 0 };
    const probes = Math.max(1, Math.floor(Number(row.probeCount) || 1));
    const ok = Math.max(0, Math.min(probes, Math.floor(Number(row.probeSuccesses) || 0)));
    cell.probes += probes;
    cell.ok += ok;
    if (row.latencyMs !== null && ok > 0) {
      cell.latSum += Number(row.latencyMs) * ok;
      cell.latWeight += ok;
      if (!acc.last || row.at >= acc.last.at) acc.last = { at: row.at, ms: Number(row.latencyMs) };
    }
    acc.lastAt = Math.max(acc.lastAt ?? 0, row.at);
    acc.buckets.set(slot, cell);
    series.set(key, acc);
  }

  const groups = new Map<ProbeCarrier, CarrierGroup>();
  for (const carrier of PROBE_CARRIERS) groups.set(carrier, { carrier, services: [], hosts: [] });
  for (const { service, carrier } of tagged) {
    groups.get(carrier)!.services.push({
      id: Number(service.id),
      name: String(service.name || ""),
      carrier,
      method: String(service.method || "tcping"),
      targetIp: String(service.targetIp || ""),
      targetPort: service.targetPort == null ? null : Number(service.targetPort),
      isEnabled: service.isEnabled !== false,
    });
  }
  for (const acc of series.values()) {
    const tag = byService.get(acc.serviceId)!;
    let probes = 0;
    let ok = 0;
    let latSum = 0;
    let latWeight = 0;
    const trend: CarrierPoint[] = [];
    for (let index = 0; index < bucketCount; index += 1) {
      const t = firstBucket + index * bucket;
      const cell = acc.buckets.get(t);
      if (!cell) {
        trend.push({ t, latencyMs: null, failPct: null });
        continue;
      }
      probes += cell.probes;
      ok += cell.ok;
      latSum += cell.latSum;
      latWeight += cell.latWeight;
      trend.push({
        t,
        latencyMs: cell.latWeight > 0 ? Math.round(cell.latSum / cell.latWeight) : null,
        failPct: cell.probes > 0 ? round1(((cell.probes - cell.ok) / cell.probes) * 100) : null,
      });
    }
    groups.get(tag.carrier)!.hosts.push({
      hostId: acc.hostId,
      serviceId: acc.serviceId,
      currentMs: acc.last && now - acc.last.at <= CARRIER_CURRENT_MAX_AGE_SECONDS ? Math.round(acc.last.ms) : null,
      avgMs: latWeight > 0 ? Math.round(latSum / latWeight) : null,
      failPct: probes > 0 ? round1(((probes - ok) / probes) * 100) : null,
      probes,
      failKind: carrierFailKind(String(tag.service.method)),
      trend,
      lastAt: acc.lastAt,
    });
  }
  for (const group of groups.values()) {
    const order = new Map(group.services.map((service, index) => [service.id, index]));
    group.hosts.sort((a, b) => (order.get(a.serviceId) ?? 0) - (order.get(b.serviceId) ?? 0) || a.hostId - b.hostId);
  }
  return PROBE_CARRIERS.map((carrier) => groups.get(carrier)!);
}

/** 预设里哪几条已经有了（同方法、同目标、同端口就算有，不管名字）。 */
export function missingCarrierPreset(existing: ReadonlyArray<{ method: string; targetIp: string; targetPort?: number | null }>) {
  return SHANGHAI_CARRIER_PRESET.filter((item) => !existing.some((service) => (
    String(service.method) === item.method
    && String(service.targetIp).trim() === item.targetIp
    && (item.method === "ping" || Number(service.targetPort) === item.targetPort)
  )));
}

/** 失败率的颜色档：0 绿、≤5% 黄、更高红。 */
export function carrierFailTone(pct: number | null): "ok" | "warn" | "down" | "none" {
  if (pct === null) return "none";
  if (pct <= 0) return "ok";
  if (pct <= 5) return "warn";
  return "down";
}
