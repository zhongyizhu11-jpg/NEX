import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { quotaAgentReports } from "../../ops/quotaAgent";
import { getQuotaMode, QUOTA_MODES, setQuotaMode } from "../../ops/quotaPolicy";

/** trpc.ops.quotaPolicy.* —— 流量用尽时的处理（#18），见 server/ops/quotaPolicy.ts 顶部的说明。 */
export const quotaPolicyRouter = router({
  get: adminProcedure.query(async () => {
    const mode = await getQuotaMode();
    const hosts = (await db.getHosts()) as any[];
    const reports = quotaAgentReports();
    // 「立即断开」对内核转发要靠 conntrack 工具；告诉管理员哪几台做不到。
    const noConntrack = hosts
      .filter((host) => reports.get(Number(host.id))?.conntrack === false)
      .map((host) => String(host.name || `主机 ${host.id}`));
    return { mode, totalHosts: hosts.length, noConntrackHosts: noConntrack };
  }),

  set: adminProcedure
    .input(z.object({ mode: z.enum(QUOTA_MODES) }))
    .mutation(async ({ input }) => {
      await setQuotaMode(input.mode);
      return { success: true, mode: input.mode };
    }),
});
