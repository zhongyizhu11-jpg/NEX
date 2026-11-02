import { useAuth } from "@/_core/hooks/useAuth";
import AddSelfServiceHostDialog from "@/components/hosts/AddSelfServiceHostDialog";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { hostDeleteNeedsOfflineConfirmation, offlineCleanupConfirmOptions } from "@/components/hosts/hostDeletion";
import { formatBytes, formatCpuPercent, formatUptime } from "@/components/hosts/hostDisplay";
import { ProxyNodeRow, proxyNodeMetaText } from "@/components/proxy/ProxyNodeRow";
import { trpc } from "@/lib/trpc";
import { Plus, Terminal, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

/**
 * 「订阅管理 › 我的节点 › 我的机器」弹窗里的那一段：租户自己的机器列表，在线不在线、跑得怎么样。
 *
 * 2.3.506 起这里只是个快捷入口，不再自己实现一遍：
 * - 加机器、拿安装命令都是 AddSelfServiceHostDialog（和「主机管理」那一页的「添加主机」同一个框，
 *   加完直接给安装命令）；原来这里自己画了一个命令框，主机管理那边加的就拿不到命令。
 * - 完整的管理（改名、看详情、监控）在「主机管理」那一页：租户早就能进那一页了（只看得到自己的和
 *   被授权的机器），底部给一个「去主机管理」。
 *
 * 后端：hosts.create 是 protectedProcedure，建出来的主机 userId 就是他自己；能开几个节点仍由
 * maxProxyInbounds 管着 —— 机器行本身不消耗任何东西。
 */
export default function MyHostsSection() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const [, setLocation] = useLocation();

  const [addOpen, setAddOpen] = useState(false);
  // 只看某一台的安装命令（打开的还是那个加机器的框，直接在第二步）
  const [commandHostId, setCommandHostId] = useState(0);

  const isAdmin = user?.role === "admin";
  const hostsQuery = trpc.hosts.list.useQuery(undefined, { enabled: !isAdmin });
  // 额度先摆出来，别等人填完表单才弹一句「已达上限」。
  const quotaQuery = trpc.hosts.selfServiceQuota.useQuery(undefined, { enabled: !isAdmin });
  /*
    自己加的机器现在什么情况。

    原来这一段只有一个在线的小圆点 —— 可「在线」只回答了「Agent 连上没有」，
    回答不了「这机器还撑得住吗」。租户自己掏钱买的机器，内存满了、磁盘满了、
    刚重启过，他都该看得见，否则只能来问管理员。

    走 latestMetricsSummary：它本来就是 protectedProcedure，逐台过 requireHostAccess，
    所以不用开新接口、也不用给租户放主机管理那一整页的权限（那里还有分组、令牌、
    Agent 升级和删任意主机，不是这个需求要的东西）。
  */
  const myHostIds = useMemo(
    () => ((hostsQuery.data || []) as any[])
      // 和下面的 myHosts 同一个口径：只要自己的。两处分别写会在改口径时漏掉一处。
      .filter((host: any) => Number(host?.userId || 0) === Number(user?.id || 0))
      .map((host: any) => Number(host.id))
      .filter((id) => Number.isInteger(id) && id > 0)
      // 排序是为了让查询键稳定：顺序一变 react-query 会当成新查询重新拉一遍。
      .sort((a, b) => a - b),
    [hostsQuery.data, user?.id],
  );
  const metricsQuery = trpc.hosts.latestMetricsSummary.useQuery(
    { hostIds: myHostIds },
    {
      enabled: !isAdmin && myHostIds.length > 0,
      // 机器状态是看一眼就走的东西，不值得为它一直轮询。
      refetchInterval: 30_000,
      staleTime: 20_000,
    },
  );
  const metricByHostId = useMemo(() => {
    const map = new Map<number, any>();
    for (const row of (metricsQuery.data || []) as any[]) map.set(Number(row.hostId), row);
    return map;
  }, [metricsQuery.data]);

  /**
   * 机器现在什么情况：CPU / 内存 / 磁盘 / 已经跑了多久。
   *
   * 离线时这些数是最后一次上报的值，会冻在那儿 —— 所以离线就说「最后一次」，
   * 别让人以为是此刻的读数（主机卡片那边同样的道理）。
   */
  const hostStatusLine = (host: any) => {
    const metric = metricByHostId.get(Number(host.id));
    // 还没上报过就什么都不说 —— 拿一排 0 冒充「机器很闲」比空着更糟。
    if (!metric) return null;
    const parts = [
      metric.cpuUsage == null ? "" : `CPU ${formatCpuPercent(metric.cpuUsage, !!host.isOnline)}`,
      metric.memoryUsage == null ? "" : `内存 ${Math.round(Number(metric.memoryUsage))}%`,
      metric.diskUsed == null || metric.diskTotal == null
        ? ""
        : `磁盘 ${formatBytes(Number(metric.diskUsed))}/${formatBytes(Number(metric.diskTotal))}`,
      metric.uptime == null ? "" : `${host.isOnline ? "已跑" : "最后跑了"} ${formatUptime(Number(metric.uptime))}`,
    ].filter(Boolean);
    if (parts.length === 0) return null;
    return (
      <p className="truncate text-[11px] leading-tight text-muted-foreground">
        {host.isOnline ? "" : "最后一次 · "}{parts.join(" · ")}
      </p>
    );
  };

  const invalidate = () => {
    utils.hosts.list.invalidate();
    utils.hosts.selfServiceQuota.invalidate();
    // 「新建 › 在我的机器上开一个」的主机下拉走的是 options，不刷的话新加的机器要等下次进页面才出现。
    utils.hosts.options.invalidate();
  };

  const deleteHost = trpc.hosts.delete.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success("已删除");
    },
    onError: async (error, variables) => {
      // 离线主机上还有待清理的规则：问一句，同意了再带确认删一次（见 components/hosts/hostDeletion.ts）。
      if (hostDeleteNeedsOfflineConfirmation(error) && !variables.confirmOfflineCleanup) {
        const host = ((hostsQuery.data || []) as any[]).find((item) => Number(item?.id) === Number(variables.id));
        if (await confirm(offlineCleanupConfirmOptions(host?.name, error.message))) {
          deleteHost.mutate({ id: variables.id, confirmOfflineCleanup: true });
        }
        return;
      }
      toast.error(error.message || "删除失败");
    },
  });

  // 管理员有整页的「主机管理」，这里再放一个精简版只是噪音。
  if (isAdmin) return null;

  const myHosts = ((hostsQuery.data || []) as any[]).filter(
    (host) => Number(host?.userId || 0) === Number(user?.id || 0),
  );
  const onlineCount = myHosts.filter((host) => !!host.isOnline).length;
  const quotaLimit = Number(quotaQuery.data?.limit || 0);
  const canAddHost = quotaQuery.data ? !!quotaQuery.data.canAdd : true;

  const askDelete = async (host: any) => {
    const ok = await confirm({
      title: "删除这台机器？",
      description: `面板不再管「${host.name}」。机器上的 Agent 不会自己卸载，要连服务器执行卸载命令才算干净。`,
      confirmText: "删除",
      tone: "destructive",
    });
    if (ok) deleteHost.mutate({ id: Number(host.id) });
  };

  /** 加机器 / 看安装命令：主机管理那一页用的同一个框（加完直接到安装命令那一步）。 */
  const dialogs = (
    <AddSelfServiceHostDialog
      open={addOpen || commandHostId > 0}
      commandHostId={commandHostId}
      onOpenChange={(open) => {
        if (open) return;
        setAddOpen(false);
        setCommandHostId(0);
      }}
      onCreated={invalidate}
    />
  );

  /**
   * 这一段长在「我的节点」那张卡的「我的机器」弹窗里，不是页面上并列的
   * 一张卡 —— 它是自建节点的前置条件，不是跟节点平级的东西。
   */
  const body = (
    <>
      {hostsQuery.isLoading ? (
        <DataSectionLoading />
      ) : myHosts.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          还没有自己的机器。加一台之后，把它给出的命令粘进那台机器的 SSH 装上 Agent，就能在上面开自己的节点。
        </p>
      ) : (
        <div className="space-y-1.5">
          {myHosts.map((host) => (
            <ProxyNodeRow
              key={host.id}
              leading={
                <span
                  className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${host.isOnline ? "bg-[var(--fx-healthy)]" : "bg-muted-foreground/40"}`}
                  title={host.isOnline ? "Agent 已连上面板" : "Agent 还没连上面板"}
                  aria-label={host.isOnline ? "在线" : "离线"}
                />
              }
              name={host.name}
              meta={proxyNodeMetaText([
                host.ip,
                host.isOnline ? "在线" : "离线",
                host.agentVersion ? `Agent ${host.agentVersion}` : "还没装 Agent",
              ])}
              detail={hostStatusLine(host)}
              actions={[
                {
                  key: "command",
                  label: "安装命令",
                  icon: Terminal,
                  onSelect: () => setCommandHostId(Number(host.id)),
                },
                {
                  key: "delete",
                  label: "删除",
                  icon: Trash2,
                  destructive: true,
                  onSelect: () => void askDelete(host),
                },
              ]}
            />
          ))}
        </div>
      )}
    </>
  );

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {quotaLimit > 0 ? `${myHosts.length}/${quotaLimit} 台` : `${myHosts.length} 台`}
            {onlineCount > 0 ? ` · ${onlineCount} 在线` : ""}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!canAddHost}
            title={canAddHost ? undefined : `自己添加的机器已达上限（${quotaLimit} 台），删掉一台，或让管理员调高上限`}
            onClick={() => setAddOpen(true)}
          >
            <Plus className="mr-1 h-4 w-4" />
            加一台
          </Button>
        </div>
        {body}
        {/* 改名、看详情和监控在主机管理那一页（同一批机器），这里不再做一份 */}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-muted-foreground" onClick={() => setLocation("/hosts")} data-testid="my-hosts-open-hosts">
            去主机管理看全部
          </Button>
        </div>
      </div>
      {dialogs}
    </>
  );
}
