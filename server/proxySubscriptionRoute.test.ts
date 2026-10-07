import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("订阅地址按 token 返回节点，并按客户端 UA 选择格式", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-sub-route-"));
  const databasePath = path.join(directory, "sub-route.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const route = await import(url("server/proxySubscriptionRoute.ts"));
    const proxyNode = await import(url("shared/proxyNode.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();

    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role, trafficUsed, trafficLimit, allowProxySubscription) VALUES (1, 'owner', 'hash', 'user', 12345, 1000000, 1)");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'other', 'hash', 'user')");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, '广州1', '1.2.3.4', '1.2.3.4', 1)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (2, '广州2', '5.6.7.8', '5.6.7.8', 1)");

    await exec(
      "INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, path, tls, sni, isEnabled) VALUES (1, 1, 'HKT', 'vless', 'hkt.example.com', 443, 'abc-uuid', 'ws', '/ray', 1, 'hkt.example.com', 1)",
    );

    const insertRule = (id, hostId, name, port, nodeId, visible) => exec(
      "INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete, proxyNodeId, proxyNodeVisible) VALUES (?, ?, ?, 'realm', 'tcp', ?, 'hkt.example.com', 443, 1, 1, 1, 0, ?, ?)",
      [id, hostId, name, port, nodeId, visible],
    );
    await insertRule(1, 1, '广州1转HKT', 20001, 1, 1);
    await insertRule(2, 2, '广州2转HKT', 20002, 1, 1);
    await insertRule(3, 1, '隐藏的那条', 20003, 1, 0);
    await insertRule(4, 1, '未绑定的转发', 20004, null, 1);

    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, rulePreset, isEnabled) VALUES (1, 1, '手机', 'token-live', 'base64', 'minimal', 1)");
    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled) VALUES (2, 1, '停用的', 'token-off', 'base64', 0)");

    const app = express();
    app.use(route.proxySubscriptionRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const get = (pathname, headers = {}) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port, path: pathname, method: "GET", headers },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
        },
      );
      request.on("error", reject);
      request.end();
    });

    // 默认格式：base64，解码后每行一个节点。
    const base64 = await get("/api/sub/token-live");
    assert.equal(base64.status, 200);
    const links = proxyNode.decodeBase64Utf8(base64.body).split("\n").filter(Boolean);
    assert.equal(links.length, 2, "隐藏和未绑定的转发不该进订阅，实际: " + links.join(" | "));
    assert.ok(links[0].includes("@1.2.3.4:20001"), links[0]);
    assert.ok(links[1].includes("@5.6.7.8:20002"), links[1]);
    // 凭据来自模板而不是转发规则。
    assert.ok(links[0].includes("abc-uuid"), links[0]);
    assert.ok(links[0].includes("sni=hkt.example.com"), links[0]);

    // 流量信息头，客户端据此显示已用流量与到期。
    assert.equal(base64.headers["subscription-userinfo"], "upload=0; download=12345; total=1000000");
    assert.equal(base64.headers["cache-control"], "no-store");

    // UA 识别：Clash 拿到 YAML，sing-box 拿到 JSON，Loon 拿到节点行。
    const clash = await get("/api/sub/token-live", { "user-agent": "clash-verge/1.5.0" });
    assert.ok(clash.body.startsWith("proxies:"), clash.body.slice(0, 60));
    assert.ok(clash.headers["content-type"].includes("yaml"));
    // 两台中转指向同一落地节点，应额外生成自动选路组，且 MATCH 指向主选择器。
    assert.ok(clash.body.includes("name: \"HKT 自动选路\""), clash.body);
    assert.ok(clash.body.includes("type: url-test"), clash.body);
    assert.ok(clash.body.includes("MATCH,NEX"), clash.body);
    // 不带 rules 参数是节点订阅：只有节点和选路组，没有分流规则。
    assert.ok(!clash.body.includes("rule-providers:"), clash.body);
    assert.ok(!clash.body.includes("RULE-SET,"), clash.body);

    // 同一个令牌带上 rules=1 就是规则订阅，用令牌上配的预设。
    const clashRules = await get("/api/sub/token-live?format=clash&rules=1");
    assert.ok(clashRules.body.includes("rule-providers:"), clashRules.body);
    assert.ok(clashRules.body.includes("RULE-SET,ads,REJECT"), clashRules.body);
    assert.ok(clashRules.body.includes("🎯 国内直连"), clashRules.body);
    // 局域网走原生网段，不引用外部规则集。
    assert.ok(clashRules.body.includes("IP-CIDR,192.168.0.0/16"), clashRules.body);
    // 节点部分两者一致，只多了规则。
    assert.ok(clashRules.body.includes("HKT 自动选路"), clashRules.body);

    // rules 可以直接指定档位，覆盖令牌上的配置。
    const comprehensive = await get("/api/sub/token-live?format=clash&rules=comprehensive");
    assert.ok(comprehensive.body.includes("🎬 TikTok"), comprehensive.body.slice(0, 2000));
    assert.ok(!clashRules.body.includes("🎬 TikTok"), "精简预设不该包含 TikTok");

    // Surge / Loon / QX / Shadowrocket 带 rules=1 拿到完整配置，节点订阅不变。
    const surgeProfile = await get("/api/sub/token-live?format=surge&rules=1", { host: "panel.example.com" });
    assert.ok(surgeProfile.body.startsWith("#!MANAGED-CONFIG http://panel.example.com/api/sub/token-live?format=surge&rules=1 "), surgeProfile.body.slice(0, 200));
    // 这里的节点是 VLESS，Surge 不支持，整份被跳过；分组和规则用 Loon 验。
    const loonProfile = await get("/api/sub/token-live?format=loon&rules=1");
    assert.ok(loonProfile.body.includes("HKT 自动选路 = url-test,"), loonProfile.body);
    assert.ok(loonProfile.body.includes("FINAL,NEX"), loonProfile.body);
    const loonNodes = await get("/api/sub/token-live?format=loon");
    assert.ok(!loonNodes.body.includes("[Proxy Group]"), loonNodes.body);

    const rocketNodes = await get("/api/sub/token-live", { "user-agent": "Shadowrocket/2070 CFNetwork/1568 Darwin/24.1.0" });
    assert.ok(proxyNode.decodeBase64Utf8(rocketNodes.body).split("\n").filter(Boolean).length > 0);
    const rocketProfile = await get("/api/sub/token-live?rules=1", { "user-agent": "Shadowrocket/2070 CFNetwork/1568 Darwin/24.1.0" });
    assert.ok(rocketProfile.body.includes("[Proxy Group]"), rocketProfile.body);
    assert.ok(rocketProfile.body.includes("HKT 自动选路 = url-test"), rocketProfile.body);

    // rules=0 明确表示节点订阅。
    const off = await get("/api/sub/token-live?format=clash&rules=0");
    assert.ok(!off.body.includes("rule-providers:"), off.body);

    const singbox = await get("/api/sub/token-live", { "user-agent": "sing-box 1.9.0" });
    const singboxOutbounds = JSON.parse(singbox.body).outbounds;
    assert.equal(singboxOutbounds[0].type, "selector");
    assert.equal(singboxOutbounds[1].type, "urltest");
    assert.equal(singboxOutbounds[1].tag, "HKT 自动选路");
    // sing-box 没有「只给节点」的格式，节点订阅同样是完整 profile：
    // 要有 final 指向选择器，但不该有分流规则。
    const singboxNodesRoute = JSON.parse(singbox.body).route;
    assert.equal(singboxNodesRoute.final, "NEX");
    assert.equal(singboxNodesRoute.rules, undefined);
    assert.equal(singboxNodesRoute.rule_set, undefined);

    const singboxRules = await get("/api/sub/token-live?format=singbox&rules=1");
    const singboxRoute = JSON.parse(singboxRules.body).route;
    assert.equal(singboxRoute.final, "NEX");
    // sing-box 用内置的 ip_is_private，不下载私有网段规则集。
    assert.ok(singboxRoute.rules.some((rule) => rule.ip_is_private === true), singboxRules.body.slice(0, 400));
    assert.ok(singboxRoute.rule_set.every((ref) => ref.url.endsWith(".srs")), singboxRules.body.slice(0, 400));

    const loon = await get("/api/sub/token-live", { "user-agent": "Loon/700" });
    assert.ok(loon.body.includes("= VLESS,1.2.3.4,20001,"), loon.body.slice(0, 120));

    // Surge 不支持 VLESS：本例两个节点都是 VLESS，应只剩说明行而不是空文件。
    const surge = await get("/api/sub/token-live", { "user-agent": "Surge iOS/3000" });
    assert.ok(surge.body.startsWith("# 已跳过节点"), surge.body.slice(0, 120));
    assert.ok(surge.body.includes("Surge / Surfboard 不支持 VLESS"), surge.body.slice(0, 200));
    // Surfboard 用 Surge 的格式，走同一个渲染器。
    const surfboard = await get("/api/sub/token-live", { "user-agent": "Surfboard/1.0" });
    assert.equal(surfboard.body, surge.body);

    // QX 支持 VLESS，UA 里的域名部分是 URL 编码的 "Quantumult%20X"。
    const qx = await get("/api/sub/token-live", { "user-agent": "Quantumult%20X/1.0.30" });
    assert.ok(qx.body.startsWith("vless=1.2.3.4:20001"), qx.body.slice(0, 120));
    assert.ok(qx.body.includes("tag=广州1 → HKT"), qx.body.slice(0, 200));

    // 显式 format 参数优先于 UA。
    const forced = await get("/api/sub/token-live?format=clash", { "user-agent": "Loon/700" });
    assert.ok(forced.body.startsWith("proxies:"));

    // 无效令牌与被停用的令牌都返回 404，不泄露令牌是否存在。
    assert.equal((await get("/api/sub/does-not-exist")).status, 404);
    assert.equal((await get("/api/sub/token-off")).status, 404);

    // 访问会被记录下来，便于用户发现订阅地址被别人用了。
    await new Promise((resolve) => setTimeout(resolve, 150));
    const rows = await runtime.queryRaw("SELECT accessCount, lastAccessUserAgent FROM proxy_sub_tokens WHERE id = 1");
    assert.ok(Number(rows[0].accessCount) >= 12, "访问次数未累加: " + rows[0].accessCount);

    await new Promise((resolve) => server.close(resolve));
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

test("订阅只包含令牌所属用户的节点", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-sub-scope-"));
  const databasePath = path.join(directory, "sub-scope.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const route = await import(url("server/proxySubscriptionRoute.ts"));
    const proxyNode = await import(url("shared/proxyNode.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'alice', 'hash', 'user', 1)");
    await exec("INSERT INTO users (id, username, password, role) VALUES (2, 'bob', 'hash', 'user')");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, '共享入口', '1.2.3.4', '1.2.3.4', 1)");

    await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, tls, isEnabled) VALUES (1, 1, 'Alice 落地', 'vless', 'a.example.com', 443, 'alice-uuid', 'tcp', 1, 1)");
    await exec("INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, tls, isEnabled) VALUES (2, 2, 'Bob 落地', 'vless', 'b.example.com', 443, 'bob-uuid', 'tcp', 1, 1)");

    const insertRule = (id, userId, port, nodeId) => exec(
      "INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete, proxyNodeId, proxyNodeVisible) VALUES (?, 1, 'rule', 'realm', 'tcp', ?, 'x.example.com', 443, ?, 1, 1, 0, ?, 1)",
      [id, port, userId, nodeId],
    );
    await insertRule(1, 1, 20001, 1);
    await insertRule(2, 2, 20002, 2);

    await exec("INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled) VALUES (1, 1, 'alice', 'alice-token', 'base64', 1)");

    const app = express();
    app.use(route.proxySubscriptionRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const body = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/sub/alice-token" }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve(text));
      }).on("error", reject);
    });

    const links = proxyNode.decodeBase64Utf8(body).split("\n").filter(Boolean);
    assert.equal(links.length, 1, "越权拿到了别人的节点: " + links.join(" | "));
    assert.ok(links[0].includes("alice-uuid"), links[0]);
    assert.ok(!links[0].includes("bob-uuid"), links[0]);

    await new Promise((resolve) => server.close(resolve));
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


test("没有客户端订阅权限时订阅地址一律 404", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-proxy-sub-perm-"));
  const databasePath = path.join(directory, "sub-perm.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const route = await import(url("server/proxySubscriptionRoute.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    // 两个用户配置完全一样，只差订阅权限。
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'yes', 'hash', 'user', 1)");
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (2, 'no', 'hash', 'user', 0)");
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (3, 'boss', 'hash', 'admin', 0)");
    await exec("INSERT INTO hosts (id, name, ip, ipv4, userId) VALUES (1, '入口', '1.2.3.4', '1.2.3.4', 1)");

    for (const userId of [1, 2, 3]) {
      await exec(
        "INSERT INTO proxy_nodes (id, userId, name, protocol, address, port, uuid, transport, tls, isEnabled) VALUES (?, ?, '落地', 'vless', 'h.example.com', 443, 'uuid-' || ?, 'tcp', 1, 1)",
        [userId, userId, userId],
      );
      await exec(
        "INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning, pendingDelete, proxyNodeId, proxyNodeVisible) VALUES (?, 1, 'r', 'realm', 'tcp', ?, 'h.example.com', 443, ?, 1, 1, 0, ?, 1)",
        [userId, 20000 + userId, userId, userId],
      );
      await exec(
        "INSERT INTO proxy_sub_tokens (id, userId, name, token, defaultFormat, isEnabled) VALUES (?, ?, 'dev', ?, 'base64', 1)",
        [userId, userId, "token-" + userId],
      );
    }

    const app = express();
    app.use(route.proxySubscriptionRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const status = (token) => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/sub/" + token }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }).on("error", reject);
    });

    assert.equal(await status("token-1"), 200, "有权限的用户应能拉到订阅");
    // 与令牌无效同样 404，不泄露「这个令牌存在但没权限」。
    assert.equal(await status("token-2"), 404, "无权限的用户不该拉到订阅");
    assert.equal(await status("token-3"), 200, "管理员不受该权限限制");

    // 收回权限后立刻失效，不需要吊销令牌。
    await exec("UPDATE users SET allowProxySubscription = 0 WHERE id = 1");
    assert.equal(await status("token-1"), 404, "收回权限后订阅应立即失效");

    /**
     * 到期与停用也要立刻失效 —— 和落地机那边同一把尺子。
     *
     * 原来这里只看订阅权限：到期的租户照样拉得到一份列着全部节点的订阅，页头还
     * 老老实实写着他已经过期。落地机那边早把他的凭据拿掉了，于是他看到的是一排
     * 连不上的节点，界面上还看不出为什么 ——「到期就停服」只兑现了一半。
     */
    await exec("UPDATE users SET allowProxySubscription = 1 WHERE id = 1");
    assert.equal(await status("token-1"), 200, "恢复权限后应当又能拉到");

    await exec("UPDATE users SET expiresAt = ? WHERE id = 1", [Math.floor(Date.now() / 1000) - 3600]);
    assert.equal(await status("token-1"), 404, "账号到期后订阅应立即失效");
    await exec("UPDATE users SET expiresAt = NULL WHERE id = 1");
    assert.equal(await status("token-1"), 200, "续期之后要自己回来");

    await exec("UPDATE users SET accountEnabled = 0 WHERE id = 1");
    assert.equal(await status("token-1"), 404, "账号被停用后订阅应立即失效");
    await exec("UPDATE users SET accountEnabled = 1 WHERE id = 1");

    // 管理员同样受停用影响（资格判定里只对「订阅权限」这一条放行）。
    await exec("UPDATE users SET accountEnabled = 0 WHERE id = 3");
    assert.equal(await status("token-3"), 404, "被停用的管理员也不该再拉到订阅");

    await new Promise((resolve) => server.close(resolve));
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
