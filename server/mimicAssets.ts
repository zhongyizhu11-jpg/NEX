import type { Request, Response, Router } from "express";
import {
  MIMIC_ASSET_RELAY_PATH,
  MIMIC_INSTALL_SCRIPT_PATH,
  MIMIC_RELEASE_REPO,
  isShellSafeUrl,
  mimicReleaseSha256,
} from "../shared/mimicAssets";
import { resolvePanelUrl } from "./agentPanelUrl";
import { SlidingWindowRateLimiter } from "./ai/rateLimiter";
import { ipRateLimitScope } from "./ipRateLimitScope";
import { createPinnedReleaseAssetStore, type FetchLike, type PinnedReleaseAssetStore } from "./pinnedReleaseAssets";
import { MIMIC_TARGET_VERSION, readMimicInstallerScript, withMimicInstallerDefaults } from "./mimicInstallTasks";

/*
  面板替连不上 GitHub 的主机转发 mimic 发布包（2.3.443）。

  国内机上 Agent 跑安装脚本时 GitHub 和几个公共镜像都可能不通（po0 那台 Debian 12 就是：
  手动带代理能装，Agent 装就全军覆没）。下载、校验、缓存在 pinnedReleaseAssets.ts（realm 也用它），
  缓存在 data/mimic-assets/v<版本>/，只认 shared/mimicAssets.ts 钉了哈希的包名。

  另外 GET /api/agent/mimic-install.sh 给手动安装用：就是面板自带的安装脚本，开头注入了
  面板转发地址，主机上一行 curl … | bash 就能装。
*/

const relayLimiter = new SlidingWindowRateLimiter({ limit: 120, windowMs: 10 * 60 * 1000 });
// 用到时才建：db 那条 import 链会绕回这个文件，模块顶层直接建会撞上还没跑完的 pinnedReleaseAssets。
let store: PinnedReleaseAssetStore | null = null;
const getStore = () => (store ??= createPinnedReleaseAssetStore({
  label: "MimicAssets",
  repo: MIMIC_RELEASE_REPO,
  cacheDir: "mimic-assets",
  maxBytes: 16 * 1024 * 1024,
  sha256: mimicReleaseSha256,
}));

export function isRelayableMimicAsset(version: string, asset: string) {
  return !!mimicReleaseSha256(version, asset);
}

/** 缓存里有（且哈希对）就用缓存，否则从 GitHub（含加速）拉一次。拿不到返回 null。 */
export function getOrFetchMimicAssetPath(version: string, asset: string, fetchImpl?: FetchLike) {
  return getStore().getOrFetch(version, asset, fetchImpl);
}

/** 面板转发 mimic 包的根地址（给安装脚本用）；面板地址不能安全写进 shell 时返回空串。 */
export function mimicAssetRelayBase(panelUrl: string) {
  const base = `${String(panelUrl || "").replace(/\/+$/, "")}${MIMIC_ASSET_RELAY_PATH}`;
  return panelUrl && isShellSafeUrl(base) ? base : "";
}

function rateLimited(req: Request, res: Response) {
  const result = relayLimiter.consume(ipRateLimitScope(req.ip || ""));
  if (result.allowed) return false;
  res.status(429).send("Too many requests");
  return true;
}

export function registerMimicAssetRoutes(router: Router) {
  router.get(`${MIMIC_ASSET_RELAY_PATH}/:version/:asset`, async (req: Request, res: Response) => {
    if (rateLimited(req, res)) return;
    const version = String(req.params.version || "").trim().replace(/^v/i, "");
    const asset = String(req.params.asset || "").trim();
    if (!/^\d+\.\d+\.\d+$/.test(version) || !isRelayableMimicAsset(version, asset)) {
      res.status(404).send("Not found");
      return;
    }
    const filePath = await getOrFetchMimicAssetPath(version, asset);
    if (!filePath) {
      res.status(503).send("Mimic asset not available");
      return;
    }
    res.setHeader("Content-Type", "application/vnd.debian.binary-package");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Disposition", `attachment; filename="${asset}"`);
    res.sendFile(filePath);
  });

  router.get(MIMIC_INSTALL_SCRIPT_PATH, async (req: Request, res: Response) => {
    if (rateLimited(req, res)) return;
    const script = readMimicInstallerScript();
    if (!script) {
      res.status(503).send("Mimic installer is not bundled with this panel");
      return;
    }
    const assetBase = mimicAssetRelayBase(await resolvePanelUrl(req));
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(withMimicInstallerDefaults(script, { version: MIMIC_TARGET_VERSION, assetBase }));
  });
}
