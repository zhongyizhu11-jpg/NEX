import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  「全部」页有分组时按分组排：分组顺序 → 组内顺序 → 不在分组里的按主机顺序。在这一页里拖，
  只能在同一段里换：同一个分组的几台换组内顺序，不在分组里的那段换主机顺序。都按「原来的座位」换，
  页偏移算不准（这一页上一个分组可能只露出一截）。
*/
test("全部页按分组排时拖主机：组内顺序 / 主机顺序都在原来的座位里换", () => {
  runInDatabase(String.raw`
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    for (const [id, order] of [[1, 0], [2, 4], [3, 6], [4, 9], [5, 12]]) {
      await exec('INSERT INTO hosts (id, name, ip, "agentToken", "userId", "sortOrder") VALUES (?, ?, ?, ?, 1, ?)', [id, "h" + id, "203.0.113." + id, "t" + id, order]);
    }
    const repo = await import(url("server/repositories/hostGroupRepository.ts"));
    const hosts = await import(url("server/repositories/hostRepository.ts"));
    const groupId = await repo.createHostGroup({ name: "g", hostIds: [1, 2, 3], userId: 1 });
    const memberOrder = async () => (await query('SELECT "hostId", "sortOrder" FROM host_group_members WHERE "groupId" = ? ORDER BY "sortOrder" ASC, id ASC', [groupId])).map((r) => Number(r.hostId)).join(",");
    const hostOrder = async () => (await query('SELECT id FROM hosts ORDER BY "sortOrder" ASC, "createdAt" DESC, id DESC')).map((r) => Number(r.id)).join(",");

    assert.equal(await memberOrder(), "1,2,3");
    // 这一页只露出这个分组的后两台，拖成 3、2：第 1 台不动
    await repo.reorderHostGroupMembersInPlace(groupId, [3, 2]);
    assert.equal(await memberOrder(), "1,3,2");
    await assert.rejects(() => repo.reorderHostGroupMembersInPlace(groupId, [4, 1]), /不属于该分组/);

    // 不在分组里的两台（4、5）互换，占的还是 9、12 两个座位，别的主机不动
    await hosts.reorderHostsInPlace([5, 4]);
    assert.equal(await hostOrder(), "1,2,3,5,4");
    const values = (await query('SELECT id, "sortOrder" FROM hosts ORDER BY id')).map((r) => r.id + ":" + r.sortOrder).join(" ");
    assert.equal(values, "1:0 2:4 3:6 4:12 5:9");
  `, { name: "host-reorder-in-place", quiet: true });
});
