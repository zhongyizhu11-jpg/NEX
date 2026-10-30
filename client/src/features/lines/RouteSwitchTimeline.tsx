import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { describeRouteReason, normalizeRouteEventKind } from "@shared/routeGroup";
import type { RouteEvent, RouteStatus } from "@/features/rules/RouteGroupSheet";
import { lineLongName, routeLineGroups } from "@/features/rules/RouteLineOverview";

/*
  切换记录（2.3.496，效果图 ③ 下半截）：一条竖线，一个点一件事。

    19:36:12 · 自动   切回 主线路          主线路恢复后稳定 3 分钟
    19:31:05 · 自动   主线路 → 备 1        中转异常：Jinx 落地拨号成功率 71%
    18:02:40 · 手动   暂停 备 2            手动暂停这条线路
    17:10:03 · 自动   整链最优换到 主线路   线路评分更优

  点的颜色：切回 / 换到更好的绿，出问题切走红，人工的强调色。
*/

const SHOWN_KINDS = new Set(["switch", "pinned", "unpinned", "precheck_failed", "flap_hold"]);

type TimelineEntry = { key: string; at: number; manual: boolean; tone: "ok" | "down" | "acc"; title: ReactNode; detail: string };

function clock(ms: number, timeZone?: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone }).format(new Date(ms));
  } catch {
    return new Date(ms).toTimeString().slice(0, 8);
  }
}

function dayLabel(ms: number, nowMs: number, timeZone?: string) {
  try {
    const format = (value: number) => new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", timeZone }).format(new Date(value));
    const day = format(ms);
    if (day === format(nowMs)) return "";
    if (day === format(nowMs - 86400_000)) return "昨天 ";
    return `${day} `;
  } catch {
    return "";
  }
}

function duration(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.round(seconds / 60)} 分钟`;
}

export function routeSwitchEntries(events: RouteEvent[], status: RouteStatus | null, nowMs: number): TimelineEntry[] {
  const groups = status ? routeLineGroups(status) : [];
  const nameOf = (key: string | null, label: string | null) => {
    if (key) {
      const group = groups.find((item) => item.key === key || item.paths.some((path) => path.key === key));
      if (group) return lineLongName(group.index);
    }
    return label || "另一条";
  };
  const indexOf = (key: string | null) => {
    if (!key) return -1;
    const group = groups.find((item) => item.key === key || item.paths.some((path) => path.key === key));
    return group ? group.index : -1;
  };
  const recover = Number(status?.policy.recoverSeconds || 0);
  return events
    .filter((event) => SHOWN_KINDS.has(String(event.kind)) && nowMs - event.at <= 7 * 86400_000)
    .sort((a, b) => b.at - a.at)
    .map((event): TimelineEntry => {
      const kind = normalizeRouteEventKind(event.kind);
      const reason = String(event.reason || "");
      const lower = reason.toLowerCase();
      const manual = kind === "pinned" || kind === "unpinned" || /^panel:|^pin\b/.test(lower);
      const to = nameOf(event.toKey, event.toLabel);
      const from = nameOf(event.fromKey, event.fromLabel);
      const base = { key: `${event.id}`, at: event.at, manual };
      if (kind === "pinned" || kind === "unpinned") {
        if (reason.includes("暂停这条线路")) return { ...base, tone: "acc", title: <>暂停 <b>{to}</b></>, detail: describeRouteReason(reason) };
        if (reason.includes("恢复这条线路")) return { ...base, tone: "ok", title: <>恢复 <b>{to}</b></>, detail: describeRouteReason(reason) };
        if (kind === "unpinned") return { ...base, tone: "acc", title: <>交回自动</>, detail: describeRouteReason(reason) };
        return { ...base, tone: "acc", title: <>人工指定 <b>{to}</b></>, detail: describeRouteReason(reason) };
      }
      if (kind === "precheck_failed") return { ...base, tone: "down", title: <>计划切换没执行</>, detail: `${describeRouteReason(reason)} · 继续走 ${from}` };
      if (kind === "flap_hold") return { ...base, tone: "down", title: <>暂停自动切换</>, detail: describeRouteReason(reason) };
      // switch
      if (lower === "failback" || (indexOf(event.toKey) === 0 && indexOf(event.fromKey) > 0 && /recovered/.test(lower))) {
        return { ...base, tone: "ok", title: <>切回 <b>{to}</b></>, detail: recover > 0 ? `${to}恢复后稳定 ${duration(recover)}` : describeRouteReason(reason) };
      }
      if (lower === "score") {
        const better = event.fromKey || event.fromLabel ? `比 ${from} 更优` : describeRouteReason(reason);
        return { ...base, tone: "ok", title: <>整链最优换到 <b>{to}</b></>, detail: `${better}${event.latencyMs ? `，换过去 ${event.latencyMs} ms` : ""}` };
      }
      if (lower === "schedule") return { ...base, tone: "acc", title: <>按时段换到 <b>{to}</b></>, detail: describeRouteReason(reason) };
      const failure = /health check|dial failed|relay down|maintenance|breaker|node offline|paused/.test(lower);
      return { ...base, tone: failure ? "down" : manual ? "acc" : "ok", title: <>{from} → <b>{to}</b></>, detail: describeRouteReason(reason) };
    });
}

const DOT: Record<TimelineEntry["tone"], string> = {
  ok: "before:bg-[var(--fx-healthy-text)]",
  down: "before:bg-[var(--fx-down-text)]",
  acc: "before:bg-[var(--fx-accent)]",
};

export function RouteSwitchTimeline({ events, status, nowMs, timeZone, limit = 12 }: { events: RouteEvent[]; status: RouteStatus | null; nowMs?: number; timeZone?: string; limit?: number }) {
  const now = nowMs ?? Date.now();
  const entries = routeSwitchEntries(events, status, now).slice(0, limit);
  if (entries.length === 0) return <p className="text-[12.5px] text-muted-foreground">近 7 天没切过。</p>;
  return (
    <div className="relative pl-4 text-[12.5px] before:absolute before:bottom-1 before:left-1 before:top-1 before:w-0.5 before:bg-[var(--fx-stroke-weak)]" data-testid="route-switch-timeline">
      {entries.map((entry, index) => (
        <div key={entry.key} className={cn("relative before:absolute before:-left-[15px] before:top-[5px] before:h-2 before:w-2 before:rounded-full", DOT[entry.tone], index < entries.length - 1 && "mb-[11px]")}>
          <div className="font-mono text-[11px] text-muted-foreground">{dayLabel(entry.at, now, timeZone)}{clock(entry.at, timeZone)} · {entry.manual ? "手动" : "自动"}</div>
          <div>{entry.title}</div>
          {entry.detail ? <div className="mt-0.5 text-[11.5px] text-muted-foreground">{entry.detail}</div> : null}
        </div>
      ))}
    </div>
  );
}
