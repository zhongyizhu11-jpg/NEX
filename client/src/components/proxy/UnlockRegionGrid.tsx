import { useState } from "react";

import {
  UNLOCK_EXTENDED_AGENT_VERSION,
  UNLOCK_SERVICES,
  unlockDisplayLabel,
  unlockRegionText,
  unlockRegionTone,
  unlockServiceSupported,
  type UnlockRegionTone,
  type UnlockStatus,
} from "@shared/unlockCheck";
import { cn } from "@/lib/utils";

/*
  解锁结果的网格（主机详情「流媒体 / AI 解锁」和订阅页「出口检测」共用）：
  每一项写「解锁 / 仅自制 / 部分解锁 / 屏蔽 / 检测失败」+ 地区；地区和主机所在地比，一致绿、跨区橙、
  不在中国的机器被认成 CN 红（shared/unlockCheck.ts 的 unlockRegionTone）。
  双栈主机 IPv4、IPv6 分开测，各一页；只有一份结果时不出页签。
*/

export type UnlockGridResult = { service: string; name: string; status: string; region: string | null; detail?: string | null };
export type UnlockGridFamily = { family: string; checkedAt: number; results: UnlockGridResult[] };

const STATUS_COLOR: Record<string, string> = {
  ok: "var(--fx-healthy-text)",
  partial: "var(--fx-warn-text)",
  blocked: "var(--fx-down-text)",
};

const REGION_CLASS: Record<UnlockRegionTone, string> = {
  match: "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]",
  mismatch: "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]",
  china: "bg-[var(--fx-down-soft)] text-[var(--fx-down-text)]",
  none: "border border-[var(--fx-stroke-base)] text-muted-foreground",
};

const REGION_TITLE: Record<UnlockRegionTone, string> = {
  match: "和主机所在地一致",
  mismatch: "和主机所在地不一致（跨区）",
  china: "被认成中国大陆",
  none: "",
};

const FAMILY_LABELS: Record<string, string> = { ipv4: "IPv4", ipv6: "IPv6", auto: "自动" };
const FAMILY_ORDER: Record<string, number> = { ipv4: 0, ipv6: 1, auto: 2 };

function formatCheckedAt(value: number) {
  if (!value) return "";
  // 检测时间存的是秒（host_unlock_checks.checkedAt）；万一传进来的是毫秒也认
  const date = new Date(value < 1e12 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

export function UnlockRegionGrid({ families, hostCountry, agentVersion }: { families: UnlockGridFamily[]; hostCountry: string | null; agentVersion?: string | null }) {
  const sorted = [...families].sort((a, b) => (FAMILY_ORDER[a.family] ?? 9) - (FAMILY_ORDER[b.family] ?? 9));
  const [picked, setPicked] = useState<string | null>(null);
  const active = sorted.find((item) => item.family === picked) || sorted[0] || null;
  if (!active) return null;
  const tested = new Set(active.results.map((item) => item.service));
  // 新加的几项老 Agent 测不了：明说要升级，不当成「检测失败」
  const needUpgrade = agentVersion !== undefined
    ? UNLOCK_SERVICES.filter((def) => !tested.has(def.id) && def.sinceAgent && !unlockServiceSupported(def, agentVersion)).map((def) => def.name)
    : [];
  return (
    <div className="space-y-1.5" data-testid="unlock-region-grid">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {sorted.length > 1
            ? sorted.map((item) => (
              <button
                key={item.family}
                type="button"
                aria-pressed={active.family === item.family}
                className={cn("fx-chip", active.family === item.family && "fx-chip-on")}
                onClick={() => setPicked(item.family)}
              >
                {FAMILY_LABELS[item.family] || item.family}
              </button>
            ))
            : null}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {formatCheckedAt(active.checkedAt)} 检测{sorted.length === 1 && active.family !== "auto" ? ` · ${FAMILY_LABELS[active.family] || active.family}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" data-testid="exit-unlock">
        {active.results.map((item) => {
          const status = item.status as UnlockStatus;
          const regionText = unlockRegionText(item.service, item.region);
          const tone = unlockRegionTone(item.service, item.region, hostCountry);
          return (
            <div key={item.service} className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-[var(--fx-l2-group)] px-2.5 py-1.5 text-xs" title={item.detail || undefined}>
              <span className="truncate">{item.name}</span>
              <span className="flex shrink-0 items-center gap-1">
                <span style={{ color: STATUS_COLOR[item.status] || "var(--fx-text-muted)" }}>{unlockDisplayLabel(item.service, status)}</span>
                {regionText ? (
                  <span className={cn("rounded-full px-1.5 text-[10.5px] leading-4", REGION_CLASS[tone])} title={REGION_TITLE[tone] || undefined} data-region-tone={tone}>{regionText}</span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      {needUpgrade.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">{needUpgrade.join("、")} 要 Agent {UNLOCK_EXTENDED_AGENT_VERSION} 起才测得了。</p>
      ) : null}
      {hostCountry ? <p className="text-[11px] text-muted-foreground">地区颜色：和主机所在地（{hostCountry}）一致为绿，跨区为橙，被认成中国大陆为红。</p> : null}
    </div>
  );
}
