#!/bin/bash
set -euo pipefail

ACTION="install"
APP_DIR="${FORWARDX_PANEL_DIR:-/opt/forwardx-panel}"
SERVICE_NAME="${FORWARDX_SERVICE_NAME:-forwardx-panel}"
PORT="${PORT:-9810}"
REPO_SLUG="${FORWARDX_GITHUB_REPO:-zhongyizhu11-jpg/NEX}"
PANEL_BUNDLE_PREFIX="${FORWARDX_PANEL_BUNDLE_PREFIX:-forwardx-panel-v}"
PNPM_VERSION="${FORWARDX_PNPM_VERSION:-10.28.1}"
ASSETS_PENDING_EXIT_CODE=12
# 面板端靠这些 "[NEX] step N/M …" / "progress download …" 行画进度条，改动格式要连 client/src/lib/panelUpgrade.ts 一起改。
PANEL_STEP_TOTAL=5
SCRIPT_STARTED_AT="$(date +%s)"
# 上一次安装成功时依赖输入的指纹放在 node_modules 里：node_modules 被删掉指纹也跟着没了，不会误判「没变」。
DEPS_FINGERPRINT_NAME=".forwardx-deps-fingerprint"
ENABLE_ADMIN_ACCOUNT="false"
GITHUB_ACCELERATOR_URL=""
GITHUB_ACCELERATOR_EXPLICIT="false"
if [ "${FORWARDX_GITHUB_ACCELERATOR_URL+x}" = "x" ]; then
  GITHUB_ACCELERATOR_URL="$FORWARDX_GITHUB_ACCELERATOR_URL"
  GITHUB_ACCELERATOR_EXPLICIT="true"
fi

usage() {
  cat <<EOF
Usage: $0 install|upgrade|uninstall|reset-admin|reset-password [--github-accelerator URL] [--enable-account]

Options:
  --github-accelerator URL   Prefix GitHub API/raw/release URLs with this HTTP(S) accelerator.
  --enable-account           With reset-admin, enable the selected administrator account.

Environment:
  FORWARDX_GITHUB_ACCELERATOR_URL   Same as --github-accelerator; an explicit empty value disables it.
EOF
}

parse_args() {
  local action_seen="false"
  local value=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      install|upgrade|update|uninstall|remove|reset-admin|reset-password)
        if [ "$action_seen" = "true" ]; then
          echo "[ERROR] Multiple actions were provided: $1" >&2
          usage >&2
          exit 1
        fi
        ACTION="$1"
        action_seen="true"
        shift
        ;;
      --github-accelerator)
        if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
          echo "[ERROR] --github-accelerator requires an HTTP(S) URL" >&2
          usage >&2
          exit 1
        fi
        GITHUB_ACCELERATOR_URL="$2"
        GITHUB_ACCELERATOR_EXPLICIT="true"
        shift 2
        ;;
      --github-accelerator=*)
        value="${1#*=}"
        if [ -z "$value" ]; then
          echo "[ERROR] --github-accelerator requires an HTTP(S) URL" >&2
          usage >&2
          exit 1
        fi
        GITHUB_ACCELERATOR_URL="$value"
        GITHUB_ACCELERATOR_EXPLICIT="true"
        shift
        ;;
      --enable-account)
        ENABLE_ADMIN_ACCOUNT="true"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "[ERROR] Unknown argument: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done
}

parse_args "$@"

if [ "$ENABLE_ADMIN_ACCOUNT" = "true" ] && [ "$ACTION" != "reset-admin" ] && [ "$ACTION" != "reset-password" ]; then
  echo "[ERROR] --enable-account is only valid with reset-admin" >&2
  exit 1
fi

valid_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
}

normalize_version() {
  local raw="${1:-}"
  raw="${raw#v}"
  printf "%s\n" "$raw"
}

get_env_value() {
  local key="$1"
  local file="$APP_DIR/.env"
  if [ ! -f "$file" ]; then
    return 0
  fi
  grep -E "^${key}=" "$file" | tail -1 | sed -E "s/^${key}=//; s/^\"//; s/\"$//"
}

normalize_github_accelerator_url() {
  local value="${1:-}"
  local pattern='^https?://[^/?#[:space:]]+(/[^?#[:space:]]*)?$'
  value="$(printf "%s" "$value" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s#/*$##')"
  if [[ ! "$value" =~ $pattern ]]; then
    return 1
  fi
  case "$value" in
    *'$'*|*'`'*|*'\'*|*'"'*) return 1 ;;
  esac
  if [ -z "$value" ]; then
    return 1
  fi
  printf "%s\n" "$value"
}

resolve_github_accelerator() {
  local existing=""
  local normalized=""
  if [ "$GITHUB_ACCELERATOR_EXPLICIT" != "true" ]; then
    existing="$(get_env_value FORWARDX_GITHUB_ACCELERATOR_URL || true)"
    if [ -n "$existing" ]; then
      GITHUB_ACCELERATOR_URL="$existing"
    fi
  fi
  if [ -z "$GITHUB_ACCELERATOR_URL" ]; then
    export FORWARDX_GITHUB_ACCELERATOR_URL=""
    return
  fi
  if ! normalized="$(normalize_github_accelerator_url "$GITHUB_ACCELERATOR_URL")"; then
    echo "[ERROR] Invalid GitHub accelerator URL: $GITHUB_ACCELERATOR_URL" >&2
    echo "[INFO] Use an HTTP(S) base URL, for example: https://mirror.example.com" >&2
    exit 1
  fi
  GITHUB_ACCELERATOR_URL="$normalized"
  export FORWARDX_GITHUB_ACCELERATOR_URL="$GITHUB_ACCELERATOR_URL"
}

is_github_url() {
  local url="${1:-}"
  [[ "$url" =~ ^https?://([^/]+\.)?github\.com(/|$) ]] \
    || [[ "$url" =~ ^https?://raw\.githubusercontent\.com(/|$) ]] \
    || [[ "$url" =~ ^https?://([^/]+\.)?githubusercontent\.com(/|$) ]]
}

accelerated_github_url() {
  local url="$1"
  if [ -n "$GITHUB_ACCELERATOR_URL" ] && is_github_url "$url"; then
    printf "%s/%s\n" "$GITHUB_ACCELERATOR_URL" "$url"
  else
    printf "%s\n" "$url"
  fi
}

release_tag_from_url() {
  local url="$1"
  curl -fsSL --retry 3 --connect-timeout 10 "$url" \
    | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v?([^"]+)".*/\1/p' \
    | head -1 || true
}

panel_step() {
  # 进度标记：面板按「第几步 / 共几步」画条，标签直接显示给用户看。
  echo "[NEX] step $1/$PANEL_STEP_TOTAL $2"
}

elapsed_seconds() {
  local now=""
  now="$(date +%s)"
  printf "%s\n" "$((now - SCRIPT_STARTED_AT))"
}

file_size_bytes() {
  local file="$1"
  local size=""
  if [ ! -f "$file" ]; then
    printf "0\n"
    return
  fi
  # GNU/busybox stat 用 -c，macOS/BSD 用 -f；都没有就数字节。
  size="$(stat -c %s "$file" 2>/dev/null || stat -f %z "$file" 2>/dev/null || wc -c < "$file" 2>/dev/null || true)"
  size="${size//[^0-9]/}"
  printf "%s\n" "${size:-0}"
}

remote_content_length() {
  # 跟随跳转后最后一个响应的 Content-Length；拿不到就输出空，进度只报已下载字节数。
  local url="$1"
  curl -sIL --retry 1 --connect-timeout 10 "$url" 2>/dev/null \
    | tr -d '\r' \
    | sed -nE 's/^[Cc]ontent-[Ll]ength:[[:space:]]*([0-9]+).*$/\1/p' \
    | tail -1 || true
}

report_download_progress() {
  local downloaded="$1"
  local total="$2"
  local percent=0
  if [ -n "$total" ] && [ "$total" -gt 0 ] 2>/dev/null; then
    percent=$((downloaded * 100 / total))
    # HEAD 探测拿到的长度可能和实际下载的不一样（镜像站返回错误页之类），不让百分比超过 100。
    if [ "$percent" -gt 100 ]; then percent=100; fi
    echo "[NEX] progress download ${downloaded}/${total} ${percent}%" >&2
  else
    echo "[NEX] progress download ${downloaded}/- -%" >&2
  fi
}

download_url_to_file() {
  local url="$1"
  local output="$2"
  local partial="${output}.part"
  local code_file="${output}.code"
  local http_code=""
  local total=""
  local size=""
  local last_size="-1"
  local idle_ticks=0
  local pid=""
  rm -f "$partial" "$code_file"
  total="$(remote_content_length "$url")"
  # curl 放到后台跑，前台每秒看一眼 .part 文件长了多少，面板那边的进度条才动得起来；
  # 之前 -s 静默下载几十 MB，面板整段时间停在同一个百分比。
  curl -fsSL --retry 3 --connect-timeout 10 --write-out "%{http_code}" --output "$partial" "$url" > "$code_file" 2>/dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    size="$(file_size_bytes "$partial")"
    # 字节数没变就不刷屏，但每 10 秒报一次让人知道没死。
    if [ "$size" != "$last_size" ] || [ "$idle_ticks" -ge 10 ]; then
      report_download_progress "$size" "$total"
      last_size="$size"
      idle_ticks=0
    else
      idle_ticks=$((idle_ticks + 1))
    fi
  done
  wait "$pid" 2>/dev/null || true
  http_code="$(tr -d '[:space:]' < "$code_file" 2>/dev/null || true)"
  rm -f "$code_file"
  if [ "$http_code" = "200" ]; then
    size="$(file_size_bytes "$partial")"
    report_download_progress "$size" "${total:-$size}"
    mv -f "$partial" "$output"
  else
    rm -f "$partial"
  fi
  printf "%s\n" "$http_code"
}

download_github_archive() {
  local url="$1"
  local output="$2"
  local accelerated=""
  local http_code=""
  accelerated="$(accelerated_github_url "$url")"
  if [ "$accelerated" != "$url" ]; then
    echo "[INFO] Trying GitHub accelerator: $accelerated" >&2
    http_code="$(download_url_to_file "$accelerated" "$output")"
    if [ "$http_code" = "200" ] && tar -tzf "$output" >/dev/null 2>&1; then
      printf "%s\n" "$http_code"
      return
    fi
    if [ "$http_code" = "200" ]; then
      http_code="invalid-archive"
      rm -f "$output"
    fi
    echo "[WARN] GitHub accelerator request failed (HTTP ${http_code:-unknown}); falling back to GitHub." >&2
  fi
  http_code="$(download_url_to_file "$url" "$output")"
  if [ "$http_code" = "200" ] && ! tar -tzf "$output" >/dev/null 2>&1; then
    rm -f "$output"
    http_code="invalid-archive"
  fi
  printf "%s\n" "$http_code"
}

read_install_port() {
  local default_port="${PORT:-9810}"
  local input=""

  if ! valid_port "$default_port"; then
    default_port="9810"
  fi

  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    PORT="$default_port"
    echo "[INFO] Non-interactive environment, use default web port: $PORT"
    return
  fi

  while true; do
    printf "Enter web listen port [default %s]: " "$default_port" > /dev/tty
    IFS= read -r input < /dev/tty || input=""
    input="${input//[[:space:]]/}"
    if [ -z "$input" ]; then
      PORT="$default_port"
      return
    fi
    if valid_port "$input"; then
      PORT="$input"
      return
    fi
    echo "[ERROR] Port must be a number in 1-65535, please retry." > /dev/tty
  done
}

json_escape() {
  printf "%s" "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

read_secret() {
  local prompt="$1"
  local value=""
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf "%s" "$prompt" > /dev/tty
    stty -echo < /dev/tty 2>/dev/null || true
    IFS= read -r value < /dev/tty || value=""
    stty echo < /dev/tty 2>/dev/null || true
    printf "\n" > /dev/tty
  fi
  printf "%s" "$value"
}

read_database_port() {
  local prompt="$1"
  local default_port="$2"
  local value=""
  while true; do
    printf "%s [%s]: " "$prompt" "$default_port" > /dev/tty
    IFS= read -r value < /dev/tty || value=""
    value="${value//[[:space:]]/}"
    [ -z "$value" ] && value="$default_port"
    if valid_port "$value"; then
      printf "%s" "$value"
      return
    fi
    echo "[ERROR] Port must be a number in 1-65535, please retry." > /dev/tty
  done
}

read_database_config() {
  local config_file="$APP_DIR/data/database.json"
  local choice host port user password database ssl
  if [ "$ACTION" != "install" ] || [ -f "$config_file" ]; then
    return
  fi
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    echo "[INFO] Non-interactive environment, database can be selected on first panel visit."
    return
  fi

  echo "Select database type:" > /dev/tty
  echo "  1) SQLite local database (default)" > /dev/tty
  echo "  2) MySQL external database" > /dev/tty
  echo "  3) PostgreSQL external database" > /dev/tty
  printf "Enter choice [1]: " > /dev/tty
  IFS= read -r choice < /dev/tty || choice=""
  choice="${choice//[[:space:]]/}"
  [ -z "$choice" ] && choice="1"
  if [ "$choice" = "1" ]; then
    mkdir -p "$APP_DIR/data"
    cat > "$config_file" <<EOF
{
  "type": "sqlite",
  "setupPending": true,
  "sqlite": {
    "path": "$(json_escape "$APP_DIR/data/forwardx.db")"
  }
}
EOF
    chmod 600 "$config_file" 2>/dev/null || true
    return
  fi
  if [ "$choice" != "2" ] && [ "$choice" != "3" ]; then
    echo "[INFO] Unknown database choice, database can be selected on first panel visit." > /dev/tty
    return
  fi

  if [ "$choice" = "2" ]; then
    printf "MySQL host [127.0.0.1]: " > /dev/tty
    IFS= read -r host < /dev/tty || host=""
    host="${host:-127.0.0.1}"
    port="$(read_database_port "MySQL port" "3306")"
  else
    printf "PostgreSQL host [127.0.0.1]: " > /dev/tty
    IFS= read -r host < /dev/tty || host=""
    host="${host:-127.0.0.1}"
    port="$(read_database_port "PostgreSQL port" "5432")"
  fi
  printf "Database name [forwardx]: " > /dev/tty
  IFS= read -r database < /dev/tty || database=""
  database="${database:-forwardx}"
  printf "Database user [forwardx]: " > /dev/tty
  IFS= read -r user < /dev/tty || user=""
  user="${user:-forwardx}"
  password="$(read_secret "Database password: ")"
  printf "Enable SSL? [y/N]: " > /dev/tty
  IFS= read -r ssl < /dev/tty || ssl=""
  case "$ssl" in y|Y|yes|YES) ssl="true" ;; *) ssl="false" ;; esac

  mkdir -p "$APP_DIR/data"
  if [ "$choice" = "2" ]; then
    cat > "$config_file" <<EOF
{
  "type": "mysql",
  "setupPending": true,
  "mysql": {
    "host": "$(json_escape "$host")",
    "port": $port,
    "user": "$(json_escape "$user")",
    "password": "$(json_escape "$password")",
    "database": "$(json_escape "$database")",
    "ssl": $ssl
  }
}
EOF
  else
    cat > "$config_file" <<EOF
{
  "type": "postgresql",
  "setupPending": true,
  "postgresql": {
    "host": "$(json_escape "$host")",
    "port": $port,
    "user": "$(json_escape "$user")",
    "password": "$(json_escape "$password")",
    "database": "$(json_escape "$database")",
    "ssl": $ssl
  }
}
EOF
  fi
  chmod 600 "$config_file" 2>/dev/null || true
}

resolve_runtime_env() {
  local existing_port existing_jwt
  existing_port="$(get_env_value PORT || true)"
  existing_jwt="$(get_env_value JWT_SECRET || true)"

  if [ -n "$existing_port" ] && valid_port "$existing_port"; then
    PORT="$existing_port"
  elif ! valid_port "$PORT"; then
    PORT="9810"
  fi

  if [ -z "${JWT_SECRET:-}" ] && [ -n "$existing_jwt" ]; then
    JWT_SECRET="$existing_jwt"
  fi
  resolve_github_accelerator
}

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "[ERROR] Please run as root"
    exit 1
  fi
}

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

is_systemd_host() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

write_openrc_service() {
  local node_bin="$1"
  cat > "/etc/init.d/$SERVICE_NAME" <<EOF
#!/sbin/openrc-run
name="$SERVICE_NAME"
description="NEX Panel"
command="/bin/sh"
# The Node entrypoint loads .env through dotenv/config; do not source it in a shell.
command_args="-lc $(shell_quote "cd \"$APP_DIR\" && exec env DOTENV_CONFIG_PATH=\"$APP_DIR/.env\" DOTENV_CONFIG_OVERRIDE=true \"$node_bin\" dist/index.js")"
command_background=true
pidfile="/run/\${RC_SVCNAME}.pid"
output_log="$APP_DIR/data/panel.log"
error_log="$APP_DIR/data/panel.log"
depend() {
  need net
}
EOF
  chmod 755 "/etc/init.d/$SERVICE_NAME"
}

write_sysv_service() {
  local node_bin="$1"
  cat > "/etc/init.d/$SERVICE_NAME" <<EOF
#!/bin/sh
### BEGIN INIT INFO
# Provides:          $SERVICE_NAME
# Required-Start:    \$network
# Required-Stop:     \$network
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: NEX Panel
### END INIT INFO
PIDFILE=/run/$SERVICE_NAME.pid
LOGFILE=$APP_DIR/data/panel.log
# The Node entrypoint loads .env through dotenv/config; do not source it in a shell.
CMD=$(shell_quote "cd \"$APP_DIR\" && exec env DOTENV_CONFIG_PATH=\"$APP_DIR/.env\" DOTENV_CONFIG_OVERRIDE=true \"$node_bin\" dist/index.js")
start() {
  mkdir -p /run "$APP_DIR/data"
  if [ -s "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null; then return 0; fi
  nohup sh -lc "\$CMD" >> "\$LOGFILE" 2>&1 &
  echo \$! > "\$PIDFILE"
}
stop() {
  if [ -s "\$PIDFILE" ]; then kill "\$(cat "\$PIDFILE")" 2>/dev/null || true; rm -f "\$PIDFILE"; fi
}
case "\$1" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status) [ -s "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null ;;
  *) echo "Usage: \$0 {start|stop|restart|status}"; exit 1 ;;
esac
EOF
  chmod 755 "/etc/init.d/$SERVICE_NAME"
}

write_service() {
  local node_bin
  node_bin="$(command -v node)"
  mkdir -p "$APP_DIR/data"
  if is_systemd_host; then
    cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=NEX Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$node_bin dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME"
  elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
    write_openrc_service "$node_bin"
    rc-update add "$SERVICE_NAME" default >/dev/null 2>&1 || true
  elif [ -d /etc/init.d ]; then
    write_sysv_service "$node_bin"
    command -v update-rc.d >/dev/null 2>&1 && update-rc.d "$SERVICE_NAME" defaults >/dev/null 2>&1 || true
    command -v chkconfig >/dev/null 2>&1 && chkconfig "$SERVICE_NAME" on >/dev/null 2>&1 || true
  else
    echo "[ERROR] Unsupported init system, please install systemd/OpenRC/SysV init support"
    exit 1
  fi
}

restart_service() {
  panel_step 5 "重启面板"
  # 面板里点的升级是面板进程的子进程，systemctl restart 会连本脚本一起杀掉，后面的 [DONE] 行
  # 到不了面板日志，所以用时在重启前先报一次。
  echo "[NEX] restarting panel service (elapsed $(elapsed_seconds)s)"
  if is_systemd_host; then
    systemctl restart "$SERVICE_NAME"
  elif command -v rc-service >/dev/null 2>&1; then
    rc-service "$SERVICE_NAME" restart
  elif [ -x "/etc/init.d/$SERVICE_NAME" ]; then
    "/etc/init.d/$SERVICE_NAME" restart
  else
    echo "[ERROR] Service manager not found for $SERVICE_NAME"
    exit 1
  fi
}

remove_service() {
  if is_systemd_host; then
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload 2>/dev/null || true
  fi
  if command -v rc-service >/dev/null 2>&1; then
    rc-service "$SERVICE_NAME" stop 2>/dev/null || true
  fi
  if command -v rc-update >/dev/null 2>&1; then
    rc-update del "$SERVICE_NAME" default 2>/dev/null || true
  fi
  if [ -x "/etc/init.d/$SERVICE_NAME" ]; then
    "/etc/init.d/$SERVICE_NAME" stop 2>/dev/null || true
  fi
  command -v update-rc.d >/dev/null 2>&1 && update-rc.d -f "$SERVICE_NAME" remove >/dev/null 2>&1 || true
  command -v chkconfig >/dev/null 2>&1 && chkconfig "$SERVICE_NAME" off >/dev/null 2>&1 || true
  rm -f "/etc/init.d/$SERVICE_NAME"
}

confirm_yes() {
  local prompt="$1"
  local answer=""

  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf "%s" "$prompt" > /dev/tty
    IFS= read -r answer < /dev/tty || answer=""
  else
    echo "[INFO] Non-interactive environment, defaulting to N: $prompt"
  fi

  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

latest_release_version() {
  local api_url="${FORWARDX_GITHUB_API_URL:-https://api.github.com/repos/${REPO_SLUG}/releases/latest}"
  local accelerated_url=""
  local tag=""
  accelerated_url="$(accelerated_github_url "$api_url")"
  if [ "$accelerated_url" != "$api_url" ]; then
    tag="$(release_tag_from_url "$accelerated_url")"
    if [ -n "$tag" ]; then
      printf "%s\n" "$tag"
      return
    fi
    echo "[WARN] GitHub accelerator version check failed; falling back to GitHub." >&2
  fi
  tag="$(release_tag_from_url "$api_url")"

  if [ -z "$tag" ]; then
    echo "[ERROR] Failed to resolve latest release version from GitHub API: $api_url" >&2
    echo "[INFO] A 404 here usually means the repository has no published release yet." >&2
    echo "[INFO] Push a version tag to build one, or pin a version with FORWARDX_TARGET_VERSION=x.y.z." >&2
    return 1
  fi
  printf "%s\n" "$tag"
}

resolve_release_version() {
  local requested="${FORWARDX_TARGET_VERSION:-}"
  local normalized=""

  if [ -n "$requested" ]; then
    normalized="$(normalize_version "$requested")"
  else
    normalized="$(latest_release_version)"
  fi

  if [[ ! "$normalized" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "[ERROR] Invalid release version: ${normalized:-<empty>}" >&2
    return 1
  fi
  printf "%s\n" "$normalized"
}

panel_bundle_url() {
  local version="$1"
  local filename="${PANEL_BUNDLE_PREFIX}${version}.tar.gz"
  printf "https://github.com/%s/releases/download/v%s/%s\n" "$REPO_SLUG" "$version" "$filename"
}

node_major_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "0"
    return
  fi
  node -p "Number(process.versions.node.split('.')[0] || 0)" 2>/dev/null || echo "0"
}

has_local_base_deps() {
  command -v curl >/dev/null 2>&1 \
    && command -v tar >/dev/null 2>&1 \
    && command -v openssl >/dev/null 2>&1 \
    && { command -v xz >/dev/null 2>&1 || command -v unxz >/dev/null 2>&1; }
}

ensure_node_runtime() {
  local major="0"
  major="$(node_major_version)"
  if [ "$major" -ge 22 ]; then
    return
  fi

  echo "[INFO] Installing Node.js 22+ ..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y -q nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    yum install -y -q nodejs
  elif command -v zypper >/dev/null 2>&1; then
    zypper -n install nodejs22 npm22 || zypper -n install nodejs npm
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs npm
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm nodejs npm
  else
    echo "[ERROR] Unsupported package manager, please install Node.js 22+ manually"
    exit 1
  fi

  major="$(node_major_version)"
  if [ "$major" -lt 22 ]; then
    echo "[ERROR] Node.js 22+ is required, current major version is $major"
    exit 1
  fi
}

install_deps() {
  if has_local_base_deps; then
    echo "[INFO] Runtime base dependencies are already installed, skip package manager update."
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates tar xz-utils openssl >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl ca-certificates tar xz openssl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl ca-certificates tar xz openssl
  elif command -v zypper >/dev/null 2>&1; then
    zypper -n install curl ca-certificates tar xz openssl
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl ca-certificates tar xz openssl
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm curl ca-certificates tar xz openssl
  fi

  ensure_node_runtime

  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null 2>&1 || npm install -g "pnpm@${PNPM_VERSION}"
  else
    npm install -g "pnpm@${PNPM_VERSION}"
  fi
}

download_panel_bundle() {
  local version="$1"
  local tmp_dir url archive http_code
  tmp_dir="$(mktemp -d)"
  archive="$tmp_dir/panel.tar.gz"
  url="$(panel_bundle_url "$version")"

  panel_step 2 "下载面板包"
  echo "[INFO] Downloading panel bundle: $url"
  http_code="$(download_github_archive "$url" "$archive")"
  if [ "$http_code" = "404" ]; then
    rm -rf "$tmp_dir"
    echo "[INFO] Panel bundle for v$version is not available yet."
    echo "[INFO] GitHub Actions may still be building or uploading release assets. Please retry later."
    exit "$ASSETS_PENDING_EXIT_CODE"
  fi
  if [ "$http_code" != "200" ]; then
    rm -rf "$tmp_dir"
    if [ "$http_code" = "invalid-archive" ]; then
      echo "[ERROR] Downloaded panel bundle is not a valid tar.gz archive"
    else
      echo "[ERROR] Failed to download panel bundle from GitHub release (HTTP ${http_code:-unknown})"
    fi
    exit 1
  fi

  panel_step 3 "解压文件"
  mkdir -p "$APP_DIR"
  seed_dependency_fingerprint
  rm -rf "$APP_DIR/dist" "$APP_DIR/client" "$APP_DIR/drizzle" "$APP_DIR/plugins" "$APP_DIR/scripts"
  rm -f "$APP_DIR/package.json" "$APP_DIR/pnpm-lock.yaml" "$APP_DIR/pnpm-workspace.yaml"

  if ! tar -xzf "$archive" -C "$APP_DIR"; then
    rm -rf "$tmp_dir"
    echo "[ERROR] Failed to extract panel bundle"
    exit 1
  fi
  rm -rf "$tmp_dir"
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    openssl dgst -sha256 | sed -E 's/^.*= *//'
  fi
}

dependency_fingerprint() {
  # 决定 node_modules 内容的全部输入：锁文件、package.json 里和依赖有关的段、pnpm 的 workspace 配置、
  # 补丁文件、以及 node / pnpm 版本（原生模块要按 node 版本重编，pnpm 大版本换了布局也不一样）。
  # 两次补丁发布之间这些几乎从不变，变了才值得花几分钟重装。
  local dir="$1"
  local file=""
  {
    printf "node=%s\n" "$(node --version 2>/dev/null || echo unknown)"
    printf "pnpm=%s\n" "$(pnpm --version 2>/dev/null || echo unknown)"
    printf "lock:\n"
    cat "$dir/pnpm-lock.yaml" 2>/dev/null || true
    printf "\nworkspace:\n"
    cat "$dir/pnpm-workspace.yaml" 2>/dev/null || true
    printf "\npackage:\n"
    (cd "$dir" && node -e '
      const pkg = require("./package.json");
      const picked = {};
      for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "pnpm", "packageManager", "overrides", "resolutions", "engines"]) {
        if (pkg[key] !== undefined) picked[key] = pkg[key];
      }
      process.stdout.write(JSON.stringify(picked));
    ' 2>/dev/null) || cat "$dir/package.json" 2>/dev/null || true
    printf "\npatches:\n"
    if [ -d "$dir/patches" ]; then
      find "$dir/patches" -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r file; do
        printf "%s\n" "${file#"$dir"/}"
        cat "$file"
        printf "\n"
      done
    fi
  } | sha256_stdin
}

seed_dependency_fingerprint() {
  # 依赖指纹是 2.3.398 的脚本才开始写的。更早的脚本装出来的 node_modules 没有指纹，
  # 第一次用新脚本升级时就只能保守地重装一遍 —— 哪怕两个版本之间依赖一个字节都没变，
  # 国内机器上要好几分钟。面板此刻正跑在这份 node_modules 上，它就是按当前（即将被替换的）
  # 锁文件装出来的，所以在解压新包之前，用旧文件把指纹补上。之后和新包算出来的指纹一比，
  # 没变就跳过安装。
  local fingerprint_file="$APP_DIR/node_modules/$DEPS_FINGERPRINT_NAME"
  local fingerprint=""
  [ -f "$fingerprint_file" ] && return 0
  [ -f "$APP_DIR/pnpm-lock.yaml" ] || return 0
  [ -d "$APP_DIR/node_modules/.pnpm" ] && [ -f "$APP_DIR/node_modules/.modules.yaml" ] || return 0
  fingerprint="$(dependency_fingerprint "$APP_DIR" 2>/dev/null || true)"
  [ -n "$fingerprint" ] || return 0
  printf "%s\n" "$fingerprint" > "$fingerprint_file" 2>/dev/null || true
  echo "[NEX] Recorded the dependency fingerprint of the running install"
}

install_runtime_dependencies() {
  local fingerprint=""
  local stored=""
  local fingerprint_file=""
  cd "$APP_DIR"
  fingerprint_file="$APP_DIR/node_modules/$DEPS_FINGERPRINT_NAME"
  if [ ! -f pnpm-lock.yaml ]; then
    panel_step 4 "安装依赖"
    rm -rf node_modules
    npm install --omit=dev
    return
  fi
  fingerprint="$(dependency_fingerprint "$APP_DIR" 2>/dev/null || true)"
  stored="$(cat "$fingerprint_file" 2>/dev/null || true)"
  if [ -n "$fingerprint" ] && [ "$fingerprint" = "$stored" ] \
    && [ -d node_modules/.pnpm ] && [ -f node_modules/.modules.yaml ]; then
    panel_step 4 "依赖未变化，跳过安装"
    echo "[NEX] Dependencies unchanged since last install, skipping pnpm install"
    return
  fi
  panel_step 4 "安装依赖"
  rm -f "$fingerprint_file"
  # 不再先删 node_modules：pnpm 自己会对着锁文件增删，绝大多数包已经在，几十秒就完；
  # 对不上（node_modules 损坏之类）再退回删掉重装。
  if ! pnpm install --prod --frozen-lockfile --prefer-offline; then
    echo "[WARN] pnpm install could not reconcile the existing node_modules; reinstalling from scratch"
    rm -rf node_modules
    pnpm install --prod --frozen-lockfile
  fi
  if [ -n "$fingerprint" ] && [ -d node_modules ]; then
    printf "%s\n" "$fingerprint" > "$fingerprint_file" 2>/dev/null || true
  fi
}

write_env() {
  local jwt_secret="${JWT_SECRET:-}"
  if [ -z "$jwt_secret" ]; then
    jwt_secret="$(openssl rand -hex 32 2>/dev/null || date +%s%N | sha256sum | awk '{print $1}')"
  fi
  mkdir -p "$APP_DIR/data"
  cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
PORT=$PORT
DATABASE_CONFIG_PATH=$APP_DIR/data/database.json
SQLITE_PATH=$APP_DIR/data/forwardx.db
MYSQL_CONFIG_PATH=$APP_DIR/data/mysql.json
JWT_SECRET=$jwt_secret
FORWARDX_PORT_CONFIG_PATH=$APP_DIR/.env
FORWARDX_PORT_MANAGEMENT=local
FORWARDX_GITHUB_ACCELERATOR_URL="$GITHUB_ACCELERATOR_URL"
FORWARDX_UPGRADE_COMMAND="/bin/bash $APP_DIR/scripts/install-panel-local.sh upgrade"
EOF
}

install_panel() {
  local release_version
  require_root
  resolve_runtime_env
  read_install_port
  panel_step 1 "检查发布资产"
  install_deps
  release_version="$(resolve_release_version)"
  download_panel_bundle "$release_version"
  install_runtime_dependencies
  write_env
  read_database_config
  write_service
  restart_service
  echo "[NEX] elapsed $(elapsed_seconds)s"
  echo "[DONE] NEX panel started (release v$release_version) in $(elapsed_seconds)s: http://SERVER_IP:$PORT"
}

upgrade_panel() {
  local release_version
  require_root
  resolve_runtime_env
  panel_step 1 "检查发布资产"
  install_deps
  release_version="$(resolve_release_version)"
  download_panel_bundle "$release_version"
  install_runtime_dependencies
  write_env
  write_service
  restart_service
  echo "[NEX] elapsed $(elapsed_seconds)s"
  echo "[DONE] NEX panel upgraded to release v$release_version and restarted in $(elapsed_seconds)s"
}

uninstall_panel() {
  require_root
  if ! confirm_yes "Confirm uninstall NEX local panel and remove service files? [y/N] "; then
    echo "[INFO] Uninstall cancelled"
    return
  fi
  remove_service

  if confirm_yes "Remove panel directory $APP_DIR ? [y/N] "; then
    rm -rf "$APP_DIR"
    echo "[DONE] Removed $APP_DIR"
  else
    echo "[DONE] Service uninstalled, kept $APP_DIR"
  fi
}

reset_admin_password() {
  require_root
  local node_bin password confirmation selector status
  node_bin="$(command -v node || true)"
  if [ -z "$node_bin" ]; then
    echo "[ERROR] Node.js is not installed on this host."
    return 1
  fi
  if [ ! -f "$APP_DIR/dist/reset-admin-password.js" ]; then
    echo "[ERROR] Password reset CLI is missing from $APP_DIR. Upgrade the panel first."
    return 1
  fi
  if [ ! -f "$APP_DIR/.env" ]; then
    echo "[ERROR] Panel environment file not found: $APP_DIR/.env"
    return 1
  fi
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    echo "[ERROR] reset-admin requires an interactive SSH terminal."
    return 1
  fi

  echo "[WARN] This revokes all existing administrator sessions. Back up the database first."
  printf "Administrator username or email (blank if only one): " > /dev/tty
  IFS= read -r selector < /dev/tty || selector=""
  password="$(read_secret "New administrator password: ")"
  confirmation="$(read_secret "Confirm administrator password: ")"
  if [ "$password" != "$confirmation" ]; then
    echo "[ERROR] Password confirmation does not match."
    unset password confirmation selector
    return 1
  fi

  set +e
  (
    cd "$APP_DIR" || exit 1
    cli_args=(--stdin)
    if [ "$ENABLE_ADMIN_ACCOUNT" = "true" ]; then cli_args+=(--enable-account); fi
    printf '%s\n%s\n%s\n' "$selector" "$password" "$confirmation" \
      | env DOTENV_CONFIG_PATH="$APP_DIR/.env" DOTENV_CONFIG_OVERRIDE=true \
        "$node_bin" dist/reset-admin-password.js "${cli_args[@]}"
  )
  status=$?
  set -e
  unset password confirmation selector
  return "$status"
}

case "$ACTION" in
  install) install_panel ;;
  upgrade|update) upgrade_panel ;;
  uninstall|remove) uninstall_panel ;;
  reset-admin|reset-password) reset_admin_password ;;
  *)
    usage
    exit 1
    ;;
esac
