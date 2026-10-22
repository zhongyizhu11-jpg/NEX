import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 外部订阅：起一个本地 HTTP 服务当「机场」，面板拉它、解析、对账；再改内容拉第二遍。
 * SSRF：拉内网地址要被拦（测试用的服务本身就在 127.0.0.1，所以 fetch 层用环境变量放一个口子）。
 */
test("外部订阅的拉取、对账与 SSRF 拦截", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-sub-source-"));
  const databasePath = path.join(directory, "sub-source.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const sync = await import(url("server/proxySubSourceSync.ts"));
    const repo = await import(url("server/repositories/proxySubExtraRepository.ts"));
    const nodesRepo = await import(url("server/repositories/proxySubscriptionRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'owner', 'hash', 'user', 1)");

    // SSRF：内网主机名直接拒。
    await assert.rejects(() => sync.assertPublicHost("127.0.0.1"), /内网/);
    await assert.rejects(() => sync.assertPublicHost("localhost"), /内网/);
    await assert.rejects(() => sync.assertPublicHost("10.0.0.5"), /内网/);
    await assert.rejects(() => sync.assertPublicHost("[fd00::1]"), /内网/);
    await sync.assertPublicHost("1.1.1.1");

    // 本地「机场」：第一次给两个节点，第二次给一个新的加一个老的。
    let body = [
      "vless://11111111-1111-1111-1111-111111111111@hk.example.com:443?encryption=none&security=tls&sni=hk.example.com&type=ws&path=%2Fray#HK-01",
      "ss://YWVzLTEyOC1nY206cGFzcw@jp.example.com:8388#JP-01",
    ].join("\n");
    const upstream = http.createServer((request, response) => {
      response.setHeader("subscription-userinfo", "upload=1; download=2; total=100; expire=0");
      response.setHeader("content-type", "text/plain");
      response.end(Buffer.from(body).toString("base64"));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = upstream.address().port;

    // 测试里的上游在 127.0.0.1：把 SSRF 检查换成放行（只在这个子进程里）。
    const originalAssert = sync.assertPublicHost;
    const fetchPatched = await import(url("server/proxySubSourceSync.ts"));
    void originalAssert; void fetchPatched;
    process.env.FORWARDX_TEST_ALLOW_PRIVATE_SUB_SOURCE = "1";

    const sourceId = await repo.createProxySubSource({ userId: 1, name: "机场", url: "http://127.0.0.1:" + port + "/sub", intervalSec: 3600, mode: "import", isEnabled: true });
    const first = await sync.syncProxySubSource(Number(sourceId), { force: true });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.added, 2);
    let nodes = await nodesRepo.getProxyNodesByUser(1);
    assert.deepEqual(nodes.map((node) => node.name).sort(), ["HK-01", "JP-01"]);
    assert.ok(nodes.every((node) => Number(node.sourceId) === Number(sourceId) && node.includeDirect));
    const sourceRow = await repo.getProxySubSourceById(Number(sourceId));
    assert.equal(sourceRow.lastStatus, "ok");
    assert.equal(sourceRow.nodeCount, 2);
    assert.deepEqual(JSON.parse(sourceRow.upstreamUserinfo), { upload: 1, download: 2, total: 100, expire: 0 });

    // 内容没变：第二次什么都不动。
    const same = await sync.syncProxySubSource(Number(sourceId));
    assert.equal(same.unchanged, true);

    // 上游换了：HK 改名、JP 没了、多了 US。
    body = [
      "vless://11111111-1111-1111-1111-111111111111@hk.example.com:443?encryption=none&security=tls&sni=hk.example.com&type=ws&path=%2Fray#HK-renamed",
      "trojan://pw@us.example.com:443?sni=us.example.com#US-01",
    ].join("\n");
    const second = await sync.syncProxySubSource(Number(sourceId));
    assert.equal(second.ok, true, second.error);
    assert.deepEqual({ added: second.added, updated: second.updated, removed: second.removed }, { added: 1, updated: 1, removed: 1 });
    nodes = await nodesRepo.getProxyNodesByUser(1);
    assert.deepEqual(nodes.map((node) => node.name).sort(), ["HK-renamed", "US-01"]);

    // 删来源连节点一起删。
    await repo.deleteProxySubSource(Number(sourceId));
    assert.equal((await nodesRepo.getProxyNodesByUser(1)).length, 0);

    await new Promise((resolve) => upstream.close(resolve));
    console.log("ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
