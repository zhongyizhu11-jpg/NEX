import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  分线路解析在阿里云 DNS、华为云 DNS 上的读写（server/ddnsLineRecords.ts）。两家各换成一个假的传输层：
  按名字 / 类型 / 线路过滤，记下每一次调用 —— 看每条线路的发布、改值、删除是不是只动面板自己的记录，
  记录条数 / 配额超限时给出看得懂的错误。DNSPod 的同类测试在 ddnsLineRecords.test.ts。
*/

process.env.FORWARDX_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ddns-lines-providers-"));

const { DdnsProviderError, resetDdnsProviderMinTtlCacheForTests } = await import("./ddns");
const lines = await import("./ddnsLineRecords");
const shared = await import("../shared/ddnsLines");

function settings(patch: Record<string, unknown> = {}) {
  return {
    provider: "aliyun",
    enabled: true,
    ttl: 60,
    cloudflareZoneId: "",
    cloudflareApiToken: "",
    webhookUrl: "",
    webhookMethod: "POST",
    webhookHeaders: "",
    huaweicloudAccessKeyId: "hw-ak",
    huaweicloudSecretKey: "hw-sk",
    huaweicloudRegion: "cn-north-4",
    huaweicloudEndpoint: "",
    huaweicloudZoneId: "",
    huaweicloudTtl: 60,
    huaweicloudLine: "default_view",
    aliyunAccessKeyId: "ali-ak",
    aliyunAccessKeySecret: "ali-sk",
    aliyunDomainName: "example.com",
    aliyunEndpoint: "",
    aliyunTtl: 60,
    aliyunLine: "default",
    tencentcloudSecretId: "",
    tencentcloudSecretKey: "",
    tencentcloudDomainName: "",
    tencentcloudTtl: 60,
    tencentcloudRecordLine: "默认",
    tencentcloudRecordLineId: "",
    ...patch,
  } as any;
}
const huawei = (patch: Record<string, unknown> = {}) => settings({ provider: "huaweicloud", ...patch });

// ===== 假的阿里云 DNS =====

type AliRecord = { RecordId: string; RR: string; Type: string; Line: string; Value: string; TTL: number };

class FakeAliyun {
  records: AliRecord[] = [];
  calls: Array<{ action: string; params: Record<string, any> }> = [];
  nextId = 880000;
  rejectTtlBelow = 0;
  /** 同名同类型同线路最多几条（模拟套餐的负载均衡条数上限）。 */
  perLineLimit = 10;

  add(record: Partial<AliRecord> & { RR: string; Type: string; Value: string }) {
    const full: AliRecord = { RecordId: String(this.nextId++), Line: "default", TTL: 600, ...record };
    this.records.push(full);
    return full;
  }

  writes() {
    return this.calls.filter((call) => !call.action.startsWith("Describe"));
  }

  on(rr: string, type: string, line: string) {
    return this.records.filter((record) => record.RR === rr && record.Type === type && record.Line === line);
  }

  transport = async (action: string, params: Record<string, any>) => {
    this.calls.push({ action, params: { ...params } });
    if ((action === "AddDomainRecord" || action === "UpdateDomainRecord") && this.rejectTtlBelow && Number(params.TTL) < this.rejectTtlBelow) {
      throw new DdnsProviderError("The TTL is not supported by the domain edition.", "DomainRecordTTLInvalid");
    }
    switch (action) {
      case "DescribeSupportLines":
        assert.equal(params.DomainName, "example.com");
        return {
          RecordLines: {
            RecordLine: [
              { LineCode: "default", LineName: "默认", LineDisplayName: "默认" },
              { LineCode: "telecom", LineName: "电信", LineDisplayName: "中国电信" },
              { LineCode: "unicom", LineName: "联通", LineDisplayName: "中国联通" },
              { LineCode: "cn_telecom_beijing", LineName: "北京", LineDisplayName: "中国电信_北京" },
              { LineCode: "bad line!", LineName: "坏的" },
            ],
          },
        };
      case "DescribeSubDomainRecords": {
        const full = String(params.SubDomain);
        const rr = full === "example.com" ? "@" : full.slice(0, -".example.com".length);
        const found = this.records
          .filter((record) => record.RR === rr && (!params.Type || record.Type === params.Type))
          .filter((record) => !params.Line || record.Line === params.Line)
          .map((record) => ({ ...record, DomainName: "example.com" }));
        // 只有一条时阿里云也回数组；这里故意回对象，看解析是不是两种都认。
        return { TotalCount: found.length, DomainRecords: { Record: found.length === 1 ? found[0] : found } };
      }
      case "AddDomainRecord": {
        assert.equal(params.DomainName, "example.com");
        const same = this.on(params.RR, params.Type, params.Line);
        if (same.some((record) => record.Value === params.Value)) throw new DdnsProviderError("The DNS record already exists.", "DomainRecordDuplicate");
        if (same.length >= this.perLineLimit) throw new DdnsProviderError("The number of records exceeds the limit.", "QuotaExceeded.ARecord");
        const record = this.add({ RR: params.RR, Type: params.Type, Line: params.Line, Value: params.Value, TTL: params.TTL });
        return { RecordId: record.RecordId };
      }
      case "UpdateDomainRecord": {
        const record = this.records.find((item) => item.RecordId === String(params.RecordId));
        assert.ok(record, `UpdateDomainRecord 改了不存在的记录 ${params.RecordId}`);
        Object.assign(record, { RR: params.RR, Type: params.Type, Value: params.Value, Line: params.Line, TTL: params.TTL });
        return { RecordId: record.RecordId };
      }
      case "DeleteDomainRecord": {
        const index = this.records.findIndex((item) => item.RecordId === String(params.RecordId));
        assert.ok(index >= 0, `DeleteDomainRecord 删了不存在的记录 ${params.RecordId}`);
        this.records.splice(index, 1);
        return { RecordId: params.RecordId };
      }
      default:
        throw new Error(`unexpected aliyun action ${action}`);
    }
  };
}

// ===== 假的华为云 DNS =====

type HwRecordSet = { id: string; name: string; type: string; line: string; records: string[]; ttl: number; zone_id: string };

class FakeHuawei {
  zones = [{ id: "ff8080825b8fc86c015b94bc6f8712c3", name: "example.com." }];
  recordsets: HwRecordSet[] = [];
  calls: Array<{ method: string; path: string; query: Record<string, any>; body?: any }> = [];
  nextId = 1;
  quota = 100;

  newId() {
    return `2c9eb155587228570158722b6ac3${String(this.nextId++).padStart(4, "0")}`;
  }

  add(recordset: Partial<HwRecordSet> & { name: string; type: string; records: string[] }) {
    const full: HwRecordSet = { id: this.newId(), line: "default_view", ttl: 300, zone_id: this.zones[0].id, ...recordset };
    this.recordsets.push(full);
    return full;
  }

  writes() {
    return this.calls.filter((call) => call.method !== "GET");
  }

  on(name: string, type: string, line: string) {
    return this.recordsets.filter((item) => item.name === name && item.type === type && item.line === line);
  }

  transport = async (method: string, pathValue: string, query: Record<string, any>, body?: any) => {
    this.calls.push({ method, path: pathValue, query: { ...query }, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
    if (method === "GET" && pathValue === "/v2/zones") {
      return { zones: this.zones.filter((zone) => zone.name === query.name) };
    }
    const zoneById = pathValue.match(/^\/v2\/zones\/([^/]+)$/);
    if (method === "GET" && zoneById) {
      const zone = this.zones.find((item) => item.id === decodeURIComponent(zoneById[1]));
      if (!zone) throw new DdnsProviderError("The zone does not exist.", "DNS.0101");
      return { ...zone };
    }
    const match = pathValue.match(/^\/v2\.1\/zones\/([^/]+)\/recordsets(?:\/([^/]+))?$/);
    assert.ok(match, `unexpected huawei path ${method} ${pathValue}`);
    const zoneId = decodeURIComponent(match[1]);
    assert.equal(zoneId, this.zones[0].id);
    const id = match[2] ? decodeURIComponent(match[2]) : null;
    if (method === "GET" && !id) {
      assert.equal(query.search_mode, "equal");
      const found = this.recordsets
        .filter((item) => item.name === query.name && (!query.type || item.type === query.type))
        .filter((item) => !query.line_id || item.line === query.line_id);
      return { recordsets: found.map((item) => ({ ...item, records: [...item.records] })), metadata: { total_count: found.length } };
    }
    if (method === "POST" && !id) {
      if (this.recordsets.length >= this.quota) throw new DdnsProviderError("Record Set资源配额不足。", "DNS.0403");
      if (this.on(body.name, body.type, body.line).length > 0) throw new DdnsProviderError("记录集名称已存在。", "DNS.0312");
      const created = this.add({ name: body.name, type: body.type, line: body.line, records: [...body.records], ttl: body.ttl });
      return { id: created.id, status: "PENDING_CREATE" };
    }
    const recordset = this.recordsets.find((item) => item.id === id);
    assert.ok(recordset, `${method} 了不存在的记录集 ${id}`);
    if (method === "PUT") {
      assert.equal(body.line, undefined, "华为云记录集的线路改不了，PUT 里不能带 line");
      Object.assign(recordset, { records: [...body.records], ttl: body.ttl });
      return { ...recordset };
    }
    if (method === "DELETE") {
      this.recordsets.splice(this.recordsets.indexOf(recordset), 1);
      return { ...recordset, status: "PENDING_DELETE" };
    }
    throw new Error(`unexpected huawei call ${method} ${pathValue}`);
  };
}

function withFakes(run: (fakes: { ali: FakeAliyun; hw: FakeHuawei }) => Promise<void>) {
  return async () => {
    const ali = new FakeAliyun();
    const hw = new FakeHuawei();
    lines.configureDdnsLineRecordsForTests({
      transport: () => async () => { throw new Error("不该调 DNSPod"); },
      aliyun: () => ali.transport,
      huawei: () => hw.transport,
    });
    resetDdnsProviderMinTtlCacheForTests();
    try {
      await run({ ali, hw });
    } finally {
      lines.configureDdnsLineRecordsForTests(null);
    }
  };
}

const TELECOM = { id: "telecom", name: "中国电信" };
const UNICOM = { id: "unicom", name: "中国联通" };
const DIANXIN = { id: "Dianxin", name: "电信" };
const LIANTONG = { id: "Liantong", name: "联通" };

test("阿里云、华为云支持分线路；凭据没填全时说清楚缺什么；默认线路按 DDNS 设置", () => {
  const ali = lines.ddnsLineSupport(settings());
  assert.deepEqual([ali.supported, ali.provider, ali.rootDomain], [true, "aliyun", "example.com"]);
  const hw = lines.ddnsLineSupport(huawei());
  assert.deepEqual([hw.supported, hw.provider], [true, "huaweicloud"]);
  assert.match(String(lines.ddnsLineSupport(settings({ aliyunAccessKeySecret: "" })).reason), /阿里云 DNS 的 AccessKey/);
  assert.match(String(lines.ddnsLineSupport(settings({ aliyunDomainName: "" })).reason), /主域名没有填全/);
  assert.match(String(lines.ddnsLineSupport(huawei({ huaweicloudSecretKey: "" })).reason), /华为云 DNS 的 Access Key ID/);
  for (const provider of ["cloudflare", "webhook"]) {
    assert.match(String(lines.ddnsLineSupport(settings({ provider })).reason), /不支持按运营商线路解析/);
  }
  assert.deepEqual(lines.ddnsDefaultLine(settings()), { id: "default", name: "默认" });
  assert.deepEqual(lines.ddnsDefaultLine(settings({ aliyunLine: "telecom" })), { id: "telecom", name: "中国电信" });
  assert.deepEqual(lines.ddnsDefaultLine(huawei()), { id: "default_view", name: "全网默认" });
  assert.deepEqual(lines.ddnsDefaultLine(huawei({ huaweicloudLine: "Abroad" })), { id: "Abroad", name: "境外" });
  assert.deepEqual(lines.ddnsDefaultLine(huawei({ huaweicloudLine: "" })), { id: "default_view", name: "全网默认" });
});

test("线路列表：阿里云按 DescribeSupportLines 实时读，华为云是固定的运营商线路；都带上服务商", withFakes(async ({ ali, hw }) => {
  const aliLines = await lines.listDdnsLinesForSettings(settings(), "entry.example.com");
  assert.equal(aliLines.supported, true);
  assert.equal(aliLines.provider, "aliyun");
  assert.deepEqual(aliLines.defaultLine, { id: "default", name: "默认", provider: "aliyun" });
  assert.deepEqual(aliLines.lines.map((line) => line.id), ["default", "telecom", "unicom", "cn_telecom_beijing"], "认不出的线路 ID 丢掉");
  assert.equal(aliLines.lines.find((line) => line.id === "cn_telecom_beijing")?.name, "中国电信_北京");
  assert.ok(aliLines.lines.every((line) => line.provider === "aliyun"));
  assert.equal(aliLines.domainWarning, null);
  assert.match(String((await lines.listDdnsLinesForSettings(settings(), "entry.other.org")).domainWarning), /不在 阿里云 DNS 的主域名 example\.com 下/);
  assert.deepEqual(ali.writes(), []);

  const hwLines = await lines.listDdnsLinesForSettings(huawei(), "entry.example.com");
  assert.equal(hwLines.provider, "huaweicloud");
  assert.equal(hwLines.rootDomain, null, "没填 Zone ID 时不知道主域名，不提示");
  for (const id of ["default_view", "Dianxin", "Liantong", "Yidong", "Jiaoyuwang", "Tietong", "Pengboshi", "Abroad", "Dianxin_Huadong"]) {
    assert.ok(hwLines.lines.some((line) => line.id === id && line.provider === "huaweicloud"), id);
  }
  assert.deepEqual(hw.calls, [], "华为云的线路列表不发请求");
  // 填了 Zone ID：按 Zone 问到主域名，提示不在它下面的入口域名。
  const withZone = await lines.listDdnsLinesForSettings(huawei({ huaweicloudZoneId: hw.zones[0].id }), "entry.other.org");
  assert.equal(withZone.rootDomain, "example.com");
  assert.match(String(withZone.domainWarning), /不在 华为云 DNS 的主域名 example\.com 下/);
  // 自定义的默认线路不在固定列表里时也列出来。
  const custom = await lines.listDdnsLinesForSettings(huawei({ huaweicloudLine: "Liantong_Beijing" }), null);
  assert.deepEqual(custom.lines[0], { id: "Liantong_Beijing", name: "Liantong_Beijing", provider: "huaweicloud" });

  const unsupported = await lines.listDdnsLinesForSettings(settings({ provider: "cloudflare" }), null);
  assert.equal(unsupported.supported, false);
  assert.deepEqual(unsupported.lines, []);
}));

test("阿里云：按线路发布多个值（一值一条），值没变不写，改值复用记录 ID，别的线路 / 名字不动", withFakes(async ({ ali }) => {
  const defaultRecord = ali.add({ RR: "entry", Type: "A", Value: "198.51.100.3" });
  const otherName = ali.add({ RR: "other", Type: "A", Line: "telecom", Value: "203.0.113.9" });
  const unicom = ali.add({ RR: "entry", Type: "A", Line: "unicom", Value: "203.0.113.10" });

  const first = await lines.publishDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "A", line: TELECOM, values: ["198.51.100.1", "198.51.100.2"], ttl: 60,
  });
  assert.equal(first.writes, 2);
  assert.deepEqual(ali.on("entry", "A", "telecom").map((record) => record.Value).sort(), ["198.51.100.1", "198.51.100.2"]);
  assert.deepEqual([...first.recordIds].sort(), ali.on("entry", "A", "telecom").map((record) => record.RecordId).sort());
  for (const call of ali.writes()) {
    assert.equal(call.action, "AddDomainRecord");
    assert.equal(call.params.Line, "telecom");
    assert.equal(call.params.RR, "entry");
    assert.equal(call.params.TTL, 60);
  }
  const list = ali.calls.find((call) => call.action === "DescribeSubDomainRecords")!;
  assert.deepEqual([list.params.SubDomain, list.params.Type, list.params.Line], ["entry.example.com", "A", "telecom"]);
  for (const record of [defaultRecord, otherName, unicom]) {
    assert.ok(ali.records.some((item) => item.RecordId === record.RecordId && item.Value === record.Value), "别的记录不能被碰");
  }

  ali.calls = [];
  const same = await lines.publishDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "A", line: TELECOM, values: ["198.51.100.2", "198.51.100.1"], ttl: 60,
  });
  assert.equal(same.writes, 0);
  assert.deepEqual(ali.calls.map((call) => call.action), ["DescribeSubDomainRecords"]);

  ali.calls = [];
  const changed = await lines.publishDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "A", line: TELECOM, values: ["198.51.100.7"], ttl: 60,
  });
  assert.deepEqual(ali.writes().map((call) => call.action).sort(), ["DeleteDomainRecord", "UpdateDomainRecord"]);
  assert.equal(changed.recordIds.length, 1);
  assert.ok(first.recordIds.includes(changed.recordIds[0]), "改值要复用原来的记录，不新建");
  assert.deepEqual(ali.on("entry", "A", "telecom").map((record) => record.Value), ["198.51.100.7"]);
  assert.equal(ali.writes().find((call) => call.action === "UpdateDomainRecord")!.params.Line, "telecom");
}));

test("阿里云：根域名、CNAME 都按线路写", withFakes(async ({ ali }) => {
  const root = await lines.publishDdnsLineRecords(settings(), { domain: "example.com", recordType: "A", line: UNICOM, values: ["198.51.100.1"] });
  assert.equal(ali.on("@", "A", "unicom").length, 1);
  assert.deepEqual(root.recordIds, ali.on("@", "A", "unicom").map((record) => record.RecordId));
  await lines.publishDdnsLineRecords(settings(), { domain: "cdn.example.com", recordType: "CNAME", line: TELECOM, values: ["Edge.Example.net."] });
  assert.deepEqual(ali.on("cdn", "CNAME", "telecom").map((record) => record.Value), ["edge.example.net"]);
}));

test("阿里云：删一条线路只删记下的 ID；同线路别人加的、别的线路上同 ID 的都不动", withFakes(async ({ ali }) => {
  const published = await lines.publishDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "A", line: UNICOM, values: ["198.51.100.2", "198.51.100.3"],
  });
  const manual = ali.add({ RR: "entry", Type: "A", Line: "unicom", Value: "192.0.2.50" });
  const telecom = ali.add({ RR: "entry", Type: "A", Line: "telecom", Value: "198.51.100.1" });

  ali.calls = [];
  const removed = await lines.deleteDdnsLineRecords(settings(), {
    domain: "entry.example.com", recordType: "A", line: UNICOM,
    // 混进一条别的线路上的 ID 和一条根本不存在的 ID：都不能删。
    recordIds: [...published.recordIds, telecom.RecordId, "999999"],
  });
  assert.deepEqual([...removed.deleted].sort(), [...published.recordIds].sort());
  assert.equal(removed.untouched, 1);
  assert.deepEqual(ali.writes().map((call) => call.action), ["DeleteDomainRecord", "DeleteDomainRecord"]);
  assert.ok(ali.records.some((record) => record.RecordId === manual.RecordId), "别人加的联通记录要留着");
  assert.ok(ali.records.some((record) => record.RecordId === telecom.RecordId), "别的线路不能被删");

  ali.calls = [];
  assert.deepEqual((await lines.deleteDdnsLineRecords(settings(), { domain: "entry.example.com", recordType: "A", line: UNICOM, recordIds: published.recordIds })).deleted, []);
  assert.deepEqual(ali.writes(), []);
  ali.calls = [];
  await lines.deleteDdnsLineRecords(settings(), { domain: "entry.example.com", recordType: "A", line: UNICOM, recordIds: ["not-a-number"] });
  assert.deepEqual(ali.calls, [], "没有像样的记录 ID：连列表都不用读");
}));

test("阿里云：记录条数到上限时给出看得懂的错误；免费版 TTL 下限按 600 重试", withFakes(async ({ ali }) => {
  ali.perLineLimit = 2;
  await assert.rejects(
    lines.publishDdnsLineRecords(settings(), {
      domain: "entry.example.com", recordType: "A", line: TELECOM, values: ["198.51.100.1", "198.51.100.2", "198.51.100.3"],
    }),
    (error: any) => {
      assert.ok(error instanceof DdnsProviderError);
      assert.equal(error.code, "QuotaExceeded.ARecord");
      assert.match(error.message, /entry\.example\.com 在线路「中国电信」上的 A 记录条数超出了套餐上限/);
      assert.match(error.message, /QuotaExceeded\.ARecord/);
      return true;
    },
  );

  ali.perLineLimit = 10;
  ali.records = [];
  ali.rejectTtlBelow = 600;
  const result = await lines.publishDdnsLineRecords(settings(), { domain: "entry.example.com", recordType: "A", line: UNICOM, values: ["198.51.100.1"], ttl: 60 });
  assert.equal(result.recordIds.length, 1);
  assert.deepEqual(ali.on("entry", "A", "unicom").map((record) => record.TTL), [600]);
}));

test("华为云：一个记录集装这条线路的全部值；值没变不写，改值 PUT 同一个记录集（不带 line）", withFakes(async ({ hw }) => {
  const defaultSet = hw.add({ name: "entry.example.com.", type: "A", records: ["198.51.100.3"] });
  const otherName = hw.add({ name: "www.example.com.", type: "A", line: "Dianxin", records: ["203.0.113.9"] });

  const first = await lines.publishDdnsLineRecords(huawei(), {
    domain: "entry.example.com", recordType: "A", line: DIANXIN, values: ["198.51.100.1", "198.51.100.2"], ttl: 60,
  });
  assert.equal(first.writes, 1);
  const created = hw.on("entry.example.com.", "A", "Dianxin");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].records.sort(), ["198.51.100.1", "198.51.100.2"]);
  assert.equal(created[0].ttl, 60);
  assert.deepEqual(first.recordIds, [created[0].id]);
  const post = hw.writes()[0];
  assert.equal(post.method, "POST");
  assert.equal(post.body.line, "Dianxin");
  assert.equal(post.body.name, "entry.example.com.");
  // 没填 Zone ID：按域名往上找到 Zone。
  assert.ok(hw.calls.some((call) => call.path === "/v2/zones" && call.query.name === "entry.example.com."));
  assert.ok(hw.calls.some((call) => call.path === "/v2/zones" && call.query.name === "example.com."));
  const list = hw.calls.find((call) => call.method === "GET" && call.path.endsWith("/recordsets"))!;
  assert.deepEqual([list.query.line_id, list.query.type, list.query.name], ["Dianxin", "A", "entry.example.com."]);

  hw.calls = [];
  const same = await lines.publishDdnsLineRecords(huawei(), {
    domain: "entry.example.com", recordType: "A", line: DIANXIN, values: ["198.51.100.2", "198.51.100.1"], ttl: 60,
  });
  assert.equal(same.writes, 0);
  assert.deepEqual(hw.writes(), []);
  assert.ok(!hw.calls.some((call) => call.path === "/v2/zones"), "Zone 找过一次就记住");
  assert.deepEqual(same.recordIds, first.recordIds);

  hw.calls = [];
  const changed = await lines.publishDdnsLineRecords(huawei(), {
    domain: "entry.example.com", recordType: "A", line: DIANXIN, values: ["198.51.100.7"], ttl: 60,
  });
  assert.deepEqual(hw.writes().map((call) => call.method), ["PUT"]);
  assert.deepEqual(changed.recordIds, first.recordIds, "改值是改同一个记录集");
  assert.deepEqual(hw.on("entry.example.com.", "A", "Dianxin")[0].records, ["198.51.100.7"]);
  assert.deepEqual(hw.recordsets.find((item) => item.id === defaultSet.id)?.records, ["198.51.100.3"], "默认线路的记录集不动");
  assert.deepEqual(hw.recordsets.find((item) => item.id === otherName.id)?.records, ["203.0.113.9"]);
}));

test("华为云：删线路只删记下的记录集 ID；同线路别人建的、别的线路的都不动；配额不足、Zone 不对时说清楚", withFakes(async ({ hw }) => {
  const zoned = huawei({ huaweicloudZoneId: hw.zones[0].id });
  const published = await lines.publishDdnsLineRecords(zoned, { domain: "entry.example.com", recordType: "AAAA", line: LIANTONG, values: ["2001:db8::1"] });
  assert.ok(!hw.calls.some((call) => call.path === "/v2/zones"), "填了 Zone ID 不用按名字找");
  const manual = hw.add({ name: "entry.example.com.", type: "AAAA", line: "Liantong", records: ["2001:db8::99"] });
  const dianxin = hw.add({ name: "entry.example.com.", type: "AAAA", line: "Dianxin", records: ["2001:db8::2"] });

  hw.calls = [];
  const removed = await lines.deleteDdnsLineRecords(zoned, {
    domain: "entry.example.com", recordType: "AAAA", line: LIANTONG, recordIds: [...published.recordIds, dianxin.id, "ffffffffffffffffffffffffffffffff"],
  });
  assert.deepEqual(removed.deleted, published.recordIds);
  assert.equal(removed.untouched, 1);
  assert.deepEqual(hw.writes().map((call) => [call.method, call.path.split("/").pop()]), published.recordIds.map((id) => ["DELETE", id]));
  assert.ok(hw.recordsets.some((item) => item.id === manual.id), "别人在联通线路上建的记录集留着");
  assert.ok(hw.recordsets.some((item) => item.id === dianxin.id), "别的线路不能被删");

  hw.quota = hw.recordsets.length;
  await assert.rejects(
    lines.publishDdnsLineRecords(zoned, { domain: "entry.example.com", recordType: "A", line: DIANXIN, values: ["198.51.100.1"] }),
    (error: any) => {
      assert.equal(error.code, "DNS.0403");
      assert.match(error.message, /华为云 DNS 记录集配额不足，没法在线路「电信」上为 entry\.example\.com 新建 A 记录集/);
      return true;
    },
  );

  hw.calls = [];
  await assert.rejects(
    lines.publishDdnsLineRecords(zoned, { domain: "entry.other.org", recordType: "A", line: DIANXIN, values: ["198.51.100.1"] }),
    /不在主域名 example\.com 下/,
  );
  assert.deepEqual(hw.writes(), []);
}));

test("华为云：同一线路上多出来的同名同类型记录集按值对账时收掉（这个名字归面板管）", withFakes(async ({ hw }) => {
  const a = hw.add({ name: "entry.example.com.", type: "A", line: "Yidong", records: ["192.0.2.1"] });
  const b = hw.add({ name: "entry.example.com.", type: "A", line: "Yidong", records: ["198.51.100.5"] });
  const result = await lines.publishDdnsLineRecords(huawei(), { domain: "entry.example.com", recordType: "A", line: { id: "Yidong", name: "移动" }, values: ["198.51.100.5"] });
  assert.deepEqual(result.recordIds, [b.id], "值已经对的那个留着");
  assert.deepEqual(hw.writes().map((call) => [call.method, call.path.split("/").pop()]), [["DELETE", a.id]]);
}));

test("成员线路带服务商：老数据（没写 provider）是 DNSPod，存回去一个字节不变；换了服务商别家的线路不算", () => {
  const legacy = JSON.stringify([{ id: "10=0", name: "电信" }, { id: "10=1", name: "联通" }]);
  assert.equal(shared.serializeDdnsLines(legacy), legacy);
  assert.equal(shared.serializeDdnsLines([{ id: "10=0", name: "电信", provider: "tencentcloud" }]), JSON.stringify([{ id: "10=0", name: "电信" }]));
  const mixed = [{ id: "10=0", name: "电信" }, { id: "telecom", name: "中国电信", provider: "aliyun" }, { id: "Dianxin", name: "电信", provider: "huaweicloud" }];
  const stored = shared.serializeDdnsLines(mixed);
  assert.deepEqual(shared.parseDdnsLines(stored).map((line) => shared.ddnsLineKey(line)).sort(), ["aliyun:telecom", "huaweicloud:Dianxin", "tencentcloud:10=0"]);
  assert.deepEqual(shared.ddnsLinesForProvider(stored, "tencentcloud"), [{ id: "10=0", name: "电信" }]);
  assert.deepEqual(shared.ddnsLinesForProvider(stored, "aliyun"), [{ id: "telecom", name: "中国电信" }]);
  assert.deepEqual(shared.ddnsLinesForProvider(stored, "huaweicloud"), [{ id: "Dianxin", name: "电信" }]);
  assert.deepEqual(shared.ddnsLinesForProvider(legacy, "aliyun"), []);
  // 认不出的 provider 当 DNSPod（和老数据一样），不会凭空变成别家的线路。
  assert.deepEqual(shared.parseDdnsLines([{ id: "x1", name: "x", provider: "cloudflare" }]), [{ id: "x1", name: "x" }]);

  // 线路状态：老数据没有 provider = DNSPod；华为云的记录集 ID（十六进制）也认。
  const legacyState = shared.parseDdnsLineState(JSON.stringify({ v: 1, domain: "a.example.com", recordType: "A", lines: { "10=0": { id: "10=0", name: "电信", values: ["198.51.100.1"], recordIds: ["123"], memberIds: [1], source: "members", at: "" } } }));
  assert.equal(legacyState?.provider, "tencentcloud");
  assert.deepEqual(legacyState?.lines["10=0"].recordIds, ["123"]);
  const hwState = shared.parseDdnsLineState({ v: 1, provider: "huaweicloud", domain: "a.example.com", recordType: "A", lines: { Dianxin: { id: "Dianxin", name: "电信", values: [], recordIds: ["2c9eb155587228570158722b6ac30007", "bad id!"], memberIds: [], source: "members", at: "" } } });
  assert.equal(hwState?.provider, "huaweicloud");
  assert.deepEqual(hwState?.lines.Dianxin.recordIds, ["2c9eb155587228570158722b6ac30007"]);
  assert.equal(shared.parseDdnsLineState({ v: 1, provider: "somewhere", domain: "", recordType: "A", lines: {} })?.provider, "unknown");
});
