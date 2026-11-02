import test from "node:test";
import { runInDatabase as runSharedDatabaseTest } from "./testing/runInDatabase";

/**
 * 「一天只做一次」的日标记要能被清掉。
 *
 * 到期提醒、流量提醒、主机续费提醒、余额自动续费都会往 system_settings 里写一行
 * `<前缀>:<...>:<YYYY-MM-DD>` 防重复，写完从来没人删。五百人的面板跑一年能攒十万
 * 行，而 getAllSettings() 是整表读、几十处在调 —— 这些垃圾每次缓存过期都要重新
 * 加载一遍，面板越用越慢还找不到原因。
 *
 * 清理最怕的是误删：日期解析不出来的键一律不动，宁可留着垃圾也不能删掉真设置。
 */
const setup = String.raw`
    const settings = await import(url("server/repositories/settingsRepository.ts"));

    const dayString = (offsetDays) =>
      new Date(Date.now() - offsetDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
`;

function runInDatabase(body: string) {
  runSharedDatabaseTest(body, { name: "ephemeral", setup });
}

test("过期的日标记会被清掉，今天的留着", () => {
  runInDatabase(String.raw`
    await settings.setSetting("emailReminder:expiry:7:42:" + dayString(30), "sent");
    await settings.setSetting("telegramReminder:traffic:42:" + dayString(9), "sent");
    await settings.setSetting("autoRenew:7:" + dayString(8), "tried");
    // 今天的还在去重窗口里，删了就会重复发一次。
    await settings.setSetting("emailReminder:expiry:3:42:" + dayString(0), "sent");

    const pruned = await settings.pruneEphemeralSettings(7);
    assert.equal(pruned, 3);
    // 只数日标记：建表时本来就会写入一批默认设置，它们不该被算进来（也不该被删）。
    const left = (await query("SELECT key FROM system_settings"))
      .map((row) => String(row.key))
      .filter((key) => settings.isEphemeralSettingKey(key));
    assert.deepEqual(left, ["emailReminder:expiry:3:42:" + dayString(0)]);
  `);
});

test("真设置一根汗毛都不能动", () => {
  runInDatabase(String.raw`
    await settings.setSetting("panelPublicUrl", "https://panel.example.com");
    await settings.setSetting("storeEnabled", "true");
    // 名字里带日期、但不是日标记前缀的键，也不该被碰。
    await settings.setSetting("someBackupAt:2020-01-01", "keep me");
    await settings.setSetting("emailReminder:expiry:7:1:" + dayString(30), "sent");

    assert.equal(await settings.pruneEphemeralSettings(7), 1);
    assert.equal(await settings.getSetting("panelPublicUrl"), "https://panel.example.com");
    assert.equal(await settings.getSetting("storeEnabled"), "true");
    assert.equal(await settings.getSetting("someBackupAt:2020-01-01"), "keep me");
  `);
});

test("日期解析不出来的日标记宁可留着 —— 不猜", () => {
  runInDatabase(String.raw`
    await settings.setSetting("emailReminder:traffic:42", "sent");
    assert.equal(await settings.pruneEphemeralSettings(7), 0);
    assert.equal(await settings.getSetting("emailReminder:traffic:42"), "sent");
  `);
});

test("日标记不进 getAllSettings —— 那份映射每几秒就要重建一次", () => {
  runInDatabase(String.raw`
    await settings.setSetting("panelPublicUrl", "https://panel.example.com");
    await settings.setSetting("emailReminder:expiry:7:42:" + dayString(0), "sent");

    const all = await settings.getAllSettings();
    assert.equal(all.panelPublicUrl, "https://panel.example.com");
    assert.ok(!("emailReminder:expiry:7:42:" + dayString(0) in all), "日标记不该混进设置表");
    // 但按精确键仍然读得到 —— 去重逻辑靠的就是这条路。
    assert.equal(await settings.getSetting("emailReminder:expiry:7:42:" + dayString(0)), "sent");
  `);
});

test("写日标记不作废整份设置缓存；写真设置才作废", () => {
  runInDatabase(String.raw`
    await settings.setSetting("panelPublicUrl", "https://a.example.com");
    assert.equal((await settings.getAllSettings()).panelPublicUrl, "https://a.example.com");
    // 绕过 setSetting 直接改库：缓存还在的话，读到的应当仍是旧值。
    await runtime.executeRaw("UPDATE system_settings SET value = ? WHERE key = ?", ["https://b.example.com", "panelPublicUrl"]);
    await settings.setSetting("telegramReminder:traffic:42:" + dayString(0), "sent");
    await settings.setSetting("runtimeCache:exitPorts", "{}");
    assert.equal(
      (await settings.getAllSettings()).panelPublicUrl,
      "https://a.example.com",
      "发一条提醒就把整份设置缓存作废，一轮提醒就是上千次整表重读",
    );
    await settings.setSetting("storeEnabled", "true");
    assert.equal((await settings.getAllSettings()).panelPublicUrl, "https://b.example.com", "真设置变了必须立刻看得到");
  `);
});

test("不带日期的日标记按写入时间清：过期的清掉，新的留着", () => {
  runInDatabase(String.raw`
    const oldSec = Math.floor((Date.now() - 10 * 24 * 3600 * 1000) / 1000);
    await settings.setSetting("emailReminder:expiry:42:1700000000:7", "sent");
    await settings.setSetting("telegramReminder:hostRenewal:3:42:1700000000:1", "sent");
    await runtime.executeRaw('UPDATE system_settings SET "updatedAt" = ? WHERE key = ?', [oldSec, "emailReminder:expiry:42:1700000000:7"]);
    assert.equal(await settings.pruneEphemeralSettings(7), 1);
    assert.equal(await settings.getSetting("emailReminder:expiry:42:1700000000:7"), null);
    assert.equal(await settings.getSetting("telegramReminder:hostRenewal:3:42:1700000000:1"), "sent");
  `);
});
