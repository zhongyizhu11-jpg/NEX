import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  DNSPod 解析记录管理（server/dnspodRecords.ts）。DNSPod 换成一个假的传输层：按 action 记账、
  按 Offset/Limit 分页，能在指定的请求上出错 —— 不碰网络，也不需要真实凭据。
*/

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-dnspod-records-"));
process.env.FORWARDX_LOG_DIR = logDir;

const { DdnsProviderError } = await import("./ddns");
const records = await import("./dnspodRecords");
const { buildDnsManagedIndex, dnsManagedOwnersOf } = await import("./dnsManagedNames");
const { remainingDnspodChanges } = await import("@shared/dnspodRecords");
const { flushJsonLogWrites } = await import("./logFileStore");

type FakeRecord = {
  RecordId: number;
  Name: string;
  Type: string;
  Line: string;
  LineId: string;
  Value: string;
  TTL: number;
  Status: string;
  Weight: number | null;
};

const LINES = [
  { Name: "默认", LineId: "0" },
  { Name: "电信", LineId: "10=0" },
  { Name: "联通", LineId: "10=1" },
  { Name: "移动", LineId: "10=3" },
  { Name: "境外", LineId: "3=0" },
  { Name: "教育网", LineId: "10=2" },
];

class FakeDnspod {
  records: FakeRecord[] = [];
  calls: Array<{ action: string; payload: Record<string, any> }> = [];
  nextId = 1000;
  /** 返回值不是 undefined 时就用它（可以抛错）代替正常处理。 */
  override: (action: string, payload: Record<string, any>, callIndex: number) => unknown = () => undefined;

  add(record: Partial<FakeRecord> & { Name: string; Type: string; Value: string }) {
    const full: FakeRecord = { RecordId: this.nextId++, Line: "默认", LineId: "0", TTL: 600, Status: "ENABLE", Weight: null, ...record };
    this.records.push(full);
    return full;
  }

  writes() {
    return this.calls.filter((call) => ["CreateRecord", "ModifyRecord", "DeleteRecord"].includes(call.action));
  }

  transport = async (action: string, payload: Record<string, any>) => {
    const index = this.calls.length;
    this.calls.push({ action, payload });
    const overridden = this.override(action, payload, index);
    if (overridden !== undefined) return overridden;
    switch (action) {
      case "DescribeDomainList":
        return { DomainCountInfo: { AllTotal: 1 }, DomainList: [{ DomainId: 1, Name: "example.com", Grade: "DP_FREE", Status: "ENABLE", RecordCount: this.records.length }] };
      case "DescribeDomain":
        return { DomainInfo: { Domain: "example.com", Grade: "DP_FREE" } };
      case "DescribeRecordLineList":
        assert.equal(payload.DomainGrade, "DP_FREE");
        return { LineList: LINES, LineGroupList: [] };
      case "DescribeRecordList": {
        const page = this.records.slice(payload.Offset, payload.Offset + payload.Limit);
        return { RecordCountInfo: { TotalCount: this.records.length, ListCount: page.length }, RecordList: page.map((record) => ({ ...record })) };
      }
      case "DescribeRecord": {
        const record = this.records.find((item) => item.RecordId === payload.RecordId);
        if (!record) throw new DdnsProviderError("记录不存在", "ResourceNotFound.NoDataOfRecord");
        return {
          RecordInfo: {
            Id: record.RecordId, SubDomain: record.Name, RecordType: record.Type, RecordLine: record.Line,
            RecordLineId: record.LineId, Value: record.Value, TTL: record.TTL, Enabled: record.Status === "ENABLE" ? 1 : 0, Weight: record.Weight,
          },
        };
      }
      case "CreateRecord": {
        const created = this.add({ Name: payload.SubDomain, Type: payload.RecordType, Value: payload.Value, Line: payload.RecordLine, LineId: payload.RecordLineId, TTL: payload.TTL });
        return { RecordId: created.RecordId };
      }
      case "ModifyRecord": {
        const record = this.records.find((item) => item.RecordId === payload.RecordId);
        if (!record) throw new DdnsProviderError("记录不存在", "InvalidParameter.RecordIdInvalid");
        Object.assign(record, { Name: payload.SubDomain, Type: payload.RecordType, Value: payload.Value, Line: payload.RecordLine, LineId: payload.RecordLineId, TTL: payload.TTL });
        if (payload.Status) record.Status = payload.Status;
        return { RecordId: record.RecordId };
      }
      case "DeleteRecord":
        this.records = this.records.filter((item) => item.RecordId !== payload.RecordId);
        return {};
      default:
        throw new Error(`unexpected action ${action}`);
    }
  };
}

function setup(options: { pageSize?: number; maxPages?: number; managed?: Parameters<typeof buildDnsManagedIndex>[0] } = {}) {
  const fake = new FakeDnspod();
  const managed = buildDnsManagedIndex(options.managed || { hosts: [], forwardGroups: [], rules: [], ruleCleanups: [], landingPools: [] });
  records.configureDnspodRecordsForTests({
    transport: async () => fake.transport,
    managedIndex: async () => managed,
    pageSize: options.pageSize ?? 100,
    maxPages: options.maxPages ?? 50,
    sleep: async () => undefined,
  });
  return fake;
}

test.after(() => {
  records.configureDnspodRecordsForTests(null);
  fs.rmSync(logDir, { recursive: true, force: true });
});

test("分页读完整：按 Offset/Limit 翻完所有页，按完整子域名分组", async () => {
  const fake = setup({ pageSize: 3 });
  for (let index = 0; index < 7; index += 1) fake.add({ Name: index % 2 ? "www" : "api", Type: "A", Value: `198.51.100.${index + 1}` });
  fake.add({ Name: "@", Type: "NS", Value: "f1g1ns1.dnspod.net." });

  const result = await records.listDnspodRecords("Example.COM.");
  assert.equal(result.domain, "example.com");
  assert.equal(result.total, 8);
  assert.deepEqual(fake.calls.filter((call) => call.action === "DescribeRecordList").map((call) => call.payload.Offset), [0, 3, 6]);
  assert.deepEqual(result.groups.map((group) => group.fqdn), ["example.com", "api.example.com", "www.example.com"]);
  assert.equal(result.groups[1].records.length, 4);
  assert.equal(result.groups[2].records.length, 3);
  // NS 这类只显示、不让改
  const ns = result.groups[0].records[0];
  assert.equal(ns.editable, false);
  assert.match(String(ns.readOnlyReason), /A \/ AAAA \/ CNAME/);
  assert.equal(result.groups[1].records[0].editable, true);
});

test("翻页期间总数变了：整份重读；一直对不上就报错，不给半份", async () => {
  const fake = setup({ pageSize: 2 });
  for (let index = 0; index < 5; index += 1) fake.add({ Name: `n${index}`, Type: "A", Value: `198.51.100.${index + 1}` });
  // 第一轮第二页时有人加了一条：TotalCount 变了，整轮作废重读。
  let mutated = false;
  fake.override = (action, payload) => {
    if (action === "DescribeRecordList" && payload.Offset === 2 && !mutated) {
      mutated = true;
      fake.add({ Name: "late", Type: "A", Value: "198.51.100.99" });
    }
    return undefined;
  };
  const result = await records.listDnspodRecords("example.com");
  assert.equal(result.total, 6);

  // 每次都给短页（没到总数就没了）：重读几次后报错。
  fake.override = (action) => action === "DescribeRecordList"
    ? { RecordCountInfo: { TotalCount: 9 }, RecordList: [{ ...fake.records[0] }] }
    : undefined;
  await assert.rejects(records.listDnspodRecords("example.com"), (error: any) => error.code === "INVALID_RESPONSE" && /一直在变/.test(error.message));

  // 同一个 RecordId 出现在两页里：同样作废。
  fake.override = (action) => action === "DescribeRecordList"
    ? { RecordCountInfo: { TotalCount: 4 }, RecordList: [{ ...fake.records[0] }, { ...fake.records[1] }] }
    : undefined;
  await assert.rejects(records.listDnspodRecords("example.com"), (error: any) => error.code === "INVALID_RESPONSE");
});

test("记录太多读不完：明确报错，不悄悄截断", async () => {
  const fake = setup({ pageSize: 2, maxPages: 2 });
  for (let index = 0; index < 5; index += 1) fake.add({ Name: `n${index}`, Type: "A", Value: `198.51.100.${index + 1}` });
  await assert.rejects(records.listDnspodRecords("example.com"), (error: any) => error.code === "TOO_MANY");
});

test("明确的空才是空；格式不对、没响应都报错", async () => {
  const fake = setup();
  // TotalCount = 0 + 空数组
  assert.deepEqual((await records.listDnspodRecords("example.com")).groups, []);
  // TotalCount = 0 + RecordList 为 null
  fake.override = (action) => action === "DescribeRecordList" ? { RecordCountInfo: { TotalCount: 0 }, RecordList: null } : undefined;
  assert.equal((await records.listDnspodRecords("example.com")).total, 0);
  // 服务商明确说「没有记录」
  fake.override = (action) => {
    if (action === "DescribeRecordList") throw new DdnsProviderError("记录列表为空", "ResourceNotFound.NoDataOfRecord");
    return undefined;
  };
  assert.equal((await records.listDnspodRecords("example.com")).total, 0);

  const abnormal: Array<[string, unknown]> = [
    ["没有 RecordCountInfo", { RecordList: [] }],
    ["TotalCount 不是数字", { RecordCountInfo: { TotalCount: "3" }, RecordList: [] }],
    ["有总数却没列表", { RecordCountInfo: { TotalCount: 3 } }],
    ["整个响应是空对象", {}],
    ["记录缺字段", { RecordCountInfo: { TotalCount: 1 }, RecordList: [{ RecordId: 1, Name: "a", Type: "A", Line: "默认", LineId: "0", TTL: 600 }] }],
  ];
  for (const [label, response] of abnormal) {
    fake.override = (action) => action === "DescribeRecordList" ? response : undefined;
    await assert.rejects(records.listDnspodRecords("example.com"), (error: any) => error.code === "INVALID_RESPONSE", label);
  }

  // 网络断了：报「连接失败」，不是空
  fake.override = (action) => {
    if (action === "DescribeRecordList") throw new TypeError("fetch failed");
    return undefined;
  };
  await assert.rejects(records.listDnspodRecords("example.com"), (error: any) => error.code === "UNAVAILABLE" && !error.uncertain);

  // 服务商拒绝（例如密钥没权限）：原因带给页面
  fake.override = (action) => {
    if (action === "DescribeRecordList") throw new DdnsProviderError("你没有权限", "AuthFailure.UnauthorizedOperation");
    return undefined;
  };
  await assert.rejects(records.listDnspodRecords("example.com"), (error: any) => error.code === "PROVIDER" && /你没有权限/.test(error.message));

  // 域名列表也一样：缺总数就是异常
  fake.override = (action) => action === "DescribeDomainList" ? { DomainList: [] } : undefined;
  await assert.rejects(records.listDnspodDomains(), (error: any) => error.code === "INVALID_RESPONSE");
  fake.override = (action) => action === "DescribeDomainList" ? { DomainCountInfo: { AllTotal: 0 }, DomainList: [] } : undefined;
  assert.deepEqual(await records.listDnspodDomains(), []);
});

test("线路按域名套餐取；写入时按线路 ID 带上线路名", async () => {
  const fake = setup();
  const lines = await records.listDnspodRecordLines("example.com");
  assert.deepEqual(lines.map((line) => line.name), ["默认", "电信", "联通", "移动", "境外", "教育网"]);

  const { results } = await records.applyDnspodRecordChanges("example.com", [
    { key: "c1", kind: "create", record: { subdomain: "cdn", type: "A", lineId: "10=0", value: "198.51.100.10", ttl: 600 } },
    { key: "c2", kind: "create", record: { subdomain: "cdn", type: "A", lineId: "10=1", value: "198.51.100.11", ttl: 600 } },
  ]);
  assert.deepEqual(results.map((result) => result.status), ["done", "done"]);
  const creates = fake.calls.filter((call) => call.action === "CreateRecord").map((call) => [call.payload.RecordLine, call.payload.RecordLineId]);
  assert.deepEqual(creates, [["电信", "10=0"], ["联通", "10=1"]]);
  // 线路列表一次保存只读一遍（加上开头单独读的那一次）
  assert.equal(fake.calls.filter((call) => call.action === "DescribeRecordLineList").length, 2);

  const bad = await records.applyDnspodRecordChanges("example.com", [
    { key: "c3", kind: "create", record: { subdomain: "cdn", type: "A", lineId: "99=9", value: "198.51.100.12", ttl: 600 } },
  ]);
  assert.equal(bad.results[0].status, "failed");
  assert.match(String(bad.results[0].error), /线路/);
});

test("统一保存部分失败：成功的不再提交，失败那条和后面的留在暂存区", async () => {
  const fake = setup();
  const api = fake.add({ Name: "api", Type: "A", Value: "198.51.100.1" });
  const old = fake.add({ Name: "old", Type: "CNAME", Value: "legacy.example.net." });
  const listed = await records.listDnspodRecords("example.com");
  const revisionOf = (id: number) => listed.groups.flatMap((group) => group.records).find((record) => record.id === String(id))!.revision;

  const staged = [
    { key: "a", kind: "create" as const, record: { subdomain: "new", type: "A" as const, lineId: "0", value: "198.51.100.2", ttl: 600 } },
    { key: "b", kind: "update" as const, recordId: String(api.RecordId), revision: revisionOf(api.RecordId), record: { subdomain: "api", type: "A" as const, lineId: "0", value: "198.51.100.3", ttl: 600 } },
    { key: "c", kind: "delete" as const, recordId: String(old.RecordId), revision: revisionOf(old.RecordId) },
  ];
  // 第二条被服务商拒绝
  let rejectModify = true;
  fake.override = (action) => {
    if (action === "ModifyRecord" && rejectModify) throw new DdnsProviderError("记录值重复", "InvalidParameter.RecordValueRepeat");
    return undefined;
  };
  const first = await records.applyDnspodRecordChanges("example.com", staged);
  assert.deepEqual(first.results.map((result) => [result.key, result.status]), [["a", "done"], ["b", "failed"], ["c", "skipped"]]);
  assert.match(String(first.results[1].error), /记录值重复/);
  assert.equal(first.results[1].uncertain, undefined);
  assert.equal(fake.calls.filter((call) => call.action === "CreateRecord").length, 1);
  assert.equal(fake.calls.filter((call) => call.action === "DeleteRecord").length, 0, "失败之后的不再去试");

  const remaining = remainingDnspodChanges(staged, first.results);
  assert.deepEqual(remaining.map((change) => change.key), ["b", "c"]);

  rejectModify = false;
  const second = await records.applyDnspodRecordChanges("example.com", remaining);
  assert.deepEqual(second.results.map((result) => result.status), ["done", "done"]);
  assert.equal(fake.calls.filter((call) => call.action === "CreateRecord").length, 1, "已经成功的新增没有再提交一次");
  assert.deepEqual(remainingDnspodChanges(remaining, second.results), []);
  assert.deepEqual(fake.records.map((record) => [record.Name, record.Value]).sort(), [["api", "198.51.100.3"], ["new", "198.51.100.2"]]);
});

test("写请求没拿到明确答复：标成「结果不确定」，后面的不再试", async () => {
  const fake = setup();
  fake.override = (action) => {
    if (action === "CreateRecord") throw new Error("DDNS 请求超时（15 秒无响应）：dnspod.tencentcloudapi.com");
    return undefined;
  };
  const { results } = await records.applyDnspodRecordChanges("example.com", [
    { key: "a", kind: "create", record: { subdomain: "x", type: "AAAA", lineId: "0", value: "2001:db8::1", ttl: 600 } },
    { key: "b", kind: "create", record: { subdomain: "y", type: "A", lineId: "0", value: "198.51.100.5", ttl: 600 } },
  ]);
  assert.equal(results[0].status, "failed");
  assert.equal(results[0].uncertain, true);
  assert.match(String(results[0].error), /可能已经生效/);
  assert.equal(results[1].status, "skipped");
});

test("别处改过的记录：拒绝覆盖", async () => {
  const fake = setup();
  const record = fake.add({ Name: "api", Type: "A", Value: "198.51.100.1" });
  const listed = await records.listDnspodRecords("example.com");
  const revision = listed.groups[0].records[0].revision;
  record.Value = "198.51.100.200"; // DNSPod 控制台里被改了
  const { results } = await records.applyDnspodRecordChanges("example.com", [
    { key: "a", kind: "delete", recordId: String(record.RecordId), revision },
  ]);
  assert.equal(results[0].status, "failed");
  assert.match(String(results[0].error), /别处被改过/);
  assert.equal(fake.writes().length, 0);
});

test("改记录保留它的暂停状态和权重", async () => {
  const fake = setup();
  const record = fake.add({ Name: "api", Type: "A", Value: "198.51.100.1", Status: "DISABLE", Weight: 20 });
  const listed = await records.listDnspodRecords("example.com");
  assert.equal(listed.groups[0].records[0].status, "DISABLE");
  await records.applyDnspodRecordChanges("example.com", [{
    key: "a", kind: "update", recordId: String(record.RecordId), revision: listed.groups[0].records[0].revision,
    record: { subdomain: "api", type: "A", lineId: "10=3", value: "198.51.100.2", ttl: 600 },
  }]);
  const modify = fake.calls.find((call) => call.action === "ModifyRecord")!;
  assert.equal(modify.payload.Status, "DISABLE");
  assert.equal(modify.payload.Weight, 20);
  assert.equal(modify.payload.RecordLine, "移动");
});

test("面板管着的名字：列表里只读并说明归谁管；改、删、改名、新建都被服务端拒绝", async () => {
  const fake = setup({
    managed: {
      hosts: [
        { id: 1, name: "香港-1", ddnsEnabled: 1, ddnsDomain: "HK1.Example.com." },
        { id: 2, name: "关了 DDNS", ddnsEnabled: 0, ddnsDomain: "off.example.com" },
      ],
      forwardGroups: [
        { id: 3, name: "主入口", groupMode: "entry", domain: "edge.example.com", ddnsAutoResolveEnabled: 1 },
        { id: 4, name: "不自动解析", groupMode: "failover", domain: "manual.example.com", ddnsAutoResolveEnabled: 0 },
      ],
      rules: [{ id: 7, name: "游戏", entryDomain: "r7.node.example.com" }],
      ruleCleanups: [{ domain: "r8.node.example.com", ruleId: 8 }],
      landingPools: [{ id: 5, name: "落地池", directDomain: "direct.example.com" }],
      ruleSuffix: "node.example.com",
    },
  });
  const hostRecord = fake.add({ Name: "hk1", Type: "A", Value: "198.51.100.1" });
  const edgeRecord = fake.add({ Name: "edge", Type: "A", Value: "198.51.100.2" });
  const freeRecord = fake.add({ Name: "free", Type: "A", Value: "198.51.100.3" });
  fake.add({ Name: "off", Type: "A", Value: "198.51.100.4" });
  fake.add({ Name: "manual", Type: "A", Value: "198.51.100.5" });
  fake.add({ Name: "r99.node", Type: "A", Value: "198.51.100.6" });

  const listed = await records.listDnspodRecords("example.com");
  const byName = new Map(listed.groups.map((group) => [group.subdomain, group]));
  assert.deepEqual(byName.get("hk1")!.managedBy, ["主机 DDNS：香港-1"]);
  assert.equal(byName.get("hk1")!.records[0].editable, false);
  assert.match(String(byName.get("hk1")!.records[0].readOnlyReason), /主机 DDNS：香港-1/);
  assert.deepEqual(byName.get("edge")!.managedBy, ["入口组：主入口"]);
  assert.match(byName.get("r99.node")!.managedBy[0], /规则专属域名/);
  assert.deepEqual(byName.get("off")!.managedBy, [], "关了 DDNS 的主机不算");
  assert.deepEqual(byName.get("manual")!.managedBy, [], "关了自动解析的组不算");
  assert.equal(byName.get("free")!.records[0].editable, true);
  const revisionOf = (record: FakeRecord) => listed.groups.flatMap((group) => group.records).find((item) => item.id === String(record.RecordId))!.revision;

  const attempts = [
    { key: "del-host", kind: "delete" as const, recordId: String(hostRecord.RecordId), revision: revisionOf(hostRecord) },
    // 浏览器谎报名字也没用：服务端按 DNSPod 那边记录此刻的名字判断
    { key: "edit-edge", kind: "update" as const, recordId: String(edgeRecord.RecordId), revision: revisionOf(edgeRecord), record: { subdomain: "free2", type: "A" as const, lineId: "0", value: "198.51.100.9", ttl: 600 } },
    { key: "rename-into", kind: "update" as const, recordId: String(freeRecord.RecordId), revision: revisionOf(freeRecord), record: { subdomain: "Direct", type: "A" as const, lineId: "0", value: "198.51.100.9", ttl: 600 } },
    { key: "create-rule", kind: "create" as const, record: { subdomain: "r12.node", type: "A" as const, lineId: "10=0", value: "198.51.100.9", ttl: 600 } },
    { key: "create-pending", kind: "create" as const, record: { subdomain: "r8.node", type: "CNAME" as const, lineId: "0", value: "x.example.net", ttl: 600 } },
    { key: "create-host-line", kind: "create" as const, record: { subdomain: "hk1", type: "A" as const, lineId: "10=0", value: "198.51.100.9", ttl: 600 } },
  ];
  for (const attempt of attempts) {
    const { results } = await records.applyDnspodRecordChanges("example.com", [attempt]);
    assert.equal(results[0].status, "failed", attempt.key);
    assert.match(String(results[0].error), /由面板管理/, attempt.key);
  }
  assert.equal(fake.writes().length, 0, "一笔都没写到 DNSPod");

  // 不归面板管的照常能改
  const { results } = await records.applyDnspodRecordChanges("example.com", [
    { key: "ok", kind: "update", recordId: String(freeRecord.RecordId), revision: revisionOf(freeRecord), record: { subdomain: "free", type: "CNAME", lineId: "3=0", value: "Target.Example.NET.", ttl: 600 } },
  ]);
  assert.equal(results[0].status, "done");
  assert.equal(fake.writes()[0].payload.Value, "target.example.net");
});

test("托管名字表：大小写、结尾的点、国际化域名都对得上；后缀下的 r<数字> 都算", () => {
  const index = buildDnsManagedIndex({
    hosts: [{ id: 1, name: "a", ddnsEnabled: true, ddnsDomain: "例子.example.com" }],
    forwardGroups: [{ id: 2, name: "g", groupType: "tunnel", groupMode: "failover", domain: "Edge.Example.com.", ddnsAutoResolveEnabled: null }],
    rules: [],
    ruleCleanups: [],
    landingPools: [],
    ruleSuffix: "Node.Example.com",
  });
  assert.equal(dnsManagedOwnersOf(index, "xn--fsqu00a.example.com").length, 1);
  assert.deepEqual(dnsManagedOwnersOf(index, "edge.example.com.").map((owner) => owner.label), ["隧道转发组：g"]);
  assert.equal(dnsManagedOwnersOf(index, "r123.node.example.com")[0].kind, "ruleDomainSuffix");
  assert.deepEqual(dnsManagedOwnersOf(index, "rx.node.example.com"), []);
  assert.deepEqual(dnsManagedOwnersOf(index, "a.r1.node.example.com"), []);
  assert.deepEqual(dnsManagedOwnersOf(index, "other.example.com"), []);
});

test("凭据没配：整批都不做，报 NOT_CONFIGURED", async () => {
  records.configureDnspodRecordsForTests({
    transport: async () => { throw new records.DnspodRecordsError("还没有填腾讯云 DNSPod 的 SecretId / SecretKey", "NOT_CONFIGURED"); },
    managedIndex: async () => buildDnsManagedIndex({ hosts: [], forwardGroups: [], rules: [], ruleCleanups: [], landingPools: [] }),
  });
  await assert.rejects(records.listDnspodRecords("example.com"), (error: any) => error.code === "NOT_CONFIGURED");
  await assert.rejects(
    records.applyDnspodRecordChanges("example.com", [{ key: "a", kind: "create", record: { subdomain: "a", type: "A", lineId: "0", value: "198.51.100.1", ttl: 600 } }]),
    (error: any) => error.code === "NOT_CONFIGURED",
  );
  // 读不出托管名字也是整批不做：不知道哪些名字归面板管时不能放行
  const fake = new FakeDnspod();
  records.configureDnspodRecordsForTests({ transport: async () => fake.transport, managedIndex: async () => { throw new Error("db down"); } });
  await assert.rejects(
    records.applyDnspodRecordChanges("example.com", [{ key: "a", kind: "create", record: { subdomain: "a", type: "A", lineId: "0", value: "198.51.100.1", ttl: 600 } }]),
    /db down/,
  );
  assert.equal(fake.writes().length, 0);
});

test("日志里不出现记录值和服务商原文", async () => {
  const fake = setup();
  fake.override = (action) => {
    if (action === "CreateRecord") throw new DdnsProviderError("记录值 203.0.113.77 冲突", "InvalidParameter.RecordValueConflict");
    return undefined;
  };
  await records.applyDnspodRecordChanges("example.com", [
    { key: "a", kind: "create", record: { subdomain: "leak", type: "A", lineId: "0", value: "203.0.113.77", ttl: 600 } },
  ]);
  await flushJsonLogWrites();
  const logFile = path.join(logDir, "panel.jsonl");
  const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  assert.match(text, /InvalidParameter\.RecordValueConflict/);
  assert.doesNotMatch(text, /203\.0\.113\.77/);
});

test("托管名字从库里读：主机 DDNS、入口组、规则域名、待删域名、落地池直连域名", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-dns-managed-"));
  const scriptPath = path.join(directory, "managed.mjs");
  fs.writeFileSync(scriptPath, String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
      const managed = await import(moduleUrl("server/dnsManagedNames.ts"));
      const exec = runtime.executeRaw;
      await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, ddnsEnabled, ddnsDomain) VALUES (1, '香港-1', '198.51.100.1', 'slave', 't1', 1, 1, 'HK1.Example.com.')");
      await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, ddnsEnabled, ddnsDomain) VALUES (2, 'off', '198.51.100.2', 'slave', 't2', 1, 0, 'off.example.com')");
      await exec('INSERT INTO "forward_groups" ("id", "name", "groupMode", "targetIp", "isEnabled", "userId", "domain", "ddnsAutoResolveEnabled") VALUES (3, ?, ?, ?, 0, 1, ?, 1)', ["主入口", "entry", "127.0.0.1", "edge.example.com"]);
      await exec("INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, entryDomain) VALUES (7, 1, '游戏', 'gost', 'tcp', 1000, '127.0.0.1', 80, 1, 1, 'r7.node.example.com')");
      await exec("INSERT INTO rule_entry_domain_cleanups (domain, ruleId) VALUES ('r8.node.example.com', 8)");
      await exec("INSERT INTO node_pools (id, userId, name, role, hostIdsJson, directDomain) VALUES (5, 1, '落地池', 'landing', '[]', 'direct.example.com')");
      await settings.setSettings({ ruleEntryDomainSuffix: "node.example.com" });

      const index = await managed.loadDnsManagedIndex();
      const owners = (name) => managed.dnsManagedOwnersOf(index, name).map((owner) => owner.label);
      assert.deepEqual(owners("hk1.example.com"), ["主机 DDNS：香港-1"]);
      assert.deepEqual(owners("off.example.com"), []);
      assert.deepEqual(owners("edge.example.com"), ["入口组：主入口"], "组停用了也算：一启用就会写");
      assert.deepEqual(owners("r7.node.example.com"), ["规则专属域名：游戏"]);
      assert.match(owners("r8.node.example.com")[0], /等待面板删除/);
      assert.match(owners("r9.node.example.com")[0], /后缀/);
      assert.deepEqual(owners("direct.example.com"), ["落地池直连域名：落地池"]);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `, "utf8");
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "managed.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    encoding: "utf8",
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.error?.stack || result.stderr || result.stdout);
});
