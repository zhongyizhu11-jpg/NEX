import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  入口组「按权重解析」接着组的评估和发布跑一遍（服务商换成一个假的 DNSPod HTTP 接口）：

    · 开了的组：记录带着 Weight 发出去；值和权重都没变时一个写请求都不发；只改了一台的带宽，只改那一条的权重；
      关掉之后把权重收回去（Weight = 0），记着的状态清掉。
    · 没开的组：发出去的请求里没有 Weight 这个字段，也不多列一次记录 —— 和加这个功能之前一模一样。

  各家接口的参数、对账细节在 server/ddnsWeightedRecords.test.ts。
*/

test("入口组按权重解析：带权重发布、不变不写、改权重只改一条、关掉后收回；没开的组请求不变", () => {
  const script = String.raw`
    // 假的 DNSPod：按 X-TC-Action 处理，记下每一次调用
    const records = [];
    const calls = [];
    let nextId = 7000;
    let failDeletes = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (!String(url).includes("dnspod.tencentcloudapi.com")) return realFetch(url, init);
      const action = init.headers["X-TC-Action"];
      const payload = JSON.parse(init.body);
      calls.push({ action, payload });
      let response = {};
      if (action === "DescribeRecordList") {
        response = { RecordList: records.filter((record) => record.Name === payload.Subdomain && record.Type === payload.RecordType && record.Line === payload.RecordLine).map((record) => ({ ...record })) };
      } else if (action === "CreateRecord") {
        const record = { RecordId: nextId++, Name: payload.SubDomain, Type: payload.RecordType, Line: payload.RecordLine, LineId: "0", Value: payload.Value, TTL: payload.TTL, Weight: payload.Weight ?? null };
        records.push(record);
        response = { RecordId: record.RecordId };
      } else if (action === "ModifyRecord") {
        const record = records.find((item) => item.RecordId === payload.RecordId);
        record.Value = payload.Value;
        if (payload.Weight !== undefined) record.Weight = payload.Weight;
        response = { RecordId: record.RecordId };
      } else if (action === "DeleteRecord") {
        if (failDeletes) return new Response(JSON.stringify({ Response: { Error: { Code: "InternalError", Message: "provider is down" } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        records.splice(records.findIndex((item) => item.RecordId === payload.RecordId), 1);
      }
      return new Response(JSON.stringify({ Response: response }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const writes = () => calls.filter((call) => call.action !== "DescribeRecordList");

    const settings = await import(url("server/repositories/settingsRepository.ts"));
    const groups = await import(url("server/db.ts"));
    await settings.setSettings({
      ddnsEnabled: "true",
      ddnsProvider: "tencentcloud",
      ddnsTencentCloudSecretId: "AKIDtest",
      ddnsTencentCloudSecretKey: "secret",
      ddnsTencentCloudDomainName: "example.com",
      ddnsTtl: "60",
    });
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await exec("INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")", values);
    };
    const now = Math.floor(Date.now() / 1000);
    const A = "198.51.100.10";
    const B = "198.51.100.20";
    for (const [id, ip, ipv6] of [[1, A, "2001:db8::10"], [2, B, ""]]) {
      await insert("hosts", ["id", "name", "ip", "ipv4", "ipv6", "userId", "isOnline", "lastHeartbeat"], [id, "entry-" + id, ip, ip, ipv6, 1, 1, now]);
      // 在线 = 连着面板、有快速存活状态（没有的算离线，见 server/forwardGroups/liveness.ts）
      (await import(url("server/agentFastLiveness.ts"))).registerPresenceCapableHost(id);
    }
    const entryGroup = async (id, domain, weighted, dualStack = false) => {
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "bandwidthAggregationEnabled", "bandwidthAggregationStrategy", "ddnsWeightEnabled", "peerProbeEnabled", "ddnsDualStack"],
        [id, "g" + id, "host", "entry", domain, "A", "0.0.0.0", 1, 1, 1, "capacity", weighted ? 1 : 0, 0, dualStack ? 1 : 0],
      );
      for (const [index, hostId, bandwidth] of [[1, 1, 1000], [2, 2, 500]]) {
        await insert(
          "forward_group_members",
          ["id", "groupId", "memberType", "hostId", "priority", "isEnabled", "healthStatus", "lastCheckedAt", "bandwidthMbps"],
          [id * 10 + index, id, "host", hostId, index, 1, "healthy", now, bandwidth],
        );
      }
    };
    const state = async (id) => (await query('SELECT "lastDdnsValue", "lastStatus", "lastMessage", "ddnsWeightState" FROM "forward_groups" WHERE "id" = ?', [id]))[0];

    // —— 开了按权重解析的组
    await entryGroup(80, "weighted.example.com", true);
    await groups.runForwardGroupFailover(80);
    assert.deepEqual(writes().map((call) => [call.action, call.payload.Value, call.payload.Weight]), [["CreateRecord", A, 100], ["CreateRecord", B, 50]]);
    let current = await state(80);
    assert.equal(current.lastStatus, "healthy");
    assert.match(current.lastMessage, /按权重解析 198\.51\.100\.10=100、198\.51\.100\.20=50/);
    assert.deepEqual(JSON.parse(current.ddnsWeightState), { provider: "tencentcloud", domain: "weighted.example.com", recordType: "A", weights: { [A]: 100, [B]: 50 }, mirrorWeighted: false });

    calls.length = 0;
    await groups.runForwardGroupFailover(80);
    assert.deepEqual(calls, [], "值和权重都没变：不找服务商");

    // 第二台的带宽从 500 改成 250：只改它那一条的权重
    await exec('UPDATE "forward_group_members" SET "bandwidthMbps" = 250 WHERE "id" = 802');
    await groups.runForwardGroupFailover(80);
    assert.deepEqual(writes().map((call) => [call.action, call.payload.Value, call.payload.Weight]), [["ModifyRecord", B, 25]]);
    assert.deepEqual(JSON.parse((await state(80)).ddnsWeightState).weights, { [A]: 100, [B]: 25 });

    // 关掉：把服务商那边的权重收回去（Weight = 0），之后照常发布；记着的状态清掉
    calls.length = 0;
    await exec('UPDATE "forward_groups" SET "ddnsWeightEnabled" = 0 WHERE "id" = 80');
    await groups.runForwardGroupFailover(80);
    assert.deepEqual(writes().map((call) => [call.action, call.payload.Value, call.payload.Weight]), [["ModifyRecord", A, 0], ["ModifyRecord", B, 0]]);
    current = await state(80);
    assert.equal(current.ddnsWeightState, null);
    assert.doesNotMatch(current.lastMessage, /按权重解析/);
    calls.length = 0;
    await groups.runForwardGroupFailover(80);
    assert.deepEqual(calls, [], "收回去之后和普通的组一样：没变化不找服务商");

    // —— 没开的组：请求里没有 Weight 字段，只列一次、建两条
    await entryGroup(81, "plain.example.com", false);
    calls.length = 0;
    await groups.runForwardGroupFailover(81);
    assert.deepEqual(calls.map((call) => call.action), ["DescribeRecordList", "CreateRecord", "CreateRecord"]);
    for (const call of writes()) assert.equal("Weight" in call.payload, false, "没开按权重解析的组，请求里不能出现 Weight");
    assert.equal((await state(81)).ddnsWeightState, null);

    // —— 双栈、副记录（AAAA）只有一台有地址：副记录带不了权重。只在第一次（老状态说不清副记录有没有权重时）
    //    收一次 AAAA 的权重，之后每次发布都不再去收（以前每次发布都多列一遍、阿里云那边是一个无条件的写请求）。
    const listsOf = (type) => calls.filter((call) => call.action === "DescribeRecordList" && call.payload.RecordType === type).length;
    await entryGroup(82, "dual.example.com", true, true);
    await groups.runForwardGroupFailover(82);
    assert.deepEqual(JSON.parse((await state(82)).ddnsWeightState).mirrorWeighted, false);
    assert.deepEqual(records.filter((record) => record.Name === "dual" && record.Type === "AAAA").map((record) => [record.Value, record.Weight]), [["2001:db8::10", null]]);
    calls.length = 0;
    await groups.runForwardGroupFailover(82, { forceSync: true });
    assert.equal(listsOf("A"), 1, "主记录按权重发：列一次");
    assert.equal(listsOf("AAAA"), 1, "副记录上一次就没按权重发：不再去收权重，只按值对账那一次");

    // —— 成员全部暂停参与（维护模式）：清空解析。服务商报错时记着的值和权重状态不能丢，抛出去让发布队列重试
    const policy = await import(url("server/hostTrafficPolicy.ts"));
    await entryGroup(83, "empty.example.com", true);
    await groups.runForwardGroupFailover(83);
    assert.equal((await state(83)).lastDdnsValue, A + "," + B);
    await exec('UPDATE "hosts" SET "maintenanceMode" = 1');
    policy.invalidateHostTrafficPolicyCache();
    failDeletes = true;
    await assert.rejects(groups.runForwardGroupFailover(83), /provider is down/);
    current = await state(83);
    assert.equal(current.lastDdnsValue, A + "," + B, "没清掉：记着的值留着，下一次还知道要清什么");
    assert.notEqual(current.ddnsWeightState, null);
    assert.equal(current.lastStatus, "error");
    failDeletes = false;
    await groups.runForwardGroupFailover(83);
    current = await state(83);
    assert.equal(current.lastDdnsValue, null);
    assert.equal(current.ddnsWeightState, null);
    assert.deepEqual(records.filter((record) => record.Name === "empty"), []);
  `;
  runInDatabase(script, { name: "group-ddns-weights" });
});
