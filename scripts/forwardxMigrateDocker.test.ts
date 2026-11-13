import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createForwardxUpstreamSqlite } from "../server/forwardxMigration.fixture";

/*
  Docker 部署的 migrate-forwardx / rollback-forwardx（scripts/install-panel-docker.sh）真的跑 bash，
  docker 换成一个假的（下面 FAKE_DOCKER，Node 写的）：
  - 数据卷是临时目录里的一个文件夹，`docker run -v 卷:/data` 时把命令里的 /data、/work、/source 换成对应的宿主机目录再执行；
  - `--entrypoint node 镜像 dist/migrate-forwardx.js …` 转调仓库里的 server/forwardxMigrationCli.ts —— 导数据是真导；
  - 容器状态（哪个镜像、在不在跑）记在一个 JSON 里，`docker exec … curl …/api/database-health` 按开关文件回健康或失败。
  这只能验证脚本自己的步骤和回退逻辑，验证不了真的 Docker（权限、存储驱动、Compose 版本差异）。
*/
const root = path.resolve(import.meta.dirname, "..");
const installer = "scripts/install-panel-docker.sh";
const OLD_IMAGE_ID = "sha256:oldforwardx";
const NEW_IMAGE = "ghcr.io/zhongyizhu11-jpg/forwardx:v2.3.527";
const JWT = "b".repeat(64);

const FAKE_DOCKER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const stateFile = process.env.FAKE_DOCKER_STATE;
const volumesDir = process.env.FAKE_DOCKER_VOLUMES;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, "docker " + args.join(" ") + "\n");
const container = () => state.container;
const exit = (code, out) => { if (out !== undefined) process.stdout.write(out); process.exit(code); };
const command = args[0];
if (command === "compose") {
  if (args[1] === "version") exit(0, "v2\n");
  // compose --env-file F -p P up -d …：用 FORWARDX_IMAGE（环境变量优先，没有再看 env 文件）起容器
  const envFile = args[args.indexOf("--env-file") + 1];
  const fromFile = (fs.readFileSync(envFile, "utf8").match(/^FORWARDX_IMAGE=(.*)$/m) || [])[1];
  const image = process.env.FORWARDX_IMAGE || fromFile;
  const imageId = image === "forwardx-migration-backup:" + state.backupTag || image === state.oldImageRef ? state.oldImageId : (image === state.newImage ? "sha256:new" : "sha256:other");
  state.container = { image: imageId, imageRef: image, running: true };
  save();
  exit(0);
}
if (command === "inspect") {
  const format = args[2];
  const c = container();
  if (!c) exit(1);
  if (format === "{{.Config.Image}}") exit(0, c.imageRef + "\n");
  if (format === "{{.Image}}") exit(0, c.image + "\n");
  if (format === "{{.Id}}") exit(0, "cid-1\n");
  if (format === "{{.State.Running}}") exit(0, String(!!c.running) + "\n");
  if (format.includes(".Mounts")) exit(0, state.volume + "\n");
  exit(0, "\n");
}
if (command === "ps") exit(0, container() ? "cid-1\n" : "");
if (command === "volume" && args[1] === "inspect") exit(fs.existsSync(path.join(volumesDir, args[2])) ? 0 : 1);
if (command === "pull") exit(0);
if (command === "tag") { state.tags = [...(state.tags || []), args[2]]; state.backupTag = args[2].split(":")[1]; save(); exit(0); }
if (command === "stop") { if (container()) container().running = false; save(); exit(0); }
if (command === "start") { if (container()) container().running = true; save(); exit(0); }
if (command === "rm") { state.container = null; save(); exit(0); }
if (command === "image") exit(0, "");
if (command === "exec") {
  const c = container();
  const healthy = c && c.running && c.image === "sha256:new" && fs.existsSync(process.env.FAKE_DOCKER_HEALTHY);
  exit(healthy ? 0 : 1, healthy ? '{"state":"healthy"}' : "");
}
if (command === "run") {
  const mounts = [];
  const env = { ...process.env };
  let index = 1;
  let entrypoint = "";
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--rm") continue;
    if (arg === "--add-host") { index += 1; continue; }
    if (arg === "-v") {
      const [source, destination] = args[++index].split(":");
      mounts.push([destination, source.startsWith("/") ? source : path.join(volumesDir, source)]);
      continue;
    }
    if (arg === "-e") { const [key, ...rest] = args[++index].split("="); env[key] = rest.join("="); continue; }
    if (arg === "--entrypoint") { entrypoint = args[++index]; continue; }
    break;
  }
  const image = args[index];
  const rest = args.slice(index + 1);
  mounts.push(["/app", process.env.FAKE_NEX_APP]);
  mounts.sort((a, b) => b[0].length - a[0].length);
  // 命令里转义过的路径（\"/data/…\"，写进文件的内容）不换：那是容器里的路径
  const mapPath = (text) => {
    let out = text;
    for (const [destination, source] of mounts) {
      out = out.replace(new RegExp("(?<!\\\\)(^|[\\s'\"=])" + destination.replace(/[/.]/g, "\\$&") + "(?=[/\\s'\"]|$)", "g"), (_, lead) => lead + source);
    }
    return out;
  };
  if (entrypoint === "node" && rest[0] === "-p") {
    exit(0, image === state.oldImageId ? "forwardx\n2.3.299\n" : "nex\n2.3.527\n");
  }
  if (entrypoint === "node" && rest[0] === "dist/migrate-forwardx.js") {
    const cliArgs = [];
    for (let i = 1; i < rest.length; i += 1) {
      if (rest[i - 1] === "--map-path") {
        const [from, to] = rest[i].split("=");
        cliArgs.push(from + "=" + mapPath(to));
      } else cliArgs.push(mapPath(rest[i]));
    }
    const result = spawnSync(process.execPath, ["--import", "tsx", path.join(process.env.FAKE_REPO_ROOT, "server", "forwardxMigrationCli.ts"), ...cliArgs], {
      cwd: process.env.FAKE_REPO_ROOT, stdio: "inherit", env: { ...env, DATABASE_TYPE: "", DATABASE_CONFIG_PATH: "/nonexistent/database.json" },
    });
    exit(result.status ?? 1);
  }
  if (entrypoint === "sh" && rest[0] === "-c") {
    const result = spawnSync("sh", ["-c", mapPath(rest[1])], { stdio: "inherit", env });
    exit(result.status ?? 1);
  }
  exit(99);
}
process.stderr.write("fake docker: unsupported " + args.join(" ") + "\n");
exit(98);
`;

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

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-migrate-docker-"));
  const app = path.join(dir, "opt", "forwardx-docker");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, ".env"), `PORT=9912\nJWT_SECRET=${JWT}\nCOMPOSE_PROJECT_NAME=forwardx\nFORWARDX_CONTAINER_NAME=forwardx-panel\nFORWARDX_IMAGE=ghcr.io/poouo/forwardx:latest\n`);
  fs.writeFileSync(path.join(app, "docker-compose.yml"), "# 原版的 compose\nservices:\n  forwardx:\n    image: ${FORWARDX_IMAGE}\n");
  const volumes = path.join(dir, "volumes");
  const volume = path.join(volumes, "forwardx_forwardx-data");
  fs.mkdirSync(volume, { recursive: true });
  fs.writeFileSync(path.join(volume, "database.json"), JSON.stringify({ type: "sqlite", sqlite: { path: "/data/forwardx.db" } }));
  fs.writeFileSync(path.join(volume, "jwt.secret"), `${"c".repeat(64)}\n`);
  createForwardxUpstreamSqlite(path.join(volume, "forwardx.db"));
  const nexApp = path.join(dir, "nex-image-app");
  fs.mkdirSync(path.join(nexApp, "dist"), { recursive: true });
  fs.writeFileSync(path.join(nexApp, "dist", "migrate-forwardx.js"), "// 假镜像里有这个文件就行\n");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "fwxm"), "#!/bin/bash\n# ForwardX Manager: host-side management for Agent/local/Docker panel.\n", { mode: 0o755 });
  const fakeBin = path.join(dir, "fakebin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  const stateFile = path.join(dir, "docker-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    container: { image: OLD_IMAGE_ID, imageRef: "ghcr.io/poouo/forwardx:latest", running: true },
    oldImageId: OLD_IMAGE_ID,
    oldImageRef: "ghcr.io/poouo/forwardx:latest",
    newImage: NEW_IMAGE,
    volume: "forwardx_forwardx-data",
  }));
  return { dir, app, volume, bin, fakeBin, stateFile, nexApp, volumes };
}

function script(box: ReturnType<typeof sandbox>, action: string) {
  return [
    "set -euo pipefail",
    `APP_DIR=${JSON.stringify(box.app)}`,
    'PROJECT_NAME="forwardx"',
    'CONTAINER_NAME="forwardx-panel"',
    'EXPLICIT_PORT=""',
    'PORT="9810"',
    'ACTION="migrate-forwardx"',
    'GITHUB_ACCELERATOR_URL=""',
    'SCRIPT_STARTED_AT="$(date +%s)"',
    "PANEL_STEP_TOTAL=4",
    'ASSUME_YES="${TEST_ASSUME_YES:-true}"',
    'TARGET_DB_CONFIG=""',
    'ROLLBACK_BACKUP_DIR=""',
    'RESOLVED_IMAGE=""',
    'EXPECTED_PANEL_VERSION=""',
    `PANEL_FWXM_LINK=${JSON.stringify(path.join(box.bin, "fwxm"))}`,
    `FORWARDX_MIGRATION_MARKER=${JSON.stringify(path.join(box.dir, "etc", "nex", "forwardx-migration.last"))}`,
    extractFunctions(installer, [
      "valid_port", "get_env_value", "panel_step", "elapsed_seconds", "confirm_yes", "compose_cmd",
      "get_compose_host_port", "get_container_host_port", "load_existing_env", "data_volume_name", "panel_container_ids", "panel_data_volume_names",
      "remove_existing_panel_containers", "write_compose_file", "write_env",
      "forwardx_image_kind", "manifest_value", "backup_forwardx_fwxm", "wait_docker_panel_ready", "forwardx_docker_cli",
      "rollback_forwardx_docker", "migrate_forwardx_docker", "rollback_forwardx_docker_action",
    ]),
    "require_root() { :; }",
    "resolve_github_accelerator() { :; }",
    "install_docker() { :; }",
    `resolve_image_selection() { RESOLVED_IMAGE=${JSON.stringify(NEW_IMAGE)}; EXPECTED_PANEL_VERSION="2.3.527"; }`,
    'install_panel_manager_from_github() { echo "[test] install_panel_manager_from_github"; }',
    action,
  ].join("\n");
}

function run(box: ReturnType<typeof sandbox>, action: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script(box, action)], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${box.fakeBin}:${process.env.PATH}`,
      FORWARDX_MIGRATE_READY_TIMEOUT: "2",
      FAKE_DOCKER_STATE: box.stateFile,
      FAKE_DOCKER_VOLUMES: box.volumes,
      FAKE_DOCKER_LOG: path.join(box.dir, "docker.log"),
      FAKE_DOCKER_HEALTHY: path.join(box.dir, "healthy"),
      FAKE_REPO_ROOT: root,
      FAKE_NEX_APP: box.nexApp,
      ...env,
    },
    timeout: 240_000,
  });
}

function backupDirOf(box: ReturnType<typeof sandbox>) {
  const parent = path.dirname(box.app);
  const found = fs.readdirSync(parent).filter((name) => name.startsWith("forwardx-docker.forwardx-backup-"));
  assert.equal(found.length, 1, found.join(","));
  return path.join(parent, found[0]);
}

test("migrate-forwardx（Docker）：数据卷和配置先备份、原版镜像打标签，导进新库后换 NEX 容器；rollback-forwardx 换回原版", () => {
  const box = sandbox();
  try {
    const sourceHash = sha256(path.join(box.volume, "forwardx.db"));
    fs.writeFileSync(path.join(box.dir, "healthy"), "1");
    const migrated = run(box, "migrate_forwardx_docker");
    assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
    assert.match(migrated.stdout, /检测到原版 ForwardX 面板：容器 forwardx-panel，镜像 ghcr\.io\/poouo\/forwardx:latest，版本 2\.3\.299/);
    assert.match(migrated.stdout, /\[DONE\] 已从原版 ForwardX 2\.3\.299 迁到 NEX/);
    const backup = backupDirOf(box);
    assert.equal(sha256(path.join(backup, "data", "forwardx.db")), sourceHash, "备份里是原版的库，没被改过");
    assert.match(fs.readFileSync(path.join(backup, "compose", ".env"), "utf8"), /FORWARDX_IMAGE=ghcr\.io\/poouo\/forwardx:latest/);
    assert.match(fs.readFileSync(path.join(backup, "compose", "docker-compose.yml"), "utf8"), /原版的 compose/);
    const manifest = fs.readFileSync(path.join(backup, "manifest"), "utf8");
    assert.match(manifest, /^OLD_IMAGE_TAG=forwardx-migration-backup:\d+$/m);
    assert.match(manifest, /^VOLUME=forwardx_forwardx-data$/m);
    assert.ok(fs.existsSync(path.join(backup, "migration-report.json")));
    assert.ok(fs.existsSync(path.join(backup, "service", "fwxm.forwardx")));
    assert.equal(fs.existsSync(path.join(box.bin, "fwxm")), false);

    // 数据卷里换成了 NEX 的库，database.json 指向它，密钥文件还在
    assert.notEqual(sha256(path.join(box.volume, "forwardx.db")), sourceHash);
    assert.equal(fs.existsSync(path.join(box.volume, "forwardx.db.nex-import")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(box.volume, "database.json"), "utf8")), { type: "sqlite", sqlite: { path: "/data/forwardx.db" } });
    assert.ok(fs.existsSync(path.join(box.volume, "jwt.secret")));
    const check = spawnSync(process.execPath, ["-e", `
      const Database = require("better-sqlite3");
      const db = new Database(process.argv[1], { readonly: true });
      console.log(JSON.stringify(db.prepare('SELECT id, "agentToken" AS t FROM hosts ORDER BY id').all()));
    `, path.join(box.volume, "forwardx.db")], { cwd: root, encoding: "utf8" });
    assert.deepEqual(JSON.parse(check.stdout), [{ id: 10, t: "tok-entry" }, { id: 11, t: "tok-exit" }]);
    const env = fs.readFileSync(path.join(box.app, ".env"), "utf8");
    assert.match(env, new RegExp(`^FORWARDX_IMAGE=${NEW_IMAGE.replace(/[/.:]/g, "\\$&")}$`, "m"));
    assert.match(env, /^PORT=9912$/m, "端口沿用原版的");
    assert.match(env, new RegExp(`^JWT_SECRET=${JWT}$`, "m"));
    const state = JSON.parse(fs.readFileSync(box.stateFile, "utf8"));
    assert.equal(state.container.image, "sha256:new");
    const log = fs.readFileSync(path.join(box.dir, "docker.log"), "utf8");
    assert.ok(log.indexOf("docker stop forwardx-panel") < log.indexOf("dist/migrate-forwardx.js import"), "先停原版再导");

    const rolledBack = run(box, "rollback_forwardx_docker_action");
    assert.equal(rolledBack.status, 0, `${rolledBack.stdout}\n${rolledBack.stderr}`);
    assert.equal(sha256(path.join(box.volume, "forwardx.db")), sourceHash, "数据卷还原成原版的库");
    assert.match(fs.readFileSync(path.join(box.app, ".env"), "utf8"), /FORWARDX_IMAGE=ghcr\.io\/poouo\/forwardx:latest/);
    assert.match(fs.readFileSync(path.join(box.app, "docker-compose.yml"), "utf8"), /原版的 compose/);
    assert.match(fs.readFileSync(path.join(box.bin, "fwxm"), "utf8"), /ForwardX Manager/);
    const after = JSON.parse(fs.readFileSync(box.stateFile, "utf8"));
    assert.equal(after.container.image, OLD_IMAGE_ID, "用备份时打的标签起原版镜像");
    assert.match(after.container.imageRef, /^forwardx-migration-backup:/);
  } finally {
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test("migrate-forwardx（Docker）：NEX 容器起不来就自动回退；没确认时什么都不动", () => {
  const box = sandbox();
  try {
    const sourceHash = sha256(path.join(box.volume, "forwardx.db"));
    const cancelled = run(box, "migrate_forwardx_docker", { TEST_ASSUME_YES: "false" });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.match(cancelled.stdout, /已取消，原版面板没有改动/);
    assert.equal(JSON.parse(fs.readFileSync(box.stateFile, "utf8")).container.running, true);
    assert.equal(fs.readdirSync(path.dirname(box.app)).some((name) => name.includes("forwardx-backup")), false);

    // 不放 healthy：NEX 容器一直不健康
    const migrated = run(box, "migrate_forwardx_docker");
    assert.equal(migrated.status, 1, `${migrated.stdout}\n${migrated.stderr}`);
    assert.match(migrated.stdout, /自动回退到原版 ForwardX/);
    assert.match(migrated.stdout, /已回到原版 ForwardX/);
    assert.equal(sha256(path.join(box.volume, "forwardx.db")), sourceHash);
    assert.match(fs.readFileSync(path.join(box.app, ".env"), "utf8"), /FORWARDX_IMAGE=ghcr\.io\/poouo\/forwardx:latest/);
    const state = JSON.parse(fs.readFileSync(box.stateFile, "utf8"));
    assert.equal(state.container.image, OLD_IMAGE_ID);
    assert.equal(state.container.running, true);
  } finally {
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});
