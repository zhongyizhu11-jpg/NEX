/**
 * Mieru 落地入站：面板、界面、测试共用的那一份规则。
 *
 * 和别的落地协议不一样的地方只有一个，但它决定了后面所有设计：服务端不是 sing-box（sing-box
 * 没有 Mieru 服务端），而是上游的 mita。一台机器上只跑一个 mita（服务名 forwardx-mita），这台机器上
 * 所有 Mieru 入站合成一份 mita 配置，由 Agent 的扩展模块 "mita" 下发（agent/ext_mita.go，
 * 面板那头 server/ops/mitaAgent.ts），不走 sing-box 那条 actions 链路。
 *
 * mita 的用户表是整台机器共用的，不分端口：A 入站的凭据在 B 入站的端口上也能连。所以用户名在整台
 * 机器上必须唯一，流量也只能按用户记（mita 自己按用户计数），不能按端口记 —— 端口计数会把
 * 「A 的用户连了 B 的端口」记到 B 头上。
 *
 * 本文件保持纯计算：客户端也会 import 它。
 */

import type { ProxyInbound, ProxyInboundUser } from "./proxyInbound";
import { isAgentVersionAtLeast } from "./version";

/** Agent 从这一版起带 mita 扩展模块。比它旧的 Agent 上，Mieru 入站照常保存，但不下发。 */
export const MIERU_AGENT_VERSION = "2.2.253";

export function isMieruAgentSupported(agentVersion: string | null | undefined): boolean {
  return isAgentVersionAtLeast(agentVersion, MIERU_AGENT_VERSION);
}

/** 行上那句「需要升级 Agent」。 */
export function mieruAgentUpgradeMessage(agentVersion: string | null | undefined): string {
  return `需要升级 Agent：Mieru 落地从 Agent ${MIERU_AGENT_VERSION} 起支持，这台主机是 ${String(agentVersion || "").trim() || "未知版本"}，入站已保存但暂不下发`;
}

/**
 * 承载：只开 TCP、只开 UDP、两个都开。两个都开时 mita 在同一段端口上 TCP、UDP 各听一份；
 * 客户端那边 mihomo 只认 TCP（见 proxySubscription.ts），mierus:// 链接两份都写。
 */
export const MIERU_TRANSPORTS = ["TCP", "UDP", "BOTH"] as const;
export type MieruTransport = (typeof MIERU_TRANSPORTS)[number];

export const MIERU_TRANSPORT_LABELS: Record<MieruTransport, string> = {
  TCP: "TCP",
  UDP: "UDP",
  BOTH: "TCP + UDP",
};

export function normalizeMieruTransport(value: unknown): MieruTransport {
  const raw = String(value ?? "").trim().toUpperCase();
  return (MIERU_TRANSPORTS as readonly string[]).includes(raw) ? raw as MieruTransport : "TCP";
}

export function mieruTransportProtocols(transport: unknown): Array<"TCP" | "UDP"> {
  const normalized = normalizeMieruTransport(transport);
  return normalized === "BOTH" ? ["TCP", "UDP"] : [normalized];
}

/**
 * 一个入站最多占多少个端口。mita 一段端口就是一组监听，太长了既占满这台机器的端口，
 * 又让端口冲突检查（逐个端口查）变慢；Mieru 文档里的例子也就十来个。
 */
export const MIERU_PORT_RANGE_MAX_PORTS = 100;

/** mita 的 UDP MTU，取官方默认值。只影响 UDP 承载，1400 在常见线路上不会分片。 */
export const MIERU_MTU = 1400;

/**
 * 用户名的字符集。面板生成的是「nex」加随机十六进制；粘来的、旧数据里的也按这个收，免得一个
 * 怪字符让 mita 拒绝整份配置 —— 同一台机器上别人的 Mieru 入站会跟着一起停。
 */
const MIERU_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function isValidMieruUsername(value: unknown): boolean {
  return MIERU_USERNAME_PATTERN.test(String(value ?? ""));
}

function toPort(value: unknown): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

/** 这个入站占的全部端口（端口段展开）。端口冲突检查用。 */
export function mieruInboundPorts(port: unknown, portRangeEnd: unknown): number[] {
  const start = toPort(port);
  if (!start) return [];
  const end = toPort(portRangeEnd);
  if (!end || end <= start) return [start];
  const ports: number[] = [];
  for (let value = start; value <= end && ports.length < MIERU_PORT_RANGE_MAX_PORTS; value += 1) ports.push(value);
  return ports;
}

/** 校验 Mieru 专有的那几个字段；空串表示没问题。通用部分（端口、用户凭据）在 validateProxyInbound。 */
export function validateMieruInboundFields(inbound: Pick<ProxyInbound, "port" | "portRangeEnd" | "mieruTransport" | "users">): string {
  const raw = String(inbound.mieruTransport ?? "").trim().toUpperCase();
  if (raw && !(MIERU_TRANSPORTS as readonly string[]).includes(raw)) {
    return `不支持的 Mieru 承载「${raw.slice(0, 16)}」，只能是 TCP / UDP / 两个都开`;
  }
  const start = toPort(inbound.port);
  const end = Number(inbound.portRangeEnd || 0);
  if (end) {
    if (!toPort(end)) return "端口段的终点不合法";
    if (end <= start) return "端口段的终点要比起点大";
    if (end - start + 1 > MIERU_PORT_RANGE_MAX_PORTS) {
      return `端口段最多 ${MIERU_PORT_RANGE_MAX_PORTS} 个端口，这里是 ${end - start + 1} 个`;
    }
  }
  for (const user of inbound.users) {
    if (user.uuid && !isValidMieruUsername(user.uuid)) {
      return `用户「${String(user.name || "").trim() || "未命名用户"}」的 Mieru 用户名只能是字母、数字和 _ . -（最多 64 个字符）`;
    }
  }
  return "";
}

export type MitaPortBinding = { port: number; protocol: "TCP" | "UDP" } | { portRange: string; protocol: "TCP" | "UDP" };

export type MitaServerConfig = {
  portBindings: MitaPortBinding[];
  users: Array<{ name: string; password: string }>;
  loggingLevel: "INFO";
  mtu: number;
};

/** mita 里的一个用户对应面板里的哪个入站、哪一行凭据。流量按它记回去。 */
export type MitaUserRef = {
  name: string;
  inboundId: number;
  inboundUserId: number;
};

export type MitaHostPlan = {
  /** 没有一个能下发的入站时是 null：Agent 收到后停掉它自己装的 forwardx-mita。 */
  config: MitaServerConfig | null;
  users: MitaUserRef[];
  /** 进了配置的入站。 */
  inboundIds: number[];
  /** 没进配置的入站 / 用户及原因（面板记日志、界面显示）。 */
  skipped: Array<{ inboundId: number; inboundUserId?: number; reason: string }>;
};

export function mieruPortBindings(inbound: Pick<ProxyInbound, "port" | "portRangeEnd" | "mieruTransport">): MitaPortBinding[] {
  const start = toPort(inbound.port);
  if (!start) return [];
  const end = toPort(inbound.portRangeEnd);
  return mieruTransportProtocols(inbound.mieruTransport).map((protocol) => (
    end > start ? { portRange: `${start}-${end}`, protocol } : { port: start, protocol }
  ));
}

/**
 * 一台机器上全部启用中的 Mieru 入站合成一份 mita 配置。
 *
 * 和 sing-box 那边同一个原则：一个坏入站只让它自己不生效，不拖累整份配置 —— mita 对端口撞车、
 * 重名用户是拒绝启动整个进程的。所以这里把会让 mita 起不来的东西挡在配置之外：
 *   - 端口（同一承载）和前面的入站撞了：整个入站跳过；
 *   - 用户名和别的入站重了、或者凭据不全：只跳过那一个用户。
 * 顺序按入站 id、用户顺序，保证同样的输入逐字节一样 —— Agent 只在配置变了时才重启 mita。
 */
export function buildMitaHostPlan(entries: ReadonlyArray<{ id: number; inbound: ProxyInbound }>): MitaHostPlan {
  const ordered = [...entries].filter((entry) => entry?.inbound?.protocol === "mieru").sort((a, b) => Number(a.id) - Number(b.id));
  const usedPorts = new Set<string>();
  const usedNames = new Set<string>();
  const portBindings: MitaPortBinding[] = [];
  const users: Array<{ name: string; password: string }> = [];
  const refs: MitaUserRef[] = [];
  const inboundIds: number[] = [];
  const skipped: MitaHostPlan["skipped"] = [];

  for (const { id, inbound } of ordered) {
    const inboundId = Number(id);
    const fieldError = validateMieruInboundFields(inbound);
    const ports = mieruInboundPorts(inbound.port, inbound.portRangeEnd);
    if (fieldError || ports.length === 0) {
      skipped.push({ inboundId, reason: fieldError || "监听端口不合法" });
      continue;
    }
    const protocols = mieruTransportProtocols(inbound.mieruTransport);
    const keys = protocols.flatMap((protocol) => ports.map((port) => `${protocol}:${port}`));
    const clash = keys.find((key) => usedPorts.has(key));
    if (clash) {
      skipped.push({ inboundId, reason: `端口 ${clash.replace(":", " ")} 已被这台机器上别的 Mieru 入站占用` });
      continue;
    }

    const accepted: Array<{ user: ProxyInboundUser; name: string; password: string }> = [];
    const localNames = new Set<string>();
    for (const user of inbound.users) {
      const name = String(user.uuid || "").trim();
      const password = String(user.password || "");
      if (!name || !password || !isValidMieruUsername(name)) {
        skipped.push({ inboundId, inboundUserId: Number(user.id) || 0, reason: "缺少用户名或密码" });
        continue;
      }
      if (usedNames.has(name) || localNames.has(name)) {
        skipped.push({ inboundId, inboundUserId: Number(user.id) || 0, reason: `用户名 ${name} 在这台机器上重复了` });
        continue;
      }
      localNames.add(name);
      accepted.push({ user, name, password });
    }
    // 一个用户都没有的入站不开端口：开出来谁也连不上，还白占着端口。
    if (accepted.length === 0) {
      skipped.push({ inboundId, reason: "没有可用的用户" });
      continue;
    }
    for (const key of keys) usedPorts.add(key);
    portBindings.push(...mieruPortBindings(inbound));
    for (const item of accepted) {
      usedNames.add(item.name);
      users.push({ name: item.name, password: item.password });
      refs.push({ name: item.name, inboundId, inboundUserId: Number(item.user.id) || 0 });
    }
    inboundIds.push(inboundId);
  }

  return {
    config: portBindings.length > 0 && users.length > 0
      ? { portBindings, users, loggingLevel: "INFO", mtu: MIERU_MTU }
      : null,
    users: refs,
    inboundIds,
    skipped,
  };
}
