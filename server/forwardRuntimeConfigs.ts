/**
 * 用户态转发后端的配置文件与 systemd 单元，按转发方式各生成各的。
 *
 * 为什么把这一层单独拎出来：realm / socat / nginx / gost 这四种都是「起一个进程
 * 来转」，而心跳路由里它们各自有一大段代码，把三件不同性质的事搅在一起 ——
 *
 *   1. **算出配置长什么样**（纯函数：规则进去，一段文本出来）
 *   2. 拼下发动作、清理上一任后端、挂计数链（依赖每次请求各不相同的上下文）
 *   3. 往 actions 里塞
 *
 * 只有第一件是纯的，也只有第一件是**真正容易写错又看不出来的**：`use_udp` 写反、
 * proxy protocol 的版本号填错、监听地址少个方括号 —— 这些不会报错，只会让流量
 * 悄悄走不通。把它们摘出来单独测，比在六千行路由里对着字符串拼接肉眼检查靠谱。
 *
 * 第二、三件仍然留在路由里：它们依赖 host、用户配额、故障转移目标这些请求级状态，
 * 硬搬过来只会变成往这边传十个回调，那不是解耦，是把耦合换个地方写。
 */

import { isIP } from "node:net";

import { isForwardRuleProtocolUdpEnabled, normalizeForwardRuleProtocol } from "../shared/forwardTypes";

export const REALM_CONFIG_DIR = "/etc/forwardx/realm";

/** realm 的 TOML 字符串字面量。JSON 的转义规则在这里正好够用。 */
export function realmTomlString(value: unknown) {
  return JSON.stringify(String(value ?? ""));
}

export function serviceProtocolSuffix(protocol: unknown) {
  return normalizeForwardRuleProtocol(protocol, "both");
}

export function realmServiceNameForPort(port: unknown, protocol: unknown) {
  return `forwardx-realm-${serviceProtocolSuffix(protocol)}-${Number(port) || 0}`;
}

export function legacyRealmServiceNameForPort(port: unknown) {
  return `forwardx-realm-${Number(port) || 0}`;
}

export function realmConfigPathForPort(port: unknown, protocol: unknown) {
  return `${REALM_CONFIG_DIR}/${realmServiceNameForPort(port, protocol)}.toml`;
}

export function legacyRealmConfigPathForPort(port: unknown) {
  return `${REALM_CONFIG_DIR}/${legacyRealmServiceNameForPort(port)}.toml`;
}

/** 生成 realm 配置需要知道的东西。都是算好的值，这一层不去查库也不碰 host。 */
export type RealmConfigInput = {
  /** 本机监听端口。 */
  sourcePort: unknown;
  /** tcp / udp / both。 */
  protocol: unknown;
  /** 已经拼好的远端 `host:port`（IPv6 要自带方括号）。 */
  remote: string;
  /** 往后端发 PROXY protocol 头。 */
  sendProxy: boolean;
  /** 接受前端来的 PROXY protocol 头。 */
  acceptProxy: boolean;
  /** PROXY protocol 版本，1 或 2。 */
  proxyVersion: number;
};

/**
 * realm 的配置文件内容。
 *
 * `use_udp` 跟着规则协议走：写死成 true 会让纯 TCP 的规则也开一个 UDP 监听，
 * 端口被别人占着时 realm 直接起不来 —— 而面板这边只会看到「等待 Agent 上报」。
 */
export function buildRealmConfigToml(input: RealmConfigInput): string {
  return [
    "[log]",
    'level = "warn"',
    "",
    "[network]",
    `use_udp = ${isForwardRuleProtocolUdpEnabled(input.protocol) ? "true" : "false"}`,
    "tcp_timeout = 300",
    "udp_timeout = 30",
    "ipv6_only = false",
    `send_proxy = ${input.sendProxy ? "true" : "false"}`,
    `send_proxy_version = ${input.proxyVersion}`,
    `accept_proxy = ${input.acceptProxy ? "true" : "false"}`,
    "accept_proxy_timeout = 5",
    "",
    "[[endpoints]]",
    `listen = ${realmTomlString(`[::0]:${Number(input.sourcePort) || 0}`)}`,
    `remote = ${realmTomlString(input.remote)}`,
    "",
  ].join("\n");
}

export type RealmUnitInput = {
  sourcePort: unknown;
  targetIp: unknown;
  targetPort: unknown;
  configPath: string;
  /** 绑定网卡，空表示不绑。 */
  networkInterface?: string;
};

/** realm 的 systemd 单元。 */
export function buildRealmServiceUnit(input: RealmUnitInput): string {
  const ifaceFlag = input.networkInterface ? ` --interface ${input.networkInterface}` : "";
  return [
    "[Unit]",
    // 单元正文是 Agent 服务签名的一部分（managedServiceActionSignature）：这里的文案改了，
    // 已装机器升级后每个 realm/socat 服务都会被当成过期重启一遍。所以品牌词保持 ForwardX。
    `Description=ForwardX realm forwarder ${input.sourcePort}->${input.targetIp}:${input.targetPort}`,
    "After=network.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=/usr/local/bin/realm -c ${input.configPath}${ifaceFlag}`,
    "Restart=always",
    "RestartSec=5",
    "LimitNOFILE=65535",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/* ---------------------------------------------------------------------------
 * 端点地址
 *
 * 这几个是纯格式化：IPv6 字面量在配置文件和命令行里要带方括号，在 socat 的协议名
 * 上还要带 `6` 后缀。写漏了不会报错，只会让这条转发起来之后连不通 —— 而面板上
 * 看到的只是「等待 Agent 上报」。
 * ------------------------------------------------------------------------- */

export function cleanEndpointHost(value: unknown) {
  return String(value || "").trim().replace(/^\[([^\]]+)\]$/, "$1");
}

export function isIpv6Literal(value: unknown) {
  return isIP(cleanEndpointHost(value)) === 6;
}

export function endpointHostPort(host: unknown, port: unknown) {
  const clean = cleanEndpointHost(host);
  return isIpv6Literal(clean) ? `[${clean}]:${Number(port) || 0}` : `${clean}:${Number(port) || 0}`;
}

/**
 * socat 的转发参数。
 *
 * - `-b65536`：socat 默认每次只搬 8 KiB，UDP 下超过 8 KiB 的数据报还会被截断。
 * - `nodelay`（只对 TCP）：socat 默认不关 Nagle，小包请求/响应（游戏、SSH、API）
 *   会被攒包和延迟确认叠出几十毫秒的延迟。realm / gost / nginx / FXP 都已经开了。
 */
export const SOCAT_TRANSFER_BUFFER_FLAG = "-b65536";

export function socatSocketOptions(protocol: "TCP" | "UDP") {
  return protocol === "TCP" ? ",nodelay" : "";
}

/** socat 的拨号端点：`TCP:1.2.3.4:80`，目标是 IPv6 时变成 `TCP6:[::1]:80`。 */
export function socatDialEndpoint(protocol: "TCP" | "UDP", host: unknown, port: unknown) {
  const clean = cleanEndpointHost(host);
  const dialProtocol = isIpv6Literal(clean) ? `${protocol}6` : protocol;
  return `${dialProtocol}:${endpointHostPort(clean, port)}`;
}

/** 写进 ExecStart 的拨号端，带上 socatSocketOptions。 */
export function socatDialAddress(protocol: "TCP" | "UDP", host: unknown, port: unknown) {
  return `${socatDialEndpoint(protocol, host, port)}${socatSocketOptions(protocol)}`;
}

/* ---------------------------------------------------------------------------
 * socat
 * ------------------------------------------------------------------------- */

export function socatServiceNameForPort(port: unknown, protocol: unknown) {
  return `forwardx-socat-${serviceProtocolSuffix(protocol)}-${Number(port) || 0}`;
}

export function legacySocatServiceNameForPort(port: unknown) {
  return `forwardx-socat-${Number(port) || 0}`;
}

export type SocatUnitInput = {
  /**
   * 写进 Description 的协议名。
   *
   * 这里不跟 `dialProtocol` 合并是因为两处本来就不一样：`both` 模式下拆出的两个
   * 单元写的是大写 `TCP` / `UDP`，单协议模式写的是规则上的原始值（小写）。
   * 统一成一种写法会改掉已经装在真机上的单元文件内容，触发一次没必要的重下发。
   */
  descriptionProtocol: unknown;
  /** 监听和拨号用的协议，决定 `TCP6-LISTEN` 还是 `UDP6-LISTEN`。 */
  dialProtocol: "TCP" | "UDP";
  sourcePort: unknown;
  /** 只用于 Description 里那句人看的说明，不参与拨号。 */
  targetIp: unknown;
  targetPort: unknown;
  /** 真正拨过去的地址：走故障转移时是本机代理端口，不等于 `targetIp`。 */
  dialHost: unknown;
  dialPort: unknown;
};

/**
 * socat 的 systemd 单元。
 *
 * 监听一律用 `TCP6/UDP6-LISTEN` 加 `ipv6only=0`：一个双栈套接字同时收 v4 和 v6，
 * 比起两个单元各监听一个协议栈少一半进程，也不会出现「v6 起来了 v4 没起来」。
 */
export function buildSocatServiceUnit(input: SocatUnitInput): string {
  const dial = socatDialAddress(input.dialProtocol, input.dialHost, input.dialPort);
  return [
    "[Unit]",
    `Description=ForwardX socat ${input.descriptionProtocol} forwarder ${input.sourcePort}->${input.targetIp}:${input.targetPort}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=/usr/bin/socat ${SOCAT_TRANSFER_BUFFER_FLAG} ${input.dialProtocol}6-LISTEN:${input.sourcePort},fork,reuseaddr,ipv6only=0${socatSocketOptions(input.dialProtocol)} ${dial}`,
    "Restart=always",
    "RestartSec=5",
    "LimitNOFILE=65535",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}
