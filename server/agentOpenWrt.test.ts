import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { generateInstallScript } from "./agentInstallScripts";
import { startManagedServiceCmd, writeManagedServiceCmd } from "./agentActionCommands";

/**
 * OpenWrt / iStoreOS 原生安装：busybox + procd，没有 systemd，依赖用 opkg 装。
 * 在 OpenWrt 23.05 的容器里实际装过一遍（依赖、Agent、FXP、realm、gost runtime、procd 开机自启、注册上线、升级、卸载），
 * 这里钉住几处一改就会在 OpenWrt 上坏、而在 Debian 上看不出来的地方。
 */

test("安装脚本认得 OpenWrt：opkg 一个个装依赖，Agent 写成 procd 服务并 enable", () => {
  const script = generateInstallScript("https://panel.example.com");
  assert.match(script, /^is_openwrt\(\) \{\n  \[ -f \/etc\/openwrt_release \] && \[ -f \/etc\/rc\.common \]/m);
  // 依赖：busybox 缺的几样（ss、nohup、timeout、od、install、stat、base64）都得在单子上。
  const deps = /for P in ([^;]+); do\n\s+openwrt_pkg_install/.exec(script);
  assert.ok(deps, "找不到 OpenWrt 的依赖清单");
  for (const pkg of ["bash", "curl", "jq", "ss", "coreutils-nohup", "coreutils-timeout", "coreutils-od", "coreutils-install", "coreutils-stat", "coreutils-base64", "ip-full"]) {
    if (pkg === "bash") continue; // bash 由安装命令前缀先装好（shared/agentInstallCommand.ts）
    assert.ok(deps[1].split(/\s+/).includes(pkg), `OpenWrt 依赖里缺 ${pkg}`);
  }
  assert.match(script, /write_agent_procd_service\n\s+"\/etc\/init\.d\/\$SERVICE_NAME" enable/);
  assert.match(script, /#!\/bin\/sh \/etc\/rc\.common\n# NEX Agent（OpenWrt procd）\nUSE_PROCD=1/);
  assert.match(script, /procd_set_param respawn/);
  const parsed = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test("安装脚本里的 tr 不用字符类：OpenWrt 的 busybox tr 不认，会把字母当成要删的字符", () => {
  const script = generateInstallScript("https://panel.example.com");
  const offenders = script.split("\n").filter((line) => /\btr\b[^|]*\[:(space|upper|lower|alpha|digit|alnum):\]/.test(line));
  assert.deepEqual(offenders, []);
});

test("面板下发的托管服务：OpenWrt 上写 procd 脚本、enable 再重启，排在 OpenRC / SysV 前面", () => {
  const unit = "[Unit]\nDescription=t\n[Service]\nExecStart=/usr/bin/socat TCP-LISTEN:24556,fork TCP:1.1.1.1:80\n";
  const write = writeManagedServiceCmd("forwardx-socat-tcp-24556", unit);
  const openwrtAt = write.indexOf("[ -f /etc/openwrt_release ] && [ -f /etc/rc.common ]");
  const openrcAt = write.indexOf("command -v rc-service");
  assert.ok(openwrtAt > 0 && openwrtAt < openrcAt, "OpenWrt 要排在 OpenRC 前面判断");
  const encoded = write.slice(openwrtAt).match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/);
  assert.ok(encoded, "找不到 procd 脚本");
  const procd = Buffer.from(encoded[1], "base64").toString("utf8");
  assert.match(procd, /^#!\/bin\/sh \/etc\/rc\.common\n/);
  assert.match(procd, /USE_PROCD=1/);
  assert.match(procd, /exec \/usr\/bin\/socat TCP-LISTEN:24556,fork TCP:1\.1\.1\.1:80 >> \/var\/log\/forwardx-agent\/forwardx-socat-tcp-24556\.log 2>&1/);
  assert.equal(spawnSync("sh", ["-n"], { input: procd, encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("sh", ["-n", "-c", write], { encoding: "utf8" }).status, 0);

  const start = startManagedServiceCmd("forwardx-socat-tcp-24556");
  assert.match(start, /\[ -f \/etc\/openwrt_release \] && \[ -f \/etc\/rc\.common \] && \[ -x \/etc\/init\.d\/forwardx-socat-tcp-24556 \]; then \/etc\/init\.d\/forwardx-socat-tcp-24556 enable >\/dev\/null 2>&1 \|\| true; \/etc\/init\.d\/forwardx-socat-tcp-24556 restart;/);
  assert.ok(start.indexOf("openwrt_release") < start.indexOf("command -v rc-service"));
});

test("Docker 版（FORWARDX_AGENT_CONTAINER=1）：不跑包管理器、不写系统服务，升级后结束旧进程让入口循环重启", () => {
  const script = generateInstallScript("https://panel.example.com");
  assert.match(script, /^is_container_agent\(\) \{\n  \[ "\$\{FORWARDX_AGENT_CONTAINER:-\}" = "1" \]/m);
  const deps = script.slice(script.indexOf("install_deps() {"));
  assert.ok(deps.indexOf("if is_container_agent; then") < deps.indexOf("apt-get update"), "容器里不该再跑 apt-get");
  const write = script.slice(script.indexOf("write_agent_service() {"));
  assert.match(write, /^write_agent_service\(\) \{\n  mkdir -p \/var\/log\/forwardx-agent\n  if is_container_agent; then\n[^\n]*\n    return 0/);
  const start = script.slice(script.indexOf("start_agent_service() {"));
  assert.match(start, /^start_agent_service\(\) \{\n  if is_container_agent; then\n[^\n]*\n    for pid in \$\(pgrep -f "\^\$GO_AGENT_BIN -config"/);
});
