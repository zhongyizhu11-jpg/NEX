/**
 * 规则编辑器里的「出口」一段：直接连接 / 落地主机（Shadowsocks）/ 外部 Shadowsocks 链接。
 *
 * 规则（能用哪些方法、UDP / SS2022 要入口机有什么能力、规则形态的限制）都在 shared/ssEgress.ts，
 * 和服务端同一份；这里只负责选和提示。最终以服务端校验为准。
 *
 * UDP 走出口（规则协议选 TCP+UDP）和 SS2022 出口要每一台入口机都报了能力（Agent 2.2.227 起、gost 运行时
 * 3.2.6-nex3 起）：撑不起时 TCP+UDP 选不了、SS2022 入站不可选，并写清楚是哪台机器、要升级什么。
 */

import { useMemo } from "react";
import { toast } from "sonner";
import { ArrowRightLeft, Globe2, Link2, Loader2, Plus, Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import {
  isSs2022Method,
  parseSsEgressLink,
  RULE_EGRESS_TYPE_LABELS,
  SS_EGRESS_DEFAULT_METHOD,
  SS_EGRESS_METHODS,
  SS_EGRESS_UDP_SUPPORTED,
  type RuleEgressType,
} from "@shared/ssEgress";

export type RuleEgressFormValue = {
  egressType: RuleEgressType;
  /** 选中的落地主机（只给选择器用，提交的是入站 id）。 */
  egressHostId: number | null;
  egressInboundId: number | null;
  /** 新粘贴的 ss:// 链接；编辑时留空 = 不改。 */
  egressLink: string;
  /** 已保存的链接打码后的样子（编辑时显示）。 */
  egressLinkMasked: string;
  egressUdp: boolean;
};

export const DEFAULT_RULE_EGRESS_FORM: RuleEgressFormValue = {
  egressType: "none",
  egressHostId: null,
  egressInboundId: null,
  egressLink: "",
  egressLinkMasked: "",
  egressUdp: false,
};

type Props = {
  value: RuleEgressFormValue;
  onChange: (patch: Partial<RuleEgressFormValue>) => void;
  /** 选了出口之后整张表单要跟着变的（gost、TCP、关掉线路组）由上层做。 */
  onEgressEnabled: (type: RuleEgressType) => void;
  /** 当前规则能不能挂出口；不能时给原因（例如旧版端口转发规则）。 */
  blockedReason?: string | null;
  /** 选了出口之后要额外说明的一句（例如这条规则会改用 gost 转发）。 */
  runtimeNote?: string | null;
  /** 规则在哪些主机上监听：这些主机不能当落地。 */
  entryHostIds: number[];
  isAdmin: boolean;
};

export type EgressEntryCapabilities = {
  /** 还在问服务端。 */
  loading: boolean;
  /** 每台入口机都能让 UDP 走出口。 */
  udp: boolean;
  /** 每台入口机都能用 SS2022 出口。 */
  ss2022: boolean;
  /** 不能时第一台撑不起的机器的原因。 */
  udpReason: string | null;
  ss2022Reason: string | null;
};

/**
 * 入口机现在的出口能力（Agent 上报的 ssEgressUdp / ssEgress2022）。规则编辑器的出口一段和保存前的
 * 拦截共用这一个查询（react-query 按 key 合并成一次请求）。
 */
export function useEgressEntryCapabilities(entryHostIds: number[], enabled: boolean): EgressEntryCapabilities {
  const hostIds = useMemo(() => Array.from(new Set(entryHostIds.map(Number).filter((id) => id > 0))).sort((a, b) => a - b), [entryHostIds]);
  const query = trpc.proxyInbounds.egressEntryCapabilities.useQuery({ hostIds }, {
    enabled: enabled && hostIds.length > 0,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  return useMemo(() => {
    const rows = (query.data || []) as Array<{ udp: boolean; ss2022: boolean; udpMessage: string | null; ss2022Message: string | null }>;
    if (!enabled || hostIds.length === 0 || query.isLoading || !query.data) {
      const reason = hostIds.length === 0 ? "请先选择入口主机" : "正在检查入口主机的 Agent / 运行时…";
      return { loading: enabled && hostIds.length > 0 && query.isLoading, udp: false, ss2022: false, udpReason: reason, ss2022Reason: reason };
    }
    const udpMissing = rows.find((row) => !row.udp);
    const ss2022Missing = rows.find((row) => !row.ss2022);
    return {
      loading: false,
      udp: SS_EGRESS_UDP_SUPPORTED && rows.length > 0 && !udpMissing,
      ss2022: rows.length > 0 && !ss2022Missing,
      udpReason: udpMissing ? udpMissing.udpMessage || "入口主机还不支持 UDP 走出口" : null,
      ss2022Reason: ss2022Missing ? ss2022Missing.ss2022Message || "入口主机还不支持 SS2022 出口" : null,
    };
  }, [enabled, hostIds.length, query.data, query.isLoading]);
}

const OPTIONS: Array<{ type: RuleEgressType; short: string; icon: typeof Server }> = [
  { type: "none", short: "直接连接", icon: ArrowRightLeft },
  { type: "ss_host", short: "落地主机", icon: Server },
  { type: "ss_link", short: "外部 SS 链接", icon: Link2 },
];

export function RuleEgressSection({ value, onChange, onEgressEnabled, blockedReason, runtimeNote, entryHostIds, isAdmin }: Props) {
  const utils = trpc.useUtils();
  const optionsQuery = trpc.proxyInbounds.egressLandingOptions.useQuery(undefined, {
    enabled: value.egressType === "ss_host",
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const createLanding = trpc.proxyInbounds.createLandingEgress.useMutation({
    onSuccess: async (result) => {
      toast.success(`已在落地主机上创建 Shadowsocks 入站（${result.method}，端口 ${result.port}）`);
      await utils.proxyInbounds.egressLandingOptions.invalidate();
      onChange({ egressHostId: result.hostId, egressInboundId: Number(result.id) });
    },
    onError: (error) => toast.error(error.message || "创建落地入站失败"),
  });

  const capabilities = useEgressEntryCapabilities(entryHostIds, value.egressType !== "none");
  const entrySet = useMemo(() => new Set(entryHostIds.map(Number)), [entryHostIds]);
  const hosts = useMemo(
    () => ((optionsQuery.data || []) as any[]).filter((host) => !entrySet.has(Number(host.hostId))),
    [entrySet, optionsQuery.data],
  );
  const selectedHost = hosts.find((host) => Number(host.hostId) === Number(value.egressHostId)) || null;
  // SS2022 入站要每台入口机都有 ssEgress2022 能力；撑不起时照样列出来，但不能选。
  const inboundBlockReason = (inbound: any): string | null => {
    if (inbound.methodError) return "不支持做出口";
    if (!inbound.isEnabled) return "已停用";
    if (isSs2022Method(inbound.method) && !capabilities.ss2022) return "入口机需升级才能用 SS2022";
    return null;
  };
  const usableInbounds = (selectedHost?.inbounds || []).filter((inbound: any) => !inboundBlockReason(inbound));
  const selectedInbound = (selectedHost?.inbounds || []).find((inbound: any) => Number(inbound.id) === Number(value.egressInboundId)) || null;
  const linkPreview = value.egressType === "ss_link" && value.egressLink.trim() ? parseSsEgressLink(value.egressLink) : null;

  const pick = (type: RuleEgressType) => {
    if (type === value.egressType) return;
    if (type !== "none" && blockedReason) return;
    onChange({ egressType: type, egressUdp: false });
    if (type !== "none") onEgressEnabled(type);
  };

  return (
    <section className="space-y-2.5 rounded-[var(--fx-radius-card)] bg-[var(--fx-l2-group)] px-3 py-2.5" data-testid="rule-egress-section">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <Label className="text-sm font-medium">出口</Label>
        <span className="min-w-0 truncate text-meta text-muted-foreground">目标看到的来源 IP 是谁</span>
      </div>
      <div className={segmentedControlClassName} role="group" aria-label="出口">
        <div className="grid grid-cols-3 gap-1">
          {OPTIONS.map((option) => {
            const active = value.egressType === option.type;
            const disabled = option.type !== "none" && !!blockedReason && !active;
            const Icon = option.icon;
            return (
              <button
                key={option.type}
                type="button"
                aria-pressed={active}
                title={RULE_EGRESS_TYPE_LABELS[option.type]}
                disabled={disabled}
                className={segmentedOptionClassName(active, disabled, "px-1.5")}
                onClick={() => pick(option.type)}
              >
                <Icon className="hidden h-4 w-4 shrink-0 sm:block" />
                <span className="truncate">{option.short}</span>
              </button>
            );
          })}
        </div>
      </div>

      {value.egressType === "none" && (
        <p className="text-meta leading-5 text-muted-foreground">
          {blockedReason
            ? <>入口机自己连接目标。{blockedReason}</>
            : <>入口机自己连接目标。选「落地主机」或「外部 SS 链接」后，入口机经 Shadowsocks 让落地去连目标，流量从落地出去。</>}
        </p>
      )}

      {value.egressType !== "none" && runtimeNote ? (
        <p className="text-meta leading-5 text-muted-foreground">{runtimeNote}</p>
      ) : null}

      {value.egressType === "ss_host" && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <FormField className="min-w-0 space-y-1.5">
              <Label>落地主机</Label>
              <Select
                value={value.egressHostId ? String(value.egressHostId) : undefined}
                disabled={optionsQuery.isLoading}
                onValueChange={(next) => {
                  const host = hosts.find((item) => Number(item.hostId) === Number(next));
                  const first = (host?.inbounds || []).find((inbound: any) => !inboundBlockReason(inbound));
                  onChange({ egressHostId: Number(next), egressInboundId: first ? Number(first.id) : null });
                }}
              >
                <SelectTrigger className="min-w-0">
                  <SelectValue placeholder={optionsQuery.isLoading ? "加载中…" : "选择落地主机"} />
                </SelectTrigger>
                <SelectContent>
                  {hosts.map((host: any) => (
                    <SelectItem key={host.hostId} value={String(host.hostId)} textValue={host.hostName}>
                      {host.hostName}
                      {!host.online ? "（离线）" : host.inbounds.length === 0 ? "（无 SS 入站）" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField className="min-w-0 space-y-1.5">
              <Label>Shadowsocks 入站</Label>
              <Select
                value={value.egressInboundId ? String(value.egressInboundId) : undefined}
                disabled={!selectedHost || (selectedHost.inbounds || []).length === 0}
                onValueChange={(next) => onChange({ egressInboundId: Number(next) })}
              >
                <SelectTrigger className="min-w-0">
                  <SelectValue placeholder={selectedHost && selectedHost.inbounds.length === 0 ? "这台主机还没有 SS 入站" : "选择入站"} />
                </SelectTrigger>
                <SelectContent>
                  {(selectedHost?.inbounds || []).map((inbound: any) => (
                    <SelectItem
                      key={inbound.id}
                      value={String(inbound.id)}
                      disabled={!!inboundBlockReason(inbound)}
                      textValue={`${inbound.name} ${inbound.port}`}
                    >
                      {inbound.name} :{inbound.port} · {inbound.method}
                      {inboundBlockReason(inbound) ? `（${inboundBlockReason(inbound)}）` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
          {selectedHost && !selectedHost.online && (
            <p className="text-meta text-[var(--fx-warn-text)]">这台落地主机当前离线，保存前请先让它上线。</p>
          )}
          {selectedInbound && isSs2022Method(selectedInbound.method) && !capabilities.ss2022 && !capabilities.loading && (
            <p className="text-meta leading-5 text-[var(--fx-warn-text)]">{capabilities.ss2022Reason}</p>
          )}
          {selectedHost && usableInbounds.length === 0 && (
            <div className="flex min-w-0 flex-col gap-2 rounded-md bg-muted/35 px-2.5 py-2 sm:flex-row sm:items-center">
              <span className="min-w-0 flex-1 text-meta leading-5 text-muted-foreground">
                {(selectedHost.inbounds || []).length > 0
                  ? `这台主机上的 SS 入站都不能做出口（只支持 ${SS_EGRESS_METHODS.join(" / ")}）。`
                  : "这台主机上还没有能做出口的 Shadowsocks 入站。"}
              </span>
              {selectedHost.canCreateInbound ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full shrink-0 sm:w-auto"
                  disabled={createLanding.isPending || !selectedHost.online}
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
          {!optionsQuery.isLoading && hosts.length === 0 && (
            <p className="text-meta text-muted-foreground">
              {isAdmin ? "除了入口主机之外还没有别的主机可以当落地。" : "您还没有可以当落地的主机：需要自己的主机，或管理员授权的主机。"}
            </p>
          )}
          <p className="text-meta leading-5 text-muted-foreground">
            {selectedHost && usableInbounds.length === 0
              ? `一键创建的入站用 ${SS_EGRESS_DEFAULT_METHOD}、随机密码，端口从这台主机的端口范围里挑，默认不进订阅。`
              : "入口机经这个 Shadowsocks 入站让落地去连目标；入站轮换密码、改端口后规则自动跟上。"}
          </p>
        </div>
      )}

      {value.egressType === "ss_link" && (
        <div className="space-y-1.5">
          <FormField className="min-w-0 space-y-1.5">
            <Label className="flex items-baseline gap-1.5">
              ss:// 链接
              <span className="text-xs font-normal text-muted-foreground">密码由面板加密保存</span>
            </Label>
            <Input
              value={value.egressLink}
              placeholder={value.egressLinkMasked || "ss://YWVzLTI1Ni1nY206cGFzcw@1.2.3.4:8388#落地"}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onChange({ egressLink: event.target.value })}
              className={linkPreview && !linkPreview.ok ? "border-destructive" : undefined}
            />
          </FormField>
          {value.egressLinkMasked && !value.egressLink.trim() && (
            <p className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
              <Globe2 className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">当前：{value.egressLinkMasked}（不改就留空）</span>
            </p>
          )}
          {linkPreview && !linkPreview.ok && <p className="text-xs text-destructive">{linkPreview.error}</p>}
          {linkPreview && linkPreview.ok && (
            <p className="min-w-0 truncate text-meta text-muted-foreground">
              {linkPreview.endpoint.server}:{linkPreview.endpoint.port} · {linkPreview.endpoint.method}
            </p>
          )}
          {linkPreview && linkPreview.ok && isSs2022Method(linkPreview.endpoint.method) && !capabilities.ss2022 && !capabilities.loading && (
            <p className="text-meta leading-5 text-[var(--fx-warn-text)]">{capabilities.ss2022Reason}</p>
          )}
          <p className="text-meta leading-5 text-muted-foreground">
            支持 {SS_EGRESS_METHODS.join(" / ")}，不支持带插件的链接。链接里的密码由面板加密保存，能接触到面板密钥的服务器管理员可以解出它。
          </p>
        </div>
      )}

      {/*
        UDP 走不走出口由上面的「协议」决定（TCP+UDP 时走，TCP 时只转 TCP），这里不再单放一个勾，
        只在需要的时候说一句：选了 TCP+UDP 要落地开着 UDP；入口机撑不起时说清楚是哪台、要升级什么。
      */}
      {value.egressType !== "none" && SS_EGRESS_UDP_SUPPORTED && (() => {
        if (capabilities.loading) return null;
        const udpAvailable = capabilities.udp;
        if (value.egressUdp) {
          return (
            <p
              data-testid="rule-egress-udp"
              className={`text-meta leading-5 ${udpAvailable ? "text-muted-foreground" : "text-[var(--fx-warn-text)]"}`}
            >
              {udpAvailable
                ? "TCP+UDP：UDP 也从落地出去，落地的 Shadowsocks 要开着 UDP。"
                : `${capabilities.udpReason}。升级前这条规则按停用下发；协议改成 TCP 就只转 TCP。`}
            </p>
          );
        }
        if (udpAvailable) return null;
        return <p data-testid="rule-egress-udp" className="text-meta leading-5 text-muted-foreground">{capabilities.udpReason}，协议只能选 TCP。</p>;
      })()}
    </section>
  );
}
