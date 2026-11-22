import { tunnelExitLatency } from "./ruleLatencyView";
import * as db from "./db";
import { appendPanelLog } from "./_core/panelLogger";
import { pushAgentRefresh } from "./agentEvents";
import { pushTunnelEndpointRefresh } from "./routers/helpers";
import { requireRuleProtocolEnabled } from "./forwardProtocolSettings";
import { newForwardChainBatchId } from "./forwardChainManualProbe";
import { linkProbeMethodForRule } from "@shared/latencyProbe";
import { exitTargetStatesForRule, ruleActiveExit } from "./exitTargetHealth";
import { liveBalanceForRule } from "./balanceLive";
import { isLatestRuleProbeTimeout } from "./repositories/metricsRepository";
import * as hopRepo from "./repositories/tunnelRepository";
import { dbBool } from "./repositories/repositoryUtils";
import { isForwardXTunnel, tunnelFxpMemberHostIds, tunnelFxpRuntimeIssues, tunnelFxpRuntimeIssueSummary } from "./tunnelFxpRuntime";

/*
  排一次规则诊断（「延迟测试」那一页的「重新测试」）：从 rules.selfTest.ts 的 startSelfTest 挪出来，
  链路换拓扑后自动重测（server/tunnelTopologyChange.ts）也走这一份，权限检查留在路由里。
*/

async function forwardXTunnelFxpIssueMessage(tunnel: any) {
  if (!isForwardXTunnel(tunnel)) return "";
  const [hops, extraExits] = await Promise.all([
    hopRepo.getTunnelHops(Number(tunnel.id)),
    hopRepo.getTunnelExitNodes(Number(tunnel.id)),
  ]);
  const groupHostIds: number[] = [];
  for (const groupId of [Number(tunnel.entryGroupId || 0), Number(tunnel.exitGroupId || 0)]) {
    if (groupId <= 0) continue;
    const group = await db.getForwardGroupById(groupId) as any;
    for (const member of group?.members || []) {
      if (member?.memberType === "host" && dbBool(member.isEnabled, true)) groupHostIds.push(Number(member.hostId || 0));
    }
  }
  const memberHostIds = tunnelFxpMemberHostIds(tunnel, {
    hopHostIds: (hops as any[] || []).map((hop) => hop.hostId),
    extraExitHostIds: (extraExits as any[] || []).filter((node) => dbBool(node.isEnabled, true)).map((node) => node.hostId),
    groupHostIds,
  });
  const hosts = new Map(((await db.getHostsByIds(memberHostIds)) as any[]).map((host) => [Number(host.id), host]));
  return tunnelFxpRuntimeIssueSummary(tunnelFxpRuntimeIssues(tunnel, memberHostIds, hosts));
}

export async function startRuleSelfTest(rule: Awaited<ReturnType<typeof db.getForwardRuleById>> & object): Promise<{ id: number; queued?: number }> {
  await requireRuleProtocolEnabled(rule);
  let hostId = rule.hostId;
  // The rule that actually carries the traffic: for a failover-group
  // template that is the active member's child rule, not the template.
  let runtimeRule: any = rule;
  let message: string | null = null;
  if ((rule as any).isForwardGroupTemplate && (rule as any).forwardGroupId) {
    const group = await db.getForwardGroupById(Number((rule as any).forwardGroupId)) as any;
    if (String(group?.groupMode || "failover") === "chain") {
      await db.syncForwardGroupRules(Number(group.id));
      const probes = await db.getForwardGroupChainProbes(Number(group.id), { includeFinalTarget: true, templateRule: rule });
      const chainLatencyMode = probes.some((probe) => probe.method === "tcp")
        && ["iptables", "nftables"].includes(String(group.forwardType || "").trim().toLowerCase())
        ? Number(group.entryGroupId || 0) > 0
          ? "multi-source-remaining-path"
          : "remaining-path"
        : "sum";
      if (probes.length === 0) throw new Error("转发链没有可测试的有效链路");
      // Durable batch: every hop row carries the batchId and the batch is
      // aggregated from the database (survives a panel restart).
      const batchId = newForwardChainBatchId();
      const testHostIds = new Set<number>();
      const rows = probes.map((probe) => {
        const probeMessage = JSON.stringify({
          kind: "forward-chain",
          groupId: group.id,
          ruleId: rule.id,
          entryIp: probe.targetIp,
          entrySourcePort: probe.targetPort,
          targetIp: probe.targetIp,
          targetPort: probe.targetPort,
          method: probe.method,
          hopLabel: probe.hopLabel,
          routeLabel: probe.routeLabel,
          batchId,
          latencyMode: chainLatencyMode,
          runtimeDependent: probe.runtimeDependent,
        });
        testHostIds.add(probe.fromHostId);
        return {
          ruleId: rule.id,
          hostId: probe.fromHostId,
          userId: rule.userId,
          status: "pending",
          listenOk: false,
          targetReachable: false,
          forwardOk: false,
          message: probeMessage,
        };
      });
      const ids = await db.createForwardTestBatch(batchId, rows);
      const queued = ids.length;
      appendPanelLog("info", `[SelfTest] rule=${rule.id} forward-chain=${group.id} batch=${batchId} queued segments=${queued} sourceHosts=${testHostIds.size}`);
      for (const hostId of testHostIds) {
        pushAgentRefresh(hostId, "forward-chain-rule-selftest", { urgent: true });
      }
      return { id: Number(ids[0] || 0), queued };
    }
    if (String(group?.groupMode || "failover") === "failover") {
      const selected = await db.getForwardGroupRuleForSelfTest(rule, group);
      runtimeRule = selected.rule;
      await requireRuleProtocolEnabled(runtimeRule);
      hostId = Number(runtimeRule.hostId);
      const sourceHost = await db.getHostById(hostId);
      // Persist the selected listener/target at click time so both Agent
      // pull paths run the same test even if failover happens afterwards.
      message = JSON.stringify({
        kind: "forward-group",
        groupId: selected.groupId,
        memberId: selected.memberId,
        runtimeRuleId: Number(runtimeRule.id),
        forwardType: runtimeRule.forwardType,
        sourcePort: runtimeRule.sourcePort,
        targetIp: runtimeRule.targetIp,
        targetPort: runtimeRule.targetPort,
        method: linkProbeMethodForRule(runtimeRule),
        sourceLabel: (sourceHost as any)?.name || `主机 #${hostId}`,
        targetLabel: rule.name,
      });
    }
  }
  if (runtimeRule.tunnelId) {
    const tunnel = await db.getTunnelById(runtimeRule.tunnelId);
    if (!tunnel) throw new Error("隧道不存在");
    const fxpIssueMessage = await forwardXTunnelFxpIssueMessage(tunnel);
    if (fxpIssueMessage) {
      const id = await db.createForwardTest({
        ruleId: rule.id,
        hostId: Number(tunnel.entryHostId || rule.hostId),
        userId: rule.userId,
        status: "failed",
        listenOk: false,
        targetReachable: false,
        forwardOk: false,
        message: fxpIssueMessage,
      });
      appendPanelLog("warn", `[SelfTest] rule=${rule.id} tunnel=${tunnel.id} FXP runtime incompatible: ${fxpIssueMessage}`);
      return { id };
    }
    /*
      负载均衡链路的主出口连不上目标、流量已经切到别的出口（2.3.537）：从在用的那台测目标。
      以前总是主出口测，诊断里一直显示「主出口 → 超时」，可转发早就切走、照常在走。
    */
    // 主出口的 Agent 老、没报快速探测时，看它最近 5 分钟的普通探测是不是在超时（2.3.539）
    const primaryReported = exitTargetStatesForRule(Number(runtimeRule.id)).some((state) => state.hostId === Number(tunnel.exitHostId));
    const primaryTimeout = primaryReported
      ? false
      : await isLatestRuleProbeTimeout(Number(runtimeRule.id), Number(tunnel.exitHostId), new Date(Date.now() - 5 * 60_000)).catch(() => null) === true;
    /*
      从哪台测：扛流量最多的那台（ruleActiveExit 的 hostIds[0]，和规则卡上的延迟、「经」是同一台，见
      exitTargetHealth.ts 的 liveCarryingExit）。它不是主出口时，「入口 → 出口」那一段也得是它的：入口真实上报的
      exitMs，没有就让入口现测一次（selfTestViaExit.ts），绝不拿链路自己那份（入口到主出口的）样本凑。
    */
    const activeExit = ruleActiveExit(Number(runtimeRule.id), Number(tunnel.id), Date.now(), { primaryTimeout });
    const primaryExitHostId = Number(tunnel.exitHostId);
    const viaActiveExit = !!activeExit && Number(activeExit.hostIds[0] || 0) > 0 && Number(activeExit.hostIds[0]) !== primaryExitHostId;
    const testExitHostId = viaActiveExit ? Number(activeExit!.hostIds[0]) : primaryExitHostId;
    hostId = testExitHostId;
    const targetIp = runtimeRule.targetIp;
    if (!targetIp) throw new Error("目标地址不可用，请检查规则目标地址");
    let entryExitTestId = 0;
    let viaEntryHostId = Number(tunnel.entryHostId || 0);
    if (viaActiveExit) {
      const live = liveBalanceForRule(Number(runtimeRule.id));
      if (live && Number(live.entryHostId) > 0) viaEntryHostId = Number(live.entryHostId);
      const liveExit = live?.exits.find((exit) => exit.hostId === testExitHostId);
      const hops = await hopRepo.getTunnelHops(Number(tunnel.id)).catch(() => []) as unknown[];
      // 多跳（出口在中转后面）：入口连不到出口机，没法直接测这一段
      // 面板的链路探测里这台出口那一段还新鲜就用它（和卡片一个口径），没有就让入口现测一次（入口报的握手延迟只兜底）
      if (!tunnelExitLatency(Number(tunnel.id), testExitHostId) && liveExit?.host && liveExit.port > 0 && viaEntryHostId > 0 && hops.length < 3) {
        const [entryHost, exitHost] = await Promise.all([db.getHostById(viaEntryHostId), db.getHostById(testExitHostId)]);
        entryExitTestId = Number(await db.createForwardTest({
          ruleId: 0,
          hostId: viaEntryHostId,
          userId: rule.userId,
          status: "pending",
          listenOk: false,
          targetReachable: false,
          forwardOk: false,
          message: JSON.stringify({
            kind: "line-segment",
            targetIp: liveExit.host,
            targetPort: liveExit.port,
            method: "tcp",
            hopLabel: `${(entryHost as { name?: unknown } | undefined)?.name || `主机 #${viaEntryHostId}`} → ${(exitHost as { name?: unknown } | undefined)?.name || `主机 #${testExitHostId}`}`,
          }),
        }) || 0);
        if (entryExitTestId > 0) pushAgentRefresh(viaEntryHostId, "forward-selftest-entry-exit", { urgent: true });
      }
    }
    const tunnelLatencyBaseline = viaActiveExit ? null : await db.getLatestTunnelLatency(Number(tunnel.id));
    // Probe only: a measurement must not invalidate a healthy runtime and
    // queue redundant re-applies ahead of the probe it is waiting for.
    const pushed = await pushTunnelEndpointRefresh(tunnel, "forward-selftest-via-tunnel", {
      urgent: true,
      refreshMode: "probe",
    });
    message = JSON.stringify({
      kind: "forward-via-tunnel",
      tunnelId: tunnel.id,
      entryHostId: viaActiveExit ? viaEntryHostId : tunnel.entryHostId,
      exitHostId: testExitHostId,
      ...(viaActiveExit ? { primaryExitHostId, viaActiveExit: true, ...(entryExitTestId > 0 ? { entryExitTestId } : {}) } : {}),
      targetIp,
      targetPort: runtimeRule.targetPort,
      method: linkProbeMethodForRule(runtimeRule),
      tunnelLatencyBaselineId: Number((tunnelLatencyBaseline as any)?.id || 0),
      refreshPushed: pushed,
    });
    appendPanelLog("info", `[SelfTest] rule=${rule.id} tunnel=${tunnel.id} queued tunnel+target test from exitHost=${testExitHostId}${viaActiveExit ? ` (流量主要走 ${testExitHostId}、不是主出口 ${tunnel.exitHostId}，测在用的出口${entryExitTestId > 0 ? `；入口现测到它 test=${entryExitTestId}` : ""})` : ""} to target=${targetIp}:${runtimeRule.targetPort}`);
  }
  const id = await db.createForwardTest({
    ruleId: rule.id,
    hostId,
    userId: rule.userId,
    status: "pending",
    listenOk: false,
    targetReachable: false,
    forwardOk: false,
    message,
  });
  pushAgentRefresh(hostId, "forward-selftest", { urgent: true });
  if (!runtimeRule.tunnelId) {
    appendPanelLog("info", `[SelfTest] rule=${rule.id}${runtimeRule !== rule ? ` runtimeRule=${runtimeRule.id}` : ""} queued direct test=${id} from host=${hostId} to target=${runtimeRule.targetIp}:${runtimeRule.targetPort}`);
  }
  return { id };
}
