import { isAgentVersionAtLeast } from "./version";

/**
 * UDP 真正的健康检查（Agent 2.2.251 起，agent/udp_probe.go）。
 *
 * 以前 UDP 路径 / UDP 成员只能 ping 主机：主机活着、UDP 服务死了，看起来照样健康。新 Agent 会探 UDP
 * 端口本身：对端回 ICMP 端口不可达就是确定不通；对端也是够新的 NEX Agent 时发回声探测报，收到回包
 * 才算通，顺带量出往返耗时。说不准的时候（没回包）照旧退回 ping，所以不会把以前判成通的判成不通。
 *
 * 面板按版本给：发回声探测报要对端的 Agent 够新（不然 24 字节的探测报会被转给落地）；转发组 / 入口组
 * 的「UDP」健康检查要探测那台的 Agent 够新（老 Agent 不认这个方法，改发 ping）。
 */
export const UDP_PROBE_MIN_AGENT_VERSION = "2.2.251";

/** 这台 Agent 会不会探 UDP 端口、会不会回 UDP 回声探测报。 */
export function agentSupportsUdpProbe(agentVersion: string | null | undefined): boolean {
  return isAgentVersionAtLeast(agentVersion, UDP_PROBE_MIN_AGENT_VERSION);
}
