import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { LineCard, LineHint, LineKv, LinePill, LineSec, type LineTone } from "@/features/lines/LineUi";
import { RouteSwitchTimeline } from "@/features/lines/RouteSwitchTimeline";
import type { RouteEvent, RouteStatus } from "@/features/rules/RouteGroupSheet";
import { trpc } from "@/lib/trpc";
import { formatAgo } from "@shared/dashboardAttention";
import { countryNameZh } from "@shared/placeNameZh";
import { hostRegionText } from "./hostDisplay";

/*
  主机详情「线路」页签（2.3.496，效果图 ③「节点维护 + 切换记录」）：

    维护中     打开就从所有线路、转发组、入口组、出口组的候选里拿掉，经过它的连接先切走（server/hostMaintenance.ts）；
               下面一条线路一行：它对这条线路意味着什么（已避开 / 已切到备 1 / 不受影响）
    节点熔断   任一规则探到它不通，所有经过它的线路一起标坏；恢复稳定一分钟解除（routeGroupStats）
    切换记录   点上面某一条线路，看它近 7 天怎么切的
*/

export default function HostLineSection({ host }: { host: any }) {
  const hostId = Number(host?.id || 0);
  const utils = trpc.useUtils();
  const health = trpc.hosts.lineHealth.useQuery({ hostId }, { enabled: hostId > 0, staleTime: 10_000, refetchInterval: 30_000 });
  const setMaintenance = trpc.hosts.setMaintenance.useMutation({
    onSuccess: (result: any, variables) => {
      void utils.hosts.lineHealth.invalidate({ hostId });
      // 卡片和详情头上的「维护中」跟着变
      void utils.hosts.list.invalidate();
      void utils.hosts.listPage.invalidate();
      void utils.rules.routeBoard.invalidate();
      void utils.lineDiagnostics.lineWorkspace.invalidate();
      void utils.lineDiagnostics.poolBoard.invalidate();
      toast.success(variables.enabled ? `已进入维护${result?.lines ? `，${result.lines} 条线路已避开` : ""}` : "已结束维护，探通稳定后线路会自己回来");
    },
    onError: (error) => toast.error(error.message),
  });
  const data = health.data;
  const lines = data?.lines || [];
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    if (lines.length === 0) return;
    if (selected === null || !lines.some((line) => line.ruleId === selected)) setSelected(lines[0].ruleId);
  }, [lines, selected]);
  const selectedLine = lines.find((line) => line.ruleId === selected) || null;
  const events = trpc.rules.routeEvents.useQuery({ ruleId: Number(selected || 0), limit: 60 }, { enabled: !!selected, staleTime: 15_000, refetchInterval: 30_000 });
  const status = trpc.rules.routeStatus.useQuery({ ruleId: Number(selected || 0) }, { enabled: !!selected, staleTime: 15_000 });

  if (!(hostId > 0)) return null;
  const role = lines.some((line) => line.entry) && lines.some((line) => !line.entry)
    ? "入口 / 中转"
    : lines.some((line) => line.entry) ? "入口" : lines.length > 0 ? "中转" : "没有线路经过";
  const region = countryNameZh(host?.geoCountryCode) || hostRegionText(host) || "";
  const sub = [role, region, host?.isOnline ? "在线" : "离线"].filter(Boolean).join(" · ");
  // 关掉维护以后多久回来：经过它的线路里最长的「恢复观察」（线路组自己的设置，各条可能不一样）
  const recoverSeconds = Math.max(0, ...lines.map((line) => Number(line.recoverSeconds || 0)));
  const recoverText = recoverSeconds > 0 ? (recoverSeconds < 60 ? `${recoverSeconds} 秒` : `${Math.round(recoverSeconds / 60)} 分钟`) : "";
  // 什么时候开始维护、备注：放在「维护中」的悬停提示里，卡面和效果图一样干净
  const since = data?.maintenance && data.maintenanceSince
    ? `${formatAgo(Date.now() - Number(data.maintenanceSince))}开始维护${data.maintenanceNote ? ` · ${data.maintenanceNote}` : ""}`
    : "";

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="host-line-section">
      <p className="px-1 text-[12.5px] text-muted-foreground">{sub}</p>
      {data ? (
        <>
          <LineCard>
            <div className="flex min-w-0 items-center justify-between gap-3">
              <b className="text-[14px]" title={since || undefined}>维护中</b>
              <Switch
                size="sm"
                checked={data.maintenance}
                disabled={!data.canManage || setMaintenance.isPending}
                onCheckedChange={(checked) => setMaintenance.mutate({ hostId, enabled: checked })}
                aria-label="维护中"
                data-testid="host-maintenance"
              />
            </div>
            <LineHint className="mt-1.5">从所有线路的候选里拿掉，经过它的连接先切走。{recoverText ? `关掉后探通、稳定 ${recoverText}再放回。` : "关掉后探通、稳定一阵再放回。"}</LineHint>
            {lines.length > 0 ? (
              <div className="mt-[10px]">
                {lines.map((line) => (
                  <LineKv
                    key={line.ruleId}
                    active={line.ruleId === selected}
                    onClick={() => setSelected(line.ruleId)}
                    left={<span className="truncate">{line.name}</span>}
                    right={line.impact}
                  />
                ))}
              </div>
            ) : (
              <LineHint className="mt-2">还没有线路经过这台机器。</LineHint>
            )}
          </LineCard>

          <LineCard>
            <div className="flex min-w-0 items-center justify-between gap-3">
              <b className="text-[14px]">节点熔断</b>
              <LinePill tone={(data.breaker.tripped ? "down" : "ok") as LineTone} dot>{data.breaker.tripped ? "熔断中" : "正常"}</LinePill>
            </div>
            <LineHint className="mt-1.5">任一规则探到它不通，所有经过它的线路一起标坏，不用各自再探。</LineHint>
          </LineCard>

          {selectedLine ? (
            <div>
              <LineSec left={`切换记录 · ${selectedLine.name}`} right="近 7 天" />
              <LineCard>
                <RouteSwitchTimeline
                  events={(events.data as RouteEvent[] | undefined) || []}
                  status={(status.data as RouteStatus | null | undefined) ?? null}
                />
              </LineCard>
            </div>
          ) : null}
        </>
      ) : (
        <p className="px-1 text-[12.5px] text-muted-foreground">{health.isLoading ? "读取中…" : "读取失败"}</p>
      )}
    </div>
  );
}
