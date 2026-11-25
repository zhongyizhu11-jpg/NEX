import test from "node:test";
import { runInDatabase } from "../../testing/runInDatabase";

/** 故障看板接上真库：汇总、正在告警、CSV / JSON 导出（JSON 里密钥打码）。 */
test("fault board summary and export work against a real database", () => {
  runInDatabase(String.raw`
      const events = await import(url("server/ops/panelEvents.ts"));
      const { faultBoardRouter } = await import(url("server/routers/ops/faultBoard.ts"));

      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
      await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, isOnline, lastHeartbeat) VALUES (1, '港-1', '203.0.113.1', 'slave', 'tok1', 1, 1, ?)", [Math.floor(Date.now() / 1000)]);
      await exec("INSERT INTO hosts (id, name, ip, hostType, agentToken, userId, isOnline) VALUES (2, '日-1', '203.0.113.2', 'slave', 'tok2', 1, 0)");

      const now = Math.floor(Date.now() / 1000);
      await events.recordPanelEvent({ kind: "host.offline", level: "warn", hostId: 2, message: "日-1 断线", at: now - 3600 });
      await events.recordPanelEvent({ kind: "host.online", level: "info", hostId: 2, message: "日-1 断线 10 分钟后恢复", data: { outageSeconds: 600 }, at: now - 3000 });
      await events.recordPanelEvent({ kind: "host.oom_killed", level: "crit", hostId: 1, message: "港-1 OOM token=abc123", at: now - 60 });
      await events.recordPanelEvent({ kind: "account.login", level: "info", message: "管理员登录", at: now - 30 });

      const caller = faultBoardRouter.createCaller({
        req: { headers: {}, ip: "127.0.0.1", socket: {} },
        res: { cookie() {}, clearCookie() {} },
        user: { id: 1, role: "admin", username: "admin" },
        authSession: null,
        authFailureReason: null,
      });
      const summary = await caller.summary({ hours: 24 });
      assert.equal(summary.hosts.total, 2);
      assert.equal(summary.hosts.offlineCount, 1);
      assert.equal(summary.hosts.offline[0].name, "日-1");
      assert.equal(summary.summary.alerts, 2);
      assert.equal(summary.summary.critical, 1);
      assert.equal(summary.summary.recovered, 1);
      assert.equal(summary.summary.avgRecoverySeconds, 600);
      assert.deepEqual(summary.recent.map((event) => event.kind), ["host.oom_killed", "host.offline"]);
      assert.equal(summary.recent[0].hostName, "港-1");

      const csv = await caller.export({ hours: 24, format: "csv" });
      assert.match(csv.filename, /^nex-faults-.*\.csv$/);
      assert.equal(csv.content.trim().split("\n").length, 5);

      const json = await caller.export({ hours: 24, format: "json" });
      const report = JSON.parse(json.content);
      assert.equal(report.kind, "nex-fault-report");
      assert.equal(report.events.length, 4);
      assert.doesNotMatch(json.content, /abc123/);
  `, { name: "fault-board" });
});
