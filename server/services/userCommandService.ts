import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";
import { refreshUserForwardEndpoints } from "../routers/helpers";
import { withTrafficBillingUserLock } from "../keyedTaskLock";
import type { ForwardAccessPauseReason } from "../repositories/userRepository";

type CommandActor = { id: number; role?: string };

async function requireTargetUser(userId: number) {
  const target = await db.getUserById(userId);
  if (!target) throw new Error("用户不存在");
  return target;
}

async function recoverForwardAccess(userId: number, reasonPrefix: string) {
  const recovery = await db.recoverUserForwardAccessIfEligible(userId);
  if (recovery.restored) {
    await refreshUserForwardEndpoints(userId, `${reasonPrefix}-forward-restored`);
  } else if (recovery.reason === "traffic_billing_balance") {
    await refreshUserForwardEndpoints(userId, `${reasonPrefix}-forward-paused`);
  }
  return recovery;
}

export async function setUserBalanceCommand(input: {
  actor: CommandActor;
  targetUserId: number;
  balanceCents: number;
  description: string;
  reasonPrefix?: string;
}) {
  await requireTargetUser(input.targetUserId);
  const result = await db.setUserBalance(input.targetUserId, input.balanceCents, {
    type: "admin_adjust",
    description: input.description,
    operatorUserId: input.actor.id,
  } as any);
  const recovery = await recoverForwardAccess(input.targetUserId, input.reasonPrefix || "balance-adjusted");
  appendPanelLog("info", `[UserCommand] action=balance.set actor=${input.actor.id} target=${input.targetUserId} balance=${input.balanceCents} delta=${result.amountCents}`);
  return { ...result, forwardAccessRestored: recovery.restored };
}

export async function adjustUserBalanceCommand(input: {
  actor: CommandActor;
  targetUserId: number;
  amountCents: number;
  description: string;
  reasonPrefix?: string;
}) {
  await requireTargetUser(input.targetUserId);
  const result = await db.addUserBalance(input.targetUserId, input.amountCents, {
    type: input.amountCents > 0 ? "admin_recharge" : "admin_adjust",
    description: input.description,
    operatorUserId: input.actor.id,
  } as any);
  const recovery = await recoverForwardAccess(input.targetUserId, input.reasonPrefix || "balance-adjusted");
  appendPanelLog("info", `[UserCommand] action=balance.adjust actor=${input.actor.id} target=${input.targetUserId} amount=${input.amountCents}`);
  return { ...result, forwardAccessRestored: recovery.restored };
}

export async function setUserAccountEnabledCommand(input: {
  actor: CommandActor;
  targetUserId: number;
  enabled: boolean;
  reasonPrefix?: string;
}) {
  if (!input.enabled && input.targetUserId === input.actor.id) throw new Error("不能禁用当前登录账户");
  const target = await requireTargetUser(input.targetUserId);
  if (!input.enabled && String(target.role) === "admin") throw new Error("不能禁用管理员账户");
  await db.setUserAccountEnabled(input.targetUserId, input.enabled);
  let forwardAccessRestored = false;
  const prefix = input.reasonPrefix || "user-account";
  if (!input.enabled) {
    await refreshUserForwardEndpoints(input.targetUserId, `${prefix}-disabled`);
  } else {
    const recovery = await recoverForwardAccess(input.targetUserId, `${prefix}-enabled`);
    forwardAccessRestored = recovery.restored;
  }
  appendPanelLog("info", `[UserCommand] action=account.${input.enabled ? "enable" : "disable"} actor=${input.actor.id} target=${input.targetUserId}`);
  return { target, forwardAccessRestored };
}

export async function setUserForwardAccessCommand(input: {
  actor: CommandActor;
  targetUserId: number;
  enabled: boolean;
  reasonPrefix?: string;
}) {
  const target = await requireTargetUser(input.targetUserId);
  if (String(target.role) === "admin") throw new Error("管理员默认拥有全部转发权限");
  await db.updateUserManualEntitlements(input.targetUserId, {
    manualCanAddRules: input.enabled,
    manualAllowForwardXTunnel: input.enabled,
    forwardAccessPauseReason: input.enabled ? null : "manual",
  });
  if (!input.enabled) await db.disableAllUserRules(input.targetUserId);
  await refreshUserForwardEndpoints(input.targetUserId, `${input.reasonPrefix || "user-forward"}-${input.enabled ? "enabled" : "disabled"}`);
  /*
    交出**真的落成了什么**，不是请求的那个值。

    上面写下的是管理员的意图（manualCanAddRules），随后重算生效值 —— 用户超额时
    生效值仍然是关。原来这里只返回 `{ target }`，路由回一个写死的 `{ success: true }`，
    客户端就拿自己刚发出去的值去 patch 缓存并弹「用户转发已开启」：toast 说开了，
    开关还是灰的，刷新一次原样。管理员以为开好了，租户那边一条转发都跑不起来。

    意图**不回滚**：额度一放开就该自动生效，那正是 manual 那一列存在的意义。
    所以这里只是如实汇报，不是把写进去的东西撤掉。
  */
  const after = await db.getUserById(input.targetUserId);
  const canAddRules = !!(after as any)?.canAddRules;
  const pauseReason = ((after as any)?.forwardAccessPauseReason ?? null) as ForwardAccessPauseReason;
  appendPanelLog(
    "info",
    `[UserCommand] action=forward.${input.enabled ? "enable" : "disable"} actor=${input.actor.id} target=${input.targetUserId} effective=${canAddRules}${canAddRules === input.enabled ? "" : ` blockedBy=${pauseReason || "unknown"}`}`,
  );
  return { target, canAddRules, pauseReason };
}

export async function resetUserTrafficCommand(input: {
  actor: CommandActor;
  targetUserId: number;
  reasonPrefix?: string;
}) {
  const target = await requireTargetUser(input.targetUserId);
  // Serialize manual resets with agent billing reports. Scheduled package-only
  // resets continue to call resetUserTraffic directly.
  await withTrafficBillingUserLock(input.targetUserId, () =>
    db.resetUserTrafficAndBillingUsage(input.targetUserId)
  );
  const recovery = await recoverForwardAccess(input.targetUserId, input.reasonPrefix || "user-traffic-reset");
  appendPanelLog("info", `[UserCommand] action=traffic.reset actor=${input.actor.id} target=${input.targetUserId}`);
  return { target, forwardAccessRestored: recovery.restored };
}

export async function renewUserCommand(input: {
  actor: CommandActor;
  targetUserId: number;
  expiresAt: Date;
  reasonPrefix?: string;
}) {
  if (!Number.isFinite(input.expiresAt.getTime())) throw new Error("续期时间超出允许范围");
  const target = await requireTargetUser(input.targetUserId);
  // expiresAt is derived from manual + subscription entitlements. Updating
  // only the derived field is immediately undone by the recovery sync.
  await db.updateUserManualEntitlements(input.targetUserId, { manualExpiresAt: input.expiresAt });
  const recovery = await recoverForwardAccess(input.targetUserId, input.reasonPrefix || "user-renewed");
  const updated = await requireTargetUser(input.targetUserId);
  if (!updated.expiresAt || new Date(updated.expiresAt).getTime() < input.expiresAt.getTime() - 1000) {
    throw new Error("续期结果与请求不一致，请核实用户有效期");
  }
  appendPanelLog("info", `[UserCommand] action=user.renew actor=${input.actor.id} target=${input.targetUserId} expiresAt=${input.expiresAt.toISOString()}`);
  return { target, forwardAccessRestored: recovery.restored };
}
