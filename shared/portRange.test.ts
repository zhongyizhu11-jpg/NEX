import assert from "node:assert/strict";
import test from "node:test";
import {
  PORT_RANGE_MAX_SIZE,
  addRulePortSpan,
  formatRuleSourcePort,
  formatRuleTargetPort,
  isPortRangeRule,
  mapPortRangeTarget,
  normalizeSourcePortEnd,
  parseBatchRuleLine,
  parseBatchRuleText,
  parsePortSpec,
  portRangeShapeError,
  portRangeUnsupportedReason,
  rulePortRangeSize,
  ruleTargetPortEnd,
} from "./portRange";

test("端口写法：单端口、段、全角横线和空格都认；倒着写、超范围、乱写都报错", () => {
  assert.deepEqual(parsePortSpec("8080"), { start: 8080, end: 8080 });
  assert.deepEqual(parsePortSpec(" 20000 - 20100 "), { start: 20000, end: 20100 });
  assert.deepEqual(parsePortSpec("20000～20100"), { start: 20000, end: 20100 });
  assert.equal(parsePortSpec(""), null);
  assert.match((parsePortSpec("20100-20000") as { error: string }).error, /从小写到大/);
  assert.match((parsePortSpec("0") as { error: string }).error, /1-65535/);
  assert.match((parsePortSpec("70000") as { error: string }).error, /1-65535/);
  assert.match((parsePortSpec("80,443") as { error: string }).error, /20000-20100/);
});

test("段结尾不比起点大就是单端口（存 null），老数据的空列也是单端口", () => {
  assert.equal(normalizeSourcePortEnd(20000, 20100), 20100);
  assert.equal(normalizeSourcePortEnd(20000, 20000), null);
  assert.equal(normalizeSourcePortEnd(20000, null), null);
  assert.equal(normalizeSourcePortEnd(0, 100), null);
  assert.equal(isPortRangeRule({ sourcePort: 8080, sourcePortEnd: null }), false);
  assert.equal(rulePortRangeSize({ sourcePort: 8080 }), 1);
});

test("平移计算：目标段从目标起点开始、和入口段一样长；同端口时目标段就是入口段", () => {
  const shifted = { sourcePort: 20000, sourcePortEnd: 20100, targetPort: 30000 };
  assert.equal(rulePortRangeSize(shifted), 101);
  assert.equal(ruleTargetPortEnd(shifted), 30100);
  assert.equal(mapPortRangeTarget(shifted, 20000), 30000);
  assert.equal(mapPortRangeTarget(shifted, 20057), 30057);
  assert.equal(mapPortRangeTarget(shifted, 20101), null);
  assert.equal(formatRuleSourcePort(shifted), "20000-20100");
  assert.equal(formatRuleTargetPort(shifted), "30000-30100");
  const same = { sourcePort: 20000, sourcePortEnd: 20100, targetPort: 20000 };
  assert.equal(formatRuleTargetPort(same), "20000-20100");
  assert.equal(formatRuleTargetPort({ sourcePort: 8080, targetPort: 80 }), "80");
});

test("段的形状：最多 1000 个端口，目标段写了就得一样长，目标段不能超出 65535", () => {
  assert.equal(portRangeShapeError({ sourcePort: 20000, sourcePortEnd: 20000 + PORT_RANGE_MAX_SIZE - 1, targetPort: 20000 }), null);
  assert.match(portRangeShapeError({ sourcePort: 20000, sourcePortEnd: 20000 + PORT_RANGE_MAX_SIZE, targetPort: 20000 }) || "", /最多 1000/);
  assert.match(portRangeShapeError({ sourcePort: 20000, sourcePortEnd: 20009, targetPort: 30000, targetPortEnd: 30019 }) || "", /一样长（10 个端口）/);
  assert.equal(portRangeShapeError({ sourcePort: 20000, sourcePortEnd: 20009, targetPort: 30000, targetPortEnd: 30009 }), null);
  assert.match(portRangeShapeError({ sourcePort: 8080, targetPort: 80, targetPortEnd: 90 }) || "", /入口是单端口/);
  assert.match(portRangeShapeError({ sourcePort: 20000, sourcePortEnd: 20010, targetPort: 65530 }) || "", /超出 65535/);
});

test("不支持端口段的情况各有一句原因：用户态转发、隧道、转发组、线路组、TLS 入站、出口、限速", () => {
  const ok = { forwardType: "nftables", sourcePort: 20000 };
  assert.equal(portRangeUnsupportedReason(ok), null);
  assert.equal(portRangeUnsupportedReason({ ...ok, forwardType: "iptables" }), null);
  for (const forwardType of ["gost", "realm", "socat", "nginx"]) {
    assert.match(portRangeUnsupportedReason({ ...ok, forwardType }) || "", /只支持 iptables \/ nftables：gost、realm 这些每个端口都要单独开一个监听/);
  }
  assert.match(portRangeUnsupportedReason({ ...ok, tunnelId: 3 }) || "", /隧道/);
  assert.match(portRangeUnsupportedReason({ ...ok, forwardGroupId: 3 }) || "", /转发组/);
  assert.match(portRangeUnsupportedReason({ ...ok, isForwardGroupTemplate: true }) || "", /转发组/);
  assert.match(portRangeUnsupportedReason({ ...ok, failoverEnabled: true }) || "", /线路组/);
  assert.match(portRangeUnsupportedReason({ ...ok, routeMode: "smart" }) || "", /线路组/);
  assert.match(portRangeUnsupportedReason({ ...ok, tlsInboundId: 1 }) || "", /TLS/);
  assert.match(portRangeUnsupportedReason({ ...ok, egressType: "ss_host" }) || "", /Shadowsocks/);
  assert.match(portRangeUnsupportedReason({ ...ok, sourcePort: 0 }) || "", /随机/);
  assert.match(portRangeUnsupportedReason({ ...ok, rateLimited: true }) || "", /限速/);
});

test("占用集合按整段加，脏数据（超长段）也只加 1000 个", () => {
  const used = new Set<number>();
  addRulePortSpan(used, 20000, 20004);
  addRulePortSpan(used, 8080, null);
  assert.deepEqual([...used].sort((a, b) => a - b), [8080, 20000, 20001, 20002, 20003, 20004]);
  const dirty = new Set<number>();
  addRulePortSpan(dirty, 1000, 65535);
  assert.equal(dirty.size, PORT_RANGE_MAX_SIZE);
});

test("批量的一行：段、平移、IPv6、备注都能解析；格式不对的说清哪里不对", () => {
  assert.deepEqual(parseBatchRuleLine("20000-20100 10.0.0.2:30000-30100 RTP 媒体", 3), {
    line: 3, text: "20000-20100 10.0.0.2:30000-30100 RTP 媒体", sourcePort: 20000, sourcePortEnd: 20100,
    targetIp: "10.0.0.2", targetPort: 30000, targetPortEnd: 30100, remark: "RTP 媒体",
  });
  const v6 = parseBatchRuleLine("443 [2001:db8::1]:8443", 1);
  assert.ok(!("error" in v6) && v6.targetIp === "2001:db8::1" && v6.targetPort === 8443 && v6.sourcePortEnd === null);
  assert.match((parseBatchRuleLine("443", 1) as { error: string }).error, /格式是/);
  assert.match((parseBatchRuleLine("443 2001:db8::1:80", 1) as { error: string }).error, /IPv6 用 \[地址\]:端口/);
  assert.match((parseBatchRuleLine("20000-20010 10.0.0.1:30000-30020", 1) as { error: string }).error, /一样长/);
  assert.match((parseBatchRuleLine("443 bad_host!:80", 1) as { error: string }).error, /目标地址/);
});

test("批量整段文本：跳过空行和注释，行号按原文，批内重叠的后一行算冲突", () => {
  const rows = parseBatchRuleText("# 游戏\n\n20000-20010 10.0.0.1:20000\n20005 10.0.0.2:80\n20011 10.0.0.3:80\r\n");
  assert.deepEqual(rows.map((row) => [row.line, "error" in row ? row.error : "ok"]), [
    [3, "ok"],
    [4, "和第 3 行的入口端口重叠"],
    [5, "ok"],
  ]);
});

test("规则表单：写一半 / 写错的端口段直接说哪里错；段不能用时按钮灰着并给原因；段长对不上也拦", async () => {
  const { forwardRuleFormBlocker } = await import("./forwardRuleForm");
  const form = { routeMode: "local" as const, tunnelId: null, forwardGroupId: 3, hostId: null, sourcePort: 20000, sourcePortEnd: 20100, targetIp: "10.0.0.1", targetPort: 30000, protocol: "both", failoverEnabled: false };
  const context = { editing: false, usesForwardGroup: true, canUseLocalForward: true, canUseForwardChain: true, canUseFailoverGroup: true, canUseGost: true, portStatus: "available" as const };
  assert.equal(forwardRuleFormBlocker(form, context), null);
  assert.match(forwardRuleFormBlocker({ ...form, sourcePortText: "20100-20000" }, context) || "", /源端口：端口段要从小写到大/);
  assert.equal(forwardRuleFormBlocker(form, { ...context, portRangeBlocker: "端口段只支持 iptables / nftables" }), "端口段只支持 iptables / nftables");
  assert.match(forwardRuleFormBlocker({ ...form, targetPortEnd: 30010 }, context) || "", /一样长/);
  assert.match(forwardRuleFormBlocker({ ...form, targetPortText: "30000-" }, context) || "", /目标端口：/);
});
