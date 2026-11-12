/*
  Agent 的发行来源：这台机器上跑的是 NEX 发的 Agent，还是原版 ForwardX（poouo/Forwardx）发的。

  为什么要单独认：两边的 Agent 版本号是同一条线往上数的（都是 2.2.x），只看版本号分不出来 ——
  原版以后发到 2.2.300，NEX 面板会以为它比自己的 2.2.256 还新，永远不让它换成 NEX 的 Agent。
  所以从这一版起 NEX 的 Agent 每次心跳都报 agentDistribution: "nex"（agent/distribution.go）。

  没报这个字段的 Agent：
  - 2.3.477 以后、这一版以前的 NEX Agent：每次心跳都带 agentCapabilities / runtimeVersion
    （agent/gost_runtime_version.go），原版 ForwardX 的 Agent 从来不报这两项 —— 认成 NEX；
  - 都没有、但这次心跳带了 agentVersion（完整心跳）：只有从原版 ForwardX 迁过来的面板
    （unknownAsForwardx，见 server/forwardxAgentMigration.ts）才认成原版 —— 一直是 NEX 的面板上，
    这种多半是更老的 NEX Agent，不能给它贴上「原版」的标签；
  - 什么都没带（精简心跳）：这一次认不出来，保留库里上次的结论。
*/
export const NEX_AGENT_DISTRIBUTION = "nex" as const;
export const FORWARDX_AGENT_DISTRIBUTION = "forwardx" as const;

export type AgentDistribution = typeof NEX_AGENT_DISTRIBUTION | typeof FORWARDX_AGENT_DISTRIBUTION;

const KNOWN: ReadonlySet<string> = new Set([NEX_AGENT_DISTRIBUTION, FORWARDX_AGENT_DISTRIBUTION]);

/** 库里 / 请求里的值规范成已知的两种，认不出的回 null。 */
export function normalizeAgentDistribution(value: unknown): AgentDistribution | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "forwardplus") return FORWARDX_AGENT_DISTRIBUTION; // 别的二开发行版：对 NEX 来说都不是自己的
  return KNOWN.has(text) ? (text as AgentDistribution) : null;
}

/** 从一次心跳的请求体认发行来源；这一次认不出来回 null（调用方保留旧值）。 */
export function classifyHeartbeatAgentDistribution(
  body: unknown,
  options: { unknownAsForwardx?: boolean } = {},
): AgentDistribution | null {
  if (!body || typeof body !== "object") return null;
  const payload = body as Record<string, unknown>;
  if (payload.agentDistribution !== undefined && payload.agentDistribution !== null && payload.agentDistribution !== "") {
    // 报了但不是 nex（比如别的分支自己起的名字）：一律当外来 Agent
    return normalizeAgentDistribution(payload.agentDistribution) === NEX_AGENT_DISTRIBUTION
      ? NEX_AGENT_DISTRIBUTION
      : FORWARDX_AGENT_DISTRIBUTION;
  }
  if (Array.isArray(payload.agentCapabilities) || payload.runtimeVersion !== undefined) return NEX_AGENT_DISTRIBUTION;
  const version = String(payload.agentVersion ?? "").trim();
  return version && options.unknownAsForwardx ? FORWARDX_AGENT_DISTRIBUTION : null;
}

/** 界面上的说法。没上报过（老数据）当 NEX，不额外提示。 */
export function agentDistributionLabel(value: unknown) {
  return normalizeAgentDistribution(value) === FORWARDX_AGENT_DISTRIBUTION ? "原版 ForwardX" : "NEX";
}
