import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  AGENT_INSTALL_SCRIPT_RAW_URL,
  AGENT_DOCKER_IMAGE,
  AGENT_OPENWRT_BOOTSTRAP,
  buildAgentDockerCommand,
  buildAgentScriptCommand,
  normalizeAgentCommandUrl,
  shellQuoteSingle,
} from "./agentInstallCommand";

test("默认先走 GitHub 脚本，失败再回落面板自带的那份", () => {
  const command = buildAgentScriptCommand({
    panelUrl: "https://panel.example.com",
    action: "install",
    token: "tok123",
  });
  const github = command.indexOf(AGENT_INSTALL_SCRIPT_RAW_URL);
  const panel = command.indexOf("/api/agent/install.sh");
  assert.ok(github >= 0 && panel >= 0);
  assert.ok(github < panel, "GitHub 那条应该排在前面");
  assert.equal(command.split(" || ").length, 2);
  assert.ok(command.includes("install '\\''tok123'\\''"), command);
});

test("preferPanelInstall 把顺序倒过来，并带上 FORWARDX_AGENT_PANEL_FIRST", () => {
  const command = buildAgentScriptCommand({
    panelUrl: "https://panel.example.com",
    action: "install",
    token: "tok123",
    preferPanelInstall: true,
  });
  assert.ok(command.indexOf("/api/agent/install.sh") < command.indexOf(AGENT_INSTALL_SCRIPT_RAW_URL));
  assert.ok(command.includes("FORWARDX_AGENT_PANEL_FIRST=true"));
});

test("加速器是拼在原始地址前面的前缀，不是替换", () => {
  const command = buildAgentScriptCommand({
    panelUrl: "https://panel.example.com",
    action: "install",
    token: "tok123",
    githubAcceleratorEnabled: true,
    githubAcceleratorUrl: "https://gh.mirror.example/",
  });
  assert.ok(command.includes(`https://gh.mirror.example/${AGENT_INSTALL_SCRIPT_RAW_URL}`));
  assert.ok(command.includes("GITHUB_ACCELERATOR_ENABLED=true"));
  // 整条管线又被 bash -c 的单引号裹了一层，所以里面的单引号是 '\'' 这种转义形态。
  assert.ok(command.includes("GITHUB_ACCELERATOR_URL='\\''https://gh.mirror.example'\\''"));
});

test("开了加速但没填地址，等于没开", () => {
  const command = buildAgentScriptCommand({
    panelUrl: "https://panel.example.com",
    action: "install",
    token: "tok123",
    githubAcceleratorEnabled: true,
    githubAcceleratorUrl: "   ",
  });
  assert.ok(!command.includes("GITHUB_ACCELERATOR_ENABLED"));
  assert.ok(command.includes(`"${AGENT_INSTALL_SCRIPT_RAW_URL}"`));
});

test("每条管线都套 set -o pipefail：curl 失败时不能整条命令还返回成功", () => {
  const command = buildAgentScriptCommand({
    panelUrl: "https://panel.example.com",
    action: "upgrade",
  });
  const occurrences = command.split("set -o pipefail;").length - 1;
  assert.equal(occurrences, 2, "两条管线各要一层");
});

test("uninstall / upgrade 不带 token", () => {
  for (const action of ["uninstall", "upgrade"] as const) {
    const command = buildAgentScriptCommand({ panelUrl: "https://panel.example.com", action, token: "tok123" });
    assert.ok(!command.includes("tok123"));
    assert.ok(command.includes(`-s -- ${action}`));
  }
});

test("面板地址的尾斜杠去掉，不然拼出双斜杠", () => {
  const command = buildAgentScriptCommand({
    panelUrl: "https://panel.example.com///",
    action: "install",
    token: "t",
  });
  assert.ok(command.includes("https://panel.example.com/api/agent/install.sh"));
  assert.ok(!command.includes("com//api"));
});

test("单引号按 shell 的办法断开，不能让引号跑出去", () => {
  assert.equal(shellQuoteSingle("a'b"), "'a'\\''b'");
  assert.equal(normalizeAgentCommandUrl(" https://x.example/// "), "https://x.example");
});

/**
 * 引号拼错的话，命令粘进 SSH 才会炸，而那时人已经在陌生机器上了。
 * 用真的 bash 做一次语法检查（-n 只解析不执行），带上会把引号拼坏的输入。
 */
test("带引号的输入拼出来的命令，bash 能解析", () => {
  const command = buildAgentScriptCommand({
    panelUrl: "https://panel.example.com",
    action: "install",
    token: "tok'; rm -rf /tmp/nope; echo '",
    githubAcceleratorEnabled: true,
    githubAcceleratorUrl: "https://gh.mirror.example/o'quote",
  });
  const result = spawnSync("bash", ["-n", "-c", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

/**
 * 光看字符串看不出引号对不对 —— 让真的 bash 把外层那一层拆开：把开头的
 * `bash -c` 换成 `printf %s`，跑出来的就是它实际会执行的那条管线。带引号的
 * token 必须原样落在里面，而不是提前结束引号、后半截变成另一条命令。
 */
test("外层引号经真 bash 拆开后，token 原样落在管线里", () => {
  const token = "tok'; rm -rf /tmp/nope; echo '";
  const command = buildAgentScriptCommand({
    panelUrl: "https://panel.example.com",
    action: "install",
    token,
  });
  const firstPipelineCommand = command.split(" || ")[0].replace(/^bash -c /, "printf %s ");
  const result = spawnSync("bash", ["-c", firstPipelineCommand], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.includes(`install ${shellQuoteSingle(token)}`),
    `管线里应带上引好的 token，实际是：${result.stdout}`,
  );
});

/**
 * OpenWrt 上登录 shell 是 busybox ash，没有 bash 和 curl：命令最前面先补上。
 * 前缀本身要在 sh（dash，和 ash 一样是 POSIX sh）里能解析，别的系统上什么都不做。
 */
test("OpenWrt 版：前面补 bash、curl，sh 能解析，没有 openwrt_release 时什么都不做；普通命令不带", () => {
  const plain = buildAgentScriptCommand({ panelUrl: "https://panel.example.com", action: "install", token: "tok" });
  assert.ok(plain.startsWith("bash -c "), "普通命令不带 OpenWrt 前缀");
  const command = buildAgentScriptCommand({ panelUrl: "https://panel.example.com", action: "install", token: "tok", openwrt: true });
  assert.equal(command, AGENT_OPENWRT_BOOTSTRAP + plain);
  assert.ok(!AGENT_OPENWRT_BOOTSTRAP.includes(" || "), "前缀里不能有 \" || \"，两条管线靠它分隔");
  const parse = spawnSync("sh", ["-n", "-c", command], { encoding: "utf8" });
  assert.equal(parse.status, 0, parse.stderr);
  const run = spawnSync("sh", ["-c", `${AGENT_OPENWRT_BOOTSTRAP}echo done`], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "done");
});

test("Docker 版：宿主机网络、配置挂卷、面板地址和 Token 引好，bash 能解析", () => {
  const command = buildAgentDockerCommand({ panelUrl: "https://panel.example.com/", token: "tok'x" });
  assert.ok(command.startsWith("docker run -d --name nex-agent --network host"));
  assert.ok(command.includes("-v nex-agent:/etc/forwardx"));
  assert.ok(command.includes("-e PANEL_URL='https://panel.example.com'"));
  assert.ok(command.includes(`-e AGENT_TOKEN=${shellQuoteSingle("tok'x")}`));
  assert.ok(command.endsWith(AGENT_DOCKER_IMAGE));
  const parsed = spawnSync("bash", ["-n", "-c", command], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
});
