import { z } from "zod";

import { adminProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { isHostConsideredOnline } from "../../hostHeartbeatPolicy";
import { netTuneHostBandwidthMbps, netTuneStatus, requestNetTuneRun } from "../../ops/netTuneAgent";
import { NETTUNE_ARCHIVE_NAME_MAX, NETTUNE_CUSTOM_AGENT_VERSION, NETTUNE_TCPFIT_AGENT_VERSION, normalizeNetTuneSetting } from "../../../shared/netTune";
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
        // 逐项设置、还原要 Agent 2.2.255 起；老 Agent 收到会当成一次检查，界面上直接不让点
        supportsCustom: isAgentVersionAtLeast((host as { agentVersion?: string | null }).agentVersion, NETTUNE_CUSTOM_AGENT_VERSION),
        // 调优存档、加 swap 要 Agent 2.2.276 起
        supportsArchive: isAgentVersionAtLeast((host as { agentVersion?: string | null }).agentVersion, NETTUNE_TCPFIT_AGENT_VERSION),
        // 缓冲上限按带宽算（2.2.276）：线路带宽，没填用手动出口整形的带宽；都没有为 0（只按内存）
        bandwidthMbps: netTuneHostBandwidthMbps(host),
        ...netTuneStatus(input.hostId),
      };
    }),

  run: adminProcedure
    .input(z.object({ hostId: z.number().int().positive(), apply: z.boolean() }))
    .mutation(async ({ input }) => {
      const host = await db.getHostById(input.hostId);
      if (!host) throw new Error("主机不存在");
      if (!isHostConsideredOnline(host)) throw new Error("主机不在线");
      return requestNetTuneRun(input.hostId, input.apply, Date.now(), undefined, { bandwidthMbps: netTuneHostBandwidthMbps(host) });
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

  /** 调优存档：存当前 / 恢复 / 改名 / 删除（0000 是调优前，只能恢复）。 */
  archive: adminProcedure
    .input(z.object({
      hostId: z.number().int().positive(),
      op: z.enum(["save", "restore", "rename", "delete"]),
      seq: z.string().regex(/^\d{1,4}$/).optional(),
      name: z.string().max(NETTUNE_ARCHIVE_NAME_MAX * 4).optional(),
    }))
    .mutation(async ({ input }) => {
      const host = await requireArchiveCapableHost(input.hostId);
      if (input.op !== "save" && input.seq === undefined) throw new Error("要说是哪一份存档");
      if (input.op === "rename" && !input.name?.trim()) throw new Error("新名字不能是空的");
      return requestNetTuneRun(Number(host.id), "archive", Date.now(), undefined, {
        archive: { op: input.op, ...(input.seq !== undefined ? { seq: input.seq.padStart(4, "0") } : {}), ...(input.name !== undefined ? { name: input.name.trim().slice(0, NETTUNE_ARCHIVE_NAME_MAX) } : {}) },
      });
    }),

  /** 加 swap（1–20 GB）或删掉面板建的 swap。 */
  swap: adminProcedure
    .input(z.union([
      z.object({ hostId: z.number().int().positive(), sizeGB: z.number().int().min(1).max(20) }),
      z.object({ hostId: z.number().int().positive(), remove: z.literal(true) }),
    ]))
    .mutation(async ({ input }) => {
      const host = await requireArchiveCapableHost(input.hostId);
      return requestNetTuneRun(Number(host.id), "swap", Date.now(), undefined, { swap: "remove" in input ? { remove: true } : { sizeGB: input.sizeGB } });
    }),

  /** 还原到面板第一次改这台机器之前的值。 */
  restore: adminProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const host = await requireCustomCapableHost(input.hostId);
      return requestNetTuneRun(Number(host.id), "restore");
    }),
});

async function requireArchiveCapableHost(hostId: number) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  if (!isHostConsideredOnline(host)) throw new Error("主机不在线");
  if (!isAgentVersionAtLeast((host as { agentVersion?: string | null }).agentVersion, NETTUNE_TCPFIT_AGENT_VERSION)) {
    throw new Error(`调优存档和加 swap 要 Agent ${NETTUNE_TCPFIT_AGENT_VERSION} 或更新，请先升级这台主机的 Agent`);
  }
  return host;
}

async function requireCustomCapableHost(hostId: number) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  if (!isHostConsideredOnline(host)) throw new Error("主机不在线");
  if (!isAgentVersionAtLeast((host as { agentVersion?: string | null }).agentVersion, NETTUNE_CUSTOM_AGENT_VERSION)) {
    throw new Error(`逐项设置和还原要 Agent ${NETTUNE_CUSTOM_AGENT_VERSION} 或更新，请先升级这台主机的 Agent`);
  }
  return host;
}
