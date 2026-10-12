import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { isHostConsideredOnline } from "../../hostHeartbeatPolicy";
import { hostSupportsAgentExt } from "../../ops/agentExt";
import {
  getRestartAllStatus,
  getScan,
  getStop,
  importedRuleFor,
  rememberImportedRule,
  setImportedRuleEnabler,
  startRestartAllRequest,
  startScan,
  startStopOriginal,
} from "../../ops/hostOpsAgent";
import { classifyRestartTargets, listenAddrNote, scanItemToRuleInput, type ScanItem } from "../../ops/hostOpsLogic";
import { recordPanelEvent } from "../../ops/panelEvents";

/*
  trpc.ops.hostOps.* —— 全部重启（#15）、导入现有配置（#16）。全部只给管理员。

  导入走的是和「新建规则」完全相同的那条路（rules.create，同样的校验、端口检查、配额），
  规则归当前管理员，先建成停用的 —— 原来的服务还占着端口。「停掉原服务并启用规则」
  由 Agent 停掉那一项后，面板再用 rules.toggle 同一个函数把规则打开。
*/

setImportedRuleEnabler(async (actor, ruleId) => {
  // 动态导入：rules 路由那一串模块很重，也免得和 ops 路由互相引用。
  const { toggleForwardRuleForActor } = await import("../rules.crud");
  await toggleForwardRuleForActor(actor, ruleId, true, { reasonPrefix: "ops-import" });
});

function hostLabel(host: any, id: number) {
  return String(host?.name || "").trim() || `#${id}`;
}

async function restartTargets() {
  const hosts = await db.getHostOptions();
  return classifyRestartTargets((hosts as any[]).map((host) => ({
    id: Number(host.id),
    name: hostLabel(host, Number(host.id)),
    online: isHostConsideredOnline(host),
    agentVersion: host.agentVersion,
  })));
}

async function requireExtHost(hostId: number) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  if (!hostSupportsAgentExt(host as any)) throw new Error("需要把 Agent 升级到 2.2.216");
  return host;
}

async function annotateScanItems(hostId: number, items: ScanItem[]) {
  const unitCounts = new Map<string, number>();
  for (const item of items) if (item.unit) unitCounts.set(item.unit, (unitCounts.get(item.unit) || 0) + 1);
  return Promise.all(items.map(async (item) => {
    const converted = scanItemToRuleInput(item);
    let conflict: string | null = null;
    if ("input" in converted) {
      const used = await db.isPortUsedOnHost(hostId, converted.input.sourcePort, undefined, converted.input.protocol).catch(() => false);
      if (used) conflict = "面板里已经有规则（或隧道、中转）占着这个端口";
    }
    const importedRuleId = importedRuleFor(hostId, item.key);
    return {
      ...item,
      forwardType: "input" in converted ? converted.input.forwardType : null,
      canImport: "input" in converted && !conflict && !importedRuleId,
      blockedReason: "error" in converted ? converted.error : conflict,
      note: listenAddrNote(item),
      // 同一个服务里还有几条别的转发：停这个服务会一起停掉。
      sharedWith: item.unit ? Math.max(0, (unitCounts.get(item.unit) || 1) - 1) : 0,
      canStop: !!item.unit || item.tool === "iptables" || item.tool === "nftables",
      importedRuleId,
    };
  }));
}

export const hostOpsRouter = router({
  // ---------------------------------------------------------------- 全部重启
  restartAllPreview: adminProcedure.query(async () => {
    const { targets, skipped } = await restartTargets();
    return { targets: targets.map((host) => ({ id: host.id, name: host.name })), skipped };
  }),

  restartAll: adminProcedure.mutation(async ({ ctx }) => {
    const { targets, skipped } = await restartTargets();
    if (targets.length === 0) throw new Error("没有可以重启的在线主机");
    const requestId = startRestartAllRequest({
      userId: Number(ctx.user.id),
      targets: targets.map((host) => ({ id: host.id, name: host.name })),
      skipped,
    });
    await recordPanelEvent({
      kind: "ops.restart_all",
      level: "info",
      userId: Number(ctx.user.id),
      message: `发起全部重启：${targets.length} 台主机${skipped.length > 0 ? `，跳过 ${skipped.length} 台` : ""}`,
      data: { requestId, targetHostIds: targets.map((host) => host.id), skipped },
    });
    return { requestId, targetCount: targets.length, skipped };
  }),

  restartAllStatus: adminProcedure
    .input(z.object({ requestId: z.string().min(1).max(64) }))
    .query(({ input }) => {
      const status = getRestartAllStatus(input.requestId);
      if (!status) throw new Error("这次重启的记录已经过期");
      return status;
    }),

  // ---------------------------------------------------------------- 导入现有配置
  scan: adminProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const host = await requireExtHost(input.hostId);
      if (!isHostConsideredOnline(host)) throw new Error("主机离线，扫描不了");
      return { scanId: startScan(input.hostId) };
    }),

  scanResult: adminProcedure
    .input(z.object({ hostId: z.number().int().positive(), scanId: z.string().min(1).max(64) }))
    .query(async ({ input }) => {
      const scan = getScan(input.hostId, input.scanId);
      if (!scan) throw new Error("这次扫描的结果已经过期，请重新扫描");
      return {
        scanId: scan.scanId,
        status: scan.status,
        finishedAt: scan.finishedAt,
        items: scan.status === "done" ? await annotateScanItems(input.hostId, scan.items) : [],
      };
    }),

  importItems: adminProcedure
    .input(z.object({
      hostId: z.number().int().positive(),
      scanId: z.string().min(1).max(64),
      keys: z.array(z.string().regex(/^[0-9a-f]{1,64}$/i)).min(1).max(100),
    }))
    .mutation(async ({ input, ctx }) => {
      const host = await requireExtHost(input.hostId);
      const scan = getScan(input.hostId, input.scanId);
      if (!scan || scan.status !== "done") throw new Error("这次扫描的结果已经过期，请重新扫描");
      const { rulesRouter } = await import("../rules");
      const caller = rulesRouter.createCaller(ctx as any);
      const results: Array<{ key: string; ok: boolean; ruleId?: number; error?: string }> = [];
      for (const key of Array.from(new Set(input.keys))) {
        const item = scan.items.find((candidate) => candidate.key === key);
        if (!item) {
          results.push({ key, ok: false, error: "这一项不在扫描结果里" });
          continue;
        }
        const existing = importedRuleFor(input.hostId, key);
        if (existing) {
          results.push({ key, ok: true, ruleId: existing });
          continue;
        }
        const converted = scanItemToRuleInput(item);
        if ("error" in converted) {
          results.push({ key, ok: false, error: converted.error });
          continue;
        }
        try {
          const created: any = await caller.create({
            hostId: input.hostId,
            ...converted.input,
            // 原来的服务还占着端口：先建成停用的，等「停掉原服务」后再启用。
            isEnabled: false,
          });
          const ruleId = Number(created?.id || 0);
          if (ruleId > 0) rememberImportedRule(input.hostId, key, ruleId);
          results.push({ key, ok: ruleId > 0, ruleId, error: ruleId > 0 ? undefined : "没拿到新规则的编号" });
        } catch (error) {
          results.push({ key, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const imported = results.filter((item) => item.ok).length;
      if (imported > 0) {
        await recordPanelEvent({
          kind: "ops.import_existing",
          level: "info",
          hostId: input.hostId,
          userId: Number(ctx.user.id),
          message: `从 ${hostLabel(host, input.hostId)} 导入了 ${imported} 条现有转发（先停用）`,
          data: { ruleIds: results.filter((item) => item.ok).map((item) => item.ruleId) },
        });
      }
      return { results, imported };
    }),

  stopOriginal: adminProcedure
    .input(z.object({
      hostId: z.number().int().positive(),
      scanId: z.string().min(1).max(64),
      key: z.string().regex(/^[0-9a-f]{1,64}$/i),
    }))
    .mutation(async ({ input, ctx }) => {
      const host = await requireExtHost(input.hostId);
      if (!isHostConsideredOnline(host)) throw new Error("主机离线，现在停不了");
      const scan = getScan(input.hostId, input.scanId);
      const item = scan?.items.find((candidate) => candidate.key === input.key);
      if (!item) throw new Error("这次扫描的结果已经过期，请重新扫描");
      const ruleId = importedRuleFor(input.hostId, input.key);
      if (!ruleId) throw new Error("先导入为规则，再停掉原服务");
      const rule: any = await db.getForwardRuleById(ruleId);
      if (!rule || Number(rule.hostId) !== input.hostId) throw new Error("导入的规则已经不在了");
      const label = item.unit ? `${item.tool}（${item.unit}）` : `${item.tool} 的 ${item.listenPort} 端口转发`;
      const actionId = startStopOriginal({
        hostId: input.hostId,
        key: input.key,
        ruleId,
        label,
        actor: { id: Number(ctx.user.id), role: String(ctx.user.role) },
      });
      return { actionId };
    }),

  stopStatus: adminProcedure
    .input(z.object({ hostId: z.number().int().positive(), actionId: z.string().min(1).max(64) }))
    .query(({ input }) => {
      const stop = getStop(input.hostId, input.actionId);
      if (!stop) throw new Error("这次操作的记录已经过期");
      return stop;
    }),
});
