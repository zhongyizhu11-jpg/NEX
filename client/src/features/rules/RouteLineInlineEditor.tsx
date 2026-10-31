import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { forwardGroupModeOf } from "@shared/forwardTypes";
import { routeGroupOf, routeGroupRuleFields, validateRouteGroup } from "@shared/routeGroup";
import { routeLinesForEditor } from "@shared/routeLines";
import { describeRoutePolicy, pinUntilSeconds } from "@shared/routePolicy";
import type { RouteStatus, RouteStatusPath } from "./RouteGroupSheet";
import { RouteGroupFields, routeGroupPayload, routePathIndexFor, type RouteGroupDraft, type RouteHostOption } from "./RouteGroupFields";
import { routeLineStatusControls, type RouteLineSwitch } from "./RouteLineOverview";
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
import { routeLineGroups } from "./routeLineText";

/*
  线路详情第一页直接改线路（2.3.498 起，原来右上角「编辑」再开一层「编辑线路组」框，用户要的是一页改完）：

    详情里「线路」那一节就是编辑器（主线路一张卡、有序备用、怎么切、高级策略），每条线路后面照样是此刻的
    状态（使用中 / 待命 / 不通）和暂停 —— 暂停点了马上生效，不用保存；点状态胶囊能手动「切到这条」（人工指定，
    也是马上生效）。别的改动攒着，动过才在底下钉一条
    「放弃改动 / 保存并立即测」。保存走 rules.update（只带 routeGroup，服务端拿库里的规则补齐其余字段、
    重新展开线路、落实中继、推给 Agent），保存后 Agent 和中转马上探一轮 ——「保存后 10 秒内每一段都有数字」。

  编辑稿从「库里那份」改起：规则列表定时刷新会换掉 rule 对象，内容没变就当没变；没在改时库里变了（刚保存完、
  刚暂停、别处改过）就跟上，正在改就不动。正在改的时候暂停、手动切换了，编辑稿也跟着改 —— 不然保存别的改动
  时带上去的是改之前的那份，刚切过去的又被切回来。
*/

function draftOf(rule: LineRuleRow | null): RouteGroupDraft | null {
  if (!rule) return null;
  const group = routeGroupOf(rule);
  return group ? { ...group, lines: routeLinesForEditor(rule, group.paths) } : null;
}

/** 两份编辑稿一样不一样：按提交出去的样子比。 */
const payloadKey = (draft: RouteGroupDraft | null) => (draft ? JSON.stringify(routeGroupPayload(draft)) : "");

/**
 * 状态胶囊上的手动切换（指定 / 交回自动）已经存进库里了：编辑稿里的指定跟着改（按线路对上路径下标），
 * 之后保存别的改动不会又把它改回去。编辑稿里已经没有那条线路（正改着删掉了）就不动，保存时照编辑稿来。
 */
export function withPin(draft: RouteGroupDraft | null, target: Pick<RouteStatusPath, "key" | "lineKey"> | null, untilMs: number | null): RouteGroupDraft | null {
  if (!draft) return draft;
  if (!target) return { ...draft, policy: { ...draft.policy, pin: null } };
  const index = routePathIndexFor(draft.paths, target);
  if (index < 0) return draft;
  return { ...draft, policy: { ...draft.policy, pin: { index, untilMs } } };
}

/** 暂停 / 恢复一条线路已经存进库里了：编辑稿跟着改，之后保存别的改动不会又把它改回去。 */
function withLinePaused(draft: RouteGroupDraft | null, lineKey: string, paused: boolean): RouteGroupDraft | null {
  if (!draft) return draft;
  return {
    ...draft,
    lines: draft.lines?.map((line) => (line.key === lineKey ? { ...line, paused } : line)),
    paths: draft.paths.map((path) => ((path.lineKey || path.key) === lineKey ? { ...path, paused } : path)),
  };
}

export function useRouteLineEditor({ rule, enabled, status, onPause, pausing = false, lineSwitch }: {
  /** 没有（转发组的子规则、只能看）就不出编辑器，详情里照旧是只读的线路列表。 */
  rule: LineRuleRow | null;
  /** 详情开着：开的那一下从库里那份开始。关着时不动，免得关的动画里编辑器先变回列表。 */
  enabled: boolean;
  status: RouteStatus | null;
  /** 立刻生效的暂停；onDone 在成功后调。 */
  onPause: (lineKey: string, paused: boolean, onDone?: () => void) => void;
  pausing?: boolean;
  /** 手动换线路：点每条线路的状态胶囊「切到这条」（人工指定，马上生效、不用保存）。 */
  lineSwitch?: RouteLineSwitch;
}): { editor: ReactNode; saveBar: ReactNode } {
  const utils = trpc.useUtils();
  const active = enabled && !!rule;
  const hostsQuery = trpc.hosts.options.useQuery(undefined, { enabled: active, staleTime: 60_000, refetchOnWindowFocus: false });
  const tunnelsQuery = trpc.tunnels.options.useQuery(undefined, { enabled: active, staleTime: 30_000, refetchOnWindowFocus: false });
  const poolsQuery = trpc.lineDiagnostics.nodePools.useQuery(undefined, { enabled: active, staleTime: 30_000, refetchOnWindowFocus: false });
  const groupsQuery = trpc.forwardGroups.options.useQuery(undefined, { enabled: active && Number(rule?.forwardGroupId || 0) > 0, staleTime: 30_000, refetchOnWindowFocus: false });
  const permission = trpc.proxySubscriptions.permission.useQuery(undefined, { enabled: active, staleTime: 60_000, refetchOnWindowFocus: false });
  const nodesQuery = trpc.proxySubscriptions.listNodes.useQuery(undefined, { enabled: active && !!permission.data?.allowed, staleTime: 60_000, refetchOnWindowFocus: false });

  const ruleId = Number(rule?.id || 0);
  const baseline = useMemo(() => draftOf(rule), [rule]);
  const baseKey = useMemo(() => payloadKey(baseline), [baseline]);
  const [draft, setDraft] = useState<RouteGroupDraft | null>(null);
  /** 编辑稿是从哪一份改起的；和它一样 = 没改动，不出保存条。 */
  const [saved, setSaved] = useState<RouteGroupDraft | null>(null);
  const draftKey = useMemo(() => payloadKey(draft), [draft]);
  const savedKey = useMemo(() => payloadKey(saved), [saved]);
  const dirty = !!draft && draftKey !== savedKey;

  useEffect(() => {
    if (!enabled) return;
    setDraft(baseline);
    setSaved(baseline);
    // 只在打开、换了一条规则时从头来；规则内容变了走下面那个
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ruleId]);
  useEffect(() => {
    if (!enabled || dirty || baseKey === savedKey) return;
    setDraft(baseline);
    setSaved(baseline);
  }, [enabled, dirty, baseKey, savedKey, baseline]);

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
      const id = Number(variables.id);
      void utils.rules.list.invalidate();
      void utils.rules.listPage.invalidate();
      void utils.rules.routeStatus.invalidate({ ruleId: id });
      void utils.rules.routeEvents.invalidate({ ruleId: id });
      void utils.rules.routeBoard.invalidate();
      void utils.lineDiagnostics.lineWorkspace.invalidate();
      toast.success("已保存，正在逐段测：10 秒内每一段都有数字");
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
    const sent = draft;
    save.mutate({ id: Number(rule.id), failoverEnabled: true, routeGroup: routeGroupPayload(sent) }, { onSuccess: () => setSaved(sent) });
  };
  const pauseLine = (lineKey: string, paused: boolean) => onPause(lineKey, paused, () => {
    setDraft((current) => withLinePaused(current, lineKey, paused));
    setSaved((current) => withLinePaused(current, lineKey, paused));
  });
  const followPin = (target: RouteStatusPath | null, untilMs: number | null) => {
    setDraft((current) => withPin(current, target, untilMs));
    setSaved((current) => withPin(current, target, untilMs));
  };
  const editorSwitch: RouteLineSwitch | undefined = lineSwitch
    ? {
        ...lineSwitch,
        onPin: (pathIndex, durationSeconds) => {
          const target = status?.paths.find((path) => path.index === pathIndex) ?? null;
          lineSwitch.onPin(pathIndex, durationSeconds, () => {
            if (!target) return;
            const until = pinUntilSeconds(durationSeconds);
            followPin(target, until === null ? null : until * 1000);
          });
        },
        onUnpin: () => lineSwitch.onUnpin(() => followPin(null, null)),
      }
    : undefined;

  // 机器列表到了再出编辑器：不然候选先显示成「主机 12」再变成名字
  const editor = draft && rule && hostsQuery.data ? (
    <SegmentLatencyProvider>
      <RouteGroupFields
        value={draft}
        onChange={setDraft}
        hosts={hosts}
        allowHops={allowHops}
        entryHostId={entryHostId}
        mainAddress={mainAddress}
        policy={policy}
        scheduleTimeZone={draft.policy.schedule?.timezone || "Asia/Shanghai"}
        protocol={rule.protocol ? String(rule.protocol) : undefined}
        nodeOptions={nodeOptions}
        pools={pools}
        tunnels={tunnels}
        entryName={entryName}
        entryPrefix={entryPrefix}
        allowTunnels={allowTunnels}
        ruleId={ruleId || null}
        upstreamHostIds={routeTunnel ? [Number(routeTunnel.entryHostId || 0)].filter((id) => id > 0) : []}
        defaultAdvancedOpen={false}
        renderLineStatus={(line) => routeLineStatusControls(status, line.key, pauseLine, pausing, editorSwitch)}
        activeLineKey={status ? routeLineGroups(status).find((group) => group.active)?.key ?? null : null}
        startCollapsed
        pinOnLineStatus={!!lineSwitch}
      />
    </SegmentLatencyProvider>
  ) : null;

  // 动过才出来；钉在详情底下（详情很长，改完不用翻到最底下找按钮）
  const saveBar = editor && dirty ? (
    <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-col gap-1 border-t border-[var(--fx-stroke-weak)] bg-[var(--fx-l0-page)] px-4 pb-4 pt-2.5 sm:-mx-6 sm:-mb-6 sm:px-6 sm:pb-6" data-testid="route-line-savebar">
      <div className="flex gap-2.5">
        <Button type="button" variant="outline" className="h-auto flex-1 rounded-[12px] py-[11px] text-[14px] font-semibold" disabled={save.isPending} onClick={() => setDraft(saved)} data-testid="route-line-discard">
          放弃改动
        </Button>
        <Button
          type="button"
          className="h-auto flex-1 rounded-[12px] border border-[var(--fx-accent)] bg-[var(--fx-accent)] py-[11px] text-[14px] font-semibold text-white hover:bg-[var(--fx-accent)]/90"
          disabled={save.isPending}
          onClick={submit}
          data-testid="route-line-save"
        >
          {save.isPending ? "保存中…" : "保存并立即测"}
        </Button>
      </div>
      <p className={cn("text-center text-[11px]", issue ? "text-[var(--fx-warn-text)]" : "text-muted-foreground")}>{issue || "保存后 10 秒内每一段都有数字"}</p>
    </div>
  ) : null;

  return { editor, saveBar };
}
