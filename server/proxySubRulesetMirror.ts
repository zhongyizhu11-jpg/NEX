/**
 * 规则集镜像：由面板自己托管 .mrs / .srs / .list，客户端从面板拿，不直连 raw.githubusercontent.com。
 *
 * 为什么要有：受限网络里客户端取不到 GitHub 的规则文件，整份配置就加载失败 ——
 * 而订阅本身是面板发的，面板能到的地方客户端就能到。
 *
 * 路径照抄上游路径：/api/sub/ruleset/<上游 raw.githubusercontent.com 后面的路径>。
 * 只放行三家仓库的固定前缀，不是开放代理。文件落在数据目录的 rulesetCache 里，
 * 按订阅设置的规则集更新间隔过期；上游取不到时继续用过期的那份（有总比没有强）。
 */

import express, { type Request, type Response } from "express";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { clientLogoDir } from "./clientLogoRoute";
import { loadProxySubSettings } from "./proxySubSettings";

const UPSTREAM = "https://raw.githubusercontent.com";

/** 放行的上游路径。改分类目录（shared/proxyRuleset.ts）不用动这里：按仓库前缀放行，不按文件名。 */
const ALLOWED = [
  /^MetaCubeX\/meta-rules-dat\/meta\/geo\/(?:geosite|geoip)\/[a-z0-9@!.-]{1,64}\.mrs$/i,
  /^SagerNet\/sing-(?:geosite|geoip)\/rule-set\/(?:geosite|geoip)-[a-z0-9@!.-]{1,64}\.srs$/i,
  /^blackmatrix7\/ios_rule_script\/master\/rule\/(?:Surge|Loon|QuantumultX|Shadowrocket)\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\.list$/,
];

const MAX_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

type CacheMeta = { fetchedAt: number; etag: string; contentType: string; size: number };

const inflight = new Map<string, Promise<void>>();

export function proxySubRulesetCacheDir(): string {
  return path.join(path.dirname(clientLogoDir()), "rulesetCache");
}

export function isAllowedRulesetPath(upstreamPath: string): boolean {
  return ALLOWED.some((pattern) => pattern.test(upstreamPath));
}

function cachePaths(upstreamPath: string) {
  const id = createHash("sha1").update(upstreamPath).digest("hex");
  const dir = proxySubRulesetCacheDir();
  return { file: path.join(dir, `${id}.bin`), meta: path.join(dir, `${id}.json`) };
}

function readMeta(file: string): CacheMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as CacheMeta : null;
  } catch {
    return null;
  }
}

function contentTypeFor(upstreamPath: string): string {
  if (upstreamPath.endsWith(".list")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

async function refresh(upstreamPath: string): Promise<void> {
  const existing = inflight.get(upstreamPath);
  if (existing) return existing;
  const task = (async () => {
    const { file, meta } = cachePaths(upstreamPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${UPSTREAM}/${upstreamPath}`, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) throw new Error(`上游返回 ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_BYTES) throw new Error("文件超过 32 MB");
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, file);
      const etag = `"${createHash("sha1").update(buffer).digest("hex")}"`;
      fs.writeFileSync(meta, JSON.stringify({ fetchedAt: Date.now(), etag, contentType: contentTypeFor(upstreamPath), size: buffer.length } satisfies CacheMeta));
    } finally {
      clearTimeout(timer);
    }
  })();
  inflight.set(upstreamPath, task);
  try {
    await task;
  } finally {
    inflight.delete(upstreamPath);
  }
}

export const proxySubRulesetRouter = express.Router();

proxySubRulesetRouter.get("/api/sub/ruleset/*", async (req: Request, res: Response) => {
  const upstreamPath = String((req.params as any)[0] || "").replace(/^\/+/, "");
  if (!upstreamPath || upstreamPath.includes("..") || !isAllowedRulesetPath(upstreamPath)) {
    res.status(404).type("text/plain").send("not found");
    return;
  }
  const settings = await loadProxySubSettings();
  if (settings.rulesetMirror !== "panel") {
    // 没开「由面板托管」就不当镜像用：订阅里不会出现这种地址，来的只能是乱拼的。
    res.status(404).type("text/plain").send("mirror disabled");
    return;
  }
  const { file, meta } = cachePaths(upstreamPath);
  let info = readMeta(meta);
  const fresh = info && fs.existsSync(file) && Date.now() - info.fetchedAt < settings.rulesetIntervalSec * 1000;
  if (!fresh) {
    try {
      await refresh(upstreamPath);
      info = readMeta(meta);
    } catch (error) {
      // 有旧的就先用旧的；一份都没有才报错。
      if (!info || !fs.existsSync(file)) {
        console.warn(`[proxy-subscription] 规则集镜像取不到 ${upstreamPath}:`, error instanceof Error ? error.message : error);
        res.status(502).type("text/plain").send("upstream unavailable");
        return;
      }
    }
  }
  if (!info || !fs.existsSync(file)) {
    res.status(404).type("text/plain").send("not found");
    return;
  }
  if (req.headers["if-none-match"] === info.etag) {
    res.status(304).end();
    return;
  }
  res.setHeader("Content-Type", info.contentType);
  res.setHeader("ETag", info.etag);
  res.setHeader("Cache-Control", `public, max-age=${Math.max(60, Math.min(settings.rulesetIntervalSec, 86400))}`);
  fs.createReadStream(file).pipe(res);
});

/** 渲染设置里 rulesetMirror === "panel" 时要换成的前缀。 */
export function panelRulesetMirrorBase(panelUrl: string): string {
  return `${String(panelUrl || "").replace(/\/+$/, "")}/api/sub/ruleset`;
}
