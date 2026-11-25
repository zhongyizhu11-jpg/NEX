import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 拖拽排序以前写 sortOrder = startIndex + i，默认整张列表是 0、1、2… 连续的。
 * 两种真实数据都会打破这个前提：
 * - 有空洞（删过行）：第二页的行被写成比第一页还小的值，跑到第一页里去；
 * - 老数据全是 0：拖完第一页，被拖的行有的成了 1，沉到了一堆 0 后面。
 * 现在改成「被拖的几行在自己原有的座位里换座」，有并列值先按当前顺序整体重编。
 */
test("拖拽排序在有空洞和老数据全 0 时顺序依然正确", () => {
  runInDatabase(String.raw`
    const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
    const tunnels = await import(url("server/repositories/tunnelRepository.ts"));
    const groups = await import(url("server/repositories/forwardGroupRepository.ts"));

    const listOrder = async (table, where = "1 = 1") => (await query(
      "SELECT id FROM " + table + " WHERE " + where + " ORDER BY sortOrder ASC, createdAt DESC, id DESC",
    )).map((r) => Number(r.id)).join(",");
    const values = async (table, where = "1 = 1") => (await query(
      "SELECT id, sortOrder FROM " + table + " WHERE " + where + " ORDER BY id",
    )).map((r) => r.id + ":" + r.sortOrder).join(" ");

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'a', 'h', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'gap', 'h', 'user')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (3, 'legacy', 'h', 'user')");
    await exec("INSERT INTO hosts (id, name, ip, userId, agentToken) VALUES (1, 'h', '192.0.2.1', 1, 't')");
    const rule = (id, userId, sortOrder, createdAt) => exec(
      "INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, sortOrder, createdAt) VALUES (?, 1, ?, 'gost', 'tcp', ?, '198.51.100.1', 80, ?, ?, ?)",
      [id, "r" + id, 20000 + id, userId, sortOrder, createdAt],
    );

    // 一、规则有空洞：0 2 5 7 9。第二页（每页 2 条）是 3、4，拖成 4、3。
    for (const [id, order] of [[1, 0], [2, 2], [3, 5], [4, 7], [5, 9]]) await rule(id, 2, order, 1000 + id);
    await rules.reorderForwardRules("local", [4, 3], 2, 2);
    assert.equal(await listOrder("forward_rules", "userId = 2"), "1,2,4,3,5", "只换这一页里的两条，别的页不动");
    assert.equal(await values("forward_rules", "userId = 2"), "1:0 2:2 3:7 4:5 5:9", "占的还是原来那两个座位");

    // 二、规则老数据全 0：展示顺序靠 createdAt 倒序，是 13、12、11、10。
    // 第一页拖成 12、13 —— 以前会写成 12:0、13:1，13 沉到 11、10 后面。
    for (const [id, createdAt] of [[10, 100], [11, 200], [12, 300], [13, 400]]) await rule(id, 3, 0, createdAt);
    await rules.reorderForwardRules("local", [12, 13], 3, 0);
    assert.equal(await listOrder("forward_rules", "userId = 3"), "12,13,11,10");
    assert.equal(await values("forward_rules", "userId = 3"), "10:3 11:2 12:0 13:1", "先按原展示顺序重编成连续值");
    assert.equal(await values("forward_rules", "userId = 2"), "1:0 2:2 3:7 4:5 5:9", "别的用户的规则不受影响");

    // 三、隧道有空洞：第二页 3、4 拖成 4、3。
    const tunnel = (id, sortOrder, createdAt) => exec(
      "INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId, sortOrder, createdAt) VALUES (?, ?, 1, 1, ?, 1, ?, ?)",
      [id, "t" + id, 30000 + id, sortOrder, createdAt],
    );
    for (const [id, order] of [[1, 0], [2, 3], [3, 4], [4, 8]]) await tunnel(id, order, 1000 + id);
    await tunnels.reorderTunnels([4, 3], 2);
    assert.equal(await listOrder("tunnels"), "1,2,4,3");
    assert.equal(await values("tunnels"), "1:0 2:3 3:8 4:4");

    // 四、转发项目老数据全 0，且只在同一类型里排：另一个类型的项目不动。
    const group = (id, mode, createdAt) => exec(
      "INSERT INTO forward_groups (id, name, groupMode, targetIp, userId, sortOrder, createdAt) VALUES (?, ?, ?, '', 1, 0, ?)",
      [id, "g" + id, mode, createdAt],
    );
    for (const [id, createdAt] of [[1, 100], [2, 200], [3, 300]]) await group(id, "failover", createdAt);
    await group(9, "chain", 50);
    // 展示顺序 3、2、1；把 1 拖到最前。
    await groups.reorderForwardGroups("failover", [1, 3, 2], 0);
    assert.equal(await listOrder("forward_groups", "groupMode = 'failover'"), "1,3,2");
    assert.equal(await values("forward_groups", "groupMode = 'chain'"), "9:0", "别的类型不被重编");

    // 五、校验照旧：别人的规则整个拒绝，一行不改。
    const before = await values("forward_rules");
    await assert.rejects(() => rules.reorderForwardRules("local", [1, 10], 2, 0), /不存在或无权访问/);
    assert.equal(await values("forward_rules"), before);

    // 六、转发组成员排序：必须是这个组完整的成员集合，否则整个拒绝、一行不改。
    for (const [id, groupId, priority] of [[101, 1, 0], [102, 1, 1], [103, 1, 2], [201, 2, 0]]) {
      await exec("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority) VALUES (?, ?, 'host', 1, ?)", [id, groupId, priority]);
    }
    const priorities = async () => (await query(
      "SELECT id, priority FROM forward_group_members ORDER BY id",
    )).map((r) => r.id + ":" + r.priority).join(" ");
    const membersBefore = await priorities();
    await assert.rejects(() => groups.reorderForwardGroupMembers(1, [103, 101]), /不一致/, "少带成员会和旧 priority 撞号");
    await assert.rejects(() => groups.reorderForwardGroupMembers(1, [103, 101, 201]), /不一致/, "夹带别的组的成员");
    await assert.rejects(() => groups.reorderForwardGroupMembers(1, [103, 101, 101]), /重复/);
    assert.equal(await priorities(), membersBefore, "拒绝之后一行都不改");
    await groups.reorderForwardGroupMembers(1, [103, 101, 102]);
    assert.equal(await priorities(), "101:1 102:2 103:0 201:0");

    console.log("REORDER_SLOTS_OK");
  `, { name: "reorder-slots", env: { NODE_ENV: "test" } });
});
