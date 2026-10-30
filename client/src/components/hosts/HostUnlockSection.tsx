import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { UNLOCK_STATUS_LABELS, type UnlockFamily, type UnlockStatus } from "@shared/unlockCheck";
import { ExitHostPanel } from "@/components/proxy/ExitQualityView";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { CollapsibleSection, Row } from "./HostDetailDialog";

/*
  主机详情里「流媒体 / AI 解锁」一节（Agent 2.2.226 起）：默认折叠，展开是和订阅页节点菜单「出口检测」
  同一副面板（ExitHostPanel：站点连通四格 + 解锁网格，hosts.exitQuality），下面只有两个按钮：
  按 IPv4 / IPv6 出口手动检测一次（只给管理员）。不定期跑 —— 每一次都要从主机去请求十来个第三方站点。

  结果是 Agent 从这台机器的出口去打开各服务的页面、按页面标记猜出来的（agent/unlock_check.go），
  每一项只有四种结论，绿 / 黄 / 红 / 灰；拿不准的就是灰的「无法判断」，不硬说可用。
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

const MANUAL_FAMILIES: { family: UnlockFamily; label: string }[] = [
  { family: "ipv4", label: "检测 IPv4" },
  { family: "ipv6", label: "检测 IPv6" },
];

export default function HostUnlockSection({ hostId }: { hostId: number }) {
  if (!(hostId > 0)) return null;
  return (
    <CollapsibleSection title="流媒体 / AI 解锁">
      <HostUnlockBody hostId={hostId} />
    </CollapsibleSection>
  );
}

function HostUnlockBody({ hostId }: { hostId: number }) {
  const utils = trpc.useUtils();
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

  // 检测跑完那一刻刷新一下主机列表和面板，卡片上的摘要跟着变。
  const lastPending = useRef(0);
  useEffect(() => {
    if (lastPending.current > 0 && pendingCount === 0) {
      void utils.hosts.listPage.invalidate();
      void utils.hosts.exitQuality.invalidate({ hostId });
    }
    lastPending.current = pendingCount;
  }, [pendingCount, utils, hostId]);

  const data = status.data;
  return (
    <>
      {data && !data.supported ? (
        <Row label="解锁检测" value={<span className="text-[var(--fx-warn-text)]">需要升级 Agent（{data.minAgentVersion} 起）</span>} />
      ) : null}

      {quality.data ? (
        <ExitHostPanel host={quality.data.host} targets={quality.data.targets} />
      ) : (
        <p className="text-meta text-muted-foreground">{quality.isLoading ? "读取中…" : "读取失败"}</p>
      )}

      {data?.canManage ? (
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {MANUAL_FAMILIES.map(({ family, label }) => {
            const pending = data.pending.find((item) => item.family === family) || null;
            return (
              <Button
                key={family}
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs"
                disabled={!data.supported || !data.online || !!pending || start.isPending}
                title={!data.supported ? "需要升级 Agent" : !data.online ? "主机离线" : "从这台主机按这个出口去各服务测一轮"}
                onClick={() => start.mutate({ hostId, family })}
              >
                {pending ? "检测中…" : label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
