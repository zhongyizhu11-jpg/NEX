import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  FORWARDX_TRUST_PROXY（反向代理的信任范围，server/trustProxy.ts）写在部署目录的 .env 里。
  两个安装脚本升级时都会整份重写 .env：管理员设过的值要带过去，Docker 的 compose 还要把它传进容器。
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

for (const file of ["scripts/install-panel-local.sh", "scripts/install-panel-docker.sh"]) {
  test(`${file}：升级重写 .env 时保留 FORWARDX_TRUST_PROXY，没设过就不写`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-trust-proxy-"));
    try {
      const run = (env: Record<string, string> = {}) => spawnSync("bash", ["-c", [
        "set -euo pipefail",
        `APP_DIR=${JSON.stringify(dir)}`,
        'PORT=9810 PROJECT_NAME=forwardx CONTAINER_NAME=forwardx-panel GITHUB_ACCELERATOR_URL=""',
        extractFunctions(file, ["get_env_value", ...(file.includes("docker") ? ["valid_port"] : []), "write_env"]),
        "write_env ghcr.io/example/forwardx:v1",
      ].join("\n")], { encoding: "utf8", env: { ...process.env, ...env } });
      fs.writeFileSync(path.join(dir, ".env"), "PORT=9810\nJWT_SECRET=x\nFORWARDX_TRUST_PROXY=172.16.0.0/12\n");
      const kept = run();
      assert.equal(kept.status, 0, kept.stderr);
      assert.match(fs.readFileSync(path.join(dir, ".env"), "utf8"), /^FORWARDX_TRUST_PROXY=172\.16\.0\.0\/12$/m);
      // 环境变量里给了新值：用新的
      assert.equal(run({ FORWARDX_TRUST_PROXY: "1" }).status, 0);
      assert.match(fs.readFileSync(path.join(dir, ".env"), "utf8"), /^FORWARDX_TRUST_PROXY=1$/m);
      fs.writeFileSync(path.join(dir, ".env"), "PORT=9810\nJWT_SECRET=x\n");
      assert.equal(run({ FORWARDX_TRUST_PROXY: "" }).status, 0);
      assert.doesNotMatch(fs.readFileSync(path.join(dir, ".env"), "utf8"), /FORWARDX_TRUST_PROXY/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("Docker 的 compose（安装脚本写的和仓库根目录那份）都把 FORWARDX_TRUST_PROXY 传进容器", () => {
  const installer = fs.readFileSync(path.join(root, "scripts", "install-panel-docker.sh"), "utf8");
  const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  for (const source of [installer, compose]) {
    assert.match(source, /FORWARDX_TRUST_PROXY: \$\{FORWARDX_TRUST_PROXY:-loopback\}/);
  }
});
