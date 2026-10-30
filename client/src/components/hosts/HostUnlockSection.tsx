import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { formatAgo } from "@shared/dashboardAttention";
import {
  UNLOCK_FAMILIES,
  UNLOCK_FAMILY_LABELS,
  UNLOCK_SCHEDULES,
  UNLOCK_SCHEDULE_LABELS,
  UNLOCK_SERVICES,
  UNLOCK_STATUS_LABELS,
  unlockChipText,
  unlockServiceDef,
  type UnlockFamily,
  type UnlockServiceResult,
  type UnlockStatus,
} from "@shared/unlockCheck";
import { ExitHostPanel } from "@/components/proxy/ExitQualityView";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Row, Section } from "./HostDetailDialog";

/*
  主机详情里「出口检测」一节：这台机器出去以后到百度 / Google / GitHub / OpenAI 连不连得上
  （站点连通四格，Agent 2.2.237 起每 2 分钟一轮），解锁了什么（流媒体 / AI，Agent 2.2.226 起）。
  画法和订阅页节点菜单里的「出口检测」同一副（ExitHostPanel），数据也是同一个口径（hosts.exitQuality）。

  解锁结果是 Agent 从这台机器的出口去打开各服务的页面、按页面标记猜出来的（agent/unlock_check.go），
  每一项只有四种结论，绿 / 黄 / 红 / 灰；拿不准的就是灰的「无法判断」，不硬说可用。
  默认不定期跑：每一次都要请求十来个第三方站点。管理员点「检测解锁」才跑，或者开计划检测。
  普通用户能看到自己能用的主机的结果，看不到按钮和计划设置。
*/

const STATUS_TONE: Record<UnlockStatus, string> = {
  ok: "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)] border-transparent",
  partial: "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)] border-transparent",
  blocked: "bg-[var(--fx-down-soft)] text-[var(--fx-down-text)] border-transparent",
  unknown: "border-[var(--fx-stroke-base)] text-[var(--fx-text-secondary)]",
};

export function UnlockStatusBadge({ status, className }: { status: UnlockStatus; className?: string }) {
  return (
    <span
      data-status={status}
      className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-4", STATUS_TONE[status], className)}
    >
      {UNLOCK_STATUS_LABELS[status]}
    </span>
  );
}

function agoText(checkedAt: number) {
  if (!checkedAt) return "—";
  return formatAgo(Date.now() - checkedAt * 1000);
}

function fullTime(checkedAt: number) {
  return checkedAt ? new Date(checkedAt * 1000).toLocaleString("zh-CN", { hour12: false }) : "—";
}

/** 历史弹窗里一次检测的各项：名字 + 徽标 + 地区，说明另起一行（窄屏上不挤）。 */
function UnlockResultList({ results }: { results: UnlockServiceResult[] }) {
  const byId = new Map(results.map((item) => [item.service, item]));
  const rows = UNLOCK_SERVICES.map((def) => byId.get(def.id)).filter((item): item is UnlockServiceResult => !!item);
  return (
    <ul className="flex min-w-0 flex-col divide-y divide-[var(--fx-stroke-weak)]" aria-label="各服务的检测结果">
      {rows.map((item) => (
        <li key={item.service} className="flex min-w-0 flex-col gap-0.5 py-1.5 first:pt-0 last:pb-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-secondary-type font-medium text-foreground">{unlockServiceDef(item.service)?.name || item.service}</span>
            {item.region ? <span className="shrink-0 font-mono text-meta tabular-nums text-muted-foreground">{item.region}</span> : null}
            <UnlockStatusBadge status={item.status} />
          </div>
          {item.detail ? <p className="min-w-0 break-words text-meta text-muted-foreground">{item.detail}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function HistoryDialog({ hostId, open, onOpenChange }: { hostId: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const history = trpc.hosts.unlockHistory.useQuery({ hostId }, { enabled: open && hostId > 0 });
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>解锁检测历史</DialogTitle>
          <DialogDescription>每台主机保留最近 10 次。</DialogDescription>
        </DialogHeader>
        {!history.data ? (
          <p className="text-meta text-muted-foreground">{history.isLoading ? "读取中…" : "读取失败"}</p>
        ) : history.data.length === 0 ? (
          <p className="text-meta text-muted-foreground">还没有检测过。</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2">
            {history.data.map((run) => {
              const isOpen = expanded === run.runId;
              return (
                <li key={run.runId} className="min-w-0 rounded-md border border-[var(--fx-stroke-weak)] px-3 py-2">
                  <button
                    type="button"
                    className="flex w-full min-w-0 flex-col items-start gap-0.5 text-left"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? null : run.runId)}
                  >
                    <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
                      <span className="text-secondary-type font-medium tabular-nums text-foreground">{fullTime(run.checkedAt)}</span>
                      <span className="shrink-0 text-meta text-muted-foreground">
                        {UNLOCK_FAMILY_LABELS[run.family]} · {run.trigger === "schedule" ? "计划" : "手动"}
                      </span>
                    </span>
                    <span className="min-w-0 max-w-full truncate text-meta text-muted-foreground">{unlockChipText(run.results) || `${run.results.length} 项`}</span>
                  </button>
                  {isOpen ? <div className="mt-2 border-t border-[var(--fx-stroke-weak)] pt-2"><UnlockResultList results={run.results} /></div> : null}
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function HostUnlockSection({ hostId }: { hostId: number }) {
  if (!(hostId > 0)) return null;
  return <HostUnlockBody hostId={hostId} />;
}

function HostUnlockBody({ hostId }: { hostId: number }) {
  const utils = trpc.useUtils();
  const [family, setFamily] = useState<UnlockFamily>("auto");
  const [historyOpen, setHistoryOpen] = useState(false);
  const status = trpc.hosts.unlockStatus.useQuery(
    { hostId },
    {
      enabled: hostId > 0,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      // 有检测在跑就每 3 秒看一次，一般十几秒内出结果。
      refetchInterval: (query) => ((query.state.data?.pending.length ?? 0) > 0 ? 3_000 : false),
    },
  );
  const pendingCount = status.data?.pending.length ?? 0;
  const quality = trpc.hosts.exitQuality.useQuery(
    { hostId },
    { enabled: hostId > 0, staleTime: 10_000, refetchOnWindowFocus: false, refetchInterval: pendingCount > 0 ? 3_000 : 60_000 },
  );
  const start = trpc.hosts.startUnlockCheck.useMutation({
    onSuccess: () => void utils.hosts.unlockStatus.invalidate({ hostId }),
    onError: (error) => toast.error(error.message),
  });
  const setSchedule = trpc.hosts.setUnlockSchedule.useMutation({
    onSuccess: (data) => {
      toast.success(data.schedule === "off" ? "已关闭计划检测" : `计划检测：${UNLOCK_SCHEDULE_LABELS[data.schedule]}一次`);
      void utils.hosts.unlockStatus.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  // 检测跑完那一刻刷新一下主机列表和出口面板，卡片上的摘要跟着变。
  const lastPending = useRef(0);
  useEffect(() => {
    if (lastPending.current > 0 && pendingCount === 0) {
      void utils.hosts.listPage.invalidate();
      void utils.hosts.exitQuality.invalidate({ hostId });
    }
    lastPending.current = pendingCount;
  }, [pendingCount, utils, hostId]);

  const data = status.data;
  const pending = data?.pending[0] || null;
  const latest = data?.latest[0] || null;
  const checkButton = data?.canManage ? (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2.5 text-xs"
      disabled={!data.supported || !data.online || !!pending || start.isPending}
      title={!data.supported ? "需要升级 Agent" : !data.online ? "主机离线" : undefined}
      onClick={() => start.mutate({ hostId, family })}
    >
      {pending ? "检测中…" : family === "auto" ? "检测解锁" : `检测解锁（${UNLOCK_FAMILY_LABELS[family]}）`}
    </Button>
  ) : null;

  return (
    <Section title="出口检测" action={checkButton}>
      {data && !data.supported ? (
        <Row label="解锁检测" value={<span className="text-[var(--fx-warn-text)]">需要升级 Agent（{data.minAgentVersion} 起）</span>} />
      ) : null}

      {quality.data ? (
        <ExitHostPanel host={quality.data.host} targets={quality.data.targets} />
      ) : (
        <p className="text-meta text-muted-foreground">{quality.isLoading ? "读取中…" : "读取失败"}</p>
      )}

      <Row
        label="最近检测"
        value={!data
          ? (status.isLoading ? "读取中…" : "读取失败")
          : pending
            ? "检测中…"
            : latest
              ? <span title={fullTime(latest.checkedAt)}>{agoText(latest.checkedAt)} · {UNLOCK_FAMILY_LABELS[latest.family]} · {latest.trigger === "schedule" ? "计划" : "手动"}</span>
              : "还没有检测过"}
      />

      {data?.canManage ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="text-meta text-muted-foreground">检测用的出口</span>
          <div className={cn(segmentedControlClassName, "flex")} role="radiogroup" aria-label="检测用的出口">
            {UNLOCK_FAMILIES.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={family === value}
                className={segmentedOptionClassName(family === value, false, "h-7 px-2.5 text-[12.5px]")}
                onClick={() => setFamily(value)}
              >
                {UNLOCK_FAMILY_LABELS[value]}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {data?.canManage && data.schedule ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="text-meta text-muted-foreground">计划检测（所有主机）</span>
          <div className={cn(segmentedControlClassName, "flex")} role="radiogroup" aria-label="计划检测">
            {UNLOCK_SCHEDULES.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={data.schedule === value}
                disabled={setSchedule.isPending}
                className={segmentedOptionClassName(data.schedule === value, setSchedule.isPending, "h-7 px-2.5 text-[12.5px]")}
                onClick={() => data.schedule !== value && setSchedule.mutate({ schedule: value })}
              >
                {UNLOCK_SCHEDULE_LABELS[value]}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <p data-fx-help="" className="text-meta text-muted-foreground">
          站点连通每 2 分钟一轮，只握手不发请求；解锁按各服务页面上的标记推断，服务改版后可能不准。
        </p>
        <button type="button" className="ml-auto shrink-0 text-meta font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" disabled={!data || data.latest.length === 0} onClick={() => setHistoryOpen(true)}>
          历史
        </button>
      </div>

      <HistoryDialog hostId={hostId} open={historyOpen} onOpenChange={setHistoryOpen} />
    </Section>
  );
}
