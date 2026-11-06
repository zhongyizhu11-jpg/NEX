import { z } from "zod";

import { adminProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { isHostConsideredOnline } from "../../hostHeartbeatPolicy";
import { NETTUNE_MIN_AGENT_VERSION } from "../../../shared/netTune";
import { hostSupportsNetTune, netTuneStatus, requestNetTuneRun } from "../../ops/netTuneAgent";

/*
  trpc.ops.netTune.* —— 主机详情 › 更多 › 网络调优（server/ops/netTuneAgent.ts）。只给管理员：
  调优会改主机的内核参数，写 /etc/sysctl.d。
*/
export const netTuneRouter = router({
  status: adminProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const host = await db.getHostById(input.hostId);
      if (!host) throw new Error("主机不存在");
      return {
        supported: hostSupportsNetTune(host as { agentVersion?: string | null }),
        minAgentVersion: NETTUNE_MIN_AGENT_VERSION,
        online: isHostConsideredOnline(host),
        ...netTuneStatus(input.hostId),
      };
    }),

  run: adminProcedure
    .input(z.object({ hostId: z.number().int().positive(), apply: z.boolean() }))
    .mutation(async ({ input }) => {
      const host = await db.getHostById(input.hostId);
      if (!host) throw new Error("主机不存在");
      if (!hostSupportsNetTune(host as { agentVersion?: string | null })) throw new Error(`需要把 Agent 升级到 ${NETTUNE_MIN_AGENT_VERSION}`);
      if (!isHostConsideredOnline(host)) throw new Error("主机不在线");
      return requestNetTuneRun(input.hostId, input.apply);
    }),
});
