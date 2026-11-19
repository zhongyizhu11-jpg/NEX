import crypto from "crypto";
import { isValidTlsServerName } from "./nginxTlsInput";
import { killByPatternCmd, removeManagedServiceCmd, shQuote, startManagedServiceCmd } from "./agentActionCommands";
import { cleanEndpointHost, isIpv6Literal } from "./forwardRuntimeConfigs";
import { forwardRuleProtocols } from "@shared/forwardTypes";
import { normalizeExitGroupStrategy } from "@shared/loadBalance";

/*
  nginx stream 运行时：配置文件的拼装（server / upstream 块、证书）、配置哈希与重载命令、
  整个 nginx 运行时退役时的清理计划。
  从 server/agentHeartbeatRoute.ts 里原样搬出来，行为不变（心跳处理函数里那几个不依赖本次请求的小函数提到了模块顶层）。
*/

export const NGINX_BIN = "/usr/local/bin/forwardx-nginx";
export const NGINX_SERVICE_NAME = "forwardx-nginx";
export const NGINX_CONFIG_DIR = "/etc/forwardx/nginx";
export const NGINX_CONFIG_PATH = "/etc/forwardx/nginx/nginx.conf";
export const NGINX_CERT_DIR = "/etc/forwardx/nginx/certs";
const NGINX_ERROR_LOG_PATH = "/var/log/forwardx-agent/forwardx-nginx-error.log";
const NGINX_SESSION_LOG_PATH = "/var/log/forwardx-agent/forwardx-nginx-session.log";

export const SHARED_NGINX_FORWARD_TYPES = new Set(["nginx", "nginx-tunnel", "nginx-tunnel-exit"]);

export type NginxStreamServerOptions = {
  name: string;
  listenPort: number;
  proto: "tcp" | "udp";
  upstream: string;
  /**
   * upstream 里有几台服务器（nginxUpstreamBlock 实际写出的 server 行数）。不传 / 1：和以前一样。
   * 2 台以上的 TCP：连接超时 3 秒（和 FXP 多出口的拨号超时一致），连不上就换下一台，每台最多试一次。
   */
  upstreamServers?: number;
  loopbackOnly?: boolean;
  /**
   * 这台机器能不能开 IPv6 监听（shared/hostIpv6Listen.ts）。不传 / true：`listen [::]:端口 … ipv6only=off`，
   * 和以前一样；false：`listen 0.0.0.0:端口`（内核关了 IPv6 时 nginx 开不了 [::] 的套接字，整份配置都起不来）。
   * 写成 0.0.0.0:端口 而不是只写端口：Agent 按「地址:端口」从配置里认监听（managed_runtime_listens.go）。
   */
  ipv6Listen?: boolean;
  sslServer?: {
    certPath: string;
    keyPath: string;
  } | null;
  sslClient?: {
    serverName?: string | null;
  } | null;
};

const nginxConfigQuote = (value: unknown) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");

/** 监听地址和要不要 ipv6only=off：回环只听 127.0.0.1；对外的有 IPv6 就双栈，没有就只听 IPv4。 */
const nginxListenTarget = (loopbackOnly = false, ipv6Listen = true) => {
  if (loopbackOnly) return { host: "127.0.0.1", dualStack: false };
  if (ipv6Listen === false) return { host: "0.0.0.0", dualStack: false };
  return { host: "[::]", dualStack: true };
};

const nginxListenLine = (port: number, proto: "tcp" | "udp", loopbackOnly = false, ipv6Listen = true) => {
  const target = nginxListenTarget(loopbackOnly, ipv6Listen);
  const parts = [`listen ${target.host}:${port}`];
  if (proto === "udp") parts.push("udp", "reuseport");
  else parts.push("so_keepalive=60s:15s:4");
  if (target.dualStack) parts.push("ipv6only=off");
  return `${parts.join(" ")};`;
};

/** 多出口 upstream 的 TCP 连接超时（秒）。和 FXP 多出口的拨号超时、gost 多出口的 dialTimeout 一致。 */
export const NGINX_MULTI_EXIT_CONNECT_TIMEOUT_SECONDS = 3;

export function buildNginxStreamServerBlock(options: NginxStreamServerOptions) {
  const target = nginxListenTarget(options.loopbackOnly, options.ipv6Listen);
  const upstreamServers = Math.max(0, Math.floor(Number(options.upstreamServers) || 0));
  const multiExitTcp = options.proto === "tcp" && upstreamServers > 1;
  const lines = [
    "  server {",
    `    # ${nginxConfigQuote(options.name)}`,
    options.sslServer && options.proto === "tcp"
      ? `    listen ${target.host}:${options.listenPort} ssl so_keepalive=60s:15s:4${target.dualStack ? " ipv6only=off" : ""};`
      : `    ${nginxListenLine(options.listenPort, options.proto, options.loopbackOnly, options.ipv6Listen)}`,
    multiExitTcp ? `    proxy_connect_timeout ${NGINX_MULTI_EXIT_CONNECT_TIMEOUT_SECONDS}s;` : "    proxy_connect_timeout 10s;",
    options.proto === "udp" ? "    proxy_timeout 2m;" : "    proxy_timeout 24h;",
  ];
  if (multiExitTcp) {
    /*
      多出口：一台连不上（拒绝、超时）就换下一台，每台最多试一次。单出口时 10 秒的连接超时照旧；多出口还等 10 秒的话，
      一台被黑洞的出口会让每条新连接都先卡 10 秒才轮到下一台。总时限 10 秒：最多跳过 3 台被黑洞的出口，
      再多就让这条连接失败（接着连续失败的那几台会被 max_fails 摘掉）。
      UDP 不动：nginx 对 UDP 只有被动判断（ICMP 不可达算失败），加 proxy_responses 会掐断单向 / 流式的 UDP。
    */
    lines.push(
      "    proxy_next_upstream on;",
      `    proxy_next_upstream_tries ${upstreamServers};`,
      "    proxy_next_upstream_timeout 10s;",
    );
  }
  if (options.proto === "tcp") {
    lines.push("    proxy_socket_keepalive on;");
  }
  if (options.sslServer && options.proto === "tcp") {
    lines.push(
      `    ssl_certificate ${options.sslServer.certPath};`,
      `    ssl_certificate_key ${options.sslServer.keyPath};`,
      "    ssl_protocols TLSv1.2 TLSv1.3;",
    );
  }
  if (options.sslClient && options.proto === "tcp") {
    lines.push(
      "    proxy_ssl on;",
      // Existing certificates may be self-signed or lack a matching SAN. Keep encryption compatible
      // until tunnels have an explicit CA trust model that can safely enable identity verification.
      "    proxy_ssl_verify off;",
    );
    const serverName = String(options.sslClient.serverName || "").trim();
    // nginxConfigQuote 只转义不加引号，挡不住 ; { } $ 与换行；旧数据里这样的域名直接不写，
    // 免得一条隧道改写或弄坏整台主机的 nginx 配置。合法主机名原样写出，配置文本不变。
    if (serverName && isValidTlsServerName(serverName)) {
      lines.push(
        "    proxy_ssl_server_name on;",
        `    proxy_ssl_name ${nginxConfigQuote(serverName)};`,
      );
    }
  }
  lines.push(`    proxy_pass ${options.upstream};`, "  }");
  return lines.join("\n");
}

export function buildNginxStreamConfig(options: {
  upstreams: string[];
  servers: string[];
  certFingerprints?: string[];
  /** false：这台机器没有 IPv6，运行时解析域名只要 A 记录（解析出 AAAA 也连不出去）。 */
  ipv6Listen?: boolean;
}) {
  const hasServers = options.servers.length > 0;
  return [
    `include ${NGINX_CONFIG_DIR}/modules.conf;`,
    "worker_processes auto;",
    // 每个 worker 的句柄上限跟着 worker_connections 走：一条转发占两个句柄，
    // 不抬的话 65535 个连接位实际只用得到系统默认的那一点。
    "worker_rlimit_nofile 1048576;",
    `error_log ${NGINX_ERROR_LOG_PATH} notice;`,
    "pid /run/forwardx-nginx.pid;",
    ...(options.certFingerprints || []).sort(),
    "",
    "events {",
    "  worker_connections 65535;",
    "}",
    "",
    ...(hasServers ? [
      "stream {",
      "  log_format forwardx_session '$time_iso8601 status=$status protocol=$protocol listen=$server_port session_time=$session_time bytes_received=$bytes_received bytes_sent=$bytes_sent upstream=$upstream_addr upstream_connect_time=$upstream_connect_time';",
      `  access_log ${NGINX_SESSION_LOG_PATH} forwardx_session buffer=32k flush=5s;`,
      "  tcp_nodelay on;",
      // 默认 16k：每搬 16k 就一次读写，高带宽下系统调用翻几倍。64k 和其他转发方式一致。
      "  proxy_buffer_size 64k;",
      `  resolver 1.1.1.1 8.8.8.8 valid=60s ipv6=${options.ipv6Listen === false ? "off" : "on"};`,
      "",
      ...options.upstreams.flatMap((block) => [block, ""]),
      ...options.servers.flatMap((block) => [block, ""]),
      "}",
      "",
    ] : []),
  ].join("\n");
}

export function buildNginxTunnelTlsClientOptions(tunnel: any) {
  const id = Number(tunnel?.id || 0);
  const certPem = String(tunnel?.certPem || "").trim();
  const keyPem = String(tunnel?.certKeyPem || "").trim();
  if (!id || !certPem || !keyPem) return null;
  return {
    serverName: String(tunnel?.certDomain || "").trim() || null,
  };
}

export function buildNginxTunnelServerCertificate(tunnel: any) {
  const clientOptions = buildNginxTunnelTlsClientOptions(tunnel);
  if (!clientOptions) return null;
  const id = Number(tunnel.id);
  const certPem = String(tunnel.certPem).trim();
  const keyPem = String(tunnel.certKeyPem).trim();
  const normalizedCertPem = certPem.endsWith("\n") ? certPem : `${certPem}\n`;
  const normalizedKeyPem = keyPem.endsWith("\n") ? keyPem : `${keyPem}\n`;
  const fingerprint = crypto.createHash("sha256").update(`${normalizedCertPem}\n${normalizedKeyPem}`).digest("hex");
  const fileKey = fingerprint.slice(0, 16);
  return {
    certPath: `${NGINX_CERT_DIR}/tunnel-${id}-${fileKey}.crt`,
    keyPath: `${NGINX_CERT_DIR}/tunnel-${id}-${fileKey}.key`,
    certPem: normalizedCertPem,
    keyPem: normalizedKeyPem,
    fingerprint,
    serverName: clientOptions.serverName,
  };
}

export function buildNginxCertificateCleanupCmd(activePaths: string[]) {
  const certDir = shQuote(NGINX_CERT_DIR);
  const liveConfig = shQuote(NGINX_CONFIG_PATH);
  const keepPatterns = Array.from(new Set(activePaths.filter(Boolean))).sort().map(shQuote).join("|");
  const cleanup = keepPatterns
    ? `case "$base_cert_file" in ${keepPatterns}) ;; *) rm -f -- "$cert_file" ;; esac`
    : 'rm -f -- "$cert_file"';
  return `for cert_file in ${certDir}/tunnel-*.crt ${certDir}/tunnel-*.key ${certDir}/tunnel-*.crt.forwardx-last-good ${certDir}/tunnel-*.key.forwardx-last-good; do [ -e "$cert_file" ] || continue; base_cert_file=\${cert_file%.forwardx-last-good}; if grep -Fq -- "$base_cert_file" ${liveConfig} 2>/dev/null; then continue; fi; ${cleanup}; done; rm -f ${certDir}/.forwardx-config-* ${certDir}/.forwardx-restore-* 2>/dev/null || true`;
}

export function isNginxTunnelMode(tunnel: any) {
  return String(tunnel?.mode || "").toLowerCase() === "nginx_stream";
}

export function ensureNginxBinaryCmd() {
  const nginx = shQuote(NGINX_BIN);
  return `if [ -e ${nginx} ]; then chmod 0755 ${nginx} 2>/dev/null || true; else for bin in /usr/sbin/nginx /usr/local/nginx/sbin/nginx $(command -v nginx 2>/dev/null || true); do [ -n "$bin" ] || continue; [ -x "$bin" ] || continue; install -m 0755 "$bin" ${nginx} && break; done; fi; [ -x ${nginx} ]`;
}

export function buildNginxRuntimeRetirementPlan() {
  const processPattern = "[/]usr/local/bin/forwardx-nginx.*[/]etc/forwardx/nginx/nginx[.]conf";
  const persistentArtifacts = [
    NGINX_CONFIG_PATH,
    `${NGINX_CONFIG_PATH}.sha256`,
    `${NGINX_CONFIG_PATH}.forwardx-last-good`,
    `${NGINX_CONFIG_DIR}/modules.conf`,
    "/run/forwardx-nginx.pid",
  ];
  const terminateManagedProcess = [
    killByPatternCmd(processPattern),
    `for attempt in 1 2 3; do if ! pgrep -f '${processPattern}' >/dev/null 2>&1; then break; fi; sleep 1; done`,
    `if pgrep -f '${processPattern}' >/dev/null 2>&1; then for pid in $(pgrep -f '${processPattern}' 2>/dev/null || true); do if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi; kill -KILL "$pid" 2>/dev/null || true; done; sleep 1; fi`,
    `if pgrep -f '${processPattern}' >/dev/null 2>&1; then echo "[service] ${NGINX_SERVICE_NAME} managed process cleanup failed"; exit 1; fi`,
  ].join("; ");
  const removePersistentState = [
    `rm -f ${persistentArtifacts.map(shQuote).join(" ")} 2>/dev/null || true`,
    `if [ -e ${shQuote(NGINX_CONFIG_PATH)} ]; then echo "[service] ${NGINX_SERVICE_NAME} config cleanup failed"; exit 1; fi`,
  ].join("; ");
  const removeManagedCertificates = [
    `rm -f ${shQuote(NGINX_CERT_DIR)}/*.crt ${shQuote(NGINX_CERT_DIR)}/*.key ${shQuote(NGINX_CERT_DIR)}/*.crt.forwardx-last-good ${shQuote(NGINX_CERT_DIR)}/*.key.forwardx-last-good ${shQuote(NGINX_CERT_DIR)}/.forwardx-config-* ${shQuote(NGINX_CERT_DIR)}/.forwardx-restore-* 2>/dev/null || true`,
    `rm -f ${shQuote(NGINX_CONFIG_DIR)}/.forwardx-config-* ${shQuote(NGINX_CONFIG_DIR)}/.forwardx-restore-* ${shQuote(NGINX_ERROR_LOG_PATH)} ${shQuote(NGINX_SESSION_LOG_PATH)} 2>/dev/null || true`,
    `rmdir ${shQuote(NGINX_CERT_DIR)} ${shQuote(NGINX_CONFIG_DIR)} 2>/dev/null || true`,
  ].join("; ");
  return {
    preCommands: [] as string[],
    managedConfigs: [] as any[],
    commands: [
      removeManagedServiceCmd(NGINX_SERVICE_NAME),
      `${terminateManagedProcess}; ${removePersistentState}`,
      removeManagedCertificates,
    ],
  };
}

export const nginxEndpoint = (hostValue: unknown, portValue: unknown) => {
  const clean = cleanEndpointHost(hostValue);
  const port = Number(portValue) || 0;
  if (!clean || port <= 0 || port > 65535) return "";
  return isIpv6Literal(clean) ? `[${clean}]:${port}` : `${clean}:${port}`;
};
export const nginxProtocolsForRule = (rule: any): Array<"tcp" | "udp"> => {
  return forwardRuleProtocols(rule?.protocol);
};
/**
 * 「主备」时第 2 台起的备用各写多大的权重（下标 0 是第一台备用）。
 *
 * nginx 开源版的 backup 没有先后：主服务器全不可用时，在所有 backup 之间按权重轮流。想要「按顺序」只能靠权重
 * 把流量压到靠前的备用上：相邻两台差 100 倍 —— 主的挂了以后，第 2 台拿约 99%，第 3 台约 1%；第 2 台也挂了
 * 第 3 台顶上。最多分三档（10000 / 100 / 1），第 4 台备用起都是 1（它们之间轮流）。
 * 权重不再往上加：nginx 的平滑加权轮询里，一台失败过的服务器恢复后有效权重是慢慢涨回去的，权重越大回到
 * 原来份额越慢（实测 10000 的那台恢复后头 3000 条连接拿回约 89%，之后稳定在约 98%；期间只是多分给后面几台，不会不通）。
 * 拿真的 nginx 1.24 验过，结果见 server/agentHeartbeatNginx.test.ts 开头的说明。
 */
export function nginxFallbackBackupWeights(backupCount: number): number[] {
  const count = Math.max(0, Math.floor(Number(backupCount) || 0));
  if (count <= 1) return Array.from({ length: count }, () => 1);
  return Array.from({ length: count }, (_, index) => {
    const steps = Math.max(0, Math.min(count - 1, 2) - index);
    return 100 ** steps;
  });
}

/**
 * nginx 上的「主备」是不是严格按顺序：两台以内是（一主一备）；三台以上不是 —— 备用之间是「靠前的拿绝大部分」，
 * 不是「前一台挂了才用后一台」。界面可以拿它决定要不要加一句说明。
 */
export function nginxFallbackIsStrictlyOrdered(serverCount: number) {
  return Math.floor(Number(serverCount) || 0) <= 2;
}

/** nginx 的 upstream 里实际会写几台服务器（地址为空的不写）。交给 buildNginxStreamServerBlock 的 upstreamServers。 */
export const nginxUpstreamServerCount = (endpoints: Array<{ addr: string }>) => (
  endpoints.filter((endpoint) => endpoint.addr).length
);

export const nginxUpstreamBlock = (
  name: string,
  endpoints: Array<{ addr: string; primary?: boolean; weight?: number }>,
  strategyRaw?: unknown,
) => {
  const cleanEndpoints = endpoints.filter((endpoint) => endpoint.addr);
  if (cleanEndpoints.length === 0) return "";
  // 先归一：库里老的 least_conn 就是「按负载」（shared/exitStrategy.ts），以前在这里直接比字符串，权重被丢掉了。
  const strategy = cleanEndpoints.length > 1 ? normalizeExitGroupStrategy(strategyRaw || "round_robin") : "round_robin";
  const lines = [`  upstream ${name} {`];
  /*
    多台服务器时开共享内存区：nginx 是 worker_processes auto，没有 zone 的话每个 worker 各记各的 ——
    轮流的位置、least_conn 的连接数、max_fails 的失败次数都只是「这个 worker 看到的」，几个 worker 加起来既不匀，
    一台出口挂了每个 worker 还都要自己撞满 max_fails 才摘。有了 zone 这些状态全体 worker 共用。
    名字就用 upstream 的名字（本来就唯一，只有字母数字下划线）。64k 放得下几十台服务器。
    单台服务器的 upstream 不加：没有可共享的东西，配置和以前一个字节不差（不会因为升级面板就整台重载、也不占内存）。
  */
  if (cleanEndpoints.length > 1) lines.push(`    zone ${name} 64k;`);
  if (strategy === "random") lines.push("    random;");
  // 自动 / 延迟优先：nginx 看不到延迟，和「按负载」一样用 least_conn + 带宽权重
  else if (strategy === "least_load" || strategy === "auto" || strategy === "latency") lines.push("    least_conn;");
  else if (strategy === "ip_hash") lines.push("    hash $remote_addr consistent;");
  const usesWeights = strategy === "weighted" || strategy === "least_load" || strategy === "auto" || strategy === "latency";
  const backupWeights = strategy === "fallback" ? nginxFallbackBackupWeights(cleanEndpoints.length - 1) : [];
  cleanEndpoints.forEach((endpoint, index) => {
    const backup = strategy === "fallback" && index > 0 ? " backup" : "";
    const weightValue = backup
      ? backupWeights[index - 1]
      : usesWeights ? Math.floor(Number(endpoint.weight) || 0) : 0;
    const weight = weightValue > 1 ? ` weight=${weightValue}` : "";
    lines.push(`    server ${endpoint.addr}${weight} max_fails=2 fail_timeout=10s${backup};`);
  });
  lines.push("  }");
  return lines.join("\n");
};

const nginxRuntimeActiveCmd = () => (
  `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl is-active --quiet ${shQuote(NGINX_SERVICE_NAME)}.service; ` +
  `elif command -v rc-service >/dev/null 2>&1; then rc-service ${shQuote(NGINX_SERVICE_NAME)} status >/dev/null 2>&1; ` +
  `elif [ -x /etc/init.d/${NGINX_SERVICE_NAME} ]; then /etc/init.d/${NGINX_SERVICE_NAME} status >/dev/null 2>&1; ` +
  `else pgrep -f '${NGINX_BIN}.*${NGINX_CONFIG_PATH}' >/dev/null 2>&1; fi`
);
const nginxConfigHashCmd = (configPath = NGINX_CONFIG_PATH) => {
  const config = shQuote(configPath);
  return `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${config} 2>/dev/null | awk '{print "sha256:"$1}'; elif command -v cksum >/dev/null 2>&1; then cksum ${config} 2>/dev/null | awk '{print "cksum:"$1":"$2}'; else echo "mtime:$(wc -c < ${config} 2>/dev/null):$(date -r ${config} +%s 2>/dev/null)"; fi`;
};
export const nginxRuntimeVerifyCmd = () => {
  const config = shQuote(NGINX_CONFIG_PATH);
  return `[ -s ${config} ] && (${nginxRuntimeActiveCmd()}) && new_hash=$(${nginxConfigHashCmd()}); old_hash=$(cat ${config}.sha256 2>/dev/null || true); [ -n "$new_hash" ] && [ "$new_hash" = "$old_hash" ]`;
};
export const reloadNginxIfConfigChangedCmd = () => {
  const config = shQuote(NGINX_CONFIG_PATH);
  const active = nginxRuntimeActiveCmd();
  const start = startManagedServiceCmd(NGINX_SERVICE_NAME);
  const configHash = nginxConfigHashCmd();
  const reload = `${shQuote(NGINX_BIN)} -p ${shQuote(NGINX_CONFIG_DIR)} -c ${config} -s reload || { [ -s /run/forwardx-nginx.pid ] && kill -HUP "$(cat /run/forwardx-nginx.pid)" 2>/dev/null; }`;
  return `new_hash=$(${configHash}); old_hash=$(cat ${config}.sha256 2>/dev/null || true); if [ -z "$new_hash" ]; then echo "[service] ${NGINX_SERVICE_NAME} config hash failed"; exit 1; fi; if [ "$new_hash" != "$old_hash" ] || ! { ${active}; }; then if { ${active}; }; then ${reload} || { echo "[service] ${NGINX_SERVICE_NAME} reload failed"; exit 1; }; else ${start}; fi; printf '%s' "$new_hash" > ${config}.sha256; else echo "[service] ${NGINX_SERVICE_NAME} config unchanged"; fi`;
};
