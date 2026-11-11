import { lazy, Suspense, useMemo, useState } from "react";
import { Info } from "lucide-react";
import { toast } from "sonner";

import {
  CARRIER_FAIL_LABELS,
  carrierFailTone,
  PROBE_CARRIER_COLORS,
  PROBE_CARRIER_LABELS,
  PROBE_CARRIERS,
  SHANGHAI_CARRIER_PRESET,
  type CarrierGroup,
  type CarrierHostSummary,
  type ProbeCarrier,
} from "@shared/probeCarrier";
import { Sparkline } from "@/components/charts/Sparkline";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import type { CarrierChartLine, CarrierChartPoint } from "./ProbeCarrierCharts";

const ProbeCarrierChart = lazy(() => import("./ProbeCarrierCharts"));

/*
  主机探测服务的「三网视图」（shared/probeCarrier.ts）：打了运营商标签的服务按电信 / 联通 / 移动分组。

    总览      每一网一块，块里每台主机一行：当前 RTT、24 小时失败率、24 小时小走势
    单机      选一台：三张摘要卡 + 一张图三条线
    双机对比  选两台：每一网一张图，两条线

  只是换个角度看已有的探测样本（不新增采集）。界面上要讲清楚：Ping 的失败是「丢包」，TCPing 的失败是
  「TCP 失败」；探的是一个固定目标，它不回不等于这家运营商整体断了。
*/

type Mode = "overview" | "single" | "compare";
type ViewData = {
  groups: CarrierGroup[];
  hosts: Array<{ id: number; name: string; online: boolean; country: string | null }>;
  series: Array<{ serviceId: number; hostId: number; latencyMs: number | null; at: number }>;
  presetMissing: string[];
};

const FAIL_TONE_CLASS: Record<ReturnType<typeof carrierFailTone>, string> = {
  ok: "text-[var(--fx-healthy-text)]",
  warn: "text-[var(--fx-warn-text)]",
  down: "text-[var(--fx-down-text)]",
  none: "text-muted-foreground",
};

function msText(value: number | null) {
  return value === null ? "—" : `${value} ms`;
}

function failText(summary: Pick<CarrierHostSummary, "failPct" | "failKind"> | null | undefined) {
  if (!summary || summary.failPct === null) return "—";
  return `${CARRIER_FAIL_LABELS[summary.failKind]} ${summary.failPct}%`;
}

function serviceTargetText(service: CarrierGroup["services"][number]) {
  return service.method === "ping" ? `Ping ${service.targetIp}` : `TCPing ${service.targetIp}:${service.targetPort ?? "-"}`;
}

export function CarrierCaveat() {
  return (
    <p className="flex items-start gap-1.5 rounded-md bg-[var(--fx-l2-group)] px-3 py-2 text-xs text-muted-foreground" data-testid="carrier-caveat">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        每一网探的是一个固定目标：目标不回（ICMP 限速、维护、换地址）不代表这家运营商整体断了，多看几台主机、几个目标再下结论。
        Ping 的失败记为「丢包」，TCPing 的失败记为「TCP 失败」（连接没建立），两者口径不同。
      </span>
    </p>
  );
}

function OverviewGroup({ group, hostName }: { group: CarrierGroup; hostName: (id: number) => string }) {
  const color = PROBE_CARRIER_COLORS[group.carrier];
  const services = new Map(group.services.map((service) => [service.id, service]));
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] p-3" data-testid={`carrier-group-${group.carrier}`}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />
          {PROBE_CARRIER_LABELS[group.carrier]}
        </span>
        <span className="min-w-0 truncate text-meta text-muted-foreground">
          {group.services.length === 0 ? "还没有打这个标签的服务" : group.services.map((service) => `${service.name}（${serviceTargetText(service)}）`).join("、")}
        </span>
      </div>
      {group.hosts.length === 0 ? (
        <p className="text-meta text-muted-foreground">{group.services.length === 0 ? "编辑一个探测服务、把运营商选成这一网，或者加上海三网预设。" : "24 小时内还没有探测样本。"}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--fx-stroke-weak)]">
          {group.hosts.map((host) => (
            <li key={`${host.serviceId}-${host.hostId}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-1.5 sm:grid-cols-[minmax(0,1fr)_5rem_7.5rem_8rem]">
              <span className="min-w-0 truncate text-sm" title={group.services.length > 1 ? services.get(host.serviceId)?.name : undefined}>
                {hostName(host.hostId)}
                {group.services.length > 1 ? <span className="ml-1 text-meta text-muted-foreground">· {services.get(host.serviceId)?.name}</span> : null}
              </span>
              <span className="text-right font-mono text-[13px] font-semibold tabular-nums" title="最近 15 分钟内最后一次的 RTT">{msText(host.currentMs)}</span>
              <span className={cn("text-meta tabular-nums sm:text-right", FAIL_TONE_CLASS[carrierFailTone(host.failPct)])} title="24 小时">{failText(host)}</span>
              <Sparkline values={host.trend.map((point) => point.latencyMs ?? 0)} width={128} height={22} minScale={50} stroke={color} className="h-[22px] w-full" title="24 小时 RTT" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 一台主机在某一网上的摘要（这一网有几个服务时取第一个有数据的）。 */
function hostCarrierSummary(groups: CarrierGroup[], carrier: ProbeCarrier, hostId: number) {
  return groups.find((group) => group.carrier === carrier)?.hosts.find((host) => host.hostId === hostId) || null;
}

/** 把 5 分钟一格的样本拼成图的数据：每条线一列。 */
function chartData(series: ViewData["series"], picks: Array<{ key: string; serviceId: number; hostId: number }>): CarrierChartPoint[] {
  const byTime = new Map<number, CarrierChartPoint>();
  for (const pick of picks) {
    for (const row of series) {
      if (row.serviceId !== pick.serviceId || row.hostId !== pick.hostId) continue;
      const point = byTime.get(row.at) || ({ t: row.at } as CarrierChartPoint);
      point[pick.key] = row.latencyMs;
      byTime.set(row.at, point);
    }
  }
  return Array.from(byTime.values()).sort((a, b) => a.t - b.t);
}

function ChartBox({ data, lines }: { data: CarrierChartPoint[]; lines: CarrierChartLine[] }) {
  if (data.length === 0) return <p className="py-6 text-center text-meta text-muted-foreground">24 小时内还没有样本</p>;
  return (
    <Suspense fallback={<Skeleton className="h-[220px] w-full" />}>
      <ProbeCarrierChart data={data} lines={lines} />
    </Suspense>
  );
}

function HostSelect({ value, onChange, hosts, label, exclude }: { value: number; onChange: (id: number) => void; hosts: ViewData["hosts"]; label: string; exclude?: number }) {
  return (
    <Select value={value ? String(value) : ""} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger aria-label={label} className="h-8 w-full text-xs sm:w-[200px]">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {hosts.filter((host) => host.id !== exclude).map((host) => (
          <SelectItem key={host.id} value={String(host.id)}>{host.name}{host.online ? "" : "（离线）"}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SingleHost({ data, hostId }: { data: ViewData; hostId: number }) {
  const picks = PROBE_CARRIERS.flatMap((carrier) => {
    const summary = hostCarrierSummary(data.groups, carrier, hostId);
    return summary ? [{ key: carrier, serviceId: summary.serviceId, hostId, carrier }] : [];
  });
  const lines: CarrierChartLine[] = picks.map((pick) => ({ key: pick.key, label: PROBE_CARRIER_LABELS[pick.carrier], color: PROBE_CARRIER_COLORS[pick.carrier] }));
  return (
    <div className="flex flex-col gap-3" data-testid="carrier-single">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {PROBE_CARRIERS.map((carrier) => {
          const summary = hostCarrierSummary(data.groups, carrier, hostId);
          return (
            <div key={carrier} className="flex flex-col gap-1 rounded-[var(--fx-radius-control)] bg-[var(--fx-l2-group)] px-3 py-2">
              <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: PROBE_CARRIER_COLORS[carrier] }} aria-hidden="true" />
                {PROBE_CARRIER_LABELS[carrier]}
              </span>
              <span className="font-mono text-lg font-semibold tabular-nums">{msText(summary?.currentMs ?? null)}</span>
              <span className="text-[11px] text-muted-foreground">
                24 小时均值 {msText(summary?.avgMs ?? null)} ·{" "}
                <span className={FAIL_TONE_CLASS[carrierFailTone(summary?.failPct ?? null)]}>{failText(summary)}</span>
              </span>
            </div>
          );
        })}
      </div>
      <ChartBox data={chartData(data.series, picks)} lines={lines} />
    </div>
  );
}

function CompareHosts({ data, a, b, hostName }: { data: ViewData; a: number; b: number; hostName: (id: number) => string }) {
  return (
    <div className="flex flex-col gap-3" data-testid="carrier-compare">
      {PROBE_CARRIERS.map((carrier) => {
        const sa = hostCarrierSummary(data.groups, carrier, a);
        const sb = hostCarrierSummary(data.groups, carrier, b);
        const picks = [
          ...(sa ? [{ key: "a", serviceId: sa.serviceId, hostId: a }] : []),
          ...(sb ? [{ key: "b", serviceId: sb.serviceId, hostId: b }] : []),
        ];
        const lines: CarrierChartLine[] = [
          ...(sa ? [{ key: "a", label: hostName(a), color: PROBE_CARRIER_COLORS[carrier] }] : []),
          ...(sb ? [{ key: "b", label: hostName(b), color: "var(--fx-text-secondary)", dashed: true }] : []),
        ];
        return (
          <section key={carrier} className="flex flex-col gap-1.5 rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-semibold">{PROBE_CARRIER_LABELS[carrier]}</span>
              <span className="text-meta text-muted-foreground tabular-nums">
                {hostName(a)} {msText(sa?.currentMs ?? null)} · {failText(sa)}　｜　{hostName(b)} {msText(sb?.currentMs ?? null)} · {failText(sb)}
              </span>
            </div>
            <ChartBox data={chartData(data.series, picks)} lines={lines} />
          </section>
        );
      })}
    </div>
  );
}

export default function ProbeCarrierView() {
  const utils = trpc.useUtils();
  const query = trpc.probeCarrier.view.useQuery(undefined, { refetchInterval: pollingInterval("slow"), staleTime: 15_000 });
  const addPreset = trpc.probeCarrier.addShanghaiPreset.useMutation({
    onSuccess: (result) => {
      toast.success(result.created > 0 ? `已添加 ${result.created} 条上海三网探测服务，所有管理员主机会开始探测` : "上海三网预设已经都在了");
      void utils.probeCarrier.view.invalidate();
      void utils.hosts.probeServices.invalidate();
    },
    onError: (error) => toast.error(error.message || "添加失败"),
  });
  const [mode, setMode] = useState<Mode>("overview");
  const [hostA, setHostA] = useState(0);
  const [hostB, setHostB] = useState(0);
  const data = query.data as ViewData | undefined;
  const hostNames = useMemo(() => new Map((data?.hosts || []).map((host) => [host.id, host.name])), [data?.hosts]);
  const hostName = (id: number) => hostNames.get(id) || `主机 ${id}`;
  const hosts = data?.hosts || [];
  const pickedA = hostA || hosts[0]?.id || 0;
  const pickedB = hostB || hosts.find((host) => host.id !== pickedA)?.id || 0;
  const hasServices = !!data && data.groups.some((group) => group.services.length > 0);

  if (query.isLoading) return <DataSectionLoading label="正在加载三网数据" />;
  if (query.isError) return <p className="text-sm text-muted-foreground">读取失败：{query.error.message}</p>;
  if (!data) return null;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="probe-carrier-view">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex h-8 items-center gap-0.5 self-start rounded-md bg-[var(--fx-l3-control-fill)] p-[3px]" role="tablist" aria-label="三网视图">
          {([["overview", "总览"], ["single", "单机"], ["compare", "双机对比"]] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "inline-flex h-full items-center justify-center whitespace-nowrap rounded-inner px-3 text-xs font-medium text-muted-foreground transition-all hover:text-foreground",
                mode === value && "bg-[image:var(--fx-primary-gradient)] font-semibold text-[var(--fx-primary-text)] hover:text-[var(--fx-primary-text)]",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mode === "single" && hosts.length > 0 ? <HostSelect value={pickedA} onChange={setHostA} hosts={hosts} label="选择主机" /> : null}
          {mode === "compare" && hosts.length > 0 ? (
            <>
              <HostSelect value={pickedA} onChange={setHostA} hosts={hosts} label="主机 A" exclude={pickedB} />
              <HostSelect value={pickedB} onChange={setHostB} hosts={hosts} label="主机 B" exclude={pickedA} />
            </>
          ) : null}
          {data.presetMissing.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={addPreset.isPending}
              title={SHANGHAI_CARRIER_PRESET.map((item) => `${item.name}：${item.method === "ping" ? item.targetIp : `${item.targetIp}:${item.targetPort}`}`).join("\n")}
              onClick={() => addPreset.mutate()}
            >
              {addPreset.isPending ? "添加中…" : "添加上海三网预设"}
            </Button>
          ) : null}
        </div>
      </div>

      <CarrierCaveat />

      {!hasServices ? (
        <p className="rounded-md border border-dashed border-[var(--fx-stroke-base)] px-3 py-6 text-center text-sm text-muted-foreground">
          还没有打运营商标签的探测服务。点「添加上海三网预设」一键加三条（电信 Ping 202.96.209.5、联通 TCPing 210.22.84.3:53、移动 Ping 211.136.150.66），
          或者在服务列表里编辑一条服务、选好「运营商」。
        </p>
      ) : mode === "overview" ? (
        <div className="flex flex-col gap-3">
          {data.groups.map((group) => <OverviewGroup key={group.carrier} group={group} hostName={hostName} />)}
        </div>
      ) : hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">24 小时内还没有探测样本。</p>
      ) : mode === "single" ? (
        <SingleHost data={data} hostId={pickedA} />
      ) : hosts.length < 2 ? (
        <p className="text-sm text-muted-foreground">只有一台主机有样本，至少要两台才能对比。</p>
      ) : (
        <CompareHosts data={data} a={pickedA} b={pickedB} hostName={hostName} />
      )}
    </div>
  );
}
