import { isForwardRuleProtocolTcpEnabled } from "@shared/forwardTypes";
import { isAgentVersionAtLeast } from "@shared/version";

/**
 * 普通端口转发（不走隧道）上的用户连接数 / 单 IP 限制。
 *
 * 以前只有隧道规则会下发 connlimit（见心跳里的 buildAccessLimitCmds，按端口挂在 filter 表）；
 * 普通规则只下发清理命令，于是用户的「单 IP」「连接数」对 iptables / realm / gost …… 这些
 * 最常见的转发完全不起作用。这里按「入口机 + 用户」给出一份完整快照，Agent 在 mangle 表上
 * 对齐（agent/port_access_limits.go）：
 *   - 每个用户一条计数链，规则增删只改分发，不清零已在计数的连接；
 *   - 只看新建的 SYN，不碰已建立的连接，也不重启任何转发进程；
 *   - 空快照 = 删掉全部限制，删规则 / 改回不限都靠它收尾。
 *
 * 需要 Agent 2.2.229：老 Agent 不认这个动作，面板不给它发（行为和以前一样：普通规则不限）。
 */
export const PORT_ACCESS_LIMIT_AGENT_VERSION = "2.2.229";
export const PORT_ACCESS_LIMIT_FORWARD_TYPE = "port-access-limit-sync";

export type PortAccessLimitSpec = {
  userId: number;
  maxIPs: number;
  maxConnections: number;
  ports: number[];
};

type UserAccessLimits = { maxIPs?: number; maxConnections?: number };

function nonNegativeInt(value: unknown) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * 这次改用户限制，是不是**只**动了单 IP / 连接数。
 *
 * 是的话普通规则不必重新下发（它们的限制由上面那份快照单独对齐，转发进程不用动）；
 * 只有隧道规则还要按老路刷新，因为隧道的限制仍然写在它自己的下发命令里。
 */
export function onlyPortAccessLimitChanged(before: any, after: any) {
  if (!before || !after) return false;
  const limitChanged = ["maxIPs", "maxConnections"].some((key) => nonNegativeInt(before[key]) !== nonNegativeInt(after[key]));
  if (!limitChanged) return false;
  return ["gostRateLimitIn", "gostRateLimitOut", "canAddRules"].every((key) => (
    key === "canAddRules"
      ? !!before[key] === !!after[key]
      : nonNegativeInt(before[key]) === nonNegativeInt(after[key])
  ));
}

/**
 * 调用方只传这台入口机上已启用、已授权的规则。隧道规则、只有 UDP 的规则、端口不合法的
 * 规则和不受限的用户都不进快照。结果与规则顺序无关（端口去重排序），签名才稳定。
 */
export function portAccessLimitSpecs(
  rules: readonly any[],
  limitsForUser: (userId: number) => UserAccessLimits,
): PortAccessLimitSpec[] {
  const users = new Map<number, PortAccessLimitSpec>();
  for (const rule of rules) {
    if (!rule || Number(rule.tunnelId || 0) > 0 || !isForwardRuleProtocolTcpEnabled(rule.protocol)) continue;
    const userId = Number(rule.userId);
    const port = Number(rule.sourcePort);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const limits = limitsForUser(userId);
    const maxIPs = nonNegativeInt(limits?.maxIPs);
    const maxConnections = nonNegativeInt(limits?.maxConnections);
    if (!maxIPs && !maxConnections) continue;
    const spec = users.get(userId) || { userId, maxIPs, maxConnections, ports: [] };
    spec.ports.push(port);
    users.set(userId, spec);
  }
  return [...users.values()]
    .sort((a, b) => a.userId - b.userId)
    .map((spec) => ({ ...spec, ports: [...new Set(spec.ports)].sort((a, b) => a - b) }));
}

export function agentSupportsPortAccessLimits(agentVersion: unknown) {
  return isAgentVersionAtLeast(String(agentVersion || ""), PORT_ACCESS_LIMIT_AGENT_VERSION);
}

/**
 * 心跳里要附带的那条运行时动作；老 Agent 返回 null（不发，也就不会被老 Agent 当成一条
 * 什么都不做的空命令「成功」掉）。新 Agent 即使快照为空也要发：那是在撤销之前的限制。
 */
export function portAccessLimitAction(specs: PortAccessLimitSpec[], supported: boolean) {
  if (!supported) return null;
  return {
    statusType: "runtime",
    ruleId: 0,
    tunnelId: 0,
    op: "apply",
    forwardType: PORT_ACCESS_LIMIT_FORWARD_TYPE,
    sourcePort: 0,
    targetIp: "",
    targetPort: 0,
    protocol: "tcp",
    reportStatus: true,
    // 这条辅助动作不能让「恢复中」一直等它：Agent 那边按期望状态自己核对、自己修。
    knownRunning: true,
    failureMessage: "TCP 端口连接限制同步失败（转发本身不受影响），请检查 iptables / ip6tables 和 Agent 日志",
    portAccessLimits: specs,
    commands: [] as string[],
  };
}
