import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  多实例部署：跑后台任务的实例启动之后才加的主机，Agent 只连另一个实例。每 10 秒读库（refreshAgentPresenceElsewhere）
  时要把它登记进快速存活状态，不然转发组评估里它一直算离线（评审 F2）。
*/
test("库里有别的实例刚见过、本进程没登记过的主机：读库时登记成在线", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-presence-elsewhere-"));
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const leaseModule = await import("./panelLease");
  const presence = await import("./agentPresenceElsewhere");
  const fast = await import("./agentFastLiveness");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "p.db") } });
    await ensureDatabaseSchema();
    const store = new leaseModule.SqlPanelLeaseStore();
    const quiet = { info: () => {}, warn: () => {} };
    const makeLease = (instanceId: string) => new leaseModule.PanelLease({ store, instanceId, logger: quiet, setTimer: (() => ({ unref() {} })) as any, clearTimer: () => {} });
    const holder = makeLease("holder");
    const other = makeLease("other");
    await holder.start();
    await other.start();
    await holder.tick();
    leaseModule.setPanelBackgroundLeaseForTests(holder);
    assert.equal(leaseModule.panelHasOtherLiveInstances(), true);
    const nowSeconds = Math.floor(Date.now() / 1000);
    await runtime.executeRaw(`INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')`);
    await runtime.executeRaw(`INSERT INTO hosts (id, name, ip, "userId", "isOnline", "lastHeartbeat", "agentVersion") VALUES (42, 'new', '198.51.100.42', 1, 1, ?, '2.2.264')`, [nowSeconds - 5]);
    await runtime.executeRaw(`INSERT INTO hosts (id, name, ip, "userId", "isOnline", "lastHeartbeat", "agentVersion") VALUES (43, 'old-agent', '198.51.100.43', 1, 1, ?, '2.1.0')`, [nowSeconds - 5]);
    assert.equal(fast.agentFastLivenessTracker.hasHost(42), false);
    await presence.refreshAgentPresenceElsewhere();
    const state = fast.agentFastLivenessTracker.state(42);
    assert.ok(state, "读库后还是没有存活状态（转发组评估里算离线）");
    assert.equal(state!.confirmedOffline, false);
    assert.equal(fast.agentFastLivenessTracker.hasHost(43), false, "不支持快速存活的版本不登记");
  } finally {
    presence.resetAgentPresenceElsewhereForTests();
    fast.agentFastLivenessTracker.clear();
    leaseModule.setPanelBackgroundLeaseForTests(null);
    await runtime.closeDatabase().catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
