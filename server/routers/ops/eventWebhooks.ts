import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import {
  EVENT_WEBHOOK_CATEGORY_KEYS,
  EVENT_WEBHOOK_SECRET_MAX_LENGTH,
  EVENT_WEBHOOK_URL_MAX_LENGTH,
} from "../../../shared/eventWebhook";
import {
  EventWebhookInputError,
  getEventWebhooksView,
  installEventWebhookDispatch,
  removeEventWebhookEndpoint,
  saveEventWebhookEndpoint,
  sendEventWebhookTest,
  setEventWebhooksEnabled,
} from "../../ops/eventWebhooks";

/*
  trpc.ops.eventWebhooks.* —— 设置 › 进阶 › 事件推送（给程序用的 JSON 事件推送，server/ops/eventWebhooks.ts）。

  只有管理员、只能在网页上操作：整个路由在 API 令牌的禁止名单里（apiTokenPolicy.ts）——
  接收地址允许填内网，泄露的令牌不该能借它让面板往内网发请求。
  每个修改都经过操作审计中间件（密钥字段自动打码），不用在这里另记。

  推送本身挂在事件时间线上，和这几个接口无关；和 webhooks.ts 一样在路由加载时挂上，
  面板一启动就生效。关着的时候监听器只看一眼内存就返回。
*/
installEventWebhookDispatch();

const idSchema = z.string().regex(/^[0-9a-f]{8,32}$/);
const categorySchema = z.enum(EVENT_WEBHOOK_CATEGORY_KEYS as [string, ...string[]]);

/** 用户填错（地址格式、密钥太短）回 400 带原话；别的错误照原样抛。 */
async function asBadRequest<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof EventWebhookInputError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    throw error;
  }
}

export const eventWebhooksRouter = router({
  /** 总开关、全部接收地址（密钥打码）和各自最近的投递结果。 */
  list: adminProcedure.query(() => getEventWebhooksView()),

  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => setEventWebhooksEnabled(input.enabled)),

  save: adminProcedure
    .input(z.object({
      /** 不传 = 新建。 */
      id: idSchema.optional(),
      url: z.string().trim().min(1).max(EVENT_WEBHOOK_URL_MAX_LENGTH),
      /** 新建必填；修改时不传或留空 = 不换密钥。 */
      secret: z.string().max(EVENT_WEBHOOK_SECRET_MAX_LENGTH + 32).optional(),
      categories: z.array(categorySchema).min(1).max(EVENT_WEBHOOK_CATEGORY_KEYS.length),
      enabled: z.boolean(),
    }))
    .mutation(({ input }) => asBadRequest(() => saveEventWebhookEndpoint(input))),

  remove: adminProcedure
    .input(z.object({ id: idSchema }))
    .mutation(({ input }) => removeEventWebhookEndpoint(input.id)),

  /** 发一条测试事件到这个地址（只发一次，不重试），返回状态码、耗时和错误。 */
  test: adminProcedure
    .input(z.object({ id: idSchema }))
    .mutation(({ input }) => asBadRequest(() => sendEventWebhookTest(input.id))),
});
