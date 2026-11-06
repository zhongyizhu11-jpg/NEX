import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createStringCipher, isSealedSecret } from "./ipChange/secrets";
import {
  decodeStoredSettingValue,
  decryptSettingRowsForExport,
  encodeSettingValueForStorage,
  setSettingsCipherSecretForTests,
  undecryptableSecretSettingLabels,
} from "./settingsEncryption";
import { isSecretSettingKey } from "./settingsSecretKeys";

test("字符串加密：往返一致，每次密文不同，换密钥解不开，没前缀的原样返回", () => {
  const cipher = createStringCipher("panel-secret-a", "unit-test");
  const sealed = cipher.encrypt("smtp-p@ss");
  assert.ok(isSealedSecret(sealed));
  assert.notEqual(sealed, cipher.encrypt("smtp-p@ss"), "随机 IV：同一明文每次密文不同");
  assert.equal(cipher.decrypt(sealed), "smtp-p@ss");
  assert.equal(cipher.decrypt("plain-old-value"), "plain-old-value");
  assert.throws(() => createStringCipher("panel-secret-b", "unit-test").decrypt(sealed), /无法解密/);
  assert.throws(() => createStringCipher("panel-secret-a", "other-info").decrypt(sealed), /无法解密/, "info 不同派生出另一把密钥");
});

test("设置编码：只加密名单里的键，空值和已经是密文的不动", () => {
  setSettingsCipherSecretForTests("panel-secret-a");
  try {
    assert.ok(isSecretSettingKey("emailPassword"));
    assert.ok(isSecretSettingKey("ops.backup.s3.secretKey"));
    assert.equal(isSecretSettingKey("siteTitle"), false);

    const stored = encodeSettingValueForStorage("emailPassword", "hunter2");
    assert.ok(stored && isSealedSecret(stored));
    assert.equal(encodeSettingValueForStorage("emailPassword", stored), stored, "已经是密文不再套一层");
    assert.equal(encodeSettingValueForStorage("emailPassword", ""), "");
    assert.equal(encodeSettingValueForStorage("emailPassword", null), null);
    assert.equal(encodeSettingValueForStorage("siteTitle", "NEX"), "NEX");

    assert.equal(decodeStoredSettingValue("emailPassword", stored), "hunter2");
    assert.equal(decodeStoredSettingValue("emailPassword", "legacy-plain"), "legacy-plain", "升级前的明文原样读");
    assert.equal(decodeStoredSettingValue("siteTitle", "NEX"), "NEX");
  } finally {
    setSettingsCipherSecretForTests(null);
  }
});

test("换了面板密钥：解不开的按空值处理并记下来，重新保存后消失", () => {
  setSettingsCipherSecretForTests("panel-secret-a");
  const stored = encodeSettingValueForStorage("telegramBotToken", "123:abc") as string;
  setSettingsCipherSecretForTests("panel-secret-b");
  try {
    assert.equal(decodeStoredSettingValue("telegramBotToken", stored), "");
    assert.deepEqual(undecryptableSecretSettingLabels(), ["Telegram 机器人 Token"]);
    encodeSettingValueForStorage("telegramBotToken", "456:def");
    assert.deepEqual(undecryptableSecretSettingLabels(), []);
  } finally {
    setSettingsCipherSecretForTests(null);
  }
});

test("导出：密钥类值换成明文，别的行原样，不改原对象", () => {
  setSettingsCipherSecretForTests("panel-secret-a");
  try {
    const sealed = encodeSettingValueForStorage("googleClientSecret", "g-secret") as string;
    const rows = [
      { key: "googleClientSecret", value: sealed, updatedAt: 1 },
      { key: "siteTitle", value: "NEX", updatedAt: 2 },
    ];
    const exported = decryptSettingRowsForExport(rows);
    assert.deepEqual(exported, [
      { key: "googleClientSecret", value: "g-secret", updatedAt: 1 },
      { key: "siteTitle", value: "NEX", updatedAt: 2 },
    ]);
    assert.equal(rows[0].value, sealed);
  } finally {
    setSettingsCipherSecretForTests(null);
  }
});

/*
  在真的 SQLite 上走一遍：设置页读写透明、库里是密文、升级迁移只跑一次，
  以及「面板 A 导出 → 面板 B（另一把密钥）导入」之后新面板读得出来、库里是 B 的密文。
*/
test("SQLite：透明读写、升级迁移、跨面板导出导入", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const repo = await import("./repositories/settingsRepository");
  const { exportMigrationSnapshot, importMigrationSnapshot } = await import("./migration");
  const { SETTINGS_SECRETS_MIGRATION_KEY } = await import("./settingsEncryption");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-settings-enc-"));
  const rawValue = async (key: string) => {
    const rows = await runtime.queryRaw<{ value: string | null }>("SELECT value FROM system_settings WHERE key = ?", [key]);
    return rows[0]?.value ?? null;
  };
  setSettingsCipherSecretForTests("panel-secret-a");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "a.db") } });
    await ensureDatabaseSchema();

    // 1. 透明读写
    await repo.setSetting("emailPassword", "smtp-secret");
    await repo.setSetting("siteTitle", "Panel A");
    assert.ok(isSealedSecret(await rawValue("emailPassword")), "库里是密文");
    assert.equal(await rawValue("siteTitle"), "Panel A", "非密钥设置照旧明文");
    assert.equal(await repo.getSetting("emailPassword"), "smtp-secret");
    assert.equal((await repo.getAllSettings()).emailPassword, "smtp-secret");
    await repo.setSetting("ops.backup.s3.secretKey", "s3-secret");
    assert.equal((await repo.getSettingsByPrefix("ops.backup."))["ops.backup.s3.secretKey"], "s3-secret");

    // 2. 升级迁移：直接塞两条老明文，迁移加密掉，再跑一次什么都不做
    const now = Math.floor(Date.now() / 1000);
    await runtime.executeRaw("INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, ?)", ["telegramBotToken", "111:legacy", now]);
    await runtime.executeRaw("INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, ?)", ["paymentConfig", "{\"stripe\":{\"secretKey\":\"sk\"}}", now]);
    repo.invalidateAllSettingsCache();
    assert.equal(await repo.getSetting("telegramBotToken"), "111:legacy", "迁移前明文照样读得出来");
    assert.equal(await repo.migrateSecretSettingsToEncrypted(), 2);
    assert.ok(isSealedSecret(await rawValue("telegramBotToken")));
    assert.ok(isSealedSecret(await rawValue("paymentConfig")));
    assert.equal(await repo.getSetting("paymentConfig"), "{\"stripe\":{\"secretKey\":\"sk\"}}");
    assert.ok(await repo.getSetting(SETTINGS_SECRETS_MIGRATION_KEY), "记下做过了");
    assert.equal(await repo.migrateSecretSettingsToEncrypted(), 0, "第二次不再扫");
    assert.equal(await repo.migrateSecretSettingsToEncrypted({ force: true }), 0, "强制再跑：全是密文，什么也不改");
    assert.equal(await repo.getSetting(SETTINGS_SECRETS_MIGRATION_KEY), repo.secretSettingKeysSignature(), "记的是名单指纹");
    // 名单以后变了（这里模拟成旧版本留下的记号）：下一次启动会重新扫，把还没加密的新键加密掉
    await runtime.executeRaw("INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, ?)", ["discordBotToken", "legacy-discord", now]);
    await repo.setSetting(SETTINGS_SECRETS_MIGRATION_KEY, "1793900000");
    assert.equal(await repo.migrateSecretSettingsToEncrypted(), 1, "记号和名单对不上：再扫一遍");
    assert.ok(isSealedSecret(await rawValue("discordBotToken")));

    // 3. 导出是明文
    const snapshot = await exportMigrationSnapshot();
    const exportedRows = snapshot.tables.system_settings as Array<{ key: string; value: string | null }>;
    const exported = Object.fromEntries(exportedRows.map((row) => [row.key, row.value]));
    assert.equal(exported.emailPassword, "smtp-secret");
    assert.equal(exported.telegramBotToken, "111:legacy");

    // 4. 导入到另一台面板（空库、另一把密钥）
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "b.db") } });
    await ensureDatabaseSchema();
    setSettingsCipherSecretForTests("panel-secret-b");
    repo.invalidateAllSettingsCache();
    await importMigrationSnapshot(snapshot, { targetPanelUrl: "https://panel-b.example.com" });
    repo.invalidateAllSettingsCache();
    assert.equal(await repo.getSetting("emailPassword"), "smtp-secret", "新面板读得出来");
    assert.equal(await repo.getSetting("telegramBotToken"), "111:legacy");
    const storedOnB = await rawValue("emailPassword");
    assert.ok(isSealedSecret(storedOnB), "新面板库里也是密文");
    setSettingsCipherSecretForTests("panel-secret-a");
    assert.equal(decodeStoredSettingValue("emailPassword", storedOnB), "", "是新面板自己的密钥加的密，旧密钥解不开");
  } finally {
    setSettingsCipherSecretForTests(null);
    await runtime.closeDatabase().catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
