import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { IP_CHANGE_LIMITS } from "../../shared/ipChange";
import { getAutoIpChangePluginStatus, getIpChangeService } from "../ipChange/runtime";
import { appendPanelLog } from "../_core/panelLogger";

/*
  trpc.ipChange.* —— 自动换 IP 管理页（/ip-change）。全部仅管理员。

  插件没装 / 没启用 / 插件功能总开关没开时：status 照常回（页面靠它显示「先去启用插件」），
  hostStatus 回 null，其余接口一律报错 —— 这一层不靠前端自觉。
*/

const credentialValues = z.record(z.string().max(64), z.string().max(16_384)).refine((value) => Object.keys(value).length <= 64, "字段太多");
const targetValues = z.record(z.string().max(64), z.string().max(4_096)).refine((value) => Object.keys(value).length <= 64, "字段太多");
const hostIdSchema = z.number().int().positive();

async function activeService() {
  const service = getIpChangeService();
  await service.assertActive();
  return service;
}

export const ipChangeRouter = router({
  status: adminProcedure.query(async () => {
    const status = await getAutoIpChangePluginStatus({ fresh: true });
    return { ...status, providerCount: getIpChangeService().listProviders().length };
  }),

  providers: adminProcedure.query(async () => (await activeService()).listProviders()),

  accounts: router({
    list: adminProcedure.query(async () => (await activeService()).listAccounts()),
    create: adminProcedure
      .input(z.object({ name: z.string().trim().min(1).max(128), provider: z.string().trim().min(1).max(64), credentials: credentialValues }))
      .mutation(async ({ input }) => ({ id: await (await activeService()).createAccount(input) })),
    /** credentials 里没改的密钥字段原样回传打码后的值即可（等于打码值 = 保留原值）。 */
    update: adminProcedure
      .input(z.object({ id: z.number().int().positive(), name: z.string().trim().min(1).max(128).optional(), credentials: credentialValues.optional() }))
      .mutation(async ({ input }) => {
        await (await activeService()).updateAccount(input);
        return { success: true };
      }),
    delete: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        await (await activeService()).deleteAccount(input.id);
        return { success: true };
      }),
    /** 给 hostId 就用那台主机保存的目标，给 target 就用表单里还没保存的目标。 */
    test: adminProcedure
      .input(z.object({ accountId: z.number().int().positive(), hostId: hostIdSchema.optional(), target: targetValues.optional() }))
      .mutation(async ({ input }) => (await activeService()).testAccount(input)),
  }),

  hosts: router({
    list: adminProcedure.query(async () => (await activeService()).listHostConfigs()),
    options: adminProcedure.query(async () => (await activeService()).listHostsForSelect()),
    save: adminProcedure
      .input(z.object({
        hostId: hostIdSchema,
        enabled: z.boolean(),
        autoEnabled: z.boolean(),
        cloudAccountId: z.number().int().positive().nullable(),
        target: targetValues,
        checkTargets: z.string().max(4_000),
        checkMethod: z.enum(["tcp", "ping"]),
        failureThreshold: z.number().int().min(IP_CHANGE_LIMITS.failureThreshold.min).max(IP_CHANGE_LIMITS.failureThreshold.max),
        checkIntervalSeconds: z.number().int().min(IP_CHANGE_LIMITS.checkIntervalSeconds.min).max(IP_CHANGE_LIMITS.checkIntervalSeconds.max),
        cooldownMinutes: z.number().int().min(IP_CHANGE_LIMITS.cooldownMinutes.min).max(IP_CHANGE_LIMITS.cooldownMinutes.max),
        maxChangesPerDay: z.number().int().min(IP_CHANGE_LIMITS.maxChangesPerDay.min).max(IP_CHANGE_LIMITS.maxChangesPerDay.max),
        releaseOldIp: z.boolean(),
      }))
      .mutation(async ({ input }) => {
        await (await activeService()).saveHostConfig(input);
        return { success: true };
      }),
    delete: adminProcedure
      .input(z.object({ hostId: hostIdSchema }))
      .mutation(async ({ input }) => {
        await (await activeService()).deleteHostConfig(input.hostId);
        return { success: true };
      }),
  }),

  /** 主机详情里的小卡片：没配置或插件没开时是 null，不报错。 */
  hostStatus: adminProcedure
    .input(z.object({ hostId: hostIdSchema }))
    .query(async ({ input }) => getIpChangeService().hostStatus(input.hostId)),

  /** 立即更换：不看冷却和每日上限；正在更换 / 结果不确定时拒绝。换 IP 在后台跑，进度看记录。 */
  changeNow: adminProcedure
    .input(z.object({ hostId: hostIdSchema }))
    .mutation(async ({ input }) => {
      const service = await activeService();
      const { eventId, done } = await service.beginChange(input.hostId, "manual");
      void done.catch((error) => {
        appendPanelLog("error", `[IpChange] host=${input.hostId} 手动更换异常结束：${error instanceof Error ? error.message : String(error)}`);
      });
      return { eventId };
    }),

  resetState: adminProcedure
    .input(z.object({ hostId: hostIdSchema }))
    .mutation(async ({ input }) => {
      await (await activeService()).resetState(input.hostId);
      return { success: true };
    }),

  events: adminProcedure
    .input(z.object({
      hostId: hostIdSchema.optional(),
      page: z.number().int().min(1).max(10_000).default(1),
      pageSize: z.number().int().min(1).max(100).default(20),
    }))
    .query(async ({ input }) => (await activeService()).listEvents(input)),
});
