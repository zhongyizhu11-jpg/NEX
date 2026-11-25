/*
  从 client/src/pages/ForwardGroups.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。
  「添加 / 编辑转发组」弹窗近 780 行 JSX（端口转发 / 转发链 / 故障切换 / 入口 / 出口五种模式共用一张表单），
  只有点开时才用得上，原来和列表打在同一个包里。
  表单 state、成员增删改和提交仍在页面上（列表、拖拽和自测都要用）；弹窗只拿一个 ctx 对象来画，
  「没保存就关先问一句」的那道门（useFormDirty / useDialogCloseGuard）跟着弹窗走。
*/
import { type Dispatch, type RefObject, type SetStateAction } from "react";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";
import { trpc } from "@/lib/trpc";
import { isCollectionMode, type ForwardGroupRow, type GroupForm, type GroupMode, type GroupType, type MemberForm } from "@/pages/ForwardGroups";
import EmptyState from "@/components/EmptyState";
import HostStatusLabel from "@/components/HostStatusLabel";
import MultiHopEditor from "@/components/MultiHopEditor";
import { BandwidthAggregationSummary } from "@/components/BandwidthAggregationSummary";
import { GroupDdnsLineSummary, groupHasDdnsLineSummary } from "@/components/links/GroupDdnsLineSummary";
import { MemberDdnsLinesButton, type DdnsLineOptions } from "@/components/links/MemberDdnsLinesButton";
import { MemberScheduleButton } from "@/components/links/MemberScheduleButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDialogCloseGuard, useFormDirty } from "@/components/ui/form-dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GroupFailoverPolicyFields } from "@/features/links/GroupFailoverPolicyFields";
import { LoadBalanceFields } from "@/features/links/LoadBalanceFields";
import { exitManualWeights, exitStrategyNote } from "@/lib/exitGroupBalance";
import { hostIpv6Address, hostPrivateAddress, sameAddress } from "@/lib/multiHopAddress";
import { BANDWIDTH_AGGREGATION_STRATEGIES, BANDWIDTH_AGGREGATION_STRATEGY_HINTS, BANDWIDTH_AGGREGATION_STRATEGY_LABELS, MAX_MEMBER_BANDWIDTH_MBPS, MAX_MEMBER_WEIGHT, normalizeBandwidthAggregationStrategy } from "@shared/bandwidthAggregation";
import { DDNS_LINE_FALLBACK_LABELS, DDNS_LINE_FALLBACK_MODES, normalizeDdnsLineFallback } from "@shared/ddnsLines";
import { ddnsWeightRecordTypeSupported } from "@shared/ddnsWeights";
import { MAX_FORWARD_GROUP_MEMBERS } from "@shared/forwardGroup";
import { FORWARD_GROUP_HEALTH_CHECK_METHODS, FORWARD_GROUP_HEALTH_CHECK_METHOD_HINTS, FORWARD_GROUP_HEALTH_CHECK_METHOD_LABELS, healthCheckTargetNeedsPort, healthCheckTargetPlaceholder, normalizeForwardGroupHealthCheckMethod } from "@shared/forwardGroupHealthCheck";
import { FORWARD_TYPE_LABELS, type ForwardType } from "@shared/forwardTypes";
import { UNIFIED_BALANCE_AGENT_VERSION } from "@shared/loadBalance";
import { type GroupRoutePolicyOptions, type RoutePolicy } from "@shared/routePolicy";
import { ChevronDown, ChevronRight, ChevronUp, GripVertical, Route, Trash2 } from "lucide-react";

/** 弹窗从页面拿的东西：表单 state、派生标志、成员操作和几个查询 / mutation。名字沿用页面里原来的。 */
type ForwardGroupOutputs = inferRouterOutputs<AppRouter>["forwardGroups"];

export type ForwardGroupEditDialogContext = {
  hosts: ForwardGroupRow[] | undefined;
  editingId: number | null;
  form: GroupForm;
  setForm: Dispatch<SetStateAction<GroupForm>>;
  /** 切换成员类型时暂存另一种类型的成员，切回来还在 */
  savedMembersRef: RefObject<Record<string, MemberForm[]>>;
  dragMemberKey: string | null;
  setDragMemberKey: Dispatch<SetStateAction<string | null>>;
  advancedSettingsOpen: boolean;
  setAdvancedSettingsOpen: Dispatch<SetStateAction<boolean>>;
  activeGroupMode: GroupMode;
  groups: ForwardGroupRow[];
  editingPoolId: number | null;
  followedPoolName: string;
  unfollowPool: ReturnType<typeof trpc.forwardGroups.followPool.useMutation>;
  telegramSettingsLoaded: boolean;
  telegramReady: boolean;
  availableForwardTypes: ForwardType[];
  hostById: Map<number, ForwardGroupRow>;
  usableEntryGroups: ForwardGroupRow[];
  entryGroupHostIds: (entryGroupId: number | null | undefined) => number[];
  applyEntryGroupToChainForm: (prev: GroupForm, entryGroupId: number | null) => GroupForm;
  effectiveGroupType: GroupType;
  availableMemberOptions: { id: number; label: string; meta: string; host?: ForwardGroupRow }[];
  showExitAddressColumns: boolean;
  showExitWeightColumn: boolean;
  showAggregationColumns: boolean;
  showScheduleColumn: boolean;
  showLineColumn: boolean;
  memberRowGridClass: string;
  /** 只读 data：按路由输出写类型（useQuery 的 ReturnType 会塌成 {}） */
  ddnsLinesQuery: { data: ForwardGroupOutputs["ddnsLines"] | undefined };
  ddnsWeightSupportQuery: { data: ForwardGroupOutputs["ddnsWeightSupport"] | undefined };
  ddnsLineOptions: DdnsLineOptions;
  ddnsLineProviderLabel: string;
  ddnsLineDomainWarning: string;
  formHasDdnsLines: boolean;
  formHasForeignDdnsLines: boolean;
  updateMemberField: (key: string, patch: Partial<MemberForm>) => void;
  addMember: (id: number) => void;
  removeMember: (key: string) => void;
  updateExitMemberUsePrivate: (key: string, checked: boolean) => void;
  updateExitMemberUseIpv6: (key: string, checked: boolean) => void;
  updateChainMemberIds: (ids: number[]) => void;
  updateChainConnectHosts: (connectHosts: Array<string | null>) => void;
  moveMember: (fromKey: string, toKey: string) => void;
  handleSubmit: () => unknown;
  memberLabel: (member: ForwardGroupRow) => string;
  groupPolicyOptions: GroupRoutePolicyOptions;
  formGroupPolicy: RoutePolicy | null;
  isPending: boolean;
  isPortMode: boolean;
  isChainMode: boolean;
  runtimeConfigMode: boolean;
  runtimeProxyProtocolSupported: boolean;
  advancedSettingsConfigured: boolean;
  dialogTitle: string;
};

export default function ForwardGroupEditDialog({ open, onOpenChange, ctx }: {
  open: boolean;
  /** 页面的 handleDialogOpenChange：关掉时顺手安排表单复位 */
  onOpenChange: (open: boolean) => void;
  ctx: ForwardGroupEditDialogContext;
}) {
  const { hosts, editingId, form, setForm, savedMembersRef, setDragMemberKey, dragMemberKey, setAdvancedSettingsOpen, advancedSettingsOpen, activeGroupMode, groups, editingPoolId, followedPoolName, unfollowPool, telegramSettingsLoaded, telegramReady, availableForwardTypes, hostById, usableEntryGroups, entryGroupHostIds, applyEntryGroupToChainForm, effectiveGroupType, availableMemberOptions, showExitAddressColumns, showExitWeightColumn, showAggregationColumns, showScheduleColumn, showLineColumn, memberRowGridClass, ddnsLinesQuery, ddnsWeightSupportQuery, ddnsLineOptions, ddnsLineProviderLabel, ddnsLineDomainWarning, formHasDdnsLines, formHasForeignDdnsLines, updateMemberField, addMember, removeMember, updateExitMemberUsePrivate, updateExitMemberUseIpv6, updateChainMemberIds, updateChainConnectHosts, moveMember, handleSubmit, memberLabel, groupPolicyOptions, formGroupPolicy, isPending, isPortMode, isChainMode, runtimeConfigMode, runtimeProxyProtocolSupported, advancedSettingsConfigured, dialogTitle } = ctx;
  // 改过没保存就关要先问「放弃修改？」；请求在路上时不许关（ui/form-dialog）
  const groupFormDirty = useFormDirty(open, form);
  const groupDialogGuard = useDialogCloseGuard({ open, dirty: groupFormDirty, pending: isPending, onOpenChange });
  return (
  <Dialog
    open={open}
    onOpenChange={groupDialogGuard.handleOpenChange}
  >
    <DialogContent className={"flex max-h-[92svh] w-[calc(100vw-1rem)] max-w-[95vw] flex-col gap-3 overflow-hidden p-4 sm:p-5 " + (isChainMode || isPortMode ? "sm:max-w-xl" : "sm:max-w-2xl")}>
      <DialogHeader>
        <DialogTitle>{dialogTitle}</DialogTitle>
        {/* 读屏要的：没有 Description Radix 会在控制台告警，读屏也只念标题。视觉上标题已经够了，所以 sr-only。 */}
        <DialogDescription className="sr-only">
          {isPortMode ? "填写端口转发的名称、入口与目标" : isChainMode ? "填写转发链的名称、入口与各跳主机" : "填写转发组的名称、成员与策略"}
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <div className={"grid gap-3 " + (isPortMode || isChainMode ? "sm:grid-cols-1" : "sm:grid-cols-2")}>
          <FormField className="space-y-2">
            <Label>{isPortMode ? "端口转发名称" : isChainMode ? "转发链名称" : "组名称"}</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={isPortMode ? "例如: 洛杉矶-备用入口" : isChainMode ? "例如: 华东-香港转发链" : activeGroupMode === "exit" ? "例如: Web 高可用出口" : "例如: Web 高可用入口"}
            />
          </FormField>

          {false && form.groupMode === "failover" && (
            <FormField className="space-y-2">
              <Label>组类型</Label>
              <Select
                value={form.groupType}
                onValueChange={(v) => {
                  const newType = v as GroupType;
                  savedMembersRef.current[form.groupType] = form.members;
                  const restored = savedMembersRef.current[newType] || [];
                  setForm({ ...form, groupType: newType, members: restored });
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="host">主机端口转发组</SelectItem>
                  <SelectItem value="tunnel">隧道转发组</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}

          {isCollectionMode(form.groupMode) && (
            <label className="flex h-10 items-center justify-between rounded-md border border-border/60 px-3 sm:self-end">
              <span className="text-sm">启用</span>
              <Checkbox aria-label="启用" checked={form.isEnabled} onCheckedChange={(isEnabled) => setForm({ ...form, isEnabled })} />
            </label>
          )}
        </div>

        {form.groupMode === "exit" && (
            <LoadBalanceFields
              strategy={form.exitStrategy}
              onStrategyChange={(exitStrategy) => setForm({ ...form, exitStrategy })}
              detect={form.balanceDetect}
              onDetectChange={(balanceDetect) => setForm({ ...form, balanceDetect })}
              note={exitStrategyNote(form.exitStrategy, form.members, hostById)}
              {...exitManualWeights(form.members, hostById)}
            />
        )}

        {(form.groupMode === "failover" || form.groupMode === "entry") && (
          <>
            <div className={"grid gap-3 " + (form.groupMode === "entry" ? "sm:grid-cols-[minmax(0,1fr)_120px_140px]" : "sm:grid-cols-[minmax(0,1fr)_120px]")}>
              <FormField className="space-y-2">
                <Label>{form.groupMode === "entry" ? "入口域名" : "DDNS 域名"}</Label>
                <Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="例如 app.example.com" />
              </FormField>
              <FormField className="space-y-2">
                <Label>记录类型</Label>
                <Select value={form.recordType} onValueChange={(v) => setForm({ ...form, recordType: v as GroupForm["recordType"] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">A</SelectItem>
                    <SelectItem value="AAAA">AAAA</SelectItem>
                    <SelectItem value="CNAME">CNAME</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              {form.groupMode === "entry" && (
                <label className="flex h-10 items-center justify-between rounded-md border border-border/60 px-3 sm:self-end">
                  <span className="text-sm">自动解析</span>
                  <Checkbox aria-label="自动解析" checked={form.ddnsAutoResolveEnabled} onCheckedChange={(ddnsAutoResolveEnabled) => setForm({ ...form, ddnsAutoResolveEnabled })} />
                </label>
              )}
            </div>
            {/*
              双栈（上游 2.3.294）：成员挑选、健康、切换照旧按上面的记录类型；另一族跟着同一批成员发，
              切走一台机器两族一起切 —— 只切 A 不切 AAAA，双栈客户端会继续连到坏机器上。
            */}
            {form.recordType !== "CNAME" && (
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
                <span className="space-y-1">
                  <span className="block text-sm font-medium">{form.recordType === "AAAA" ? "同时发 IPv4（A）" : "同时发 IPv6（AAAA）"}</span>
                  <span data-fx-help="" className="block text-xs text-muted-foreground">
                    按上面选中的成员，把它们的{form.recordType === "AAAA" ? " IPv4 " : " IPv6 "}也发成同名记录；没有这一族地址的成员少一条，全都没有时清空这一族。
                  </span>
                </span>
                <Checkbox aria-label="双栈 DDNS" checked={form.ddnsDualStack} onCheckedChange={(ddnsDualStack) => setForm({ ...form, ddnsDualStack })} />
              </label>
            )}

            <div className="space-y-2 rounded-md border border-border/60 p-3" data-testid="group-peer-probe">
              <label className="flex items-center justify-between gap-3">
                <span className="space-y-1">
                  <span className="block text-sm font-medium">外部观察</span>
                  <span data-fx-help="" className="block text-xs text-muted-foreground">
                    让组里别的成员替面板去连每个成员对外的入口端口。成员自己报告正常、但两台别的机器持续连不上它，照样从解析里拿掉；
                    面板连不上它的 Agent、别的机器却连得上，就继续留着。观察点要 Agent {UNIFIED_BALANCE_AGENT_VERSION} 以上；没有可用的观察点时只看成员自己的报告。
                  </span>
                </span>
                <Checkbox aria-label="外部观察" checked={form.peerProbeEnabled} onCheckedChange={(peerProbeEnabled) => setForm({ ...form, peerProbeEnabled })} />
              </label>
              {form.peerProbeEnabled ? (
                <div className="space-y-2 border-t border-border/60 pt-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">额外的观察主机</span>
                    {form.peerObserverHostIds.length === 0 ? <span className="text-xs text-muted-foreground">没有指定（成员之间互相看）</span> : null}
                    {form.peerObserverHostIds.map((hostId) => (
                      <Badge key={hostId} variant="secondary" className="h-6 gap-1 rounded px-1.5 font-normal">
                        {hostById.get(hostId)?.name || `主机 ${hostId}`}
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={`移除观察主机 ${hostById.get(hostId)?.name || hostId}`}
                          onClick={() => setForm({ ...form, peerObserverHostIds: form.peerObserverHostIds.filter((id) => id !== hostId) })}
                        >
                          ×
                        </button>
                      </Badge>
                    ))}
                  </div>
                  {form.peerObserverHostIds.length < 8 ? (
                    <Select
                      value=""
                      onValueChange={(value) => {
                        const hostId = Number(value);
                        if (hostId > 0 && !form.peerObserverHostIds.includes(hostId)) setForm({ ...form, peerObserverHostIds: [...form.peerObserverHostIds, hostId] });
                      }}
                    >
                      <SelectTrigger aria-label="添加观察主机" className="h-8 w-full sm:w-64"><SelectValue placeholder="添加观察主机（成员少、或者想从别的网络看）" /></SelectTrigger>
                      <SelectContent>
                        {(hosts || [])
                          .filter((host: { id: number }) => !form.peerObserverHostIds.includes(Number(host.id)) && !form.members.some((member) => Number(member.hostId) === Number(host.id)))
                          .map((host: { id: number; name: string }) => <SelectItem key={host.id} value={String(host.id)}>{host.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>
              ) : null}
            </div>

            {formHasDdnsLines && (
              <div className="space-y-2 rounded-md border border-border/60 p-3">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] sm:items-center">
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">分线路解析</span>
                    <span data-fx-help="" className="block text-xs text-muted-foreground">
                      分了线路的成员只解析给对应运营商的用户（例如电信 → 一台、联通 → 另一台），没分的留在默认线路。
                      一条线路的成员全不可用时怎么办：
                    </span>
                  </span>
                  <Select value={form.ddnsLineFallback} onValueChange={(value) => setForm({ ...form, ddnsLineFallback: normalizeDdnsLineFallback(value) })}>
                    <SelectTrigger aria-label="线路成员全不可用时"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DDNS_LINE_FALLBACK_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>{DDNS_LINE_FALLBACK_LABELS[mode]}{mode === "default" ? "（推荐）" : ""}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {ddnsLinesQuery.data && !ddnsLinesQuery.data.supported ? (
                  <p className="text-xs text-[var(--fx-warn)]">{ddnsLinesQuery.data.reason}；成员上的线路配置先保留，暂不生效，组照旧只发布默认线路。</p>
                ) : null}
                {ddnsLineDomainWarning ? <p className="text-xs text-[var(--fx-warn)]">{ddnsLineDomainWarning}</p> : null}
                {formHasForeignDdnsLines ? (
                  <p className="text-xs text-[var(--fx-warn)]">有成员勾的是换服务商之前的线路（标着「已不可用」），这些线路不生效、成员只在默认线路，请按 {ddnsLineProviderLabel} 的线路重新勾选。</p>
                ) : null}
              </div>
            )}
            {editingId && groupHasDdnsLineSummary(groups.find((group) => Number(group.id) === editingId) || {}) ? (
              <GroupDdnsLineSummary group={groups.find((group) => Number(group.id) === editingId)} memberLabel={memberLabel} />
            ) : null}

            {form.groupMode === "entry" && (
              <div className="space-y-3 rounded-md border border-border/60 p-3">
                <label className="flex items-center justify-between gap-3">
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">按带宽排序解析</span>
                    <span data-fx-help="" className="block text-xs text-muted-foreground">
                      入口域名照旧解析出全部健康入口，面板按带宽给它们排先后并显示占用率。
                      DNS 的多条记录没有顺序，解析器会自己轮换，所以它现在不改变客户端被分到哪一台。
                      要按比例分连接，用订阅里的「负载均衡」组；要把一条连接拆开同时走几台，用隧道中转的「单连接叠加」。
                    </span>
                  </span>
                  <Checkbox
                    checked={form.bandwidthAggregationEnabled}
                    onCheckedChange={(bandwidthAggregationEnabled) => setForm({ ...form, bandwidthAggregationEnabled })}
                  />
                </label>

                {form.bandwidthAggregationEnabled && (
                  <div className="space-y-3 border-t border-border/60 pt-3">
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
                      <FormField className="space-y-2">
                        <Label>排序依据</Label>
                        <Select
                          value={form.bandwidthAggregationStrategy}
                          onValueChange={(value) => setForm({ ...form, bandwidthAggregationStrategy: normalizeBandwidthAggregationStrategy(value) })}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {BANDWIDTH_AGGREGATION_STRATEGIES.map((strategy) => (
                              <SelectItem key={strategy} value={strategy}>
                                {BANDWIDTH_AGGREGATION_STRATEGY_LABELS[strategy]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormField>
                      <FormField className="space-y-2">
                        <Label>最少健康前置</Label>
                        <Input
                          type="number"
                          min={1}
                          max={5}
                          value={form.bandwidthAggregationMinMembers}
                          onChange={(e) => setForm({ ...form, bandwidthAggregationMinMembers: e.target.value })}
                          placeholder="1"
                        />
                      </FormField>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {BANDWIDTH_AGGREGATION_STRATEGY_HINTS[form.bandwidthAggregationStrategy]}
                      {" 健康入口少于下限时不排序。"}
                    </p>
                    {editingId ? (
                      <BandwidthAggregationSummary groupId={editingId} open={open} />
                    ) : null}
                    {(() => {
                      // 按权重解析：把上面算出来的份额写成 DNS 服务商的记录权重，解析时真的按比例返回。
                      const weightSupport = ddnsWeightSupportQuery.data;
                      const typeReason = ddnsWeightRecordTypeSupported(form.recordType) ? null : "CNAME 一个名字只能有一条记录，没有按比例一说，用不了按权重解析";
                      const disabledReason = typeReason || (weightSupport && !weightSupport.supported ? weightSupport.reason : null);
                      return (
                        <label className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
                          <span className="space-y-1">
                            <span className="block text-sm font-medium">按权重解析</span>
                            <span data-fx-help="" className="block text-xs text-muted-foreground">
                              把上面的份额写成 DNS 服务商的记录权重，解析时按比例返回各个入口（腾讯云 DNSPod、阿里云 DNS、华为云 DNS 支持；只管默认线路）。
                            </span>
                            {disabledReason ? <span className="block text-xs text-[var(--fx-warn-text)]" data-testid="ddns-weight-unsupported">{disabledReason}</span> : null}
                          </span>
                          <Checkbox
                            aria-label="按权重解析"
                            checked={form.ddnsWeightEnabled && !disabledReason}
                            disabled={!!disabledReason}
                            onCheckedChange={(ddnsWeightEnabled) => setForm({ ...form, ddnsWeightEnabled })}
                          />
                        </label>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            {form.groupMode === "entry" && (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,200px)]">
              <div className="space-y-1.5">
                <Input
                  aria-label="入口健康度检测目标"
                  disabled={!form.chinaHealthCheckEnabled}
                  value={form.chinaHealthCheckTarget}
                  onChange={(e) => setForm({ ...form, chinaHealthCheckTarget: e.target.value })}
                  placeholder={healthCheckTargetPlaceholder(form.chinaHealthCheckMethod)}
                />
                <Select
                  value={form.chinaHealthCheckMethod}
                  onValueChange={(value) => setForm({ ...form, chinaHealthCheckMethod: normalizeForwardGroupHealthCheckMethod(value) })}
                  disabled={!form.chinaHealthCheckEnabled}
                >
                  <SelectTrigger aria-label="健康度检测方式"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FORWARD_GROUP_HEALTH_CHECK_METHODS.map((method) => (
                      <SelectItem key={method} value={method}>
                        {FORWARD_GROUP_HEALTH_CHECK_METHOD_LABELS[method]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {FORWARD_GROUP_HEALTH_CHECK_METHOD_HINTS[form.chinaHealthCheckMethod]}
                  {healthCheckTargetNeedsPort(form.chinaHealthCheckMethod) ? " IPv6 格式：[地址]:端口。" : " IPv6 直接填地址。"}
                </p>
              </div>
              <div className="space-y-2">
                <label className="flex h-10 items-center justify-between rounded-md border border-border/60 px-3">
                  <span className="text-sm">入口健康度检测</span>
                  <Checkbox aria-label="入口健康度检测" checked={form.chinaHealthCheckEnabled} onCheckedChange={(chinaHealthCheckEnabled) => setForm({ ...form, chinaHealthCheckEnabled })} />
                </label>
                <label
                  className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                  title={telegramReady ? "仅在自动切换时发送 Telegram 告警。" : telegramSettingsLoaded ? "请先在系统设置中配置并启用 Telegram 机器人。" : "正在确认 Telegram 配置。"}
                >
                  <span className="min-w-0">
                    <span className="block text-sm">切换告警</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {telegramReady ? "仅自动切换提醒" : telegramSettingsLoaded ? "需先配置 Telegram" : "正在确认配置"}
                    </span>
                  </span>
                  <Checkbox
                    checked={form.telegramSwitchNotifyEnabled}
                    disabled={telegramSettingsLoaded && !telegramReady && !form.telegramSwitchNotifyEnabled}
                    onCheckedChange={(telegramSwitchNotifyEnabled) => {
                      if (telegramSwitchNotifyEnabled && telegramSettingsLoaded && !telegramReady) {
                        toast.error("请先在系统设置中配置并启用 Telegram 机器人");
                        return;
                      }
                      setForm({ ...form, telegramSwitchNotifyEnabled });
                    }}
                  />
                </label>
              </div>
            </div>
            )}
          </>
        )}

        {(form.groupMode === "chain" || form.groupMode === "port") && (
          <FormField className="space-y-2">
            <Label>{form.groupMode === "port" ? "入口组（可选）" : "入口组"}</Label>
            {form.groupMode === "port" && (
              <p data-fx-help="" className="text-xs text-muted-foreground">挂上入口组就用组里的主机当入口，隧道 / 转发链共用同一个组，组里加减主机这里自动跟着变；不挂就在下面指定主机。</p>
            )}
            <Select
              value={form.entryGroupId ? String(form.entryGroupId) : "none"}
              onValueChange={(value) => setForm((prev) => applyEntryGroupToChainForm(prev, value === "none" ? null : Number(value)))}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择已保存入口组" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{form.groupMode === "port" ? "不使用入口组，指定主机" : "不使用入口组"}</SelectItem>
                {usableEntryGroups.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">暂无可用入口组</div>
                ) : usableEntryGroups.map((group: ForwardGroupRow) => (
                  <SelectItem key={group.id} value={String(group.id)} textValue={group.name}>
                    <span className="fx-select-two inline-flex min-w-0 flex-col">
                      <span className="truncate">{group.name}</span>
                      <span className="fx-select-sub truncate text-xs text-muted-foreground">{String(group.domain || "-")}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}

        {runtimeConfigMode && (
          <div className="space-y-2.5 border-t border-border/60 pt-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">运行配置</p>
              <p data-fx-help="" id="forward-group-rate-limit-help" className="text-xs text-muted-foreground">0 表示不限速</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(132px,160px)_112px] sm:items-end">
              <FormField className="space-y-2">
                <Label>转发工具</Label>
                <Select
                  value={form.forwardType}
                  disabled={availableForwardTypes.length === 0}
                  onValueChange={(value) => {
                    const forwardType = value as ForwardType;
                    const tcpSupported = form.protocol !== "udp";
                    setForm({
                      ...form,
                      forwardType,
                      proxyProtocolReceive: tcpSupported && (forwardType === "gost" || forwardType === "realm") && form.proxyProtocolReceive,
                      proxyProtocolSend: tcpSupported && (forwardType === "gost" || forwardType === "realm") && form.proxyProtocolSend,
                      tcpFastOpen: false,
                      zeroCopy: false,
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择转发工具" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableForwardTypes.map((type) => (
                      <SelectItem key={type} value={type}>{FORWARD_TYPE_LABELS[type]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <div className="space-y-2">
                <Label htmlFor="forward-group-rate-limit">资源限速</Label>
                <div className="flex h-10 min-w-0 overflow-hidden rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
                  <Input
                    id="forward-group-rate-limit"
                    aria-describedby="forward-group-rate-limit-help"
                    className="h-10 min-w-0 flex-1 rounded-none border-0 bg-transparent px-3 tabular-nums focus-visible:border-0 focus-visible:ring-0"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={1000000}
                    step={1}
                    value={form.rateLimitMbps}
                    onChange={(event) => setForm({ ...form, rateLimitMbps: event.target.value })}
                    placeholder="0"
                  />
                  <span className="flex h-full shrink-0 items-center border-l border-border/60 bg-muted/50 px-2.5 text-xs text-muted-foreground">Mbps</span>
                </div>
              </div>
              <FormField className="space-y-2">
                <Label>流量倍率</Label>
                <Input
                  className="tabular-nums"
                  type="number"
                  min={0.01}
                  max={50}
                  step={0.01}
                  value={form.trafficMultiplier}
                  onChange={(event) => setForm({ ...form, trafficMultiplier: event.target.value })}
                  placeholder="1"
                />
              </FormField>
            </div>
          </div>
        )}

        {runtimeConfigMode && (
          <div className="rounded-lg border border-border/60 bg-muted/20">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
              onClick={() => setAdvancedSettingsOpen((open) => !open)}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium">高级设置</div>
                <div className="text-xs text-muted-foreground">PROXY Protocol</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={advancedSettingsConfigured ? "secondary" : "outline"} className="h-5 px-1.5 text-[11px] font-normal">
                  {advancedSettingsConfigured ? "已配置" : "可选"}
                </Badge>
                <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${advancedSettingsOpen ? "rotate-90" : ""}`} />
              </div>
            </button>
            {advancedSettingsOpen && (
              <div className="space-y-3 border-t border-border/50 px-3 pb-3 pt-2">
                <div className="space-y-2">
                  <FormField className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <Label className="text-sm">PROXY Protocol</Label>
                    <Select
                      value={String(form.proxyProtocolVersion)}
                      onValueChange={(value) => setForm({ ...form, proxyProtocolVersion: Number(value) === 2 ? 2 : 1 })}
                      disabled={!runtimeProxyProtocolSupported}
                    >
                      <SelectTrigger className="h-8 w-full sm:w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">v1</SelectItem>
                        <SelectItem value="2">v2</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border/50 bg-background/55 px-2.5 py-2">
                      <span className="text-sm">接收 PROXY</span>
                      <Checkbox aria-label="接收 PROXY" checked={runtimeProxyProtocolSupported && form.proxyProtocolReceive} disabled={!runtimeProxyProtocolSupported} onCheckedChange={(checked) => setForm({ ...form, proxyProtocolReceive: checked })} />
                    </label>
                    <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border/50 bg-background/55 px-2.5 py-2">
                      <span className="text-sm">发送 PROXY</span>
                      <Checkbox aria-label="发送 PROXY" checked={runtimeProxyProtocolSupported && form.proxyProtocolSend} disabled={!runtimeProxyProtocolSupported} onCheckedChange={(checked) => setForm({ ...form, proxyProtocolSend: checked })} />
                    </label>
                  </div>
                  {!runtimeProxyProtocolSupported && <p className="text-xs text-muted-foreground">PROXY Protocol 仅支持 TCP 且转发工具为 GOST 或 Realm。</p>}
                </div>

              </div>
            )}
          </div>
        )}

        {/*
          端口转发的入口主机和转发组的成员用同一张列表（2.3.437 起端口转发能挂多台入口主机，
          poouo/Forwardx#15）：每台都同时监听规则的入口端口、转到同一个目标，所以没有「启用」
          开关那一列 —— 不想让哪台转就把它移掉。
        */}
        {!(form.groupMode === "port" && form.entryGroupId) && (
          <div className={form.groupMode === "chain" ? "space-y-2" : "space-y-3 rounded-lg border border-border/60 p-3"}>
            {/* 标题和「添加成员」放一行（省一行高：3 台出口的出口组在笔记本上不用滚） */}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <Label>{form.groupMode === "chain" ? "链路主机顺序" : form.groupMode === "port" || form.groupMode === "entry" ? "入口主机" : form.groupMode === "exit" ? "出口主机" : "成员优先级"}</Label>
              {form.groupMode !== "chain" ? (
                <Select onValueChange={(v) => addMember(Number(v))}>
                  <SelectTrigger aria-label="添加成员" className="w-full sm:w-64">
                    <SelectValue placeholder={effectiveGroupType === "host" ? "添加主机成员" : "添加隧道成员"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableMemberOptions.map((item) => (
                      <SelectItem key={item.id} value={String(item.id)} textValue={item.label}>
                        {effectiveGroupType === "host" ? (
                          <HostStatusLabel host={item.host} label={item.label} />
                        ) : (
                          <span>{item.label} {item.meta ? "/ " + item.meta : ""}</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
            {editingPoolId ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-[var(--fx-accent)]/30 bg-[var(--fx-accent-soft)] px-3 py-2 text-xs leading-[1.5]" data-testid="group-follows-pool">
                <span className="min-w-0 flex-1">
                  成员跟着节点池「{followedPoolName}」：机器的加减以池为准，这里只改每台的地址、带宽、权重和时段。
                </span>
                <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2 text-xs" disabled={unfollowPool.isPending} onClick={() => unfollowPool.mutate({ groupId: editingId!, poolId: null })}>
                  不跟了
                </Button>
              </div>
            ) : null}
            {form.groupMode === "port" && (
              <p data-fx-help="" className="text-xs text-muted-foreground">选一台或多台主机，每台都在规则的入口端口上监听、转到同一个目标；加减主机后已有规则自动跟着下发。</p>
            )}
            {form.groupMode === "chain" ? (
              <MultiHopEditor
                hosts={hosts || []}
                initialHopIds={form.members.map((member) => Number(member.hostId || 0)).filter(Boolean)}
                initialHopConnectHosts={form.members.map((member) => member.connectHost || null)}
                maxHops={MAX_FORWARD_GROUP_MEMBERS}
                externalEntry={!!form.entryGroupId}
                excludedHostIds={entryGroupHostIds(form.entryGroupId)}
                onChange={updateChainMemberIds}
                onConnectHostsChange={updateChainConnectHosts}
              />
            ) : (
              <>
                <div className="space-y-2">
                  {form.members.length > 0 && (
                    <>
                      {/* 有鼠标的宽屏上说明挪到表头的悬停里（省两行，3 台成员的组不用滚）；触屏照旧写出来 */}
                      {form.groupMode !== "port" && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/35 px-2.5 py-1.5 text-[11px] text-muted-foreground [@media(hover:hover)_and_(min-width:640px)]:hidden">
                        <span className="font-medium text-foreground/70">开关说明</span>
                        {showExitAddressColumns && (
                          <>
                            <span>内网：使用该主机内网 IP</span>
                            <span>IPv6：使用该主机 IPv6</span>
                            <span>两者互斥，未配置时不可开启</span>
                          </>
                        )}
                        {showAggregationColumns && (
                          <>
                            <span>上行 Mbps：该前置的上行带宽，留空或 0 表示未知</span>
                            <span>权重：手动排序比重，0 表示按所选排序依据自动计算</span>
                          </>
                        )}
                        {showLineColumn && <span>线路：按运营商分线路解析，不分 = 只在默认线路</span>}
                        {showScheduleColumn && <span>时段：只在设定的时段使用这个成员，时段外自动暂停</span>}
                        <span>启用：关闭后该成员不参与当前组</span>
                      </div>}
                      <div className={"hidden items-center gap-1.5 px-2.5 text-[11px] text-muted-foreground sm:grid " + memberRowGridClass}>
                        <span className="col-span-2">顺序</span>
                        <span>{effectiveGroupType === "host" ? "主机" : "隧道"}</span>
                        {showExitAddressColumns && (
                          <>
                            <span className="text-center" title="使用该主机内网 IP（和 IPv6 互斥，未配置时不可开启）">内网</span>
                            <span className="text-center" title="使用该主机 IPv6（和内网互斥，未配置时不可开启）">IPv6</span>
                            {showExitWeightColumn && <span className="text-center">权重</span>}
                          </>
                        )}
                        {showAggregationColumns && (
                          <>
                            <span className="text-center" title="该前置的上行带宽，留空或 0 表示未知">上行 Mbps</span>
                            <span className="text-center">权重</span>
                          </>
                        )}
                        {showLineColumn && <span className="text-center" title="按运营商分线路解析，不分 = 只在默认线路">线路</span>}
                        {showScheduleColumn && <span className="text-center" title="只在设定的时段使用这个成员，时段外自动暂停">时段</span>}
                        {form.groupMode !== "port" && <span className="text-center" title="关闭后该成员不参与当前组">启用</span>}
                        <span className="text-right">操作</span>
                      </div>
                    </>
                  )}
                  {form.members.map((member, index) => (
                    <div
                      key={member.key}
                      draggable
                      onDragStart={() => setDragMemberKey(member.key)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (dragMemberKey) moveMember(dragMemberKey, member.key);
                        setDragMemberKey(null);
                      }}
                      className={"flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-background/70 px-3 py-2 sm:grid sm:gap-1.5 " + memberRowGridClass}
                    >
                      {/* ↑↓：手机上拖不动，点着调顺序（2.3.534）；电脑上照样能拖 */}
                      <span className="flex items-center">
                        <GripVertical className="hidden h-4 w-4 cursor-grab text-muted-foreground sm:block" />
                        {form.members.length > 1 ? (
                          <span className="fx-lb-move">
                            <button type="button" aria-label={`上移 ${memberLabel(member)}`} disabled={index === 0} onClick={() => moveMember(member.key, form.members[index - 1].key)}>
                              <ChevronUp className="h-4 w-4" />
                            </button>
                            <button type="button" aria-label={`下移 ${memberLabel(member)}`} disabled={index === form.members.length - 1} onClick={() => moveMember(member.key, form.members[index + 1].key)}>
                              <ChevronDown className="h-4 w-4" />
                            </button>
                          </span>
                        ) : null}
                      </span>
                      <span className="flex h-6 w-6 items-center justify-center rounded bg-muted text-xs">{index + 1}</span>
                      {member.memberType === "host" ? (
                        <HostStatusLabel
                          host={hostById.get(Number(member.hostId))}
                          label={memberLabel(member)}
                          // 手机上一行：拖动 + 序号 + 名字占满，后面的输入框换到下一行（以前名字被挤成 0 宽，只剩一个圆点）
                          className="min-w-0 flex-1 basis-[calc(100%-6.5rem)] text-sm font-medium sm:basis-auto"
                          labelClassName="truncate"
                        />
                      ) : (
                        <div className="flex min-w-0 flex-1 basis-[calc(100%-6.5rem)] items-center gap-2 sm:basis-auto">
                          <Route className="h-4 w-4 text-primary" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{memberLabel(member)}</p>
                          </div>
                        </div>
                      )}
                      {form.groupMode === "exit" && member.memberType === "host" && (
                        <>
                          {/* 手机上没有表头：勾选框旁边直接写它是什么（sm 起表头在上面，这几个字收起） */}
                          <label className="flex h-7 items-center justify-center gap-1.5 sm:w-[56px]">
                            <Checkbox
                              checked={!!hostPrivateAddress(hostById.get(Number(member.hostId || 0))) && sameAddress(member.connectHost, hostPrivateAddress(hostById.get(Number(member.hostId || 0))))}
                              disabled={!hostPrivateAddress(hostById.get(Number(member.hostId || 0)))}
                              onCheckedChange={(checked) => updateExitMemberUsePrivate(member.key, checked)}
                              aria-label={"为" + memberLabel(member) + "使用内网IP"}
                            />
                            <span className="text-xs text-muted-foreground sm:hidden">内网</span>
                          </label>
                          <label className="flex h-7 items-center justify-center gap-1.5 sm:w-[56px]">
                            <Checkbox
                              checked={!!hostIpv6Address(hostById.get(Number(member.hostId || 0))) && sameAddress(member.connectHost, hostIpv6Address(hostById.get(Number(member.hostId || 0))))}
                              disabled={!hostIpv6Address(hostById.get(Number(member.hostId || 0)))}
                              onCheckedChange={(checked) => updateExitMemberUseIpv6(member.key, checked)}
                              aria-label={"为" + memberLabel(member) + "使用IPv6转发"}
                            />
                            <span className="text-xs text-muted-foreground sm:hidden">IPv6</span>
                          </label>
                          {showExitWeightColumn && (
                            <label className="flex items-center justify-center gap-1.5 sm:w-[64px]">
                              <span className="text-xs text-muted-foreground sm:hidden">权重</span>
                              <Input
                                type="number"
                                min={0}
                                max={MAX_MEMBER_WEIGHT}
                                value={member.aggregationWeight === "0" ? "" : member.aggregationWeight}
                                onChange={(e) => updateMemberField(member.key, { aggregationWeight: e.target.value })}
                                className="h-7 w-[56px] text-center text-xs"
                                placeholder="自动"
                                aria-label={memberLabel(member) + "的权重"}
                              />
                            </label>
                          )}
                        </>
                      )}
                      {showAggregationColumns && (
                        <>
                          <label className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground sm:hidden">上行</span>
                          <Input
                            type="number"
                            min={0}
                            max={MAX_MEMBER_BANDWIDTH_MBPS}
                            value={member.bandwidthMbps}
                            onChange={(e) => updateMemberField(member.key, { bandwidthMbps: e.target.value })}
                            className="h-7 w-[92px] text-center text-xs"
                            placeholder="0"
                            aria-label={memberLabel(member) + "的上行带宽 Mbps"}
                          />
                          </label>
                          <label className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground sm:hidden">权重</span>
                          <Input
                            type="number"
                            min={0}
                            max={MAX_MEMBER_WEIGHT}
                            value={member.aggregationWeight}
                            onChange={(e) => updateMemberField(member.key, { aggregationWeight: e.target.value })}
                            className="h-7 w-[72px] text-center text-xs"
                            placeholder="0"
                            aria-label={memberLabel(member) + "的聚合权重"}
                          />
                          </label>
                        </>
                      )}
                      {showLineColumn && <div className="flex h-7 w-[44px] items-center justify-center">
                        <MemberDdnsLinesButton
                          value={member.ddnsLines}
                          memberLabel={memberLabel(member)}
                          options={ddnsLineOptions}
                          onChange={(ddnsLines) => updateMemberField(member.key, { ddnsLines })}
                        />
                      </div>}
                      {showScheduleColumn && <div className="flex h-7 w-[44px] items-center justify-center">
                        <MemberScheduleButton
                          value={member.activeSchedule || null}
                          memberLabel={memberLabel(member)}
                          onChange={(activeSchedule) => updateMemberField(member.key, { activeSchedule })}
                        />
                      </div>}
                      {form.groupMode !== "port" && <label className="flex h-7 items-center justify-center gap-1.5 sm:w-[52px]">
                        <Checkbox aria-label={`启用 ${memberLabel(member)}`} checked={member.isEnabled} onCheckedChange={(checked) => {
                          setForm({ ...form, members: form.members.map((m) => m.key === member.key ? { ...m, isEnabled: checked } : m) });
                        }} title={member.isEnabled ? "关闭后该成员不参与转发组切换" : "开启后该成员可参与转发组切换"} />
                        <span className="text-xs text-muted-foreground sm:hidden">启用</span>
                      </label>}
                      <div className="flex h-7 w-9 items-center justify-end">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={`移除成员 ${memberLabel(member)}`} onClick={() => removeMember(member.key)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  {form.members.length === 0 && (
                    <EmptyState className="py-6" title="还没有成员" description="用上面的选择框把成员加进来。" />
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {form.groupMode === "failover" && (
          <div className="space-y-4">
            <GroupFailoverPolicyFields
              value={form}
              onChange={(patch) => setForm({ ...form, ...patch })}
              policy={formGroupPolicy}
              ddnsSwitching={groupPolicyOptions.ddnsSwitching}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <label
                className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                title={telegramReady ? "仅在自动切换时发送 Telegram 告警。" : telegramSettingsLoaded ? "请先在系统设置中配置并启用 Telegram 机器人。" : "正在确认 Telegram 配置。"}
              >
                <span className="min-w-0">
                  <span className="block text-sm">切换告警</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {telegramReady ? "仅自动切换提醒" : telegramSettingsLoaded ? "需先配置 Telegram" : "正在确认配置"}
                  </span>
                </span>
                <Checkbox
                  checked={form.telegramSwitchNotifyEnabled}
                  disabled={telegramSettingsLoaded && !telegramReady && !form.telegramSwitchNotifyEnabled}
                  onCheckedChange={(telegramSwitchNotifyEnabled) => {
                    if (telegramSwitchNotifyEnabled && telegramSettingsLoaded && !telegramReady) {
                      toast.error("请先在系统设置中配置并启用 Telegram 机器人");
                      return;
                    }
                    setForm({ ...form, telegramSwitchNotifyEnabled });
                  }}
                />
              </label>
              <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
                <span className="text-sm">启用</span>
                <Checkbox aria-label="启用" checked={form.isEnabled} onCheckedChange={(isEnabled) => setForm({ ...form, isEnabled })} />
              </label>
            </div>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={groupDialogGuard.requestClose}>取消</Button>
        <Button onClick={handleSubmit} disabled={isPending}>{isPending ? "保存中..." : editingId ? "保存" : "创建"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  );
}
