#!/usr/bin/env bash
# 核对 Agent 进程内的 TCP 转发（协议守护 guard、线路组 routegroup）是不是走内核 splice 零拷贝：
# 用 strace -c 数一遍灌 200 MiB 时的系统调用。走 splice 时 splice 调用成千上万、read/write
# 只有夹具自己那一份；没走 splice 时 read/write 会多出一倍（转发自己在用户态搬）。
# 只在本机回环上跑，需要 strace。
#
# 用法：scripts/bench/splice-check.sh [输出目录]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-bench-out}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
if ! command -v strace >/dev/null 2>&1; then
  echo "需要 strace" >&2
  exit 1
fi

BIN="$OUT/agent-dataplane.test"
(cd "$ROOT/agent" && go test -c -o "$BIN" .)

for path in direct guard routegroup; do
  report="$OUT/strace-tcp-$path.txt"
  # -f 跟所有线程；只数和搬数据有关的几个调用。基准本身的输出（Gbps 等）进 .bench。
  strace -f -c -o "$report" -e trace=splice,read,write,readv,writev,sendmsg,recvmsg,sendto,recvfrom \
    "$BIN" -test.run '^$' -test.bench "BenchmarkDataplaneTCPBulk/$path/streams=1\$" \
    -test.benchtime 200x -test.cpu 4 >"$OUT/strace-tcp-$path.bench" 2>&1
  echo "== $path"
  grep -E '^ *[0-9.]+ +[0-9.]+ +[0-9]+ +[0-9]+ +([0-9]+ +)?(splice|read|write|readv|writev|sendmsg|recvmsg|sendto|recvfrom|total)$' "$report" || cat "$report"
done
rm -f "$BIN"
