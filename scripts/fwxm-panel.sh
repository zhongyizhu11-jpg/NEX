#!/bin/bash
# NEX 面板的 SSH 管理命令（fwxm panel …）。
#
# 面板安装脚本（install-panel-local.sh / install-panel-docker.sh）装 / 升级时把这个文件放到
# /usr/local/lib/nex/fwxm-panel，并在 /etc/nex/panel-manage.conf 里写上部署方式和目录。
# 怎么调起来：
#   · 只装了面板：/usr/local/bin/fwxm 是一个小转发脚本，直接进这里；
#   · 同机还装了 Agent：Agent 的 fwxm 认 `fwxm panel …`，交给这里；不带参数时先问管面板还是 Agent。
# 上游 poouo/Forwardx 2.3.284 的 forwardx-manage.sh 是同一个意思，NEX 的部署目录和服务名不一样，单独写。
set -uo pipefail

CONF_FILE="${FWXM_PANEL_CONF:-/etc/nex/panel-manage.conf}"
MODE=""
APP_DIR=""
SERVICE_NAME="forwardx-panel"
CONTAINER_NAME="forwardx-panel"
REPO_SLUG="zhongyizhu11-jpg/NEX"

die() { echo "[错误] $*" >&2; exit 1; }

usage() {
  cat <<"HELP"
NEX 面板管理命令 fwxm panel
  fwxm panel                交互菜单
  fwxm panel info           部署方式、目录、端口、版本
  fwxm panel status         运行状态
  fwxm panel logs           跟踪面板日志（Ctrl+C 退出）
  fwxm panel start|stop|restart
  fwxm panel address        面板访问地址（按本机 IP 和端口拼）
  fwxm panel upgrade        升级到最新发布版（保留数据和配置）
  fwxm panel reset-admin    重置管理员密码（会撤销该管理员已登录的会话）
  fwxm panel uninstall      卸载面板（会再确认是否删数据）
  fwxm panel version        面板版本
只装了面板时 panel 可以省略：fwxm status、fwxm logs ……
HELP
}

load_conf() {
  [ -r "$CONF_FILE" ] || die "没找到面板管理配置 $CONF_FILE，请重新运行一次面板安装 / 升级脚本"
  local key value
  # 只认这几个键，不 source：配置文件被改坏了也不会被当成脚本执行
  while IFS='=' read -r key value; do
    value="${value%\"}"; value="${value#\"}"
    case "$key" in
      MODE) MODE="$value" ;;
      APP_DIR) APP_DIR="$value" ;;
      SERVICE_NAME) SERVICE_NAME="$value" ;;
      CONTAINER_NAME) CONTAINER_NAME="$value" ;;
      REPO_SLUG) REPO_SLUG="$value" ;;
    esac
  done < "$CONF_FILE"
  case "$MODE" in local|docker) ;; *) die "面板管理配置里的部署方式无效：${MODE:-空}" ;; esac
  [ -n "$APP_DIR" ] || die "面板管理配置里没有部署目录"
}

env_value() {
  # 从部署目录的 .env 里取一个值（不 source）
  [ -r "$APP_DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$APP_DIR/.env" | tail -n 1 | sed 's/^"//; s/"$//'
}

confirm() {
  local answer
  [ -r /dev/tty ] && [ -w /dev/tty ] || die "这个操作需要在交互式 SSH 终端里确认"
  printf "%s [y/N] " "$1" > /dev/tty
  IFS= read -r answer < /dev/tty || return 1
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

service_action() {
  local action="$1"
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    if [ "$action" = status ]; then systemctl status "$SERVICE_NAME" --no-pager -l; else systemctl "$action" "$SERVICE_NAME"; fi
  elif command -v rc-service >/dev/null 2>&1; then rc-service "$SERVICE_NAME" "$action"
  elif [ -x "/etc/init.d/$SERVICE_NAME" ]; then "/etc/init.d/$SERVICE_NAME" "$action"
  else die "找不到可用的服务管理器"; fi
}

panel_port() {
  local port
  port="$(env_value PORT)"
  echo "${port:-9810}"
}

panel_version() {
  if [ "$MODE" = docker ]; then
    docker exec "$CONTAINER_NAME" node -p "require('/app/package.json').version" 2>/dev/null || echo "（容器没在运行）"
  else
    sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" 2>/dev/null | head -n 1
  fi
}

# Docker 部署没有在本机留安装脚本：要用时按 .env 里的 GitHub 加速站去下（和首次安装的命令同一个脚本）。
run_docker_installer() {
  local action="$1" accelerator url tmp
  accelerator="$(env_value FORWARDX_GITHUB_ACCELERATOR_URL)"
  url="https://raw.githubusercontent.com/${REPO_SLUG}/main/scripts/install-panel-docker.sh"
  [ -n "$accelerator" ] && url="${accelerator%/}/${url}"
  tmp="$(mktemp /tmp/nex-panel-install.XXXXXX)" || die "无法创建临时文件"
  trap 'rm -f "$tmp"' EXIT
  echo "[信息] 获取安装脚本: $url"
  if ! curl -fsSL --connect-timeout 15 --speed-limit 1024 --speed-time 60 "$url" -o "$tmp"; then
    if [ -n "$accelerator" ]; then
      echo "[警告] 加速站下载失败，改用 GitHub 直连"
      curl -fsSL --connect-timeout 15 "https://raw.githubusercontent.com/${REPO_SLUG}/main/scripts/install-panel-docker.sh" -o "$tmp" || die "下载安装脚本失败"
    else
      die "下载安装脚本失败（GitHub 访问不稳定时可在面板设置里配置加速站，或用 --github-accelerator 重新安装）"
    fi
  fi
  bash -n "$tmp" || die "安装脚本校验失败，已取消"
  FORWARDX_DOCKER_DIR="$APP_DIR" FORWARDX_CONTAINER_NAME="$CONTAINER_NAME" bash "$tmp" "$action"
}

run_local_installer() {
  local action="$1"
  [ -r "$APP_DIR/scripts/install-panel-local.sh" ] || die "部署目录里没有 scripts/install-panel-local.sh，请用 GitHub 上的安装命令升级一次"
  FORWARDX_PANEL_DIR="$APP_DIR" FORWARDX_SERVICE_NAME="$SERVICE_NAME" bash "$APP_DIR/scripts/install-panel-local.sh" "$action"
}

show_address() {
  local port ip found="false"
  port="$(panel_port)"
  for ip in $(hostname -I 2>/dev/null || true); do
    case "$ip" in 127.*|::1|fe80:*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) continue ;; esac
    case "$ip" in *:*) echo "http://[$ip]:$port" ;; *) echo "http://$ip:$port" ;; esac
    found="true"
  done
  [ "$found" = true ] || echo "http://服务器IP:$port"
  echo "配了域名、HTTPS 或反向代理的话，以「系统设置 › 面板公开地址」为准。"
}

case "${1:-}" in -h|--help|help) usage; exit 0 ;; esac
[ "$(id -u)" = 0 ] || die "请用 root（sudo fwxm panel）运行"
load_conf

ACTION="${1:-}"; [ "$#" = 0 ] || shift
if [ -z "$ACTION" ]; then
  [ -r /dev/tty ] || { usage; exit 0; }
  printf "\nNEX 面板管理（%s 部署）\n" "$MODE" > /dev/tty
  printf "%s\n" "  1) 关键信息" "  2) 运行状态" "  3) 查看日志" "  4) 重启面板" "  5) 访问地址" "  6) 升级" "  7) 重置管理员密码" "  8) 卸载" "  0) 退出" > /dev/tty
  printf "选择: " > /dev/tty; IFS= read -r choice < /dev/tty || exit 0
  case "$choice" in
    1) ACTION=info ;; 2) ACTION=status ;; 3) ACTION=logs ;; 4) ACTION=restart ;; 5) ACTION=address ;;
    6) ACTION=upgrade ;; 7) ACTION=reset-admin ;; 8) ACTION=uninstall ;; *) exit 0 ;;
  esac
fi

case "$ACTION" in
  info)
    echo "部署方式:  $MODE"
    echo "部署目录:  $APP_DIR"
    echo "访问端口:  $(panel_port)"
    echo "面板版本:  $(panel_version)"
    if [ "$MODE" = docker ]; then
      echo "容器名称:  $CONTAINER_NAME"
      echo "数据位置:  Docker 数据卷（不在部署目录里），docker volume ls 查看"
    else
      echo "服务名称:  $SERVICE_NAME"
      echo "数据目录:  $APP_DIR/data"
      echo "日志文件:  $APP_DIR/data/panel.log（systemd 部署看 journalctl -u $SERVICE_NAME）"
    fi ;;
  status)
    if [ "$MODE" = docker ]; then docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'
    else service_action status; fi ;;
  logs)
    if [ "$MODE" = docker ]; then docker logs --tail 100 -f "$CONTAINER_NAME"
    elif command -v journalctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then journalctl -u "$SERVICE_NAME" -n 100 -f
    else tail -n 100 -F "$APP_DIR/data/panel.log"; fi ;;
  start|stop|restart)
    if [ "$MODE" = docker ]; then docker "$ACTION" "$CONTAINER_NAME"
    else service_action "$ACTION"; fi ;;
  address|url) show_address ;;
  version) panel_version ;;
  upgrade|update)
    if [ "$MODE" = docker ]; then run_docker_installer upgrade; else run_local_installer upgrade; fi ;;
  reset-admin|reset-password)
    if [ "$MODE" = docker ]; then
      [ -t 0 ] || die "重置密码需要在交互式 SSH 终端里运行"
      docker exec -it "$CONTAINER_NAME" node dist/reset-admin-password.js "$@"
    else
      run_local_installer reset-admin
    fi ;;
  uninstall|remove)
    confirm "卸载面板？（接下来安装脚本还会单独问是否删除数据）" || exit 0
    if [ "$MODE" = docker ]; then run_docker_installer uninstall; else run_local_installer uninstall; fi ;;
  *) usage; exit 1 ;;
esac
