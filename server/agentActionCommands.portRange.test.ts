import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildCountingChainCmds,
  buildIptablesForwardCleanupCmds,
  buildIptablesForwardCmds,
  buildKernelForwardCmds,
  buildNftCleanupCmds,
  buildNftForwardCmds,
} from "./agentActionCommands";

/*
  端口段规则（shared/portRange.ts）生成的内核规则文本。

  Agent 那头的就绪检查按这些文本认规则（agent/port_range.go、kernel_forward_snapshot.go），
  所以这里逐字核对：段写法、同端口只改地址、平移的偏移 / 映射表、计数规则按整段匹配。
  单端口规则生成的命令必须和以前一字不差 —— 否则升级后每条老规则都会被重下一遍。
*/

const sameRange = { id: 7, sourcePort: 20000, sourcePortEnd: 20100, targetIp: "203.0.113.10", targetPort: 20000, protocol: "both", forwardType: "nftables" };
const shiftRange = { id: 8, sourcePort: 20000, sourcePortEnd: 20002, targetIp: "203.0.113.10", targetPort: 30000, protocol: "udp", forwardType: "nftables" };
const single = { id: 9, sourcePort: 22222, targetIp: "203.0.113.10", targetPort: 443, protocol: "both", forwardType: "nftables" };

test("nft 同端口的段规则：整段匹配，DNAT 只写地址保留原端口", () => {
  const text = buildNftForwardCmds(sameRange).join("\n");
  assert.match(text, /prerouting meta l4proto tcp tcp dport 20000-20100 counter dnat ip to 203\.0\.113\.10 comment '"fwx-rule-7-in"'/);
  assert.match(text, /prerouting meta l4proto udp udp dport 20000-20100 counter dnat ip to 203\.0\.113\.10 comment/);
  assert.match(text, /forward meta l4proto tcp ip daddr 203\.0\.113\.10 tcp dport 20000-20100 ct original proto-dst 20000-20100 counter accept/);
  assert.match(text, /ip saddr 203\.0\.113\.10 tcp sport 20000-20100 ct original proto-dst 20000-20100 ct state established,related counter accept/);
  assert.doesNotMatch(text, /add map|dport map/, "同端口用不着映射表");
  assert.doesNotMatch(text, /203\.0\.113\.10:20000/, "不能写成目标端口，否则成了单端口");
});

test("nft 平移的段规则：先建映射表（每个入口端口一项），DNAT 引用它", () => {
  const cmds = buildNftForwardCmds(shiftRange);
  const text = cmds.join("\n");
  assert.ok(cmds.includes("nft add map inet forwardx fwx_pr_8_udp '{ type inet_service : inet_service; }'"));
  assert.ok(cmds.includes("nft flush map inet forwardx fwx_pr_8_udp"));
  assert.ok(cmds.includes("nft add element inet forwardx fwx_pr_8_udp '{ 20000 : 30000, 20001 : 30001, 20002 : 30002 }'"));
  assert.match(text, /udp dport 20000-20002 counter dnat ip to 203\.0\.113\.10 : udp dport map @fwx_pr_8_udp comment/);
  assert.match(text, /ip daddr 203\.0\.113\.10 udp dport 30000-30002 ct original proto-dst 20000-20002/);
  assert.doesNotMatch(text, /tcp dport/, "纯 UDP 不该出现 TCP 规则");
  // 映射表的元素只出现一次（四个兜底写法都只引用表名）。
  assert.equal(text.split("20001 : 30001").length - 1, 1);
});

test("nft 段规则清理：按注释删规则之后再删映射表；单端口规则不多出清理命令", () => {
  const cleanup = buildNftCleanupCmds(shiftRange);
  const commentIndex = cleanup.findIndex((cmd) => cmd.includes("fwx-rule-8") && cmd.includes(" prerouting "));
  const mapIndex = cleanup.findIndex((cmd) => cmd.includes("delete map inet forwardx fwx_pr_8_udp"));
  assert.ok(commentIndex >= 0 && mapIndex > commentIndex, "映射表被规则引用时删不掉，必须排在后面");
  assert.ok(cleanup.some((cmd) => cmd.includes("delete map inet forwardx fwx_pr_8_tcp")), "协议改过的话 TCP 那张也要清");
  assert.ok(!buildNftCleanupCmds(single).some((cmd) => cmd.includes("fwx_pr_")));
});

test("单端口 nft 规则的命令和以前一样（端口、目标都是原样）", () => {
  const text = buildNftForwardCmds(single).join("\n");
  assert.match(text, /tcp dport 22222 counter dnat ip to 203\.0\.113\.10:443 comment/);
  assert.match(text, /tcp dport 443 ct original proto-dst 22222 counter accept/);
  // 只看端口段语法（「22222-」后面跟数字）；Docker 放行的注释名 fwx-docker-<规则>-22222-tcp 不算
  assert.doesNotMatch(text, /22222-\d|443-\d|fwx_pr_/);
});

test("iptables 同端口段：--dport 起:止，DNAT 只写地址；放行和 MASQUERADE 按目标段匹配", () => {
  const rule = { ...sameRange, forwardType: "iptables", protocol: "tcp" };
  const text = buildIptablesForwardCmds(rule).join("\n");
  assert.match(text, /-A PREROUTING -p tcp --dport 20000:20100 -j DNAT --to-destination 203\.0\.113\.10(?:;| )/);
  assert.match(text, /POSTROUTING -p tcp -d 203\.0\.113\.10 --dport 20000:20100 -m comment --comment fwx-rule-7 -j MASQUERADE/);
  assert.match(text, /FORWARD -p tcp -s 203\.0\.113\.10 --sport 20000:20100 -m state --state ESTABLISHED,RELATED -m comment --comment fwx-rule-7 -j ACCEPT/);
});

test("iptables 平移段：--to-destination 地址:目标段/入口起点（按偏移一一对应），IPv6 带方括号", () => {
  const rule = { ...shiftRange, forwardType: "iptables", protocol: "tcp" };
  const text = buildIptablesForwardCmds(rule).join("\n");
  assert.match(text, /--dport 20000:20002 -j DNAT --to-destination 203\.0\.113\.10:30000-30002\/20000/);
  assert.match(text, /-d 203\.0\.113\.10 --dport 30000:30002 /);
  const v6 = buildIptablesForwardCmds({ ...rule, targetIp: "2001:db8::10" }).join("\n");
  assert.match(v6, /ip6tables .*--to-destination \[2001:db8::10\]:30000-30002\/20000/);
  // 清理用同一份写法删 DNAT；按端口清理的正则也认以起点开头的段。
  const cleanup = buildIptablesForwardCleanupCmds(rule).join("\n");
  assert.match(cleanup, /-D PREROUTING -p tcp --dport 20000:20002 -j DNAT --to-destination 203\.0\.113\.10:30000-30002\/20000/);
  assert.match(cleanup, /--dport 20000\(:\[0-9\]\+\)\?\( \|\$\)/);
});

test("iptables 段规则的计数链按整段匹配，标记仍是起始端口", () => {
  const rule = { ...shiftRange, forwardType: "iptables", protocol: "tcp" };
  const text = buildKernelForwardCmds(rule, "iptables").join("\n");
  assert.match(text, /FORWARD -p tcp -m conntrack --ctorigdstport 20000:20002 -d 203\.0\.113\.10 --dport 30000:30002 -m comment --comment "fwx-stat-20000:in"/);
  assert.match(text, /FORWARD -p tcp -m conntrack --ctorigdstport 20000:20002 -s 203\.0\.113\.10 --sport 30000:30002 -m comment --comment "fwx-stat-20000:out"/);
  // 单端口照旧。
  const plain = buildCountingChainCmds(22222, "203.0.113.10", 443, "tcp", "iptables").join("\n");
  assert.match(plain, /--ctorigdstport 22222 -d 203\.0\.113\.10 --dport 443 /);
});

/*
  真执行一遍：在独立的网络命名空间里把生成的命令跑起来，看内核真的收下了（nft / iptables 语法、
  映射表、偏移写法）。要 root + unshare + nft + iptables，默认不跑：FORWARDX_NETNS_E2E=1 打开。
*/
const netnsEnabled = process.env.FORWARDX_NETNS_E2E === "1";

function runInNetns(script: string) {
  return spawnSync("unshare", ["-n", "sh", "-c", script], { encoding: "utf8", env: { ...process.env, FWX_IPT_WAIT: "" } });
}

test("netns 里真跑：nft 平移段规则装得上、映射表一一对应、重装和清理都干净", { skip: !netnsEnabled }, () => {
  const apply = buildNftForwardCmds({ ...shiftRange, protocol: "both" });
  const cleanup = buildNftCleanupCmds({ ...shiftRange, protocol: "both" });
  // Agent 逐条执行、任何一条失败就算这次下发失败，所以每条都必须成功。
  const must = (cmd: string, index: number) => `{ ${cmd}; } >/dev/null 2>&1 || { echo "FAILED #${index}" >&2; exit 1; }`;
  const script = [
    ...apply.map(must),
    // 再装一遍：清理 + 重建不能报 EBUSY，也不能留下第二份规则。
    ...apply.map(must),
    "nft -a list table inet forwardx",
    "echo ---CLEANUP---",
    ...cleanup.map((cmd) => `{ ${cmd}; } >/dev/null 2>&1 || true`),
    "nft list table inet forwardx",
  ].join("\n");
  const result = runInNetns(script);
  const failed = /FAILED #(\d+)/.exec(result.stderr);
  assert.equal(result.status, 0, failed ? apply[Number(failed[1])] : result.stderr);
  const [installed, cleaned] = result.stdout.split("---CLEANUP---");
  assert.match(installed, /udp dport 20000-20002 counter packets \d+ bytes \d+ dnat ip to 203\.0\.113\.10:udp dport map @fwx_pr_8_udp comment "fwx-rule-8-in"/);
  assert.match(installed, /tcp dport 20000-20002 counter packets \d+ bytes \d+ dnat ip to 203\.0\.113\.10:tcp dport map @fwx_pr_8_tcp comment "fwx-rule-8-in"/);
  assert.match(installed, /elements = \{ 20000 : 30000, 20001 : 30001, 20002 : 30002 \}/);
  assert.equal(installed.split("dport map @fwx_pr_8_udp").length - 1, 1, "重装后只剩一条");
  assert.doesNotMatch(cleaned, /fwx_pr_8|fwx-rule-8/);
});

test("netns 里真跑：iptables 同端口 / 平移段规则装得上，计数链也在", { skip: !netnsEnabled }, () => {
  const same = buildKernelForwardCmds({ ...sameRange, forwardType: "iptables", protocol: "tcp" }, "iptables");
  const shift = buildKernelForwardCmds({ ...shiftRange, id: 10, sourcePort: 21000, sourcePortEnd: 21002, forwardType: "iptables", protocol: "udp" }, "iptables");
  const script = [
    ...[...same, ...shift].map((cmd) => `{ ${cmd}; } >/dev/null 2>&1 || echo "FAILED: ${cmd.slice(0, 60).replace(/["$`\\]/g, "")}"`),
    "iptables -t nat -S PREROUTING",
    "iptables -t mangle -S FORWARD",
  ].join("\n");
  const result = runInNetns(script);
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  assert.match(out, /-A PREROUTING -p tcp -m tcp --dport 20000:20100 -j DNAT --to-destination 203\.0\.113\.10\n/);
  assert.match(out, /-A PREROUTING -p udp -m udp --dport 21000:21002 -j DNAT --to-destination 203\.0\.113\.10:30000-30002\/21000/);
  assert.match(out, /--ctorigdstport 21000:21002 -m udp --dport 30000:30002 -m comment --comment "fwx-stat-21000:in"/);
  // 生成的命令里有可选步骤（ip6tables、nft 清理），失败也不算；DNAT 本身必须成功。
  assert.doesNotMatch(out, /FAILED: iptables .*PREROUTING/);
});
