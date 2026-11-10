import { z } from "zod";

import { adminProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { isHostConsideredOnline } from "../../hostHeartbeatPolicy";
import { netTuneStatus, requestNetTuneRun } from "../../ops/netTuneAgent";
import { NETTUNE_CUSTOM_AGENT_VERSION, normalizeNetTuneSetting } from "../../../shared/netTune";
import { isAgentVersionAtLeast } from "../../../shared/version";

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
        online: isHostConsideredOnline(host),
        // 逐项设置、还原要 Agent 2.2.253 起；老 Agent 收到会当成一次检查，界面上直接不让点
        supportsCustom: isAgentVersionAtLeast((host as { agentVersion?: string | null }).agentVersion, NETTUNE_CUSTOM_AGENT_VERSION),
        ...netTuneStatus(input.hostId),
      };
    }),

  run: adminProcedure
    .input(z.object({ hostId: z.number().int().positive(), apply: z.boolean() }))
    .mutation(async ({ input }) => {
      const host = await db.getHostById(input.hostId);
      if (!host) throw new Error("主机不存在");
      if (!isHostConsideredOnline(host)) throw new Error("主机不在线");
      return requestNetTuneRun(input.hostId, input.apply);
    }),

  /** 逐项设置：{ 键: 值 }，一次最多 32 项。 */
  set: adminProcedure
    .input(z.object({ hostId: z.number().int().positive(), values: z.record(z.string().max(80), z.string().max(128)) }))
    .mutation(async ({ input }) => {
      const host = await requireCustomCapableHost(input.hostId);
      const entries = Object.entries(input.values);
      if (entries.length === 0) throw new Error("没有要改的参数");
      if (entries.length > 32) throw new Error("一次最多改 32 项");
      const values: Record<string, string> = {};
      for (const [key, value] of entries) values[key] = normalizeNetTuneSetting(key, value);
      return requestNetTuneRun(Number(host.id), "set", Date.now(), values);
    }),

  /** 还原到面板第一次改这台机器之前的值。 */
  restore: adminProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const host = await requireCustomCapableHost(input.hostId);
      return requestNetTuneRun(Number(host.id), "restore");
    }),
});

async function requireCustomCapableHost(hostId: number) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  if (!isHostConsideredOnline(host)) throw new Error("主机不在线");
  if (!isAgentVersionAtLeast((host as { agentVersion?: string | null }).agentVersion, NETTUNE_CUSTOM_AGENT_VERSION)) {
    throw new Error(`逐项设置和还原要 Agent ${NETTUNE_CUSTOM_AGENT_VERSION} 或更新，请先升级这台主机的 Agent`);
  }
  return host;
}
