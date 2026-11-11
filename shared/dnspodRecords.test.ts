import assert from "node:assert/strict";
import test from "node:test";
import {
  dnspodRecordFqdn,
  normalizeDnspodSubdomain,
  remainingDnspodChanges,
  validateDnspodRecordDraft,
} from "./dnspodRecords";

test("主机记录：@、泛解析、下划线都认；乱写的拒绝", () => {
  assert.equal(normalizeDnspodSubdomain(""), "@");
  assert.equal(normalizeDnspodSubdomain(" WWW "), "www");
  assert.equal(normalizeDnspodSubdomain("*.cdn"), "*.cdn");
  assert.equal(normalizeDnspodSubdomain("_acme-challenge.a"), "_acme-challenge.a");
  assert.equal(normalizeDnspodSubdomain("a..b"), null);
  assert.equal(normalizeDnspodSubdomain("a.*"), null);
  assert.equal(normalizeDnspodSubdomain("-bad"), null);
  assert.equal(normalizeDnspodSubdomain("有中文"), null);
});

test("记录值按类型校验，CNAME 规整成小写、去掉结尾的点", () => {
  const base = { subdomain: "a", lineId: "0", ttl: 600 };
  assert.equal(validateDnspodRecordDraft({ ...base, type: "A", value: "198.51.100.1" }).ok, true);
  assert.equal(validateDnspodRecordDraft({ ...base, type: "A", value: "198.51.100.256" }).ok, false);
  assert.equal(validateDnspodRecordDraft({ ...base, type: "A", value: "2001:db8::1" }).ok, false);
  assert.equal(validateDnspodRecordDraft({ ...base, type: "AAAA", value: "2001:db8::1" }).ok, true);
  assert.equal(validateDnspodRecordDraft({ ...base, type: "AAAA", value: "198.51.100.1" }).ok, false);
  const cname = validateDnspodRecordDraft({ ...base, type: "CNAME", value: "Edge.Example.NET." });
  assert.equal(cname.ok && cname.record.value, "edge.example.net");
  assert.equal(validateDnspodRecordDraft({ ...base, type: "CNAME", value: "localhost" }).ok, false);
  assert.equal(validateDnspodRecordDraft({ ...base, type: "MX" as any, value: "mx.example.com" }).ok, false);
  assert.equal(validateDnspodRecordDraft({ ...base, type: "A", value: "198.51.100.1", lineId: "" }).ok, false);
  assert.equal(validateDnspodRecordDraft({ ...base, type: "A", value: "198.51.100.1", ttl: 0 }).ok, false);
});

test("完整域名和暂存区：只有 done 的拿掉", () => {
  assert.equal(dnspodRecordFqdn("@", "Example.com."), "example.com");
  assert.equal(dnspodRecordFqdn("www", "example.com"), "www.example.com");
  const staged = [{ key: "a" }, { key: "b" }, { key: "c" }];
  assert.deepEqual(remainingDnspodChanges(staged, [
    { key: "a", status: "done" },
    { key: "b", status: "failed", error: "x" },
    { key: "c", status: "skipped" },
  ]).map((item) => item.key), ["b", "c"]);
  assert.equal(remainingDnspodChanges(staged, null).length, 3);
});
