/*
  同 Token 换机接管（上游 2.3.290 的行为，NEX 自己实现）。

  一个 Token 对应一条主机记录。以前把同一条安装命令在另一台机器上再执行一次，两台 Agent 会拿着
  同一个 Token 轮流上报：配置被来回改写、在线状态和指标来回跳、谁也收不到完整的配置。

  现在每个 Agent 在第一次启动时生成一个安装实例 ID（64 位十六进制，存在配置目录的 installation.json，
  升级、同机重装只要文件还在就不变），每次经 /api/sync 通信都放在加密信封里带上。面板按主机记着
  「当前实例」和「已被接管的实例」：

  - 带着当前实例 ID：正常处理。
  - 带着一个面板没见过的 ID：这是新装的机器 —— 由它接管这条主机记录，原来的实例记进已接管列表。
  - 带着已接管列表里的 ID：这是被换下来的旧机器 —— 回一个它认得的「已被接管」状态，
    它停止同步（保留本机已有的转发，不再上报），只记一次日志。
  - 不带 ID（还没升级的旧 Agent）：主机还没绑定过实例就照旧放行；已经绑定了，说明另一台机器上的
    新 Agent 接管过它，这台旧 Agent 再上报就是在抢 —— 拒绝（旧 Agent 只会当成一次普通失败重试，
    不会动本机转发）。

  这里只放纯函数：判定结果由 server/agentInstallation.ts 落库。
*/

export const AGENT_INSTALLATION_ID_LENGTH = 64;
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
