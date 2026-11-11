import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 「这条转发别跑了」下发的清理命令，钉成基线。
 *
 * apply 那一路已经有基线了（forwardTypeCommandBaseline），这一组补的是**另外半边**：
 * 停用和删除。面板里有几条路径都会走到这里 —— 用户手动停用、管理员在设置里关掉
 * 整个协议、规则被删除 —— 每条路径都为六种转发方式各手抄了一份清理命令列表。
 *
 * 十几份手抄的列表，谁也不盯着谁。已经因此漏过一次：nginx 手动停用时不清故障转移
 * 的守护后端，而关协议和删除那两条都清（见 disabledRuleGuardCleanup）。
 *
 * 所以这一组在把这几条路径合并成一处之前先铺上：合并之后每一种转发方式下发的
 * 清理命令必须一条不差、一条不多、顺序不变 —— 这些命令是要在真机上删 iptables
 * 规则、停 systemd 单元、删配置文件的，靠读代码判断「应该一样」不算数。
 *
 * 如果你是**故意**改了清理逻辑，这个测试会红。更新基线，并在提交信息里说清改了
 * 什么、为什么。不要不看就把哈希覆盖过去 —— 那等于把安全网拆了。
 */

type Fingerprint = { commands: number; hash: string; svcName: string };

/**
 * 两条停用路径当下的真实产出。
 *
 * `disabled` = 用户手动停用（协议还开着）；`protocolOff` = 管理员把整个协议关掉。
 * 两边一样才是对的 —— 但这里分开记，因为「一样」本身就是要被钉住的事实，
 * 合并成一张表就看不出哪天又岔开了。
 */
const BASELINE: Record<string, Record<string, Fingerprint>> = {
  disabled: {
    "iptables:tcp": { commands: 36, hash: "e7a3d8fb26550fb4", svcName: "" },
    "iptables:udp": { commands: 36, hash: "60fbd11c48a54eb1", svcName: "" },
    "iptables:both": { commands: 42, hash: "c101fa22c1397994", svcName: "" },
    "nftables:tcp": { commands: 45, hash: "b0f81f8de9290970", svcName: "" },
    "nftables:udp": { commands: 45, hash: "6c223952e9a87303", svcName: "" },
    "nftables:both": { commands: 57, hash: "02591859860bcf1c", svcName: "" },
    "realm:tcp": { commands: 49, hash: "89b7d5a4653792fb", svcName: "forwardx-realm-tcp-20007" },
    "realm:udp": { commands: 46, hash: "02a964e61218c6e5", svcName: "forwardx-realm-udp-20008" },
    "realm:both": { commands: 55, hash: "39c519107d0c6d83", svcName: "forwardx-realm-both-20009" },
    "socat:tcp": { commands: 46, hash: "67dff8c1da5dcbea", svcName: "" },
    "socat:udp": { commands: 45, hash: "c0c51c2b7530241c", svcName: "" },
    "socat:both": { commands: 52, hash: "f75a27d2d07a58a4", svcName: "" },
    "nginx:tcp": { commands: 42, hash: "506b1e6c91ef625a", svcName: "" },
    "nginx:udp": { commands: 42, hash: "3ffda69482c96d8a", svcName: "" },
    "nginx:both": { commands: 48, hash: "0e294ef2c1bc24a7", svcName: "" },
    "gost:tcp": { commands: 45, hash: "c7296530f6a135dc", svcName: "" },
    "gost:udp": { commands: 45, hash: "9c9a6b221361bfbb", svcName: "" },
    "gost:both": { commands: 56, hash: "52b7a34bf269e240", svcName: "" },
  },
  protocolOff: {
    "iptables:tcp": { commands: 36, hash: "e7a3d8fb26550fb4", svcName: "" },
    "iptables:udp": { commands: 36, hash: "60fbd11c48a54eb1", svcName: "" },
    "iptables:both": { commands: 42, hash: "c101fa22c1397994", svcName: "" },
    "nftables:tcp": { commands: 45, hash: "b0f81f8de9290970", svcName: "" },
    "nftables:udp": { commands: 45, hash: "6c223952e9a87303", svcName: "" },
    "nftables:both": { commands: 57, hash: "02591859860bcf1c", svcName: "" },
    "realm:tcp": { commands: 49, hash: "89b7d5a4653792fb", svcName: "forwardx-realm-tcp-20007" },
    "realm:udp": { commands: 46, hash: "02a964e61218c6e5", svcName: "forwardx-realm-udp-20008" },
    "realm:both": { commands: 55, hash: "39c519107d0c6d83", svcName: "forwardx-realm-both-20009" },
    "socat:tcp": { commands: 46, hash: "67dff8c1da5dcbea", svcName: "" },
    "socat:udp": { commands: 45, hash: "c0c51c2b7530241c", svcName: "" },
    "socat:both": { commands: 52, hash: "f75a27d2d07a58a4", svcName: "" },
    "nginx:tcp": { commands: 42, hash: "506b1e6c91ef625a", svcName: "" },
    "nginx:udp": { commands: 42, hash: "3ffda69482c96d8a", svcName: "" },
    "nginx:both": { commands: 48, hash: "0e294ef2c1bc24a7", svcName: "" },
    "gost:tcp": { commands: 45, hash: "c7296530f6a135dc", svcName: "" },
    "gost:udp": { commands: 45, hash: "9c9a6b221361bfbb", svcName: "" },
    "gost:both": { commands: 56, hash: "52b7a34bf269e240", svcName: "" },
  },
};

const TYPES = ["iptables", "nftables", "realm", "socat", "nginx", "gost"] as const;
const PROTOCOLS = ["tcp", "udp", "both"] as const;

function collect(protocolsEnabled: boolean): Record<string, Fingerprint> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-remove-baseline-"));
  const databasePath = path.join(directory, "remove.db");
  const script = String.raw`
    import crypto from "node:crypto";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const SEP = String.fromCharCode(1);
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    const TYPES = ["iptables", "nftables", "realm", "socat", "nginx", "gost"];
    const PROTOCOLS = ["tcp", "udp", "both"];
    const enabled = process.env.PROTOCOLS_ENABLED === "1";

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    await exec(
      'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline") VALUES (1, ?, ?, ?, ?, ?, 1, 1)',
      ["入口机", "203.0.113.1", "203.0.113.1", "slave", "tok1"],
    );
    await exec(
      "INSERT INTO system_settings (key, value) VALUES (?, ?)",
      ["forwardProtocols", JSON.stringify(Object.fromEntries(TYPES.map((t) => [t, enabled])))],
    );

    /** 六种类型乘三种协议，端口固定，好让哈希稳定。都已停用，但 Agent 还报着在跑。 */
    const keyById = {};
    const localRules = [];
    let id = 0;
    for (const forwardType of TYPES) {
      for (const protocol of PROTOCOLS) {
        id += 1;
        keyById[id] = forwardType + ":" + protocol;
        await exec(
          'INSERT INTO forward_rules (id, "hostId", name, "forwardType", protocol, "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning")'
            + ' VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1, 0, 1)',
          [id, forwardType + "-" + protocol, forwardType, protocol, 20000 + id, "198.51.100.7", 443],
        );
        localRules.push({ port: 20000 + id, protocol, ruleId: id, forwardType });
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

    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok1" },
      // 不报 localState 的话面板认为「Agent 还没说话」，会直接把规则标成停了而不下发清理。
      body: JSON.stringify({
        agentVersion: "2.3.362", uptime: 1000, cpuUsage: 1, memoryUsage: 1, diskUsage: 1,
        localState: { rules: localRules, services: [], tunnels: [] },
      }),
    });
    const body = await response.json();
    server.close();
    if (response.status !== 200) throw new Error("心跳没通: " + response.status);

    const out = {};
    for (const action of (body.desiredState && body.desiredState.actions) || []) {
      const ruleId = Number(action.ruleId || 0);
      if (ruleId <= 0 || !keyById[ruleId]) continue;
      const commands = (action.commands || []).map(String);
      out[keyById[ruleId]] = {
        commands: commands.length,
        hash: crypto.createHash("sha256").update(commands.join(SEP)).digest("hex").slice(0, 16),
        svcName: String(action.svcName == null ? "" : action.svcName),
      };
    }
    console.log("REMOVAL " + JSON.stringify(out));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_TYPE: "sqlite",
      FORWARDX_TEST_DB: databasePath,
      PROTOCOLS_ENABLED: protocolsEnabled ? "1" : "0",
    },
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("REMOVAL "));
  assert.ok(line, `没拿到基线输出：\n${result.stdout}`);
  return JSON.parse(line.slice("REMOVAL ".length)) as Record<string, Fingerprint>;
}

const actual = { disabled: collect(true), protocolOff: collect(false) };

if (process.env.FORWARDX_RECORD_REMOVAL_BASELINE === "1") {
  console.log("RECORD " + JSON.stringify(actual));
}

for (const pathName of ["disabled", "protocolOff"] as const) {
  test(`${pathName}：每种转发方式下发的清理命令保持基线`, () => {
    for (const forwardType of TYPES) {
      for (const protocol of PROTOCOLS) {
        const key = `${forwardType}:${protocol}`;
        const expected = BASELINE[pathName][key];
        const got = actual[pathName][key];
        if (!expected) {
          assert.ok(!got, `${key} 这一种原来不产出清理动作，现在产出了 —— 更新基线并说明为什么`);
          continue;
        }
        assert.ok(got, `${key} 这一种不再产出清理动作了 —— 停用之后机器上的东西没人收`);
        assert.equal(
          got.commands,
          expected.commands,
          `${pathName} 的 ${key} 清理命令条数从 ${expected.commands} 变成了 ${got.commands}`,
        );
        assert.equal(
          got.hash,
          expected.hash,
          `${pathName} 的 ${key} 清理命令内容或顺序变了（条数没变）；如果是故意改的，更新基线并在提交信息里说清楚`,
        );
        assert.equal(got.svcName, expected.svcName, `${pathName} 的 ${key} 服务名变了`);
      }
    }
  });
}

/**
 * 两条停用路径现在是**同一段代码**，所以一处都不该差。
 *
 * 这条断言原来写的是「差异只剩 realm 的命令顺序」—— 那时候这几条路径各自手抄
 * 了一份六种转发方式的清理列表，十几份列表谁也不盯着谁，已经因此漏过一次
 * （nginx 手动停用不清故障转移的守护后端，见 disabledRuleGuardCleanup）。
 *
 * 合并之后两条路径都走 buildDisabledRuleRemovalAction，结构上已经不可能岔开。
 * 这条留着不是防「又抄漏了」，而是防**有人再开一条新的手抄路径** —— 那是唯一
 * 能让它重新变红的改法。
 */
test("两条停用路径下发的清理命令完全一致", () => {
  const mismatched = Object.keys(actual.disabled)
    .filter((key) => JSON.stringify(actual.disabled[key]) !== JSON.stringify(actual.protocolOff[key]))
    .sort();
  assert.deepEqual(
    mismatched,
    [],
    "手动停用和关协议这两条路径又岔开了 —— 它们本该是同一段代码，岔开说明有人在某一条上单独动了手",
  );
});
