import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCountingChainCmds,
  buildIptablesForwardCleanupCmds,
  buildIptablesForwardCmds,
  buildIptablesTransitionCleanupCmds,
  buildKernelForwardTransitionCleanupCmds,
  buildNftCleanupCmds,
  buildKernelForwardCmds,
  buildNftForwardCmds,
  buildNftTransitionCleanupCmds,
  gostRuntimeApiConfig,
  gostRuntimeApiExecStart,
  restartManagedServiceIfConfigChangedCmd,
  restartMimicServiceIfConfigChangedCmd,
  syncGostServiceIfConfigChangedCmd,
} from "./agentActionCommands";
import { AGENT_CAPABILITY_GOST_API_SYNC, hostSupportsGostApiSync } from "../shared/gostRuntimeApi";

test("GOST API sync uses root-only Unix sockets and keeps the restart command as fallback", () => {
  for (const [service, configPath] of [
    ["forwardx-runtime", "/etc/forwardx/runtime/gost.json"],
    ["forwardx-tunnel-runtime", "/etc/forwardx/runtime/tunnel-gost.json"],
  ]) {
    const socket = `/run/forwardx-agent/gost-api/${service}.sock`;
    assert.deepEqual(gostRuntimeApiConfig(service), { addr: `unix://${socket}` });
    const command = syncGostServiceIfConfigChangedCmd(service, configPath);
    const [marker, ...rest] = command.split("\n");
    assert.equal(marker, `# forwardx-gost-api-sync ${service} ${configPath}`);
    // The fallback is byte-for-byte the old restart command, so old Agents behave exactly as before.
    assert.equal(rest.join("\n"), restartManagedServiceIfConfigChangedCmd(service, configPath));
    const execStart = gostRuntimeApiExecStart("/usr/local/bin/forwardx-runtime", service, configPath);
    assert.ok(execStart.startsWith("/bin/sh -c '"));
    assert.ok(execStart.includes("mkdir -p -m 700 /run/forwardx-agent/gost-api && chmod 700 /run/forwardx-agent/gost-api"));
    assert.ok(execStart.includes(`rm -f ${socket} && umask 177 && exec /usr/local/bin/forwardx-runtime -C ${configPath}'`));
    // systemd would substitute $VAR inside ExecStart; never expose the API on TCP.
    assert.ok(!(execStart + command).includes("127.0.0.1"));
    assert.ok(!execStart.includes("$"));
  }
  assert.throws(() => gostRuntimeApiConfig("other"));
  assert.throws(() => gostRuntimeApiConfig("__proto__"));
  assert.throws(() => syncGostServiceIfConfigChangedCmd("forwardx-runtime", "/tmp/config"));
  assert.throws(() => gostRuntimeApiExecStart("/usr/local/bin/x; rm -rf /", "forwardx-runtime", "/etc/forwardx/runtime/gost.json"));
});

test("GOST API sync is enabled only for capable Agents", () => {
  assert.equal(hostSupportsGostApiSync({ agentVersion: "2.2.229", agentCapabilities: JSON.stringify([AGENT_CAPABILITY_GOST_API_SYNC]) }), true);
  assert.equal(hostSupportsGostApiSync({ agentVersion: "2.2.229", agentCapabilities: "[]" }), false);
  // A downgraded Agent may still have the stored capability; the version gate rejects it.
  assert.equal(hostSupportsGostApiSync({ agentVersion: "2.2.228", agentCapabilities: JSON.stringify([AGENT_CAPABILITY_GOST_API_SYNC]) }), false);
  assert.equal(hostSupportsGostApiSync(null), false);
});

test("nft rule comments keep nft string quotes after shell parsing", () => {
  const commands = buildNftForwardCmds({
    id: 42,
    sourcePort: 22222,
    targetIp: "203.0.113.10",
    targetPort: 443,
    protocol: "both",
  }).join("\n");

  assert.match(commands, /comment '\"fwx-rule-42-in\"'/);
  assert.match(commands, /comment '\"fwx-rule-42-out\"'/);
  assert.match(commands, /comment '\"fwx-rule-42\"'/);
  assert.doesNotMatch(commands, /comment \"fwx-rule-42-(?:in|out)\"/);
  assert.doesNotMatch(commands, /fwx-rule-42:(?:in|out)/);
});

test("process runtime actions leave counter reconciliation to the Agent", () => {
  for (const forwardType of ["gost", "realm", "socat", "nginx", "guard"]) {
    assert.deepEqual(
      buildCountingChainCmds(22022, "target.example", 443, "both", forwardType),
      [],
      `${forwardType} action unexpectedly rebuilt shared counters`,
    );
  }
});

test("iptables forwarding gets only conntrack-scoped DNAT counters", () => {
  const commands = buildCountingChainCmds(22022, "203.0.113.10", 443, "both", "iptables").join("\n");

  // DNAT rewrites the destination before the forward hook, so the forward
  // counters match the target endpoint while conntrack keeps the listener
  // identity available after the rewrite.
  assert.match(commands, /FORWARD -p tcp -m conntrack --ctorigdstport 22022 -d 203\.0\.113\.10 --dport 443/);
  assert.match(commands, /FORWARD -p tcp -m conntrack --ctorigdstport 22022 -s 203\.0\.113\.10 --sport 443/);
  assert.match(commands, /FORWARD -p udp -m conntrack --ctorigdstport 22022 -d 203\.0\.113\.10 --dport 443/);
  assert.doesNotMatch(commands, /-A (?:PREROUTING|INPUT|OUTPUT|POSTROUTING) .*fwx-stat-22022/);
  assert.doesNotMatch(commands, /nft add rule inet forwardx_traffic/);
  // The cleanup pass must sweep the forward chain too, or stale counters leak.
  assert.match(commands, /for c in input output forward; do/);
});

test("native nft return counters keep shared targets isolated by original listener port", () => {
  const commands = buildNftForwardCmds({
    id: 42,
    sourcePort: 22022,
    targetIp: "203.0.113.10",
    targetPort: 443,
    protocol: "tcp",
  }).join("\n");

  assert.match(commands, /forward meta l4proto tcp ip daddr 203\.0\.113\.10 tcp dport 443 ct original proto-dst 22022 counter accept comment '\"fwx-rule-42-in\"'/);
  assert.match(commands, /forward meta l4proto tcp ip daddr 203\.0\.113\.10 tcp dport 443 ct original proto-dst 22022 comment '\"fwx-rule-42-in\"' counter accept/);
  assert.match(commands, /forward meta l4proto tcp ip saddr 203\.0\.113\.10 tcp sport 443 ct original proto-dst 22022 ct state established,related counter accept comment '\"fwx-rule-42-out\"'/);
  assert.match(commands, /forward meta l4proto tcp ip saddr 203\.0\.113\.10 tcp sport 443 ct original proto-dst 22022 ct state established,related comment '\"fwx-rule-42-out\"' counter accept/);
  assert.match(commands, /forward meta l4proto tcp ip daddr 203\.0\.113\.10 tcp dport 443 ct original proto-dst 22022 accept comment '\"fwx-rule-42\"'/);
  assert.doesNotMatch(commands, /forward meta l4proto tcp ip saddr 203\.0\.113\.10 tcp sport 443 ct state established,related counter accept comment/);
});

test("nft forwarding has compatibility fallbacks for selector and masquerade failures", () => {
  const commands = buildNftForwardCmds({
    id: 42,
    sourcePort: 22022,
    targetIp: "203.0.113.10",
    targetPort: 443,
    protocol: "tcp",
  }).join("\n");

  assert.match(commands, /forward selector failed, fallback=fwx-rule-42/);
  assert.match(commands, /forward meta l4proto tcp ip daddr 203\.0\.113\.10 tcp dport 443 accept comment/);
  assert.match(commands, /forward meta l4proto tcp ip saddr 203\.0\.113\.10 tcp sport 443 ct state established,related accept comment/);
  assert.match(commands, /rule failed, fallback=fwx-rule-42-masquerade-tcp/);
  assert.match(commands, /postrouting meta l4proto tcp ip daddr 203\.0\.113\.10 tcp dport 443 masquerade comment/);
  assert.match(commands, /forwarding chains are unavailable/);
});

test("kernel transition cleanup removes both nftables and iptables state", () => {
  const commands = buildKernelForwardTransitionCleanupCmds({
    id: 42,
    sourcePort: 22022,
    targetIp: "203.0.113.10",
    targetPort: 443,
    protocol: "both",
  }).join("\n");

  // A process-backed replacement must clean a previous kernel backend even
  // when the Agent's per-port owner marker is missing or stale.
  assert.match(commands, /iptables \$FWX_IPT_WAIT -t nat -S PREROUTING/);
  assert.match(commands, /nft list table inet forwardx/);
  assert.match(commands, /fwx-rule-42/);
  // Transition cleanup must not remove the state marker before the new action
  // has successfully written its owner.
  assert.doesNotMatch(commands, /rm -f .*port_22022\.rule/);
});

test("native backend transitions clean only the opposite backend", () => {
  const rule = {
    id: 42,
    sourcePort: 22022,
    targetIp: "203.0.113.10",
    targetPort: 443,
    protocol: "tcp",
  };
  const nftCleanup = buildNftTransitionCleanupCmds(rule).join("\n");
  const iptablesCleanup = buildIptablesTransitionCleanupCmds(rule).join("\n");

  assert.match(nftCleanup, /nft list table inet forwardx/);
  assert.doesNotMatch(nftCleanup, /iptables(?: \$FWX_IPT_WAIT)? -t nat/);
  assert.match(iptablesCleanup, /iptables \$FWX_IPT_WAIT -t nat/);
  assert.doesNotMatch(iptablesCleanup, /nft list table inet forwardx/);
});

test("nft cleanup without a rule id avoids synthetic chains", () => {
  const commands = buildNftCleanupCmds({
    id: 0,
    sourcePort: 22022,
    targetIp: "203.0.113.10",
    targetPort: 443,
    protocol: "tcp",
  }).join("\n");

  assert.doesNotMatch(commands, /forwardx in_0|forwardx out_0/);
  assert.match(commands, /port='22022'/);
});

test("process counters do not attribute shared target traffic to every listener", () => {
  const commands = buildCountingChainCmds(22022, "203.0.113.10", 443, "tcp", "gost").join("\n");

  // Listener hooks account realm/socat/gost/nginx proxy traffic. Target-only
  // local hooks cannot identify which proxy instance opened the connection,
  // so only the conntrack-qualified FORWARD rules remain for kernel DNAT.
  assert.equal(commands, "");
});

test("forward-hook counters isolate listeners that share one DNAT target", () => {
  const first = buildCountingChainCmds(22022, "203.0.113.10", 443, "tcp", "iptables").join("\n");
  const second = buildCountingChainCmds(22023, "203.0.113.10", 443, "tcp", "iptables").join("\n");

  assert.match(first, /--ctorigdstport 22022 -d 203\.0\.113\.10 --dport 443/);
  assert.match(second, /--ctorigdstport 22023 -d 203\.0\.113\.10 --dport 443/);
  assert.doesNotMatch(first, /--ctorigdstport 22023/);
  assert.doesNotMatch(second, /--ctorigdstport 22022/);
});

test("iptables counters use ip6tables for IPv6 targets", () => {
  const commands = buildCountingChainCmds(22022, "2001:db8::10", 443, "tcp", "iptables").join("\n");

  assert.match(commands, /ip6tables .*--ctorigdstport 22022 -d 2001:db8::10 --dport 443/);
  assert.match(commands, /ip6tables .*--ctorigdstport 22022 -s 2001:db8::10 --sport 443/);
  assert.doesNotMatch(commands, /nft add rule inet forwardx_traffic/);
});

test("iptables additions are skipped when the target is not a resolved IP", () => {
  const commands = buildCountingChainCmds(22022, "", 0, "both", "iptables").join("\n");

  assert.match(commands, /fwx-stat-22022:/);
  assert.doesNotMatch(commands, /-A FORWARD/);
});

test("self-reported and native nft modes only clean legacy fwx-stat rules", () => {
  for (const forwardType of ["forwardx", "forwardx-v1", "nftables"]) {
    const commands = buildCountingChainCmds(22022, "203.0.113.10", 443, "tcp", forwardType).join("\n");
    assert.match(commands, /fwx-stat-22022:/);
    assert.match(commands, /position\[chain\]\+\+/);
    assert.match(commands, /for \(i=count; i>=1; i--\)/);
    assert.match(commands, /-D "\$chain" "\$number"/);
    assert.doesNotMatch(commands, /\bxargs\b/);
    assert.doesNotMatch(commands, /-A FORWARD/);
    assert.doesNotMatch(commands, /nft add rule inet forwardx_traffic/);
  }
});

test("Mimic service reconciliation cleans stale hooks and has an skb fallback", () => {
  const commands = restartMimicServiceIfConfigChangedCmd("mimic@eth0", "/etc/mimic/eth0.conf", "eth0");

  assert.match(commands, /xdp_mode = /);
  assert.match(commands, /forwardx-xdp-mode/);
  assert.match(commands, /xdpdrv off/);
  assert.match(commands, /\/run\/mimic\/\*_\"\$mimic_ifindex\"\.lock/);
  assert.match(commands, /\$mimic_xdp_mode XDP\/TC hooks were not ready; retrying with \$mimic_fallback_mode mode/);
  assert.match(commands, /if \[ "\$mimic_xdp_mode" = "native" \]; then mimic_fallback_mode=skb; else mimic_fallback_mode=native; fi/);
  assert.match(commands, /mimic_existing_xdp_mode/);
  assert.match(commands, /forwardx-bpf\.conf/);
  assert.match(commands, /CAP_BPF/);
  assert.match(commands, /mimic_dropin_changed/);
  assert.match(commands, /\$\{mimic_force_restart:-0\}/);
  assert.match(commands, /if \[ "\$mimic_needs_start" = "1" \]; then\s+mimic_cleanup_runtime/);
  assert.match(commands, /virtio\|virtio_net\|veth\|tap\|tun\|\*\) mimic_xdp_mode=skb/);
  assert.match(commands, /mimic_start_service\(\)/);
  assert.match(commands, /mimic_start_output="\$\(mimic_start_service 2>&1\)"/);
  assert.match(commands, /service is active but XDP\/TC hooks were not detected/);
  assert.doesNotMatch(commands, /\/sys\/class\/net\/'eth0'\//);
  assert.doesNotMatch(commands, /systemctl disable 'mimic@eth0'/);
});

/**
 * 内核态转发两种的差别必须留着。
 *
 * iptables 和 nftables 原来在心跳路由里各写一遍 else-if，合并时最容易顺手抹平的
 * 就是那条「计数链只有 iptables 下」—— nft 构造器自带计数器，再下一遍 iptables
 * 计数链会把同一份流量数两次，而账面上看不出来。
 */
test("内核态转发：nftables 不下 iptables 计数链，iptables 要下", () => {
  const rule = {
    id: 1,
    sourcePort: 20001,
    targetIp: "198.51.100.7",
    targetPort: 443,
    protocol: "tcp",
    userId: 1,
    hostId: 1,
  };

  const iptablesCmds = buildKernelForwardCmds({ ...rule, forwardType: "iptables" }, "iptables").join("\n");
  const nftablesCmds = buildKernelForwardCmds({ ...rule, forwardType: "nftables" }, "nftables").join("\n");

  const countingChain = buildCountingChainCmds(20001, "198.51.100.7", 443, "tcp", "iptables");
  assert.ok(countingChain.length > 0, "这一组的前提是 iptables 确实有计数链");
  assert.ok(
    iptablesCmds.includes(countingChain[0]),
    "iptables 这一路要下计数链 —— 它的转发规则本身不带计数器",
  );
  assert.ok(
    !nftablesCmds.includes(countingChain[0]),
    "nftables 不该再下一遍 iptables 计数链：nft 构造器自带计数器，下两遍等于同一份流量数两次",
  );

  /** 访问限制由调用方传进来，传什么就该原样出现在末尾。 */
  const withLimits = buildKernelForwardCmds({ ...rule, forwardType: "nftables" }, "nftables", ["LIMIT-A", "LIMIT-B"]);
  assert.deepEqual(withLimits.slice(-2), ["LIMIT-A", "LIMIT-B"], "访问限制要接在最后");
});

/**
 * 用一个假的 iptables（规则存成文本文件）真跑一遍生成的 shell，
 * 验证共享目标的 MASQUERADE / FORWARD 不会被另一条规则的清理带走。
 */
const FAKE_IPTABLES = String.raw`#!/bin/sh
table=filter
while [ $# -gt 0 ]; do
  case "$1" in
    -w) shift; case "$1" in [0-9]*) shift ;; esac ;;
    -t) table=$2; shift 2 ;;
    *) break ;;
  esac
done
f="$FAKE_IPT_DIR/$table"; touch "$f"
op=$1; shift
case "$op" in
  -S) if [ -n "$1" ]; then grep "^-A $1 " "$f"; else cat "$f"; fi; exit 0 ;;
  -C) [ -n "$FAKE_IPT_CHECK_RC" ] && exit "$FAKE_IPT_CHECK_RC"; chain=$1; shift; grep -qxF -- "-A $chain $*" "$f" && exit 0; exit 1 ;;
  -A) chain=$1; shift; echo "-A $chain $*" >> "$f" ;;
  -I) chain=$1; shift; { echo "-A $chain $*"; cat "$f"; } > "$f.tmp"; mv "$f.tmp" "$f" ;;
  -D) chain=$1; shift
      if [ $# -eq 1 ] && echo "$1" | grep -qE '^[0-9]+$'; then
        awk -v c="-A $chain " -v n="$1" 'index($0, c) == 1 {k++; if (k == n) next} {print}' "$f" > "$f.tmp"
      else
        grep -qxF -- "-A $chain $*" "$f" || exit 1
        awk -v l="-A $chain $*" '!done && $0 == l {done = 1; next} {print}' "$f" > "$f.tmp"
      fi
      mv "$f.tmp" "$f" ;;
esac
exit 0
`;

function withFakeIptables(run: (exec: (commands: string[], env?: Record<string, string>) => void, state: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-fake-ipt-"));
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(bin, "iptables"), FAKE_IPTABLES, { mode: 0o755 });
  const exec = (commands: string[], env: Record<string, string> = {}) => {
    for (const command of commands) {
      if (/^sysctl /.test(command)) continue;
      spawnSync("sh", ["-c", command], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_IPT_DIR: state, FWX_IPT_WAIT: "-w 5", ...env },
        encoding: "utf8",
      });
    }
  };
  try {
    run(exec, state);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readTable = (state: string, table: string) => {
  const file = path.join(state, table);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};

const sharedTargetRule = (id: number, sourcePort: number) => ({
  id, sourcePort, targetIp: "10.0.0.9", targetPort: 80, protocol: "tcp",
});

test("iptables：删掉一条规则不会带走共享同一目标的另一条规则的 MASQUERADE / FORWARD", () => {
  withFakeIptables((exec, state) => {
    exec(buildIptablesForwardCmds(sharedTargetRule(1, 1001)));
    exec(buildIptablesForwardCmds(sharedTargetRule(2, 1002)));
    assert.match(readTable(state, "nat"), /--comment fwx-rule-1 -j MASQUERADE/);
    assert.match(readTable(state, "nat"), /--comment fwx-rule-2 -j MASQUERADE/);

    exec(buildIptablesForwardCleanupCmds(sharedTargetRule(1, 1001)));
    const nat = readTable(state, "nat");
    const filter = readTable(state, "filter");
    assert.doesNotMatch(nat, /--dport 1001 -j DNAT/);
    assert.doesNotMatch(nat, /fwx-rule-1 /);
    assert.match(nat, /--dport 1002 -j DNAT/);
    assert.match(nat, /--comment fwx-rule-2 -j MASQUERADE/);
    assert.equal((filter.match(/fwx-rule-2 -j ACCEPT/g) || []).length, 2, filter);
    assert.doesNotMatch(filter, /fwx-rule-1 /);
  });
});

test("iptables：旧版无标记的共享副本只在没有别的规则引用时才删", () => {
  withFakeIptables((exec, state) => {
    // 旧 Agent/面板留下的布局：两条规则的 DNAT + 一份共享、无标记的 MASQUERADE/FORWARD。
    fs.writeFileSync(path.join(state, "nat"), [
      "-A PREROUTING -p tcp --dport 1001 -j DNAT --to-destination 10.0.0.9:80",
      "-A PREROUTING -p tcp --dport 1002 -j DNAT --to-destination 10.0.0.9:80",
      "-A POSTROUTING -p tcp -d 10.0.0.9 --dport 80 -j MASQUERADE",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(state, "filter"), [
      "-A FORWARD -p tcp -d 10.0.0.9 --dport 80 -j ACCEPT",
      "-A FORWARD -p tcp -s 10.0.0.9 --sport 80 -m state --state ESTABLISHED,RELATED -j ACCEPT",
      "",
    ].join("\n"));

    exec(buildIptablesForwardCleanupCmds(sharedTargetRule(1, 1001)));
    assert.match(readTable(state, "nat"), /^-A POSTROUTING -p tcp -d 10\.0\.0\.9 --dport 80 -j MASQUERADE$/m, "规则 2 还在用，无标记的 MASQUERADE 必须保留");
    assert.match(readTable(state, "filter"), /^-A FORWARD -p tcp -d 10\.0\.0\.9 --dport 80 -j ACCEPT$/m);

    // 规则 2 被新面板重下发：迁移成带标记的规则，无标记副本已无人引用，被收掉。
    exec(buildIptablesForwardCmds(sharedTargetRule(2, 1002)));
    const nat = readTable(state, "nat");
    assert.doesNotMatch(nat, /^-A POSTROUTING -p tcp -d 10\.0\.0\.9 --dport 80 -j MASQUERADE$/m);
    assert.match(nat, /--comment fwx-rule-2 -j MASQUERADE/);
    assert.doesNotMatch(readTable(state, "filter"), /--dport 80 -j ACCEPT$/m);
  });
});

/**
 * 换隧道后旧入口的临时桥接（规则 id 落在桥接编号段）插到链首：
 * 机器上原有 firewalld 那样的 FORWARD 末尾 REJECT、Docker 的 FORWARD DROP 策略，追加在后面的
 * ACCEPT 永远轮不到，客户端连旧入口只看到超时。用户自己的 iptables 规则照旧追加。
 */
test("iptables：旧入口桥接插到链首，排在机器上已有的 REJECT 前面；普通规则照旧追加", () => {
  const bridgeRule = { id: 2_000_000_005, sourcePort: 52582, targetIp: "42.194.198.67", targetPort: 52582, protocol: "both" };
  const bridgeCmds = buildIptablesForwardCmds(bridgeRule);
  assert.ok(bridgeCmds.some((line) => line.includes("-I PREROUTING -p tcp --dport 52582 -j DNAT --to-destination 42.194.198.67:52582")), bridgeCmds.join("\n"));
  assert.ok(bridgeCmds.some((line) => line.includes("-I FORWARD -p udp -d 42.194.198.67 --dport 52582 -m comment --comment fwx-rule-2000000005 -j ACCEPT")), bridgeCmds.join("\n"));
  assert.ok(!bridgeCmds.some((line) => / -A (PREROUTING|POSTROUTING|FORWARD) -p /.test(line)), "桥接的四段规则都该是 -I");
  const normalCmds = buildIptablesForwardCmds(sharedTargetRule(7, 1007));
  assert.ok(normalCmds.some((line) => line.includes("-A FORWARD -p tcp -d 10.0.0.9 --dport 80 -m comment --comment fwx-rule-7 -j ACCEPT")), normalCmds.join("\n"));
  assert.ok(!normalCmds.some((line) => / -I (PREROUTING|POSTROUTING|FORWARD) -p /.test(line)), "普通规则不该改成 -I");

  withFakeIptables((exec, state) => {
    // 机器上原有的布局：firewalld 式的 FORWARD 末尾 REJECT。
    exec(["iptables -A FORWARD -j FORWARD_IN_ZONES", "iptables -A FORWARD -j REJECT --reject-with icmp-host-prohibited"]);
    exec(buildIptablesForwardCmds(bridgeRule));
    exec(buildIptablesForwardCmds(sharedTargetRule(7, 1007)));
    const filter = readTable(state, "filter").trim().split("\n");
    const reject = filter.findIndex((line) => line.includes("-j REJECT"));
    const bridgeAccepts = filter.map((line, index) => (line.includes("fwx-rule-2000000005") ? index : -1)).filter((index) => index >= 0);
    const normalAccepts = filter.map((line, index) => (line.includes("fwx-rule-7 ") ? index : -1)).filter((index) => index >= 0);
    assert.equal(bridgeAccepts.length, 4, filter.join("\n"));
    assert.ok(bridgeAccepts.every((index) => index < reject), `桥接的放行要排在 REJECT 前面：\n${filter.join("\n")}`);
    assert.ok(normalAccepts.every((index) => index > reject), `普通规则照旧追加在后面：\n${filter.join("\n")}`);
    const nat = readTable(state, "nat").trim().split("\n");
    assert.ok(nat.slice(0, 4).every((line) => line.includes("52582")), `桥接的 DNAT / MASQUERADE 也在链首：\n${nat.join("\n")}`);

    // 重下一遍（目标没变）：先删后插，仍然只有一份，仍在链首。
    exec(buildIptablesForwardCmds(bridgeRule));
    const again = readTable(state, "filter").trim().split("\n");
    assert.equal(again.filter((line) => line.includes("fwx-rule-2000000005")).length, 4, again.join("\n"));
    assert.ok(again.findIndex((line) => line.includes("fwx-rule-2000000005")) < again.findIndex((line) => line.includes("-j REJECT")));
  });
});

test("iptables：-C 因锁忙等原因失败（非 1）时不追加，避免重复规则", () => {
  withFakeIptables((exec, state) => {
    exec(buildCountingChainCmds(22022, "203.0.113.10", 443, "tcp", "iptables"), { FAKE_IPT_CHECK_RC: "4" });
    assert.equal(readTable(state, "mangle").trim(), "");
    exec(buildCountingChainCmds(22022, "203.0.113.10", 443, "tcp", "iptables"));
    exec(buildCountingChainCmds(22022, "203.0.113.10", 443, "tcp", "iptables").slice(-2));
    assert.equal((readTable(state, "mangle").match(/fwx-stat-22022:in/g) || []).length, 1);
  });
});

test("iptables 命令都带锁等待占位", () => {
  const commands = [
    ...buildIptablesForwardCmds(sharedTargetRule(7, 1007)),
    ...buildCountingChainCmds(1007, "10.0.0.9", 80, "tcp", "iptables"),
  ].join("\n");
  const bare = (commands.match(/\bip6?tables [^\n;]{0,16}/g) || [])
    .filter((item) => !item.includes("$FWX_IPT_WAIT") && !/^ip6?tables >/.test(item));
  assert.deepEqual(bare, []);
});
