/**
 * 转发规则的 VLESS Reality 出口：服务端那一半（规则见 shared/vlessEgress.ts，和 Shadowsocks 出口共用的那部分在
 * server/ssEgress.ts）。
 *
 *   - 外部 vless:// 链接的加密保存：和 SS 链接同一套 AES-256-GCM，单独一个 HKDF info，两边的密文互相解不开；
 *   - 入口机上的本机桥接：每条规则一个 127.0.0.1 上的 socks 入站（随机凭据）→ 一个 vless 出站，
 *     合成一份 sing-box 配置（forwardx-singbox-egress 服务，/etc/forwardx/singbox/egress.json）；
 *   - 桥接端口：每次心跳按规则号确定性地挑，避开这台机器上规则、隧道、落地入站用到的端口；
 *     挑好的端口再交给协议守卫的端口分配当作「已占用」（见心跳里 reservedProtocolGuardPorts）。
 *
 * gost 那一侧只是链上多一个 socks5 节点（server/ssEgress.ts 的 buildGostEgressChain），监听、计数、限速和
 * Shadowsocks 出口一模一样，都在入口的 gost 服务上。
 */

import crypto from "node:crypto";

import type { GithubAcceleratorConfig } from "../shared/githubAccelerator";
import { VLESS_EGRESS_FLOW, type VlessEgressEndpoint } from "../shared/vlessEgress";
import * as db from "./db";
import { ENV } from "./env";
import { createCredentialCipher, type CredentialCipher } from "./ipChange/secrets";
import {
  restartManagedServiceIfConfigChangedCmd,
  shQuote,
  stopManagedServiceCmd,
  writeManagedServiceCmd,
} from "./agentActionCommands";
import { ensureSingboxBinaryCmd, SINGBOX_BIN, SINGBOX_CONFIG_DIR, type SingboxManagedConfig } from "./singboxRuntimePlan";

/* ── 外部链接的加密 ─────────────────────────────────────────────────── */

const VLESS_EGRESS_CIPHER_INFO = "vless-egress-link-v1";
let cipherInstance: CredentialCipher | null = null;
let cipherSecretOverride: string | null = null;

function egressCipher() {
  return (cipherInstance ||= createCredentialCipher(cipherSecretOverride ?? ENV.cookieSecret, VLESS_EGRESS_CIPHER_INFO));
}

/** 测试用：换一把密钥（模拟「迁到另一台面板」）。传 null 恢复用面板密钥。 */
export function setVlessEgressCipherSecretForTests(secret: string | null) {
  cipherSecretOverride = secret;
  cipherInstance = null;
}

export function encryptVlessEgressEndpoint(endpoint: VlessEgressEndpoint): string {
  return egressCipher().encrypt({
    protocol: "vless",
    server: String(endpoint.server),
    port: String(Number(endpoint.port)),
    uuid: String(endpoint.uuid),
    serverName: String(endpoint.serverName),
    publicKey: String(endpoint.publicKey),
    shortId: String(endpoint.shortId || ""),
    fingerprint: String(endpoint.fingerprint || ""),
    ...(endpoint.name ? { name: String(endpoint.name) } : {}),
  });
}

/** 解不开（面板密钥变过、或者存的是 SS 链接的密文）或内容不对时回 null。 */
export function decryptVlessEgressEndpoint(stored: unknown): VlessEgressEndpoint | null {
  const text = String(stored ?? "");
  if (!text) return null;
  try {
    const raw = egressCipher().decrypt(text);
    if (String(raw.protocol || "") !== "vless") return null;
    const endpoint: VlessEgressEndpoint = {
      server: String(raw.server || ""),
      port: Number(raw.port || 0),
      uuid: String(raw.uuid || ""),
      serverName: String(raw.serverName || ""),
      publicKey: String(raw.publicKey || ""),
      shortId: String(raw.shortId || ""),
      fingerprint: String(raw.fingerprint || ""),
      ...(raw.name ? { name: String(raw.name) } : {}),
    };
    return endpoint.server && endpoint.port && endpoint.uuid && endpoint.publicKey ? endpoint : null;
  } catch {
    return null;
  }
}

/* ── 落地入站 → 出口端点 ─────────────────────────────────────────────── */

/**
 * 落地入站拿哪一个用户的 UUID 去连：优先入站主人自己的（sharedUserId = 0，分享收回时不会被一起删掉），
 * 再按排序取第一个。没有用户回空串（调用方按「出口配置失效」处理）。
 */
export function pickVlessEgressInboundUuid(users: readonly { uuid?: unknown; sharedUserId?: unknown }[] | null | undefined): string {
  const list = (users || []).filter((user) => String(user?.uuid || "").trim());
  const own = list.find((user) => !(Number(user?.sharedUserId || 0) > 0));
  return String((own || list[0])?.uuid || "").trim().toLowerCase();
}

/* ── 本机桥接 ─────────────────────────────────────────────────────── */

export const VLESS_EGRESS_BRIDGE_SERVICE_NAME = "forwardx-singbox-egress";
export const VLESS_EGRESS_BRIDGE_CONFIG_PATH = `${SINGBOX_CONFIG_DIR}/egress.json`;
/** 桥接端口挑在这一段里：和协议守卫、隧道出口本机服务那几段（45000 + 规则号起）错开，冲突时往后顺延。 */
export const VLESS_EGRESS_BRIDGE_PORT_MIN = 36000;
export const VLESS_EGRESS_BRIDGE_PORT_MAX = 39999;

/**
 * socks 入站的凭据。桥接只听 127.0.0.1，但同一台机器上别的进程（别的租户的 socat、用户自己跑的程序）
 * 也能连回环地址：不带凭据的话，谁都能借这条 VLESS 线路出去。凭据由面板密钥和规则号、UUID 派生：
 * 每次心跳算出来都一样（配置不变就不重启 sing-box），换了落地 UUID 跟着换。
 */
export function vlessEgressBridgeCredentials(ruleId: number, uuid: string, secret: string = cipherSecretOverride ?? ENV.cookieSecret) {
  const digest = crypto.createHmac("sha256", `nex-vless-egress-bridge:${secret}`).update(`${Number(ruleId)}:${String(uuid)}`).digest("hex");
  return { username: `r${Number(ruleId)}-${digest.slice(0, 8)}`, password: digest.slice(8, 40) };
}

export type VlessEgressBridgePortAllocator = {
  /** 这条规则的桥接端口；同一次心跳里同一条规则拿到的总是同一个。没有空闲端口回 0。 */
  portFor(ruleId: number): number;
  /** 已经分出去的端口（交给协议守卫当作已占用）。 */
  ports(): number[];
};

/**
 * 按规则号确定性地挑：首选 MIN + 规则号 % 段长，被占了往后顺延。先给 preallocateRuleIds 按规则号从小到大分，
 * 这样同一台机器上规则的增删不会让别的规则的端口来回换（换端口就得重启 sing-box）。
 */
export function createVlessEgressBridgePortAllocator(usedPorts: Iterable<number>, preallocateRuleIds: readonly number[] = []): VlessEgressBridgePortAllocator {
  const used = new Set<number>();
  for (const value of usedPorts) {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0 && port <= 65535) used.add(port);
  }
  const assigned = new Map<number, number>();
  const span = VLESS_EGRESS_BRIDGE_PORT_MAX - VLESS_EGRESS_BRIDGE_PORT_MIN + 1;
  const portFor = (ruleIdRaw: number) => {
    const ruleId = Number(ruleIdRaw);
    if (!(ruleId > 0)) return 0;
    const existing = assigned.get(ruleId);
    if (existing !== undefined) return existing;
    let picked = 0;
    for (let offset = 0; offset < span; offset += 1) {
      const port = VLESS_EGRESS_BRIDGE_PORT_MIN + ((ruleId + offset) % span);
      if (used.has(port)) continue;
      used.add(port);
      picked = port;
      break;
    }
    assigned.set(ruleId, picked);
    return picked;
  };
  for (const ruleId of Array.from(new Set(preallocateRuleIds.map(Number).filter((id) => id > 0))).sort((a, b) => a - b)) portFor(ruleId);
  return { portFor, ports: () => Array.from(assigned.values()).filter((port) => port > 0) };
}

/** 规则行、隧道行上这台机器可能在听的端口。 */
type PortRow = Record<string, unknown> | null | undefined;

function addRowPorts(target: Set<number>, row: PortRow, keys: readonly string[]) {
  for (const key of keys) {
    const port = Number(row?.[key] || 0);
    if (Number.isInteger(port) && port > 0 && port <= 65535) target.add(port);
  }
}

/**
 * 心跳用：这台机器上 VLESS 出口规则的桥接端口分配器。没有 VLESS 出口规则时不查库，直接给一个空的。
 * 已占用的端口：这台机器上所有规则的监听 / 本机转发端口、隧道监听端口、落地入站端口。
 */
export async function planVlessEgressBridgePorts(hostId: number, rules: readonly PortRow[], tunnels: readonly PortRow[] = []): Promise<VlessEgressBridgePortAllocator> {
  const vlessRuleIds = rules
    .filter((rule) => Number(rule?.hostId) === Number(hostId) && /^vless_/.test(String(rule?.egressType || "")))
    .map((rule) => Number(rule?.id));
  if (vlessRuleIds.length === 0) return createVlessEgressBridgePortAllocator([]);
  const used = new Set<number>();
  for (const rule of rules) addRowPorts(used, rule, ["sourcePort", "targetPort", "udpOverTcpPort", "gostRelayPort", "tunnelExitPort"]);
  for (const tunnel of tunnels) addRowPorts(used, tunnel, ["listenPort", "mimicPort", "entryPort"]);
  for (const inbound of await db.getProxyInboundsByHost(Number(hostId)).catch(() => [])) addRowPorts(used, { port: inbound.port }, ["port"]);
  return createVlessEgressBridgePortAllocator(used, vlessRuleIds);
}

export type VlessEgressBridge = {
  ruleId: number;
  port: number;
  username: string;
  password: string;
  endpoint: VlessEgressEndpoint;
};

/** 一条规则的 sing-box vless 出站（字段按 sing-box 1.14 的出站文档；REALITY 客户端必须开 uTLS）。 */
export function buildVlessEgressOutbound(tag: string, endpoint: VlessEgressEndpoint): Record<string, unknown> {
  return {
    type: "vless",
    tag,
    server: endpoint.server,
    server_port: Number(endpoint.port),
    uuid: endpoint.uuid,
    flow: VLESS_EGRESS_FLOW,
    tls: {
      enabled: true,
      server_name: endpoint.serverName,
      utls: { enabled: true, fingerprint: endpoint.fingerprint || "chrome" },
      reality: {
        enabled: true,
        public_key: endpoint.publicKey,
        ...(endpoint.shortId ? { short_id: endpoint.shortId } : {}),
      },
    },
  };
}

/**
 * 入口机上桥接用的那份 sing-box 配置。每条规则一对「socks 入站 → vless 出站」，路由按入站一一对上。
 *
 * 刻意没有 direct 出站：sing-box 没配 final 时用第一个出站兜底，要是有 direct，一条对不上的连接就会从
 * 入口机自己出去 —— 出口最不能出的错就是「显示在走落地，其实直连了」。Agent 2.2.253 写入前也查这一条
 * （agent/singbox_egress_bridge.go）。
 */
export function buildVlessEgressBridgeConfig(bridges: readonly VlessEgressBridge[]): string {
  const sorted = [...bridges].sort((left, right) => left.ruleId - right.ruleId);
  const config = {
    log: { level: "warn", timestamp: true },
    inbounds: sorted.map((bridge) => ({
      type: "socks",
      tag: `bridge-${bridge.ruleId}`,
      listen: "127.0.0.1",
      listen_port: bridge.port,
      users: [{ username: bridge.username, password: bridge.password }],
    })),
    outbounds: sorted.map((bridge) => buildVlessEgressOutbound(`egress-${bridge.ruleId}`, bridge.endpoint)),
    route: {
      rules: sorted.map((bridge) => ({ inbound: [`bridge-${bridge.ruleId}`], outbound: `egress-${bridge.ruleId}` })),
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function buildVlessEgressBridgeServiceUnit(): string {
  return [
    "[Unit]",
    "Description=ForwardX sing-box egress bridge (VLESS Reality)",
    "After=network.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${SINGBOX_BIN} run -c ${VLESS_EGRESS_BRIDGE_CONFIG_PATH}`,
    "Restart=always",
    "RestartSec=5",
    "LimitNOFILE=65535",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export type VlessEgressBridgePlan = {
  active: boolean;
  preCommands: string[];
  /** mode：配置里有落地的 UUID 和桥接凭据，只给 root 读（sing-box 以 root 跑）。 */
  managedConfigs: Array<SingboxManagedConfig & { mode: number }>;
  commands: string[];
};

/**
 * 下发计划，和落地入站那份（server/singboxRuntimePlan.ts）同一个结构：装二进制（同一个 forwardx-singbox）→
 * 写配置（sing-box check 不过整份回滚）→ 起服务。配置没变、服务也在跑时不重启（restartManagedServiceIfConfigChangedCmd），
 * 心跳定期重发不会打断正在走出口的连接。没有桥接时停服务、删配置，不删二进制（落地入站也在用它）。
 */
export function buildVlessEgressBridgePlan(options: {
  bridges: readonly VlessEgressBridge[];
  accelerator?: GithubAcceleratorConfig | null;
  panelRelayBase?: string;
}): VlessEgressBridgePlan {
  const bridges = options.bridges.filter((bridge) => bridge && bridge.port > 0);
  if (bridges.length === 0) {
    return {
      active: false,
      preCommands: [],
      managedConfigs: [],
      commands: [
        stopManagedServiceCmd(VLESS_EGRESS_BRIDGE_SERVICE_NAME),
        `rm -f ${shQuote(VLESS_EGRESS_BRIDGE_CONFIG_PATH)} ${shQuote(`${VLESS_EGRESS_BRIDGE_CONFIG_PATH}.sha256`)} 2>/dev/null || true`,
      ],
    };
  }
  const config = buildVlessEgressBridgeConfig(bridges);
  return {
    active: true,
    preCommands: [ensureSingboxBinaryCmd({ accelerator: options.accelerator, panelRelayBase: options.panelRelayBase })],
    managedConfigs: [{
      path: VLESS_EGRESS_BRIDGE_CONFIG_PATH,
      contentBase64: Buffer.from(config, "utf8").toString("base64"),
      format: "json",
      validateCommand: `${SINGBOX_BIN} check -c {{path}}`,
      serviceName: VLESS_EGRESS_BRIDGE_SERVICE_NAME,
      mode: 0o600,
    }],
    commands: [
      writeManagedServiceCmd(VLESS_EGRESS_BRIDGE_SERVICE_NAME, buildVlessEgressBridgeServiceUnit()),
      restartManagedServiceIfConfigChangedCmd(VLESS_EGRESS_BRIDGE_SERVICE_NAME, VLESS_EGRESS_BRIDGE_CONFIG_PATH),
    ],
  };
}

/** 运行视图里能跑的 VLESS 出口规则 → 桥接条目（只取这台机器自己的、启用着的）。 */
type BridgeRuleView = {
  id?: unknown;
  hostId?: unknown;
  isEnabled?: unknown;
  egressRuntime?: Record<string, unknown> | null;
};

export function collectVlessEgressBridges(rules: readonly unknown[], hostId: number): VlessEgressBridge[] {
  const byRule = new Map<number, VlessEgressBridge>();
  for (const item of rules) {
    const rule = item as BridgeRuleView | null | undefined;
    const runtime = rule?.egressRuntime;
    if (!runtime || runtime.kind !== "vless" || Number(rule?.hostId) !== Number(hostId)) continue;
    if (!(rule?.isEnabled === true || rule?.isEnabled === 1 || rule?.isEnabled === "1")) continue;
    if (!(Number(runtime.bridgePort) > 0)) continue;
    byRule.set(Number(rule?.id), {
      ruleId: Number(rule?.id),
      port: Number(runtime.bridgePort),
      username: String(runtime.bridgeUsername),
      password: String(runtime.bridgePassword),
      endpoint: {
        server: String(runtime.server),
        port: Number(runtime.port),
        uuid: String(runtime.uuid),
        serverName: String(runtime.serverName),
        publicKey: String(runtime.publicKey),
        shortId: String(runtime.shortId || ""),
        fingerprint: String(runtime.fingerprint || ""),
      },
    });
  }
  return Array.from(byRule.values());
}
