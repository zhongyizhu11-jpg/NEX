import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  scripts/verify-vless-egress.mjs 是 VLESS Reality 出口（含 UDP）的真二进制端到端验证。CI 上没有 gost 运行时和
  sing-box，跑不了数据路径，但两件事要守住：
    - 不给二进制时它打印 SKIP、退出码 0（不能因为缺二进制把 CI 判红，也不能悄悄什么都没说）；
    - 它用面板真实代码路径生成配置那一半（--generate-only）一直能跑通：接口、心跳改了形状时这里先红，
      而不是等到有人拿真二进制验的时候才发现脚本本身坏了。
*/
const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "verify-vless-egress.mjs");

test("没给二进制时打印 SKIP、退出码 0", () => {
  const env = { ...process.env };
  delete env.GOST_BIN;
  delete env.SING_BOX_BIN;
  delete env.REQUIRE_BINARIES;
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", env, timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^SKIP verify-vless-egress: GOST_BIN, SING_BOX_BIN/m);
});

test("面板代码生成的 UDP / TCP 出口配置形状对（--generate-only，不需要二进制）", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-vless-verify-test-"));
  try {
    const result = spawnSync(process.execPath, [script, "--generate-only", directory], { cwd: root, encoding: "utf8", timeout: 240_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^RESULT generated-configs ok /m);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
