/*
  从 server/agentHeartbeatRoute.ts 第 3965-4070 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { appendPanelLog } from "../_core/panelLogger";
import { withDesiredStateConfigHash } from "../agentDesiredStateHash";
import { dropStalePortRemoveActions, resolveActionBatchIssuedAt, ruleRuntimeIdentityKey } from "../agentHeartbeatDispatch";
import { runtimeBool } from "../agentHeartbeatRuntime";
import * as db from "../db";
import { getHostWireGuardPlane, isTunnelRuntimeHostReady } from "../tunnelRuntimeStatus";

export type OrderHeartbeatActionsContext = {
  actions: Array<any>;
  protectedRuleRemoveActionKeys: Set<string>;
  host: any;
  responseIssuedAt: number;
  rules: Array<any>;
  hasReportedRuntimeState: boolean;
  localRuleMatches: any /* 原类型 (rule: any, expectedForwardType: string, port: number) => boolean… 引用了拿不到的 rule，手动收拾 */;
  localTunnelMatches: any /* 原类型 (tunnelId: number, expectedForwardType: string, port: number, options?: { allowP… 引用了拿不到的 expectedForwardType，手动收拾 */;
  tunnelById: Map<any, any>;
  configRevision: number;
  deferActionsForLocalState: any;
  runningRules: any /* 原类型 Array<{ ruleId: number; tunnelId?: number; sourcePort: number; sourcePortEnd?: n… 引用了拿不到的 tunnelId，手动收拾 */;
  addRunningRule: any /* 原类型 (rule: { ruleId: number; tunnelId?: number; sourcePort: number; sourcePortEnd?: … 引用了拿不到的 rule，手动收拾 */;
  recoveryTriggered: boolean;
  previousHost: any;
  agentBootId: string;
  agentProcessId: number;
};

export type OrderHeartbeatActionsResult = {
  activeWorkActions: Array<any>;
  orderedActions: Array<any>;
  desiredStatePieceByAction: WeakMap<object, string>;
  actionBatchIssuedAt: number;
  recoveryWasInProgress: boolean;
};

export async function orderHeartbeatActions(ctx: OrderHeartbeatActionsContext): Promise<OrderHeartbeatActionsResult> {
  const { actions, protectedRuleRemoveActionKeys, host, responseIssuedAt, rules, hasReportedRuntimeState, localRuleMatches, localTunnelMatches, tunnelById, configRevision, deferActionsForLocalState, runningRules, addRunningRule, recoveryTriggered, previousHost, agentBootId, agentProcessId } = ctx;
  const effectiveActions = dropStalePortRemoveActions(actions, protectedRuleRemoveActionKeys);
  const actionBatchIssuedAt = resolveActionBatchIssuedAt(Number(host.id), effectiveActions, responseIssuedAt);
  const ruleByIdForDesired = new Map((rules as any[]).map((rule: any) => [Number(rule.id), rule]));
  const desiredKnownRunning = (action: any) => {
    if (action?.op === "remove") return true;
    /*
      V2 隧道的 WireGuard 运行时动作：本机报上来的 localState 里有这条隧道的数据面（kernel / netstack），
      就是已经在跑。原来所有 runtime 动作一律算「没在跑」，于是每台 V2 隧道两端的主机：
        - 每次心跳都有待办，永远走不上稳定快路径，每次都整份重算期望状态；
        - 期望状态每 60 秒整份重发一遍；
        - 重连后的恢复进度永远差一条（「恢复中 23/24」），每次心跳还要写一次库。
      配置变了动作内容就变，照样立刻下发（shouldSendDesiredState 比的是不含 knownRunning 的签名）；
      Agent 对 runtime 动作不看 knownRunning，按自己的记录决定要不要重做，所以这里改成 true 不影响下发。
    */
    if (action?.statusType === "runtime") {
      return action?.op === "apply"
        && String(action?.forwardType || "") === "forwardx-wireguard"
        && hasReportedRuntimeState
        && Number(action?.tunnelId || 0) > 0
        && !!getHostWireGuardPlane(Number(action.tunnelId), Number(host.id));
    }
    const ruleId = Number(action?.ruleId || 0);
    if (ruleId > 0) {
      const rule = ruleByIdForDesired.get(ruleId) as any;
      const sourcePort = Number(action?.sourcePort || 0);
      if (rule && hasReportedRuntimeState && sourcePort > 0) {
        return localRuleMatches(rule, String(action?.forwardType || rule.forwardType || ""), sourcePort);
      }
      return runtimeBool(rule?.isRunning);
    }
    const tunnelId = Number(action?.tunnelId || 0);
    if (tunnelId > 0) {
      const sourcePort = Number(action?.sourcePort || 0);
      if (hasReportedRuntimeState && sourcePort > 0) {
        return localTunnelMatches(tunnelId, String(action?.forwardType || ""), sourcePort);
      }
      const tunnel = tunnelById.get(tunnelId) as any;
      return runtimeBool(tunnel?.isRunning) || isTunnelRuntimeHostReady(tunnelId, Number(host.id));
    }
    return false;
  };
  // 每条动作只规整一次：同一份结果既出 configHash，又留给下面的 desiredStateHash 拼接。
  const desiredStatePieceByAction = new WeakMap<object, string>();
  const normalizedActions = effectiveActions.map((action: any) => {
    const statusType = action.statusType || (Number(action.ruleId) > 0 ? "rule" : (Number(action.tunnelId) > 0 ? "tunnel" : undefined));
    const normalized = {
      ...action,
      issuedAt: Number(action.issuedAt) || actionBatchIssuedAt,
      configRevision,
      knownRunning: typeof action.knownRunning === "boolean" ? action.knownRunning : desiredKnownRunning(action),
      statusType,
      // A tunnel apply can be fully adopted by the Agent's persisted local
      // runtime record. Ask it to report that adoption so a panel restart or
      // a cleared in-memory runtime map becomes ready without restarting the
      // healthy listener.
      ...(statusType === "tunnel" && action.op === "apply" && action.reportStatus === undefined
        ? { reportStatus: true }
        : {}),
    };
    return withDesiredStateConfigHash(normalized, desiredStatePieceByAction);
  });
  if (!deferActionsForLocalState) {
    const runningRuleKeys = new Set(runningRules.map((rule: any) => ruleRuntimeIdentityKey(rule.ruleId, rule.sourcePort, rule.protocol)));
    for (const action of normalizedActions) {
      if (action.op !== "apply" || !Number(action.ruleId) || !Number(action.sourcePort)) continue;
      const key = ruleRuntimeIdentityKey(action.ruleId, action.sourcePort, action.protocol);
      if (runningRuleKeys.has(key)) continue;
      addRunningRule({
        ruleId: Number(action.ruleId),
        tunnelId: Number(action.tunnelId || 0) || undefined,
        sourcePort: Number(action.sourcePort),
        ...(Number(action.sourcePortEnd || 0) > Number(action.sourcePort) ? { sourcePortEnd: Number(action.sourcePortEnd) } : {}),
        targetIp: String(action.targetIp || ""),
        targetPort: Number(action.targetPort || 0),
        protocol: action.protocol || "tcp",
        forwardType: action.forwardType || "unknown",
        failover: action.failover,
      });
      runningRuleKeys.add(key);
    }
  }
  const actionRank = (action: any) => (
    action.statusType === "runtime" ? 0 : action.op === "apply" ? 1 : 2
  );
  const orderedActions = normalizedActions.slice().sort((a: any, b: any) => actionRank(a) - actionRank(b));
  const activeWorkActions = deferActionsForLocalState
    ? []
    : orderedActions.filter((action: any) => action.op === "remove" || !action.knownRunning);
  const recoveryWasInProgress = recoveryTriggered
    || (!!previousHost.agentRecoveryStartedAt && !previousHost.agentRecoveryCompletedAt);
  if (recoveryWasInProgress) {
    const currentApplyCount = activeWorkActions.filter((action: any) => action.op === "apply").length;
    const expected = recoveryTriggered
      ? orderedActions.filter((action: any) => action.op === "apply").length
      : Math.max(Number(previousHost.agentRecoveryExpected || 0), currentApplyCount);
    const ready = Math.max(0, expected - currentApplyCount);
    const completed = !deferActionsForLocalState && currentApplyCount === 0;
    await db.updateHostHeartbeat(host.id, {
      agentRecoveryExpected: expected,
      agentRecoveryReady: completed ? expected : ready,
      ...(completed ? { agentRecoveryCompletedAt: new Date() } : {}),
    } as any);
    if (completed && !previousHost.agentRecoveryCompletedAt) {
      appendPanelLog("info", `[AgentRecovery] host=${host.id} complete ready=${expected}/${expected} bootId=${agentBootId || "-"} pid=${agentProcessId || "-"}`);
    }
  }
  return { activeWorkActions, orderedActions, desiredStatePieceByAction, actionBatchIssuedAt, recoveryWasInProgress };
}
