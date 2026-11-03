import crypto from "crypto";
import { isValidTlsServerName } from "./nginxTlsInput";
import { killByPatternCmd, removeManagedServiceCmd, shQuote, startManagedServiceCmd } from "./agentActionCommands";
import { cleanEndpointHost, isIpv6Literal } from "./forwardRuntimeConfigs";
import { forwardRuleProtocols } from "@shared/forwardTypes";

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
  loopbackOnly?: boolean;
  sslServer?: {
    certPath: string;
    keyPath: string;
  } | null;
  sslClient?: {
    serverName?: string | null;
  } | null;
};

const nginxConfigQuote = (value: unknown) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");

const nginxListenLine = (port: number, proto: "tcp" | "udp", loopbackOnly = false) => {
  const parts = [`listen ${loopbackOnly ? "127.0.0.1" : "[::]"}:${port}`];
  if (proto === "udp") parts.push("udp", "reuseport");
  else parts.push("so_keepalive=60s:15s:4");
  if (!loopbackOnly) parts.push("ipv6only=off");
  return `${parts.join(" ")};`;
};

export function buildNginxStreamServerBlock(options: NginxStreamServerOptions) {
  const lines = [
    "  server {",
    `    # ${nginxConfigQuote(options.name)}`,
    options.sslServer && options.proto === "tcp"
      ? `    listen ${options.loopbackOnly ? "127.0.0.1" : "[::]"}:${options.listenPort} ssl so_keepalive=60s:15s:4${options.loopbackOnly ? "" : " ipv6only=off"};`
      : `    ${nginxListenLine(options.listenPort, options.proto, options.loopbackOnly)}`,
    "    proxy_connect_timeout 10s;",
    options.proto === "udp" ? "    proxy_timeout 2m;" : "    proxy_timeout 24h;",
  ];
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
      "  resolver 1.1.1.1 8.8.8.8 valid=60s ipv6=on;",
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
export const nginxUpstreamBlock = (
  name: string,
  endpoints: Array<{ addr: string; primary?: boolean; weight?: number }>,
  strategyRaw?: unknown,
) => {
  const cleanEndpoints = endpoints.filter((endpoint) => endpoint.addr);
  if (cleanEndpoints.length === 0) return "";
  const strategy = cleanEndpoints.length > 1 ? String(strategyRaw || "round_robin") : "round_robin";
  const lines = [`  upstream ${name} {`];
  if (strategy === "random") lines.push("    random;");
  else if (strategy === "least_conn" || strategy === "least_load") lines.push("    least_conn;");
  else if (strategy === "ip_hash") lines.push("    hash $remote_addr consistent;");
  cleanEndpoints.forEach((endpoint, index) => {
    const backup = strategy === "fallback" && index > 0 ? " backup" : "";
    const weight = (strategy === "weighted" || strategy === "least_load") && Number(endpoint.weight) > 1 ? ` weight=${Math.floor(Number(endpoint.weight))}` : "";
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
