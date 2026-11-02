import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getLinkDiagnosticsReport, startLinkDiagnostics } from "../linkDiagnostics";
import { buildFaultBundle, faultBundleFilename } from "../faultBundle";
import { getSegmentSpeedRun } from "../lineSegmentSpeed";
import type { DiagnosticSubjectKind } from "@shared/linkDiagnostics";

/*
  诊断的统一入口（2.3.506）：按「对象类型 + id」。

  原来同一件事各有一套接口：规则的延迟测试是 rules.startSelfTest / rules.latestTest，隧道是
  tunnels.test / tunnels.getById 上的 lastTest*，转发链是 forwardGroups.test / forwardGroups.latestTest；
  测带宽是 lineDiagnostics.segmentSpeedStart（线路）和 lookingGlass.pairSpeedStart（隧道、两台机器）。
  这里不另写一份实现：每个过程都转调原来那个（同一个权限检查、同一把锁），只是把入参和结果统一了。
  旧过程全都留着 —— 网页、MCP 和老版本的客户端都还在用。

  kind=line 是开了线路组的规则：清单和延迟测试按规则算（规则那一套本来就会把线路组的每条路径带上），
  测带宽测的是线路此刻在走的那条（或者 pathKey 指定的那条）。
*/

export const DIAGNOSTICS_KINDS = ["rule", "line", "tunnel", "forwardGroup"] as const;
export type DiagnosticsKind = (typeof DIAGNOSTICS_KINDS)[number];

/** 清单（一键诊断）和故障包按哪种对象算：线路就是那条规则。 */
export function checklistKindOf(kind: DiagnosticsKind): DiagnosticSubjectKind {
  return kind === "line" ? "rule" : kind;
}

/** 统一后的「上一次延迟测试」：三种对象原来各是各的字段名。 */
export type LatencyResult = {
  kind: DiagnosticsKind;
  id: number;
  /** pending / running / success / failed / timeout；还没测过是 null。 */
  status: string | null;
  testing: boolean;
  latencyMs: number | null;
  /** Agent 报上来的原文（结构化的，前端用 parseLinkTestMessage 解）。 */
  message: string | null;
  at: string | null;
};

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(typeof value === "number" && value < 1e12 ? value * 1000 : (value as any));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 规则、转发链：forward_tests 的一行（rules.latestTest / forwardGroups.latestTest 的返回）。 */
export function latencyFromTestRow(kind: DiagnosticsKind, id: number, row: any): LatencyResult {
  const status = row?.status ? String(row.status) : null;
  return {
    kind,
    id,
    status,
    testing: status === "pending" || status === "running",
    latencyMs: finiteOrNull(row?.latencyMs),
    message: row?.message === null || row?.message === undefined ? null : String(row.message),
    at: isoOrNull(row?.updatedAt ?? row?.createdAt),
  };
}

/** 隧道：结果记在隧道本身（tunnels.getById 的 lastTest*）。 */
export function latencyFromTunnel(id: number, tunnel: any): LatencyResult {
  const status = tunnel?.lastTestStatus ? String(tunnel.lastTestStatus) : null;
  return {
    kind: "tunnel",
    id,
    status,
    testing: status === "pending" || status === "running",
    latencyMs: finiteOrNull(tunnel?.lastLatencyMs),
    message: tunnel?.lastTestMessage === null || tunnel?.lastTestMessage === undefined ? null : String(tunnel.lastTestMessage),
    at: isoOrNull(tunnel?.lastTestAt),
  };
}

const subjectInput = z.object({
  kind: z.enum(DIAGNOSTICS_KINDS),
  id: z.number().int().positive(),
});

/** 各个旧路由按需要再加载：它们和这里没有先后依赖，静态引入会把整个路由树绕成一个环。 */
async function callers(ctx: any) {
  const [{ rulesRouter }, { tunnelsRouter }, { forwardGroupsRouter }] = await Promise.all([
    import("./rules"),
    import("./tunnels"),
    import("./forwardGroups"),
  ]);
  return {
    rules: rulesRouter.createCaller(ctx) as any,
    tunnels: tunnelsRouter.createCaller(ctx) as any,
    forwardGroups: forwardGroupsRouter.createCaller(ctx) as any,
  };
}

/**
 * 一键链路诊断。start 当场给出面板侧的结论、给涉及的主机排 diagnostics 任务；
 * 浏览器每 2 秒拿 sessionId 来问 status，主机回报一项清单就更新一项。
 * 管理员什么都能诊断，普通用户只能诊断自己的规则 / 隧道 / 转发链（权限在 linkDiagnostics 里查）。
 */
export const diagnosticsRouter = router({
  start: protectedProcedure
    .input(subjectInput)
    .mutation(({ input, ctx }) => startLinkDiagnostics(ctx, { kind: checklistKindOf(input.kind), id: input.id })),

  status: protectedProcedure
    .input(z.object({ sessionId: z.string().min(8).max(64) }))
    .query(({ input, ctx }) => getLinkDiagnosticsReport(ctx, input.sessionId)),

  /**
   * 一键故障包（见 server/faultBundle.ts）：只读，不给主机派任务。
   * 是 query 不是 mutation：只读 API 令牌、MCP 的只读工具也能取。
   */
  faultBundle: protectedProcedure
    .input(subjectInput)
    .query(async ({ input, ctx }) => {
      const subject = { kind: checklistKindOf(input.kind), id: input.id };
      return {
        filename: faultBundleFilename(subject),
        bundle: await buildFaultBundle(ctx, subject),
      };
    }),

  /** 延迟测试：转调 rules.startSelfTest / tunnels.test / forwardGroups.test。结果用 latencyStatus 轮询。 */
  latencyStart: protectedProcedure
    .input(subjectInput)
    .mutation(async ({ input, ctx }) => {
      const call = await callers(ctx);
      if (input.kind === "tunnel") await call.tunnels.test({ id: input.id });
      else if (input.kind === "forwardGroup") await call.forwardGroups.test({ groupId: input.id });
      else await call.rules.startSelfTest({ ruleId: input.id });
      return { kind: input.kind, id: input.id, started: true };
    }),

  /** 上一次（或正在跑的）延迟测试，三种对象一个样子。没测过 / 看不到时 status 为 null。 */
  latencyStatus: protectedProcedure
    .input(subjectInput)
    .query(async ({ input, ctx }): Promise<LatencyResult> => {
      const call = await callers(ctx);
      if (input.kind === "tunnel") return latencyFromTunnel(input.id, await call.tunnels.getById({ id: input.id }));
      if (input.kind === "forwardGroup") return latencyFromTestRow("forwardGroup", input.id, await call.forwardGroups.latestTest({ groupId: input.id, includeActive: true }));
      return latencyFromTestRow(input.kind, input.id, await call.rules.latestTest({ ruleId: input.id, includeActive: true }));
    }),

  /**
   * 测带宽：线路逐段（lineDiagnostics.segmentSpeedStart，pathKey 不给就是此刻在走的那条）、
   * 隧道按经过的机器拆段（lookingGlass.pairSpeedStart）。两种都是 server/lineSegmentSpeed.ts 跑的，
   * 返回同一种进度（SegmentSpeedRunView），用 speedStatus 轮询。
   */
  speedStart: protectedProcedure
    .input(z.object({
      kind: z.enum(["line", "tunnel"]),
      id: z.number().int().positive(),
      pathKey: z.string().min(1).max(64).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (input.kind === "tunnel") {
        const { lookingGlassRouter } = await import("./lookingGlass");
        return (lookingGlassRouter.createCaller(ctx as any) as any).pairSpeedStart({ tunnelId: input.id });
      }
      let pathKey = input.pathKey;
      if (!pathKey) {
        const status = await (await callers(ctx)).rules.routeStatus({ ruleId: input.id });
        const paths = (status?.paths || []) as Array<{ key: string; active?: boolean }>;
        pathKey = (paths.find((path) => path.active) || paths[0])?.key;
        if (!pathKey) throw new Error("这条规则没有开线路组");
      }
      const { lineDiagnosticsRouter } = await import("./lineDiagnostics");
      return (lineDiagnosticsRouter.createCaller(ctx as any) as any).segmentSpeedStart({ ruleId: input.id, pathKey });
    }),

  speedStatus: protectedProcedure
    .input(z.object({ runId: z.string().min(8).max(64) }))
    .query(async ({ input, ctx }) => {
      const run = getSegmentSpeedRun(input.runId, ctx.user);
      if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "测速任务不存在或已过期" });
      return run;
    }),
});
