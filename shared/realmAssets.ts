/*
  zhboner/realm 发布包的 SHA-256（安装脚本默认装 v2.9.4）。

  主机先从 GitHub 装 realm，装不上才从面板下（GET /api/agent/realm-assets/v2.9.4/<包名>）：面板按需
  从 GitHub 拉一次缓存起来，只认这里钉了哈希的包名，内容对不上就不给。v2.9.4 没有 glibc2.28 那种包。
*/
export const REALM_RELEASE_REPO = "zhboner/realm";

export const REALM_RELEASE_SHA256: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "2.9.4": {
    "realm-x86_64-unknown-linux-gnu.tar.gz": "9dec109386b8abc828b452d0d1cecde35b7a2f8cfa93eae757fe9c248ad07ddd",
    "realm-x86_64-unknown-linux-musl.tar.gz": "a19b86c4ae4642d5864821b41d23633c0c91df279a88496c05834dc584169175",
    "realm-aarch64-unknown-linux-gnu.tar.gz": "1f7f06e82fe0ea798b5c8e8e32906ee212a7085629a1c5cef9957ca270fcad99",
    "realm-aarch64-unknown-linux-musl.tar.gz": "0195e77ca99713166e25ff85fefe042049c79fdaddf500e8ffd9ba77494a029c",
  },
};

export function realmReleaseSha256(version: string, asset: string): string | null {
  const normalized = String(version || "").trim().replace(/^v/i, "");
  return REALM_RELEASE_SHA256[normalized]?.[String(asset || "")] ?? null;
}

/** 面板转发路径的前缀（相对面板根地址）。 */
export const REALM_ASSET_RELAY_PATH = "/api/agent/realm-assets";
