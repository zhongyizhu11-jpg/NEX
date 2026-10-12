/*
  API 令牌能调什么（#9）。单独一个不带依赖的文件：server/_core/trpc.ts 的中间件要引用它，
  不能顺带把整个数据库层拖进 tRPC 的核心模块。
*/

export type ApiTokenScope = "read" | "full";

export type ApiTokenContext = {
  id: number;
  scope: ApiTokenScope;
  name: string;
};

export const API_TOKEN_READ_ONLY_MESSAGE = "这个 API 令牌是只读的，不能执行修改操作";
export const API_TOKEN_FORBIDDEN_MESSAGE = "API 令牌不能管理令牌、密码、双重验证、通行密钥或登录设备，请在网页上操作";

export function normalizeApiTokenScope(value: unknown): ApiTokenScope {
  return value === "full" ? "full" : "read";
}

/*
  令牌碰不到的过程：整个 ops.apiTokens / passkeys / sessions 路由，
  以及 auth 里改密码、开关 2FA 的几个过程。管理员给别人重置密码、摘掉 2FA 也算在内 ——
  泄露的管理员令牌不该能顺手接管任何一个账号，也不该能给自己再签一枚令牌续命。
*/
const TOKEN_FORBIDDEN_PATHS = [
  "ops.apiTokens.",
  "ops.passkeys.",
  "ops.sessions.",
  "auth.changePassword",
  "auth.beginTwoFactorSetup",
  "auth.enableTwoFactor",
  "auth.disableTwoFactor",
  "users.resetPassword",
  "users.removeTwoFactor",
];

/** 这枚令牌能不能调这个过程。能返回 null，不能返回给人看的原因。 */
export function apiTokenPolicyError(scope: ApiTokenScope, path: string, type: string): string | null {
  const normalizedPath = String(path || "");
  // 以 . 结尾的是整个路由，否则是单个过程。
  if (TOKEN_FORBIDDEN_PATHS.some((rule) => (rule.endsWith(".") ? normalizedPath.startsWith(rule) : normalizedPath === rule))) {
    return API_TOKEN_FORBIDDEN_MESSAGE;
  }
  if (scope !== "full" && type !== "query") return API_TOKEN_READ_ONLY_MESSAGE;
  return null;
}
