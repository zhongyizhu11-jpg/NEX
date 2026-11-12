import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  RULE_RUNTIME_FAILURE_LABELS,
  RULE_RUNTIME_FAILURE_USER_TEXT,
  agentRuntimeFailureLogTail,
  classifyRuleRuntimeFailure,
  ruleRuntimeFailureReason,
} from "./ruleRuntimeFailureText";
import { IPV6_LISTEN_REPORT_AGENT_VERSION } from "../shared/hostIpv6Listen";
import { getRulePortWarnings, recordRuleRuntimeStatus, resetPortOccupancyForTests } from "./rulePortOccupancy";

const notReady = "managed runtime listener not ready after apply port=30021 protocol=tcp forwardType=realm";

test("门槛版本和 Agent 那头对得上", () => {
  assert.equal(IPV6_LISTEN_REPORT_AGENT_VERSION, "2.2.256");
  const goSource = fs.readFileSync(path.join(process.cwd(), "agent/runtime_failure_detail.go"), "utf8");
  for (const cause of ["ipv6-unavailable", "runtime-missing", "address-in-use", "permission-denied"]) {
    assert.match(goSource, new RegExp(`"${cause}"`), `Agent 要会报 cause=${cause}`);
  }
  assert.match(fs.readFileSync(path.join(process.cwd(), "agent/heartbeat.go"), "utf8"), /payload\["ipv6Listen"\]/);
  assert.match(fs.readFileSync(path.join(process.cwd(), "agent/main.go"), "utf8"), /payload\["ipv6Listen"\]/);
});

test("IPv6 不可用：realm 的 bind 失败、socat 的 socket() 失败都认得出来", () => {
  const realm = `${notReady}; cause=ipv6-unavailable; log: [tcp]failed to bind [::]:30021: Address family not supported by protocol (os error 97)`;
  const failure = classifyRuleRuntimeFailure(realm, 30021);
  assert.equal(failure?.kind, "runtime");
  assert.equal(failure?.label, RULE_RUNTIME_FAILURE_LABELS.listener);
  assert.equal(failure?.user, "监听没起来：IPv6 在这台机器上不可用");
  assert.equal(failure?.admin, "监听没起来：IPv6 在这台机器上不可用（日志：[tcp]failed to bind [::]:30021: Address family not supported by protocol (os error 97)）");
  // 没有 cause（比如日志认得但分类没认）也按日志认。
  assert.equal(classifyRuleRuntimeFailure(`${notReady}; log: socat[1] E socket(10, 1, 6): Address family not supported by protocol`, 1)?.user, RULE_RUNTIME_FAILURE_USER_TEXT.ipv6);
});

test("运行时没装：带上二进制路径给管理员，用户只看到结论", () => {
  const failure = classifyRuleRuntimeFailure(`${notReady}; cause=runtime-missing binary=/usr/local/bin/realm`, 30021);
  assert.equal(failure?.label, "运行时没安装");
  assert.equal(failure?.admin, "运行时没安装（重新执行安装命令或升级 Agent）：/usr/local/bin/realm");
  assert.equal(failure?.user, RULE_RUNTIME_FAILURE_USER_TEXT.runtimeMissing);
  assert.doesNotMatch(failure!.user, /usr\/local/);
});

test("端口被占：认出占用进程；只有日志说 address in use 时写入口端口", () => {
  const occupied = classifyRuleRuntimeFailure(`${notReady}; port 30021/tcp occupied by nginx (pid 812); cause=address-in-use; log: [tcp]failed to bind 0.0.0.0:30021: Address already in use (os error 98)`, 30021);
  assert.equal(occupied?.kind, "bind");
  assert.equal(occupied?.admin, "端口绑定失败：30021/TCP 被 nginx（pid 812）占用");
  assert.equal(occupied?.user, "端口绑定失败：30021/TCP 已被其他程序占用");
  const inUse = classifyRuleRuntimeFailure(`${notReady}; cause=address-in-use; log: bind failed: Address already in use`, 30021);
  assert.equal(inUse?.kind, "bind");
  assert.equal(inUse?.admin, "端口绑定失败：入口端口 30021 已被占用（日志：bind failed: Address already in use）");
  // 老格式（不是「监听没起来」那句）照旧把原文带上。
  assert.equal(classifyRuleRuntimeFailure("listen tcp :443: bind: address already in use", 443)?.admin, "端口绑定失败：listen tcp :443: bind: address already in use");
});

test("监听没起来、原因认不出：管理员看到日志；老 Agent 不带日志时提示升级", () => {
  const withLog = classifyRuleRuntimeFailure(`${notReady}; log: config error: unknown field \`foo\``, 30021);
  assert.equal(withLog?.kind, "runtime");
  assert.equal(withLog?.admin, "监听没起来：config error: unknown field `foo`");
  assert.equal(withLog?.user, RULE_RUNTIME_FAILURE_USER_TEXT.listener);
  assert.match(classifyRuleRuntimeFailure(notReady, 30021, { agentVersion: "2.2.255" })!.admin, /Agent 2\.2\.255 不带原因，升级到 2\.2\.256 以上/);
  assert.equal(classifyRuleRuntimeFailure(notReady, 30021, { agentVersion: "2.2.256" })?.admin, "监听没起来（服务日志里没有线索，到主机上看这个服务的日志）");
  assert.equal(classifyRuleRuntimeFailure(`${notReady}; cause=permission-denied; log: bind: Permission denied`, 80)?.user, RULE_RUNTIME_FAILURE_USER_TEXT.permission);
});

test("认不出的原因原样返回；空的返回空", () => {
  assert.equal(classifyRuleRuntimeFailure("runtime action failed: realm", 1), null);
  assert.equal(ruleRuntimeFailureReason("runtime action failed: realm", 1), "runtime action failed: realm");
  assert.equal(ruleRuntimeFailureReason("", 1), "");
  assert.equal(ruleRuntimeFailureReason(null, 1), "");
  assert.equal(ruleRuntimeFailureReason(`${notReady}; cause=ipv6-unavailable`, 1), "监听没起来：IPv6 在这台机器上不可用");
  assert.equal(agentRuntimeFailureLogTail(`${notReady}; cause=x; log: a; b`), "a; b");
  assert.equal(agentRuntimeFailureLogTail(notReady), "");
});

test("规则卡上的告警：监听没起来带中文标签，报运行就清掉", () => {
  resetPortOccupancyForTests();
  const now = 1_800_000_000_000;
  const rule = { id: 21, hostId: 3, sourcePort: 30021, protocol: "tcp", forwardType: "realm", isEnabled: true, pendingDelete: false };
  recordRuleRuntimeStatus({ rule, hostId: 3, isRunning: false, message: `${notReady}; cause=ipv6-unavailable; log: [tcp]failed to bind [::]:30021: Address family not supported by protocol (os error 97)` }, now);
  const [admin] = getRulePortWarnings(rule, true, now);
  assert.equal(admin.level, "error");
  assert.equal(admin.kind, "runtime");
  assert.equal(admin.label, "监听没起来");
  assert.match(admin.message, /IPv6 在这台机器上不可用（日志：.*os error 97/);
  assert.equal(getRulePortWarnings(rule, false, now)[0].message, "监听没起来：IPv6 在这台机器上不可用");
  recordRuleRuntimeStatus({ rule, hostId: 3, isRunning: true }, now + 1000);
  assert.deepEqual(getRulePortWarnings(rule, true, now + 1000), []);
});

test("英文界面：规则卡上会出现的固定文案都有译文", () => {
  const dictionary = JSON.parse(fs.readFileSync(path.join(process.cwd(), "client/src/i18n/en.json"), "utf8")) as Record<string, string>;
  const texts = [
    RULE_RUNTIME_FAILURE_LABELS.listener,
    RULE_RUNTIME_FAILURE_LABELS.runtimeMissing,
    RULE_RUNTIME_FAILURE_LABELS.bind,
    RULE_RUNTIME_FAILURE_LABELS.kernel,
    ...Object.values(RULE_RUNTIME_FAILURE_USER_TEXT),
  ];
  for (const text of texts) assert.ok(dictionary[text], `en.json 缺「${text}」`);
});
