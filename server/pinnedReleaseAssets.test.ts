import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPinnedReleaseAssetStore } from "./pinnedReleaseAssets";
import { getOrFetchRealmAssetPath } from "./realmAssets";
import { REALM_RELEASE_SHA256, realmReleaseSha256 } from "../shared/realmAssets";

const content = Buffer.from("realm tarball");
const sha = crypto.createHash("sha256").update(content).digest("hex");

function inTempDir<T>(fn: (dir: string) => Promise<T>) {
  return async () => {
    const cwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-pinned-"));
    process.chdir(dir);
    try {
      return await fn(dir);
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const okFetch = (body: Buffer, calls: string[]) => async (url: string) => {
  calls.push(url);
  return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(body).buffer };
};

test("哈希对得上才缓存，之后直接用缓存不再去 GitHub", inTempDir(async (dir) => {
  const store = createPinnedReleaseAssetStore({
    label: "Test", repo: "o/r", cacheDir: "test-assets", maxBytes: 1024,
    sha256: (version, asset) => (version === "1.2.3" && asset === "a.tar.gz" ? sha : null),
  });
  const calls: string[] = [];
  const first = await store.getOrFetch("v1.2.3", "a.tar.gz", okFetch(content, calls));
  assert.equal(first, path.join(fs.realpathSync(dir), "data/test-assets/v1.2.3/a.tar.gz"));
  assert.deepEqual(fs.readFileSync(first!), content);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/github\.com\/o\/r\/releases\/download\/v1\.2\.3\/a\.tar\.gz$/);
  assert.equal(await store.getOrFetch("1.2.3", "a.tar.gz", okFetch(content, calls)), first);
  assert.equal(calls.length, 1, "第二次应该走缓存");
}));

test("内容哈希不对不存，没钉哈希的包名不去下", inTempDir(async (dir) => {
  const store = createPinnedReleaseAssetStore({
    label: "Test", repo: "o/r", cacheDir: "test-assets", maxBytes: 1024,
    sha256: (_version, asset) => (asset === "a.tar.gz" ? sha : null),
  });
  const calls: string[] = [];
  assert.equal(await store.getOrFetch("1.2.3", "a.tar.gz", okFetch(Buffer.from("tampered"), calls)), null);
  assert.equal(fs.existsSync(path.join(dir, "data/test-assets/v1.2.3/a.tar.gz")), false);
  calls.length = 0;
  assert.equal(await store.getOrFetch("1.2.3", "other.tar.gz", okFetch(content, calls)), null);
  assert.equal(calls.length, 0);
}));

test("realm 只转发钉了哈希的 v2.9.4 四个包", inTempDir(async () => {
  assert.deepEqual(Object.keys(REALM_RELEASE_SHA256["2.9.4"]).sort(), [
    "realm-aarch64-unknown-linux-gnu.tar.gz",
    "realm-aarch64-unknown-linux-musl.tar.gz",
    "realm-x86_64-unknown-linux-gnu.tar.gz",
    "realm-x86_64-unknown-linux-musl.tar.gz",
  ]);
  for (const hash of Object.values(REALM_RELEASE_SHA256["2.9.4"])) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(realmReleaseSha256("v2.9.4", "realm-x86_64-unknown-linux-gnu.tar.gz"));
  const calls: string[] = [];
  assert.equal(await getOrFetchRealmAssetPath("2.9.4", "../../etc/passwd", okFetch(content, calls)), null);
  assert.equal(await getOrFetchRealmAssetPath("2.9.4", "realm-x86_64-unknown-linux-gnu.tar.gz", okFetch(content, calls)), null, "内容不对");
  assert.equal(calls.length, 1);
}));
