import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * macOS 自带的 bash 3.2 会把紧跟在变量名后面的多字节字符（中文、全角标点）算进变量名：
 * `$SERVICE_NAME）` 读的是一个叫「SERVICE_NAME）」的变量，开了 set -u 就直接报 unbound variable 退出。
 * Linux 上的 bash 4/5 没这个问题，所以只在 iOS 构建（macOS runner）跑测试时才红过。
 * 仓库里所有 .sh 都按这一条查：变量后面紧跟非 ASCII 字符时写成 ${NAME}。
 */
test("所有 .sh：变量后面紧跟中文时要加花括号（bash 3.2 会把多字节字符吞进变量名）", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const files = execFileSync("git", ["ls-files", "*.sh"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.ok(files.length > 0);
  const offenders: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
