/*
  SagerNet/sing-box 发布包的 SHA-256（落地节点用的版本见 server/singboxRuntimePlan.ts 的 SINGBOX_VERSION）。

  落地机先从 GitHub（含加速）下 sing-box，下不到才从面板下（GET /api/agent/singbox-assets/v<版本>/<包名>）：
  面板按需从 GitHub 拉一次缓存起来，只认这里钉了哈希的包名，内容对不上就不给。
*/
export const SINGBOX_RELEASE_REPO = "SagerNet/sing-box";

export const SINGBOX_RELEASE_SHA256: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "1.14.0": {
    "sing-box-1.14.0-linux-amd64.tar.gz": "2375de6999f4f56ab46b4fc5ddf26a6aba1d3e61a0f4e7ddec2f4690457d5f63",
    "sing-box-1.14.0-linux-arm64.tar.gz": "04d9b40bc98dc55b6f509ce3292145c65478f65866bea64826ebb2f382385088",
  },
};

export function singboxReleaseSha256(version: string, asset: string): string | null {
  const normalized = String(version || "").trim().replace(/^v/i, "");
  return SINGBOX_RELEASE_SHA256[normalized]?.[String(asset || "")] ?? null;
}

/** 面板转发路径的前缀（相对面板根地址）。 */
export const SINGBOX_ASSET_RELAY_PATH = "/api/agent/singbox-assets";
