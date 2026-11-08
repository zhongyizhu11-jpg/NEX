import crypto from "crypto";
import { hashNormalizedConfig, normalizeConfigForHash } from "./configAudit";

/*
  下发那一步用到的签名 / 摘要（纯函数）：判断这批动作和上次一样不一样、给每条动作补 configHash、
  算整批期望状态的摘要。从 server/agentHeartbeatRoute.ts 里原样搬出来，结果逐字节相同。
*/

/*
  线路组规格（action.failover）里的运行时提示：中转异常（down / downReason）、下游延迟（extraLatencyMs）、
  沿途负载（loadPct）、出口 IP（exitIp）。面板每一轮都可能换一次；Agent 那边算签名时也去掉它们
  （agent/route_group.go 的 stripFailoverRelayHints / failoverSpecSignatureJSON），由 runningRules 同步原地换上
  （它们本来就跟着 runningRules 走，每次心跳 Agent 都按它同步一遍调度代理）。

  这里比「动作变没变」、算 configHash 和整批期望状态摘要时同样去掉：只是提示变了，不重发整份期望状态、不写
  「下发」审计；Agent 报上来的已执行摘要也一直对得上，不会被当成落后、反复重发，稳定快路径也不会因此失效。
  没带提示的动作原样返回（同一个对象），摘要和以前逐字节相同。
*/
const FAILOVER_RUNTIME_HINT_KEYS = ["down", "downReason", "extraLatencyMs", "loadPct", "exitIp"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function targetWithoutRuntimeHints(target: unknown): unknown {
  if (!isPlainRecord(target) || !FAILOVER_RUNTIME_HINT_KEYS.some((key) => key in target)) return target;
  const stripped: Record<string, unknown> = { ...target };
  for (const key of FAILOVER_RUNTIME_HINT_KEYS) delete stripped[key];
  return stripped;
}

export function failoverWithoutRuntimeHints<T>(failover: T): T {
  if (!isPlainRecord(failover) || !Array.isArray(failover.targets)) return failover;
  const targets: unknown[] = failover.targets;
  const strippedTargets = targets.map(targetWithoutRuntimeHints);
  if (strippedTargets.every((target, index) => target === targets[index])) return failover;
  return { ...failover, targets: strippedTargets } as T;
}

// 算摘要用的动作：线路组规格去掉运行时提示，别的原样（没变就是同一个对象）。
function actionWithoutRuntimeHints<T>(action: T): T {
  if (!isPlainRecord(action) || !action.failover) return action;
  const stripped = failoverWithoutRuntimeHints(action.failover);
  return stripped === action.failover ? action : ({ ...action, failover: stripped } as T);
}

export function stableActionSignature(actions: any[]) {
  return JSON.stringify(actions.map((action: any) => ({
    op: action?.op || "",
    statusType: action?.statusType || "",
    ruleId: Number(action?.ruleId || 0),
    tunnelId: Number(action?.tunnelId || 0),
    pluginId: String(action?.pluginId || ""),
    forwardType: action?.forwardType || "",
    sourcePort: Number(action?.sourcePort || 0),
    targetIp: String(action?.targetIp || ""),
    targetPort: Number(action?.targetPort || 0),
    protocol: action?.protocol || "",
    commands: action?.commands || [],
    removalCommands: action?.removalCommands || [],
    removalToken: action?.removalToken || "",
    managedConfigs: action?.managedConfigs || [],
    portAccessLimits: action?.portAccessLimits || [],
    rollbackCommands: action?.rollbackCommands || [],
    preCommands: action?.preCommands || [],
    postCommands: action?.postCommands || [],
    serviceName: action?.serviceName || action?.svcName || "",
    serviceNameExtra: action?.serviceNameExtra || "",
    unit: action?.unit || "",
    unitExtra: action?.unitExtra || "",
    fxp: action?.fxp || null,
    wireGuard: action?.wireGuard || null,
    failover: failoverWithoutRuntimeHints(action?.failover) || null,
    forceRuntimeSync: action?.forceRuntimeSync === true,
    requiresMimicEnvironment: action?.requiresMimicEnvironment === true,
  })));
}

/*
  下发缓存（批次签发时间、期望状态是否要重发、运行时同步动作）只需要判断「和上次一样不一样」，
  不需要签名原文。原文是整批动作连同全部命令、托管配置的 JSON，一台机器几十上百 KB，
  乘上几千台机器常驻在内存里；这里只存它的 sha256，比较结果不变。
*/
export function stableActionSignatureHash(actions: any[], prefix = "") {
  return crypto.createHash("sha256").update(prefix).update(stableActionSignature(actions)).digest("hex");
}


/*
  整批期望状态的摘要 = hashConfig(去掉 issuedAt / configHash、线路组规格去掉运行时提示的动作数组)。
  hashConfig 对数组就是逐项规整再 JSON 拼接，而规整是逐键独立的，所以「先规整整条动作、
  再去掉这两个键」和「先去掉再规整」得到同一个对象。心跳里每条动作算 configHash 时已经
  规整过一次，把去键后的 JSON 片段记在 normalizedPieces 里，这里直接拼，不再整批重新规整；
  没给片段（或动作不在里面）时就地规整，结果逐字节相同。
*/
export function desiredStateActionPiece(normalizedAction: any) {
  const { issuedAt: _issuedAt, configHash: _configHash, ...stableAction } = normalizedAction || {};
  return JSON.stringify(stableAction);
}

// 给一条动作补上 configHash（= hashConfig(去掉运行时提示的 action)），顺手把它去键后的规整片段记进 pieces。
export function withDesiredStateConfigHash<T extends object>(action: T, pieces: WeakMap<object, string>) {
  const hashInput = normalizeConfigForHash(actionWithoutRuntimeHints(action));
  const hashedAction = { ...action, configHash: hashNormalizedConfig(hashInput) };
  pieces.set(hashedAction, desiredStateActionPiece(hashInput));
  return hashedAction;
}

export function stableDesiredStateHash(actions: any[], normalizedPieces?: WeakMap<object, string>) {
  const hash = crypto.createHash("sha256");
  hash.update("[");
  actions.forEach((action: any, index: number) => {
    if (index > 0) hash.update(",");
    const cached = action && typeof action === "object" ? normalizedPieces?.get(action) : undefined;
    hash.update(cached ?? desiredStateActionPiece(normalizeConfigForHash(actionWithoutRuntimeHints(action))));
  });
  hash.update("]");
  return hash.digest("hex");
}
