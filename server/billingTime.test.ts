import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";
import { pathToFileURL } from "node:url";
import {
  BILLING_DATE_TIME_FORMAT_OPTIONS,
  billingAddMonthsClamped,
  billingCalendarParts,
  billingMonthStart,
  billingMonthlyBoundary,
  billingStartOfCalendarDay,
  formatBillingDateInput,
  parseBillingDateInput,
  parseBillingExpiryInput,
} from "../shared/billingTime";

test("expiry date inputs are interpreted as the start of the day in the billing time zone", () => {
  // 选 10 月 1 日 = 北京时间 10-01 00:00，而不是 UTC 零点（北京 08:00，西半球读回来是 9 月 30 日）。
  assert.equal(parseBillingDateInput("2026-10-01")?.toISOString(), "2026-09-30T16:00:00.000Z");
  assert.equal(parseBillingExpiryInput("2026-10-01")?.toISOString(), "2026-09-30T16:00:00.000Z");
  assert.equal(parseBillingExpiryInput("2026-10-01T04:05:06.000Z")?.toISOString(), "2026-10-01T04:05:06.000Z");
  assert.equal(parseBillingExpiryInput("not-a-date"), undefined);
  assert.equal(parseBillingDateInput("2026-02-30"), null);
  assert.equal(parseBillingDateInput(""), null);

  // 读回来按计费时区取日期：新值、旧值（UTC 零点）都显示成同一天。
  assert.equal(formatBillingDateInput(parseBillingDateInput("2026-10-01")), "2026-10-01");
  assert.equal(formatBillingDateInput(new Date("2026-10-01")), "2026-10-01");
  assert.equal(formatBillingDateInput("2026-10-01T00:00:00.000Z"), "2026-10-01");
  assert.equal(formatBillingDateInput(null), "");
  assert.equal(formatBillingDateInput("garbage"), "");
});

test("billing calendar boundaries use Asia/Shanghai instead of the process time zone", () => {
  const reference = new Date("2026-08-03T02:00:00.000Z");
  assert.equal(billingMonthStart(reference).toISOString(), "2026-07-31T16:00:00.000Z");
  assert.equal(billingMonthlyBoundary(reference, 23).toISOString(), "2026-08-22T16:00:00.000Z");
  assert.equal(billingMonthlyBoundary(reference, 23, 1).toISOString(), "2026-09-22T16:00:00.000Z");
  assert.equal(
    billingMonthlyBoundary(new Date("2027-02-10T00:00:00.000Z"), 31, 0, 31).toISOString(),
    "2027-02-27T16:00:00.000Z",
  );
  assert.equal(
    billingAddMonthsClamped(new Date("2026-01-30T20:15:00.000Z"), 1).toISOString(),
    "2026-02-27T20:15:00.000Z",
  );
  assert.equal(
    billingStartOfCalendarDay(billingAddMonthsClamped(new Date("2026-01-30T20:15:00.000Z"), 1)).toISOString(),
    "2026-02-27T16:00:00.000Z",
  );

  assert.deepEqual(billingCalendarParts("2026-08-22T15:59:59.000Z"), {
    year: 2026,
    month: 8,
    day: 22,
    hour: 23,
    minute: 59,
    second: 59,
  });
  assert.deepEqual(billingCalendarParts("2026-08-22T16:00:00.000Z"), {
    year: 2026,
    month: 8,
    day: 23,
    hour: 0,
    minute: 0,
    second: 0,
  });
});

test("billing boundaries and display stay identical across process time zones", () => {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "shared/billingTime.ts")).href;
  const script = String.raw`
    const billing = await import(${JSON.stringify(moduleUrl)});
    const reference = new Date("2026-08-03T02:00:00.000Z");
    const boundary = billing.billingMonthlyBoundary(reference, 23);
    process.stdout.write(JSON.stringify({
      boundary: boundary.toISOString(),
      monthStart: billing.billingMonthStart(reference).toISOString(),
      currentDay: billing.billingCalendarParts("2026-08-22T16:00:00.000Z").day,
      anchored: billing.billingAddMonthsClamped("2026-01-30T20:15:00.000Z", 1).toISOString(),
      anchoredBoundary: billing.billingStartOfCalendarDay(
        billing.billingAddMonthsClamped("2026-01-30T20:15:00.000Z", 1),
      ).toISOString(),
      display: boundary.toLocaleString("zh-CN", billing.BILLING_DATE_TIME_FORMAT_OPTIONS),
    }));
  `;

  const results = ["UTC", "Asia/Shanghai", "America/Los_Angeles"].map((timeZone) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: timeZone },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, `${timeZone}: ${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  });

  for (const result of results) {
    assert.deepEqual(result, results[0]);
    assert.equal(result.boundary, "2026-08-22T16:00:00.000Z");
    assert.equal(result.monthStart, "2026-07-31T16:00:00.000Z");
    assert.equal(result.currentDay, 23);
    assert.equal(result.anchored, "2026-02-27T20:15:00.000Z");
    assert.equal(result.anchoredBoundary, "2026-02-27T16:00:00.000Z");
    assert.match(result.display, /00:00:00/);
  }
});

test("billing display options do not expose the UTC storage offset", () => {
  const boundary = new Date("2026-08-22T16:00:00.000Z");
  assert.match(boundary.toLocaleString("zh-CN", BILLING_DATE_TIME_FORMAT_OPTIONS), /2026\/8\/23 00:00:00/);
});

test("user and host monthly reset selection changes at the billing boundary in every process time zone", () => {
  const script = String.raw`
    const users = await import(url("server/repositories/userRepository.ts"));
    const hosts = await import(url("server/repositories/hostRepository.ts"));
    const epoch = (value) => Math.floor(new Date(value).getTime() / 1000);
    await exec(
      'INSERT INTO "users" ("id", "username", "password", "role", "lastTrafficReset") VALUES (?, ?, ?, ?, ?)',
      [99, "legacy-reset-user", "hash", "user", epoch("2026-07-31T16:00:00.000Z")],
    );
    await exec(
      'DELETE FROM "system_settings" WHERE "key" = ?',
      ["last-auto-traffic-reset-backfill-v1"],
    );
    await exec('ALTER TABLE "users" DROP COLUMN "lastAutoTrafficReset"');
    await schema.ensureDatabaseSchema();
    const [legacyUser] = await query(
      'SELECT "lastTrafficReset", "lastAutoTrafficReset" FROM "users" WHERE "id" = ?',
      [99],
    );
    for (const [id, resetDay, lastReset] of [
      [1, 23, null],
      [2, 24, null],
      [3, 23, epoch("2026-07-31T16:00:00.000Z")],
      [4, 23, epoch("2026-07-31T15:59:59.000Z")],
    ]) {
      await exec(
        'INSERT INTO "users" ("id", "username", "password", "role", "trafficAutoReset", "trafficResetDay", "lastTrafficReset", "lastAutoTrafficReset") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, "billing-user-" + id, "hash", "user", 1, resetDay, lastReset, lastReset],
      );
      await exec(
        'INSERT INTO "hosts" ("id", "name", "ip", "userId", "portRangeStart", "portRangeEnd", "trafficAutoReset", "trafficResetDay", "lastTrafficReset") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, "billing-host-" + id, "127.0.0." + id, id, 10000 + id, 10000 + id, 1, resetDay, lastReset],
      );
    }
    await exec(
      'INSERT INTO "users" ("id", "username", "password", "role", "trafficAutoReset", "trafficResetDay", "trafficUsed") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [5, "manual-reset-user", "hash", "user", 1, 23, 123],
    );
    await users.resetUserTraffic(5);
    await schema.ensureDatabaseSchema();
    const [manualUserAfterEnsure] = await query(
      'SELECT "lastAutoTrafficReset" FROM "users" WHERE "id" = ?',
      [5],
    );

    const before = new Date("2026-08-22T15:59:59.000Z");
    const boundary = new Date("2026-08-22T16:00:00.000Z");
    const ids = (rows) => rows.map((row) => Number(row.id)).sort((left, right) => left - right);
    const usersBefore = ids(await users.getUsersForAutoReset(before));
    const usersAt = ids(await users.getUsersForAutoReset(boundary));
    await exec('UPDATE "users" SET "trafficUsed" = ? WHERE "id" = ?', [456, 5]);
    const resetAt = new Date("2026-08-22T17:00:00.000Z");
    const firstCycleReset = await users.resetUserTrafficForCycle(5, boundary, resetAt);
    const secondCycleReset = await users.resetUserTrafficForCycle(5, boundary, resetAt);
    const usersAfterCycle = ids(await users.getUsersForAutoReset(boundary));
    const [cycleUser] = await query(
      'SELECT "trafficUsed", "lastTrafficReset", "lastAutoTrafficReset" FROM "users" WHERE "id" = ?',
      [5],
    );
    process.stdout.write("\n__BILLING_RESULT__" + JSON.stringify({
      usersBefore,
      usersAt,
      hostsBefore: ids(await hosts.getHostsForTrafficAutoReset(before)),
      hostsAt: ids(await hosts.getHostsForTrafficAutoReset(boundary)),
      legacyReset: Number(legacyUser.lastAutoTrafficReset),
      legacySourceReset: Number(legacyUser.lastTrafficReset),
      manualMarkerAfterEnsure: manualUserAfterEnsure.lastAutoTrafficReset,
      firstCycleReset,
      secondCycleReset,
      usersAfterCycle,
      cycleTrafficUsed: Number(cycleUser.trafficUsed),
      cycleLastReset: Number(cycleUser.lastTrafficReset),
      cycleLastAutoReset: Number(cycleUser.lastAutoTrafficReset),
    }));
  `;

  const results = ["UTC", "Asia/Shanghai"].map((timeZone) => {
    const result = runInDatabase(script, { name: "billing-boundary", env: { TZ: timeZone } });
    const tail = result.stdout.split("__BILLING_RESULT__").pop() || "";
    return JSON.parse(tail.slice(0, tail.lastIndexOf("}") + 1));
  });

  assert.deepEqual(results, [
    {
      usersBefore: [], usersAt: [1, 4, 5], hostsBefore: [], hostsAt: [1, 4],
      legacyReset: 1785513600, legacySourceReset: 1785513600, manualMarkerAfterEnsure: null,
      firstCycleReset: true, secondCycleReset: false, cycleTrafficUsed: 0,
      usersAfterCycle: [1, 4],
      cycleLastReset: 1787418000, cycleLastAutoReset: 1787418000,
    },
    {
      usersBefore: [], usersAt: [1, 4, 5], hostsBefore: [], hostsAt: [1, 4],
      legacyReset: 1785513600, legacySourceReset: 1785513600, manualMarkerAfterEnsure: null,
      firstCycleReset: true, secondCycleReset: false, cycleTrafficUsed: 0,
      usersAfterCycle: [1, 4],
      cycleLastReset: 1787418000, cycleLastAutoReset: 1787418000,
    },
  ]);
});
