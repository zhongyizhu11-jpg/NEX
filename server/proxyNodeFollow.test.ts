import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 节点地址变了，绑着它的转发和落地选它的线路组路径跟着改（server/proxyNodeFollow.ts）。
 * 真 SQLite 上跑：建用户、入口机、节点、规则，改节点地址，看规则目标和路径落地。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-nodefollow-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));
      const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
      const follow = await import(url("server/proxyNodeFollow.ts"));
      const { parseRoutePaths, serializeRoutePaths } = await import(url("shared/routeGroup.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'alice', 'hash', 'admin', 1)");
      await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId) VALUES (10, '入口', '9.9.9.9', '9.9.9.9', 'tok', 1)");
      const nodeId = Number(await subs.createProxyNode({ userId: 1, name: "HK 落地", protocol: "vless", address: "1.1.1.1", port: 443, uuid: "11111111-2222-3333-4444-555555555555", transport: "tcp", tls: true, isEnabled: true, includeDirect: false }));
      ${body}
      await runtime.closeDatabase();
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "follow.db") },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("节点换了地址：绑着它的转发目标跟着改，没绑的和中继不动", () => {
  runInDatabase(String.raw`
    const bound = Number(await rules.createForwardRule({ userId: 1, hostId: 10, name: "到 HK", forwardType: "gost", protocol: "tcp", sourcePort: 20001, targetIp: "1.1.1.1", targetPort: 443, proxyNodeId: nodeId, isEnabled: true }));
    const other = Number(await rules.createForwardRule({ userId: 1, hostId: 10, name: "别的", forwardType: "gost", protocol: "tcp", sourcePort: 20002, targetIp: "1.1.1.1", targetPort: 443, isEnabled: true }));
    await subs.updateProxyNode(nodeId, { address: "2.2.2.2", port: 8443 });
    const result = await follow.followBoundRulesToNode(nodeId);
    assert.deepEqual(result.retargeted, [bound]);
    const after = await rules.getForwardRuleById(bound);
    assert.equal(after.targetIp, "2.2.2.2");
    assert.equal(after.targetPort, 8443);
    const untouched = await rules.getForwardRuleById(other);
    assert.equal(untouched.targetIp, "1.1.1.1", "没绑这个节点的规则不动");
    // 再来一次：已经一致，什么都不改。
    assert.deepEqual((await follow.followBoundRulesToNode(nodeId)).retargeted, []);
  `);
});

test("线路组路径的落地选了节点：节点换地址后 dest 跟着改", () => {
  runInDatabase(String.raw`
    const paths = serializeRoutePaths([
      { key: "main", name: "主", hops: [], dest: { ip: "1.1.1.1", port: 443 }, destNodeId: nodeId, weight: 50, probe: null, dial: null, issue: null },
      { key: "b", name: "备", hops: [], dest: { ip: "5.5.5.5", port: 443 }, destNodeId: null, weight: 50, probe: null, dial: null, issue: null },
    ]);
    const ruleId = Number(await rules.createForwardRule({ userId: 1, hostId: 10, name: "线路组", forwardType: "gost", protocol: "tcp", sourcePort: 20003, targetIp: "7.7.7.7", targetPort: 443, failoverEnabled: true, routePaths: paths, isEnabled: true }));
    await subs.updateProxyNode(nodeId, { address: "2.2.2.2", port: 8443 });
    const result = await follow.followBoundRulesToNode(nodeId);
    assert.deepEqual(result.routePaths, [ruleId]);
    const after = parseRoutePaths((await rules.getForwardRuleById(ruleId)).routePaths);
    assert.deepEqual(after[0].dest, { ip: "2.2.2.2", port: 8443 });
    assert.equal(after[0].destNodeId, nodeId);
    assert.deepEqual(after[1].dest, { ip: "5.5.5.5", port: 443 }, "手填的落地不动");
  `);
});
