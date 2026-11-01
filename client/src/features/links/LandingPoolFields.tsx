import { KeyRound, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { LineChipButton, LineSegmented } from "@/features/lines/LineUi";
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

/** 服务端给的落地配置视图（lineDiagnostics.nodePools 的 landing.config）。 */
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

const FIELD_LABEL = "text-[11.5px] text-muted-foreground";

export function LandingPoolFields({ draft, onChange, directDomain, onDirectDomainChange, editing, onRotate, rotating }: {
  draft: LandingDraft;
  onChange: (draft: LandingDraft) => void;
  directDomain: string;
  onDirectDomainChange: (value: string) => void;
  /** 改已有的池：显示「换密钥」。 */
  editing?: boolean;
  onRotate?: () => void;
  rotating?: boolean;
}) {
  const securities = landingPoolSecurities(draft.protocol);
  const transports = landingPoolTransports(draft.protocol, draft.security);
  const multi = proxyInboundSupportsMultiUser(draft.protocol);
  const ownUsers = draft.users.filter((user) => !user.shared).length;
  const setUser = (index: number, name: string) => onChange({ ...draft, users: draft.users.map((user, position) => (position === index ? { ...user, name: name.slice(0, 64) } : user)) });
  return (
    <div className="flex flex-col gap-3" data-testid="landing-pool-fields">
      <div className="flex flex-col gap-2.5 rounded-[12px] border border-[var(--fx-stroke-weak)] p-3">
        <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
          <label className="flex min-w-0 flex-col gap-1">
            <span className={FIELD_LABEL}>协议</span>
            <Select value={draft.protocol} onValueChange={(value) => onChange(withProtocol(draft, value as LandingPoolProtocol))}>
              <SelectTrigger aria-label="落地协议" className="h-8 text-xs" data-testid="landing-protocol"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LANDING_POOL_PROTOCOLS.map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>{LANDING_POOL_PROTOCOL_LABELS[protocol]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={FIELD_LABEL}>端口</span>
            <Input value={draft.port} inputMode="numeric" onChange={(event) => onChange({ ...draft, port: event.target.value.replace(/[^\d]/g, "").slice(0, 5) })} className="h-8 font-mono text-xs" aria-label="落地端口" data-testid="landing-port" />
          </label>
        </div>
        {securities.length > 1 ? (
          <LineSegmented
            ariaLabel="安全层"
            value={draft.security}
            options={[{ value: "reality", label: "REALITY" }, { value: "none", label: "不加密" }]}
            onChange={(security) => onChange(withSecurity(draft, security as LandingPoolSecurity))}
          />
        ) : null}
        {transports.length > 1 ? (
          <label className="flex min-w-0 flex-col gap-1">
            <span className={FIELD_LABEL}>传输</span>
            <Select value={draft.transport} onValueChange={(value) => onChange({ ...draft, transport: value as ProxyNodeTransport })}>
              <SelectTrigger aria-label="传输" className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {transports.map((transport) => <SelectItem key={transport} value={transport}>{TRANSPORT_LABELS[transport] || transport}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        {draft.transport !== "tcp" ? (
          <div className="grid grid-cols-2 gap-2">
            <Input value={draft.path} onChange={(event) => onChange({ ...draft, path: event.target.value.slice(0, 200) })} placeholder={draft.transport === "grpc" ? "serviceName" : "路径，比如 /ray"} className="h-8 text-xs" aria-label="路径" />
            {draft.transport !== "grpc" ? <Input value={draft.host} onChange={(event) => onChange({ ...draft, host: event.target.value.slice(0, 253) })} placeholder="Host（可选）" className="h-8 text-xs" aria-label="Host" /> : null}
          </div>
        ) : null}
        {draft.security === "reality" ? (
          <>
            <label className="flex min-w-0 flex-col gap-1">
              <span className={FIELD_LABEL}>REALITY 握手域名</span>
              <Input value={draft.serverName} onChange={(event) => onChange({ ...draft, serverName: event.target.value.trim().slice(0, 253) })} placeholder="不填用 dl.google.com" className="h-8 text-xs" aria-label="REALITY 握手域名" />
            </label>
            <label className="flex items-center justify-between gap-3 text-[12px]">
              <span>Vision 流控<span className="ml-1 text-[11.5px] text-muted-foreground">推荐开着</span></span>
              <Switch checked={draft.flow === "xtls-rprx-vision"} onCheckedChange={(on) => onChange({ ...draft, flow: on ? "xtls-rprx-vision" : "" })} aria-label="Vision 流控" />
            </label>
          </>
        ) : null}
        {draft.protocol === "shadowsocks" ? (
          <label className="flex min-w-0 flex-col gap-1">
            <span className={FIELD_LABEL}>加密方式</span>
            <Select value={draft.method || PROXY_INBOUND_SHADOWSOCKS_DEFAULT_METHOD} onValueChange={(method) => onChange({ ...draft, method })}>
              <SelectTrigger aria-label="加密方式" className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SS_METHODS.map((method) => <SelectItem key={method.value} value={method.value}>{method.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        {draft.protocol === "snell" ? (
          <LineSegmented ariaLabel="Snell 版本" value={String(draft.snellVersion)} options={[{ value: "5", label: "Snell v5" }, { value: "6", label: "Snell v6" }]} onChange={(value) => onChange({ ...draft, snellVersion: Number(value) })} />
        ) : null}
        {multi ? (
          <div className="flex flex-col gap-1.5" data-testid="landing-users">
            <span className={FIELD_LABEL}>用户（一人一份凭据，每台都一样）</span>
            {draft.users.map((user, index) => (
              <div key={`${user.id}-${index}`} className="flex min-w-0 items-center gap-1.5">
                <Input value={user.name} disabled={user.shared} onChange={(event) => setUser(index, event.target.value)} className="h-8 min-w-0 flex-1 text-xs" aria-label={`用户 ${index + 1}`} />
                {user.shared ? <span className="shrink-0 text-[11px] text-muted-foreground">分享发的</span> : null}
                {!user.shared && ownUsers > 1 ? (
                  <button type="button" className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground" aria-label={`去掉 ${user.name || "用户"}`} onClick={() => onChange({ ...draft, users: draft.users.filter((_, position) => position !== index) })}><X className="h-3.5 w-3.5" /></button>
                ) : null}
              </div>
            ))}
            <LineChipButton variant="add" className="self-start" onClick={() => onChange({ ...draft, users: [...draft.users, { id: 0, name: `用户 ${draft.users.length + 1}` }] })}><Plus className="h-3 w-3" />加用户</LineChipButton>
          </div>
        ) : null}
        <p className="text-[11.5px] leading-[1.5] text-muted-foreground">
          凭据和密钥由面板生成，每台机器一模一样；某台的端口被占了会换一个（订阅里还是一条，走中转不受影响）。
        </p>
      </div>
      <label className="flex min-w-0 flex-col gap-1">
        <span className={FIELD_LABEL}>直连域名（可选）</span>
        <Input value={directDomain} onChange={(event) => onDirectDomainChange(event.target.value.trim().slice(0, 253))} placeholder="比如 hk.example.com" className="h-8 text-xs" aria-label="直连域名" data-testid="landing-domain" />
        <span className="text-[11.5px] leading-[1.5] text-muted-foreground">
          {directDomain
            ? "订阅里多一条直连，DNS 只解析到在线的机器；每台要同一个端口。"
            : "不填就只走中转：订阅里只有中转那一条，面板在池里挑机器。"}
        </span>
      </label>
      {editing && onRotate ? (
        <Button type="button" variant="outline" size="sm" className="self-start gap-1" disabled={rotating} onClick={onRotate} data-testid="landing-rotate">
          <KeyRound className="h-3.5 w-3.5" />换密钥
        </Button>
      ) : null}
    </div>
  );
}
