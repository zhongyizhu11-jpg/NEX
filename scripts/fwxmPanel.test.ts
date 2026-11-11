import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fwxmScript } from "../server/agentManagementShell";

/*
  面板这一侧的 fwxm：两个面板安装脚本里的 install_panel_manager / remove_panel_manager，
  scripts/fwxm-panel.sh 本身，和 Agent 的 fwxm 把 `fwxm panel …` 交过去。
  真的跑 bash，只是把 /usr/local、/etc 换成临时目录。
*/
const root = path.resolve(import.meta.dirname, "..");

function extractFunctions(file: string, names: string[]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  return names.map((name) => {
    const start = source.indexOf(`\n${name}() {\n`);
    assert.ok(start >= 0, `${file} 里找不到 ${name}`);
    const end = source.indexOf("\n}\n", start);
    return source.slice(start + 1, end + 3);
  }).join("\n");
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-fwxm-"));
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app", ".env"), "PORT=9911\nFORWARDX_GITHUB_ACCELERATOR_URL=\n");
  fs.writeFileSync(path.join(dir, "app", "package.json"), '{\n  "name": "forwardx",\n  "version": "2.3.525"\n}\n');
  return dir;
}

function run(script: string, env: Record<string, string> = {}, args: string[] = []) {
  return spawnSync("bash", ["-c", script, "bash", ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 });
}

function installerPrelude(file: string, dir: string, mode: "local" | "docker") {
  return [
    "set -euo pipefail",
    `APP_DIR=${JSON.stringify(path.join(dir, "app"))}`,
    'SERVICE_NAME="forwardx-panel"',
    'CONTAINER_NAME="forwardx-panel"',
    'REPO_SLUG="zhongyizhu11-jpg/NEX"',
    // 安装脚本里这几个路径是常量，测试里换到临时目录
    extractFunctions(file, ["install_panel_manager", "remove_panel_manager"]),
    `PANEL_MANAGER_DIR=${JSON.stringify(path.join(dir, "lib"))}`,
    `PANEL_MANAGER="$PANEL_MANAGER_DIR/fwxm-panel"`,
    `PANEL_MANAGER_CONF=${JSON.stringify(path.join(dir, "etc", "panel-manage.conf"))}`,
    `PANEL_FWXM_LINK=${JSON.stringify(path.join(dir, "bin", "fwxm"))}`,
    'PANEL_FWXM_MARKER="nex-panel-fwxm-dispatcher"',
    `mkdir -p ${JSON.stringify(path.join(dir, "bin"))}`,
    `MODE_UNDER_TEST=${mode}`,
  ].join("\n");
}

for (const [file, mode] of [["scripts/install-panel-local.sh", "local"], ["scripts/install-panel-docker.sh", "docker"]] as const) {
  test(`${file}：装上面板管理脚本、写配置和 fwxm 转发脚本；卸载时一起清掉`, () => {
    const dir = sandbox();
    try {
      const install = run(`${installerPrelude(file, dir, mode)}\ninstall_panel_manager ${JSON.stringify(path.join(root, "scripts", "fwxm-panel.sh"))} ${mode}`);
      assert.equal(install.status, 0, install.stderr);
      assert.match(install.stdout, /SSH 管理命令: fwxm/);
      const conf = fs.readFileSync(path.join(dir, "etc", "panel-manage.conf"), "utf8");
      assert.match(conf, new RegExp(`^MODE=${mode}$`, "m"));
      assert.match(conf, new RegExp(`^APP_DIR=${path.join(dir, "app").replace(/[/.]/g, "\\$&")}$`, "m"));
      assert.match(conf, mode === "docker" ? /^CONTAINER_NAME=forwardx-panel$/m : /^SERVICE_NAME=forwardx-panel$/m);
      const dispatcher = fs.readFileSync(path.join(dir, "bin", "fwxm"), "utf8");
      assert.match(dispatcher, /nex-panel-fwxm-dispatcher/);
      assert.match(dispatcher, /\[ "\$\{1:-\}" = panel \] && shift/);
      assert.ok(dispatcher.includes(`exec "${path.join(dir, "lib", "fwxm-panel")}" "$@"`), dispatcher);
      assert.equal(fs.statSync(path.join(dir, "lib", "fwxm-panel")).mode & 0o777, 0o755);

      // Agent 的 fwxm 已经在了：不覆盖它
      fs.writeFileSync(path.join(dir, "bin", "fwxm"), "#!/bin/bash\n# agent fwxm\n");
      const again = run(`${installerPrelude(file, dir, mode)}\ninstall_panel_manager ${JSON.stringify(path.join(root, "scripts", "fwxm-panel.sh"))} ${mode}`);
      assert.equal(again.status, 0, again.stderr);
      assert.equal(fs.readFileSync(path.join(dir, "bin", "fwxm"), "utf8"), "#!/bin/bash\n# agent fwxm\n");

      // 管理脚本缺失或坏了：只警告，不让安装失败
      fs.writeFileSync(path.join(dir, "broken.sh"), "if then fi\n");
      const broken = run(`${installerPrelude(file, dir, mode)}\ninstall_panel_manager ${JSON.stringify(path.join(dir, "broken.sh"))} ${mode}; install_panel_manager /nonexistent ${mode}`);
      assert.equal(broken.status, 0, broken.stderr);
      assert.match(broken.stdout, /没有装上/);

      // 卸载：管理脚本和配置删掉；Agent 的 fwxm 不动
      const remove = run(`${installerPrelude(file, dir, mode)}\nremove_panel_manager`);
      assert.equal(remove.status, 0, remove.stderr);
      assert.equal(fs.existsSync(path.join(dir, "lib", "fwxm-panel")), false);
      assert.equal(fs.existsSync(path.join(dir, "etc", "panel-manage.conf")), false);
      assert.equal(fs.existsSync(path.join(dir, "bin", "fwxm")), true, "Agent 的 fwxm 留着");
      // 只装了面板时的转发脚本会被删掉
      run(`${installerPrelude(file, dir, mode)}\nrm -f "$PANEL_FWXM_LINK"; install_panel_manager ${JSON.stringify(path.join(root, "scripts", "fwxm-panel.sh"))} ${mode}; remove_panel_manager`);
      assert.equal(fs.existsSync(path.join(dir, "bin", "fwxm")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("fwxm-panel.sh：读配置不执行它；info / address / version 按部署方式出结果", () => {
  const dir = sandbox();
  try {
    const conf = path.join(dir, "panel-manage.conf");
    const manager = path.join(root, "scripts", "fwxm-panel.sh");
    // 需要 root：测试里把 id 换成一个总是返回 0 的假命令
    const fakeBin = path.join(dir, "fakebin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, "hostname"), "#!/bin/sh\necho 203.0.113.9 10.0.0.2 127.0.0.1 2001:db8::9\n", { mode: 0o755 });
    const env = { FWXM_PANEL_CONF: conf, PATH: `${fakeBin}:${process.env.PATH}` };

    fs.writeFileSync(conf, `MODE=local\nAPP_DIR=${path.join(dir, "app")}\nSERVICE_NAME=forwardx-panel\nINJECT=$(touch ${path.join(dir, "pwned")})\n`);
    const info = run(`bash ${JSON.stringify(manager)} info`, env);
    assert.equal(info.status, 0, info.stderr);
    assert.match(info.stdout, /部署方式:\s+local/);
    assert.match(info.stdout, /访问端口:\s+9911/);
    assert.match(info.stdout, /面板版本:\s+2\.3\.524/);
    assert.equal(fs.existsSync(path.join(dir, "pwned")), false, "配置文件不当脚本执行");

    const address = run(`bash ${JSON.stringify(manager)} address`, env);
    assert.equal(address.status, 0, address.stderr);
    assert.match(address.stdout, /http:\/\/203\.0\.113\.9:9911/);
    assert.match(address.stdout, /http:\/\/\[2001:db8::9\]:9911/);
    assert.doesNotMatch(address.stdout, /127\.0\.0\.1/);

    assert.equal(run(`bash ${JSON.stringify(manager)} version`, env).stdout.trim(), "2.3.525");
    assert.match(run(`bash ${JSON.stringify(manager)} help`, env).stdout, /fwxm panel upgrade/);
    assert.notEqual(run(`bash ${JSON.stringify(manager)} nonsense`, env).status, 0);

    fs.writeFileSync(conf, "MODE=weird\nAPP_DIR=/x\n");
    const badMode = run(`bash ${JSON.stringify(manager)} info`, env);
    assert.notEqual(badMode.status, 0);
    assert.match(badMode.stderr, /部署方式无效/);

    const missing = run(`bash ${JSON.stringify(manager)} info`, { ...env, FWXM_PANEL_CONF: path.join(dir, "nope.conf") });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /没找到面板管理配置/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Agent 的 fwxm：fwxm panel … 交给面板管理脚本；没装面板时说清楚", () => {
  const dir = sandbox();
  try {
    const agentFwxm = path.join(dir, "fwxm");
    fs.writeFileSync(agentFwxm, fwxmScript(), { mode: 0o755 });
    const fakePanel = path.join(dir, "fwxm-panel");
    fs.writeFileSync(fakePanel, '#!/bin/bash\necho "panel manager got: $*"\n', { mode: 0o755 });
    const delegated = run(`bash ${JSON.stringify(agentFwxm)} panel status --x`, { FWXM_PANEL_MANAGER: fakePanel });
    assert.equal(delegated.status, 0, delegated.stderr);
    assert.equal(delegated.stdout.trim(), "panel manager got: status --x");
    const absent = run(`bash ${JSON.stringify(agentFwxm)} panel status`, { FWXM_PANEL_MANAGER: path.join(dir, "missing") });
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /没有装面板/);
    assert.match(run(`bash ${JSON.stringify(agentFwxm)} help`).stdout, /fwxm panel/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("发布包带着 fwxm-panel.sh（本机部署的升级从部署目录里拿它）", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "release-panel.yml"), "utf8");
  assert.match(workflow, /scripts\/fwxm-panel\.sh/);
});
