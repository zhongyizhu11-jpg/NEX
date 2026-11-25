import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 线路组面板以前拉 rules.list 全部规则，再在前端按 failoverEnabled 丢掉绝大多数。
 * 现在带 failoverOnly 在库里筛：结果必须和「全拉再按 routeGroupOf 过滤」完全一致。
 */
test("rules.list 的 failoverOnly 在服务端筛，结果和前端原来的过滤一致", () => {
  runInDatabase(String.raw`
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'tenant', 'h', 'user')");
    await exec("INSERT INTO hosts (id, name, ip, userId, agentToken) VALUES (1, 'h', '192.0.2.1', 1, 't')");
    for (const [id, userId, failover] of [[1, 1, 1], [2, 1, 0], [3, 2, 1], [4, 2, 0], [5, 2, 1]]) {
      await exec(
        "INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, failoverEnabled) VALUES (?, 1, ?, 'gost', 'tcp', ?, '198.51.100.1', 80, ?, ?)",
        [id, "r" + id, 20000 + id, userId, failover],
      );
    }
    const { rulesRouter } = await import(url("server/routers/rules.ts"));
    const { routeGroupOf } = await import(url("shared/routeGroup.ts"));
    const call = (id, role) => rulesRouter.createCaller({ user: { id, role, username: "u" + id }, req: { headers: {} }, res: { setHeader: () => {} } });
    const ids = (rows) => rows.map((row) => Number(row.id));

    for (const [caller, input] of [[call(1, "admin"), { scope: "all" }], [call(2, "user"), {}]]) {
      const everything = await caller.list(input);
      const filtered = await caller.list({ ...input, failoverOnly: true });
      const expected = everything.filter((rule) => routeGroupOf(rule));
      assert.deepEqual(JSON.parse(JSON.stringify(filtered)), JSON.parse(JSON.stringify(expected)));
      assert.ok(filtered.length > 0 && filtered.length < everything.length, "测试前提：两种规则都有");
    }
    assert.deepEqual(ids(await call(2, "user").list({ failoverOnly: true })).sort(), [3, 5], "租户只拿到自己开了主备的规则");
    console.log("FAILOVER_ONLY_OK");
  `, { name: "rule-failover-only", env: { NODE_ENV: "test" } });
});
