import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, protectedProcedure } from "../_core/trpc";
import { requireHostAccess } from "./helpers";
import {
  getUnlockSchedule,
  hostSupportsUnlock,
  latestUnlockRuns,
  listUnlockHistory,
  pendingUnlockRunsForHost,
  setUnlockSchedule,
  startUnlockCheck,
  UnlockCheckError,
} from "../ops/unlock";
import { UNLOCK_FAMILIES, UNLOCK_MIN_AGENT_VERSION, UNLOCK_SCHEDULES } from "@shared/unlockCheck";

/*
  trpc.hosts.unlock* —— 主机详情里的「流媒体 / AI 解锁」一节（Agent 2.2.225 起）。

  unlockStatus      最新结果（每个 family 一份）、在等的检测、是否支持；能用这台主机的人都能看
  unlockHistory     最近 10 次；同上
  startUnlockCheck  「检测解锁」按钮，只给管理员（每次都要从主机去请求一串第三方站点）
  unlockSchedule / setUnlockSchedule  计划检测（关闭 / 每天 / 每周），全局一个设置，只给管理员
*/
const hostInput = z.object({ hostId: z.number().int().positive() });

async function accessibleHost(ctx: { user: { id: number; role: string } }, hostId: number) {
  try {
    return await requireHostAccess(ctx, hostId);
  } catch (error) {
    throw new TRPCError({ code: "NOT_FOUND", message: error instanceof Error ? error.message : "主机不存在" });
  }
}

export const hostUnlockProcedures = {
  unlockStatus: protectedProcedure
    .input(hostInput)
    .query(async ({ input, ctx }) => {
      const host: any = await accessibleHost(ctx, input.hostId);
      const isAdmin = ctx.user.role === "admin";
      const [latest, schedule] = await Promise.all([
        latestUnlockRuns(input.hostId),
        isAdmin ? getUnlockSchedule() : Promise.resolve(null),
      ]);
      return {
        supported: hostSupportsUnlock(host),
        minAgentVersion: UNLOCK_MIN_AGENT_VERSION,
        agentVersion: host.agentVersion ? String(host.agentVersion) : null,
        online: !!host.isOnline,
        canManage: isAdmin,
        schedule,
        pending: pendingUnlockRunsForHost(input.hostId).map((run) => ({
          runId: run.runId,
          family: run.family,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
        })),
        latest: latest.map(({ id: _id, ...run }) => run),
      };
    }),

  unlockHistory: protectedProcedure
    .input(hostInput)
    .query(async ({ input, ctx }) => {
      await accessibleHost(ctx, input.hostId);
      return (await listUnlockHistory(input.hostId)).map(({ id: _id, ...run }) => run);
    }),

  startUnlockCheck: adminProcedure
    .input(hostInput.extend({ family: z.enum(UNLOCK_FAMILIES).default("auto") }))
    .mutation(async ({ input, ctx }) => {
      const host: any = await accessibleHost(ctx, input.hostId);
      try {
        return startUnlockCheck(host, { family: input.family, trigger: "manual", requestedBy: Number(ctx.user.id) });
      } catch (error) {
        if (error instanceof UnlockCheckError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
        throw error;
      }
    }),

  unlockSchedule: adminProcedure.query(async () => ({ schedule: await getUnlockSchedule() })),

  setUnlockSchedule: adminProcedure
    .input(z.object({ schedule: z.enum(UNLOCK_SCHEDULES) }))
    .mutation(async ({ input }) => {
      await setUnlockSchedule(input.schedule);
      return { schedule: input.schedule };
    }),
};
