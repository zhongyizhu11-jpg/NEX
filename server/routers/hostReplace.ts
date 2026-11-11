import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { isHostConsideredOnline } from "../hostHeartbeatPolicy";
import { getHostEntryAddress, type HostEntryAddressSource } from "../../shared/hostEntryAddress";
import { buildHostReplacePlan } from "../hostReplace/plan";
import { executeHostReplace, listHostReplacements, undoHostReplace } from "../hostReplace/execute";

/*
  trpc.hostReplace.* —— 主机替换向导（换 VPS，见 server/hostReplace/）。全部仅管理员：它一次改动所有
  用户挂在这台机器上的规则、隧道和组。每次执行 / 撤回都进配置审计（resourceType host），接口调用本身
  走操作审计。
*/

const hostId = z.number().int().positive();

export const hostReplaceRouter = router({
  /** 选新机：除了旧机以外的机器，在线的排前面（新机得在线才能换）。 */
  candidates: adminProcedure
    .input(z.object({ oldHostId: hostId }))
    .query(async ({ input }) => {
      const hosts = await db.getHosts() as Array<Record<string, unknown> & { id: number }>;
      return hosts
        .filter((host) => Number(host.id) !== input.oldHostId)
        .map((host) => ({
          id: Number(host.id),
          name: String(host.name || "").trim() || `主机 ${host.id}`,
          address: getHostEntryAddress(host as HostEntryAddressSource) || String(host.ip || ""),
          online: isHostConsideredOnline(host),
          maintenance: !!host.maintenanceMode,
        }))
        .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "zh-CN"));
    }),

  preview: adminProcedure
    .input(z.object({ oldHostId: hostId, newHostId: hostId }))
    .query(async ({ input }) => (await buildHostReplacePlan(input.oldHostId, input.newHostId)).preview),

  execute: adminProcedure
    .input(z.object({
      oldHostId: hostId,
      newHostId: hostId,
      fingerprint: z.string().min(1).max(64),
      resolutions: z.record(
        z.string().max(128),
        z.object({ action: z.enum(["newPort", "skip"]), port: z.number().int().min(1).max(65535).nullable().optional() }),
      ).refine((value) => Object.keys(value).length <= 2000, "冲突太多").optional(),
      bridge: z.boolean().optional(),
      maintenance: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => executeHostReplace(input, { id: Number(ctx.user.id), name: String(ctx.user.username || ctx.user.name || "") })),

  undo: adminProcedure
    .input(z.object({ recordId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => undoHostReplace(input.recordId, { id: Number(ctx.user.id), name: String(ctx.user.username || ctx.user.name || "") })),

  /** 这台机器（作为旧机或新机）的替换记录；不给 hostId 就是全部。 */
  records: adminProcedure
    .input(z.object({ hostId: hostId.optional() }).optional())
    .query(async ({ input }) => listHostReplacements(input?.hostId ?? null)),
});
