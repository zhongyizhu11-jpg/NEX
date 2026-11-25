import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

test("an entry/exit group still used by a tunnel or chain cannot be deleted", () => {
  runInDatabase(String.raw`
    const service = await import(url("server/services/forwardGroupService.ts"));
    const q = (name) => '"' + name + '"';
    const insert = (table, columns, values) => exec(
      "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
      values,
    );
    const groupExists = async (id) => (await query('SELECT "id" FROM "forward_groups" WHERE "id" = ?', [id])).length > 0;
    await insert("users", ["id", "username", "password", "role"], [1, "admin", "x", "admin"]);
    for (const id of [1, 2]) await insert("hosts", ["id", "name", "ip", "userId"], [id, "h" + id, "198.51.100." + id, 1]);
    const groupCols = ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"];
    await insert("forward_groups", groupCols, [20, "entry", "host", "entry", "entry.example.test", "0.0.0.0", 1, 1]);
    await insert("forward_groups", groupCols, [21, "exit", "host", "exit", null, "0.0.0.0", 1, 1]);
    await insert("forward_groups", groupCols, [22, "unused-entry", "host", "entry", "unused.example.test", "0.0.0.0", 1, 1]);
    await insert("forward_groups", [...groupCols, "entryGroupId"], [23, "chain", "host", "chain", null, "0.0.0.0", 1, 1, 22]);
    await insert("tunnels", ["id", "name", "entryGroupId", "exitGroupId", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [30, "t", 20, 21, 1, 2, "tls", 25000, 1, 1]);

    await assert.rejects(() => service.deleteForwardGroupWithImpact(20), /隧道「t」/);
    await assert.rejects(() => service.deleteForwardGroupWithImpact(21), /隧道「t」/);
    await assert.rejects(() => service.deleteForwardGroupWithImpact(22), /转发链「chain」/);
    assert.equal(await groupExists(20) && await groupExists(21) && await groupExists(22), true);

    await exec('DELETE FROM "tunnels" WHERE "id" = 30');
    await service.deleteForwardGroupWithImpact(21);
    assert.equal(await groupExists(21), false, "an unreferenced group can be deleted");
  `, { name: "group-delete-refs" });
});
