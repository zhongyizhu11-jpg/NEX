import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildIptablesForwardCleanupCmds,
  buildIptablesForwardCmds,
  buildKernelForwardCmds,
  buildKernelForwardTransitionCleanupCmds,
  buildManagedPortCleanupCmds,
  buildNftCleanupCmds,
  buildNftForwardCmds,
} from "./agentActionCommands";
import { buildDockerForwardCompatCleanupCmds, buildDockerForwardCompatCmds, dockerCompatTargetTag } from "./dockerForwardCompat";

/*
  DOCKER-USER 放行的命令：注释格式是和 Agent（agent/docker_forward_compat.go）共用的契约；
  再用一个假的 iptables-nft / iptables-legacy（规则存成文本）真跑一遍生成的 shell，
  看「先装新的、再删旧的」、管理员规则在前、链尾 RETURN 在后、只动 FORWARD DROP + DOCKER-USER 的前端。
*/

const rule = { id: 42, sourcePort: 22022, targetIp: "203.0.113.10", targetPort: 443, protocol: "both" };
const tag = createHash("sha1").update("203.0.113.10:443").digest("hex").slice(0, 8);

test("注释带规则、入口端口、协议、方向和目标摘要", () => {
  assert.equal(dockerCompatTargetTag("203.0.113.10", 443), tag);
  const script = buildDockerForwardCompatCmds(rule).join("\n");
  for (const proto of ["tcp", "udp"]) {
    assert.ok(script.includes(`-p ${proto} -d 203.0.113.10 --dport 443 -m conntrack --ctorigdstport 22022 -m comment --comment fwx-docker-42-22022-${proto}-in-${tag} -j ACCEPT`), script);
    assert.ok(script.includes(`-p ${proto} -s 203.0.113.10 --sport 443 -m conntrack --ctorigdstport 22022 --ctdir REPLY --ctstate ESTABLISHED,RELATED -m comment --comment fwx-docker-42-22022-${proto}-out-${tag} -j ACCEPT`), script);
  }
  assert.match(script, /\[docker-compat\]/);
  assert.match(script, /\$FWX_IPT_WAIT/);
});

test("IPv6 / 没解析的目标不装放行，只收掉以前留下的", () => {
  for (const targetIp of ["2001:db8::1", "example.com"]) {
    const script = buildDockerForwardCompatCmds({ ...rule, targetIp }).join("\n");
    assert.doesNotMatch(script, /fwx_dc_ensure "\$fwx_dc_b" -p/);
    assert.match(script, /fwx_dc_prune/);
  }
});

test("内核转发构造器带上放行，清理路径删掉放行，原地重建和两种内核转发互换时不删", () => {
  const has = (cmds: string[], marker: string) => cmds.some((cmd) => cmd.includes(marker));
  const ensure = "fwx_dc_ensure \"$fwx_dc_b\" -p";
  const prune = "fwx_dc_prune \"$fwx_dc_b\" '--comment";
  for (const cmds of [buildNftForwardCmds(rule), buildIptablesForwardCmds(rule), buildKernelForwardCmds(rule, "iptables"), buildKernelForwardCmds(rule, "nftables")]) {
    assert.ok(has(cmds, ensure));
    // 只有最后那一段（先装后删）里有 prune：前面的清理不能先把放行删掉。
    const firstPrune = cmds.findIndex((cmd) => cmd.includes(prune));
    const firstEnsure = cmds.findIndex((cmd) => cmd.includes(ensure));
    assert.equal(firstPrune, firstEnsure, "放行的删除只能和安装在同一段里、排在安装之后");
  }
  assert.ok(has(buildNftCleanupCmds(rule), prune));
  assert.ok(has(buildIptablesForwardCleanupCmds(rule), prune));
  assert.ok(has(buildKernelForwardTransitionCleanupCmds(rule), prune));
  assert.ok(has(buildManagedPortCleanupCmds(22022, undefined, undefined, "tcp"), prune));
  assert.equal(buildDockerForwardCompatCleanupCmds({}).length, 0);
});

/** 假的 iptables 前端：每张表一个文件，存 -P / -N / -A 行；restore 支持 *filter 里的 -D，一次事务。 */
const FAKE_FRONT = String.raw`#!/bin/sh
name=$(basename "$0")
dir="$FAKE_IPT_DIR/${"${name%-restore}"}"; mkdir -p "$dir"
f="$dir/filter"; touch "$f"
case "$name" in
  *-restore)
    input=$(cat)
    tmp="$f.restore"; cp "$f" "$tmp"
    printf '%s\n' "$input" | while IFS= read -r line; do
      case "$line" in
        -D\ *) want="-A ${"${line#-D }"}"
               grep -qxF -- "$want" "$tmp" || { echo "Bad rule: $line" >&2; exit 1; }
               awk -v l="$want" '!done && $0 == l {done = 1; next} {print}' "$tmp" > "$tmp.n" && mv "$tmp.n" "$tmp" ;;
      esac
    done || { rm -f "$tmp"; exit 1; }
    mv "$tmp" "$f"; exit 0 ;;
esac
[ -n "$FAKE_FRONT_FAIL" ] && [ "$FAKE_FRONT_FAIL" = "$name" ] && exit 1
while [ $# -gt 0 ]; do
  case "$1" in
    -w) shift; case "$1" in [0-9]*) shift ;; esac ;;
    -t) shift 2 ;;
    *) break ;;
  esac
done
op=$1; shift
case "$op" in
  -S) if [ -n "$1" ]; then grep -q -x -e "-N $1" -e "-P $1 .*" "$f" || { echo "No chain/target/match by that name." >&2; exit 1; }; grep -e "^-P $1 " -e "^-N $1\$" -e "^-A $1 " "$f"; else cat "$f"; fi; exit 0 ;;
  -C) chain=$1; shift; grep -qxF -- "-A $chain $*" "$f" && exit 0; exit 1 ;;
  -A) chain=$1; shift; echo "-A $chain $*" >> "$f" ;;
  -I) chain=$1; shift; pos=1; case "$1" in [0-9]*) pos=$1; shift ;; esac
      awk -v c="-A $chain " -v n="$pos" -v l="-A $chain $*" 'index($0, c) == 1 {k++; if (k == n) print l} {print} END {if (k < n) print l}' "$f" > "$f.tmp"; mv "$f.tmp" "$f" ;;
esac
exit 0
`;

type Front = "iptables-nft" | "iptables-legacy";

function withFakeFronts(
  layout: Partial<Record<Front, string>>,
  run: (exec: (commands: string[], env?: Record<string, string>) => { status: number; stderr: string }, read: (front: Front) => string[]) => void,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-fake-docker-"));
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  for (const front of ["iptables-nft", "iptables-legacy", "iptables-nft-restore", "iptables-legacy-restore"]) {
    fs.writeFileSync(path.join(bin, front), FAKE_FRONT, { mode: 0o755 });
  }
  // 普通 iptables 只给 -S 用：测试里不该被调到真的。
  fs.writeFileSync(path.join(bin, "iptables"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  for (const [front, content] of Object.entries(layout)) {
    fs.mkdirSync(path.join(state, front), { recursive: true });
    fs.writeFileSync(path.join(state, front, "filter"), `${String(content).trim()}\n`);
  }
  // 测试机上的 /proc/net/ip_tables_names 和假前端无关：改成「layout 里给了 legacy 才算已加载」。
  const exec = (commands: string[], env: Record<string, string> = {}) => {
    let status = 0;
    let stderr = "";
    for (const command of commands) {
      const patched = command.replace(
        "! grep -qx filter /proc/net/ip_tables_names 2>/dev/null",
        `! [ -f "$FAKE_IPT_DIR/iptables-legacy/filter" ]`,
      );
      const result = spawnSync("sh", ["-c", patched], {
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FAKE_IPT_DIR: state, FWX_IPT_WAIT: "-w 5", ...env },
        encoding: "utf8",
      });
      if (result.status !== 0) status = result.status ?? 1;
      stderr += result.stderr || "";
    }
    return { status, stderr };
  };
  const read = (front: Front) => {
    const file = path.join(state, front, "filter");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
  };
  try {
    run(exec, read);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DOCKER_LAYOUT = [
  "-P FORWARD DROP",
  "-N DOCKER-USER",
  "-A FORWARD -j DOCKER-USER",
  "-A FORWARD -j DOCKER-FORWARD",
  "-A DOCKER-USER -s 198.51.100.0/24 -j DROP",
  "-A DOCKER-USER -j RETURN",
].join("\n");

const allowances = (lines: string[]) => lines.filter((line) => line.includes("fwx-docker-"));

test("Docker 前端：放行排在管理员规则之后、RETURN 之前；没有 Docker 的前端不动", () => {
  withFakeFronts({ "iptables-nft": DOCKER_LAYOUT, "iptables-legacy": "-P FORWARD ACCEPT" }, (exec, read) => {
    const result = exec(buildDockerForwardCompatCmds(rule));
    assert.equal(result.status, 0, result.stderr);
    const lines = read("iptables-nft").filter((line) => line.startsWith("-A DOCKER-USER"));
    assert.equal(allowances(lines).length, 4, lines.join("\n"));
    assert.ok(lines[0].includes("198.51.100.0/24 -j DROP"), "管理员的拒绝仍然在最前");
    assert.equal(lines[lines.length - 1], "-A DOCKER-USER -j RETURN");
    assert.deepEqual(allowances(read("iptables-legacy")), []);

    // 再下一遍：已有的不重复、不重建。
    assert.equal(exec(buildDockerForwardCompatCmds(rule)).status, 0);
    assert.equal(allowances(read("iptables-nft")).length, 4);
  });
});

test("改目标 / 去掉协议：先装新的再删旧的；同端口的前任规则也收掉；删除只动 ForwardX 的放行", () => {
  withFakeFronts({ "iptables-nft": DOCKER_LAYOUT }, (exec, read) => {
    exec(buildDockerForwardCompatCmds({ id: 7, sourcePort: 22022, targetIp: "192.0.2.1", targetPort: 80, protocol: "tcp" }));
    exec(buildDockerForwardCompatCmds(rule));
    let current = allowances(read("iptables-nft"));
    assert.equal(current.length, 4, current.join("\n"));
    assert.ok(current.every((line) => line.includes(`fwx-docker-42-22022-`) && line.includes(tag)), current.join("\n"));

    exec(buildDockerForwardCompatCmds({ ...rule, targetIp: "203.0.113.20", protocol: "tcp" }));
    current = allowances(read("iptables-nft"));
    assert.equal(current.length, 2, current.join("\n"));
    assert.ok(current.every((line) => line.includes("203.0.113.20") && line.includes("-tcp-")), current.join("\n"));

    const result = exec(buildDockerForwardCompatCleanupCmds({ ruleId: 42, port: 22022, protocol: "tcp" }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(allowances(read("iptables-nft")), []);
    assert.ok(read("iptables-nft").includes("-A DOCKER-USER -s 198.51.100.0/24 -j DROP"));
    assert.ok(read("iptables-nft").includes("-A DOCKER-USER -j RETURN"));
  });
});

test("iptables-legacy 和 iptables-nft 各自判断：只给真的 DROP + DOCKER-USER 的那个装", () => {
  withFakeFronts({ "iptables-nft": "-P FORWARD ACCEPT", "iptables-legacy": DOCKER_LAYOUT }, (exec, read) => {
    assert.equal(exec(buildDockerForwardCompatCmds(rule)).status, 0);
    assert.equal(allowances(read("iptables-legacy")).length, 4);
    assert.deepEqual(allowances(read("iptables-nft")), []);
  });
});

test("装不上要以非零退出并说明原因，不吞掉", () => {
  // DOCKER-USER 不存在但 FORWARD 跳转它：-A 会失败。
  const broken = "-P FORWARD DROP\n-A FORWARD -j DOCKER-USER";
  withFakeFronts({ "iptables-nft": broken }, (exec) => {
    const failing = buildDockerForwardCompatCmds(rule).map((command) => command.replace(
      'fwx_dc_ensure() {\n  fwx_dc_front=$1; shift',
      'fwx_dc_ensure() {\n  return 1',
    ));
    const result = exec(failing);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\[docker-compat\] iptables-nft: cannot install DOCKER-USER allowance for rule 42 port 22022\/tcp \(in\)/);
  });
});

test("没有 Docker 的主机：什么都不做，正常退出", () => {
  withFakeFronts({ "iptables-nft": "-P FORWARD ACCEPT\n-A FORWARD -j ACCEPT" }, (exec, read) => {
    assert.equal(exec(buildDockerForwardCompatCmds(rule)).status, 0);
    assert.equal(exec(buildDockerForwardCompatCleanupCmds({ ruleId: 42 })).status, 0);
    assert.deepEqual(allowances(read("iptables-nft")), []);
  });
});
