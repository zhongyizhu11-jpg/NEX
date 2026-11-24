/*
  从 server/agentHeartbeatRoute.ts 第 1257-1316 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { runtimeBool } from "../agentHeartbeatRuntime";
import { isForwardXWireGuardV2 } from "../forwardXWireGuard";
import { hostEgressShaping, tunnelLinkShaping } from "../tunnelFxpRuntime";
import { forwardXV3SpecFields, isForwardXV3Tunnel } from "@shared/forwardXV3";

export type BuildForwardXTransportHelpersContext = {
  linkShapingHints: () => Promise<Map<number, { up: number; down: number; }>>;
  host: any;
  egressHint: () => Promise<number>;
  getCurrentHostForwardXWireGuardPlan: any /* 原类型 (tunnel: any) => Promise<ForwardXWireGuardNodePlan | null>… 引用了拿不到的 ForwardXWireGuardNodePlan，手动收拾 */;
  tunnelExitRowsByRuleId: Map<number, Array<any>>;
};

export type BuildForwardXTransportHelpersResult = {
  tunnelRuleExitMappings: (rule: any) => Array<{ exitNodeId: number; exitSeq: number; exitHostId: number; tunnelExitPort: number; }>;
  applyForwardXTransport: (fxpSpec: any, tunnel: any) => Promise<any>;
};

export function buildForwardXTransportHelpers(ctx: BuildForwardXTransportHelpersContext): BuildForwardXTransportHelpersResult {
  const { linkShapingHints, host, egressHint, getCurrentHostForwardXWireGuardPlan, tunnelExitRowsByRuleId } = ctx;
  const applyForwardXTransport = async (fxpSpec: any, tunnel: any) => {
    // 链路整形跟着每个角色的配置走（入口、出口、中转都要）：主动拨出去的连接按
    // 上行整形，接进来的连接按下行整形，FXP 自己按方向取。手动给上限，自动给提示值。
    const link = tunnelLinkShaping(tunnel);
    fxpSpec.linkShaping = link.mode;
    if (link.mode === "manual") {
      if (link.upMbps > 0) fxpSpec.linkUpMbps = link.upMbps;
      if (link.downMbps > 0) fxpSpec.linkDownMbps = link.downMbps;
    } else if (link.mode === "auto") {
      const hint = (await linkShapingHints()).get(Number(tunnel.id));
      if (hint?.up) fxpSpec.linkUpHintMbps = hint.up;
      if (hint?.down) fxpSpec.linkDownHintMbps = hint.down;
    }
    // 抗丢包（FXP 的 udp_fec.go）：隧道上每个角色都要带，冗余包是逐跳发、逐跳还原的。
    // 关着不写字段，配置和旧版本一模一样，FXP 不会因此重启。
    if (runtimeBool((tunnel as any)?.udpFec)) fxpSpec.udpFec = true;
    // 抗丢包传输（FXP 的 loss_carrier.go）：入口、中转、出口都要带，承载是逐跳的。只给 V1
    // （V2 外层已经是 WireGuard 的 UDP，FXP 也会拒）。关着不写字段，配置和旧版一模一样。
    if (runtimeBool(tunnel?.lossTolerant) && !isForwardXWireGuardV2(tunnel)) fxpSpec.lossTolerant = true;
    // 主机公网出口整形按主机配置，每条隧道的配置都带同一份（FXP 整台机器只建一个）。
    // 关着不写字段，老 FXP 的配置保持原样。
    const egress = hostEgressShaping(host);
    if (egress.mode !== "off") {
      fxpSpec.egressShaping = egress.mode;
      if (egress.mode === "manual") fxpSpec.egressMbps = egress.mbps;
      else if (await egressHint()) fxpSpec.egressHintMbps = await egressHint();
    }
    // NEX V3（shared/forwardXV3.ts）：外层选项逐跳都带，入口、中转、出口读的是同一行隧道配置。
    if (isForwardXV3Tunnel(tunnel)) {
      const v3Fields = forwardXV3SpecFields(tunnel);
      if (!v3Fields) return null;
      // 面板保存时已经拒了 V3 + 抗丢包传输；库里要是还留着旧值（比如直接改库），这里不下发，
      // 免得 FXP 拒掉整份配置、隧道上别的规则跟着起不来。多路径（中转叠加 / 热备 / 单连接
      // 多路并发）照常下发：FXP 2.2.141 起每条腿是一条自己的 V3 物理连接。
      delete fxpSpec.lossTolerant;
      fxpSpec.transportVersion = "v3";
      Object.assign(fxpSpec, v3Fields);
      return fxpSpec;
    }
    if (!isForwardXWireGuardV2(tunnel)) {
      fxpSpec.transportVersion = "v1";
      return fxpSpec;
    }
    const plan = await getCurrentHostForwardXWireGuardPlan(tunnel);
    if (!plan) return null;
    fxpSpec.transportVersion = "v2";
    return fxpSpec;
  };
  const tunnelRuleExitMappings = (rule: any) => {
    const rows = tunnelExitRowsByRuleId.get(Number(rule?.id || 0)) || [];
    return rows
      .map((row: any) => ({
        exitNodeId: Number(row.exitNodeId),
        exitSeq: Number(row.exitSeq),
        exitHostId: Number(row.exitHostId),
        tunnelExitPort: Number(row.tunnelExitPort),
      }))
      .filter((row) => row.exitHostId > 0)
      .sort((a, b) => a.exitSeq - b.exitSeq);
  };
  return { tunnelRuleExitMappings, applyForwardXTransport };
}
