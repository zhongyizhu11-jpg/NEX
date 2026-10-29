import { ListSection } from "@/components/ios/GroupedList";
import { Sparkline } from "@/components/charts/Sparkline";
import { countryFlagLabel } from "@/lib/flagEmojiSupport";
import { describeProbeFailure, describeProbeFailureShort } from "@shared/probeFailure";
import { SITE_LATENCY_BAD_MS, SITE_LATENCY_WARN_MS } from "@shared/siteLatency";

/*
  概览「出口质量」：每台主机从自己出去，到百度 / Google / GitHub / OpenAI 的握手延迟，
  最近两小时一条小走势线；右上是那台主机最近一次解锁检测的摘要（主机卡上同一份）。

  数据：dashboard.exitQuality（server/exitQualityView.ts），Agent 扩展模块 "sitelatency"
  2.2.237 起。一台有样本的主机都没有时整块不出现；只有在 footer 里说一句有几台要升级。
*/

export type ExitQualitySiteView = {
  key: string;
  latestMs: number | null;
  latestFail: string | null;
  latestAt: number | null;
  medianMs: number | null;
  lossPct: number;
  samples: number;
  tone: "ok" | "warn" | "down" | "off";
  values: number[];
};

export type ExitQualityView = {
  targets: { key: string; label: string; host: string }[];
  hosts: {
    id: number;
    name: string;
    online: boolean;
    countryCode: string | null;
    sites: ExitQualitySiteView[];
    unlock: { checkedAt: number; items: { service: string; text: string; status: string }[] } | null;
  }[];
  unsupported: number;
};

const TONE_TEXT: Record<ExitQualitySiteView["tone"], string> = {
  ok: "var(--fx-healthy-text)",
  warn: "var(--fx-warn-text)",
  down: "var(--fx-down-text)",
  off: "var(--fx-text-muted)",
};

const TONE_LINE: Record<ExitQualitySiteView["tone"], string> = {
  ok: "var(--fx-healthy)",
  warn: "var(--fx-warn)",
  down: "var(--fx-down)",
  off: "var(--fx-text-muted)",
};

const UNLOCK_TONE: Record<string, string> = {
  ok: "var(--fx-healthy-text)",
  partial: "var(--fx-warn-text)",
  blocked: "var(--fx-down-text)",
};

/** 格子里的大字：最近一次的毫秒数，没连上写原因。 */
export function exitSiteHeadline(site: Pick<ExitQualitySiteView, "latestMs" | "latestFail" | "samples">) {
  if (site.samples === 0) return "—";
  if (site.latestMs === null) return describeProbeFailureShort(site.latestFail || "timeout");
  return `${site.latestMs} ms`;
}

export function exitSiteTitle(label: string, host: string, site: ExitQualitySiteView) {
  if (site.samples === 0) return `${label}（${host}）：还没有样本`;
  const parts = [`${label}（${host}:443 握手）`];
  parts.push(site.latestMs === null ? `最近一次没连上：${describeProbeFailure(site.latestFail || "timeout")}` : `最近一次 ${site.latestMs} ms`);
  if (site.medianMs !== null) parts.push(`两小时中位数 ${site.medianMs} ms`);
  if (site.lossPct > 0) parts.push(`没连上 ${site.lossPct}%`);
  parts.push(`${site.samples} 个样本，≤${SITE_LATENCY_WARN_MS} ms 绿、≤${SITE_LATENCY_BAD_MS} ms 黄`);
  return parts.join("；");
}

export function ExitQualitySection({ data }: { data: ExitQualityView | null | undefined }) {
  if (!data || data.hosts.length === 0) return null;
  const labels = new Map(data.targets.map((target) => [target.key, target]));
  return (
    <ListSection
      id="dashboard-exit-quality"
      header="出口质量"
      footer={`每台主机每 2 分钟和几个站点握一次手（只连 443，不发请求），线是最近两小时。${data.unsupported > 0 ? `还有 ${data.unsupported} 台在线主机的 Agent 早于 2.2.237，升级后出现。` : ""}`}
    >
      {data.hosts.map((host) => {
        const flag = countryFlagLabel(host.countryCode);
        return (
          <div key={host.id} className="flex min-w-0 flex-col gap-2 border-b border-[var(--fx-stroke-weak)] px-4 py-3 last:border-b-0" data-testid="exit-quality-host">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {flag ? <span className="mr-1">{flag}</span> : null}
                {host.name}
              </span>
              {!host.online ? <span className="text-meta text-[var(--fx-down-text)]">离线 · 显示的是掉线前的</span> : null}
              {host.unlock && host.unlock.items.length > 0 ? (
                <span className="ml-auto flex min-w-0 flex-wrap items-center gap-x-2 text-meta" title="最近一次解锁检测">
                  {host.unlock.items.map((item) => (
                    <span key={item.service} style={{ color: UNLOCK_TONE[item.status] || "var(--fx-text-muted)" }}>{item.text}</span>
                  ))}
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {host.sites.map((site) => {
                const target = labels.get(site.key);
                const label = target?.label || site.key;
                return (
                  <div key={site.key} className="flex min-w-0 flex-col gap-1 rounded-[var(--fx-radius-control)] bg-[var(--fx-l2-group)] px-2.5 py-2" title={exitSiteTitle(label, target?.host || site.key, site)} data-testid="exit-quality-site" data-tone={site.tone}>
                    <div className="flex min-w-0 items-baseline justify-between gap-2">
                      <span className="truncate text-meta text-muted-foreground">{label}</span>
                      <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums" style={{ color: TONE_TEXT[site.tone] }}>{exitSiteHeadline(site)}</span>
                    </div>
                    <Sparkline values={site.values} width={160} height={22} minScale={SITE_LATENCY_WARN_MS} stroke={TONE_LINE[site.tone]} className="h-[22px] w-full" />
                    {site.lossPct > 0 ? <span className="text-[10.5px] tabular-nums text-[var(--fx-warn-text)]">没连上 {site.lossPct}%</span> : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </ListSection>
  );
}
