#!/usr/bin/env bash
# 「GOST 出口组由入口机本机代理挑」端到端（面板 server/gostBalancePlan.ts + Agent failover_exit_group.go）。
#
# 全链路都是真的：
#   1. gen-configs.mjs 起一个临时 SQLite 库和真实的心跳路由，建 1 入口 + 3 出口 + 一条负载均衡的 GOST 链路 + 一条规则，
#      从心跳的下发里取出入口机的 gost.json、每台出口的隧道配置、交给入口 Agent 的代理规格（每个场景一份）；
#   2. agent 里带 balancee2e 标签的 TestBalanceProxyE2E 把它们跑起来：真实的 gost 运行时进程（3 出口 + 入口）、
#      本进程里的真实 failoverProxy、一个记「谁拨来的」的目标。出口各自绑 127.0.0.11 / .12 / .13 往外拨，
#      目标看到 127.0.0.1 就是入口机绕过隧道直连了。
#
# 验的东西：八种分配方式的 TCP / UDP 分布；出口进程死掉、被黑洞时多久摘掉（期间新连接一条都不许失败、目标一条
# 直连都不许收到）、回来多久放回；UDP 会话自己换出口；单台出口到目标不通时的经出口复核；手动指定（指定的那台死了
# 不黑洞）；PROXY protocol 入口接收 / 入口发送；只有 TCP、只有 UDP 的规则；上报给面板的 picks / share。
#
# 用法：gost-runtime/test/balance-proxy/run.sh <gost 运行时二进制>
#   黑洞、「单台出口到目标不通」要 root 和 iptables（往 lo 的 INPUT 链里临时加带 fwx-balance-e2e 注释的规则，
#   结束时删掉）；没有就跳过这两类。BALANCE_E2E_RUN=<正则> 只跑一部分；KEEP_WORK=1 留着生成的配置。
set -euo pipefail

GOST="${1:?usage: run.sh <gost-runtime-binary>}"
GOST="$(cd "$(dirname "$GOST")" && pwd)/$(basename "$GOST")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORK="$(mktemp -d)"
cleanup() {
  # 测试被打断时留下的规则
  if [ "${IPTABLES:-0}" = 1 ]; then
    while iptables -S INPUT 2>/dev/null | grep -q 'fwx-balance-e2e'; do
      rule="$(iptables -S INPUT | grep 'fwx-balance-e2e' | head -1 | sed 's/^-A /-D /')"
      # shellcheck disable=SC2086
      iptables $rule 2>/dev/null || break
    done
  fi
  if [ -n "${KEEP_WORK:-}" ]; then echo "work dir kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

"$GOST" -V
IPTABLES=0
if [ "$(id -u)" = 0 ] && command -v iptables >/dev/null 2>&1 && iptables -S INPUT >/dev/null 2>&1; then IPTABLES=1; fi
echo "iptables 场景（黑洞、单台出口到目标不通）：$([ "$IPTABLES" = 1 ] && echo 跑 || echo '跳过（要 root 和 iptables）')"

echo "== 1. 用真实的心跳路由生成下发"
(cd "$REPO" && DATABASE_TYPE=sqlite OUT="$WORK/gen" FORWARDX_TEST_DB="$WORK/e2e.db" \
  node --import tsx gost-runtime/test/balance-proxy/gen-configs.mjs > "$WORK/gen.log" 2>&1) || { cat "$WORK/gen.log"; exit 1; }
tail -1 "$WORK/gen.log"

echo "== 2. 真实 gost + 真实 failoverProxy"
cd "$REPO/agent"
BALANCE_E2E_DIR="$WORK/gen" BALANCE_E2E_GOST="$GOST" BALANCE_E2E_IPTABLES="$IPTABLES" \
  go test -tags balancee2e -count=1 -timeout 20m -run "${BALANCE_E2E_RUN:-TestBalanceProxyE2E}" -v . 2>&1 \
  | grep -v -E '^[0-9]{4}/[0-9]{2}/[0-9]{2} |^=== (RUN|PAUSE|CONT)' | tee "$WORK/test.log"
grep -q '^ok ' "$WORK/test.log" || { echo "FAILED"; exit 1; }
echo "ALL OK"
