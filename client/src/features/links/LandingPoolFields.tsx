import { Loader2, Plus, Sparkles, X } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { LINE_BARE_SELECT, LINE_FORM_ROW, LineBareInput, LineChipButton, LineField, LineFormGroup, LineFormRow, LineSegmented } from "@/features/lines/LineUi";
import {
  LANDING_POOL_PROTOCOL_LABELS,
  LANDING_POOL_PROTOCOLS,
  landingPoolSecurities,
  landingPoolTransports,
  type LandingPoolProtocol,
  type LandingPoolSecurity,
} from "@shared/landingPool";
import { PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD, proxyInboundSupportsMultiUser } from "@shared/proxyInbound";
import type { ProxyNodeTransport } from "@shared/proxyNode";

/*
  节点池弹窗里「落地」那一块（2.3.500）：一份落地配置，面板照它在池里每台机器上开一个一模一样的入站。
  凭据、密钥都是服务端生成的，这里只填形状（协议、端口、安全层、传输）和用户的名字。
*/

export type LandingDraftUser = { id: number; name: string; shared?: boolean };

export type LandingDraft = {
  protocol: LandingPoolProtocol;
  port: string;
  security: LandingPoolSecurity;
  transport: ProxyNodeTransport;
  flow: string;
  serverName: string;
  path: string;
  host: string;
  method: string;
  snellVersion: number;
  users: LandingDraftUser[];
};

/** 服务端给的落地配置视图（nodePools.list 的 landing.config）。 */
export type LandingConfigView = {
  protocol: string;
  port: number;
  transport: string;
  security: string;
  flow: string;
  serverName: string;
  path: string;
  host: string;
  method: string;
  snellVersion: number;
  users: Array<{ id: number; name: string; shared: boolean }>;
} | null;

const SS_METHODS = [
  { value: "2022-blake3-aes-128-gcm", label: "SS2022 · AES-128（推荐）" },
  { value: "2022-blake3-aes-256-gcm", label: "SS2022 · AES-256" },
  { value: "2022-blake3-chacha20-poly1305", label: "SS2022 · ChaCha20" },
  { value: "aes-128-gcm", label: "AES-128-GCM（老式）" },
  { value: "aes-256-gcm", label: "AES-256-GCM（老式）" },
] as const;

const TRANSPORT_LABELS: Partial<Record<ProxyNodeTransport, string>> = { tcp: "TCP", ws: "WebSocket", grpc: "gRPC", http: "HTTP/2", httpupgrade: "HTTPUpgrade" };

export function landingDraftFrom(config: LandingConfigView): LandingDraft {
  if (!config) {
    return { protocol: "vless", port: "443", security: "reality", transport: "tcp", flow: "xtls-rprx-vision", serverName: "", path: "", host: "", method: "", snellVersion: 5, users: [{ id: 0, name: "默认" }] };
  }
  const protocol = (LANDING_POOL_PROTOCOLS as readonly string[]).includes(config.protocol) ? config.protocol as LandingPoolProtocol : "vless";
  return {
    protocol,
    port: String(config.port || ""),
    security: config.security === "reality" ? "reality" : "none",
    transport: (config.transport || "tcp") as ProxyNodeTransport,
    flow: config.flow || "",
    serverName: config.serverName || "",
    path: config.path || "",
    host: config.host || "",
    method: config.method || "",
    snellVersion: config.snellVersion || 5,
    users: config.users.length > 0 ? config.users.map((user) => ({ id: user.id, name: user.name, shared: user.shared })) : [{ id: 0, name: "默认" }],
  };
}

/** 草稿 → nodePoolSave 的 landing 入参（分享发的那几份不送：服务端照留）。 */
export function landingInputFromDraft(draft: LandingDraft) {
  const multi = proxyInboundSupportsMultiUser(draft.protocol);
  return {
    protocol: draft.protocol,
    port: Math.floor(Number(draft.port)),
    security: draft.security,
    transport: draft.transport,
    flow: draft.protocol === "vless" && draft.security === "reality" ? draft.flow : "",
    serverName: draft.security === "reality" ? draft.serverName.trim() : "",
    path: draft.transport === "tcp" ? "" : draft.path.trim(),
    host: draft.transport === "tcp" || draft.transport === "grpc" ? "" : draft.host.trim(),
    method: draft.protocol === "shadowsocks" ? (draft.method || PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD) : "",
    snellVersion: draft.protocol === "snell" ? draft.snellVersion : 0,
    ...(multi ? { users: draft.users.filter((user) => !user.shared).map((user) => ({ id: user.id, name: user.name.trim() || "默认" })) } : {}),
  };
}

/** 草稿能不能存：端口合法，多用户协议至少一个自己的用户。返回原因，空串 = 能存。 */
export function landingDraftError(draft: LandingDraft): string {
  const port = Number(draft.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "端口要是 1-65535";
  if (proxyInboundSupportsMultiUser(draft.protocol) && draft.users.filter((user) => !user.shared).length === 0) return "至少留一个用户";
  return "";
}

function withProtocol(draft: LandingDraft, protocol: LandingPoolProtocol): LandingDraft {
  const securities = landingPoolSecurities(protocol);
  const security = securities.includes(draft.security) ? draft.security : securities[0];
  const transports = landingPoolTransports(protocol, security);
  return {
    ...draft,
    protocol,
    security,
    transport: transports.includes(draft.transport) ? draft.transport : transports[0],
    flow: protocol === "vless" && security === "reality" ? (draft.flow || "xtls-rprx-vision") : "",
    method: protocol === "shadowsocks" ? (draft.method || PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD) : draft.method,
    users: draft.users.length > 0 ? draft.users : [{ id: 0, name: "默认" }],
  };
}

function withSecurity(draft: LandingDraft, security: LandingPoolSecurity): LandingDraft {
  const transports = landingPoolTransports(draft.protocol, security);
  return {
    ...draft,
    security,
    transport: transports.includes(draft.transport) ? draft.transport : transports[0],
    flow: draft.protocol === "vless" && security === "reality" ? (draft.flow || "xtls-rprx-vision") : "",
  };
}

/*
  2.3.501 起照 iOS 设置排：「落地配置」「用户」「直连域名」各一张白卡，卡里一行一项、值写在右边，
  不带框；说明只剩卡底下一句。以前是标签压在框上、框里套框、每个控件底下一句灰字。
*/
export function LandingPoolFields({ draft, onChange, directDomain, onDirectDomainChange, domainEditable = true, onSuggestDomain, suggesting, editing, onRotate, rotating }: {
  draft: LandingDraft;
  onChange: (draft: LandingDraft) => void;
  directDomain: string;
  onDirectDomainChange: (value: string) => void;
  /** 直连域名只有管理员能设（面板拿系统的 DNS 服务商替它写解析）；别人只看得到管理员设的那个。 */
  domainEditable?: boolean;
  /** 「自动」：在 DDNS 管着的主域名下起一个。 */
  onSuggestDomain?: () => void;
  suggesting?: boolean;
  /** 改已有的池：卡底下多一个「换一套」密钥。 */
  editing?: boolean;
  onRotate?: () => void;
  rotating?: boolean;
}) {
  const securities = landingPoolSecurities(draft.protocol);
  const transports = landingPoolTransports(draft.protocol, draft.security);
  const multi = proxyInboundSupportsMultiUser(draft.protocol);
  const ownUsers = draft.users.filter((user) => !user.shared).length;
  const setUser = (index: number, name: string) => onChange({ ...draft, users: draft.users.map((user, position) => (position === index ? { ...user, name: name.slice(0, 64) } : user)) });
  // 凭据那句跟在最后一张配置卡底下（多用户协议是「用户」那张）
  const credentials = (
    <>
      凭据和密钥由面板生成，每台一样；端口被占会自动换。
      {editing && onRotate ? (
        <button type="button" className="ml-1 font-medium text-[var(--fx-accent)] disabled:opacity-50" disabled={rotating} onClick={onRotate} data-testid="landing-rotate">换一套</button>
      ) : null}
    </>
  );
  return (
    <>
      <LineField label="落地配置" footer={multi ? undefined : credentials} testId="landing-pool-fields">
        <LineFormGroup>
          <LineFormRow label="协议">
            <Select value={draft.protocol} onValueChange={(value) => onChange(withProtocol(draft, value as LandingPoolProtocol))}>
              <SelectTrigger data-slot="line-bare-select" aria-label="落地协议" className={LINE_BARE_SELECT} data-testid="landing-protocol"><SelectValue /></SelectTrigger>
              <SelectContent align="end">
                {LANDING_POOL_PROTOCOLS.map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>{LANDING_POOL_PROTOCOL_LABELS[protocol]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </LineFormRow>
          <LineFormRow label="端口">
            <LineBareInput value={draft.port} inputMode="numeric" onChange={(event) => onChange({ ...draft, port: event.target.value.replace(/[^\d]/g, "").slice(0, 5) })} className="w-24 font-mono" aria-label="落地端口" data-testid="landing-port" />
          </LineFormRow>
          {securities.length > 1 ? (
            <LineFormRow label="加密">
              <div className="w-[10.5rem]">
                <LineSegmented
                  ariaLabel="安全层"
                  value={draft.security}
                  options={[{ value: "reality", label: "REALITY" }, { value: "none", label: "不加密" }]}
                  onChange={(security) => onChange(withSecurity(draft, security as LandingPoolSecurity))}
                />
              </div>
            </LineFormRow>
          ) : null}
          {transports.length > 1 ? (
            <LineFormRow label="传输">
              <Select value={draft.transport} onValueChange={(value) => onChange({ ...draft, transport: value as ProxyNodeTransport })}>
                <SelectTrigger data-slot="line-bare-select" aria-label="传输" className={LINE_BARE_SELECT}><SelectValue /></SelectTrigger>
                <SelectContent align="end">
                  {transports.map((transport) => <SelectItem key={transport} value={transport}>{TRANSPORT_LABELS[transport] || transport}</SelectItem>)}
                </SelectContent>
              </Select>
            </LineFormRow>
          ) : null}
          {draft.transport !== "tcp" ? (
            <LineFormRow label={draft.transport === "grpc" ? "服务名" : "路径"}>
              <LineBareInput value={draft.path} onChange={(event) => onChange({ ...draft, path: event.target.value.slice(0, 200) })} placeholder={draft.transport === "grpc" ? "serviceName" : "/ray"} className="font-mono" aria-label="路径" />
            </LineFormRow>
          ) : null}
          {draft.transport !== "tcp" && draft.transport !== "grpc" ? (
            <LineFormRow label="Host">
              <LineBareInput value={draft.host} onChange={(event) => onChange({ ...draft, host: event.target.value.slice(0, 253) })} placeholder="可选" aria-label="Host" />
            </LineFormRow>
          ) : null}
          {draft.security === "reality" ? (
            <>
              <LineFormRow label="握手域名">
                <LineBareInput value={draft.serverName} onChange={(event) => onChange({ ...draft, serverName: event.target.value.trim().slice(0, 253) })} placeholder="dl.google.com" aria-label="REALITY 握手域名" />
              </LineFormRow>
              <LineFormRow label="Vision 流控">
                <Switch checked={draft.flow === "xtls-rprx-vision"} onCheckedChange={(on) => onChange({ ...draft, flow: on ? "xtls-rprx-vision" : "" })} aria-label="Vision 流控" />
              </LineFormRow>
            </>
          ) : null}
          {draft.protocol === "shadowsocks" ? (
            <LineFormRow label="加密方式">
              <Select value={draft.method || PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD} onValueChange={(method) => onChange({ ...draft, method })}>
                <SelectTrigger data-slot="line-bare-select" aria-label="加密方式" className={LINE_BARE_SELECT}><SelectValue /></SelectTrigger>
                <SelectContent align="end">
                  {SS_METHODS.map((method) => <SelectItem key={method.value} value={method.value}>{method.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </LineFormRow>
          ) : null}
          {draft.protocol === "snell" ? (
            <LineFormRow label="版本">
              <div className="w-[8rem]">
                <LineSegmented ariaLabel="Snell 版本" value={String(draft.snellVersion)} options={[{ value: "5", label: "v5" }, { value: "6", label: "v6" }]} onChange={(value) => onChange({ ...draft, snellVersion: Number(value) })} />
              </div>
            </LineFormRow>
          ) : null}
        </LineFormGroup>
      </LineField>
      {multi ? (
        <LineField label="用户" aside="一人一份凭据" footer={credentials} testId="landing-users">
          <LineFormGroup>
            {draft.users.map((user, index) => (
              <div key={`${user.id}-${index}`} className={cn(LINE_FORM_ROW, "flex min-h-[46px] min-w-0 items-center gap-2 pr-[14px]")}>
                <LineBareInput align="left" value={user.name} disabled={user.shared} onChange={(event) => setUser(index, event.target.value)} aria-label={`用户 ${index + 1}`} />
                {user.shared ? <span className="shrink-0 text-[12px] text-muted-foreground">分享发的</span> : null}
                {!user.shared && ownUsers > 1 ? (
                  <button type="button" className="shrink-0 rounded-full p-1 text-muted-foreground hover:text-foreground" aria-label={`去掉 ${user.name || "用户"}`} onClick={() => onChange({ ...draft, users: draft.users.filter((_, position) => position !== index) })}><X className="h-4 w-4" /></button>
                ) : null}
              </div>
            ))}
            <button type="button" className={cn(LINE_FORM_ROW, "flex h-[46px] w-full items-center gap-1.5 pr-[14px] text-left text-[14px] text-[var(--fx-accent)]")} onClick={() => onChange({ ...draft, users: [...draft.users, { id: 0, name: `用户 ${draft.users.length + 1}` }] })}>
              <Plus className="h-4 w-4" />加用户
            </button>
          </LineFormGroup>
        </LineField>
      ) : null}
      {domainEditable || directDomain ? (
        <LineField
          label="直连域名"
          testId="landing-domain-field"
          aside={domainEditable && onSuggestDomain ? (
            <LineChipButton variant="sel" disabled={suggesting} onClick={onSuggestDomain} data-testid="landing-domain-auto">
              {suggesting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}自动
            </LineChipButton>
          ) : null}
          footer={directDomain
            ? `订阅里多一条直连，DNS 只解析到在线的那几台。${domainEditable ? "" : "管理员设的。"}`
            : "不填就只走中转。"}
        >
          <LineFormGroup>
            <div className="flex min-h-[46px] min-w-0 items-center pr-[14px]">
              {domainEditable ? (
                <LineBareInput align="left" value={directDomain} onChange={(event) => onDirectDomainChange(event.target.value.trim().slice(0, 253))} placeholder="可选，比如 hk.example.com" aria-label="直连域名" data-testid="landing-domain" />
              ) : (
                <span className="min-w-0 truncate text-[14px]" data-testid="landing-domain">{directDomain}</span>
              )}
            </div>
          </LineFormGroup>
        </LineField>
      ) : null}
    </>
  );
}
