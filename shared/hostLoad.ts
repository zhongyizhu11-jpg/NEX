import type { RoutePath } from "./routeGroup";

/*
  主机负载（Agent 2.2.251 起评分里算它）：一台机器此刻有多忙，0–100 一个数。

  取 CPU 占用和带宽占用里大的那个。CPU 心跳直接报百分比；带宽心跳报的是 /proc/net/dev 的**累计字节数**
  （networkIn / networkOut 是计数器，不是速率，见 server/hostLiveMetrics.ts 的 speedBetween），得拿相邻两次
  心跳相减、除以间隔才是速率，再比上主机填的线路带宽（hostBandwidthHintMbps）才是百分比。没填带宽
  （0 = 不知道）、只有一次样本、计数器归零（机器重启）时都算不出带宽占用，这时只看 CPU。

  面板算出每台的负载后，给线路组的每条路径一个 loadPct：沿途中转机、落地机（落地是 NEX 主机时）里最忙的
  那台；直接写地址的落地不算。Agent 拿它扣评分（shared/routeScore.ts）、算「自动」分法的权重。
*/

export type HostLoadSample = {
  /** Unix 毫秒 */
  at: number;
  /** CPU 占用百分比；没报是 null。 */
  cpuUsage: number | null;
  /** 累计收 / 发字节数（计数器）；没报是 null。 */
  networkIn: number | null;
  networkOut: number | null;
};

/** 两次样本之间的速率：收、发里大的那个，字节 / 秒。算不出（只有一次、间隔太短、计数器归零）是 null。 */
export function hostNetworkBytesPerSecond(previous: HostLoadSample | null | undefined, latest: HostLoadSample): number | null {
  if (!previous) return null;
  const seconds = (latest.at - previous.at) / 1000;
  if (!(seconds >= 0.5)) return null;
  const rate = (a: number | null, b: number | null) => {
    if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    // 计数器只会涨：变小了是机器重启或接口换了，这一段算不出
    if (a < b) return null;
    return (a - b) / seconds;
  };
  const inRate = rate(latest.networkIn, previous.networkIn);
  const outRate = rate(latest.networkOut, previous.networkOut);
  if (inRate === null && outRate === null) return null;
  return Math.max(inRate ?? 0, outRate ?? 0);
}

/** 带宽占用百分比：速率（字节 / 秒）比上线路带宽（Mbps）。带宽不知道（≤ 0）或速率算不出是 null。 */
export function hostBandwidthUtilizationPct(bytesPerSecond: number | null | undefined, bandwidthMbps: number | null | undefined): number | null {
  if (bytesPerSecond === null || bytesPerSecond === undefined) return null;
  const bandwidth = Number(bandwidthMbps);
  const rate = Number(bytesPerSecond);
  if (!(bandwidth > 0) || !Number.isFinite(rate) || rate < 0) return null;
  const pct = (rate * 8) / (bandwidth * 1_000_000) * 100;
  return Math.min(100, Math.round(pct * 10) / 10);
}

/** 一台的负载：CPU 和带宽占用取大；都不知道是 null。 */
export function hostLoadPct(cpuUsage: number | null | undefined, bandwidthPct: number | null | undefined): number | null {
  const cpu = Number(cpuUsage);
  const bandwidth = Number(bandwidthPct);
  const values: number[] = [];
  if (cpuUsage !== null && cpuUsage !== undefined && Number.isFinite(cpu) && cpu >= 0) values.push(Math.min(100, cpu));
  if (bandwidthPct !== null && bandwidthPct !== undefined && Number.isFinite(bandwidth) && bandwidth >= 0) values.push(Math.min(100, bandwidth));
  if (values.length === 0) return null;
  return Math.round(Math.max(...values) * 10) / 10;
}

/** 相邻两次心跳 → 这台此刻的负载。previous 为空（第一次心跳）只看 CPU。 */
export function hostLoadFromSamples(previous: HostLoadSample | null | undefined, latest: HostLoadSample, bandwidthMbps: number | null | undefined): number | null {
  return hostLoadPct(latest.cpuUsage, hostBandwidthUtilizationPct(hostNetworkBytesPerSecond(previous, latest), bandwidthMbps));
}

type RoutePathLoadInput = Pick<RoutePath, "hops"> & { destNodeId?: number | null; destHostId?: number | null };

/**
 * 这条路径的负载看哪几台：沿途的中转，加上落地是 NEX 主机时的那台 —— 落地池的成员机（路径上记着 destHostId），
 * 或者「我的节点」是某台主机上的入站派生的（nodeHostId 查，0 = 不是 NEX 主机上的节点）。直接写地址的落地不算。
 */
export function routePathLoadHostIds(path: RoutePathLoadInput, nodeHostId: (nodeId: number) => number = () => 0): number[] {
  const ids = path.hops.map((hop) => Number(hop)).filter((hop) => Number.isInteger(hop) && hop > 0);
  const nodeId = Number(path.destNodeId || 0);
  const landing = Number(path.destHostId || 0) > 0 ? Number(path.destHostId) : nodeId > 0 ? Number(nodeHostId(nodeId) || 0) : 0;
  if (Number.isInteger(landing) && landing > 0 && !ids.includes(landing)) ids.push(landing);
  return ids;
}

/** 一条路径的负载：沿途几台里最忙的；一台都不知道是 null。 */
export function routePathLoadPct(path: RoutePathLoadInput, loadOf: (hostId: number) => number | null, nodeHostId?: (nodeId: number) => number): number | null {
  let worst: number | null = null;
  for (const hostId of routePathLoadHostIds(path, nodeHostId)) {
    const load = loadOf(hostId);
    if (load === null || load === undefined || !Number.isFinite(load)) continue;
    if (worst === null || load > worst) worst = load;
  }
  return worst;
}
