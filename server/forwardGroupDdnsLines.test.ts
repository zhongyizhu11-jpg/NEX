import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  入口组分线路解析走完整的组评估（forwardGroupRepository → forwardGroupDdnsLines → ddnsLineRecords）：
  真实的 sqlite 库、真实的腾讯云签名请求，只是 fetch 换成一个假的 DNSPod。

  1. 没分线路的组：发给 DNSPod 的请求和直接调用原来的 updateDdnsRecordValues 一模一样，
     没有任何线路相关的请求，也不写 ddnsLineState；
  2. 分了线路：每条线路一组记录，记下记录 ID；线路成员全挂时回落到默认线路的健康成员；
  3. 线路不再有成员：只按记下的 ID 删，同一线路上别人加的记录不动。
*/

function runIsolatedScript(directory: string, databasePath: string, name: string, script: string) {
  const scriptPath = path.join(directory, `${name}.mjs`);
  fs.writeFileSync(scriptPath, script, "utf8");
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_TYPE: "sqlite",
      FORWARDX_TEST_DB: databasePath,
      FORWARDX_LOG_DIR: path.join(directory, "logs"),
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.error?.stack || result.stderr || result.stdout);
}

test("入口组分线路解析：没分线路时请求不变；分了线路按线路发布、回落、按记录 ID 清理", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-ddns-lines-"));
  const databasePath = path.join(directory, "lines.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;

    // ===== 假的 DNSPod：按名字 / 类型 / 线路过滤，记下每一个请求 =====
    const dnspod = { records: [], calls: [], nextId: 7000 };
    const addRecord = (record) => {
      const full = { RecordId: dnspod.nextId++, Line: "默认", LineId: "0", TTL: 600, Status: "ENABLE", ...record };
      dnspod.records.push(full);
      return full;
    };
    const handle = (action, payload) => {
      switch (action) {
        case "DescribeRecordList":
          return {
            RecordList: dnspod.records
              .filter((record) => record.Name === payload.Subdomain && record.Type === payload.RecordType)
              .filter((record) => payload.RecordLineId ? record.LineId === payload.RecordLineId : record.Line === payload.RecordLine)
              .map((record) => ({ ...record })),
          };
        case "CreateRecord":
          return { RecordId: addRecord({ Name: payload.SubDomain, Type: payload.RecordType, Line: payload.RecordLine, LineId: payload.RecordLineId || (payload.RecordLine === "默认" ? "0" : ""), Value: payload.Value, TTL: payload.TTL }).RecordId };
        case "ModifyRecord": {
          const record = dnspod.records.find((item) => item.RecordId === Number(payload.RecordId));
          assert.ok(record, "ModifyRecord on missing record");
          Object.assign(record, { Value: payload.Value, TTL: payload.TTL });
          return { RecordId: record.RecordId };
        }
        case "DeleteRecord": {
          const index = dnspod.records.findIndex((item) => item.RecordId === Number(payload.RecordId));
          assert.ok(index >= 0, "DeleteRecord on missing record " + payload.RecordId);
          dnspod.records.splice(index, 1);
          return {};
        }
        default:
          throw new Error("unexpected DNSPod action " + action);
      }
    };
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(String(url), "https://dnspod.tencentcloudapi.com");
      const action = init.headers["X-TC-Action"];
      const payload = JSON.parse(init.body || "{}");
      dnspod.calls.push({ action, payload });
      return new Response(JSON.stringify({ Response: handle(action, payload) }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const takeCalls = () => dnspod.calls.splice(0, dnspod.calls.length);
    const on = (name, line) => dnspod.records.filter((record) => record.Name === name && record.Type === "A" && record.LineId === line).map((record) => record.Value).sort();

    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
    const ddns = await import(moduleUrl("server/ddns.ts"));
    const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
    await settings.setSettings({
      ddnsEnabled: "true",
      ddnsProvider: "tencentcloud",
      ddnsTencentCloudSecretId: "test-id",
      ddnsTencentCloudSecretKey: "test-key",
      ddnsTencentCloudDomainName: "example.test",
      ddnsTtl: "600",
    });

    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [id, ip] of [[1, "198.51.100.10"], [2, "198.51.100.20"], [3, "198.51.100.30"]]) {
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [id, "host-" + id, ip, ip, 1, 1, now]);
    }
    const memberColumns = ["id", "groupId", "memberType", "hostId", "priority", "isEnabled", "healthStatus", "lastCheckedAt", "healthySince", "ddnsLines"];
    const groupColumns = ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "failoverSeconds"];
    const groupState = async (id) => (await runtime.queryRaw('SELECT "lastDdnsValue", "ddnsLineState", "lastStatus" FROM "forward_groups" WHERE "id" = ?', [id]))[0];
    const strip = (calls) => calls.map((call) => ({ action: call.action, payload: call.payload }));

    // ===== 1. 没分线路的组：和原来的 DDNS 发布一模一样 =====
    await ddns.updateDdnsRecordValues({ groupId: 20, domain: "plain.example.test", recordType: "A", values: ["198.51.100.10", "198.51.100.20"], ttl: 600 });
    const baseline = strip(takeCalls());
    dnspod.records = [];
    assert.deepEqual(baseline.map((call) => call.action), ["DescribeRecordList", "CreateRecord", "CreateRecord"]);

    await insert("forward_groups", groupColumns, [20, "plain", "host", "entry", "plain.example.test", "A", "0.0.0.0", 1, 1, 60]);
    await insert("forward_group_members", memberColumns, [201, 20, "host", 1, 0, 1, "healthy", now, now - 300, null]);
    await insert("forward_group_members", memberColumns, [202, 20, "host", 2, 1, 1, "healthy", now, now - 300, null]);
    await forwardGroups.runForwardGroupFailover(20);
    assert.deepEqual(strip(takeCalls()), baseline, "没分线路的组发给 DNSPod 的请求必须和原来完全一样");
    assert.equal((await groupState(20)).ddnsLineState, null);
    await forwardGroups.runForwardGroupFailover(20);
    assert.deepEqual(takeCalls(), [], "已是最新时不再发请求");

    // ===== 2. 电信 → host1，联通 → host2，默认 → host3 =====
    const TELECOM = JSON.stringify([{ id: "10=0", name: "电信" }]);
    const UNICOM = JSON.stringify([{ id: "10=1", name: "联通" }]);
    await insert("forward_groups", groupColumns, [30, "lines", "host", "entry", "lines.example.test", "A", "0.0.0.0", 1, 1, 60]);
    await insert("forward_group_members", memberColumns, [301, 30, "host", 1, 0, 1, "healthy", now, now - 300, TELECOM]);
    await insert("forward_group_members", memberColumns, [302, 30, "host", 2, 1, 1, "healthy", now, now - 300, UNICOM]);
    await insert("forward_group_members", memberColumns, [303, 30, "host", 3, 2, 1, "healthy", now, now - 300, null]);
    await forwardGroups.runForwardGroupFailover(30);
    const firstCalls = takeCalls();
    assert.deepEqual(on("lines", "0"), ["198.51.100.30"], "默认线路只剩没分线路的成员");
    assert.deepEqual(on("lines", "10=0"), ["198.51.100.10"]);
    assert.deepEqual(on("lines", "10=1"), ["198.51.100.20"]);
    assert.ok(firstCalls.filter((call) => call.payload.RecordLineId === "10=0").every((call) => call.payload.RecordLine === "电信"));
    let state = await groupState(30);
    assert.equal(state.lastDdnsValue, "198.51.100.30");
    let lineState = JSON.parse(state.ddnsLineState);
    assert.equal(lineState.domain, "lines.example.test");
    const telecomIds = lineState.lines["10=0"].recordIds;
    const unicomIds = lineState.lines["10=1"].recordIds;
    assert.deepEqual(telecomIds, dnspod.records.filter((record) => record.Name === "lines" && record.LineId === "10=0").map((record) => String(record.RecordId)));
    assert.equal(unicomIds.length, 1);

    await forwardGroups.runForwardGroupFailover(30);
    assert.deepEqual(takeCalls(), [], "线路记录已是最新时也不再发请求");

    // ===== 电信线路的成员故障超过观察时间：电信回落到默认线路的健康成员 =====
    await runtime.executeRaw('UPDATE "forward_group_members" SET "healthStatus" = \'unhealthy\', "lastCheckedAt" = ?, "failureSince" = ?, "healthySince" = NULL WHERE "id" = 301', [now, now - 120]);
    await forwardGroups.runForwardGroupFailover(30);
    takeCalls();
    assert.deepEqual(on("lines", "10=0"), ["198.51.100.30"], "电信全挂时改用默认线路的健康成员，不留空");
    lineState = JSON.parse((await groupState(30)).ddnsLineState);
    assert.equal(lineState.lines["10=0"].source, "fallback");
    assert.deepEqual(lineState.lines["10=0"].recordIds, telecomIds, "回落是改值，记录 ID 不变");

    // ===== 3. 联通不再有成员：只删面板写的那条，别人加在联通线路上的留着 =====
    const thirdParty = addRecord({ Name: "lines", Type: "A", Line: "联通", LineId: "10=1", Value: "192.0.2.99" });
    await runtime.executeRaw('UPDATE "forward_group_members" SET "ddnsLines" = NULL WHERE "id" = 302');
    await forwardGroups.runForwardGroupFailover(30, { forceSync: true });
    const deletes = takeCalls().filter((call) => call.action === "DeleteRecord");
    assert.deepEqual(deletes.map((call) => String(call.payload.RecordId)), unicomIds);
    assert.deepEqual(on("lines", "10=1"), ["192.0.2.99"]);
    assert.ok(dnspod.records.some((record) => record.RecordId === thirdParty.RecordId));
    assert.deepEqual(on("lines", "0"), ["198.51.100.20", "198.51.100.30"], "去掉线路的成员回到默认线路");
    lineState = JSON.parse((await groupState(30)).ddnsLineState);
    assert.deepEqual(Object.keys(lineState.lines), ["10=0"]);

    // 最后一个分了线路的成员也去掉：线路状态清空，之后这个组就和没分线路的组一样。
    await runtime.executeRaw('UPDATE "forward_group_members" SET "ddnsLines" = NULL WHERE "id" = 301');
    await forwardGroups.runForwardGroupFailover(30);
    takeCalls();
    assert.deepEqual(on("lines", "10=0"), []);
    assert.equal((await groupState(30)).ddnsLineState, null);
    await forwardGroups.runForwardGroupFailover(30);
    assert.deepEqual(takeCalls(), []);

    // ===== 4. 主备组（还没有规则在用）：每条线路一个值 =====
    await insert("forward_groups", [...groupColumns, "activeMemberId"], [40, "failover", "host", "failover", "fo.example.test", "A", "0.0.0.0", 1, 1, 60, null]);
    await insert("forward_group_members", memberColumns, [401, 40, "host", 1, 0, 1, "unknown", null, null, TELECOM]);
    await insert("forward_group_members", memberColumns, [402, 40, "host", 2, 1, 1, "unknown", null, null, JSON.stringify([{ id: "10=0", name: "电信" }, { id: "0", name: "默认" }])]);
    await insert("forward_group_members", memberColumns, [403, 40, "host", 3, 2, 1, "unknown", null, null, null]);
    await forwardGroups.runForwardGroupFailover(40);
    takeCalls();
    assert.deepEqual(on("fo", "0"), ["198.51.100.20"], "默认线路在默认线路成员里按顺序挑第一个");
    assert.deepEqual(on("fo", "10=0"), ["198.51.100.10"], "电信线路在电信成员里按顺序挑第一个");
    process.exit(0);
  `;
  runIsolatedScript(directory, databasePath, "group-ddns-lines", script);
});

/*
  阿里云 / 华为云走同一套组评估：真实的签名请求，fetch 换成假的阿里云（RPC，参数在 query 里）和
  假的华为云（REST）。看入口组多值线路、回落、删除模式、只按记录 ID 删，以及换服务商时旧服务商的
  记录 ID 绝不拿去新服务商那边删（包括老版本没写 provider 的 DNSPod 线路状态）。
*/
test("阿里云 / 华为云分线路：多值线路、回落、删除模式、按记录 ID 清理；换服务商不拿旧 ID 去删", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-ddns-lines-providers-"));
  const databasePath = path.join(directory, "lines.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;

    // ===== 假的阿里云 DNS =====
    const ali = { records: [], calls: [], nextId: 880001 };
    const aliAdd = (record) => {
      const full = { RecordId: String(ali.nextId++), Line: "default", TTL: 600, Status: "ENABLE", ...record };
      ali.records.push(full);
      return full;
    };
    const aliHandle = (action, params) => {
      switch (action) {
        case "DescribeSubDomainRecords": {
          const rr = params.SubDomain === "example.test" ? "@" : params.SubDomain.slice(0, -".example.test".length);
          const found = ali.records.filter((record) => record.RR === rr && record.Type === params.Type && (!params.Line || record.Line === params.Line));
          return { TotalCount: found.length, DomainRecords: { Record: found.map((record) => ({ ...record })) } };
        }
        case "AddDomainRecord":
          return { RecordId: aliAdd({ RR: params.RR, Type: params.Type, Line: params.Line, Value: params.Value, TTL: Number(params.TTL) }).RecordId };
        case "UpdateDomainRecord": {
          const record = ali.records.find((item) => item.RecordId === params.RecordId);
          assert.ok(record, "UpdateDomainRecord on missing record");
          Object.assign(record, { Value: params.Value, Line: params.Line, TTL: Number(params.TTL) });
          return { RecordId: record.RecordId };
        }
        case "DeleteDomainRecord": {
          const index = ali.records.findIndex((item) => item.RecordId === params.RecordId);
          assert.ok(index >= 0, "DeleteDomainRecord on missing record " + params.RecordId);
          ali.records.splice(index, 1);
          return { RecordId: params.RecordId };
        }
        default:
          throw new Error("unexpected aliyun action " + action);
      }
    };

    // ===== 假的华为云 DNS =====
    const ZONE = "ff8080825b8fc86c015b94bc6f8712c3";
    const hw = { recordsets: [], calls: [], nextId: 1 };
    const hwAdd = (set) => {
      const full = { id: "2c9eb15558722857015872" + String(hw.nextId++).padStart(10, "0"), line: "default_view", ttl: 300, zone_id: ZONE, ...set };
      hw.recordsets.push(full);
      return full;
    };
    const hwHandle = (method, pathname, query, body) => {
      if (method === "GET" && pathname === "/v2/zones/" + ZONE) return { id: ZONE, name: "example.test." };
      const base = "/v2.1/zones/" + ZONE + "/recordsets";
      if (method === "GET" && pathname === "/v2.1/recordsets") {
        // 默认线路（server/ddns.ts 原来的写法）走租户级列表。
        const found = hw.recordsets.filter((set) => set.name === query.name && set.type === query.type && (!query.line_id || set.line === query.line_id));
        return { recordsets: found.map((set) => ({ ...set })) };
      }
      if (method === "GET" && pathname === base) {
        const found = hw.recordsets.filter((set) => set.name === query.name && set.type === query.type && (!query.line_id || set.line === query.line_id));
        return { recordsets: found.map((set) => ({ ...set, records: [...set.records] })), metadata: { total_count: found.length } };
      }
      if (method === "POST" && pathname === base) {
        return { id: hwAdd({ name: body.name, type: body.type, line: body.line || "default_view", records: [...body.records], ttl: body.ttl }).id, status: "PENDING_CREATE" };
      }
      const id = pathname.startsWith(base + "/") ? pathname.slice(base.length + 1) : null;
      const set = hw.recordsets.find((item) => item.id === id);
      assert.ok(set, "huawei " + method + " on missing record set " + pathname);
      if (method === "PUT") {
        assert.equal(body.line, undefined);
        Object.assign(set, { records: [...body.records], ttl: body.ttl });
        return { ...set };
      }
      if (method === "DELETE") {
        hw.recordsets.splice(hw.recordsets.indexOf(set), 1);
        return { ...set };
      }
      throw new Error("unexpected huawei call " + method + " " + pathname);
    };

    let dnspodCalls = 0;
    globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(String(url));
      if (parsed.host === "alidns.aliyuncs.com") {
        const params = Object.fromEntries(parsed.searchParams.entries());
        assert.ok(params.Signature, "阿里云请求要签名");
        ali.calls.push({ action: params.Action, params });
        return new Response(JSON.stringify({ RequestId: "r", ...aliHandle(params.Action, params) }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (parsed.host === "dns.myhuaweicloud.com") {
        assert.match(String(init.headers.Authorization), /^SDK-HMAC-SHA256 Access=hw-ak/);
        const method = String(init.method || "GET").toUpperCase();
        const query = Object.fromEntries(parsed.searchParams.entries());
        const body = init.body ? JSON.parse(init.body) : undefined;
        hw.calls.push({ method, path: parsed.pathname, query, body });
        return new Response(JSON.stringify(hwHandle(method, parsed.pathname, query, body)), { status: method === "POST" ? 202 : 200, headers: { "Content-Type": "application/json" } });
      }
      dnspodCalls += 1;
      throw new Error("unexpected fetch " + url);
    };
    const takeAli = () => ali.calls.splice(0, ali.calls.length);
    const takeHw = () => hw.calls.splice(0, hw.calls.length);
    const aliOn = (rr, line) => ali.records.filter((record) => record.RR === rr && record.Type === "A" && record.Line === line).map((record) => record.Value).sort();
    const hwOn = (name, line) => hw.recordsets.filter((set) => set.name === name + ".example.test." && set.type === "A" && set.line === line).map((set) => [...set.records].sort());

    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
    const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
    const base = {
      ddnsEnabled: "true",
      ddnsTtl: "600",
      ddnsAliyunAccessKeyId: "ali-ak",
      ddnsAliyunAccessKeySecret: "ali-sk",
      ddnsAliyunDomainName: "example.test",
      ddnsHuaweiCloudAccessKeyId: "hw-ak",
      ddnsHuaweiCloudSecretKey: "hw-sk",
      ddnsHuaweiCloudZoneId: ZONE,
    };
    await settings.setSettings({ ...base, ddnsProvider: "aliyun" });

    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [id, ip] of [[1, "198.51.100.10"], [2, "198.51.100.20"], [3, "198.51.100.30"]]) {
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [id, "host-" + id, ip, ip, 1, 1, now]);
    }
    const memberColumns = ["id", "groupId", "memberType", "hostId", "priority", "isEnabled", "healthStatus", "lastCheckedAt", "healthySince", "ddnsLines"];
    const groupColumns = ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "failoverSeconds"];
    const groupState = async (id) => (await runtime.queryRaw('SELECT "lastDdnsValue", "ddnsLineState" FROM "forward_groups" WHERE "id" = ?', [id]))[0];
    const lineStateOf = async (id) => JSON.parse((await groupState(id)).ddnsLineState);
    const events = async (id, type) => (await runtime.queryRaw('SELECT "message" FROM "forward_group_events" WHERE "groupId" = ? AND "type" = ?', [id, type])).map((row) => row.message);
    const setHealth = async (ids, healthy) => {
      for (const id of ids) {
        if (healthy) await runtime.executeRaw('UPDATE "forward_group_members" SET "healthStatus" = \'healthy\', "lastCheckedAt" = ?, "failureSince" = NULL, "healthySince" = ? WHERE "id" = ?', [now, now - 300, id]);
        else await runtime.executeRaw('UPDATE "forward_group_members" SET "healthStatus" = \'unhealthy\', "lastCheckedAt" = ?, "failureSince" = ?, "healthySince" = NULL WHERE "id" = ?', [now, now - 120, id]);
      }
    };

    // ===== 阿里云：电信 → host1 + host2（入口组多值），默认 → host3 =====
    const ALI_TELECOM = JSON.stringify([{ id: "telecom", name: "中国电信", provider: "aliyun" }]);
    await insert("forward_groups", groupColumns, [50, "ali", "host", "entry", "ali.example.test", "A", "0.0.0.0", 1, 1, 60]);
    await insert("forward_group_members", memberColumns, [501, 50, "host", 1, 0, 1, "healthy", now, now - 300, ALI_TELECOM]);
    await insert("forward_group_members", memberColumns, [502, 50, "host", 2, 1, 1, "healthy", now, now - 300, ALI_TELECOM]);
    await insert("forward_group_members", memberColumns, [503, 50, "host", 3, 2, 1, "healthy", now, now - 300, null]);
    await forwardGroups.runForwardGroupFailover(50);
    takeAli();
    assert.deepEqual(aliOn("ali", "default"), ["198.51.100.30"], "默认线路只剩没分线路的成员");
    assert.deepEqual(aliOn("ali", "telecom"), ["198.51.100.10", "198.51.100.20"], "电信线路一个值一条记录");
    let lineState = await lineStateOf(50);
    assert.equal(lineState.provider, "aliyun");
    const telecomIds = lineState.lines.telecom.recordIds;
    assert.deepEqual([...telecomIds].sort(), ali.records.filter((record) => record.Line === "telecom").map((record) => record.RecordId).sort());
    await forwardGroups.runForwardGroupFailover(50);
    assert.deepEqual(takeAli(), [], "已是最新时不再发请求");

    // 电信两台都挂了：改用默认线路的健康成员（改值，记录 ID 是原来的那批里的）。
    await setHealth([501, 502], false);
    await forwardGroups.runForwardGroupFailover(50);
    takeAli();
    assert.deepEqual(aliOn("ali", "telecom"), ["198.51.100.30"]);
    lineState = await lineStateOf(50);
    assert.equal(lineState.lines.telecom.source, "fallback");
    assert.ok(lineState.lines.telecom.recordIds.every((id) => telecomIds.includes(id)));

    // 删除模式：电信的记录按记下的 ID 删掉，别人手加在电信线路上的留着。
    const manual = aliAdd({ RR: "ali", Type: "A", Line: "telecom", Value: "192.0.2.99" });
    await runtime.executeRaw('UPDATE "forward_groups" SET "ddnsLineFallback" = \'remove\' WHERE "id" = 50');
    await forwardGroups.runForwardGroupFailover(50, { forceSync: true });
    const deletes = takeAli().filter((call) => call.action === "DeleteDomainRecord").map((call) => call.params.RecordId);
    assert.deepEqual(deletes, lineState.lines.telecom.recordIds);
    assert.deepEqual(aliOn("ali", "telecom"), ["192.0.2.99"]);
    assert.ok(ali.records.some((record) => record.RecordId === manual.RecordId));
    assert.equal((await groupState(50)).ddnsLineState, null);

    // 恢复：电信重新发布（新建记录），手加的那条按值对账收掉（这个名字归面板管）。
    await runtime.executeRaw('UPDATE "forward_groups" SET "ddnsLineFallback" = \'default\' WHERE "id" = 50');
    await setHealth([501, 502], true);
    await forwardGroups.runForwardGroupFailover(50, { forceSync: true });
    takeAli();
    assert.deepEqual(aliOn("ali", "telecom"), ["198.51.100.10", "198.51.100.20"]);
    lineState = await lineStateOf(50);
    const aliIdsBeforeSwitch = lineState.lines.telecom.recordIds;

    // ===== 换成华为云：阿里云的记录 ID 一个都不拿去华为云删；阿里云那边也不再发任何请求 =====
    await settings.setSettings({ ...base, ddnsProvider: "huaweicloud" });
    await forwardGroups.runForwardGroupFailover(50, { forceSync: true });
    assert.deepEqual(takeAli(), [], "换了服务商后不再碰阿里云");
    assert.ok(!takeHw().some((call) => call.method === "DELETE"), "旧服务商的记录 ID 不能拿到新服务商那边删");
    assert.deepEqual(aliOn("ali", "telecom"), ["198.51.100.10", "198.51.100.20"], "旧服务商的记录留着，等人手动清理");
    const switchEvents = await events(50, "ddns-line-provider-change");
    assert.equal(switchEvents.length, 1);
    assert.match(switchEvents[0], /从 阿里云 DNS 换成了 华为云 DNS/);
    assert.match(switchEvents[0], /线路 中国电信 上的 2 条记录/);
    assert.equal((await groupState(50)).ddnsLineState, null, "阿里云的线路配置在华为云下不算数，组等于没分线路");
    assert.deepEqual(hwOn("ali", "default_view"), [["198.51.100.10", "198.51.100.20", "198.51.100.30"]], "成员都回到默认线路");
    assert.equal(aliIdsBeforeSwitch.length, 2);

    // 华为云：电信（Dianxin）→ host1，一个记录集；默认线路是剩下的。
    await runtime.executeRaw('UPDATE "forward_group_members" SET "ddnsLines" = ? WHERE "id" = 501', [JSON.stringify([{ id: "Dianxin", name: "电信", provider: "huaweicloud" }])]);
    await runtime.executeRaw('UPDATE "forward_group_members" SET "ddnsLines" = NULL WHERE "id" = 502');
    await forwardGroups.runForwardGroupFailover(50, { forceSync: true });
    takeHw();
    assert.deepEqual(hwOn("ali", "Dianxin"), [["198.51.100.10"]]);
    assert.deepEqual(hwOn("ali", "default_view"), [["198.51.100.20", "198.51.100.30"]]);
    lineState = await lineStateOf(50);
    assert.equal(lineState.provider, "huaweicloud");
    assert.deepEqual(lineState.lines.Dianxin.recordIds, hw.recordsets.filter((set) => set.line === "Dianxin").map((set) => set.id));

    // 华为云线路成员全挂：回落到默认线路的健康成员（PUT 同一个记录集）。
    await setHealth([501], false);
    await forwardGroups.runForwardGroupFailover(50);
    const hwWrites = takeHw().filter((call) => call.method !== "GET");
    assert.ok(hwWrites.some((call) => call.method === "PUT" && call.path.endsWith("/" + lineState.lines.Dianxin.recordIds[0])));
    assert.deepEqual(hwOn("ali", "Dianxin"), [["198.51.100.20", "198.51.100.30"]]);
    assert.equal((await lineStateOf(50)).lines.Dianxin.source, "fallback");

    // 不再分线路：只删记下的记录集，别人在电信线路上建的同名记录集不动。
    const hwManual = hwAdd({ name: "ali.example.test.", type: "A", line: "Dianxin", records: ["192.0.2.88"], weight: 1 });
    await setHealth([501], true);
    await runtime.executeRaw('UPDATE "forward_group_members" SET "ddnsLines" = NULL WHERE "id" = 501');
    await forwardGroups.runForwardGroupFailover(50, { forceSync: true });
    const hwDeletes = takeHw().filter((call) => call.method === "DELETE").map((call) => call.path.split("/").pop());
    assert.deepEqual(hwDeletes, lineState.lines.Dianxin.recordIds);
    assert.ok(hw.recordsets.some((set) => set.id === hwManual.id));
    assert.equal((await groupState(50)).ddnsLineState, null);

    // ===== 老版本（2.3.528）留下的 DNSPod 线路状态没有 provider：换到阿里云后绝不拿它的 ID 去阿里云删 =====
    await settings.setSettings({ ...base, ddnsProvider: "aliyun" });
    // 故意让阿里云上有一条 ID、名字、类型、线路都和老状态对得上的记录：没有服务商核对就会被误删。
    const lookalike = aliAdd({ RR: "legacy", Type: "A", Line: "10=0", Value: "203.0.113.1" });
    const legacyState = JSON.stringify({
      v: 1,
      domain: "legacy.example.test",
      recordType: "A",
      lines: { "10=0": { id: "10=0", name: "电信", values: ["198.51.100.10"], recordIds: [lookalike.RecordId], memberIds: [601], source: "members", at: "" } },
    });
    await insert("forward_groups", [...groupColumns, "ddnsLineState"], [60, "legacy", "host", "entry", "legacy.example.test", "A", "0.0.0.0", 1, 1, 60, legacyState]);
    await insert("forward_group_members", memberColumns, [601, 60, "host", 1, 0, 1, "healthy", now, now - 300, JSON.stringify([{ id: "10=0", name: "电信" }])]);
    await insert("forward_group_members", memberColumns, [602, 60, "host", 2, 1, 1, "healthy", now, now - 300, null]);
    takeAli();
    await forwardGroups.runForwardGroupFailover(60, { forceSync: true });
    const legacyCalls = takeAli();
    assert.ok(!legacyCalls.some((call) => call.action === "DeleteDomainRecord"), "DNSPod 的记录 ID 不能拿到阿里云删");
    assert.ok(!legacyCalls.some((call) => call.params.Line === "10=0"), "DNSPod 的线路配置在阿里云下不算数");
    assert.ok(ali.records.some((record) => record.RecordId === lookalike.RecordId));
    assert.match((await events(60, "ddns-line-provider-change"))[0], /从 腾讯云 DNSPod 换成了 阿里云 DNS/);
    assert.equal((await groupState(60)).ddnsLineState, null);
    assert.deepEqual(aliOn("legacy", "default"), ["198.51.100.10", "198.51.100.20"]);
    assert.equal(dnspodCalls, 0);
    process.exit(0);
  `;
  runIsolatedScript(directory, databasePath, "group-ddns-lines-providers", script);
});
