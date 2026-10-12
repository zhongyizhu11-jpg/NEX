import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  在真的 SQLite 上跑一遍「备份 → 列表 → 保留 N 份 → 取回解密」，WebDAV 服务器用一个替身 fetch 模拟
  （地址用公网 IP 字面量，SSRF 检查不需要查 DNS）。
*/
test("异地备份：WebDAV 上传、保留份数、取回后能用口令解密", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("../dbRuntime");
  const { ensureDatabaseSchema } = await import("../dbSchema");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-offsite-"));
  const store = new Map<string, Buffer>();
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || "GET").toUpperCase();
    seen.push(`${method} ${url.pathname}`);
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.authorization, `Basic ${Buffer.from("u:p").toString("base64")}`);
    const name = decodeURIComponent(url.pathname.split("/").pop() || "");
    if (method === "PUT") {
      store.set(name, Buffer.from(init.body));
      return new Response(null, { status: 201 });
    }
    if (method === "DELETE") {
      store.delete(name);
      return new Response(null, { status: 204 });
    }
    if (method === "GET") {
      const body = store.get(name);
      return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response(null, { status: 404 });
    }
    if (method === "PROPFIND") {
      const items = Array.from(store.entries()).map(([key, value]) => `<d:response><d:href>/dav/nex/${encodeURIComponent(key)}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${value.length}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
      return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/nex/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>${items.join("")}</d:multistatus>`, { status: 207 });
    }
    return new Response(null, { status: 405 });
  }) as typeof fetch;
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "a.db") } });
    await ensureDatabaseSchema();
    await runtime.insertAndGetId("users", { username: "admin", password: "x", role: "admin" });
    const backup = await import("./offsiteBackup");
    const { decryptMigrationSnapshotBackup } = await import("../migration");
    const { listPanelEvents } = await import("./panelEvents");

    // 两份「旧」备份 + 一个别人的文件
    store.set("nex-backup-20200101-0400.fwxbak", Buffer.from("old1"));
    store.set("nex-backup-20200102-0400.fwxbak", Buffer.from("old2"));
    store.set("notes.txt", Buffer.from("keep me"));

    await backup.saveOffsiteBackupSettings({
      destination: "webdav",
      webdav: { url: "https://93.184.216.34/dav/nex", user: "u", password: "p" },
      passphrase: "correct horse",
      schedule: { mode: "daily", hour: 4 },
      keep: 2,
    });
    const forClient = await backup.readOffsiteBackupSettingsForClient();
    assert.equal(forClient.webdav.hasPassword, true);
    assert.equal((forClient.webdav as any).password, undefined, "密码不回给界面");
    assert.equal(forClient.hasPassphrase, true);

    const result = await backup.runOffsiteBackup("manual");
    assert.match(result.name, /^nex-backup-\d{8}-\d{4}\.fwxbak$/);
    assert.equal(result.deleted, 1, "保留 2 份：删掉最旧的那一份");
    assert.ok(store.has(result.name));
    assert.ok(!store.has("nex-backup-20200101-0400.fwxbak"));
    assert.ok(store.has("nex-backup-20200102-0400.fwxbak"));
    assert.ok(store.has("notes.txt"), "别人的文件不动");

    // 上传的内容是加密的：不含明文用户名，能用口令解开
    const uploaded = store.get(result.name)!.toString("utf8");
    assert.ok(!uploaded.includes("\"admin\""));
    const list = await backup.listOffsiteBackups();
    assert.deepEqual(list.map((file) => file.name), [result.name, "nex-backup-20200102-0400.fwxbak"]);
    const content = await backup.downloadOffsiteBackup(result.name);
    const snapshot = decryptMigrationSnapshotBackup(content, "correct horse");
    assert.ok(Array.isArray(snapshot.tables.users));
    assert.throws(() => decryptMigrationSnapshotBackup(content, "wrong password"));
    await assert.rejects(() => backup.downloadOffsiteBackup("notes.txt"), /只能恢复/);

    const state = await backup.readOffsiteBackupSettings();
    assert.equal(state.status.lastStatus, "success");
    const events = await listPanelEvents({ kindPrefix: "ops.backup" });
    assert.equal(events[0]?.level, "info");

    // 只许 HTTPS
    await backup.saveOffsiteBackupSettings({
      destination: "webdav",
      webdav: { url: "http://93.184.216.34/dav/nex" },
      schedule: { mode: "daily", hour: 4 },
      keep: 2,
    });
    await assert.rejects(() => backup.runOffsiteBackup("manual"), /HTTPS/);
    const failed = await listPanelEvents({ kindPrefix: "ops.backup" });
    assert.equal(failed[0]?.level, "warn");
    assert.match(failed[0]?.message || "", /异地备份失败/);
  } finally {
    globalThis.fetch = realFetch;
    await runtime.closeDatabase().catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
