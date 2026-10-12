import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import { WEBHOOK_CATEGORY_KEYS } from "../../../shared/opsWebhook";
import {
  getWebhookSettingsView,
  installWebhookDelivery,
  saveWebhookSettings,
  sendWebhookTest,
  WEBHOOK_URL_MAX_LENGTH,
} from "../../ops/webhooks";

/*
  trpc.ops.webhooks.* —— 设置 › Webhook。

  推送本身挂在事件时间线上（installWebhookDelivery），和这几个接口无关；这里顺手在
  路由加载时挂上，面板一启动就生效，不管哪套主题、有没有人打开过设置页。
*/
installWebhookDelivery();

const categorySchema = z.enum(WEBHOOK_CATEGORY_KEYS as unknown as [string, ...string[]]);
const levelSchema = z.enum(["info", "warn", "crit"]);

export const webhooksRouter = router({
  get: adminProcedure.query(() => getWebhookSettingsView()),

  save: adminProcedure
    .input(z.object({
      enabled: z.boolean(),
      /** 不传 = 地址不变（前端只拿得到打码后的样子）；空串 = 清掉。 */
      url: z.string().trim().max(WEBHOOK_URL_MAX_LENGTH).optional(),
      categories: z.array(categorySchema).max(WEBHOOK_CATEGORY_KEYS.length),
      minLevel: levelSchema,
    }))
    .mutation(({ input }) => saveWebhookSettings({
      enabled: input.enabled,
      url: input.url,
      categories: input.categories as any,
      minLevel: input.minLevel,
    })),

  /** 发一条测试消息。url 给了就测这个新地址（还没保存也行），不给就测已保存的。 */
  test: adminProcedure
    .input(z.object({ url: z.string().trim().max(WEBHOOK_URL_MAX_LENGTH).optional() }).optional())
    .mutation(({ input }) => sendWebhookTest(input?.url || null)),
});
