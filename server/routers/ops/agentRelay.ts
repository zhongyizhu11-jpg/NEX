import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { isHostConsideredOnline } from "../../hostHeartbeatPolicy";
import { getConfiguredPanelUrl } from "../../agentPanelUrl";
import { hostSupportsAgentExt, wakeAgentExt } from "../../ops/agentExt";
import {
  autoSwitchStats,
  emptyRelayConfig,
  ensureRelayListenPort,
  getRelayReport,
  loadRelayConfigs,
  releaseRelayListenPortIfUnused,
  writeRelayConfig,
} from "../../ops/agentRelayAgent";
import {
  AUTO_SWITCH_THRESHOLD_CHOICES,
  normalizeThreshold,
  relayCandidateIssue,
  relayStatusLine,
} from "../../ops/agentRelayLogic";
import { recordPanelEvent } from "../../ops/panelEvents";

function hostLabel(host: any, id: number) {
  return String(host?.name || "").trim() || `#${id}`;
}

async function relayView(hostId: number) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  const configs = await loadRelayConfigs(true);
  const config = configs.get(hostId) || emptyRelayConfig(hostId);
  const hosts = await db.getHostOptions();
  const byId = new Map((hosts as any[]).map((row) => [Number(row.id), row]));
  const candidates = (hosts as any[])
    .filter((row) => Number(row.id) !== hostId)
    .map((row) => {
      const id = Number(row.id);
      const issue = relayCandidateIssue(
        { id, name: row.name, agentVersion: row.agentVersion, online: isHostConsideredOnline(row) },
        hostId,
        configs,
      );
      return { id, name: hostLabel(row, id), eligible: !issue, reason: issue };
    });
  const viaHost = config.viaHostId ? byId.get(config.viaHostId) : null;
  const viaName = config.viaHostId ? hostLabel(viaHost, config.viaHostId) : null;
  const stored = getRelayReport(hostId);
  const supported = hostSupportsAgentExt(host as any);
  const status = relayStatusLine({
    supported,
    configuredViaName: viaName,
    report: stored?.report || null,
    reportAgeSeconds: stored ? Math.round((Date.now() - stored.at) / 1000) : null,
  });
  // 这台机器作为中转那一面。
  const dependents = Array.from(configs.values())
    .filter((row) => row.viaHostId === hostId)
    .map((row) => ({ id: row.hostId, name: hostLabel(byId.get(row.hostId), row.hostId) }));
  const listen = stored?.report.listen || null;
  const viaConfig = config.viaHostId ? configs.get(config.viaHostId) : null;
  const panelUrlConfigured = !!(await getConfiguredPanelUrl().catch(() => ""));
  return {
    hostId,
    supported,
    viaHostId: config.viaHostId,
    viaHostName: viaName,
    viaPort: viaConfig?.listenPort ?? null,
    autoViaHostId: config.autoViaHostId,
    autoViaHostName: config.autoViaHostId ? hostLabel(byId.get(config.autoViaHostId), config.autoViaHostId) : null,
    autoThresholdMinutes: config.autoThresholdMinutes,
    autoThresholdChoices: [...AUTO_SWITCH_THRESHOLD_CHOICES],
    autoSwitchedAt: config.autoSwitchedAt,
    autoStats: config.autoViaHostId && !config.viaHostId ? autoSwitchStats(hostId) : null,
    status,
    report: stored ? { at: stored.at, relayedConnections: stored.report.relayedConnections ?? 0, rejectedConnections: stored.report.rejectedConnections ?? 0 } : null,
    relay: config.listenPort || dependents.length > 0
      ? {
        listenPort: config.listenPort,
        dependents,
        listening: !!listen?.listening,
        error: listen?.error || null,
      }
      : null,
    panelUrlConfigured,
    candidates,
  };
}

export const agentRelayRouter = router({
  get: adminProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .query(({ input }) => relayView(input.hostId)),

  save: adminProcedure
    .input(z.object({
      hostId: z.number().int().positive(),
      viaHostId: z.number().int().positive().nullable(),
      autoViaHostId: z.number().int().positive().nullable(),
      autoThresholdMinutes: z.number().int().min(1).max(240).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const host = await db.getHostById(input.hostId);
      if (!host) throw new Error("主机不存在");
      const configs = await loadRelayConfigs(true);
      const current = configs.get(input.hostId) || emptyRelayConfig(input.hostId);
      const checkCandidate = async (candidateId: number, label: string) => {
        const candidate = await db.getHostById(candidateId);
        if (!candidate) throw new Error(`${label}的主机不存在`);
        // 当前已经经由它、只是改别的设置时，不因为它此刻离线就拒绝保存。
        if (candidateId === current.viaHostId && label === "中转") return candidate;
        const issue = relayCandidateIssue(
          { id: candidateId, name: (candidate as any).name, agentVersion: (candidate as any).agentVersion, online: isHostConsideredOnline(candidate) },
          input.hostId,
          configs,
        );
        if (issue) throw new Error(`${hostLabel(candidate, candidateId)} 不能当中转：${issue}`);
        return candidate;
      };
      if (input.viaHostId) await checkCandidate(input.viaHostId, "中转");
      if (input.autoViaHostId && input.autoViaHostId !== current.autoViaHostId) await checkCandidate(input.autoViaHostId, "自动切换");
      if (input.autoViaHostId === input.hostId) throw new Error("不能经由自己");

      if (input.viaHostId) await ensureRelayListenPort(input.viaHostId);
      const latest = (await loadRelayConfigs(true)).get(input.hostId) || current;
      const next = {
        ...latest,
        viaHostId: input.viaHostId,
        autoViaHostId: input.autoViaHostId,
        autoThresholdMinutes: normalizeThreshold(input.autoThresholdMinutes ?? latest.autoThresholdMinutes),
        // 改了自动切换的目标、或者人手改回直连，就重新开始观察（允许以后再自动切一次）。
        autoSwitchedAt: input.autoViaHostId !== latest.autoViaHostId || (!input.viaHostId && latest.viaHostId) ? null : latest.autoSwitchedAt,
      };
      await writeRelayConfig(next);
      if (current.viaHostId && current.viaHostId !== input.viaHostId) await releaseRelayListenPortIfUnused(current.viaHostId);

      const name = hostLabel(host, input.hostId);
      if (current.viaHostId !== input.viaHostId) {
        const viaName = input.viaHostId ? hostLabel(await db.getHostById(input.viaHostId), input.viaHostId) : null;
        await recordPanelEvent({
          kind: "host.relay_switched",
          level: "info",
          hostId: input.hostId,
          userId: ctx.user.id,
          message: viaName ? `${name} 改为经由 ${viaName} 连面板` : `${name} 改回直连面板`,
          data: { viaHostId: input.viaHostId, previousViaHostId: current.viaHostId, auto: false },
        });
      }
      for (const id of new Set([input.hostId, input.viaHostId, current.viaHostId].filter(Boolean) as number[])) {
        wakeAgentExt(id, "relay-settings");
      }
      return relayView(input.hostId);
    }),
});
