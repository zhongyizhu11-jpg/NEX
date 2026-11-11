import { tunnelSecretSeed } from "./agentRouteUtils";
import { isTunnelProtocolEnabled } from "./forwardProtocolSettings";
import { appendPanelLog } from "./_core/panelLogger";
import { setBoundedMapValue } from "./boundedCache";
import { gostTunnelTransportType, planGostTunnelProbeListeners } from "./tunnelRuntimePlan";
import { gostProxyProtocolMetadata } from "./gostProxyProtocol";
import { planGostTunnelHopRelay, planGostTunnelRuleProtocol } from "./gostTunnelProtocol";
import { buildCountingChainCmds, shQuote, stopManagedServiceCmd, writeManagedServiceCmd } from "./agentActionCommands";
import { endpointHostPort } from "./forwardRuntimeConfigs";
import { forwardRuleProtocols } from "@shared/forwardTypes";
import { isTunnelRelayFailover, tunnelRelayCandidates, tunnelRelayUsesParallelRelays } from "@shared/tunnelRelay";
import { gostExitSelector, shouldUseFastTunnelFailover } from "./tunnelExitStrategy";
import { buildGostEgressChain, gostEgressChainName, ruleEgressRuntime } from "./ssEgress";
import { isSniRuntimeRule } from "./tlsInboundRuntime";
import { AGENT_DYNAMIC_CACHE_MAX, tunnelRouteLogCache } from "./agentHeartbeatState";
import {
  buildGostRuleListener,
  ensureRuntimeBinaryCmd,
  isGostTunnelMode,
  LEGACY_GOST_SERVICE_NAME,
  LEGACY_TUNNEL_SERVICE_NAME,
  RUNTIME_CONFIG_DIR,
  RUNTIME_CONFIG_PATH,
  runtimeBool,
  SHARED_RUNTIME_NOFILE,
  TUNNEL_RUNTIME_CONFIG_PATH,
  TUNNEL_RUNTIME_SERVICE_NAME,
} from "./agentHeartbeatRuntime";
import type { HeartbeatRequestContext, HeartbeatRow, HeartbeatRuleRow, TunnelEgressHelper } from "./agentHeartbeatContext";
import type { GostProxyProtocolMetadata, GostTunnelProxyProtocolPlan } from "./gostProxyProtocol";
import { gostTunnelNode } from "./agentHeartbeatTunnel";

/*
  共享 gost 运行时和隧道 gost 运行时这一次心跳的下发内容：本机 gost 规则的 services（含协议守卫、限速、出口链、
  走隧道时的 SS 出口转发）、隧道链 chains、空闲隧道的探测监听，以及写配置 / 重启的命令
  （buildGostReloadCmds、buildTunnelReloadCmds）。
  从 server/agentHeartbeatRoute.ts 的心跳处理函数里搬出来：语句原样、顺序不变，原来从闭包里读的值改由
  ctx（本次请求只读的值，见 agentHeartbeatContext.ts）和 deps（处理函数里的辅助闭包）在开头解构出来。
  services / chains 仍在处理函数里原来那个位置算（await 这个函数），两个 build*Cmds 仍旧要用时才调。
*/

export type GostRuntimePlanDeps = {
  VERBOSE_AGENT_ACTIONS: boolean;
  anyTunnelDnsRefresh: (tunnels: HeartbeatRow[]) => boolean;
  applyGostLimiter: (service: HeartbeatRow, rule: HeartbeatRow, tunnel?: HeartbeatRow) => HeartbeatRow;
  buildLoadBalancedExitNodes: (rule: HeartbeatRow, tunnel: HeartbeatRow, primaryHostOverride?: string | undefined) => Promise<HeartbeatRow[]>;
  buildProxyRuleDebugCmd: (label: string, rule: HeartbeatRow, extra?: Record<string, unknown>) => string;
  currentHostTunnelExitPortsForRule: (rule: HeartbeatRow, tunnel: HeartbeatRow) => number[];
  dnsRuntimeRefreshCmd: (label: string) => string;
  failoverTargetAddr: (rule: HeartbeatRow, proxyDirection?: "send" | "exitSend") => string;
  getHopDialAddress: (hop: HeartbeatRow, tunnel?: HeartbeatRow) => Promise<string>;
  gostRateLimiters: HeartbeatRow[];
  gostRelayFailoverHopMetadata: { strategy: string; maxFails: number; failTimeout: string; };
  gostRules: HeartbeatRow[];
  gostRuntimeApiSection: (service: string) => { api: { addr: string; }; } | { api?: undefined; };
  gostRuntimeExecStart: (service: string, configPath: string) => string;
  gostRuntimeSyncCmd: (service: string, configPath: string) => string;
  gostServiceName: "forwardx-runtime";
  gostServiceUnit: string;
  gostTunnelExitTargetAddr: (rule: HeartbeatRow, tunnel: HeartbeatRow) => Promise<string>;
  guardBackendPort: (rule: HeartbeatRow) => number;
  isCurrentHostTunnelEntry: (tunnel: HeartbeatRow) => boolean;
  isForwardXTunnel: (tunnel: HeartbeatRow) => boolean;
  maybeProxyProtocolMetadata: (rule: HeartbeatRow, direction: "receive" | "send" | "entryReceive" | "entrySend" | "exitReceive" | "exitSend") => GostProxyProtocolMetadata | undefined;
  proxyProtocolEnabled: (rule: HeartbeatRow, direction: "receive" | "send" | "entryReceive" | "entrySend" | "exitReceive" | "exitSend") => boolean;
  proxyProtocolVersion: (rule: HeartbeatRow) => 1 | 2;
  routeHeaderStripRuleIds: Set<number>;
  shouldUseRuleGuard: (rule: HeartbeatRuleRow) => Promise<boolean>;
  tunnelEgressHelpers: Map<number, TunnelEgressHelper>;
  tunnelExitEndpointsForRule: (rule: HeartbeatRow, tunnel: HeartbeatRow) => { exitNodeId: number; exitSeq: number; exitHostId: number; listenPort: number; rulePort: number; primary: boolean; node?: HeartbeatRow; }[];
  tunnelExitRules: HeartbeatRow[];
  tunnelForwardProtos: (protocol: string) => ("tcp" | "udp")[];
  tunnelProxyProtocolPlan: (rule: HeartbeatRow) => GostTunnelProxyProtocolPlan;
};

export async function createGostRuntimePlan(ctx: HeartbeatRequestContext, deps: GostRuntimePlanDeps) {
  const {
    forwardProtocolSettings,
    host,
    hostTunnels,
    tunnelById,
    tunnelExitEndpointById,
    tunnelExitNodesByTunnelId,
    tunnelHopsByTunnelId,
  } = ctx;
  const {
    VERBOSE_AGENT_ACTIONS,
    anyTunnelDnsRefresh,
    applyGostLimiter,
    buildLoadBalancedExitNodes,
    buildProxyRuleDebugCmd,
    currentHostTunnelExitPortsForRule,
    dnsRuntimeRefreshCmd,
    failoverTargetAddr,
    getHopDialAddress,
    gostRateLimiters,
    gostRelayFailoverHopMetadata,
    gostRules,
    gostRuntimeApiSection,
    gostRuntimeExecStart,
    gostRuntimeSyncCmd,
    gostServiceName,
    gostServiceUnit,
    gostTunnelExitTargetAddr,
    guardBackendPort,
    isCurrentHostTunnelEntry,
    isForwardXTunnel,
    maybeProxyProtocolMetadata,
    proxyProtocolEnabled,
    proxyProtocolVersion,
    routeHeaderStripRuleIds,
    shouldUseRuleGuard,
    tunnelEgressHelpers,
    tunnelExitEndpointsForRule,
    tunnelExitRules,
    tunnelForwardProtos,
    tunnelProxyProtocolPlan,
  } = deps;
  // Shadowsocks 出口链：每条带出口的规则每个协议一条（chain-egress-<规则>-<协议>），和隧道链一起写进 chains。
  const egressGostChains: any[] = [];
  const gostServiceConfig = (await Promise.all(gostRules
    .map(async (r: any) => {
      const useRuleGuard = await shouldUseRuleGuard(r);
      const tunnel = (r as any).tunnelId ? tunnelById.get((r as any).tunnelId) as any : null;
      if (tunnel && !isGostTunnelMode(tunnel)) return [];
      const protos = tunnel ? tunnelForwardProtos(r.protocol) : forwardRuleProtocols(r.protocol);
      return Promise.all(protos.map(async (proto) => {
        const tunnelHops = tunnel ? tunnelHopsByTunnelId.get(Number(tunnel.id)) : null;
        const isMultiHopTunnel = Array.isArray(tunnelHops) && tunnelHops.length >= 3;
        const useMultiHopEntry =
          isMultiHopTunnel
          && isCurrentHostTunnelEntry(tunnel);
        const relayFailover = useMultiHopEntry && tunnelRelayUsesParallelRelays(tunnel, tunnelHops);
        const exitCandidateCount = tunnel ? tunnelExitEndpointsForRule(r, tunnel).length : 0;
        const routeRetries = Math.max(
          relayFailover ? tunnelRelayCandidates(tunnelHops as any[]).length - 1 : 0,
          exitCandidateCount - 1,
        );
        // Every multi-exit strategy must fail over promptly when a node is
        // blackholed.  The selector already retries the remaining nodes;
        // leaving the default dial timeout here makes round-robin/random/
        // hash wait on the dead endpoint before that retry can happen.
        const fastFailover = shouldUseFastTunnelFailover(exitCandidateCount, relayFailover);
        const tunnelExitHost = tunnel ? tunnelExitEndpointById.get(tunnel.id)?.host : "";
        const tunnelProxyPlan = tunnel ? tunnelProxyProtocolPlan(r) : null;
        const protocolPlan = tunnel ? planGostTunnelRuleProtocol({
          protocol: r.protocol,
          tunnelId: Number(tunnel.id),
          ruleId: Number(r.id),
          secretSeed: tunnelSecretSeed(tunnel),
        }) : null;
        const handlerProxyMetadata = proto === "tcp"
          ? (tunnel
            ? tunnelProxyPlan?.entryHandler
            : maybeProxyProtocolMetadata(r, "send")
              // 只发给本机的调度器、由它剥掉的头（按访客固定），见 routeHeaderStripRuleIds。
              || (routeHeaderStripRuleIds.has(Number(r.id)) ? gostProxyProtocolMetadata(1) : undefined))
          : undefined;
        const serviceListenPort = useRuleGuard && !tunnel ? guardBackendPort(r) : Number(r.sourcePort);
        // 共享 TLS 入站上经隧道的规则：隧道入口只听回环，客户端连的是入站端口（SNI 分流器交过来）。
        const loopbackOnly = (useRuleGuard && !tunnel) || (!!tunnel && isSniRuntimeRule(r));
        const service: any = {
          name: `fwx-${r.id}-${proto}`,
          addr: loopbackOnly ? `127.0.0.1:${serviceListenPort}` : `:${serviceListenPort}`,
          handler: tunnel
            ? {
                type: proto,
                chain: `chain-tunnel-${r.id}`,
                ...(routeRetries > 0 ? { retries: routeRetries } : {}),
                ...(handlerProxyMetadata ? { metadata: handlerProxyMetadata } : {}),
              }
            : { type: proto, ...(handlerProxyMetadata ? { metadata: handlerProxyMetadata } : {}) },
          listener: buildGostRuleListener(proto),
        };
        if (proto === "tcp" && tunnelProxyPlan?.entryListener) {
          service.metadata = tunnelProxyPlan.entryListener;
        } else if (proto === "tcp" && !tunnel && proxyProtocolEnabled(r, "receive")) {
          service.metadata = maybeProxyProtocolMetadata(r, "receive");
        } else if (proto === "tcp" && useRuleGuard && proxyProtocolEnabled(r, "send")) {
          service.metadata = gostProxyProtocolMetadata(proxyProtocolVersion(r));
        }
        if (fastFailover) {
          service.metadata = { ...(service.metadata || {}), dialTimeout: "3s" };
        }
        if (!tunnel) {
          service.forwarder = {
            nodes: [{
              name: `target-${r.id}`,
              addr: failoverTargetAddr(r),
              connector: { type: proto },
              dialer: { type: proto },
            }],
          };
          /*
            Shadowsocks 出口：forwarder 仍是最终目标，handler 挂一条一跳的链 —— gost 拨的是落地的 SS
            服务器，请它代连目标（和隧道入口同一个机制）。计数（监听端口上的计数链）、限速（服务上的
            limiter）都在入口这一侧，和普通 gost 规则一样。运行视图已经保证：没有 egressRuntime 的
            出口规则根本走不到这里（按停用下发）；UDP 不走出口时协议已收窄成 TCP。
          */
          const egressRuntime = ruleEgressRuntime(r);
          if (egressRuntime && (proto === "tcp" || egressRuntime.udp)) {
            service.handler = { ...service.handler, chain: gostEgressChainName(Number(r.id), proto) };
            egressGostChains.push(buildGostEgressChain(Number(r.id), proto, egressRuntime));
          } else if (egressRuntime) {
            return null;
          }
        } else if (!useMultiHopEntry && (!tunnelExitHost || tunnelExitEndpointsForRule(r, tunnel).length === 0)) {
          return null;
        } else if (useMultiHopEntry || protocolPlan?.entryNeedsTarget) {
          service.forwarder = {
            nodes: [{
              name: `target-${r.id}`,
              addr: protocolPlan?.entryNeedsTarget
                ? await gostTunnelExitTargetAddr(r, tunnel)
                : failoverTargetAddr(r),
              connector: { type: proto },
              dialer: { type: proto },
            }],
          };
        }
        return applyGostLimiter(service, r, tunnel);
      }));
    })))
    .flat()
    .filter(Boolean);
  /*
    走隧道的规则接 Shadowsocks 出口，这台是隧道出口机：本机 127.0.0.1:端口 上一个 gost 转发，handler 挂出口链
    （和直连规则的出口同一条链），forwarder 是规则真正的目标 —— SS 落地代连。隧道出口拨进来的就是它。
    计数、限速都在入口那一侧，这里不挂。
  */
  for (const helper of tunnelEgressHelpers.values()) {
    if (!helper.port || !helper.targetHost || !helper.targetPort) continue;
    for (const proto of forwardRuleProtocols(helper.protocol)) {
      if (proto === "udp" && !helper.runtime.udp) continue;
      gostServiceConfig.push({
        name: `fwx-tegress-${helper.ruleId}-${proto}`,
        addr: `127.0.0.1:${helper.port}`,
        handler: { type: proto, chain: gostEgressChainName(helper.ruleId, proto) },
        listener: buildGostRuleListener(proto),
        forwarder: {
          nodes: [{
            name: `tegress-target-${helper.ruleId}`,
            addr: endpointHostPort(helper.targetHost, helper.targetPort),
            connector: { type: proto },
            dialer: { type: proto },
          }],
        },
      });
      egressGostChains.push(buildGostEgressChain(helper.ruleId, proto, helper.runtime));
    }
  }
  const tunnelGostChains = (await Promise.all(gostRules
    .filter((r: any) => runtimeBool(r.isEnabled) && r.forwardType === "gost" && r.tunnelId)
    .map(async (r: any) => {
      const tunnel = tunnelById.get((r as any).tunnelId) as any;
      if (!isGostTunnelMode(tunnel)) return null;
      const tunnelExitHost = tunnel ? tunnelExitEndpointById.get(tunnel.id)?.host : "";
      if (!tunnel || !tunnelExitHost || tunnelExitEndpointsForRule(r, tunnel).length === 0) return null;
      const tunnelHops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      const firstHop = Array.isArray(tunnelHops) && tunnelHops.length >= 2 ? (tunnelHops[0] as any) : null;
      const isMultiHopTunnel = Array.isArray(tunnelHops) && tunnelHops.length >= 3;
      const useMultiHopEntry =
        isMultiHopTunnel
        && isCurrentHostTunnelEntry(tunnel);
      // Multi-hop rules on the entry host must build an explicit B->...->exit chain.
      // Dialing the local first-hop listener only proves the generic probe path and bypasses
      // the selected tunnel exit listener.
      if (isMultiHopTunnel && !useMultiHopEntry) {
        console.warn(`[TunnelRoute] skip direct fallback for multi-hop tunnel=${tunnel.id} rule=${r.id}; entry host mismatch host=${host.id} firstHop=${Number(firstHop?.hostId) || 0}`);
        return null;
      }
      if (isMultiHopTunnel && useMultiHopEntry) {
        const chainHops: any[] = [];
        const routeParts: string[] = [`entry#${Number(host.id)}:${Number((r as any).sourcePort)}`];
        const relayFailover = isTunnelRelayFailover(tunnel, tunnelHops);
        if (relayFailover) {
          const relayNodes = await Promise.all(tunnelRelayCandidates(tunnelHops).map(async (hop: any, index: number) => {
            const hopDialHost = await getHopDialAddress(hop, tunnel);
            if (!hopDialHost || !Number(hop.listenPort)) return null;
            const hopAddr = endpointHostPort(hopDialHost, hop.listenPort);
            routeParts.push(`relay#${index + 1}:${Number(hop.hostId)}@${hopAddr}`);
            return gostTunnelNode(
              `relay-${r.id}-${Number(hop.seq)}`,
              hopAddr,
              gostTunnelTransportType(tunnel.mode),
              tunnel,
            );
          }));
          const validRelayNodes = relayNodes.filter(Boolean);
          if (validRelayNodes.length !== tunnelRelayCandidates(tunnelHops).length) return null;
          chainHops.push({
            name: `hop-tunnel-${r.id}-relay-failover`,
            selector: gostRelayFailoverHopMetadata,
            nodes: validRelayNodes,
          });
        } else {
          for (let i = 1; i < tunnelHops.length - 1; i++) {
            const hop = tunnelHops[i] as any;
            const hopDialHost = await getHopDialAddress(hop, tunnel);
            if (!hopDialHost || !Number(hop.listenPort)) return null;
            const hopAddr = endpointHostPort(hopDialHost, hop.listenPort);
            routeParts.push(`hop#${Number(hop.hostId)}@${hopAddr}`);
            chainHops.push({
              name: `hop-tunnel-${r.id}-${Number(hop.seq)}`,
              nodes: [gostTunnelNode(
                `mhop-${r.id}-${Number(hop.seq)}`,
                hopAddr,
                gostTunnelTransportType(tunnel.mode),
                tunnel,
              )],
            });
          }
        }
        const exitHop = tunnelHops[tunnelHops.length - 1] as any;
        const exitHost = await getHopDialAddress(exitHop, tunnel);
        const exitNodes = await buildLoadBalancedExitNodes(r, tunnel, exitHost);
        if (!exitHost || exitNodes.length === 0) return null;
        chainHops.push({
          name: `hop-tunnel-${r.id}-exit`,
          ...(exitNodes.length > 1 ? { selector: gostExitSelector((tunnel as any).loadBalanceStrategy) } : {}),
          nodes: exitNodes,
        });
        if (chainHops.length === 0) return null;
        routeParts.push(`exit#${Number(exitHop.hostId)}@${exitNodes.map((node: any) => node.addr).join(",")}`);
        const route = routeParts.join(" -> ");
        const routeKey = `${tunnel.id}:${r.id}:${host.id}`;
        if (tunnelRouteLogCache.get(routeKey) !== route) {
          setBoundedMapValue(tunnelRouteLogCache, routeKey, route, AGENT_DYNAMIC_CACHE_MAX);
          appendPanelLog("info", `[TunnelRoute] gost multi-hop tunnel=${tunnel.id} rule=${r.id} host=${host.id} proxyEntrySend=${proxyProtocolEnabled(r, "entrySend")} route=${route}`);
        }
        return { name: `chain-tunnel-${r.id}`, hops: chainHops };
      }
      const firstExitEndpoint = tunnelExitEndpointsForRule(r, tunnel)[0];
      const chainTargetAddr = useMultiHopEntry
        ? endpointHostPort("127.0.0.1", firstHop.listenPort)
        : endpointHostPort(tunnelExitHost, firstExitEndpoint?.listenPort || 0);
      const chainNodeName = useMultiHopEntry ? `mhop-entry-${r.id}` : `exit-${r.id}`;
      const exitNodes = !useMultiHopEntry ? await buildLoadBalancedExitNodes(r, tunnel) : [];
      return {
        name: `chain-tunnel-${r.id}`,
        hops: [{
          name: `hop-tunnel-${r.id}`,
          ...(exitNodes.length > 1 ? { selector: gostExitSelector((tunnel as any).loadBalanceStrategy) } : {}),
          nodes: useMultiHopEntry ? [gostTunnelNode(
            chainNodeName,
            chainTargetAddr,
            "tcp",
            tunnel,
          )] : exitNodes,
        }],
      };
    }))).filter(Boolean);
  const gostChains = [...tunnelGostChains, ...egressGostChains];
  const gostManagedConfigs: any[] = [];
  const buildGostReloadCmds = () => {
    const encodedConfig = Buffer.from(JSON.stringify({ services: gostServiceConfig, chains: gostChains, limiters: gostRateLimiters, ...gostRuntimeApiSection(gostServiceName) }, null, 2), "utf8").toString("base64");
    gostManagedConfigs.push({
      path: RUNTIME_CONFIG_PATH,
      contentBase64: encodedConfig,
      format: "json",
      serviceName: gostServiceName,
    });
    const proxyDebugCmds = VERBOSE_AGENT_ACTIONS ? gostRules
      .filter((rule: any) => rule && Number(rule.tunnelId || 0) > 0 && (
        proxyProtocolEnabled(rule, "entryReceive") ||
        proxyProtocolEnabled(rule, "entrySend") ||
        proxyProtocolEnabled(rule, "exitReceive") ||
        proxyProtocolEnabled(rule, "exitSend")
      ))
      .map((rule: any) => buildProxyRuleDebugCmd("entry", rule, {
        chain: `chain-tunnel-${Number(rule.id || 0)}`,
      })) : [];
    const cmds = [
      `mkdir -p ${shQuote(RUNTIME_CONFIG_DIR)}`,
      ...proxyDebugCmds,
      writeManagedServiceCmd(gostServiceName, gostServiceUnit),
      stopManagedServiceCmd(LEGACY_GOST_SERVICE_NAME),
    ];
    if (gostServiceConfig.length > 0) {
      cmds.unshift(ensureRuntimeBinaryCmd());
      if (anyTunnelDnsRefresh(hostTunnels as any[])) {
        cmds.push(dnsRuntimeRefreshCmd("gost"), `rm -f ${shQuote(`${RUNTIME_CONFIG_PATH}.sha256`)} 2>/dev/null || true`);
      }
      cmds.push(gostRuntimeSyncCmd(gostServiceName, RUNTIME_CONFIG_PATH));
    } else {
      cmds.push(stopManagedServiceCmd(gostServiceName));
    }
    return cmds;
  };
  const businessTunnelListenKeys = new Set<string>();
  for (const rule of tunnelExitRules as any[]) {
    const tunnel = tunnelById.get(Number((rule as any).tunnelId)) as any;
    if (!tunnel || !isGostTunnelMode(tunnel)) continue;
    for (const endpoint of tunnelExitEndpointsForRule(rule, tunnel)) {
      if (endpoint.exitHostId > 0 && endpoint.listenPort > 0) {
        businessTunnelListenKeys.add(`${endpoint.exitHostId}:${endpoint.listenPort}`);
      }
    }
  }
  // Keep idle GOST links probeable. A real forwarding service on the same
  // host and port takes precedence, so the generated runtime never binds twice.
  const gostTunnelProbePlans = planGostTunnelProbeListeners(
    Number(host.id),
    (hostTunnels as any[]).map((tunnel: any) => ({
      ...tunnel,
      protocolEnabled: isTunnelProtocolEnabled(forwardProtocolSettings, tunnel),
    })),
    tunnelExitNodesByTunnelId,
    businessTunnelListenKeys,
  );
  const gostTunnelProbeServices = gostTunnelProbePlans.map((probe) => ({
    name: probe.name,
    addr: `:${probe.listenPort}`,
    handler: { type: "tcp" },
    listener: {
      type: gostTunnelTransportType(probe.mode),
    },
    forwarder: {
      nodes: [{
        name: `probe-${probe.name}`,
        addr: "127.0.0.1:9",
        connector: { type: "tcp" },
        dialer: { type: "tcp" },
      }],
    },
  }));
  const buildTunnelReloadCmds = async () => {
    const ruleServices = (await Promise.all(tunnelExitRules.map(async (rule: any) => {
      const tunnel = tunnelById.get(rule.tunnelId) as any;
      if (!tunnel || !isGostTunnelMode(tunnel)) return [];
      const exitPorts = currentHostTunnelExitPortsForRule(rule, tunnel);
      if (exitPorts.length === 0) return [];
      const protocolPlan = planGostTunnelRuleProtocol({
        protocol: rule.protocol,
        tunnelId: Number(tunnel.id),
        ruleId: Number(rule.id),
        secretSeed: tunnelSecretSeed(tunnel),
      });
      const targetAddr = protocolPlan.exitTargetDialType ? await gostTunnelExitTargetAddr(rule, tunnel) : "";
      return exitPorts.map((exitPort) => {
        return {
          name: `fwx-tunnel-exit-${tunnel.id}-${rule.id}-${exitPort}`,
          addr: `:${exitPort}`,
          handler: protocolPlan.exitHandler,
          listener: {
            type: gostTunnelTransportType(tunnel.mode),
          },
          ...(protocolPlan.exitTargetDialType
            ? {
                forwarder: {
                  nodes: [{
                    name: `target-${rule.id}`,
                    addr: targetAddr,
                    connector: { type: protocolPlan.exitTargetDialType },
                    dialer: { type: protocolPlan.exitTargetDialType },
                  }],
                },
              }
            : {}),
        };
      });
    }))).flat();
    const multiHopRelayServices = await Promise.all((hostTunnels as any[]).map(async (tunnel: any) => {
      if (!tunnel || !runtimeBool(tunnel.isEnabled) || !isGostTunnelMode(tunnel) || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return null;
      const hops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      if (!hops || hops.length < 2) return null;
      const hostIdx = hops.findIndex((hop: any) => Number(hop.hostId) === Number(host.id));
      if (hostIdx < 0 || hostIdx >= hops.length - 1) return null; // not in chain or exit hop
      const currentHop = hops[hostIdx] as any;
      return {
        name: `fwx-mhop-${tunnel.id}-${Number(currentHop.seq)}`,
        addr: `:${Number(currentHop.listenPort)}`,
        handler: planGostTunnelHopRelay({
          tunnelId: Number(tunnel.id),
          secretSeed: tunnelSecretSeed(tunnel),
        }),
        listener: {
          // Entry hop receives local plain TCP traffic; relays receive tunneled traffic.
          type: Number(currentHop.seq) === 0 ? "tcp" : gostTunnelTransportType(tunnel.mode),
        },
      };
    }));
    const services = [...gostTunnelProbeServices, ...ruleServices, ...multiHopRelayServices.filter(Boolean)];
    const countingCmds = tunnelExitRules.flatMap((rule: any) => {
      const tunnel = tunnelById.get(rule.tunnelId) as any;
      if (!tunnel || !isGostTunnelMode(tunnel)) return [];
      return currentHostTunnelExitPortsForRule(rule, tunnel)
        .flatMap((exitPort) => buildCountingChainCmds(Number(exitPort), rule.targetIp, rule.targetPort, rule.protocol));
    });
    const proxyDebugCmds = VERBOSE_AGENT_ACTIONS ? tunnelExitRules.flatMap((rule: any) => {
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      if (!tunnel || isForwardXTunnel(tunnel)) return [];
      if (
        !proxyProtocolEnabled(rule, "entryReceive") &&
        !proxyProtocolEnabled(rule, "entrySend") &&
        !proxyProtocolEnabled(rule, "exitReceive") &&
        !proxyProtocolEnabled(rule, "exitSend")
      ) return [];
      return currentHostTunnelExitPortsForRule(rule, tunnel).map((exitPort) => buildProxyRuleDebugCmd("exit", rule, {
        exitPort: Number(exitPort),
        listener: gostTunnelTransportType(tunnel.mode),
      }));
    }) : [];
    const encodedConfig = Buffer.from(JSON.stringify({ services, ...gostRuntimeApiSection(TUNNEL_RUNTIME_SERVICE_NAME) }, null, 2), "utf8").toString("base64");
    gostManagedConfigs.push({
      path: TUNNEL_RUNTIME_CONFIG_PATH,
      contentBase64: encodedConfig,
      format: "json",
      serviceName: TUNNEL_RUNTIME_SERVICE_NAME,
    });
    const cmds = [
      `mkdir -p ${shQuote(RUNTIME_CONFIG_DIR)}`,
      ...proxyDebugCmds,
      writeManagedServiceCmd(TUNNEL_RUNTIME_SERVICE_NAME, [
        "[Unit]",
        "Description=ForwardX managed tunnel runtime",
        "After=network.target",
        "StartLimitIntervalSec=60",
        "StartLimitBurst=5",
        "",
        "[Service]",
        "Type=simple",
        `ExecStart=${gostRuntimeExecStart(TUNNEL_RUNTIME_SERVICE_NAME, TUNNEL_RUNTIME_CONFIG_PATH)}`,
        "Restart=always",
        "RestartSec=5",
        `LimitNOFILE=${SHARED_RUNTIME_NOFILE}`,
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ].join("\n")),
      stopManagedServiceCmd(LEGACY_TUNNEL_SERVICE_NAME),
    ];
    if (services.length > 0) {
      cmds.unshift(ensureRuntimeBinaryCmd());
      if (anyTunnelDnsRefresh(hostTunnels as any[])) {
        cmds.push(dnsRuntimeRefreshCmd("gost-tunnel"), `rm -f ${shQuote(`${TUNNEL_RUNTIME_CONFIG_PATH}.sha256`)} 2>/dev/null || true`);
      }
      cmds.push(gostRuntimeSyncCmd(TUNNEL_RUNTIME_SERVICE_NAME, TUNNEL_RUNTIME_CONFIG_PATH));
    } else {
      cmds.push(stopManagedServiceCmd(TUNNEL_RUNTIME_SERVICE_NAME));
    }
    cmds.push(...countingCmds);
    return cmds;
  };
  return { buildGostReloadCmds, buildTunnelReloadCmds, gostManagedConfigs, gostServiceConfig, gostTunnelProbePlans };
}
