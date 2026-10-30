import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { countryFlagLabel } from "@/lib/flagEmojiSupport";
import { trpc } from "@/lib/trpc";
import { formatMbps, NODE_CHECK_PHASE_LABELS, type SpeedSample, type SpeedTestResult } from "@shared/nodeCheck";

/*
  网速测试：一台机器（或经一个节点）对 Cloudflare 测速。画法照 Stash 的「网速测试」：
  大数字 + 下载 / 上传曲线，下面「出站」一行、「启动」按钮、延迟 / 抖动 / 下载 / 上传 /
  服务机房 / 出口 / 网络 一列。跑的时候曲线是实时的（Agent 每秒送一次进度，这里 1 秒一刷）。

  subject 两种：
    · { hostId }：主机详情里的「网速测试」，只测这台机器自己的带宽。
    · { entryKey }：预览订阅里每条线路的「测速」：挑一台不在这条线路上的机器，临时拉 sing-box
      把订阅里这条线路的入口当出站（客户端拿到的就是它），测的是整条链（server/nodeCheckView）。
*/

export type SpeedTestSubject = { hostId: number } | { entryKey: string };

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
      <div className="mt-1.5 flex gap-4 text-[11px] text-muted-foreground">
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
  const hostId = subject && "hostId" in subject ? subject.hostId : 0;
  const entryKey = subject && "entryKey" in subject ? subject.entryKey : "";
  const [viaHostId, setViaHostId] = useState<number>(0);
  useEffect(() => { setViaHostId(0); }, [entryKey, hostId]);

  const hostStatus = trpc.hosts.speedTestStatus.useQuery({ hostId }, {
    enabled: hostId > 0,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data?.pending ? 1000 : false),
  });
  const entryStatus = trpc.proxySubscriptions.entrySpeedTestStatus.useQuery({ entryKey }, {
    enabled: !!entryKey,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data?.pending ? 1000 : false),
  });
  const invalidate = () => {
    if (hostId > 0) void utils.hosts.speedTestStatus.invalidate({ hostId });
    if (entryKey) void utils.proxySubscriptions.entrySpeedTestStatus.invalidate({ entryKey });
  };
  const startHost = trpc.hosts.startSpeedTest.useMutation({ onSuccess: invalidate, onError: (error) => toast.error(error.message) });
  const startEntry = trpc.proxySubscriptions.entrySpeedTestStart.useMutation({ onSuccess: invalidate, onError: (error) => toast.error(error.message) });

  const status: Status | null = hostId > 0 ? (hostStatus.data ?? null) : (entryStatus.data ?? null);
  const candidates = entryKey ? entryStatus.data?.candidates ?? [] : [];
  const chosenVia = viaHostId || candidates.find((item) => item.online && item.supported)?.id || 0;
  const pending = status?.pending ?? null;
  const latest = status?.latest ?? null;
  const starting = startHost.isPending || startEntry.isPending;
  const hostUnsupported = hostId > 0 && hostStatus.data && !hostStatus.data.supported;
  const hostOffline = hostId > 0 && hostStatus.data && !hostStatus.data.online;

  const samples = pending ? pending.samples : latest?.speed?.samples ?? [];
  const liveSample = pending && pending.samples.length > 0 ? pending.samples[pending.samples.length - 1] : null;
  const headline = pending
    ? liveSample ? formatMbps(liveSample.up > 0 ? liveSample.up : liveSample.down) : "—"
    : latest?.speed ? formatMbps(latest.speed.downloadMbps) : "—";
  const subline = pending
    ? `${NODE_CHECK_PHASE_LABELS[pending.phase] || "测速中"}…`
    : latest?.speed ? `已完成 · ${formatCheckedAt(latest.checkedAt)}` : latest?.error ? "上次失败" : "还没测过";

  const exitHostLabel = useMemo(() => {
    if (hostId > 0) return hostStatus.data ? `${countryFlagLabel(hostStatus.data.countryCode) || ""} ${hostStatus.data.hostName}`.trim() : "";
    return "";
  }, [hostId, hostStatus.data]);

  const start = () => {
    if (hostId > 0) startHost.mutate({ hostId });
    else if (entryKey) startEntry.mutate({ entryKey, hostId: chosenVia || undefined });
  };
  const result = latest?.speed ?? null;

  return (
    <Dialog open={!!subject} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle>网速测试 · {name}</DialogTitle>
          <DialogDescription className="text-xs">
            {entryKey ? "从一台机器连这条线路的入口，走完整条链对 Cloudflare 测速：延迟、抖动、下载、上传，以及最后从哪个出口出去。" : "这台机器对 Cloudflare 测速：延迟、抖动、下载、上传，以及从哪个机房、哪个出口出去。"}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" data-testid="speed-test">
          <div className="fx-hd-sec">
            <div className="fx-hd-sec-body pt-3">
              <div className="text-[34px] font-bold leading-none tracking-tight tabular-nums" data-testid="speed-headline">{headline}</div>
              <div className="text-[13px] text-muted-foreground">{subline}</div>
              {samples.length > 0 ? <SpeedChart samples={samples} /> : (
                <div className="flex h-[120px] items-center justify-center text-[12.5px] text-muted-foreground">点「启动」开始，曲线会实时画出来。</div>
              )}
            </div>
          </div>

          <div className="fx-hd-sec">
            <div className="fx-hd-sec-body pt-2.5">
              {entryKey ? (
                <div className="flex min-w-0 items-center justify-between gap-3 text-[13.5px]">
                  <span className="shrink-0">从哪台测</span>
                  <Select value={chosenVia ? String(chosenVia) : ""} onValueChange={(value) => setViaHostId(Number(value))}>
                    <SelectTrigger className="h-8 w-[200px]" aria-label="从哪台机器测"><SelectValue placeholder="选一台机器" /></SelectTrigger>
                    <SelectContent>
                      {candidates.map((item) => (
                        <SelectItem key={item.id} value={String(item.id)} disabled={!item.online || !item.supported}>
                          {item.name}{!item.online ? " · 离线" : !item.supported ? " · Agent 太旧" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <ResultRow label="出站" value={exitHostLabel || "—"} />
              )}
              {entryKey ? (
                <p className="text-[11.5px] text-muted-foreground">
                  选中的机器会像客户端一样连这条线路的入口，流量走入口 → 中转 → 落地出去，测出来的就是整条链的带宽。机器上要有 sing-box（建过自建节点的都有），线路上的机器不在候选里。
                </p>
              ) : null}
            </div>
          </div>

          <Button
            type="button"
            className="h-10 w-full rounded-full text-[15px]"
            variant="outline"
            disabled={!!pending || starting || !!hostUnsupported || !!hostOffline || (!!entryKey && !chosenVia)}
            title={hostUnsupported ? `需要升级 Agent（${hostStatus.data?.minAgentVersion} 起）` : hostOffline ? "主机离线" : undefined}
            onClick={start}
            data-testid="speed-test-start"
          >
            {pending ? "测速中…" : result ? "再测一次" : "启动"}
          </Button>
          {hostUnsupported ? <p className="text-[12px] text-[var(--fx-warn-text)]">这台机器的 Agent 太旧，升级到 {hostStatus.data?.minAgentVersion} 后才能测速。</p> : null}
          {latest?.error && !pending ? <p className="text-[12px] text-[var(--fx-down-text)]">{latest.error}</p> : null}

          {result ? (
            <div className="fx-hd-sec">
              <div className="fx-hd-sec-body divide-y divide-[var(--fx-stroke-weak)] gap-0 pt-0.5" data-testid="speed-test-result">
                <ResultRow label="延迟" value={`${Math.round(result.latencyMs)} ms`} />
                <ResultRow label="抖动" value={`${Math.round(result.jitterMs)} ms`} />
                <ResultRow label="下载" value={formatMbps(result.downloadMbps)} />
                <ResultRow label="上传" value={formatMbps(result.uploadMbps)} />
                <ResultRow label="服务机房" value={result.colo || "—"} />
                <ResultRow label="出口" value={[[result.city, result.country].filter(Boolean).join(", "), result.clientIp].filter(Boolean).join(" · ") || "—"} />
                <ResultRow label="网络" value={[result.asn, result.asOrg].filter(Boolean).join(" · ") || "—"} />
              </div>
            </div>
          ) : null}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            此测速使用 Cloudflare 的测速服务，测的是{entryKey ? "经这条线路" : "这台机器"}到 Cloudflare 最近机房的带宽，每次约 300 MB 流量。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
