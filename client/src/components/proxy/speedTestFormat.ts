import type { SpeedTestResult } from "@shared/nodeCheck";

/* 网速测试弹窗里几个数怎么写（SpeedTestDialog）。 */

/** 延迟、抖动：10 ms 以下留一位小数（抖动常常不到 1 ms，取整就成了 0）。 */
export function formatSpeedMs(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—";
  return `${value < 10 ? (Math.round(value * 10) / 10).toFixed(1) : Math.round(value)} ms`;
}

/** 测速点：Ookla 写「运营商 · 城市 · 多远」，Cloudflare 写机房，面板写明上限是面板的带宽。 */
export function speedServerLabel(result: Pick<SpeedTestResult, "server" | "serverName" | "serverDistanceKm" | "colo">) {
  if (result.server === "panel") return "面板服务器";
  if (result.server === "ookla") {
    return ["Ookla", result.serverName, result.serverDistanceKm > 0 ? `${result.serverDistanceKm} km` : ""].filter(Boolean).join(" · ");
  }
  return ["Cloudflare", result.colo].filter(Boolean).join(" · ");
}

export function formatTraffic(bytes: number) {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / (1 << 20)))} MB`;
}

/**
 * 订阅线路测速在入口机上测的是「入口往后的链路」；你实际用的时候数据还要在入口机和你之间走一趟：你下载时入口机
 * 往外发（它的上行），你上传时它往里收（它的下行）。两边取小，就是你大约能跑到的（你自己的宽带不算在内）。
 */
export function speedReach(chain: { downloadMbps: number; uploadMbps: number }, entry: { downloadMbps: number; uploadMbps: number }) {
  return {
    downloadMbps: Math.min(chain.downloadMbps, entry.uploadMbps),
    uploadMbps: Math.min(chain.uploadMbps, entry.downloadMbps),
    downLimitedByEntry: entry.uploadMbps < chain.downloadMbps,
    upLimitedByEntry: entry.downloadMbps < chain.uploadMbps,
  };
}
