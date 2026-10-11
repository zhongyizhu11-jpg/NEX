import { useMemo } from "react";

import { trpc } from "@/lib/trpc";
import { formatBytes } from "@shared/formatBytes";
import {
  hostTrafficPercent,
  hostTrafficUsedBytes,
  normalizeHostTrafficMeasureMode,
} from "@shared/hostTrafficQuota";
import { resolveNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

import { formatUptime, readCachedHostMetrics } from "./hostDisplay";

/**
 * 一台主机的「体征」—— 列表和详情读同一份。
 *
 * 这一段推导原来整个长在 HostCard 里（约 170 行），于是任何一个想显示主机
 * 状态的地方都只有两个选择：整张 HostCard 端过去，或者自己再推一遍。上一版
 * 选了前者，结果列表里塞进了详情页该有的全部字段，一台机器占掉接近一屏。
 *
 * 抽出来之后列表和详情各画各的，读的是同一份结论：
 *   列表负责看状态，详情负责看数据。
 *
 * ── 离线时哪些数字还算数 ──
 *
 * 这是这个 hook 唯一需要动脑子的地方，也是上一版做错的地方。
 *
 * CPU / 内存 / 磁盘的百分比是「此刻」的量，机器一掉线它们就冻在最后一次上报
 * 的值上。继续显示等于报了一个它没说过的数 —— 一台断了三天的机器写着
 * 「CPU 2%」，看的人会以为它在跑。所以离线时这三个一律回 null，由
 * ResourceMeter 画成「—」。
 *
 * 流量数字正好相反：**掉线前跑到哪儿是有用的线索，抹掉更糟**。所以数字照留，
 * 只把标签从「当前」改成「最后一次」，并把上报时间挂进 title。
 */

export type HostVitals = {
  health: NetworkHealth;
  isOnline: boolean;
  /** 离线时为 null —— 不是 0，是不知道 */
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  /** 瞬时速率，字节/秒。离线时是最后一次上报的值 */
  speedIn: number | null;
  speedOut: number | null;
  /** 速率那一行该叫「当前」还是「最后一次」 */
  speedLabel: string;
  /** 计费口径下的累计用量 */
  usedBytes: number;
  trafficLimit: number;
  /** 未设上限时为 null */
  trafficPercent: number | null;
  trafficUsageLabel: string;
  /** 系统累计（系统重启后重置） */
  systemIn: number | null;
  systemOut: number | null;
  uptimeText: string;
  uptimeLabel: string;
  lastReportedText: string;
  memoryUsed: number | null;
  memoryTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  /**
   * 此刻的 TCP / UDP 连接数。和 CPU 一样是「此刻」的量：离线回 null；
   * 旧 Agent（2.2.215 之前）不报这两项，也是 null，画成「—」。
   */
  tcpConnections: number | null;
  udpConnections: number | null;
};

const bytesOrNull = (value: unknown) => (value == null ? null : Number(value));

/**
 * 只做推导，不查询 —— 已经拿到 metrics 的调用方（列表页一次批量查回来）
 * 直接用这个，不要每张卡再各发一次请求。
 */
export function deriveHostVitals(
  host: any,
  metrics: any[] | null | undefined,
  traffic?: { bytesIn?: number | null; bytesOut?: number | null } | null,
): HostVitals {
  const latest = metrics?.[0];
  const previous = metrics?.[1];
  const isOnline = !!host?.isOnline;

  /*
    离线就没有「此刻的占用」。这三个值在线时才有意义，所以门禁放在这里
    而不是每个渲染处各判一次 —— 判断只此一份，漏判就不会发生。
  */
  const pct = (value: unknown) => {
    if (!isOnline || !latest || value == null) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const speed = (() => {
    if (!latest) return { in: null as number | null, out: null as number | null };
    if (latest.networkSpeedIn != null || latest.networkSpeedOut != null) {
      return {
        in: bytesOrNull(latest.networkSpeedIn),
        out: bytesOrNull(latest.networkSpeedOut),
      };
    }
    if (!previous) return { in: null as number | null, out: null as number | null };
    const latestAt = new Date(latest.recordedAt).getTime();
    const previousAt = new Date(previous.recordedAt).getTime();
    const seconds = Math.max(1, (latestAt - previousAt) / 1000);
    const inDelta = Math.max(0, Number(latest.networkIn || 0) - Number(previous.networkIn || 0));
    const outDelta = Math.max(0, Number(latest.networkOut || 0) - Number(previous.networkOut || 0));
    return { in: inDelta / seconds, out: outDelta / seconds };
  })();

  const totalIn = traffic?.bytesIn == null ? null : Number(traffic.bytesIn);
  const totalOut = traffic?.bytesOut == null ? null : Number(traffic.bytesOut);
  const trafficLimit = Math.max(0, Number(host?.trafficLimit || 0));
  const measureMode = normalizeHostTrafficMeasureMode(host?.trafficMeasureMode);
  const usedBytes = hostTrafficUsedBytes({ bytesIn: totalIn, bytesOut: totalOut }, measureMode);
  const trafficPercent = hostTrafficPercent(usedBytes, trafficLimit);

  /*
    健康状态走 shared/networkHealth 的统一判定，不在这里自己写一套 if。

    `reachable` 只有 true / false 两种取值而没有 undefined，是因为主机的在线
    与否由服务端的心跳闸口算好了 isOnline —— 到这里已经是结论。真正的
    「没上报过」由下面的 standby 那一支处理：一台从没连上来过的机器
    （没有任何 metric）不该报故障，它只是还没开始。
  */
  const neverReported = !latest;
  const health: NetworkHealth = neverReported && !isOnline
    ? "unknown"
    : resolveNetworkHealth({ reachable: isOnline });

  return {
    health,
    isOnline,
    cpuPercent: pct(latest?.cpuUsage),
    memoryPercent: pct(latest?.memoryUsage),
    diskPercent: pct(latest?.diskUsage),
    speedIn: speed.in,
    speedOut: speed.out,
    speedLabel: isOnline ? "当前" : "最后一次",
    usedBytes,
    trafficLimit,
    trafficPercent,
    trafficUsageLabel:
      trafficPercent === null
        ? `${formatBytes(usedBytes)} / 不限`
        : `${formatBytes(usedBytes)} / ${formatBytes(trafficLimit)}（${trafficPercent}%）`,
    systemIn: bytesOrNull(latest?.networkIn),
    systemOut: bytesOrNull(latest?.networkOut),
    uptimeText: latest?.uptime == null ? "—" : formatUptime(latest.uptime),
    uptimeLabel: isOnline ? "已运行" : "最后运行",
    lastReportedText: latest?.recordedAt
      ? new Date(latest.recordedAt).toLocaleString("zh-CN", { hour12: false })
      : "",
    memoryUsed: bytesOrNull(latest?.memoryUsed),
    memoryTotal: bytesOrNull(host?.memoryTotal),
    diskUsed: bytesOrNull(latest?.diskUsed),
    diskTotal: bytesOrNull(latest?.diskTotal),
    tcpConnections: pct(latest?.tcpConnections),
    udpConnections: pct(latest?.udpConnections),
  };
}

/**
 * 带查询的版本：调用方没有现成 metrics 时用。
 *
 * 拿不到新数据时退回本地缓存的上一份 —— 刷新页面的那一瞬间全部画成「—」
 * 比画旧值更糟：用户会以为机器刚刚全掉了。
 */
export function useHostVitals(
  host: any,
  options: {
    metrics?: any[] | null;
    traffic?: { bytesIn?: number | null; bytesOut?: number | null } | null;
    refreshInterval?: number | false;
  } = {},
): HostVitals {
  const hasExternal = options.metrics !== undefined;
  const { data: queried } = trpc.hosts.metrics.useQuery(
    { hostId: host?.id, limit: 2, live: !!options.refreshInterval },
    { enabled: !hasExternal && !!host?.id, refetchInterval: hasExternal ? false : options.refreshInterval },
  );
  const metrics = hasExternal ? options.metrics : queried;
  const cached = useMemo(() => readCachedHostMetrics(host?.id), [host?.id]);
  const display = metrics === undefined || metrics === null || metrics.length === 0 ? cached : metrics;

  return useMemo(
    () => deriveHostVitals(host, display, options.traffic),
    [host, display, options.traffic],
  );
}
