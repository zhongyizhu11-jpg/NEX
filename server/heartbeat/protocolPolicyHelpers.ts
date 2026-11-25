/*
  从 server/agentHeartbeatRoute.ts 第 2772-2985 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { isNginxTunnelMode } from "../agentHeartbeatNginx";
import { hasProtocolPolicy, protocolPolicyFromHost, selectProtocolGuardRateLimit, shouldUseProcessBackendGuard } from "../agentHeartbeatProtocolGuard";
import { isGostTunnelMode, runtimeBool } from "../agentHeartbeatRuntime";
import * as db from "../db";
import { isRuleProtocolEnabled, isTunnelProtocolEnabled } from "../forwardProtocolSettings";
import { cleanEndpointHost } from "../forwardRuntimeConfigs";
import { isForwardXWireGuardV2, type ForwardXWireGuardNodePlan } from "../forwardXWireGuard";
import { isEntryBridgeRuntimeRule } from "../ruleEntryBridges";
import { portRangeAgentUnsupportedReason } from "../rulePortRange";
import { isSniRuntimeRule } from "../tlsInboundRuntime";
import { tunnelLinkShaping } from "../tunnelFxpRuntime";
import { getHostWireGuardPlane } from "../tunnelRuntimeStatus";
import { isForwardRuleProtocolTcpEnabled, normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import { isPortRangeRule } from "@shared/portRange";
import { isIP } from "net";

export type BuildProtocolPolicyHelpersContext = {
  emptyProtocolPolicy: { blockHttp: boolean; blockSocks: boolean; blockTls: boolean; };
  hostProtocolPolicyById: Map<number, { blockHttp: boolean; blockSocks: boolean; blockTls: boolean; }>;
  isCurrentHostTunnelEntry: any /* 原类型 (tunnel: any) => boolean… 引用了拿不到的 tunnel，手动收拾 */;
  host: any;
  forwardProtocolSettings: any /* 原类型 ForwardProtocolSettings… 引用了拿不到的 ForwardProtocolSettings，手动收拾 */;
  tunnelEntryHostIds: any /* 原类型 (tunnel: any) => Array<number>… 引用了拿不到的 tunnel，手动收拾 */;
  tunnelHopsByTunnelId: Map<number, Array<any>>;
  tunnelExitNodesByTunnelId: Map<number, Array<any>>;
  getTunnelDialHost: any /* 原类型 (hostId: unknown) => Promise<any>… 引用了拿不到的 hostId，手动收拾 */;
  getForwardXWireGuardPlans: any /* 原类型 (tunnel: any) => Promise<Map<number, ForwardXWireGuardNodePlan>>… 引用了拿不到的 tunnel，手动收拾 */;
  forwardGroupHealthByRuleId: Map<number, any>;
  ruleRateLimits: any /* 原类型 (rule: any, tunnel?: any | null) => { rateLimitScope: string; limitIn: number; l… 引用了拿不到的 tunnel，手动收拾 */;
  userAccessLimits: any /* 原类型 (userId: number) => { maxConnections: number; maxIPs: number; }… 引用了拿不到的 userId，手动收拾 */;
  proxyProtocolOptions: any /* 原类型 (rule: any) => ResolvedRuleProxyProtocolOptions… 引用了拿不到的 rule，手动收拾 */;
  agentAllRules: Array<any>;
  tunnelById: Map<any, any>;
  protocolGuardPortsForRule: any /* 原类型 (rule: any) => ProtocolGuardPortPlan… 引用了拿不到的 rule，手动收拾 */;
  failoverTargetEndpoint: any /* 原类型 (rule: any, proxyDirection?: "send" | "exitSend") => { targetIp: any; targetPort… 引用了拿不到的 rule，手动收拾 */;
  isCurrentHostTunnelExitForRule: any /* 原类型 (rule: any, tunnel: any) => boolean… 引用了拿不到的 tunnel，手动收拾 */;
};

export type BuildProtocolPolicyHelpersResult = {
  tunnelProtocolPolicy: any /* 原类型 (tunnel: any) => Promise<{ blockHttp: boolean; blockSocks: boolean; blockTls: bo… 引用了拿不到的 tunnel，手动收拾 */;
  guardListenPort: any /* 原类型 (rule: any) => number… 引用了拿不到的 rule，手动收拾 */;
  shouldUseRuleGuard: any /* 原类型 (rule: any) => Promise<any>… 引用了拿不到的 rule，手动收拾 */;
  guardBackendPort: any /* 原类型 (rule: any) => number… 引用了拿不到的 rule，手动收拾 */;
  tunnelExitRules: Array<any>;
  nginxTunnelExitRules: Array<any>;
  ruleProtocolPolicy: any /* 原类型 (rule: any) => Promise<{ blockHttp: boolean; blockSocks: boolean; blockTls: bool… 引用了拿不到的 rule，手动收拾 */;
  kernelPassthroughForRule: any /* 原类型 (rule: any, tunnel: any) => Promise<KernelPassthroughPlan | null>… 引用了拿不到的 tunnel，手动收拾 */;
  guardTargetForRule: any /* 原类型 (rule: any, useRuleGuard: boolean) => { backendPort: number; backendForwardType:… 引用了拿不到的 rule，手动收拾 */;
  guardRateLimitForRule: any /* 原类型 (rule: any) => { rateLimits?: Array<{ burstOut?: number | undefined; burstIn?: n… 引用了拿不到的 rule，手动收拾 */;
  kernelPassthroughRuleView: any /* 原类型 (rule: any, plan: KernelPassthroughPlan) => any… 引用了拿不到的 rule，手动收拾 */;
  portRangeRuntimeBlocker: any /* 原类型 (rule: Record<string, unknown>) => string | null… 引用了拿不到的 rule，手动收拾 */;
  kernelPassthroughEntriesForTunnel: any /* 原类型 (tunnel: any) => Promise<Array<Record<string, unknown>>>… 引用了拿不到的 tunnel，手动收拾 */;
};

export function buildProtocolPolicyHelpers(ctx: BuildProtocolPolicyHelpersContext): BuildProtocolPolicyHelpersResult {
  const { emptyProtocolPolicy, hostProtocolPolicyById, isCurrentHostTunnelEntry, host, forwardProtocolSettings, tunnelEntryHostIds, tunnelHopsByTunnelId, tunnelExitNodesByTunnelId, getTunnelDialHost, getForwardXWireGuardPlans, forwardGroupHealthByRuleId, ruleRateLimits, userAccessLimits, proxyProtocolOptions, agentAllRules, tunnelById, protocolGuardPortsForRule, failoverTargetEndpoint, isCurrentHostTunnelExitForRule } = ctx;
  const getHostProtocolPolicy = async (hostId: number) => {
    const id = Number(hostId);
    if (!Number.isFinite(id) || id <= 0) return emptyProtocolPolicy;
    const cached = hostProtocolPolicyById.get(id);
    if (cached) return cached;
    const entryHost = await db.getHostById(id);
    const policy = entryHost ? protocolPolicyFromHost(entryHost) : emptyProtocolPolicy;
    hostProtocolPolicyById.set(id, policy);
    return policy;
  };
  const ruleProtocolPolicy = (rule: any) => getHostProtocolPolicy(Number((rule as any)?.hostId || 0));
  const tunnelProtocolPolicy = (tunnel: any) => getHostProtocolPolicy(isCurrentHostTunnelEntry(tunnel) ? Number(host.id) : Number((tunnel as any)?.entryHostId || 0));
  /*
    V2 内核直通（隧道开关 kernelPassthrough，2.3.431 起）。

    开着的时候，这条隧道上的普通规则不再经 FXP：入口机把规则端口 DNAT 到出口机的 WireGuard
    地址（同一个端口），包在内核里直接进 nexwg；出口机在 nexwg 上把来自入口 WireGuard 地址的
    这个端口 DNAT 到规则目标。两头都没有用户态进程，加密只有 WireGuard 这一层。入口这边下发
    的就是一条普通的 iptables 规则（目标 = 出口 WireGuard 地址:规则端口），所以状态上报、
    流量计数、就绪检查、从 FXP 切换过来时停掉旧进程这些都走现成的 iptables 路径；出口那边
    的 DNAT 跟着 WireGuard 数据面配置一起下发（wireGuard.passthrough），Agent 在建 / 更新
    nexwg 时同步，隧道停掉时跟着清掉。

    只有这些条件全满足才直通，否则规则照旧走 FXP（切换是自动的，不用改规则）：
      - 隧道是 V2，单入口、单出口（没有中转、没有入口组、没有额外出口）；
      - 两台机器都报告自己跑的是内核 WireGuard（用户态 wireguard-go 没有内核路由可用）；
      - 隧道没开链路整形、UDP 抗丢包、协议拦截、PROXY protocol（这些都是 FXP 里做的）；
      - 规则没有限速、连接数 / IP 数限制、线路组、PROXY protocol，目标是 IPv4 地址
        （域名由面板解析成 IP 后同样可以）。
  */
  type KernelPassthroughPlan = { entryHostId: number; exitHostId: number; entryAddress: string; exitAddress: string };
  const kernelPassthroughPlanPromises = new Map<number, Promise<KernelPassthroughPlan | null>>();
  const tunnelKernelPassthroughPlan = (tunnel: any): Promise<KernelPassthroughPlan | null> => {
    const tunnelId = Number(tunnel?.id || 0);
    const cached = kernelPassthroughPlanPromises.get(tunnelId);
    if (cached) return cached;
    const work = (async () => {
      if (!tunnel || tunnelId <= 0 || !runtimeBool((tunnel as any).kernelPassthrough) || !isForwardXWireGuardV2(tunnel)) return null;
      if (!runtimeBool(tunnel.isEnabled) || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) return null;
      const entryHostIds = tunnelEntryHostIds(tunnel);
      const exitHostId = Number(tunnel.exitHostId || 0);
      const hops = tunnelHopsByTunnelId.get(tunnelId) || [];
      const extraExits = (tunnelExitNodesByTunnelId.get(tunnelId) || []).filter((node: any) => runtimeBool(node?.isEnabled, true));
      if (entryHostIds.length !== 1 || exitHostId <= 0 || entryHostIds[0] === exitHostId) return null;
      if (hops.length >= 3 || (runtimeBool((tunnel as any).loadBalanceEnabled) && extraExits.length > 0)) return null;
      if (tunnelLinkShaping(tunnel).mode !== "off" || runtimeBool((tunnel as any).udpFec)) return null;
      if (runtimeBool((tunnel as any).proxyProtocolReceive) || runtimeBool((tunnel as any).proxyProtocolSend)
        || runtimeBool((tunnel as any).proxyProtocolExitReceive) || runtimeBool((tunnel as any).proxyProtocolExitSend)) return null;
      const policy = await tunnelProtocolPolicy(tunnel);
      if (policy.blockHttp || policy.blockSocks || policy.blockTls) return null;
      const entryHostId = entryHostIds[0];
      for (const hostId of [entryHostId, exitHostId]) {
        if (getHostWireGuardPlane(tunnelId, hostId) !== "kernel") return null;
        const member = hostId === Number(host.id) ? host : await getTunnelDialHost(hostId).catch(() => null);
        if (!member) return null;
      }
      let plans: Map<number, ForwardXWireGuardNodePlan>;
      try {
        plans = await getForwardXWireGuardPlans(tunnel);
      } catch {
        return null;
      }
      const entryAddress = String(plans.get(entryHostId)?.address || "").trim();
      const exitAddress = String(plans.get(exitHostId)?.address || "").trim();
      if (!entryAddress || !exitAddress) return null;
      return { entryHostId, exitHostId, entryAddress, exitAddress };
    })();
    kernelPassthroughPlanPromises.set(tunnelId, work);
    return work;
  };
  const kernelPassthroughRuleTarget = (rule: any) => {
    const targetIp = cleanEndpointHost(rule?.targetIp);
    const targetPort = Number(rule?.targetPort || 0);
    if (isIP(targetIp) !== 4 || !Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) return null;
    return { targetIp, targetPort };
  };
  const ruleKernelPassthroughEligible = (rule: any, tunnel: any) => {
    if (!rule || rule.forwardType !== "gost" || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled)) return false;
    if (Number(rule.tunnelId || 0) !== Number(tunnel?.id || 0) || !isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) return false;
    if (isEntryBridgeRuntimeRule(rule) || runtimeBool(rule.failoverEnabled) || forwardGroupHealthByRuleId.has(Number(rule.id))) return false;
    // 共享 TLS 入站上的规则：连接从本机回环进来，PREROUTING 的直通规则接不到。
    if (isSniRuntimeRule(rule)) return false;
    const port = Number(rule.sourcePort || 0);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || !kernelPassthroughRuleTarget(rule)) return false;
    const limits = ruleRateLimits(rule, tunnel);
    if (limits.limitIn > 0 || limits.limitOut > 0) return false;
    const access = userAccessLimits(Number(rule.userId));
    if (access.maxConnections > 0 || access.maxIPs > 0) return false;
    const proxy = proxyProtocolOptions(rule);
    if (proxy.proxyProtocolReceive || proxy.proxyProtocolSend || proxy.proxyProtocolExitReceive || proxy.proxyProtocolExitSend) return false;
    return true;
  };
  /** 入口机上这条规则该不该直通；是的话返回隧道的直通计划（出口 WireGuard 地址在里面）。 */
  const kernelPassthroughForRule = async (rule: any, tunnel: any) => {
    if (!tunnel || !isForwardXWireGuardV2(tunnel) || !runtimeBool((tunnel as any).kernelPassthrough)) return null;
    if (!ruleKernelPassthroughEligible(rule, tunnel)) return null;
    const plan = await tunnelKernelPassthroughPlan(tunnel);
    return plan && plan.entryHostId === Number(host.id) ? plan : null;
  };
  /** 直通规则在入口机上的样子：一条 iptables 规则，目标是出口 WireGuard 地址上的同一个端口。 */
  const kernelPassthroughRuleView = (rule: any, plan: KernelPassthroughPlan) => ({
    ...rule,
    forwardType: "iptables",
    targetIp: plan.exitAddress,
    _originalTargetIp: plan.exitAddress,
    targetPort: Number(rule.sourcePort),
  });
  /** 这台机器在隧道 WireGuard 配置里要带的直通表：出口带 DNAT 目标，入口只是告诉 Agent 有规则在用这条隧道。 */
  const kernelPassthroughEntriesForTunnel = async (tunnel: any) => {
    const plan = await tunnelKernelPassthroughPlan(tunnel);
    if (!plan) return [] as Array<Record<string, unknown>>;
    const role = plan.exitHostId === Number(host.id) ? "exit" : plan.entryHostId === Number(host.id) ? "entry" : "";
    if (!role) return [] as Array<Record<string, unknown>>;
    const entries: Array<Record<string, unknown>> = [];
    for (const rule of agentAllRules as any[]) {
      if (!ruleKernelPassthroughEligible(rule, tunnel)) continue;
      const target = kernelPassthroughRuleTarget(rule)!;
      entries.push({
        ruleId: Number(rule.id),
        role,
        peerId: String(role === "exit" ? plan.entryHostId : plan.exitHostId),
        port: Number(rule.sourcePort),
        protocol: normalizeForwardRuleProtocol(rule.protocol, "both"),
        ...(role === "exit" ? { targetIp: target.targetIp, targetPort: target.targetPort } : {}),
      });
    }
    return entries.sort((a, b) => Number(a.ruleId) - Number(b.ruleId));
  };
  const tunnelForRule = (rule: any) => (
    Number(rule?.tunnelId || 0) > 0 ? tunnelById.get(Number(rule.tunnelId)) as any : null
  );
  const isNginxTunnelEntryRule = (rule: any, tunnel = tunnelForRule(rule)) => (
    !!tunnel && isNginxTunnelMode(tunnel) && isCurrentHostTunnelEntry(tunnel)
  );
  const guardRateLimitForRule = (rule: any) => {
    const tunnel = tunnelForRule(rule);
    const limits = ruleRateLimits(rule, tunnel);
    return selectProtocolGuardRateLimit({
      hostId: Number(host.id) || 0,
      rule: {
        ...rule,
        tunnelMode: tunnel?.mode,
        tunnelEntry: isNginxTunnelEntryRule(rule, tunnel),
      },
      ...limits,
    });
  };
  const shouldUseRuleGuard = async (rule: any) => {
    // 端口段规则（shared/portRange.ts）只走内核 DNAT：守卫是一个端口一个进程，接不了一整段。
    // 段规则要限速时不在这里悄悄放行，而是下面内核那一支直接报错（portRangeRuntimeBlocker）。
    if (isPortRangeRule(rule)) return false;
    // 旧入口桥接只是把流量原样递给新入口，限速、协议封禁由新入口上的规则本身执行；
    // 这里再套一层守卫会多一个用户态进程，还会让同一份限速串联两次。
    if (isEntryBridgeRuntimeRule(rule)) return false;
    // 共享 TLS 入站上的规则一律由守卫在回环上接（入站把连接交到 127.0.0.1:sourcePort），
    // 计数、限速和普通规则同一套。经隧道的不用守卫：隧道入口自己只听回环（见 tlsInboundRuntime.ts）。
    const tunnel = tunnelForRule(rule);
    if (isSniRuntimeRule(rule) && !tunnel) return true;
    const nginxTunnelEntry = isNginxTunnelEntryRule(rule, tunnel);
    const rateLimits = guardRateLimitForRule(rule);
    if (rateLimits.limitIn > 0 || rateLimits.limitOut > 0) {
      // GOST already applies the same user bucket in its runtime config.
      // Keep the Agent guard for process backends and Nginx tunnel entries
      // only, otherwise two serial buckets halve the effective rate.
      if (rule.forwardType !== "gost" || nginxTunnelEntry) return true;
    }
    if (tunnel) return false;
    if (!shouldUseProcessBackendGuard(rule)) return false;
    if (!isForwardRuleProtocolTcpEnabled(rule.protocol)) return false;
    return hasProtocolPolicy(await ruleProtocolPolicy(rule));
  };
  const guardListenPort = (rule: any) => protocolGuardPortsForRule(rule).guardListenPort;
  /** 端口段规则这一轮能不能下发；不能就是给用户看的原因（见内核转发那一支）。 */
  const portRangeRuntimeBlocker = (rule: Record<string, unknown>): string | null => {
    const agentReason = portRangeAgentUnsupportedReason(host);
    if (agentReason) return agentReason;
    const limits = guardRateLimitForRule(rule);
    if (limits.limitIn > 0 || limits.limitOut > 0) return "端口段规则不能限速（内核转发限速要换成用户态守卫，一个端口一个进程），请取消限速或改回单端口";
    return null;
  };
  const guardBackendPort = (rule: any) => protocolGuardPortsForRule(rule).guardBackendPort;
  const guardTargetForRule = (rule: any, useRuleGuard: boolean) => (
    useRuleGuard && shouldUseProcessBackendGuard(rule)
      && (!tunnelForRule(rule) || isNginxTunnelEntryRule(rule))
      ? {
          targetIp: "127.0.0.1",
          targetPort: guardBackendPort(rule),
          backendPort: guardBackendPort(rule),
          backendForwardType: isNginxTunnelEntryRule(rule) ? "nginx" : String(rule.forwardType || ""),
        }
      : { ...failoverTargetEndpoint(rule), backendPort: 0, backendForwardType: "" }
  );
  const tunnelExitRules = agentAllRules
    .filter((r: any) => {
      if (runtimeBool(r.pendingDelete) || !runtimeBool(r.isEnabled) || r.forwardType !== "gost" || !r.tunnelId) return false;
      const tunnel = tunnelById.get(r.tunnelId) as any;
      return !!tunnel
        && runtimeBool(tunnel.isEnabled)
        && isGostTunnelMode(tunnel)
        && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
        && isRuleProtocolEnabled(forwardProtocolSettings, r, tunnel)
        && isCurrentHostTunnelExitForRule(r, tunnel);
    });
  const nginxTunnelExitRules = agentAllRules
    .filter((r: any) => {
      if (runtimeBool(r.pendingDelete) || !runtimeBool(r.isEnabled) || r.forwardType !== "gost" || !r.tunnelId) return false;
      const tunnel = tunnelById.get(r.tunnelId) as any;
      return !!tunnel
        && runtimeBool(tunnel.isEnabled)
        && isNginxTunnelMode(tunnel)
        && isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)
        && isRuleProtocolEnabled(forwardProtocolSettings, r, tunnel)
        && isCurrentHostTunnelExitForRule(r, tunnel);
    });
  return { tunnelProtocolPolicy, guardListenPort, shouldUseRuleGuard, guardBackendPort, tunnelExitRules, nginxTunnelExitRules, ruleProtocolPolicy, kernelPassthroughForRule, guardTargetForRule, guardRateLimitForRule, kernelPassthroughRuleView, portRangeRuntimeBlocker, kernelPassthroughEntriesForTunnel };
}
