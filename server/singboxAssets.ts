import type { Request, Response, Router } from "express";
import { isShellSafeUrl } from "../shared/mimicAssets";
import { SINGBOX_ASSET_RELAY_PATH, SINGBOX_RELEASE_REPO, singboxReleaseSha256 } from "../shared/singboxAssets";
import { SlidingWindowRateLimiter } from "./ai/rateLimiter";
import { ipRateLimitScope } from "./ipRateLimitScope";
import { createPinnedReleaseAssetStore, type FetchLike, type PinnedReleaseAssetStore } from "./pinnedReleaseAssets";

/*
  面板替连不上 GitHub 的落地机转发 sing-box 发布包。落地机先从 GitHub 下，下不到才来这里。
  缓存在 data/singbox-assets/v<版本>/，只认 shared/singboxAssets.ts 钉了哈希的包名。
*/

const relayLimiter = new SlidingWindowRateLimiter({ limit: 60, windowMs: 10 * 60 * 1000 });
// 用到时才建：db 那条 import 链会绕回这个文件，模块顶层直接建会撞上还没跑完的 pinnedReleaseAssets。
let store: PinnedReleaseAssetStore | null = null;
const getStore = () => (store ??= createPinnedReleaseAssetStore({
  label: "SingboxAssets",
  repo: SINGBOX_RELEASE_REPO,
  cacheDir: "singbox-assets",
  maxBytes: 64 * 1024 * 1024,
  sha256: singboxReleaseSha256,
}));

export function getOrFetchSingboxAssetPath(version: string, asset: string, fetchImpl?: FetchLike) {
  return getStore().getOrFetch(version, asset, fetchImpl);
}

/** 面板转发 sing-box 包的根地址（给下发命令用）；面板地址不能安全写进 shell 时返回空串。 */
export function singboxAssetRelayBase(panelUrl: string) {
  const base = `${String(panelUrl || "").replace(/\/+$/, "")}${SINGBOX_ASSET_RELAY_PATH}`;
  return panelUrl && isShellSafeUrl(base) ? base : "";
}

export function registerSingboxAssetRoutes(router: Router) {
  router.get(`${SINGBOX_ASSET_RELAY_PATH}/:version/:asset`, async (req: Request, res: Response) => {
    if (!relayLimiter.consume(ipRateLimitScope(req.ip || "")).allowed) {
      res.status(429).send("Too many requests");
      return;
    }
    const version = String(req.params.version || "").trim().replace(/^v/i, "");
    const asset = String(req.params.asset || "").trim();
    if (!/^\d+\.\d+\.\d+$/.test(version) || !singboxReleaseSha256(version, asset)) {
      res.status(404).send("Not found");
      return;
    }
    const filePath = await getOrFetchSingboxAssetPath(version, asset);
    if (!filePath) {
      res.status(503).send("sing-box asset not available");
      return;
    }
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Disposition", `attachment; filename="${asset}"`);
    res.sendFile(filePath);
  });
}
