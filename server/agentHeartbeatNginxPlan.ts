import crypto from "crypto";
import { isRuleProtocolEnabled, isTunnelProtocolEnabled } from "./forwardProtocolSettings";
import { appendPanelLog } from "./_core/panelLogger";
import { setBoundedMapValue } from "./boundedCache";
import { buildCountingChainCmds, shQuote, writeManagedServiceCmd } from "./agentActionCommands";
import {
  AGENT_DYNAMIC_CACHE_MAX,
  AGENT_HOST_CACHE_MAX,
  nginxRuntimeLogCache,
  tunnelRouteLogCache,
} from "./agentHeartbeatState";
import { runtimeBool } from "./agentHeartbeatRuntime";
import {
  buildNginxCertificateCleanupCmd,
  buildNginxRuntimeRetirementPlan,
  buildNginxStreamConfig,
  buildNginxStreamServerBlock,
  buildNginxTunnelServerCertificate,
  buildNginxTunnelTlsClientOptions,
  ensureNginxBinaryCmd,
  isNginxTunnelMode,
  NGINX_BIN,
  NGINX_CERT_DIR,
  NGINX_CONFIG_DIR,
  NGINX_CONFIG_PATH,
  NGINX_SERVICE_NAME,
  nginxEndpoint,
  nginxProtocolsForRule,
  type NginxStreamServerOptions,
  nginxUpstreamBlock,
  reloadNginxIfConfigChangedCmd,
} from "./agentHeartbeatNginx";
import type { HeartbeatRequestContext, HeartbeatRow, HeartbeatRuleRow } from "./agentHeartbeatContext";

/*
  nginx stream 运行时这一次心跳的同步计划：本机的 nginx 规则、nginx 隧道的入口 / 出口 / 探测端口拼成一份配置，
  再配上写服务、重载、计数链的命令；本机没有要跑的就给退役计划。
  从 server/agentHeartbeatRoute.ts 的心跳处理函数里搬出来：函数体原样不动，原来从闭包里读的值改由
  ctx（本次请求只读的值，见 agentHeartbeatContext.ts）和 deps（处理函数里的那几个辅助闭包）在开头解构出来。
  处理函数仍在原来的位置建出 buildNginxRuntimeSyncPlan，也仍旧只在要下发时才调用（getNginxRuntimeSyncPlan）。
*/

export type NginxRuntimeSyncPlanDeps = {
  anyTunnelDnsRefresh: (tunnels: HeartbeatRow[]) => boolean;
  buildRuleAccessLimitCmds: (rule: HeartbeatRow) => string[];
  currentHostTunnelExitPortsForRule: (rule: HeartbeatRow, tunnel: HeartbeatRow) => number[];
  dnsRuntimeRefreshCmd: (label: string) => string;
  exitWeightsForHostIds: (strategy: unknown, hostIds: number[]) => Promise<number[] | null>;
  failoverTargetEndpoint: (rule: HeartbeatRow, proxyDirection?: "send" | "exitSend") => { targetIp: HeartbeatRow; targetPort: number; };
  getExtraExitDialAddress: (exitNode: HeartbeatRow, tunnel?: HeartbeatRow) => Promise<string>;
  guardBackendPort: (rule: HeartbeatRow) => number;
  isCurrentHostTunnelEntry: (tunnel: HeartbeatRow) => boolean;
  nginxTunnelExitRules: HeartbeatRow[];
  shouldUseRuleGuard: (rule: HeartbeatRuleRow) => Promise<boolean>;
  tunnelExitEndpointsForRule: (rule: HeartbeatRow, tunnel: HeartbeatRow) => { exitNodeId: number; exitSeq: number; exitHostId: number; listenPort: number; rulePort: number; primary: boolean; node?: HeartbeatRow; }[];
  tunnelExitHostAddress: (tunnel: HeartbeatRow) => Promise<string>;
  tunnelExtraExitNodes: (tunnel: HeartbeatRow) => HeartbeatRow[];
};

export function createNginxRuntimeSyncPlanBuilder(ctx: HeartbeatRequestContext, deps: NginxRuntimeSyncPlanDeps) {
  const { agentHostRules, forwardProtocolSettings, host, hostTunnels, tunnelById, tunnelExitEndpointById } = ctx;
  const {
    anyTunnelDnsRefresh,
    buildRuleAccessLimitCmds,
    currentHostTunnelExitPortsForRule,
    dnsRuntimeRefreshCmd,
    exitWeightsForHostIds,
    failoverTargetEndpoint,
    getExtraExitDialAddress,
    guardBackendPort,
    isCurrentHostTunnelEntry,
    nginxTunnelExitRules,
    shouldUseRuleGuard,
    tunnelExitEndpointsForRule,
    tunnelExitHostAddress,
    tunnelExtraExitNodes,
  } = deps;
  const buildNginxRuntimeSyncPlan = async () => {
    const startedAt = Date.now();
    const nginxManagedConfigs: any[] = [];
    const upstreams: string[] = [];
    const servers: string[] = [];
    const certFingerprints: string[] = [];
    const certKeys = new Set<string>();
    const activeCertPaths = new Set<string>();
    const countingCmds: string[] = [];
    const routeSummaries: string[] = [];
    const warnNginxRoute = (message: string) => {
      const key = `nginx:${Number(host.id)}:${message}`;
      if (tunnelRouteLogCache.get(key) === message) return;
      setBoundedMapValue(tunnelRouteLogCache, key, message, AGENT_DYNAMIC_CACHE_MAX);
      appendPanelLog("warn", message);
    };
    const logNginxRoute = (message: string) => {
      const key = `nginx:${Number(host.id)}:${message}`;
      if (tunnelRouteLogCache.get(key) === message) return;
      setBoundedMapValue(tunnelRouteLogCache, key, message, AGENT_DYNAMIC_CACHE_MAX);
      appendPanelLog("info", message);
    };
    const ensureNginxTunnelCert = (tunnel: any) => {
      const cert = buildNginxTunnelServerCertificate(tunnel);
      if (!cert) return null;
      activeCertPaths.add(cert.certPath);
      activeCertPaths.add(cert.keyPath);
      const key = `${cert.certPath}:${cert.keyPath}`;
      if (!certKeys.has(key)) {
        certKeys.add(key);
        certFingerprints.push(`# cert tunnel-${Number(tunnel?.id || 0)} ${cert.fingerprint}`);
        nginxManagedConfigs.push(
          {
            path: cert.certPath,
            contentBase64: Buffer.from(cert.certPem, "utf8").toString("base64"),
            format: "text",
            mode: 0o644,
          },
          {
            path: cert.keyPath,
            contentBase64: Buffer.from(cert.keyPem, "utf8").toString("base64"),
            format: "text",
            mode: 0o600,
          },
        );
      }
      return cert;
    };
    const addUpstreamServer = (name: string, endpoints: Array<{ addr: string; primary?: boolean; weight?: number }>, strategy?: unknown) => {
      const block = nginxUpstreamBlock(name, endpoints, strategy);
      if (!block) return false;
      upstreams.push(block);
      return true;
    };
    let tlsClientServers = 0;
    let tlsServerServers = 0;
    const addServer = (options: NginxStreamServerOptions) => {
      if (!options.listenPort || !options.upstream) return;
      if (options.sslClient && options.proto === "tcp") tlsClientServers += 1;
      if (options.sslServer && options.proto === "tcp") tlsServerServers += 1;
      servers.push(buildNginxStreamServerBlock(options));
    };

    for (const rule of agentHostRules as any[]) {
      if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || rule.forwardType !== "nginx") continue;
      if (!isRuleProtocolEnabled(forwardProtocolSettings, rule, null)) continue;
      const useRuleGuard = await shouldUseRuleGuard(rule);
      const listenPort = useRuleGuard ? guardBackendPort(rule) : Number(rule.sourcePort);
      // 线路组生效时 nginx 拨本机的调度器，由它挑路径（failoverTargetEndpoint）。
      const nginxTarget = failoverTargetEndpoint(rule);
      for (const proto of nginxProtocolsForRule(rule)) {
        const upstream = `fwx_rule_${Number(rule.id)}_${proto}`;
        if (!addUpstreamServer(upstream, [{ addr: nginxEndpoint(nginxTarget.targetIp, nginxTarget.targetPort), primary: true }])) continue;
        routeSummaries.push(`rule=${rule.id} port=${Number(rule.sourcePort)} listen=${listenPort} proto=${proto} target=${nginxTarget.targetIp}:${Number(nginxTarget.targetPort) || 0}`);
        addServer({
          name: `rule ${Number(rule.id)} ${proto}`,
          listenPort,
          proto,
          upstream,
          loopbackOnly: useRuleGuard,
        });
      }
      countingCmds.push(...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol));
      countingCmds.push(...buildRuleAccessLimitCmds(rule));
    }

    for (const rule of agentHostRules as any[]) {
      if (!rule || runtimeBool(rule.pendingDelete) || !runtimeBool(rule.isEnabled) || rule.forwardType !== "gost" || !rule.tunnelId) continue;
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      if (!tunnel || !runtimeBool(tunnel.isEnabled) || !isNginxTunnelMode(tunnel) || !isCurrentHostTunnelEntry(tunnel)) continue;
      if (!isTunnelProtocolEnabled(forwardProtocolSettings, tunnel) || !isRuleProtocolEnabled(forwardProtocolSettings, rule, tunnel)) continue;
      const tlsClient = buildNginxTunnelTlsClientOptions(tunnel);
      const endpoints: Array<{ addr: string; primary?: boolean; weight?: number }> = [];
      const endpointHostIds: number[] = [];
      for (const endpoint of tunnelExitEndpointsForRule(rule, tunnel)) {
        const exitHost = endpoint.primary
          ? (tunnelExitEndpointById.get(tunnel.id)?.host || await tunnelExitHostAddress(tunnel))
          : await getExtraExitDialAddress(endpoint.node, tunnel);
        const addr = nginxEndpoint(exitHost, endpoint.listenPort);
        if (addr) {
          endpoints.push({ addr, primary: endpoint.primary });
          endpointHostIds.push(endpoint.exitHostId);
          continue;
        }
        warnNginxRoute(`[NginxRuntime] missing endpoint host=${host.id} name=${String(host.name || "-")} tunnel=${tunnel.id} rule=${rule.id} exitHost=${endpoint.exitHostId} listenPort=${endpoint.listenPort || "-"} primary=${endpoint.primary}`);
      }
      const endpointWeights = await exitWeightsForHostIds((tunnel as any).loadBalanceStrategy, endpointHostIds);
      if (endpointWeights) endpoints.forEach((endpoint, index) => { endpoint.weight = endpointWeights[index]; });
      if (endpoints.length === 0) {
        warnNginxRoute(`[NginxRuntime] skipped tunnel entry host=${host.id} name=${String(host.name || "-")} tunnel=${tunnel.id} rule=${rule.id} reason=no-endpoints`);
        continue;
      }
      const useRuleGuard = await shouldUseRuleGuard(rule);
      const listenPort = useRuleGuard ? guardBackendPort(rule) : Number(rule.sourcePort);
      routeSummaries.push(`entry rule=${rule.id} tunnel=${tunnel.id} port=${Number(rule.sourcePort)} listen=${listenPort} endpoints=${endpoints.map((item) => item.addr).join(",")}`);
      for (const proto of nginxProtocolsForRule(rule)) {
        const upstream = `fwx_tentry_${Number(rule.id)}_${proto}`;
        if (!addUpstreamServer(upstream, endpoints, (tunnel as any).loadBalanceStrategy)) continue;
        addServer({
          name: `tunnel entry ${Number(tunnel.id)} rule ${Number(rule.id)} ${proto}`,
          listenPort,
          proto,
          upstream,
          loopbackOnly: useRuleGuard,
          sslClient: proto === "tcp" ? tlsClient : null,
        });
      }
      countingCmds.push(...buildCountingChainCmds(rule.sourcePort, rule.targetIp, rule.targetPort, rule.protocol));
      countingCmds.push(...buildRuleAccessLimitCmds(rule));
    }

    const nginxBusinessListenKeys = new Set<string>();
    for (const rule of nginxTunnelExitRules as any[]) {
      const tunnel = tunnelById.get(Number(rule.tunnelId)) as any;
      if (!tunnel || !isNginxTunnelMode(tunnel)) continue;
      const exitPorts = currentHostTunnelExitPortsForRule(rule, tunnel);
      if (exitPorts.length === 0) continue;
      let cert: ReturnType<typeof buildNginxTunnelServerCertificate> | null | undefined;
      // 线路组生效时出口的 nginx 拨本机的调度器，由它挑路径（failoverForCurrentHost 下发规格）。
      const exitTarget = failoverTargetEndpoint(rule);
      for (const exitPort of exitPorts) {
        nginxBusinessListenKeys.add(`${Number(host.id)}:${Number(exitPort)}`);
        routeSummaries.push(`exit rule=${rule.id} tunnel=${tunnel.id} host=${Number(host.id)} listen=${Number(exitPort)} target=${exitTarget.targetIp}:${Number(exitTarget.targetPort) || 0}`);
        for (const proto of nginxProtocolsForRule(rule)) {
          const upstream = `fwx_texit_${Number(tunnel.id)}_${Number(rule.id)}_${Number(exitPort)}_${proto}`;
          if (!addUpstreamServer(upstream, [{ addr: nginxEndpoint(exitTarget.targetIp, exitTarget.targetPort), primary: true }])) continue;
          if (proto === "tcp" && cert === undefined) cert = ensureNginxTunnelCert(tunnel);
          addServer({
            name: `tunnel exit ${Number(tunnel.id)} rule ${Number(rule.id)} port ${Number(exitPort)} ${proto}`,
            listenPort: Number(exitPort),
            proto,
            upstream,
            sslServer: proto === "tcp" && cert ? { certPath: cert.certPath, keyPath: cert.keyPath } : null,
          });
        }
        countingCmds.push(...buildCountingChainCmds(Number(exitPort), rule.targetIp, rule.targetPort, rule.protocol));
      }
    }

    for (const tunnel of hostTunnels as any[]) {
      if (!tunnel || !runtimeBool(tunnel.isEnabled) || !isNginxTunnelMode(tunnel) || !isTunnelProtocolEnabled(forwardProtocolSettings, tunnel)) continue;
      const probePorts: number[] = [];
      if (Number(tunnel.exitHostId) === Number(host.id)) probePorts.push(Number(tunnel.listenPort) || 0);
      for (const exitNode of tunnelExtraExitNodes(tunnel)) {
        if (Number((exitNode as any).hostId || 0) === Number(host.id)) probePorts.push(Number((exitNode as any).listenPort || 0));
      }
      const activeProbePorts = Array.from(new Set(probePorts.filter((port) => port > 0)));
      if (activeProbePorts.length === 0) continue;
      let cert: ReturnType<typeof buildNginxTunnelServerCertificate> | null | undefined;
      for (const listenPort of activeProbePorts) {
        if (nginxBusinessListenKeys.has(`${Number(host.id)}:${listenPort}`)) continue;
        const upstream = `fwx_tprobe_${Number(tunnel.id)}_${listenPort}`;
        if (!addUpstreamServer(upstream, [{ addr: "127.0.0.1:9", primary: true }])) continue;
        if (cert === undefined) cert = ensureNginxTunnelCert(tunnel);
        addServer({
          name: `tunnel probe ${Number(tunnel.id)} port ${listenPort}`,
          listenPort,
          proto: "tcp",
          upstream,
          sslServer: cert ? { certPath: cert.certPath, keyPath: cert.keyPath } : null,
        });
      }
    }

    const hasServers = servers.length > 0;
    const configSignature = crypto.createHash("sha256")
      .update(JSON.stringify({ hostId: Number(host.id), upstreams, servers, certFingerprints, counting: countingCmds.length }))
      .digest("hex");
    const previousSignature = nginxRuntimeLogCache.get(Number(host.id));
    if (previousSignature !== configSignature) {
      setBoundedMapValue(nginxRuntimeLogCache, Number(host.id), configSignature, AGENT_HOST_CACHE_MAX);
      logNginxRoute(`[NginxRuntime] host=${host.id} name=${String(host.name || "-")} servers=${servers.length} upstreams=${upstreams.length} tlsClients=${tlsClientServers} tlsServers=${tlsServerServers} certs=${certKeys.size} counting=${countingCmds.length} routes=${routeSummaries.length} elapsedMs=${Date.now() - startedAt}`);
      for (const summary of routeSummaries.slice(0, 20)) {
        logNginxRoute(`[NginxRuntime] host=${host.id} ${summary}`);
      }
      if (routeSummaries.length > 20) {
        logNginxRoute(`[NginxRuntime] host=${host.id} routeDetailsOmitted=${routeSummaries.length - 20}`);
      }
    }
    const config = buildNginxStreamConfig({ upstreams, servers, certFingerprints });
    const encodedConfig = Buffer.from(config, "utf8").toString("base64");
    const setupCmds = [
      `mkdir -p ${shQuote(NGINX_CONFIG_DIR)} ${shQuote(NGINX_CERT_DIR)} /var/log/forwardx-agent`,
      `modules_conf=${shQuote(`${NGINX_CONFIG_DIR}/modules.conf`)}; : > "$modules_conf"; for mod in /usr/lib/nginx/modules/ngx_stream_module.so /usr/lib64/nginx/modules/ngx_stream_module.so /usr/share/nginx/modules/ngx_stream_module.so modules/ngx_stream_module.so; do if [ -s "$mod" ]; then printf 'load_module %s;\\n' "$mod" > "$modules_conf"; break; fi; done`,
      buildNginxCertificateCleanupCmd(Array.from(activeCertPaths)),
    ];
    const cmds: string[] = [];
    if (hasServers) {
      nginxManagedConfigs.push({
        path: NGINX_CONFIG_PATH,
        contentBase64: encodedConfig,
        format: "text",
        mode: 0o644,
        validateCommand: `${shQuote(NGINX_BIN)} -p ${shQuote(NGINX_CONFIG_DIR)} -c {{path}} -t`,
        serviceName: NGINX_SERVICE_NAME,
      });
      const nginxApplyCmd = [
        writeManagedServiceCmd(NGINX_SERVICE_NAME, [
          "[Unit]",
          "Description=ForwardX managed Nginx stream runtime",
          "After=network.target",
          "",
          "[Service]",
          "Type=simple",
          `ExecStart=${NGINX_BIN} -p ${NGINX_CONFIG_DIR} -c ${NGINX_CONFIG_PATH} -g "daemon off;"`,
          `ExecReload=${NGINX_BIN} -p ${NGINX_CONFIG_DIR} -c ${NGINX_CONFIG_PATH} -s reload`,
          "Restart=always",
          "RestartSec=5",
          "LimitNOFILE=65535",
          "",
          "[Install]",
          "WantedBy=multi-user.target",
          "",
        ].join("\n")),
        ...(anyTunnelDnsRefresh(hostTunnels as any[]) ? [dnsRuntimeRefreshCmd("nginx"), `rm -f ${shQuote(`${NGINX_CONFIG_PATH}.sha256`)} 2>/dev/null || true`] : []),
        reloadNginxIfConfigChangedCmd(),
      ].filter(Boolean).map((cmd) => `(${cmd})`).join(" && ");
      cmds.push(nginxApplyCmd);
      cmds.push(...countingCmds);
      return {
        preCommands: [ensureNginxBinaryCmd(), ...setupCmds],
        commands: cmds,
        managedConfigs: nginxManagedConfigs,
      };
    }
    const retirementPlan = buildNginxRuntimeRetirementPlan();
    return {
      ...retirementPlan,
      commands: [...retirementPlan.commands, ...countingCmds],
    };
  };
  return { buildNginxRuntimeSyncPlan };
}
