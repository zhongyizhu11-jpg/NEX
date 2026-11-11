#!/usr/bin/env node
/*
  不依赖面板，把 NEX 的加密备份（.fwxbak，手动导出的和异地自动备份的是同一种）解成明文 JSON。

  面板机器整台没了、又暂时装不了新面板时用：只要有 Node（16 以上）和备份口令就行，
  这个文件不引用仓库里别的任何东西，单独拷走就能跑。正常恢复不需要它 —— 装好新面板，
  到「系统设置 › 备份恢复」里导入 .fwxbak 并输入口令即可。

    node decrypt-backup.mjs <备份文件.fwxbak> [输出文件.json]

  口令从环境变量 NEX_BACKUP_PASSPHRASE 读；没设就在终端里问（不回显）。不接受写在命令行参数里：
  那样会留在 shell 历史和进程列表里。

  解出来的文件里是全部主机 Token、用户密码哈希、各种密钥的明文，看完请删掉。

  ── 文件格式（和 server/migration.ts 的 encryptMigrationSnapshot 一致）──
  一个 JSON：format = "forwardx-panel-backup"、version = 1、cipher = "aes-256-gcm"，
  kdf = { name: "scrypt", salt(base64), keyLength: 32, cost(N), blockSize(r), parallelization(p) }，
  iv / tag / data 都是 base64。密钥 = scrypt(口令, salt, 32, { N, r, p })，
  明文 = AES-256-GCM 解密 data（iv 12 字节，tag 是认证标签），解出来是导出快照的 JSON。
*/
import { createDecipheriv, scryptSync } from "node:crypto";
import fs from "node:fs";
import process from "node:process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** 在终端里问口令，输入不回显。不是终端（管道）时就按行读标准输入。 */
function askPassphrase() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write("备份口令：");
    if (!stdin.isTTY) {
      let text = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => { text += chunk; });
      stdin.on("end", () => resolve(text.replace(/\r?\n$/, "")));
      return;
    }
    let text = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(text);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function decryptBackup(rawContent, passphrase) {
  let backup;
  try {
    backup = JSON.parse(rawContent);
  } catch {
    throw new Error("这不是 NEX 的备份文件（不是 JSON）");
  }
  if (backup?.format !== "forwardx-panel-backup" || backup.version !== 1 || backup.encrypted !== true) {
    throw new Error("这不是 NEX 的加密备份，或者版本不认识");
  }
  if (backup.cipher !== "aes-256-gcm" || backup.kdf?.name !== "scrypt") {
    throw new Error(`不认识的加密方式：${backup.cipher} / ${backup.kdf?.name}`);
  }
  const N = Number(backup.kdf.cost);
  const r = Number(backup.kdf.blockSize);
  const p = Number(backup.kdf.parallelization);
  let plain;
  try {
    // maxmem 按参数算：scrypt 要 128·N·r 字节，Node 默认上限 32 MB，参数以后调大了也不至于跑不了。
    const key = scryptSync(String(passphrase), Buffer.from(backup.kdf.salt, "base64"), 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(backup.iv, "base64"));
    decipher.setAuthTag(Buffer.from(backup.tag, "base64"));
    plain = Buffer.concat([decipher.update(Buffer.from(backup.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("口令不对，或者备份文件已损坏");
  }
  return { header: backup, plain };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || args[0] === "-h" || args[0] === "--help") {
    fail("用法：node decrypt-backup.mjs <备份文件.fwxbak> [输出文件.json]\n口令从环境变量 NEX_BACKUP_PASSPHRASE 读，没设就在终端里问。");
  }
  const input = args[0];
  const output = args[1] || `${input.replace(/\.fwxbak$/i, "")}.json`;
  if (!fs.existsSync(input)) fail(`找不到文件：${input}`);
  if (fs.existsSync(output)) fail(`${output} 已经存在，换个输出文件名，或者先删掉它`);
  const raw = fs.readFileSync(input, "utf8");
  const passphrase = process.env.NEX_BACKUP_PASSPHRASE || await askPassphrase();
  let result;
  try {
    result = decryptBackup(raw, passphrase);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  // 只让自己读：里面是全部密钥的明文。
  fs.writeFileSync(output, result.plain, { mode: 0o600, flag: "wx" });
  let tables = {};
  try {
    tables = JSON.parse(result.plain).tables || {};
  } catch {
    // 解密成功但内容不是预期的 JSON：照样写出去，让人自己看。
  }
  const exportedAt = Number(result.header.exportedAt) > 0 ? new Date(Number(result.header.exportedAt)).toISOString() : "未知";
  console.log(`已解密到 ${output}`);
  console.log(`导出时间 ${exportedAt}，面板版本 ${result.header.appVersion || "未知"}`);
  const counts = Object.entries(tables)
    .filter(([, rows]) => Array.isArray(rows) && rows.length > 0)
    .map(([name, rows]) => `${name} ${rows.length}`);
  if (counts.length > 0) console.log(`各表行数：${counts.join("，")}`);
  console.log("里面是全部主机 Token 和密钥的明文，用完请删掉。");
}

await main();
