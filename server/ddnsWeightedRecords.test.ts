import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  入口组「按权重解析」在腾讯云 DNSPod、阿里云 DNS、华为云 DNS 上的读写（server/ddnsWeightedRecords.ts），
  以及份额换权重的纯逻辑（shared/ddnsWeights.ts）。三家各换成一个假的传输层，记下每一次调用：
  看记录怎么对账、权重设成多少、权重没变时是不是一个写请求都不发、关掉后怎么收回去。
*/

process.env.FORWARDX_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ddns-weights-"));

const { DdnsProviderError, resetDdnsProviderMinTtlCacheForTests } = await import("./ddns");
const weighted = await import("./ddnsWeightedRecords");
const shared = await import("../shared/ddnsWeights");
const { buildBandwidthAggregationPlan } = await import("../shared/bandwidthAggregation");

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
    tencentcloudSecretId: "tc-id",
    tencentcloudSecretKey: "tc-key",
    tencentcloudDomainName: "example.com",
    tencentcloudTtl: 60,
    tencentcloudRecordLine: "默认",
    tencentcloudRecordLineId: "",
    ...patch,
  } as any;
}

const A = "198.51.100.10";
const B = "198.51.100.20";
const C = "198.51.100.30";

// ===== 纯逻辑 =====

test("哪家服务商支持记录权重，不支持的给出一句原因", () => {
  for (const provider of ["tencentcloud", "aliyun", "huaweicloud"]) {
    assert.deepEqual(shared.ddnsWeightSupportForProvider(provider), { supported: true, provider, reason: null });
  }
  const cloudflare = shared.ddnsWeightSupportForProvider("cloudflare");
  assert.equal(cloudflare.supported, false);
  assert.match(cloudflare.reason || "", /Cloudflare/);
  assert.match(shared.ddnsWeightSupportForProvider("webhook").reason || "", /Webhook/);
  assert.match(shared.ddnsWeightSupportForProvider("disabled").reason || "", /没有启用/);
  assert.equal(shared.ddnsWeightSupportForProvider("tencentcloud", false).supported, false);
  assert.equal(shared.ddnsWeightRecordTypeSupported("AAAA"), true);
  assert.equal(shared.ddnsWeightRecordTypeSupported("CNAME"), false);
  // 凭据没填全：服务端说不支持
  assert.equal(weighted.ddnsWeightSupport(settings({ tencentcloudSecretKey: "" })).supported, false);
  assert.equal(weighted.ddnsWeightSupport(settings({ provider: "huaweicloud" })).supported, true);
});

test("聚合份额换成记录权重：最大的是 100，其余按比例，最小 1", () => {
  const plan = buildBandwidthAggregationPlan([
    { memberId: 1, value: A, bandwidthMbps: 1000 },
    { memberId: 2, value: B, bandwidthMbps: 500 },
    { memberId: 3, value: C, bandwidthMbps: 1 },
  ], { strategy: "capacity" });
  assert.deepEqual(shared.ddnsWeightsFromAggregationPlan(plan, [A, B, C]), { [A]: 100, [B]: 50, [C]: 1 });
  // 只发布其中两台时按这两台重新定满分
  assert.deepEqual(shared.ddnsWeightsFromAggregationPlan(plan, [B, C]), { [B]: 100, [C]: 1 });
  // 不足两条、聚合没生效、有值找不到成员：这一轮不带权重
  assert.equal(shared.ddnsWeightsFromAggregationPlan(plan, [A]), null);
  assert.equal(shared.ddnsWeightsFromAggregationPlan({ ...plan, degraded: true }, [A, B]), null);
  assert.equal(shared.ddnsWeightsFromAggregationPlan({ ...plan, enabled: false }, [A, B]), null);
  assert.equal(shared.ddnsWeightsFromAggregationPlan(plan, [A, "203.0.113.1"]), null);
  assert.equal(shared.ddnsWeightsFromAggregationPlan(null, [A, B]), null);
});

test("权重是否变了：值的集合相同且差在死区内算没变", () => {
  assert.equal(shared.ddnsWeightsEqual({ [A]: 100, [B]: 50 }, { [B]: 50, [A]: 100 }), true);
  assert.equal(shared.ddnsWeightsEqual({ [A]: 100, [B]: 50 }, { [A]: 100, [B]: 60 }), false);
  assert.equal(shared.ddnsWeightsEqual({ [A]: 100, [B]: 50 }, { [A]: 100, [B]: 60 }, shared.DDNS_WEIGHT_ADAPTIVE_TOLERANCE), true);
  assert.equal(shared.ddnsWeightsEqual({ [A]: 100 }, { [A]: 100, [B]: 100 }), false);
  assert.equal(shared.ddnsWeightsEqual(null, null), true);
  assert.equal(shared.ddnsWeightsEqual(null, { [A]: 1 }), false);
  assert.deepEqual(shared.parseDdnsWeightState(JSON.stringify({ provider: "aliyun", domain: "Edge.Example.com", recordType: "a", weights: { [A]: 100, [B]: 0, bad: "x" } })), {
    provider: "aliyun", domain: "edge.example.com", recordType: "A", weights: { [A]: 100 },
  });
  assert.equal(shared.parseDdnsWeightState("{oops"), null);
  assert.equal(shared.describeDdnsWeights({ [A]: 100, [B]: 40 }, [B, A]), `${B}=40、${A}=100`);
});

// ===== 腾讯云 DNSPod =====

type TcRecord = { RecordId: number; Name: string; Type: string; Line: string; LineId: string; Value: string; TTL: number; Weight: number | null };

class FakeDnspod {
  records: TcRecord[] = [];
  calls: Array<{ action: string; payload: Record<string, any> }> = [];
  nextId = 5000;
  add(record: Partial<TcRecord> & { Name: string; Value: string }) {
    const full: TcRecord = { RecordId: this.nextId++, Type: "A", Line: "默认", LineId: "0", TTL: 600, Weight: null, ...record };
    this.records.push(full);
    return full;
  }
  writes() { return this.calls.filter((call) => call.action !== "DescribeRecordList"); }
  transport = async (action: string, payload: Record<string, any>) => {
    this.calls.push({ action, payload: { ...payload } });
    if (action === "DescribeRecordList") {
      return { RecordList: this.records.filter((record) => record.Name === payload.Subdomain && record.Type === payload.RecordType && record.Line === payload.RecordLine).map((record) => ({ ...record })) };
    }
    if (action === "CreateRecord") {
      const record = this.add({ Name: payload.SubDomain, Type: payload.RecordType, Line: payload.RecordLine, Value: payload.Value, TTL: payload.TTL, Weight: payload.Weight ?? null });
      return { RecordId: record.RecordId };
    }
    if (action === "ModifyRecord") {
      const record = this.records.find((item) => item.RecordId === payload.RecordId);
      if (!record) throw new DdnsProviderError("记录不存在", "InvalidParameter.RecordIdInvalid");
      record.Value = payload.Value;
      record.TTL = payload.TTL;
      if (payload.Weight !== undefined) record.Weight = payload.Weight;
      return { RecordId: record.RecordId };
    }
    if (action === "DeleteRecord") {
      this.records = this.records.filter((item) => item.RecordId !== payload.RecordId);
      return {};
    }
    throw new Error(`unexpected DNSPod action ${action}`);
  };
}

test("DNSPod：新建 / 改值 / 留着的记录都带上 Weight，权重没变时不发写请求", async () => {
  resetDdnsProviderMinTtlCacheForTests();
  const fake = new FakeDnspod();
  fake.add({ Name: "edge", Value: A });
  fake.add({ Name: "edge", Value: "203.0.113.99" });
  fake.add({ Name: "edge", Value: "203.0.113.5", Line: "电信", LineId: "10=0" });
  fake.add({ Name: "other", Value: A });
  weighted.configureDdnsWeightedRecordsForTests({ tencent: () => fake.transport });
  try {
    const result = await weighted.publishWeightedDdnsRecords(settings(), { domain: "edge.example.com", recordType: "A", values: [A, B, C], weights: { [A]: 100, [B]: 50, [C]: 7 }, ttl: 60 });
    assert.equal(result.writes, 3);
    const onDefault = fake.records.filter((record) => record.Name === "edge" && record.Line === "默认");
    assert.deepEqual(onDefault.map((record) => [record.Value, record.Weight]).sort(), [[A, 100], [B, 50], [C, 7]]);
    // 没用上的那条被改成了缺的值（带权重）；另一条线路、另一个名字的记录没动
    assert.deepEqual(fake.writes().map((call) => [call.action, call.payload.Value, call.payload.Weight]), [
      ["ModifyRecord", B, 50],
      ["CreateRecord", C, 7],
      ["ModifyRecord", A, 100],
    ]);
    assert.equal(fake.records.find((record) => record.Line === "电信")?.Weight, null);
    assert.equal(fake.records.find((record) => record.Name === "other")?.Weight, null);

    fake.calls = [];
    assert.equal((await weighted.publishWeightedDdnsRecords(settings(), { domain: "edge.example.com", recordType: "A", values: [A, B, C], weights: { [A]: 100, [B]: 50, [C]: 7 } })).writes, 0);
    assert.deepEqual(fake.writes(), [], "值和权重都没变：只列一次，不写");

    // 少了一台、权重变了：删多余的，只改权重变了的那条
    fake.calls = [];
    await weighted.publishWeightedDdnsRecords(settings(), { domain: "edge.example.com", recordType: "A", values: [A, B], weights: { [A]: 100, [B]: 80 } });
    assert.deepEqual(fake.writes().map((call) => [call.action, call.payload.Value ?? call.payload.RecordId, call.payload.Weight]), [
      ["ModifyRecord", B, 80],
      ["DeleteRecord", fake.calls.find((call) => call.action === "DeleteRecord")!.payload.RecordId, undefined],
    ]);

    // 不按权重了：每条记录 Weight 设回 0（关闭），值不动
    fake.calls = [];
    assert.equal((await weighted.clearDdnsRecordWeights(settings(), { domain: "edge.example.com", recordType: "A", values: [A, B] })).writes, 2);
    assert.deepEqual(fake.writes().map((call) => [call.action, call.payload.Value, call.payload.Weight]), [["ModifyRecord", A, 0], ["ModifyRecord", B, 0]]);
    fake.calls = [];
    assert.equal((await weighted.clearDdnsRecordWeights(settings(), { domain: "edge.example.com", recordType: "A", values: [A, B] })).writes, 0, "已经关了的不再写");
  } finally {
    weighted.configureDdnsWeightedRecordsForTests(null);
  }
});

test("只支持 A / AAAA；不支持的服务商直接报原因", async () => {
  await assert.rejects(
    weighted.publishWeightedDdnsRecords(settings(), { domain: "edge.example.com", recordType: "CNAME", values: ["a.example.net", "b.example.net"], weights: {} }),
    /只支持 A \/ AAAA/,
  );
  await assert.rejects(
    weighted.publishWeightedDdnsRecords(settings({ provider: "cloudflare" }), { domain: "edge.example.com", recordType: "A", values: [A, B], weights: { [A]: 1, [B]: 1 } }),
    /Cloudflare/,
  );
});

// ===== 阿里云 DNS =====

type AliRecord = { RecordId: string; RR: string; Type: string; Line: string; Value: string; TTL: number; Weight?: number };

class FakeAliyun {
  records: AliRecord[] = [];
  calls: Array<{ action: string; params: Record<string, any> }> = [];
  slbOpen = false;
  nextId = 880000;
  /** DescribeSubDomainRecords 回不回 Weight（文档没写清，两种都要能跑）。 */
  listWeights = true;
  add(record: Partial<AliRecord> & { RR: string; Value: string }) {
    const full: AliRecord = { RecordId: String(this.nextId++), Type: "A", Line: "default", TTL: 600, ...record };
    this.records.push(full);
    return full;
  }
  writes() { return this.calls.filter((call) => !call.action.startsWith("Describe")); }
  transport = async (action: string, params: Record<string, any>) => {
    this.calls.push({ action, params: { ...params } });
    if (action === "DescribeSubDomainRecords") {
      const rr = String(params.SubDomain).replace(/\.example\.com$/, "");
      return { DomainRecords: { Record: this.records.filter((record) => record.RR === rr && record.Type === params.Type && record.Line === params.Line).map((record) => {
        const { Weight, ...rest } = record;
        return this.listWeights && Weight !== undefined ? { ...rest, Weight } : rest;
      }) } };
    }
    if (action === "AddDomainRecord") return { RecordId: this.add({ RR: params.RR, Type: params.Type, Line: params.Line, Value: params.Value, TTL: params.TTL }).RecordId };
    if (action === "UpdateDomainRecord") {
      const record = this.records.find((item) => item.RecordId === params.RecordId)!;
      record.Value = params.Value;
      record.Weight = undefined;
      return { RecordId: record.RecordId };
    }
    if (action === "DeleteDomainRecord") {
      this.records = this.records.filter((item) => item.RecordId !== params.RecordId);
      return {};
    }
    if (action === "SetDNSSLBStatus") {
      this.slbOpen = params.Open === "true";
      return { Open: this.slbOpen, RecordCount: this.records.length };
    }
    if (action === "UpdateDNSSLBWeight") {
      if (!this.slbOpen) throw new DdnsProviderError("权重配置未开启", "DisableDNSSLB");
      const record = this.records.find((item) => item.RecordId === params.RecordId)!;
      record.Weight = Number(params.Weight);
      return { RecordId: record.RecordId, Weight: record.Weight };
    }
    throw new Error(`unexpected Aliyun action ${action}`);
  };
}

test("阿里云：先对账记录，再打开权重配置、逐条设权重；没变的不重设", async () => {
  resetDdnsProviderMinTtlCacheForTests();
  const fake = new FakeAliyun();
  fake.add({ RR: "edge", Value: A });
  fake.add({ RR: "edge", Value: "203.0.113.5", Line: "telecom" });
  const ali = settings({ provider: "aliyun" });
  weighted.configureDdnsWeightedRecordsForTests({ aliyun: () => fake.transport });
  try {
    await weighted.publishWeightedDdnsRecords(ali, { domain: "edge.example.com", recordType: "A", values: [A, B], weights: { [A]: 100, [B]: 30 } });
    assert.deepEqual(fake.writes().map((call) => call.action), ["AddDomainRecord", "SetDNSSLBStatus", "UpdateDNSSLBWeight", "UpdateDNSSLBWeight"]);
    const slb = fake.calls.find((call) => call.action === "SetDNSSLBStatus")!.params;
    assert.deepEqual(slb, { DomainName: "example.com", SubDomain: "edge.example.com", Type: "A", Line: "default", Open: "true" });
    assert.deepEqual(fake.records.filter((record) => record.Line === "default").map((record) => [record.Value, record.Weight]), [[A, 100], [B, 30]]);
    assert.equal(fake.records.find((record) => record.Line === "telecom")?.Weight, undefined, "别的线路的记录不设权重");

    fake.calls = [];
    assert.equal((await weighted.publishWeightedDdnsRecords(ali, { domain: "edge.example.com", recordType: "A", values: [A, B], weights: { [A]: 100, [B]: 30 } })).writes, 0);
    assert.deepEqual(fake.writes(), [], "列表里带着权重、没变：一个写请求都不发");

    // 只改了一台的权重
    fake.calls = [];
    await weighted.publishWeightedDdnsRecords(ali, { domain: "edge.example.com", recordType: "A", values: [A, B], weights: { [A]: 100, [B]: 60 } });
    assert.deepEqual(fake.writes().map((call) => [call.action, call.params.Weight]), [["SetDNSSLBStatus", undefined], ["UpdateDNSSLBWeight", 60]]);

    // 列表不回 Weight 的话每次都设一遍（结果一样，只是多几个请求）
    fake.listWeights = false;
    fake.calls = [];
    await weighted.publishWeightedDdnsRecords(ali, { domain: "edge.example.com", recordType: "A", values: [A, B], weights: { [A]: 100, [B]: 60 } });
    assert.deepEqual(fake.writes().map((call) => call.action), ["SetDNSSLBStatus", "UpdateDNSSLBWeight", "UpdateDNSSLBWeight"]);

    // 不按权重了：关掉这个子域名的权重配置
    fake.calls = [];
    await weighted.clearDdnsRecordWeights(ali, { domain: "edge.example.com", recordType: "A", values: [A, B] });
    assert.deepEqual(fake.writes().map((call) => [call.action, call.params.Open]), [["SetDNSSLBStatus", "false"]]);
    assert.equal(fake.slbOpen, false);
  } finally {
    weighted.configureDdnsWeightedRecordsForTests(null);
  }
});

test("阿里云：服务商拒绝关闭权重配置不算失败（本来就没开），网络错误照常抛出", async () => {
  const ali = settings({ provider: "aliyun" });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    weighted.configureDdnsWeightedRecordsForTests({ aliyun: () => async () => { throw new DdnsProviderError("not open", "DnsSLB.NotOpen"); } });
    assert.deepEqual(await weighted.clearDdnsRecordWeights(ali, { domain: "edge.example.com", recordType: "A", values: [A] }), { writes: 0 });
    weighted.configureDdnsWeightedRecordsForTests({ aliyun: () => async () => { throw new Error("DDNS 请求超时"); } });
    await assert.rejects(weighted.clearDdnsRecordWeights(ali, { domain: "edge.example.com", recordType: "A", values: [A] }), /超时/);
  } finally {
    console.warn = originalWarn;
    weighted.configureDdnsWeightedRecordsForTests(null);
  }
});

// ===== 华为云 DNS =====

type HwSet = { id: string; zone_id: string; name: string; type: string; line: string; ttl: number; records: string[]; weight: number | null };

class FakeHuawei {
  sets: HwSet[] = [];
  calls: Array<{ method: string; path: string; query: Record<string, any>; body?: any }> = [];
  nextId = 1;
  add(set: Partial<HwSet> & { records: string[] }) {
    const full: HwSet = { id: `rs${this.nextId++}`, zone_id: "zone1", name: "edge.example.com.", type: "A", line: "default_view", ttl: 300, weight: 1, ...set };
    this.sets.push(full);
    return full;
  }
  writes() { return this.calls.filter((call) => call.method !== "GET"); }
  transport = async (method: string, pathName: string, query: Record<string, any>, body?: any) => {
    this.calls.push({ method, path: pathName, query: { ...query }, body: body ? JSON.parse(JSON.stringify(body)) : undefined });
    if (method === "GET" && pathName === "/v2.1/recordsets") {
      return { recordsets: this.sets.filter((set) => set.name === query.name && set.type === query.type && set.line === query.line_id).map((set) => ({ ...set, records: [...set.records] })) };
    }
    if (method === "GET" && pathName === "/v2/zones") {
      return { zones: query.name === "example.com." ? [{ id: "zone1", name: "example.com." }] : [] };
    }
    const base = "/v2.1/zones/zone1/recordsets";
    if (method === "POST" && pathName === base) {
      const set = this.add({ name: body.name, type: body.type, line: body.line || "default_view", ttl: body.ttl, records: body.records, weight: body.weight ?? 1 });
      return { id: set.id };
    }
    const id = pathName.startsWith(`${base}/`) ? pathName.slice(base.length + 1) : "";
    const set = this.sets.find((item) => item.id === id);
    if (!set) throw new DdnsProviderError("记录集不存在", "DNS.0312");
    if (method === "PUT") {
      set.records = body.records;
      if (body.weight !== undefined) set.weight = body.weight;
      return { id: set.id };
    }
    if (method === "DELETE") {
      this.sets = this.sets.filter((item) => item.id !== id);
      return {};
    }
    throw new Error(`unexpected Huawei call ${method} ${pathName}`);
  };
}

test("华为云：把「一个记录集装全部值」拆成一个值一个记录集、各带各的 weight；关掉后合回去", async () => {
  const fake = new FakeHuawei();
  const combined = fake.add({ records: [A, B] });
  fake.add({ records: ["203.0.113.5"], line: "Dianxin" });
  const hw = settings({ provider: "huaweicloud" });
  weighted.configureDdnsWeightedRecordsForTests({ huawei: () => fake.transport });
  try {
    await weighted.publishWeightedDdnsRecords(hw, { domain: "edge.example.com", recordType: "A", values: [A, B, C], weights: { [A]: 100, [B]: 50, [C]: 10 }, ttl: 60 });
    const onDefault = fake.sets.filter((set) => set.line === "default_view");
    assert.deepEqual(onDefault.map((set) => [set.records, set.weight]), [[[A], 100], [[B], 50], [[C], 10]]);
    // 老的那个记录集改成了第一个值，其余新建；任何时刻一个值只在一个记录集里
    assert.deepEqual(fake.writes().map((call) => [call.method, call.body?.records, call.body?.weight, call.body?.line]), [
      ["PUT", [A], 100, undefined],
      ["POST", [B], 50, "default_view"],
      ["POST", [C], 10, "default_view"],
    ]);
    assert.equal(fake.writes()[0].path.endsWith(combined.id), true);
    assert.deepEqual(fake.sets.find((set) => set.line === "Dianxin")?.records, ["203.0.113.5"], "别的线路的记录集不动");

    fake.calls = [];
    assert.equal((await weighted.publishWeightedDdnsRecords(hw, { domain: "edge.example.com", recordType: "A", values: [A, B, C], weights: { [A]: 100, [B]: 50, [C]: 10 } })).writes, 0);

    // 少一台 + 改权重：删多余的记录集，只改权重变了的
    fake.calls = [];
    await weighted.publishWeightedDdnsRecords(hw, { domain: "edge.example.com", recordType: "A", values: [A, B], weights: { [A]: 100, [B]: 70 } });
    assert.deepEqual(fake.writes().map((call) => [call.method, call.body?.records, call.body?.weight]), [["DELETE", undefined, undefined], ["PUT", [B], 70]]);

    // 关掉：合回一个记录集（weight 设回 1）
    fake.calls = [];
    await weighted.clearDdnsRecordWeights(hw, { domain: "edge.example.com", recordType: "A", values: [A, B] });
    assert.deepEqual(fake.sets.filter((set) => set.line === "default_view").map((set) => [set.records, set.weight]), [[[A, B], 1]]);
    assert.deepEqual(fake.writes().map((call) => call.method), ["DELETE", "PUT"]);
    // 要清空记录时：只收到剩一个记录集，剩下那个留给默认的发布路径删
    fake.add({ records: [C], weight: 5 });
    fake.calls = [];
    await weighted.clearDdnsRecordWeights(hw, { domain: "edge.example.com", recordType: "A", values: [] });
    assert.equal(fake.sets.filter((set) => set.line === "default_view").length, 1);
    assert.deepEqual(fake.writes().map((call) => call.method), ["DELETE"]);
  } finally {
    weighted.configureDdnsWeightedRecordsForTests(null);
  }
});

test("华为云：这个名字还没有记录集时按域名找 Zone 再新建", async () => {
  const fake = new FakeHuawei();
  weighted.configureDdnsWeightedRecordsForTests({ huawei: () => fake.transport });
  try {
    await weighted.publishWeightedDdnsRecords(settings({ provider: "huaweicloud" }), { domain: "edge.example.com", recordType: "A", values: [A, B], weights: { [A]: 100, [B]: 100 } });
    assert.deepEqual(fake.calls.filter((call) => call.method === "GET").map((call) => [call.path, call.query.name]), [
      ["/v2.1/recordsets", "edge.example.com."],
      ["/v2/zones", "edge.example.com."],
      ["/v2/zones", "example.com."],
    ]);
    assert.deepEqual(fake.sets.map((set) => [set.records, set.weight]), [[[A], 100], [[B], 100]]);
  } finally {
    weighted.configureDdnsWeightedRecordsForTests(null);
  }
});
