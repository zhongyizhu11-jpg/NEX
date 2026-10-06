import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 六种转发方式下发给 Agent 的东西，钉成基线。
 *
 * 这是**重构用的安全网**，不是功能测试。真正生成这些命令的是
 * agentHeartbeatRoute 里一条三百多行的 if/else 链，埋在一个五千多行的路由注册
 * 闭包里 —— 没法单独调用，所以只能从真实心跳接口整条打进去再看它吐出什么。
 *
 * 有了它，把那条链抽成按类型分派的策略表时，才能证明「一条命令都没丢、没多、
 * 没换顺序」。没有它，任何重构都是拿在跑的系统赌运气：这些命令是要在真机上
 * 写 iptables/nftables 规则和 systemd 单元的。
 *
 * 钉的是**指纹**不是全文：一种类型四十来条命令，全文贴进来没人读得下去，而且
 * 任何一处空格变动都会让它红成一片。指纹 = 每种类型每个命令字段的条数 + 内容
 * 哈希，既能发现少了一条，也能发现换了内容。
 *
 * 如果你是**故意**改了命令生成（加了参数、换了清理顺序），这个测试会红。那是
 * 它该做的事：更新下面的基线，并在提交信息里说清改了什么、为什么。不要不看
 * 就把哈希覆盖过去 —— 那等于把安全网拆了。
 */

type Fingerprint = {
  commands: number;
  preCommands: number;
  postCommands: number;
  managedConfigs: number;
  hash: string;
  /** systemd 单元名，直接记名字：换了名字等于换了一个服务，值得在 diff 里一眼看见。 */
  svcName: string;
  svcNameExtra: string;
  /** 单元文件正文的哈希。正文几十行，记全文没人读得下去。 */
  serviceHash: string;
};

/**
 * 记录当下的真实产出。
 *
 * nginx 不在里面：DEFAULT_FORWARD_PROTOCOL_SETTINGS 里 nginx 默认是 false，
 * 没开的协议不下发任何动作，这是对的（下面单独有一条断言盯着这个默认值）。
 */
const BASELINE: Record<string, Fingerprint> = {
  "gost:both": {
    commands: 35, preCommands: 0, postCommands: 0, managedConfigs: 0,
    hash: "e9583f7a9fe8a03a",
    svcName: "", svcNameExtra: "", serviceHash: "16682bd0d8bc0d18",
  },
  "gost:tcp": {
    commands: 29, preCommands: 0, postCommands: 0, managedConfigs: 0,
    hash: "b3e1f9c1979f096d",
    svcName: "", svcNameExtra: "", serviceHash: "16682bd0d8bc0d18",
  },
  "gost:udp": {
    commands: 29, preCommands: 0, postCommands: 0, managedConfigs: 0,
    hash: "718efeb70fc093b3",
    svcName: "", svcNameExtra: "", serviceHash: "16682bd0d8bc0d18",
  },
  "iptables:both": {
    commands: 54, preCommands: 0, postCommands: 0, managedConfigs: 0,
    hash: "e6e0a8bcd1bf70e6",
    svcName: "", svcNameExtra: "", serviceHash: "16682bd0d8bc0d18",
  },
  "iptables:tcp": {
    commands: 42, preCommands: 0, postCommands: 0, managedConfigs: 0,
    hash: "3384134ac3fdf445",
    svcName: "", svcNameExtra: "", serviceHash: "16682bd0d8bc0d18",
  },
  "iptables:udp": {
    commands: 42, preCommands: 0, postCommands: 0, managedConfigs: 0,
    hash: "985e31c8864f040f",
    svcName: "", svcNameExtra: "", serviceHash: "16682bd0d8bc0d18",
  },
  "nftables:both": {
    commands: 51, preCommands: 0, postCommands: 0, managedConfigs: 0,
    hash: "d1adbef99833c9a0",
    svcName: "", svcNameExtra: "", serviceHash: "16682bd0d8bc0d18",
  },
  "nftables:tcp": {
    commands: 41, preCommands: 0, postCommands: 0, managedConfigs: 0,
    hash: "4f472478707fe7b9",
    svcName: "", svcNameExtra: "", serviceHash: "16682bd0d8bc0d18",
  },
  "nftables:udp": {
    commands: 41, preCommands: 0, postCommands: 0, managedConfigs: 0,
    hash: "c3a869b49620d2f3",
    svcName: "", svcNameExtra: "", serviceHash: "16682bd0d8bc0d18",
  },
  "realm:both": {
    commands: 4, preCommands: 36, postCommands: 0, managedConfigs: 0,
    hash: "6d11e3df42b80db5",
    svcName: "forwardx-realm-both-20009", svcNameExtra: "", serviceHash: "5d838a006b0ac881",
  },
  "realm:tcp": {
    commands: 4, preCommands: 30, postCommands: 0, managedConfigs: 0,
    hash: "241a37193c57736f",
    svcName: "forwardx-realm-tcp-20007", svcNameExtra: "", serviceHash: "79a28070f6d97393",
  },
  "realm:udp": {
    commands: 4, preCommands: 27, postCommands: 0, managedConfigs: 0,
    hash: "75852e5e4c96e940",
    svcName: "forwardx-realm-udp-20008", svcNameExtra: "", serviceHash: "046d73a8a531bea5",
  },
  "socat:both": {
    commands: 0, preCommands: 32, postCommands: 4, managedConfigs: 0,
    hash: "12e1697475b9d5fb",
    svcName: "forwardx-socat-tcp-20012", svcNameExtra: "forwardx-socat-udp-20012", serviceHash: "578ca68128b707fd",
  },
  "socat:tcp": {
    commands: 0, preCommands: 27, postCommands: 4, managedConfigs: 0,
    hash: "f7206dd451e62023",
    svcName: "forwardx-socat-tcp-20010", svcNameExtra: "", serviceHash: "aed69a0848d05841",
  },
  "socat:udp": {
    commands: 0, preCommands: 26, postCommands: 4, managedConfigs: 0,
    hash: "6e2e7906d1e870f5",
    svcName: "forwardx-socat-udp-20011", svcNameExtra: "", serviceHash: "3140c5bbf792afcc",
  },
};

const COMMAND_FIELDS = ["commands", "preCommands", "postCommands", "managedConfigs"] as const;

test("六种转发方式下发的命令保持基线（重构安全网）", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-cmd-baseline-"));
  const databasePath = path.join(directory, "cmd-baseline.db");
  const script = String.raw`
    import crypto from "node:crypto";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline") VALUES (1, ?, ?, ?, ?, ?, 1, 1)',
      ["入口机", "203.0.113.1", "203.0.113.1", "slave", "tok1"],
    );

    /** 六种类型乘三种协议，端口固定，好让哈希稳定。 */
    const TYPES = ["iptables", "nftables", "realm", "socat", "nginx", "gost"];
    const PROTOCOLS = ["tcp", "udp", "both"];
    let id = 0;
    for (const forwardType of TYPES) {
      for (const protocol of PROTOCOLS) {
        id += 1;
        await exec(
          'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled")'
            + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, 1, forwardType + "-" + protocol, forwardType, protocol, 20000 + id, "198.51.100.7", 443, 1, 1],
        );
      }
    }

    const express = (await import("express")).default;
    const heartbeat = await import(url("server/agentHeartbeatRoute.ts"));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const authorization = String(req.headers.authorization || "");
      req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      next();
    });
    heartbeat.registerAgentHeartbeatRoute(app);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = "http://127.0.0.1:" + server.address().port;

    const response = await fetch(base + "/api/agent/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok1" },
      body: JSON.stringify({ agentVersion: "2.3.362", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1 }),
    });
    const body = await response.json();
    server.close();
    if (response.status !== 200) throw new Error("心跳没通: " + response.status);

    const actions = (body.desiredState && body.desiredState.actions) || [];
    const FIELDS = ["commands", "preCommands", "postCommands", "managedConfigs"];
    // 单元正文不是命令数组，走的是动作上的顶层字段 —— 单独算一份哈希。
    const SERVICE_FIELDS = ["unit", "unitExtra"];
    const UNIT = String.fromCharCode(1);
    const RECORD = String.fromCharCode(2);

    const fingerprint = (action) => {
      const counts = {};
      const parts = [];
      for (const field of FIELDS) {
        const list = Array.isArray(action[field]) ? action[field] : [];
        counts[field] = list.length;
        const text = list.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(UNIT);
        parts.push(field + ":" + text);
      }
      const hash = crypto.createHash("sha256").update(parts.join(RECORD)).digest("hex").slice(0, 16);
      const serviceParts = SERVICE_FIELDS.map((field) => field + ":" + String(action[field] == null ? "" : action[field]));
      const serviceHash = crypto.createHash("sha256").update(serviceParts.join(RECORD)).digest("hex").slice(0, 16);
      return {
        ...counts,
        hash,
        svcName: String(action.svcName == null ? "" : action.svcName),
        svcNameExtra: String(action.svcNameExtra == null ? "" : action.svcNameExtra),
        serviceHash,
      };
    };

    const out = {};
    for (const action of actions) {
      const forwardType = String(action.forwardType || "");
      // 只看转发规则的动作；运行时同步那几条（gost-runtime-sync 等）不在这一组的范围里。
      if (!TYPES.includes(forwardType)) continue;
      out[forwardType + ":" + String(action.protocol || "")] = fingerprint(action);
    }
    console.log("BASELINE " + JSON.stringify(out));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const line = result.stdout.split("\n").find((row) => row.startsWith("BASELINE "));
  assert.ok(line, `没拿到基线输出：\n${result.stdout}`);
  const actual = JSON.parse(line.slice("BASELINE ".length)) as Record<string, Fingerprint>;

  for (const [key, expected] of Object.entries(BASELINE)) {
    const got = actual[key];
    assert.ok(got, `${key} 这一种不再产出动作了 —— 一整类转发方式没了下发`);
    for (const field of COMMAND_FIELDS) {
      assert.equal(
        got[field],
        expected[field],
        `${key} 的 ${field} 条数从 ${expected[field]} 变成了 ${got[field]}；如果是故意改的，更新基线并在提交信息里说清楚`,
      );
    }
    assert.equal(
      got.hash,
      expected.hash,
      `${key} 的命令内容变了（条数没变）；如果是故意改的，更新基线并在提交信息里说清楚`,
    );
    /*
      单元文件正文和服务名走的是动作上的顶层字段，不在上面那四个命令数组里。
      漏掉它们的话，「把 systemd 单元的拼接搬个地方」这类改动可以一路绿着过去 ——
      而那正是 realm / socat 这两支重构时唯一动到的东西。
    */
    assert.equal(
      got.svcName,
      expected.svcName,
      `${key} 的服务名从 ${expected.svcName || "(无)"} 变成了 ${got.svcName || "(无)"}；换名字等于换了一个服务，旧的会留在真机上`,
    );
    assert.equal(
      got.svcNameExtra,
      expected.svcNameExtra,
      `${key} 的第二个服务名从 ${expected.svcNameExtra || "(无)"} 变成了 ${got.svcNameExtra || "(无)"}`,
    );
    assert.equal(
      got.serviceHash,
      expected.serviceHash,
      `${key} 的 systemd 单元正文变了；如果是故意改的，更新基线并在提交信息里说清楚`,
    );
  }

  // nginx 默认关闭，不该有动作。这一条防止哪天那个默认值被无声改掉。
  for (const protocol of ["tcp", "udp", "both"]) {
    assert.ok(
      !actual[`nginx:${protocol}`],
      "nginx 默认是关的（DEFAULT_FORWARD_PROTOCOL_SETTINGS.nginx = false），不该下发动作",
    );
  }
});
