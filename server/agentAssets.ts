import { compareVersions, normalizeVersion } from "@shared/version";
import { createHash } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { AGENT_VERSION, APP_VERSION } from "../shared/versions";
import { setBoundedMapValue } from "./boundedCache";

const REPO_URL = "https://github.com/zhongyizhu11-jpg/NEX";
const MAX_AGENT_ASSET_BYTES = 80 * 1024 * 1024;
const fetchLocks = new Map<string, Promise<string | null>>();

/*
  /api/agent/assets 不用登录（装机脚本、老 Agent 升级都从这里取），所以替人去 GitHub 下载这件事要收住：
  - 只替「当前版本」和往前 AGENT_ASSET_RECENT_RELEASES 个补丁版本去下（装机脚本当前版本的包还没传完时，
    会回退到上一个发布版本；比当前新的也放行，面板没升级时脚本可能取 GitHub 上最新的）；
    更老的只认面板上已经有的文件。
  - 下不到的记负缓存，AGENT_ASSET_MISS_TTL_MS 内不再去 GitHub。
  - 下完按发布页的 SHA256SUMS 校验（发布流程每版都传这个文件）。
  - 缓存目录最多留 AGENT_ASSET_CACHE_MAX_VERSIONS 个版本，多了删最旧的（当前版本不删）。
*/
export const AGENT_ASSET_RECENT_RELEASES = 5;
export const AGENT_ASSET_CACHE_MAX_VERSIONS = 6;
const AGENT_ASSET_MISS_TTL_MS = 5 * 60 * 1000;
const missCache = new Map<string, number>();

/** 什么样的 fetch 都行（测试里换成假的）。 */
export type AgentAssetFetch = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers: { get(name: string): string | null };
  body: any;
  text(): Promise<string>;
}>;

export const AGENT_ASSET_NAMES = [
  "forwardx-agent-linux-amd64",
  "forwardx-agent-linux-arm64",
  "forwardx-fxp-linux-amd64",
  "forwardx-fxp-linux-arm64",
  "forwardx-runtime-linux-amd64",
  "forwardx-runtime-linux-arm64",
] as const;

export const AGENT_ASSET_NAME_SET = new Set<string>(AGENT_ASSET_NAMES);

const serverDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

function hasElfMagic(buffer: Uint8Array) {
  return buffer.length >= 4
    && buffer[0] === 0x7f
    && buffer[1] === 0x45
    && buffer[2] === 0x4c
    && buffer[3] === 0x46;
}

function isBundledElfAsset(filePath: string) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    return bytesRead === header.length && hasElfMagic(header);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors while rejecting an invalid asset.
      }
    }
  }
}

async function isCachedElfAsset(filePath: string) {
  let file: fsp.FileHandle | undefined;
  try {
    file = await fsp.open(filePath, "r");
    const header = Buffer.alloc(4);
    const result = await file.read(header, 0, header.length, 0);
    return result.bytesRead === header.length && hasElfMagic(header);
  } catch {
    return false;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function isSemver(version: string) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function githubAssetUrl(version: string, asset: string) {
  return `${REPO_URL}/releases/download/v${normalizeVersion(version)}/${encodeURIComponent(asset)}`;
}

function agentAssetCachePath(version: string, asset: string) {
  return path.resolve(process.cwd(), "data", "agent-assets", `v${normalizeVersion(version)}`, asset);
}

function getAgentAssetReleaseCandidates(version: string) {
  const normalized = normalizeVersion(version);
  const agentVersion = normalizeVersion(AGENT_VERSION);
  const appVersion = normalizeVersion(APP_VERSION);
  const candidates = [normalized];
  if ((normalized === agentVersion || normalized === appVersion) && appVersion !== normalized) {
    candidates.unshift(appVersion);
  }
  if ((normalized === agentVersion || normalized === appVersion) && agentVersion !== normalized) {
    candidates.push(agentVersion);
  }
  return Array.from(new Set(candidates.filter(isSemver)));
}

function getAgentAssetCandidates(version: string, asset: string) {
  const normalized = normalizeVersion(version);
  const agentVersion = normalizeVersion(AGENT_VERSION);
  const appVersion = normalizeVersion(APP_VERSION);
  const includeVersionless = normalized === agentVersion || normalized === appVersion;
  const versionDirs = [`v${normalized}`, normalized];
  if (normalized === agentVersion && appVersion !== agentVersion) {
    versionDirs.push(`v${appVersion}`, appVersion);
  } else if (normalized === appVersion && appVersion !== agentVersion) {
    versionDirs.push(`v${agentVersion}`, agentVersion);
  }
  const assetRoots = [
    path.resolve(process.cwd(), "dist", "agent"),
    path.resolve(process.cwd(), "data", "agent-assets"),
    path.resolve(process.cwd(), "agent-assets"),
    path.resolve(serverDir, "agent"),
    path.resolve(serverDir, "agent-assets"),
    path.resolve(serverDir, "..", "dist", "agent"),
    path.resolve(serverDir, "..", "agent-assets"),
  ];

  const candidates: string[] = [];
  for (const root of assetRoots) {
    if (includeVersionless) candidates.push(path.resolve(root, asset));
    for (const versionDir of versionDirs) {
      candidates.push(path.resolve(root, versionDir, asset));
    }
  }
  return Array.from(new Set(candidates));
}

export function getBundledAgentAssetPath(version: string, asset: string) {
  const normalized = normalizeVersion(version);
  if (!isSemver(normalized) || !AGENT_ASSET_NAME_SET.has(asset)) return null;

  for (const candidate of getAgentAssetCandidates(normalized, asset)) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size > 0 && isBundledElfAsset(candidate)) return candidate;
    } catch {
      // Try next bundled asset location.
    }
  }
  return null;
}

/** 这个版本值不值得替人去 GitHub 下：当前 Agent / 面板版本，或者不比「当前往前 N 个补丁版本」更老。 */
export function isAgentAssetVersionFetchable(version: string) {
  const normalized = normalizeVersion(version);
  if (!isSemver(normalized)) return false;
  if (normalized === normalizeVersion(AGENT_VERSION) || normalized === normalizeVersion(APP_VERSION)) return true;
  const [major, minor, patch] = normalizeVersion(APP_VERSION).split(".").map(Number);
  const floor = `${major}.${minor}.${Math.max(0, patch - AGENT_ASSET_RECENT_RELEASES)}`;
  return compareVersions(normalized, floor) >= 0;
}

/**
 * 发布页上这个版本的 SHA256SUMS 里，这个文件该是什么哈希。
 * 返回哈希；发布页没有这个文件（老版本）或者里面没列这一项返回 "unpublished"；
 * 取不到（网络问题、上游 5xx）返回 null —— 这种情况不缓存二进制，过一会儿再试。
 */
async function releaseAssetSha256(releaseVersion: string, asset: string, fetchImpl: AgentAssetFetch): Promise<string | "unpublished" | null> {
  try {
    const res = await fetchImpl(`${REPO_URL}/releases/download/v${normalizeVersion(releaseVersion)}/SHA256SUMS`, {
      redirect: "follow",
      headers: { "User-Agent": `NEX/${APP_VERSION}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return "unpublished";
    if (!res.ok) return null;
    const sums = parseSha256Sums(await res.text());
    return sums[asset] || "unpublished";
  } catch {
    return null;
  }
}

async function fileSha256(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * 缓存目录里的版本多于上限时删最旧的（按目录修改时间）。当前 Agent / 面板版本和刚写进去的那个不删。
 */
export async function pruneAgentAssetCache(keepVersion: string, maxVersions = AGENT_ASSET_CACHE_MAX_VERSIONS) {
  const root = path.resolve(process.cwd(), "data", "agent-assets");
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [] as string[];
  }
  const protectedDirs = new Set([keepVersion, AGENT_VERSION, APP_VERSION].map((value) => `v${normalizeVersion(value)}`));
  const dirs: Array<{ name: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^v\d+\.\d+\.\d+$/.test(entry.name)) continue;
    const stat = await fsp.stat(path.join(root, entry.name)).catch(() => null);
    if (stat) dirs.push({ name: entry.name, mtimeMs: stat.mtimeMs });
  }
  if (dirs.length <= maxVersions) return [];
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const removed: string[] = [];
  let room = Math.max(0, maxVersions - dirs.filter((dir) => protectedDirs.has(dir.name)).length);
  for (const dir of dirs) {
    if (protectedDirs.has(dir.name)) continue;
    if (room > 0) {
      room -= 1;
      continue;
    }
    await fsp.rm(path.join(root, dir.name), { recursive: true, force: true }).catch(() => undefined);
    removed.push(dir.name);
  }
  return removed;
}

async function downloadAgentAssetToCache(version: string, asset: string, fetchImpl: AgentAssetFetch) {
  const normalized = normalizeVersion(version);
  if (!isSemver(normalized) || !AGENT_ASSET_NAME_SET.has(asset)) return null;

  for (const releaseVersion of getAgentAssetReleaseCandidates(normalized)) {
    const cachePath = agentAssetCachePath(releaseVersion, asset);
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      const res = await fetchImpl(githubAssetUrl(releaseVersion, asset), {
        cache: "no-store",
        redirect: "follow",
        headers: {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "User-Agent": `NEX/${APP_VERSION}`,
        },
      });
      if (!res.ok || !res.body) {
        console.warn(`[AgentAssets] Release asset unavailable ${asset} v${releaseVersion}: ${res.status} ${res.statusText}`);
        continue;
      }

      const contentLength = Number(res.headers.get("content-length") || 0);
      if (contentLength > MAX_AGENT_ASSET_BYTES) {
        console.warn(`[AgentAssets] Release asset too large ${asset} v${releaseVersion}: ${contentLength}`);
        continue;
      }

      const file = await fsp.open(tmpPath, "w");
      let written = 0;
      try {
        for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
          written += chunk.length;
          if (written > MAX_AGENT_ASSET_BYTES) throw new Error("Agent asset is too large");
          await file.write(chunk);
        }
      } finally {
        await file.close();
      }
      if (written <= 0) continue;
      if (!(await isCachedElfAsset(tmpPath))) {
        console.warn(`[AgentAssets] Downloaded asset is not an ELF binary ${asset} v${releaseVersion}`);
        continue;
      }
      const expected = await releaseAssetSha256(releaseVersion, asset, fetchImpl);
      if (expected === null) {
        console.warn(`[AgentAssets] SHA256SUMS unavailable for v${releaseVersion}, not caching ${asset}`);
        continue;
      }
      if (expected === "unpublished") {
        console.warn(`[AgentAssets] v${releaseVersion} publishes no checksum for ${asset}; caching without verification`);
      } else if ((await fileSha256(tmpPath)) !== expected) {
        console.warn(`[AgentAssets] Checksum mismatch for ${asset} v${releaseVersion}`);
        continue;
      }
      await fsp.chmod(tmpPath, 0o755).catch(() => undefined);
      await fsp.rename(tmpPath, cachePath);
      await pruneAgentAssetCache(releaseVersion).catch(() => undefined);
      return cachePath;
    } catch (error) {
      console.warn(`[AgentAssets] Failed to cache ${asset} v${releaseVersion}:`, error);
    } finally {
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }
  return null;
}

export async function getOrFetchAgentAssetPath(version: string, asset: string, fetchImpl: AgentAssetFetch = fetch as any) {
  const bundled = getBundledAgentAssetPath(version, asset);
  if (bundled) return bundled;

  const normalized = normalizeVersion(version);
  if (!isSemver(normalized) || !AGENT_ASSET_NAME_SET.has(asset)) return null;
  if (!isAgentAssetVersionFetchable(normalized)) return null;

  const key = `${normalized}:${asset}`;
  const missUntil = missCache.get(key) || 0;
  if (missUntil > Date.now()) return null;
  if (missUntil) missCache.delete(key);
  let lock = fetchLocks.get(key);
  if (!lock) {
    lock = downloadAgentAssetToCache(normalized, asset, fetchImpl)
      .then((result) => {
        if (!result) setBoundedMapValue(missCache, key, Date.now() + AGENT_ASSET_MISS_TTL_MS, 1000);
        return result;
      })
      .finally(() => fetchLocks.delete(key));
    fetchLocks.set(key, lock);
  }
  return await lock;
}

export function clearAgentAssetMissCacheForTests() {
  missCache.clear();
}

export function getMissingBundledAgentAssets(version = APP_VERSION) {
  const normalized = normalizeVersion(version);
  return AGENT_ASSET_NAMES.filter((asset) => !getBundledAgentAssetPath(normalized, asset));
}

const RELEASE_CHECKSUM_TTL_MS = 6 * 60 * 60 * 1000;
const RELEASE_CHECKSUM_FAILURE_TTL_MS = 5 * 60 * 1000;
const releaseChecksumCache = new Map<string, { at: number; sums: Record<string, string[]> | null; complete: boolean }>();

export function parseSha256Sums(text: string) {
  const sums: Record<string, string> = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/i);
    // 旧版本发布的 SHA256SUMS 里写的是 CI 机器上的绝对路径，按文件名比对。
    const name = match ? match[2].split("/").pop() || "" : "";
    if (match && AGENT_ASSET_NAME_SET.has(name)) sums[name] = match[1].toLowerCase();
  }
  return sums;
}

/**
 * 某个发布版本里 Agent / FXP / runtime 二进制的 SHA-256。
 *
 * 嵌进面板生成的 install.sh：二进制不管是从 GitHub、加速镜像还是面板缓存下的，都按这里
 * 的值校验。安装脚本是从面板拿的，面板是 https 时这份哈希和面板一样可信 —— 镜像被人
 * 替换了二进制，校验就过不去。
 *
 * 优先用面板自带（发布包里打进来的）二进制现算，其次去 GitHub 取 SHA256SUMS；
 * 都拿不到就返回 null，安装脚本会自己再去 GitHub 取一次。
 */
export async function getAgentReleaseChecksums(version: string): Promise<Record<string, string[]> | null> {
  const normalized = normalizeVersion(version);
  if (!isSemver(normalized)) return null;
  const cached = releaseChecksumCache.get(normalized);
  if (cached && Date.now() - cached.at < (cached.complete ? RELEASE_CHECKSUM_TTL_MS : RELEASE_CHECKSUM_FAILURE_TTL_MS)) {
    return cached.sums;
  }
  /*
    面板自带的二进制和 GitHub 发布页上的二进制是两次构建出来的，哈希不一定相同
    （老版本构建带了 VCS 信息，工作区状态不同就不同）。装机脚本可能从面板下，也可能
    从 GitHub / 加速镜像下，所以两份都嵌进去，下到哪一份都认；两份都是可信来源。
  */
  const sums: Record<string, string[]> = {};
  const add = (asset: string, hash: string) => {
    const list = sums[asset] || (sums[asset] = []);
    if (!list.includes(hash)) list.push(hash);
  };
  for (const asset of AGENT_ASSET_NAMES) {
    const filePath = getBundledAgentAssetPath(normalized, asset);
    if (!filePath) continue;
    const { createHash } = await import("crypto");
    add(asset, createHash("sha256").update(await fsp.readFile(filePath)).digest("hex"));
  }
  let githubOk = false;
  try {
    const response = await fetch(`${REPO_URL}/releases/download/v${normalized}/SHA256SUMS`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const parsed = parseSha256Sums(await response.text());
      for (const [asset, hash] of Object.entries(parsed)) add(asset, hash);
      githubOk = Object.keys(parsed).length > 0;
    }
  } catch {
    // 连不上 GitHub（或者发布页的二进制还没传完）：先只用面板自带的，过一会儿再试。
  }
  const result = Object.keys(sums).length > 0 ? sums : null;
  releaseChecksumCache.set(normalized, { at: Date.now(), sums: result, complete: githubOk });
  return result;
}
