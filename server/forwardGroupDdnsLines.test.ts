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
