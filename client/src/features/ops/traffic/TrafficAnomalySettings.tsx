import { useEffect, useState } from "react";
import { TrendingUp } from "lucide-react";
import { toast } from "sonner";

import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { useSaveDockItem } from "@/components/settings/SaveDock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import {
  TRAFFIC_ANOMALY_PRESETS,
  TRAFFIC_ANOMALY_SENSITIVITY_OPTIONS,
  TRAFFIC_ANOMALY_THROTTLE_OPTIONS,
  type TrafficAnomalyConfig,
  type TrafficAnomalySensitivity,
} from "@shared/trafficAnomaly";

/*
  设置 › Webhook 下方的「流量异常」（资源告警下面）：规则 / 用户流量突然暴涨、单个来源 IP 连接数暴涨时
  记事件、发给管理员（和资源告警走同一路 Telegram / Discord），可选给规则临时限速。
  灵敏度三档够用；选「自定义」才露出四个阈值。下面列着此刻正在生效的临时限速，误报了可以当场撤掉。
*/

type Draft = Omit<TrafficAnomalyConfig, "cooldownMinutes">;

function toDraft(config: TrafficAnomalyConfig): Draft {
  const { cooldownMinutes: _cooldown, ...rest } = config;
  return rest;
}

function sameDraft(a: Draft, b: Draft) {
  return (Object.keys(a) as Array<keyof Draft>).every((key) => a[key] === b[key]);
}

function NumberInput({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        aria-label={label}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        className="h-8 w-20 text-right"
        value={String(value)}
        onChange={(event) => {
          const n = Number(event.target.value);
          onChange(Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : min);
        }}
      />
      <span className="shrink-0 text-sm text-muted-foreground">{unit}</span>
    </div>
  );
}

function clock(ms: number) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function ActiveThrottles({ enabled }: { enabled: boolean }) {
  const utils = trpc.useUtils();
  const query = trpc.ops.trafficAnomaly.throttles.useQuery(undefined, { enabled, refetchInterval: 60_000 });
  const release = trpc.ops.trafficAnomaly.release.useMutation({
    onSuccess: () => {
      void utils.ops.trafficAnomaly.throttles.invalidate();
      void utils.rules.invalidate();
      toast.success("已撤掉，这一轮异常不会再自动加回来");
    },
    onError: (error) => toast.error(error.message || "撤销失败"),
  });
  const items = query.data ?? [];
  if (!enabled || items.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="text-secondary-type font-medium text-foreground">正在临时限速</div>
      <div className="fx-grouped-list overflow-hidden rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)]">
        {items.map((item) => (
          <div key={item.ruleId} className="fx-list-row flex min-w-0 items-center justify-between gap-3 px-3 py-2.5">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-secondary-type text-foreground">{item.ruleName}</span>
              <span className="text-meta tabular-nums text-muted-foreground">
                限到 {item.mbps} Mbps，{clock(item.until)} 自动撤掉{item.manualMbps > 0 ? `（手动限速 ${item.manualMbps} Mbps 不变）` : ""}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={release.isPending}
              onClick={() => release.mutate({ ruleId: item.ruleId })}
            >
              撤掉
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TrafficAnomalySettings(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const query = trpc.ops.trafficAnomaly.get.useQuery(undefined, { staleTime: 30_000 });
  const settings = query.data;
  const [draft, setDraft] = useState<Draft | null>(null);

  const reset = () => {
    if (settings) setDraft(toDraft(settings));
  };
  useEffect(reset, [settings]);

  const saveMutation = trpc.ops.trafficAnomaly.save.useMutation({
    onSuccess: (next) => {
      utils.ops.trafficAnomaly.get.setData(undefined, next);
      void utils.ops.trafficAnomaly.throttles.invalidate();
      toast.success("流量异常设置已保存");
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });

  const save = (): Promise<boolean> | boolean => {
    if (!draft) return false;
    return saveMutation.mutateAsync(draft).then(() => true, () => false);
  };

  const dirty = !!settings && !!draft && !sameDraft(draft, toDraft(settings));
  useSaveDockItem({
    id: "ops.trafficAnomaly",
    label: "流量异常",
    dirty,
    pending: saveMutation.isPending,
    save,
    reset,
  });

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => (current ? { ...current, [key]: value } : current));
  const setSensitivity = (value: TrafficAnomalySensitivity) => setDraft((current) => {
    if (!current) return current;
    // 从某一档切到自定义：从那一档的数开始改，不是从一堆空框开始。
    return value === "custom" ? { ...current, sensitivity: value } : { ...current, sensitivity: value, ...TRAFFIC_ANOMALY_PRESETS[value] };
  });
  const sensitivity = TRAFFIC_ANOMALY_SENSITIVITY_OPTIONS.find((option) => option.value === draft?.sensitivity);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-primary" />
              流量异常
            </CardTitle>
            <CardDescription className="mt-1">
              规则或用户的流量比平时突然高出好几倍、某个 IP 连接数暴涨时通知管理员，恢复后再报一次。
            </CardDescription>
          </div>
          {settings ? (
            <Badge variant={settings.enabled ? "default" : "outline"} className="w-fit">
              {settings.enabled ? "监控中" : "已关闭"}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <DataSectionLoading label="正在读取流量异常设置" minHeight="min-h-[120px]" />
        ) : query.isError || !settings || !draft ? (
          <DataSectionError label="流量异常设置" error={query.error} onRetry={() => { void query.refetch(); }} retrying={query.isFetching} />
        ) : (
          <>
            <SettingList>
              <SettingRow
                asLabel
                label="启用流量异常检测"
                description="和平时比：近 3 天的中位数、前几天同一时段，取大的那个。建起来不满一天的规则不判。通知走「资源告警」那一路。"
                control={<Checkbox aria-label="启用流量异常检测" checked={draft.enabled} onCheckedChange={(checked) => update("enabled", checked === true)} />}
              />
              <SettingRow
                label="灵敏度"
                description={sensitivity?.description}
                keepDescription
                control={(
                  <Select value={draft.sensitivity} onValueChange={(value) => setSensitivity(value as TrafficAnomalySensitivity)}>
                    <SelectTrigger className="h-8 w-28" aria-label="灵敏度">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TRAFFIC_ANOMALY_SENSITIVITY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              >
                {draft.sensitivity === "custom" ? (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="flex items-center justify-between gap-2 text-meta text-muted-foreground">
                      <span className="whitespace-nowrap">平时的几倍</span>
                      <NumberInput label="平时的几倍" value={draft.multiplier} min={2} max={100} unit="倍" onChange={(value) => update("multiplier", Math.max(2, value))} />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-meta text-muted-foreground">
                      <span className="whitespace-nowrap">至少（绝对下限）</span>
                      <NumberInput label="绝对下限" value={draft.minMbps} min={1} max={100000} unit="Mbps" onChange={(value) => update("minMbps", Math.max(1, value))} />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-meta text-muted-foreground">
                      <span className="whitespace-nowrap">持续多久才算</span>
                      <NumberInput label="持续分钟" value={draft.sustainMinutes} min={1} max={120} unit="分钟" onChange={(value) => update("sustainMinutes", Math.max(1, value))} />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-meta text-muted-foreground">
                      <span className="whitespace-nowrap">单 IP 连接数</span>
                      <NumberInput label="单 IP 连接数" value={draft.ipConnThreshold} min={0} max={1000000} unit="个" onChange={(value) => update("ipConnThreshold", value)} />
                    </label>
                    <span className="text-meta text-muted-foreground sm:col-span-2">单 IP 连接填 0 表示不看连接数。</span>
                  </div>
                ) : null}
              </SettingRow>
              <SettingRow
                asLabel
                label="突增时自动临时限速"
                description="只限这条规则，限到异常线；到时间或回落后自动撤掉。手动设的限速不会被改动。"
                control={<Checkbox aria-label="突增时自动临时限速" checked={draft.autoThrottle} onCheckedChange={(checked) => update("autoThrottle", checked === true)} />}
              />
              {draft.autoThrottle ? (
                <SettingRow
                  label="限速多久"
                  control={(
                    <Select value={String(draft.throttleMinutes)} onValueChange={(value) => update("throttleMinutes", Number(value))}>
                      <SelectTrigger className="h-8 w-28" aria-label="限速多久">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TRAFFIC_ANOMALY_THROTTLE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>
                        ))}
                        {TRAFFIC_ANOMALY_THROTTLE_OPTIONS.some((option) => option.value === draft.throttleMinutes) ? null : (
                          <SelectItem value={String(draft.throttleMinutes)}>{draft.throttleMinutes} 分钟</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  )}
                />
              ) : null}
            </SettingList>

            <ActiveThrottles enabled={settings.enabled} />

            <div className="flex flex-wrap gap-2">
              <Button data-dock-save onClick={() => { void save(); }} disabled={saveMutation.isPending}>
                保存
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
