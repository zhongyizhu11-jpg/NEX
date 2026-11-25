import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 绑定会过期这件事。
 *
 * 「这条转发通向那个落地节点」只在保存那一刻成立过。之后目标地址能改、节点自己的
 * 地址端口也能改，而绑定一直留着。留错了不只是订阅里少一条或多一条线路 ——
 * 订阅里那条节点**带着这个落地的凭据**（uuid、Reality 公钥、SNI），地址写的却是转发
 * 入口；入口现在通向别处，客户端就会把这套凭据递给那台别的机器。
 *
 * 两头都要管：保存时把能判定的绑定修正过来（这一半走 planProxyNodeBinding），
 * 判不定的照发但要告警（这一半走订阅组装）。
 */
test("SQLite 绑定过期时：能判定的改绑或解绑，判不定的照发但告警", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-binding-drift-"));
  const databasePath = path.join(directory, "binding-drift.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));
    const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
    const { planProxyNodeBinding } = await import(url("shared/proxyNodeAutoBind.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    const query = (sql, params = []) => runtime.queryRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (2, 'tenant', 'hash', 'user', 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId) VALUES (10, '入口', '203.0.113.10', '203.0.113.10', 'tok10', 2)");

    const makeNode = async (name, address, port) => Number(await subs.createProxyNode({
      userId: 2, name, protocol: "vless", address, port,
      uuid: "11111111-2222-3333-4444-555555555555", transport: "tcp", tls: true,
      isEnabled: true, includeDirect: false,
    }));
    const nodeA = await makeNode("落地 A", "198.51.100.5", 443);
    const nodeB = await makeNode("落地 B", "198.51.100.9", 443);

    /** 和服务端同一套决策 + 同一套写库动作。 */
    const saveTarget = async (ruleId, targetIp, targetPort) => {
      const before = (await query('SELECT "proxyNodeId", "targetIp", "targetPort" FROM "forward_rules" WHERE "id" = ?', [ruleId]))[0];
      const candidates = (await subs.getProxyNodesForSubscription(2)).map((node) => ({
        id: Number(node.id),
        address: String(node.address || ""),
        port: Number(node.port || 0),
        isEnabled: node.isEnabled !== false,
        sharedFrom: !!node.sharedFrom,
      }));
      const boundNodeId = Number(before.proxyNodeId || 0);
      const bound = candidates.find((node) => node.id === boundNodeId);
      await rules.updateForwardRule(ruleId, { targetIp, targetPort });
      const plan = planProxyNodeBinding({
        isCreate: false,
        targetChanged: String(before.targetIp) !== String(targetIp) || Number(before.targetPort) !== Number(targetPort),
        boundNodeId,
        boundNodePlace: bound ? { address: bound.address, port: bound.port } : null,
        previousTarget: { targetIp: before.targetIp, targetPort: before.targetPort },
        nextTarget: { targetIp, targetPort },
        candidates,
      });
      if (plan.action === "release") await rules.updateForwardRule(ruleId, { proxyNodeId: null });
      else if (plan.action === "bind" || plan.action === "rebind") {
        await rules.updateForwardRule(ruleId, { proxyNodeId: plan.nodeId, proxyNodeVisible: true });
      }
      return plan.action;
    };
    const boundNodeOf = async (ruleId) => Number(
      (await query('SELECT "proxyNodeId" FROM "forward_rules" WHERE "id" = ?', [ruleId]))[0].proxyNodeId || 0,
    );

    await exec(
      'INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, proxyNodeId, proxyNodeVisible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [70, 10, '去落地 A', 'direct', 'tcp', 20001, '198.51.100.5', 443, 2, 1, nodeA, 1],
    );

    // 1. 改到落地 B 上：改绑。
    assert.equal(await saveTarget(70, "198.51.100.9", 443), "rebind");
    assert.equal(await boundNodeOf(70), nodeB, "目标换成另一个节点，绑定要跟着换");

    // 2. 改到谁都不是的地方：解绑。
    assert.equal(await saveTarget(70, "203.0.113.250", 8443), "release");
    assert.equal(await boundNodeOf(70), 0, "目标已经不通向任何节点，绑定必须解掉");

    // 3. 再改回落地 A：自己认回去。
    assert.equal(await saveTarget(70, "198.51.100.5", 443), "bind");
    assert.equal(await boundNodeOf(70), nodeA);

    /**
     * 4. 串两跳：这条转发的目标是**自己另一条转发的入口**，绑定挂在第一跳上。
     *    目标当然不等于节点地址，但这是正常拓扑 —— 面板不许自作主张动它，也不许报警。
     */
    await exec(
      'INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, proxyNodeId, proxyNodeVisible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [72, 10, '另一条入口', 'direct', 'tcp', 20005, '198.51.100.5', 443, 2, 1, null, 0],
    );
    await exec(
      'INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, proxyNodeId, proxyNodeVisible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [71, 10, '串两跳的第一跳', 'direct', 'tcp', 20002, '203.0.113.10', 20001, 2, 1, nodeA, 1],
    );
    // 改成串到另一条入口上：前后都不是字面相符，所以一个字都不该动。
    assert.equal(await saveTarget(71, "203.0.113.10", 20005), "none", "原来就不是字面相符的拓扑，不该被改");
    assert.equal(await boundNodeOf(71), nodeA, "他自己搭的拓扑，绑定要留着");

    // 5. 绕过保存路径改坏（老数据、手改库、或者节点自己换了地址）：
    //    订阅照发，但必须带上告警 —— 静默少一条节点是这套面板反复踩过的坑。
    await exec('UPDATE forward_rules SET targetIp = ?, targetPort = ? WHERE id = ?', ["203.0.113.250", 8443, 70]);
    const plan = await subs.buildProxySubscriptionPlanForUser(2);
    const drifted = plan.warnings.filter((item) => item.reason === "target-mismatch");
    assert.equal(drifted.length, 1, "对不上的那条要告警");
    assert.equal(Number(drifted[0].ruleId), 70);
    assert.equal(drifted[0].nodeName, "落地 A");
    assert.equal(drifted[0].targetText, "203.0.113.250:8443");
    assert.ok(
      plan.entries.some((entry) => Number(entry.ruleId) === 70 && entry.targetMismatch === true),
      "那条节点仍然要发出去，只是标出来 —— 不能静默少一条",
    );
    // 串两跳那条不能被误报。
    assert.ok(
      !plan.warnings.some((item) => Number(item.ruleId) === 71),
      "目标指向自己另一条转发的入口，是正常的串联，不该报警",
    );
    // 规则页用的轻量接口只回规则 id，结论必须和完整 plan 的告警一致（不组装订阅文档）。
    const { plan: contextPlan } = await subs.buildProxySubscriptionContextForUser(2);
    const lightIds = contextPlan.warnings.filter((item) => item.reason === "target-mismatch").map((item) => Number(item.ruleId));
    assert.deepEqual(lightIds, [70], "targetMismatchRuleIds 的来源要和 preview 的告警一致");

    /**
     * 6. 谁都没用的节点：没开直连、也没有任何转发绑到它 —— 客户端里根本没有它，
     *    而「我的节点」里它看着好好的。这是当初「转发不绑节点就不进订阅、页面上还看不出」
     *    从节点这一侧再犯一次。
     */
    const orphan = await makeNode("谁也没指向它", "198.51.100.77", 443);
    const planWithOrphan = await subs.buildProxySubscriptionPlanForUser(2);
    const unused = planWithOrphan.warnings.filter((item) => item.reason === "node-unused");
    const unusedIds = unused.map((item) => Number(item.nodeId));
    assert.ok(unusedIds.includes(orphan), "刚建的、谁也没指向的节点要报");
    // 落地 B 这会儿也确实没人指向它了（上面第 2 步把那条转发解绑、第 3 步改回了落地 A）。
    assert.deepEqual(unusedIds.sort((a, b) => a - b), [nodeB, orphan].sort((a, b) => a - b));
    assert.ok(!unusedIds.includes(nodeA), "有转发指向的节点不该报");
    assert.equal(unused.find((item) => Number(item.nodeId) === orphan).nodeText, "198.51.100.77:443");

    // 停用的节点不算：那是他自己关的，行上本来就写着停用。
    await subs.updateProxyNode(orphan, { isEnabled: false });
    const planAfterDisable = await subs.buildProxySubscriptionPlanForUser(2);
    assert.ok(
      !planAfterDisable.warnings.some((item) => item.reason === "node-unused" && Number(item.nodeId) === orphan),
      "停用的节点不该再报「没进订阅」—— 那是他自己关的",
    );

    /**
     * 7. 机器的 Agent 从没连上过。
     *
     * 这种机器上开的落地端口，配置根本下发不下去 —— 可面板照样把它当成一条好线路发进
     * 订阅，客户端拉到手连不上，页面上一个字都没提过。仍然照发（机器可能下一分钟就连上
     * 了，悄悄拿掉比发出去更糟），但必须告警。
     *
     * 关键是别把「掉线」也算进来：掉线是暂时的，节点行上那个状态点已经在说了，
     * 拿它去告警就会天天报。
     */
    const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, agentToken, userId) VALUES (60, ?, ?, ?, ?, 2)',
      ["刚加的机器", "203.0.113.60", "203.0.113.60", "tok60"],
    );
    const inboundId = Number(await inbounds.createProxyInbound({
      userId: 2, hostId: 60, name: "新开的端口", protocol: "vless", port: 34567,
      security: "reality", uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      realityPublicKey: "pk", realityShortId: "ab", serverName: "www.example.com",
      realityPrivateKey: "sk", realityDest: "www.example.com:443", isEnabled: true,
    }));
    await inbounds.replaceProxyInboundUsers(inboundId, [{ userId: 2, uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "默认" }]);
    await inbounds.syncProxyNodeFromInbound(inboundId);

    const neverPlan = await subs.buildProxySubscriptionPlanForUser(2);
    const neverOnline = neverPlan.warnings.filter((item) => item.reason === "host-never-online");
    assert.equal(neverOnline.length, 1, "Agent 从没连上的机器要告警");
    assert.equal(neverOnline[0].nodeName, "新开的端口");
    assert.equal(neverOnline[0].targetText, "刚加的机器");
    assert.ok(
      neverPlan.entries.some((entry) => entry.node.name === "新开的端口"),
      "照样要发出去 —— 机器可能下一分钟就连上，悄悄拿掉比发出去更糟",
    );

    // 收过一次心跳之后就不该再报：之后掉不掉线归状态点管。
    await exec('UPDATE hosts SET lastHeartbeat = ?, isOnline = 0 WHERE id = 60', [new Date().toISOString()]);
    const afterBeat = await subs.buildProxySubscriptionPlanForUser(2);
    assert.equal(
      afterBeat.warnings.filter((item) => item.reason === "host-never-online").length,
      0,
      "装过 Agent 的机器只是掉线，不该按「还没装」告警",
    );

    // 粘来的节点没有机器，面板对它们的状态无话可说，任何时候都不该报。
    assert.ok(
      !neverPlan.warnings.some((item) => item.reason === "host-never-online" && Number(item.nodeId) === nodeA),
      "粘来的节点不该报机器没连上",
    );

    console.log("OK");
    await runtime.closeDatabase();
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
