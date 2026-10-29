import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** 「一个落地只许一处决定出口」：规则出口 vs 入站分流落地，两头各拦一次（server/landingConflicts.ts）。 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-landing-conflict-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));
      const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));
      const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
      const guard = await import(url("server/landingConflicts.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'alice', 'hash', 'admin', 1)");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId) VALUES (10, '入口', '9.9.9.9', '9.9.9.9', 'tok', 1)");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId) VALUES (11, '落地', '1.1.1.1', '1.1.1.1', 'tok2', 1)");
      const routing = JSON.stringify({ routes: [{ presets: ["netflix"], domains: [], target: "landing", landingInboundId: 99 }] });
      const inboundId = Number(await inbounds.createProxyInbound({ userId: 1, hostId: 11, name: "HK 入站", protocol: "vless", port: 443, transport: "tcp", security: "none", routingJson: routing, isEnabled: true }));
      const nodeId = Number(await subs.createProxyNode({ userId: 1, name: "HK 节点", protocol: "vless", address: "1.1.1.1", port: 443, uuid: "11111111-2222-3333-4444-555555555555", transport: "tcp", tls: true, isEnabled: true, includeDirect: false, inboundId, inboundUserId: 0 }));
      ${body}
      await runtime.closeDatabase();
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "conflict.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("规则目标是节点、节点的入站已有分流落地：规则不能再配出口；没配出口、或目标不是节点照常", () => {
  runInDatabase(String.raw`
    await assert.rejects(
      guard.assertRuleEgressNotDoubleLanding({ userId: 1, targetIp: "1.1.1.1", targetPort: 443, egressType: "ss_host" }),
      /多绕一跳/,
    );
    await guard.assertRuleEgressNotDoubleLanding({ userId: 1, targetIp: "1.1.1.1", targetPort: 443, egressType: "none" });
    await guard.assertRuleEgressNotDoubleLanding({ userId: 1, targetIp: "8.8.8.8", targetPort: 443, egressType: "ss_host" });
  `);
});

test("入站要配分流落地，而有规则把它当目标又配了出口：不让存；没有这样的规则照常", () => {
  runInDatabase(String.raw`
    const landing = JSON.stringify({ routes: [{ presets: ["netflix"], domains: [], target: "auto_unlock", landingInboundId: 0 }] });
    await guard.assertInboundRoutingNotDoubleLanding(inboundId, landing);
    await rules.createForwardRule({ userId: 1, hostId: 10, name: "带出口", forwardType: "gost", protocol: "tcp", sourcePort: 20001, targetIp: "1.1.1.1", targetPort: 443, egressType: "ss_host", egressInboundId: 5, isEnabled: true });
    await assert.rejects(guard.assertInboundRoutingNotDoubleLanding(inboundId, landing), /带出口/);
    await guard.assertInboundRoutingNotDoubleLanding(inboundId, JSON.stringify({ routes: [{ presets: ["netflix"], domains: [], target: "direct", landingInboundId: 0 }] }));
  `);
});
