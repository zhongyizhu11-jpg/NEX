import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("ordinary users persist an isolated order for owned and authorized hosts", () => {
  runInDatabase(String.raw`
    const hosts = await import(url("server/repositories/hostRepository.ts"));
    const settings = await import(url("server/repositories/settingsRepository.ts"));
    const pageIds = async (input) => (await hosts.getHostsPage(input)).items.map((host) => Number(host.id));
    for (const [id, username] of [[10, "viewer"], [20, "shared-owner"], [30, "other-viewer"]]) {
      await exec(
        'INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)',
        [id, username, "hash", "user"],
      );
    }
    for (const [id, userId, sortOrder] of [
      [1, 10, 0],
      [2, 10, 1],
      [3, 20, 2],
      [4, 20, 3],
      [5, 10, 4],
    ]) {
      await exec(
        'INSERT INTO "hosts" ("id", "name", "ip", "hostType", "userId", "sortOrder") VALUES (?, ?, ?, ?, ?, ?)',
        [id, "host-" + id, "192.0.2." + id, "slave", userId, sortOrder],
      );
    }

    const viewerScope = { ownerUserId: 10, allowedHostIds: [3], sortUserId: 10 };
    assert.deepEqual(await pageIds({ ...viewerScope, page: 1, pageSize: 10 }), [1, 2, 3, 5]);

    await hosts.reorderVisibleHostsForUser([2, 1], 10, [3], 0);
    assert.deepEqual(await pageIds({ ...viewerScope, page: 1, pageSize: 10 }), [2, 1, 3, 5]);

    await hosts.reorderVisibleHostsForUser([5, 3], 10, [3], 2);
    assert.deepEqual(await pageIds({ ...viewerScope, page: 1, pageSize: 2 }), [2, 1]);
    assert.deepEqual(await pageIds({ ...viewerScope, page: 2, pageSize: 2 }), [5, 3]);
    assert.deepEqual(JSON.parse(await settings.getSetting("ui.hostOrder.user.10.v1")), [2, 1, 5, 3]);

    assert.deepEqual(await pageIds({ page: 1, pageSize: 10 }), [1, 2, 3, 4, 5]);
    assert.deepEqual(await pageIds({ ownerUserId: 30, allowedHostIds: [1, 2, 3, 5], sortUserId: 30, page: 1, pageSize: 10 }), [1, 2, 3, 5]);

    await assert.rejects(
      () => hosts.reorderVisibleHostsForUser([4], 10, [3], 0),
      /无权操作或不存在/,
    );
    assert.deepEqual(JSON.parse(await settings.getSetting("ui.hostOrder.user.10.v1")), [2, 1, 5, 3]);

    await hosts.reorderHosts([2, 1], undefined, 0);
    assert.deepEqual(await pageIds({ page: 1, pageSize: 10 }), [2, 1, 3, 4, 5]);
    assert.deepEqual(await pageIds({ ...viewerScope, page: 1, pageSize: 10 }), [2, 1, 5, 3]);

    await exec(
      'INSERT INTO "hosts" ("id", "name", "ip", "hostType", "userId", "sortOrder") VALUES (?, ?, ?, ?, ?, ?)',
      [6, "host-6", "192.0.2.6", "slave", 20, 5],
    );
    const changedScope = { ownerUserId: 10, allowedHostIds: [6], sortUserId: 10 };
    assert.deepEqual(await pageIds({ ...changedScope, page: 1, pageSize: 10 }), [2, 1, 5, 6]);
    await hosts.reorderVisibleHostsForUser([6, 5], 10, [6], 2);
    assert.deepEqual(await pageIds({ ...changedScope, page: 1, pageSize: 10 }), [2, 1, 6, 5]);
    assert.deepEqual(JSON.parse(await settings.getSetting("ui.hostOrder.user.10.v1")), [2, 1, 6, 5]);

    await settings.setSetting("ui.hostOrder.user.30.v1", "not-json");
    assert.deepEqual(await pageIds({ ownerUserId: 30, allowedHostIds: [1, 2, 3], sortUserId: 30, page: 1, pageSize: 10 }), [2, 1, 3]);
  `, { name: "host-user-order" });
});
