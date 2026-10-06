import { normalizeVersion } from "@shared/version";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { AGENT_VERSION, APP_VERSION } from "../shared/versions";

const REPO_URL = "https://github.com/zhongyizhu11-jpg/NEX";
const MAX_AGENT_ASSET_BYTES = 80 * 1024 * 1024;
const fetchLocks = new Map<string, Promise<string | null>>();

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

async function downloadAgentAssetToCache(version: string, asset: string) {
  const normalized = normalizeVersion(version);
  if (!isSemver(normalized) || !AGENT_ASSET_NAME_SET.has(asset)) return null;

  for (const releaseVersion of getAgentAssetReleaseCandidates(normalized)) {
    const cachePath = agentAssetCachePath(releaseVersion, asset);
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      const res = await fetch(githubAssetUrl(releaseVersion, asset), {
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
      await fsp.chmod(tmpPath, 0o755).catch(() => undefined);
      await fsp.rename(tmpPath, cachePath);
      return cachePath;
    } catch (error) {
      console.warn(`[AgentAssets] Failed to cache ${asset} v${releaseVersion}:`, error);
    } finally {
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }
  return null;
}

export async function getOrFetchAgentAssetPath(version: string, asset: string) {
  const bundled = getBundledAgentAssetPath(version, asset);
  if (bundled) return bundled;

  const normalized = normalizeVersion(version);
  if (!isSemver(normalized) || !AGENT_ASSET_NAME_SET.has(asset)) return null;

  const key = `${normalized}:${asset}`;
  let lock = fetchLocks.get(key);
  if (!lock) {
    lock = downloadAgentAssetToCache(normalized, asset).finally(() => fetchLocks.delete(key));
    fetchLocks.set(key, lock);
  }
  return await lock;
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
