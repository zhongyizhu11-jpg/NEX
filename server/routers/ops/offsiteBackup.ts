import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import { systemRouter } from "../../_core/systemRouter";
import {
  downloadOffsiteBackup,
  listOffsiteBackups,
  OFFSITE_BACKUP_TARGETS,
  readOffsiteBackupSettingsForClient,
  runOffsiteBackup,
  saveOffsiteBackupSettings,
  testOffsiteBackupConnection,
} from "../../ops/offsiteBackup";

const hourSchema = z.number().int().min(0).max(23);
const scheduleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("daily"), hour: hourSchema }),
  z.object({ mode: z.literal("weekly"), weekday: z.number().int().min(0).max(6), hour: hourSchema }),
  z.object({ mode: z.literal("interval"), everyHours: z.number().int().min(1).max(168) }),
]);

const settingsSchema = z.object({
  /** 开着的目的地；空数组 = 关闭 */
  destinations: z.array(z.enum(OFFSITE_BACKUP_TARGETS)).max(OFFSITE_BACKUP_TARGETS.length),
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

/** trpc.ops.offsiteBackup.* —— 异地自动备份（#10），只有管理员能用。写操作由操作审计中间件记一行（密钥打码）。 */
export const offsiteBackupRouter = router({
  get: adminProcedure.query(async () => readOffsiteBackupSettingsForClient()),

  save: adminProcedure.input(settingsSchema).mutation(async ({ input }) => {
    if (input.passphrase && input.passphrase.length < 8) throw new Error("备份口令至少 8 位");
    assertHttpsUrl(input.webdav?.url, "WebDAV 地址");
    assertHttpsUrl(input.s3?.endpoint, "S3 地址");
    if (input.destinations.length > 0) {
      // 开着就会按点自动跑：口令和地址这些必填的缺了，现在就说，别等到半夜失败。
      const current = await readOffsiteBackupSettingsForClient();
      if (!input.passphrase && !current.hasPassphrase) throw new Error("请先设置备份口令");
      if (input.destinations.includes("webdav")) {
        if (!(input.webdav?.url ?? current.webdav.url)) throw new Error("请填写 WebDAV 地址");
      }
      if (input.destinations.includes("s3")) {
        if (!(input.s3?.endpoint ?? current.s3.endpoint) || !(input.s3?.bucket ?? current.s3.bucket)) throw new Error("请填写 S3 地址和存储桶");
        if (!(input.s3?.accessKeyId ?? current.s3.accessKeyId) || !(input.s3?.secretAccessKey || current.s3.hasSecretKey)) {
          throw new Error("请填写 Access Key 和 Secret Key");
        }
      }
    }
    await saveOffsiteBackupSettings(input);
    return { success: true };
  }),

  testConnection: adminProcedure.mutation(async () => {
    const message = await testOffsiteBackupConnection();
    return { message };
  }),

  runNow: adminProcedure.mutation(async () => runOffsiteBackup("manual")),

  /** 各个目的地上现有的备份。要去请求远端，界面上点了「从远端恢复」才查。 */
  list: adminProcedure.query(async () => listOffsiteBackups()),

  /**
   * 从远端取回一份备份并恢复。会替换当前数据，界面上要二次确认，并且要再输一次口令 ——
   * 存在设置里的口令不拿来用：恢复是一件要人亲手确认的事。
   * 解密、防重复、导入、通知 Agent 全部交给 system.importPanelBackup，和手动导入走同一条路。
   */
  restore: adminProcedure
    .input(z.object({
      destination: z.enum(OFFSITE_BACKUP_TARGETS),
      name: z.string().trim().min(1).max(128),
      password: z.string().min(1, "请输入备份口令").max(256),
      confirmed: z.literal(true),
    }))
    .mutation(async ({ input, ctx }) => {
      const content = await downloadOffsiteBackup(input.destination, input.name);
      return systemRouter.createCaller(ctx).importPanelBackup({
        content,
        password: input.password,
        confirmed: true,
      });
    }),
});
