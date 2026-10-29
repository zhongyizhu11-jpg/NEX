import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateInstallScript } from "./agentInstallScripts";
import { parseSha256Sums } from "./agentAssets";

/** 从生成的脚本里抠出一个 bash 函数的完整定义。 */
function shellFunction(script: string, name: string) {
  const start = script.indexOf(`${name}() {`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = script.indexOf("\n}\n", start);
  return script.slice(start, end + 3);
}

test("downloaded agent binaries are verified against the release SHA-256", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-install-checksum-"));
  try {
    const good = path.join(directory, "agent");
    fs.writeFileSync(good, "real agent binary");
    const hash = createHash("sha256").update("real agent binary").digest("hex");
    const script = generateInstallScript("https://panel.example", {
      releaseChecksums: { "9.9.9": { "forwardx-agent-linux-amd64": hash } },
    });
    const prelude = [
      "FORWARDX_CURL_CONNECT_TIMEOUT=1",
      shellFunction(script, "is_enabled_value"),
      shellFunction(script, "expected_release_sha256"),
      shellFunction(script, "file_sha256"),
      shellFunction(script, "verify_release_checksum"),
      // 测试里不让它真去连 GitHub。
      "curl() { return 1; }",
    ].join("\n");
    const run = (body: string, env: Record<string, string> = {}) => spawnSync("bash", ["-c", `${prelude}\n${body}`], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

    const ok = run(`verify_release_checksum forwardx-agent-linux-amd64 ${good} 9.9.9 "Go Agent"`);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /校验通过/);

    const tampered = path.join(directory, "tampered");
    fs.writeFileSync(tampered, "evil binary");
    const bad = run(`verify_release_checksum forwardx-agent-linux-amd64 ${tampered} 9.9.9 "Go Agent"`);
    assert.equal(bad.status, 1, "a replaced binary must fail the install");
    assert.equal(fs.existsSync(tampered), false, "the replaced binary must be deleted");

    const unknown = path.join(directory, "unknown");
    fs.writeFileSync(unknown, "x");
    const warn = run(`verify_release_checksum forwardx-agent-linux-amd64 ${unknown} 1.0.0 "Go Agent"`);
    assert.equal(warn.status, 0, "no checksum available: warn and continue by default");
    assert.match(warn.stdout, /跳过校验/);
    const strict = run(`verify_release_checksum forwardx-agent-linux-amd64 ${unknown} 1.0.0 "Go Agent"`, { FORWARDX_REQUIRE_CHECKSUM: "1" });
    assert.equal(strict.status, 1, "FORWARDX_REQUIRE_CHECKSUM=1 must refuse unverifiable binaries");

    assert.equal(spawnSync("bash", ["-n"], { input: script }).status, 0, "the generated script must stay valid bash");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a binary from either trusted build passes: panel-bundled hash or GitHub SHA256SUMS", () => {
  /*
    2.3.391 实际发生的情况：面板自带的 Agent 和 GitHub 发布页上的是两次构建，哈希不同，
    脚本只嵌了面板那份，从 GitHub / 加速镜像下载的主机全部校验失败、升级卡住。
    另外发布页 SHA256SUMS 里写的是 CI 机器上的绝对路径，按资产名比对永远对不上。
  */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-install-checksum-multi-"));
  try {
    const panelBuild = path.join(directory, "panel-build");
    const githubBuild = path.join(directory, "github-build");
    fs.writeFileSync(panelBuild, "agent built with the panel");
    fs.writeFileSync(githubBuild, "agent built by the release workflow");
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const panelHash = sha("agent built with the panel");
    const githubHash = sha("agent built by the release workflow");
    const scriptWith = (sums: Record<string, string | string[]>) => generateInstallScript("http://panel.example", {
      releaseChecksums: { "9.9.9": sums },
    });
    const prelude = (script: string, curlBody: string) => [
      "FORWARDX_CURL_CONNECT_TIMEOUT=1",
      shellFunction(script, "is_enabled_value"),
      shellFunction(script, "expected_release_sha256"),
      shellFunction(script, "file_sha256"),
      shellFunction(script, "verify_release_checksum"),
      // 当作 GitHub 通：这一组要的是 SHA256SUMS 那条路。
      "GITHUB_REACHABLE=1",
      shellFunction(script, "github_reachable"),
      `curl() { ${curlBody}; }`,
    ].join("\n");
    const run = (script: string, curlBody: string, body: string) => spawnSync("bash", ["-c", `${prelude(script, curlBody)}\n${body}`], { encoding: "utf8" });

    // 面板把两份哈希都嵌进来：两份构建都能过，被换的不行。
    const both = scriptWith({ "forwardx-agent-linux-amd64": [panelHash, githubHash] });
    const offline = "return 1";
    assert.equal(run(both, offline, `verify_release_checksum forwardx-agent-linux-amd64 ${panelBuild} 9.9.9 A`).status, 0);
    assert.equal(run(both, offline, `verify_release_checksum forwardx-agent-linux-amd64 ${githubBuild} 9.9.9 A`).status, 0);
    const evil = path.join(directory, "evil");
    fs.writeFileSync(evil, "evil");
    assert.equal(run(both, offline, `verify_release_checksum forwardx-agent-linux-amd64 ${evil} 9.9.9 A`).status, 1);

    // 面板只嵌了自己那份（连不上 GitHub）：主机再按发布页 SHA256SUMS 比一次，绝对路径也认。
    const panelOnly = scriptWith({ "forwardx-agent-linux-amd64": panelHash });
    const sumsWithPaths = `${githubHash}  /home/runner/work/Forwardx/Forwardx/dist/agent/forwardx-agent-linux-amd64`;
    const githubCurl = `printf '%s\\n' '${sumsWithPaths}'`;
    const fromGithub = run(panelOnly, githubCurl, `verify_release_checksum forwardx-agent-linux-amd64 ${githubBuild} 9.9.9 A`);
    assert.equal(fromGithub.status, 0, fromGithub.stdout + fromGithub.stderr);
    fs.writeFileSync(evil, "evil");
    assert.equal(run(panelOnly, githubCurl, `verify_release_checksum forwardx-agent-linux-amd64 ${evil} 9.9.9 A`).status, 1);
    assert.equal(spawnSync("bash", ["-n"], { input: both }).status, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SHA256SUMS written with CI absolute paths still maps to asset names", () => {
  const sums = parseSha256Sums(`${"d".repeat(64)}  /home/runner/work/Forwardx/Forwardx/dist/agent/forwardx-agent-linux-amd64`);
  assert.deepEqual(sums, { "forwardx-agent-linux-amd64": "d".repeat(64) });
});

test("SHA256SUMS parsing keeps only known agent assets", () => {
  const sums = parseSha256Sums([
    `${"a".repeat(64)}  forwardx-agent-linux-amd64`,
    `${"b".repeat(64)} *forwardx-fxp-linux-arm64`,
    `${"c".repeat(64)}  forwardx-panel-v1.tar.gz`,
    "garbage",
  ].join("\n"));
  assert.deepEqual(sums, {
    "forwardx-agent-linux-amd64": "a".repeat(64),
    "forwardx-fxp-linux-arm64": "b".repeat(64),
  });
});

test("升级前先看装着的：哈希和这一版一致就不再下载，不一致照常下载", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-install-reuse-"));
  try {
    const installed = path.join(directory, "forwardx-agent");
    fs.writeFileSync(installed, "agent v9.9.9");
    const hash = createHash("sha256").update("agent v9.9.9").digest("hex");
    const script = generateInstallScript("https://panel.example", {
      releaseChecksums: { "9.9.9": { "forwardx-agent-linux-amd64": hash } },
    });
    const prelude = [
      shellFunction(script, "expected_release_sha256"),
      shellFunction(script, "file_sha256"),
      shellFunction(script, "installed_binary_matches_release"),
      shellFunction(script, "stage_release_binary"),
      // 真下载时留个记号，看有没有走到。
      `download_release_binary_with_retry() { echo DOWNLOADED; printf 'fresh' > "$2"; return 0; }`,
    ].join("\n");
    const run = (body: string) => spawnSync("bash", ["-c", `${prelude}\n${body}`], { encoding: "utf8" });

    const same = run(`RELEASE_VERSION=9.9.9; stage_release_binary forwardx-agent-linux-amd64 ${installed} "Go Agent" 0 && echo "v=$DOWNLOADED_RELEASE_VERSION"`);
    assert.equal(same.status, 0, same.stdout + same.stderr);
    assert.match(same.stdout, /已是 v9\.9\.9（校验一致），跳过下载/);
    assert.doesNotMatch(same.stdout, /DOWNLOADED/);
    assert.match(same.stdout, /v=9\.9\.9/);
    assert.equal(fs.readFileSync(`${installed}.forwardx-new`, "utf8"), "agent v9.9.9", "拿装着的那份当新文件");

    const newer = run(`RELEASE_VERSION=9.9.10; stage_release_binary forwardx-agent-linux-amd64 ${installed} "Go Agent" 0`);
    assert.equal(newer.status, 0);
    assert.match(newer.stdout, /DOWNLOADED/, "目标版本没有嵌进来的哈希：照常下载");

    fs.writeFileSync(installed, "tampered");
    const changed = run(`RELEASE_VERSION=9.9.9; stage_release_binary forwardx-agent-linux-amd64 ${installed} "Go Agent" 0`);
    assert.match(changed.stdout, /DOWNLOADED/, "装着的被改过：照常下载");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
