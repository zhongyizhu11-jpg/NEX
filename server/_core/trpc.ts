import { ACCOUNT_DISABLED_ERR_MSG, COOKIE_NAME, NOT_ADMIN_ERR_MSG, SESSION_REPLACED_ERR_MSG, UNAUTHED_ERR_MSG } from '../../shared/const';
import { AsyncLocalStorage } from "node:async_hooks";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { getSessionCookieOptions } from "./cookies";
import { runWithConfigAuditContext } from "../configAudit";
import { DATABASE_MAINTENANCE_MESSAGE, isDatabaseMaintenanceActive } from "../databaseMaintenance";
import { formatTrpcErrorShape } from "./errorFormatter";
import { apiTokenPolicyError } from "../ops/apiTokenPolicy";
import { impersonationPolicyError } from "../ops/impersonationPolicy";
import { assertMaintenanceAllows } from "../ops/maintenance";
import { databaseHealth } from "../databaseHealthState";
import { DATABASE_UNAVAILABLE_MESSAGE } from "../../shared/databaseHealth";
import { apiRateLimitMessage, checkApiRateLimit } from "../apiRateLimit";
import { currentApiRateLimitConfig, noteApiRateLimited } from "../apiRateLimitConfig";
import { clientIp } from "../clientIp";
import { auditMutationCall } from "../operationAudit";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter: formatTrpcErrorShape,
});

export const router = t.router;

/**
 * 切换数据库期间拒绝所有写操作（mutation），查询照常 —— 管理员要能看切换进度。
 * 见 server/databaseMaintenance.ts。
 */
const rejectMutationsDuringDatabaseMaintenance = t.middleware(opts => {
  if (opts.type === "mutation" && isDatabaseMaintenanceActive()) {
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: DATABASE_MAINTENANCE_MESSAGE });
  }
  return opts.next();
});

/** 个人 API 令牌的两条限制（只读令牌不能改、任何令牌不能动账号本身），见 server/ops/apiTokenPolicy.ts。 */
const enforceApiTokenPolicy = t.middleware(opts => {
  const apiToken = opts.ctx.apiToken;
  if (apiToken) {
    const reason = apiTokenPolicyError(apiToken.scope, opts.path, opts.type, apiToken.modules);
    if (reason) throw new TRPCError({ code: "FORBIDDEN", message: reason });
  }
  return opts.next();
});

/**
 * 管理员代入用户后台时碰不到的写操作（账号安全、登录绑定、付款），见 server/ops/impersonationPolicy.ts。
 * 和令牌策略一样排在操作审计后面：被拒的也记一行「被拒绝」，记在发起代入的管理员名下。
 */
const enforceImpersonationPolicy = t.middleware(opts => {
  if (opts.ctx.impersonation) {
    const reason = impersonationPolicyError(opts.path, opts.type);
    if (reason) throw new TRPCError({ code: "FORBIDDEN", message: reason });
  }
  return opts.next();
});

/**
 * 主库不可用时所有过程一律 503「数据库暂时不可用」（上游 v2.3.281）。执行中途库挂了、
 * 过程本身报了别的错（比如因为读不到用户而报「未登录」）也改成 503：前端靠这句 message
 * 认出数据库故障、显示故障页，而不是把人踢回登录页。
 */
const rejectWhileDatabaseUnavailable = t.middleware(async opts => {
  if (databaseHealth.isUnavailable()) {
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: DATABASE_UNAVAILABLE_MESSAGE });
  }
  const result = await opts.next();
  if (!result.ok && databaseHealth.isUnavailable()) {
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: DATABASE_UNAVAILABLE_MESSAGE });
  }
  return result;
});

/**
 * 全局接口限流：按令牌 / 用户 / 来源 IP 各一份额度，查询和修改分开（server/apiRateLimit.ts）。
 * 超了回 429（TOO_MANY_REQUESTS），带 Retry-After。
 *
 * 排在操作审计和令牌权限前面：
 *   · 被限流的请求不写审计 —— 有人狂刷接口时，不会顺带把数据库也写爆；
 *   · 令牌权限拒掉的调用也占额度 —— 拿着令牌一直撞禁止的接口，照样会被限下来。
 *
 * 只算最外面那一层：过程里再 createCaller 调别的过程（批量重启规则、故障包）不重复计数 ——
 * 管理员点一次「全部重启」不该因为里面调了 300 次 rules.* 被挡。没有 HTTP 请求的进程内调用
 * （测试、定时任务、Telegram 机器人）不限，它们不是从外面打进来的。
 */
const rateLimitedScope = new AsyncLocalStorage<true>();

const enforceApiRateLimit = t.middleware(opts => {
  const { ctx } = opts;
  if (!ctx.req || rateLimitedScope.getStore()) return opts.next();
  const ip = clientIp(ctx.req, "unknown");
  const decision = checkApiRateLimit(
    { apiTokenId: ctx.apiToken?.id ?? null, userId: ctx.user ? Number(ctx.user.id) : null, ip },
    opts.type,
    currentApiRateLimitConfig(),
  );
  if (decision.limited) {
    try { ctx.res?.setHeader?.("Retry-After", String(decision.retryAfterSeconds)); } catch { /* 响应壳（MCP）没有头可写 */ }
    noteApiRateLimited(decision, { path: opts.path, type: opts.type, userId: ctx.user ? Number(ctx.user.id) : null, tokenName: ctx.apiToken?.name ?? null, ip });
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: apiRateLimitMessage(decision, opts.type) });
  }
  return rateLimitedScope.run(true, () => opts.next());
});

/**
 * 操作审计：登录用户的每次写操作记一行（谁、从哪、调了什么、参数打码、成没成），见 server/operationAudit.ts。
 * 排在令牌策略前面：被令牌策略、管理员校验拒掉的写操作也要记成「被拒绝」。
 */
const recordOperationAudit = t.middleware(opts => auditMutationCall({
  type: opts.type,
  path: opts.path,
  ctx: opts.ctx,
  getRawInput: opts.getRawInput,
  next: () => opts.next(),
}));

/**
 * 中间件顺序：数据库不可用 → 数据库维护 → 限流 → 操作审计 → 令牌权限 → 代入限制。
 * 限流在审计前（被限流的不写库），审计在令牌权限 / 代入限制前（被策略拒掉的写操作记成「被拒绝」）。
 */
const baseProcedure = t.procedure
  .use(rejectWhileDatabaseUnavailable)
  .use(rejectMutationsDuringDatabaseMaintenance)
  .use(enforceApiRateLimit)
  .use(recordOperationAudit)
  .use(enforceApiTokenPolicy)
  .use(enforceImpersonationPolicy);

export const publicProcedure = baseProcedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: ctx.authFailureReason === "session_replaced"
        ? SESSION_REPLACED_ERR_MSG
        : ctx.authFailureReason === "account_disabled" ? ACCOUNT_DISABLED_ERR_MSG : UNAUTHED_ERR_MSG,
    });
  }
  if ((ctx.user as any).accountEnabled === false) {
    ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
    throw new TRPCError({ code: "UNAUTHORIZED", message: ACCOUNT_DISABLED_ERR_MSG });
  }
  // 维护模式：普通用户调需要登录的接口一律「面板维护中」（管理员不受影响），见 server/ops/maintenance.ts。
  await assertMaintenanceAllows(ctx.user);

  // 代入用户后台时，规则 / 主机这些配置的改动记在真正动手的管理员名下，来源标成代入。
  return runWithConfigAuditContext({
    actorUserId: ctx.impersonation ? ctx.impersonation.adminUserId : Number(ctx.user.id),
    actorName: ctx.impersonation ? ctx.impersonation.adminName : String(ctx.user.username || ctx.user.name || ""),
    source: ctx.impersonation ? "panel:impersonation" : "panel:trpc",
    requestId: String(ctx.req.headers["x-request-id"] || "") || undefined,
    requestPath: opts.path,
  }, () => next({ ctx: { ...ctx, user: ctx.user } }));
});

export const protectedProcedure = baseProcedure.use(requireUser);

export const adminProcedure = baseProcedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: ctx.authFailureReason === "session_replaced"
          ? SESSION_REPLACED_ERR_MSG
          : ctx.authFailureReason === "account_disabled" ? ACCOUNT_DISABLED_ERR_MSG : UNAUTHED_ERR_MSG,
      });
    }
    if ((ctx.user as any).accountEnabled === false) {
      ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
      throw new TRPCError({ code: "UNAUTHORIZED", message: ACCOUNT_DISABLED_ERR_MSG });
    }
    // 代入的目标永远是普通用户，本来就过不了下面的角色判断；这里再明确拒一次，
    // 不让「代入会话拿到管理员权限」只靠那一条兜着。
    if (ctx.impersonation || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return runWithConfigAuditContext({
      actorUserId: Number(ctx.user.id),
      actorName: String(ctx.user.username || ctx.user.name || ""),
      source: "panel:trpc",
      requestId: String(ctx.req.headers["x-request-id"] || "") || undefined,
      requestPath: opts.path,
    }, () => next({ ctx: { ...ctx, user: ctx.user } }));
  }),
);
