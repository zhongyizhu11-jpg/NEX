import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createForwardxUpstreamSqlite } from "../server/forwardxMigration.fixture";

/*
  本机部署的 migrate-forwardx / rollback-forwardx（scripts/install-panel-local.sh）真的跑 bash：
  - 原版面板目录是临时目录里按原版布局摆出来的（package.json、.env、data/database.json、原版表结构的 SQLite）；
  - 下载 / 装依赖 / 写 systemd 服务这几步换成假的，「NEX 发布包」里的 dist/migrate-forwardx.js 转调仓库里的
    server/forwardxMigrationCli.ts —— 导数据这一步是真导；
  - systemctl / curl 换成 PATH 里的假命令：systemctl 只记调用，curl 按开关文件回「数据库健康」或失败。
*/
const root = path.resolve(import.meta.dirname, "..");
const installer = "scripts/install-panel-local.sh";

function extractFunctions(file: string, names: string[]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  return names.map((name) => {
    const start = source.indexOf(`\n${name}() {\n`);
    assert.ok(start >= 0, `${file} 里找不到 ${name}`);
    const end = source.indexOf("\n}\n", start);
    return source.slice(start + 1, end + 3);
  }).join("\n");
}

function sha256(file: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const JWT = "a".repeat(64);

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-migrate-local-"));
  const app = path.join(dir, "opt", "forwardx-panel");
  fs.mkdirSync(path.join(app, "data"), { recursive: true });
  fs.mkdirSync(path.join(app, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), '{\n  "name": "forwardx",\n  "version": "2.3.299",\n  "description": "ForwardX 多主机端口转发与隧道管理面板"\n}\n');
  fs.writeFileSync(path.join(app, ".env"), `NODE_ENV=production\nPORT=9911\nDATABASE_CONFIG_PATH=${app}/data/database.json\nSQLITE_PATH=${app}/data/forwardx.db\nJWT_SECRET=${JWT}\n`);
  fs.writeFileSync(path.join(app, "data", "database.json"), JSON.stringify({ type: "sqlite", sqlite: { path: `${app}/data/forwardx.db` } }));
  fs.writeFileSync(path.join(app, "data", ".setup-complete"), "2026-01-01\n");
  fs.writeFileSync(path.join(app, "node_modules", "upstream-marker"), "x");
  createForwardxUpstreamSqlite(path.join(app, "data", "forwardx.db"));
  // 「NEX 发布包」
  const bundle = path.join(dir, "bundle");
  fs.mkdirSync(path.join(bundle, "dist"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "package.json"), '{\n  "name": "forwardx",\n  "version": "2.3.527",\n  "description": "NEX 多主机端口转发与隧道管理面板"\n}\n');
  fs.writeFileSync(path.join(bundle, "dist", "migrate-forwardx.js"), [
    'const { spawnSync } = require("node:child_process");',
    `const result = spawnSync(process.execPath, ["--import", "tsx", ${JSON.stringify(path.join(root, "server", "forwardxMigrationCli.ts"))}, ...process.argv.slice(2)], { stdio: "inherit", cwd: ${JSON.stringify(root)}, env: process.env });`,
    "process.exit(result.status ?? 1);",
    "",
  ].join("\n"));
  // 服务文件、原版的 fwxm、假命令
  const etc = path.join(dir, "etc");
  fs.mkdirSync(etc, { recursive: true });
  fs.writeFileSync(path.join(etc, "forwardx-panel.service"), "[Unit]\nDescription=ForwardX Panel\n");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "fwxm"), "#!/bin/bash\n# ForwardX Manager: host-side management for Agent/local/Docker panel.\n", { mode: 0o755 });
  const fakeBin = path.join(dir, "fakebin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> ${JSON.stringify(path.join(dir, "systemctl.log"))}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "curl"), `#!/bin/sh\nif [ -f ${JSON.stringify(path.join(dir, "healthy"))} ]; then echo '{"state":"healthy","databaseType":"sqlite"}'; else exit 7; fi\n`, { mode: 0o755 });
  return { dir, app, bundle, etc, bin, fakeBin };
}

function script(box: ReturnType<typeof sandbox>, action: string) {
  return [
    "set -euo pipefail",
    `APP_DIR=${JSON.stringify(box.app)}`,
    'SERVICE_NAME="forwardx-panel"',
    'PORT="9810"',
    'ACTION="migrate-forwardx"',
    'GITHUB_ACCELERATOR_URL=""',
    'SCRIPT_STARTED_AT="$(date +%s)"',
    "PANEL_STEP_TOTAL=5",
    'ASSUME_YES="${TEST_ASSUME_YES:-true}"',
    'TARGET_DB_CONFIG=""',
    'ROLLBACK_BACKUP_DIR=""',
    `PANEL_FWXM_LINK=${JSON.stringify(path.join(box.bin, "fwxm"))}`,
    `FORWARDX_MIGRATION_MARKER=${JSON.stringify(path.join(box.etc, "nex", "forwardx-migration.last"))}`,
    extractFunctions(installer, [
      "get_env_value", "valid_port", "panel_step", "elapsed_seconds", "json_escape", "resolve_runtime_env", "require_root",
      "confirm_yes", "write_env", "restart_service",
      "forwardx_panel_kind", "forwardx_package_version", "stop_panel_service", "start_panel_service", "wait_local_panel_ready",
      "forwardx_migration_cli", "forwardx_source_args", "backup_forwardx_fwxm", "rollback_forwardx_local",
      "migrate_forwardx_local", "rollback_forwardx_local_action",
    ]),
    // 不在测试里做的几步
    "require_root() { :; }",
    "resolve_github_accelerator() { :; }",
    "is_systemd_host() { return 0; }",
    "install_deps() { :; }",
    'resolve_release_version() { echo "2.3.527"; }',
    `download_panel_bundle() { mkdir -p "$APP_DIR"; cp -a ${JSON.stringify(box.bundle)}/. "$APP_DIR/"; }`,
    "install_runtime_dependencies() { :; }",
    `write_service() { echo "[Unit]\\nDescription=NEX Panel" > ${JSON.stringify(path.join(box.etc, "forwardx-panel.service"))}; }`,
    `panel_service_files() { echo ${JSON.stringify(path.join(box.etc, "forwardx-panel.service"))}; echo ${JSON.stringify(path.join(box.etc, "init.d-forwardx-panel"))}; }`,
    'install_panel_manager() { echo "[test] install_panel_manager $*"; }',
    action,
  ].join("\n");
}

function run(box: ReturnType<typeof sandbox>, action: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script(box, action)], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${box.fakeBin}:${process.env.PATH}`, FORWARDX_MIGRATE_READY_TIMEOUT: "2", DATABASE_TYPE: "", ...env },
    timeout: 240_000,
  });
}

function backupDirOf(box: ReturnType<typeof sandbox>) {
  const parent = path.dirname(box.app);
  const found = fs.readdirSync(parent).filter((name) => name.startsWith("forwardx-panel.forwardx-backup-"));
  assert.equal(found.length, 1, found.join(","));
  return path.join(parent, found[0]);
}

test("migrate-forwardx（本机）：原版目录整个留作备份，NEX 装到原位、数据导进新库；rollback-forwardx 换回原版", () => {
  const box = sandbox();
  try {
    const sourceHash = sha256(path.join(box.app, "data", "forwardx.db"));
    fs.writeFileSync(path.join(box.dir, "healthy"), "1");
    const migrated = run(box, "migrate_forwardx_local");
    assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
    assert.match(migrated.stdout, /检测到原版 ForwardX 面板：.*版本 2\.3\.299/);
    assert.match(migrated.stdout, /\[DONE\] 已从原版 ForwardX 2\.3\.299 迁到 NEX v2\.3\.527/);

    const backup = backupDirOf(box);
    // 原版：一个文件不少、数据库一个字节没改
    assert.equal(sha256(path.join(backup, "app", "data", "forwardx.db")), sourceHash);
    assert.ok(fs.existsSync(path.join(backup, "app", "node_modules", "upstream-marker")));
    assert.match(fs.readFileSync(path.join(backup, "app", "package.json"), "utf8"), /ForwardX 多主机/);
    assert.match(fs.readFileSync(path.join(backup, "service", "forwardx-panel.service"), "utf8"), /ForwardX Panel/);
    assert.ok(fs.existsSync(path.join(backup, "service", ".none-init.d-forwardx-panel")), "原来没有的服务文件也要记下来");
    assert.match(fs.readFileSync(path.join(backup, "manifest"), "utf8"), /^SOURCE_VERSION=2\.3\.299$/m);
    assert.ok(fs.existsSync(path.join(backup, "migration-report.json")));
    assert.equal(fs.readFileSync(path.join(box.etc, "nex", "forwardx-migration.last"), "utf8").trim(), backup);
    // 原版的 fwxm 会从原版仓库重装面板：挪进备份
    assert.equal(fs.existsSync(path.join(box.bin, "fwxm")), false);
    assert.ok(fs.existsSync(path.join(backup, "service", "fwxm.forwardx")));

    // NEX：在原位，端口和 JWT 密钥沿用原版的，数据库是新导出来的 NEX 库
    assert.match(fs.readFileSync(path.join(box.app, "package.json"), "utf8"), /NEX 多主机/);
    const env = fs.readFileSync(path.join(box.app, ".env"), "utf8");
    assert.match(env, /^PORT=9911$/m);
    assert.match(env, new RegExp(`^JWT_SECRET=${JWT}$`, "m"));
    assert.ok(fs.existsSync(path.join(box.app, "data", ".setup-complete")), "data/ 里别的文件带过来");
    assert.equal(fs.existsSync(path.join(box.app, "data", "forwardx.db.nex-import")), false);
    const config = JSON.parse(fs.readFileSync(path.join(box.app, "data", "database.json"), "utf8"));
    assert.deepEqual(config, { type: "sqlite", sqlite: { path: path.join(box.app, "data", "forwardx.db") } });
    const check = spawnSync(process.execPath, ["-e", `
      const Database = require("better-sqlite3");
      const db = new Database(process.argv[1], { readonly: true });
      const hosts = db.prepare('SELECT id, "agentDistribution" AS d FROM hosts ORDER BY id').all();
      console.log(JSON.stringify(hosts));
    `, path.join(box.app, "data", "forwardx.db")], { cwd: root, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    assert.deepEqual(JSON.parse(check.stdout), [{ id: 10, d: "forwardx" }, { id: 11, d: "forwardx" }]);
    assert.match(fs.readFileSync(path.join(box.etc, "forwardx-panel.service"), "utf8"), /NEX Panel/);
    const calls = fs.readFileSync(path.join(box.dir, "systemctl.log"), "utf8");
    assert.match(calls, /systemctl stop forwardx-panel/);
    assert.match(calls, /systemctl restart forwardx-panel/);

    // 退回原版
    const rolledBack = run(box, "rollback_forwardx_local_action");
    assert.equal(rolledBack.status, 0, `${rolledBack.stdout}\n${rolledBack.stderr}`);
    assert.match(fs.readFileSync(path.join(box.app, "package.json"), "utf8"), /ForwardX 多主机/);
    assert.equal(sha256(path.join(box.app, "data", "forwardx.db")), sourceHash);
    assert.ok(fs.existsSync(path.join(box.app, "node_modules", "upstream-marker")));
    assert.match(fs.readFileSync(path.join(box.etc, "forwardx-panel.service"), "utf8"), /ForwardX Panel/);
    assert.match(fs.readFileSync(path.join(box.bin, "fwxm"), "utf8"), /ForwardX Manager/);
    assert.equal(fs.existsSync(path.join(box.etc, "nex", "forwardx-migration.last")), false);
    const leftovers = fs.readdirSync(path.dirname(box.app)).filter((name) => name.startsWith("forwardx-panel.nex-failed-"));
    assert.equal(leftovers.length, 1, "NEX 的目录挪开留着，不直接删");
  } finally {
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test("migrate-forwardx（本机）：NEX 起不来就自动回退，原版原样回来", () => {
  const box = sandbox();
  try {
    const sourceHash = sha256(path.join(box.app, "data", "forwardx.db"));
    // 不放 healthy：假 curl 一直失败，等就绪超时
    const migrated = run(box, "migrate_forwardx_local");
    assert.equal(migrated.status, 1, `${migrated.stdout}\n${migrated.stderr}`);
    assert.match(migrated.stdout, /自动回退到原版 ForwardX/);
    assert.match(migrated.stdout, /已回到原版 ForwardX/);
    assert.match(fs.readFileSync(path.join(box.app, "package.json"), "utf8"), /ForwardX 多主机/);
    assert.equal(sha256(path.join(box.app, "data", "forwardx.db")), sourceHash);
    assert.match(fs.readFileSync(path.join(box.etc, "forwardx-panel.service"), "utf8"), /ForwardX Panel/);
    assert.match(fs.readFileSync(path.join(box.bin, "fwxm"), "utf8"), /ForwardX Manager/);
    const calls = fs.readFileSync(path.join(box.dir, "systemctl.log"), "utf8");
    assert.ok(calls.trim().split("\n").at(-1)?.includes("restart forwardx-panel"), "最后把原版服务重新拉起来");
  } finally {
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test("migrate-forwardx（本机）：已经是 NEX、没确认、原版的库不对，都不动原版", () => {
  const box = sandbox();
  try {
    const before = fs.readFileSync(path.join(box.app, "package.json"), "utf8");
    // 不确认（测试里没有终端，confirm_yes 当作 N）
    const cancelled = run(box, "migrate_forwardx_local", { TEST_ASSUME_YES: "false" });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.match(cancelled.stdout, /已取消，原版面板没有改动/);
    assert.equal(fs.readFileSync(path.join(box.app, "package.json"), "utf8"), before);
    assert.equal(fs.existsSync(`${box.app}.nex-staging`), false, "旁边装的 NEX 删掉");
    assert.equal(fs.readdirSync(path.dirname(box.app)).some((name) => name.includes("forwardx-backup")), false);

    // 原版的库不对（缺 hosts 表）：检查就失败，什么都不动
    fs.renameSync(path.join(box.app, "data", "forwardx.db"), path.join(box.dir, "good.db"));
    spawnSync(process.execPath, ["-e", `const D=require("better-sqlite3");const d=new D(process.argv[1]);d.exec("CREATE TABLE users (id INTEGER)");d.close();`, path.join(box.app, "data", "forwardx.db")], { cwd: root });
    const broken = run(box, "migrate_forwardx_local");
    assert.equal(broken.status, 1);
    assert.match(broken.stdout, /数据库检查没通过，原版面板没有改动/);
    assert.equal(fs.readFileSync(path.join(box.app, "package.json"), "utf8"), before);

    // 已经是 NEX
    fs.writeFileSync(path.join(box.app, "package.json"), '{ "name": "forwardx", "version": "2.3.526", "description": "NEX 多主机端口转发与隧道管理面板" }\n');
    const nex = run(box, "migrate_forwardx_local");
    assert.equal(nex.status, 1);
    assert.match(nex.stdout, /已经是 NEX 面板了/);
  } finally {
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});
