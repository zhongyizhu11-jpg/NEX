import crypto from "crypto";
import fsp from "fs/promises";
import path from "path";
import * as db from "./db";
import { APP_VERSION } from "../shared/versions";
import { githubDownloadCandidates } from "../shared/githubAccelerator";
import { appendPanelLog } from "./_core/panelLogger";

/*
  面板替连不上 GitHub 的主机转发第三方发布包（mimic 的 deb、realm 的 tar.gz）。

  面板一般在海外，按需从 GitHub（开了加速先走加速）拉一次存到 data/<cacheDir>/v<版本>/，之后谁要
  都直接给。只认代码里钉了 SHA-256 的包名，下下来的内容哈希不对就不存 —— 面板转发不会比直连
  GitHub 更不可信。
*/

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export type PinnedReleaseAssetStore = {
  /** 缓存里有（且哈希对）就用缓存，否则从 GitHub（含加速）拉一次。拿不到返回 null。 */
  getOrFetch(version: string, asset: string, fetchImpl?: FetchLike): Promise<string | null>;
};

export function createPinnedReleaseAssetStore(options: {
  /** 日志前缀，比如 MimicAssets。 */
  label: string;
  /** owner/repo */
  repo: string;
  /** data/ 下的目录名。 */
  cacheDir: string;
  maxBytes: number;
  sha256(version: string, asset: string): string | null;
}): PinnedReleaseAssetStore {
  const fetchLocks = new Map<string, Promise<string | null>>();
  const cachePathOf = (version: string, asset: string) => path.resolve(process.cwd(), "data", options.cacheDir, `v${version}`, asset);
  const log = (message: string) => appendPanelLog("warn", `[${options.label}] ${message}`);

  async function cachedIfValid(version: string, asset: string, expected: string) {
    const cachePath = cachePathOf(version, asset);
    try {
      const data = await fsp.readFile(cachePath);
      if (crypto.createHash("sha256").update(data).digest("hex") === expected) return cachePath;
      await fsp.rm(cachePath, { force: true });
    } catch {
      // 没缓存
    }
    return null;
  }

  async function download(version: string, asset: string, expected: string, fetchImpl: FetchLike) {
    const settings = await db.getAllSettings().catch(() => ({} as Record<string, string>));
    const sourceUrl = `https://github.com/${options.repo}/releases/download/v${version}/${encodeURIComponent(asset)}`;
    const candidates = githubDownloadCandidates(sourceUrl, {
      enabled: settings.githubAcceleratorEnabled === "true",
      url: settings.githubAcceleratorUrl || "",
    });
    const cachePath = cachePathOf(version, asset);
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    for (const url of candidates) {
      try {
        const res = await fetchImpl(url, {
          redirect: "follow",
          headers: { "User-Agent": `NEX/${APP_VERSION}` },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          log(`${asset} unavailable from ${new URL(url).host}: HTTP ${res.status}`);
          continue;
        }
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length === 0 || data.length > options.maxBytes) continue;
        const actual = crypto.createHash("sha256").update(data).digest("hex");
        if (actual !== expected) {
          log(`${asset} from ${new URL(url).host} has SHA-256 ${actual}, expected ${expected}; discarded`);
          continue;
        }
        const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
        await fsp.writeFile(tmpPath, data);
        await fsp.rename(tmpPath, cachePath);
        return cachePath;
      } catch (error) {
        log(`${asset} fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return null;
  }

  return {
    async getOrFetch(version, asset, fetchImpl = fetch as any) {
      const normalized = String(version || "").trim().replace(/^v/i, "");
      const expected = options.sha256(normalized, asset);
      if (!expected) return null;
      const cached = await cachedIfValid(normalized, asset, expected);
      if (cached) return cached;
      const key = `${normalized}/${asset}`;
      let lock = fetchLocks.get(key);
      if (!lock) {
        lock = download(normalized, asset, expected, fetchImpl).finally(() => fetchLocks.delete(key));
        fetchLocks.set(key, lock);
      }
      return await lock;
    },
  };
}
