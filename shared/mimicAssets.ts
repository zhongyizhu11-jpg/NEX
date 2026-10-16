/*
  hack3ric/mimic 发布包（面板当前目标版本 0.7.1）的 SHA-256。

  面板转发这些包给连不上 GitHub 的主机（GET /api/agent/mimic-assets/v0.7.1/<包名>），安装脚本
  scripts/install-mimic.sh 里也钉了同一份：不管包是从面板、加速镜像还是 GitHub 拿的，哈希对不上
  就不装。两边由 server/mimicAssets.test.ts 对齐。
*/
export const MIMIC_RELEASE_REPO = "hack3ric/mimic";
/** 面板这一版装的 mimic 版本（server/mimicInstallTasks.ts 的 MIMIC_TARGET_VERSION 就是它）。 */
export const MIMIC_DEFAULT_VERSION = "0.7.1";

export const MIMIC_RELEASE_SHA256: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "0.7.1": {
    "bookworm_mimic_0.7.1-1_amd64.deb": "d227a95d8c3293f58ace79dfbed72b541a420c6fb490320e10fe98b4566cd950",
    "bookworm_mimic_0.7.1-1_arm64.deb": "8d87eab9bc8f509fcf03f4036aa3311322312aba924c3dabe92ac3c0516a31cf",
    "bookworm_mimic-dkms_0.7.1-1_amd64.deb": "ecf2791943374f4b5a603ba73ec52b132ebb6aa5d1e4ff8960cc7106e6c0b4ab",
    "bookworm_mimic-dkms_0.7.1-1_arm64.deb": "63635494984f28d10910b827e854060d7c4b90afa2d5a39dca5c703c74216c07",
    "trixie_mimic_0.7.1-1_amd64.deb": "02facc8883cf5f8f8aea70f3b00beeb11fe26f94c19a168d5030a8b75139b3a2",
    "trixie_mimic_0.7.1-1_arm64.deb": "97c227d2754051a7959eb99465c85b8ca9e92cac3322cd15dba51cf03e7a9512",
    "trixie_mimic-dkms_0.7.1-1_amd64.deb": "03ec0391d1fc7aa5644f25938b84c37f02fe10727a8833fb30ecffdc99828343",
    "trixie_mimic-dkms_0.7.1-1_arm64.deb": "8f3333e6f3233cc946dfd3c9255c6675f5e449fe3bb826f74887a7399277ea3c",
    "noble_mimic_0.7.1-1_amd64.deb": "bc2fce90cf5ff597f8847eb4e571c51eb19190c41d173950e0099121b1896543",
    "noble_mimic_0.7.1-1_arm64.deb": "172fbe95624f9dd901d26383ca7f3802b082b4fb933fc85581deedb254ee1d49",
    "noble_mimic-dkms_0.7.1-1_amd64.deb": "75ab963becea19d35a9f3ec5696d02475fab87c7377544ef06b37054d232027a",
    "noble_mimic-dkms_0.7.1-1_arm64.deb": "04be95941b53b313bffb83872a75f8919cd53b55d9f260a1850be4f905fc1d1d",
  },
};

export function mimicReleaseSha256(version: string, asset: string): string | null {
  const normalized = String(version || "").trim().replace(/^v/i, "");
  return MIMIC_RELEASE_SHA256[normalized]?.[String(asset || "")] ?? null;
}

/** 面板转发路径的前缀（相对面板根地址）。 */
export const MIMIC_ASSET_RELAY_PATH = "/api/agent/mimic-assets";
/** 手动安装用的脚本（已注入面板转发地址）。 */
export const MIMIC_INSTALL_SCRIPT_PATH = "/api/agent/mimic-install.sh";

const SAFE_URL_RE = /^https?:\/\/[A-Za-z0-9._~:/%@[\]-]+$/;
const SAFE_PROXY_RE = /^(socks5h|socks5|socks4a|socks4|http|https):\/\/[A-Za-z0-9._~:/%@[\]-]+$/;

/** 能原样写进 shell 双引号里的 URL：没有引号、空格、$、反引号、反斜杠。 */
export function isShellSafeUrl(value: string) {
  return SAFE_URL_RE.test(String(value || ""));
}

/**
 * 下载代理：socks5h://127.0.0.1:1080、http://user:pass@host:port 这类。
 * 返回规范化后的值；不合法返回 null（空串表示不用代理）。密码里的特殊字符要先 URL 编码。
 */
export function normalizeMimicDownloadProxy(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.length > 300 || !SAFE_PROXY_RE.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!url.hostname || !url.port) return null;
    if (url.search || url.hash) return null;
  } catch {
    return null;
  }
  return raw.replace(/\/+$/, "");
}

export type MimicFailureReason = "download" | "kernel-headers" | "dkms-build" | "module-not-loaded" | "unknown";

/** 从安装输出 / 错误里取 `RESULT: failed reason=…`（安装脚本最后一行）。 */
export function mimicFailureReason(...texts: Array<string | null | undefined>): MimicFailureReason {
  let reason = "";
  for (const text of texts) {
    const matches = String(text || "").match(/RESULT: failed reason=([a-z-]+)/g);
    if (matches) {
      reason = matches[matches.length - 1].replace(/^RESULT: failed reason=/, "");
      break;
    }
  }
  if (reason === "download" || reason === "kernel-headers" || reason === "dkms-build" || reason === "module-not-loaded") return reason;
  // 旧脚本（2.3.442 及以前）下载失败时只会说「no compatible Mimic Debian assets」+ reason=unknown
  if (texts.some((text) => /failed to download mimic source archive|could not download the Mimic packages/.test(String(text || "")))) {
    return "download";
  }
  return "unknown";
}

export function mimicFailureReasonText(reason: MimicFailureReason) {
  switch (reason) {
    case "download": return "下载不到安装包：这台机器连不上 GitHub，用代理安装或手动安装";
    case "kernel-headers": return "缺当前内核的头文件，内核模块编不出来";
    case "dkms-build": return "内核模块编译失败，看日志";
    case "module-not-loaded": return "装好了但内核模块加载不上（Secure Boot 或需要重启）";
    default: return "安装失败，看日志";
  }
}

/**
 * 手动安装命令。panel：走面板转发（面板地址能连就行，推荐）；github：直接从 GitHub 下 .deb
 * （Debian / Ubuntu），跟手动验证过的步骤一致。proxy 只加在下载上。
 */
export function buildMimicManualCommands(options: { panelUrl: string; version?: string; proxy?: string }) {
  const version = String(options.version || MIMIC_DEFAULT_VERSION).replace(/^v/, "");
  const panelUrl = String(options.panelUrl || "").replace(/\/+$/, "");
  const proxy = normalizeMimicDownloadProxy(options.proxy) || "";
  const panel = panelUrl && isShellSafeUrl(`${panelUrl}${MIMIC_INSTALL_SCRIPT_PATH}`)
    ? `curl -fsSL ${panelUrl}${MIMIC_INSTALL_SCRIPT_PATH} | sudo ${proxy ? `FORWARDX_MIMIC_PROXY=${proxy} ` : ""}bash`
    : "";
  const curlProxy = proxy ? ` -x ${proxy}` : "";
  // 发布包只有 bookworm / trixie / noble 三套：别的代号按家族退回（同安装脚本的 detect_deb_codenames）。
  // 一行一步用 && 串起来：任何一步失败就停，不会拿旧文件去装；临时目录每次新建。
  const github = [
    `V=${version}; A=$(dpkg --print-architecture); . /etc/os-release`,
    `case "$VERSION_CODENAME" in bookworm|trixie|noble) C=$VERSION_CODENAME ;; *) case " $ID $ID_LIKE " in *" ubuntu "*) C=noble ;; *) C=bookworm ;; esac ;; esac`,
    `BASE=https://github.com/${MIMIC_RELEASE_REPO}/releases/download/v$V; D=$(mktemp -d) && \\`,
    `curl -fL --retry 3${curlProxy} -o "$D/mimic.deb" "$BASE/\${C}_mimic_\${V}-1_\${A}.deb" && \\`,
    `curl -fL --retry 3${curlProxy} -o "$D/mimic-dkms.deb" "$BASE/\${C}_mimic-dkms_\${V}-1_\${A}.deb" && \\`,
    `sudo apt-get install -y "linux-headers-$(uname -r)" "$D/mimic.deb" "$D/mimic-dkms.deb" && \\`,
    `sudo modprobe mimic && mimic --version`,
  ].join("\n");
  return { panel, github };
}
