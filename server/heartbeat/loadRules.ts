/*
  从 server/agentHeartbeatRoute.ts 第 873-1068 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { hostSupportsGostApiSync } from "../../shared/gostRuntimeApi";
import { gostRuntimeApiConfig, gostRuntimeApiExecStart, restartManagedServiceIfConfigChangedCmd, restartMimicServiceIfConfigChangedCmd, shQuote, startManagedServiceCmd, stopManagedServiceCmd, syncGostServiceIfConfigChangedCmd } from "../agentActionCommands";
import { type AgentDnsWatch } from "../agentHeartbeatDns";
import { type AgentLocalRuntimeServiceState } from "../agentHeartbeatReport";
import { MIMIC_CONFIG_DIR, RUNTIME_BIN, RUNTIME_CONFIG_PATH, RUNTIME_SERVICE_NAME, SHARED_RUNTIME_NOFILE } from "../agentHeartbeatRuntime";
import { dnsRuntimeGenerations } from "../agentHeartbeatState";
import { normalizeNetworkInterface } from "../agentInputValidation";
import { latestConfigRevision, type MimicLifecycleResource } from "../configAudit";
import * as db from "../db";
import { getForwardProtocolSettings } from "../forwardProtocolSettings";
import { gateForwardRulesForRuntime } from "../linkAccessView";
import { buildForwardXMimicConfig } from "../mimicConfig";
import { loadEntryBridgeRuntimeRules } from "../ruleEntryBridges";
import { loadEgressRuntimeContext, ruleEgressRuntimeView } from "../ssEgress";
import { sniRuleRuntimeView } from "../tlsInboundRuntime";
import { planVlessEgressBridgePorts } from "../vlessEgress";
import { hostIpv6ListenAvailable } from "@shared/hostIpv6Listen";

export type LoadHeartbeatRulesContext = {
  host: any;
  effectiveAgentVersion: string;
  reportedDefaultNetworkInterface: string;
  dnsChangedScopes: Set<string>;
  dnsChangedTokenByScope: Map<string, string>;
};

export type LoadHeartbeatRulesResult = {
  rules: Array<any>;
  dnsWatches: Map<string, AgentDnsWatch>;
  dnsChangedFor: any /* 原类型 (scope: string, refId: unknown) => boolean… 引用了拿不到的 scope，手动收拾 */;
  actions: Array<any>;
  hostInterface: string;
  hostTunnels: any;
  egressRuntimeContext: any /* 原类型 EgressRuntimeContext… 引用了拿不到的 EgressRuntimeContext，手动收拾 */;
  sniRuntimeView: any /* 原类型 <T extends Record<string, any>>(rule: T) => T… 引用了拿不到的 T，手动收拾 */;
  egressRuntimeView: any /* 原类型 <T extends Record<string, any>>(rule: T) => T… 引用了拿不到的 T，手动收拾 */;
  dnsRuntimeGeneration: any /* 原类型 (scope: string, refId: unknown) => number… 引用了拿不到的 scope，手动收拾 */;
  responseIssuedAt: number;
  forwardProtocolSettings: any /* 原类型 ForwardProtocolSettings… 引用了拿不到的 ForwardProtocolSettings，手动收拾 */;
  vlessBridgePorts: any /* 原类型 VlessEgressBridgePortAllocator… 引用了拿不到的 VlessEgressBridgePortAllocator，手动收拾 */;
  addMimicFilter: any /* 原类型 (filter: string, iface?: string, lifecycleResources?: MimicLifecycleResource[]) … 引用了拿不到的 filter，手动收拾 */;
  gostRuntimeApiSection: any /* 原类型 (service: string) => { api: { addr: string; }; } | { api?: undefined; }… 引用了拿不到的 service，手动收拾 */;
  gostRuntimeExecStart: any /* 原类型 (service: string, configPath: string) => string… 引用了拿不到的 service，手动收拾 */;
  gostRuntimeSyncCmd: any /* 原类型 (service: string, configPath: string) => string… 引用了拿不到的 service，手动收拾 */;
  gostServiceName: "forwardx-runtime";
  gostServiceUnit: string;
  reportedMimicInterfaces: Set<string>;
  reportedMimicServicesByInterface: Map<string, AgentLocalRuntimeServiceState>;
  hostIpv6Listen: boolean;
  mimicFiltersByInterface: Map<string, Set<string>>;
  mimicRequestedWithoutInterface: boolean;
  mimicLifecycleResources: Map<string, MimicLifecycleResource>;
  configRevision: number;
  buildMimicRuntimeSyncCmds: any /* 原类型 (lifecycleToken: string, dnsRefreshToken?: string, approvedRemovals?: Map<string… 引用了拿不到的 lifecycleToken，手动收拾 */;
  hostTlsInbounds: Array<db.TlsInboundRow>;
};

export async function loadHeartbeatRules(ctx: LoadHeartbeatRulesContext): Promise<LoadHeartbeatRulesResult> {
  const { host, effectiveAgentVersion, reportedDefaultNetworkInterface, dnsChangedScopes, dnsChangedTokenByScope } = ctx;
  const [rawRules, hostTunnels, forwardProtocolSettings, configRevision, hostTlsInbounds] = await Promise.all([
    db.getForwardRulesForAgent(host.id),
    db.getTunnelsByHost(host.id),
    getForwardProtocolSettings(),
    latestConfigRevision(),
    db.listTlsInboundsByHost(Number(host.id)),
  ]);
  /*
    共享 TLS 入站上的规则：入站不在 / 停用 / Agent 太旧时按停用下发；要发 PROXY 头时守卫先收入站给的头。
    见 server/tlsInboundRuntime.ts。普通规则原样通过（同一个对象）。
  */
  const tlsInboundById = new Map(hostTlsInbounds.map((inbound) => [inbound.id, inbound] as const));
  const sniRuntimeView = <T extends Record<string, any>>(rule: T): T => sniRuleRuntimeView(rule, {
    hostId: Number(host.id),
    agentVersion: effectiveAgentVersion,
    inboundById: tlsInboundById,
  });
  /*
    Shadowsocks 出口（server/ssEgress.ts）：出口失效、落地入站没了、Agent 低于 2.2.226、要 UDP / SS2022
    而入口机没报这项能力时规则按停用下发（绝不退回直连）；能跑的规则带上 egressRuntime，下面生成 gost 配置时挂出口链。只管这台主机自己的规则。
  */
  let egressRuntimeContext = await loadEgressRuntimeContext(rawRules as any[]);
  // VLESS Reality 出口的本机 sing-box 桥接端口（server/vlessEgress.ts）：下面协议守卫分端口时当作已占用。
  const vlessBridgePorts = await planVlessEgressBridgePorts(Number(host.id), rawRules, hostTunnels);
  const egressRuntimeView = <T extends Record<string, any>>(rule: T): T => (Number(rule?.hostId) === Number(host.id)
    ? ruleEgressRuntimeView(rule, {
      entryHostId: Number(host.id),
      entryAgentVersion: effectiveAgentVersion,
      entryHostName: String((host as any).name || ""),
      // 这次心跳刚报的能力（上面已经写回 host）：UDP / SS2022 出口只发给此刻撑得起的入口机。
      entryAgentCapabilities: (host as any).agentCapabilities,
      entryRuntimeVersion: (host as any).runtimeVersion,
      context: egressRuntimeContext,
      vlessBridgePorts,
    })
    : rule);
  const gatedRules = (await gateForwardRulesForRuntime(rawRules as any[])).map(sniRuntimeView).map(egressRuntimeView);
  /*
    换隧道后旧入口的临时桥接（server/ruleEntryBridges）：合成成普通的 iptables 规则行接在
    后面，下面整条下发流程原样生成动作、计数、孤儿清理。桥接到期或删掉后这一行消失，
    Agent 上报的那个监听随即被当成孤儿撤掉。
  */
  const rules = [...gatedRules, ...await loadEntryBridgeRuntimeRules(Number(host.id), gatedRules)];
  const actions: any[] = [];
  const dnsWatches = new Map<string, AgentDnsWatch>();
  const responseIssuedAt = Date.now();

  // Prefer the explicit host setting. Current Agents also report the
  // interface selected by the default route so mimic is not silently skipped.
  const configuredHostInterface = normalizeNetworkInterface((host as any).networkInterface);
  const hostInterface = configuredHostInterface || reportedDefaultNetworkInterface;
  // 内核关了 IPv6 的机器（Agent 2.2.256+ 报 ipv6Listen=false）：realm / socat 只听 IPv4。没报过按有 IPv6，配置不变。
  const hostIpv6Listen = hostIpv6ListenAvailable(host);
  const mimicFiltersByInterface = new Map<string, Set<string>>();
  const mimicLifecycleResources = new Map<string, MimicLifecycleResource>();
  const reportedMimicInterfaces = new Set<string>();
  const reportedMimicServicesByInterface = new Map<string, AgentLocalRuntimeServiceState>();
  let mimicRequestedWithoutInterface = false;
  const addMimicFilter = (
    filter: string,
    iface = hostInterface,
    lifecycleResources: MimicLifecycleResource[] = [],
  ) => {
    const networkInterface = normalizeNetworkInterface(iface);
    const text = String(filter || "").trim();
    if (!text) return;
    if (!networkInterface) {
      mimicRequestedWithoutInterface = true;
      return;
    }
    if (!mimicFiltersByInterface.has(networkInterface)) mimicFiltersByInterface.set(networkInterface, new Set());
    mimicFiltersByInterface.get(networkInterface)!.add(text);
    for (const resource of lifecycleResources) {
      const resourceId = Math.floor(Number(resource.resourceId) || 0);
      if (resourceId <= 0) continue;
      mimicLifecycleResources.set(`${resource.resourceType}:${resourceId}`, {
        resourceType: resource.resourceType,
        resourceId,
      });
    }
  };
  const dnsChangedKey = (scope: string, refId: unknown) => `${scope}:${Number(refId) || 0}`;
  const dnsChangedFor = (scope: string, refId: unknown) => dnsChangedScopes.has(dnsChangedKey(scope, refId));
  const dnsRuntimeGeneration = (scope: string, refId: unknown) => {
    return dnsRuntimeGenerations.generation(scope, refId, dnsChangedTokenByScope.get(dnsChangedKey(scope, refId)));
  };
  const buildMimicRuntimeSyncCmds = (lifecycleToken: string, dnsRefreshToken = "", approvedRemovals = new Map<string, string>()) => {
    if (mimicRequestedWithoutInterface && !hostInterface) {
      return {
        commands: [`echo "[mimic] no usable network interface; configure the host network interface or upgrade the Agent so it can report the default interface"; exit 1`],
        removalCommands: [] as string[],
        rollbackCommands: [] as string[],
      };
    }
    const cmds: string[] = [];
    const removalCommands: string[] = [];
    const rollbackCommands: string[] = [];
    const activeIfaces = Array.from(mimicFiltersByInterface.keys()).sort();
    const knownIfaces = new Set([
      ...activeIfaces,
      ...approvedRemovals.keys(),
    ]);
    for (const networkInterface of Array.from(knownIfaces).sort()) {
      const desiredFilters = Array.from(mimicFiltersByInterface.get(networkInterface) || []).sort();
      const filters = desiredFilters;
      const configPath = `${MIMIC_CONFIG_DIR}/${networkInterface}.conf`;
      const backupPath = `${configPath}.forwardx-backup`;
      const backupActivePath = `${configPath}.forwardx-backup-active`;
      const backupEnabledPath = `${configPath}.forwardx-backup-enabled`;
      const dnsRefreshPath = `${configPath}.forwardx-dns-refresh`;
      const xdpModePath = `${configPath}.forwardx-xdp-mode`;
      const lifecyclePath = `${configPath}.forwardx-lifecycle`;
      const configTempPath = `${configPath}.forwardx-new`;
      const serviceName = `mimic@${networkInterface}`;
      const bpfDropInPath = `/etc/systemd/system/${serviceName}.service.d/forwardx-bpf.conf`;
      const bpfDropInDir = `/etc/systemd/system/${serviceName}.service.d`;
      const serviceNameQuoted = shQuote(serviceName);
      const serviceActiveCheck = `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl is-active --quiet ${serviceNameQuoted}.service; elif command -v rc-service >/dev/null 2>&1; then rc-service ${serviceNameQuoted} status >/dev/null 2>&1; elif [ -x /etc/init.d/${serviceName} ]; then /etc/init.d/${serviceName} status >/dev/null 2>&1; else false; fi`;
      const serviceEnabledCheck = `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl is-enabled --quiet ${serviceNameQuoted}.service; elif command -v rc-update >/dev/null 2>&1; then rc-update show default 2>/dev/null | grep -q -F ${shQuote(serviceName)}; else false; fi`;
      const enableRestoredService = `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl enable ${serviceNameQuoted}.service; elif command -v rc-update >/dev/null 2>&1; then rc-update add ${serviceNameQuoted} default; else echo "[mimic] cannot restore enabled state for ${serviceName} on unsupported init system"; exit 1; fi`;
      const restartRestoredService = `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl restart ${serviceNameQuoted}.service; elif command -v rc-service >/dev/null 2>&1; then rc-service ${serviceNameQuoted} restart; elif [ -x /etc/init.d/${serviceName} ]; then /etc/init.d/${serviceName} restart; else echo "[mimic] cannot restore service ${serviceName} on unsupported init system"; exit 1; fi`;
      if (filters.length === 0) {
        removalCommands.push(
          `if [ -f ${shQuote(configPath)} ] && grep -q '^# Managed by ForwardX$' ${shQuote(configPath)} 2>/dev/null; then ${stopManagedServiceCmd(serviceName)}; if [ -f ${shQuote(backupPath)} ]; then mv -f ${shQuote(backupPath)} ${shQuote(configPath)}; if [ -f ${shQuote(backupEnabledPath)} ]; then if ! { ${enableRestoredService}; }; then exit 1; fi; fi; if [ -f ${shQuote(backupActivePath)} ]; then if ! { ${restartRestoredService}; }; then exit 1; fi; fi; else rm -f ${shQuote(configPath)}; fi; rm -f ${shQuote(backupActivePath)} ${shQuote(backupEnabledPath)} ${shQuote(dnsRefreshPath)} ${shQuote(xdpModePath)} ${shQuote(lifecyclePath)} ${shQuote(configTempPath)} ${shQuote(`${configPath}.forwardx-last-good`)} ${shQuote(configPath)}.sha256 ${shQuote(bpfDropInPath)} 2>/dev/null || true; rmdir ${shQuote(bpfDropInDir)} 2>/dev/null || true; if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl daemon-reload 2>/dev/null || true; fi; fi; rm -f ${shQuote(xdpModePath)} ${shQuote(lifecyclePath)} 2>/dev/null || true`,
        );
        continue;
      }
      const config = buildForwardXMimicConfig(filters);
      const encodedConfig = Buffer.from(config, "utf8").toString("base64");
      cmds.push([
        "set -e",
        `if ! command -v mimic >/dev/null 2>&1; then echo "[mimic] mimic is not installed; install mimic and mimic-dkms to use UDP camouflage"; exit 1; fi`,
        `if ! ip link show dev ${shQuote(networkInterface)} >/dev/null 2>&1; then echo "[mimic] network interface ${shQuote(networkInterface)} does not exist"; exit 1; fi`,
        `mkdir -p ${shQuote(MIMIC_CONFIG_DIR)}`,
        `if [ -f ${shQuote(configPath)} ] && ! grep -q '^# Managed by ForwardX$' ${shQuote(configPath)} 2>/dev/null && [ ! -f ${shQuote(backupPath)} ]; then if { ${serviceActiveCheck}; }; then : > ${shQuote(backupActivePath)}; else rm -f ${shQuote(backupActivePath)}; fi; if { ${serviceEnabledCheck}; }; then : > ${shQuote(backupEnabledPath)}; else rm -f ${shQuote(backupEnabledPath)}; fi; rm -f ${shQuote(`${configPath}.forwardx-last-good`)}; cp -p ${shQuote(configPath)} ${shQuote(backupPath)}; fi`,
        `printf '%s' '${encodedConfig}' | base64 -d > ${shQuote(configTempPath)}`,
        `printf '\\n' >> ${shQuote(configTempPath)}; mimic_filter_count=$(grep -c '^filter = ' ${shQuote(configTempPath)} 2>/dev/null || true); if [ "$mimic_filter_count" -le 0 ] || [ "$mimic_filter_count" -gt 32 ]; then rm -f ${shQuote(configTempPath)}; echo "[mimic] invalid filter count: $mimic_filter_count (supported 1-32)"; exit 1; fi; if [ -f ${shQuote(configPath)} ] && grep -q '^# Managed by ForwardX$' ${shQuote(configPath)} 2>/dev/null; then cp -p ${shQuote(configPath)} ${shQuote(`${configPath}.forwardx-last-good`)}; fi; mv -f ${shQuote(configTempPath)} ${shQuote(configPath)}; chmod 644 ${shQuote(configPath)}`,
        `echo "[mimic] sync ${shQuote(networkInterface)} filters=$mimic_filter_count"`,
        `if ! modprobe mimic 2>/dev/null; then echo "[mimic] kernel module could not be loaded"; exit 1; fi`,
        `mimic_force_restart=0; if [ "$(cat ${shQuote(lifecyclePath)} 2>/dev/null || true)" != ${shQuote(lifecycleToken)} ]; then mimic_force_restart=1; fi`,
        dnsRefreshToken
          ? `mimic_old_hash=$(cat ${shQuote(configPath)}.sha256 2>/dev/null || true); if command -v sha256sum >/dev/null 2>&1; then mimic_new_hash=$(sha256sum ${shQuote(configPath)} 2>/dev/null | awk '{print "sha256:"$1}'); elif command -v cksum >/dev/null 2>&1; then mimic_new_hash=$(cksum ${shQuote(configPath)} 2>/dev/null | awk '{print "cksum:"$1":"$2}'); else mimic_new_hash="mtime:$(wc -c < ${shQuote(configPath)} 2>/dev/null):$(date -r ${shQuote(configPath)} +%s 2>/dev/null)"; fi; mimic_dns_restart=0; if { ${serviceActiveCheck}; } && [ "$mimic_new_hash" = "$mimic_old_hash" ] && [ "$(cat ${shQuote(dnsRefreshPath)} 2>/dev/null || true)" != ${shQuote(dnsRefreshToken)} ]; then mimic_dns_restart=1; fi`
          : "mimic_dns_restart=0",
        restartMimicServiceIfConfigChangedCmd(serviceName, configPath, networkInterface),
        dnsRefreshToken
          ? `if [ "$mimic_dns_restart" = "1" ] && [ "$mimic_needs_start" != "1" ]; then echo ${shQuote(`[mimic] DNS refresh ${dnsRefreshToken}`)}; ${startManagedServiceCmd(serviceName)}; fi; printf '%s' ${shQuote(dnsRefreshToken)} > ${shQuote(dnsRefreshPath)}`
          : "",
        `if ! mimic show ${shQuote(networkInterface)} >/dev/null 2>&1; then echo "[mimic] runtime hooks are unavailable on ${shQuote(networkInterface)}"; systemctl status ${shQuote(serviceName)}.service --no-pager -l 2>/dev/null || true; journalctl -u ${shQuote(serviceName)}.service -n 80 --no-pager 2>/dev/null || true; exit 1; fi`,
        `mimic_lifecycle_tmp=${shQuote(`${lifecyclePath}.tmp`)}.$$; printf '%s' ${shQuote(lifecycleToken)} > "$mimic_lifecycle_tmp"; chmod 644 "$mimic_lifecycle_tmp"; mv -f "$mimic_lifecycle_tmp" ${shQuote(lifecyclePath)}`,
      ].filter(Boolean).join("\n"));
      rollbackCommands.push(`if [ -f ${shQuote(`${configPath}.forwardx-last-good`)} ]; then cp -p ${shQuote(`${configPath}.forwardx-last-good`)} ${shQuote(configPath)}; ${startManagedServiceCmd(serviceName)}; elif [ -f ${shQuote(backupPath)} ]; then ${stopManagedServiceCmd(serviceName)}; cp -p ${shQuote(backupPath)} ${shQuote(configPath)}; if [ -f ${shQuote(backupEnabledPath)} ]; then if ! { ${enableRestoredService}; }; then exit 1; fi; fi; if [ -f ${shQuote(backupActivePath)} ]; then if ! { ${restartRestoredService}; }; then exit 1; fi; fi; rm -f ${shQuote(backupPath)} ${shQuote(backupActivePath)} ${shQuote(backupEnabledPath)} ${shQuote(dnsRefreshPath)} ${shQuote(xdpModePath)} ${shQuote(configTempPath)} ${shQuote(configPath)}.sha256 2>/dev/null || true; else ${stopManagedServiceCmd(serviceName)}; rm -f ${shQuote(configPath)} ${shQuote(xdpModePath)} 2>/dev/null || true; fi`);
    }
    return { commands: cmds, removalCommands, rollbackCommands };
  };

  /** 包装一条只追加一次的 iptables 规则：先 -C 检查是否存在，不存在才 -A */
  /**
   * 为转发规则创建一对 mangle 计数链以跨转发方式采集准确流量。
   * - FWX_IN_<port>：匹配 dport=<port> 的入站包（客户端→Agent）
   * - FWX_OUT_<port>：匹配 sport=<port> 的出站包（Agent→客户端响应）
   * 不设 RETURN，所以只作计数不影响路由。三种转发方式都会经过 mangle 表，覆盖 100% 路径。
   */
  const gostServiceName = RUNTIME_SERVICE_NAME;
  /*
    能力 gostApiSync（Agent ≥ 2.2.229、运行时 ≥ 3.2.6）的机器：gost.json 开 root 专用的 Unix 套接字 API，
    ExecStart 包一层准备套接字目录，重启命令前加 API 同步标记 —— API 能做的改动不再重启共享进程（shared/gostRuntimeApi.ts）。
    别的机器上配置、单元、命令和以前逐字节相同。
  */
  const gostApiSync = hostSupportsGostApiSync({ agentVersion: effectiveAgentVersion, agentCapabilities: (host as any).agentCapabilities });
  const gostRuntimeExecStart = (service: string, configPath: string) => (
    gostApiSync ? gostRuntimeApiExecStart(RUNTIME_BIN, service, configPath) : `${RUNTIME_BIN} -C ${configPath}`
  );
  const gostRuntimeApiSection = (service: string) => (gostApiSync ? { api: gostRuntimeApiConfig(service) } : {});
  const gostRuntimeSyncCmd = (service: string, configPath: string) => (
    gostApiSync ? syncGostServiceIfConfigChangedCmd(service, configPath) : restartManagedServiceIfConfigChangedCmd(service, configPath)
  );
  const gostServiceUnit = [
    "[Unit]",
    "Description=ForwardX unified runtime forwarder",
    "After=network.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${gostRuntimeExecStart(gostServiceName, RUNTIME_CONFIG_PATH)}`,
    "Restart=always",
    "RestartSec=5",
    // 这台机器上所有 gost 规则共用这一个进程，一条转发占两个句柄：65535 意味着
    // 整机三万来个并发就到顶，新连接直接 accept 失败。
    `LimitNOFILE=${SHARED_RUNTIME_NOFILE}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
  return { rules, dnsWatches, dnsChangedFor, actions, hostInterface, hostTunnels, egressRuntimeContext, sniRuntimeView, egressRuntimeView, dnsRuntimeGeneration, responseIssuedAt, forwardProtocolSettings, vlessBridgePorts, addMimicFilter, gostRuntimeApiSection, gostRuntimeExecStart, gostRuntimeSyncCmd, gostServiceName, gostServiceUnit, reportedMimicInterfaces, reportedMimicServicesByInterface, hostIpv6Listen, mimicFiltersByInterface, mimicRequestedWithoutInterface, mimicLifecycleResources, configRevision, buildMimicRuntimeSyncCmds, hostTlsInbounds };
}
