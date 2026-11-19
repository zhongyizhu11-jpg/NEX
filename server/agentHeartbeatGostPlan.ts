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
  /** 这条规则的主出口节点（不走本机代理时链里只有它一台；没有选择器）。解析不出地址返回 null。 */
  buildPrimaryExitNode: (rule: HeartbeatRow, tunnel: HeartbeatRow, primaryHostOverride?: string | undefined) => Promise<HeartbeatRow | null>;
  buildProxyRuleDebugCmd: (label: string, rule: HeartbeatRow, extra?: Record<string, unknown>) => string;
  currentHostTunnelExitPortsForRule: (rule: HeartbeatRow, tunnel: HeartbeatRow) => number[];
  dnsRuntimeRefreshCmd: (label: string) => string;
  failoverTargetAddr: (rule: HeartbeatRow, proxyDirection?: "send" | "exitSend") => string;
  getHopDialAddress: (hop: HeartbeatRow, tunnel?: HeartbeatRow) => Promise<string>;
  /**
   * GOST 链路负载均衡由入口本机代理挑的规则（见 agentHeartbeatRoute 的 gostBalancePlans、server/gostBalancePlan.ts）。
   * targetAddr 是出口该拨的目标（和不走代理时入口服务的 forwarder 同一个）；proxyVersion 是 TCP 上给代理的 PROXY 头版本。
   */
  gostBalancePlans: Map<number, { failoverPort: number; exits: Array<{ hostId: number; localPort: number; node: HeartbeatRow }>; targetAddr: string; proxyVersion: 1 | 2 }>;
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
    buildPrimaryExitNode,
    buildProxyRuleDebugCmd,
    currentHostTunnelExitPortsForRule,
    dnsRuntimeRefreshCmd,
    failoverTargetAddr,
    getHopDialAddress,
    gostBalancePlans,
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
        // 并联中转（中转故障切换）：一台中转拨不通就换下一台重拨，拨号别等默认的长超时。出口那一跳永远只有一个
        // 节点（几台出口由本机代理挑，见下面的 balanceGostChains），不靠 gost 重试。
        const routeRetries = relayFailover ? tunnelRelayCandidates(tunnelHops as any[]).length - 1 : 0;
        const fastFailover = relayFailover;
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
        } else if (gostBalancePlans.has(Number(r.id))) {
          /*
            GOST 链路负载均衡：端口照旧由 gost 听（计数、限速、连接数限制都在这里），收下的连接 / UDP 会话交给本机
            代理（Agent 的 failoverProxy），它在「每台出口一个本机 gost 端口」之间挑。出口切换只改代理的提示，不改
            这里的配置，正在走的连接不断。

            handler 总是带 proxyProtocol：gost 连上代理就先发一个 PROXY 头，代理从里面读访客地址（按访客固定、
            「连上就被关」算谁的账）。规则本来就往目标发头（入口发送）时代理原样转给出口；否则代理读完扔掉
            （规格里的 proxyProtocolStrip）。「入口接收」还是这个公网监听的事（上面的 service.metadata），gost 把
            收到的头里的访客地址写进它发给代理的头。UDP 固定用 v2：gost 给每个新会话先发一个只有头的包
            （v1 是文本协议，没有 UDP），代理认出来记下访客、不转发（agent/route_group_udp_visitor.go）。
          */
          const balance = gostBalancePlans.get(Number(r.id))!;
          service.handler = { type: proto, metadata: gostProxyProtocolMetadata(proto === "udp" ? 2 : balance.proxyVersion) };
          service.forwarder = {
            nodes: [{
              name: `balance-${r.id}`,
              addr: endpointHostPort("127.0.0.1", balance.failoverPort),
              connector: { type: proto },
              dialer: { type: proto },
            }],
          };
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
  /*
    多跳链路从入口到最后一台中转的那几跳（不含出口那一跳）。并联中转是一跳、几台中转按顺序用（中转的故障切换，
    和出口组无关）；串联中转一台一跳。有中转的地址解析不出来返回 null（整条链不生成）。suffix 给跳和节点的名字
    加后缀：每台出口各有一条链时名字不能撞。
  */
  const buildRelayHops = async (r: { id?: number | null }, tunnel: HeartbeatRow, tunnelHops: HeartbeatRow[], suffix: string, routeParts?: string[]) => {
    const hops: Array<Record<string, unknown>> = [];
    if (isTunnelRelayFailover(tunnel, tunnelHops)) {
      const relayNodes = await Promise.all(tunnelRelayCandidates(tunnelHops).map(async (hop: HeartbeatRow, index: number) => {
        const hopDialHost = await getHopDialAddress(hop, tunnel);
        if (!hopDialHost || !Number(hop.listenPort)) return null;
        const hopAddr = endpointHostPort(hopDialHost, hop.listenPort);
        routeParts?.push(`relay#${index + 1}:${Number(hop.hostId)}@${hopAddr}`);
        return gostTunnelNode(`relay-${r.id}-${Number(hop.seq)}${suffix}`, hopAddr, gostTunnelTransportType(tunnel.mode), tunnel);
      }));
      const validRelayNodes = relayNodes.filter(Boolean);
      if (validRelayNodes.length !== tunnelRelayCandidates(tunnelHops).length) return null;
      hops.push({ name: `hop-tunnel-${r.id}-relay-failover${suffix}`, selector: gostRelayFailoverHopMetadata, nodes: validRelayNodes });
      return hops;
    }
    for (let i = 1; i < tunnelHops.length - 1; i++) {
      const hop = tunnelHops[i];
      const hopDialHost = await getHopDialAddress(hop, tunnel);
      if (!hopDialHost || !Number(hop.listenPort)) return null;
      const hopAddr = endpointHostPort(hopDialHost, hop.listenPort);
      routeParts?.push(`hop#${Number(hop.hostId)}@${hopAddr}`);
      hops.push({
        name: `hop-tunnel-${r.id}-${Number(hop.seq)}${suffix}`,
        nodes: [gostTunnelNode(`mhop-${r.id}-${Number(hop.seq)}${suffix}`, hopAddr, gostTunnelTransportType(tunnel.mode), tunnel)],
      });
    }
    return hops;
  };
  /*
    GOST 链路负载均衡：每台出口一个本机 gost 端口（只听 127.0.0.1，TCP、UDP 同一个号），各挂一条只走那台出口的
    链（多跳链路是「中转 → 那台出口」）；本机代理拨它们。
      · forwarder 是出口该拨的目标（和不走代理时入口服务的一样）：relay 隧道里「出口拨哪儿」是入口在请求里说的，
        没有它出口不知道往哪儿拨（2.3.539 那一版就缺这个）。
      · 出口那一跳只有一个节点、没有选择器：gost 的「节点全被摘掉 → 路由为空 → 入口机直连目标」那条路在这里不存在。
        拨不通出口就是把本机这条连接关掉，代理当场换下一台。
      · dialTimeout 3 秒：出口被黑洞时 3 秒后关本机连接（代理的「连上就被关」保护期是 8 秒，够它换路重发）。
      · 限速、计数只在前面那个公网端口上算一次，这里不挂。
  */
  const balanceGostChains: Array<Record<string, unknown>> = [];
  for (const r of gostRules as Array<{ id?: number | null; isEnabled?: unknown; protocol?: string | null; tunnelId?: number | null }>) {
    const balance = gostBalancePlans.get(Number(r?.id || 0));
    if (!balance || !runtimeBool(r.isEnabled)) continue;
    const tunnel = tunnelById.get(Number(r.tunnelId)) as HeartbeatRow | undefined;
    const tunnelHops = tunnel ? tunnelHopsByTunnelId.get(Number(tunnel.id)) as HeartbeatRow[] | undefined : undefined;
    const multiHop = !!tunnel && Array.isArray(tunnelHops) && tunnelHops.length >= 3;
    // 并联中转：一台中转拨不通，这条本机连接换下一台中转重拨（出口还是这一台）
    const relayRetries = multiHop && tunnelRelayUsesParallelRelays(tunnel, tunnelHops) ? tunnelRelayCandidates(tunnelHops!).length - 1 : 0;
    for (const exit of balance.exits) {
      const chainName = `chain-tunnel-${r.id}-x${exit.hostId}`;
      const relayHops = multiHop ? await buildRelayHops(r, tunnel!, tunnelHops!, `-x${exit.hostId}`) : [];
      // 中转解析不出来：这台出口的本机端口照样听着，只是链是空的会直连 —— 不能留。不生成服务，代理拨不上本机端口，
      // 不算出口的账，流量走不通（和不走代理时整条链不生成一样）。
      if (!relayHops) continue;
      for (const proto of tunnelForwardProtos(String(r.protocol || "tcp"))) {
        gostServiceConfig.push({
          name: `fwx-${r.id}-${proto}-x${exit.hostId}`,
          addr: endpointHostPort("127.0.0.1", exit.localPort),
          handler: { type: proto, chain: chainName, ...(relayRetries > 0 ? { retries: relayRetries } : {}) },
          listener: buildGostRuleListener(proto),
          metadata: { dialTimeout: "3s" },
          forwarder: {
            nodes: [{
              name: `target-${r.id}`,
              addr: balance.targetAddr,
              connector: { type: proto },
              dialer: { type: proto },
            }],
          },
        });
      }
      balanceGostChains.push({ name: chainName, hops: [...relayHops, { name: `hop-tunnel-${r.id}-x${exit.hostId}`, nodes: [exit.node] }] });
    }
  }
  /*
    不走本机代理的隧道规则（只有一台出口；或者这台入口机的 Agent 还不能执行统一调度 —— 那时只走主出口，链路上标
    「需要升级 Agent」）：一条链，出口那一跳只有主出口一个节点。几台出口带选择器的链已经没有了：gost 的选择器
    摘空时会让入口机直连目标，而且它的算法、健康判断和别的运行时都不一样。
  */
  const tunnelGostChains = (await Promise.all(gostRules
    .filter((r: any) => runtimeBool(r.isEnabled) && r.forwardType === "gost" && r.tunnelId)
    .map(async (r: any) => {
      const tunnel = tunnelById.get((r as any).tunnelId) as any;
      if (!isGostTunnelMode(tunnel)) return null;
      // 负载均衡由本机代理挑的规则（TCP、UDP 都是）：用的是上面每台出口各一条的链
      if (gostBalancePlans.has(Number(r.id))) return null;
      const tunnelExitHost = tunnel ? tunnelExitEndpointById.get(tunnel.id)?.host : "";
      if (!tunnel || !tunnelExitHost || tunnelExitEndpointsForRule(r, tunnel).length === 0) return null;
      const tunnelHops = tunnelHopsByTunnelId.get(Number(tunnel.id));
      const firstHop = Array.isArray(tunnelHops) && tunnelHops.length >= 2 ? (tunnelHops[0] as any) : null;
      const isMultiHopTunnel = Array.isArray(tunnelHops) && tunnelHops.length >= 3;
      if (!isMultiHopTunnel) {
        const exitNode = await buildPrimaryExitNode(r, tunnel);
        if (!exitNode) return null;
        return { name: `chain-tunnel-${r.id}`, hops: [{ name: `hop-tunnel-${r.id}`, nodes: [exitNode] }] };
      }
      // Multi-hop rules on the entry host must build an explicit B->...->exit chain.
      // Dialing the local first-hop listener only proves the generic probe path and bypasses
      // the selected tunnel exit listener.
      if (!isCurrentHostTunnelEntry(tunnel)) {
        console.warn(`[TunnelRoute] skip direct fallback for multi-hop tunnel=${tunnel.id} rule=${r.id}; entry host mismatch host=${host.id} firstHop=${Number(firstHop?.hostId) || 0}`);
        return null;
      }
      const routeParts: string[] = [`entry#${Number(host.id)}:${Number((r as any).sourcePort)}`];
      const chainHops = await buildRelayHops(r, tunnel, tunnelHops as any[], "", routeParts);
      if (!chainHops) return null;
      const exitHop = tunnelHops[tunnelHops.length - 1] as any;
      const exitHost = await getHopDialAddress(exitHop, tunnel);
      const exitNode = exitHost ? await buildPrimaryExitNode(r, tunnel, exitHost) : null;
      if (!exitNode) return null;
      chainHops.push({ name: `hop-tunnel-${r.id}-exit`, nodes: [exitNode] });
      routeParts.push(`exit#${Number(exitHop.hostId)}@${String((exitNode as { addr?: string }).addr || "")}`);
      const route = routeParts.join(" -> ");
      const routeKey = `${tunnel.id}:${r.id}:${host.id}`;
      if (tunnelRouteLogCache.get(routeKey) !== route) {
        setBoundedMapValue(tunnelRouteLogCache, routeKey, route, AGENT_DYNAMIC_CACHE_MAX);
        appendPanelLog("info", `[TunnelRoute] gost multi-hop tunnel=${tunnel.id} rule=${r.id} host=${host.id} proxyEntrySend=${proxyProtocolEnabled(r, "entrySend")} route=${route}`);
      }
      return { name: `chain-tunnel-${r.id}`, hops: chainHops };
    }))).filter(Boolean);
  const gostChains = [...tunnelGostChains, ...balanceGostChains, ...egressGostChains];
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
        // 中转拨下一跳最多等 3 秒：下一跳（出口）被黑洞时尽快把这条连接关掉，入口机的本机代理才能及时换出口
        // （它的「连上就被关」保护期是 8 秒；不写的话是运行时默认的长超时，换路来不及）。
        metadata: { dialTimeout: "3s" },
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
