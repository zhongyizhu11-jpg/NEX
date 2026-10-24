import type { Request, Response, Router } from "express";
import { REALM_ASSET_RELAY_PATH, REALM_RELEASE_REPO, realmReleaseSha256 } from "../shared/realmAssets";
import { SlidingWindowRateLimiter } from "./ai/rateLimiter";
import { ipRateLimitScope } from "./ipRateLimitScope";
import { createPinnedReleaseAssetStore, type FetchLike, type PinnedReleaseAssetStore } from "./pinnedReleaseAssets";

/*
  面板替连不上 GitHub 的主机转发 realm 发布包（2.3.483）。安装脚本先从 GitHub 装，装不上才来这里。
  缓存在 data/realm-assets/v<版本>/，只认 shared/realmAssets.ts 钉了哈希的包名。
*/

const relayLimiter = new SlidingWindowRateLimiter({ limit: 120, windowMs: 10 * 60 * 1000 });
// 用到时才建：db 那条 import 链会绕回这个文件，模块顶层直接建会撞上还没跑完的 pinnedReleaseAssets。
let store: PinnedReleaseAssetStore | null = null;
const getStore = () => (store ??= createPinnedReleaseAssetStore({
  label: "RealmAssets",
  repo: REALM_RELEASE_REPO,
  cacheDir: "realm-assets",
  maxBytes: 16 * 1024 * 1024,
  sha256: realmReleaseSha256,
}));

export function getOrFetchRealmAssetPath(version: string, asset: string, fetchImpl?: FetchLike) {
  return getStore().getOrFetch(version, asset, fetchImpl);
}

export function registerRealmAssetRoutes(router: Router) {
  router.get(`${REALM_ASSET_RELAY_PATH}/:version/:asset`, async (req: Request, res: Response) => {
    if (!relayLimiter.consume(ipRateLimitScope(req.ip || "")).allowed) {
      res.status(429).send("Too many requests");
      return;
    }
    const version = String(req.params.version || "").trim().replace(/^v/i, "");
    const asset = String(req.params.asset || "").trim();
    if (!/^\d+\.\d+\.\d+$/.test(version) || !realmReleaseSha256(version, asset)) {
      res.status(404).send("Not found");
      return;
    }
    const filePath = await getOrFetchRealmAssetPath(version, asset);
    if (!filePath) {
      res.status(503).send("Realm asset not available");
      return;
    }
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Disposition", `attachment; filename="${asset}"`);
    res.sendFile(filePath);
  });
}
