import { Gauge, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCompactLayout } from "@/hooks/useCompactLayout";
import { toast } from "sonner";
import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * 设置 › 进阶 › 流量用尽时的处理（#18）。
 *
 * 两种都会先停掉这个人的规则、拒绝新连接；差别只在已经连着的那些。说明文字照实写：
 * 进程类转发（realm / gost / ForwardX）停进程就一定断，「允许跑完」只对内核转发成立。
 * 细节见 server/ops/quotaPolicy.ts。
 */

type Mode = "cut" | "drain";

const OPTIONS: Array<{ value: Mode; label: string; hint: string }> = [
  {
    value: "cut",
    label: "立即断开",
    hint: "规则马上停下，已经连着的连接一起断开。iptables / nftables 转发上的连接由 Agent 用 conntrack 清掉，这部分需要 Agent 2.2.216 以上、机器上装了 conntrack。",
  },
  {
    value: "drain",
    label: "允许跑完",
    hint: "新连接一律拒绝；iptables / nftables 转发上已经连着的跑到自然断开为止，这段流量不再计入用量。realm、gost、ForwardX 等进程类转发停规则就要停进程，仍会立即断开。",
  },
];

export default function QuotaModeSection(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const compactLayout = useCompactLayout();
  const upgradeMany = trpc.hosts.requestAgentUpgradeMany.useMutation({
    onSuccess: (data: any) => {
      void utils.ops.quotaPolicy.get.invalidate();
      void utils.hosts.list.invalidate();
      const skipped = Number(data?.skippedOffline || 0);
      toast.success(`已安排 ${data?.requested || 0} 台升级${skipped ? `，${skipped} 台离线没发` : ""}`);
    },
    onError: (error) => toast.error(error.message || "升级没发出去"),
  });
  const query = trpc.ops.quotaPolicy.get.useQuery(undefined, { refetchOnWindowFocus: false });
  const setMode = trpc.ops.quotaPolicy.set.useMutation({
    onSuccess: () => {
      toast.success("已保存");
      void utils.ops.quotaPolicy.get.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  if (query.isLoading) return <DataSectionLoading />;
  if (query.error) return <DataSectionError label="流量用尽处理" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;

  const data = query.data!;
  const current = (setMode.isPending && setMode.variables?.mode) || data.mode;
  const active = OPTIONS.find((option) => option.value === current) || OPTIONS[0];
  const outdated = data.outdatedHosts || [];
  const noConntrack = data.noConntrackHosts || [];
  const names = (list: string[]) => `${list.slice(0, 3).join("、")}${list.length > 3 ? ` 等 ${list.length} 台` : ""}`;

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4 text-primary" />
          流量用尽时
        </CardTitle>
        <CardDescription>用户流量用完后，他名下的规则都会停下、新连接被拒；这里决定已经连着的怎么办。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className={cn(segmentedControlClassName, "grid grid-cols-2 gap-1")} role="radiogroup" aria-label="流量用尽时的处理">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={current === option.value}
              disabled={setMode.isPending}
              onClick={() => {
                if (current !== option.value) setMode.mutate({ mode: option.value });
              }}
              className={segmentedOptionClassName(current === option.value, setMode.isPending)}
            >
              {setMode.isPending && setMode.variables?.mode === option.value ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {option.label}
            </button>
          ))}
        </div>
        {compactLayout ? null : <p className="text-meta text-muted-foreground">{active.hint}</p>}
        {compactLayout && current === "cut" && (outdated.length > 0 || noConntrack.length > 0) ? (
          /* 精简布局：两段长提示合成一行，原因不细说，直接给按钮。 */
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[13px] text-[var(--fx-warn-text)]" title={[...outdated, ...noConntrack].join("、")}>
              {(data.upgradeHostIds || []).length || outdated.length + noConntrack.length} 台主机需要升级
            </p>
            <Button
              size="sm"
              className="shrink-0"
              disabled={upgradeMany.isPending || !(data.upgradeHostIds || []).length}
              onClick={() => upgradeMany.mutate({ hostIds: data.upgradeHostIds })}
            >
              {upgradeMany.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              一键升级
            </Button>
          </div>
        ) : null}
        {!compactLayout && current === "cut" && outdated.length > 0 ? (
          <p className="text-meta text-[var(--fx-warn-text)]">
            {names(outdated)} 的 Agent 低于 2.2.216，这几台上的 iptables / nftables 连接不会被清掉，需要把 Agent 升级到 2.2.216。
          </p>
        ) : null}
        {!compactLayout && current === "cut" && noConntrack.length > 0 ? (
          <p className="text-meta text-[var(--fx-warn-text)]">
            {names(noConntrack)} 没有装 conntrack，这几台上的 iptables / nftables 连接不会被清掉。把 Agent 升级到最新会自动装上。
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
