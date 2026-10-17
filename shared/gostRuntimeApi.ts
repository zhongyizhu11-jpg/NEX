/**
 * gost 共享运行时的增量同步（agent/gost_api_sync.go）—— 面板、Agent 共用的门槛。
 *
 * 一台机器上所有 gost 规则共用一个 forwardx-runtime（隧道出口是 forwardx-tunnel-runtime）进程。以前加一条
 * 规则就要重写 gost.json、重启进程，这台机器上其它规则的连接全断。能力 gostApiSync 的机器上，面板：
 *   - 在 gost.json 里开 gost 的 API，只监听 root 专用的 Unix 套接字（目录 0700、套接字 0600），不开 TCP；
 *   - 单元的 ExecStart 包一层 sh：建目录、删上次异常退出留下的套接字（否则 gost 起不来）、umask 177；
 *   - 重启命令前面加一行标记。新 Agent 看到标记就先按规范形式算差量、通过 API 改运行状态（新增服务 / 链 /
 *     限速器、改限速值、改删 UDP 规则）；需要断开 TCP 已有连接的改动（TCP 规则的修改、删除）、全局变化或 API
 *     出错，就撤销这次 API 做的改动、照旧全量写 + 重启（agent/gost_api_sync.go）。
 *     旧 Agent 把标记当注释，直接执行后面的重启命令。
 * 能力要 Agent ≥ 2.2.229 并且它实测装着的运行时 ≥ 3.2.6（NEX 自编版和官方版都行；更旧的官方版不一定认
 * unix:// 的 API 地址，不认的话 gost 会起不来），所以面板只看能力，旧 Agent / 旧运行时的机器配置一个字节都不变。
 */

import { parseAgentCapabilities } from "./ssEgress";
import { isAgentVersionAtLeast } from "./version";

/** 和 agent/gost_api_sync.go 的 gostAPISyncAgentVersion 一致（scripts/check-versions.mjs 会查）。 */
export const GOST_API_SYNC_AGENT_VERSION = "2.2.229";
/** 和 agent/gost_api_sync.go 的 agentCapabilityGostAPISync 一致。 */
export const AGENT_CAPABILITY_GOST_API_SYNC = "gostApiSync";
/** 和 agent/gost_api_sync.go 的 gostAPIDir 一致。 */
export const GOST_API_DIR = "/run/forwardx-agent/gost-api";

export function hostSupportsGostApiSync(host: { agentVersion?: unknown; agentCapabilities?: unknown } | null | undefined) {
  if (!host || !isAgentVersionAtLeast(String(host.agentVersion || ""), GOST_API_SYNC_AGENT_VERSION)) return false;
  return parseAgentCapabilities(host.agentCapabilities).includes(AGENT_CAPABILITY_GOST_API_SYNC);
}
