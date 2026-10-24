import { Router, Request, Response } from "express";
import * as db from "./db";
import { buildMetaAgentSelfTestPayload, buildRuleAgentSelfTestPayload, parseSelfTestMeta } from "./agentRouteUtils";
import { settleManualTunnelProbeBatch } from "./tunnelManualProbe";
import { settleManualForwardChainBatch } from "./forwardChainManualProbe";
import { forwardTestRequestMessage, isDurableForwardTestBatchId, TUNNEL_PROBE_BATCH_PREFIX } from "./repositories/forwardTestRepository";
import { appendPanelLog } from "./_core/panelLogger";
import { getAgentHostIdentityFromRequest } from "./agentAuth";
import { normalizeLinkProbeMethod } from "@shared/latencyProbe";
import { structuredLinkTestMessage } from "./linkTestMessages";
import {
  canReuseRecentTunnelLatencySample,
  combineTunnelRuleLatencySample,
  freshTunnelSegmentLatency,
  tunnelRuleLatencySampleSucceeded,
} from "./ruleLatency";
import { clearRuleLatencyQueryCache } from "./ruleLatencyQueryCache";
import { waitForTunnelLatencyRefresh } from "./tunnelLatencyRefresh";
import { getTunnelAutoHopDetails } from "./tunnelAutoLatencyState";
import { getTunnelMultiEntryHopDetails } from "./tunnelMultiEntryLatencyState";
import { tunnelProbeTopologyKey } from "./probeTopology";
import { isTunnelRelayFailover } from "../shared/tunnelRelay";
import {
  selectTunnelLatencyDetailPathKey,
  structuredTunnelMessageMatchesLatency,
  timestampMs,
  tunnelDetailsMatchTopology,
  tunnelLatencySampleIsAfterBaseline,
} from "./tunnelLatencyDetails";
import { FORWARD_TUNNEL_LATENCY_WAIT_MS } from "./selfTestTiming";

async function resolveSelfTestTarget(rule: any) {
  return rule?.targetIp;
}

async function isTunnelDetailsCurrent(tunnel: any, details: any[]) {
  const tunnelId = Number(tunnel?.id || 0);
  if (!tunnelId) return false;
  const [hops, exitNodes, entryHostIds] = await Promise.all([
    db.getTunnelHops(tunnelId).catch(() => []) as Promise<any[]>,
    db.getTunnelExitNodes(tunnelId).catch(() => []) as Promise<any[]>,
    tunnelEntryHostIdList(tunnel),
  ]);
  return tunnelDetailsMatchTopology({ tunnel, hops, exitNodes, entryHostIds, details });
}

async function tunnelEntryHostIdList(tunnel: any) {
  const ids = new Set<number>();
  const primary = Number(tunnel?.entryHostId || 0);
  if (primary > 0) ids.add(primary);
  const entryGroupId = Number(tunnel?.entryGroupId || 0);
  if (entryGroupId > 0) {
    const group = await db.getForwardGroupById(entryGroupId).catch(() => null) as any;
    if (group?.isEnabled && String(group.groupMode || "") === "entry") {
      for (const member of group.members || []) {
        const hostId = member?.isEnabled !== false && member?.memberType === "host" ? Number(member.hostId || 0) : 0;
        if (hostId > 0) ids.add(hostId);
      }
    }
  }
  return Array.from(ids).sort((left, right) => left - right);
}

async function loadFreshTunnelAutoDetails(tunnel: any, latestLatency: any) {
  const tunnelId = Number(tunnel?.id || 0);
  if (!tunnelId) return [];
  const [hops, exitNodes, entryHostIds] = await Promise.all([
    db.getTunnelHops(tunnelId).catch(() => []) as Promise<any[]>,
    db.getTunnelExitNodes(tunnelId).catch(() => []) as Promise<any[]>,
    tunnelEntryHostIdList(tunnel),
  ]);
  const topologyKey = tunnelProbeTopologyKey(tunnel, hops, exitNodes);
  const hopCount = isTunnelRelayFailover(tunnel, hops)
    ? 2
    : Array.isArray(hops) && hops.length >= 2 ? hops.length - 1 : 1;
  const referenceAt = timestampMs(latestLatency?.recordedAt);
  const batchSeries = await db.getTunnelLatencyBranchSeriesForTotal(
    tunnelId,
    Number(latestLatency?.id || 0),
  ).catch(() => []) as any[];
  const pathKey = selectTunnelLatencyDetailPathKey(latestLatency, batchSeries);
  let rawDetails: Array<{
    hopIndex: number;
    hopCount: number;
    fromHostId: number | null;
    toHostId: number | null;
    latencyMs: number | null;
    isTimeout: boolean;
  }> | null = null;
  if (entryHostIds.length > 1) {
    rawDetails = getTunnelMultiEntryHopDetails({
      tunnelId,
      expectedEntryHostIds: entryHostIds,
      hopCount,
      generation: `${topologyKey}:entries:${entryHostIds.join(",")}`,
      pathKey,
      referenceAt,
    });
  } else {
    rawDetails = getTunnelAutoHopDetails({
      tunnelId,
      hopCount,
      generation: topologyKey,
      pathKey,
      referenceAt,
    });
  }
  if (!rawDetails?.length) return [];

  const hostIds = Array.from(new Set(rawDetails.flatMap((detail) => [detail.fromHostId, detail.toHostId]
    .map((value) => Number(value || 0))
    .filter((value) => value > 0))));
  const hostRows = await Promise.all(hostIds.map((hostId) => db.getHostById(hostId).catch(() => null)));
  const hostNames = new Map(hostIds.map((hostId, index) => [
    hostId,
    String((hostRows[index] as any)?.name || `主机${hostId}`),
  ]));
  return rawDetails.map((detail, index) => {
    const fromId = Number(detail.fromHostId || 0) || 0;
    const toId = Number(detail.toHostId || 0) || 0;
    const fromName = hostNames.get(fromId) || (fromId > 0 ? `主机${fromId}` : `节点 ${index + 1}`);
    const toName = hostNames.get(toId) || (toId > 0 ? `主机${toId}` : `节点 ${index + 2}`);
    const success = !detail.isTimeout && typeof detail.latencyMs === "number" && detail.latencyMs > 0;
    return {
      success,
      latencyMs: success ? detail.latencyMs : null,
      message: success ? null : "隧道跳探测超时",
      fromHostId: fromId || null,
      toHostId: toId || null,
      hopIndex: detail.hopIndex,
      hopCount: detail.hopCount,
      hopLabel: `${detail.hopIndex + 1}/${detail.hopCount} ${fromId || fromName}->${toId || toName}`,
      routeLabel: `${fromName} -> ${toName}`,
      method: "tcp",
      pending: false,
    };
  });
}

export function registerAgentSelfTestRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/selftest-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const { testId, targetReachable, latencyMs, message, resolvedTargetIp } = req.body || {};
    if (!Number.isInteger(testId) || testId <= 0) {
      res.status(400).json({ error: "testId is required" });
      return;
    }
    const t = await db.getForwardTestById(testId);
    if (!t || t.hostId !== host.id) {
      res.status(404).json({ error: "test not found" });
      return;
    }
    // The Agent's result overwrites `message`; the dispatch payload lives in requestMessage.
    const meta = parseSelfTestMeta(forwardTestRequestMessage(t as any));
    const success = targetReachable === true;
    const cleanLatency = typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0
      ? Math.max(1, Math.round(latencyMs))
      : null;
    const cleanMessage = typeof message === "string" ? message.slice(0, 4000) : null;
    const cleanResolvedTargetIp = typeof resolvedTargetIp === "string" ? resolvedTargetIp.trim().slice(0, 255) : "";
    if (typeof targetReachable !== "boolean" || (success && cleanLatency === null)) {
      res.status(400).json({ error: "Invalid probe result: successful probes require a finite latency" });
      return;
    }
    const durableBatchId = String((t as any).batchId || "");
    if (isDurableForwardTestBatchId(durableBatchId)) {
      // Commit this hop's report on its own first, then try to aggregate the
      // batch from the database (whoever completes the last hop wins).
      const accepted = await db.completeForwardTestIfActive(testId, {
        status: success ? "success" : "failed",
        listenOk: true,
        targetReachable: success,
        forwardOk: success,
        latencyMs: success ? cleanLatency : null,
        message: cleanMessage,
      });
      const hopLabel = String((meta as any)?.hopLabel || "hop");
      if (accepted) {
        appendPanelLog(success ? "info" : "warn", `[SelfTest] batch=${durableBatchId} test=${testId} host=${host.id} ${hopLabel} success=${success} latency=${success ? `${cleanLatency}ms` : "-"}${!success && cleanMessage ? ` message=${cleanMessage}` : ""}`);
      }
      if (durableBatchId.startsWith(TUNNEL_PROBE_BATCH_PREFIX)) await settleManualTunnelProbeBatch(durableBatchId);
      else await settleManualForwardChainBatch(durableBatchId);
      res.json({ success: true, ...(accepted ? {} : { ignored: true }) });
      return;
    }
    const tunnelLatencyBaselineId = meta?.kind === "forward-via-tunnel"
      ? Number((meta as any).tunnelLatencyBaselineId || 0)
      : 0;
    const refreshedTunnelLatency = meta?.kind === "forward-via-tunnel" && typeof meta.tunnelId === "number"
      ? await waitForTunnelLatencyRefresh({
        tunnelId: meta.tunnelId,
        baselineId: tunnelLatencyBaselineId,
        loadLatest: db.getLatestTunnelLatency,
        waitMs: FORWARD_TUNNEL_LATENCY_WAIT_MS,
      })
      : null;
    const deferTunnelRuleCompletion = meta?.kind === "forward-via-tunnel" && typeof meta.tunnelId === "number";
    if (!deferTunnelRuleCompletion) {
      const accepted = await db.completeForwardTestIfActive(testId, {
        status: success ? "success" : "failed",
        listenOk: true,
        targetReachable: success,
        forwardOk: success,
        latencyMs: success ? cleanLatency : null,
        message: cleanMessage,
      });
      if (!accepted) {
        res.json({ success: true, ignored: true });
        return;
      }
    }
    if (meta?.kind === "tunnel" && typeof meta.tunnelId === "number") {
      if (success) await db.updateTunnelRunningStatus(meta.tunnelId, true);
      await db.updateTunnelTestResult(meta.tunnelId, {
        status: success ? "success" : "failed",
        latencyMs: success ? cleanLatency : null,
        message: cleanMessage,
      });
      await db.insertTunnelLatencyStat(
        { tunnelId: meta.tunnelId, latencyMs: success ? cleanLatency : null, isTimeout: !success },
        { message: cleanMessage },
      );
      if (success) {
        console.log(`[TunnelTest] tunnel=${meta.tunnelId} entry-agent tcping success latency=${cleanLatency}ms`);
      } else {
        console.warn(`[TunnelTest] tunnel=${meta.tunnelId} entry-agent tcping failed: ${cleanMessage || "unknown"}`);
      }
    }
    if (meta?.kind === "tunnel-hop" && typeof meta.tunnelId === "number") {
      // Only rows created before durable batches reach here; their in-memory
      // batch did not survive the panel restart, so the aggregate can never be
      // computed. Release the tunnel's pending status instead of leaving it.
      const hopLabel = String((meta as any).hopLabel || "hop");
      const tunnel = await db.getTunnelById(meta.tunnelId);
      if (["pending", "running"].includes(String((tunnel as any)?.lastTestStatus || ""))) {
        await db.updateTunnelTestResult(meta.tunnelId, {
          status: "failed",
          latencyMs: null,
          message: `隧道测试批次已失效（面板重启前发起），${hopLabel} 的结果无法汇总，请重新测试`,
        });
      }
      console.warn(`[TunnelTest] tunnel=${meta.tunnelId} legacy hop result without durable batch test=${testId} ${hopLabel}`);
    }
    if (meta?.kind === "forward-via-tunnel" && typeof meta.tunnelId === "number") {
      const tunnel = await db.getTunnelById(meta.tunnelId);
      const tunnelLatencyRefreshed = tunnelLatencySampleIsAfterBaseline(
        refreshedTunnelLatency,
        tunnelLatencyBaselineId,
      );
      const tunnelProbeReused = !tunnelLatencyRefreshed && canReuseRecentTunnelLatencySample({
        sample: refreshedTunnelLatency,
        tunnel,
      });
      const tunnelLatency = tunnelLatencyRefreshed || tunnelProbeReused
        ? refreshedTunnelLatency
        : null;
      const combinedLatency = combineTunnelRuleLatencySample({
        targetLatencyMs: cleanLatency,
        targetIsTimeout: !success,
        tunnelLatencyMs: (tunnelLatency as any)?.latencyMs,
        tunnelIsTimeout: !!(tunnelLatency as any)?.isTimeout,
        tunnelRecordedAt: (tunnelLatency as any)?.recordedAt,
      });
      // 隧道段单独算：落地不通时它照样有值，诊断里才看得出是断在隧道还是断在落地。
      const tunnelSegment = tunnelLatency
        ? freshTunnelSegmentLatency({
          tunnelLatencyMs: (tunnelLatency as any).latencyMs,
          tunnelIsTimeout: !!(tunnelLatency as any).isTimeout,
          tunnelRecordedAt: (tunnelLatency as any).recordedAt,
        })
        : null;
      const tunnelLatencyMs = tunnelSegment && !tunnelSegment.isTimeout && tunnelSegment.latencyMs > 0
        ? Number(tunnelSegment.latencyMs)
        : 0;
      let tunnelDetails: any[] = tunnelLatency
        ? await loadFreshTunnelAutoDetails(tunnel, tunnelLatency)
        : [];
      const tunnelMessage = typeof (tunnel as any)?.lastTestMessage === "string" ? String((tunnel as any).lastTestMessage).trim() : "";
      const tunnelTestStatus = String((tunnel as any)?.lastTestStatus || "");
      if (tunnelLatency && tunnelDetails.length === 0 && tunnelMessage.startsWith("{") && tunnelTestStatus !== "pending" && tunnelTestStatus !== "running") {
        try {
          const parsedTunnelMessage = JSON.parse(tunnelMessage);
          if (
            Array.isArray(parsedTunnelMessage?.details)
            && structuredTunnelMessageMatchesLatency(
              parsedTunnelMessage?.generatedAt,
              (tunnelLatency as any)?.recordedAt,
            )
          ) {
            tunnelDetails = parsedTunnelMessage.details
              .filter((detail: any) => !detail?.pending && (detail?.success || detail?.message || typeof detail?.latencyMs === "number"))
              .map((detail: any) => ({
                success: !!detail.success,
                latencyMs: typeof detail.latencyMs === "number" ? detail.latencyMs : null,
                message: typeof detail.message === "string" ? detail.message : null,
                fromHostId: Number(detail.fromHostId || 0) || null,
                toHostId: Number(detail.toHostId || 0) || null,
                hopIndex: typeof detail.hopIndex === "number" && Number.isInteger(detail.hopIndex) && detail.hopIndex >= 0 ? detail.hopIndex : null,
                hopCount: typeof detail.hopCount === "number" && Number.isInteger(detail.hopCount) && detail.hopCount > 0 ? detail.hopCount : null,
                hopLabel: typeof detail.hopLabel === "string" ? detail.hopLabel : null,
                routeLabel: typeof detail.routeLabel === "string" ? detail.routeLabel : null,
                method: typeof detail.method === "string" ? detail.method : "tcp",
                pending: detail.pending === true,
                groupKey: typeof detail.groupKey === "string" ? detail.groupKey : null,
                groupLabel: typeof detail.groupLabel === "string" ? detail.groupLabel : null,
              }));
            if (!(await isTunnelDetailsCurrent(tunnel, tunnelDetails))) tunnelDetails = [];
          }
        } catch {
          tunnelDetails = [];
        }
      }
      const overallSuccess = tunnelRuleLatencySampleSucceeded(success, combinedLatency);
      const tunnelProbeTimedOut = !tunnelLatency || !!(tunnelLatency as any).isTimeout;
      const overallTimedOut = success && (!combinedLatency || combinedLatency.isTimeout);
      const totalLatency = combinedLatency && !combinedLatency.isTimeout ? combinedLatency.latencyMs : null;
      const target = `${meta.targetIp || "-"}:${meta.targetPort || "-"}`;
      const targetMethod = normalizeLinkProbeMethod(meta.method);
      const resolvedTargetText = cleanResolvedTargetIp && cleanResolvedTargetIp !== String(meta.targetIp || "").trim()
        ? `解析到 ${cleanResolvedTargetIp}`
        : "";
      const messageParts = [
        `隧道整体链路测试 ${overallSuccess ? "成功" : overallTimedOut ? "超时" : "失败"}`,
        `出口到目标 ${target}${success ? ` ${cleanLatency}ms` : ""}${resolvedTargetText ? `，${resolvedTargetText}` : ""}`,
      ];
      if (tunnelLatencyMs > 0) messageParts.push(`隧道段 ${tunnelLatencyMs}ms`);
      if (tunnelProbeTimedOut) messageParts.push("隧道段探测超时");
      if (tunnelProbeReused) messageParts.push("隧道探测未刷新，沿用最近成功样本");
      if (cleanMessage && !success) messageParts.push(cleanMessage);
      const detailMessage = cleanMessage || messageParts.join("; ");
      const structuredMessage = structuredLinkTestMessage({
        kind: "forward-via-tunnel",
        tunnelId: meta.tunnelId,
        message: messageParts.join("; "),
        details: [...tunnelDetails, {
          success,
          latencyMs: success ? cleanLatency : null,
          message: success && resolvedTargetText ? resolvedTargetText : success ? null : detailMessage,
          fromHostId: Number(host.id) || null,
          hopLabel: `出口 -> 目标 ${target}`,
          routeLabel: `出口 -> 目标 ${target}`,
          method: targetMethod,
        }],
        totalLatencyMs: totalLatency,
        tunnelProbeTimedOut,
        tunnelLatencyMs: tunnelLatencyMs > 0 ? tunnelLatencyMs : null,
      });
      const accepted = await db.completeForwardTestIfActive(testId, {
        status: overallSuccess ? "success" : overallTimedOut ? "timeout" : "failed",
        listenOk: true,
        targetReachable: success,
        forwardOk: overallSuccess,
        latencyMs: totalLatency,
        message: structuredMessage,
      });
      if (!accepted) {
        res.json({ success: true, ignored: true });
        return;
      }
      if (combinedLatency) {
        await db.insertTcpingStat({
          ruleId: Number(t.ruleId),
          hostId: Number(host.id),
          latencyMs: combinedLatency.isTimeout ? null : combinedLatency.latencyMs,
          isTimeout: combinedLatency.isTimeout,
        });
        clearRuleLatencyQueryCache();
      }
      console.log(`[SelfTest] tunnel rule overall test=${testId} tunnel=${meta.tunnelId} success=${overallSuccess} targetLatency=${cleanLatency ?? "-"}ms tunnelLatency=${tunnelLatencyMs || "-"}ms total=${totalLatency ?? "-"}ms`);
    }
    if (meta?.kind === "forward-via-tunnel-entry" && typeof meta.tunnelId === "number") {
      const entryTarget = `${meta.entryIp || "-"}:${meta.entrySourcePort || "-"}`;
      const finalTarget = `${meta.targetIp || "-"}:${meta.targetPort || "-"}`;
      const messageParts = [
        `隧道入口端口检测 ${success ? "成功" : "失败"}`,
        `入口 ${entryTarget}${success && cleanLatency !== null ? ` ${cleanLatency}ms` : ""}`,
        `最终目标 ${finalTarget}`,
      ];
      if (cleanMessage && !success) messageParts.push(cleanMessage);
      await db.updateForwardTestResult(testId, {
        status: success ? "success" : "failed",
        listenOk: success,
        targetReachable: success,
        forwardOk: success,
        latencyMs: success ? cleanLatency : null,
        message: messageParts.join("; "),
      });
      if (success) {
        console.log(`[SelfTest] tunnel rule entry-port test=${testId} tunnel=${meta.tunnelId} success latency=${cleanLatency ?? "-"}ms entry=${entryTarget} target=${finalTarget}`);
      } else {
        console.warn(`[SelfTest] tunnel rule entry-port test=${testId} tunnel=${meta.tunnelId} failed entry=${entryTarget} target=${finalTarget}: ${cleanMessage || "unknown"}`);
      }
    }
    if (meta?.kind === "forward-chain" && typeof meta.groupId === "number") {
      const entryTarget = `${meta.entryIp || "-"}:${meta.entrySourcePort || "-"}`;
      const finalTarget = `${meta.targetIp || "-"}:${meta.targetPort || "-"}`;
      const hopLabel = String((meta as any).hopLabel || "");
      if (hopLabel) {
        // Only rows created before durable batches reach here; the row itself
        // already holds the hop result, the lost in-memory batch cannot be summarized.
        appendPanelLog("warn", `[SelfTest] forward-chain group=${meta.groupId} legacy hop result without durable batch test=${testId} hop=${hopLabel} success=${success}`);
        res.json({ success: true });
        return;
      }
      const messageParts = [
        `转发链检测 ${success ? "成功" : "失败"}`,
        `入口 ${entryTarget}${success && cleanLatency !== null ? ` ${cleanLatency}ms` : ""}`,
        `最终目标 ${finalTarget}`,
      ];
      if (cleanMessage && !success) messageParts.push(cleanMessage);
      await db.updateForwardTestResult(testId, {
        status: success ? "success" : "failed",
        listenOk: success,
        targetReachable: success,
        forwardOk: success,
        latencyMs: success ? cleanLatency : null,
        message: messageParts.join("; "),
      });
      appendPanelLog(
        success ? "info" : "warn",
        `[SelfTest] forward-chain test=${testId} group=${meta.groupId} success=${success} latency=${success && cleanLatency !== null ? `${cleanLatency}ms` : "-"} entry=${entryTarget} target=${finalTarget}${cleanMessage && !success ? ` message=${cleanMessage}` : ""}`,
      );
    }
    if (!meta || meta.kind === "forward-group") {
      await db.insertTcpingStat({
        ruleId: Number(t.ruleId),
        hostId: Number(host.id),
        latencyMs: success && cleanLatency !== null ? cleanLatency : null,
        isTimeout: !success || cleanLatency === null,
      });
      clearRuleLatencyQueryCache();
      appendPanelLog(
        success ? "info" : "warn",
        `[SelfTest] rule=${t.ruleId} direct test=${testId} host=${host.id} success=${success} latency=${success && cleanLatency !== null ? `${cleanLatency}ms` : "-"}${cleanMessage ? ` message=${cleanMessage}` : ""}`,
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent SelfTest] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
agentRouter.post("/api/agent/selftest-pull", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const pendingTests = await db.getPendingForwardTestsByHost(host.id);
    const selfTests: any[] = [];
    for (const t of pendingTests) {
      const claimed = await db.markForwardTestRunning(t.id);
      if (!claimed) continue;
      const meta = parseSelfTestMeta(forwardTestRequestMessage(t as any));
      const metaSelfTest = buildMetaAgentSelfTestPayload(t, meta);
      if (metaSelfTest) {
        selfTests.push(metaSelfTest);
        continue;
      }
      const rule = await db.getForwardRuleById(t.ruleId);
      if (!rule) continue;
      const targetIp = await resolveSelfTestTarget(rule);
      selfTests.push(buildRuleAgentSelfTestPayload(t, rule, targetIp));
    }
    res.json({ success: true, selfTests });
  } catch (error) {
    console.error("[Agent SelfTest Pull] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 流量上报

}
