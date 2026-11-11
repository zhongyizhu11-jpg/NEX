import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { inList, quoteIdentifier } from "../dbCompat";
import { queryRaw } from "../dbRuntime";
import { invalidateAgentStableHeartbeatPlan } from "../agentHeartbeatGate";
import {
  buildCarrierView,
  CARRIER_VIEW_HOURS,
  missingCarrierPreset,
  normalizeProbeCarrier,
  SHANGHAI_PRESET_INTERVAL_SECONDS,
} from "../../shared/probeCarrier";

/*
  trpc.probeCarrier.* —— 主机管理「服务」页里的三网视图（shared/probeCarrier.ts）。

  view               打了运营商标签的探测服务，按电信 / 联通 / 移动分组，每台主机的当前 RTT、24 小时失败率、
                     30 分钟一格的小走势，外加单机图、双机对比要的 5 分钟序列（客户端自己挑）。
  addShanghaiPreset  一键加「上海三网」三条服务（已经有同目标的就跳过），所有管理员主机都会去探。

  只给管理员：探测服务本身就是管理员在管（服务页只有管理员看得到），而且「全部主机」范围的服务跑在
  管理员的机器上，普通用户不该看到那些机器。只读已有的探测样本，不新增采集。
*/
export const probeCarrierRouter = router({
  view: adminProcedure
    .input(z.object({ hours: z.number().min(1).max(72).default(CARRIER_VIEW_HOURS) }).optional())
    .query(async ({ input }) => {
      const hours = input?.hours ?? CARRIER_VIEW_HOURS;
      const now = Math.floor(Date.now() / 1000);
      const services = (await db.getHostProbeServices()) as any[];
      const tagged = services.filter((service) => normalizeProbeCarrier(service.carrier));
      const presetMissing = missingCarrierPreset(services).map((item) => item.name);
      if (tagged.length === 0) return { groups: buildCarrierView([], [], now, { hours }), hosts: [], series: [], presetMissing, now };
      const rows = (await db.getHostProbeServiceSeries({ serviceIds: tagged.map((service) => Number(service.id)), hours })).map((row) => ({
        serviceId: row.serviceId,
        hostId: row.hostId,
        latencyMs: row.latencyMs,
        probeCount: row.probeCount,
        probeSuccesses: row.probeSuccesses,
        at: Math.floor(new Date(row.recordedAt).getTime() / 1000),
      }));
      const groups = buildCarrierView(tagged, rows, now, { hours });
      const hostIds = Array.from(new Set(rows.map((row) => row.hostId))).filter((id) => id > 0);
      const q = quoteIdentifier;
      const list = inList(hostIds);
      const hostRows = hostIds.length > 0
        ? await queryRaw<any>(`SELECT ${q("id")}, ${q("name")}, ${q("isOnline")}, ${q("geoCountryCode")} FROM ${q("hosts")} WHERE ${q("id")} IN ${list.sql}`, list.params)
        : [];
      return {
        groups,
        hosts: hostRows.map((row) => ({
          id: Number(row.id),
          name: String(row.name || `主机 ${row.id}`),
          online: row.isOnline === true || Number(row.isOnline) === 1,
          country: row.geoCountryCode ? String(row.geoCountryCode).toUpperCase() : null,
        })),
        // 单机图 / 双机对比用的原始桶（5 分钟一格），客户端按主机挑
        series: rows,
        presetMissing,
        now,
      };
    }),

  addShanghaiPreset: adminProcedure.mutation(async ({ ctx }) => {
    const services = (await db.getHostProbeServices()) as any[];
    const missing = missingCarrierPreset(services);
    for (const item of missing) {
      await db.createHostProbeService({
        name: item.name,
        method: item.method,
        targetIp: item.targetIp,
        targetPort: item.targetPort,
        addressFamily: "auto",
        carrier: item.carrier,
        hostScope: "all",
        intervalSeconds: SHANGHAI_PRESET_INTERVAL_SECONDS,
        isEnabled: true,
        userId: Number(ctx.user.id),
      });
    }
    // 探测服务随心跳下发：清掉稳定计划，下一次心跳就带上新服务
    if (missing.length > 0) invalidateAgentStableHeartbeatPlan();
    return { created: missing.length, skipped: 3 - missing.length };
  }),
});
