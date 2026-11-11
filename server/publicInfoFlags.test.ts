import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 规则、隧道、组、主机页原来为了几个开关拉整份 system.getSettings，现在从 publicInfo 读。
 * 这里守两件事：
 *   · publicInfo 给的值和 getSettings 里对应字段一致（协议开关、面板公开地址、专属域名、Telegram、DDNS、向导）；
 *   · 只对管理员有意义的开关（adminFlags）只给管理员，普通用户和未登录都是 null —— 和他们从 getSettings 读到的 false 一样。
 */

function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-public-info-flags-"));
  const databasePath = path.join(directory, "flags.db");
  const logDirectory = path.join(directory, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const script = String.raw`
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const now = Math.floor(Date.now() / 1000);
    for (const [key, value] of [
      ["panelPublicUrl", "https://panel.example.com"],
      ["forwardProtocols", JSON.stringify({ nginx_stream: false })],
      ["telegramBotEnabled", "true"],
      ["telegramBotToken", "123456:abcdef"],
      ["ddnsEnabled", "true"],
      ["ddnsProvider", "webhook"],
      ["linkWizardEnabled", "true"],
    ]) {
      await exec("INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value, now]);
    }
    const { systemRouter } = await import(url("server/_core/systemRouter.ts"));
    const context = (user) => ({ req: { headers: {}, secure: false }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
    const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
    const alice = { id: 2, username: "alice", role: "user", accountEnabled: true };
    const out = {};
    for (const [name, user] of [["admin", admin], ["user", alice], ["anonymous", null]]) {
      const caller = systemRouter.createCaller(context(user));
      const info = await caller.publicInfo();
      const settings = await caller.getSettings();
      out[name] = {
        info: {
          panelPublicUrl: info.panelPublicUrl,
          forwardProtocols: info.forwardProtocols,
          ruleEntryDomainActive: info.ruleEntryDomainActive,
          adminFlags: info.adminFlags,
        },
        settings: {
          panelPublicUrl: settings.panelPublicUrl,
          forwardProtocols: settings.forwardProtocols,
          ruleEntryDomainActive: settings.ddns.ruleEntryDomainActive,
          telegramBotReady: !!settings.telegram.enabled && !!settings.telegram.configured,
          ddnsEnabled: !!settings.ddns.enabled && settings.ddns.provider !== "disabled",
          ddnsProvider: settings.ddns.provider,
          linkWizardEnabled: !!settings.linkWizardEnabled,
        },
      };
    }
    console.log("OUTCOME " + JSON.stringify(out));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: logDirectory, TELEGRAM_BOT_TOKEN: "" },
    timeout: 120_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("OUTCOME "));
  assert.ok(line, `没拿到结果：\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("OUTCOME ".length));
}

test("publicInfo 的开关和 getSettings 一致，管理员才有的开关只给管理员", () => {
  const outcome = run();
  for (const name of ["admin", "user", "anonymous"]) {
    const { info, settings } = outcome[name];
    assert.equal(info.panelPublicUrl, settings.panelPublicUrl, name);
    assert.deepEqual(info.forwardProtocols, settings.forwardProtocols, name);
    assert.equal(info.ruleEntryDomainActive, settings.ruleEntryDomainActive, name);
  }
  assert.equal(outcome.admin.info.panelPublicUrl, "https://panel.example.com");
  assert.equal(outcome.admin.info.forwardProtocols.nginx_stream, false);
  assert.deepEqual(outcome.admin.info.adminFlags, {
    telegramBotReady: outcome.admin.settings.telegramBotReady,
    ddnsEnabled: outcome.admin.settings.ddnsEnabled,
    // 只有服务商名字（多公网 IP 那块按服务商写说明），密钥之类的不在这里
    ddnsProvider: outcome.admin.settings.ddnsProvider,
    linkWizardEnabled: outcome.admin.settings.linkWizardEnabled,
  });
  assert.deepEqual(outcome.admin.info.adminFlags, { telegramBotReady: true, ddnsEnabled: true, ddnsProvider: "webhook", linkWizardEnabled: true });
  for (const name of ["user", "anonymous"]) {
    assert.equal(outcome[name].info.adminFlags, null, name);
    assert.equal(outcome[name].settings.telegramBotReady, false, name);
    assert.equal(outcome[name].settings.ddnsEnabled, false, name);
    assert.equal(outcome[name].settings.linkWizardEnabled, false, name);
  }
});
