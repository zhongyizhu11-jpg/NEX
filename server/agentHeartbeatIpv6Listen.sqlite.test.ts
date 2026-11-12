import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 内核关了 IPv6 的机器（Agent 2.2.256+ 心跳带 ipv6Listen=false）：
 *   - 主机表记下 ipv6ListenAvailable；之后的心跳没带这个字段（老 Agent / 别的路径）不动它；
 *   - realm / socat / nginx 的监听换成 IPv4（0.0.0.0 / TCP4-LISTEN / listen 0.0.0.0:端口）；
 *   - 同一个结论再报一遍不再写库、期望状态不变（不会来回重下发）；报回 true 就回到双栈。
 *   - 从没报过的主机：和以前一样的双栈配置。
 */
function runInDatabase(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ipv6-listen-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import http from "node:http";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const exec = (sql, params = []) => runtime.executeRaw(sql, params);
      const query = (sql, params = []) => runtime.queryRaw(sql, params);
      const now = Math.floor(Date.now() / 1000);

      await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion") VALUES (10, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
        ["入口", "203.0.113.10", "203.0.113.10", "slave", "tok10", now, "2.2.256"],
      );

      const ctx = {
        req: { headers: {} },
        res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      };
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      await settings.setSetting("forwardProtocols", JSON.stringify({ nginx: true }));
      const { rulesRouter } = await import(url("server/routers/rules.ts"));
      const rules = rulesRouter.createCaller(ctx);
      const realm = await rules.create({ hostId: 10, forwardType: "realm", protocol: "tcp", sourcePort: 30021, targetIp: "198.51.100.7", targetPort: 443 });
      const socat = await rules.create({ hostId: 10, forwardType: "socat", protocol: "both", sourcePort: 30022, targetIp: "198.51.100.7", targetPort: 443 });
      const nginx = await rules.create({ hostId: 10, forwardType: "nginx", protocol: "tcp", sourcePort: 30023, targetIp: "198.51.100.7", targetPort: 443 });
      assert.ok(realm.id && socat.id && nginx.id);

      const express = (await import("express")).default;
      const route = await import(url("server/agentHeartbeatRoute.ts"));
      const gate = await import(url("server/agentHeartbeatGate.ts"));
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const authorization = String(req.headers.authorization || "");
        req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        next();
      });
      route.registerAgentHeartbeatRoute(app);
      const server = http.createServer(app);
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });

      const decode = (b64) => Buffer.from(b64, "base64").toString("utf8");
      // 像真的 Agent 一样：收到期望状态就当执行完，下一次心跳报回它的版本和摘要。
      let applied = { revision: 0, hash: "" };
      const heartbeat = async (extra) => {
        gate.agentStableHeartbeatPlanCache.invalidate(10);
        const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer tok10" },
          body: JSON.stringify({
            agentVersion: "2.2.256", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1,
            // 测试里心跳一个接一个：绕过「刚对过账就合并」的闸门（那条早退不写主机表，下一次照样会写）。
            forceReconcile: true,
            agentLastReceivedRevision: applied.revision, agentLastAppliedRevision: applied.revision,
            agentLastReceivedHash: applied.hash, agentLastAppliedHash: applied.hash,
            ...extra,
          }),
        });
        const body = await response.json();
        if (response.status !== 200) throw new Error("心跳没通: " + response.status + " " + JSON.stringify(body));
        const desired = body.desiredState;
        if (!desired) return { sent: false };
        applied = { revision: Number(desired.configRevision) || 0, hash: String(desired.configHash || "") };
        const actions = desired.actions || [];
        const realmAction = actions.find((a) => a.ruleId === realm.id && a.forwardType === "realm");
        const socatAction = actions.find((a) => a.ruleId === socat.id && a.forwardType === "socat");
        let nginxConfig = "";
        for (const action of actions) {
          for (const config of action.managedConfigs || []) {
            if (String(config.path || "").endsWith("/nginx/nginx.conf")) nginxConfig = decode(config.contentBase64);
          }
        }
        const realmToml = realmAction
          ? decode(/printf '%s' '([^']+)' \| base64 -d/.exec(realmAction.preCommands.join("\n"))[1])
          : "";
        return { sent: true, hash: applied.hash, realmToml, socatUnits: socatAction ? [socatAction.unit, socatAction.unitExtra].join("\n") : "", nginxConfig };
      };
      const stored = async () => (await query('SELECT "ipv6ListenAvailable" AS v FROM hosts WHERE id = 10'))[0].v;

      try {
        ${body}
      } finally {
        server.close();
      }
      console.log("OK");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "ipv6.db") },
      timeout: 180_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OK/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("心跳 ipv6Listen：记到主机上，realm / socat / nginx 按它换监听；没报不动、重复报不来回", () => {
  runInDatabase(String.raw`
    // 从没报过：双栈，和以前一样。
    const legacy = await heartbeat({});
    assert.ok(legacy.sent);
    assert.equal(await stored(), null);
    assert.match(legacy.realmToml, /^listen = "\[::0\]:30021"$/m);
    assert.match(legacy.socatUnits, /TCP6-LISTEN:30022,fork,reuseaddr,ipv6only=0,nodelay /);
    assert.match(legacy.socatUnits, /UDP6-LISTEN:30022,fork,reuseaddr,ipv6only=0 /);
    assert.match(legacy.nginxConfig, /listen \[::\]:30023 so_keepalive=60s:15s:4 ipv6only=off;/);

    // 报 true：记下来，期望状态不变（Agent 已经执行过的那份，不重发 / 摘要一样）。
    const v6 = await heartbeat({ ipv6Listen: true });
    assert.equal(Number(await stored()), 1);
    assert.ok(!v6.sent || v6.hash === legacy.hash, "有 IPv6 的机器报了 true，配置不能变");

    // 报 false：马上重发一份只听 IPv4 的。
    const v4 = await heartbeat({ ipv6Listen: false });
    assert.equal(Number(await stored()), 0);
    assert.ok(v4.sent, "结论变了要马上重下发");
    assert.notEqual(v4.hash, legacy.hash);
    assert.match(v4.realmToml, /^listen = "0\.0\.0\.0:30021"$/m);
    assert.doesNotMatch(v4.socatUnits, /TCP6|UDP6|ipv6only/);
    assert.match(v4.socatUnits, /TCP4-LISTEN:30022,fork,reuseaddr,nodelay /);
    assert.match(v4.socatUnits, /UDP4-LISTEN:30022,fork,reuseaddr /);
    assert.match(v4.nginxConfig, /listen 0\.0\.0\.0:30023 so_keepalive=60s:15s:4;/);
    assert.match(v4.nginxConfig, /ipv6=off;/);

    // 再报一遍 false、或者没带这个字段：库里不动，期望状态不变（不会来回重下发）。
    for (const extra of [{ ipv6Listen: false }, {}, { ipv6Listen: false }]) {
      const beat = await heartbeat(extra);
      assert.equal(Number(await stored()), 0);
      assert.ok(!beat.sent || beat.hash === v4.hash, "同一个结论不该换配置: " + JSON.stringify(extra));
    }

    // 机器又有 IPv6 了：回到双栈，和最开始那份一模一样。
    const back = await heartbeat({ ipv6Listen: true });
    assert.ok(back.sent);
    assert.equal(back.hash, legacy.hash);
    assert.equal(back.realmToml, legacy.realmToml);
    assert.equal(back.socatUnits, legacy.socatUnits);
    assert.equal(back.nginxConfig, legacy.nginxConfig);
  `);
});
