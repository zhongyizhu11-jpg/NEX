/**
 * Agent 安装/卸载/升级命令，一处真身。
 *
 * 这段拼装原来只长在「主机管理」的 AgentTokenManager 里，纯前端。租户自助
 * 加机器那条路走不通同一份代码 —— 拼命令要的 panelPublicUrl、GitHub 加速、
 * agentPreferPanelInstall 都在管理员才能读的系统设置里，普通用户拿不到，
 * 只能由服务端拼好再给他。
 *
 * 两边各抄一份的话，改了一边忘了另一边，租户拿到的就是一条过时的命令 ——
 * 而这种错要等到有人真去装机器才会发现。所以抽到这里，两边共用。
 */

export type AgentScriptAction = "install" | "uninstall" | "upgrade";

export interface AgentScriptCommandOptions {
  /** 面板地址，Agent 回连用。空串会让命令里出现 `/api/agent/install.sh` 这种半截地址，调用方要先兜住。 */
  panelUrl: string;
  action: AgentScriptAction;
  /** install 时必填；其余动作忽略。 */
  token?: string;
  githubAcceleratorUrl?: string;
  githubAcceleratorEnabled?: boolean;
  /** true = Agent 程序先从面板下（FORWARDX_AGENT_PANEL_FIRST）；安装脚本不管它，总是先从面板拉。 */
  preferPanelInstall?: boolean;
  /** OpenWrt / iStoreOS 版：最前面先补 bash、curl（AGENT_OPENWRT_BOOTSTRAP）。普通命令不带，免得 VPS 上看着吓人。 */
  openwrt?: boolean;
}

/** 脚本在 fork 里的原始地址。加速器是拼在它前面的前缀，不是替换。 */
export const AGENT_INSTALL_SCRIPT_RAW_URL =
  "https://raw.githubusercontent.com/zhongyizhu11-jpg/NEX/main/scripts/install-agent.sh";

/**
 * OpenWrt / iStoreOS 默认没有 bash 和 curl（登录 shell 是 busybox ash）：OpenWrt 版的安装命令最前面先补上。
 * 别的系统上 /etc/openwrt_release 不存在，这一段什么都不做；ash、bash、zsh 都能解析。
 * 不能出现 " || "：后面两条管线靠它分隔，测试也按它拆。
 */
export const AGENT_OPENWRT_BOOTSTRAP =
  "if [ -f /etc/openwrt_release ] && ! { command -v bash && command -v curl; } >/dev/null 2>&1; then "
  + "if command -v opkg >/dev/null 2>&1; then opkg update && opkg install bash curl ca-bundle; "
  + "else apk update && apk add bash curl ca-bundle; fi; fi; ";

/** 单引号包起来，内部的单引号按 shell 的老办法断开再拼。 */
export function shellQuoteSingle(value: string) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** 去掉尾部斜杠，避免拼出 `https://panel//api/...`。 */
export function normalizeAgentCommandUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

/**
 * 拼出可以直接粘进 SSH 的一整行。
 *
 * 两条管线（面板自带脚本、GitHub 原始脚本）用 `||` 串起来：前一条整体失败
 * 才走后一条。每条都套一层 `bash -c 'set -o pipefail; …'` —— 不套的话
 * `curl … | bash` 在 curl 失败时管道仍然返回 0，命令看着成功，机器上什么
 * 都没装。
 */
export function buildAgentScriptCommand(options: AgentScriptCommandOptions): string {
  const panelUrl = normalizeAgentCommandUrl(options.panelUrl);
  const acceleratorUrl = normalizeAgentCommandUrl(options.githubAcceleratorUrl || "");
  const acceleratorActive = !!options.githubAcceleratorEnabled && !!acceleratorUrl;
  /**
   * token 也要引起来。现在的 token 是 nanoid(32)，只有字母数字和 _-，引不引
   * 都一样；但这条命令以后要由服务端拼给租户，token 一旦换了生成方式（或者
   * 有人手工塞一个），没引号的那份会直接从外层单引号里跑出去，变成粘进 SSH
   * 就执行的另一条命令。
   */
  const args = options.action === "install"
    ? `install ${shellQuoteSingle(String(options.token || "").trim())}`
    : options.action;

  const env = [
    acceleratorActive ? "GITHUB_ACCELERATOR_ENABLED=true" : "",
    acceleratorActive ? `GITHUB_ACCELERATOR_URL=${shellQuoteSingle(acceleratorUrl)}` : "",
    options.preferPanelInstall ? "FORWARDX_AGENT_PANEL_FIRST=true" : "",
  ].filter(Boolean).join(" ");
  const bashPrefix = env ? `${env} bash` : "bash";
  const withPipefail = (pipeline: string) => `bash -c ${shellQuoteSingle(`set -o pipefail; ${pipeline}`)}`;
  const curlScriptArgs = "--connect-timeout 15 --speed-limit 1024 --speed-time 60";

  const panelCommand = withPipefail(
    `curl -fsSL ${curlScriptArgs} "${panelUrl}/api/agent/install.sh" | PANEL_URL=${shellQuoteSingle(panelUrl)} ${bashPrefix} -s -- ${args}`,
  );
  const githubScriptUrl = acceleratorActive
    ? `${acceleratorUrl}/${AGENT_INSTALL_SCRIPT_RAW_URL}`
    : AGENT_INSTALL_SCRIPT_RAW_URL;
  const githubCommand = withPipefail(
    `curl -fsSL ${curlScriptArgs} "${githubScriptUrl}" | PANEL_URL=${shellQuoteSingle(panelUrl)} ${bashPrefix} -s -- ${args}`,
  );

  // 面板那条总在前面：GitHub 入口脚本自己也是去面板拉同一份 install.sh，先走 GitHub 只是多绕一道 ——
  // 国内机上 raw.githubusercontent.com 不通时还要先白等 15 秒连接超时。面板 Agent 本来就得连得上。
  // GitHub 那条留着兜底（面板反代把 /api/agent/install.sh 挡掉之类）。
  const pipelines = `${panelCommand} || ${githubCommand}`;
  return options.openwrt ? AGENT_OPENWRT_BOOTSTRAP + pipelines : pipelines;
}

/** Docker 版 Agent 的镜像（docker/agent/Dockerfile，发版时一起推）。 */
export const AGENT_DOCKER_IMAGE = "ghcr.io/zhongyizhu11-jpg/nex-agent:latest";

/**
 * Docker 版的安装命令：给装了 Docker 的 NAS、iStoreOS、Unraid。
 * 宿主机网络（转发要监听宿主机端口），NET_ADMIN / NET_RAW 给防火墙计数和诊断；配置放卷里，重建容器不用再给 Token。
 * Token、面板地址和普通安装命令一样单引号包好。
 */
export function buildAgentDockerCommand(options: { panelUrl: string; token: string }): string {
  const panelUrl = normalizeAgentCommandUrl(options.panelUrl);
  return [
    "docker run -d --name nex-agent --network host --cap-add NET_ADMIN --cap-add NET_RAW",
    "--restart unless-stopped -v nex-agent:/etc/forwardx",
    `-e PANEL_URL=${shellQuoteSingle(panelUrl)}`,
    `-e AGENT_TOKEN=${shellQuoteSingle(String(options.token || "").trim())}`,
    AGENT_DOCKER_IMAGE,
  ].join(" ");
}
