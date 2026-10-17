import { ACCOUNT_DISABLED_ERR_MSG, COOKIE_NAME, NOT_ADMIN_ERR_MSG, SESSION_REPLACED_ERR_MSG, UNAUTHED_ERR_MSG } from '../../shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { getSessionCookieOptions } from "./cookies";
import { runWithConfigAuditContext } from "../configAudit";
import { DATABASE_MAINTENANCE_MESSAGE, isDatabaseMaintenanceActive } from "../databaseMaintenance";
import { formatTrpcErrorShape } from "./errorFormatter";
import { apiTokenPolicyError } from "../ops/apiTokenPolicy";
import { assertMaintenanceAllows } from "../ops/maintenance";
import { databaseHealth } from "../databaseHealthState";
import { DATABASE_UNAVAILABLE_MESSAGE } from "../../shared/databaseHealth";

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
    const reason = apiTokenPolicyError(apiToken.scope, opts.path, opts.type);
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

const baseProcedure = t.procedure.use(rejectWhileDatabaseUnavailable).use(rejectMutationsDuringDatabaseMaintenance).use(enforceApiTokenPolicy);

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

  return runWithConfigAuditContext({
    actorUserId: Number(ctx.user.id),
    actorName: String(ctx.user.username || ctx.user.name || ""),
    source: "panel:trpc",
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
    if (ctx.user.role !== 'admin') {
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
