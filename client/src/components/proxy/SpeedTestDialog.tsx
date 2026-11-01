import { useMemo } from "react";
import { toast } from "sonner";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { countryFlagLabel } from "@/lib/flagEmojiSupport";
import { trpc } from "@/lib/trpc";
import { formatSpeedMs, formatTraffic, speedReach, speedServerLabel } from "./speedTestFormat";
import { formatMbps, NODE_CHECK_ACCURATE_VERSION, NODE_CHECK_DOMESTIC_VERSION, NODE_CHECK_PANEL_FALLBACK_VERSION, NODE_CHECK_PHASE_LABELS, type SpeedSample, type SpeedTestResult } from "@shared/nodeCheck";

/*
  网速测试：一台机器（或经一个节点）对 Cloudflare 测速。画法照 Stash 的「网速测试」：
  大数字 + 下载 / 上传曲线，下面「出站」一行、「启动」按钮、延迟 / 抖动 / 下载 / 上传 /
  服务机房 / 出口 / 网络 一列。跑的时候曲线是实时的（Agent 每秒送一次进度，这里 1 秒一刷）。

  Agent 2.2.246 起先就近找一个 Ookla 测速点（speedtest.net 按出口 IP 给最近的几台，国内机器拿到电信 / 联通 /
  移动的），测不了换 Cloudflare，都不行才测到面板自己（server = "panel"：量的是到面板这条路，上限是面板
  服务器的带宽，界面上写明，不当成这台机器的带宽）。2.2.245 以前只有 Cloudflare → 面板，上传还偏高。

  subject 两种：
    · { hostId }：主机详情里的「网速测试」，只测这台机器自己的带宽。
    · { entryKey }：预览订阅里每条线路的「测速」：在入口机上临时拉 sing-box 连本机的入口，流量走
      入口 → 中转 → 落地出去，测的就是整条链；直连节点、入口机测不了时借一台机器当客户端
      （server/nodeCheckView 的 planEntryCheck，note 写清楚在哪测、测的是哪一段）。

  延迟是连接建好以后来回一趟的时间（中位数），抖动是相邻两次的差；第一个请求要握手，单独记成「建连」。
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

/**
 * 曲线是入口往后的链路实测的；capMbps（入口机上行比链路慢时）画一条虚线：你下载时被它限住，大数字写的是它。
 */
function SpeedChart({ samples, capMbps }: { samples: SpeedSample[]; capMbps?: number | null }) {
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
          {capMbps && capMbps > 0 ? <ReferenceLine y={capMbps} stroke="var(--fx-warn-text)" strokeDasharray="5 4" strokeWidth={1.5} ifOverflow="extendDomain" /> : null}
        </AreaChart>
      </ResponsiveContainer>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: "var(--fx-accent)" }} />下载</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: "var(--fx-healthy)" }} />上传</span>
        {capMbps && capMbps > 0 ? (
          <span data-testid="speed-chart-cap"><i className="mr-1 inline-block h-0 w-3 border-t-[1.5px] border-dashed align-middle" style={{ borderColor: "var(--fx-warn-text)" }} />入口机上行 {formatMbps(capMbps)}</span>
        ) : null}
      </div>
    </div>
  );
}

function ResultRow({ label, value, strong = false, testId }: { label: string; value: string; strong?: boolean; testId?: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 py-2 text-[13.5px]" data-testid={testId}>
      <span className={strong ? "shrink-0 font-semibold text-foreground" : "shrink-0 text-foreground"}>{label}</span>
      <span className={strong ? "min-w-0 truncate text-right font-semibold tabular-nums text-foreground" : "min-w-0 truncate text-right tabular-nums text-muted-foreground"}>{value}</span>
    </div>
  );
}

function formatDirections(down: number, up: number) {
  return `↓ ${formatMbps(down)} · ↑ ${formatMbps(up)}`;
}

export function SpeedTestDialog({ subject, name, onOpenChange }: { subject: SpeedTestSubject | null; name: string; onOpenChange: (open: boolean) => void }) {
  const utils = trpc.useUtils();
  const hostId = subject && "hostId" in subject ? subject.hostId : 0;
  const entryKey = subject && "entryKey" in subject ? subject.entryKey : "";

  const hostStatus = trpc.hosts.speedTestStatus.useQuery({ hostId }, {
    enabled: hostId > 0,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data?.pending ? 1000 : false),
  });
  const entryStatus = trpc.proxySubscriptions.entrySpeedTestStatus.useQuery({ entryKey }, {
    enabled: !!entryKey,
    refetchOnWindowFocus: false,
    // 入口机自己的网速测试排在线路前面先跑：它在跑的时候也要接着刷
    refetchInterval: (query) => (query.state.data?.pending || query.state.data?.entryHostPending ? 1000 : false),
  });
  const invalidate = () => {
    if (hostId > 0) void utils.hosts.speedTestStatus.invalidate({ hostId });
    if (entryKey) void utils.proxySubscriptions.entrySpeedTestStatus.invalidate({ entryKey });
  };
  const startHost = trpc.hosts.startSpeedTest.useMutation({ onSuccess: invalidate, onError: (error) => toast.error(error.message) });
  const startEntry = trpc.proxySubscriptions.entrySpeedTestStart.useMutation({ onSuccess: invalidate, onError: (error) => toast.error(error.message) });

  const status: Status | null = hostId > 0 ? (hostStatus.data ?? null) : (entryStatus.data ?? null);
  const entryHost = entryKey ? entryStatus.data?.host ?? null : null;
  const pending = status?.pending ?? null;
  const latest = status?.latest ?? null;
  const starting = startHost.isPending || startEntry.isPending;
  const hostUnsupported = (hostId > 0 && hostStatus.data && !hostStatus.data.supported) || (!!entryKey && !!entryHost && !entryHost.supported);
  const hostOffline = (hostId > 0 && hostStatus.data && !hostStatus.data.online) || (!!entryKey && !!entryHost && !entryHost.online);
  const entryNoHost = !!entryKey && !!entryStatus.data && !entryHost;

  // 订阅线路在入口机上测（2.3.502）：入口往后的链路，再按入口机自己的带宽算出你大约能跑到多少
  const entryRole = !!entryKey && entryStatus.data?.hostRole === "entry";
  const entryHostSpeed = entryRole ? entryStatus.data?.entryHostSpeed ?? null : null;
  const entryHostPending = entryRole && !!entryStatus.data?.entryHostPending;
  const reach = latest?.speed && entryHostSpeed && latest.speed.server !== "panel" ? speedReach(latest.speed, entryHostSpeed) : null;

  const samples = pending ? pending.samples : latest?.speed?.samples ?? [];
  const liveSample = pending && pending.samples.length > 0 ? pending.samples[pending.samples.length - 1] : null;
  const headline = pending
    ? liveSample ? formatMbps(liveSample.up > 0 ? liveSample.up : liveSample.down) : "—"
    : reach ? formatMbps(reach.downloadMbps) : latest?.speed ? formatMbps(latest.speed.downloadMbps) : "—";
  const subline = pending
    ? entryHostPending && pending.phase === "queued" ? "先测入口机自己的带宽…" : `${NODE_CHECK_PHASE_LABELS[pending.phase] || "测速中"}…`
    : latest?.speed
      ? `已完成 · ${formatCheckedAt(latest.checkedAt)}${latest.speed.server === "panel" ? " · 到面板的速度" : reach ? " · 你大约能跑到的下载" : ""}`
      : latest?.error ? "上次失败" : "还没测过";

  const exitHostLabel = useMemo(() => {
    if (hostId > 0) return hostStatus.data ? `${countryFlagLabel(hostStatus.data.countryCode) || ""} ${hostStatus.data.hostName}`.trim() : "";
    if (entryHost) return `${entryHost.name}${entryStatus.data?.hostRole === "entry" ? " · 入口机本机" : " · 借来当客户端"}${!entryHost.online ? " · 离线" : !entryHost.supported ? " · Agent 太旧" : ""}`;
    return entryNoHost ? "没有机器能测" : "";
  }, [hostId, hostStatus.data, entryHost, entryStatus.data?.hostRole, entryNoHost]);

  const start = () => {
    if (hostId > 0) startHost.mutate({ hostId });
    else if (entryKey) startEntry.mutate({ entryKey });
  };
  const result = latest?.speed ?? null;
  // 2.2.246 起测得准：就近的 Ookla 测速点、上传只算对端收下的
  const accurate = hostId > 0 ? !!hostStatus.data?.accurate : !!entryHost?.accurate;
  const agentKnown = hostId > 0 ? !!hostStatus.data?.supported : !!entryHost?.supported;
  // 大陆的主机测自己：测国内三网的 Ookla 测速点（Agent 2.2.248 起）
  const domesticHost = hostId > 0 && String(hostStatus.data?.countryCode || "").toUpperCase() === "CN" && !hostStatus.data?.domesticUpgrade;

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
              {samples.length > 0 ? <SpeedChart samples={samples} capMbps={!pending && reach?.downLimitedByEntry ? reach.downloadMbps : null} /> : (
                <div className="flex h-[120px] items-center justify-center text-[12.5px] text-muted-foreground">—</div>
              )}
            </div>
          </div>

          <div className="fx-hd-sec">
            <div className="fx-hd-sec-body pt-2.5">
              <ResultRow label={entryKey ? "从哪台测" : "出站"} value={exitHostLabel || "—"} />
              {entryKey && entryStatus.data?.note ? (
                <p className="pb-2 text-[11.5px] leading-snug text-muted-foreground" data-testid="speed-test-plan">{entryStatus.data.note}</p>
              ) : null}
            </div>
          </div>

          <Button
            type="button"
            className="h-10 w-full rounded-full text-[15px]"
            variant="outline"
            disabled={!!pending || starting || !!hostUnsupported || !!hostOffline || entryNoHost}
            title={hostUnsupported ? "需要升级 Agent（2.2.241 起）" : hostOffline ? "主机离线" : undefined}
            onClick={start}
            data-testid="speed-test-start"
          >
            {pending ? "测速中…" : result ? "再测一次" : "启动"}
          </Button>
          {hostUnsupported ? <p className="text-center text-[12px] text-[var(--fx-warn-text)]">Agent 需升级到 2.2.241</p> : null}
          {latest?.error && !pending ? <p className="text-center text-[12px] text-[var(--fx-down-text)]">{latest.error}</p> : null}

          {entryRole && result && result.server !== "panel" ? (
            <div className="fx-hd-sec">
              <div className="fx-hd-sec-body gap-0 pt-0.5">
                <div className="divide-y divide-[var(--fx-stroke-weak)]" data-testid="speed-test-reach">
                  {reach ? <ResultRow label="你大约能跑到" value={formatDirections(reach.downloadMbps, reach.uploadMbps)} strong testId="speed-test-reach-value" /> : null}
                  <ResultRow label="入口往后的链路" value={formatDirections(result.downloadMbps, result.uploadMbps)} />
                  <ResultRow
                    label="入口机自己的带宽"
                    value={entryHostSpeed ? formatDirections(entryHostSpeed.downloadMbps, entryHostSpeed.uploadMbps) : entryHostPending ? "正在测…" : "还没测过"}
                  />
                </div>
                <p className="pb-2.5 pt-1 text-[11.5px] leading-snug text-muted-foreground">
                  {entryHostSpeed
                    ? `你下载时数据要从入口机发给你，受它的上行限制；上传受它的下行限制（入口机 ${formatCheckedAt(entryHostSpeed.checkedAt)} 测的）。你自己的宽带不在里面。`
                    : entryHostPending
                      ? "入口机自己的带宽测完，这里就算出你大约能跑到多少。"
                      : "入口机 30 天里没测过自己的带宽：再测一次时会先测它，才算得出你大约能跑到多少。"}
                </p>
              </div>
            </div>
          ) : null}
          {result ? (
            <div className="fx-hd-sec">
              <div className="fx-hd-sec-body divide-y divide-[var(--fx-stroke-weak)] gap-0 pt-0.5" data-testid="speed-test-result">
                <ResultRow label="延迟" value={formatSpeedMs(result.latencyMs)} />
                <ResultRow label="抖动" value={formatSpeedMs(result.jitterMs)} />
                {result.connectMs > 0 ? <ResultRow label="建连" value={formatSpeedMs(result.connectMs)} /> : null}
                {/* 在入口机上测的：下载 / 上传在上面「入口往后的链路」里 */}
                {entryRole && result.server !== "panel" ? null : (
                  <>
                    <ResultRow label="下载" value={formatMbps(result.downloadMbps)} />
                    <ResultRow label="上传" value={formatMbps(result.uploadMbps)} />
                  </>
                )}
                <ResultRow label="测速点" value={speedServerLabel(result)} />
                <ResultRow label="出口" value={[[result.city, result.country].filter(Boolean).join(", "), result.clientIp].filter(Boolean).join(" · ") || "—"} />
                <ResultRow label="网络" value={[result.asn, result.asOrg].filter(Boolean).join(" · ") || "—"} />
                {result.downloadBytes + result.uploadBytes > 0 ? <ResultRow label="用掉流量" value={formatTraffic(result.downloadBytes + result.uploadBytes)} /> : null}
              </div>
            </div>
          ) : null}
          {result?.note ? <p className="text-center text-[11.5px] text-[var(--fx-warn-text)]" data-testid="speed-test-note">{result.note}</p> : null}
          {hostId > 0 && hostStatus.data && hostStatus.data.supported && !hostStatus.data.panelFallback ? (
            <p className="text-center text-[11.5px] text-[var(--fx-warn-text)]">这台的 Agent 早于 {NODE_CHECK_PANEL_FALLBACK_VERSION}：连不上 Cloudflare 时不会改测到面板，升级 Agent 后才会</p>
          ) : agentKnown && !accurate ? (
            <p className="text-center text-[11.5px] text-[var(--fx-warn-text)]" data-testid="speed-test-upgrade">
              {entryKey ? "测速那台" : "这台"}的 Agent 早于 {NODE_CHECK_ACCURATE_VERSION}：上传数偏高，国内机器多半只能测到面板（上限是面板的带宽）。升级 Agent 后就近找测速点，测得准
            </p>
          ) : hostId > 0 && hostStatus.data?.supported && hostStatus.data.domesticUpgrade ? (
            <p className="text-center text-[11.5px] text-[var(--fx-warn-text)]" data-testid="speed-test-upgrade">
              这台的 Agent 早于 {NODE_CHECK_DOMESTIC_VERSION}：国内机器连不上 speedtest.net，只能测到面板（上限是面板的带宽）。升级 Agent 后测国内三网的测速点
            </p>
          ) : null}
          <div className="text-center text-[11px] leading-[1.6] text-muted-foreground">
            {accurate || !agentKnown ? (
              <>
                <p>{entryKey ? "经整条链，" : ""}就近找测速点：Ookla{domesticHost ? "（国内三网）" : ""} → Cloudflare → 面板</p>
                <p>流量约为速度 × 18 秒，100M 约 230 MB</p>
              </>
            ) : (
              <p>{entryKey ? "经整条链对 Cloudflare 测速 · 连不上时改测到面板" : "对 Cloudflare 测速 · 连不上时改测到面板"}</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
