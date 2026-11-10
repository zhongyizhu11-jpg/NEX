/*
  API 令牌能调什么（#9）。单独一个不带依赖的文件：server/_core/trpc.ts 的中间件要引用它，
  不能顺带把整个数据库层拖进 tRPC 的核心模块。
*/
import { apiTokenModuleOfPath, apiTokenModulesAllowPath, apiTokenModulesLabel, API_TOKEN_MODULE_LABELS, type ApiTokenModule } from "../../shared/apiTokenModules";

export type ApiTokenScope = "read" | "full";

export type ApiTokenContext = {
  id: number;
  scope: ApiTokenScope;
  name: string;
  /** 只能碰这几个模块（shared/apiTokenModules.ts）；null / 不给 = 不限。 */
  modules?: ApiTokenModule[] | null;
};

export const API_TOKEN_READ_ONLY_MESSAGE = "这个 API 令牌是只读的，不能执行修改操作";
export const API_TOKEN_FORBIDDEN_MESSAGE = "API 令牌不能做账号和面板的高危操作（令牌、密码、双重验证、登录绑定、备份迁移、插件安装等），请在网页上操作";

export function normalizeApiTokenScope(value: unknown): ApiTokenScope {
  return value === "full" ? "full" : "read";
}

/*
  令牌碰不到的过程：整个 ops.apiTokens / passkeys / sessions 路由，
  以及 auth 里改密码、开关 2FA 的几个过程。管理员给别人重置密码、摘掉 2FA 也算在内 ——
  泄露的管理员令牌不该能顺手接管任何一个账号，也不该能给自己再签一枚令牌续命。

  后来补上的几类（都是「拿走账号」或「拿走整个面板」的路）：
  · 安装向导整个 setup.*：装好以后本来就锁着，令牌更不该碰；
  · Telegram 绑定 / 解绑和机器人登录：绑上自己的 Telegram 就能用机器人登录拿到浏览器会话；
  · Google / Discord 设初始密码、解绑：给没设密码的账号设密码再解绑，能把主人锁在外面；
  · 面板备份导出导入、迁移码、面板迁移、切换数据库：整库带走（含 Agent 令牌和 2FA 密钥）或改写用户表；
  · 面板 SSL 私钥查看：私钥只给网页上的管理员；
  · 插件安装、更新、授予信任、执行动作：插件能在所有 Agent 上以 root 跑脚本；
  · 离站备份整个路由：能把整库备份发到别处，也能从备份恢复；
  · 改接口限流：被限流的令牌不能自己把限流关掉；
  · 操作审计整个路由：审计记着所有人的 IP 和参数，令牌既不该能读走，也不该能把保留天数改短、借每天的清理删掉记录。
  · 面板性能剖析整个路由：堆快照就是面板进程内存的原样拷贝（会话、密码、密钥都在里面），下载路由也只认网页会话。
  auth.updateProfile 改邮箱在过程里单独拦（见 apiTokenProfileUpdateError）：只改昵称这类不受影响。
*/
const TOKEN_FORBIDDEN_PATHS = [
  "ops.apiTokens.",
  "ops.passkeys.",
  "ops.sessions.",
  "ops.offsiteBackup.",
  "ops.audit.",
  "ops.profiling.",
  "setup.",
  "auth.changePassword",
  "auth.beginTwoFactorSetup",
  "auth.enableTwoFactor",
  "auth.disableTwoFactor",
  "users.resetPassword",
  "users.removeTwoFactor",
  "telegram.createBindCode",
  "telegram.unbind",
  "telegram.startMobileLogin",
  "telegram.mobileLoginStatus",
  "telegram.login",
  "telegram.loginWithWidget",
  "telegram.loginWithWebApp",
  "googleAuth.setInitialPassword",
  "googleAuth.unlink",
  "discordAuth.setInitialPassword",
  "discordAuth.unlink",
  "system.exportPanelBackup",
  "system.importPanelBackup",
  "system.createMigrationCode",
  "system.getMigrationCode",
  "system.approveMigrationRequest",
  "system.startPanelMigration",
  "system.testDatabaseSwitchTarget",
  "system.startDatabaseSwitch",
  "system.revealPanelSslKey",
  "plugins.installFromStore",
  "plugins.installFromGithub",
  "plugins.installFromUpload",
  "plugins.updateFromGithub",
  "plugins.setTrusted",
  "plugins.runAction",
  // 令牌不能给自己（和别的令牌）解除接口限流
  "ops.apiRateLimit.update",
  // 商城对接页上的「生成对接令牌」：和 ops.apiTokens. 一样，令牌不能再签令牌
  "shopSync.createToken",
];

/** 测试和 MCP 自检用：当前禁止名单（只读副本）。 */
export function apiTokenForbiddenPaths(): readonly string[] {
  return [...TOKEN_FORBIDDEN_PATHS];
}

/** 令牌勾了模块、而这个过程不在里面时的说明。 */
export function apiTokenModuleDeniedMessage(modules: readonly ApiTokenModule[], path: string) {
  const module = apiTokenModuleOfPath(path);
  const where = module ? `「${API_TOKEN_MODULE_LABELS[module]}」` : "未开放给令牌的部分";
  return `这个 API 令牌只能访问：${apiTokenModulesLabel(modules)}；${path} 属于${where}`;
}

/**
 * 这枚令牌能不能调这个过程。能返回 null，不能返回给人看的原因。
 * 顺序：高危禁止名单 → 模块范围 → 只读。禁止名单永远最先，勾了哪个模块都绕不过去。
 */
export function apiTokenPolicyError(scope: ApiTokenScope, path: string, type: string, modules?: readonly ApiTokenModule[] | null): string | null {
  const normalizedPath = String(path || "");
  // 以 . 结尾的是整个路由，否则是单个过程。
  if (TOKEN_FORBIDDEN_PATHS.some((rule) => (rule.endsWith(".") ? normalizedPath.startsWith(rule) : normalizedPath === rule))) {
    return API_TOKEN_FORBIDDEN_MESSAGE;
  }
  if (modules && modules.length > 0 && !apiTokenModulesAllowPath(modules, normalizedPath)) {
    return apiTokenModuleDeniedMessage(modules, normalizedPath);
  }
  if (scope !== "full" && type !== "query") return API_TOKEN_READ_ONLY_MESSAGE;
  return null;
}

/**
 * auth.updateProfile 用令牌改邮箱：邮箱是找回密码、通知和第三方登录对得上号的依据，
 * 改了它等于换了账号的主人。只改昵称、备注这类照常放行。
 */
export function apiTokenProfileUpdateError(
  apiToken: { scope: ApiTokenScope } | null | undefined,
  input: { email?: string | null },
  currentEmail: string | null | undefined,
): string | null {
  if (!apiToken || input.email === undefined) return null;
  const next = String(input.email || "").trim().toLowerCase();
  const current = String(currentEmail || "").trim().toLowerCase();
  return next === current ? null : API_TOKEN_FORBIDDEN_MESSAGE;
}
