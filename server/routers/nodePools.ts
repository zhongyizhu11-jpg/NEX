import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { lineDiagnosticsRouter } from "./lineDiagnostics";

/*
  节点池的接口（2.3.506）：nodePools.*。

  节点池最早是线路诊断那一批一起做的，接口就挂在了 lineDiagnostics 下面（lineDiagnostics.nodePools /
  nodePoolSave / …），和「诊断」没关系，找起来也费劲。这里起一组正名，直接用原来那几个过程（同一份实现、
  同一套权限）；lineDiagnostics 下的旧名字照留：MCP、老版本的客户端还在调。
*/
const legacy = lineDiagnosticsRouter._def.procedures;

export const nodePoolsRouter = router({
  /** 节点池那一页：节点池 + 入口组 + 出口组合成一种卡（= lineDiagnostics.poolBoard）。 */
  board: legacy.poolBoard,
  /** 列表（= lineDiagnostics.nodePools）。 */
  list: legacy.nodePools,
  /** 建 / 改（= lineDiagnostics.nodePoolSave）。 */
  save: legacy.nodePoolSave,
  /** 落地池直连域名「自动」（= lineDiagnostics.nodePoolSuggestDomain）。 */
  suggestDomain: legacy.nodePoolSuggestDomain,
  /** 落地池换密钥（= lineDiagnostics.nodePoolRotate）。 */
  rotate: legacy.nodePoolRotate,
  /** 删（= lineDiagnostics.nodePoolDelete）。 */
  delete: legacy.nodePoolDelete,
  /** 从入口组 / 出口组带入（= lineDiagnostics.nodePoolImport）。 */
  import: legacy.nodePoolImport,
  /** 拖动排序（2.3.509）：被拖的几个在原来的座位里换；管理员排全部，别人排自己的。 */
  reorder: protectedProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(1000) }))
    .mutation(async ({ input, ctx }) => {
      const { reorderNodePools } = await import("../nodePools");
      await reorderNodePools(ctx.user.role === "admin" ? null : ctx.user.id, input.ids);
      return { success: true };
    }),
});
