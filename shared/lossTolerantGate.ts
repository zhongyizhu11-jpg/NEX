import { isAgentVersionAtLeast } from "./version";

/*
  抗丢包传输（KCP + 纠错）是严格模式：入口拨 UDP，出口 / 中转拒收 TCP 会话。
  隧道上任何一台的 Agent 或 FXP 还是旧的，这条隧道不是「退回 TCP」，而是直接不通。
  所以保存时就拦下，写清是哪台、差在哪，而不是等用户发现流量断了再去翻 FXP 日志。
  这两个版本是第一版带这个功能的 Agent / FXP，以后升版本号不用跟着改。
*/
export const LOSS_TOLERANT_MIN_AGENT_VERSION = "2.2.254";
export const LOSS_TOLERANT_MIN_FXP_VERSION = "2.2.140";

export type LossTolerantHost = {
  id: number;
  name?: string | null;
  agentVersion?: string | null;
  fxpVersion?: string | null;
};

export type LossTolerantBlocker = {
  hostId: number;
  name: string;
  /** 缺什么：Agent、FXP，或两样都缺。 */
  missing: Array<"agent" | "fxp">;
};

export function lossTolerantBlockers(hosts: Array<LossTolerantHost | null | undefined>, hostIds: number[]): LossTolerantBlocker[] {
  const byId = new Map(hosts.filter((host): host is LossTolerantHost => !!host).map((host) => [Number(host.id), host]));
  const blockers: LossTolerantBlocker[] = [];
  for (const id of Array.from(new Set(hostIds))) {
    const host = byId.get(id);
    const missing: Array<"agent" | "fxp"> = [];
    if (!isAgentVersionAtLeast(host?.agentVersion, LOSS_TOLERANT_MIN_AGENT_VERSION)) missing.push("agent");
    if (!isAgentVersionAtLeast(host?.fxpVersion, LOSS_TOLERANT_MIN_FXP_VERSION)) missing.push("fxp");
    if (missing.length > 0) blockers.push({ hostId: id, name: String(host?.name || `#${id}`), missing });
  }
  return blockers;
}

export function lossTolerantBlockerMessage(blockers: LossTolerantBlocker[]) {
  const parts = blockers.slice(0, 4).map((blocker) => {
    const what = blocker.missing.map((item) => (item === "agent" ? `Agent ${LOSS_TOLERANT_MIN_AGENT_VERSION}` : `FXP ${LOSS_TOLERANT_MIN_FXP_VERSION}`)).join("、");
    return `${blocker.name}（要 ${what} 以上）`;
  });
  const more = blockers.length > 4 ? ` 等 ${blockers.length} 台` : "";
  return `抗丢包传输要隧道上每台机器都升级：${parts.join("，")}${more}。先升级这些主机再打开。`;
}
