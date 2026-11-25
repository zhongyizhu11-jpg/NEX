import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 地理缓存的 expiresAt 写入时就已经是「抓取时间 + 30 天」，过了就再也不会被读。
 * 清理原来又往回减了 30 天，过期行要白白多躺一个月。
 */
test("过期的地理缓存行按 expiresAt <= 现在 清掉，没过期的留着", () => {
  runInDatabase(String.raw`
      const geo = await import(url("server/hostGeo.ts"));

      const now = Math.floor(Date.now() / 1000);
      const insert = (address, expiresAt) => exec(
        'INSERT INTO ip_geo_cache (address, "resolvedAddress", "geoCountryCode", "fetchedAt", "expiresAt") VALUES (?, ?, ?, ?, ?)',
        [address, address, "US", now - 40 * 86400, expiresAt],
      );
      await insert("expired-yesterday.example", now - 86400);
      await insert("expired-long-ago.example", now - 60 * 86400);
      await insert("fresh.example", now + 86400);

      await geo.cleanOldAddressGeoCache();
      const left = (await query("SELECT address FROM ip_geo_cache ORDER BY address")).map((row) => row.address);
      assert.deepEqual(left, ["fresh.example"], "昨天就过期、再也不会被读的行不该再留一个月");
  `, { name: "geo-cleanup" });
});
