import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_ASSET_CACHE_MAX_VERSIONS,
  AGENT_ASSET_RECENT_RELEASES,
  clearAgentAssetMissCacheForTests,
  getOrFetchAgentAssetPath,
  isAgentAssetVersionFetchable,
  pruneAgentAssetCache,
} from "./agentAssets";
import { AGENT_VERSION, APP_VERSION } from "../shared/versions";

/*
  Agent 二进制中转（P1-2）：只替当前和最近几个版本去 GitHub 下、下不到记负缓存、
  按发布页 SHA256SUMS 校验、缓存目录有上限。
*/

const [major, minor, patch] = APP_VERSION.split(".").map(Number);
const recent = (back: number) => `${major}.${minor}.${patch - back}`;
const ASSET = "forwardx-agent-linux-amd64";
const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("fake agent binary")]);
const sha = crypto.createHash("sha256").update(elf).digest("hex");

function inTempDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const cwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-agent-assets-"));
    process.chdir(dir);
    clearAgentAssetMissCacheForTests();
    try {
      await fn(dir);
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

type Route = { status: number; body?: Buffer | string } | Error;
function fakeFetch(routes: (url: string) => Route, calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    const route = routes(url);
    if (route instanceof Error) throw route;
    const body = Buffer.from(route.body ?? "");
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      statusText: "",
      headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? String(body.length) : null) },
      body: (async function* () { yield new Uint8Array(body); })(),
      text: async () => body.toString("utf8"),
    };
  };
}

test("只替当前和最近几个版本去下；太老的不碰 GitHub", inTempDir(async () => {
  assert.equal(isAgentAssetVersionFetchable(APP_VERSION), true);
  assert.equal(isAgentAssetVersionFetchable(AGENT_VERSION), true, "Agent 版本号和面板不同，也要能取");
  assert.equal(isAgentAssetVersionFetchable(recent(1)), true, "装机脚本会回退到上一个发布版本");
  assert.equal(isAgentAssetVersionFetchable(recent(AGENT_ASSET_RECENT_RELEASES)), true);
  assert.equal(isAgentAssetVersionFetchable(recent(AGENT_ASSET_RECENT_RELEASES + 1)), false);
  assert.equal(isAgentAssetVersionFetchable(`${major}.${minor}.${patch + 3}`), true, "面板没升级时脚本可能取更新的版本");
  assert.equal(isAgentAssetVersionFetchable("1.0.0"), false);
  const calls: string[] = [];
  assert.equal(await getOrFetchAgentAssetPath("1.0.0", ASSET, fakeFetch(() => ({ status: 200, body: elf }), calls) as any), null);
  assert.equal(calls.length, 0);
}));

test("哈希对得上才缓存；对不上不存，并记负缓存", inTempDir(async (dir) => {
  const calls: string[] = [];
  const version = recent(1);
  const good = fakeFetch((url) => (url.endsWith("/SHA256SUMS") ? { status: 200, body: `${sha}  ${ASSET}\n` } : { status: 200, body: elf }), calls);
  const cached = await getOrFetchAgentAssetPath(version, ASSET, good as any);
  assert.equal(cached, path.join(fs.realpathSync(dir), "data", "agent-assets", `v${version}`, ASSET));
  assert.deepEqual(fs.readFileSync(cached!), elf);

  const bad = recent(2);
  calls.length = 0;
  const tampered = fakeFetch((url) => (url.endsWith("/SHA256SUMS") ? { status: 200, body: `${"0".repeat(64)}  ${ASSET}\n` } : { status: 200, body: elf }), calls);
  assert.equal(await getOrFetchAgentAssetPath(bad, ASSET, tampered as any), null);
  assert.equal(fs.existsSync(path.join(dir, "data", "agent-assets", `v${bad}`, ASSET)), false);
  assert.ok(calls.length > 0);
  // 负缓存：几分钟内不再去 GitHub。
  calls.length = 0;
  assert.equal(await getOrFetchAgentAssetPath(bad, ASSET, good as any), null);
  assert.equal(calls.length, 0);
}));

test("SHA256SUMS 取不到时不缓存；发布页根本没有这个文件（老版本）时照旧缓存", inTempDir(async (dir) => {
  const calls: string[] = [];
  const offline = recent(3);
  const flaky = fakeFetch((url) => (url.endsWith("/SHA256SUMS") ? new Error("ECONNRESET") : { status: 200, body: elf }), calls);
  assert.equal(await getOrFetchAgentAssetPath(offline, ASSET, flaky as any), null);
  assert.equal(fs.existsSync(path.join(dir, "data", "agent-assets", `v${offline}`, ASSET)), false);

  const legacy = recent(4);
  const noSums = fakeFetch((url) => (url.endsWith("/SHA256SUMS") ? { status: 404 } : { status: 200, body: elf }), calls);
  assert.ok(await getOrFetchAgentAssetPath(legacy, ASSET, noSums as any));
}));

test("缓存目录最多留几个版本，删最旧的，当前版本不删", inTempDir(async (dir) => {
  const root = path.join(dir, "data", "agent-assets");
  const versions = Array.from({ length: AGENT_ASSET_CACHE_MAX_VERSIONS + 3 }, (_, index) => `1.0.${index}`);
  const now = Date.now() / 1000;
  versions.forEach((version, index) => {
    fs.mkdirSync(path.join(root, `v${version}`), { recursive: true });
    fs.utimesSync(path.join(root, `v${version}`), now - 1000 + index, now - 1000 + index);
  });
  // 当前版本的目录最旧，也不能删。
  fs.mkdirSync(path.join(root, `v${APP_VERSION}`), { recursive: true });
  fs.utimesSync(path.join(root, `v${APP_VERSION}`), now - 5000, now - 5000);
  const removed = await pruneAgentAssetCache(versions[versions.length - 1]);
  const left = fs.readdirSync(root).sort();
  assert.equal(left.length, AGENT_ASSET_CACHE_MAX_VERSIONS, left.join(","));
  assert.ok(left.includes(`v${APP_VERSION}`));
  assert.ok(left.includes(`v${versions[versions.length - 1]}`));
  assert.ok(removed.includes("v1.0.0"));
}));
