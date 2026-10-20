import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { hostSupportsAgentExt } from "../../ops/agentExt";
import { quotaAgentReports } from "../../ops/quotaAgent";
import { getQuotaMode, QUOTA_MODES, setQuotaMode } from "../../ops/quotaPolicy";

/** trpc.ops.quotaPolicy.* —— 流量用尽时的处理（#18），见 server/ops/quotaPolicy.ts 顶部的说明。 */
export const quotaPolicyRouter = router({
  get: adminProcedure.query(async () => {
    const mode = await getQuotaMode();
    const hosts = (await db.getHosts()) as any[];
    const reports = quotaAgentReports();
    // 「立即断开」对内核转发要靠 Agent 扩展通道 + conntrack 工具；告诉管理员哪几台做不到。
    const outdatedList = hosts.filter((host) => !hostSupportsAgentExt(host));
    const noConntrackList = hosts.filter((host) => hostSupportsAgentExt(host) && reports.get(Number(host.id))?.conntrack === false);
    const nameOf = (host: any) => String(host.name || `主机 ${host.id}`);
    return {
      mode,
      totalHosts: hosts.length,
      outdatedHosts: outdatedList.map(nameOf),
      noConntrackHosts: noConntrackList.map(nameOf),
      // 精简布局的「一键升级」用：两种情况都是升级 Agent 解决（升级时会顺带装 conntrack）。
      upgradeHostIds: Array.from(new Set([...outdatedList, ...noConntrackList].map((host) => Number(host.id)))),
    };
  }),

  set: adminProcedure
    .input(z.object({ mode: z.enum(QUOTA_MODES) }))
    .mutation(async ({ input }) => {
      await setQuotaMode(input.mode);
      return { success: true, mode: input.mode };
    }),
});
