import { UNLOCK_FAMILY_LABELS, UNLOCK_STATUS_LABELS, unlockServiceDef, type UnlockChipItem, type UnlockFamily } from "@shared/unlockCheck";

/*
  主机卡上的解锁摘要：「NF 全解 · GPT ✓ · Claude ✗」，颜色跟结论走。
  只在测过的主机上出现（服务端 listPage 带 unlockSummary）；只挑最常被问的几项，全部的进详情看。
*/
const TONE: Record<UnlockChipItem["status"], string> = {
  ok: "text-[var(--fx-healthy-text)]",
  partial: "text-[var(--fx-warn-text)]",
  blocked: "text-[var(--fx-down-text)]",
  unknown: "text-muted-foreground",
};

export type HostUnlockSummary = { family: UnlockFamily; checkedAt: number; items: UnlockChipItem[] };

export function hostUnlockChipTitle(summary: HostUnlockSummary) {
  const when = summary.checkedAt ? new Date(summary.checkedAt * 1000).toLocaleString("zh-CN", { hour12: false }) : "";
  const lines = summary.items.map((item) => `${unlockServiceDef(item.service)?.name || item.service}：${UNLOCK_STATUS_LABELS[item.status]}`);
  return [`流媒体 / AI 解锁（${UNLOCK_FAMILY_LABELS[summary.family]}${when ? ` · ${when}` : ""}）`, ...lines].join("\n");
}

export default function HostUnlockChip({ summary }: { summary: HostUnlockSummary | null | undefined }) {
  if (!summary || !Array.isArray(summary.items) || summary.items.length === 0) return null;
  return (
    <div className="fx-host-unlock flex min-w-0 items-center gap-1.5 truncate text-[12px] leading-4 tabular-nums" title={hostUnlockChipTitle(summary)} data-testid="host-unlock-chip">
      {summary.items.map((item, index) => (
        <span key={item.service} className="inline-flex shrink-0 items-center gap-1.5">
          {index > 0 ? <span aria-hidden="true" className="text-muted-foreground">·</span> : null}
          <span className={TONE[item.status]}>{item.text}</span>
        </span>
      ))}
    </div>
  );
}
