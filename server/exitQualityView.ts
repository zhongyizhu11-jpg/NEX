import * as db from "./db";
import { getSiteLatencySamples, hostSupportsSiteLatency } from "./ops/siteLatency";
import { latestUnlockSummariesByHostIds } from "./ops/unlock";
import { SITE_LATENCY_TARGETS, summarizeSiteSamples, type SiteLatencySummary } from "../shared/siteLatency";

/*
  概览「出口质量」卡的数据（dashboard.exitQuality）。

  每台主机一行：在线、每个站点的走势（耗时序列，没连上记 0 —— 小走势线把 0 画在底边）和
  汇总（最近一次、中位数、丢失率、分档），以及解锁检测最近一次的摘要（主机卡上同一份）。
  只列有样本的主机；一台都没有时 hosts 为空，界面整块不出现，另外告诉它有几台主机的 Agent
  还不支持（升级就有）。
*/

export type ExitQualitySite = SiteLatencySummary & { key: string; values: number[] };

export type ExitQualityHost = {
  id: number;
  name: string;
  online: boolean;
  countryCode: string | null;
  sites: ExitQualitySite[];
  unlock: { checkedAt: number; items: { service: string; text: string; status: string }[] } | null;
};

export async function buildExitQuality() {
  const hosts = (await db.getHosts()) as any[];
  const rows: ExitQualityHost[] = [];
  let unsupported = 0;
  for (const host of hosts) {
    const samples = getSiteLatencySamples(Number(host.id));
    if (samples.size === 0) {
      if (host.isOnline && !hostSupportsSiteLatency(host)) unsupported += 1;
      continue;
    }
    rows.push({
      id: Number(host.id),
      name: String(host.name || `主机 ${host.id}`),
      online: !!host.isOnline,
      countryCode: host.countryCode ? String(host.countryCode) : null,
      sites: SITE_LATENCY_TARGETS.map((target) => {
        const list = samples.get(target.key) || [];
        return { key: target.key, ...summarizeSiteSamples(list), values: list.map((sample) => sample.ms ?? 0) };
      }),
      unlock: null,
    });
  }
  const unlock = await latestUnlockSummariesByHostIds(rows.map((row) => row.id)).catch(() => new Map());
  for (const row of rows) {
    const summary = unlock.get(row.id);
    if (summary) row.unlock = { checkedAt: summary.checkedAt, items: summary.items };
  }
  return {
    targets: SITE_LATENCY_TARGETS.map(({ key, label, host }) => ({ key, label, host })),
    hosts: rows,
    unsupported,
  };
}
