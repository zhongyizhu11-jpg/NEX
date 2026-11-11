/**
 * 规则编辑器里的「出口」一段：直接连接 / 落地主机 / 外部链接。落地主机上的入站可以是 Shadowsocks，也可以是
 * VLESS + REALITY + Vision（2.3.525）；外部链接粘 ss:// 或 vless://。具体存成哪种出口（ss_host / vless_host、
 * ss_link / vless_link）跟着选中的入站 / 粘的链接走，三个按钮不用变成五个。VLESS 出口只转 TCP、不接隧道，
 * 入口机 Agent 要 2.2.253 起（shared/vlessEgress.ts）。
 *
 * 规则（能用哪些方法、UDP / SS2022 要入口机有什么能力、规则形态的限制）都在 shared/ssEgress.ts，
 * 和服务端同一份；这里只负责选和提示。最终以服务端校验为准。落地主机 / 入站的下拉和「一键创建」
 * 是和节点分流共用的落地选择器（proxy/LandingPicker.tsx）。
 *
 * UDP 走出口（规则协议选 TCP+UDP）和 SS2022 出口要每一台入口机都报了能力（Agent 2.2.227 起、gost 运行时
 * 3.2.6-nex3 起）：撑不起时 TCP+UDP 选不了、SS2022 入站不可选，并写清楚是哪台机器、要升级什么。
 */

import { useMemo } from "react";
import { ArrowRightLeft, Globe2, Link2, Server } from "lucide-react";

import { LandingPicker, useLandingOptions, type LandingInbound } from "@/components/proxy/LandingPicker";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { trpc } from "@/lib/trpc";
import {
  isSs2022Method,
  parseSsEgressLink,
  ruleEgressProtocolOf,
  ruleEgressUsesInbound,
  ruleEgressUsesLink,
  RULE_EGRESS_TYPE_LABELS,
  SS_EGRESS_METHODS,
  SS_EGRESS_UDP_SUPPORTED,
  type RuleEgressType,
} from "@shared/ssEgress";
import { parseVlessEgressLink, VLESS_EGRESS_AGENT_VERSION } from "@shared/vlessEgress";

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
  /** 真正去连 SS 落地的主机（直连规则是入口，走隧道的规则是隧道出口机）：这些主机不能当落地。 */
  entryHostIds: number[];
  /** 规则走隧道：SS 客户端跑在隧道出口机上，说明文字里的「入口机」换成「隧道出口机」。 */
  viaTunnel?: boolean;
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
  /** 每台入口机都能用 VLESS Reality 出口（Agent 2.2.253 起）。 */
  vless: boolean;
  vlessReason: string | null;
};

/**
 * 入口机现在的出口能力（Agent 上报的 ssEgressUdp / ssEgress2022）。规则编辑器的出口一段和保存前的
 * 拦截共用这一个查询（react-query 按 key 合并成一次请求）。
 */
export function useEgressEntryCapabilities(entryHostIds: number[], enabled: boolean, role = "入口主机"): EgressEntryCapabilities {
  const hostIds = useMemo(() => Array.from(new Set(entryHostIds.map(Number).filter((id) => id > 0))).sort((a, b) => a - b), [entryHostIds]);
  const query = trpc.proxyInbounds.egressEntryCapabilities.useQuery({ hostIds }, {
    enabled: enabled && hostIds.length > 0,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  return useMemo(() => {
    const rows = (query.data || []) as Array<{ udp: boolean; ss2022: boolean; udpMessage: string | null; ss2022Message: string | null; vless?: boolean; vlessMessage?: string | null }>;
    if (!enabled || hostIds.length === 0 || query.isLoading || !query.data) {
      const reason = hostIds.length === 0 ? `请先选择${role}` : `正在检查${role}的 Agent / 运行时…`;
      return { loading: enabled && hostIds.length > 0 && query.isLoading, udp: false, ss2022: false, udpReason: reason, ss2022Reason: reason, vless: false, vlessReason: reason };
    }
    const udpMissing = rows.find((row) => !row.udp);
    const ss2022Missing = rows.find((row) => !row.ss2022);
    const vlessMissing = rows.find((row) => row.vless !== true);
    return {
      loading: false,
      udp: SS_EGRESS_UDP_SUPPORTED && rows.length > 0 && !udpMissing,
      ss2022: rows.length > 0 && !ss2022Missing,
      udpReason: udpMissing ? udpMissing.udpMessage || `${role}还不支持 UDP 走出口` : null,
      ss2022Reason: ss2022Missing ? ss2022Missing.ss2022Message || `${role}还不支持 SS2022 出口` : null,
      vless: rows.length > 0 && !vlessMissing,
      vlessReason: vlessMissing ? vlessMissing.vlessMessage || `${role}的 Agent 需要升级到 ${VLESS_EGRESS_AGENT_VERSION} 才能用 VLESS Reality 出口` : null,
    };
  }, [enabled, hostIds.length, query.data, query.isLoading, role]);
}

type EgressMode = "none" | "host" | "link";

const OPTIONS: Array<{ mode: EgressMode; short: string; title: string; icon: typeof Server }> = [
  { mode: "none", short: "直接连接", title: RULE_EGRESS_TYPE_LABELS.none, icon: ArrowRightLeft },
  { mode: "host", short: "落地主机", title: "落地主机（Shadowsocks / VLESS Reality）", icon: Server },
  { mode: "link", short: "外部链接", title: "外部 Shadowsocks / VLESS Reality 链接", icon: Link2 },
];

function egressModeOf(type: RuleEgressType): EgressMode {
  if (ruleEgressUsesInbound(type)) return "host";
  if (ruleEgressUsesLink(type)) return "link";
  return "none";
}

/** 粘的链接是哪种出口：vless:// 是 VLESS Reality，其余按 Shadowsocks（解析时会说清楚哪里不对）。 */
export function egressLinkType(link: string): RuleEgressType {
  return /^\s*vless:\/\//i.test(link) ? "vless_link" : "ss_link";
}

export function RuleEgressSection({ value, onChange, onEgressEnabled, blockedReason, runtimeNote, entryHostIds, viaTunnel = false, isAdmin }: Props) {
  // 谁去连 SS 落地：直连规则是入口机，走隧道的规则是隧道出口机。
  const dialer = viaTunnel ? "隧道出口机" : "入口机";
  const mode = egressModeOf(value.egressType);
  const vless = ruleEgressProtocolOf(value.egressType) === "vless";
  const options = useLandingOptions(mode === "host");
  const capabilities = useEgressEntryCapabilities(entryHostIds, value.egressType !== "none", viaTunnel ? "隧道出口机" : "入口主机");
  const entrySet = useMemo(() => new Set(entryHostIds.map(Number)), [entryHostIds]);
  const hosts = useMemo(() => options.hosts.filter((host) => !entrySet.has(Number(host.hostId))), [entrySet, options.hosts]);
  const selectedHost = hosts.find((host) => Number(host.hostId) === Number(value.egressHostId)) || null;
  // SS2022 入站要每台入口机都有 ssEgress2022 能力；撑不起时照样列出来，但不能选。
  const inboundBlockReason = (inbound: LandingInbound): string | null => {
    if (inbound.methodError) return inbound.protocol === "vless" ? inbound.methodError : "不支持做出口";
    if (!inbound.isEnabled) return "已停用";
    if (inbound.protocol === "vless") {
      // VLESS 出口不接隧道、要入口机 Agent 2.2.253：撑不起时照样列出来，但不能选。
      if (viaTunnel) return "隧道规则只能接 Shadowsocks 出口";
      if (!capabilities.vless && !capabilities.loading) return `${dialer}需升级 Agent 到 ${VLESS_EGRESS_AGENT_VERSION}`;
      return null;
    }
    if (isSs2022Method(inbound.method) && !capabilities.ss2022) return `${dialer}需升级才能用 SS2022`;
    return null;
  };
  const usableInbounds = (selectedHost?.inbounds || []).filter((inbound) => !inboundBlockReason(inbound));
  const selectedInbound = (selectedHost?.inbounds || []).find((inbound) => Number(inbound.id) === Number(value.egressInboundId)) || null;
  const linkPreview = value.egressType === "ss_link" && value.egressLink.trim() ? parseSsEgressLink(value.egressLink) : null;
  const vlessLinkPreview = value.egressType === "vless_link" && value.egressLink.trim() ? parseVlessEgressLink(value.egressLink) : null;

  const pick = (next: EgressMode) => {
    if (next === mode) return;
    if (next !== "none" && blockedReason) return;
    const type: RuleEgressType = next === "host" ? "ss_host" : next === "link" ? egressLinkType(value.egressLink) : "none";
    onChange({ egressType: type, egressUdp: false });
    if (type !== "none") onEgressEnabled(type);
  };
  /** 选中的入站是 VLESS 时出口跟着变成 vless_host（反过来也一样）；UDP 只有 SS 能走。 */
  const pickInbound = (next: { hostId: number | null; inboundId: number | null }) => {
    const host = hosts.find((item) => Number(item.hostId) === Number(next.hostId));
    const inbound = host?.inbounds.find((item) => Number(item.id) === Number(next.inboundId));
    const type: RuleEgressType = inbound?.protocol === "vless" ? "vless_host" : "ss_host";
    onChange({
      egressHostId: next.hostId,
      egressInboundId: next.inboundId,
      ...(type !== value.egressType ? { egressType: type, egressUdp: false } : {}),
    });
  };
  const changeLink = (link: string) => {
    const type = egressLinkType(link);
    onChange({ egressLink: link, ...(type !== value.egressType ? { egressType: type, egressUdp: false, egressLinkMasked: "" } : {}) });
  };

  return (
    // 标题和折叠在外面（规则编辑框的 RuleFormCollapsible「出口」），这里只放里面的内容。
    <section className="space-y-2.5" data-testid="rule-egress-section">
      <p className="text-meta text-muted-foreground">目标看到的来源 IP 是谁</p>
      <SegmentedControl<EgressMode>
        ariaLabel="出口"
        listClassName="grid grid-cols-3 gap-1"
        optionClassName="px-1.5"
        value={mode}
        options={OPTIONS.map((option) => {
          const Icon = option.icon;
          return {
            value: option.mode,
            title: option.title,
            disabled: option.mode !== "none" && !!blockedReason && mode !== option.mode,
            icon: <Icon className="hidden h-4 w-4 shrink-0 sm:block" />,
            label: <span className="truncate">{option.short}</span>,
          };
        })}
        onChange={pick}
      />

      {value.egressType === "none" && (
        <p className="text-meta leading-5 text-muted-foreground">
          {blockedReason
            ? <>{dialer}自己连接目标。{blockedReason}</>
            : <>{dialer}自己连接目标。选「落地主机」或「外部链接」后，{dialer}经 Shadowsocks 或 VLESS Reality 让落地去连目标，流量从落地出去。</>}
        </p>
      )}

      {value.egressType !== "none" && runtimeNote ? (
        <p className="text-meta leading-5 text-muted-foreground">{runtimeNote}</p>
      ) : null}

      {mode === "host" && (
        <div className="space-y-2">
          <LandingPicker
            value={{ hostId: value.egressHostId, inboundId: value.egressInboundId }}
            onChange={pickInbound}
            excludeHostIds={entryHostIds}
            filterInbound={inboundBlockReason}
            protocols={["shadowsocks", "vless"]}
            allowCreate
            emptyMessage={isAdmin ? `除了${viaTunnel ? "隧道出口机" : "入口主机"}之外还没有别的主机可以当落地。` : undefined}
          />
          {selectedInbound && isSs2022Method(selectedInbound.method) && !capabilities.ss2022 && !capabilities.loading && (
            <p className="text-meta leading-5 text-[var(--fx-warn-text)]">{capabilities.ss2022Reason}</p>
          )}
          {selectedInbound?.protocol === "vless" && !capabilities.vless && !capabilities.loading && (
            <p className="text-meta leading-5 text-[var(--fx-warn-text)]">{capabilities.vlessReason}</p>
          )}
          {!(selectedHost && usableInbounds.length === 0) && (
            <p className="text-meta leading-5 text-muted-foreground">
              {vless
                ? `${dialer}上起一个只听本机的 sing-box，经这个 VLESS Reality 入站让落地去连目标（只转 TCP）；入站换密钥、改端口后规则自动跟上。`
                : `${dialer}经这个 Shadowsocks 入站让落地去连目标；入站轮换密码、改端口后规则自动跟上。`}
            </p>
          )}
        </div>
      )}

      {mode === "link" && (
        <div className="space-y-1.5">
          <FormField className="min-w-0 space-y-1.5">
            <Label className="flex items-baseline gap-1.5">
              ss:// 或 vless:// 链接
              <span className="text-xs font-normal text-muted-foreground">凭据由面板加密保存</span>
            </Label>
            <Input
              value={value.egressLink}
              placeholder={value.egressLinkMasked || "ss://YWVzLTI1Ni1nY206cGFzcw@1.2.3.4:8388#落地"}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => changeLink(event.target.value)}
              className={(linkPreview && !linkPreview.ok) || (vlessLinkPreview && !vlessLinkPreview.ok) ? "border-destructive" : undefined}
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
          {vlessLinkPreview && !vlessLinkPreview.ok && <p className="text-xs text-destructive">{vlessLinkPreview.error}</p>}
          {vlessLinkPreview && vlessLinkPreview.ok && (
            <p className="min-w-0 truncate text-meta text-muted-foreground">
              {vlessLinkPreview.endpoint.server}:{vlessLinkPreview.endpoint.port} · REALITY · {vlessLinkPreview.endpoint.serverName}
            </p>
          )}
          {vless && !capabilities.vless && !capabilities.loading && (
            <p className="text-meta leading-5 text-[var(--fx-warn-text)]">{capabilities.vlessReason}</p>
          )}
          <p className="text-meta leading-5 text-muted-foreground">
            Shadowsocks 支持 {SS_EGRESS_METHODS.join(" / ")}，不支持带插件的链接；VLESS 只收 RAW/TCP + REALITY + xtls-rprx-vision（只转 TCP）。链接里的密码 / UUID 由面板加密保存，能接触到面板密钥的服务器管理员可以解出它。
          </p>
        </div>
      )}

      {/*
        UDP 走不走出口由上面的「协议」决定（TCP+UDP 时走，TCP 时只转 TCP），这里不再单放一个勾，
        只在需要的时候说一句：选了 TCP+UDP 要落地开着 UDP；入口机撑不起时说清楚是哪台、要升级什么。
      */}
      {vless && (
        <p data-testid="rule-egress-udp" className="text-meta leading-5 text-muted-foreground">VLESS Reality 出口只转发 TCP，协议只能选 TCP。</p>
      )}
      {value.egressType !== "none" && !vless && SS_EGRESS_UDP_SUPPORTED && (() => {
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
