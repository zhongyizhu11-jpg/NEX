import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  实时链路从头到尾（2.3.559）：Agent 报上来 → /api/live 推「rules.live」给页面 → 页面重取 rules.trafficSummary
  拿到的就是刚报的数（数据库那边节流没写也一样）。规则卡上看到的就是这一条路。
  浏览器那一段（页面收到通知就重取、刷新不显示旧状态）见 scripts/live-browser-check.mjs。
*/
test("SQLite 实时链路：上报 → 推送 → 页面重取到的是刚报的数", () => {
  runInDatabase(String.raw`
    const http = (await import("node:http")).default;
    const express = (await import("express")).default;
    const batcher = await import(url("server/dbWriteBatcher.ts"));
    await import(url("server/routers.ts"));
    const reports = await import(url("server/agentReportRoutes.ts"));
    const live = await import(url("server/liveEvents.ts"));
    const { rulesRouter } = await import(url("server/routers/rules.ts"));
    const insert = (table, columns, values) => exec('INSERT INTO "' + table + '" (' + columns.map(c => '"'+c+'"').join(',') + ') VALUES (' + values.map(() => '?').join(',') + ')', values);
    await insert("users", ["id","username","name","role","password"], [7,"owner","owner","user","x"]).catch(() => undefined);
    await insert("hosts", ["id","name","ip","hostType","agentToken","userId"], [1,"host-1","127.0.0.1","slave","e2e-token-1",7]);
    await insert("forward_rules", ["id","hostId","name","forwardType","protocol","sourcePort","targetIp","targetPort","userId","isEnabled","isRunning"], [50,1,"direct","realm","tcp",10050,"localhost",443,7,1,1]);
    const app = express();
    app.use(express.json());
    app.use((req,res,next) => { req.agentToken = String(req.headers.authorization || "").replace(/^Bearer /, ""); next(); });
    reports.registerAgentReportRoutes(app);
    live.registerLiveRoute(app, async () => ({ id: 7 }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    let total = 0;
    const report = (ms) => { total += 3; return { ruleId: 50, sourcePort: 10050, targetIp: "localhost", targetPort: 443, method: "tcping", latencyMs: ms, isTimeout: false, probeCount: 3, probeSuccesses: 3, probeCounterEpoch: "e2e", probeTotalCount: total, probeTotalSuccesses: total }; };
    const post = async (ms) => {
      const response = await fetch(base + "/api/agent/tcping", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer e2e-token-1" }, body: JSON.stringify({ results: [report(ms)] }) });
      assert.equal(response.status, 200, await response.text());
      await batcher.flushPendingWrites();
    };
    const caller = rulesRouter.createCaller({ req: { headers: {}, socket: {} }, res: { setHeader() {} }, user: { id: 7, role: "user", accountEnabled: true }, authSession: null, authFailureReason: null });
    const card = async () => (await caller.trafficSummary({ hours: 24, range: "24h", ruleIds: [50] })).find((row) => Number(row.ruleId) === 50);
    const controller = new AbortController();
    try {
      await post(8);
      assert.equal((await card())?.latestLatencyMs, 8);

      // 页面连着实时通知
      const stream = await fetch(base + "/api/live", { signal: controller.signal });
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      let text = decoder.decode((await reader.read()).value);

      // 一分钟后同样通、延迟变了：数据库节流不写，可页面收到通知、重取到的是新数
      await post(31);
      live.flushLiveForTest();
      while (!text.includes("rules.live")) text += decoder.decode((await reader.read()).value);
      assert.equal(Number((await query('SELECT COUNT(*) AS n FROM "tcping_stats" WHERE "ruleId"=50'))[0].n), 1, "数据库历史照旧节流");
      const row = await card();
      assert.equal(row?.latestLatencyMs, 31, "卡片拿到的是刚报的数，不是数据库里那条 8");
      assert.equal(row?.latestLatencySource, "probe");
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `, { name: "live-end-to-end", env: { NODE_ENV: "test" } });
});
