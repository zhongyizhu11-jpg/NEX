/*
  每日简报里「过去 24 小时的掉线」那一块的计算（纯函数，测试见 digestFormat.test.ts）。

  数据来自事件时间线的 host.offline / host.online：按时间顺序配对，一次掉线到下一次恢复算一段。
  - 窗口开始前就已经断着、窗口里才恢复的：恢复事件里记着断线起点（offlineSince），截到窗口起点算；
    没记就按窗口起点算。
  - 到现在还没恢复的：算到现在，标成「仍未恢复」。
*/

export type OutageEvent = {
  /** 事件 id：同一秒里的两条按写入先后排 */
  id?: number;
  hostId: number;
  kind: string;
  /** 秒 */
  at: number;
  /**
   * 断线起点（秒），可以没有：host.online 里记的是那次断线从哪开始，
   * host.offline 里是最后一次心跳的时间（比判定离线的时刻早几十秒到几分钟）。
   */
  offlineSince?: number | null;
};

export type HostOutageSummary = {
  hostId: number;
  count: number;
  totalSeconds: number;
  ongoing: boolean;
};

export function summarizeOutages(events: readonly OutageEvent[], windowStart: number, now: number): HostOutageSummary[] {
  const sorted = [...events]
    .filter((event) => event.hostId > 0 && (event.kind === "host.offline" || event.kind === "host.online"))
    .sort((a, b) => a.at - b.at || Number(a.id || 0) - Number(b.id || 0));
  const open = new Map<number, number>();
  const byHost = new Map<number, HostOutageSummary>();
  const summaryFor = (hostId: number) => {
    let summary = byHost.get(hostId);
    if (!summary) {
      summary = { hostId, count: 0, totalSeconds: 0, ongoing: false };
      byHost.set(hostId, summary);
    }
    return summary;
  };
  for (const event of sorted) {
    if (event.kind === "host.offline") {
      // 连着两条掉线（中间那次恢复没记上）：以第一条为准
      const since = Number(event.offlineSince) > 0 && Number(event.offlineSince) <= event.at ? Number(event.offlineSince) : event.at;
      if (!open.has(event.hostId)) open.set(event.hostId, Math.max(windowStart, since));
      continue;
    }
    const since = open.has(event.hostId)
      ? open.get(event.hostId)!
      : Number(event.offlineSince) > 0 ? Math.max(windowStart, Number(event.offlineSince)) : null;
    open.delete(event.hostId);
    if (since === null) continue; // 一条孤立的「上线」（新机器、面板重启前就断着又没记）：不算掉线
    const summary = summaryFor(event.hostId);
    summary.count += 1;
    summary.totalSeconds += Math.max(0, event.at - since);
  }
  for (const [hostId, since] of open) {
    const summary = summaryFor(hostId);
    summary.count += 1;
    summary.totalSeconds += Math.max(0, now - since);
    summary.ongoing = true;
  }
  return Array.from(byHost.values()).sort((a, b) => Number(b.ongoing) - Number(a.ongoing) || b.totalSeconds - a.totalSeconds || a.hostId - b.hostId);
}
