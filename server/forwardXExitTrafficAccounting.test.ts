import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * NEX（forwardx）隧道按哪边记流量。
 *
 * 入口全是管理员的机器：照旧按入口记，出口 FXP 报上来的那份（reportSide=exit）算「记在别处」。
 * 有一台入口机是租户自己的（主入口、入口组成员，停用的成员也算）：改按出口记（主出口 +
 * 负载均衡里启用的出口），入口报的算「记在别处」—— 租户改自己的入口少报，账照样记在出口上。
 * 同一台机器既在入口组里又是出口时，只认该记那一边的那份，不记两遍。
 *
 * 起一个真的 sqlite 和真的流量上报路由跑一遍。
 */
test("NEX traffic is accounted on exactly one side, at the exit when an entry host is tenant-owned", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-exit-traffic-accounting-"));
  const databasePath = path.join(directory, "traffic.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const reports = await import(url("server/agentReportRoutes.ts"));

    // 1 = 管理员，2 = 租户。
    const hosts = [
      [10, 1], [19, 1],                 // A：管理员入口 → 管理员出口
      [20, 2], [29, 1], [28, 1], [27, 1], // B：租户入口 → 管理员出口，28 是启用的负载均衡出口，27 是停用的
      [40, 1], [41, 2], [49, 1],        // C：管理员主入口，入口组里有台停用的租户机器
      [50, 1], [59, 1],                 // D：管理员入口组里包含出口机 59
    ];
    let server;
    const tokenForHost = (hostId) => "exit-accounting-token-" + hostId;
    let reportSeq = 0;

    async function postTraffic(baseUrl, hostId, ruleId, bytesIn, bytesOut, side) {
      reportSeq += 1;
      const body = {
        reportId: "report-" + reportSeq,
        reportProducerId: (side ? "fxp-exit-" : "fxp-entry-") + hostId,
        stats: [{ ruleId, bytesIn, bytesOut, connections: 1 }],
      };
      if (side) body.reportSide = side;
      const response = await fetch(baseUrl + "/api/agent/traffic", {
        method: "POST",
        headers: { authorization: "Bearer " + tokenForHost(hostId), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, "host " + hostId + " rule " + ruleId);
      assert.equal((await response.json()).success, true);
    }

    async function trafficRows(ruleId) {
      return runtime.queryRaw(
        'SELECT "hostId", SUM("bytesIn") AS "bytesIn", SUM("bytesOut") AS "bytesOut" FROM "traffic_stats" WHERE "ruleId" = ? GROUP BY "hostId" ORDER BY "hostId"',
        [ruleId],
      );
    }

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "name", "role", "trafficUsed") VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)',
        [1, "admin", "hash", "Admin", "admin", 0, 2, "tenant", "hash", "Tenant", "user", 0],
      );
      for (const [hostId, userId] of hosts) {
        await runtime.executeRaw(
          'INSERT INTO "hosts" ("id", "name", "ip", "hostType", "agentToken", "userId") VALUES (?, ?, ?, ?, ?, ?)',
          [hostId, "host-" + hostId, "127.0.1." + hostId, "slave", tokenForHost(hostId), userId],
        );
      }
      await runtime.executeRaw(
        'INSERT INTO "forward_groups" ("id", "name", "groupMode", "targetIp", "isEnabled", "userId") VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)',
        [401, "c-entry", "entry", "127.0.0.1", 1, 1, 501, "d-entry", "entry", "127.0.0.1", 1, 1],
      );
      await runtime.executeRaw(
        'INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "isEnabled") VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)',
        [4011, 401, "host", 41, 10, 0, 5011, 501, "host", 59, 10, 1],
      );
      const tunnels = [
        [100, "a", null, 10, 19, 0],
        [200, "b", null, 20, 29, 1],
        [400, "c", 401, 40, 49, 0],
        [500, "d", 501, 50, 59, 0],
      ];
      for (const [id, name, entryGroupId, entryHostId, exitHostId, loadBalanceEnabled] of tunnels) {
        await runtime.executeRaw(
          'INSERT INTO "tunnels" ("id", "name", "entryGroupId", "entryHostId", "exitHostId", "mode", "listenPort", "loadBalanceEnabled", "loadBalanceStrategy", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, name, entryGroupId, entryHostId, exitHostId, "forwardx", 20000 + id, loadBalanceEnabled, "round_robin", 2],
        );
      }
      await runtime.executeRaw(
        'INSERT INTO "tunnel_exit_nodes" ("id", "tunnelId", "seq", "hostId", "listenPort", "isEnabled") VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)',
        [2001, 200, 1, 28, 30201, 1, 2002, 200, 2, 27, 30202, 0],
      );
      for (const [id, hostId, tunnelId] of [[1000, 10, 100], [2000, 20, 200], [4000, 40, 400], [5000, 50, 500]]) {
        await runtime.executeRaw(
          'INSERT INTO "forward_rules" ("id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "targetIp", "targetPort", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, hostId, "rule-" + id, "gost", "tcp", tunnelId, 10000 + id / 10, "127.0.0.1", 80, 2],
        );
      }

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const authorization = String(req.headers.authorization || "");
        req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        next();
      });
      reports.registerAgentReportRoutes(app);
      server = http.createServer(app);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const baseUrl = "http://127.0.0.1:" + server.address().port;

      // A：入口可信，按入口记；出口那份记在别处。
      await postTraffic(baseUrl, 10, 1000, 100, 200);
      await postTraffic(baseUrl, 19, 1000, 100, 200, "exit");
      assert.deepEqual(await trafficRows(1000), [{ hostId: 10, bytesIn: 100, bytesOut: 200 }]);

      // B：入口是租户的，按出口记。入口报 0 也好、报多少也好都不算；出口 FXP 的那份算，
      // 负载均衡里启用的出口也算，停用的不算；出口机上不带 reportSide 的上报不算。
      await postTraffic(baseUrl, 20, 2000, 0, 0);
      await postTraffic(baseUrl, 20, 2000, 7, 7);
      await postTraffic(baseUrl, 29, 2000, 1000, 3000, "exit");
      await postTraffic(baseUrl, 28, 2000, 10, 30, "exit");
      await postTraffic(baseUrl, 27, 2000, 5, 5, "exit");
      await postTraffic(baseUrl, 29, 2000, 9, 9);
      await postTraffic(baseUrl, 20, 2000, 9, 9, "exit");
      assert.deepEqual(await trafficRows(2000), [
        { hostId: 28, bytesIn: 10, bytesOut: 30 },
        { hostId: 29, bytesIn: 1000, bytesOut: 3000 },
      ]);

      // C：入口组里停用的租户机器也让入口不可信。
      await postTraffic(baseUrl, 40, 4000, 50, 50);
      await postTraffic(baseUrl, 49, 4000, 60, 60, "exit");
      assert.deepEqual(await trafficRows(4000), [{ hostId: 49, bytesIn: 60, bytesOut: 60 }]);

      // D：59 既在入口组里又是出口，入口可信：它入口那份算、出口那份不算。
      await postTraffic(baseUrl, 50, 5000, 1, 2);
      await postTraffic(baseUrl, 59, 5000, 3, 4);
      await postTraffic(baseUrl, 59, 5000, 3, 4, "exit");
      assert.deepEqual(await trafficRows(5000), [
        { hostId: 50, bytesIn: 1, bytesOut: 2 },
        { hostId: 59, bytesIn: 3, bytesOut: 4 },
      ]);

      const counted = (await runtime.queryRaw('SELECT COALESCE(SUM("bytesIn" + "bytesOut"), 0) AS "total" FROM "traffic_stats"'))[0].total;
      assert.equal(counted, 300 + 4040 + 120 + 10);
      const tenant = (await runtime.queryRaw('SELECT "trafficUsed" FROM "users" WHERE "id" = 2'))[0];
      assert.equal(tenant.trafficUsed, counted, "tenant quota must move with exactly one side of every rule");
    } finally {
      if (server) await new Promise((resolve) => server.close(() => resolve()));
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
