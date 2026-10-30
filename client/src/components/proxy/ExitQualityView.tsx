import { useState } from "react";
import { toast } from "sonner";

import { Sparkline } from "@/components/charts/Sparkline";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NODE_CHECK_PHASE_LABELS } from "@shared/nodeCheck";
import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { countryFlagLabel } from "@/lib/flagEmojiSupport";
import { trpc } from "@/lib/trpc";
import { describeProbeFailure, describeProbeFailureShort } from "@shared/probeFailure";
import { SITE_FAILURE_LABELS, SITE_LATENCY_BAD_MS, SITE_LATENCY_VERIFIED_AGENT_VERSION, SITE_LATENCY_WARN_MS } from "@shared/siteLatency";
import { UNLOCK_STATUS_LABELS, type UnlockStatus } from "@shared/unlockCheck";

/*
  落地出口检测：这个节点从哪台机器出去，那台出去以后到百度 / Google / GitHub / OpenAI 连不连得上，
  解锁了什么。原来是概览上所有主机一排排铺开（「出口质量」），现在按节点看，挂在订阅管理
  的节点菜单（「出口检测」）和订阅内容里每条线路的出口那一节。

  数据：proxySubscriptions.exitCheck（server/exitQualityView.ts），Agent 扩展模块 "sitelatency"。
  2.2.240 起每轮握 3 次取中位数、并做 TLS 校验证书：DNS 被污染时写「解析被污染」，不再是一个假的低延迟。
*/

export type ExitQualitySiteView = {
  key: string;
  latestMs: number | null;
  latestFail: string | null;
  latestAt: number | null;
  medianMs: number | null;
  lossPct: number;
  samples: number;
  latestTries?: number;
  latestOk?: number;
  tone: "ok" | "warn" | "down" | "off";
  values: number[];
};

export type ExitQualityHostView = {
  id: number;
  name: string;
  online: boolean;
  countryCode: string | null;
  sites: ExitQualitySiteView[];
  noEgress?: boolean;
  unverified?: boolean;
  unsupported?: boolean;
  unlock: { checkedAt: number; items: { service: string; text: string; status: string }[] } | null;
  unlockDetail?: { checkedAt: number; family: string; results: { service: string; name: string; status: string; region: string | null }[] } | null;
  unlockSupported?: boolean;
};

export type ExitQualityTarget = { key: string; label: string; host: string };

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

/** 出口探测的失败说法：poisoned / blocked 是它特有的，其余沿用 shared/probeFailure。 */
export function exitFailureShort(kind: string | null | undefined) {
  const own = kind ? SITE_FAILURE_LABELS[kind] : undefined;
  return own ? own.short : describeProbeFailureShort(kind || "timeout");
}

export function exitFailureLong(kind: string | null | undefined) {
  const own = kind ? SITE_FAILURE_LABELS[kind] : undefined;
  return own ? own.long : describeProbeFailure(kind || "timeout");
}

/** 格子里的大字：最近一次的毫秒数，没连上写原因。 */
export function exitSiteHeadline(site: Pick<ExitQualitySiteView, "latestMs" | "latestFail" | "samples">) {
  if (site.samples === 0) return "—";
  if (site.latestMs === null) return exitFailureShort(site.latestFail);
  return `${site.latestMs} ms`;
}

export function exitSiteTitle(label: string, host: string, site: ExitQualitySiteView) {
  if (site.samples === 0) return `${label}（${host}）：还没有样本`;
  const parts = [`${label}（${host}:443）`];
  if (site.latestMs === null) parts.push(`最近一次没连上：${exitFailureLong(site.latestFail)}`);
  else if ((site.latestTries || 0) > 1) parts.push(`最近一次握手 ${site.latestTries} 次、连上 ${site.latestOk} 次，中位数 ${site.latestMs} ms`);
  else parts.push(`最近一次 ${site.latestMs} ms`);
  if (site.medianMs !== null) parts.push(`两小时中位数 ${site.medianMs} ms`);
  if (site.lossPct > 0) parts.push(`没连上 ${site.lossPct}%`);
  parts.push(`${site.samples} 轮，≤${SITE_LATENCY_WARN_MS} ms 绿、≤${SITE_LATENCY_BAD_MS} ms 黄`);
  return parts.join("；");
}

function formatCheckedAt(value: number) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

/** 一台主机的出口：四个站点各一格 + 解锁。概览不再放，订阅管理的出口检测和线路详情共用。 */
export function ExitHostPanel({ host, targets, compact = false }: { host: ExitQualityHostView; targets: readonly ExitQualityTarget[]; compact?: boolean }) {
  const labels = new Map(targets.map((target) => [target.key, target]));
  const flag = countryFlagLabel(host.countryCode);
  const hasSamples = host.sites.some((site) => site.samples > 0);
  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-testid="exit-quality-host">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {flag ? <span className="mr-1">{flag}</span> : null}
          {host.name}
        </span>
        {!host.online ? <span className="text-meta text-[var(--fx-down-text)]">离线 · 显示的是掉线前的</span> : null}
      </div>

      {host.unsupported ? (
        <p className="rounded-md bg-[var(--fx-l2-group)] px-3 py-2 text-xs text-muted-foreground">这台机器的 Agent 太旧，还没有出口探测。升级 Agent 后两分钟内出现。</p>
      ) : !hasSamples ? (
        <p className="rounded-md bg-[var(--fx-l2-group)] px-3 py-2 text-xs text-muted-foreground">还没有样本：每 2 分钟测一轮，稍等一下再打开。</p>
      ) : host.noEgress ? (
        <p data-testid="exit-no-egress" className="rounded-md bg-[var(--fx-l2-group)] px-3 py-2 text-xs text-muted-foreground">
          这台机器连不上任何一个公网站点（{host.sites.map((site) => `${labels.get(site.key)?.label || site.key} ${exitSiteHeadline(site)}`).join(" · ")}）。
          国内专线 / 中转入口通常不开公网出口，这是正常的；它做落地才会有问题。
        </p>
      ) : (
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
      )}

      {host.unverified && hasSamples ? (
        <p data-testid="exit-unverified" className="text-[11px] text-[var(--fx-warn-text)]">
          这台的 Agent 早于 {SITE_LATENCY_VERIFIED_AGENT_VERSION}，没校验证书：DNS 被污染时会显示一个假的低延迟。升级后准确。
        </p>
      ) : null}

      {compact ? (
        host.unlock && host.unlock.items.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-meta" title="最近一次解锁检测">
            {host.unlock.items.map((item) => (
              <span key={item.service} style={{ color: UNLOCK_TONE[item.status] || "var(--fx-text-muted)" }}>{item.text}</span>
            ))}
          </div>
        ) : null
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-meta font-medium text-muted-foreground">解锁</span>
            {host.unlockDetail ? <span className="text-[11px] text-muted-foreground">{formatCheckedAt(host.unlockDetail.checkedAt)} 检测</span> : null}
          </div>
          {host.unlockDetail && host.unlockDetail.results.length > 0 ? (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" data-testid="exit-unlock">
              {host.unlockDetail.results.map((item) => (
                <div key={item.service} className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-[var(--fx-l2-group)] px-2.5 py-1.5 text-xs">
                  <span className="truncate">{item.name}</span>
                  <span className="shrink-0" style={{ color: UNLOCK_TONE[item.status] || "var(--fx-text-muted)" }}>
                    {UNLOCK_STATUS_LABELS[item.status as UnlockStatus] || item.status}
                    {item.region ? ` · ${item.region}` : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{host.unlockSupported === false ? "这台的 Agent 还不支持解锁检测。" : "还没做过解锁检测（管理员在主机详情里点「检测解锁」，或开定时检测）。"}</p>
          )}
        </div>
      )}
    </div>
  );
}

export type ExitCheckSubject = { inboundId: number } | { nodeId: number };

/**
 * 粘贴进来、机器不是自己的节点：挑一台自己的机器，临时拉 sing-box 经这个节点做一轮站点握手 + 解锁，
 * 结果画成和主机那版一样的面板（server/nodeCheckView）。
 */
function ViaHostExitCheck({ nodeId, address, targets }: { nodeId: number; address: string; targets: readonly ExitQualityTarget[] }) {
  const utils = trpc.useUtils();
  const [viaHostId, setViaHostId] = useState(0);
  const status = trpc.proxySubscriptions.nodeExitCheckStatus.useQuery({ nodeId }, {
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data?.pending ? 2000 : false),
  });
  const start = trpc.proxySubscriptions.nodeExitCheckStart.useMutation({
    onSuccess: () => void utils.proxySubscriptions.nodeExitCheckStatus.invalidate({ nodeId }),
    onError: (error) => toast.error(error.message),
  });
  const data = status.data;
  const candidates = data?.plan.candidates ?? [];
  const chosen = viaHostId || candidates.find((item) => item.online && item.supported)?.id || 0;
  const pending = data?.pending ?? null;
  const latest = data?.latest ?? null;
  return (
    <div className="space-y-3" data-testid="exit-via-host">
      <p className="rounded-md bg-[var(--fx-l2-group)] px-3 py-2.5 text-xs text-muted-foreground">
        这个节点的地址 {address} 对不上你的任何一台机器：它不在装了 Agent 的机器上。可以让你的一台机器临时经这个节点去测它的出口（机器上要有 sing-box，建过自建节点的都有）。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={chosen ? String(chosen) : ""} onValueChange={(value) => setViaHostId(Number(value))}>
          <SelectTrigger className="h-8 w-[200px]" aria-label="经哪台机器检测"><SelectValue placeholder={status.isLoading ? "读取中…" : "选一台机器"} /></SelectTrigger>
          <SelectContent>
            {candidates.map((item) => (
              <SelectItem key={item.id} value={String(item.id)} disabled={!item.online || !item.supported}>
                {item.name}{item.preferred ? " · 入口" : ""}{!item.online ? " · 离线" : !item.supported ? " · Agent 太旧" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" size="sm" variant="outline" className="h-8" disabled={!chosen || !!pending || start.isPending} onClick={() => start.mutate({ nodeId, hostId: chosen })}>
          {pending ? `${NODE_CHECK_PHASE_LABELS[pending.phase] || "检测中"}…` : latest ? "再测一次" : "经这台机器检测"}
        </Button>
      </div>
      {latest?.error && !pending ? <p className="text-xs text-[var(--fx-down-text)]">{latest.error}</p> : null}
      {data?.exitView && !pending ? <ExitHostPanel host={data.exitView} targets={targets} /> : null}
      {candidates.length === 0 && data ? <p className="text-xs text-muted-foreground">没有可以用的机器：要一台在线、Agent 2.2.241 以上的机器。</p> : null}
    </div>
  );
}

/** 订阅管理 › 节点菜单 › 出口检测。 */
export function NodeExitDialog({ subject, name, onOpenChange }: { subject: ExitCheckSubject | null; name: string; onOpenChange: (open: boolean) => void }) {
  const query = trpc.proxySubscriptions.exitCheck.useQuery(subject ?? { nodeId: 1 }, {
    enabled: !!subject,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
  const data = query.data;
  return (
    <Dialog open={!!subject} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>出口检测 · {name}</DialogTitle>
          <DialogDescription className="text-xs">
            这个节点从哪台机器出去，那台出去以后连不连得上常用站点、解锁了什么。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {query.isLoading ? (
            <DataSectionLoading />
          ) : query.error && !data ? (
            <DataSectionError label="出口检测" error={query.error} retrying={query.isFetching} onRetry={() => { void query.refetch(); }} />
          ) : data && !data.host ? (
            data.subject.kind === "node" ? (
              <ViaHostExitCheck nodeId={data.subject.id} address={data.subject.address} targets={data.targets} />
            ) : (
              <p data-testid="exit-unmatched" className="rounded-md bg-[var(--fx-l2-group)] px-3 py-2.5 text-sm text-muted-foreground">这个节点所在的机器已经不在了。</p>
            )
          ) : data?.host ? (
            <div className="space-y-3">
              {data.match === "address" ? <p className="text-[11px] text-muted-foreground">按地址 {data.subject.address} 对上了这台机器。</p> : null}
              <ExitHostPanel host={data.host} targets={data.targets} />
            </div>
          ) : null}
        </div>
        <p className="shrink-0 border-t pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          每 2 分钟一轮：每个站点握 3 次 TCP 取中位数，再做一次 TLS 看证书是不是这个站点的。只握手不发请求，
          数字是到这个站点最近的节点，不是打开网页要多久。
        </p>
      </DialogContent>
    </Dialog>
  );
}
