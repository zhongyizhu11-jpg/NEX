import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  内存是「现在」，数据库是「历史」（2.3.559）：状态没变的定时上报数据库那边照旧按 5 分钟节流，
  可内存里的实时样本每次上报都要更新 —— 以前卡片上的延迟最多停在 5 分钟前（用户：「诊断延迟返回后，规则还显示 7ms 8 分钟前」）。
*/
test("SQLite 定时上报：数据库节流写历史，内存里的规则 / 链路样本每次都更新", () => {
  runInDatabase(String.raw`
    const http = (await import("node:http")).default;
    const express = (await import("express")).default;
    const batcher = await import(url("server/dbWriteBatcher.ts"));
    await import(url("server/routers.ts"));
    const reports = await import(url("server/agentReportRoutes.ts"));
    const view = await import(url("server/ruleLatencyView.ts"));
    const insert = (table, columns, values) => exec('INSERT INTO "' + table + '" (' + columns.map(c => '"'+c+'"').join(',') + ') VALUES (' + values.map(() => '?').join(',') + ')', values);
    for (const id of [1,2]) await insert("hosts", ["id","name","ip","hostType","agentToken","userId"],
      [id,"host-"+id,"127.0.0."+id,"slave","live-token-"+id,7]);
    await insert("forward_rules", ["id","hostId","name","forwardType","protocol","sourcePort","targetIp","targetPort","userId"], [50,1,"direct","realm","tcp",10050,"localhost",443,7]);
    await insert("tunnels", ["id","name","entryHostId","exitHostId","mode","listenPort","userId"], [20,"tunnel",1,2,"forwardx",20020,7]);
    const app = express();
    app.use(express.json());
    app.use((req,res,next) => { req.agentToken = String(req.headers.authorization || "").replace(/^Bearer /, ""); next(); });
    reports.registerAgentReportRoutes(app);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = "http://127.0.0.1:" + server.address().port + "/api/agent/tcping";
    const post = async (body) => {
      const response = await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer live-token-1"},body:JSON.stringify(body)});
      const result = await response.json();
      assert.equal(response.status,200,JSON.stringify(result));
      await batcher.flushPendingWrites();
    };
    const count = async (sql) => Number((await query(sql))[0].n);
    const totals = { rule: [0, 0], link: [0, 0] };
    const counters = (kind, ok) => { totals[kind][0] += 3; if (ok) totals[kind][1] += 3; return { probeCounterEpoch:"live-"+kind, probeTotalCount: totals[kind][0], probeTotalSuccesses: totals[kind][1] }; };
    const sample = (ms) => ms === undefined ? { isTimeout: true, probeCount: 3, probeSuccesses: 0 } : { latencyMs: ms, isTimeout: false, probeCount: 3, probeSuccesses: 3 };
    const rule = (ms) => ({ruleId:50,sourcePort:10050,targetIp:"localhost",targetPort:443,method:"tcping",...sample(ms),...counters("rule", ms !== undefined)});
    const link = (ms) => ({tunnelId:20,targetIp:"127.0.0.2",targetPort:20020,method:"tcp",...sample(ms),...counters("link", ms !== undefined)});
    try {
      await post({results:[rule(8)], tunnels:[link(6)]});
      assert.equal(view.ruleSample(50)?.ms, 8);
      assert.equal(view.tunnelSample(20)?.ms, 6);
      assert.equal(await count('SELECT COUNT(*) AS n FROM "tcping_stats" WHERE "ruleId"=50'), 1);
      assert.equal(await count('SELECT COUNT(*) AS n FROM "tunnel_latency_stats" WHERE "tunnelId"=20'), 1);

      // 一分钟后同样通、延迟变了：数据库不多写，内存是新的数
      await post({results:[rule(31)], tunnels:[link(17)]});
      assert.equal(await count('SELECT COUNT(*) AS n FROM "tcping_stats" WHERE "ruleId"=50'), 1, "数据库历史照旧节流");
      assert.equal(await count('SELECT COUNT(*) AS n FROM "tunnel_latency_stats" WHERE "tunnelId"=20'), 1, "数据库历史照旧节流");
      assert.equal(view.ruleSample(50)?.ms, 31, "规则样本是这一次的");
      assert.equal(view.tunnelSample(20)?.ms, 17, "链路样本是这一次的");
      assert.equal(view.tunnelExitLatency(20, 2)?.ms, 17, "单出口链路：入口到出口那一段也是这一次的");

      // 超时：状态变了，数据库立刻记，内存也是超时
      await post({results:[rule(undefined)], tunnels:[link(undefined)]});
      assert.equal(await count('SELECT COUNT(*) AS n FROM "tcping_stats" WHERE "ruleId"=50'), 2);
      assert.equal(view.ruleSample(50)?.isTimeout, true);
      assert.equal(view.tunnelSample(20)?.isTimeout, true);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `, { name: "live-samples", env: { NODE_ENV: "test" } });
});
