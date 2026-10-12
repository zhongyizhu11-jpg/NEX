import { eq } from "drizzle-orm";

import { tunnels } from "../drizzle/schema";
import { getDb } from "./dbRuntime";
import { clearTunnelLinkShapingState } from "./repositories/tunnelLinkShapingRepository";
import { getSetting, setSetting } from "./repositories/settingsRepository";
import { appendPanelLog } from "./_core/panelLogger";

/*
  链路整形改成默认关（2026-10-12 用户要的：这类传输优化开关默认都该是关的）。

  以前新建隧道的链路整形默认是「自动」，于是没人动过的隧道也在偷偷探限速点，卡片上
  还跟着一行「正在找限速点」。新建的隧道现在默认关；已经建好的隧道里，档位还停在
  「自动」的那些也跟着关掉一次 —— 那个「自动」不是谁选的，是旧的默认值。

  只跑一次（记在 system_settings 里）：升级之后用户自己再打开「自动」的隧道不会被动。
  手动档和手动填的上限一律不动，那是明明白白设过的。
*/

export const LINK_SHAPING_DEFAULT_OFF_SETTING = "tunnel.linkShaping.defaultOffAt";

/** 升级到这个版本时把还停在旧默认值「自动」的隧道关掉；返回改了几条。只在第一次跑时真的改。 */
export async function applyLinkShapingDefaultOffOnce(): Promise<number> {
  if (await getSetting(LINK_SHAPING_DEFAULT_OFF_SETTING)) return 0;
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ id: tunnels.id })
    .from(tunnels)
    .where(eq(tunnels.linkShapingMode, "auto"));
  const ids = rows.map((row: any) => Number(row.id)).filter((id: number) => Number.isFinite(id) && id > 0);
  if (ids.length > 0) {
    await db.update(tunnels).set({ linkShapingMode: "off" } as any).where(eq(tunnels.linkShapingMode, "auto"));
    // 记着的整形状态一起收掉，不然卡片上那行字要等下一次心跳才消失。
    for (const id of ids) await clearTunnelLinkShapingState(id).catch(() => undefined);
    appendPanelLog("info", `[LinkShaping] 链路整形默认值改为关，已关闭 ${ids.length} 条沿用旧默认值的隧道`);
  }
  await setSetting(LINK_SHAPING_DEFAULT_OFF_SETTING, String(Math.floor(Date.now() / 1000)));
  return ids.length;
}
