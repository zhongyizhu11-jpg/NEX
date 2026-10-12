import { z } from "zod";
import { adminProcedure, publicProcedure, router } from "../../_core/trpc";
import {
  getMaintenanceState,
  MAINTENANCE_BASE_MESSAGE,
  MAINTENANCE_MESSAGE_MAX_LENGTH,
  saveMaintenanceState,
} from "../../ops/maintenance";
import { recordPanelEvent } from "../../ops/panelEvents";

/**
 * trpc.ops.maintenance.* —— 设置 › 进阶 › 维护模式（#14）。
 *
 * get 是公开的：登录页和顶部横幅要在没登录 / 被挡住的时候也能读到「在维护、说明是什么」。
 * 只给开关和说明，不给别的。
 */
export const maintenanceRouter = router({
  get: publicProcedure.query(async () => {
    const state = await getMaintenanceState();
    return { enabled: state.enabled, message: state.message, baseMessage: MAINTENANCE_BASE_MESSAGE };
  }),

  set: adminProcedure
    .input(z.object({
      enabled: z.boolean(),
      message: z.string().max(MAINTENANCE_MESSAGE_MAX_LENGTH, `说明最多 ${MAINTENANCE_MESSAGE_MAX_LENGTH} 个字`).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const previous = await getMaintenanceState();
      const next = await saveMaintenanceState({ enabled: input.enabled, message: input.message ?? previous.message });
      if (previous.enabled !== next.enabled) {
        const who = ctx.user.name || ctx.user.username;
        void recordPanelEvent({
          kind: "ops.maintenance",
          level: next.enabled ? "warn" : "info",
          userId: ctx.user.id,
          message: next.enabled
            ? `${who} 开启了维护模式，普通用户暂时无法登录和操作${next.message ? `（${next.message}）` : ""}`
            : `${who} 关闭了维护模式，普通用户恢复正常使用`,
          data: { enabled: next.enabled, message: next.message || null },
        });
        console.info(`[Maintenance] ${next.enabled ? "enabled" : "disabled"} by userId=${ctx.user.id}`);
      }
      return next;
    }),
});
