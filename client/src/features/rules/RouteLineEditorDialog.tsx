import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { forwardGroupModeOf } from "@shared/forwardTypes";
import { routeGroupOf, routeGroupRuleFields, validateRouteGroup } from "@shared/routeGroup";
import { routeLinesForEditor } from "@shared/routeLines";
import { describeRoutePolicy } from "@shared/routePolicy";
import { RouteGroupFields, routeGroupPayload, type RouteGroupDraft, type RouteHostOption } from "./RouteGroupFields";
import type { RouteLinePool, RouteLineTunnel } from "./RouteLinesEditor";
import {
  routeHostOptionsOf,
  routeLinePoolsOf,
  routeLineTunnelsOf,
  type ForwardGroupOptionRow,
  type HostOptionRow,
  type LineRuleRow,
  type ProxyNodeRow,
  type TunnelOptionRow,
} from "./routeLineOptions";
import { SegmentLatencyProvider } from "./SegmentLatencyProvider";

/*
  编辑线路组（2.3.496，效果图 ②）：从线路详情右上角「编辑」进来，只改线路和怎么切，不碰规则的
  其余设置。保存走 rules.update（只带 routeGroup，服务端拿库里的规则补齐其余字段、重新展开线路、
  落实中继、推给 Agent），保存后 Agent 和中转马上探一轮 —— 「保存后 10 秒内每一段都有数字」。
*/

export function RouteLineEditorDialog({ open, onOpenChange, rule }: { open: boolean; onOpenChange: (open: boolean) => void; rule: LineRuleRow | null }) {
  const utils = trpc.useUtils();
  const hostsQuery = trpc.hosts.options.useQuery(undefined, { enabled: open, staleTime: 60_000, refetchOnWindowFocus: false });
  const tunnelsQuery = trpc.tunnels.options.useQuery(undefined, { enabled: open, staleTime: 30_000, refetchOnWindowFocus: false });
  const poolsQuery = trpc.lineDiagnostics.nodePools.useQuery(undefined, { enabled: open, staleTime: 30_000, refetchOnWindowFocus: false });
  const groupsQuery = trpc.forwardGroups.options.useQuery(undefined, { enabled: open && Number(rule?.forwardGroupId || 0) > 0, staleTime: 30_000, refetchOnWindowFocus: false });
  const permission = trpc.proxySubscriptions.permission.useQuery(undefined, { enabled: open, staleTime: 60_000, refetchOnWindowFocus: false });
  const nodesQuery = trpc.proxySubscriptions.listNodes.useQuery(undefined, { enabled: open && !!permission.data?.allowed, staleTime: 60_000, refetchOnWindowFocus: false });

  const [draft, setDraft] = useState<RouteGroupDraft | null>(null);
  const ruleId = Number(rule?.id || 0);
  useEffect(() => {
    if (!open || !rule) return;
    const group = routeGroupOf(rule);
    setDraft(group ? { ...group, lines: routeLinesForEditor(rule, group.paths) } : null);
    // 只在打开、或换了一条规则时取一次：规则列表定时刷新会换掉 rule 对象，不能把正在改的冲掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ruleId]);

  const hostRows: HostOptionRow[] = hostsQuery.data || [];
  const tunnelRows: TunnelOptionRow[] = tunnelsQuery.data || [];
  const groupRows: ForwardGroupOptionRow[] = groupsQuery.data || [];
  const hosts = useMemo<RouteHostOption[]>(() => routeHostOptionsOf(hostsQuery.data), [hostsQuery.data]);
  const tunnels = useMemo<RouteLineTunnel[]>(() => routeLineTunnelsOf(tunnelsQuery.data), [tunnelsQuery.data]);
  const pools = useMemo<RouteLinePool[]>(() => routeLinePoolsOf(poolsQuery.data), [poolsQuery.data]);
  const nodeOptions = useMemo(() => ((nodesQuery.data || []) as ProxyNodeRow[])
    .filter((node) => node.isEnabled !== false && node.isEnabled !== 0 && String(node.address || "").trim() && Number(node.port) > 0)
    .map((node) => ({ id: Number(node.id), name: String(node.name || `节点 #${node.id}`), protocol: String(node.protocol || "").toUpperCase(), address: String(node.address).trim(), port: Number(node.port) })), [nodesQuery.data]);

  const routeTunnel = rule && Number(rule.tunnelId || 0) > 0 ? tunnelRows.find((tunnel) => Number(tunnel.id) === Number(rule.tunnelId)) || null : null;
  const entryHostId = routeTunnel ? Number(routeTunnel.exitHostId || 0) || null : Number(rule?.hostId || 0) || null;
  const entryName = hosts.find((host) => host.id === entryHostId)?.name || "入口";
  const entryPrefix = routeTunnel
    ? `${hosts.find((host) => host.id === Number(routeTunnel.entryHostId))?.name || "入口"} → 隧道 ${routeTunnel.name || routeTunnel.id} →`
    : null;
  const forwardGroup = rule && Number(rule.forwardGroupId || 0) > 0 ? groupRows.find((group) => Number(group.id) === Number(rule.forwardGroupId)) || null : null;
  // 转发组（故障转移组）上的规则不能经过中转；端口转发资源（转发组模板）可以，但放不了隧道段。
  const groupBacked = Number(rule?.forwardGroupId || 0) > 0;
  const allowHops = !groupBacked || (!!forwardGroup && forwardGroupModeOf(forwardGroup) === "port");
  const allowTunnels = allowHops && !routeTunnel && !groupBacked;
  const mainAddress = rule?.targetIp && Number(rule?.targetPort) > 0 ? `${String(rule.targetIp).trim()}:${Number(rule.targetPort)}` : "";
  const entryHost = hostRows.find((host) => Number(host.id) === entryHostId);
  const policy = useMemo(() => {
    if (!draft || !rule) return null;
    return describeRoutePolicy({
      ...rule,
      failoverEnabled: true,
      ...routeGroupRuleFields(draft, { targetIp: rule.targetIp, targetPort: rule.targetPort }),
    }, { host: entryHost });
  }, [draft, rule, entryHost]);

  const save = trpc.rules.update.useMutation({
    onSuccess: (_result, variables) => {
      const ruleId = Number(variables.id);
      void utils.rules.list.invalidate();
      void utils.rules.listPage.invalidate();
      void utils.rules.routeStatus.invalidate({ ruleId });
      void utils.rules.routeEvents.invalidate({ ruleId });
      void utils.rules.routeBoard.invalidate();
      void utils.lineDiagnostics.lineWorkspace.invalidate();
      toast.success("已保存，正在逐段测：10 秒内每一段都有数字");
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });

  const issue = draft && hosts.length > 0 ? validateRouteGroup(draft, {
    entryHostId,
    hostIds: new Set(hosts.map((host) => host.id)),
    hasRuleTarget: !!mainAddress,
    rejectDuplicates: !!draft.lines?.length,
  }) : null;
  const submit = () => {
    if (!draft || !rule) return;
    if (issue) {
      toast.error(issue);
      return;
    }
    save.mutate({ id: Number(rule.id), failoverEnabled: true, routeGroup: routeGroupPayload(draft) });
  };

  return (
    <LineEditorShell
      open={open}
      onOpenChange={onOpenChange}
      primaryLabel={save.isPending ? "保存中…" : "保存并立即测"}
      primaryDisabled={!draft || save.isPending}
      onPrimary={submit}
      note={issue && draft ? issue : "保存后 10 秒内每一段都有数字"}
      noteWarn={!!(issue && draft)}
    >
      {draft ? (
        <RouteGroupFields
          value={draft}
          onChange={setDraft}
          hosts={hosts}
          allowHops={allowHops}
          entryHostId={entryHostId}
          mainAddress={mainAddress}
          policy={policy}
          scheduleTimeZone={draft.policy.schedule?.timezone || "Asia/Shanghai"}
          protocol={rule?.protocol ? String(rule.protocol) : undefined}
          nodeOptions={nodeOptions}
          pools={pools}
          tunnels={tunnels}
          entryName={entryName}
          entryPrefix={entryPrefix}
          allowTunnels={allowTunnels}
          ruleId={Number(rule?.id || 0) || null}
          upstreamHostIds={routeTunnel ? [Number(routeTunnel.entryHostId || 0)].filter((id) => id > 0) : []}
          defaultAdvancedOpen={false}
        />
      ) : (
        <p className="text-[12.5px] text-muted-foreground">这条规则还没开线路组。</p>
      )}
    </LineEditorShell>
  );
}

/**
 * 编辑线路组的那个框（效果图 ②）：标题、编辑器、钉在底下的「取消 / 主按钮」。线路详情里的「编辑」
 * （保存并立即测）和规则表单里的「编辑线路」（完成，跟着规则一起存）用的是同一个框、同一个编辑器。
 */
export function LineEditorShell({
  open,
  onOpenChange,
  primaryLabel,
  primaryDisabled = false,
  onPrimary,
  note,
  noteWarn = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  primaryLabel: string;
  primaryDisabled?: boolean;
  onPrimary: () => void;
  note?: string;
  noteWarn?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 bg-[var(--fx-l0-page)] sm:max-w-xl" onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader className="space-y-0.5">
          <DialogTitle className="text-[19px] font-bold">编辑线路组</DialogTitle>
          <DialogDescription className="text-[12.5px]">每层放几台候选，按整条链的延迟挑</DialogDescription>
        </DialogHeader>
        <SegmentLatencyProvider>{children}</SegmentLatencyProvider>
        {/* 底下的按钮钉住：编辑框很长，改完不用再翻到最底下找主按钮 */}
        <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-col gap-1 border-t border-[var(--fx-stroke-weak)] bg-[var(--fx-l0-page)] px-4 pb-4 pt-2.5 sm:-mx-6 sm:-mb-6 sm:px-6 sm:pb-6">
          <div className="flex gap-2.5">
            <Button type="button" variant="outline" className="h-auto flex-1 rounded-[12px] py-[11px] text-[14px] font-semibold" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              type="button"
              className="h-auto flex-1 rounded-[12px] border border-[var(--fx-accent)] bg-[var(--fx-accent)] py-[11px] text-[14px] font-semibold text-white hover:bg-[var(--fx-accent)]/90"
              disabled={primaryDisabled}
              onClick={onPrimary}
              data-testid="route-line-save"
            >
              {primaryLabel}
            </Button>
          </div>
          {note ? <p className={noteWarn ? "text-center text-[11px] text-[var(--fx-warn-text)]" : "text-center text-[11px] text-muted-foreground"}>{note}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
