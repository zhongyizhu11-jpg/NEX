import crypto from "crypto";
import { hashNormalizedConfig, normalizeConfigForHash } from "./configAudit";

/*
  下发那一步用到的签名 / 摘要（纯函数）：判断这批动作和上次一样不一样、给每条动作补 configHash、
  算整批期望状态的摘要。从 server/agentHeartbeatRoute.ts 里原样搬出来，结果逐字节相同。
*/

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
    failover: action?.failover || null,
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
  整批期望状态的摘要 = hashConfig(去掉 issuedAt / configHash 的动作数组)。
  hashConfig 对数组就是逐项规整再 JSON 拼接，而规整是逐键独立的，所以「先规整整条动作、
  再去掉这两个键」和「先去掉再规整」得到同一个对象。心跳里每条动作算 configHash 时已经
  规整过一次，把去键后的 JSON 片段记在 normalizedPieces 里，这里直接拼，不再整批重新规整；
  没给片段（或动作不在里面）时就地规整，结果逐字节相同。
*/
export function desiredStateActionPiece(normalizedAction: any) {
  const { issuedAt: _issuedAt, configHash: _configHash, ...stableAction } = normalizedAction || {};
  return JSON.stringify(stableAction);
}

// 给一条动作补上 configHash（= hashConfig(action)），顺手把它去键后的规整片段记进 pieces。
export function withDesiredStateConfigHash<T extends object>(action: T, pieces: WeakMap<object, string>) {
  const hashInput = normalizeConfigForHash(action);
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
    hash.update(cached ?? desiredStateActionPiece(normalizeConfigForHash(action)));
  });
  hash.update("]");
  return hash.digest("hex");
}
