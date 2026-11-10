import assert from "node:assert/strict";
import test from "node:test";
import { impersonationPolicyError } from "./impersonationPolicy";
import { apiTokenPolicyError, API_TOKEN_FORBIDDEN_MESSAGE } from "./apiTokenPolicy";
import { IMPERSONATION_BLOCKED_MESSAGE } from "../../shared/userImpersonation";

test("代入用户后台：账号安全、登录绑定、付款类写操作一律拒，查询照常", () => {
  const blocked = [
    "auth.changePassword",
    "auth.updateProfile",
    "auth.beginTwoFactorSetup",
    "auth.enableTwoFactor",
    "auth.disableTwoFactor",
    "auth.login",
    "auth.requestPasswordReset",
    "users.updateAvatar",
    "users.enterUserBackend",
    "ops.passkeys.remove",
    "ops.passkeys.finishRegistration",
    "ops.sessions.revoke",
    "ops.sessions.revokeOthers",
    "ops.apiTokens.create",
    "telegram.createBindCode",
    "telegram.unbind",
    "googleAuth.unlink",
    "discordAuth.setInitialPassword",
    "payment.createOrder",
    "billing.redeem",
    "billing.purchasePlanWithBalance",
    "billing.purchaseTrafficAddonWithBalance",
    "plans.setAutoRenew",
    "setup.createAdmin",
  ];
  for (const path of blocked) assert.equal(impersonationPolicyError(path, "mutation"), IMPERSONATION_BLOCKED_MESSAGE, path);
  // 查询都放行：管理员进来就是为了看
  for (const path of ["auth.me", "ops.sessions.list", "billing.me", "payment.myOrders", "telegram.status"]) {
    assert.equal(impersonationPolicyError(path, "query"), null, path);
  }
  // 放行的写操作：退出代入、算优惠价、普通业务
  for (const path of ["auth.logout", "billing.previewDiscount", "rules.create", "rules.toggle", "tickets.create", "hosts.update", "plans.deleteCancelledSubscription"]) {
    assert.equal(impersonationPolicyError(path, "mutation"), null, path);
  }
  // 前缀相同的别的路由不被误伤
  assert.equal(impersonationPolicyError("authx.something", "mutation"), null);
  assert.equal(impersonationPolicyError("usersExtra.x", "mutation"), null);
});

test("API 令牌调不到进入用户后台，也调不到找回密码", () => {
  for (const path of ["users.enterUserBackend", "auth.requestPasswordReset", "auth.resetPasswordWithToken"]) {
    for (const scope of ["read", "full"] as const) {
      assert.equal(apiTokenPolicyError(scope, path, "mutation"), API_TOKEN_FORBIDDEN_MESSAGE, `${scope} ${path}`);
    }
  }
  assert.equal(apiTokenPolicyError("full", "auth.passwordResetOptions", "query"), null);
});
