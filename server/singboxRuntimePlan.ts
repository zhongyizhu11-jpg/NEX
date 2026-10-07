/**
 * 把落地入站变成一份「下发计划」：装什么二进制、写哪个配置、起哪个服务。
 *
 * 结构照搬面板里已有的两套 —— gost 与 nginx 都是「生成配置 → managedConfigs 推
 * 下去 → systemd 重启」，本文件是第三套，不是新范式。刻意做成纯函数并单独成文件，
 * 是为了在没有 Agent、没有数据库的情况下也能完整测。
 *
 * 挑 sing-box 而不是 Xray 分支：它的入站覆盖我们渲染的全部八个协议，出站也一样，
 * 一个二进制两头都够。本文件里的每一处字段与版本区间都拿真二进制验过，不是照文档抄的。
 */

import { githubDownloadCandidates, type GithubAcceleratorConfig } from "../shared/githubAccelerator";
import { buildSingboxConfig, proxyInboundEnumFieldError, type ProxyInbound } from "../shared/proxyInbound";
import { appendPanelLog } from "./_core/panelLogger";
import {
  shQuote,
  startManagedServiceCmd,
  stopManagedServiceCmd,
  writeManagedServiceCmd,
} from "./agentActionCommands";

export const SINGBOX_BIN = "/usr/local/bin/forwardx-singbox";
export const SINGBOX_SERVICE_NAME = "forwardx-singbox";
export const SINGBOX_CONFIG_DIR = "/etc/forwardx/singbox";
export const SINGBOX_CONFIG_PATH = "/etc/forwardx/singbox/config.json";

/**
 * 钉死版本，与 gost 的 GOST_VERSION 一个做法。
 *
 * 1.14.0 是撰写时的最新稳定版（1.15 还在 alpha），也是 Snell 落地的下限。
 * 装机脚本里允许用 SINGBOX_VERSION 环境变量覆盖。
 */
export const SINGBOX_VERSION = "1.14.0";

/** sing-box 官方发布的架构名，与 uname -m 的对应关系。 */
const SINGBOX_ARCHES = [
  { unames: ["x86_64", "amd64"], asset: "amd64" },
  { unames: ["aarch64", "arm64"], asset: "arm64" },
] as const;

export function singboxAssetUrl(version: string, arch: string): string {
  const clean = String(version || "").replace(/^v/, "");
  return `https://github.com/SagerNet/sing-box/releases/download/v${clean}/sing-box-${clean}-linux-${arch}.tar.gz`;
}

/**
 * 落地机上跑的服务单元。
 *
 * `run -c` 而不是 `run -D`：配置由面板下发，落地机不需要工作目录里的状态。
 */
export function buildSingboxServiceUnit(): string {
  return [
    "[Unit]",
    "Description=ForwardX sing-box inbound runtime",
    "After=network.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${SINGBOX_BIN} run -c ${SINGBOX_CONFIG_PATH}`,
    "Restart=always",
    "RestartSec=5",
    "LimitNOFILE=65535",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/**
 * 确保落地机上有可用的 sing-box。
 *
 * 三级来源，逐级回退：已装且版本对得上 → 系统里现成的 sing-box → 从 GitHub 下载。
 * 下载走候选列表（加速地址在前、原地址在后），与面板其他二进制一致。
 *
 * 全程用「候选文件 + 校验通过再改名」：下载一半断线或者装了个跑不起来的二进制时，
 * 旧的那个还在原地 —— 落地机上跑着别人的流量，不能为了升级把它先删了。
 */
export function ensureSingboxBinaryCmd(options: {
  version?: string;
  accelerator?: GithubAcceleratorConfig | null;
} = {}): string {
  const version = String(options.version || SINGBOX_VERSION).replace(/^v/, "");
  const bin = shQuote(SINGBOX_BIN);
  const wanted = shQuote(`sing-box version ${version}`);

  // 版本对不上也要重装：入站配置是按某个版本的字段写的，旧版会整份拒绝加载。
  const versionMatches = (target: string) => `${target} version 2>/dev/null | head -n1 | grep -qF ${wanted}`;

  /**
   * 用位置参数传候选地址，而不是塞进一个变量再靠 $SB_URLS 拆词 ——
   * 那样 shQuote 加的引号会变成 URL 的一部分。
   */
  const archCases = SINGBOX_ARCHES.map((entry) => {
    const urls = githubDownloadCandidates(singboxAssetUrl(version, entry.asset), options.accelerator)
      .map(shQuote)
      .join(" ");
    return `    ${entry.unames.join("|")}) set -- ${urls} ;;`;
  }).join("\n");

  // 换行而不是分号：if/else/case 这些关键字后面跟分号是语法错误，
  // 而 Agent 侧是用 sh -c 跑这段的，多行没有问题。
  return [
    `mkdir -p ${shQuote(SINGBOX_CONFIG_DIR)}`,
    `SB_OK=0`,
    `if [ -x ${bin} ] && ${versionMatches(bin)}; then`,
    `  SB_OK=1`,
    `fi`,
    `if [ "$SB_OK" = "0" ]; then`,
    // 系统里已经有一个版本对得上的 sing-box 就直接用，省一次下载。
    `  SB_SYS=$(command -v sing-box 2>/dev/null || true)`,
    `  if [ -n "$SB_SYS" ] && ${versionMatches('"$SB_SYS"')}; then`,
    `    install -m 0755 "$SB_SYS" ${bin} && SB_OK=1`,
    `  fi`,
    `fi`,
    `if [ "$SB_OK" = "0" ]; then`,
    `  case "$(uname -m)" in`,
    archCases,
    `    *) echo "[singbox] unsupported arch $(uname -m)"; exit 1 ;;`,
    `  esac`,
    `  SB_TMP=$(mktemp -d)`,
    `  for SB_URL in "$@"; do`,
    `    rm -rf "$SB_TMP"/* 2>/dev/null || true`,
    `    curl -fsSL --connect-timeout 15 --retry 2 "$SB_URL" -o "$SB_TMP/sb.tgz" 2>/dev/null || continue`,
    `    tar -xzf "$SB_TMP/sb.tgz" -C "$SB_TMP" 2>/dev/null || continue`,
    `    SB_FOUND=$(find "$SB_TMP" -type f -name sing-box 2>/dev/null | head -n1)`,
    `    [ -n "$SB_FOUND" ] || continue`,
    `    SB_NEW=${shQuote(`${SINGBOX_BIN}.candidate.`)}$$`,
    `    install -m 0755 "$SB_FOUND" "$SB_NEW" 2>/dev/null || continue`,
    // 装上先跑一次：架构不对或者文件截断了这里就能发现，而不是等服务起不来。
    `    if "$SB_NEW" version >/dev/null 2>&1 && mv -f "$SB_NEW" ${bin}; then`,
    `      SB_OK=1`,
    `      break`,
    `    fi`,
    `    rm -f "$SB_NEW"`,
    `  done`,
    `  rm -rf "$SB_TMP" 2>/dev/null || true`,
    `fi`,
    /**
     * 收尾要查版本，不能只查文件在不在。
     *
     * 只查存在的话，「要 1.15、装着 1.14、下载又失败了」会以退出码 0 收场，
     * 然后面板把按新版字段写的配置推下去，sing-box 拒绝加载 —— 报出来是
     * 「服务起不来」，跟版本毫无字面关联。这里当场说清楚要的是哪个、装的是哪个。
     */
    `if ! ${versionMatches(bin)}; then`,
    `  echo "[singbox] 需要 ${version}，实际是 $(${bin} version 2>/dev/null | head -n1 || echo '未安装')"`,
    `  exit 1`,
    `fi`,
  ].join("\n");
}

export type SingboxInboundEntry = {
  inbound: ProxyInbound;
  /** sing-box 里的出/入站标识，用入站行 id 保证唯一。 */
  tag: string;
};

export type SingboxManagedConfig = {
  path: string;
  contentBase64: string;
  format: "json";
  /** 装配置前先跑一遍，不通过就整份回滚 —— Agent 侧 managedConfigs 支持这个。 */
  validateCommand: string;
  serviceName: string;
};

export type SingboxRuntimePlan = {
  /** 这台机器上有没有启用中的入站。没有时走 retirement 那条路。 */
  active: boolean;
  managedConfigs: SingboxManagedConfig[];
  commands: string[];
};

/**
 * 配置下发前先让 sing-box 自己校验一遍。
 *
 * 这一步是整条链路上最值钱的一道闸：一份配置里只要有一个入站不合法，sing-box 就
 * 拒绝加载**整份**配置 —— 同一台落地机上其他入站会跟着一起停。有了它，坏配置在
 * 落地前就被挡住，Agent 的 managedConfigs 事务会把旧配置原样放回去。
 */
export function singboxValidateCommand(): string {
  return `${SINGBOX_BIN} check -c {{path}}`;
}

const loggedInvalidSingboxInbounds = new Set<string>();

/**
 * 一台机器上所有租户的入站合成一份配置，sing-box check 只要有一个入站不认识就整份
 * 拒绝，别人的入站也跟着冻结在旧配置上。输入校验之前存进去的坏行在这里单独剔掉，
 * 只让它自己不生效；同一条原因只记一次日志，免得每次心跳都刷。
 */
function invalidSingboxInboundReason(entry: SingboxInboundEntry): string {
  const reason = proxyInboundEnumFieldError(entry.inbound);
  if (reason) {
    const key = `${entry.tag}|${reason}`;
    if (!loggedInvalidSingboxInbounds.has(key)) {
      if (loggedInvalidSingboxInbounds.size > 4096) loggedInvalidSingboxInbounds.clear();
      loggedInvalidSingboxInbounds.add(key);
      appendPanelLog("warn", `[SingboxRuntime] skip invalid inbound tag=${entry.tag} reason=${reason}`);
    }
  }
  return reason;
}

/**
 * 生成下发计划。inbounds 为空表示这台机器不再需要 sing-box。
 */
export function buildSingboxRuntimePlan(options: {
  inbounds: readonly SingboxInboundEntry[];
  version?: string;
  accelerator?: GithubAcceleratorConfig | null;
}): SingboxRuntimePlan {
  const entries = options.inbounds.filter((entry) => entry && entry.inbound && !invalidSingboxInboundReason(entry));
  if (entries.length === 0) return buildSingboxRetirementPlan();

  const config = buildSingboxConfig(entries);
  return {
    active: true,
    managedConfigs: [{
      path: SINGBOX_CONFIG_PATH,
      contentBase64: Buffer.from(config, "utf8").toString("base64"),
      format: "json",
      validateCommand: singboxValidateCommand(),
      serviceName: SINGBOX_SERVICE_NAME,
    }],
    commands: [
      ensureSingboxBinaryCmd({ version: options.version, accelerator: options.accelerator }),
      writeManagedServiceCmd(SINGBOX_SERVICE_NAME, buildSingboxServiceUnit()),
      startManagedServiceCmd(SINGBOX_SERVICE_NAME),
    ],
  };
}

/**
 * 这台机器上一个入站都不剩时的收尾。
 *
 * 只停服务、删配置，**不删二进制** —— 用户很可能马上又建一个，重下 30MB 不值当；
 * 而且删二进制那一步失败会让整个下发失败，代价与收益不成比例。
 */
export function buildSingboxRetirementPlan(): SingboxRuntimePlan {
  return {
    active: false,
    managedConfigs: [],
    commands: [
      stopManagedServiceCmd(SINGBOX_SERVICE_NAME),
      `rm -f ${shQuote(SINGBOX_CONFIG_PATH)} ${shQuote(`${SINGBOX_CONFIG_PATH}.sha256`)} 2>/dev/null || true`,
    ],
  };
}
