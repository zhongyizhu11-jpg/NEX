import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { UI_THEME_LIMITS } from "../../shared/uiThemePackage";
import {
  UiThemeError,
  exportUiThemeArchive,
  installOfficialUiTheme,
  installUiThemeFromArchive,
  installUiThemeFromUrl,
  listInstalledUiThemes,
  listOfficialUiThemes,
  uiThemeStarterArchive,
  uninstallUiTheme,
} from "../uiThemes";

/*
  trpc.uiThemes.* —— 设置 › 个性化 › 主题管理（只有管理员）。

  list               已安装的主题 + 官方主题库（哪些装了、哪些可更新）
  installOfficial    从官方主题库装一套（随面板发布，不用外网）
  installFromUpload  装一个上传的压缩包（base64；这一条的请求体上限放到 10MB，见 server/bodyParsers.ts）
  installFromUrl     填一个压缩包直链，面板去下
  uninstall          卸载（站点默认正用着它时，站点默认回到经典）
  exportArchive      把装着的一套打回压缩包
  starter            开发模板

  「现在用哪一套」不在这里：那是 system.updateSettings 的 personalizationUiTheme，和以前一样。
  所有人都要知道的那份名单（id、名字、预览色、样式版本）跟着 system.publicInfo 走。
*/
const themeIdInput = z.object({ id: z.string().min(1).max(64) });

function rethrow(error: unknown): never {
  if (error instanceof UiThemeError) throw new TRPCError({ code: error.code, message: error.message });
  throw error;
}

export const uiThemesRouter = router({
  list: adminProcedure.query(async () => ({
    installed: await listInstalledUiThemes(),
    official: await listOfficialUiThemes(),
    limits: { archiveBytes: UI_THEME_LIMITS.archiveBytes, installed: UI_THEME_LIMITS.installed },
  })),

  installOfficial: adminProcedure.input(themeIdInput).mutation(async ({ input }) => {
    try {
      return await installOfficialUiTheme(input.id);
    } catch (error) {
      rethrow(error);
    }
  }),

  installFromUpload: adminProcedure
    .input(z.object({
      // base64 比原文件大三分之一；多留一点给换行
      dataBase64: z.string().min(1).max(Math.ceil(UI_THEME_LIMITS.archiveBytes / 3) * 4 + 1024),
      replace: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const text = input.dataBase64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new TRPCError({ code: "BAD_REQUEST", message: "上传的文件读不出来，请重新选择压缩包" });
      try {
        return await installUiThemeFromArchive(Buffer.from(text, "base64"), { replace: input.replace === true, source: "upload" });
      } catch (error) {
        rethrow(error);
      }
    }),

  installFromUrl: adminProcedure
    .input(z.object({ url: z.string().trim().min(1).max(2000), replace: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      try {
        return await installUiThemeFromUrl(input.url, { replace: input.replace === true });
      } catch (error) {
        rethrow(error);
      }
    }),

  uninstall: adminProcedure.input(themeIdInput).mutation(async ({ input }) => {
    try {
      return await uninstallUiTheme(input.id);
    } catch (error) {
      rethrow(error);
    }
  }),

  exportArchive: adminProcedure.input(themeIdInput).query(async ({ input }) => {
    const exported = await exportUiThemeArchive(input.id);
    if (!exported) throw new TRPCError({ code: "NOT_FOUND", message: "这套主题没有安装" });
    return { filename: exported.filename, dataBase64: exported.archive.toString("base64") };
  }),

  starter: adminProcedure.query(() => {
    const starter = uiThemeStarterArchive();
    return { filename: starter.filename, dataBase64: starter.archive.toString("base64") };
  }),
});
