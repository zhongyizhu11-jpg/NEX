import { useMemo } from "react";
import { toast } from "sonner";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { countryFlagLabel } from "@/lib/flagEmojiSupport";
import { trpc } from "@/lib/trpc";
import { formatSpeedMs, formatTraffic, speedServerLabel } from "./speedTestFormat";
import { formatMbps, NODE_CHECK_PHASE_LABELS, type SpeedSample, type SpeedTestResult } from "@shared/nodeCheck";

/*
  网速测试：一台机器（或经一个节点）对 Cloudflare 测速。画法照 Stash 的「网速测试」：
  大数字 + 下载 / 上传曲线，下面「出站」一行、「启动」按钮、延迟 / 抖动 / 下载 / 上传 /
  服务机房 / 出口 / 网络 一列。跑的时候曲线是实时的（Agent 每秒送一次进度，这里 1 秒一刷）。

  Agent 2.2.246 起先就近找一个 Ookla 测速点（speedtest.net 按出口 IP 给最近的几台，国内机器拿到电信 / 联通 /
  移动的），测不了换 Cloudflare，都不行才测到面板自己（server = "panel"：量的是到面板这条路，上限是面板
  服务器的带宽，界面上写明，不当成这台机器的带宽）。2.2.245 以前只有 Cloudflare → 面板，上传还偏高。

  只测这台机器自己的带宽（主机详情里的「网速测试」）。订阅预览里经整条链测线路的那种 2.3.505 去掉了：
  瓶颈在入口机自己的带宽，链路上机器之间的速度用网络测试页的「iperf3 对拉」测。

  延迟是连接建好以后来回一趟的时间（中位数），抖动是相邻两次的差；第一个请求要握手，单独记成「建连」。
*/

export type SpeedTestSubject = { hostId: number };

type Status = {
  pending: { runId: string; hostId: number; phase: string; startedAt: number; samples: SpeedSample[] } | null;
  latest: { runId: string; hostId: number; nodeId: number; checkedAt: number; error: string; speed: SpeedTestResult | null } | null;
};

function formatCheckedAt(sec: number) {
  if (!sec) return "";
  return new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function SpeedChart({ samples }: { samples: SpeedSample[] }) {
  const data = samples.map((sample) => ({ t: sample.t / 1000, down: sample.down, up: sample.up }));
  const max = Math.max(1, ...samples.map((sample) => Math.max(sample.down, sample.up)));
  const yMax = max <= 10 ? 10 : max <= 100 ? 100 : max <= 500 ? 500 : max <= 1000 ? 1000 : Math.ceil(max / 1000) * 1000;
  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={170}>
        <AreaChart data={data} margin={{ top: 6, right: 8, left: -10, bottom: 0 }}>
          <defs>
            <linearGradient id="fxSpeedDown" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--fx-accent)" stopOpacity={0.32} />
              <stop offset="95%" stopColor="var(--fx-accent)" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="fxSpeedUp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--fx-healthy)" stopOpacity={0.28} />
              <stop offset="95%" stopColor="var(--fx-healthy)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--fx-stroke-weak)" vertical={false} />
          <XAxis dataKey="t" tick={{ fontSize: 10 }} tickFormatter={(value) => `${Math.round(Number(value))}s`} minTickGap={32} />
          <YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => (Number(value) >= 1000 ? `${Number(value) / 1000} Gbps` : `${value}`)} width={48} domain={[0, yMax]} allowDecimals={false} />
          <RTooltip
            formatter={(value: number, name: string) => [formatMbps(Number(value)), name === "down" ? "下载" : "上传"]}
            labelFormatter={(value) => `${Number(value).toFixed(1)} s`}
            cursor={{ stroke: "var(--fx-text-muted)", strokeDasharray: "3 3" }}
            contentStyle={{ fontSize: 12, borderRadius: 8 }}
          />
          <Area type="monotone" dataKey="down" stroke="var(--fx-accent)" strokeWidth={2} fill="url(#fxSpeedDown)" isAnimationActive={false} />
          <Area type="monotone" dataKey="up" stroke="var(--fx-healthy)" strokeWidth={2} fill="url(#fxSpeedUp)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: "var(--fx-accent)" }} />下载</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: "var(--fx-healthy)" }} />上传</span>
      </div>
    </div>
  );
}

function ResultRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 py-2 text-[13.5px]">
      <span className="shrink-0 text-foreground">{label}</span>
      <span className="min-w-0 truncate text-right tabular-nums text-muted-foreground">{value}</span>
    </div>
  );
}

export function SpeedTestDialog({ subject, name, onOpenChange }: { subject: SpeedTestSubject | null; name: string; onOpenChange: (open: boolean) => void }) {
  const utils = trpc.useUtils();
  const hostId = subject?.hostId ?? 0;

  const hostStatus = trpc.hosts.speedTestStatus.useQuery({ hostId }, {
    enabled: hostId > 0,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data?.pending ? 1000 : false),
  });
  const startHost = trpc.hosts.startSpeedTest.useMutation({
    onSuccess: () => void utils.hosts.speedTestStatus.invalidate({ hostId }),
    onError: (error) => toast.error(error.message),
  });

  const status: Status | null = hostStatus.data ?? null;
  const pending = status?.pending ?? null;
  const latest = status?.latest ?? null;
  const hostOffline = !!hostStatus.data && !hostStatus.data.online;

  const samples = pending ? pending.samples : latest?.speed?.samples ?? [];
  const liveSample = pending && pending.samples.length > 0 ? pending.samples[pending.samples.length - 1] : null;
  const headline = pending
    ? liveSample ? formatMbps(liveSample.up > 0 ? liveSample.up : liveSample.down) : "—"
    : latest?.speed ? formatMbps(latest.speed.downloadMbps) : "—";
  const subline = pending
    ? `${NODE_CHECK_PHASE_LABELS[pending.phase] || "测速中"}…`
    : latest?.speed
      ? `已完成 · ${formatCheckedAt(latest.checkedAt)}${latest.speed.server === "panel" ? " · 到面板的速度" : ""}`
      : latest?.error ? "上次失败" : "还没测过";

  const exitHostLabel = useMemo(
    () => (hostStatus.data ? `${countryFlagLabel(hostStatus.data.countryCode) || ""} ${hostStatus.data.hostName}`.trim() : ""),
    [hostStatus.data],
  );

  const result = latest?.speed ?? null;
  // 大陆的主机测自己：测国内三网的 Ookla 测速点
  const domesticHost = String(hostStatus.data?.countryCode || "").toUpperCase() === "CN";

  return (
    <Dialog open={!!subject} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle>网速测试</DialogTitle>
          <DialogDescription className="truncate text-[13px]">{name}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" data-testid="speed-test">
          <div className="fx-hd-sec">
            <div className="fx-hd-sec-body pt-3">
              <div className="text-[38px] font-semibold leading-none tracking-tight tabular-nums" data-testid="speed-headline">{headline}</div>
              <div className="text-[13px] text-muted-foreground">{subline}</div>
              {samples.length > 0 ? <SpeedChart samples={samples} /> : (
                <div className="flex h-[120px] items-center justify-center text-[12.5px] text-muted-foreground">—</div>
              )}
            </div>
          </div>

          <div className="fx-hd-sec">
            <div className="fx-hd-sec-body pt-2.5">
              <ResultRow label="出站" value={exitHostLabel || "—"} />
            </div>
          </div>

          <Button
            type="button"
            className="h-10 w-full rounded-full text-[15px]"
            variant="outline"
            disabled={!!pending || startHost.isPending || hostOffline}
            title={hostOffline ? "主机离线" : undefined}
            onClick={() => startHost.mutate({ hostId })}
            data-testid="speed-test-start"
          >
            {pending ? "测速中…" : result ? "再测一次" : "启动"}
          </Button>
          {latest?.error && !pending ? <p className="text-center text-[12px] text-[var(--fx-down-text)]">{latest.error}</p> : null}

          {result ? (
            <div className="fx-hd-sec">
              <div className="fx-hd-sec-body divide-y divide-[var(--fx-stroke-weak)] gap-0 pt-0.5" data-testid="speed-test-result">
                <ResultRow label="延迟" value={formatSpeedMs(result.latencyMs)} />
                <ResultRow label="抖动" value={formatSpeedMs(result.jitterMs)} />
                {result.connectMs > 0 ? <ResultRow label="建连" value={formatSpeedMs(result.connectMs)} /> : null}
                <ResultRow label="下载" value={formatMbps(result.downloadMbps)} />
                <ResultRow label="上传" value={formatMbps(result.uploadMbps)} />
                <ResultRow label="测速点" value={speedServerLabel(result)} />
                <ResultRow label="出口" value={[[result.city, result.country].filter(Boolean).join(", "), result.clientIp].filter(Boolean).join(" · ") || "—"} />
                <ResultRow label="网络" value={[result.asn, result.asOrg].filter(Boolean).join(" · ") || "—"} />
                {result.downloadBytes + result.uploadBytes > 0 ? <ResultRow label="用掉流量" value={formatTraffic(result.downloadBytes + result.uploadBytes)} /> : null}
              </div>
            </div>
          ) : null}
          {result?.note ? <p className="text-center text-[11.5px] text-[var(--fx-warn-text)]" data-testid="speed-test-note">{result.note}</p> : null}
          <div className="text-center text-[11px] leading-[1.6] text-muted-foreground">
            <p>就近找测速点：Ookla{domesticHost ? "（国内三网）" : ""} → Cloudflare → 面板</p>
            <p>流量约为速度 × 18 秒，100M 约 230 MB</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
