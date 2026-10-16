import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getNetworkTopology } from "../networkTopology";

/**
 * 网络拓扑：整张图一次给。管理员看全站，可以按用户筛；普通用户只看自己的规则、隧道、
 * 转发组、入站和它们经过的主机（看不见的中转打码），传 userId 也不认。
 */
export const topologyRouter = router({
  graph: protectedProcedure
    .input(z.object({ userId: z.number().int().positive().nullable().optional() }).optional())
    .query(async ({ ctx, input }) => getNetworkTopology(
      { id: Number(ctx.user.id), role: String(ctx.user.role || "user") },
      { userId: input?.userId ?? null },
    )),
});
