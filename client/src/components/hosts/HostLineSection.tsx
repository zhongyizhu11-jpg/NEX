import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatAgo } from "@shared/dashboardAttention";
import { Row, Section } from "./HostDetailDialog";

/*
  主机详情「线路」一节（2.3.496）：这台机器在线路里的样子。

    维护中   勾上就从所有线路、转发组、入口组、出口组的候选里拿掉，经过它的连接先切走（server/hostMaintenance.ts）
    节点熔断 几条线路都探不通它时自动标坏、经过它的路径一起避开；恢复稳定一分钟解除（routeGroupStats）
    经过它   哪些线路经过这台机器、此刻在不在走它
*/
export default function HostLineSection({ hostId }: { hostId: number }) {
  const utils = trpc.useUtils();
  const health = trpc.hosts.lineHealth.useQuery({ hostId }, { enabled: hostId > 0, staleTime: 10_000, refetchInterval: 30_000 });
  const setMaintenance = trpc.hosts.setMaintenance.useMutation({
    onSuccess: (result: any, variables) => {
      void utils.hosts.lineHealth.invalidate({ hostId });
      void utils.rules.routeBoard.invalidate();
      toast.success(variables.enabled ? `已进入维护${result?.lines ? `，${result.lines} 条线路已避开` : ""}` : "已结束维护，探通稳定后线路会自己回来");
    },
    onError: (error) => toast.error(error.message),
  });
  const data = health.data;
  if (!(hostId > 0)) return null;
  return (
    <Section title="线路">
      {data ? (
        <>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-secondary-type font-medium">维护中</div>
              <p className="text-meta leading-5 text-muted-foreground">从所有线路和组的候选里拿掉，经过它的连接先切走。关掉后要探通、稳定才放回。</p>
              {data.maintenance && data.maintenanceSince ? <p className="text-meta text-[var(--fx-warn-text)]">{formatAgo(Date.now() - Number(data.maintenanceSince))}开始{data.maintenanceNote ? ` · ${data.maintenanceNote}` : ""}</p> : null}
            </div>
            <Switch
              checked={data.maintenance}
              disabled={!data.canManage || setMaintenance.isPending}
              onCheckedChange={(checked) => setMaintenance.mutate({ hostId, enabled: checked })}
              aria-label="维护中"
              data-testid="host-maintenance"
            />
          </div>
          <Row
            label="节点熔断"
            value={<span className={cn(data.breaker.tripped ? "text-[var(--fx-down-text)]" : "text-[var(--fx-healthy-text)]")}>{data.breaker.tripped ? "熔断中：几条线路都探不通它" : "正常"}</span>}
          />
          {data.lines.length > 0 ? (
            <div className="flex flex-col divide-y divide-[var(--fx-stroke-weak)]">
              {data.lines.map((line: any) => (
                <div key={line.ruleId} className="flex min-w-0 items-center justify-between gap-2 py-1.5 text-meta">
                  <span className="truncate text-foreground">{line.name}</span>
                  <span className={cn("shrink-0", line.usingNow ? "text-[var(--fx-healthy-text)]" : "text-muted-foreground")}>
                    {data.maintenance || data.breaker.tripped ? "已避开" : line.usingNow ? "在走它" : "备用里有它"}
                  </span>
                </div>
              ))}
            </div>
          ) : <Row label="经过它的线路" value="没有" />}
        </>
      ) : (
        <p className="text-meta text-muted-foreground">{health.isLoading ? "读取中…" : "读取失败"}</p>
      )}
    </Section>
  );
}
