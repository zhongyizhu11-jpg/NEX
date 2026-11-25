/*
  从 client/src/pages/Hosts.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。
  「编辑主机」弹窗 650 行 JSX（基础信息 / 其他配置两页），只有点开某台主机时才用得上，原来和主机列表打在同一个包里。
  表单 state 与提交仍在页面上（列表的乐观更新要用）；「没保存就关先问一句」的那道门（useFormDirty / useDialogCloseGuard）跟着弹窗走。
*/
import { useMemo, type ComponentProps, type Dispatch, type SetStateAction } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePanelFlags } from "@/hooks/usePanelFlags";
import {
  HOST_DIALOG_TABS, clampBillingDay, clampBillingMonth, clampMonthlyResetDay, clampRenewalReminderDays, clampTrafficAlertThresholdPercent,
  normalizeHostBillingCycleMonths, normalizeHostExpiryAction, normalizeHostTrafficMeasureMode, parseCustomPortsInput,
  type HostDialogTab, type HostFormData,
} from "@/pages/Hosts";
import DateTimePickerInput from "@/components/DatePickerInput";
import HostAgentManagementSection from "@/components/hosts/HostAgentManagementSection";
import { HostCostFields } from "@/components/hosts/HostCostFields";
import { HostPrimaryAddressPicker } from "@/components/hosts/HostPrimaryAddressPicker";
import { HOST_EGRESS_MBPS_MAX, describeHostEgressShaping, normalizeHostEgressMbpsInput, normalizeHostEgressShapingMode } from "@/components/hosts/hostEgressShaping";
import { describeHostFlowOffload } from "@/components/hosts/hostFlowOffload";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDialogCloseGuard, useFormDirty } from "@/components/ui/form-dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ddnsProviderSupportsMultipleValues, hostDdnsProviderValueModeNote, normalizeHostDdnsIpVersion, normalizeHostDdnsValueMode } from "@shared/hostDdnsPlan";
import { hostTrafficExcluded, normalizeHostTrafficFailoverPercent } from "@shared/hostTrafficPolicy";
import { RadioTower } from "lucide-react";

/** 正在编辑的那一行主机：弹窗只看地址 / 流量策略 / 整形与 offload 状态这几样。 */
export type HostEditRow = ComponentProps<typeof HostPrimaryAddressPicker>["host"]
  & NonNullable<Parameters<typeof hostTrafficExcluded>[0]>
  & {
    addressManual?: boolean | number | null;
    egressShapingStatus?: Parameters<typeof describeHostEgressShaping>[0];
    flowOffloadStatus?: Parameters<typeof describeHostFlowOffload>[0];
  };

export default function HostEditDialog({
  open, onOpenChange, form, setForm, editingId, editingHostRow, detectedPrivateIpv4, handleSubmit, isPending,
  hostDialogTab, setHostDialogTab, user, panelFlags, nginxFeatureEnabled, ddnsProviderEnabled, reminderChannelHint,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: HostFormData;
  setForm: Dispatch<SetStateAction<HostFormData>>;
  editingId: number | null;
  editingHostRow: HostEditRow | null;
  /** Agent 上报的内网 IPv4（页面按正在编辑的那一行算好） */
  detectedPrivateIpv4: string;
  handleSubmit: () => void;
  isPending: boolean;
  hostDialogTab: HostDialogTab;
  setHostDialogTab: Dispatch<SetStateAction<HostDialogTab>>;
  user: ReturnType<typeof useAuth>["user"];
  panelFlags: ReturnType<typeof usePanelFlags>;
  nginxFeatureEnabled: boolean;
  ddnsProviderEnabled: boolean;
  reminderChannelHint: string;
}) {
  // 改过没保存就关要先问「放弃修改？」；请求在路上时不许关（ui/form-dialog）
  const hostFormDirty = useFormDirty(open, form);
  const hostDialogGuard = useDialogCloseGuard({ open, dirty: hostFormDirty, pending: isPending, onOpenChange });
  const customPortInputState = useMemo(() => parseCustomPortsInput(form.portAllowlist), [form.portAllowlist]);
  return (
  <Dialog open={open} onOpenChange={hostDialogGuard.handleOpenChange}>
    <DialogContent className="flex h-[min(720px,86svh)] max-h-[86svh] flex-col overflow-hidden sm:max-w-[44rem]">
      <DialogHeader className="shrink-0 space-y-1">
        <DialogTitle>编辑主机</DialogTitle>
        <DialogDescription className="sr-only">
          修改主机信息
        </DialogDescription>
      </DialogHeader>
      <Tabs
        value={hostDialogTab}
        onValueChange={(value) => setHostDialogTab(value as HostDialogTab)}
        className="min-h-0 flex flex-1 flex-col overflow-hidden"
      >
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-md bg-muted/50 p-1">
          {HOST_DIALOG_TABS.map((item) => {
            const Icon = item.icon;
            return (
              <TabsTrigger key={item.value} value={item.value} className="min-w-0 gap-2 px-3 py-1.5 text-sm">
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>
        <div className="dialog-scroll-area mt-3 min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-4 pl-0.5 pr-7">
          <TabsContent value="basic" className="m-0 space-y-3 !animate-none">
            <section className="space-y-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <Label className="text-sm font-semibold">基础信息</Label>
                <span className="text-xs text-muted-foreground">主机连接</span>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <FormField className="space-y-1">
                  <Label className="text-sm">主机名称</Label>
                  <Input
                    className="h-8"
                    placeholder="例如: 香港节点-01"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </FormField>
                <FormField className="space-y-1">
                  <Label className="text-sm">Agent 检测 IP</Label>
                  <Input
                    className="h-8"
                    placeholder="Agent 自动检测"
                    value={form.detectedAddress}
                    onChange={(e) => setForm({ ...form, detectedAddress: e.target.value })}
                  />
                  {/*
                    手改之后地址由用户说了算，心跳不再覆盖（agentAddressState）；清空保存交回 Agent。
                    IPv4、IPv6 各一个，用逗号或空格隔开。
                  */}
                  <p className="text-xs text-muted-foreground">
                    {editingHostRow?.addressManual
                      ? "已手动指定，Agent 上报不再覆盖；清空后保存恢复自动检测"
                      : "可以手改（IPv4、IPv6 用逗号隔开），改了之后 Agent 上报不再覆盖"}
                  </p>
                </FormField>
              </div>
              {editingId && editingHostRow ? (
                <div className="mt-2.5">
                  <HostPrimaryAddressPicker
                    host={editingHostRow}
                    primaryIpv4={form.primaryIpv4}
                    primaryIpv6={form.primaryIpv6}
                    onChange={(family, value) => setForm({ ...form, ...(family === "ipv4" ? { primaryIpv4: value } : { primaryIpv6: value }) })}
                  />
                </div>
              ) : null}
              <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                <FormField className="space-y-1">
                  <Label className="text-sm">入口 IP / 域名</Label>
                  <Input
                    className="h-8"
                    placeholder="例如: example.com 或 1.2.3.4"
                    value={form.entryIp}
                    onChange={(e) => setForm({ ...form, entryIp: e.target.value })}
                  />
                  {/* 家里的机器当入口（比如叠加的入口）时，订阅里的地址就是它的内网 IP。 */}
                  {detectedPrivateIpv4 && !form.entryIp.trim() ? (
                    <button
                      type="button"
                      className="text-left text-xs text-primary hover:underline"
                      onClick={() => setForm({ ...form, entryIp: detectedPrivateIpv4 })}
                    >
                      填内网 IP {detectedPrivateIpv4}
                    </button>
                  ) : null}
                </FormField>
                <FormField className="space-y-1">
                  <Label className="text-sm">内网地址 <span className="text-xs text-muted-foreground">可选</span></Label>
                  <Input
                    className="h-8"
                    placeholder={detectedPrivateIpv4 ? `检测到 ${detectedPrivateIpv4}` : "10.0.0.8 或 node-a.internal"}
                    value={form.tunnelEntryIp}
                    onChange={(e) => setForm({ ...form, tunnelEntryIp: e.target.value })}
                  />
                  {/*
                    Agent 报上来的本机内网 IP 只做建议，点了才填：这一栏决定隧道走内网，
                    不在同一个内网的机器被自动填上会连不通。
                  */}
                  {detectedPrivateIpv4 && form.tunnelEntryIp.trim() !== detectedPrivateIpv4 ? (
                    <button
                      type="button"
                      className="text-left text-xs text-primary hover:underline"
                      onClick={() => setForm({ ...form, tunnelEntryIp: detectedPrivateIpv4 })}
                    >
                      使用检测到的内网 IP {detectedPrivateIpv4}
                    </button>
                  ) : null}
                </FormField>
              </div>
              <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
                <FormField className="space-y-1">
                  <Label className="text-sm">网卡名称 <span className="text-xs text-muted-foreground">可选</span></Label>
                  <Input
                    className="h-8"
                    placeholder="eth0, ens33, bond0"
                    value={form.networkInterface}
                    onChange={(e) => setForm({ ...form, networkInterface: e.target.value })}
                  />
                </FormField>
              </div>
            </section>

            <section className="space-y-3 border-t border-border/40 pt-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <Label className="text-sm font-semibold">端口限制</Label>
                <span className="text-xs text-muted-foreground">留空不限</span>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <FormField className="space-y-1">
                  <Label className="text-xs text-muted-foreground">起始端口</Label>
                  <Input
                    className="h-8"
                    type="number"
                    min={1}
                    max={65535}
                    step={1}
                    placeholder="例如: 10000"
                    value={form.portRangeStart ?? ""}
                    onChange={(e) => {
                      const v = e.target.value ? parseInt(e.target.value) : null;
                      setForm({ ...form, portRangeStart: v });
                    }}
                  />
                </FormField>
                <FormField className="space-y-1">
                  <Label className="text-xs text-muted-foreground">结束端口</Label>
                  <Input
                    className="h-8"
                    type="number"
                    min={1}
                    max={65535}
                    step={1}
                    placeholder="例如: 20000"
                    value={form.portRangeEnd ?? ""}
                    onChange={(e) => {
                      const v = e.target.value ? parseInt(e.target.value) : null;
                      setForm({ ...form, portRangeEnd: v });
                    }}
                  />
                </FormField>
              </div>
              <div className="mt-2.5 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-xs text-muted-foreground">自定义端口</Label>
                  {customPortInputState.invalid.length === 0 && customPortInputState.ports.length > 0 ? (
                    <span className="text-xs text-muted-foreground">{customPortInputState.ports.length} 个</span>
                  ) : null}
                </div>
                <Input
                  placeholder="例如: 80,443,65095"
                  value={form.portAllowlist}
                  onChange={(e) => setForm({ ...form, portAllowlist: e.target.value })}
                  className={`h-8 ${customPortInputState.invalid.length > 0 ? "border-destructive focus-visible:ring-destructive" : ""}`}
                />
                {customPortInputState.invalid.length > 0 ? (
                  <p className="text-xs text-destructive">
                    自定义端口只能填写 1-65535 的整数，多个端口使用英文逗号分隔
                  </p>
                ) : null}
              </div>
              {form.portRangeStart != null && form.portRangeEnd != null && form.portRangeStart > form.portRangeEnd && (
                <p className="mt-3 text-xs text-destructive">
                  起始端口不能大于结束端口
                </p>
              )}
            </section>
            {user?.role === "admin" && (
              <section className="space-y-3 border-t border-border/40 pt-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <Label className="text-sm font-semibold">协议屏蔽</Label>
                  <span className="text-xs text-muted-foreground">访问策略</span>
                </div>
                <p data-fx-help="" className="rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
命中的连接会被拒绝，规则仍保持运行。{nginxFeatureEnabled ? "支持 NEX、Realm、GOST、Socat 和 Nginx；不支持 iptables/nftables。" : "支持 NEX、Realm、GOST 和 Socat；不支持 iptables/nftables。"}
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-muted/35 px-2.5 py-2">
                    <span className="min-w-0 truncate text-sm font-medium">HTTP</span>
                    <Checkbox aria-label="拦截 HTTP" className="shrink-0" checked={form.blockHttp} onCheckedChange={(checked) => setForm({ ...form, blockHttp: checked })} />
                  </label>
                  <label className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-muted/35 px-2.5 py-2">
                    <span className="min-w-0 truncate text-sm font-medium">SOCKS</span>
                    <Checkbox aria-label="拦截 SOCKS" className="shrink-0" checked={form.blockSocks} onCheckedChange={(checked) => setForm({ ...form, blockSocks: checked })} />
                  </label>
                  <label className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-muted/35 px-2.5 py-2">
                    <span className="min-w-0 truncate text-sm font-medium">TLS</span>
                    <Checkbox aria-label="拦截 TLS" className="shrink-0" checked={form.blockTls} onCheckedChange={(checked) => setForm({ ...form, blockTls: checked })} />
                  </label>
                </div>
              </section>
            )}
          </TabsContent>

          <TabsContent value="other" className="m-0 !animate-none">
            <section className="space-y-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <Label className="text-sm font-semibold">其他配置</Label>
                <span className="text-xs text-muted-foreground">主机统计</span>
              </div>
              {user?.role === "admin" ? (
                <>
                  <div className="grid min-w-0 gap-2.5 px-1 md:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-sm">机器购买时间</Label>
                      <DateTimePickerInput
                        value={form.purchasedAt}
                        onChange={(value) => setForm({ ...form, purchasedAt: value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-sm">机器停止时间</Label>
                      <DateTimePickerInput
                        value={form.stoppedAt}
                        onChange={(value) => setForm({ ...form, stoppedAt: value })}
                        align="end"
                      />
                    </div>
                    <FormField className="min-w-0 space-y-1">
                      <Label className="text-sm">账单周期</Label>
                      <Select
                        value={String(normalizeHostBillingCycleMonths(form.billingCycleMonths))}
                        onValueChange={(value) => setForm({ ...form, billingCycleMonths: normalizeHostBillingCycleMonths(value) })}
                      >
                        <SelectTrigger className="h-8 min-w-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1">月付</SelectItem>
                          <SelectItem value="3">季付</SelectItem>
                          <SelectItem value="6">半年付</SelectItem>
                          <SelectItem value="12">年付</SelectItem>
                          <SelectItem value="24">两年付</SelectItem>
                          <SelectItem value="36">三年付</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                    <div className="min-w-0 space-y-1">
                      <Label className="text-sm">账单月日</Label>
                      <div className="grid min-w-0 grid-cols-2 gap-2">
                        <Select
                          value={String(clampBillingMonth(form.billingMonth))}
                          onValueChange={(value) => setForm({ ...form, billingMonth: clampBillingMonth(Number(value)) })}
                        >
                          <SelectTrigger aria-label="账单月" className="h-8 min-w-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                              <SelectItem key={month} value={String(month)}>{month} 月</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={String(clampBillingDay(form.billingDay))}
                          onValueChange={(value) => setForm({ ...form, billingDay: clampBillingDay(Number(value)) })}
                        >
                          <SelectTrigger aria-label="账单日" className="h-8 min-w-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                              <SelectItem key={day} value={String(day)}>{day} 日</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <FormField className="min-w-0 space-y-1">
                      <Label className="text-sm">机器到期处理</Label>
                      <Select
                        value={normalizeHostExpiryAction(form.expiryHandling)}
                        onValueChange={(value) => setForm({ ...form, expiryHandling: normalizeHostExpiryAction(value) })}
                      >
                        <SelectTrigger className="h-8 min-w-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">不处理</SelectItem>
                          <SelectItem value="extend_cycle">周期顺延</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField className="min-w-0 space-y-1">
                      <Label className="text-sm">套餐流量</Label>
                      <div className="flex h-8 min-w-0 overflow-hidden rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
                        <Input
                          className="h-8 min-w-0 flex-1 rounded-none border-0 bg-transparent px-3 py-1 focus-visible:border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                          type="text"
                          inputMode="decimal"
                          placeholder="例如: 2000"
                          value={form.trafficLimitGb}
                          onChange={(e) => setForm({ ...form, trafficLimitGb: e.target.value })}
                        />
                        <span className="flex h-full shrink-0 items-center border-l border-border/60 bg-muted/50 px-2.5 text-sm text-muted-foreground">
                          GB
                        </span>
                      </div>
                    </FormField>
                    <FormField className="min-w-0 space-y-1">
                      <Label className="text-sm">流量计算</Label>
                      <Select
                        value={form.trafficMeasureMode}
                        onValueChange={(value) => setForm({ ...form, trafficMeasureMode: normalizeHostTrafficMeasureMode(value) })}
                      >
                        <SelectTrigger className="h-8 min-w-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="outbound">仅出向</SelectItem>
                          <SelectItem value="both">双向</SelectItem>
                          <SelectItem value="max">取最大值</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                  </div>
                  {/* 费用（主机账本用）：默认收起，收起时一行写着填了什么。 */}
                  <HostCostFields
                    className="mx-1 mt-2.5"
                    value={form.cost}
                    cycleMonths={normalizeHostBillingCycleMonths(form.billingCycleMonths)}
                    onChange={(cost) => setForm({ ...form, cost })}
                  />
                  <div data-fx-setting-box="" className="mt-2.5 flex min-h-9 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between" data-host-traffic-failover-setting="">
                    <div className="min-w-0 space-y-0.5">
                      <Label className="text-sm font-medium">流量故障转移</Label>
                      {/*
                        上游 v2.3.281。和下面的「流量耗尽提醒」是两回事：提醒只发消息，这个会真的
                        把这台从组里摘出去（转发组、入口组、出口组、多出口隧道），组里换别的成员顶上。
                        只改运行时，成员和端口都不删；流量重置（手动或每月自动）或关掉这个开关就恢复。
                      */}
                      <p data-fx-help="" className="text-xs text-muted-foreground">用到这个比例后暂停参与组调度，流量重置后恢复。</p>
                      {editingHostRow && hostTrafficExcluded(editingHostRow) ? (
                        <p className="text-xs text-[var(--fx-warn-text)]">已到阈值，正暂停参与组调度。</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <div className="flex h-8 w-20 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                        <Input aria-label="流量故障转移阈值（%）"
                          className="h-8 rounded-none border-0 px-2 text-right focus-visible:ring-0 focus-visible:ring-offset-0"
                          type="number"
                          min={1}
                          max={100}
                          step={1}
                          disabled={!form.trafficFailoverEnabled}
                          value={form.trafficFailoverThresholdPercent}
                          onChange={(e) => setForm({ ...form, trafficFailoverThresholdPercent: normalizeHostTrafficFailoverPercent(e.target.value) })}
                        />
                        <span className="flex h-8 shrink-0 items-center border-l border-border/60 bg-muted/50 px-1.5 text-sm text-muted-foreground">%</span>
                      </div>
                      <Checkbox aria-label="流量故障转移"
                        checked={form.trafficFailoverEnabled}
                        onCheckedChange={(checked) => setForm({ ...form, trafficFailoverEnabled: checked })}
                      />
                    </div>
                  </div>
                  <div data-fx-setting-box="" className="mt-2.5 flex min-h-9 items-center justify-between gap-3 rounded-md bg-muted/35 px-3 py-2">
                    <div className="min-w-0 space-y-0.5">
                      <Label className="text-sm font-medium">上下线通知</Label>
                      <p data-fx-help="" className="text-xs text-muted-foreground">掉线、恢复时推送给管理员。</p>
                    </div>
                    <Checkbox aria-label="上下线通知"
                      checked={form.hostStatusNotifyEnabled}
                      onCheckedChange={(checked) => setForm({ ...form, hostStatusNotifyEnabled: checked })}
                    />
                  </div>
                  <div data-fx-setting-box="" className="mt-2.5 flex min-h-9 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-0.5">
                      <Label className="text-sm font-medium">流量耗尽提醒</Label>
                      {/*
                        原来这个开关被绑死在「TG 机器人已配置」上，没用 Telegram 的
                        商家根本打不开 —— 机房流量跑超、机器停机，他名下所有转发和
                        落地节点一起断，却没有任何人告诉他。现在邮件那一路也会发，
                        开关只管「这台机器要不要提醒」，走哪个渠道看你配了什么。
                      */}
                      <p className="text-xs text-muted-foreground">{reminderChannelHint}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <div className="flex h-8 w-20 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                        <Input aria-label="流量耗尽提醒阈值（%）"
                          className="h-8 rounded-none border-0 px-2 text-right focus-visible:ring-0 focus-visible:ring-offset-0"
                          type="number"
                          min={1}
                          max={99}
                          step={1}
                          value={form.trafficAlertThresholdPercent}
                          onChange={(e) => setForm({ ...form, trafficAlertThresholdPercent: clampTrafficAlertThresholdPercent(Number(e.target.value)) })}
                        />
                        <span className="flex h-8 shrink-0 items-center border-l border-border/60 bg-muted/50 px-1.5 text-sm text-muted-foreground">%</span>
                      </div>
                      <Checkbox aria-label="流量耗尽提醒"
                        checked={form.telegramTrafficAlertEnabled}
                        onCheckedChange={(checked) => setForm({ ...form, telegramTrafficAlertEnabled: checked })}
                      />
                    </div>
                  </div>
                  <div data-fx-setting-box="" className="mt-2.5 flex min-h-9 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-0.5">
                      <Label className="text-sm font-medium">续费提醒</Label>
                      <p className="text-xs text-muted-foreground">
                        剩余天数不足时提醒。{reminderChannelHint}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <div className="flex h-8 w-24 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                        <Input aria-label="续费提醒提前天数"
                          className="h-8 rounded-none border-0 px-2 text-right focus-visible:ring-0 focus-visible:ring-offset-0"
                          type="number"
                          min={1}
                          max={365}
                          step={1}
                          value={form.renewalReminderDays}
                          onChange={(e) => setForm({ ...form, renewalReminderDays: clampRenewalReminderDays(Number(e.target.value)) })}
                        />
                        <span className="flex h-8 shrink-0 items-center border-l border-border/60 bg-muted/50 px-2 text-sm text-muted-foreground">天</span>
                      </div>
                      <Checkbox aria-label="续费提醒"
                        checked={form.telegramRenewalReminderEnabled}
                        onCheckedChange={(checked) => setForm({ ...form, telegramRenewalReminderEnabled: checked })}
                      />
                    </div>
                  </div>
                  <div data-fx-setting-box="" className="mt-2.5 flex min-h-9 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <Label className="text-sm font-medium">自动重置流量</Label>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Select
                        value={String(clampMonthlyResetDay(form.trafficResetDay))}
                        onValueChange={(value) => setForm({ ...form, trafficResetDay: clampMonthlyResetDay(Number(value)) })}
                      >
                        <SelectTrigger aria-label="每月流量重置日" className="h-8 w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                            <SelectItem key={day} value={String(day)}>{day} 号</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Checkbox aria-label="每月自动清零" checked={form.trafficAutoReset} onCheckedChange={(checked) => setForm({ ...form, trafficAutoReset: checked })} />
                    </div>
                  </div>
                  <div data-fx-setting-box="" className="mt-2.5 flex min-h-9 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-0.5">
                      <Label className="text-sm font-medium">线路带宽</Label>
                      <p data-fx-help="" className="text-xs text-muted-foreground">商家给的带宽，负载均衡按它分，不限速。</p>
                    </div>
                    <div className="flex h-8 w-36 shrink-0 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                      <Input aria-label="线路带宽（Mbit/s）"
                        className="h-8 min-w-0 rounded-none border-0 px-2 text-right tabular-nums focus-visible:ring-0 focus-visible:ring-offset-0"
                        type="number"
                        min={0}
                        max={1000000}
                        inputMode="numeric"
                        placeholder="没填"
                        value={form.lineBandwidthMbps > 0 ? form.lineBandwidthMbps : ""}
                        onChange={(e) => setForm({ ...form, lineBandwidthMbps: Math.min(1_000_000, Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
                      />
                      <span className="flex h-8 shrink-0 items-center border-l border-border/60 bg-muted/50 px-2 text-xs text-muted-foreground">Mbit/s</span>
                    </div>
                  </div>
                  {user?.role === "admin" && editingId ? (
                    <div data-fx-setting-box="" className="mt-2.5 flex min-h-9 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0 space-y-0.5">
                        <Label className="text-sm font-medium">整台主机转发限速</Label>
                        <p data-fx-help="" className="text-xs text-muted-foreground">所有用户合计上限，0 = 不限。</p>
                      </div>
                      <div className="flex h-8 w-36 shrink-0 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                        <Input aria-label="整台主机转发限速（Mbit/s）"
                          className="h-8 min-w-0 rounded-none border-0 px-2 text-right tabular-nums focus-visible:ring-0 focus-visible:ring-offset-0"
                          type="number"
                          min={0}
                          max={1000000}
                          inputMode="numeric"
                          placeholder="不限"
                          value={form.rateLimitMbps > 0 ? form.rateLimitMbps : ""}
                          onChange={(e) => setForm({ ...form, rateLimitMbps: Math.min(1_000_000, Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
                        />
                        <span className="flex h-8 shrink-0 items-center border-l border-border/60 bg-muted/50 px-2 text-xs text-muted-foreground">Mbit/s</span>
                      </div>
                    </div>
                  ) : null}
                  <div data-fx-setting-box="" className="mt-2.5 flex min-h-9 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-0.5">
                      <Label className="text-sm font-medium">公网出口整形</Label>
                      {form.egressShapingMode === "auto" ? (
                        <p className="text-xs text-muted-foreground" data-host-egress-status="">
                          {describeHostEgressShaping(editingHostRow?.egressShapingStatus)}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {form.egressShapingMode === "manual" ? (
                        <div className="flex h-8 w-36 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                          <Input aria-label="公网带宽上限（Mbit/s）"
                            className="h-8 min-w-0 rounded-none border-0 px-2 text-right tabular-nums focus-visible:ring-0 focus-visible:ring-offset-0"
                            type="number"
                            min={0}
                            max={HOST_EGRESS_MBPS_MAX}
                            inputMode="numeric"
                            placeholder="例如: 500"
                            value={form.egressMbps > 0 ? form.egressMbps : ""}
                            onChange={(e) => setForm({ ...form, egressMbps: normalizeHostEgressMbpsInput(e.target.value) })}
                          />
                          <span className="flex h-8 shrink-0 items-center border-l border-border/60 bg-muted/50 px-2 text-xs text-muted-foreground">Mbit/s</span>
                        </div>
                      ) : null}
                      <Select
                        value={form.egressShapingMode}
                        onValueChange={(value) => setForm({ ...form, egressShapingMode: normalizeHostEgressShapingMode(value) })}
                      >
                        <SelectTrigger aria-label="公网出口整形" className="h-8 w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">自动</SelectItem>
                          <SelectItem value="manual">手动</SelectItem>
                          <SelectItem value="off">关</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {editingId ? (
                    <div data-fx-setting-box="" className="mt-2.5 flex min-h-9 items-start justify-between gap-3 rounded-md bg-muted/35 px-3 py-2">
                      <div className="min-w-0 space-y-0.5">
                        <Label className="text-sm font-medium">内核快速转发</Label>
                        <p className="text-xs text-muted-foreground">
                          跳过逐包检查，更省 CPU（Linux 6.1 起）。
                        </p>
                        {form.flowOffload && editingHostRow?.flowOffloadStatus ? (
                          <p className="text-xs text-muted-foreground" data-host-flow-offload-status="">
                            {describeHostFlowOffload(editingHostRow.flowOffloadStatus)}
                          </p>
                        ) : null}
                      </div>
                      <Checkbox
                        aria-label="内核快速转发"
                        checked={form.flowOffload}
                        onCheckedChange={(checked) => setForm({ ...form, flowOffload: checked })}
                      />
                    </div>
                  ) : null}
                  <div data-fx-setting-box="" className="mt-2.5 space-y-2 rounded-md bg-muted/35 px-3 py-2.5">
                    <FormField className="flex min-h-8 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-center gap-2">
                        <RadioTower className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <Label className="text-sm font-medium">DDNS 服务</Label>
                        {!ddnsProviderEnabled ? (
                          <Badge variant="secondary" className="shrink-0 text-[11px]">未配置服务商</Badge>
                        ) : null}
                      </div>
                      <Checkbox
                        checked={form.ddnsEnabled}
                        disabled={!ddnsProviderEnabled && !form.ddnsEnabled}
                        onCheckedChange={(checked) => setForm({ ...form, ddnsEnabled: checked })}
                      />
                    </FormField>
                    <div className="grid min-w-0 gap-2.5 sm:grid-cols-[8rem_7rem_minmax(0,1fr)]">
                      <Select
                        value={form.ddnsIpVersion}
                        disabled={!ddnsProviderEnabled}
                        onValueChange={(value) => setForm({ ...form, ddnsIpVersion: normalizeHostDdnsIpVersion(value) })}
                      >
                        <SelectTrigger aria-label="DDNS 记录类型" className="h-8 min-w-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ipv4">IPv4 / A</SelectItem>
                          <SelectItem value="ipv6">IPv6 / AAAA</SelectItem>
                          <SelectItem value="dual">双栈 / A + AAAA</SelectItem>
                        </SelectContent>
                      </Select>
                      {/* 仅主 IP（老配置默认）/ 全部 IP：检测到的每个地址各发一条同名记录（shared/hostDdnsPlan） */}
                      <Select
                        value={form.ddnsValueMode}
                        disabled={!ddnsProviderEnabled}
                        onValueChange={(value) => setForm({ ...form, ddnsValueMode: normalizeHostDdnsValueMode(value) })}
                      >
                        <SelectTrigger aria-label="DDNS 记录值" className="h-8 min-w-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="primary">仅主 IP</SelectItem>
                          <SelectItem value="all">全部 IP</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        className="h-8 min-w-0"
                        placeholder="例如: node.example.com"
                        value={form.ddnsDomain}
                        disabled={!ddnsProviderEnabled}
                        onChange={(e) => setForm({ ...form, ddnsDomain: e.target.value })}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      IP 变了自动更新解析。{form.ddnsIpVersion === "dual" ? "双栈：A 发 IPv4、AAAA 发 IPv6，哪一族没有地址就先不动那一族。" : ""}
                    </p>
                    {form.ddnsValueMode === "all" ? (
                      <p
                        className={`text-xs ${ddnsProviderSupportsMultipleValues(panelFlags.ddnsProvider) ? "text-muted-foreground" : "text-[var(--fx-warn-text)]"}`}
                        data-host-ddns-value-mode-note=""
                      >
                        全部 IP：Agent 检测到的每个公网地址各一条同名记录，主 IP 排第一；旧 Agent 没报列表时只发主 IP。
                        {hostDdnsProviderValueModeNote(panelFlags.ddnsProvider)}
                      </p>
                    ) : null}
                  </div>
                  {/* Agent 面板连接地址 / 流量阈值关机 / 本机资源告警 / 安装实例：单独保存，见 HostAgentManagementSection */}
                  {editingId ? <HostAgentManagementSection hostId={Number(editingId)} /> : null}
                </>
              ) : (
                <div className="rounded-md bg-muted/35 px-3 py-2 text-sm text-muted-foreground">
                  仅管理员可配置主机其他配置。
                </div>
              )}
            </section>
          </TabsContent>

        </div>
      </Tabs>
      <DialogFooter className="shrink-0 pt-2">
        <Button variant="outline" onClick={hostDialogGuard.requestClose}>
          取消
        </Button>
        <Button onClick={handleSubmit} disabled={isPending || !form.name}>
          {isPending ? "处理中..." : "保存"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  );
}
