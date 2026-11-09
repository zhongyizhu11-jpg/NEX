#!/usr/bin/env bash
# 面板 + 真 Agent 联调（CI 的 e2e 任务）。本地跑要有 docker：
#
#   pnpm build
#   NEX_GOST_SOURCE=upstream bash scripts/build-agent-release.sh   # 面板给 Agent 装机用的二进制（dist/agent）
#   bash e2e/run.sh
#
# 做的事：在本机起一份干净的面板（sqlite，监听所有网卡的 9810，容器里的 Agent 走网关地址访问它），然后跑
# e2e/scenario.ts（建管理员、建 Token、起容器、建线路、按场景切换并用真流量核对）。日志、报告都在 e2e/out。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/e2e/out"
PORT="${E2E_PANEL_PORT:-9810}"
COMPOSE=(docker compose -f "$ROOT/e2e/compose.yml" -p nex-e2e)

[ -f "$ROOT/dist/index.js" ] || { echo "[e2e] 没有 dist/index.js，先 pnpm build" >&2; exit 1; }
if [ "${E2E_DRY_RUN:-0}" != "1" ]; then
  [ -f "$ROOT/dist/agent/forwardx-agent-linux-amd64" ] || { echo "[e2e] 没有 dist/agent/forwardx-agent-linux-amd64，先 bash scripts/build-agent-release.sh" >&2; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "[e2e] 需要 docker compose" >&2; exit 1; }
fi

rm -rf "$OUT"
mkdir -p "$OUT/data"

PANEL_PID=""
cleanup() {
  local rc=$?
  set +e
  if [ "${E2E_DRY_RUN:-0}" != "1" ]; then
    "${COMPOSE[@]}" ps -a > "$OUT/compose-ps.txt" 2>&1
    "${COMPOSE[@]}" logs --no-color --timestamps > "$OUT/compose.log" 2>&1
    # 容器里 Agent 自己的日志（停了的容器也能 cp 出来）
    for name in entry relay-a relay-b; do
      "${COMPOSE[@]}" cp "$name:/var/log/forwardx-agent/agent-go.log" "$OUT/agent-$name.log" >/dev/null 2>&1 || true
    done
    "${COMPOSE[@]}" down -v --remove-orphans --timeout 5 >/dev/null 2>&1
  fi
  if [ -n "$PANEL_PID" ]; then
    kill "$PANEL_PID" 2>/dev/null
    wait "$PANEL_PID" 2>/dev/null
  fi
  if [ "$rc" -ne 0 ]; then
    echo "[e2e] 失败（退出码 $rc）。面板日志最后 60 行："
    tail -n 60 "$OUT/panel.log" 2>/dev/null || true
  fi
  exit "$rc"
}
trap cleanup EXIT

echo "[e2e] 起面板：http://0.0.0.0:$PORT（数据在 $OUT/data）"
(
  cd "$ROOT"
  DATABASE_TYPE=sqlite \
  SQLITE_PATH="$OUT/data/forwardx.db" \
  DATABASE_CONFIG_PATH="$OUT/data/database.json" \
  PORT="$PORT" \
  NODE_ENV=production \
  FORWARDX_PANEL_TIME_SYNC=false \
  exec node dist/index.js
) > "$OUT/panel.log" 2>&1 &
PANEL_PID=$!

for _ in $(seq 1 90); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  if ! kill -0 "$PANEL_PID" 2>/dev/null; then echo "[e2e] 面板起不来" >&2; exit 1; fi
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/" || { echo "[e2e] 面板 90 秒内没起来" >&2; exit 1; }
echo "[e2e] 面板已就绪"

cd "$ROOT"
PANEL_URL="http://127.0.0.1:$PORT" E2E_OUT="$OUT" node --import tsx e2e/scenario.ts
