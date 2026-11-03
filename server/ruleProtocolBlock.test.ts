import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 协议封禁只有主机那一层说了算。
 *
 * forward_rules 上有 blockHttp / blockSocks / blockTls 三列，看着像是「这条转发禁用
 * HTTP」。实际上下发给 Agent 的策略一律按 rule.hostId 去查**主机**
 * （agentHeartbeatProtocolGuard 的 protocolPolicyFromHost），规则自己的这三列全仓库没有任何
 * 地方读过 —— 写死 false，仅此而已。
 *
 * 两件事各自都会咬人：
 *
 *   · **接口收下却不生效**。create/update 的入参原来声明了这三个字段，而服务端在
 *     落库前把它们 delete 掉。调用方传 blockHttp: true 会拿到成功响应，什么也没发生。
 *     这和「开关存得下设置却永远不触发」是同一类东西 —— 比没有这个字段更糟，因为
 *     人会以为已经安排好了。
 *   · **哪天真把它接上**。老库里可能存着 true（来路已不可考）。一旦有人把下发那一路
 *     接到规则这一层，那些沉睡的 true 会毫无征兆地生效：一条正常跑了很久的转发突然
 *     开始拦 HTTP，而界面上没有任何开关能解释它。
 *
 * 所以这条钉两件事：入参里不许再出现这三个字段；规则的这三列不许有人读。真要做
 * 「单条规则的协议封禁」，得先把下发那一路接上，那时这条测试会红 —— 红得正是时候。
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

const PROTOCOL_BLOCK_FIELDS = ["blockHttp", "blockSocks", "blockTls"] as const;

test("规则的增改接口不许再收协议封禁字段", () => {
  const source = read("server/routers/rules.crud.ts");
  for (const field of PROTOCOL_BLOCK_FIELDS) {
    const declared = new RegExp(`${field}:\\s*z\\.`).test(source);
    assert.equal(
      declared,
      false,
      `rules.crud.ts 的入参里又声明了 ${field}。服务端并不会把它落库 —— `
        + "收下一个永远不生效的字段，等于告诉调用方「设好了」，而什么也没发生。",
    );
  }
});

test("规则那三列不许有人读，生效的只能是主机那一层", () => {
  /*
    只扫服务端和 Agent 下发相关的代码。命中的写法包括 rule.blockHttp、
    (rule as any).blockHttp、row.blockHttp 这类 —— 凡是从一条规则上取这个值的。
  */
  const files = [
    "server/routers/rules.crud.ts",
    "server/agentHeartbeatRoute.ts",
    // 从 agentHeartbeatRoute.ts 拆出去的下发相关模块，一样要扫。
    "server/agentHeartbeatProtocolGuard.ts",
    "server/agentHeartbeatAccessLimits.ts",
    "server/agentHeartbeatDispatch.ts",
    "server/agentHeartbeatDns.ts",
    "server/agentHeartbeatLocalState.ts",
    "server/agentHeartbeatNginx.ts",
    "server/agentHeartbeatRuntime.ts",
    "server/agentHeartbeatTunnel.ts",
    "server/agentStatusRoutes.ts",
    "server/repositories/forwardGroupRepository.ts",
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const source = read(file);
    source.split("\n").forEach((line, index) => {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
      for (const field of PROTOCOL_BLOCK_FIELDS) {
        // 从「规则/行」上取值的写法；主机那一层（host.blockHttp）是合法的，放过。
        if (new RegExp(`\\b(rule|row|r)\\b[^\\n]{0,20}\\.${field}\\b`).test(line)
          || new RegExp(`\\(\\s*rule\\s+as\\s+any\\s*\\)\\s*\\??\\.${field}\\b`).test(line)) {
          offenders.push(`${file}:${index + 1}  ${line.trim()}`);
        }
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "有人开始读规则自己的协议封禁列了：\n" + offenders.join("\n")
      + "\n这三列永远是 false，读它只会得到「没封禁」。真要做单条规则的封禁，"
      + "得先把下发那一路（agentHeartbeatProtocolGuard 的 protocolPolicyFromHost）接上。",
  );
});

test("下发给 Agent 的封禁策略，按主机查", () => {
  const source = read("server/agentHeartbeatRoute.ts");
  assert.match(
    source,
    /const ruleProtocolPolicy = \(rule: any\) => getHostProtocolPolicy\(/,
    "规则的封禁策略不再是按主机查了。改成别的来源之前，先确认规则那三列是不是已经"
      + "有人在维护 —— 它们至今为止一直是写死的 false。",
  );
});
