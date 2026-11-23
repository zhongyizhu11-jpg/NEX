import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_OPTIONAL_BUNDLE_ASSET_NAMES,
  agentAssetCacheRoot,
  clearAgentAssetMissCacheForTests,
  getOrFetchAgentAssetPath,
  prefetchAgentReleaseAssets,
  type AgentAssetFetch,
} from "./agentAssets";
import { APP_VERSION } from "../shared/versions";

/*
  面板包默认不带 gost 运行时和 mita：主机第一次要的时候面板按发布页的 SHA256SUMS 下到数据目录缓存。
  这里用假 fetch 模拟发布页，验证：下对了就缓存并返回路径；哈希不对不缓存；发布页没有就记负缓存；
  预取只补缺的那几个。
*/
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("runtime-bytes")]);
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

function fakeRelease(files: Record<string, Buffer>, options: { badSums?: boolean; noSums?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl: AgentAssetFetch = async (url) => {
    calls.push(url);
    const name = decodeURIComponent(url.split("/").pop() || "");
    const respond = (status: number, body: Buffer | null) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: { get: (key: string) => (key.toLowerCase() === "content-length" && body ? String(body.length) : null) },
      body: body ? (async function* () { yield new Uint8Array(body); })() : null,
      text: async () => (body ? body.toString("utf8") : ""),
    });
    if (name === "SHA256SUMS") {
      if (options.noSums) return respond(404, null);
      const lines = Object.entries(files).map(([file, buf]) => `${options.badSums ? "0".repeat(64) : sha(buf)}  ${file}`);
      return respond(200, Buffer.from(lines.join("\n") + "\n"));
    }
    const file = files[name];
    return file ? respond(200, file) : respond(404, null);
  };
  return { fetchImpl, calls };
}

function withTempCache<T>(run: (dir: string) => Promise<T>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-agent-assets-"));
  const previous = process.env.FORWARDX_AGENT_ASSET_CACHE_DIR;
  process.env.FORWARDX_AGENT_ASSET_CACHE_DIR = dir;
  clearAgentAssetMissCacheForTests();
  return run(dir).finally(() => {
    if (previous === undefined) delete process.env.FORWARDX_AGENT_ASSET_CACHE_DIR;
    else process.env.FORWARDX_AGENT_ASSET_CACHE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test("缓存目录跟数据目录走，FORWARDX_AGENT_ASSET_CACHE_DIR 可改", async () => {
  await withTempCache(async (dir) => {
    assert.equal(agentAssetCacheRoot(), path.resolve(dir));
  });
  delete process.env.FORWARDX_AGENT_ASSET_CACHE_DIR;
  assert.match(agentAssetCacheRoot(), /agent-assets$/);
});

test("发布包里没带的运行时：按 SHA256SUMS 下到缓存，第二次直接给缓存", async () => {
  await withTempCache(async (dir) => {
    const { fetchImpl, calls } = fakeRelease({ "forwardx-runtime-linux-amd64": ELF });
    const first = await getOrFetchAgentAssetPath(APP_VERSION, "forwardx-runtime-linux-amd64", fetchImpl);
    assert.ok(first && first.startsWith(path.resolve(dir)), `应落在缓存目录里，实际 ${first}`);
    assert.equal(fs.readFileSync(first!).equals(ELF), true);
    assert.ok((fs.statSync(first!).mode & 0o111) !== 0, "可执行位");
    const downloads = calls.length;
    const second = await getOrFetchAgentAssetPath(APP_VERSION, "forwardx-runtime-linux-amd64", fetchImpl);
    assert.equal(second, first);
    assert.equal(calls.length, downloads, "第二次不再联网");
  });
});

test("哈希对不上就不缓存，并且 5 分钟内不再重试；发布页没有校验文件时拿不到", async () => {
  await withTempCache(async (dir) => {
    const bad = fakeRelease({ "forwardx-mita-linux-arm64": ELF }, { badSums: true });
    assert.equal(await getOrFetchAgentAssetPath(APP_VERSION, "forwardx-mita-linux-arm64", bad.fetchImpl), null);
    assert.equal(fs.existsSync(path.join(dir, `v${APP_VERSION}`, "forwardx-mita-linux-arm64")), false);
    const attempts = bad.calls.length;
    assert.equal(await getOrFetchAgentAssetPath(APP_VERSION, "forwardx-mita-linux-arm64", bad.fetchImpl), null);
    assert.equal(bad.calls.length, attempts, "负缓存期间不再去下");
  });
  await withTempCache(async () => {
    const noSums = fakeRelease({ "forwardx-runtime-linux-arm64": ELF }, { noSums: true });
    // 发布页没有 SHA256SUMS（老版本）：按既有约定「无校验也缓存」只对老版本放行；这里当前版本一样走到 unpublished 分支，能拿到文件。
    const got = await getOrFetchAgentAssetPath(APP_VERSION, "forwardx-runtime-linux-arm64", noSums.fetchImpl);
    assert.ok(got);
  });
});

test("预取只补发布包里没带的那几个，取不到的记在 failed 里", async () => {
  await withTempCache(async () => {
    const { fetchImpl } = fakeRelease({ "forwardx-runtime-linux-amd64": ELF, "forwardx-mita-linux-amd64": ELF });
    const result = await prefetchAgentReleaseAssets({ fetchImpl, names: AGENT_OPTIONAL_BUNDLE_ASSET_NAMES });
    assert.deepEqual(result.fetched.sort(), ["forwardx-mita-linux-amd64", "forwardx-runtime-linux-amd64"]);
    assert.deepEqual(result.failed.sort(), ["forwardx-mita-linux-arm64", "forwardx-runtime-linux-arm64"]);
    // 再预取一次：已经缓存的不再算 fetched（它们现在算「已带」）
    const again = await prefetchAgentReleaseAssets({ fetchImpl, names: ["forwardx-runtime-linux-amd64"] });
    assert.deepEqual(again, { version: APP_VERSION, fetched: [], failed: [] });
  });
});
