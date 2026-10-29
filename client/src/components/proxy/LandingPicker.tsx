/**
 * 落地选择器：挑一台落地主机上的 Shadowsocks 入站。
 *
 * 转发规则的「出口」（RuleEgressSection）和落地节点的「分流」（InboundRoutingEditor）以前各画各的下拉、
 * 各问各的接口；现在都用这一个：数据来自 proxyInbounds.landingOptions（按主机分组，每个入站带方法、
 * 启停、能不能做出口、所在主机最新一次解锁检测各服务的结论），界面是「主机 → 入站」两级下拉。
 *
 * 先选主机再选入站，而不是一个下拉把「主机 · 入站」平铺：没有入站的主机也要能选中，选中之后才能
 * 「一键创建落地 SS 入站」（allowCreate）。谁能选、谁不能选（SS2022 要入口机能力、自己不能当自己的落地）
 * 由调用方通过 excludeHostIds / filterInbound 决定，这里只负责画和拦。
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";

import { StatusDot } from "@/components/network/StatusDot";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { SS_EGRESS_DEFAULT_METHOD, SS_EGRESS_METHODS } from "@shared/ssEgress";
import { UNLOCK_SERVICES, UNLOCK_STATUS_LABELS, type UnlockStatus } from "@shared/unlockCheck";

/** 和 server/landingOptions.ts 的 LandingOptionInbound / LandingOptionHost 同一个形状。 */
export type LandingInbound = {
  id: number;
  name: string;
  port: number;
  method: string;
  methodError: string | null;
  isEnabled: boolean;
  landingEgress: boolean;
  unlock: Record<string, UnlockStatus>;
  unlockCheckedAt: number;
};

export type LandingHost = {
  hostId: number;
  name: string;
  isOnline: boolean;
  hasAddress: boolean;
  ownHost: boolean;
  canCreateInbound: boolean;
  inbounds: LandingInbound[];
};

export type LandingPickerValue = {
  /** 选中的主机；只知道入站 id 时可以留空，选择器会从清单里反查。 */
  hostId: number | null;
  inboundId: number | null;
};

export type LandingPickerProps = {
  value: LandingPickerValue | null;
  onChange: (next: LandingPickerValue) => void;
  /** 这些主机不能当落地（规则的入口机 / 隧道出口机、节点自己所在的主机），清单里不列。 */
  excludeHostIds?: number[];
  /** 入站不能选时给原因（例如「不支持做出口」「已停用」「入口机需升级才能用 SS2022」）；返回 null 表示能选。 */
  filterInbound?: (inbound: LandingInbound, host: LandingHost) => string | null;
  /** 入站后面带上所在主机最新一次解锁检测的结论（分流编辑器用）。 */
  showUnlock?: boolean;
  /** showUnlock 时只显示这几个服务的结论；不传就显示测过的全部。 */
  unlockServices?: string[];
  /** 选中的主机上没有能用的入站时，给「一键创建落地 SS 入站」按钮（proxyInbounds.createLandingEgress）。 */
  allowCreate?: boolean;
  /** 紧凑版：矮一点的触发器、不带字段标题（嵌在分流那种一行一行的表单里）。 */
  compact?: boolean;
  /** 一台能用的主机都没有时的说明；不传就用通用的一句。 */
  emptyMessage?: string;
  /** 让 aria-label 能区分同一页上的多个选择器（例如「第 2 条分流」）。 */
  labelPrefix?: string;
  disabled?: boolean;
  className?: string;
};

const STATUS_TONE: Record<UnlockStatus, string> = {
  ok: "text-[var(--fx-healthy-text)]",
  partial: "text-[var(--fx-warn-text)]",
  blocked: "text-[var(--fx-down-text)]",
  unknown: "text-muted-foreground",
};

/** 落地清单（react-query 按 key 合并：同一页上几处用的是同一次请求）。 */
export function useLandingOptions(enabled = true) {
  const query = trpc.proxyInbounds.landingOptions.useQuery(undefined, {
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  return { ...query, hosts: (query.data || []) as LandingHost[] };
}

/** 入站上所在主机最新检测的结论，一个服务一个小标签。 */
export function LandingUnlockChips({ inbound, services, className }: { inbound: LandingInbound; services?: string[]; className?: string }) {
  const ids = services && services.length > 0 ? services : UNLOCK_SERVICES.filter((service) => inbound.unlock[service.id]).map((service) => service.id);
  if (ids.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {ids.map((id) => {
        const status = inbound.unlock[id];
        const service = UNLOCK_SERVICES.find((item) => item.id === id);
        return (
          <span
            key={id}
            className={cn("rounded-[var(--fx-radius-pill)] bg-muted/60 px-1.5 text-[11px] leading-4", status ? STATUS_TONE[status] : "text-muted-foreground")}
            title={`${service?.name || id}：${status ? UNLOCK_STATUS_LABELS[status] : "没测过"}`}
          >
            {service?.short || id} {status ? UNLOCK_STATUS_LABELS[status] : "没测过"}
          </span>
        );
      })}
    </span>
  );
}

export function LandingPicker({
  value,
  onChange,
  excludeHostIds,
  filterInbound,
  showUnlock = false,
  unlockServices,
  allowCreate = false,
  compact = false,
  emptyMessage,
  labelPrefix = "",
  disabled = false,
  className,
}: LandingPickerProps) {
  const utils = trpc.useUtils();
  const options = useLandingOptions();
  const excluded = useMemo(() => new Set((excludeHostIds || []).map(Number)), [excludeHostIds]);
  const hosts = useMemo(() => options.hosts.filter((host) => !excluded.has(Number(host.hostId))), [excluded, options.hosts]);
  const blockReason = (inbound: LandingInbound, host: LandingHost): string | null => {
    if (filterInbound) return filterInbound(inbound, host);
    if (inbound.methodError) return "不支持做出口";
    if (!inbound.isEnabled) return "已停用";
    return null;
  };

  // 只知道入站 id（分流存的就是它）时从清单里反查主机；调用方不存主机时，刚选的主机（还没选入站）记在这里，
  // 不然选中一台没有入站的主机会立刻弹回去，「一键创建」就没法点。
  const [pickedHostId, setPickedHostId] = useState<number | null>(null);
  const inboundId = value?.inboundId ? Number(value.inboundId) : null;
  const derivedHostId = inboundId ? hosts.find((host) => host.inbounds.some((inbound) => inbound.id === inboundId))?.hostId ?? null : null;
  const hostId = value?.hostId ? Number(value.hostId) : derivedHostId ?? pickedHostId;
  const selectedHost = hosts.find((host) => host.hostId === hostId) || null;
  const selectedInbound = selectedHost?.inbounds.find((inbound) => inbound.id === inboundId) || null;
  const usableInbounds = selectedHost ? selectedHost.inbounds.filter((inbound) => !blockReason(inbound, selectedHost)) : [];

  const createLanding = trpc.proxyInbounds.createLandingEgress.useMutation({
    onSuccess: async (result) => {
      toast.success(`已在落地主机上创建 Shadowsocks 入站（${result.method}，端口 ${result.port}）`);
      await Promise.all([
        utils.proxyInbounds.landingOptions.invalidate(),
        utils.proxyInbounds.egressLandingOptions.invalidate(),
        utils.proxyInbounds.routingLandingOptions.invalidate(),
      ]);
      onChange({ hostId: Number(result.hostId), inboundId: Number(result.id) });
    },
    onError: (error) => toast.error(error.message || "创建落地入站失败"),
  });

  const pickHost = (next: string) => {
    const host = hosts.find((item) => item.hostId === Number(next));
    const first = host ? host.inbounds.find((inbound) => !blockReason(inbound, host)) : null;
    setPickedHostId(Number(next));
    onChange({ hostId: Number(next), inboundId: first ? first.id : null });
  };

  const triggerClass = cn("min-w-0", compact && "h-8");
  const hostSelect = (
    <Select value={hostId ? String(hostId) : undefined} disabled={disabled || options.isLoading} onValueChange={pickHost}>
      <SelectTrigger className={triggerClass} aria-label={`${labelPrefix}落地主机`}>
        <SelectValue placeholder={options.isLoading ? "加载中…" : "选择落地主机"} />
      </SelectTrigger>
      <SelectContent>
        {hosts.map((host) => (
          <SelectItem key={host.hostId} value={String(host.hostId)} textValue={host.name}>
            <span className="inline-flex min-w-0 items-center gap-2">
              <StatusDot health={host.isOnline ? "healthy" : "down"} label={host.isOnline ? "在线" : "离线"} className="shadow-none" />
              <span className="truncate">{host.name}</span>
              {!host.isOnline
                ? <span className="text-muted-foreground">（离线）</span>
                : host.inbounds.length === 0
                  ? <span className="text-muted-foreground">（无 SS 入站）</span>
                  : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const inboundSelect = (
    <Select
      value={inboundId ? String(inboundId) : undefined}
      disabled={disabled || !selectedHost || selectedHost.inbounds.length === 0}
      onValueChange={(next) => onChange({ hostId: selectedHost ? selectedHost.hostId : hostId, inboundId: Number(next) })}
    >
      <SelectTrigger className={triggerClass} aria-label={`${labelPrefix}Shadowsocks 入站`}>
        <SelectValue placeholder={selectedHost && selectedHost.inbounds.length === 0 ? "这台主机还没有 SS 入站" : "选择入站"} />
      </SelectTrigger>
      <SelectContent>
        {(selectedHost?.inbounds || []).map((inbound) => {
          const reason = selectedHost ? blockReason(inbound, selectedHost) : null;
          return (
            <SelectItem key={inbound.id} value={String(inbound.id)} disabled={!!reason} textValue={`${inbound.name} ${inbound.port}`}>
              <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="truncate">{inbound.name} :{inbound.port} · {inbound.method}</span>
                {reason ? <span className="text-muted-foreground">（{reason}）</span> : null}
                {showUnlock && !reason ? <LandingUnlockChips inbound={inbound} services={unlockServices} /> : null}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );

  return (
    <div className={cn("space-y-2", className)} data-testid="landing-picker">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {compact ? hostSelect : (
          <FormField className="min-w-0 space-y-1.5">
            <Label>落地主机</Label>
            {hostSelect}
          </FormField>
        )}
        {compact ? inboundSelect : (
          <FormField className="min-w-0 space-y-1.5">
            <Label>Shadowsocks 入站</Label>
            {inboundSelect}
          </FormField>
        )}
      </div>
      {selectedHost && !selectedHost.isOnline && (
        <p className="text-meta text-[var(--fx-warn-text)]">这台落地主机当前离线，保存前请先让它上线。</p>
      )}
      {showUnlock && selectedInbound && (
        <p className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted-foreground">
          <span>「{selectedHost?.name} · {selectedInbound.name}」最新检测：</span>
          {selectedInbound.unlockCheckedAt > 0 || (unlockServices && unlockServices.length > 0)
            ? <LandingUnlockChips inbound={selectedInbound} services={unlockServices} />
            : <span>没测过</span>}
        </p>
      )}
      {allowCreate && selectedHost && usableInbounds.length === 0 && (
        <div className="flex min-w-0 flex-col gap-2 rounded-md bg-muted/35 px-2.5 py-2 sm:flex-row sm:items-center">
          <span className="min-w-0 flex-1 text-meta leading-5 text-muted-foreground">
            {selectedHost.inbounds.length > 0
              ? `这台主机上的 SS 入站都不能做出口（只支持 ${SS_EGRESS_METHODS.join(" / ")}）。`
              : "这台主机上还没有能做出口的 Shadowsocks 入站。"}
          </span>
          {selectedHost.canCreateInbound ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full shrink-0 sm:w-auto"
              disabled={disabled || createLanding.isPending || !selectedHost.isOnline}
              onClick={() => createLanding.mutate({ hostId: Number(selectedHost.hostId) })}
            >
              {createLanding.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              一键创建落地 SS 入站
            </Button>
          ) : (
            <span className="text-meta text-muted-foreground">请联系管理员在这台主机上开一个。</span>
          )}
        </div>
      )}
      {allowCreate && selectedHost && usableInbounds.length === 0 && (
        <p className="text-meta leading-5 text-muted-foreground">
          一键创建的入站用 {SS_EGRESS_DEFAULT_METHOD}、随机密码，端口从这台主机的端口范围里挑，默认不进订阅。
        </p>
      )}
      {!options.isLoading && hosts.length === 0 && (
        <p className="text-meta text-muted-foreground">{emptyMessage || "还没有可以当落地的主机：需要自己的主机，或管理员授权的主机。"}</p>
      )}
    </div>
  );
}
