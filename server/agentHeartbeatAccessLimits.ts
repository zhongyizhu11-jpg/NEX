import { IPTABLES_WAIT_ARG, iptablesEnsureShell } from "./agentActionCommands";

/*
  连接数 / 来源 IP 数限制（iptables connlimit）的命令拼装。
  从 server/agentHeartbeatRoute.ts 的心跳处理函数里原样提到模块顶层：这些函数不依赖本次请求，行为不变。
*/

type AccessLimitBinary = "iptables" | "ip6tables";
const accessLimitBinaries: AccessLimitBinary[] = ["iptables", "ip6tables"];
const accessLimitCommand = (binary: AccessLimitBinary, command: string) => (
  binary === "ip6tables"
    ? `if command -v ip6tables >/dev/null 2>&1; then ${command}; fi; true`
    : `${command}; true`
);
// `$FWX_IPT_WAIT` 由 Agent 注入 xtables 锁等待参数，见 agentActionCommands.IPTABLES_WAIT_ARG。
const accessLimitBin = (binary: AccessLimitBinary) => `${binary} ${IPTABLES_WAIT_ARG}`;
const accessLimitDeleteJump = (binary: AccessLimitBinary, chainName: string, port: number, scopeChain: string) => (
  accessLimitCommand(binary, `while ${accessLimitBin(binary)} -C ${chainName} -p tcp --dport ${port} -j ${scopeChain} 2>/dev/null; do if ${accessLimitBin(binary)} -D ${chainName} -p tcp --dport ${port} -j ${scopeChain} 2>/dev/null; then :; else break; fi; done`)
);
const accessLimitEnsureJump = (binary: AccessLimitBinary, chainName: string, port: number, scopeChain: string) => (
  accessLimitCommand(binary, iptablesEnsureShell(accessLimitBin(binary), "", `${chainName} -p tcp --dport ${port} -j ${scopeChain}`, "-I"))
);
const accessLimitOptional = (binary: AccessLimitBinary, command: string) => accessLimitCommand(binary, `${command} 2>/dev/null`);
const accessScopeName = (scope: string) => `FWX_LIMIT_${scope.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}`;
export const buildAccessLimitCleanupCmds = (port: number, scope: string): string[] => {
  const chain = accessScopeName(scope);
  const cmds: string[] = [];
  for (const binary of accessLimitBinaries) {
    cmds.push(
      accessLimitDeleteJump(binary, "INPUT", port, chain),
      accessLimitDeleteJump(binary, "FORWARD", port, chain),
    );
  }
  return cmds;
};
export const buildAccessLimitCmds = (port: number, scope: string, limits: { maxConnections?: number; maxIPs?: number }): string[] => {
  const maxConnections = Math.max(0, Number(limits.maxConnections || 0));
  const maxIPs = Math.max(0, Number(limits.maxIPs || 0));
  if (maxConnections <= 0 && maxIPs <= 0) return buildAccessLimitCleanupCmds(port, scope);
  const chain = accessScopeName(scope);
  const cmds = buildAccessLimitCleanupCmds(port, scope);
  for (const binary of accessLimitBinaries) {
    const mask = binary === "ip6tables" ? 128 : 32;
    cmds.push(
      accessLimitOptional(binary, `${accessLimitBin(binary)} -N ${chain}`),
      accessLimitOptional(binary, `${accessLimitBin(binary)} -F ${chain}`),
    );
    if (maxConnections > 0) {
      cmds.push(accessLimitCommand(binary, `${accessLimitBin(binary)} -A ${chain} -p tcp -m connlimit --connlimit-above ${maxConnections} --connlimit-mask 0 -j REJECT --reject-with tcp-reset`));
    }
    if (maxIPs > 0) {
      cmds.push(accessLimitCommand(binary, `${accessLimitBin(binary)} -A ${chain} -p tcp -m connlimit --connlimit-above ${maxIPs} --connlimit-mask ${mask} -j REJECT --reject-with tcp-reset`));
    }
    cmds.push(
      accessLimitCommand(binary, `${accessLimitBin(binary)} -A ${chain} -j RETURN`),
      accessLimitEnsureJump(binary, "INPUT", port, chain),
      accessLimitEnsureJump(binary, "FORWARD", port, chain),
    );
  }
  return cmds;
};
