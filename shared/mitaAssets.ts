/*
  mita（Mieru 的服务端，enfein/mieru，GPLv3）钉死的版本与哈希。

  mita 是一个独立程序，Agent 只是把它下下来、写配置、用 forwardx-mita 服务跑起来 —— 不链接、
  不改它的代码，许可证见 THIRD_PARTY_NOTICES.md。

  两层哈希都钉在这里，缺一不可：
    - 发布包（tar.gz）的哈希：scripts/build-agent-release.sh 下包时校验；面板替主机去 GitHub 拉时也按它校验。
    - 包里 mita 二进制的哈希：Agent 不管从哪拿到（面板 /api/agent/assets 转发的 forwardx-mita-linux-<架构>、
      或者自己从 GitHub / 加速镜像下的包里解出来），装之前都按它校验，对不上就不装。
      上游的包是 CI 打的静态二进制，解出来的文件逐字节固定，所以能钉。

  升级 mita：改 MITA_VERSION，两张表换成新版本的四个哈希（发布页每个包旁边有 .sha256.txt），
  build-agent-release.sh 不用动 —— 它从这个文件里读。一次只钉一个版本：脚本按版本号前缀取哈希。
*/

/** 1.0 起的配置字段（portBindings / users / mtu / loggingLevel）一直没变过；3.39.0 是撰写时的最新版（2026-10-23 发布）。 */
export const MITA_VERSION = "3.39.0";

export const MITA_RELEASE_REPO = "enfein/mieru";

export const MITA_ARCHES = ["amd64", "arm64"] as const;
export type MitaArch = (typeof MITA_ARCHES)[number];

/** 发布包的 SHA-256，键是「版本/包名」。 */
export const MITA_TARBALL_SHA256: Readonly<Record<string, string>> = {
  "3.39.0/mita_3.39.0_linux_amd64.tar.gz": "ea35fdef84bef1378f32b74a2d5a883d508a49dd4e64dba9a3a8363beed5798c",
  "3.39.0/mita_3.39.0_linux_arm64.tar.gz": "853eb8c3221ce294afffd7d690dbece929c4e774ed3d81c209b71446b515d1c6",
};

/** 包里 mita 二进制的 SHA-256，键是「版本/forwardx-mita-linux-架构」（也就是面板转发时的资产名）。 */
export const MITA_BINARY_SHA256: Readonly<Record<string, string>> = {
  "3.39.0/forwardx-mita-linux-amd64": "8418176b9ea6c57783a8776e5a2a4ca07d6c055b833ad33d8ab21727b86a769c",
  "3.39.0/forwardx-mita-linux-arm64": "ded0b9b8067862d855ac32287c1b73d95ccff867216c060c5a7d235f1ddee73e",
};

/** 随 Agent 发布包一起发的资产名（build-agent-release.sh 产出，/api/agent/assets 转发）。 */
export const MITA_AGENT_ASSET_NAMES = ["forwardx-mita-linux-amd64", "forwardx-mita-linux-arm64"] as const;

function cleanVersion(version: string) {
  return String(version || "").trim().replace(/^v/i, "");
}

export function mitaAgentAssetName(arch: MitaArch) {
  return `forwardx-mita-linux-${arch}`;
}

export function mitaTarballName(version: string, arch: MitaArch) {
  const clean = cleanVersion(version);
  return `mita_${clean}_linux_${arch}.tar.gz`;
}

export function mitaTarballUrl(version: string, arch: MitaArch) {
  const clean = cleanVersion(version);
  return `https://github.com/${MITA_RELEASE_REPO}/releases/download/v${clean}/${mitaTarballName(clean, arch)}`;
}

export function mitaTarballSha256(version: string, arch: MitaArch): string | null {
  const clean = cleanVersion(version);
  return MITA_TARBALL_SHA256[`${clean}/${mitaTarballName(clean, arch)}`] ?? null;
}

export function mitaBinarySha256(version: string, arch: MitaArch): string | null {
  return MITA_BINARY_SHA256[`${cleanVersion(version)}/${mitaAgentAssetName(arch)}`] ?? null;
}
