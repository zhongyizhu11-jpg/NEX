import { Link } from "wouter";
import { toast } from "sonner";
import { formatAgo } from "@shared/dashboardAttention";
import { Section, Row } from "@/components/hosts/HostDetailDialog";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { trpc } from "@/lib/trpc";
import { SeverityBadge, type Severity } from "./securityParts";

/*
  主机详情里的「安全」一节（#3）：待处理的发现按级别各几条、最近一次巡检、基线，
  一个链接去「监控 › 安全巡检」并按这台主机筛。只给管理员（插槽那边判断过）。
*/
const ORDER: Severity[] = ["critical", "high", "medium", "low"];

export default function HostSecuritySection({ host }: { host: any }) {
  const hostId = Number(host?.id);
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const summary = trpc.ops.hostSecurity.hostSummary.useQuery({ hostId }, { enabled: hostId > 0, staleTime: 15_000 });
  const rebaseline = trpc.ops.hostSecurity.rebaseline.useMutation({
    onSuccess: () => { toast.success("Agent 下一轮会重新记下这台机器的现状"); void utils.ops.hostSecurity.hostSummary.invalidate({ hostId }); },
    onError: (error) => toast.error(error.message),
  });
  if (!(hostId > 0)) return null;
  const data = summary.data;

  const rebaselineButton = data?.supported ? (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2.5 text-xs"
      disabled={rebaseline.isPending}
      onClick={async () => {
        const ok = await confirm({
          title: "重新建立基线？",
          description: "Agent 会把这台机器现在的端口、账号、钥匙、定时任务等都当作正常的记下来，之后只提醒新的变化。已有的发现不会删除。",
          confirmText: "重新建立",
        });
        if (ok) rebaseline.mutate({ hostId });
      }}
    >
      重新建立基线
    </Button>
  ) : null;

  return (
    <Section title="安全" action={rebaselineButton}>
      {!data ? (
        <Row label="巡检" value={summary.isLoading ? "读取中…" : "读取失败"} />
      ) : !data.supported ? (
        <Row label="巡检" value="需要把 Agent 升级到 2.2.216" />
      ) : (
        <>
          <Row
            label="待处理"
            value={data.openTotal === 0 ? "没有" : (
              <span className="inline-flex flex-wrap justify-end gap-1">
                {ORDER.filter((s) => data.open[s] > 0).map((s) => (
                  <span key={s} className="inline-flex items-center gap-1">
                    <SeverityBadge severity={s} />
                    <span className="tabular-nums">{data.open[s]}</span>
                  </span>
                ))}
              </span>
            )}
          />
          <Row label="最近巡检" value={data.lastCheckAt ? `${formatAgo(Date.now() - data.lastCheckAt * 1000)} · 每 ${data.intervalMinutes} 分钟` : "还没有巡检过"} />
          <Row label="基线" value={data.baselineReady && data.baselineAt ? `${new Date(data.baselineAt * 1000).toLocaleDateString("zh-CN")} 建立` : "正在建立"} />
          <Link href={`/insights?tab=security&host=${hostId}`} className="self-start text-meta font-medium text-primary underline-offset-4 hover:underline">
            查看这台主机的发现
          </Link>
        </>
      )}
    </Section>
  );
}
