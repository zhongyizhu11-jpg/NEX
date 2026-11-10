import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/*
  scripts/decrypt-backup.mjs 是「面板没了也能解开备份」的那条退路：它不引用仓库里任何别的文件，
  所以面板这边的加密（server/migration.ts 的 encryptMigrationSnapshot）一旦改了格式而忘了改它，
  平时没有任何地方会报错 —— 直到真的要用的那一天。这里拿面板加密出来的文件喂给它，守住这一点。

  脚本是另起一个 node 进程跑的（不带 tsx），和用户在一台只有 Node 的机器上跑是同一回事。
*/

const script = path.resolve(import.meta.dirname, "decrypt-backup.mjs");
const PASSPHRASE = "口令 with spaces & 符号 #1";
const snapshot = {
  version: 1 as const,
  exportedAt: Date.UTC(2026, 9, 4, 4, 0),
  appVersion: "test",
  tables: {
    users: [{ id: 1, username: "admin", role: "admin" }],
    hosts: [{ id: 7, name: "东京 1", agentToken: "host-token-明文" }],
    system_settings: [{ key: "siteTitle", value: "NEX" }],
  },
};

let directory = "";
let backupFile = "";
let encryptedText = "";

function run(args: string[], passphrase: string | undefined, input?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NEX_BACKUP_PASSPHRASE;
  delete env.NODE_OPTIONS;
  if (passphrase !== undefined) env.NEX_BACKUP_PASSPHRASE = passphrase;
  return spawnSync(process.execPath, [script, ...args], { env, input, encoding: "utf8", timeout: 30_000 });
}

before(async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const { encryptMigrationSnapshot } = await import("../server/migration");
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-decrypt-"));
  backupFile = path.join(directory, "nex-backup-20261004-0400.fwxbak");
  const encrypted = encryptMigrationSnapshot(snapshot as Parameters<typeof encryptMigrationSnapshot>[0], PASSPHRASE);
  encryptedText = JSON.stringify(encrypted);
  fs.writeFileSync(backupFile, encryptedText);
});

after(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test("备份文件头带版本、算法和盐，正文是密文", () => {
  const header = JSON.parse(encryptedText);
  assert.equal(header.format, "forwardx-panel-backup");
  assert.equal(header.version, 1);
  assert.equal(header.cipher, "aes-256-gcm");
  assert.equal(header.kdf.name, "scrypt");
  assert.equal(Buffer.from(header.kdf.salt, "base64").length, 16);
  assert.equal(Buffer.from(header.iv, "base64").length, 12);
  assert.ok(!encryptedText.includes("host-token-明文") && !encryptedText.includes("admin"));
});

test("同一个口令加密两次，盐和密文都不一样", async () => {
  const { encryptMigrationSnapshot } = await import("../server/migration");
  const again = encryptMigrationSnapshot(snapshot as Parameters<typeof encryptMigrationSnapshot>[0], PASSPHRASE);
  const first = JSON.parse(encryptedText);
  assert.notEqual(again.kdf.salt, first.kdf.salt);
  assert.notEqual(again.data, first.data);
});

test("面板加密、面板解密：往返一致；口令不对、文件被改过都解不开", async () => {
  const { decryptMigrationSnapshotBackup } = await import("../server/migration");
  assert.deepEqual(decryptMigrationSnapshotBackup(encryptedText, PASSPHRASE), snapshot);
  assert.throws(() => decryptMigrationSnapshotBackup(encryptedText, `${PASSPHRASE} `), /备份密码错误或备份文件已损坏/);
  const tampered = JSON.parse(encryptedText);
  const data = Buffer.from(tampered.data, "base64");
  data[0] ^= 1;
  tampered.data = data.toString("base64");
  assert.throws(() => decryptMigrationSnapshotBackup(JSON.stringify(tampered), PASSPHRASE), /备份密码错误或备份文件已损坏/);
});

test("独立脚本：口令从环境变量读，解出来和面板导出的一模一样，文件只有自己能读", () => {
  const output = path.join(directory, "env.json");
  const result = run([backupFile, output], PASSPHRASE);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), snapshot);
  assert.match(result.stdout, /users 1/);
  assert.match(result.stdout, /2026-10-04T04:00:00/);
  if (process.platform !== "win32") assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});

test("独立脚本：没设环境变量时从标准输入读口令，默认输出到同名 .json", () => {
  const result = run([backupFile], undefined, `${PASSPHRASE}\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(backupFile.replace(/\.fwxbak$/, ".json"), "utf8")), snapshot);
});

test("独立脚本：口令不对时报错退出，不留下输出文件", () => {
  const output = path.join(directory, "wrong.json");
  const result = run([backupFile, output], "not the passphrase");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /口令不对，或者备份文件已损坏/);
  assert.ok(!fs.existsSync(output));
});

test("独立脚本：输出文件已存在就不覆盖；不是备份文件就说不是", () => {
  const output = path.join(directory, "exists.json");
  fs.writeFileSync(output, "keep");
  const result = run([backupFile, output], PASSPHRASE);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /已经存在/);
  assert.equal(fs.readFileSync(output, "utf8"), "keep");

  const notBackup = path.join(directory, "plain.json");
  fs.writeFileSync(notBackup, JSON.stringify({ hello: "world" }));
  const other = run([notBackup, path.join(directory, "plain-out.json")], PASSPHRASE);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /不是 NEX 的加密备份/);
});
