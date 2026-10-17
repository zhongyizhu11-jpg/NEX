#!/usr/bin/env bash
# 「增删改规则不断连接」压测：见同目录 README.md。
#
# 用法：sudo gost-runtime/test/hitless-sync/run.sh <gost 运行时二进制（nex5 起）>
# 环境变量：
#   SING_BOX=<sing-box 二进制>   不给就用 ss-egress-e2e 下载的那份（没有就下载官方 1.14.0）
#   HITLESS_SECONDS=300          增删改持续多久
#   HITLESS_TCP_STREAMS=32       不动的普通 TCP 规则上的长连接数
#   HITLESS_UDP_FLOWS=64         不动的普通 UDP 规则上的并发流数
set -euo pipefail

GOST="${1:?usage: run.sh <gost-runtime-binary>}"
GOST="$(cd "$(dirname "$GOST")" && pwd)/$(basename "$GOST")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SING_BOX_VERSION="${SING_BOX_VERSION:-1.14.0}"

if [ "$(id -u)" != 0 ]; then
  echo "needs root: the API socket directory must be root-owned and the traffic counters are nft rules" >&2
  exit 1
fi

if [ -z "${SING_BOX:-}" ]; then
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/nex-ss-egress-e2e"
  SING_BOX="$CACHE/sing-box-${SING_BOX_VERSION}-linux-amd64/sing-box"
  if [ ! -x "$SING_BOX" ]; then
    mkdir -p "$CACHE"
    curl -fsSL --retry 3 -o "$CACHE/sing-box.tgz" \
      "https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-amd64.tar.gz"
    tar -xzf "$CACHE/sing-box.tgz" -C "$CACHE"
  fi
fi

echo "[hitless] runtime: $("$GOST" -V 2>&1 | head -1)"
echo "[hitless] sing-box: $("$SING_BOX" version 2>&1 | head -1)"
cd "$REPO/agent"
# 只把 RESULT 行和失败信息打出来；gost 自己的日志在失败时由测试附带。
NEX_GOST_RUNTIME_BIN="$GOST" SING_BOX="$SING_BOX" \
  go test -run '^TestGostHitlessSyncHarness$' -count=1 -v -timeout 2h . 2>&1 \
  | grep -vE '^\s+\{"' | grep -vE ' gost runtime api sync service=' | grep -vE '^=== '
