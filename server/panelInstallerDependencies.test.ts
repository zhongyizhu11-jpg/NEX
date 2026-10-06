import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  本地安装脚本的「依赖没变就不重装」和「下载时报进度」。

  用户在手机上升级面板卡在 74% 好几分钟：那一段其实是在删掉 node_modules 重装全部依赖，
  而两次补丁版本之间锁文件几乎从不变。这里把脚本里相关的函数原样 source 进来，
  pnpm / curl 换成假的，验证的是脚本本身，而不是抄一遍逻辑。
*/

const localSource = fs.readFileSync(path.join(process.cwd(), "scripts/install-panel-local.sh"), "utf8");

function resolveBash() {
  const result = spawnSync("bash", ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0 ? "bash" : "";
}

const bash = resolveBash();

function sourceBefore(marker: string) {
  const index = localSource.indexOf(marker);
  assert.notEqual(index, -1, `missing shell marker: ${marker}`);
  return localSource.slice(0, index).replace(/\r\n/g, "\n");
}

function runInstallerHarness(options: { body: string; prepare?: (directory: string) => void }) {
  assert.ok(bash, "bash is required for panel installer regression tests");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-installer-deps-"));
  const appDir = path.join(directory, "app");
  fs.mkdirSync(appDir, { recursive: true });
  options.prepare?.(appDir);
  const harness = path.join(directory, "harness.sh");
  const callLog = path.join(directory, "calls.log");
  fs.writeFileSync(harness, `${sourceBefore("write_env() {")}\n${options.body}\n`);
  const result = spawnSync(bash, [harness, "upgrade"], {
    encoding: "utf8",
    env: { ...process.env, FORWARDX_PANEL_DIR: appDir, CALL_LOG: callLog, FORWARDX_GITHUB_ACCELERATOR_URL: "" },
    timeout: 60_000,
  });
  const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
  const fingerprintFile = path.join(appDir, "node_modules/.forwardx-deps-fingerprint");
  const fingerprint = fs.existsSync(fingerprintFile) ? fs.readFileSync(fingerprintFile, "utf8").trim() : "";
  fs.rmSync(directory, { recursive: true, force: true });
  return { ...result, calls, fingerprint };
}

function writeBundle(appDir: string, lock = "lockfileVersion: '9.0'\npackages:\n  a@1.0.0: {}\n") {
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({
    name: "forwardx",
    version: "2.3.398",
    scripts: { build: "changes here must not force a reinstall" },
    dependencies: { a: "1.0.0" },
  }));
  fs.writeFileSync(path.join(appDir, "pnpm-lock.yaml"), lock);
  fs.writeFileSync(path.join(appDir, "pnpm-workspace.yaml"), "packages: []\n");
  fs.mkdirSync(path.join(appDir, "patches"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "patches/a@1.0.0.patch"), "--- a\n+++ b\n");
}

// 假 pnpm：记下调用，成功时摆出 pnpm 装完后的样子（.pnpm 目录和 .modules.yaml）。
const fakePnpm = `
PNPM_FAIL_ONCE="\${PNPM_FAIL_ONCE:-false}"
pnpm() {
  if [ "$1" = "--version" ]; then printf '10.28.1\\n'; return 0; fi
  printf 'pnpm %s\\n' "$*" >> "$CALL_LOG"
  if [ "$PNPM_FAIL_ONCE" = "true" ]; then PNPM_FAIL_ONCE="false"; return 1; fi
  mkdir -p node_modules/.pnpm
  printf 'layoutVersion: 5\\n' > node_modules/.modules.yaml
}
npm() { printf 'npm %s\\n' "$*" >> "$CALL_LOG"; }
`;

test("the local installer skips pnpm install when the dependency inputs did not change", { skip: !bash }, () => {
  const result = runInstallerHarness({
    prepare: (appDir) => writeBundle(appDir),
    body: `${fakePnpm}
install_runtime_dependencies
echo "--- second upgrade, same lockfile"
install_runtime_dependencies
echo "--- third upgrade, only package.json scripts changed"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.scripts.build="something else";p.version="2.3.399";fs.writeFileSync("package.json",JSON.stringify(p))'
install_runtime_dependencies
echo "--- fourth upgrade, lockfile changed"
printf 'lockfileVersion: 9\\npackages:\\n  a@1.0.1: {}\\n' > pnpm-lock.yaml
install_runtime_dependencies
`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  // 第一次和锁文件变了的第四次装，中间两次跳过。
  assert.deepEqual(result.calls, [
    "pnpm install --prod --frozen-lockfile --prefer-offline",
    "pnpm install --prod --frozen-lockfile --prefer-offline",
  ]);
  const stepLines = result.stdout.split("\n").filter((line) => line.startsWith("[NEX] step 4/5"));
  assert.deepEqual(stepLines, [
    "[NEX] step 4/5 安装依赖",
    "[NEX] step 4/5 依赖未变化，跳过安装",
    "[NEX] step 4/5 依赖未变化，跳过安装",
    "[NEX] step 4/5 安装依赖",
  ]);
  assert.match(result.stdout, /Dependencies unchanged since last install, skipping pnpm install/);
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
});

test("upgrading an install made by the pre-fingerprint script skips pnpm when the lockfile did not change", { skip: !bash }, () => {
  // 2.3.398 之前的脚本不写指纹：老机器第一次用新脚本升级时，按解压前的旧文件补上指纹，
  // 依赖没变就不用白装一遍。
  const result = runInstallerHarness({
    prepare: (appDir) => {
      writeBundle(appDir);
      fs.mkdirSync(path.join(appDir, "node_modules/.pnpm"), { recursive: true });
      fs.writeFileSync(path.join(appDir, "node_modules/.modules.yaml"), "layoutVersion: 5\n");
    },
    body: `${fakePnpm}
cd "$APP_DIR"
seed_dependency_fingerprint
echo "--- new bundle extracted: only the version changed"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.version="2.3.399";fs.writeFileSync("package.json",JSON.stringify(p))'
install_runtime_dependencies
echo "--- a seeded fingerprint is never overwritten by a later seed"
seed_dependency_fingerprint
printf 'lockfileVersion: 9\\npackages:\\n  a@2.0.0: {}\\n' > pnpm-lock.yaml
install_runtime_dependencies
`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Recorded the dependency fingerprint of the running install/);
  assert.deepEqual(result.calls, ["pnpm install --prod --frozen-lockfile --prefer-offline"], "only the real lockfile change installs");
  const stepLines = result.stdout.split("\n").filter((line) => line.startsWith("[NEX] step 4/5"));
  assert.deepEqual(stepLines, ["[NEX] step 4/5 依赖未变化，跳过安装", "[NEX] step 4/5 安装依赖"]);
});

test("without node_modules there is nothing to seed and the installer installs", { skip: !bash }, () => {
  const result = runInstallerHarness({
    prepare: (appDir) => writeBundle(appDir),
    body: `${fakePnpm}
seed_dependency_fingerprint
install_runtime_dependencies
`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /Recorded the dependency fingerprint/);
  assert.deepEqual(result.calls, ["pnpm install --prod --frozen-lockfile --prefer-offline"]);
});

test("a patch change or a missing node_modules forces a reinstall even with the same lockfile", { skip: !bash }, () => {
  const result = runInstallerHarness({
    prepare: (appDir) => writeBundle(appDir),
    body: `${fakePnpm}
install_runtime_dependencies
echo "--- patch changed"
printf -- '--- a\\n+++ c\\n' > patches/a@1.0.0.patch
install_runtime_dependencies
echo "--- node_modules wiped by hand"
rm -rf node_modules
install_runtime_dependencies
echo "--- fingerprint present but .modules.yaml gone"
rm -f node_modules/.modules.yaml
install_runtime_dependencies
`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.calls.length, 4, result.calls.join("\n"));
  assert.doesNotMatch(result.stdout, /跳过安装/);
});

test("when pnpm cannot reconcile the existing node_modules the installer falls back to a clean install", { skip: !bash }, () => {
  const result = runInstallerHarness({
    prepare: (appDir) => {
      writeBundle(appDir);
      fs.mkdirSync(path.join(appDir, "node_modules/.pnpm/stale"), { recursive: true });
      fs.writeFileSync(path.join(appDir, "node_modules/.modules.yaml"), "layoutVersion: 5\n");
      fs.writeFileSync(path.join(appDir, "node_modules/.forwardx-deps-fingerprint"), "stale-fingerprint\n");
    },
    body: `${fakePnpm}
PNPM_FAIL_ONCE="true"
install_runtime_dependencies
[ -e node_modules/.pnpm/stale ] && echo "STALE_KEPT" || echo "STALE_REMOVED"
`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.calls, [
    "pnpm install --prod --frozen-lockfile --prefer-offline",
    "pnpm install --prod --frozen-lockfile",
  ]);
  assert.match(result.stdout, /STALE_REMOVED/);
  assert.match(result.stdout, /reinstalling from scratch/);
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
});

test("without a lockfile the installer still runs npm install --omit=dev", { skip: !bash }, () => {
  const result = runInstallerHarness({
    prepare: (appDir) => {
      fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "forwardx", dependencies: {} }));
    },
    body: `${fakePnpm}
install_runtime_dependencies
`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.calls, ["npm install --omit=dev"]);
  assert.equal(result.fingerprint, "");
});

test("the local installer reports download progress while curl is still writing", { skip: !bash }, () => {
  const result = runInstallerHarness({
    body: `
curl() {
  local output=""
  local expect_output="false"
  local head_request="false"
  local arg=""
  for arg in "$@"; do
    if [ "$expect_output" = "true" ]; then output="$arg"; expect_output="false"; continue; fi
    case "$arg" in
      --output|-o) expect_output="true" ;;
      -sIL|-I|--head) head_request="true" ;;
    esac
  done
  if [ "$head_request" = "true" ]; then printf 'HTTP/1.1 302 Found\\r\\ncontent-length: 0\\r\\n\\r\\nHTTP/1.1 200 OK\\r\\nContent-Length: 3072\\r\\n\\r\\n'; return 0; fi
  # 模拟慢速下载：每 0.7 秒写 1 KB，前台循环应该在中途至少报一次进度。
  local i=0
  while [ "$i" -lt 3 ]; do
    head -c 1024 /dev/zero >> "$output"
    sleep 0.7
    i=$((i + 1))
  done
  printf '200'
}
code="$(download_url_to_file 'https://github.com/example/panel.tar.gz' "$APP_DIR/panel.tar.gz")"
printf 'CODE=%s SIZE=%s\\n' "$code" "$(file_size_bytes "$APP_DIR/panel.tar.gz")"
`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "CODE=200 SIZE=3072");
  const progress = result.stderr.split("\n").filter((line) => line.startsWith("[NEX] progress download "));
  assert.ok(progress.length >= 2, `expected intermediate progress lines, got:\n${result.stderr}`);
  // 跟随跳转后取最后一个 Content-Length，最终一行必须是 100%。
  assert.equal(progress[progress.length - 1], "[NEX] progress download 3072/3072 100%");
  assert.ok(progress.some((line) => /\/3072 (33|66)%$/.test(line)), progress.join("\n"));
});
