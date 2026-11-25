import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 拖拽排序看起来无害，其实是个**批量写接口**：给一串 id，逐个改它们的 sortOrder。
 *
 * 所以它必须先整体校验再写 —— 少了那一步，一个夹带了别人 id 的排序请求会把别人的
 * 行也改掉，而且悄无声息（界面上只是自己那一列换了个顺序）。
 *
 * 探测服务和主机分组的重排原来各存一份 371 token 的实现，一字不差，现在合并成
 * `reorderRowsBySortOrder`。合并动的是批量写的路径，所以这一组把三条守住：
 * 正常排序要生效、夹带别人的 id 要整个拒绝且**一行都不许改**、重复 id 要拒绝。
 */
test("重排序：越权和脏数据整个拒绝，且不留下半拉写入", () => {
  runInDatabase(String.raw`
    const groups = await import(url("server/repositories/hostGroupRepository.ts"));

    const order = async () => (await query(
      'SELECT "id", "sortOrder" FROM "host_groups" ORDER BY "id"',
    )).map((r) => Number(r.id) + ":" + Number(r.sortOrder)).join(" ");

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'a', 'h', 'admin')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, '张三', 'h', 'user')");
    await exec("INSERT INTO users (id, username, password, role) VALUES (3, '李四', 'h', 'user')");
    // 张三两个分组，李四一个
    await exec("INSERT INTO host_groups (id, name, userId, sortOrder) VALUES (10, 'z1', 2, 0)");
    await exec("INSERT INTO host_groups (id, name, userId, sortOrder) VALUES (11, 'z2', 2, 1)");
    await exec("INSERT INTO host_groups (id, name, userId, sortOrder) VALUES (20, 'l1', 3, 0)");

    // 一、正常排序生效
    await groups.reorderHostGroups([11, 10], 2);
    assert.equal(await order(), "10:1 11:0 20:0", "张三自己的两个分组要换过来");

    const before = await order();

    // 二、夹带别人的 id —— 整个拒绝，一行都不许改
    await assert.rejects(
      () => groups.reorderHostGroups([11, 10, 20], 2),
      /无权操作或不存在/,
      "夹带了李四的分组，应当整个拒绝",
    );
    assert.equal(await order(), before, "拒绝之后一行都不该被改过");

    // 三、重复 id —— 前端状态已经乱了，照着写会把两行挤到同一个位置
    await assert.rejects(() => groups.reorderHostGroups([10, 10], 2), /排序数据无效/);
    assert.equal(await order(), before, "重复 id 拒绝之后也不该改任何行");

    // 四、不存在的 id 同样整个拒绝
    await assert.rejects(() => groups.reorderHostGroups([10, 999], 2), /无权操作或不存在/);
    assert.equal(await order(), before);

    // 五、管理员不传 userId 时可以跨用户排，但 id 必须都存在
    await groups.reorderHostGroups([20, 10, 11]);
    assert.equal(await order(), "10:1 11:2 20:0", "管理员那一路照旧能排");

    console.log("REORDER_OK");
  `, { name: "reorder", env: { NODE_ENV: "test" } });
});
