import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DIGEST_HOUR, formatDigestHour, isDigestDue, normalizeDigestHour, parseDigestBlocks } from "./opsDigest";

test("digest hour defaults to 9 when unset or unreadable", () => {
  assert.equal(DEFAULT_DIGEST_HOUR, 9);
  for (const value of [undefined, null, "", " ", "abc", "9.5", 9.5, -1, 24, "24", "100", "9:30", Number.NaN]) {
    assert.equal(normalizeDigestHour(value), 9, String(value));
  }
});

test("digest hour accepts 0-23 as numbers, strings and HH:00", () => {
  assert.equal(normalizeDigestHour(0), 0);
  assert.equal(normalizeDigestHour("0"), 0);
  assert.equal(normalizeDigestHour(23), 23);
  assert.equal(normalizeDigestHour("07"), 7);
  assert.equal(normalizeDigestHour(" 18 "), 18);
  assert.equal(normalizeDigestHour("21:00"), 21);
  assert.equal(formatDigestHour(7), "07:00");
  assert.equal(formatDigestHour(undefined), "09:00");
});

test("digest is due once the configured hour has been reached", () => {
  // 默认 9 点：和原来写死的 DIGEST_HOUR 行为一致
  assert.equal(isDigestDue(8, undefined), false);
  assert.equal(isDigestDue(9, undefined), true);
  assert.equal(isDigestDue(23, null), true);
  assert.equal(isDigestDue(19, 20), false);
  assert.equal(isDigestDue(20, "20"), true);
  assert.equal(isDigestDue(0, 0), true);
  assert.equal(isDigestDue(22, 23), false);
  // 钟点读不出来时按 9 点算，而不是一直不发 / 零点就发
  assert.equal(isDigestDue(8, "garbage"), false);
  assert.equal(isDigestDue(10, "garbage"), true);
  assert.equal(isDigestDue(Number.NaN, 0), false);
});

test("digest blocks parse to known keys in a fixed order, default none", () => {
  assert.deepEqual(parseDigestBlocks(null), []);
  assert.deepEqual(parseDigestBlocks(""), []);
  assert.deepEqual(parseDigestBlocks("security, hostTraffic,unknown,hostTraffic"), ["hostTraffic", "security"]);
  assert.deepEqual(parseDigestBlocks(["lowQuota", "topUsers"]), ["topUsers", "lowQuota"]);
});
