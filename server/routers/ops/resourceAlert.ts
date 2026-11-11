import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import { readResourceAlertConfig, saveResourceAlertConfig, sendAdminAlert } from "../../resourceAlertNotifier";
import { queryRaw, quoteDbIdentifier } from "../../dbRuntime";
import { RESOURCE_ALERT_SCOPE_MAX_HOSTS } from "../../../shared/resourceAlert";

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
      // 对哪些主机生效 + 是否同时通知主机所属用户（上游 2.3.290）。可选：旧客户端不带时保持原值。
      scope: z.enum(["all", "include", "exclude"]).optional(),
      scopeHostIds: z.array(z.number().int().positive()).max(RESOURCE_ALERT_SCOPE_MAX_HOSTS).optional(),
      notifyOwner: z.boolean().optional(),
    }))
    .mutation(({ input }) => saveResourceAlertConfig(input)),

  /** 「指定主机 / 排除主机」的候选：只要 id 和名字。 */
  hosts: adminProcedure.query(async () => {
    const q = quoteDbIdentifier;
    const rows = await queryRaw<{ id: number; name?: string | null }>(`SELECT ${q("id")}, ${q("name")} FROM ${q("hosts")} ORDER BY ${q("sortOrder")} ASC, ${q("id")} ASC`);
    return rows.map((row) => ({ id: Number(row.id), name: String(row.name || `主机 #${row.id}`) }));
  }),

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
