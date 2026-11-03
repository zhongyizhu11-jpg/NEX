import { tunnelSecretSeed } from "./agentRouteUtils";
import crypto from "crypto";
import { planGostTunnelHopRelay } from "./gostTunnelProtocol";
import { runtimeBool } from "./agentHeartbeatRuntime";

/*
  隧道下发里几个不依赖本次请求的小函数：出口 SS 规则的停用 / 改指向、出口端口行和出口节点是否对得上、
  FXP 跳点密钥、GOST 隧道节点。
  从 server/agentHeartbeatRoute.ts 的心跳处理函数里原样提到模块顶层，行为不变。
*/

export const holdTunnelEgressRule = (objects: any[], state: string) => {
  for (const rule of objects) {
    rule.isEnabled = false;
    rule.egressRuntimeBlocked = state;
  }
};
export const pointTunnelEgressRule = (objects: any[], port: number) => {
  for (const rule of objects) {
    if (!rule._tunnelEgressTarget) {
      rule._tunnelEgressTarget = { host: String(rule._originalTargetIp || rule.targetIp || ""), port: Number(rule.targetPort || 0) };
    }
    rule.targetIp = "127.0.0.1";
    rule._originalTargetIp = "127.0.0.1";
    rule.targetPort = port;
  }
};

export const tunnelExitRowsMatchNodes = (rows: any[], nodes: any[]) => {
  const enabledNodes = nodes
    .filter((node: any) => node && runtimeBool(node.isEnabled, true))
    .map((node: any) => ({
      id: Number(node.id),
      seq: Number(node.seq),
      hostId: Number(node.hostId),
    }))
    .filter((node: any) => node.id > 0 && node.hostId > 0);
  if (rows.length !== enabledNodes.length) return false;
  const rowByNodeId = new Map(rows.map((row: any) => [Number(row.exitNodeId), row]));
  return enabledNodes.every((node: any) => {
    const row = rowByNodeId.get(node.id);
    return !!row
      && Number(row.exitSeq) === node.seq
      && Number(row.exitHostId) === node.hostId
      && Number(row.tunnelExitPort) > 0;
  });
};

const hopKey = (secret: string, idx: number) =>
  crypto.createHash("sha256").update(`${secret}|hop|${idx}`).digest("hex");
const hopSeq = (hop: any, fallback: number) => {
  const seq = Number((hop as any)?.seq);
  return Number.isFinite(seq) ? seq : fallback;
};
export const fxpHopKey = (tunnel: any, hop: any, fallback: number) =>
  hopKey(tunnelSecretSeed(tunnel), hopSeq(hop, fallback));

export const gostTunnelNode = (
  name: string,
  addr: string,
  dialerType: string,
  tunnel: any,
  connector?: Record<string, unknown>,
) => ({
  name,
  addr,
  connector: connector || planGostTunnelHopRelay({
    tunnelId: Number(tunnel.id),
    secretSeed: tunnelSecretSeed(tunnel),
  }),
  dialer: {
    type: dialerType,
  },
});
