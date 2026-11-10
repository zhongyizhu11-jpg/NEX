import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import type { BackupTransport } from "./offsiteBackupDestinations";
import { sha256Hex, signV4 } from "./offsiteBackupS3";

/*
  起两个本机 HTTP 服务器冒充 S3 和 WebDAV，在真的 SQLite 上把「备份 → 清理 → 失败 → 重试 → 恢复」
  整条路跑一遍。请求是面板真的用 fetch 发出去的，所以能查出「签名时用的和实际发出去的不是一回事」
  这类问题（Host 带不带端口、路径和查询串怎么编码、PROPFIND 这种方法发不发得出去）。

  假 S3 不只看有没有 Authorization：它按收到的请求（方法、路径、查询串、SignedHeaders 列的那些头、
  x-amz-content-sha256）重新算一遍 SigV4，对不上就回 403 SignatureDoesNotMatch，正文哈希也要对得上。
  签名算法本身对不对由 offsiteBackupS3.test.ts 里 AWS 文档的已知向量管。

  正式环境只许 HTTPS、不许连本机（offsiteBackupDestinations.ts 的 safeTransport），这里用测试开关换成
  直接 fetch。
*/

const ACCESS_KEY = "AKIDLOCALTEST";
const SECRET_KEY = "local/secret+key=for-tests";
const BUCKET = "panel-backups";

type Recorded = { method: string; path: string; signed: boolean };

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 路径风格的假 S3：PUT / GET / DELETE 对象、ListObjectsV2（每页 2 个，逼出翻页）。 */
function createFakeS3() {
  const objects = new Map<string, Buffer>();
  const requests: Recorded[] = [];
  const s3Error = (res: http.ServerResponse, status: number, code: string, message: string) => {
    res.writeHead(status, { "content-type": "application/xml" });
    res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const rawUrl = req.url || "/";
      const questionAt = rawUrl.indexOf("?");
      const rawPath = questionAt === -1 ? rawUrl : rawUrl.slice(0, questionAt);
      const query: Array<[string, string]> = questionAt === -1 || questionAt === rawUrl.length - 1
        ? []
        : rawUrl.slice(questionAt + 1).split("&").map((pair) => {
          const eq = pair.indexOf("=");
          return [decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq)), decodeURIComponent(eq === -1 ? "" : pair.slice(eq + 1))] as [string, string];
        });
      const method = String(req.method);
      const auth = String(req.headers.authorization || "");
      const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
      requests.push({ method, path: rawPath, signed: !!match });
      if (!match) return s3Error(res, 403, "AccessDenied", "missing or malformed Authorization");
      const [, accessKeyId, dateStamp, region, signedHeaders, signature] = match;
      const amzDate = String(req.headers["x-amz-date"] || "");
      const payloadHash = String(req.headers["x-amz-content-sha256"] || "");
      if (!/^\d{8}T\d{6}Z$/.test(amzDate) || !amzDate.startsWith(dateStamp)) return s3Error(res, 403, "AccessDenied", "bad x-amz-date");
      if (accessKeyId !== ACCESS_KEY) return s3Error(res, 403, "InvalidAccessKeyId", "unknown access key");
      if (payloadHash !== sha256Hex(body)) return s3Error(res, 400, "XAmzContentSHA256Mismatch", "payload hash mismatch");
      const names = signedHeaders.split(";");
      for (const required of ["host", "x-amz-content-sha256", "x-amz-date"]) {
        if (!names.includes(required)) return s3Error(res, 403, "AccessDenied", `${required} must be signed`);
      }
      const expected = signV4({
        method,
        canonicalPath: rawPath,
        query,
        headers: Object.fromEntries(names.map((name) => [name, String(req.headers[name] ?? "")])),
        payloadHash,
        region,
        service: "s3",
        accessKeyId,
        secretAccessKey: SECRET_KEY,
        amzDate,
      });
      if (expected.signature !== signature) return s3Error(res, 403, "SignatureDoesNotMatch", "The request signature we calculated does not match");

      const [bucket, ...rest] = decodeURIComponent(rawPath).replace(/^\//, "").split("/");
      const key = rest.join("/");
      if (bucket !== BUCKET) return s3Error(res, 404, "NoSuchBucket", "no such bucket");
      if (method === "GET" && !key) {
        const params = new Map(query);
        if (params.get("list-type") !== "2") return s3Error(res, 400, "InvalidArgument", "only ListObjectsV2");
        const prefix = params.get("prefix") || "";
        const keys = Array.from(objects.keys()).filter((item) => item.startsWith(prefix)).sort();
        const start = Number(params.get("continuation-token") || 0);
        const page = keys.slice(start, start + 2);
        const more = start + 2 < keys.length;
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}${page.map((item) => `<Contents><Key>${xmlEscape(item)}</Key><Size>${objects.get(item)!.length}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`).join("")}</ListBucketResult>`);
        return;
      }
      if (method === "PUT") {
        objects.set(key, body);
        res.writeHead(200);
        res.end();
        return;
      }
      if (method === "GET") {
        const found = objects.get(key);
        if (!found) return s3Error(res, 404, "NoSuchKey", "no such key");
        res.writeHead(200, { "content-length": String(found.length) });
        res.end(found);
        return;
      }
      if (method === "DELETE") {
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      s3Error(res, 405, "MethodNotAllowed", method);
    })().catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  return { server, objects, requests };
}

/** 假 WebDAV：Basic 认证，/dav/nex/ 一个目录。broken 打开时一律回 500（模拟网盘挂了）。 */
function createFakeWebdav(user: string, password: string) {
  const files = new Map<string, Buffer>();
  const requests: Recorded[] = [];
  const state = { broken: false, folderExists: true };
  const expectedAuth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const server = http.createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const method = String(req.method);
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      requests.push({ method, path: urlPath, signed: req.headers.authorization === expectedAuth });
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="dav"' });
        res.end();
        return;
      }
      if (state.broken) {
        res.writeHead(500);
        res.end("disk on fire");
        return;
      }
      if (!urlPath.startsWith("/dav/nex/")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const name = urlPath.slice("/dav/nex/".length);
      if (method === "MKCOL" && !name) {
        state.folderExists = true;
        res.writeHead(201);
        res.end();
        return;
      }
      if (!state.folderExists) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (method === "PROPFIND" && !name) {
        assert.match(body.toString("utf8"), /propfind/, "PROPFIND 带着请求体发出来了");
        const depth = String(req.headers.depth || "");
        const self = `<D:response><D:href>/dav/nex/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
        const children = depth === "1"
          ? Array.from(files.entries()).map(([key, value]) => `<D:response><D:href>/dav/nex/${encodeURIComponent(key)}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>${value.length}</D:getcontentlength><D:getlastmodified>Thu, 01 Jan 2026 00:00:00 GMT</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join("")
          : "";
        res.writeHead(207, { "content-type": "application/xml; charset=utf-8" });
        res.end(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${self}${children}</D:multistatus>`);
        return;
      }
      if (method === "PUT" && name) {
        files.set(name, body);
        res.writeHead(201);
        res.end();
        return;
      }
      if (method === "GET" && name) {
        const found = files.get(name);
        res.writeHead(found ? 200 : 404);
        res.end(found);
        return;
      }
      if (method === "DELETE" && name) {
        res.writeHead(files.delete(name) ? 204 : 404);
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
    })().catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  return { server, files, requests, state };
}

const localTransport: BackupTransport = (url, init) => {
  const { timeoutMs, ...rest } = init;
  return fetch(url, { ...rest, redirect: "manual", signal: AbortSignal.timeout(timeoutMs ?? 10_000) });
};

const OWN_NAME = /^nex-backup-\d{8}-\d{4}\.fwxbak$/;
const HOUR = 3600 * 1000;

const s3 = createFakeS3();
const dav = createFakeWebdav("backup", "dav-pass-123");
let s3Port = 0;
let davPort = 0;
let directory = "";

// 碰数据库的模块都要等 DATABASE_TYPE 设好之后再 import（dbRuntime 在加载时就定了方言）。
type Backup = typeof import("./offsiteBackup");
type Destinations = typeof import("./offsiteBackupDestinations");
type Job = typeof import("./offsiteBackupJob");
type Events = typeof import("./panelEvents");
type Runtime = typeof import("../dbRuntime");
type SettingsRepo = typeof import("../repositories/settingsRepository");
let backup: Backup;
let destinations: Destinations;
let job: Job;
let events: Events;
let runtime: Runtime;
let settingsRepo: SettingsRepo;

const s3Settings = (overrides: { secretAccessKey?: string } = {}) => ({
  endpoint: `http://127.0.0.1:${s3Port}`,
  region: "auto",
  bucket: BUCKET,
  prefix: "nex",
  accessKeyId: ACCESS_KEY,
  secretAccessKey: overrides.secretAccessKey ?? SECRET_KEY,
  pathStyle: true,
});
const davSettings = () => ({ url: `http://127.0.0.1:${davPort}/dav/nex`, user: "backup", password: "dav-pass-123" });
const ownS3Keys = () => Array.from(s3.objects.keys()).filter((key) => key.startsWith("nex/") && OWN_NAME.test(key.slice(4)));
const backupEvents = () => events.listPanelEvents({ kindPrefix: "ops.backup" });

before(async () => {
  process.env.DATABASE_TYPE = "sqlite";
  s3Port = await listen(s3.server);
  davPort = await listen(dav.server);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-offsite-local-"));
  runtime = await import("../dbRuntime");
  const { ensureDatabaseSchema } = await import("../dbSchema");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "a.db") } });
  await ensureDatabaseSchema();
  await runtime.insertAndGetId("users", { username: "admin", password: "x", role: "admin" });
  backup = await import("./offsiteBackup");
  job = await import("./offsiteBackupJob");
  events = await import("./panelEvents");
  settingsRepo = await import("../repositories/settingsRepository");
  destinations = await import("./offsiteBackupDestinations");
  destinations.setOffsiteBackupTransportForTests(localTransport);
});

after(async () => {
  destinations?.setOffsiteBackupTransportForTests(null);
  await runtime?.closeDatabase().catch(() => undefined);
  await new Promise((resolve) => s3.server.close(resolve));
  await new Promise((resolve) => dav.server.close(resolve));
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test("S3：上传的请求签名对得上，保留份数只清前缀目录里自己起名的文件", async () => {
  // 前缀目录里：三份旧备份 + 别人的文件；更深的目录、别的前缀、桶根上长得像备份的，都不是我们的。
  for (const key of [
    "nex/nex-backup-20200101-0400.fwxbak",
    "nex/nex-backup-20200102-0400.fwxbak",
    "nex/nex-backup-20200103-0400.fwxbak",
    "nex/notes.txt",
    "nex/nex-backup-20200101-0400.fwxbak.bak",
    "nex/archive/nex-backup-20200101-0400.fwxbak",
    "other/nex-backup-20200101-0400.fwxbak",
    "nex-backup-20200101-0400.fwxbak",
  ]) s3.objects.set(key, Buffer.from("x"));
  const foreign = Array.from(s3.objects.keys()).filter((key) => !key.startsWith("nex/nex-backup-2020010") || key.endsWith(".bak"));

  await backup.saveOffsiteBackupSettings({
    destinations: ["s3"],
    s3: s3Settings(),
    passphrase: "correct horse battery",
    schedule: { mode: "daily", hour: 4 },
    keep: 2,
  });
  const forClient = await backup.readOffsiteBackupSettingsForClient();
  assert.equal(forClient.s3.hasSecretKey, true);
  assert.ok(!JSON.stringify(forClient).includes(SECRET_KEY), "Secret Key 不回给界面");
  assert.ok(!JSON.stringify(forClient).includes("correct horse battery"), "备份口令不回给界面");
  const stored = await runtime.queryRaw<{ value: string }>("SELECT value FROM system_settings WHERE key = ?", ["ops.backup.s3.secretKey"]);
  assert.ok(stored[0].value && !stored[0].value.includes(SECRET_KEY), "Secret Key 落库是密文");

  const result = await backup.runOffsiteBackup("manual");
  assert.match(result.name, OWN_NAME);
  assert.equal(result.deleted, 2, "保留 2 份：新的一份 + 最新的一份旧的");
  assert.deepEqual(ownS3Keys().sort(), ["nex/nex-backup-20200103-0400.fwxbak", `nex/${result.name}`].sort());
  for (const key of foreign) assert.ok(s3.objects.has(key), `${key} 不是面板的备份，不能动`);

  assert.ok(s3.requests.length > 0 && s3.requests.every((request) => request.signed), "每个请求都带着 SigV4 的 Authorization");
  const methods = new Set(s3.requests.map((request) => request.method));
  assert.deepEqual([...methods].sort(), ["DELETE", "GET", "PUT"]);
  assert.ok(s3.requests.filter((request) => request.method === "GET").length >= 2, "列目录翻了页");

  // 传上去的是密文，取回来能用口令解开
  const uploaded = s3.objects.get(`nex/${result.name}`)!.toString("utf8");
  assert.ok(!uploaded.includes("\"admin\""));
  const { decryptMigrationSnapshotBackup } = await import("../migration");
  const content = await backup.downloadOffsiteBackup("s3", result.name);
  assert.ok(Array.isArray(decryptMigrationSnapshotBackup(content, "correct horse battery").tables.users));
  assert.throws(() => decryptMigrationSnapshotBackup(content, "wrong passphrase"), /备份密码错误/);
});

test("S3：「测试连接」试写再删掉，不留文件；Secret Key 不对时报出 S3 的错误码且不泄露密钥", async () => {
  const before = Array.from(s3.objects.keys()).sort();
  assert.match(await backup.testOffsiteBackupConnection(), /S3：连接正常/);
  assert.deepEqual(Array.from(s3.objects.keys()).sort(), before);

  await backup.saveOffsiteBackupSettings({ destinations: ["s3"], s3: s3Settings({ secretAccessKey: "not-the-secret" }), schedule: { mode: "daily", hour: 4 }, keep: 2 });
  await assert.rejects(() => backup.testOffsiteBackupConnection(), (error: Error) => {
    assert.match(error.message, /S3 不通/);
    assert.match(error.message, /SignatureDoesNotMatch/);
    assert.ok(!error.message.includes("not-the-secret"));
    return true;
  });
  await assert.rejects(() => backup.runOffsiteBackup("manual"), /SignatureDoesNotMatch/);
  await backup.saveOffsiteBackupSettings({ destinations: ["s3"], s3: s3Settings(), schedule: { mode: "daily", hour: 4 }, keep: 2 });
  // 把上面那次失败清掉，后面的用例从「没有连续失败」开始。
  assert.ok(await backup.runOffsiteBackup("manual"));
});

test("WebDAV：目录不存在时测试连接会新建；密码不对报 401", async () => {
  dav.state.folderExists = false;
  await backup.saveOffsiteBackupSettings({ destinations: ["webdav"], webdav: davSettings(), schedule: { mode: "daily", hour: 4 }, keep: 2 });
  assert.match(await backup.testOffsiteBackupConnection(), /WebDAV：连接正常，目录不存在，已新建/);
  assert.equal(dav.files.size, 0, "试写的文件删掉了");
  assert.ok(dav.requests.some((request) => request.method === "MKCOL"));

  await backup.saveOffsiteBackupSettings({ destinations: ["webdav"], webdav: { ...davSettings(), password: "wrong-pass" }, schedule: { mode: "daily", hour: 4 }, keep: 2 });
  await assert.rejects(() => backup.testOffsiteBackupConnection(), (error: Error) => {
    assert.match(error.message, /401/);
    assert.ok(!error.message.includes("wrong-pass"));
    return true;
  });
});

test("两个目的地都开：一个不通时另一个照常成功，重试只补不通的那个，连续失败不刷事件", async () => {
  dav.files.set("nex-backup-20200101-0400.fwxbak", Buffer.from("old"));
  dav.files.set("family-photos.zip", Buffer.from("keep me"));
  await backup.saveOffsiteBackupSettings({ destinations: ["webdav", "s3"], webdav: davSettings(), s3: s3Settings(), schedule: { mode: "daily", hour: 4 }, keep: 2 });

  // 第一次：WebDAV 挂了
  dav.state.broken = true;
  const eventsBefore = (await backupEvents()).length;
  await assert.rejects(() => backup.runOffsiteBackup("manual"), (error: Error) => {
    assert.match(error.message, /异地备份失败：WebDAV .*HTTP 500/);
    assert.match(error.message, /（S3 已成功）/);
    return true;
  });
  let { state } = await backup.readOffsiteBackupSettings();
  const s3SuccessAt = state.targets.s3.successAt;
  assert.ok(s3SuccessAt);
  assert.equal(state.targets.webdav.successAt, null);
  assert.equal(state.failStreak, 1);
  assert.deepEqual(state.history.slice(0, 2).map((entry) => [entry.destination, entry.ok]), [["webdav", false], ["s3", true]]);
  assert.match(state.history[0].message, /HTTP 500/);
  let list = await backupEvents();
  assert.equal(list.length, eventsBefore + 1, "第一次失败记一条事件");
  assert.equal(list[0].level, "warn");

  // 一小时后的定时重试：S3 这个时间点已经成功过，只补 WebDAV；还是失败，但不再记事件
  const s3Puts = () => s3.requests.filter((request) => request.method === "PUT").length;
  const putsBefore = s3Puts();
  const makeWebdavRetryDue = () => settingsRepo.setSettings({ "ops.backup.last.webdav.attemptAt": String(Date.now() - 2 * HOUR) });
  await makeWebdavRetryDue();
  await assert.rejects(() => backup.runOffsiteBackup("schedule"), /WebDAV/);
  assert.equal(s3Puts(), putsBefore, "S3 没有被再传一份");
  ({ state } = await backup.readOffsiteBackupSettings());
  assert.equal(state.failStreak, 2);
  assert.equal(state.targets.s3.successAt, s3SuccessAt);
  assert.equal((await backupEvents()).length, eventsBefore + 1, "连续失败的第二次不再记事件");

  // 刚失败过、还没到一小时：定时任务什么都不做
  assert.equal(await backup.runOffsiteBackup("schedule"), null);

  // 失败满一天后的那一次再记一条，带上连续失败的次数
  await settingsRepo.setSettings({ "ops.backup.fail.reportedAt": String(Date.now() - 25 * HOUR) });
  await makeWebdavRetryDue();
  await assert.rejects(() => backup.runOffsiteBackup("schedule"), /WebDAV/);
  list = await backupEvents();
  assert.equal(list.length, eventsBefore + 2);
  assert.match(list[0].message, /已连续失败 3 次/);

  // WebDAV 好了：定时任务补上它，事件里说明恢复；同一个小时里另一个面板进程抢不到标记，不会再跑一遍
  dav.state.broken = false;
  await makeWebdavRetryDue();
  const now = Date.now();
  await job.runOffsiteBackupIfDue(now);
  ({ state } = await backup.readOffsiteBackupSettings());
  assert.ok(state.targets.webdav.successAt, "WebDAV 补上了");
  assert.equal(state.failStreak, 0);
  assert.equal(s3Puts(), putsBefore, "S3 仍然没有被再传");
  list = await backupEvents();
  assert.equal(list[0].level, "info");
  assert.match(list[0].message, /此前连续失败 3 次，已恢复/);
  const ownDav = Array.from(dav.files.keys()).filter((name) => OWN_NAME.test(name));
  assert.ok(ownDav.length === 2 && ownDav.includes("nex-backup-20200101-0400.fwxbak"));
  assert.ok(dav.files.has("family-photos.zip"), "网盘里别人的文件不动");

  const davPuts = () => dav.requests.filter((request) => request.method === "PUT").length;
  const davPutsBefore = davPuts();
  await settingsRepo.setSettings({ "ops.backup.last.webdav.successAt": String(now - 48 * HOUR), "ops.backup.last.webdav.attemptAt": String(now - 47 * HOUR) });
  await job.runOffsiteBackupIfDue(now);
  assert.equal(davPuts(), davPutsBefore, "这个小时的标记已经被抢走，不重复备份");

  // 「从远端恢复」的列表：两个目的地各列各的
  const remote = await backup.listOffsiteBackups();
  assert.deepEqual(remote.map((group) => [group.destination, group.error]), [["webdav", null], ["s3", null]]);
  assert.ok(remote.every((group) => group.files.length > 0 && group.files.every((file) => OWN_NAME.test(file.name))));
});

test("没开或没设口令时，定时任务什么都不做", async () => {
  const requestsBefore = s3.requests.length + dav.requests.length;
  await backup.saveOffsiteBackupSettings({ destinations: [], schedule: { mode: "daily", hour: 4 }, keep: 2 });
  await job.runOffsiteBackupIfDue(Date.now() + 5 * HOUR);
  assert.equal(await backup.runOffsiteBackup("schedule"), null);
  await assert.rejects(() => backup.runOffsiteBackup("manual"), /未开启/);
  assert.equal(s3.requests.length + dav.requests.length, requestsBefore);
});
