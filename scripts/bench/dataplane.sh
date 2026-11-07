#!/usr/bin/env bash
# 数据面基准（只在本机回环上跑，不连任何外部主机）。
#
# 量 agent 和 forwardx-fxp 进程内转发路径的：单向吞吐（Gbps）、每 1e9 字节的进程 CPU
# （cpu-ms/GB，用户态 + 内核态）和堆分配（allocs/GB）、64 字节一问一答的往返时延
# （p50-us / p99-us）、TCP 建连速率（conns/s）、UDP 按固定速率发包时目标收到的速率和
# 丢包率（pps / loss-%）。基准本体在 agent/bench_dataplane_test.go 和
# forwardx-fxp/bench_dataplane_test.go，各路径的含义见那两个文件开头。
#
# 用法：
#   scripts/bench/dataplane.sh [输出目录] [标签]       跑一遍，存原始输出和中位数汇总
#   scripts/bench/dataplane.sh compare <输出目录> <标签A> <标签B>
#                                                       两次汇总并排对比（B 相对 A 的变化）
#   scripts/bench/dataplane.sh table <标签>-summary.tsv  一个子项一行地看一份汇总
#
#   输出目录  默认 bench-out
#   标签      默认当前提交的短哈希；改前改后各跑一次，用不同标签
#
# 环境变量：
#   BENCHTIME  每个子项跑多久，默认 1s
#   COUNT      每个子项重复几次，默认 3（汇总取中位数）
#   CPUS       GOMAXPROCS 列表，默认「1,本机核数」
#   FILTER     只跑名字匹配这个正则的基准，默认 BenchmarkDataplane
#   PACKAGES   跑哪些包，默认「agent forwardx-fxp」
#
# 产物：
#   <输出目录>/<标签>-agent.txt、<标签>-forwardx-fxp.txt   go test -bench 原始输出（日志行已剔掉）
#   <输出目录>/<标签>-<包>.log                            被剔掉的日志和 stderr
#   <输出目录>/<标签>-summary.tsv                         每个子项每个指标的中位数：名字 单位 数值
#
# 说明：本机回环没有网卡、没有真实的 RTT 和丢包，数字只适合同一台机器上前后对比，不能
# 当线上吞吐。真机长跑见 scripts/soak/。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 去掉混进基准输出里的日志行（agent: 2026-11-06T16:19:45Z ...；fxp: 2026/11/06 16:22:13 ...），
# 再把被日志截成两半的「基准名 / 结果」拼回一行。
clean_bench_output() {
  awk -v log_file="$1" '
    {
      line = $0
      p = match(line, /[0-9][0-9][0-9][0-9][-\/][0-9][0-9][-\/][0-9][0-9][T ][0-9][0-9]:[0-9][0-9]:[0-9][0-9]/)
      if (p > 0) {
        print substr(line, p) >> log_file
        line = substr(line, 1, p - 1)
      }
      if (line ~ /^[ \t]*$/) next
      if (pending != "") {
        if (line ~ /^[ \t]*[0-9]+[ \t]/) { print pending line; pending = ""; next }
        print pending
        pending = ""
      }
      if (line ~ /^Benchmark[^ \t]*[ \t]*$/) { pending = line; next }
      print line
    }
    END { if (pending != "") print pending }
  '
}

# 原始输出 → 「名字<TAB>单位<TAB>中位数」。
summarize() {
  awk '
    /^Benchmark/ {
      for (i = 3; i + 1 <= NF; i += 2) printf "%s\t%s\t%s\n", $1, $(i + 1), $i
    }' "$@" | LC_ALL=C sort -t "$(printf '\t')" -k1,1 -k2,2 -k3,3g | awk -F '\t' '
    function flush() { if (prev != "") printf "%s\t%s\n", prev, vals[int((n + 1) / 2)] }
    {
      key = $1 "\t" $2
      if (key != prev) { flush(); prev = key; n = 0 }
      vals[++n] = $3
    }
    END { flush() }'
}

if [[ "${1:-}" == "table" ]]; then
  if [[ $# -ne 2 ]]; then
    echo "usage: $0 table <标签>-summary.tsv" >&2
    exit 2
  fi
  # 一个子项一行，常用指标各一列。
  awk -F '\t' '
    BEGIN { n = split("Gbps cpu-ms/GB allocs/GB p50-us p99-us conns/s pps loss-% cpu-ns/pkt", units, " ") }
    {
      name = $1
      sub(/^BenchmarkDataplane/, "", name)
      if (!(name in seen)) { seen[name] = 1; order[++rows] = name }
      v[name SUBSEP $2] = $3
    }
    END {
      printf "%-40s", "benchmark"
      for (i = 1; i <= n; i++) printf " %10s", units[i]
      printf "\n"
      for (r = 1; r <= rows; r++) {
        name = order[r]
        line = sprintf("%-40s", name)
        any = 0
        for (i = 1; i <= n; i++) {
          key = name SUBSEP units[i]
          if (key in v) { line = line sprintf(" %10.4g", v[key]); any = 1 } else line = line sprintf(" %10s", "")
        }
        if (any) print line
      }
    }' "$2"
  exit 0
fi

if [[ "${1:-}" == "compare" ]]; then
  if [[ $# -ne 4 ]]; then
    echo "usage: $0 compare <输出目录> <标签A> <标签B>" >&2
    exit 2
  fi
  dir=$2
  a="$dir/$3-summary.tsv"
  b="$dir/$4-summary.tsv"
  printf 'benchmark\tunit\t%s\t%s\tdelta\n' "$3" "$4"
  join -t "$(printf '\t')" \
    <(awk -F '\t' '{ printf "%s|%s\t%s\n", $1, $2, $3 }' "$a" | LC_ALL=C sort) \
    <(awk -F '\t' '{ printf "%s|%s\t%s\n", $1, $2, $3 }' "$b" | LC_ALL=C sort) |
    awk -F '\t' '{
      split($1, k, "|")
      d = ($2 + 0 != 0) ? sprintf("%+.1f%%", ($3 - $2) / $2 * 100) : "-"
      printf "%s\t%s\t%s\t%s\t%s\n", k[1], k[2], $2, $3, d
    }'
  exit 0
fi

OUT="${1:-bench-out}"
LABEL="${2:-$(git -C "$ROOT" rev-parse --short HEAD)}"
BENCHTIME="${BENCHTIME:-1s}"
COUNT="${COUNT:-3}"
CPUS="${CPUS:-1,$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
FILTER="${FILTER:-BenchmarkDataplane}"
PACKAGES="${PACKAGES:-agent forwardx-fxp}"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
{
  echo "label=$LABEL commit=$(git -C "$ROOT" rev-parse HEAD) date=$(date -u +%FT%TZ)"
  echo "kernel=$(uname -r) cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null) go=$(go version | awk '{print $3}')"
  grep -m1 'model name' /proc/cpuinfo 2>/dev/null || true
  echo "benchtime=$BENCHTIME count=$COUNT cpu=$CPUS filter=$FILTER"
} | tee "$OUT/$LABEL-env.txt"

outputs=()
for pkg in $PACKAGES; do
  raw="$OUT/$LABEL-$pkg.txt"
  log="$OUT/$LABEL-$pkg.log"
  : >"$log"
  : >"$raw"
  # COUNT 遍轮着跑（每遍每个子项一次），而不是 -count 让同一个子项连跑几次：机器上有别的负载
  # 起伏时，各子项（包括同一个二进制里的开关对照，比如 udp / udp-perpacket）吃到的是同样的干扰。
  for pass in $(seq 1 "$COUNT"); do
    echo "== $pkg pass $pass/$COUNT"
    (cd "$ROOT/$pkg" && go test -run '^$' -bench "$FILTER" -benchtime "$BENCHTIME" -count 1 -cpu "$CPUS" -timeout 60m . 2>>"$log") |
      clean_bench_output "$log" | tee -a "$raw"
  done
  outputs+=("$raw")
done

summarize "${outputs[@]}" >"$OUT/$LABEL-summary.tsv"
echo "summary: $OUT/$LABEL-summary.tsv"
