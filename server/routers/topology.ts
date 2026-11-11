import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getNetworkTopology } from "../networkTopology";
import {
  createTopologyManualLink,
  createTopologyManualNode,
  deleteTopologyManualLink,
  deleteTopologyManualNode,
  listTopologyManual,
  TopologyManualError,
  updateTopologyManualNode,
} from "../topologyManual";
import { mergeTopologyManual, parseTopologyManualRef, TOPOLOGY_MANUAL_LIMITS, type TopologyManualHost } from "../../shared/topologyManual";
import { requireHostAccess } from "./helpers";

/**
 * 网络拓扑：整张图一次给。管理员看全站，可以按用户筛；普通用户只看自己的规则、隧道、
 * 转发组、入站和它们经过的主机（看不见的中转打码），传 userId 也不认。
 *
 * manual* 是当前账号自己在图上手动标注的外部节点 / 连线（shared/topologyManual.ts）：只是展示，
 * 不碰任何转发配置；graph 返回时并进图里（管理员按用户筛时，画的仍是管理员自己的那份标注）。
 */
type Viewer = { user: { id: number; role: string } };

async function canUseHost(ctx: Viewer, hostId: number) {
  try {
    await requireHostAccess(ctx, hostId);
    return true;
  } catch {
    return false;
  }
}

/** 连线引用到的主机里，这个人看得见的那几台（图上没有它们时补节点用）。 */
async function visibleManualHosts(ctx: Viewer, refs: string[]) {
  const ids = Array.from(new Set(refs.map(parseTopologyManualRef).flatMap((ref) => (ref?.type === "host" ? [ref.id] : []))));
  const out = new Map<number, TopologyManualHost>();
  for (const id of ids.slice(0, TOPOLOGY_MANUAL_LIMITS.links)) {
    try {
      const host = await requireHostAccess(ctx, id);
      out.set(id, {
        name: String(host.name || `主机 ${id}`),
        address: host.entryIp || host.ip ? String(host.entryIp || host.ip) : null,
        online: !!host.isOnline,
        country: host.geoCountryCode ? String(host.geoCountryCode).toUpperCase() : null,
      });
    } catch {
      // 看不见的主机不补节点，那条线也就不画
    }
  }
  return out;
}

function manualError(error: unknown): never {
  if (error instanceof TopologyManualError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  throw error;
}

const nodeInput = z.object({
  label: z.string().trim().min(1).max(TOPOLOGY_MANUAL_LIMITS.label),
  note: z.string().trim().max(TOPOLOGY_MANUAL_LIMITS.note).nullable().optional(),
  country: z.string().trim().max(8).nullable().optional(),
});
const refInput = z.string().trim().min(3).max(191);

export const topologyRouter = router({
  graph: protectedProcedure
    .input(z.object({ userId: z.number().int().positive().nullable().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const viewer = { id: Number(ctx.user.id), role: String(ctx.user.role || "user") };
      const graph = await getNetworkTopology(viewer, { userId: input?.userId ?? null });
      const manual = await listTopologyManual(viewer.id);
      if (manual.nodes.length === 0 && manual.links.length === 0) return graph;
      const hosts = await visibleManualHosts({ user: viewer }, manual.links.flatMap((link) => [link.fromRef, link.toRef]));
      return { ...graph, ...mergeTopologyManual(graph, manual, hosts) };
    }),

  manual: protectedProcedure.query(async ({ ctx }) => listTopologyManual(Number(ctx.user.id))),

  createManualNode: protectedProcedure
    .input(nodeInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return { id: await createTopologyManualNode(Number(ctx.user.id), input) };
      } catch (error) {
        manualError(error);
      }
    }),

  updateManualNode: protectedProcedure
    .input(nodeInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await updateTopologyManualNode(Number(ctx.user.id), input.id, input);
        return { success: true };
      } catch (error) {
        manualError(error);
      }
    }),

  deleteManualNode: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await deleteTopologyManualNode(Number(ctx.user.id), input.id);
        return { success: true };
      } catch (error) {
        manualError(error);
      }
    }),

  createManualLink: protectedProcedure
    .input(z.object({
      fromRef: refInput,
      toRef: refInput,
      label: z.string().trim().max(TOPOLOGY_MANUAL_LIMITS.label).nullable().optional(),
      note: z.string().trim().max(TOPOLOGY_MANUAL_LIMITS.note).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const viewer = { user: { id: Number(ctx.user.id), role: String(ctx.user.role || "user") } };
      try {
        return { id: await createTopologyManualLink(viewer.user.id, input, (hostId) => canUseHost(viewer, hostId)) };
      } catch (error) {
        manualError(error);
      }
    }),

  deleteManualLink: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await deleteTopologyManualLink(Number(ctx.user.id), input.id);
        return { success: true };
      } catch (error) {
        manualError(error);
      }
    }),
});
