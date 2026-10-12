import { z } from "zod";
import * as db from "../../db";
import { adminProcedure, router } from "../../_core/trpc";
import { DIGEST_BLOCK_KEYS } from "../../../shared/opsDigest";
import { getDigestSettings, saveDigestSettings } from "../../ops/digestContent";
import { buildTelegramDigestText, sendTelegramMessage } from "../../telegramBot";
import { isTelegramBotReady } from "../../telegramReady";
import { isTelegramDigestEnabled, readTelegramNotifyPrefs } from "../../telegramNotifyPrefs";

/*
  trpc.ops.digest.* —— 设置 › Telegram 底部「每日简报」：几点发、管理员简报里多带哪几块。

  「现在发一条试试」发给的正是到点会收到简报的那些管理员（绑了 Telegram、没在机器人里关掉简报），
  内容和到点发的一样 —— 不写「今天已发」的标记，到点照常发。
*/

const blockSchema = z.enum(DIGEST_BLOCK_KEYS as unknown as [string, ...string[]]);

export const digestRouter = router({
  get: adminProcedure.query(async () => {
    const [settings, telegramReady] = await Promise.all([getDigestSettings(), isTelegramBotReady()]);
    return { ...settings, telegramReady };
  }),

  save: adminProcedure
    .input(z.object({
      hour: z.number().int().min(0).max(23),
      blocks: z.array(blockSchema).max(DIGEST_BLOCK_KEYS.length),
    }))
    .mutation(({ input }) => saveDigestSettings(input)),

  sendTest: adminProcedure.mutation(async () => {
    if (!(await isTelegramBotReady())) throw new Error("Telegram 机器人还没启用或没填 Token");
    const prefs = await readTelegramNotifyPrefs();
    const admins = (await db.getTelegramAdminRecipients() as any[])
      .filter((admin) => !!admin.telegramId && isTelegramDigestEnabled(prefs, { id: admin.id, role: "admin" }));
    if (admins.length === 0) {
      throw new Error("没有管理员会收到简报：要先在机器人里绑定 Telegram，并且没关掉每日简报");
    }
    let sent = 0;
    const failures: string[] = [];
    for (const admin of admins) {
      try {
        const user = await db.getUserById(Number(admin.id)) as any;
        if (!user?.telegramId || user.accountEnabled === false) continue;
        await sendTelegramMessage(user.telegramId, await buildTelegramDigestText(user));
        sent += 1;
      } catch (error) {
        failures.push(`${admin.name || admin.username || `#${admin.id}`}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (sent === 0 && failures.length > 0) throw new Error(`发送失败：${failures[0]}`);
    return { sent, failed: failures.length, failures: failures.slice(0, 5) };
  }),
});
