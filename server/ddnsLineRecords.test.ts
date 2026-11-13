import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  分线路解析在 DNSPod 上的读写（server/ddnsLineRecords.ts）。DNSPod 换成一个假的传输层：按名字 /
  类型 / 线路过滤，记下每一次调用 —— 看每条线路的发布、改值、删除是不是只按记录 ID 动面板自己的记录。
*/

process.env.FORWARDX_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ddns-lines-"));

const { DdnsProviderError, resetDdnsProviderMinTtlCacheForTests } = await import("./ddns");
const lines = await import("./ddnsLineRecords");
const { buildDnsManagedIndex, dnsManagedOwnersOf } = await import("./dnsManagedNames");
const records = await import("./dnspodRecords");

type FakeRecord = { RecordId: number; Name: string; Type: string; Line: string; LineId: string; Value: string; TTL: number };

const DEFAULT = { id: "0", name: "默认" };
const TELECOM = { id: "10=0", name: "电信" };
const UNICOM = { id: "10=1", name: "联通" };

class FakeDnspod {
  records: FakeRecord[] = [];
  calls: Array<{ action: string; payload: Record<string, any> }> = [];
  nextId = 5000;
  rejectTtlBelow = 0;

  add(record: Partial<FakeRecord> & { Name: string; Type: string; Value: string }) {
    const full: FakeRecord = { RecordId: this.nextId++, Line: "默认", LineId: "0", TTL: 600, ...record };
    this.records.push(full);
    return full;
  }

  writes() {
    return this.calls.filter((call) => call.action !== "DescribeRecordList");
  }

  transport = async (action: string, payload: Record<string, any>) => {
    this.calls.push({ action, payload: { ...payload } });
    if ((action === "CreateRecord" || action === "ModifyRecord") && this.rejectTtlBelow && Number(payload.TTL) < this.rejectTtlBelow) {
      throw new DdnsProviderError("TTL 不在套餐允许范围", "InvalidParameter.InvalidTTL");
    }
    switch (action) {
      case "DescribeRecordList":
        return {
          RecordList: this.records
            .filter((record) => record.Name === payload.Subdomain && record.Type === payload.RecordType)
            .filter((record) => (payload.RecordLineId ? record.LineId === payload.RecordLineId : record.Line === payload.RecordLine))
            .map((record) => ({ ...record })),
        };
      case "CreateRecord": {
        const record = this.add({ Name: payload.SubDomain, Type: payload.RecordType, Line: payload.RecordLine, LineId: payload.RecordLineId, Value: payload.Value, TTL: payload.TTL });
        return { RecordId: record.RecordId };
      }
      case "ModifyRecord": {
        const record = this.records.find((item) => item.RecordId === Number(payload.RecordId));
        assert.ok(record, `ModifyRecord 改了不存在的记录 ${payload.RecordId}`);
        Object.assign(record, { Value: payload.Value, TTL: payload.TTL, Line: payload.RecordLine, LineId: payload.RecordLineId });
        return { RecordId: record.RecordId };
      }
      case "DeleteRecord": {
        const index = this.records.findIndex((item) => item.RecordId === Number(payload.RecordId));
        assert.ok(index >= 0, `DeleteRecord 删了不存在的记录 ${payload.RecordId}`);
        this.records.splice(index, 1);
        return {};
      }
      default:
        throw new Error(`unexpected action ${action}`);
    }
  };

  on(name: string, type: string, line: { id: string }) {
    return this.records.filter((record) => record.Name === name && record.Type === type && record.LineId === line.id);
  }
}

function settings(patch: Record<string, unknown> = {}) {
  return {
    provider: "tencentcloud",
    enabled: true,
    ttl: 60,
    cloudflareZoneId: "",
    cloudflareApiToken: "",
    webhookUrl: "",
    webhookMethod: "POST",
    webhookHeaders: "",
    huaweicloudAccessKeyId: "",
    huaweicloudSecretKey: "",
    huaweicloudRegion: "",
    huaweicloudEndpoint: "",
    huaweicloudZoneId: "",
    huaweicloudTtl: 60,
    huaweicloudLine: "default_view",
    aliyunAccessKeyId: "",
    aliyunAccessKeySecret: "",
    aliyunDomainName: "",
    aliyunEndpoint: "",
    aliyunTtl: 60,
    aliyunLine: "default",
    tencentcloudSecretId: "id",
    tencentcloudSecretKey: "key",
    tencentcloudDomainName: "example.com",
    tencentcloudTtl: 60,
    tencentcloudRecordLine: "默认",
    tencentcloudRecordLineId: "",
    ...patch,
  } as any;
}

function withFake(run: (fake: FakeDnspod) => Promise<void>) {
  return async () => {
    const fake = new FakeDnspod();
    lines.configureDdnsLineRecordsForTests({ transport: () => fake.transport });
    resetDdnsProviderMinTtlCacheForTests();
    try {
      await run(fake);
    } finally {
      lines.configureDdnsLineRecordsForTests(null);
    }
  };
}

test("腾讯云 DNSPod 支持分线路（Cloudflare / Webhook 不支持）；默认线路是 DDNS 设置里的线路", () => {
  assert.equal(lines.ddnsLineSupport(settings()).supported, true);
  assert.equal(lines.ddnsLineSupport(settings()).rootDomain, "example.com");
  for (const provider of ["cloudflare", "webhook"]) {
    const support = lines.ddnsLineSupport(settings({ provider }));
    assert.equal(support.supported, false, provider);
    assert.match(String(support.reason), /分线路解析支持腾讯云 DNSPod、阿里云 DNS、华为云 DNS/);
  }
  assert.equal(lines.ddnsLineSupport(settings({ enabled: false })).supported, false);
  assert.equal(lines.ddnsLineSupport(settings({ tencentcloudSecretKey: "" })).supported, false);
  assert.deepEqual(lines.ddnsDefaultLine(settings()), DEFAULT);
  assert.deepEqual(lines.ddnsDefaultLine(settings({ tencentcloudRecordLine: "境外", tencentcloudRecordLineId: "3=0" })), { id: "3=0", name: "境外" });
});

test("按线路发布：只动这条线路的记录，返回面板管着的记录 ID", withFake(async (fake) => {
  const defaultRecord = fake.add({ Name: "entry", Type: "A", Value: "198.51.100.3" });
  const otherName = fake.add({ Name: "other", Type: "A", Line: "电信", LineId: TELECOM.id, Value: "203.0.113.9" });

  const first = await lines.publishDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "A", line: TELECOM, values: ["198.51.100.1", "198.51.100.2"], ttl: 60,
  });
  assert.equal(first.writes, 2);
  assert.deepEqual(fake.on("entry", "A", TELECOM).map((record) => record.Value).sort(), ["198.51.100.1", "198.51.100.2"]);
  assert.deepEqual(first.recordIds.sort(), fake.on("entry", "A", TELECOM).map((record) => String(record.RecordId)).sort());
  // 写的每一笔都带着线路名和线路 ID。
  for (const call of fake.writes()) {
    assert.equal(call.payload.RecordLine, "电信");
    assert.equal(call.payload.RecordLineId, TELECOM.id);
    assert.equal(call.payload.SubDomain, "entry");
  }
  // 默认线路、别的名字都没被碰。
  assert.deepEqual(fake.records.find((record) => record.RecordId === defaultRecord.RecordId)?.Value, "198.51.100.3");
  assert.deepEqual(fake.records.find((record) => record.RecordId === otherName.RecordId)?.Value, "203.0.113.9");

  // 值没变：只读一次，不写。
  fake.calls = [];
  const same = await lines.publishDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "A", line: TELECOM, values: ["198.51.100.2", "198.51.100.1"], ttl: 60,
  });
  assert.equal(same.writes, 0);
  assert.deepEqual(fake.calls.map((call) => call.action), ["DescribeRecordList"]);
  assert.deepEqual(same.recordIds.sort(), first.recordIds.sort());

  // 换一个值、少一个值：改一条（同一个记录 ID）、删一条。
  fake.calls = [];
  const changed = await lines.publishDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "A", line: TELECOM, values: ["198.51.100.7"], ttl: 60,
  });
  assert.deepEqual(fake.writes().map((call) => call.action).sort(), ["DeleteRecord", "ModifyRecord"]);
  assert.equal(changed.recordIds.length, 1);
  assert.ok(first.recordIds.includes(changed.recordIds[0]), "改值要复用原来的记录，不新建");
  assert.deepEqual(fake.on("entry", "A", TELECOM).map((record) => record.Value), ["198.51.100.7"]);
}));

test("IPv6 线路记录走 AAAA，不碰同一线路的 A 记录", withFake(async (fake) => {
  const v4 = fake.add({ Name: "entry", Type: "A", Line: "电信", LineId: TELECOM.id, Value: "198.51.100.1" });
  const result = await lines.publishDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "AAAA", line: TELECOM, values: ["2001:db8::1"], ttl: 60,
  });
  assert.equal(result.recordIds.length, 1);
  assert.deepEqual(fake.on("entry", "AAAA", TELECOM).map((record) => record.Value), ["2001:db8::1"]);
  assert.equal(fake.records.find((record) => record.RecordId === v4.RecordId)?.Value, "198.51.100.1");
}));

test("删一条线路：只删记下的记录 ID，同线路上别人手加的不动，已经不在的不重复删", withFake(async (fake) => {
  const published = await lines.publishDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "A", line: UNICOM, values: ["198.51.100.2"], ttl: 60,
  });
  const thirdParty = fake.add({ Name: "entry", Type: "A", Line: "联通", LineId: UNICOM.id, Value: "192.0.2.50" });
  const telecom = fake.add({ Name: "entry", Type: "A", Line: "电信", LineId: TELECOM.id, Value: "198.51.100.1" });

  fake.calls = [];
  const removed = await lines.deleteDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "A", line: UNICOM, recordIds: [...published.recordIds, "999999"],
  });
  assert.deepEqual(removed.deleted, published.recordIds);
  assert.equal(removed.untouched, 1);
  assert.deepEqual(fake.writes().map((call) => [call.action, String(call.payload.RecordId)]), published.recordIds.map((id) => ["DeleteRecord", id]));
  assert.ok(fake.records.some((record) => record.RecordId === thirdParty.RecordId), "别人加的联通记录要留着");
  assert.ok(fake.records.some((record) => record.RecordId === telecom.RecordId), "别的线路不能被删");

  // 再删一次：记下的 ID 已经不在，不发任何删除。
  fake.calls = [];
  const again = await lines.deleteDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "A", line: UNICOM, recordIds: published.recordIds,
  });
  assert.deepEqual(again.deleted, []);
  assert.deepEqual(fake.writes(), []);

  // 没有记下任何 ID：连列表都不用读。
  fake.calls = [];
  await lines.deleteDdnsLineRecords(settings(), { domain: "entry.example.com", recordType: "A", line: UNICOM, recordIds: [] });
  assert.deepEqual(fake.calls, []);
}));

test("免费套餐 TTL 下限：被拒后按 600 秒重写，记录 ID 只记一份", withFake(async (fake) => {
  fake.rejectTtlBelow = 600;
  const result = await lines.publishDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "A", line: TELECOM, values: ["198.51.100.1"], ttl: 60,
  });
  assert.equal(result.recordIds.length, 1);
  assert.deepEqual(fake.on("entry", "A", TELECOM).map((record) => record.TTL), [600]);
}));

test("服务商不支持时拒绝写，不发请求", withFake(async (fake) => {
  await assert.rejects(
    lines.publishDdnsLineRecords(settings({ provider: "cloudflare" }), { domain: "entry.example.com", recordType: "A", line: TELECOM, values: ["198.51.100.1"] }),
    /不支持按运营商线路解析/,
  );
  await assert.rejects(
    lines.publishDdnsLineRecords(settings(), { domain: "entry.example.com", recordType: "A", line: TELECOM, values: [] }),
    /不能为空/,
  );
  assert.deepEqual(fake.calls, []);
}));

test("面板托管名字的只读保护按名字算，覆盖这个名字下所有线路的记录", async () => {
  const index = buildDnsManagedIndex({
    hosts: [],
    forwardGroups: [{ id: 1, name: "入口", groupType: "host", groupMode: "entry", domain: "entry.example.com", ddnsAutoResolveEnabled: 1 }],
    rules: [],
    ruleCleanups: [],
    landingPools: [],
  });
  assert.equal(dnsManagedOwnersOf(index, "entry.example.com").length, 1);
  // 走一遍 DNSPod 记录管理页的列表：电信、联通线路上的记录和默认线路一样只读。
  const fake = new FakeDnspod();
  fake.add({ Name: "entry", Type: "A", Value: "198.51.100.3" });
  fake.add({ Name: "entry", Type: "A", Line: "电信", LineId: TELECOM.id, Value: "198.51.100.1" });
  fake.add({ Name: "entry", Type: "AAAA", Line: "联通", LineId: UNICOM.id, Value: "2001:db8::2" });
  fake.add({ Name: "www", Type: "A", Line: "电信", LineId: TELECOM.id, Value: "192.0.2.1" });
  const listing = async (action: string, payload: Record<string, any>) => {
    assert.equal(action, "DescribeRecordList");
    const page = fake.records.slice(Number(payload.Offset || 0), Number(payload.Offset || 0) + Number(payload.Limit || 100));
    return { RecordCountInfo: { TotalCount: fake.records.length }, RecordList: page.map((record) => ({ ...record, Status: "ENABLE" })) };
  };
  records.configureDnspodRecordsForTests({ transport: async () => listing, managedIndex: async () => index });
  try {
    const result = await records.listDnspodRecords("example.com");
    const entry = result.groups.find((group) => group.subdomain === "entry")!;
    assert.equal(entry.records.length, 3);
    assert.ok(entry.records.every((record) => !record.editable && /由面板管理/.test(String(record.readOnlyReason))));
    assert.ok(result.groups.find((group) => group.subdomain === "www")!.records.every((record) => record.editable));
  } finally {
    records.configureDnspodRecordsForTests(null);
  }
});
