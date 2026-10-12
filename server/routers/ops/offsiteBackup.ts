import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import { systemRouter } from "../../_core/systemRouter";
import { nextBackupAt } from "../../ops/offsiteBackupLogic";
import {
  downloadOffsiteBackup,
  listOffsiteBackups,
  OFFSITE_BACKUP_DESTINATIONS,
  readOffsiteBackupSettingsForClient,
  runOffsiteBackup,
  saveOffsiteBackupSettings,
  testOffsiteBackupConnection,
} from "../../ops/offsiteBackup";

const scheduleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("daily"), hour: z.number().int().min(0).max(23) }),
  z.object({ mode: z.literal("interval"), everyHours: z.number().int().min(1).max(168) }),
]);

const settingsSchema = z.object({
  destination: z.enum(OFFSITE_BACKUP_DESTINATIONS),
  webdav: z.object({
    url: z.string().trim().max(512).optional(),
    user: z.string().max(256).optional(),
    password: z.string().max(512).optional(),
  }).optional(),
  s3: z.object({
    endpoint: z.string().trim().max(512).optional(),
    region: z.string().trim().max(64).optional(),
    bucket: z.string().trim().max(255).optional(),
    prefix: z.string().trim().max(512).optional(),
    accessKeyId: z.string().trim().max(256).optional(),
    secretAccessKey: z.string().max(512).optional(),
    pathStyle: z.boolean().optional(),
  }).optional(),
  passphrase: z.string().max(256).optional(),
  schedule: scheduleSchema,
  keep: z.number().int().min(1).max(100),
});

function assertHttpsUrl(value: string | undefined, label: string) {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} 不是有效的地址`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} 只支持 https:// 开头的地址`);
  if (url.username || url.password) throw new Error(`${label} 里不要写账号密码，请填在下面的输入框里`);
}

/** trpc.ops.offsiteBackup.* —— 异地自动备份（#10），只有管理员能用。 */
export const offsiteBackupRouter = router({
  get: adminProcedure.query(async () => {
    const data = await readOffsiteBackupSettingsForClient();
    return {
      ...data,
      nextRunAt: data.destination === "off" || !data.hasPassphrase
        ? null
        : nextBackupAt(data.schedule, Date.now(), data.status.lastSuccessAt),
    };
  }),

  save: adminProcedure.input(settingsSchema).mutation(async ({ input }) => {
    if (input.passphrase && input.passphrase.length < 8) throw new Error("备份口令至少 8 位");
    assertHttpsUrl(input.webdav?.url, "WebDAV 地址");
    assertHttpsUrl(input.s3?.endpoint, "S3 地址");
    if (input.destination !== "off") {
      const current = await readOffsiteBackupSettingsForClient();
      if (!input.passphrase && !current.hasPassphrase) throw new Error("请先设置备份口令");
    }
    await saveOffsiteBackupSettings(input);
    return { success: true };
  }),

  testConnection: adminProcedure.mutation(async () => {
    const message = await testOffsiteBackupConnection();
    return { message };
  }),

  runNow: adminProcedure.mutation(async () => runOffsiteBackup("manual")),

  list: adminProcedure.query(async () => listOffsiteBackups()),

  /**
   * 从远端取回一份备份并恢复。会替换当前数据，界面上要二次确认，并且要再输一次口令 ——
   * 存在设置里的口令不拿来用：恢复是一件要人亲手确认的事。
   * 解密、防重复、导入、通知 Agent 全部交给 system.importPanelBackup，和手动导入走同一条路。
   */
  restore: adminProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(128),
      password: z.string().min(1, "请输入备份口令").max(256),
      confirmed: z.literal(true),
    }))
    .mutation(async ({ input, ctx }) => {
      const content = await downloadOffsiteBackup(input.name);
      return systemRouter.createCaller(ctx).importPanelBackup({
        content,
        password: input.password,
        confirmed: true,
      });
    }),
});
