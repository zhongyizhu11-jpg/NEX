#!/bin/sh
# 面板容器入口：以 root 起来，把数据卷的属主修正给 forwardx 用户，然后降权运行面板。
#
# 为什么不直接在 Dockerfile 里写 USER：老部署的数据卷里 forwardx.db / database.json / jwt.secret 都是 root 的
# （以前容器就是 root 跑的，安装脚本写 database.json 也是 root），直接换用户就打不开库。这里每次启动用
# find 只修正属主不对的文件，正常情况下一个都不用动。
#
# 两种情况不降权，照旧 root：
#   · FORWARDX_RUN_AS_ROOT=1：运维明确要 root（比如挂了只读的、改不了属主的目录）。
#   · 挂了 /var/run/docker.sock：面板内「一键升级」要用宿主机的 Docker 重建自己的容器，socket 一般只有 root 能用。
#     要降权又要升级，把 socket 的属组给容器里的 forwardx（gid 见 Dockerfile）或者用宿主机上的安装脚本升级。
#
# FORWARDX_ENTRYPOINT_DRY_RUN=1 时只打印会怎么做（测试用，不动文件、不启动）。
set -eu

PANEL_USER="${FORWARDX_PANEL_USER:-forwardx}"
DATA_DIR="${FORWARDX_DATA_DIR:-/data}"
DOCKER_SOCK="${FORWARDX_DOCKER_SOCK:-/var/run/docker.sock}"
CURRENT_UID="${FORWARDX_ENTRYPOINT_UID:-$(id -u)}"
DRY_RUN="${FORWARDX_ENTRYPOINT_DRY_RUN:-}"

decide() {
  if [ "$CURRENT_UID" != "0" ]; then
    echo "already-unprivileged"
  elif [ "${FORWARDX_RUN_AS_ROOT:-}" = "1" ]; then
    echo "root:requested"
  elif [ -S "$DOCKER_SOCK" ]; then
    echo "root:docker-socket"
  elif ! id "$PANEL_USER" >/dev/null 2>&1; then
    echo "root:no-user"
  else
    echo "drop"
  fi
}

decision="$(decide)"
if [ -n "$DRY_RUN" ]; then
  echo "$decision"
  exit 0
fi

case "$decision" in
  drop)
    mkdir -p "$DATA_DIR"
    # 只改属主不对的（老数据卷、root 用 docker exec 写进去的），一个都不用动时这一步是空的。
    find "$DATA_DIR" ! -user "$PANEL_USER" -exec chown "$PANEL_USER:$PANEL_USER" {} + 2>/dev/null || true
    exec su-exec "$PANEL_USER" "$@"
    ;;
  root:docker-socket)
    echo "[entrypoint] /var/run/docker.sock is mounted; running as root so the in-panel upgrade can drive Docker (set FORWARDX_RUN_AS_ROOT=0 and chgrp the socket to drop privileges)" >&2
    exec "$@"
    ;;
  root:*)
    exec "$@"
    ;;
  already-unprivileged)
    exec "$@"
    ;;
esac
