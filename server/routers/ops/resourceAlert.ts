import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import { readResourceAlertConfig, saveResourceAlertConfig, sendAdminAlert } from "../../resourceAlertNotifier";

/*
  trpc.ops.resourceAlert.* —— 设置 › 资源告警。判定挂在心跳上（server/resourceAlertNotifier.ts），
  这里只读写设置、发测试消息。
*/
const thresholdSchema = z.number().int().min(0).max(100);

export const resourceAlertRouter = router({
  get: adminProcedure.query(() => readResourceAlertConfig()),

  save: adminProcedure
    .input(z.object({
      enabled: z.boolean(),
      cpuPercent: thresholdSchema,
      memoryPercent: thresholdSchema,
      diskPercent: thresholdSchema,
      sustainSeconds: z.number().int().min(30).max(3600),
      recoverMarginPercent: z.number().int().min(0).max(30),
      emailEnabled: z.boolean(),
      oomAlert: z.boolean(),
      crashAlert: z.boolean(),
      lossPercent: thresholdSchema,
    }))
    .mutation(({ input }) => saveResourceAlertConfig(input)),

  /** 按当前设置的渠道发一条测试告警。 */
  test: adminProcedure.mutation(async () => {
    const config = await readResourceAlertConfig();
    await sendAdminAlert({
      title: "NEX 资源告警测试",
      marker: "🧪",
      fields: [["说明", "这是一条测试消息：资源告警会通过 Telegram、Discord" + (config.emailEnabled ? "和邮件" : "") + "发到这里。"]],
      logLabel: "test",
    }, { email: config.emailEnabled });
    return { ok: true };
  }),
});
