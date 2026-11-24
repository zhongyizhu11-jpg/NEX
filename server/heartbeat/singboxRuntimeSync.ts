/*
  从 server/agentHeartbeatRoute.ts 第 3440-3511 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { appendPanelLog } from "../_core/panelLogger";
import type { CollectHeartbeatRunningRulesResult } from "./runningRules";
import { isVlessEgressAgentSupported } from "../../shared/vlessEgress";
import { shouldSendRuntimeSyncAction } from "../agentHeartbeatDispatch";
import { AGENT_GOST_RUNTIME_RECONCILE_MS } from "../agentHeartbeatRoute";
import { getSingboxAccelerator } from "../agentHeartbeatRuntime";
import { resolveHostInboundRoutes } from "../inboundRoutingRuntime";
import { singboxAssetRelayBase } from "../singboxAssets";
import { buildSingboxRuntimePlan } from "../singboxRuntimePlan";
import { buildVlessEgressBridgePlan, collectVlessEgressBridges } from "../vlessEgress";

export type QueueSingboxRuntimeSyncContext = {
  deferActionsForLocalState: any;
  host: any;
  hostProxyInbounds: CollectHeartbeatRunningRulesResult["hostProxyInbounds"];
  panelUrl: string;
  runtimeSyncBootstrap: any;
  responseIssuedAt: number;
  actions: Array<any>;
  effectiveAgentVersion: string;
  rules: Array<any>;
};

export async function queueSingboxRuntimeSync(ctx: QueueSingboxRuntimeSyncContext) {
  const { deferActionsForLocalState, host, hostProxyInbounds, panelUrl, runtimeSyncBootstrap, responseIssuedAt, actions, effectiveAgentVersion, rules } = ctx;
  if (!deferActionsForLocalState) {
    // 分流（按服务 / 域名从别的落地出去）：出口在这里现挑，解锁检测结果变了下次心跳就跟着变。
    const inboundRoutes = await resolveHostInboundRoutes(Number(host.id), hostProxyInbounds).catch((error) => {
      appendPanelLog("warn", `[SingboxRouting] resolve failed host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
      return new Map<number, any[]>();
    });
    const singboxPlan = buildSingboxRuntimePlan({
      inbounds: hostProxyInbounds.map((row) => ({
        inbound: row.inbound,
        // 用行 id 做 tag：改名不该让 sing-box 认为这是另一个入站。
        tag: `inbound-${row.id}`,
        ...(inboundRoutes.has(row.id) ? { routes: inboundRoutes.get(row.id) } : {}),
      })),
      accelerator: await getSingboxAccelerator(),
      panelRelayBase: singboxAssetRelayBase(panelUrl),
    });
    const singboxAction = {
      statusType: "runtime",
      ruleId: 0,
      tunnelId: 0,
      op: "apply",
      forwardType: "singbox-runtime-sync",
      sourcePort: 0,
      targetIp: "",
      targetPort: 0,
      protocol: "tcp",
      knownRunning: false,
      forceRuntimeSync: true,
      preCommands: singboxPlan.preCommands,
      commands: singboxPlan.commands,
      managedConfigs: singboxPlan.managedConfigs,
    } as any;
    if (shouldSendRuntimeSyncAction(
      Number(host.id),
      singboxAction,
      runtimeSyncBootstrap,
      responseIssuedAt,
      AGENT_GOST_RUNTIME_RECONCILE_MS,
    )) {
      actions.push(singboxAction);
    }
    /*
      VLESS Reality 出口的本机桥接（server/vlessEgress.ts）：单独一个 sing-box 服务，规则改了不打断上面的落地入站。
      只发给 2.2.255 起的 Agent（旧 Agent 上这类规则本来就按停用下发，也就没有桥接）；没有桥接时发一份收尾。
    */
    if (isVlessEgressAgentSupported(effectiveAgentVersion)) {
      const bridgePlan = buildVlessEgressBridgePlan({
        bridges: collectVlessEgressBridges(rules, Number(host.id)),
        accelerator: await getSingboxAccelerator(),
        panelRelayBase: singboxAssetRelayBase(panelUrl),
      });
      const bridgeAction = {
        statusType: "runtime",
        ruleId: 0,
        tunnelId: 0,
        op: "apply",
        forwardType: "singbox-egress-runtime-sync",
        sourcePort: 0,
        targetIp: "",
        targetPort: 0,
        protocol: "tcp",
        knownRunning: false,
        forceRuntimeSync: true,
        preCommands: bridgePlan.preCommands,
        commands: bridgePlan.commands,
        managedConfigs: bridgePlan.managedConfigs,
      };
      if (shouldSendRuntimeSyncAction(Number(host.id), bridgeAction, runtimeSyncBootstrap, responseIssuedAt, AGENT_GOST_RUNTIME_RECONCILE_MS)) {
        actions.push(bridgeAction);
      }
    }
  }
}
