import { isAgentVersionAtLeast } from "./version";

/*
  主机能不能开 IPv6 监听（hosts.ipv6ListenAvailable）。

  内核关掉 IPv6 的机器（ipv6.disable=1）上 socket(AF_INET6) 直接失败：realm 的 listen = "[::0]:端口"、
  socat 的 TCP6-LISTEN、nginx 的 listen [::]:端口 都起不来。Agent 从 IPV6_LISTEN_REPORT_AGENT_VERSION 起
  每次心跳带上 ipv6Listen（agent/ipv6_listen.go），面板记到主机上，生成这三种配置时据此改成只听 IPv4。

  没报过（老 Agent，列是 NULL）一律当能用：和以前完全一样的双栈配置，一个字节都不变。
*/

/** 从这一版起 Agent 上报 ipv6Listen，监听没起来时也带上服务日志里的原因（agent/runtime_failure_detail.go）。 */
export const IPV6_LISTEN_REPORT_AGENT_VERSION = "2.2.256";

/** 只有明确报过「不能用」才是 false；NULL / 没这一列 / 别的值都按能用。 */
export function hostIpv6ListenAvailable(host: { ipv6ListenAvailable?: unknown } | null | undefined): boolean {
  const value = host?.ipv6ListenAvailable;
  return !(value === false || value === 0 || value === "0");
}

/** 心跳里的 ipv6Listen：只认布尔值，别的（没带、老 Agent）返回 null，表示「这次没报，库里的不动」。 */
export function parseReportedIpv6Listen(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

export function agentReportsRuntimeFailureDetail(agentVersion: string | null | undefined) {
  return isAgentVersionAtLeast(agentVersion, IPV6_LISTEN_REPORT_AGENT_VERSION);
}
