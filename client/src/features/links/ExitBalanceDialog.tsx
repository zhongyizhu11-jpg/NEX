import { useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";

import { BalanceStatePill, BalanceStateRow } from "@/components/balance/BalanceStateRow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dedupeSwitchEvents, exitRowView, pinBypassText, switchEventView } from "@/lib/balanceState";
import { getTunnelHopIds, moveExitInGroup, tunnelBalanceExits, tunnelHopHostName, type ExitGroupMemberLite } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { balanceStrategyHint, BALANCE_STRATEGY_LABELS, nginxBalanceBasicSupportNote, normalizeBalanceDetect, normalizeExitGroupStrategy } from "@shared/loadBalance";
import { tunnelExitPinUnsupportedReason } from "@shared/tunnelExitPin";

/*
  链路卡上点「负载均衡 ×N」：这几台出口此刻怎么样（入口真实上报，server/exitTargetHealth.ts，每 5 秒刷新）。

    标题      链路名；下面一行「自动 · 3 台出口 · 2 台在用」和这种方式的一句话
    提示      只放一条最要紧的：需要升级 Agent > 基础支持（Nginx）> 已指定 > 目标本身的问题
    每台一行  状态（在用 / 备用 / 连不上 / 不稳 / 慢启动中 / 已指定）、到目标多快、分到多少；不是在用的写原因
    最近切换  几点、哪台、从什么到什么、为什么

  手动指定（「切到这台」/「交回自动」，tunnels.setExitPin）和 ↑↓ 调顺序（出口组成员顺序，forwardGroups.reorder）
  只在真起作用时给：Nginx、带中转的 NEX 链路、入口 Agent 太旧时不给按钮。
*/

type ExitGroupLite = { id: number; name?: string | null; members?: ExitGroupMemberLite[] | null };
type HostLite = { id: number; name?: string | null; isOnline?: unknown };
type TunnelLite = {
  id: number;
  name?: string | null;
  mode?: string | null;
  userId?: number | null;
  exitHostId?: number | null;
  loadBalanceExits?: unknown;
  loadBalanceStrategy?: string | null;
  balanceDetect?: string | null;
  balancePinHostId?: number | null;
  fxpIssues?: Array<{ message?: string | null }> | null;
  hopHostIds?: unknown;
  hopHosts?: unknown;
};

export function ExitBalanceDialog({
  tunnel,
  exitGroup,
  hosts,
  canManagePin,
  canReorder,
  onClose,
}: {
  tunnel: TunnelLite;
  exitGroup: ExitGroupLite | null;
  hosts: readonly HostLite[] | undefined;
  /** 管理员或链路自己的主人 */
  canManagePin: boolean;
  /** 管理员（改的是出口组的成员顺序） */
  canReorder: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const summary = trpc.tunnels.exitTargets.useQuery({ tunnelId: Number(tunnel.id) }, { refetchInterval: 5_000 }).data ?? null;
  const refresh = () => Promise.all([
    utils.tunnels.list.invalidate(),
    utils.tunnels.listPage.invalidate(),
    utils.forwardGroups.options.invalidate(),
    utils.forwardGroups.listPage.invalidate(),
  ]);
  const pinMutation = trpc.tunnels.setExitPin.useMutation({
    onSuccess: (result) => { toast.success(result.hostId ? "已指定" : "已交回自动"); void refresh(); },
    onError: (error) => toast.error(error.message),
  });
  // ↑↓ 点了马上换位置（排序要重铺链路，接口要等一会儿）；连点几下时等最后一次回来再交给服务端的顺序
  const [order, setOrder] = useState<number[] | null>(null);
  const [eventsOpen, setEventsOpen] = useState(false);
  const pending = useRef(0);
  const reorderMutation = trpc.forwardGroups.reorder.useMutation({
    onMutate: () => { pending.current += 1; },
    onSuccess: async () => { await refresh(); if (pending.current <= 1) setOrder(null); },
    onError: (error) => { setOrder(null); toast.error(error.message); },
    onSettled: () => { pending.current = Math.max(0, pending.current - 1); },
  });

  const groupMembers = (exitGroup?.members || [])
    .filter((member) => member.memberType === "host" && Number(member.hostId) > 0 && member.isEnabled !== false && member.isEnabled !== 0)
    .sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
  const exits = tunnelBalanceExits(tunnel, groupMembers, order);
  const hostById = new Map((hosts || []).map((host) => [Number(host.id), host] as const));
  const online = (hostId: number) => { const value = hostById.get(hostId)?.isOnline; return value === true || value === 1; };
  const nameOf = (hostId: number) => tunnelHopHostName(tunnel, hostId, hosts as never) || `主机 ${hostId}`;

  const strategy = normalizeExitGroupStrategy(tunnel.loadBalanceStrategy);
  const detect = normalizeBalanceDetect(tunnel.balanceDetect);
  const nginxNote = nginxBalanceBasicSupportNote(tunnel.mode);
  const mode = String(tunnel.mode || "").toLowerCase();
  // GOST 链路的 fxpIssues 只有一种：入口机 Agent 太旧、负载均衡没生效（server/tunnelBalanceAgent.ts）
  const upgradeIssue = mode !== "forwardx" && !nginxNote ? (tunnel.fxpIssues || [])[0]?.message || null : null;
  const pinHostId = Number(tunnel.balancePinHostId || 0);
  const pinActive = pinHostId > 0 && exits.some((exit) => exit.hostId === pinHostId);
  const pinOnline = pinActive && online(pinHostId);
  const pinUnsupported = tunnelExitPinUnsupportedReason(tunnel, getTunnelHopIds(tunnel).length);
  const canPin = canManagePin && exits.length > 1 && !pinUnsupported && !upgradeIssue;
  const reorderable = canReorder && !!exitGroup && groupMembers.length > 1;
  const busy = pinMutation.isPending;
  const byHost = new Map((summary?.exits || []).map((item) => [Number(item.hostId), item] as const));
  const events = summary?.live ? dedupeSwitchEvents(summary.events || []) : [];

  const rows = exits.map((exit, index) => ({
    ...exit,
    view: exitRowView(byHost.get(exit.hostId), {
      online: online(exit.hostId),
      index,
      strategy,
      live: !!summary?.live,
      pinHostId: pinOnline ? pinHostId : 0,
      hostId: exit.hostId,
      upgradeNeeded: !!upgradeIssue,
      slowStart: detect.slowStart,
      events,
      ruleNames: summary?.ruleNames,
    }),
  }));
  const inUse = rows.filter((row) => row.view.state === "active" || row.view.state === "pinned" || row.view.state === "warming").length;
  // 「只走最快的一台」是每条规则各挑自己目标最快的：几条规则目标不同时会有两台都「在用」——写清楚，不然像没生效
  const ruleCount = Math.max(0, ...(summary?.exits || []).map((item) => Number(item.rules) || 0));
  const inUseText = strategy === "latency" && detect.fastestOnly && ruleCount > 1 && inUse > 1
    ? `${ruleCount} 条规则各走自己最快的一台，用到 ${inUse} 台`
    : `${inUse} 台在用`;
  // 指定的那台对哪几条规则不通（那几条照常按分法走别的出口，agent/failover_pick.go）
  const pinBypass = pinOnline ? pinBypassText(byHost.get(pinHostId), summary?.ruleNames) : null;
  const targetDown = (summary?.targetIssues || []).filter((issue) => issue.kind === "down").length;
  const targetUnstable = (summary?.targetIssues || []).length - targetDown;

  const move = (hostId: number, delta: -1 | 1) => {
    if (!exitGroup) return;
    const next = moveExitInGroup(exitGroup.members || [], exits.map((exit) => exit.hostId), hostId, delta);
    if (!next) return;
    setOrder(next.hostIds);
    reorderMutation.mutate({ groupId: Number(exitGroup.id), memberIds: next.memberIds });
  };

  const notice = upgradeIssue
    ? { tone: "warn", text: upgradeIssue }
    : nginxNote
      ? { tone: "info", text: nginxNote.replace(/^基础支持：/, "") }
      : pinActive
        ? { tone: pinOnline && !pinBypass ? "info" : "warn", text: !pinOnline ? `指定的 ${nameOf(pinHostId)} 离线，暂按${BALANCE_STRATEGY_LABELS[strategy].label}分` : pinBypass ? `已指定 ${nameOf(pinHostId)}（${pinBypass}不通，暂走别的）` : `已指定走 ${nameOf(pinHostId)}，其余备用` }
        : targetDown + targetUnstable > 0
          ? { tone: "warn", text: `${targetDown > 0 ? `${targetDown} 条规则的目标从每台出口都连不上` : `${targetUnstable} 条规则的目标从每台出口都不稳`}：问题在目标那边，换出口没用` }
          : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[92svh] gap-3 overflow-y-auto sm:max-w-md" data-testid="exit-balance-dialog">
        <DialogHeader className="space-y-1">
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-6">
            <span className="min-w-0 truncate">{tunnel.name}</span>
            {nginxNote ? <BalanceStatePill state="basic" /> : upgradeIssue ? <BalanceStatePill state="upgrade" /> : null}
          </DialogTitle>
          <DialogDescription>
            {pinActive && pinOnline ? "手动指定" : BALANCE_STRATEGY_LABELS[strategy].label} · {exits.length} 台出口 · {inUseText}
          </DialogDescription>
          {!pinActive && !upgradeIssue ? <p className="text-meta leading-5 text-muted-foreground">{balanceStrategyHint(strategy, false, nginxNote ? null : detect)}</p> : null}
        </DialogHeader>
        {notice ? (
          <div className={cn("fx-lb-pin-banner", notice.tone === "warn" && "is-warn")} data-balance-notice={nginxNote ? "basic" : upgradeIssue ? "upgrade" : pinActive ? "pin" : "target"}>
            <span className="min-w-0 flex-1">{notice.text}</span>
            {pinActive && canManagePin ? <Button size="sm" variant="outline" className="shrink-0" disabled={busy} onClick={() => pinMutation.mutate({ tunnelId: Number(tunnel.id), hostId: null })}>交回自动</Button> : null}
          </div>
        ) : null}
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
          {rows.map(({ hostId, weight, view }, index) => (
            <BalanceStateRow
              key={hostId}
              name={nameOf(hostId)}
              state={view.state}
              detail={[view.detail, weight ? `权重 ${weight}` : ""].filter(Boolean).join(" · ") || null}
              reason={view.reason}
              hint={view.hint}
              dim={pinActive && pinOnline && hostId !== pinHostId && view.state === "standby"}
              leading={reorderable ? (
                <span className="fx-lb-move">
                  <button type="button" aria-label={`${nameOf(hostId)} 上移`} disabled={index === 0} onClick={() => move(hostId, -1)}><ChevronUp className="h-4 w-4" /></button>
                  <button type="button" aria-label={`${nameOf(hostId)} 下移`} disabled={index === exits.length - 1} onClick={() => move(hostId, 1)}><ChevronDown className="h-4 w-4" /></button>
                </span>
              ) : null}
              action={canPin && view.state !== "pinned" && view.state !== "down" ? (
                <Button size="sm" variant="outline" className="h-9" disabled={busy} onClick={() => pinMutation.mutate({ tunnelId: Number(tunnel.id), hostId })}>切到这台</Button>
              ) : null}
            />
          ))}
        </ul>
        {events.length > 0 ? (
          <div className="fx-lb-events">
            {/* 默认收着（用户：「把最近切换隐藏折叠起来」）：平时看的是每台出口的状态，切换记录点开再看 */}
            <button
              type="button"
              className="fx-lb-events-title flex items-center gap-1 self-start"
              aria-expanded={eventsOpen}
              onClick={() => setEventsOpen((open) => !open)}
            >
              最近切换
              {eventsOpen ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
            {eventsOpen ? <ul>
              {events.slice(0, 3).map((event) => {
                const item = switchEventView(event);
                return (
                  <li key={`${event.at}-${event.ruleId}-${event.hostId}-${event.to}`}>
                    <span className="fx-lb-events-time">{item.time}</span>
                    <span className="min-w-0">
                      {event.hostName} {item.from} → {item.to}
                      <span className="text-muted-foreground"> · {item.why}</span>
                    </span>
                  </li>
                );
              })}
            </ul> : null}
          </div>
        ) : null}
        {canManagePin && pinUnsupported && !nginxNote ? <p className="text-meta text-muted-foreground">{pinUnsupported}</p> : null}
        {reorderable ? <p className="text-meta text-muted-foreground">顺序就是出口组「{exitGroup?.name}」的成员顺序，第一台是主出口</p> : null}
      </DialogContent>
    </Dialog>
  );
}
