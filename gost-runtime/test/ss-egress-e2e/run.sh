#!/usr/bin/env bash
# Shadowsocks 出口端到端测试：真 gost 运行时（入口）→ 真 sing-box（落地）→ 目标服务。见同目录 README.md。
#
# 用法（仓库根目录或任意目录）：
#   gost-runtime/test/ss-egress-e2e/run.sh <gost 运行时二进制>
# 环境变量：
#   SING_BOX=<sing-box 二进制>   不给就下载官方 1.14.0 到 ~/.cache/nex-ss-egress-e2e/
#   SOAK_SECONDS=600             长稳测试时长（秒）；0 跳过
#   SOAK_PPS=200                 长稳测试每个方法的包速
#   SOAK_METHODS="aes-256-gcm 2022-blake3-aes-128-gcm"
#   IDLE_SECONDS=45              空闲多久后再恢复发包（要大于面板下发的 UDP 监听 ttl 30s）
#   SKIP_SPLICE=1                跳过 splice-check.sh 回归
#   RESULTS=<文件>               结果行另存一份
set -uo pipefail

GOST="${1:?usage: run.sh <gost-runtime-binary>}"
GOST="$(cd "$(dirname "$GOST")" && pwd)/$(basename "$GOST")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SING_BOX_VERSION="${SING_BOX_VERSION:-1.14.0}"
SOAK_SECONDS="${SOAK_SECONDS:-600}"
SOAK_PPS="${SOAK_PPS:-200}"
SOAK_METHODS="${SOAK_METHODS:-aes-256-gcm 2022-blake3-aes-128-gcm}"
IDLE_SECONDS="${IDLE_SECONDS:-45}"
WORK="$(mktemp -d)"
PIDS=()
FAILS=0
RESULTS_FILE="${RESULTS:-$WORK/results.txt}"
: > "$RESULTS_FILE"

cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  [ -n "${KEEP_WORK:-}" ] && echo "work dir kept: $WORK" || rm -rf "$WORK"
}
trap cleanup EXIT

log() { printf '[e2e] %s\n' "$*"; }
record() { # 名字 命令...
  local name="$1"; shift
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  printf '%s\n' "$out" | grep -E '^(RESULT|FAIL|sample)' | sed "s/^/[$name] /"
  printf '%s\n' "$out" | grep '^RESULT' >> "$RESULTS_FILE"
  if [ "$rc" != 0 ]; then
    # 失败记进结果文件（后台跑的 record 改不了父 shell 的变量），最后统一数。
    echo "FAIL $name rc=$rc" >> "$RESULTS_FILE"
    printf '%s\n' "$out" | tail -5
  fi
  return 0
}

# ── 二进制 ─────────────────────────────────────────────────────────────
if [ -z "${SING_BOX:-}" ]; then
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/nex-ss-egress-e2e"
  SING_BOX="$CACHE/sing-box-${SING_BOX_VERSION}-linux-amd64/sing-box"
  if [ ! -x "$SING_BOX" ]; then
    mkdir -p "$CACHE"
    log "downloading sing-box ${SING_BOX_VERSION}"
    curl -fsSL --retry 3 -o "$CACHE/sing-box.tgz" \
      "https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-amd64.tar.gz"
    tar -xzf "$CACHE/sing-box.tgz" -C "$CACHE"
  fi
fi
"$GOST" -V
"$SING_BOX" version | head -1
(cd "$HERE/tool" && GOTOOLCHAIN="${GOTOOLCHAIN:-local}" go build -o "$WORK/tool" .) || { echo "tool build failed"; exit 1; }
T="$WORK/tool"

# ── 用面板代码生成配置 ─────────────────────────────────────────────────
ECHO_PORT=29500; DNS_PORT=29553; QUIC_PORT=29443; PPROF_PORT=29660
log "generating configs with the panel code paths"
(cd "$REPO" && OUT="$WORK" FORWARDX_TEST_DB="$WORK/e2e.db" DATABASE_TYPE=sqlite \
  TARGET_TCP_UDP=$ECHO_PORT TARGET_DNS=$DNS_PORT TARGET_QUIC=$QUIC_PORT \
  node --import tsx "$HERE/gen-configs.mjs" > "$WORK/gen.log" 2>&1) || { cat "$WORK/gen.log"; exit 1; }
# 只为采样 goroutine 数加一个 profiling 监听（不影响转发路径）。
node -e '
  const fs = require("fs"); const f = process.argv[1];
  const cfg = JSON.parse(fs.readFileSync(f, "utf8")); cfg.profiling = { addr: "127.0.0.1:" + process.argv[2] };
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
' "$WORK/gost.json" "$PPROF_PORT"
plan() { node -e 'const p=require(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],p); console.log(typeof v==="object"?JSON.stringify(v):v)' "$WORK/plan.json" "$1"; }
METHODS="$(node -e 'console.log(Object.keys(require(process.argv[1]).methods).join(" "))' "$WORK/plan.json")"

# ── 起进程 ─────────────────────────────────────────────────────────────
"$T" serve -udp-echo 127.0.0.1:$ECHO_PORT -tcp-echo 127.0.0.1:$ECHO_PORT -dns 127.0.0.1:$DNS_PORT -quic 127.0.0.1:$QUIC_PORT > "$WORK/serve.log" 2>&1 &
PIDS+=("$!")
"$SING_BOX" run -c "$WORK/singbox.json" > "$WORK/singbox.log" 2>&1 &
PIDS+=("$!")
"$GOST" -C "$WORK/gost.json" > "$WORK/gost.log" 2>&1 &
GOST_PID=$!
PIDS+=("$GOST_PID")
for _ in $(seq 1 100); do
  grep -q "listening on" "$WORK/gost.log" 2>/dev/null && grep -q serving "$WORK/serve.log" 2>/dev/null && break
  sleep 0.1
done
sleep 1
kill -0 "$GOST_PID" 2>/dev/null || { echo "gost exited:"; tail -20 "$WORK/gost.log"; exit 1; }
log "gost pid=$GOST_PID methods: $METHODS"

# ── 每个方法：UDP 回声 / DNS / QUIC / TCP / 只走 TCP 的出口 ─────────────────
for m in $METHODS; do
  echo_port="$(plan "methods.$m.echoPort")"; dns_port="$(plan "methods.$m.dnsPort")"
  quic_port="$(plan "methods.$m.quicPort")"; tcp_port="$(plan "methods.$m.tcpOnlyPort")"
  record "$m" "$T" udp -addr 127.0.0.1:$echo_port -count 200 -label "udp-echo/$m"
  record "$m" "$T" dns -addr 127.0.0.1:$dns_port -n 200 -label "dns/$m"
  record "$m" "$T" quic -addr 127.0.0.1:$quic_port -conns 3 -streams 8 -bytes 1048576 -label "quic/$m"
  record "$m" "$T" tcp -addr 127.0.0.1:$echo_port -conns 16 -bytes 4194304 -label "tcp-egress/$m"
  record "$m" "$T" tcp -addr 127.0.0.1:$tcp_port -conns 16 -bytes 4194304 -label "tcp-only-egress/$m"
done
link_port="$(plan link.port)"; link_method="$(plan link.method)"
record link "$T" udp -addr 127.0.0.1:$link_port -count 200 -label "udp-echo/ss-link-$link_method"
record link "$T" tcp -addr 127.0.0.1:$link_port -conns 8 -bytes 4194304 -label "tcp-egress/ss-link-$link_method"
plain_port="$(plan plain.port)"
record plain "$T" udp -addr 127.0.0.1:$plain_port -count 200 -label "udp-plain-no-egress"
record plain "$T" tcp -addr 127.0.0.1:$plain_port -conns 16 -bytes 4194304 -label "tcp-plain-no-egress"

# ── 并发：200 个 UDP 流 + 同时 32 条 TCP ──────────────────────────────────
for m in aes-256-gcm 2022-blake3-aes-128-gcm; do
  echo_port="$(plan "methods.$m.echoPort")"
  [ "$echo_port" = "undefined" ] && continue
  record "concurrency-$m" "$T" tcp -addr 127.0.0.1:$echo_port -conns 32 -bytes 2097152 -label "concurrent-tcp/$m" &
  bg=$!
  record "concurrency-$m" "$T" flows -addr 127.0.0.1:$echo_port -flows 200 -rounds 20 -label "flows-200/$m"
  wait "$bg"
done

# ── 能力闸门：没能力的入口机（面板代码生成的那份 gost.json）────────────────
node -e '
  const p = require(process.argv[1]); const g = p.gating; const errs = [];
  if (!/UDP 走 Shadowsocks 出口/.test(g.udpSaveOnOldHost)) errs.push("UDP egress was saved on a host without the capability: " + g.udpSaveOnOldHost);
  if (!/SS2022/.test(g.ss2022SaveOnOldHost)) errs.push("SS2022 egress was saved on a host without the capability: " + g.ss2022SaveOnOldHost);
  if (g.oldHostChains.some((c) => /:ssu$/.test(c))) errs.push("host without capability received an ssu chain");
  if (g.oldHostServices.some((s) => s.startsWith("fwx-9900-"))) errs.push("UDP egress rule delivered to a host without the capability");
  if (!g.oldHostServices.includes("fwx-" + g.oldHostTcpRuleId + "-tcp")) errs.push("classic TCP egress missing on old host");
  if (g.oldHostUdpRuleState?.state !== "udp_runtime_upgrade" || g.oldHostUdpRuleState?.udp !== false) errs.push("card state for the old host UDP rule: " + JSON.stringify(g.oldHostUdpRuleState));
  if (g.oldHostTcpRuleState !== "running") errs.push("classic TCP egress on old host state " + g.oldHostTcpRuleState);
  if (g.newHostUdpRuleState?.state !== "running" || g.newHostUdpRuleState?.udp !== true) errs.push("card state on capable host: " + JSON.stringify(g.newHostUdpRuleState));
  const line = "RESULT gating udp_save_rejected=" + /UDP/.test(g.udpSaveOnOldHost) + " ss2022_save_rejected=" + /SS2022/.test(g.ss2022SaveOnOldHost) +
    " old_host_services=" + g.oldHostServices.join(",") + " old_host_chains=" + g.oldHostChains.join(",") + " old_host_udp_rule_state=" + g.oldHostUdpRuleState?.state + " capable_host_state=" + g.newHostUdpRuleState?.state + "/udp=" + g.newHostUdpRuleState?.udp;
  console.log(line); if (errs.length) { console.log("FAIL " + errs.join("; ")); process.exit(1); }
' "$WORK/plan.json" > "$WORK/gating.txt" 2>&1 || FAILS=$((FAILS + 1))
sed 's/^/[gating] /' "$WORK/gating.txt"; grep '^RESULT' "$WORK/gating.txt" >> "$RESULTS_FILE"

# ── 长稳：持续 UDP + 进程资源采样 + 空闲后恢复 ─────────────────────────────
if [ "$SOAK_SECONDS" -gt 0 ]; then
  log "soak ${SOAK_SECONDS}s at ${SOAK_PPS} pps per method: $SOAK_METHODS"
  soak_pids=()
  first=1
  for m in $SOAK_METHODS; do
    echo_port="$(plan "methods.$m.echoPort")"
    sample_args=()
    # 只让第一个 soak 采样进程资源（两个一起采样数字一样，日志重复）。
    [ "$first" = 1 ] && sample_args=(-pid "$GOST_PID" -pprof "http://127.0.0.1:$PPROF_PORT")
    first=0
    record "soak-$m" "$T" soak -addr 127.0.0.1:$echo_port -duration "${SOAK_SECONDS}s" -pps "$SOAK_PPS" -flows 4 -payload 512 \
      -idle "${IDLE_SECONDS}s" -sample 60s "${sample_args[@]}" -label "soak/$m" &
    soak_pids+=("$!")
  done
  for p in "${soak_pids[@]}"; do wait "$p"; done
fi

kill -0 "$GOST_PID" 2>/dev/null || { echo "gost died during the run"; FAILS=$((FAILS + 1)); }
if grep -qE "panic|fatal error" "$WORK/gost.log"; then echo "gost log has panic"; grep -nE "panic|fatal error" "$WORK/gost.log" | head; FAILS=$((FAILS + 1)); fi
echo "sing-box errors: $(grep -c ERROR "$WORK/singbox.log" || true)"
grep ERROR "$WORK/singbox.log" | sed 's/\x1b\[[0-9;]*m//g' | awk '{$1=$2=""; print}' | sort | uniq -c | sort -rn | head -5

# ── 回归：自编 gost 原有的 splice / TCP 转发 ─────────────────────────────
if [ -z "${SKIP_SPLICE:-}" ]; then
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  PIDS=()
  if bash "$REPO/gost-runtime/test/splice-check.sh" "$GOST" > "$WORK/splice.log" 2>&1; then
    echo "RESULT splice-check ok=1 $(grep -c 'splice 日志行数' "$WORK/splice.log") scenarios" | tee -a "$RESULTS_FILE"
  else
    FAILS=$((FAILS + 1)); echo "FAIL splice-check"; tail -20 "$WORK/splice.log"
  fi
fi

echo
echo "================ results ================"
cat "$RESULTS_FILE"
FAILS=$((FAILS + $(grep -c '^FAIL' "$RESULTS_FILE" || true)))
echo "failures: $FAILS"
[ "$FAILS" = 0 ]
