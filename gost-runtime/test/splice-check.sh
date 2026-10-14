#!/usr/bin/env bash
# 自编 gost 的 splice 覆盖面回归：在回环上起真实的 gost 进程，灌 64 MB 随机数据做字节级比对，
# 再看日志里哪一端打了 splice:true。
#
# 用法：gost-runtime/test/splice-check.sh <gost 二进制> [字节数]
#       LENIENT=1 时 splice 日志对不上只报告不退出（用来看老版本的基线）。
#
# 三个场景：
#   a. TCP 模式隧道：tcp 监听 + relay 出口 → 目标；forward/local 入口带 chain（relay 连接器 + tcp 拨号）
#      期望：入口、出口都 splice:true，三个 SHA-256 一致。
#   b. 普通端口转发 + 发 PROXY v1 头：目标先读头再回声。期望：splice:true，头正确，数据一致。
#   c. tls 模式隧道：期望仍然通（用户态拷贝），日志里没有 splice:true。
set -euo pipefail

GOST="${1:?usage: splice-check.sh <gost-binary> [bytes]}"
SIZE="${2:-67108864}"
GOST="$(cd "$(dirname "$GOST")" && pwd)/$(basename "$GOST")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

(cd "$HERE/echocheck" && go build -o "$WORK/echocheck" .)
"$GOST" -V

# 端口：目标 T、出口 A、入口 B、普通转发 C
T=28701; A=28702; B=28703; C=28704
USER_=fwx-test; PASS_=secret-test

start_gost() { # name config
  local name="$1" cfg="$2"
  "$GOST" -C "$cfg" > "$WORK/$name.log" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 50); do
    grep -q 'listening on' "$WORK/$name.log" 2>/dev/null && return 0
    sleep 0.1
  done
  echo "gost $name did not start:"; cat "$WORK/$name.log"; exit 1
}
stop_gost() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  PIDS=()
}
splice_lines() { # logfile
  grep -c '"splice":true' "$1" 2>/dev/null || true
}
expect_splice() { # name logfile want(0|1)
  local n; n="$(splice_lines "$2")"
  if [ "$3" = 1 ] && [ "$n" -lt 1 ]; then echo "FAIL: $1 没有 splice:true 日志"; grep '>-<' "$2" || true; [ "${LENIENT:-0}" = 1 ] || exit 1; fi
  if [ "$3" = 0 ] && [ "$n" -gt 0 ]; then echo "FAIL: $1 不该 splice 却打了 splice:true"; [ "${LENIENT:-0}" = 1 ] || exit 1; fi
  echo "$1: splice 日志行数=$n"; grep '>-<' "$2" | tail -2 || true
}

tunnel_configs() { # listenerType dialerType
  cat > "$WORK/exit.json" <<EOF
{"services":[{"name":"exit","addr":"127.0.0.1:$A",
  "handler":{"type":"relay","auth":{"username":"$USER_","password":"$PASS_"},"metadata":{"nodelay":true}},
  "listener":{"type":"$1"}}]}
EOF
  cat > "$WORK/entry.json" <<EOF
{"services":[{"name":"entry","addr":"127.0.0.1:$B",
  "handler":{"type":"tcp","chain":"tunnel"},
  "listener":{"type":"tcp"},
  "forwarder":{"nodes":[{"name":"target","addr":"127.0.0.1:$T","connector":{"type":"tcp"},"dialer":{"type":"tcp"}}]}}],
 "chains":[{"name":"tunnel","hops":[{"name":"hop","nodes":[{"name":"exit","addr":"127.0.0.1:$A",
  "connector":{"type":"relay","auth":{"username":"$USER_","password":"$PASS_"},"metadata":{"nodelay":true}},
  "dialer":{"type":"$2"}}]}]}]}
EOF
}

echo "=== a. TCP 模式隧道（tcp 监听 relay 出口 + chain 入口），$SIZE 字节"
tunnel_configs tcp tcp
start_gost exit "$WORK/exit.json"
start_gost entry "$WORK/entry.json"
"$WORK/echocheck" -listen "127.0.0.1:$T" -dial "127.0.0.1:$B" -size "$SIZE"
sleep 0.5
stop_gost
expect_splice "入口(entry)" "$WORK/entry.log" 1
expect_splice "出口(exit)" "$WORK/exit.log" 1

echo "=== b. 普通转发 + proxyProtocol:1，$SIZE 字节"
cat > "$WORK/fwd.json" <<EOF
{"services":[{"name":"fwd","addr":"127.0.0.1:$C",
  "handler":{"type":"tcp","metadata":{"proxyProtocol":"1"}},
  "listener":{"type":"tcp"},
  "forwarder":{"nodes":[{"name":"target","addr":"127.0.0.1:$T","connector":{"type":"tcp"},"dialer":{"type":"tcp"}}]}}]}
EOF
start_gost fwd "$WORK/fwd.json"
"$WORK/echocheck" -listen "127.0.0.1:$T" -dial "127.0.0.1:$C" -size "$SIZE" -proxy
sleep 0.5
stop_gost
expect_splice "转发(fwd)" "$WORK/fwd.log" 1

echo "=== c. TLS 模式隧道（回归：用户态拷贝，不 splice），$SIZE 字节"
tunnel_configs tls tls
start_gost exit "$WORK/exit.json"
start_gost entry "$WORK/entry.json"
"$WORK/echocheck" -listen "127.0.0.1:$T" -dial "127.0.0.1:$B" -size "$SIZE"
sleep 0.5
stop_gost
expect_splice "入口(entry)" "$WORK/entry.log" 0
expect_splice "出口(exit)" "$WORK/exit.log" 0

echo "ALL OK"
