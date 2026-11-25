/**
 * 「订阅内容」弹窗：客户端会拿到什么、还差什么。
 *
 * 从「订阅管理」页面里拆出来、由页面 lazy 引入：它有五百多行、只在点开时才用得上，
 * 跟着页面一起进包等于每次进订阅页都先下载一份看不到的东西。
 *
 * 这里的开关都是乐观的（OptimisticSwitch）：拨下去当场变，失败弹回。每个写操作只让自己
 * 影响到的查询失效 —— 改转发的显隐只动 preview；改节点（直连 / 选路）要连 listNodes 一起，
 * 因为节点行上也显示这些；令牌列表一律不碰。失效的 promise 从 onSuccess 返回出去，
 * mutateAsync 就会等到重取落地才算完 —— 不然乐观开关跑完一轮会按旧的外部值闪一下。
 */

import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { PreviewRouteDetail } from "@/components/proxy/PreviewRouteDetail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OptimisticSwitch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import {
  PROXY_NODE_AUTO_GROUPS,
  PROXY_NODE_AUTO_GROUP_LABELS,
  normalizeProxyNodeAutoGroup,
  type ProxyNodeAutoGroup,
} from "@shared/proxySubscriptionPlan";
import { AlertTriangle, ChevronDown, EyeOff, Pencil, Plug, Zap } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { NODE_COLLAPSED_STORAGE_KEY, readStoredCollapsed, writeStoredPref } from "./proxyNodeViewPrefs";
import type { ProxyPreviewRenameTarget } from "./ProxyPreviewRenameDialog";
import { summarizeProxyPreview } from "./proxyPreviewSummary";

/** 弹窗要看的节点字段。页面上的节点列表是服务端拼出来的宽对象，这里只认用到的。 */
export type ProxyPreviewOwnerNode = {
  id: number;
  name?: string | null;
  sharedFrom?: unknown;
  frontProxyId?: number | null;
  autoGroup?: string | null;
  publicLabel?: string | null;
  remark?: string | null;
  isEnabled?: boolean | null;
  address?: string | null;
  port?: number | null;
};

/**
 * 订阅内容的两类条目。
 *
 * 中转在前：那是主力 —— 直连条目只有开了「加进订阅」的节点才有，通常只有一两条，
 * 而且落地 IP 直接暴露在订阅里，放后面不容易被误当成常规入口。
 */
const PREVIEW_GROUPS = [
  { key: "relay", label: "中转" },
  { key: "direct", label: "直连" },
] as const;

/**
 * 子块小标题：一行文字 + 一条细横线。
 *
 * 这张卡里原本有五个子块，各用一种样式 —— 彩色框、虚线框、灰底框、纯标题。
 * 样式不同会让人以为它们是不同性质的东西，其实都只是「订阅里的一部分」。
 * 统一成同一条线之后，视觉重量交还给内容本身。
 */
function SectionLabel({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span>{children}</span>
      {count !== undefined ? <span className="tabular-nums">({count})</span> : null}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: ReadonlyArray<ProxyPreviewOwnerNode>;
  /** 点铅笔：改名弹窗归页面管（它和这个弹窗并列，不嵌套）。 */
  onRename: (target: ProxyPreviewRenameTarget) => void;
};

export default function ProxySubscriptionPreviewDialog({ open, onOpenChange, nodes, onRename }: Props) {
  // 和页面同一个查询键：页面要它算概览条上的数字，这里直接吃缓存，不多发请求。
  const previewQuery = trpc.proxySubscriptions.preview.useQuery();
  const summary = useMemo(() => summarizeProxyPreview(previewQuery.data), [previewQuery.data]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>订阅内容</DialogTitle>
          <DialogDescription className="text-xs">
            客户端拉到的就是这些。
            {summary.nodes.length > 0 ? (
              <>
                {" "}共 {summary.nodes.length} 条
                {summary.relayNodes.length > 0 ? ` · 中转 ${summary.relayNodes.length}` : ""}
                {summary.directNodes.length > 0 ? ` · 直连 ${summary.directNodes.length}` : ""}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {/* 正文单独一个组件：折叠 / 展开这些状态跟着 Content 一起卸载，下次打开从本地偏好重读。 */}
        <PreviewBody nodes={nodes} onRename={onRename} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ nodes, onRename, onClose }: { nodes: ReadonlyArray<ProxyPreviewOwnerNode>; onRename: Props["onRename"]; onClose: () => void }) {
  const utils = trpc.useUtils();
  // 同一个查询键，吃外面那一份缓存；在这里再 useQuery 一次只是为了拿到带类型的 data，不多发请求。
  const previewQuery = trpc.proxySubscriptions.preview.useQuery();
  const hideUnreachableQuery = trpc.proxySubscriptions.hideUnreachable.useQuery();
  const preview = previewQuery.data;
  const summary = useMemo(() => summarizeProxyPreview(preview), [preview]);
  const { directNodes, relayNodes, hiddenRules, unboundRules, otherSkipped, driftedRules, unusedNodes, hostOfflineNodes } = summary;
  const previewNodes = summary.nodes;

  const invalidatePreview = () => utils.proxySubscriptions.preview.invalidate();
  const invalidateNodesAndPreview = () => Promise.all([
    utils.proxySubscriptions.listNodes.invalidate(),
    utils.proxySubscriptions.preview.invalidate(),
  ]);
  const onError = (error: { message?: string }) => toast.error(error.message || "保存失败");

  const setHideUnreachable = trpc.proxySubscriptions.setHideUnreachable.useMutation({
    onSuccess: () => Promise.all([utils.proxySubscriptions.hideUnreachable.invalidate(), invalidatePreview()]),
    onError,
  });
  const setRuleVisible = trpc.proxySubscriptions.setRuleVisible.useMutation({ onSuccess: invalidatePreview, onError });
  // 自动选路组里每条入口的「进组」开关（2.3.545，用户：4 台 HKT 只想用两台）
  const setRuleAutoGroupMember = trpc.proxySubscriptions.setRuleAutoGroupMember.useMutation({ onSuccess: invalidatePreview, onError });
  // 这里的 updateNode 只改直连 / 选路两件事：节点行上也显示它们，所以连 listNodes 一起重取。
  const updateNode = trpc.proxySubscriptions.updateNode.useMutation({ onSuccess: invalidateNodesAndPreview, onError });
  const bindRule = trpc.proxySubscriptions.bindRule.useMutation({
    onSuccess: () => {
      toast.success("已加入订阅");
      return invalidateNodesAndPreview();
    },
    onError,
  });
  /**
   * 「指向已经变了」那张卡上直接改绑。
   *
   * 同一个 bindRule 接口，分开一个实例只为了提示语：那边是「加入订阅」，这边是
   * 「改绑」或「移出」—— 用户在订阅这一屏就把事办了，不必再去转发页找这条规则。
   */
  const rebindRule = trpc.proxySubscriptions.bindRule.useMutation({
    onSuccess: (_data, variables) => {
      toast.success(variables.proxyNodeId === null ? "已移出订阅" : "已改绑落地节点");
      return invalidateNodesAndPreview();
    },
    onError,
  });

  /** 折叠起来的分组键（中转 / 直连）。记在本地，下次进来还是折着的。 */
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(readStoredCollapsed);
  const isGroupCollapsed = (key: string) => collapsedGroups.includes(key);
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key];
      writeStoredPref(NODE_COLLAPSED_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };
  // 展开看线路的那一条（rule-<id> / direct-<模板 id>）。
  const [expandedPreviewKey, setExpandedPreviewKey] = useState<string | null>(null);

  /**
   * 直连条目的开关写的是节点模板的「直连也放进订阅」（includeDirect）。
   * 只有自己的节点能改；被别的节点当前置代理引用的，订阅里必须出现，不给关。
   */
  const ownNodeById = useMemo(
    () => new Map(nodes.filter((node) => !node.sharedFrom).map((node) => [Number(node.id), node])),
    [nodes],
  );
  const frontReferencedNodeIds = useMemo(
    () => new Set(nodes.map((node) => Number(node.frontProxyId || 0)).filter((id) => id > 0)),
    [nodes],
  );
  /**
   * 模板 id → 那一条直连要标什么。订阅内容这边只有 templateId，标注在节点行上。
   *
   * 对外标注优先：分享进来的节点被抹掉了备注（那是对方的账本），只剩这一句 ——
   * 而它恰恰是收方最需要的（这条线是家宽还是 IEPL）。自己的节点两个都在时也用它：
   * 这一屏说的是客户端会拿到什么，那是对外的口径。
   */
  const remarkByTemplateId = useMemo(() => {
    const map = new Map<number, string>();
    for (const node of nodes) {
      const label = String(node.publicLabel || "").trim() || String(node.remark || "").trim();
      if (label) map.set(Number(node.id), label);
    }
    return map;
  }, [nodes]);
  const enabledNodes = useMemo(() => nodes.filter((node) => node.isEnabled), [nodes]);

  /** 自己的节点里，有两条以上入口、选路方式却是「不生成」的：自动选路组那段要给它们留一行改回去。 */
  const offGroupOwners = useMemo(() => {
    const counts = new Map<number, number>();
    for (const node of previewNodes) {
      const id = Number(node.templateId || 0);
      if (id > 0) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .filter(([id, count]) => count >= 2 && normalizeProxyNodeAutoGroup(ownNodeById.get(id)?.autoGroup) === "off")
      .map(([id, count]) => ({ owner: ownNodeById.get(id)!, count }));
  }, [previewNodes, ownNodeById]);

  /**
   * 选路方式不是「不生成」、入口也够两条，组却没生成：是「进组」开关关得只剩一台了。
   * 组没了卡片也没了的话开关就再也找不回来，所以这种落地留一张卡，开关照常。
   */
  const trimmedGroupOwners = useMemo(() => {
    const counts = new Map<number, number>();
    for (const node of previewNodes) {
      const id = Number(node.templateId || 0);
      if (id > 0 && node.kind !== "direct") counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const generated = new Set((preview?.groups ?? []).map((group) => Number(group.templateId || 0)));
    return Array.from(counts.entries())
      .filter(([id, count]) => count >= 2 && !generated.has(id) && !!ownNodeById.get(id) && normalizeProxyNodeAutoGroup(ownNodeById.get(id)?.autoGroup) !== "off")
      .map(([id]) => ownNodeById.get(id)!);
  }, [preview, previewNodes, ownNodeById]);

  /** 一个落地的自动选路组卡片里的入口清单：每条一个「进组」开关；直连那条没有开关；暂时不通的灰着。 */
  const renderGroupMembers = (templateId: number, mode: ProxyNodeAutoGroup, weighted: boolean) => {
    const entries = previewNodes.filter((node) => Number(node.templateId) === templateId);
    const relays = entries.filter((node) => node.kind !== "direct");
    const unreachable = (preview?.skipped ?? []).filter((item) => item.reason === "unreachable" && Number(item.templateId) === templateId);
    const inGroup = entries.filter((node) => node.autoGroupMember !== false && (mode !== "load-balance" || node.kind !== "direct"));
    const left = relays.length - relays.filter((node) => node.autoGroupMember !== false).length;
    return (
      <>
        <ul className="mt-1.5 divide-y divide-border/60 border-t border-border/60">
          {entries.map((node) => (
            <li key={`${node.kind}-${node.ruleId}`} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-foreground">
                {node.name}
                {node.kind === "direct"
                  ? <span className="text-muted-foreground"> · 落地直连{mode === "load-balance" ? "，负载均衡不带它" : ""}</span>
                  : node.hostName ? <span className="text-muted-foreground"> · {node.hostName}</span> : null}
              </span>
              {node.kind !== "direct" ? (
                <OptimisticSwitch
                  aria-label={`${node.name} 进组`}
                  className="shrink-0 scale-90"
                  checked={node.autoGroupMember !== false}
                  onCheckedChangeAsync={(checked) => setRuleAutoGroupMember.mutateAsync({ ruleId: Number(node.ruleId), member: checked })}
                />
              ) : null}
            </li>
          ))}
          {unreachable.map((item) => (
            <li key={`unreachable-${item.ruleId}`} className="flex items-center gap-2 py-1.5 opacity-70">
              <span className="min-w-0 flex-1 truncate">
                {item.nodeName || item.ruleName}
                <span className="text-[var(--fx-warn-text)]"> · 暂时不通，通了自动回来</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-1">
          {inGroup.length >= 2
            ? `组里 ${inGroup.length} 台：${inGroup.map((node) => node.name).join(" / ")}`
            : `组里只剩 ${inGroup.length} 台，不够两台不生成组`}
          {left > 0 ? ` · 另 ${left} 条入口只做裸节点，客户端里还能手动选` : ""}
          {weighted ? "（按带宽分连接，Clash / Mihomo 生效）" : ""}
        </p>
      </>
    );
  };

  const autoGroupSelect = (owner: ProxyPreviewOwnerNode, value: ProxyNodeAutoGroup) => (
    <Select
      value={value}
      onValueChange={(next) => updateNode.mutate({ id: Number(owner.id), autoGroup: next as ProxyNodeAutoGroup })}
      disabled={updateNode.isPending}
    >
      <SelectTrigger aria-label={`「${String(owner.name || "")}」的选路方式`} className="h-7 w-32 shrink-0 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PROXY_NODE_AUTO_GROUPS.map((mode) => (
          <SelectItem key={mode} value={mode}>{PROXY_NODE_AUTO_GROUP_LABELS[mode]}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <>
      <ScrollFade className="min-h-0 flex-1 overflow-y-auto pr-1">
        {/*
          客户端测延迟只测到入口，后面断了照样显示几十毫秒，负载均衡组还会把连接分给它。
          开着的话，端到端探测连续不通的转发暂时不放进订阅，通了自动回来。
        */}
        <div className="mb-3 flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium">自动隐藏不通的节点</p>
            <p data-fx-help="" className="mt-0.5 text-xs text-muted-foreground">
              端到端探测连续 3 次不通的转发暂时移出订阅，通了自动回来。客户端更新订阅后生效。
            </p>
          </div>
          <OptimisticSwitch
            aria-label="自动隐藏不通的节点"
            checked={hideUnreachableQuery.data?.enabled ?? true}
            disabled={hideUnreachableQuery.isLoading}
            onCheckedChangeAsync={(enabled) => setHideUnreachable.mutateAsync({ enabled })}
          />
        </div>
        {previewQuery.isLoading ? (
          <DataSectionLoading />
        ) : previewQuery.error && !preview ? (
          <DataSectionError
            label="订阅内容"
            error={previewQuery.error}
            retrying={previewQuery.isFetching}
            onRetry={() => { void previewQuery.refetch(); }}
          />
        ) : (
          <div className="space-y-4">
            {previewNodes.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                订阅里还没有节点。先在「我的节点」里加一个 —— 自己机器上开一个，或者粘一条别处的链接。
                指向它的转发会自动跟着进来。
              </p>
            ) : (
              <div className="space-y-3">
                {PREVIEW_GROUPS.map((group) => {
                  const groupNodes = group.key === "direct" ? directNodes : relayNodes;
                  if (groupNodes.length === 0) return null;
                  const collapsed = isGroupCollapsed(group.key);
                  return (
                    <div key={group.key} className="space-y-1.5">
                      <button
                        type="button"
                        className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground"
                        onClick={() => toggleGroup(group.key)}
                        aria-expanded={!collapsed}
                      >
                        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
                        <span>{group.label}</span>
                        <span className="tabular-nums">({groupNodes.length})</span>
                        <span className="h-px flex-1 bg-border" />
                      </button>
                      {collapsed ? null : (
                        <div className="space-y-1.5">
                          {groupNodes.map((node) => {
                            // 直连条目不来自转发规则，ruleId 都是 0 —— 拿它当 key 会互相撞。
                            const direct = node.kind === "direct";
                            const key = direct ? `direct-${node.templateId}` : `rule-${node.ruleId}`;
                            const expanded = expandedPreviewKey === key;
                            return (
                              <div key={key} className="overflow-hidden rounded-md border">
                                <div className="flex items-center gap-2 px-2.5 py-1.5">
                                  {/* 点名字那一块展开这条线路：入口 → 中转 → 落地，和落地出口（PreviewRouteDetail）。 */}
                                  <button
                                    type="button"
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                    aria-expanded={expanded}
                                    title="看这条线路怎么走"
                                    onClick={() => setExpandedPreviewKey((current) => (current === key ? null : key))}
                                  >
                                    <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`} />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="truncate text-sm font-medium leading-tight">{node.name}</span>
                                        {/*
                                          有备注就显示备注。原来一律标「直连」—— 这一段本来就叫
                                          「直连」，每条都写一遍等于没说，还占着唯一能放信息的位置。
                                        */}
                                        {direct && (
                                          <Badge variant="outline" size="sm" className="shrink-0 font-normal">
                                            {remarkByTemplateId.get(Number(node.templateId)) || "直连"}
                                          </Badge>
                                        )}
                                        {/* 开了线路组的转发：订阅里只有这一个入口，面板在几条线路之间切（中转机上的那几段不单独出节点）。 */}
                                        {!direct && node.lineGroup && (
                                          <Badge variant="outline" size="sm" className="shrink-0 font-normal" title="一个入口，面板在几条线路之间自动切">线路组</Badge>
                                        )}
                                      </div>
                                      <p className="truncate text-[11px] leading-tight text-muted-foreground">
                                        {node.address}:{node.port}
                                      </p>
                                    </div>
                                  </button>
                                  <div className="flex shrink-0 items-center gap-1">
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-7 w-7"
                                      title="改这个节点在订阅里显示的名字"
                                      aria-label={`改「${node.name}」在订阅里显示的名字`}
                                      onClick={() => onRename({
                                        kind: direct ? "direct" : "relay",
                                        ruleId: node.ruleId,
                                        templateId: node.templateId,
                                        name: node.name,
                                      })}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                    {/*
                                      中转条目的开关是这条转发的「进不进订阅」；直连条目的开关是节点模板的
                                      「直连也放进订阅」—— 关掉只藏直连，经它中转的线路照常在。
                                      分享来的节点改不了；被当前置代理引用的必须在订阅里，开关锁住。
                                    */}
                                    {!direct ? (
                                      <OptimisticSwitch
                                        aria-label={`${node.name} 进订阅`}
                                        className="scale-90"
                                        checked
                                        title="关掉只是不进订阅，转发照常运行"
                                        onCheckedChangeAsync={() => setRuleVisible.mutateAsync({ ruleId: node.ruleId, visible: false })}
                                      />
                                    ) : ownNodeById.has(Number(node.templateId)) ? (
                                      <OptimisticSwitch
                                        aria-label={`${node.name} 直连放进订阅`}
                                        className="scale-90"
                                        checked
                                        disabled={frontReferencedNodeIds.has(Number(node.templateId))}
                                        title={frontReferencedNodeIds.has(Number(node.templateId))
                                          ? "它是别的节点的前置代理，订阅里必须有它"
                                          : "关掉只藏这条直连，经它中转的线路照常在订阅里"}
                                        onCheckedChangeAsync={() => updateNode.mutateAsync({ id: Number(node.templateId), includeDirect: false })}
                                      />
                                    ) : null}
                                  </div>
                                </div>
                                {expanded ? (
                                  <PreviewRouteDetail ruleId={Number(node.ruleId || 0)} nodeId={Number(node.templateId || 0)} direct={direct} address={`${node.address}:${node.port}`} />
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {hostOfflineNodes.length > 0 && (
              <div className="space-y-2">
                <SectionLabel count={hostOfflineNodes.length}>机器还没连上面板</SectionLabel>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  这几台机器的 Agent 从没连上过 —— 配置下发不下去，节点虽然在订阅里，客户端现在连不上。
                  去「我的机器」拿安装命令，在那台机器上装好 Agent 就行。
                </p>
                {hostOfflineNodes.map((item) => (
                  <div
                    key={`host-offline-${item.nodeId}`}
                    className="space-y-1 rounded-md border border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] bg-[var(--fx-warn)]/[0.06] px-2.5 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--fx-warn-text)]" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.nodeName}</span>
                    </div>
                    <p className="break-all text-xs text-muted-foreground">
                      开在「{item.targetText}」上，这台机器的 Agent 还没装
                    </p>
                  </div>
                ))}
              </div>
            )}

            {unusedNodes.length > 0 && (
              <div className="space-y-2">
                <SectionLabel count={unusedNodes.length}>这些节点还没进订阅</SectionLabel>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  它们没开直连，也没有任何转发指向它们 —— 客户端里看不到。
                  给它建一条转发（目标填它的地址端口，会自动认出来），或者打开右边的开关让直连进订阅。
                </p>
                {unusedNodes.map((item) => (
                  <div
                    key={`unused-${item.nodeId}`}
                    className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5"
                  >
                    <Plug className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{item.nodeName}</span>
                    <span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground">{item.nodeText}</span>
                    {ownNodeById.has(Number(item.nodeId)) ? (
                      <OptimisticSwitch
                        aria-label={`${item.nodeName} 直连放进订阅`}
                        className="shrink-0 scale-90"
                        checked={false}
                        title="打开后订阅里多一条它自己的地址"
                        onCheckedChangeAsync={() => updateNode.mutateAsync({ id: Number(item.nodeId), includeDirect: true })}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {driftedRules.length > 0 && (
              <div className="space-y-2">
                <SectionLabel count={driftedRules.length}>指向已经变了</SectionLabel>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  这几条转发的目标已经不是它绑的那个节点了。线路还在订阅里，但客户端连过去是
                  拿着原来那个落地的凭据去连新目标 —— 在这里改绑成现在真正通向的那个节点，
                  或者把转发的目标改回去；这条转发不再通向任何落地的话，就移出订阅。
                </p>
                {driftedRules.map((item) => {
                  /*
                    目标正好是某个节点的地址端口时，那个节点就是答案：单独点出来，
                    一下就能改过去，不用在下拉里翻。
                  */
                  const matched = enabledNodes.find((node) =>
                    Number(node.id) !== Number(item.nodeId)
                    && `${String(node.address || "").toLowerCase()}:${Number(node.port)}` === String(item.targetText || "").toLowerCase());
                  const busy = rebindRule.isPending && rebindRule.variables?.ruleId === item.ruleId;
                  return (
                    <div
                      key={`drift-${item.ruleId}`}
                      className="space-y-1.5 rounded-md border border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] bg-[var(--fx-warn)]/[0.06] px-2.5 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--fx-warn-text)]" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.ruleName}</span>
                      </div>
                      <p className="break-all text-xs text-muted-foreground">
                        绑的是「{item.nodeName}」（{item.nodeText}），现在指向 {item.targetText}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        <Select
                          value={String(item.nodeId)}
                          disabled={busy}
                          onValueChange={(value) => {
                            if (value === String(item.nodeId)) return;
                            rebindRule.mutate({
                              ruleId: item.ruleId,
                              proxyNodeId: value === "__unbind" ? null : Number(value),
                            });
                          }}
                        >
                          <SelectTrigger aria-label={`${item.ruleName} 改绑落地节点`} className="h-8 w-40 shrink-0 text-xs">
                            <SelectValue placeholder="改绑落地节点" />
                          </SelectTrigger>
                          <SelectContent>
                            {enabledNodes.map((node) => (
                              <SelectItem key={node.id} value={String(node.id)}>
                                {node.name}
                              </SelectItem>
                            ))}
                            <SelectItem value="__unbind">移出订阅（解绑）</SelectItem>
                          </SelectContent>
                        </Select>
                        {matched ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs"
                            disabled={busy}
                            onClick={() => rebindRule.mutate({ ruleId: item.ruleId, proxyNodeId: Number(matched.id) })}
                          >
                            目标就是「{matched.name}」，改绑过去
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {hiddenRules.length > 0 && (
              <div className="space-y-2">
                <SectionLabel count={hiddenRules.length}>被你关掉的</SectionLabel>
                {hiddenRules.map((item) => (
                  <div
                    key={item.ruleId}
                    className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5"
                  >
                    <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    {/* 和上面节点同一种叫法（规则名，订阅里改过的用改过的）；两者不一样时规则名放在下面一行 */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm text-muted-foreground">{item.nodeName || item.ruleName}</span>
                        {item.lineGroup && <Badge variant="outline" size="sm" className="shrink-0 font-normal">线路组</Badge>}
                      </div>
                      {item.nodeName && item.nodeName !== item.ruleName && (
                        <p className="truncate text-[11px] leading-tight text-muted-foreground">转发「{item.ruleName}」</p>
                      )}
                    </div>
                    <OptimisticSwitch aria-label={`${item.nodeName || item.ruleName} 放回订阅`}
                      className="shrink-0 scale-90"
                      checked={false}
                      onCheckedChangeAsync={() => setRuleVisible.mutateAsync({ ruleId: item.ruleId, visible: true })}
                    />
                  </div>
                ))}
              </div>
            )}

            {((preview?.groups.length ?? 0) > 0 || offGroupOwners.length > 0 || trimmedGroupOwners.length > 0) && (
              <div className="space-y-1.5">
                <SectionLabel>
                  <Zap className="mr-1 inline h-3 w-3" />
                  自动选路组（Clash 与 sing-box）
                </SectionLabel>
                {/*
                  这些组不是谁手动建的：一个落地节点有两条以上入口（直连 + 转发、或几条转发）时，按这个节点的
                  「选路方式」自动生成（新节点默认「自动选最快」）。不写清楚的话，看着像是面板自己改了设置。
                */}
                <p className="text-xs text-muted-foreground">
                  一个落地有两条以上入口时，按这个节点的「选路方式」自动生成，新节点默认「自动选最快」。右边可以直接改成主备、负载均衡或不生成。每条入口后面的开关决定进不进组：关掉的照样进订阅，只是不进这个组。
                </p>
                {(preview?.groups ?? []).map((group) => {
                  const owner = group.templateId ? nodes.find((node) => Number(node.id) === Number(group.templateId)) : null;
                  // 自建节点（从自己机器的入站派生）没有节点链接，不能走「编辑客户端节点」那个框：就地改选路方式。
                  const editable = !!owner && !owner.sharedFrom;
                  const members = group.members.map((member, index) => (
                    group.type === "load-balance" && Array.isArray(group.weights) && group.weights[index]
                      ? `${member}×${group.weights[index]}`
                      : member
                  )).join(" / ");
                  const modeLabel = group.type === "url-test" ? "自动选最快" : group.type === "load-balance" ? "负载均衡" : "主备切换";
                  return (
                    <div key={group.name} className="rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{group.name}</span>
                        {editable && owner ? autoGroupSelect(owner, normalizeProxyNodeAutoGroup(owner.autoGroup)) : (
                          <span className="shrink-0">{modeLabel}</span>
                        )}
                      </div>
                      {editable && owner ? renderGroupMembers(Number(owner.id), group.type as ProxyNodeAutoGroup, group.type === "load-balance" && Array.isArray(group.weights)) : (
                        <p className="mt-0.5 truncate">
                          {members}
                          {group.type === "load-balance" && Array.isArray(group.weights) ? "（按带宽分连接，Clash / Mihomo 生效）" : ""}
                        </p>
                      )}
                    </div>
                  );
                })}
                {trimmedGroupOwners.map((owner) => (
                  <div key={`trimmed-${owner.id}`} className="rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{String(owner.name || "")}</span>
                      {autoGroupSelect(owner, normalizeProxyNodeAutoGroup(owner.autoGroup))}
                    </div>
                    {renderGroupMembers(Number(owner.id), normalizeProxyNodeAutoGroup(owner.autoGroup), false)}
                  </div>
                ))}
                {/*
                  选了「不生成」，组就从上面消失了 —— 下拉也跟着没了，想改回来只能去节点里找。
                  所以有两条以上入口、却设成不生成的自己的节点，在这里留一行，照样能改回去。
                */}
                {offGroupOwners.map(({ owner, count }) => (
                  <div key={`off-${owner.id}`} className="rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{String(owner.name || "")}</span>
                      {autoGroupSelect(owner, "off")}
                    </div>
                    <p className="mt-0.5 truncate">没有生成组，{count} 条入口在客户端里各是一个节点</p>
                  </div>
                ))}
              </div>
            )}

            {unboundRules.length > 0 && (
              <div className="space-y-2">
                {/*
                  这一段和下面那段原来叫「还没加入订阅的转发」和「未进入订阅的
                  转发」—— 两个名字几乎一样，说的却是两件事：这一段**选个节点就能
                  进来**，下面那段是**进不来**。名字要让人一眼分得出哪个该动手。
                */}
                <SectionLabel count={unboundRules.length}>差一个落地节点</SectionLabel>
                <p className="text-xs text-muted-foreground">
                  {enabledNodes.length === 0
                    ? "这些转发还没说清楚通往哪个落地节点，所以进不了订阅。先加一个节点，它们就能一起认上来。"
                    : "这些转发还没说清楚通往哪个落地节点，所以进不了订阅。选一个就好；目标地址正好是你某个节点时，以后新建的转发会自动认出来。"}
                </p>
                {/*
                  一个节点都还没有的时候，逐行摆一个选不了的下拉，等于把同一句
                  「请先添加落地节点」重复几十遍 —— 真正该做的那一件事（去加个节点）
                  反而被挤到看不见的地方。这种时候只把名字列出来：要动的手只有一次，
                  不是几十次。
                */}
                {enabledNodes.length === 0 ? (
                  <ul className="space-y-1">
                    {unboundRules.map((item) => (
                      <li key={item.ruleId} className="truncate text-xs text-muted-foreground">
                        {item.ruleName}
                      </li>
                    ))}
                  </ul>
                ) : unboundRules.map((item) => (
                  <div
                    key={item.ruleId}
                    className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{item.ruleName}</span>
                    <Select
                      value=""
                      onValueChange={(value) => bindRule.mutate({
                        ruleId: item.ruleId,
                        proxyNodeId: Number(value),
                      })}
                    >
                      <SelectTrigger aria-label={`${item.ruleName} 选择落地节点`} className="h-8 w-36 shrink-0 text-xs">
                        <SelectValue placeholder="选择落地节点" />
                      </SelectTrigger>
                      <SelectContent>
                        {enabledNodes.map((node) => (
                          <SelectItem key={node.id} value={String(node.id)}>
                            {node.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            )}

            {otherSkipped.length > 0 && (
              <div className="space-y-1.5">
                <SectionLabel count={otherSkipped.length}>这些进不了订阅</SectionLabel>
                <ul className="space-y-1">
                  {otherSkipped.map((item) => (
                    <li key={item.ruleId} className="text-xs text-muted-foreground">
                      {item.ruleName} —— {item.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </ScrollFade>
      <DialogFooter className="shrink-0 border-t pt-3">
        <Button variant="outline" onClick={onClose}>关闭</Button>
      </DialogFooter>
    </>
  );
}
