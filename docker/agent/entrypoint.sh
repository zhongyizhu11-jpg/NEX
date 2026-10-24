#!/bin/bash
# NEX Agent 的 Docker 入口（docker/agent/Dockerfile）。
#
# 镜像里只有依赖，Agent 本身第一次启动时从面板装（和在机器上执行安装命令是同一个脚本、同一套二进制），
# 所以 Agent 版本永远跟着面板走，不用为每个版本出镜像。配置在 /etc/forwardx（挂卷）：
#   - 第一次：没有配置，用 AGENT_TOKEN 安装并注册；
#   - 容器重建：卷里有配置、镜像里没有二进制，按已有配置重装一遍（不用再给 Token）；
#   - 之后 Agent 由下面的循环拉起，退出了 3 秒后再拉；面板升级 Agent 时换好二进制、结束旧进程，循环用新版本起来。
set -u

CONFIG=/etc/forwardx/agent/config.json
BIN=/usr/local/bin/forwardx-agent
export FORWARDX_AGENT_CONTAINER=1

panel_url="${PANEL_URL:-}"
if [ -z "$panel_url" ] && [ -f "$CONFIG" ]; then
  panel_url="$(jq -r '.panelUrl // empty' "$CONFIG" 2>/dev/null || true)"
fi
panel_url="${panel_url%/}"
if [ -z "$panel_url" ]; then
  echo "[错误] 请用 -e PANEL_URL=http://你的面板地址:9810 指定面板地址" >&2
  exit 1
fi

install_agent() {
  local action="$1"
  shift
  curl -fsSL --connect-timeout 15 --retry 3 "$panel_url/api/agent/install.sh" \
    | PANEL_URL="$panel_url" bash -s -- "$action" "$@"
}

if [ ! -x "$BIN" ]; then
  if [ -f "$CONFIG" ]; then
    echo "[信息] 卷里已有 Agent 配置，按原配置安装 Agent"
    until install_agent upgrade; do echo "[信息] 安装没成功，30 秒后重试"; sleep 30; done
  else
    if [ -z "${AGENT_TOKEN:-}" ]; then
      echo "[错误] 第一次启动要用 -e AGENT_TOKEN=... 给出面板里复制的 Token" >&2
      exit 1
    fi
    until install_agent install "$AGENT_TOKEN"; do echo "[信息] 安装没成功，30 秒后重试"; sleep 30; done
  fi
fi

child=""
trap 'if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; fi; exit 0' TERM INT
echo "[信息] NEX Agent 启动：$("$BIN" -version 2>/dev/null | head -n 1)，面板 $panel_url"
while true; do
  "$BIN" -config "$CONFIG" &
  child=$!
  wait "$child"
  child=""
  sleep 3
done
