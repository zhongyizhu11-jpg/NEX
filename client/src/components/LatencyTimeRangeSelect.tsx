import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type LatencyTimeRangeHours = 720 | 168 | 72 | 24 | 12 | 6 | 3 | 1 | 0.5;

export const DEFAULT_LATENCY_TIME_RANGE_HOURS: LatencyTimeRangeHours = 24;

export const LATENCY_TIME_RANGE_OPTIONS: Array<{ value: string; hours: LatencyTimeRangeHours; label: string }> = [
  { value: "24", hours: 24, label: "24H" },
  { value: "12", hours: 12, label: "12H" },
  { value: "6", hours: 6, label: "6H" },
  { value: "3", hours: 3, label: "3H" },
  { value: "1", hours: 1, label: "1H" },
  { value: "0.5", hours: 0.5, label: "0.5H" },
];

/**
 * 更长的几档：只有存了按小时汇总的图表能用（主机的服务延迟，见 server/repositories/hostProbeHourlyRepository.ts）；
 * 规则、隧道、线路组的原始样本只留 72 小时，还用上面那组。
 */
export const LATENCY_LONG_TIME_RANGE_OPTIONS: Array<{ value: string; hours: LatencyTimeRangeHours; label: string }> = [
  { value: "720", hours: 720, label: "30天" },
  { value: "168", hours: 168, label: "7天" },
  { value: "72", hours: 72, label: "3天" },
  ...LATENCY_TIME_RANGE_OPTIONS,
];

export function latencyTimeRangeLabel(hours: number) {
  const option = LATENCY_LONG_TIME_RANGE_OPTIONS.find((item) => item.hours === hours);
  return option?.label || `${hours}H`;
}

export function filterLatencySeriesByTimeRange<T extends { recordedAt: string | Date }>(
  series: T[] | null | undefined,
  hours: number,
  now = Date.now(),
) {
  if (!series?.length) return [];
  const rangeMs = Math.max(0.5, Number(hours) || DEFAULT_LATENCY_TIME_RANGE_HOURS) * 60 * 60 * 1000;
  const cutoff = now - rangeMs;
  return series.filter((item) => {
    const time = new Date(item.recordedAt).getTime();
    return Number.isFinite(time) && time >= cutoff && time <= now;
  });
}

export function LatencyTimeRangeSelect({
  value,
  onChange,
  className,
  long = false,
}: {
  value: LatencyTimeRangeHours;
  onChange: (value: LatencyTimeRangeHours) => void;
  className?: string;
  /** 加上 3 天 / 7 天 / 30 天。 */
  long?: boolean;
}) {
  const options = long ? LATENCY_LONG_TIME_RANGE_OPTIONS : LATENCY_TIME_RANGE_OPTIONS;
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => {
        const option = options.find((item) => item.value === next);
        if (option) onChange(option.hours);
      }}
    >
      <SelectTrigger aria-label="延迟时间范围" className={cn("h-8 w-24 shrink-0 text-xs", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
