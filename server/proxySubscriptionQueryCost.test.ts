import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 组装一份订阅要打多少次库。
 *
 * 订阅地址是**没有登录态、按客户端节奏来**的一条路：默认十二小时刷一次不觉得，可
 * 客户端的刷新间隔是用户自己填的，一个商家几百个租户里总有人填几分钟。这条路上每
 * 多跑一条查询，就是几百倍地多跑。
 *
 * 之前这里白跑了两处：
 *
 * - 节点模板查了两遍 —— plan 里查一次，外面渲染文档时又查一次，而它们本来就是
 *   一次能查完的（每遍三条：自己的、别人分享的、独立凭据的）。
 * - 主机整表读 —— `select * from hosts` 不带条件，而实际用到的只有这些转发的入口机
 *   和这些自建节点所在的机器。
 *
 * 所以这一组不测「快不快」（那会变成一条看机器脸色的脆测试），只测**打了几次库、
 * 有没有不带条件的整表读**。
 */
test("SQLite 一次订阅组装不重复查模板，也不整表读主机", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sub-cost-"));
  const databasePath = path.join(directory, "sub-cost.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    // 必须在建库之前挂钩子：所有语句（drizzle 的和裸 SQL 的）都从 prepare 过。
    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    const statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, p = []) => runtime.executeRaw(sql, p);

    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1,'t','h','user',1)");
    for (let i = 1; i <= 6; i++) {
      await exec("INSERT INTO hosts (id,name,ip,ipv4,agentToken,userId) VALUES (?,?,?,?,?,1)",
        [i, "机器" + i, "10.0.0." + i, "10.0.0." + i, "tok" + i]);
    }
    for (let i = 1; i <= 3; i++) {
      await exec("INSERT INTO proxy_nodes (id,userId,name,protocol,address,port,uuid,tls,isEnabled,includeDirect) VALUES (?,1,?,'vless',?,443,'u',1,1,1)",
        [i, "节点" + i, "198.51.100." + i]);
    }
    // 只用到 1、2 两台机器：另外四台不该被读进来。
    for (let i = 1; i <= 2; i++) {
      await exec("INSERT INTO forward_rules (id,hostId,name,forwardType,protocol,sourcePort,targetIp,targetPort,userId,isEnabled,proxyNodeId,proxyNodeVisible) VALUES (?,?,?,'direct','tcp',?,?,443,1,1,?,1)",
        [i, i, "转发" + i, 20000 + i, "198.51.100." + i, i]);
    }

    // 预热一次（首次会有建表/兼容性检查之类的杂音），再开始计数。
    await subs.getProxySubscriptionDocumentForUser(1);
    statements.length = 0;
    recording = true;
    await subs.getProxySubscriptionDocumentForUser(1);
    recording = false;

    const touching = (table) => statements.filter((sql) => new RegExp('from\\s+"?' + table + '"?', "i").test(sql));

    /*
      查模板这一路一共三条：自己的（proxy_nodes）、别人分享的（proxy_node_shares）、
      独立凭据（proxy_inbound_users）。查两遍就会各变成两条 —— 所以按「各一条」订，
      而不是订一个宽松的上限（订宽了等于没订，我第一版就吃过这个亏）。
    */
    for (const table of ["proxy_nodes", "proxy_node_shares"]) {
      const reads = touching(table);
      assert.equal(
        reads.length,
        1,
        table + " 被查了 " + reads.length + " 次，模板那一路多半又查了两遍：\n" + reads.join("\n"),
      );
    }
    // 独立凭据只查主人自己节点挂着的那几条；这里三个节点都不是从凭据派生的，一条都不该查。
    assert.equal(touching("proxy_inbound_users").length, 0, "没有凭据派生的节点，不该去扫分享凭据");

    const hostReads = touching("hosts");
    assert.equal(hostReads.length, 1, "主机只该查一次，实际 " + hostReads.length + " 条");
    assert.match(
      hostReads[0],
      /where/i,
      "主机必须带条件查 —— 不带条件就是每来一次订阅就把整张 hosts 表读一遍：\n" + hostReads[0],
    );

    // 总量也拦一道：这条路上任何新增的查询都该是有意识加的。
    /*
      总量也拦一道。真要新增查询就把这个数改大 —— 但先想清楚：这条路没有登录态、
      按客户端自己填的刷新间隔跑，多一条就是几百倍地多一条。
    */
    // 5 → 7：「自动隐藏不通的节点」要读一次开关、一次（所有转发合一条的）探测记录。
    // 7 → 5：开关改从设置缓存里取（不再单独点一条），实际就是 5 条，按实际订。
    assert.ok(
      statements.length <= 5,
      "一次订阅组装打库次数超了（" + statements.length + " 条）：\n" + statements.join("\n"),
    );

    console.log("OK statements=" + statements.length);
    Database.prototype.prepare = originalPrepare;
    await runtime.closeDatabase();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

/**
 * 面板里「订阅内容」那一屏也走同一份组装，不许把整份订阅算两遍。
 *
 * 这一屏要两样东西：算出来的 plan（谁进了、谁没进、为什么），和渲染出来的 document
 * （策略组长什么样）。原来是分两次去要的 —— 于是整份订阅从头组装了两遍，打库次数
 * 正好翻倍。
 *
 * 慢一倍还是次要的。真正的问题是那两次是**两次独立读库**：中间只要有人删掉一条转发，
 * 这一屏就会自相矛盾 —— 策略组里列着一个节点，底下的节点清单里却没有它。而这一屏
 * 存在的全部意义就是回答「我的订阅里到底有什么」。
 */
test("SQLite 预览订阅内容不把整份订阅组装两遍", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sub-preview-cost-"));
  const databasePath = path.join(directory, "sub-preview-cost.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    const statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, p = []) => runtime.executeRaw(sql, p);

    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1,'t','h','user',1)");
    await exec("INSERT INTO hosts (id,name,ip,ipv4,agentToken,userId) VALUES (1,'机器','10.0.0.1','10.0.0.1','tok',1)");
    await exec("INSERT INTO proxy_nodes (id,userId,name,protocol,address,port,uuid,tls,isEnabled,includeDirect) VALUES (1,1,'节点','vless','198.51.100.1',443,'u',1,1,1)");
    await exec("INSERT INTO forward_rules (id,hostId,name,forwardType,protocol,sourcePort,targetIp,targetPort,userId,isEnabled,proxyNodeId,proxyNodeVisible) VALUES (1,1,'转发','direct','tcp',20001,'198.51.100.1',443,1,1,1,1)");

    const measure = async (run) => {
      await run();                 // 预热，避开首次的建表/兼容性杂音
      statements.length = 0;
      recording = true;
      const value = await run();
      recording = false;
      return { value, count: statements.length, sql: statements.slice() };
    };

    const preview = await measure(() => subs.getProxySubscriptionPreviewForUser(1));

    /*
      按绝对条数订，不拿「渲染文档要几条」当基准 —— 渲染那条路如今就是走预览实现的，
      拿它作基准，两边只会一起变，等于没订。
    */
    for (const table of ["proxy_nodes", "proxy_node_shares", "proxy_inbound_users", "hosts", "forward_rules"]) {
      const reads = preview.sql.filter((sql) => new RegExp('from\\s+"?' + table + '"?', "i").test(sql));
      assert.ok(
        reads.length <= 1,
        table + " 在一次预览里被查了 " + reads.length + " 次 —— plan 和 document 多半又各组装了一遍：\n" + reads.join("\n"),
      );
    }
    assert.ok(
      preview.count <= 5,
      "一次预览打库 " + preview.count + " 条（不该超过一次订阅组装的 5 条）：\n" + preview.sql.join("\n"),
    );

    // 两样东西确实都拿到了，而且来自同一次组装。
    assert.ok(Array.isArray(preview.value.plan.entries), "预览要带上 plan");
    assert.ok(Array.isArray(preview.value.document.nodes), "预览要带上 document");
    const nodeNames = new Set(preview.value.document.nodes.map((node) => node.name));
    for (const group of preview.value.document.groups) {
      for (const member of group.members) {
        if (member === "DIRECT" || member === "REJECT" || nodeNames.has(member)) continue;
        // 策略组里也可以引用别的策略组
        assert.ok(
          preview.value.document.groups.some((other) => other.name === member),
          "策略组「" + group.name + "」里的 " + member + " 在节点清单里找不到 —— 这一屏自相矛盾了",
        );
      }
    }

    console.log("OK preview=" + preview.count);
    Database.prototype.prepare = originalPrepare;
    await runtime.closeDatabase();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

/**
 * 订阅路由那一路：同一个用户的第二条令牌、换一种格式来拉，不该把这个用户的转发、模板、主机再查一遍。
 *
 * 正文缓存按「令牌 × 格式 × 客户端 × 选项……」分键，一个人手机、电脑、路由器各拉各的，每一种组合
 * 第一次来都要把这个用户的东西从头查一遍（8～10 条），而这些只跟用户有关。所以正文缓存底下再垫一层
 * 按用户的组装上下文（proxySubCache.ts 的 contextEntries）：第二次只剩透传来源之外的零星查询。
 * 这里把两次的条数都打出来，基线按「第二次远少于第一次、且不超过 1 条」订。
 */
test("SQLite 同一用户换令牌 / 格式再组装，命中按用户的上下文缓存", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sub-ctx-cost-"));
  const databasePath = path.join(directory, "sub-ctx-cost.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    const statements = [];
    Database.prototype.prepare = function (sql) {
      if (recording) statements.push(String(sql));
      return originalPrepare.call(this, sql);
    };

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const subs = await import(url("server/repositories/proxySubscriptionRepository.ts"));
    const cache = await import(url("server/proxySubCache.ts"));
    const { parseProxySubSettings } = await import(url("shared/proxySubSettings.ts"));
    const { PROXY_SUB_DEFAULT_TOKEN_OPTIONS, PROXY_SUB_EMPTY_SCOPE } = await import(url("shared/proxySubTokenScope.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, p = []) => runtime.executeRaw(sql, p);

    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1,'t','h','user',1)");
    for (let i = 1; i <= 3; i++) {
      await exec("INSERT INTO hosts (id,name,ip,ipv4,agentToken,userId) VALUES (?,?,?,?,?,1)", [i, "机器" + i, "10.0.0." + i, "10.0.0." + i, "tok" + i]);
      await exec("INSERT INTO proxy_nodes (id,userId,name,protocol,address,port,uuid,tls,isEnabled,includeDirect) VALUES (?,1,?,'vless',?,443,'u',1,1,1)", [i, "节点" + i, "198.51.100." + i]);
      await exec("INSERT INTO forward_rules (id,hostId,name,forwardType,protocol,sourcePort,targetIp,targetPort,userId,isEnabled,proxyNodeId,proxyNodeVisible) VALUES (?,?,?,'direct','tcp',?,?,443,1,1,?,1)",
        [i, i, "转发" + i, 20000 + i, "198.51.100." + i, i]);
    }

    const settings = parseProxySubSettings({});
    const build = (format) => subs.buildProxySubscriptionForToken(1, {
      rulePreset: "off",
      scope: PROXY_SUB_EMPTY_SCOPE,
      options: PROXY_SUB_DEFAULT_TOKEN_OPTIONS,
      settings,
      template: null,
      info: null,
      vars: { appName: "NEX", panelUrl: "", subUrl: "", username: "t", format },
    }, { ttlSec: 60, settingsFingerprint: "fp" });
    const measure = async (run) => {
      statements.length = 0;
      recording = true;
      const value = await run();
      recording = false;
      return { value, count: statements.length, sql: statements.slice() };
    };

    // 预热：首次会有建表 / 兼容性检查之类的杂音；然后清掉缓存，让第一次是实打实的组装。
    await build("clash");
    cache.clearProxySubCacheForTests();
    const first = await measure(() => build("clash"));
    const second = await measure(() => build("singbox"));
    console.log("statements first=" + first.count + " second=" + second.count);
    assert.ok(first.count >= 5, "第一次该是实打实的组装（" + first.count + " 条）：\n" + first.sql.join("\n"));
    assert.ok(second.count <= 1, "第二次该命中按用户的上下文缓存，实际 " + second.count + " 条：\n" + second.sql.join("\n"));
    assert.equal(second.value.document.nodes.length, first.value.document.nodes.length);

    // 这个用户的内容一变（任何一条按用户作废的路），下一次重新组装。
    cache.invalidateProxySubCacheForUser(1);
    const rebuilt = await measure(() => build("clash"));
    assert.ok(rebuilt.count >= 5, "作废后该重新组装，实际 " + rebuilt.count + " 条");
    // 全站作废同样。
    cache.invalidateProxySubCacheAll();
    const rebuiltAll = await measure(() => build("clash"));
    assert.ok(rebuiltAll.count >= 5, "全站作废后该重新组装，实际 " + rebuiltAll.count + " 条");
    // 不带缓存参数（界面预览）每次都现查。
    const preview = await measure(() => subs.getProxySubscriptionPreviewForUser(1));
    assert.ok(preview.count >= 5, "预览不走上下文缓存，实际 " + preview.count + " 条");

    console.log("OK");
    Database.prototype.prepare = originalPrepare;
    await runtime.closeDatabase();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const counts = /statements first=(\d+) second=(\d+)/.exec(result.stdout);
  assert.ok(counts, result.stdout);
  console.log(`上下文缓存：第一次 ${counts[1]} 条，第二次 ${counts[2]} 条`);
});
