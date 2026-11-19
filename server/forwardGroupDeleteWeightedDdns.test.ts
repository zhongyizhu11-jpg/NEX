import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  删按权重发布过的入口组：只删面板自己发布的那几个值（组的 lastDdnsValue），同一个名字上别人加的记录
  一条都不碰 —— 华为云不把别人的记录集合并 / 删掉，腾讯云不把别人记录的权重改成 0，阿里云不在还有别人
  记录时关掉整个子域名的权重配置。
*/

process.env.DATABASE_TYPE = "sqlite";
process.env.FORWARDX_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-delete-weighted-"));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-delete-weighted-db-"));
const runtime = await import("./dbRuntime");
const { ensureDatabaseSchema } = await import("./dbSchema");
await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "d.db") } });
await ensureDatabaseSchema();
const settingsRepo = await import("./repositories/settingsRepository");
const weighted = await import("./ddnsWeightedRecords");
const { clearForwardGroupPublishedDdns } = await import("./forwardGroups/ddnsPublish");
const { resetDdnsProviderMinTtlCacheForTests } = await import("./ddns");

const A = "198.51.100.10";
const B = "198.51.100.20";
const FOREIGN = "203.0.113.99";

function weightedGroup(provider: string) {
  return {
    id: 7,
    groupMode: "entry",
    domain: "edge.example.com",
    recordType: "A",
    ddnsAutoResolveEnabled: true,
    lastDdnsAt: new Date(),
    lastDdnsValue: `${A},${B}`,
    ddnsWeightState: JSON.stringify({ provider, domain: "edge.example.com", recordType: "A", weights: { [A]: 100, [B]: 50 } }),
    members: [],
  };
}

test.after(() => {
  weighted.configureDdnsWeightedRecordsForTests(null);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("华为云：删组只删面板发布的记录集，别人加的记录集留着", async () => {
  await settingsRepo.setSettings({ ddnsEnabled: "true", ddnsProvider: "huaweicloud", ddnsHuaweiCloudAccessKeyId: "a", ddnsHuaweiCloudSecretKey: "b", ddnsHuaweiCloudLine: "default_view" });
  let sets: any[] = [
    { id: "s1", name: "edge.example.com.", type: "A", records: [A], weight: 100, line: "default_view", zone_id: "z", ttl: 60 },
    { id: "s2", name: "edge.example.com.", type: "A", records: [B], weight: 50, line: "default_view", zone_id: "z", ttl: 60 },
    { id: "foreign", name: "edge.example.com.", type: "A", records: [FOREIGN], weight: 5, line: "default_view", zone_id: "z", ttl: 60 },
    { id: "mixed", name: "edge.example.com.", type: "A", records: [A, "203.0.113.7"], weight: 1, line: "default_view", zone_id: "z", ttl: 60 },
  ];
  const transport = async (method: string, p: string, _q: any, body?: any) => {
    if (method === "GET" && p === "/v2.1/recordsets") return { recordsets: sets.map((set) => ({ ...set, records: [...set.records] })) };
    const id = decodeURIComponent(p.split("/").pop()!);
    if (method === "DELETE") { sets = sets.filter((s) => s.id !== id); return {}; }
    if (method === "PUT") { const s = sets.find((x) => x.id === id); Object.assign(s, { records: body.records, weight: body.weight ?? s.weight }); return {}; }
    throw new Error(`unexpected ${method} ${p}`);
  };
  weighted.configureDdnsWeightedRecordsForTests({ huawei: () => transport as any });
  await clearForwardGroupPublishedDdns(weightedGroup("huaweicloud"));
  assert.deepEqual(sets.map((s) => [s.id, s.records, s.weight]), [
    ["foreign", [FOREIGN], 5],
    // 装着面板值和别人值的记录集：只拿掉面板的那个值，权重不动
    ["mixed", ["203.0.113.7"], 1],
  ]);
});

test("腾讯云：删组只删面板发布的值，别人记录的权重不改", async () => {
  resetDdnsProviderMinTtlCacheForTests();
  await settingsRepo.setSettings({ ddnsEnabled: "true", ddnsProvider: "tencentcloud", ddnsTencentCloudSecretId: "a", ddnsTencentCloudSecretKey: "b", ddnsTencentCloudDomainName: "example.com" });
  let records: any[] = [
    { RecordId: 1, Name: "edge", Type: "A", Line: "默认", Value: A, TTL: 60, Weight: 100 },
    { RecordId: 2, Name: "edge", Type: "A", Line: "默认", Value: B, TTL: 60, Weight: 50 },
    { RecordId: 3, Name: "edge", Type: "A", Line: "默认", Value: FOREIGN, TTL: 60, Weight: 5 },
  ];
  const calls: string[] = [];
  const transport = async (action: string, payload: any) => {
    calls.push(action);
    if (action === "DescribeRecordList") return { RecordList: records.map((record) => ({ ...record })) };
    if (action === "DeleteRecord") { records = records.filter((record) => record.RecordId !== payload.RecordId); return {}; }
    if (action === "ModifyRecord") { Object.assign(records.find((record) => record.RecordId === payload.RecordId), { Weight: payload.Weight }); return {}; }
    throw new Error(`unexpected ${action}`);
  };
  weighted.configureDdnsWeightedRecordsForTests({ tencent: () => transport as any });
  await clearForwardGroupPublishedDdns(weightedGroup("tencentcloud"));
  assert.deepEqual(records.map((record) => [record.Value, record.Weight]), [[FOREIGN, 5]]);
  assert.equal(calls.includes("ModifyRecord"), false, "删组不改任何记录的权重");
});

test("阿里云：删组只删面板发布的值；子域名上还有别人的记录时不关权重配置，没有了才关", async () => {
  resetDdnsProviderMinTtlCacheForTests();
  await settingsRepo.setSettings({ ddnsEnabled: "true", ddnsProvider: "aliyun", ddnsAliyunAccessKeyId: "a", ddnsAliyunAccessKeySecret: "b", ddnsAliyunDomainName: "example.com" });
  let records: any[] = [];
  let slbOpen = true;
  const calls: string[] = [];
  const transport = async (action: string, params: any) => {
    calls.push(action);
    if (action === "DescribeSubDomainRecords") return { DomainRecords: { Record: records.map((record) => ({ ...record })) } };
    if (action === "DeleteDomainRecord") { records = records.filter((record) => record.RecordId !== params.RecordId); return {}; }
    if (action === "SetDNSSLBStatus") { slbOpen = params.Open === "true"; return {}; }
    throw new Error(`unexpected ${action}`);
  };
  weighted.configureDdnsWeightedRecordsForTests({ aliyun: () => transport as any });
  records = [
    { RecordId: "1", RR: "edge", Type: "A", Line: "default", Value: A, TTL: 60, Weight: 100 },
    { RecordId: "2", RR: "edge", Type: "A", Line: "default", Value: B, TTL: 60, Weight: 50 },
    { RecordId: "3", RR: "edge", Type: "A", Line: "default", Value: FOREIGN, TTL: 60, Weight: 5 },
  ];
  await clearForwardGroupPublishedDdns(weightedGroup("aliyun"));
  assert.deepEqual(records.map((record) => record.Value), [FOREIGN]);
  assert.equal(slbOpen, true, "别人的记录还在：权重配置不关");
  assert.equal(calls.includes("SetDNSSLBStatus"), false);

  records = [
    { RecordId: "1", RR: "edge", Type: "A", Line: "default", Value: A, TTL: 60, Weight: 100 },
    { RecordId: "2", RR: "edge", Type: "A", Line: "default", Value: B, TTL: 60, Weight: 50 },
  ];
  calls.length = 0;
  await clearForwardGroupPublishedDdns(weightedGroup("aliyun"));
  assert.deepEqual(records, []);
  assert.equal(slbOpen, false, "子域名上只剩面板的记录、删完了：顺手把权重配置关掉");
});
