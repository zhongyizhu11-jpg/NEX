import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateInstallScript } from "./agentInstallScripts";
import { AGENT_MANAGEMENT_PROXY_VERSION, agentProxyShellFunctions, fwxmScript } from "./agentManagementShell";

// Agent 管理流量代理 + fwxm（上游 v2.3.284 的 managementProxy.test.ts 思路）：真的用 bash 跑这些函数。

function bash(script: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH || "/usr/bin:/bin", ...env } });
}

function withTempDir<T>(work: (dir: string) => T) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-agent-proxy-"));
  try { return work(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const functions = agentProxyShellFunctions().join("\n");

test("the Go Agent and the panel agree on the version that understands proxyUrl", () => {
  const goSource = fs.readFileSync(path.join(process.cwd(), "agent/management_proxy.go"), "utf8");
  assert.match(goSource, new RegExp(`agentManagementProxyVersion = "${AGENT_MANAGEMENT_PROXY_VERSION.replace(/\./g, "\\.")}"`));
  assert.equal(AGENT_MANAGEMENT_PROXY_VERSION, "2.2.229");
});

test("proxy URLs are validated, socks5 becomes socks5h, and credentials never reach the output", () => {
  const ok = bash(`${functions}\nfwx_proxy_normalize 'socks5://user:p%40ss@10.0.0.1:1080/'; echo; fwx_proxy_normalize 'http://proxy.example:3128'; echo; fwx_proxy_redacted 'socks5h://user:secret@10.0.0.1:1080'; fwx_proxy_redacted ''`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.stdout.trim().split("\n"), ["socks5h://user:p%40ss@10.0.0.1:1080", "http://proxy.example:3128", "socks5h://***@10.0.0.1:1080", "直连（未设置代理）"]);
  for (const bad of ["ftp://h:21", "http://host", "socks5://h:0", "socks5://h:65536", "http://h:80/path", "http://h:80?x=1", "http://u:pa ss@h:80", "socks5://:1080"]) {
    const result = bash(`${functions}\nfwx_proxy_normalize ${JSON.stringify(bad)}`);
    assert.notEqual(result.status, 0, bad);
    assert.doesNotMatch(result.stderr + result.stdout, /pa ss|secret/);
  }
});

test("install/upgrade arguments: explicit proxy wins, upgrades reuse the saved proxy, no proxy leaves the environment alone", () => withTempDir((dir) => {
  const config = path.join(dir, "agent");
  fs.mkdirSync(config);
  const prelude = `${functions}\nCONFIG_DIR=${config}; LEGACY_CONFIG_DIR=${dir}/legacy; GO_AGENT_BIN=${dir}/agent-bin\n`;
  const explicit = bash(`${prelude}fwx_agent_proxy_args install TOKEN1 --proxy socks5://u:p@127.0.0.1:1080 >/dev/null; echo "$ACTION|$TOKEN|$FORWARDX_AGENT_PROXY|$FWX_PROXY_EXPLICIT|$HTTPS_PROXY|$ALL_PROXY|$NO_PROXY"`);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout.trim(), "install|TOKEN1|socks5h://u:p@127.0.0.1:1080|true|socks5h://u:p@127.0.0.1:1080|socks5h://u:p@127.0.0.1:1080|");
  // 参数顺序随意。
  const reordered = bash(`${prelude}fwx_agent_proxy_args --proxy=http://127.0.0.1:3128 upgrade >/dev/null; echo "$ACTION|$TOKEN|$FORWARDX_AGENT_PROXY"`);
  assert.equal(reordered.stdout.trim(), "upgrade||http://127.0.0.1:3128");
  // 没有配置、没给代理：不碰继承来的环境变量（和原来一样）。
  const untouched = bash(`${prelude}fwx_agent_proxy_args upgrade; echo "[$FORWARDX_AGENT_PROXY]|$HTTPS_PROXY"`, { HTTPS_PROXY: "http://inherited:8080" });
  assert.equal(untouched.stdout.trim(), "[]|http://inherited:8080");
  // 配置里有代理：升级沿用它。
  fs.writeFileSync(path.join(config, "config.json"), JSON.stringify({ panelUrl: "https://p", token: "t", proxyUrl: "socks5h://10.1.1.1:1080", custom: 1 }));
  const reuse = bash(`${prelude}fwx_agent_proxy_args upgrade >/dev/null; echo "$FORWARDX_AGENT_PROXY|$FWX_PROXY_EXPLICIT|$http_proxy"`);
  assert.equal(reuse.stdout.trim(), "socks5h://10.1.1.1:1080|false|socks5h://10.1.1.1:1080");
  // 坏掉的代理配置：直接失败，不悄悄改成直连。卸载不受影响。
  fs.writeFileSync(path.join(config, "config.json"), JSON.stringify({ panelUrl: "https://p", proxyUrl: 42 }));
  assert.notEqual(bash(`${prelude}fwx_agent_proxy_args upgrade`).status, 0);
  assert.equal(bash(`${prelude}fwx_agent_proxy_args uninstall`).status, 0);
  assert.notEqual(bash(`${prelude}fwx_agent_proxy_args install T --proxy ftp://x:1`).status, 0);
  assert.notEqual(bash(`${prelude}fwx_agent_proxy_args install T --bogus`).status, 0);
}));

test("saving the proxy keeps other config fields, removes the key for direct and keeps the file private", () => withTempDir((dir) => {
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ panelUrl: "https://p", token: "t", interval: 30, panelMigrationId: "m" }));
  const prelude = `${functions}\nCONFIG_DIR=${dir}\n`;
  assert.equal(bash(`${prelude}FORWARDX_AGENT_PROXY='socks5h://u:p@h:1080' fwx_agent_proxy_save`).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { panelUrl: "https://p", token: "t", interval: 30, panelMigrationId: "m", proxyUrl: "socks5h://u:p@h:1080" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(bash(`${prelude}FORWARDX_AGENT_PROXY='' fwx_agent_proxy_save`).status, 0);
  assert.equal("proxyUrl" in JSON.parse(fs.readFileSync(file, "utf8")), false);
}));

test("old Agent binaries are detected so the installer can warn that management traffic is still direct", () => withTempDir((dir) => {
  const make = (name: string, body: string) => { const file = path.join(dir, name); fs.writeFileSync(file, `#!/bin/bash\n${body}\n`); fs.chmodSync(file, 0o755); return file; };
  const modern = make("modern", 'echo "2.2.229"');
  const newer = make("newer", 'echo "2.2.300"');
  const legacy = make("legacy", 'echo "flag provided but not defined: -version" >&2; exit 2');
  const older = make("older", 'echo "2.2.228"');
  for (const [bin, supported] of [[modern, true], [newer, true], [legacy, false], [older, false]] as const) {
    const result = bash(`${functions}\nGO_AGENT_BIN=${bin}; FORWARDX_AGENT_PROXY=socks5h://h:1; fwx_agent_supports_proxy && echo yes || echo no; fwx_warn_if_proxy_unsupported`);
    assert.equal(result.stdout.split("\n")[0], supported ? "yes" : "no", bin);
    assert.equal(/不支持管理代理/.test(result.stdout), !supported);
  }
  // 没配代理就不提示。
  assert.doesNotMatch(bash(`${functions}\nGO_AGENT_BIN=${legacy}; FORWARDX_AGENT_PROXY=''; fwx_warn_if_proxy_unsupported`).stdout, /不支持/);
}));

test("the generated installer parses --proxy before acting, writes JSON with jq and installs fwxm", () => {
  const script = generateInstallScript("https://panel.example.com");
  const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const entry = script.slice(script.indexOf("# ============ 入口 ============"));
  assert.ok(entry.indexOf('fwx_agent_proxy_args "$@"') < entry.indexOf('case "$ACTION" in'));
  assert.doesNotMatch(script, /cat > "\$CONFIG_DIR\/config\.json" << EOF/, "config.json is no longer assembled with an unquoted heredoc");
  assert.match(script, /jq -n --arg panelUrl "\$PANEL_URL" --arg token "\$AGENT_TOKEN" --arg proxy/);
  const install = script.slice(script.indexOf("do_install() {"), script.indexOf("do_upgrade() {"));
  assert.match(install, /install_management_command/);
  assert.match(install, /fwx_warn_if_proxy_unsupported/);
  const upgrade = script.slice(script.indexOf("do_upgrade() {"), script.indexOf("# ============ 入口 ============"));
  assert.match(upgrade, /FWX_PROXY_EXPLICIT:-false}" = true[\s\S]*fwx_agent_proxy_save/);
  assert.match(upgrade, /install_management_command/);
  assert.match(script, /rm -f \/usr\/local\/bin\/fwxm/);
  assert.match(script, /--proxy URL/);
  // 代理密码不出现在任何 echo 里（只打印打码后的）。
  for (const line of script.split("\n").filter((item) => /echo/.test(item) && item.includes("$FORWARDX_AGENT_PROXY"))) {
    assert.match(line, /fwx_proxy_redacted "\$FORWARDX_AGENT_PROXY"/, line);
  }
  // jq 写配置这一句在真实 bash 里跑一遍。
  withTempDir((dir) => {
    const line = script.split("\n").find((item) => item.includes("jq -n --arg panelUrl"))!;
    const result = bash(`CONFIG_DIR=${dir}; PANEL_URL='https://p"x'; AGENT_TOKEN='t\\\\k'; FORWARDX_AGENT_PROXY=''\n${line}\nFORWARDX_AGENT_PROXY='socks5h://h:1'; CONFIG_DIR=${dir}/b; mkdir -p ${dir}/b\n${line}`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")), { panelUrl: 'https://p"x', token: "t\\\\k", interval: 30 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "b/config.json"), "utf8")).proxyUrl, "socks5h://h:1");
    assert.equal(fs.statSync(path.join(dir, "config.json")).mode & 0o777, 0o600);
  });
});

test("fwxm shows, sets and clears the proxy and restarts only the Agent", { skip: typeof process.getuid === "function" && process.getuid() !== 0 ? "fwxm requires root" : false }, () => withTempDir((dir) => {
  const manage = path.join(dir, "manage");
  const config = path.join(dir, "agent");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(manage); fs.mkdirSync(config); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(manage, "agent-proxy.sh"), functions + "\n");
  fs.writeFileSync(path.join(dir, "fwxm"), fwxmScript(), { mode: 0o755 });
  fs.writeFileSync(path.join(config, "config.json"), JSON.stringify({ panelUrl: "https://panel.example", token: "t" }));
  const log = path.join(dir, "service.log");
  // 服务管理器换成桩：只记下被要求做什么。
  fs.writeFileSync(path.join(bin, "rc-service"), `#!/bin/bash\necho "$*" >> ${log}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/bash\necho "$*" >> ${log}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "agent"), '#!/bin/bash\necho 2.2.229\n', { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, FWXM_MANAGE_DIR: manage, FORWARDX_AGENT_CONFIG_DIR: config, FWXM_AGENT_BIN: path.join(bin, "agent") };
  const run = (...args: string[]) => spawnSync("bash", [path.join(dir, "fwxm"), ...args], { encoding: "utf8", env, input: "" });
  assert.equal(run("proxy", "show").stdout.trim(), "直连（未设置代理）");
  const set = run("proxy", "set", "socks5://user:secret@127.0.0.1:1080");
  assert.equal(set.status, 0, set.stderr);
  assert.doesNotMatch(set.stdout + set.stderr, /secret/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config, "config.json"), "utf8")).proxyUrl, "socks5h://user:secret@127.0.0.1:1080");
  assert.match(fs.readFileSync(log, "utf8"), /restart/);
  assert.equal(run("proxy", "show").stdout.trim(), "socks5h://***@127.0.0.1:1080");
  const info = run("info");
  assert.match(info.stdout, /https:\/\/panel\.example/);
  assert.match(info.stdout, /2\.2\.229/);
  assert.doesNotMatch(info.stdout, /secret/);
  assert.notEqual(run("proxy", "set", "ftp://x:1").status, 0);
  assert.equal(run("proxy", "off").status, 0);
  assert.equal("proxyUrl" in JSON.parse(fs.readFileSync(path.join(config, "config.json"), "utf8")), false);
  // 卸载 / 修复要在终端里确认，没有终端（或没确认）时什么都不做，也不去面板下载安装脚本。
  const uninstall = run("uninstall");
  assert.doesNotMatch(uninstall.stdout, /从面板获取安装脚本/);
}));
