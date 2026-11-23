
/** 已接管实例最多记几个：够覆盖反复换机，又不会让一行越写越大。 */
export const AGENT_RETIRED_INSTALLATION_LIMIT = 16;

/** Agent 回包里认得的标记：带着它的 409 表示「你已经被另一台机器接管了」。 */
export const AGENT_SUPERSEDED_FIELD = "agentSuperseded";

export function normalizeAgentInstallationId(value: unknown): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-f0-9]{64}$/.test(text) ? text : "";
}

export function parseRetiredInstallationIds(raw: unknown): string[] {
  let values: unknown = raw;
  if (typeof raw === "string") {
    try {
      values = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    const id = normalizeAgentInstallationId(value);
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(-AGENT_RETIRED_INSTALLATION_LIMIT);
}

export type AgentInstallationState = {
  current: string;
  retired: readonly string[];
};

export type AgentInstallationDecision =
  /** 照常处理（同一个实例，或者主机还没绑定过、来的是旧 Agent）。 */
  | { kind: "accept" }
  /** 第一次登记实例（主机原来没有绑定）。 */
  | { kind: "bind"; next: AgentInstallationState }
  /** 新机器接管：原来的实例进已接管列表。 */
  | { kind: "takeover"; previous: string; next: AgentInstallationState }
  /** 被接管下来的旧实例：回「已被接管」，它停止同步。 */
  | { kind: "superseded" }
  /** 主机已经绑定了实例，来的却是不带 ID 的旧 Agent：拒绝，防止它和新机器抢。 */
  | { kind: "legacy-rejected" };

export function decideAgentInstallation(state: AgentInstallationState, presentedRaw: unknown): AgentInstallationDecision {
  const current = normalizeAgentInstallationId(state.current);
  const retired = parseRetiredInstallationIds([...state.retired]);
  const presented = normalizeAgentInstallationId(presentedRaw);
  if (!presented) return current ? { kind: "legacy-rejected" } : { kind: "accept" };
  if (presented === current) return { kind: "accept" };
  // 先看已接管列表：被换下来的机器重启后再来，不能借「没见过」又把主机抢回去。
  if (retired.includes(presented)) return { kind: "superseded" };
  if (!current) return { kind: "bind", next: { current: presented, retired } };
  const nextRetired = [...retired.filter((id) => id !== current), current].slice(-AGENT_RETIRED_INSTALLATION_LIMIT);
  return { kind: "takeover", previous: current, next: { current: presented, retired: nextRetired } };
}

/** 界面上显示的简短实例号（前 8 位）。 */
export function shortAgentInstallationId(value: unknown) {
  const id = normalizeAgentInstallationId(value);
  return id ? id.slice(0, 8) : "";
}
