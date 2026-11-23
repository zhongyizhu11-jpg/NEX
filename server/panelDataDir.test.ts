import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalPath, panelDataDir } from "./env";

/*
  macOS 上 os.tmpdir() 给的是 /var/folders/...，真实路径是 /private/var/folders/...。
  缓存路径要和 process.cwd()（chdir 后是真实路径）、fs.realpathSync 比对，所以数据目录要先解掉符号链接；
  目录还不存在时也得能解（解到最近的已存在祖先）。
*/
test("panelDataDir 跟 SQLITE_PATH 走，并解掉路径里的符号链接", () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "nex-datadir-"));
  const link = `${real}-link`;
  fs.symlinkSync(real, link, "dir");
  try {
    const expected = fs.realpathSync(real);
    assert.equal(panelDataDir({ SQLITE_PATH: path.join(link, "data", "forwardx.db") }), path.join(expected, "data"), "data/ 还不存在也能解到真实路径");
    fs.mkdirSync(path.join(real, "data"));
    assert.equal(panelDataDir({ SQLITE_PATH: path.join(link, "data", "forwardx.db") }), path.join(expected, "data"));
    assert.equal(canonicalPath(path.join(link, "a", "b", "c")), path.join(expected, "a", "b", "c"));
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("没有 SQLITE_PATH 时按平台默认，不存在的根也不报错", () => {
  const dir = panelDataDir({});
  assert.ok(path.isAbsolute(dir));
  assert.match(dir, process.platform === "win32" ? /data$/ : /^\/data$/);
});
