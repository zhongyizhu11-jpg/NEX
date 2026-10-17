import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { getHostNamesByIds } from "../../repositories/hostRepository";
import { CONN_STATS_RETENTION_HOURS, getTunnelConnStats } from "../../ops/connStats";
import { connStatsToCsv } from "../../../shared/connStats";
import { APP_VERSION } from "../../../shared/versions";

/*
  trpc.ops.connStats.* —— 隧道详情 › 连接监控：每一跳、每个阶段的成功率和耗时，留 7 天，能导出。只给管理员。
*/
const inputSchema = z.object({
  tunnelId: z.number().int().positive(),
  hours: z.number().int().min(1).max(CONN_STATS_RETENTION_HOURS).default(24),
});

async function loadWithNames(tunnelId: number, hours: number) {
  const tunnel = await db.getTunnelById(tunnelId);
  if (!tunnel) throw new Error("隧道不存在");
  const stats = await getTunnelConnStats(tunnelId, hours);
  const hostIds = [...new Set(stats.groups.map((group) => group.hostId))];
  const names = hostIds.length > 0 ? await getHostNamesByIds(hostIds).catch(() => new Map<number, string>()) : new Map<number, string>();
  return {
    tunnel: { id: Number((tunnel as any).id), name: String((tunnel as any).name || `#${tunnelId}`) },
    ...stats,
    groups: stats.groups.map((group) => ({ ...group, hostName: names.get(group.hostId) || `#${group.hostId}` })),
  };
}

export const connStatsRouter = router({
  tunnel: adminProcedure.input(inputSchema).query(({ input }) => loadWithNames(input.tunnelId, input.hours)),

  export: adminProcedure
    .input(inputSchema.extend({ format: z.enum(["csv", "json"]) }))
    .mutation(async ({ input }) => {
      const data = await loadWithNames(input.tunnelId, input.hours);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const base = `nex-conn-stats-tunnel-${input.tunnelId}-${stamp}`;
      if (input.format === "csv") {
        return {
          filename: `${base}.csv`,
          mime: "text/csv",
          content: connStatsToCsv(data.groups.map((group) => ({
            hostName: group.hostName,
            role: group.role,
            stage: group.stage,
            endpoint: group.endpoint,
            ruleId: null,
            summary: group.summary,
            lastError: group.lastError,
          }))),
        };
      }
      return {
        filename: `${base}.json`,
        mime: "application/json",
        content: JSON.stringify({ kind: "nex-connection-stats", panelVersion: APP_VERSION, generatedAt: new Date().toISOString(), ...data }, null, 2),
      };
    }),
});
