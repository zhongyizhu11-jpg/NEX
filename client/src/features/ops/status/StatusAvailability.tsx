import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { cn } from "@/lib/utils";

/**
 * 公开监控页上方的可用率、每日条和最近断线（#1）。
 *
 * 数据来自 trpc.ops.statusAvailability.public：服务端每分钟采一次主机在线状态，攒成每日表和
 * 断线事件（功能刚上线时用 host_metrics 回填前 72 小时）。这一块和下面的实时卡片是两种节奏：
 * 实时卡片 3 秒一刷，这里 30 秒一刷就够 —— 可用率一分钟才变一次。
 */

type DayCell = {
  day: string;
  observedSeconds: number;
  downSeconds: number;
  hostsAffected: number;
  state: "none" | "up" | "partial" | "major";
};

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  // 向下取两位：有过断线就不能显示成 100%。
  const floored = Math.floor(value * 10000) / 100;
  return `${floored.toFixed(2).replace(/\.?0+$/, "")}%`;
}

function formatDowntime(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return "不到 1 分钟";
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

function dayLabel(day: string) {
  const [, month, date] = day.split("-").map(Number);
  return month && date ? `${month}月${date}日` : day;
}

function cellText(cell: DayCell) {
  if (cell.state === "none") return `${dayLabel(cell.day)} · 没有数据`;
  if (cell.state === "up") return `${dayLabel(cell.day)} · 全天正常`;
  const who = cell.hostsAffected > 1 ? `${cell.hostsAffected} 台累计` : "";
  return `${dayLabel(cell.day)} · ${who}断线 ${formatDowntime(cell.downSeconds)}`;
}

const CELL_CLASS: Record<DayCell["state"], string> = {
  none: "bg-[var(--fx-l3-control-fill)]",
  up: "bg-[var(--fx-healthy)]",
  partial: "bg-[var(--fx-warn)]",
  major: "bg-[var(--fx-down)]",
};

function formatClock(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // 统一按北京时间显示，和每日条的切日一致。
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("month")}月${get("day")}日 ${get("hour")}:${get("minute")}`;
}

/** 「10月4日 14:20 → 14:55」；跨天时结束也写日期；还没恢复写「未恢复」。 */
function incidentSpan(startedAt: string, endedAt: string | null) {
  const start = formatClock(startedAt);
  if (!endedAt) return `${start} · 未恢复`;
  const end = formatClock(endedAt);
  const [startDay] = start.split(" ");
  const [endDay, endTime] = end.split(" ");
  return `${start} → ${startDay === endDay ? endTime : end}`;
}

export default function StatusAvailability({ path }: { path?: string }) {
  const query = trpc.ops.statusAvailability.public.useQuery(
    { path },
    { retry: false, refetchOnWindowFocus: false, refetchInterval: pollingInterval("slow") },
  );
  const data = query.data as any;
  const days = (data?.days || []) as DayCell[];
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const selected = useMemo(
    () => days.find((cell) => cell.day === selectedDay) || null,
    [days, selectedDay],
  );

  // 接口失败（开关关了、路径不对）时下面那一大块本来就会报错，这里安静地不画。
  if (!data) return null;
  if (Number(data.totalHosts || 0) === 0) return null;

  const offline = Number(data.offlineHosts || 0);
  const total = Number(data.totalHosts || 0);
  const tone = offline === 0 ? "healthy" : offline >= total ? "down" : "warn";
  const statusText = offline === 0
    ? "全部主机运行正常"
    : offline >= total
      ? "全部主机离线"
      : `${offline} 台主机离线`;
  const offlineNames = (data.offlineHostNames || []) as string[];
  const incidents = (data.incidents || []) as Array<{ hostName: string; startedAt: string; endedAt: string | null; durationSeconds: number }>;

  return (
    <Card>
      <CardContent className="space-y-3 p-3 sm:p-4">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              tone === "healthy" ? "bg-[var(--fx-healthy)]" : tone === "warn" ? "bg-[var(--fx-warn)]" : "bg-[var(--fx-down)]",
            )}
          />
          <span
            className={cn(
              "shrink-0 text-sm font-medium",
              tone === "healthy" ? "text-[var(--fx-healthy-text)]" : tone === "warn" ? "text-[var(--fx-warn-text)]" : "text-[var(--fx-down-text)]",
            )}
          >
            {statusText}
          </span>
          {offline > 0 && offlineNames.length > 0 ? (
            <span className="min-w-0 truncate text-meta text-muted-foreground">
              {offlineNames.join("、")}{offline > offlineNames.length ? " 等" : ""}
            </span>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <p className="text-meta text-muted-foreground">近 24 小时可用率</p>
            <p className="truncate text-2xl font-semibold tabular-nums tracking-tight">{formatPercent(data.availability24h)}</p>
          </div>
          <div className="min-w-0 border-l border-[var(--fx-stroke-weak)] pl-3">
            <p className="text-meta text-muted-foreground">近 30 天可用率</p>
            <p className="truncate text-2xl font-semibold tabular-nums tracking-tight">{formatPercent(data.availability30d)}</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex h-7 items-stretch gap-[2px]" role="list" aria-label="近 30 天每日可用情况">
            {days.map((cell) => (
              <button
                key={cell.day}
                type="button"
                role="listitem"
                title={cellText(cell)}
                aria-label={cellText(cell)}
                // 手机上没有悬停：点一格，下面那行说这一天。
                onClick={() => setSelectedDay((current) => (current === cell.day ? null : cell.day))}
                className={cn(
                  "min-w-0 flex-1 rounded-[2px] transition-opacity",
                  CELL_CLASS[cell.state],
                  selectedDay && selectedDay !== cell.day && "opacity-50",
                )}
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 text-meta text-muted-foreground">
            {selected ? (
              <span className="truncate text-foreground">{cellText(selected)}</span>
            ) : (
              <>
                <span>30 天前</span>
                <span className="hidden truncate sm:inline">点一格看那天断了多久</span>
                <span>今天</span>
              </>
            )}
          </div>
        </div>

        {incidents.length > 0 ? (
          <div className="space-y-1 border-t border-[var(--fx-stroke-weak)] pt-2">
            <p className="text-meta text-muted-foreground">最近断线</p>
            <ul className="space-y-1">
              {incidents.map((incident, index) => (
                <li key={`${incident.startedAt}-${index}`} className="flex min-w-0 items-baseline gap-2 text-[13px]">
                  <span className="min-w-0 truncate font-medium">{incident.hostName || "主机"}</span>
                  <span className={cn("shrink-0", incident.endedAt ? "text-muted-foreground" : "text-[var(--fx-down-text)]")}>
                    {incident.endedAt ? `断线 ${formatDowntime(incident.durationSeconds)}` : `已断 ${formatDowntime(incident.durationSeconds)}`}
                  </span>
                  <span className="ml-auto shrink-0 text-meta tabular-nums text-muted-foreground">
                    {incidentSpan(incident.startedAt, incident.endedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
