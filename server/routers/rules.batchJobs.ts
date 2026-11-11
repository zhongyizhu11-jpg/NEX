import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router, runAsNestedProcedureCall } from "../_core/trpc";
import type { TrpcContext } from "../_core/context";
import * as db from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { clientIp } from "../clientIp";
import { databaseHealth } from "../databaseHealthState";
import { isDatabaseMaintenanceActive } from "../databaseMaintenance";
import { getActiveAuthSession } from "../repositories/sessionRepository";
import type { SessionKind } from "../session";
import type { ApiTokenContext } from "../ops/apiTokenPolicy";
import type { ImpersonationContext } from "../ops/impersonationPolicy";
import {
  RuleBatchJobLimitError,
  RuleBatchJobQueue,
  RuleBatchJobStopError,
  type RuleBatchJobItem,
  type RuleBatchJobOwner,
} from "../ruleBatchJobs";
import { isRuleBatchPortConflictError, startRuleBatchJobSchema } from "../../shared/ruleBatchJobs";

/*
  规则批量任务的接口（rules.batchJobStart / batchJobs / batchJobStatus / batchJobStop / batchJobRetryFailed /
  batchJobDismiss，并进 rulesRouter）。队列本身见 server/ruleBatchJobs.ts。

  每一项都通过 appRouter.createCaller 调单条接口（rules.toggle / restart / delete / create）：入参校验、
  「是不是你的规则」「这条能不能动」、套餐 / 端口 / 库存检查、操作审计全是单条接口那一份，批量没有任何捷径。
  用的身份是提交任务的人，但每一项都重新读一遍账号：中途被停用、登录被撤销、数据库不可用，任务就停在那里，
  剩下的记成「未执行」。令牌提交的任务带着令牌的权限范围（只读令牌提交不了，勾了模块的只能动 rules.*）。
*/

type OwnerExtra = {
  sid: string | null;
  kind: SessionKind;
  apiToken: ApiTokenContext | null;
  impersonation: ImpersonationContext | null;
  ip: string;
  userAgent: string;
  originalUrl: string;
};

/** 同一个任务里认人的结果缓存几秒：几千项不必每一项都查一次会话表，撤销登录最多晚几秒生效。 */
const SESSION_CHECK_CACHE_MS = 5_000;
const sessionChecks = new Map<string, number>();

async function executionContext(jobId: string, owner: RuleBatchJobOwner<OwnerExtra>): Promise<TrpcContext> {
  if (databaseHealth.isUnavailable()) throw new RuleBatchJobStopError("数据库暂不可用，任务已停止，请核对已完成的规则后再操作");
  if (isDatabaseMaintenanceActive()) throw new RuleBatchJobStopError("面板正在切换数据库，任务已停止，请稍后再操作");
  const user = await db.getUserById(owner.userId);
  if (!user || (user as { accountEnabled?: unknown }).accountEnabled === false) throw new RuleBatchJobStopError("账号已不存在或已停用，剩下的规则没有继续处理");
  const { sid, kind } = owner.extra;
  if (sid) {
    const key = `${jobId}:${sid}`;
    const checkedAt = sessionChecks.get(key) || 0;
    if (Date.now() - checkedAt > SESSION_CHECK_CACHE_MS) {
      if (!(await getActiveAuthSession(owner.userId, sid, kind))) {
        sessionChecks.delete(key);
        throw new RuleBatchJobStopError("登录已失效，剩下的规则没有继续处理");
      }
      sessionChecks.set(key, Date.now());
    }
  }
  return {
    // 带上提交时的来源：审计里这一批记成同一个人、同一个地址发起的。
    req: {
      headers: { "x-request-id": `rule-batch-${jobId}`, "user-agent": owner.extra.userAgent },
      ip: owner.extra.ip,
      socket: { remoteAddress: owner.extra.ip },
      originalUrl: owner.extra.originalUrl,
      protocol: "http",
    } as unknown as TrpcContext["req"],
    res: { clearCookie() {}, setHeader() {} } as unknown as TrpcContext["res"],
    user,
    authSession: null,
    authFailureReason: null,
    apiToken: owner.extra.apiToken,
    impersonation: owner.extra.impersonation,
  };
}

async function runItem(
  job: { id: string; operation: string; conflictStrategy: string; owner: RuleBatchJobOwner<OwnerExtra> },
  item: RuleBatchJobItem,
): Promise<{ skipped?: boolean }> {
  const ctx = await executionContext(job.id, job.owner);
  // 按需加载：appRouter 本身引用了这个文件，顶部 import 会成环。
  const { appRouter } = await import("../routers");
  const caller = appRouter.createCaller(ctx);
  const ruleId = Number(item.ruleId || 0);
  try {
    return await runAsNestedProcedureCall(async () => {
      switch (job.operation) {
        case "enable": await caller.rules.toggle({ id: ruleId, isEnabled: true }); return {};
        case "pause": await caller.rules.toggle({ id: ruleId, isEnabled: false }); return {};
        case "restart": {
          const result = await caller.rules.restart({ id: ruleId });
          return { skipped: "skipped" in result && !!result.skipped };
        }
        case "delete": await caller.rules.delete({ id: ruleId }); return {};
        case "copy": {
          const input = (item.input || {}) as Parameters<typeof caller.rules.create>[0];
          try {
            await caller.rules.create(input);
            return {};
          } catch (error) {
            if (job.conflictStrategy === "error" || !isRuleBatchPortConflictError(error)) throw error;
            if (job.conflictStrategy === "skip") return { skipped: true };
            await caller.rules.create({ ...input, sourcePort: 0 });
            return {};
          }
        }
        default: throw new Error("不支持的批量操作");
      }
    });
  } catch (error) {
    // 单条接口说「没登录 / 数据库不可用」时，后面的项也不会成功：整个任务停下，而不是刷出几千条一样的失败。
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "UNAUTHORIZED" || code === "SERVICE_UNAVAILABLE") {
      throw new RuleBatchJobStopError(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

export const ruleBatchJobQueue = new RuleBatchJobQueue<OwnerExtra>(runItem);

// 做完的任务过期后从内存里清掉（查询时也会顺手清）。
const ruleBatchJobPruneTimer = setInterval(() => ruleBatchJobQueue.prune(), 60_000);
ruleBatchJobPruneTimer.unref?.();

function ownerOf(ctx: TrpcContext & { user: NonNullable<TrpcContext["user"]> }): RuleBatchJobOwner<OwnerExtra> {
  return {
    userId: Number(ctx.user.id),
    extra: {
      sid: ctx.authSession?.sid || null,
      kind: ctx.authSession?.kind || "browser",
      apiToken: ctx.apiToken ?? null,
      impersonation: ctx.impersonation ?? null,
      ip: clientIp(ctx.req, ""),
      userAgent: String(ctx.req?.headers?.["user-agent"] || "").slice(0, 256),
      originalUrl: String(ctx.req?.originalUrl || ""),
    },
  };
}

function limitError(cause: unknown): never {
  if (cause instanceof RuleBatchJobLimitError) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: cause.message, cause });
  throw cause;
}

const jobIdInput = z.object({ id: z.string().uuid() });

export const ruleBatchJobsRouter = router({
  /** 提交一个批量任务，马上返回任务快照。同样内容的任务还在跑时返回那一个（duplicate: true）。 */
  batchJobStart: protectedProcedure
    .input(startRuleBatchJobSchema)
    .mutation(({ ctx, input }) => {
      let items: RuleBatchJobItem[];
      if (input.operation === "copy") {
        items = (input.copyItems || []).map((item) => ({ label: item.label, input: item.input }));
      } else {
        const ids = Array.from(new Set(input.ruleIds || []));
        items = ids.map((id) => ({ ruleId: id, label: String(input.ruleLabels?.[String(id)] || "").trim() || `规则 #${id}` }));
      }
      try {
        const result = ruleBatchJobQueue.start(ownerOf(ctx), {
          operation: input.operation,
          title: input.title,
          items,
          conflictStrategy: input.conflictStrategy,
        });
        if (!result.duplicate) {
          appendPanelLog("info", `[RuleBatch] user=${ctx.user.id} started job=${result.snapshot.id} op=${input.operation} items=${items.length}`);
        }
        return result;
      } catch (cause) {
        return limitError(cause);
      }
    }),

  /** 我的全部任务（在跑的和最近做完的）。小窗打开页面时用它接上。 */
  batchJobs: protectedProcedure.query(({ ctx }) => ruleBatchJobQueue.list(Number(ctx.user.id))),

  /** 按任务号查进度；别人的任务、已经被忘掉的、面板重启前的都返回 null。 */
  batchJobStatus: protectedProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).max(20) }))
    .query(({ ctx, input }) => input.ids.map((id) => ({ id, job: ruleBatchJobQueue.get(Number(ctx.user.id), id) }))),

  batchJobStop: protectedProcedure
    .input(jobIdInput)
    .mutation(({ ctx, input }) => {
      const job = ruleBatchJobQueue.stop(Number(ctx.user.id), input.id);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在或已过期" });
      return job;
    }),

  batchJobRetryFailed: protectedProcedure
    .input(jobIdInput)
    .mutation(({ ctx, input }) => {
      try {
        const result = ruleBatchJobQueue.retryFailed(ownerOf(ctx), input.id);
        if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在或已过期" });
        return result;
      } catch (cause) {
        return limitError(cause);
      }
    }),

  batchJobDismiss: protectedProcedure
    .input(jobIdInput)
    .mutation(({ ctx, input }) => ({ dismissed: ruleBatchJobQueue.dismiss(Number(ctx.user.id), input.id) })),
});
