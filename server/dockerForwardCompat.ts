import { createHash } from "crypto";
import { isIP } from "net";
import { forwardRuleProtocols } from "@shared/forwardTypes";
import { ruleSourcePortEnd, ruleTargetPortEnd } from "@shared/portRange";

/*
  内核转发（iptables / nftables）在装了 Docker 的入口机上的放行。

  Docker 把 iptables 的 FORWARD 默认策略改成 DROP，只跳进它自己的几条链。问题出在两处：
    · nftables 模式：面板的放行写在 `inet forwardx` 表自己的 forward 链里。同一个 hook 上
      别的基础链（iptables-nft 的 `ip filter FORWARD`）判了 DROP 就是 DROP，自己表里的 ACCEPT
      盖不过去 —— DNAT 在、规则显示运行，外面连进来却全部超时；
    · iptables 模式：Agent 调的 `iptables` 和 Docker 用的不一定是同一个前端（iptables-legacy /
      iptables-nft 规则互不相通，内核两套都求值），放行装在 legacy 里，nft 那套照样 DROP。
  所以放行要装进 Docker 留给管理员的那条链：DOCKER-USER。

  只处理「FORWARD 默认 DROP 且跳转 DOCKER-USER」这一种结构、只处理 IPv4。ufw、自定义防火墙、
  Docker 的 nftables 原生后端都不判断、不修改：那是主机自己的策略，面板猜不准就不该动。

  每条放行带注释 `fwx-docker-<规则>-<入口端口>-<协议>-<in|out>-<目标摘要>`，目标摘要是
  sha1("<目标地址>:<目标端口>") 的前 8 位十六进制。Agent（agent/docker_forward_compat.go）
  按同一个格式核实与清理，两边要一起改。

  重新下发时就地收敛：先确保要的放行都在，再删多余的（旧目标、去掉的协议、同端口同协议的
  前任规则），没变的放行不删不重建，转发不中断。删除走 `<前端>-restore --noflush` 按规则内容
  一次事务删，不按行号：Docker 或管理员随时可能改这条链，行号会指到别人的规则上。
*/

export const DOCKER_COMPAT_CHAIN = "DOCKER-USER";
const dockerCompatLabel = "[docker-compat]";

/** 构造器只读规则的这几个字段（数据库行、隧道 / 孤儿快照都传得进来）。 */
export type DockerCompatRule = { id?: unknown; sourcePort?: unknown; sourcePortEnd?: unknown; targetIp?: unknown; targetPort?: unknown; protocol?: unknown };

type DockerCompatSpec = {
  proto: "tcp" | "udp";
  direction: "in" | "out";
  comment: string;
  args: string;
};

function cleanAddress(value: unknown) {
  return String(value || "").trim().replace(/^\[(.*)\]$/, "$1");
}

function validPort(value: unknown) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

/** 目标摘要：目标一变注释就变，改目标的规则因此能「先装新的、再删旧的」。 */
export function dockerCompatTargetTag(targetIp: string, targetPort: number, span = "") {
  // 单端口的摘要和 Agent（agent/docker_forward_compat.go）算法一致，Agent 按它核实；端口段多带一截，Agent 不核实端口段
  return createHash("sha1").update(span ? `${targetIp}:${targetPort}-${span}` : `${targetIp}:${targetPort}`).digest("hex").slice(0, 8);
}

function dockerCompatSpecs(rule: DockerCompatRule): DockerCompatSpec[] {
  const targetIp = cleanAddress(rule?.targetIp);
  const targetPort = validPort(rule?.targetPort);
  const sourcePort = validPort(rule?.sourcePort);
  if (isIP(targetIp) !== 4 || !targetPort || !sourcePort) return [];
  const ruleId = Number(rule?.id) || 0;
  // 端口段（shared/portRange.ts）：入口段、目标段整段放行（iptables 的 --dport / --ctorigdstport 都认「起:止」）。
  // 注释名里还是入口起点，Agent 的清理匹配不用改；目标摘要把段带上，段一变注释就变，照样「先装新的、再删旧的」。
  const sourceEnd = ruleSourcePortEnd({ sourcePort, sourcePortEnd: rule?.sourcePortEnd });
  const targetEnd = ruleTargetPortEnd({ sourcePort, sourcePortEnd: rule?.sourcePortEnd, targetPort });
  const ranged = sourceEnd > sourcePort && targetEnd <= 65535;
  if (sourceEnd > sourcePort && !ranged) return [];
  const sourceSpan = ranged ? `${sourcePort}:${sourceEnd}` : String(sourcePort);
  const targetSpan = ranged ? `${targetPort}:${targetEnd}` : String(targetPort);
  const tag = ranged ? dockerCompatTargetTag(targetIp, targetPort, `${targetEnd}/${sourceEnd}`) : dockerCompatTargetTag(targetIp, targetPort);
  const specs: DockerCompatSpec[] = [];
  for (const proto of forwardRuleProtocols(rule?.protocol)) {
    const inComment = `fwx-docker-${ruleId}-${sourcePort}-${proto}-in-${tag}`;
    const outComment = `fwx-docker-${ruleId}-${sourcePort}-${proto}-out-${tag}`;
    // 去程按「入口原始端口 + DNAT 后的目标」放行；回程只放这条连接的应答方向，不顺带放开目标主动连进来的流量。
    specs.push({
      proto,
      direction: "in",
      comment: inComment,
      args: `-p ${proto} -d ${targetIp} --dport ${targetSpan} -m conntrack --ctorigdstport ${sourceSpan} -m comment --comment ${inComment} -j ACCEPT`,
    }, {
      proto,
      direction: "out",
      comment: outComment,
      args: `-p ${proto} -s ${targetIp} --sport ${targetSpan} -m conntrack --ctorigdstport ${sourceSpan} --ctdir REPLY --ctstate ESTABLISHED,RELATED -m comment --comment ${outComment} -j ACCEPT`,
    });
  }
  return specs;
}

/*
  几个 shell 函数，安装和清理共用：
    fwx_dc_bins   列出内核在求值的 iptables 前端。legacy 表只在已经加载时才读：在纯 nft 的
                  机器上 `iptables-legacy -S` 会把内核模块拉起来。连 FORWARD 都列不出来的前端
                  （OpenVZ / LXC 里没有 nf_tables 之类）不可能装着规则，跳过，免得每条规则都报失败。
    fwx_dc_active 这个前端是不是「FORWARD 默认 DROP + 跳转 DOCKER-USER」。
    fwx_dc_ensure 确保一条放行在：排在管理员自己的规则之后（他的显式拒绝仍然优先），
                  排在部分 Docker 版本放在链尾的无条件 RETURN 之前。
    fwx_dc_prune  删掉某个属主名下、不在保留名单里的放行。链不存在 = 没什么可删；
                  别的失败（xtables 锁忙之类）都算「没确认删掉」，返回失败。
  iptables 调用带 $FWX_IPT_WAIT（Agent 注入的锁等待参数，见 agentActionCommands.ts 的 IPTABLES_WAIT_ARG）。
*/
const dockerCompatShellPrelude = [
  "fwx_dc_bins() {",
  '  fwx_dc_list=""',
  "  for fwx_dc_cand in iptables-nft iptables-legacy; do",
  '    command -v "$fwx_dc_cand" >/dev/null 2>&1 || continue',
  '    if [ "$fwx_dc_cand" = iptables-legacy ] && ! grep -qx filter /proc/net/ip_tables_names 2>/dev/null; then continue; fi',
  '    "$fwx_dc_cand" $FWX_IPT_WAIT -S FORWARD >/dev/null 2>&1 || continue',
  '    fwx_dc_list="$fwx_dc_list $fwx_dc_cand"',
  "  done",
  '  if [ -z "$fwx_dc_list" ] && command -v iptables >/dev/null 2>&1 && iptables $FWX_IPT_WAIT -S FORWARD >/dev/null 2>&1; then fwx_dc_list=iptables; fi',
  "  printf '%s' \"$fwx_dc_list\"",
  "}",
  "fwx_dc_active() {",
  '  fwx_dc_fwd=$("$1" $FWX_IPT_WAIT -S FORWARD 2>/dev/null) || return 1',
  "  printf '%s\\n' \"$fwx_dc_fwd\" | grep -qx -e '-P FORWARD DROP' || return 1",
  `  printf '%s\\n' "$fwx_dc_fwd" | grep -Eq -e '^-A FORWARD( .*)? -j ${DOCKER_COMPAT_CHAIN}$'`,
  "}",
  "fwx_dc_ensure() {",
  "  fwx_dc_front=$1; shift",
  `  "$fwx_dc_front" $FWX_IPT_WAIT -C ${DOCKER_COMPAT_CHAIN} "$@" >/dev/null 2>&1 && return 0`,
  `  fwx_dc_pos=$("$fwx_dc_front" $FWX_IPT_WAIT -S ${DOCKER_COMPAT_CHAIN} 2>/dev/null | awk '/^-A ${DOCKER_COMPAT_CHAIN} / {n++; last=$0} END {if (n > 0 && last == "-A ${DOCKER_COMPAT_CHAIN} -j RETURN") print n}')`,
  `  if [ -n "$fwx_dc_pos" ]; then "$fwx_dc_front" $FWX_IPT_WAIT -I ${DOCKER_COMPAT_CHAIN} "$fwx_dc_pos" "$@" || return 1; else "$fwx_dc_front" $FWX_IPT_WAIT -A ${DOCKER_COMPAT_CHAIN} "$@" || return 1; fi`,
  `  "$fwx_dc_front" $FWX_IPT_WAIT -C ${DOCKER_COMPAT_CHAIN} "$@" >/dev/null 2>&1`,
  "}",
  // $1 前端，$2 属主匹配，$3 要保留的注释（两头带空格）。各版本 iptables 对「链不存在」的报错措辞不一样，
  // 所以先列整张表：列得出来且没有这条链才是真没有；列不出来（锁忙等）就是没确认。
  "fwx_dc_prune() {",
  '  fwx_dc_table=$("$1" $FWX_IPT_WAIT -S 2>/dev/null) || return 1',
  `  printf '%s\\n' "$fwx_dc_table" | grep -qx -e '-N ${DOCKER_COMPAT_CHAIN}' || return 0`,
  "  fwx_dc_round=0",
  "  while :; do",
  `    fwx_dc_del=$("$1" $FWX_IPT_WAIT -S ${DOCKER_COMPAT_CHAIN} 2>/dev/null | awk -v pat="$2" -v keep="$3" '/^-A ${DOCKER_COMPAT_CHAIN} / && $0 ~ pat {c=""; if (match($0, /fwx-docker-[0-9A-Za-z_-]+/)) c=substr($0, RSTART, RLENGTH); if (index(keep, " " c " ") == 0) {sub(/^-A /, "-D "); print}}')`,
  '    [ -n "$fwx_dc_del" ] || return 0',
  '    [ "$fwx_dc_round" -lt 5 ] || return 1',
  "    fwx_dc_round=$((fwx_dc_round + 1))",
  '    command -v "$1-restore" >/dev/null 2>&1 || return 1',
  // iptables-restore 1.6.2 起才认 --wait，老版本退回不带等待的写法。
  `    printf '*filter\\n%s\\nCOMMIT\\n' "$fwx_dc_del" | "$1-restore" --noflush --wait 5 >/dev/null 2>&1 || printf '*filter\\n%s\\nCOMMIT\\n' "$fwx_dc_del" | "$1-restore" --noflush >/dev/null 2>&1 || :`,
  "  done",
  "}",
];

/**
 * 一个规则编号、或者一个端口加协议，名下有哪些放行（awk 正则）。规则编号拥有它用过的所有端口和协议；
 * 光给端口时只拥有要删的那几种协议，另一种协议上别的规则的放行保留。
 */
function dockerCompatOwnerPattern(ruleId: number, port: number, protocols: string[]) {
  const owned: string[] = [];
  if (ruleId > 0) owned.push(`${ruleId}-[0-9]+-(tcp|udp)`);
  if (validPort(port) && protocols.length > 0) owned.push(`[0-9]+-${port}-(${protocols.join("|")})`);
  if (owned.length === 0) return "";
  return `--comment "?fwx-docker-(${owned.join("|")})-(in|out)-[0-9a-f]+"?( |$)`;
}

/**
 * 装 / 收敛一条内核转发规则在 DOCKER-USER 里的放行。目标不是 IPv4（IPv6、还没解析出来的域名）
 * 时不装，但要把以前 IPv4 目标留下的那几条收掉。失败时以非零退出并在 stderr 打 `[docker-compat]`，
 * Agent 把它带进规则的动作状态，面板上看得到原因。
 */
export function buildDockerForwardCompatCmds(rule: DockerCompatRule): string[] {
  const specs = dockerCompatSpecs(rule);
  const ruleId = Number(rule?.id) || 0;
  if (specs.length === 0) {
    return buildDockerForwardCompatCleanupCmds({ ruleId, port: Number(rule?.sourcePort), protocol: rule?.protocol });
  }
  const sourcePort = validPort(rule?.sourcePort);
  const pattern = dockerCompatOwnerPattern(ruleId, sourcePort, forwardRuleProtocols(rule?.protocol));
  const keep = ` ${specs.map((spec) => spec.comment).join(" ")} `;
  const label = `rule ${ruleId} port ${sourcePort}`;
  const ensure = specs.map((spec) =>
    `    fwx_dc_ensure "$fwx_dc_b" ${spec.args} || { echo "${dockerCompatLabel} $fwx_dc_b: cannot install ${DOCKER_COMPAT_CHAIN} allowance for ${label}/${spec.proto} (${spec.direction}); Docker's default-DROP FORWARD would block it" >&2; fwx_dc_failed=1; }`);
  return [[
    ...dockerCompatShellPrelude,
    "fwx_dc_failed=0",
    `fwx_dc_keep='${keep}'`,
    "for fwx_dc_b in $(fwx_dc_bins); do",
    '  if fwx_dc_active "$fwx_dc_b"; then',
    ...ensure,
    "  fi",
    // 旧目标、去掉的协议、这个端口的前任属主：新的都装好之后才删，重下发的规则全程不断。
    `  fwx_dc_prune "$fwx_dc_b" '${pattern}' "$fwx_dc_keep" || { echo "${dockerCompatLabel} $fwx_dc_b: could not remove stale ForwardX allowance from ${DOCKER_COMPAT_CHAIN} (${label})" >&2; fwx_dc_failed=1; }`,
    "done",
    '[ "$fwx_dc_failed" = 0 ]',
  ].join("\n")];
}

/** 删掉一个规则编号和 / 或一个端口（按协议）名下的全部放行：停用、删除、换成用户态转发、本地兜底清理都走这里。 */
export function buildDockerForwardCompatCleanupCmds(selector: { ruleId?: number; port?: number; protocol?: unknown }): string[] {
  const ruleId = Number(selector.ruleId) || 0;
  const port = validPort(selector.port);
  const pattern = dockerCompatOwnerPattern(ruleId, port, forwardRuleProtocols(selector.protocol, "both"));
  if (!pattern) return [];
  const label = `rule ${ruleId || "-"} port ${port || "-"}`;
  return [[
    ...dockerCompatShellPrelude,
    "fwx_dc_failed=0",
    "for fwx_dc_b in $(fwx_dc_bins); do",
    `  fwx_dc_prune "$fwx_dc_b" '${pattern}' ' ' || { echo "${dockerCompatLabel} $fwx_dc_b: could not remove ForwardX allowance from ${DOCKER_COMPAT_CHAIN} (${label})" >&2; fwx_dc_failed=1; }`,
    "done",
    '[ "$fwx_dc_failed" = 0 ]',
  ].join("\n")];
}
