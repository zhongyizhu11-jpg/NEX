import { useMemo, useState, type SyntheticEvent } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { Check, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  LineBig,
  LineCard,
  LineChip,
  LineChipButton,
  LINE_GRAY_BG,
  LineBareInput,
  LineDot,
  LineField,
  LineFormGroup,
  LineFormRow,
  LineHint,
  LineKv,
  LineMs,
  LinePath,
  LinePill,
  LineRow,
  LineSec,
  LineSegmented,
  LineTitle,
  type LineTone,
} from "@/features/lines/LineUi";
import { RouteBoardList } from "@/features/rules/RouteBoardList";
import { LINE_PARAM, useSearchIdParam } from "./lineLinks";
import { LandingPoolFields, landingDraftError, landingDraftFrom, landingInputFromDraft, type LandingConfigView, type LandingDraft } from "./LandingPoolFields";
import { LINK_SPREAD_LABELS } from "@shared/linkTerms";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import type { AppRouter } from "../../../../server/routers";

/*
  线路工作台（2.3.496，效果图 ④「所有线路一个入口」）：

    三个数   经过线路的机器在线几台、近 24 小时告警几次、自动恢复几次
    告警     此刻还在的问题（维护中、熔断、离线的中转）+ 最近几条：左边出了什么事，右边系统做了什么
    线路     一条线路一张卡（按状态排序）：在走哪条、整条链毫秒、用法标签；点开是线路详情

  链路管理分类条最后一个页签「线路概览」就是它（2.3.499 起原来的「链路总览」去掉了：总览里的线路组列表和这里
  重复，三栏组和隧道在各自页签里都有）。看到的都能点进去改：线路卡和跟某条线路有关的告警行都打开那条线路的
  详情，在详情第一页直接改。
  节点池（NodePoolsSection，效果图 ⑤）是另一个页签：节点池、入口组、出口组合成一种卡。
*/

/** 告警默认只摆三行（和效果图一样），多的点开看：别把下面的线路卡挤出一屏。 */
const ALERT_ROWS_SHOWN = 3;

export function LineWorkspace({ searchQuery = "", isAdmin = false }: { searchQuery?: string; isAdmin?: boolean }) {
  const board = trpc.lineDiagnostics.lineWorkspace.useQuery({ hours: 24 }, { refetchInterval: 30_000, staleTime: 10_000 });
  const data = board.data;
  const [allAlerts, setAllAlerts] = useState(false);
  // 告警行和下面的线路卡点开的是同一个线路详情（在里面直接改）。开着时地址栏带 ?line=<规则 id>，复制下来就能分享（lineLinks.ts）
  const [openRuleId, setOpenRuleId] = useSearchIdParam(LINE_PARAM);
  const alerts = data?.recent || [];
  const shownAlerts = allAlerts ? alerts : alerts.slice(0, ALERT_ROWS_SHOWN);
  return (
    <div className="fx-line-ui flex min-w-0 flex-col gap-3" data-testid="line-workspace">
      <LineTitle
        title="线路概览"
        sub={data ? `${data.lines} 条线路 · ${data.hosts.total} 台机器 · 近 ${data.hours} 小时` : "在读线路…"}
      />
      <LineCard className="grid grid-cols-3 gap-1.5 text-center" data-testid="line-workspace-stats">
        <div>
          <LineBig tone="text" size={26} value={data ? data.hosts.online : "—"} unit={<span className="text-muted-foreground">/{data ? data.hosts.total : "—"}</span>} />
          <div className="mt-1 text-[11.5px] text-muted-foreground">在线节点</div>
        </div>
        <div>
          <LineBig tone={data && data.alerts > 0 ? "down" : "text"} size={26} value={data ? data.alerts : "—"} />
          <div className="mt-1 text-[11.5px] text-muted-foreground">告警</div>
        </div>
        <div>
          <LineBig tone="ok" size={26} value={data ? data.recovered : "—"} />
          <div className="mt-1 text-[11.5px] text-muted-foreground">已自动恢复</div>
        </div>
      </LineCard>
      {alerts.length > 0 ? (
        <LineCard className="px-3 py-1.5" data-testid="line-workspace-recent">
          {shownAlerts.map((item, index) => (
            <LineKv
              key={index}
              left={<><LineDot tone={item.tone as LineTone} /> <span className="truncate">{item.text}</span></>}
              right={item.ruleId > 0 ? <span className="inline-flex items-center gap-0.5">{item.action}<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></span> : item.action}
              onClick={item.ruleId > 0 ? () => setOpenRuleId(item.ruleId) : undefined}
            />
          ))}
          {alerts.length > ALERT_ROWS_SHOWN ? (
            <button type="button" className="w-full py-1.5 text-center text-[11.5px] text-muted-foreground hover:text-foreground" onClick={() => setAllAlerts(!allAlerts)} data-testid="line-workspace-more">
              {allAlerts ? "收起" : `还有 ${alerts.length - ALERT_ROWS_SHOWN} 条`}
            </button>
          ) : null}
        </LineCard>
      ) : null}
      <div>
        <LineSec left="线路" right="按状态排序" />
        <RouteBoardList searchQuery={searchQuery} isAdmin={isAdmin} openRuleId={openRuleId} onOpenRuleChange={setOpenRuleId} />
      </div>
    </div>
  );
}

/*
  节点池两种用途（2.3.500）：中转 = 线路里一层候选；落地 = 同一份落地配置开在每台上（协议、端口、密钥一样），
  订阅里整个池只出一条。2.3.499 以前的「通用」读成中转。
*/
type PoolRole = "relay" | "landing";
const ROLE_LABEL: Record<string, string> = { relay: "中转", landing: "落地", any: "中转" };
const ROLE_OPTIONS = [
  { value: "relay", label: "中转" },
  { value: "landing", label: "落地" },
] as const satisfies ReadonlyArray<{ value: PoolRole; label: string }>;
/** 弹窗标题下那一句：这种池是干什么的（2.3.501 起只留这一句，用途下面那句、每个控件下面那句都去掉了）。 */
const ROLE_DESCRIPTION: Record<PoolRole, string> = {
  relay: "线路里一层选它，面板在这几台里按整条链的延迟挑。",
  landing: "几台开同一份落地（协议、端口、密钥一样），订阅里整个池只出一条。",
};
/** 落地池最多几台（每台都要开入站，线路里一台一条路径）。 */
const MAX_LANDING_MEMBERS = 8;

type PoolDraft = { id?: number; name: string; role: PoolRole; hostIds: number[]; landing: LandingDraft; directDomain: string; configured: boolean };

function countTone(usable: number, total: number): LineTone {
  if (total === 0 || usable === 0) return "down";
  return usable === total ? "ok" : "warn";
}

export type PoolGroupMode = "entry" | "exit" | "failover";

export function NodePoolsSection({ hosts, onOpenGroup, isAdmin = false }: {
  hosts: Array<{ id: number; name: string; isOnline?: boolean | null }>;
  /** 管理员才能让组跟着节点池（改的是组的成员），才能设落地池的直连域名。 */
  isAdmin?: boolean;
  /** 点入口组 / 出口组的卡：到它原来那一页打开编辑。 */
  onOpenGroup?: (mode: PoolGroupMode, groupId: number) => void;
}) {
  const utils = trpc.useUtils();
  const [, setLocation] = useLocation();
  const board = trpc.nodePools.board.useQuery(undefined, { staleTime: 15_000, refetchInterval: 30_000 });
  const refresh = () => {
    void utils.nodePools.board.invalidate();
    void utils.nodePools.list.invalidate();
  };
  const save = trpc.nodePools.save.useMutation({
    onSuccess: (result) => {
      refresh();
      setEditing(null);
      const groups = result.groups || [];
      const changed = groups.filter((group) => !group.error && group.added + group.removed > 0).length;
      const landing = result.landing;
      const parts = [
        landing ? `${landing.open}/${landing.total} 台开好了${landing.fallback ? `（${landing.fallback} 台换了端口）` : ""}` : "",
        result.reexpanded ? `${result.reexpanded} 条${landing ? "转发" : "线路"}跟着更新` : "",
        changed ? `${changed} 个组跟着换了成员` : "",
      ].filter(Boolean);
      toast.success(parts.length ? `已保存，${parts.join("，")}` : "已保存");
      if (landing?.credentialsReset) toast.warning("换了协议或加密方式，凭据整份换新：客户端要重新拉订阅");
      if (landing && landing.errors.length) toast.warning(`${landing.errors.length} 台没开出来：${landing.errors.map((item) => `${hostName(item.hostId)}：${item.error}`).join("；")}`);
      if (landing?.dnsError) toast.warning(landing.dnsError);
      const failed = groups.filter((group) => group.error || group.skipped);
      if (failed.length) toast.warning(`${failed.length} 个跟着这个池的组没同步：${failed.map((group) => group.error || group.skipped).join("；")}`);
      if (changed) void utils.forwardGroups.invalidate();
      if (landing) {
        void utils.proxyInbounds.list.invalidate();
        void utils.proxySubscriptions.listNodes.invalidate();
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const rotate = trpc.nodePools.rotate.useMutation({
    onSuccess: (result) => {
      refresh();
      void utils.proxyInbounds.list.invalidate();
      toast.success(`密钥换好了：${result.open}/${result.total} 台已换上，客户端要重新拉订阅`);
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = trpc.nodePools.delete.useMutation({
    onSuccess: () => { refresh(); setEditing(null); toast.success("已删掉"); },
    onError: (error) => toast.error(error.message),
  });
  // 落地池直连域名「自动」（2.3.501，管理员）：每点一次起一个新的，所以是 mutation
  const suggestDomain = trpc.nodePools.suggestDomain.useMutation({
    onSuccess: (result) => {
      if (result.domain) setEditing((current) => (current ? { ...current, directDomain: result.domain || "" } : current));
      else toast.warning(result.reason || "没起出域名，自己填一个");
    },
    onError: (error) => toast.error(error.message),
  });
  const followPool = trpc.forwardGroups.followPool.useMutation({
    onSuccess: (result, input) => {
      refresh();
      void utils.forwardGroups.invalidate();
      if (input.poolId === null) toast.success("不再跟着节点池，成员留着现在这些");
      else if (result.skipped) toast.warning(result.skipped);
      else toast.success(result.added + result.removed > 0 ? `跟上了：加了 ${result.added} 台、去掉 ${result.removed} 台` : "跟上了：成员和池里一样");
    },
    onError: (error) => toast.error(error.message),
  });
  const [editing, setEditing] = useState<PoolDraft | null>(null);
  const hostName = (id: number) => hosts.find((host) => host.id === id)?.name || `主机 ${id}`;
  const data = board.data;
  const entryGroups = data?.entryGroups || [];
  const exitGroups = data?.exitGroups || [];
  const nodePools = data?.nodePools || [];
  /** 建池框里「从组带入」：有成员的入口组、出口组，带入它们的机器。 */
  const importable = useMemo(() => [
    ...entryGroups.map((group) => ({ key: `e${group.id}`, label: `入口组 · ${group.domain || group.name}`, hostIds: group.members.map((member) => member.hostId) })),
    ...exitGroups.map((group) => ({ key: `x${group.id}`, label: `出口组 · ${group.name}`, hostIds: group.members.map((member) => member.hostId) })),
  ].filter((group) => group.hostIds.length > 0), [entryGroups, exitGroups]);
  const openPool = (pool: (typeof nodePools)[number]) => setEditing({
    id: pool.id,
    name: pool.name,
    role: pool.role === "landing" ? "landing" : "relay",
    hostIds: pool.hostIds,
    landing: landingDraftFrom((pool.landing?.config as LandingConfigView) ?? null),
    directDomain: pool.landing?.directDomain || "",
    configured: !!pool.landing?.configured,
  });
  const newPool = (role: PoolRole): PoolDraft => ({ name: "", role, hostIds: [], landing: landingDraftFrom(null), directDomain: "", configured: false });
  const draftError = editing?.role === "landing" ? (editing.hostIds.length > MAX_LANDING_MEMBERS ? `落地池最多 ${MAX_LANDING_MEMBERS} 台` : landingDraftError(editing.landing)) : "";
  const submit = () => {
    if (!editing) return;
    save.mutate({
      id: editing.id,
      name: editing.name.trim(),
      role: editing.role,
      hostIds: editing.hostIds,
      // 直连域名只有管理员送（2.3.501）：别人不送 = 不改，服务端也拦
      ...(editing.role === "landing" ? { landing: landingInputFromDraft(editing.landing), ...(isAdmin ? { directDomain: editing.directDomain.trim() || null } : {}) } : {}),
    });
  };
  const editingFollowers = editing?.id ? nodePools.find((pool) => pool.id === editing.id)?.followers || [] : [];
  /*
    组的成员跟不跟节点池：跟着的，卡底下一个醒目的 chip（这是要一眼看见的状态）；没跟的只在说明
    后面挂一个不起眼的「跟着节点池」—— 每张卡都摆一个「成员：手动加减」太吵。
  */
  const followMenu = (group: { id: number; poolId: number | null; poolName: string | null }, inHint: boolean) => {
    if (!isAdmin || inHint !== !group.poolId || (!group.poolId && nodePools.length === 0)) return null;
    return <PoolFollowMenu inline={inHint} poolId={group.poolId} poolName={group.poolName} pools={nodePools} busy={followPool.isPending} onPick={(poolId) => followPool.mutate({ groupId: group.id, poolId })} />;
  };

  return (
    <div className="fx-line-ui flex min-w-0 flex-col gap-3" data-testid="node-pools">
      {/*
        新建只有一个入口，在标题右边：中转池、落地池两行（2.3.501）。入口组、出口组、转发组各有自己的页签，
        在那里新建；这里只摆它们的卡（2.3.498–2.3.500 的菜单里也能建，五行带小字，挤）。
      */}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <LineTitle title="节点池" sub="中转池当线路一层候选，落地池几台一份配置" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" className="mt-1 h-8 shrink-0 gap-1 rounded-full px-3" data-testid="node-pool-new">
              <Plus className="h-3.5 w-3.5" />新建
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-32">
            <DropdownMenuItem onSelect={() => setEditing(newPool("relay"))} data-testid="node-pool-new-pool">中转池</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setEditing(newPool("landing"))} data-testid="node-pool-new-landing">落地池</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {board.isLoading ? <p className="px-1 text-[12.5px] text-muted-foreground">在读节点池…</p> : null}

      {nodePools.length > 0 && entryGroups.length + exitGroups.length > 0 ? <LineSec left="中转池 / 落地池" right={`${nodePools.length} 个`} /> : null}
      {nodePools.map((pool) => pool.role === "landing" ? (
        <LandingPoolCard key={`p${pool.id}`} pool={pool} onOpen={() => openPool(pool)} />
      ) : (
        <LineCard
          key={`p${pool.id}`}
          className="cursor-pointer hover:border-[var(--fx-stroke)]"
          role="button"
          tabIndex={0}
          onClick={() => openPool(pool)}
          onKeyDown={(event) => { if (event.key === "Enter") openPool(pool); }}
          data-testid="node-pool-card"
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <b className="truncate text-[14px]">{pool.name}</b>
              <LinePill tone="acc">{ROLE_LABEL[pool.role as PoolRole] || "中转"}</LinePill>
            </div>
            <LinePill tone={countTone(pool.usable, pool.total)}>{pool.usable}/{pool.total}</LinePill>
          </div>
          <div className="mt-[10px] flex flex-wrap gap-1.5">
            {pool.members.map((member) => (
              <LineChip key={member.hostId}>
                <LineDot tone={member.tone} />
                {member.name}
                {/* 和效果图一样：颜色只放在点上，状态字照常色 */}
                {member.state ? <span>{member.state}</span> : <LineMs value={member.latencyMs ?? undefined} />}
              </LineChip>
            ))}
          </div>
          <LineHint>
            用在 {pool.lines} 条线路{pool.pick ? ` · 挑法：${pool.pick}` : ""}
            {pool.followers.length ? ` · ${pool.followers.join("、")} 的成员跟着这个池` : ""}
          </LineHint>
        </LineCard>
      ))}

      {entryGroups.length > 0 ? <LineSec left="入口组" right={`${entryGroups.length} 个`} /> : null}
      {entryGroups.map((group) => (
        <LineCard
          key={`e${group.id}`}
          className={onOpenGroup ? "cursor-pointer hover:border-[var(--fx-stroke)]" : undefined}
          onClick={() => onOpenGroup?.(group.mode, group.id)}
          title={group.domain ? `${group.name}（${group.domain}）` : group.name}
          data-testid="entry-pool-card"
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <b className="truncate text-[14px]">{group.domain || group.name}</b>
              <LinePill tone="acc">{group.mode === "failover" ? "入口 · 主备" : group.domain ? "入口 · DNS" : "入口"}</LinePill>
            </div>
            <LinePill tone={countTone(group.usable, group.total)}>{group.usable}/{group.total}</LinePill>
          </div>
          <div className="mt-2 flex flex-col gap-[5px]">
            {group.members.map((member) => {
              const bad = member.tone === "down";
              return (
                <LineRow key={member.memberId} bad={bad} className={bad ? "border-[var(--fx-down-text)] bg-[var(--fx-down-soft)]" : undefined}>
                  <LineDot tone={member.tone as LineTone} />
                  <LinePath bad={bad} className={bad ? "font-mono" : "font-mono text-foreground"} title={member.name}>{member.value}</LinePath>
                  <LinePill tone={bad ? "down" : member.tone === "warn" ? "warn" : "gray"}>{member.state}</LinePill>
                </LineRow>
              );
            })}
          </div>
          <LineHint>
            {group.mode === "failover"
              ? `${group.domain && group.autoDns && group.provider ? `${group.provider} · ` : ""}在用的坏了切到下一台${group.autoFailback ? "，恢复稳定后切回" : ""}`
              : group.autoDns && group.provider
                ? `${group.provider} · 坏了自动摘记录，恢复稳定后加回`
                : group.domain ? "没开自动解析：坏了不会摘记录" : "没有入口域名：成员各自用自己的地址"}
            {followMenu(group, true)}
          </LineHint>
          {followMenu(group, false)}
        </LineCard>
      ))}

      {exitGroups.length > 0 ? <LineSec left="出口组" right={`${exitGroups.length} 个`} /> : null}
      {exitGroups.map((group) => (
        <LineCard
          key={`x${group.id}`}
          className={onOpenGroup ? "cursor-pointer hover:border-[var(--fx-stroke)]" : undefined}
          onClick={() => onOpenGroup?.("exit", group.id)}
          data-testid="exit-pool-card"
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <b className="truncate text-[14px]">{group.name}</b>
              <LinePill tone="acc">出口</LinePill>
            </div>
            <LinePill tone={countTone(group.usable, group.total)}>{group.usable}/{group.total}</LinePill>
          </div>
          <div className="mt-[10px] flex flex-wrap gap-1.5">
            {group.members.map((member) => (
              <LineChip key={member.hostId} title={member.name}>
                {member.tone !== "ok" ? <LineDot tone={member.tone as LineTone} /> : null}
                {member.label}
                {member.state ? <span>{member.state}</span> : null}
              </LineChip>
            ))}
          </div>
          <LineHint>
            {group.members.some((member) => member.checked)
              ? `流媒体 / AI 按解锁结果自动分流，其余${group.strategy === "fallback" || group.strategy === "none" ? "按顺序走" : LINK_SPREAD_LABELS[group.strategy as keyof typeof LINK_SPREAD_LABELS]?.label || "轮流走"}`
              : "还没做过出口检测：到主机详情「流媒体 / AI 解锁」测一次，订阅里才能按解锁结果分流"}
            {followMenu(group, true)}
          </LineHint>
          {followMenu(group, false)}
        </LineCard>
      ))}

      {data && nodePools.length + entryGroups.length + exitGroups.length === 0 ? (
        <p className="px-1 text-[12.5px] text-muted-foreground">还没有池。建一个中转池，线路里一层直接选它；或者建一个落地池，几台开同一份落地。入口组、出口组也会在这里一起看。</p>
      ) : null}

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        {editing ? (
          // 打开时不自动聚焦名字：手机上会直接弹键盘、盖住半个框（和线路详情一样）
          <DialogContent className="sm:max-w-md" onOpenAutoFocus={(event) => event.preventDefault()}>
            <DialogHeader>
              <DialogTitle>{`${editing.id ? "编辑" : "新建"}${editing.role === "landing" ? "落地池" : "中转池"}`}</DialogTitle>
              <DialogDescription>
                {ROLE_DESCRIPTION[editing.role]}
                {/* 新建落地节点的主入口在订阅管理（2.3.506）：只开一台的不用建池 */}
                {editing.role === "landing" && !editing.id ? (
                  <> 只开一台的，到<a href="/client-subscriptions?create=node" onClick={(event) => { event.preventDefault(); setEditing(null); setLocation("/client-subscriptions?create=node"); }} className="text-primary hover:underline" data-testid="node-pool-single-landing">订阅管理新建节点</a>。</>
                ) : null}
              </DialogDescription>
            </DialogHeader>
            {/*
              2.3.501 起照 iOS 设置排：一张白卡写名字（改已有的池再多一行「用途」），一张白卡放机器，落地池再加
              「落地配置」「用户」「直连域名」三张；卡里不带框，值写在右边。新建时用途已经在「新建」菜单里选了，
              不再摆「中转 | 落地」。fx-line-ui：机器 chip、「加机器」跟线路那几屏一样大（不被触屏 44px 撑高）。
            */}
            <div className="fx-line-ui flex min-w-0 flex-col gap-[18px]">
              <LineFormGroup>
                <LineFormRow label="名字">
                  <LineBareInput value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value.slice(0, 60) })} placeholder={editing.role === "landing" ? "例如：香港落地池" : "例如：香港中转池"} aria-label="节点池名字" />
                </LineFormRow>
                {editing.id ? (
                  <LineFormRow label="用途">
                    <div className="w-[8.5rem]">
                      <LineSegmented ariaLabel="节点池用途" value={editing.role} options={ROLE_OPTIONS} onChange={(role) => setEditing({ ...editing, role })} />
                    </div>
                  </LineFormRow>
                ) : null}
              </LineFormGroup>
              <LineField
                label={<>机器<span data-testid="node-pool-count">· {editing.hostIds.length}{editing.role === "landing" ? `/${MAX_LANDING_MEMBERS}` : ""} 台</span></>}
                aside={importable.length > 0 ? (
                  /* 现有入口组 / 出口组的机器一次带进来 */
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className="inline-flex items-center gap-0.5 text-[12px] font-medium text-[var(--fx-accent)]" data-testid="node-pool-from-group">
                        从组带入<ChevronDown className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-60">
                      {importable.map((group) => (
                        <DropdownMenuItem
                          key={group.key}
                          onSelect={() => setEditing({ ...editing, hostIds: Array.from(new Set([...editing.hostIds, ...group.hostIds])) })}
                        >
                          <span className="min-w-0 truncate">{group.label}</span>
                          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{group.hostIds.length} 台</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                footer={editingFollowers.length ? (
                  <span data-testid="node-pool-followers">
                    {editingFollowers.join("、")} 的成员跟着这个池：这里加减机器，{editingFollowers.length > 1 ? "它们" : "它"}的成员也跟着加减。
                  </span>
                ) : null}
              >
                <LineFormGroup className="py-3 pr-[14px]">
                  <div className="flex flex-wrap gap-1.5">
                    {editing.hostIds.map((hostId) => (
                      <LineChip key={hostId} className={cn(LINE_GRAY_BG, "border-transparent py-[4px] pl-[10px] pr-[7px] text-[12px]")}>
                        {hostName(hostId)}
                        <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`去掉 ${hostName(hostId)}`} onClick={() => setEditing({ ...editing, hostIds: editing.hostIds.filter((id) => id !== hostId) })}><X className="h-3 w-3" /></button>
                      </LineChip>
                    ))}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <LineChipButton variant="add" className="py-[4px] text-[12px]" disabled={editing.role === "landing" && editing.hostIds.length >= MAX_LANDING_MEMBERS} data-testid="node-pool-add-host"><Plus className="h-3 w-3" />加机器</LineChipButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="max-h-72">
                        {hosts.filter((host) => !editing.hostIds.includes(host.id)).map((host) => (
                          <DropdownMenuItem key={host.id} onSelect={() => setEditing({ ...editing, hostIds: [...editing.hostIds, host.id] })}>{host.name}{host.isOnline === false ? "（离线）" : ""}</DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </LineFormGroup>
              </LineField>
              {editing.role === "landing" ? (
                <LandingPoolFields
                  draft={editing.landing}
                  onChange={(landing) => setEditing({ ...editing, landing })}
                  directDomain={editing.directDomain}
                  onDirectDomainChange={(directDomain) => setEditing({ ...editing, directDomain })}
                  domainEditable={isAdmin}
                  suggesting={suggestDomain.isPending}
                  onSuggestDomain={isAdmin ? () => suggestDomain.mutate({ name: editing.name.trim() || undefined, hostIds: editing.hostIds }) : undefined}
                  editing={!!editing.id && editing.configured}
                  rotating={rotate.isPending}
                  onRotate={editing.id ? () => { if (window.confirm("换掉这个落地池的全部凭据和密钥？每台一起换，客户端要重新拉订阅。")) rotate.mutate({ id: editing.id! }); } : undefined}
                />
              ) : null}
              {draftError ? <p className="px-[14px] text-[12px] text-[var(--fx-warn-text)]">{draftError}</p> : null}
            </div>
            <DialogFooter>
              {editing.id ? (
                <Button type="button" variant="ghost" className="mr-auto text-[var(--fx-down-text)]" disabled={remove.isPending} onClick={() => remove.mutate({ id: editing.id! })}>删掉这个池</Button>
              ) : null}
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button>
              <Button type="button" disabled={!editing.name.trim() || editing.hostIds.length === 0 || !!draftError || save.isPending} onClick={submit} data-testid="node-pool-save">保存</Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

type PoolBoardPool = inferRouterOutputs<AppRouter>["lineDiagnostics"]["poolBoard"]["nodePools"][number];

/**
 * 落地池的卡（2.3.500）：协议一句话、每台开在哪个端口（换了端口的标出来、没开出来的说为什么）、
 * 订阅里一条、用在几条转发。点开是同一个编辑框。
 */
function LandingPoolCard({ pool, onOpen }: { pool: PoolBoardPool; onOpen: () => void }) {
  const landing = pool.landing;
  const states = new Map((landing?.members || []).map((member) => [member.hostId, member]));
  const open = pool.members.filter((member) => states.get(member.hostId)?.open && member.tone === "ok").length;
  return (
    <LineCard
      className="cursor-pointer hover:border-[var(--fx-stroke)]"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}
      data-testid="landing-pool-card"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <b className="truncate text-[14px]">{pool.name}</b>
          <LinePill tone="acc">落地</LinePill>
        </div>
        <LinePill tone={landing?.configured ? countTone(open, pool.total) : "gray"}>{landing?.configured ? `${open}/${pool.total}` : "未配置"}</LinePill>
      </div>
      {landing?.configured ? (
        <p className="mt-1.5 truncate font-mono text-[11.5px] text-muted-foreground" data-testid="landing-pool-summary">
          {landing.summary}{landing.directDomain ? ` · 直连 ${landing.directDomain}` : ""}
        </p>
      ) : null}
      <div className="mt-[10px] flex flex-wrap gap-1.5">
        {pool.members.map((member) => {
          const state = states.get(member.hostId);
          const failed = !!landing?.configured && !!state?.error;
          return (
            <LineChip key={member.hostId} title={failed ? String(state?.error) : state?.portFallback ? `池的端口 ${landing?.config?.port} 在这台被占了，换成了 ${state.port}` : undefined}>
              <LineDot tone={failed ? "down" : member.tone} />
              {member.name}
              {failed ? <span>没开</span> : member.state ? <span>{member.state}</span> : state?.port ? <span className="font-mono">{state.port}{state.portFallback ? "（换了端口）" : ""}</span> : null}
            </LineChip>
          );
        })}
      </div>
      <LineHint>
        {landing?.configured
          ? `订阅里一条${landing.directDomain ? "（直连走域名）" : "，只走中转"} · 用在 ${landing.rules} 条转发`
          : "还没配落地协议：点开选协议和端口，面板在每台上开一样的"}
      </LineHint>
    </LineCard>
  );
}

/** 入口组 / 出口组卡上：组的成员跟着哪个节点池（池里加减机器，组的成员跟着加减）。 */
function PoolFollowMenu({ inline, poolId, poolName, pools, busy, onPick }: {
  /** 没跟池时挂在说明那行后面的小字；跟着池时是卡底下的 chip。 */
  inline: boolean;
  poolId: number | null;
  poolName: string | null;
  pools: ReadonlyArray<{ id: number; name: string; role: string; total: number }>;
  busy: boolean;
  onPick: (poolId: number | null) => void;
}) {
  // 卡本身点一下是去编辑这个组；菜单在 portal 里，点击照样会冒泡到卡上，得拦住
  const stop = (event: SyntheticEvent) => event.stopPropagation();
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {inline ? (
          <button type="button" disabled={busy} className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50" data-testid="group-follow-pool">
            跟着节点池<ChevronDown className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : (
          <LineChipButton variant="sel" disabled={busy} className="max-w-full" data-testid="group-follow-pool">
            <span className="min-w-0 truncate">成员跟着「{poolName || `节点池 ${poolId}`}」</span>
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          </LineChipButton>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] w-64 overflow-y-auto" onClick={stop}>
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">跟着一个节点池：池里加减机器，组的成员跟着加减</DropdownMenuLabel>
        {pools.map((pool) => (
          <DropdownMenuItem key={pool.id} disabled={pool.total === 0} onSelect={() => { if (pool.id !== poolId) onPick(pool.id); }}>
            <Check className={pool.id === poolId ? "h-3.5 w-3.5 shrink-0" : "h-3.5 w-3.5 shrink-0 opacity-0"} aria-hidden="true" />
            <span className="min-w-0 truncate">{pool.name}</span>
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{ROLE_LABEL[pool.role as PoolRole] || "中转"} · {pool.total} 台</span>
          </DropdownMenuItem>
        ))}
        {poolId ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onPick(null)}>不跟了：成员留着现在这些，以后手动加减</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return inline
    ? <span onClick={stop}>{" · "}{menu}</span>
    : <div className="mt-2 flex" onClick={stop}>{menu}</div>;
}
