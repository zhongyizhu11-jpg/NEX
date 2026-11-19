#!/usr/bin/env bash
# 「出口全挂时流量不许绕过隧道」回归（nex6，gost-runtime/nex-selector-noempty.patch）。
#
# 上游 gost 的毛病：一跳里有两个以上节点时，失败过滤器把「还在 failTimeout 里的失败节点」全筛掉，
# 筛完是空的 → 选择器什么都不返回 → 这条路由里没有节点 → gost 当成「不走链」，由入口机直接去拨转发目标
# （多跳时是上一跳的中转机去拨）。出口全挂的那 5–15 秒里，新连接就这样绕过隧道出去了。
#
# 这个脚本在回环上起真实的 gost 进程把它演出来。目标端（peerlog）记下每条连接 / 每个 UDP 包是谁拨来的：
#   入口 gost 自己拨出去是 127.0.0.1；出口 1 / 出口 2 / 中转各自绑了 127.0.0.11 / .12 / .13 往外拨。
# 所以目标看到 127.0.0.1（多跳时 127.0.0.13）就是绕过了隧道。
#
# 用法：gost-runtime/test/bypass-check/run.sh <gost 二进制>
#       BYPASS_EXPECT=bug 时反过来断言「确实绕过了」，拿来在 nex5 以前的运行时 / 官方 gost 上证明这个毛病存在
#       （场景 g 的毛病 nex6 的第一版补丁里还在，见 nex-selector-noempty.patch 的第 3 层）。
#
# 场景（配置和面板下发的一样：relay 连接器 nodelay、maxFails 1、handler.retries = 出口数 - 1、dialTimeout 3s）：
#   a. 单跳两出口，round，failTimeout 15s，TCP
#   b. 单跳两出口，fifo，failTimeout 5s，TCP（主备 / 延迟优先）
#   c. 单跳两出口，round，UDP
#   d. 多跳：中转一台 + 出口两台（round），TCP —— 绕过时是中转机去拨目标
#   e. 多跳：中转一台 + 出口两台（round），UDP
#   f. 跳上配了 bypass、目标命中：本来就该直连，补丁前后都必须还是直连（没把正常的直连路径堵掉）
#   g. 经 API 改链路时链路暂时没注册（updateChain = 先注销再注册；deleteChain；重载）：TCP、UDP 都不许直连。
#      删掉链路 → 连着试 4 次一次都不许通、目标收不到；加回来 → 马上通、只看到出口；
#      再一边反复 PUT 改链路一边试 10 次：可以有不通的，但目标不许收到入口直接拨来的。
# a–e 每个场景：
#   1. 两台出口都在：通，目标只看到出口的地址；
#   2. 杀掉两台出口：连着试 6 次（都在 failTimeout 里），一次都不许通、目标一条连接都不许收到；
#   3. 拉起出口 1：马上能通（不用等 failTimeout 过去），目标只看到出口 1 的地址。
set -euo pipefail

GOST="${1:?usage: run.sh <gost-binary>}"
GOST="$(cd "$(dirname "$GOST")" && pwd)/$(basename "$GOST")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPECT="${BYPASS_EXPECT:-fixed}"
WORK="$(mktemp -d)"
declare -A PID=()
TARGET_PID=""
cleanup() {
  for p in "${PID[@]:-}" "$TARGET_PID"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

(cd "$HERE/peerlog" && go build -o "$WORK/peerlog" .)
"$GOST" -V

# 端口：目标 T、出口 X1 / X2、中转 R、入口 E、入口的 gost API
T=28721; X1=28722; X2=28723; R=28724; E=28725; API=28726
ENTRY_IP=127.0.0.1; X1_IP=127.0.0.11; X2_IP=127.0.0.12; R_IP=127.0.0.13
USER_=fwx-test; PASS_=secret-test
HOP_USER=fwx-hop-test; HOP_PASS=secret-hop
PEERS="$WORK/peers.log"
FAILED=0

start_gost() { # name
  local name="$1"
  "$GOST" -C "$WORK/$name.json" >> "$WORK/$name.log" 2>&1 &
  PID[$name]="$!"
  for _ in $(seq 1 50); do
    grep -q 'listening on' "$WORK/$name.log" 2>/dev/null && return 0
    sleep 0.1
  done
  echo "gost $name did not start:"; cat "$WORK/$name.log"; exit 1
}
stop_gost() { # name...
  local name
  for name in "$@"; do
    [ -n "${PID[$name]:-}" ] || continue
    kill "${PID[$name]}" 2>/dev/null || true
    wait "${PID[$name]}" 2>/dev/null || true
    PID[$name]=""
    : > "$WORK/$name.log"
  done
}
stop_all() { stop_gost entry exit1 exit2 relay; }

probe() { # proto -> 0 通 / 1 不通
  "$WORK/peerlog" probe -proto "$1" -dial "127.0.0.1:$E" -timeout 4s >/dev/null 2>&1
}
peers() { # proto -> 目标看到的对端地址（去重，一行）
  { grep "^$1 " "$PEERS" 2>/dev/null || true; } | awk '{print $2}' | sort -u | tr '\n' ' ' | sed 's/ $//'
}
peer_count() { # proto ip
  { grep -c "^$1 $2\$" "$PEERS" 2>/dev/null || true; } | head -1
}
fail() { echo "  FAIL: $*"; FAILED=1; }

exit_config() { # name port bindIP
  cat > "$WORK/$1.json" <<EOF
{"services":[{"name":"$1","addr":"127.0.0.1:$2","interface":"$3",
  "handler":{"type":"relay","auth":{"username":"$USER_","password":"$PASS_"},"metadata":{"nodelay":true}},
  "listener":{"type":"tcp"}}]}
EOF
}
relay_config() {
  cat > "$WORK/relay.json" <<EOF
{"services":[{"name":"relay","addr":"127.0.0.1:$R","interface":"$R_IP",
  "handler":{"type":"relay","auth":{"username":"$HOP_USER","password":"$HOP_PASS"},"metadata":{"nodelay":true}},
  "listener":{"type":"tcp"}}]}
EOF
}
exit_node() { # name port
  echo "{\"name\":\"$1\",\"addr\":\"127.0.0.1:$2\",\"connector\":{\"type\":\"relay\",\"auth\":{\"username\":\"$USER_\",\"password\":\"$PASS_\"},\"metadata\":{\"nodelay\":true}},\"dialer\":{\"type\":\"tcp\"}}"
}
chain_json() { # strategy failTimeout multihop(0|1) bypass(0|1)
  local strategy="$1" fail_timeout="$2" multihop="$3" bypass="$4"
  local relay_hop="" hop_bypass=""
  if [ "$multihop" = 1 ]; then
    relay_hop="{\"name\":\"hop-relay\",\"nodes\":[{\"name\":\"relay\",\"addr\":\"127.0.0.1:$R\",\"connector\":{\"type\":\"relay\",\"auth\":{\"username\":\"$HOP_USER\",\"password\":\"$HOP_PASS\"},\"metadata\":{\"nodelay\":true}},\"dialer\":{\"type\":\"tcp\"}}]},"
  fi
  [ "$bypass" = 1 ] && hop_bypass="\"bypass\":\"direct-target\","
  echo "{\"name\":\"tunnel\",\"hops\":[$relay_hop{\"name\":\"hop-exit\",$hop_bypass\"selector\":{\"strategy\":\"$strategy\",\"maxFails\":1,\"failTimeout\":\"$fail_timeout\"},\"nodes\":[$(exit_node exit1 "$X1"),$(exit_node exit2 "$X2")]}]}"
}
entry_config() { # proto strategy failTimeout multihop(0|1) bypass(0|1) [api(0|1)]
  local proto="$1" strategy="$2" fail_timeout="$3" multihop="$4" bypass="$5" api="${6:-0}"
  local bypasses="" api_cfg=""
  [ "$bypass" = 1 ] && bypasses=",\"bypasses\":[{\"name\":\"direct-target\",\"matchers\":[\"127.0.0.1\"]}]"
  [ "$api" = 1 ] && api_cfg=",\"api\":{\"addr\":\"127.0.0.1:$API\"}"
  cat > "$WORK/entry.json" <<EOF
{"services":[{"name":"entry","addr":"127.0.0.1:$E",
  "handler":{"type":"$proto","chain":"tunnel","retries":1},
  "listener":{"type":"$proto"},
  "metadata":{"dialTimeout":"3s"},
  "forwarder":{"nodes":[{"name":"target","addr":"127.0.0.1:$T","connector":{"type":"$proto"},"dialer":{"type":"$proto"}}]}}],
 "chains":[$(chain_json "$strategy" "$fail_timeout" "$multihop" "$bypass")]$bypasses$api_cfg}
EOF
}
api_call() { # method path [json]
  if [ -n "${3:-}" ]; then
    curl -fsS -m 5 -X "$1" -H 'Content-Type: application/json' -d "$3" "http://127.0.0.1:$API/config$2" >/dev/null
  else
    curl -fsS -m 5 -X "$1" "http://127.0.0.1:$API/config$2" >/dev/null
  fi
}

"$WORK/peerlog" serve -listen "127.0.0.1:$T" -log "$PEERS" > "$WORK/target.log" 2>&1 &
TARGET_PID="$!"
for _ in $(seq 1 50); do grep -q 'listening on' "$WORK/target.log" 2>/dev/null && break; sleep 0.1; done
grep -q 'listening on' "$WORK/target.log" || { echo "target did not start:"; cat "$WORK/target.log"; exit 1; }

exit_config exit1 "$X1" "$X1_IP"
exit_config exit2 "$X2" "$X2_IP"
relay_config

scenario() { # title proto strategy failTimeout multihop
  local title="$1" proto="$2" strategy="$3" fail_timeout="$4" multihop="$5"
  # 绕过时去拨目标的是谁：单跳是入口，多跳是中转
  local leak_ip="$ENTRY_IP"; [ "$multihop" = 1 ] && leak_ip="$R_IP"
  local i ok seen leaked
  echo "=== $title"
  entry_config "$proto" "$strategy" "$fail_timeout" "$multihop" 0
  : > "$PEERS"
  start_gost exit1; start_gost exit2
  [ "$multihop" = 1 ] && start_gost relay
  start_gost entry

  ok=0
  for i in 1 2 3 4; do probe "$proto" && ok=$((ok + 1)); done
  seen="$(peers "$proto")"
  echo "  1. 出口都在：4 次通了 $ok 次，目标看到的对端：[$seen]"
  [ "$ok" = 4 ] || fail "出口都在时不通"
  case "$seen" in
    "$X1_IP"|"$X2_IP"|"$X1_IP $X2_IP") ;;
    *) fail "出口都在时目标看到了不是出口的地址：[$seen]" ;;
  esac

  stop_gost exit1 exit2
  : > "$PEERS"
  ok=0
  for i in 1 2 3 4 5 6; do
    if probe "$proto"; then ok=$((ok + 1)); fi
    sleep 0.3
  done
  sleep 0.3
  seen="$(peers "$proto")"
  leaked="$(peer_count "$proto" "$leak_ip")"
  echo "  2. 出口全挂：6 次通了 $ok 次，目标看到的对端：[$seen]（其中来自 $leak_ip 的 $leaked 条 = 绕过隧道）"
  if [ "$EXPECT" = bug ]; then
    if [ "$leaked" -gt 0 ]; then echo "  BUG REPRODUCED：出口全挂时目标收到了 $leak_ip 直接拨来的 $leaked 条"; else fail "没有复现绕过"; fi
    stop_all
    return 0
  fi
  [ "$ok" = 0 ] || fail "出口全挂时居然通了 $ok 次"
  [ -z "$seen" ] || fail "出口全挂时目标收到了连接：[$seen]"

  : > "$PEERS"
  start_gost exit1
  ok=0
  for i in $(seq 1 6); do
    if probe "$proto"; then ok=$((ok + 1)); fi
    sleep 0.3
  done
  seen="$(peers "$proto")"
  echo "  3. 出口 1 回来：试了 $i 次通了 $ok 次，目标看到的对端：[$seen]"
  [ "$ok" -ge 1 ] || fail "出口 1 回来后还是不通"
  [ "$seen" = "$X1_IP" ] || fail "出口 1 回来后目标看到的不只是出口 1：[$seen]"
  stop_all
}

scenario "a. 单跳两出口 round / failTimeout 15s / TCP" tcp round 15s 0
scenario "b. 单跳两出口 fifo / failTimeout 5s / TCP" tcp fifo 5s 0
scenario "c. 单跳两出口 round / failTimeout 15s / UDP" udp round 15s 0
scenario "d. 多跳（中转 + 两出口）round / failTimeout 15s / TCP" tcp round 15s 1
scenario "e. 多跳（中转 + 两出口）round / failTimeout 15s / UDP" udp round 15s 1

echo "=== f. 跳上的 bypass 命中目标：本来就该直连（补丁前后都一样）"
for proto in tcp udp; do
  entry_config "$proto" round 15s 0 1
  : > "$PEERS"
  start_gost entry
  ok=0
  for i in 1 2 3; do probe "$proto" && ok=$((ok + 1)); done
  seen="$(peers "$proto")"
  echo "  ${proto}：3 次通了 $ok 次，目标看到的对端：[$seen]"
  [ "$ok" = 3 ] || fail "bypass 命中时 $proto 不通"
  [ "$seen" = "$ENTRY_IP" ] || fail "bypass 命中时 $proto 不是入口直连：[$seen]"
  stop_all
done

echo "=== g. 经 API 改链路时链路暂时没注册：不许直连（updateChain = 先注销再注册、deleteChain）"
for proto in tcp udp; do
  entry_config "$proto" round 15s 0 0 1
  : > "$PEERS"
  start_gost exit1; start_gost exit2; start_gost entry
  ok=0
  for i in 1 2; do probe "$proto" && ok=$((ok + 1)); done
  echo "  ${proto} 1. 链路在：2 次通了 $ok 次，目标看到的对端：[$(peers "$proto")]"
  [ "$ok" = 2 ] || fail "链路在时 $proto 不通"

  api_call DELETE /chains/tunnel || fail "API 删链路失败"
  : > "$PEERS"
  ok=0
  for i in 1 2 3 4; do probe "$proto" && ok=$((ok + 1)); done
  sleep 0.3
  seen="$(peers "$proto")"; leaked="$(peer_count "$proto" "$ENTRY_IP")"
  echo "  ${proto} 2. 链路删了：4 次通了 $ok 次，目标看到的对端：[$seen]（其中来自 $ENTRY_IP 的 $leaked 条 = 绕过隧道）"
  if [ "$EXPECT" = bug ]; then
    if [ "$leaked" -gt 0 ]; then echo "  BUG REPRODUCED：链路没注册时目标收到了入口直接拨来的 $leaked 条"; else fail "没有复现绕过"; fi
  else
    [ "$ok" = 0 ] || fail "链路删了居然通了 $ok 次"
    [ -z "$seen" ] || fail "链路删了目标收到了连接：[$seen]"
  fi

  api_call POST /chains "$(chain_json round 15s 0 0)" || fail "API 加回链路失败"
  : > "$PEERS"
  ok=0
  for i in 1 2; do probe "$proto" && ok=$((ok + 1)); done
  seen="$(peers "$proto")"
  echo "  ${proto} 3. 链路加回来：2 次通了 $ok 次，目标看到的对端：[$seen]"
  [ "$ok" = 2 ] || fail "链路加回来后 $proto 不通"
  case "$seen" in
    "$X1_IP"|"$X2_IP"|"$X1_IP $X2_IP") ;;
    *) fail "链路加回来后目标看到了不是出口的地址：[$seen]" ;;
  esac

  # 一边反复 PUT 改链路（每次都先注销再注册），一边连：不通可以，绕过不行。
  : > "$PEERS"
  (for i in $(seq 1 200); do api_call PUT /chains/tunnel "$(chain_json round 15s 0 0)" || true; done) &
  churn=$!
  ok=0
  for i in $(seq 1 10); do probe "$proto" && ok=$((ok + 1)); done
  wait "$churn" 2>/dev/null || true
  sleep 0.3
  seen="$(peers "$proto")"; leaked="$(peer_count "$proto" "$ENTRY_IP")"
  echo "  ${proto} 4. 反复改链路时：10 次通了 $ok 次，目标看到的对端：[$seen]（其中来自 $ENTRY_IP 的 $leaked 条 = 绕过隧道）"
  [ "$EXPECT" = bug ] || [ "$leaked" = 0 ] || fail "改链路时目标收到了入口直接拨来的 $leaked 条"
  stop_all
done

if [ "$FAILED" != 0 ]; then
  echo "FAILED"
  exit 1
fi
if [ "$EXPECT" = bug ]; then echo "BUG REPRODUCED IN ALL SCENARIOS"; else echo "ALL OK"; fi
