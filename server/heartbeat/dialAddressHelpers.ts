/*
  从 server/agentHeartbeatRoute.ts 第 1227-1302 行抽出（scripts/extract-block.mjs），行为不变。
*/
import type { HeartbeatRequestContext } from "../agentHeartbeatContext";
import { addDnsWatch } from "../agentHeartbeatDns";
import * as db from "../db";
import { selectTunnelDialAddress, selectTunnelHopDialAddress } from "../tunnelAddressSelection";

export type BuildDialAddressHelpersContext = {
  tunnelDialHostPromiseById: Map<number, Promise<any>>;
  dnsWatches: any /* 原类型 Map<string, AgentDnsWatch>… 引用了拿不到的 AgentDnsWatch，手动收拾 */;
  host: any;
  hostTunnels: any;
  agentHostRules: Array<any>;
  agentAllRules: Array<unknown>;
  forwardProtocolSettings: any;
  tunnelById: Map<any, any>;
  tunnelHopsByTunnelId: Map<number, Array<any>>;
  tunnelExitNodesByTunnelId: Map<number, Array<any>>;
  hostPublicAddress: (hostLike: any) => string;
};

export type BuildDialAddressHelpersResult = {
  heartbeatCtx: HeartbeatRequestContext;
  getExtraExitDialAddress: (exitNode: any, tunnel?: any) => Promise<string>;
  getHopDialAddress: (hop: any, tunnel?: any) => Promise<string>;
  tunnelExitHostAddress: (tunnel: any) => Promise<string>;
  tunnelExitEndpointById: Map<number, { host: string; port: number; udpPort?: number; }>;
  getTunnelDialHost: (hostId: unknown) => Promise<any>;
};

export function buildDialAddressHelpers(ctx: BuildDialAddressHelpersContext): BuildDialAddressHelpersResult {
  const { tunnelDialHostPromiseById, dnsWatches, host, hostTunnels, agentHostRules, agentAllRules, forwardProtocolSettings, tunnelById, tunnelHopsByTunnelId, tunnelExitNodesByTunnelId, hostPublicAddress } = ctx;
  const getTunnelDialHost = (hostId: unknown) => {
    const id = Number(hostId);
    let pending = tunnelDialHostPromiseById.get(id);
    if (!pending) {
      pending = db.getHostById(id);
      tunnelDialHostPromiseById.set(id, pending);
    }
    return pending;
  };
  const tunnelExitHostAddress = async (tunnel: any) => {
    const connectHost = String(tunnel?.connectHost || "").trim();
    if (connectHost) {
      const address = selectTunnelDialAddress(tunnel, null);
      addDnsWatch(dnsWatches, address, "tunnel-connect", Number(tunnel?.id || 0));
      return address;
    }
    const exit = await getTunnelDialHost(tunnel.exitHostId);
    const address = selectTunnelDialAddress(tunnel, exit);
    if (!address) return "";
    addDnsWatch(dnsWatches, address, "host-entry", Number((exit as any)?.id || tunnel?.exitHostId || 0));
    return address;
  };
  const tunnelExitEndpointById = new Map<number, { host: string; port: number; udpPort?: number }>();
  // 拆到 agentHeartbeat*Plan.ts 等模块里的那几段要读的、本次请求只读的值（见 agentHeartbeatContext.ts）。
  const heartbeatCtx: HeartbeatRequestContext = {
    host,
    hostTunnels,
    agentHostRules,
    agentAllRules,
    forwardProtocolSettings,
    tunnelById,
    tunnelHopsByTunnelId,
    tunnelExitNodesByTunnelId,
    tunnelExitEndpointById,
  };
  const hostIngressAddressById = new Map<number, string>();
  const getHostIngressAddress = async (hostId: number) => {
    const id = Number(hostId);
    if (!Number.isFinite(id) || id <= 0) return "";
    const cached = hostIngressAddressById.get(id);
    if (cached !== undefined) return cached;
    const hopHost = await getTunnelDialHost(id) as any;
    const addr = hopHost ? hostPublicAddress(hopHost) : "";
    hostIngressAddressById.set(id, addr);
    return addr;
  };
  const getHopDialAddress = async (hop: any, tunnel?: any) => {
    const configured = String((hop as any)?.connectHost || "").trim();
    if (configured) {
      addDnsWatch(dnsWatches, configured, "tunnel-hop-connect", Number((hop as any)?.id || 0));
      return configured;
    }
    const hopHost = await getTunnelDialHost((hop as any)?.hostId) as any;
    const selected = selectTunnelHopDialAddress(hop, hopHost, tunnel);
    const privateAddress = String(hopHost?.tunnelEntryIp || "").trim();
    if (privateAddress && selected === privateAddress) {
      addDnsWatch(dnsWatches, selected, "tunnel-private", Number((hop as any)?.hostId || 0));
      return selected;
    }
    return getHostIngressAddress(Number((hop as any)?.hostId));
  };
  const getExtraExitDialAddress = async (exitNode: any, tunnel?: any) => {
    const configured = String((exitNode as any)?.connectHost || "").trim();
    if (configured) {
      addDnsWatch(dnsWatches, configured, "tunnel-exit-connect", Number((exitNode as any)?.id || 0));
      return configured;
    }
    const exitHost = await getTunnelDialHost((exitNode as any)?.hostId) as any;
    const selected = selectTunnelHopDialAddress(exitNode, exitHost, tunnel);
    const privateAddress = String(exitHost?.tunnelEntryIp || "").trim();
    if (privateAddress && selected === privateAddress) {
      addDnsWatch(dnsWatches, selected, "tunnel-private", Number((exitNode as any)?.hostId || 0));
      return selected;
    }
    return getHostIngressAddress(Number((exitNode as any)?.hostId));
  };
  return { heartbeatCtx, getExtraExitDialAddress, getHopDialAddress, tunnelExitHostAddress, tunnelExitEndpointById, getTunnelDialHost };
}
