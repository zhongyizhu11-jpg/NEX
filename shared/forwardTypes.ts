export const FORWARD_TYPES = ["iptables", "nftables", "realm", "socat", "gost", "nginx"] as const;

export type ForwardType = (typeof FORWARD_TYPES)[number];
export type ForwardRuleProtocol = "tcp" | "udp" | "both";

/** NEX 隧道的传输版本：V1 FXP 加密直连、V2 WireGuard、V3 HTTP / WS / TLS 外层（shared/forwardXV3.ts）。 */
export const FORWARDX_VERSIONS = ["v1", "v2", "v3"] as const;
export type ForwardXVersion = (typeof FORWARDX_VERSIONS)[number];

export function normalizeForwardXVersion(value: unknown): ForwardXVersion {
  const normalized = String(value || "").trim().toLowerCase();
  return (FORWARDX_VERSIONS as readonly string[]).includes(normalized) ? normalized as ForwardXVersion : "v1";
}

export const FORWARD_TYPE_LABELS: Record<ForwardType, string> = {
  iptables: "iptables",
  nftables: "nftables",
  realm: "realm",
  socat: "socat",
  gost: "gost",
  nginx: "nginx",
};

/**
 * 内核转发：连接在内核里被改写目的地，握手是和**最终落地**完成的。
 *
 * 这个区分只有一个用处，但那个用处很要紧：判断「对这台中转的转发端口连一次 TCP」
 * 到底测到了什么。
 *
 *   · iptables / nftables（DNAT）：SYN 被改写目的地送出去，SYN-ACK 是落地回的 ——
 *     这一连**就是端到端的**，中转的上游断了立刻探得出来。
 *   · realm / socat / gost / nginx：中转在用户态 accept 下来，再自己另开一条去
 *     落地。连得上只能证明**中转活着**，它的上游是死是活完全看不出来。
 *
 * 后一种情况下主备的健康检查有盲区：中转好好的、它到落地那段断了，不会切，流量
 * 继续往死路里送。所以哪种转发方式用在中转上，直接决定了要不要另外配一个探测目标。
 */
const KERNEL_FORWARD_TYPES = ["iptables", "nftables"] as const;

export function isUserspaceForwardType(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return !(KERNEL_FORWARD_TYPES as readonly string[]).includes(normalized);
}

export const FORWARD_RULE_PROTOCOL_LABELS: Record<ForwardRuleProtocol, string> = {
  tcp: "TCP",
  udp: "UDP",
  both: "TCP + UDP",
};

export function normalizeForwardRuleProtocol(protocol: unknown, fallback: ForwardRuleProtocol = "tcp"): ForwardRuleProtocol {
  const raw = String(protocol ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "tcp" || raw === "udp" || raw === "both") return raw;
  const compact = raw.replace(/[\s_+\/-]+/g, "");
  if (compact === "tcpudp" || compact === "udptcp" || compact === "tcpandudp" || compact === "udpandtcp") return "both";
  return fallback;
}

export function forwardRuleProtocols(protocol: unknown, fallback: ForwardRuleProtocol = "tcp"): Array<"tcp" | "udp"> {
  const normalized = normalizeForwardRuleProtocol(protocol, fallback);
  if (normalized === "udp") return ["udp"];
  if (normalized === "both") return ["tcp", "udp"];
  return ["tcp"];
}

export function isForwardRuleProtocolTcpEnabled(protocol: unknown, fallback: ForwardRuleProtocol = "tcp") {
  return normalizeForwardRuleProtocol(protocol, fallback) !== "udp";
}

export function isForwardRuleProtocolUdpEnabled(protocol: unknown, fallback: ForwardRuleProtocol = "tcp") {
  return normalizeForwardRuleProtocol(protocol, fallback) !== "tcp";
}

export function formatForwardRuleProtocol(protocol: string | null | undefined) {
  if (protocol == null || String(protocol).trim() === "") return "-";
  return FORWARD_RULE_PROTOCOL_LABELS[normalizeForwardRuleProtocol(protocol)];
}

export const TUNNEL_PROTOCOLS = ["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp", "nginx_stream"] as const;

export type TunnelProtocol = (typeof TUNNEL_PROTOCOLS)[number];

export const FORWARD_PROTOCOLS = Array.from(new Set([...FORWARD_TYPES, ...TUNNEL_PROTOCOLS])) as Array<ForwardType | TunnelProtocol>;

export type ForwardProtocolKey = ForwardType | TunnelProtocol;

export type ForwardProtocolSettings = Record<ForwardProtocolKey, boolean>;

export const FORWARD_PROTOCOL_LABELS: Record<ForwardProtocolKey, string> = {
  iptables: "iptables",
  nftables: "nftables",
  realm: "realm",
  socat: "socat",
  gost: "gost",
  nginx: "Nginx",
  forwardx: "NEX",
  tls: "GOST TLS",
  wss: "GOST WSS",
  tcp: "GOST TCP",
  mtls: "GOST MTLS",
  mwss: "GOST MWSS",
  mtcp: "GOST MTCP",
  nginx_stream: "Nginx",
};

export const DEFAULT_FORWARD_PROTOCOL_SETTINGS: ForwardProtocolSettings = {
  iptables: true,
  nftables: true,
  realm: true,
  socat: true,
  gost: true,
  nginx: false,
  forwardx: true,
  tls: true,
  wss: true,
  tcp: true,
  mtls: true,
  mwss: true,
  mtcp: true,
  nginx_stream: false,
};

export function normalizeForwardProtocolSettings(input?: Partial<Record<string, unknown>> | null): ForwardProtocolSettings {
  const out: ForwardProtocolSettings = { ...DEFAULT_FORWARD_PROTOCOL_SETTINGS };
  if (!input) return out;
  for (const key of FORWARD_PROTOCOLS) {
    const value = input[key];
    if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = value === "true";
  }
  return out;
}

export function isNginxForwardProtocolEnabled(settings: Partial<Record<string, unknown>> | null | undefined) {
  const normalized = normalizeForwardProtocolSettings(settings);
  return normalized.nginx !== false || normalized.nginx_stream !== false;
}

export type ForwardGroupMode = "port" | "failover" | "chain" | "entry" | "exit";

/**
 * 转发组的模式，认不出的一律当 failover。
 *
 * 流量计费配置页和套餐管理页原来各存一份（一个用 includes、一个用连等，结果
 * 一样），文案函数也各存一份。这是**摆给人看的类别名** —— 同一个组在两页叫
 * 两个名字，人会以为是两种东西。
 */
export function forwardGroupModeOf(group: any): ForwardGroupMode {
  const mode = String(group?.groupMode || "failover");
  return mode === "port" || mode === "failover" || mode === "chain" || mode === "entry" || mode === "exit"
    ? mode
    : "failover";
}

export function forwardGroupTypeText(group: any) {
  const mode = forwardGroupModeOf(group);
  if (mode === "port") return "端口转发";
  if (mode === "chain") return "转发链";
  if (mode === "entry") return "入口组";
  if (mode === "exit") return "出口组";
  if (group?.groupType === "tunnel") return "隧道转发组";
  return "转发组";
}
