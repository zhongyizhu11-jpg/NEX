import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { maskWebhookHeaders, resolvePanelSslKeyPem } from "./settingsSecrets";

test("webhook 请求头只回打码后的样子，两种写法都认", () => {
  assert.equal(maskWebhookHeaders(""), "");
  assert.equal(maskWebhookHeaders(null), "");
  const json = maskWebhookHeaders('{"Authorization":"Bearer super-secret-token-123","X-Short":"abc"}');
  assert.equal(json, "Authorization: Bear******23\nX-Short: a******");
  assert.doesNotMatch(json, /super-secret/);
  const lines = maskWebhookHeaders("Authorization: Bearer super-secret-token-123\nX-Api-Key: k3y-value-0000");
  assert.equal(lines, "Authorization: Bear******23\nX-Api-Key: k3y-******00");
  assert.equal(maskWebhookHeaders("garbage without colon"), "（已保存）");
});

test("保存面板 SSL：私钥框留空沿用已保存的，粘贴了新私钥就替换，证书也清空才一起删", () => {
  const stored = "-----BEGIN PRIVATE KEY-----\nold\n-----END PRIVATE KEY-----";
  const cert = "-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----";
  assert.equal(resolvePanelSslKeyPem({ certPem: cert, keyPem: "" }, stored), stored);
  assert.equal(resolvePanelSslKeyPem({ certPem: cert, keyPem: "  " }, stored), stored);
  assert.equal(resolvePanelSslKeyPem({ certPem: cert, keyPem: " new-key " }, stored), "new-key");
  assert.equal(resolvePanelSslKeyPem({ certPem: "", keyPem: "" }, stored), "");
  assert.equal(resolvePanelSslKeyPem({ certPem: cert, keyPem: "" }, ""), "");
});

const SETTINGS_SCRIPT = String.raw`
  import assert from "node:assert/strict";
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
  const runtime = await import(moduleUrl("server/dbRuntime.ts"));
  const schema = await import(moduleUrl("server/dbSchema.ts"));
  const db = await import(moduleUrl("server/db.ts"));
  const { systemRouter } = await import(moduleUrl("server/_core/systemRouter.ts"));
  const context = (extra = {}) => ({
    req: { headers: {}, secure: false, ip: "127.0.0.1", socket: {} },
    res: { clearCookie() {}, cookie() {} },
    user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
    authSession: null,
    authFailureReason: null,
    ...extra,
  });
  const caller = systemRouter.createCaller(context());
  const tokenCaller = systemRouter.createCaller(context({ apiToken: { id: 9, scope: "read", name: "ci" } }));
  const key = ["-----BEGIN PRIVATE KEY-----", "secret-key-body", "-----END PRIVATE KEY-----"].join("\n");
  const cert = ["-----BEGIN CERTIFICATE-----", "cert-body", "-----END CERTIFICATE-----"].join("\n");
  const headers = '{"Authorization":"Bearer webhook-secret-123456"}';
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    await db.setSettings({ panelSslEnabled: "false", panelSslMode: "path", panelSslCertPem: cert, panelSslKeyPem: key, ddnsWebhookHeaders: headers });

    for (const settings of [await caller.getSettings(), await tokenCaller.getSettings()]) {
      assert.equal(settings.panelSsl.keyPem, "");
      assert.equal(settings.panelSsl.keyPemConfigured, true);
      assert.equal(settings.panelSsl.certPem, cert);
      assert.equal(settings.ddns.webhookHeaders, "");
      assert.match(settings.ddns.webhookHeadersMasked, /^Authorization: Bear\*+56$/);
      assert.doesNotMatch(JSON.stringify(settings), /secret-key-body|webhook-secret/);
    }

    assert.equal((await caller.revealPanelSslKey()).keyPem, key);
    // 令牌调 system.revealPanelSslKey 被禁止名单拦下，见 server/ops/apiTokenPolicy.test.ts。

    // 设置页回存：私钥框是空的、请求头框是空的，都不该把已保存的冲掉。
    await caller.updatePanelSsl({ enabled: false, mode: "path", certPath: "", keyPath: "", certPem: cert, keyPem: "", confirmed: true });
    assert.equal(await db.getSetting("panelSslKeyPem"), key);
    await caller.updateSettings({ ddns: { webhookUrl: "https://ddns.example.com/hook", webhookHeaders: "" } });
    assert.equal(await db.getSetting("ddnsWebhookHeaders"), headers);
    await caller.updateSettings({ ddns: { webhookHeaders: "X-Token: replaced" } });
    assert.equal(await db.getSetting("ddnsWebhookHeaders"), "X-Token: replaced");
    await caller.updateSettings({ ddns: { clearWebhookHeaders: true } });
    assert.equal(await db.getSetting("ddnsWebhookHeaders"), null);

    // 证书和私钥一起清空才删私钥。
    await caller.updatePanelSsl({ enabled: false, mode: "path", certPath: "", keyPath: "", certPem: "", keyPem: "", confirmed: true });
    assert.equal(await db.getSetting("panelSslKeyPem"), null);
    assert.equal((await caller.getSettings()).panelSsl.keyPemConfigured, false);
  } finally {
    await runtime.closeDatabase();
  }
`;

test("system.getSettings 不再带出私钥和请求头原文；查看私钥只给管理员；保存时不带回也不会被冲掉", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-settings-secrets-"));
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", SETTINGS_SCRIPT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_TYPE: "sqlite",
      FORWARDX_TEST_DB: path.join(directory, "settings.db"),
      JWT_SECRET: "settings-secrets-test",
      NODE_ENV: "test",
    },
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
