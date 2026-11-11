import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { ensureFreshUserTrafficDaily, getUserTrafficHistory } from "../userTrafficHistory";

/*
  trpc.userTrafficHistory.daily —— 用户管理里「流量历史」对话框：某个用户最近 30 / 90 天每天的
  上传 / 下载和这段时间用量最多的规则。只给管理员；读的是 server/userTrafficHistory.ts 从已有
  流量桶汇总出来的日表，不新增采集。
*/
export const userTrafficHistoryRouter = router({
  daily: adminProcedure
    .input(z.object({ userId: z.number().int().positive(), days: z.union([z.literal(30), z.literal(90)]).default(30) }))
    .query(async ({ input }) => {
      const user = await db.getUserById(input.userId);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" });
      await ensureFreshUserTrafficDaily();
      return getUserTrafficHistory(input.userId, input.days);
    }),
});
