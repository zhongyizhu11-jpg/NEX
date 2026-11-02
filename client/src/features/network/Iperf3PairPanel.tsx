import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowLeftRight, Gauge, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/*
  网络测试页「iperf3 对拉」（2.3.505）：选一条隧道（按它经过的机器自动拆段）或者两台机器，一键测。
  每段：下游开 iperf3 服务端 → 上游测正向、反向、（可选）单条连接 → 关服务端，一段一段来，不互相抢带宽。
  结果每段一张卡：正向 / 反向、单条连接、多条里最慢和最快的一条、重传、一句判断（server/lineSegmentSpeed.ts）。
*/

const SECONDS = [5, 10, 20, 30] as const;
const STREAMS = [1, 2, 4, 8, 16] as const;

type Mode = "tunnel" | "hosts";

function mbps(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} Gbps` : `${Math.round(value)} Mbps`;
}

function perGB(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return value >= 10_000 ? `${Math.round(value / 1000)}k / GB` : `${value} / GB`;
}

function Stat({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("truncate tabular-nums", strong ? "text-[17px] font-semibold text-foreground" : "text-[13px] text-foreground")}>{value}</p>
    </div>
  );
}

export function Iperf3PairPanel({ methodPicker, hosts }: { methodPicker: ReactNode; hosts: Array<{ id: number; name: string; isOnline?: boolean }> }) {
  const [mode, setMode] = useState<Mode>("tunnel");
  const [tunnelId, setTunnelId] = useState("");
  const [fromHostId, setFromHostId] = useState("");
  const [toHostId, setToHostId] = useState("");
  const [seconds, setSeconds] = useState("10");
  const [streams, setStreams] = useState("4");
  const [single, setSingle] = useState(true);
  const [runId, setRunId] = useState<string | null>(null);

  const tunnels = trpc.lookingGlass.pairSpeedTunnels.useQuery(undefined, { staleTime: 60_000, refetchOnWindowFocus: false });
  const hostName = useMemo(() => new Map(hosts.map((host) => [Number(host.id), String(host.name)])), [hosts]);
  const start = trpc.lookingGlass.pairSpeedStart.useMutation({
    onSuccess: (run) => setRunId(String(run.runId)),
    onError: (error) => toast.error(error.message),
  });
  const run = trpc.lookingGlass.pairSpeedStatus.useQuery({ runId: runId || "" }, {
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1500 : false),
    refetchOnWindowFocus: false,
  });
  const data = run.data;
  const running = start.isPending || data?.status === "running";

  const chainOf = (hostIds: number[]) => hostIds.map((id) => hostName.get(id) || `主机 ${id}`).join(" → ");
  const passes = 2 + (single && Number(streams) > 1 ? 1 : 0);
  // 按 1 Gbps 估：一段 passes 次，每次 seconds 秒
  const gbPerSegment = (passes * Number(seconds) * 1000) / 8 / 1024;
  const ready = mode === "tunnel" ? Number(tunnelId) > 0 : Number(fromHostId) > 0 && Number(toHostId) > 0 && fromHostId !== toHostId;

  const submit = () => {
    const options = { seconds: Number(seconds), streams: Number(streams), single: single && Number(streams) > 1 };
    if (mode === "tunnel") start.mutate({ tunnelId: Number(tunnelId), ...options });
    else start.mutate({ fromHostId: Number(fromHostId), toHostId: Number(toHostId), ...options });
  };

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,420px)_1fr]" data-testid="iperf3-pair">
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="h-5 w-5 text-primary" />
            测试配置
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {methodPicker}

          <FormField className="space-y-2">
            <Label>测什么</Label>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/40 p-1" role="radiogroup" aria-label="测什么">
              {([["tunnel", "一条隧道"], ["hosts", "两台机器"]] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={mode === value}
                  onClick={() => setMode(value)}
                  className={cn("h-8 rounded-md text-[13px] transition-colors", mode === value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground")}
                  data-testid={`iperf3-pair-mode-${value}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </FormField>

          {mode === "tunnel" ? (
            <FormField className="space-y-2">
              <Label htmlFor="iperf3-pair-tunnel">隧道</Label>
              <Select value={tunnelId} onValueChange={setTunnelId}>
                <SelectTrigger id="iperf3-pair-tunnel"><SelectValue placeholder={tunnels.data?.length === 0 ? "还没有隧道" : "选一条隧道"} /></SelectTrigger>
                <SelectContent>
                  {(tunnels.data || []).map((tunnel) => (
                    <SelectItem key={tunnel.id} value={String(tunnel.id)}>{tunnel.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(() => {
                const tunnel = (tunnels.data || []).find((item) => String(item.id) === tunnelId);
                return tunnel ? (
                  <p className="text-xs text-muted-foreground">
                    {chainOf(tunnel.hostIds)}
                    {tunnel.parallelRelays ? " · 中转是并排的：入口到每台中转、每台中转到出口各测一段" : tunnel.hostIds.length > 2 ? ` · 拆成 ${tunnel.hostIds.length - 1} 段` : ""}
                  </p>
                ) : <p className="text-xs text-muted-foreground">按隧道经过的机器拆段，一段一段测。</p>;
              })()}
            </FormField>
          ) : (
            <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
              <FormField className="min-w-0 space-y-2">
                <Label htmlFor="iperf3-pair-from">上游（发起）</Label>
                <Select value={fromHostId} onValueChange={setFromHostId}>
                  <SelectTrigger id="iperf3-pair-from"><SelectValue placeholder="选机器" /></SelectTrigger>
                  <SelectContent>
                    {hosts.map((host) => <SelectItem key={host.id} value={String(host.id)}>{host.name}{host.isOnline === false ? " / 离线" : ""}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FormField>
              <Button type="button" variant="ghost" size="icon" className="mb-0.5 h-9 w-9" aria-label="两头对调" onClick={() => { setFromHostId(toHostId); setToHostId(fromHostId); }}>
                <ArrowLeftRight className="h-4 w-4" />
              </Button>
              <FormField className="min-w-0 space-y-2">
                <Label htmlFor="iperf3-pair-to">下游（开服务端）</Label>
                <Select value={toHostId} onValueChange={setToHostId}>
                  <SelectTrigger id="iperf3-pair-to"><SelectValue placeholder="选机器" /></SelectTrigger>
                  <SelectContent>
                    {hosts.map((host) => <SelectItem key={host.id} value={String(host.id)}>{host.name}{host.isOnline === false ? " / 离线" : ""}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField className="min-w-0 space-y-2">
              <Label htmlFor="iperf3-pair-seconds">每次测多久</Label>
              <Select value={seconds} onValueChange={setSeconds}>
                <SelectTrigger id="iperf3-pair-seconds"><SelectValue /></SelectTrigger>
                <SelectContent>{SECONDS.map((value) => <SelectItem key={value} value={String(value)}>{value} 秒</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            <FormField className="min-w-0 space-y-2">
              <Label htmlFor="iperf3-pair-streams">并行连接</Label>
              <Select value={streams} onValueChange={setStreams}>
                <SelectTrigger id="iperf3-pair-streams"><SelectValue /></SelectTrigger>
                <SelectContent>{STREAMS.map((value) => <SelectItem key={value} value={String(value)}>{value === 1 ? "1（单连接）" : `${value} 条`}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
          </div>

          <label className={cn("flex items-start gap-2.5 text-[13px]", Number(streams) <= 1 && "opacity-50")}>
            <Checkbox checked={single && Number(streams) > 1} disabled={Number(streams) <= 1} onCheckedChange={(checked) => setSingle(checked === true)} aria-label="加测单条连接" className="mt-0.5" />
            <span>
              加测单条连接
              <span className="block text-xs text-muted-foreground">和多条合计比一比：单个下载能跑多快、中间有没有硬限速</span>
            </span>
          </label>

          <Button className="w-full gap-2" onClick={submit} disabled={!ready || running} data-testid="iperf3-pair-start">
            {running ? <Loader2 className="forwardx-icon-spin h-4 w-4" /> : <Gauge className="h-4 w-4" />}
            {running ? "对拉中…" : "开始对拉"}
          </Button>
          <p className="text-xs leading-relaxed text-muted-foreground">
            每段测 {passes} 次（正向、反向{passes > 2 ? "、单条连接" : ""}），每次 {seconds} 秒，一段一段来；按 1 Gbps 算每段约用 {gbPerSegment.toFixed(1)} GB 流量。下游的 iperf3 服务端测完自动关。
          </p>
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span className="truncate">{data ? data.title : "对拉结果"}</span>
            {data ? (
              <span className={cn("shrink-0 text-xs font-normal", data.status === "error" ? "text-[var(--fx-down-text)]" : "text-muted-foreground")}>
                {data.status === "running" ? "测试中…" : data.status === "done" ? `${data.seconds} 秒 · ${data.streams} 条连接` : "没测成"}
              </span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3" data-testid="iperf3-pair-result">
          {!data ? (
            <p className="py-6 text-center text-[13px] text-muted-foreground">选好隧道或两台机器，点「开始对拉」。正向是上游发给下游（流量往外走的方向），反向是下游发回上游。</p>
          ) : (
            <>
              {data.segments.map((segment, index) => {
                const slowest = data.slowest === index && data.segments.filter((item) => item.status === "done").length > 1;
                return (
                  <div key={index} className={cn("rounded-xl border p-3", slowest ? "border-[var(--fx-warn-text)]/50" : "border-border/60")} data-testid="iperf3-pair-segment">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-[13.5px] font-medium">{segment.from.name} → {segment.to.name}</p>
                      <span className="shrink-0 text-[11.5px] text-muted-foreground">
                        {segment.status === "running" ? <span className="inline-flex items-center gap-1"><Loader2 className="forwardx-icon-spin h-3 w-3" />测试中</span>
                          : segment.status === "pending" ? "排队"
                            : segment.status === "skipped" ? "不测"
                              : segment.status === "error" ? <span className="text-[var(--fx-down-text)]">失败</span>
                                : slowest ? <span className="font-medium text-[var(--fx-warn-text)]">最慢</span> : "完成"}
                      </span>
                    </div>
                    {segment.status === "done" ? (
                      <>
                        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
                          <Stat label="正向（上游 → 下游）" value={mbps(segment.mbps)} strong />
                          <Stat label="反向（下游 → 上游）" value={mbps(segment.reverseMbps)} strong />
                          <Stat label="单条连接" value={mbps(segment.singleMbps)} />
                          <Stat label="多条里最慢 ~ 最快" value={segment.streamRange ? `${Math.round(segment.streamRange.min)} ~ ${Math.round(segment.streamRange.max)}` : "—"} />
                          <Stat label="重传 正 / 反" value={`${perGB(segment.retransPerGB)} · ${perGB(segment.reverseRetransPerGB)}`} />
                        </div>
                        {segment.verdict ? <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">{segment.verdict}</p> : null}
                      </>
                    ) : segment.error && segment.status !== "pending" ? (
                      <p className={cn("mt-1.5 text-[12px]", segment.status === "error" ? "text-[var(--fx-down-text)]" : "text-muted-foreground")}>{segment.error}</p>
                    ) : null}
                  </div>
                );
              })}
              {data.error && data.status === "error" ? <p className="text-[12px] text-[var(--fx-down-text)]">{data.error}</p> : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
