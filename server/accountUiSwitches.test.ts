import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  Telegram 登录单独开关（关了所有 Telegram 登录过程都拒绝，绑定照旧）和按账号保存的界面偏好
  （auth.updateUiPreferences）在真实路由上走一遍，见 accountUiSwitches.fixture.ts。
*/
test("Telegram 登录开关关掉后登录过程一律拒绝、绑定照旧；界面偏好按项合并、清洗后落库", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-account-ui-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/accountUiSwitches.fixture.ts"], {
      encoding: "utf8", timeout: 90_000, windowsHide: true,
      env: {
        ...process.env,
        DATABASE_CONFIG_PATH: path.join(directory, "database.json"),
        DATABASE_TYPE: "sqlite",
        SQLITE_PATH: path.join(directory, "ui.db"),
        JWT_SECRET: "account-ui-fixture-secret-long-enough",
        FORWARDX_DEV_PANEL: "0",
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
        TELEGRAM_BOT_TOKEN: "",
      },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
