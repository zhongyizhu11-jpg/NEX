import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { generateInstallScript } from "./agentInstallScripts";
import { APP_VERSION } from "@shared/versions";

/**
 * 装 Agent 时「上一版本」到底是哪一版。
 *
 * 安装脚本把下载地址钉在面板版本上；那一版的资产还没传完时会回退到「上一版本」。
 * 原来这个上一版本是**算出来的**：补丁号减一。它默认每个补丁号都发过版 —— 而攒
 * 十几个版本发一次是常态（v2.3.341 → v2.3.353 中间那些从来没有 release），算出来
 * 的版本根本不存在，回退地址必然 404，装机就地失败且毫无线索。
 *
 * 所以真正要回退时去查仓库里**真正发布过**的最新版本。这一组直接把脚本里那个函数
 * 抠出来在 bash 里跑，curl 用桩替掉 —— 只比字符串等于没有意义，这段逻辑的价值全在
 * 「查得到用查到的、查不到退回猜的、用户指定过谁都别覆盖」这三条分支上。
 */
function runResolver(options: { curlOutput: string; curlExit?: number; preset?: string; githubReachable?: boolean }) {
  const script = generateInstallScript("https://panel.example.com");
  const start = script.indexOf("resolve_fallback_release_version() {");
  const end = script.indexOf("\ndownload_release_binary() {", start);
  assert.notEqual(start, -1, "脚本里应该有 resolve_fallback_release_version");
  assert.notEqual(end, -1);
  const fn = script.slice(start, end);

  const probeStart = script.indexOf("github_reachable() {");
  const probe = script.slice(probeStart, script.indexOf("\n}\n", probeStart) + 2);
  assert.notEqual(probeStart, -1, "脚本里应该有 github_reachable");

  const hintMatch = script.match(/FALLBACK_RELEASE_VERSION_HINT="([^"]*)"/);
  assert.ok(hintMatch, "脚本里应该保留一个猜测值作为最后兜底");

  const harness = [
    "#!/bin/bash",
    `FALLBACK_RELEASE_VERSION="${options.preset ?? ""}"`,
    `FALLBACK_RELEASE_VERSION_HINT="${hintMatch[1]}"`,
    "FALLBACK_RELEASE_RESOLVED=0",
    `GITHUB_REACHABLE="${options.githubReachable === false ? 0 : 1}"`,
    probe,
    "curl() {",
    '  echo "CURL_CALLED" >&2',
    `  cat <<'CURL_STUB_EOF'`,
    options.curlOutput,
    "CURL_STUB_EOF",
    `  return ${options.curlExit ?? 0}`,
    "}",
    fn,
    "resolve_fallback_release_version",
    'echo "RESOLVED=$FALLBACK_RELEASE_VERSION"',
    // 再调一次：应该是幂等的，不该重新查。
    "resolve_fallback_release_version",
    'echo "AGAIN=$FALLBACK_RELEASE_VERSION"',
  ].join("\n");

  const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const resolved = /RESOLVED=(.*)/.exec(result.stdout)?.[1] ?? "";
  const again = /AGAIN=(.*)/.exec(result.stdout)?.[1] ?? "";
  assert.equal(resolved, again, "重复调用不该改变结果");
  return { resolved, hint: hintMatch[1], curlCalled: result.stderr.includes("CURL_CALLED") };
}

test("查得到就用真正发布过的那一版，而不是补丁号减一", () => {
  const { resolved, hint } = runResolver({
    curlOutput: '{"tag_name":"v2.3.340","name":"v2.3.340","draft":false}',
  });
  assert.equal(resolved, "2.3.340");
  assert.notEqual(resolved, hint, "整个改动就是为了不再用那个猜出来的版本号");
});

test("连不上 GitHub 时不去查，直接用猜测值", () => {
  const { resolved, hint, curlCalled } = runResolver({ curlOutput: '{"tag_name":"v2.3.340"}', githubReachable: false });
  assert.equal(resolved, hint);
  assert.equal(curlCalled, false);
});

test("tag 没有 v 前缀也认", () => {
  assert.equal(runResolver({ curlOutput: '{"tag_name":"2.3.340"}' }).resolved, "2.3.340");
});

test("查不到就退回猜测值 —— 网络不通时总比什么兜底都没有强", () => {
  const { resolved, hint } = runResolver({ curlOutput: "", curlExit: 1 });
  assert.equal(resolved, hint);
  assert.ok(hint.length > 0);
});

test("返回的东西认不出来时也退回猜测值，不会解析出半截垃圾", () => {
  const { resolved, hint } = runResolver({ curlOutput: "<html>403 Forbidden</html>" });
  assert.equal(resolved, hint);
});

test("用户显式指定过就听他的，谁都别覆盖", () => {
  assert.equal(
    runResolver({ curlOutput: '{"tag_name":"v2.3.340"}', preset: "2.3.100" }).resolved,
    "2.3.100",
  );
});

test("脚本不再把猜出来的版本直接当兜底用", () => {
  const script = generateInstallScript("https://panel.example.com");
  // 猜测值只能出现在 HINT 那一行；FALLBACK_RELEASE_VERSION 自己必须是空的。
  assert.match(script, /FALLBACK_RELEASE_VERSION="\$\{FALLBACK_RELEASE_VERSION:-\}"/);
  assert.doesNotMatch(script, /FALLBACK_RELEASE_VERSION="\$\{FALLBACK_RELEASE_VERSION:-\d/);
  assert.ok(APP_VERSION.length > 0);
});
