#!/bin/bash
set -euo pipefail

ACTION="install"
APP_DIR="${FORWARDX_DOCKER_DIR:-/opt/forwardx-docker}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-forwardx}"
CONTAINER_NAME="${FORWARDX_CONTAINER_NAME:-forwardx-panel}"
EXPLICIT_PORT="${PORT:-}"
PORT="${EXPLICIT_PORT:-9810}"
REPO_SLUG="${FORWARDX_GITHUB_REPO:-zhongyizhu11-jpg/NEX}"
IMAGE_REPO="${FORWARDX_IMAGE_REPO:-ghcr.io/zhongyizhu11-jpg/forwardx}"
ASSETS_PENDING_EXIT_CODE=12
# 面板端靠 "[NEX] step N/M …" 行画进度条，改动格式要连 client/src/lib/panelUpgrade.ts 一起改。
PANEL_STEP_TOTAL=4
SCRIPT_STARTED_AT="$(date +%s)"
ENABLE_ADMIN_ACCOUNT="false"
# migrate-forwardx / rollback-forwardx 用：--yes 跳过确认、--target-db-config 导进外部空库、--backup-dir 指定回退用的备份
ASSUME_YES="false"
TARGET_DB_CONFIG=""
ROLLBACK_BACKUP_DIR=""
EXPLICIT_FORWARDX_IMAGE="${FORWARDX_IMAGE:-}"
DATA_VOLUME_REUSE_NOTIFIED="false"
RESOLVED_IMAGE=""
EXPECTED_PANEL_VERSION=""
GITHUB_ACCELERATOR_URL=""
GITHUB_ACCELERATOR_EXPLICIT="false"
if [ "${FORWARDX_GITHUB_ACCELERATOR_URL+x}" = "x" ]; then
  GITHUB_ACCELERATOR_URL="$FORWARDX_GITHUB_ACCELERATOR_URL"
  GITHUB_ACCELERATOR_EXPLICIT="true"
fi

usage() {
  cat <<EOF
Usage: $0 install|upgrade|uninstall|reset-admin|reset-password|migrate-forwardx|rollback-forwardx [options]

Options:
  --github-accelerator URL   Prefix GitHub API/raw/release URLs with this HTTP(S) accelerator.
                             Docker image pulls still use FORWARDX_IMAGE/FORWARDX_IMAGE_REPO.
  --enable-account           With reset-admin, enable the selected administrator account.
  --yes                      With migrate-forwardx / rollback-forwardx, skip the confirmation prompt.
  --target-db-config FILE    With migrate-forwardx, import into the empty MySQL/PostgreSQL database
                             described by FILE (NEX database.json format) instead of a new SQLite file.
  --backup-dir DIR           With rollback-forwardx, the backup created by migrate-forwardx.

migrate-forwardx moves an original ForwardX (poouo/Forwardx) Docker panel to NEX: the original
.env, compose file, data volume and image are kept as a backup and restored if anything fails.

Environment:
  FORWARDX_GITHUB_ACCELERATOR_URL   Same as --github-accelerator; an explicit empty value disables it.
EOF
}

parse_args() {
  local action_seen="false"
  local value=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      install|upgrade|update|uninstall|remove|reset-admin|reset-password|migrate-forwardx|rollback-forwardx)
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
      --yes|-y)
        ASSUME_YES="true"
        shift
        ;;
      --target-db-config|--backup-dir)
        if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
          echo "[ERROR] $1 requires a path" >&2
          usage >&2
          exit 1
        fi
        if [ "$1" = "--target-db-config" ]; then TARGET_DB_CONFIG="$2"; else ROLLBACK_BACKUP_DIR="$2"; fi
        shift 2
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

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "[ERROR] Please run as root"
    exit 1
  fi
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

valid_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
}

start_docker_service() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl enable --now docker 2>/dev/null || systemctl restart docker 2>/dev/null || true
  elif command -v rc-service >/dev/null 2>&1; then
    rc-update add docker default 2>/dev/null || true
    rc-service docker restart 2>/dev/null || rc-service docker start 2>/dev/null || true
  elif command -v service >/dev/null 2>&1; then
    service docker restart 2>/dev/null || service docker start 2>/dev/null || true
  elif [ -x /etc/init.d/docker ]; then
    /etc/init.d/docker restart 2>/dev/null || /etc/init.d/docker start 2>/dev/null || true
  fi
}

normalize_version() {
  local raw="${1:-}"
  raw="${raw#v}"
  printf "%s\n" "$raw"
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "[ERROR] Docker Compose not found, please install Docker Compose plugin first"
    exit 1
  fi
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
  echo "[NEX] step $1/$PANEL_STEP_TOTAL $2"
}

elapsed_seconds() {
  local now=""
  now="$(date +%s)"
  printf "%s\n" "$((now - SCRIPT_STARTED_AT))"
}

get_compose_host_port() {
  local file="$APP_DIR/docker-compose.yml"
  local port=""
  if [ ! -f "$file" ]; then
    return 0
  fi

  port="$(sed -nE 's/^[[:space:]]*-[[:space:]]*"?([0-9]{1,5}):3000(\/[a-zA-Z]+)?"?[[:space:]]*$/\1/p' "$file" | head -1 || true)"
  if valid_port "$port"; then
    printf "%s" "$port"
    return
  fi

  port="$(sed -nE 's/^[[:space:]]*-[[:space:]]*"?[^"]+:([0-9]{1,5}):3000(\/[a-zA-Z]+)?"?[[:space:]]*$/\1/p' "$file" | head -1 || true)"
  if valid_port "$port"; then
    printf "%s" "$port"
    return
  fi
}

get_container_host_port() {
  local id=""
  local output=""
  local port=""
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi

  output="$(docker port "$CONTAINER_NAME" 3000/tcp 2>/dev/null || true)"
  port="$(printf "%s\n" "$output" | sed -nE 's/.*:([0-9]{1,5})$/\1/p' | head -1 || true)"
  if valid_port "$port"; then
    printf "%s" "$port"
    return
  fi

  id="$(docker ps -aq \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=forwardx" 2>/dev/null | head -1 || true)"
  if [ -z "$id" ]; then
    return 0
  fi
  output="$(docker port "$id" 3000/tcp 2>/dev/null || true)"
  port="$(printf "%s\n" "$output" | sed -nE 's/.*:([0-9]{1,5})$/\1/p' | head -1 || true)"
  if valid_port "$port"; then
    printf "%s" "$port"
  fi
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

read_database_config_json() {
  local choice host port user password database ssl
  DATABASE_CONFIG_JSON=""
  if [ "$ACTION" != "install" ]; then
    return
  fi
  if docker volume inspect "$(data_volume_name)" >/dev/null 2>&1; then
    echo "[WARN] Existing Docker data volume detected; preserving its database configuration and administrator data."
    echo "[INFO] Database selection is skipped on reinstall. Use the existing administrator account, or fully uninstall and confirm volume deletion before a clean install."
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
    DATABASE_CONFIG_JSON="$(cat <<EOF
{
  "type": "sqlite",
  "setupPending": true,
  "sqlite": {
    "path": "/data/forwardx.db"
  }
}
EOF
)"
    return
  fi
  if [ "$choice" != "2" ] && [ "$choice" != "3" ]; then
    echo "[INFO] Unknown database choice, database can be selected on first panel visit." > /dev/tty
    return
  fi

  echo "[INFO] Database host must be reachable from inside the NEX panel container." > /dev/tty
  echo "[INFO] If the database runs on the host, try host.docker.internal or the host LAN IP instead of 127.0.0.1." > /dev/tty
  echo "[INFO] If the database runs in another container, make sure both containers share a Docker network and use the database service/container name." > /dev/tty

  if [ "$choice" = "2" ]; then
    printf "MySQL host [host.docker.internal]: " > /dev/tty
    IFS= read -r host < /dev/tty || host=""
    host="${host:-host.docker.internal}"
    port="$(read_database_port "MySQL port" "3306")"
  else
    printf "PostgreSQL host [host.docker.internal]: " > /dev/tty
    IFS= read -r host < /dev/tty || host=""
    host="${host:-host.docker.internal}"
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

  if [ "$choice" = "2" ]; then
    DATABASE_CONFIG_JSON="$(cat <<EOF
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
)"
  else
    DATABASE_CONFIG_JSON="$(cat <<EOF
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
)"
  fi
}

write_database_config_to_volume() {
  if [ -z "${DATABASE_CONFIG_JSON:-}" ]; then
    return
  fi
  ensure_data_volume
  printf "%s\n" "$DATABASE_CONFIG_JSON" | docker run --rm -i -v "$(data_volume_name):/data" busybox sh -c 'umask 077; cat > /data/database.json'
}

data_volume_name() {
  printf "%s_forwardx-data" "$PROJECT_NAME"
}

panel_container_ids() {
  {
    docker inspect --format '{{.Id}}' "$CONTAINER_NAME" 2>/dev/null || true
    docker ps -aq --filter "name=^/${CONTAINER_NAME}$" 2>/dev/null || true
    docker ps -aq \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
      --filter "label=com.docker.compose.service=forwardx" 2>/dev/null || true
  } | awk 'NF && !seen[$0]++'
}

panel_data_volume_names() {
  local ids=""
  local id=""
  ids="$(panel_container_ids)"
  if [ -z "$ids" ]; then
    return
  fi
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}{{end}}' "$id" 2>/dev/null || true
  done <<< "$ids" | awk 'NF && !seen[$0]++'
}

uninstall_volume_state_file() {
  printf "%s/.forwardx-uninstall-volumes" "$APP_DIR"
}

uninstall_data_volume_names() {
  local state_file=""
  state_file="$(uninstall_volume_state_file)"
  {
    printf "%s\n" "$(data_volume_name)"
    if [ -f "$state_file" ]; then
      awk 'NF' "$state_file"
    fi
    panel_data_volume_names
  } | awk 'NF && !seen[$0]++'
}

persist_uninstall_data_volume_names() {
  local volume_names="$1"
  local state_file=""
  state_file="$(uninstall_volume_state_file)"
  mkdir -p "$APP_DIR"
  (umask 077; printf "%s\n" "$volume_names" > "$state_file")
}

ensure_data_volume() {
  local volume_name
  volume_name="$(data_volume_name)"
  if docker volume inspect "$volume_name" >/dev/null 2>&1; then
    if [ "$ACTION" = "install" ] && [ "$DATA_VOLUME_REUSE_NOTIFIED" != "true" ]; then
      echo "[WARN] Existing Docker data volume will be reused: $volume_name"
      echo "[WARN] Existing SQLite data and administrator credentials are retained. Run the uninstall action and confirm volume deletion before a clean reinstall."
      DATA_VOLUME_REUSE_NOTIFIED="true"
    fi
    return
  fi
  docker volume create \
    --label "com.docker.compose.project=${PROJECT_NAME}" \
    --label "com.docker.compose.volume=forwardx-data" \
    "$volume_name" >/dev/null
}

load_existing_env() {
  local value public_value compose_port container_port port_source
  value="$(get_env_value COMPOSE_PROJECT_NAME || true)"
  if [ -n "$value" ]; then PROJECT_NAME="$value"; fi
  value="$(get_env_value FORWARDX_CONTAINER_NAME || true)"
  if [ -n "$value" ]; then CONTAINER_NAME="$value"; fi

  if [ -n "$EXPLICIT_PORT" ] && valid_port "$EXPLICIT_PORT"; then
    PORT="$EXPLICIT_PORT"
    port_source="environment"
  else
    container_port="$(get_container_host_port || true)"
    compose_port="$(get_compose_host_port || true)"
    value="$(get_env_value PORT || true)"
    public_value="$(get_env_value FORWARDX_PUBLIC_PORT || true)"
    if [ -n "$container_port" ] && valid_port "$container_port"; then
      PORT="$container_port"
      port_source="running container"
    elif [ -n "$compose_port" ] && valid_port "$compose_port"; then
      PORT="$compose_port"
      port_source="docker-compose.yml"
    elif [ -n "$value" ] && valid_port "$value"; then
      PORT="$value"
      port_source=".env PORT"
    elif [ -n "$public_value" ] && valid_port "$public_value"; then
      PORT="$public_value"
      port_source=".env FORWARDX_PUBLIC_PORT"
    fi
  fi
  if [ -n "${port_source:-}" ]; then
    echo "[INFO] Reusing Docker public port from ${port_source}: ${PORT}"
    [ "$port_source" = "environment" ] || PORT_REUSED=1
  fi

  value="$(get_env_value FORWARDX_IMAGE || true)"
  if [ -n "$value" ] && [ -z "${FORWARDX_IMAGE:-}" ] && [ "$ACTION" = "install" ]; then FORWARDX_IMAGE="$value"; fi
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

resolve_image_selection() {
  local version=""
  RESOLVED_IMAGE=""
  EXPECTED_PANEL_VERSION=""

  if [ -n "$EXPLICIT_FORWARDX_IMAGE" ]; then
    RESOLVED_IMAGE="$EXPLICIT_FORWARDX_IMAGE"
    if [ -n "${FORWARDX_TARGET_VERSION:-}" ]; then
      if ! EXPECTED_PANEL_VERSION="$(resolve_release_version)"; then
        return 1
      fi
    fi
    return
  fi

  if ! version="$(resolve_release_version)"; then
    return 1
  fi
  EXPECTED_PANEL_VERSION="$version"
  RESOLVED_IMAGE="${IMAGE_REPO}:v${version}"
}

install_base_deps() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl openssl >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl ca-certificates openssl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl ca-certificates openssl
  elif command -v zypper >/dev/null 2>&1; then
    zypper -n install curl ca-certificates openssl
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl ca-certificates openssl
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm curl ca-certificates openssl
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "[INFO] Docker is already installed, skip package manager update."
    start_docker_service
    return
  fi
  install_base_deps
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
    start_docker_service
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q docker
    start_docker_service
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q docker
    start_docker_service
  elif command -v zypper >/dev/null 2>&1; then
    zypper -n install docker docker-compose-plugin || zypper -n install docker docker-compose
    start_docker_service
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache docker docker-cli-compose
    start_docker_service
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm docker docker-compose
    start_docker_service
  fi
}

write_compose_file() {
  mkdir -p "$APP_DIR"
  cat > "$APP_DIR/docker-compose.yml" <<'EOF'
name: ${COMPOSE_PROJECT_NAME:-forwardx}

services:
  forwardx:
    image: ${FORWARDX_IMAGE}
    container_name: ${FORWARDX_CONTAINER_NAME:-forwardx-panel}
    restart: unless-stopped
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "${PORT:-9810}:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      FORWARDX_PUBLIC_PORT: ${PORT:-9810}
      FORWARDX_PORT_MANAGEMENT: docker
      DATABASE_CONFIG_PATH: /data/database.json
      SQLITE_PATH: /data/forwardx.db
      MYSQL_CONFIG_PATH: /data/mysql.json
      POSTGRES_URL: ${POSTGRES_URL:-}
      POSTGRES_HOST: ${POSTGRES_HOST:-}
      POSTGRES_PORT: ${POSTGRES_PORT:-5432}
      POSTGRES_USER: ${POSTGRES_USER:-}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-}
      POSTGRES_DATABASE: ${POSTGRES_DATABASE:-}
      POSTGRES_SSL: ${POSTGRES_SSL:-false}
      JWT_SECRET: ${JWT_SECRET:-}
      FORWARDX_TRUST_PROXY: ${FORWARDX_TRUST_PROXY:-loopback}
    volumes:
      - forwardx-data:/data
    logging:
      driver: local
      options:
        max-size: "${FORWARDX_LOG_MAX_SIZE:-20m}"
        max-file: "${FORWARDX_LOG_MAX_FILES:-3}"

volumes:
  forwardx-data:
    name: ${COMPOSE_PROJECT_NAME:-forwardx}_forwardx-data
    external: true
EOF
}

write_env() {
  local image="$1"
  local existing_jwt jwt_secret
  # 反向代理的信任范围（server/trustProxy.ts）：.env 每次升级都会重写，管理员设过的值要带过去
  local trust_proxy="${FORWARDX_TRUST_PROXY:-$(get_env_value FORWARDX_TRUST_PROXY || true)}"
  if ! valid_port "$PORT"; then
    PORT="9810"
  fi

  existing_jwt="$(get_env_value JWT_SECRET || true)"
  jwt_secret="${JWT_SECRET:-$existing_jwt}"
  if [ -z "$jwt_secret" ]; then
    jwt_secret="$(openssl rand -hex 32 2>/dev/null || date +%s%N | sha256sum | awk '{print $1}')"
  fi
  cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
FORWARDX_PUBLIC_PORT=$PORT
JWT_SECRET=$jwt_secret
COMPOSE_PROJECT_NAME=$PROJECT_NAME
FORWARDX_CONTAINER_NAME=$CONTAINER_NAME
FORWARDX_IMAGE=$image
FORWARDX_GITHUB_ACCELERATOR_URL="$GITHUB_ACCELERATOR_URL"
EOF
  if [ -n "$trust_proxy" ]; then
    printf 'FORWARDX_TRUST_PROXY=%s\n' "$trust_proxy" >> "$APP_DIR/.env"
  fi
}

remove_existing_panel_containers() {
  local ids=""
  local id=""
  ids="$(panel_container_ids)"
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    if docker rm -f "$id" >/dev/null 2>&1; then
      echo "[INFO] Removed previous NEX container: $id"
    fi
  done <<< "$ids"
}

image_panel_version() {
  local image="$1"
  docker run --rm --entrypoint node "$image" -p "require('./package.json').version"
}

image_label_version() {
  local image="$1"
  docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image"
}

image_id() {
  local image="$1"
  docker image inspect --format '{{.Id}}' "$image"
}

assert_target_image_ready() {
  local image="$1"
  local expected="${2:-}"
  local package_version=""
  local label_version=""
  local normalized_label=""
  if [ -z "$expected" ]; then
    return
  fi
  expected="$(normalize_version "$expected")"
  package_version="$(image_panel_version "$image" 2>/dev/null || true)"
  package_version="$(normalize_version "$package_version")"
  label_version="$(image_label_version "$image" 2>/dev/null || true)"
  label_version="$(normalize_version "$label_version")"
  normalized_label="$(printf "%s" "$label_version" | tr '[:upper:]' '[:lower:]')"

  if [ "$package_version" != "$expected" ]; then
    echo "[ERROR] Pulled NEX image failed version verification: $image"
    echo "[ERROR] Expected v$expected; package=${package_version:-unreadable}; label=${label_version:-unreadable}"
    echo "[INFO] The release image may still be publishing, or a Docker registry mirror/proxy may be serving stale content."
    echo "[INFO] Check 'docker info' for Registry Mirrors, bypass or purge the stale mirror cache, then retry the upgrade."
    exit "$ASSETS_PENDING_EXIT_CODE"
  fi

  case "$normalized_label" in
    ""|unknown|"<no value>"|null)
      echo "[WARN] Image OCI version label is unavailable; verified the embedded package version instead."
      ;;
    "$expected")
      ;;
    *)
      echo "[ERROR] Pulled NEX image label conflicts with its expected version: $image"
      echo "[ERROR] Expected v$expected; package=v$package_version; label=v$label_version"
      echo "[INFO] A Docker registry mirror/proxy may be serving stale or inconsistent image metadata."
      echo "[INFO] Check 'docker info' for Registry Mirrors, bypass or purge the stale mirror cache, then retry the upgrade."
      exit "$ASSETS_PENDING_EXIT_CODE"
      ;;
  esac

  echo "[INFO] Verified pulled image version: v$expected"
}

running_panel_version() {
  docker exec "$CONTAINER_NAME" node -p "require('/app/package.json').version"
}

assert_running_panel_ready() {
  local expected_image_id="$1"
  local expected_version="${2:-}"
  local running=""
  local active_image_id=""
  local running_version=""
  local attempt=0

  while [ "$attempt" -lt 15 ]; do
    running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)"
    active_image_id="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"
    if [ "$running" = "true" ]; then
      running_version="$(running_panel_version 2>/dev/null || true)"
      if [ -n "$running_version" ]; then
        break
      fi
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  if [ "$running" != "true" ]; then
    echo "[ERROR] NEX container did not remain running after recreation: $CONTAINER_NAME"
    echo "[INFO] Inspect it with: docker logs --tail 100 $CONTAINER_NAME"
    return 1
  fi
  if [ -z "$running_version" ]; then
    echo "[ERROR] Unable to read the NEX version from the running container: $CONTAINER_NAME"
    echo "[INFO] Inspect it with: docker logs --tail 100 $CONTAINER_NAME"
    return 1
  fi
  if [ -z "$expected_image_id" ] || [ "$active_image_id" != "$expected_image_id" ]; then
    echo "[ERROR] Recreated container is not using the image that was just pulled."
    echo "[ERROR] Pulled image ID: ${expected_image_id:-unreadable}"
    echo "[ERROR] Running image ID: ${active_image_id:-unreadable}"
    echo "[INFO] Check for duplicate Compose projects/containers and retry the upgrade."
    return 1
  fi

  running_version="$(normalize_version "$running_version")"
  expected_version="$(normalize_version "$expected_version")"
  if [ -n "$expected_version" ] && [ "$running_version" != "$expected_version" ]; then
    echo "[ERROR] Running NEX version mismatch: expected v$expected_version, got ${running_version:+v}${running_version:-unreadable}"
    echo "[INFO] The container image ID is correct, but its runtime package is inconsistent. Check Docker storage and registry mirror integrity."
    return 1
  fi

  echo "[INFO] Verified running NEX container: image=$active_image_id version=${running_version:+v}$running_version"
}

image_repository_from_ref() {
  local image_ref="${1%%@*}"
  local last_component="${image_ref##*/}"
  if [[ "$last_component" == *:* ]]; then
    printf "%s\n" "${image_ref%:*}"
  else
    printf "%s\n" "$image_ref"
  fi
}

cleanup_old_panel_images() {
  local image="$1"
  local repository=""
  local current_image_id=""
  local running=""
  local rows=""
  local listed_repository=""
  local tag=""
  local image_id=""
  local image_ref=""

  running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  if [ "$running" != "true" ]; then
    echo "[WARN] NEX container is not running; old image cleanup skipped."
    return
  fi

  current_image_id="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  repository="$(image_repository_from_ref "$image")"
  if [ -z "$current_image_id" ] || [ -z "$repository" ]; then
    echo "[WARN] Unable to identify the active NEX image; old image cleanup skipped."
    return
  fi

  rows="$(docker image ls --no-trunc --format '{{.Repository}}|{{.Tag}}|{{.ID}}' "$repository" 2>/dev/null || true)"
  while IFS='|' read -r listed_repository tag image_id; do
    if [ "$listed_repository" != "$repository" ] || [ -z "$tag" ] || [ "$tag" = "<none>" ]; then
      continue
    fi
    if [ "$image_id" = "$current_image_id" ]; then
      continue
    fi

    image_ref="${listed_repository}:${tag}"
    if docker image rm "$image_ref" >/dev/null 2>&1; then
      echo "[INFO] Removed old NEX image: $image_ref"
    else
      echo "[WARN] Could not remove old NEX image (it may still be in use): $image_ref"
    fi
  done <<< "$rows"
}

start_panel() {
  local image="$1"
  local expected_version="${2:-}"
  local pulled_image_id=""
  cd "$APP_DIR"
  panel_step 2 "拉取镜像"
  echo "[INFO] Pulling image: $image"
  if ! docker pull "$image"; then
    echo "[INFO] Docker image $image is not available yet."
    echo "[INFO] GitHub Actions may still be building or uploading release assets. Please retry later."
    exit "$ASSETS_PENDING_EXIT_CODE"
  fi
  assert_target_image_ready "$image" "$expected_version"
  pulled_image_id="$(image_id "$image" 2>/dev/null || true)"
  if [ -z "$pulled_image_id" ]; then
    echo "[ERROR] Unable to resolve the pulled image ID: $image"
    echo "[INFO] Check Docker daemon storage and retry the upgrade."
    return 1
  fi
  panel_step 3 "重建容器"
  remove_existing_panel_containers
  ensure_data_volume
  # 容器里点的升级（挂了 docker.sock 时）会随旧容器一起被杀，后面的行到不了面板日志，用时先报一次。
  echo "[NEX] restarting panel service (elapsed $(elapsed_seconds)s)"
  compose_cmd --env-file "$APP_DIR/.env" -p "$PROJECT_NAME" up -d --remove-orphans forwardx
  panel_step 4 "等待面板就绪"
  assert_running_panel_ready "$pulled_image_id" "$expected_version"
  cleanup_old_panel_images "$image"
}

# 这个端口上谁在监听：打印「进程名(pid)」，没人监听打印空。没有 ss / netstat 时当没人（不拦）。
port_listener_info() {
  local port="$1" out=""
  if command -v ss >/dev/null 2>&1; then
    out="$(ss -H -ltnp "sport = :$port" 2>/dev/null | head -n 1)"
    [ -n "$out" ] || return 0
    printf "%s\n" "$out" | grep -o 'users:(("[^"]*",pid=[0-9]*' | head -n 1 | sed 's/users:(("//; s/",pid=/(/; s/$/)/' | grep . || echo "未知进程"
    return 0
  fi
  if command -v netstat >/dev/null 2>&1; then
    out="$(netstat -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {print $7; exit}')"
    [ -n "$out" ] && echo "$out"
  fi
  return 0
}

# 端口能不能给面板用：没人用，或者用它的就是 NEX 面板自己（重装 / 迁移时）都算能用。
install_port_available() {
  local port="$1" info=""
  info="$(port_listener_info "$port")"
  [ -z "$info" ] && return 0
  case "$info" in
    *node*|*forwardx*|*nex*|*docker-proxy*)
      echo "[INFO] Port $port is in use by $info (looks like an existing NEX panel), keep using it."
      return 0
      ;;
  esac
  echo "[WARN] Port $port is already in use by $info."
  return 1
}

# 全新安装（没有在跑的容器、也没有旧配置里的端口）时检查端口；被别的程序占着就换一个。
ensure_install_port_free() {
  local input=""
  [ -n "${PORT_REUSED:-}" ] && return 0
  install_port_available "$PORT" && return 0
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    echo "[WARN] The panel container will fail to start until port $PORT is free; rerun with PORT=<another port> to pick one."
    return 0
  fi
  while true; do
    printf "Port %s is taken, enter another web port: " "$PORT" > /dev/tty
    IFS= read -r input < /dev/tty || input=""
    input="${input//[[:space:]]/}"
    if valid_port "$input" && install_port_available "$input" > /dev/tty; then
      PORT="$input"
      return 0
    fi
    echo "[ERROR] Port must be a free number in 1-65535, please retry." > /dev/tty
  done
}

# ── SSH 管理命令 fwxm（面板这一侧，脚本本体是 scripts/fwxm-panel.sh） ──
# 放到 /usr/local/lib/nex/fwxm-panel，部署方式和目录写进 /etc/nex/panel-manage.conf。
# /usr/local/bin/fwxm 没有、或者是我们自己写的转发脚本时，写一个转发脚本过去；已经是 Agent 的 fwxm 就不动
# （Agent 的 fwxm 认 `fwxm panel …`，会交给面板这一份）。
PANEL_MANAGER_DIR="/usr/local/lib/nex"
PANEL_MANAGER="$PANEL_MANAGER_DIR/fwxm-panel"
PANEL_MANAGER_CONF="/etc/nex/panel-manage.conf"
PANEL_FWXM_LINK="/usr/local/bin/fwxm"
PANEL_FWXM_MARKER="nex-panel-fwxm-dispatcher"

install_panel_manager() {
  local source="$1" mode="$2"
  if [ ! -s "$source" ] || ! bash -n "$source" 2>/dev/null; then
    echo "[WARN] SSH 管理命令 fwxm 没有装上（管理脚本缺失或校验失败），不影响面板运行"
    return 0
  fi
  mkdir -p "$PANEL_MANAGER_DIR" "$(dirname "$PANEL_MANAGER_CONF")" /usr/local/bin || return 0
  install -m 755 "$source" "$PANEL_MANAGER.new" && mv -f "$PANEL_MANAGER.new" "$PANEL_MANAGER" || return 0
  {
    echo "MODE=$mode"
    echo "APP_DIR=$APP_DIR"
    if [ "$mode" = docker ]; then echo "CONTAINER_NAME=$CONTAINER_NAME"; else echo "SERVICE_NAME=$SERVICE_NAME"; fi
    echo "REPO_SLUG=$REPO_SLUG"
  } > "$PANEL_MANAGER_CONF.new" && chmod 644 "$PANEL_MANAGER_CONF.new" && mv -f "$PANEL_MANAGER_CONF.new" "$PANEL_MANAGER_CONF"
  if [ ! -e "$PANEL_FWXM_LINK" ] || grep -q "$PANEL_FWXM_MARKER" "$PANEL_FWXM_LINK" 2>/dev/null; then
    cat > "$PANEL_FWXM_LINK.new" <<FWXM_DISPATCH
#!/bin/bash
# ${PANEL_FWXM_MARKER}：只装了面板时的 fwxm。同机装了 Agent 后会被 Agent 的 fwxm 换掉，它同样认 fwxm panel。
[ "\${1:-}" = panel ] && shift
exec "$PANEL_MANAGER" "\$@"
FWXM_DISPATCH
    chmod 755 "$PANEL_FWXM_LINK.new" && mv -f "$PANEL_FWXM_LINK.new" "$PANEL_FWXM_LINK"
  fi
  echo "[INFO] SSH 管理命令: fwxm（同机装了 Agent 时用 fwxm panel）查看状态、日志、升级、重置管理员密码"
}

remove_panel_manager() {
  rm -f "$PANEL_MANAGER" "$PANEL_MANAGER_CONF"
  rmdir "$PANEL_MANAGER_DIR" "$(dirname "$PANEL_MANAGER_CONF")" 2>/dev/null || true
  if grep -q "$PANEL_FWXM_MARKER" "$PANEL_FWXM_LINK" 2>/dev/null; then rm -f "$PANEL_FWXM_LINK"; fi
}

# Docker 部署本机没有面板的发布包：管理脚本按版本号从 GitHub 取（走加速站，失败回直连），取不到不影响面板。
install_panel_manager_from_github() {
  local ref="${EXPECTED_PANEL_VERSION:+v$EXPECTED_PANEL_VERSION}" tmp url
  ref="${ref:-main}"
  tmp="$(mktemp /tmp/nex-fwxm-panel.XXXXXX)" || return 0
  url="https://raw.githubusercontent.com/${REPO_SLUG}/${ref}/scripts/fwxm-panel.sh"
  if ! curl -fsSL --connect-timeout 15 "$(accelerated_github_url "$url")" -o "$tmp" 2>/dev/null; then
    curl -fsSL --connect-timeout 15 "$url" -o "$tmp" 2>/dev/null \
      || curl -fsSL --connect-timeout 15 "https://raw.githubusercontent.com/${REPO_SLUG}/main/scripts/fwxm-panel.sh" -o "$tmp" 2>/dev/null \
      || true
  fi
  install_panel_manager "$tmp" docker
  rm -f "$tmp"
}

install_panel() {
  local image
  require_root
  install_docker
  load_existing_env
  ensure_install_port_free
  resolve_github_accelerator
  read_database_config_json
  panel_step 1 "检查镜像"
  resolve_image_selection
  image="$RESOLVED_IMAGE"
  write_compose_file
  write_env "$image"
  write_database_config_to_volume
  start_panel "$image" "$EXPECTED_PANEL_VERSION"
  install_panel_manager_from_github
  echo "[NEX] elapsed $(elapsed_seconds)s"
  echo "[DONE] NEX Docker panel started in $(elapsed_seconds)s: http://SERVER_IP:$PORT"
  echo "[INFO] Image: $image"
}

upgrade_panel() {
  local image
  require_root
  load_existing_env
  resolve_github_accelerator
  install_docker
  panel_step 1 "检查镜像"
  resolve_image_selection
  image="$RESOLVED_IMAGE"
  write_compose_file
  write_env "$image"
  start_panel "$image" "$EXPECTED_PANEL_VERSION"
  install_panel_manager_from_github
  echo "[NEX] elapsed $(elapsed_seconds)s"
  echo "[DONE] NEX Docker panel upgraded and restarted in $(elapsed_seconds)s"
  echo "[INFO] Image: $image"
}

uninstall_panel() {
  local volume_names=""
  local volume_name=""
  local volume_remove_failed="false"
  require_root
  load_existing_env
  if ! confirm_yes "Confirm uninstall NEX Docker panel and delete deployment dir + Docker volume? [y/N] "; then
    echo "[INFO] Uninstall cancelled"
    return
  fi
  volume_names="$(uninstall_data_volume_names)"
  persist_uninstall_data_volume_names "$volume_names"
  cd "$APP_DIR" 2>/dev/null || true
  if [ -f "$APP_DIR/docker-compose.yml" ]; then
    compose_cmd --env-file "$APP_DIR/.env" -p "$PROJECT_NAME" down --remove-orphans || true
  fi
  remove_existing_panel_containers
  cd /
  while IFS= read -r volume_name; do
    [ -z "$volume_name" ] && continue
    if ! docker volume inspect "$volume_name" >/dev/null 2>&1; then
      continue
    fi
    if docker volume rm "$volume_name" >/dev/null 2>&1; then
      echo "[INFO] Removed Docker data volume: $volume_name"
    else
      echo "[ERROR] Failed to remove Docker data volume: $volume_name"
      echo "[ERROR] The volume is still in use or Docker refused the removal. Existing administrator credentials remain in that volume."
      volume_remove_failed="true"
    fi
  done <<< "$volume_names"
  if [ "$volume_remove_failed" = "true" ]; then
    echo "[ERROR] NEX containers were removed, but persistent data was not fully deleted."
    echo "[INFO] Deployment metadata is retained at $APP_DIR so the remaining volume can be located and the uninstall retried."
    return 1
  fi
  rm -rf "$APP_DIR"
  remove_panel_manager
  echo "[INFO] External MySQL/PostgreSQL database contents, if configured, were not deleted."
  echo "[DONE] NEX Docker panel uninstalled"
}

reset_admin_password() {
  require_root
  local running
  if ! command -v docker >/dev/null 2>&1; then
    echo "[ERROR] Docker is not installed or not available."
    return 1
  fi
  load_existing_env
  running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  if [ "$running" != "true" ]; then
    echo "[ERROR] NEX container is not running: $CONTAINER_NAME"
    echo "[INFO] Start the panel and retry; no container or database data was changed."
    return 1
  fi
  if ! docker exec "$CONTAINER_NAME" test -f /app/dist/reset-admin-password.js >/dev/null 2>&1; then
    echo "[ERROR] Password reset CLI is missing from the running container. Upgrade the panel image first."
    return 1
  fi
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    echo "[ERROR] reset-admin requires an interactive Docker terminal."
    return 1
  fi

  echo "[INFO] Starting the password reset CLI inside the Docker container."
  cli_args=()
  if [ "$ENABLE_ADMIN_ACCOUNT" = "true" ]; then cli_args+=(--enable-account); fi
  docker exec -it "$CONTAINER_NAME" node dist/reset-admin-password.js "${cli_args[@]}" < /dev/tty
}

# ── 从原版 ForwardX 迁移（migrate-forwardx / rollback-forwardx） ──
# 用在跑着原版 ForwardX（poouo/Forwardx）Docker 面板的机器上：
#   1. 先拉 NEX 镜像，用镜像里的迁移命令只读检查原版的库（原版容器照常跑），列出能迁的数据，等确认；
#   2. 停原版容器；原版的 .env、docker-compose.yml 和整个数据卷拷到 ${APP_DIR}.forwardx-backup-时间，
#      原版镜像另打一个 forwardx-migration-backup:时间 的标签（清理旧镜像时不会被删）；
#   3. 迁移命令从备份里的原版数据库导进全新的 NEX 数据库（数据卷里的 forwardx.db 换成 NEX 的），
#      换上 NEX 的 compose / .env 起容器、等数据库健康；
#   4. 第 2 步以后任何一步失败都自动回退：删 NEX 容器、数据卷按备份还原、原版 .env / compose 放回、原版镜像起容器。
# 迁完以后想退回原版：rollback-forwardx。
FORWARDX_MIGRATION_MARKER="${FORWARDX_MIGRATION_MARKER:-/etc/nex/forwardx-migration.last}"

forwardx_image_kind() {
  # 镜像里装的是哪家的面板：输出两行，第一行 forwardx / nex，第二行版本
  local image="$1" out=""
  out="$(docker run --rm --entrypoint node "$image" -p "const p = require('/app/package.json'); (/^NEX/.test(p.description || '') ? 'nex' : 'forwardx') + '\n' + p.version" 2>/dev/null || true)"
  if [ -z "$out" ]; then
    printf "unknown\n\n"
  else
    printf "%s\n" "$out"
  fi
}

manifest_value() {
  # 备份里的 manifest 只按 KEY=VALUE 读，不当脚本执行
  sed -n "s/^$2=//p" "$1/manifest" 2>/dev/null | head -1
}

backup_forwardx_fwxm() {
  # 原版装的 /usr/local/bin/fwxm（forwardx-manage.sh）会从原版仓库重装面板：留一份到备份里再删掉，
  # NEX 的 fwxm 才装得上（install_panel_manager 不覆盖别人的 fwxm）。回退时放回去。
  local backup_dir="$1"
  if [ -f "$PANEL_FWXM_LINK" ] && grep -q "ForwardX Manager" "$PANEL_FWXM_LINK" 2>/dev/null; then
    mkdir -p "$backup_dir/service"
    cp -p "$PANEL_FWXM_LINK" "$backup_dir/service/fwxm.forwardx"
    rm -f "$PANEL_FWXM_LINK"
  fi
}

wait_docker_panel_ready() {
  # 容器在跑还不够：数据库连上并且 healthy 才算起来了（/api/database-health 不查业务、不要登录）
  local attempt=0 body=""
  local limit="${FORWARDX_MIGRATE_READY_TIMEOUT:-90}"
  while [ "$attempt" -lt "$limit" ]; do
    body="$(docker exec "$CONTAINER_NAME" curl -fsS -m 3 http://127.0.0.1:3000/api/database-health 2>/dev/null || true)"
    case "$body" in
      *'"state":"healthy"'*) return 0 ;;
    esac
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "[ERROR] NEX 容器 ${limit} 秒内没有就绪（/api/database-health：${body:-无响应}），看日志：docker logs --tail 100 ${CONTAINER_NAME}"
  return 1
}

forwardx_docker_cli() {
  # 在 NEX 镜像里跑迁移命令。$1 镜像，$2 数据卷，$3 只读挂成 /source 的目录（可空），$4 挂成 /work 的目录，其余是参数
  local image="$1" volume="$2" source_dir="$3" work_dir="$4"
  shift 4
  local -a mounts=(-v "$volume:/data" -v "$work_dir:/work")
  if [ -n "$source_dir" ]; then mounts+=(-v "$source_dir:/source:ro"); fi
  docker run --rm --add-host host.docker.internal:host-gateway "${mounts[@]}" \
    -e JWT_SECRET="$(get_env_value JWT_SECRET)" \
    --entrypoint node "$image" dist/migrate-forwardx.js "$@"
}

rollback_forwardx_docker() {
  local backup_dir="$1"
  local old_image volume
  old_image="$(manifest_value "$backup_dir" OLD_IMAGE_TAG)"
  volume="$(manifest_value "$backup_dir" VOLUME)"
  if [ -z "$old_image" ] || [ -z "$volume" ] || [ ! -d "$backup_dir/data" ]; then
    echo "[ERROR] 备份不完整，没法自动回退：$backup_dir"
    return 1
  fi
  echo "[NEX] 回退到原版 ForwardX：$backup_dir"
  remove_existing_panel_containers
  if ! docker run --rm -v "$volume:/data" -v "$backup_dir/data:/backup:ro" --entrypoint sh "$old_image" \
    -c 'find /data -mindepth 1 -delete && cp -a /backup/. /data/'; then
    echo "[ERROR] 数据卷 $volume 没能按备份还原，备份还在 $backup_dir/data，请手动处理"
    return 1
  fi
  cp -p "$backup_dir/compose/.env" "$APP_DIR/.env"
  if [ -f "$backup_dir/compose/docker-compose.yml" ]; then cp -p "$backup_dir/compose/docker-compose.yml" "$APP_DIR/docker-compose.yml"; fi
  if [ -f "$backup_dir/service/fwxm.forwardx" ]; then
    mkdir -p "$(dirname "$PANEL_FWXM_LINK")"
    cp -p "$backup_dir/service/fwxm.forwardx" "$PANEL_FWXM_LINK"
  fi
  # 用备份时打的标签起原版镜像（.env 里写的可能是 latest，现在拉到的已经不是当时那一版）
  if ! (cd "$APP_DIR" && FORWARDX_IMAGE="$old_image" compose_cmd --env-file "$APP_DIR/.env" -p "$PROJECT_NAME" up -d --remove-orphans); then
    echo "[ERROR] 原版的 .env / compose / 数据卷已经换回，但容器没起来，请手动检查：cd $APP_DIR && docker compose up -d"
    return 1
  fi
  echo "[DONE] 已回到原版 ForwardX（镜像 ${old_image}）"
}

migrate_forwardx_docker() {
  local old_image_ref old_image_id old_kind old_version image volume backup_dir stamp target_arg status=0
  local -a source_args=() target_args=()
  require_root
  load_existing_env
  old_image_ref="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  old_image_id="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  if [ -z "$old_image_id" ]; then
    echo "[ERROR] 没找到原版面板容器 ${CONTAINER_NAME}（用 FORWARDX_CONTAINER_NAME 指定容器名）"
    return 1
  fi
  { read -r old_kind; read -r old_version; } < <(forwardx_image_kind "$old_image_id")
  if [ "$old_kind" = nex ]; then
    echo "[ERROR] 容器 $CONTAINER_NAME 已经是 NEX 面板了，不用迁移；升级请用 upgrade"
    return 1
  fi
  volume="$(panel_data_volume_names | head -1)"
  volume="${volume:-$(data_volume_name)}"
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "[ERROR] 没找到原版面板的数据卷 $volume"
    return 1
  fi
  if [ -n "$TARGET_DB_CONFIG" ] && [ ! -f "$TARGET_DB_CONFIG" ]; then
    echo "[ERROR] 目标数据库配置不存在：$TARGET_DB_CONFIG"
    return 1
  fi
  stamp="$(date +%Y%m%d%H%M%S)"
  backup_dir="${APP_DIR}.forwardx-backup-${stamp}"
  echo "[NEX] 检测到原版 ForwardX 面板：容器 ${CONTAINER_NAME}，镜像 ${old_image_ref:-$old_image_id}，版本 ${old_version:-未知}，数据卷 ${volume}，端口 ${PORT}"

  # 1. 拉 NEX 镜像、只读检查原版的库（原版容器照常跑）
  resolve_github_accelerator
  install_docker
  panel_step 1 "检查镜像"
  resolve_image_selection
  image="$RESOLVED_IMAGE"
  echo "[INFO] Pulling image: $image"
  if ! docker pull "$image"; then
    echo "[ERROR] 拉不到 NEX 镜像 ${image}，原版面板没有改动"
    return 1
  fi
  if ! docker run --rm --entrypoint sh "$image" -c 'test -f /app/dist/migrate-forwardx.js'; then
    echo "[ERROR] NEX 镜像 $image 里没有迁移命令 dist/migrate-forwardx.js，原版面板没有改动"
    return 1
  fi
  mkdir -p "$backup_dir/compose"
  cp -p "$APP_DIR/.env" "$backup_dir/compose/.env"
  echo "[NEX] 检查原版面板的数据库（只读）"
  if ! forwardx_docker_cli "$image" "$volume" "" "$backup_dir/compose" inspect \
    --source-config /data/database.json --source-mysql-config /data/mysql.json \
    --source-env-file /work/.env --default-sqlite /data/forwardx.db --map-path /data=/data; then
    rm -rf "$backup_dir"
    echo "[ERROR] 原版面板的数据库检查没通过，原版面板没有改动"
    return 1
  fi
  echo "[NEX] 接下来：停掉原版容器 → 数据卷和配置备份到 $backup_dir → 换成 NEX 镜像并导入数据"
  if [ -n "$TARGET_DB_CONFIG" ]; then
    echo "[NEX] 数据导进 $TARGET_DB_CONFIG 指定的数据库（必须是空库）"
  else
    echo "[NEX] 数据导进数据卷里新的 SQLite 数据库（原版的数据库留在备份里）"
  fi
  echo "[NEX] 迁移后已接入的原版 Agent 会在下一次心跳时自动换成 NEX 的 Agent"
  if [ "$ASSUME_YES" != "true" ] && ! confirm_yes "确认从原版 ForwardX 迁移到 NEX？[y/N] "; then
    rm -rf "$backup_dir"
    echo "[INFO] 已取消，原版面板没有改动"
    return 0
  fi

  # 2. 停原版、备份
  docker tag "$old_image_id" "forwardx-migration-backup:$stamp"
  docker stop "$CONTAINER_NAME" >/dev/null
  if [ -f "$APP_DIR/docker-compose.yml" ]; then cp -p "$APP_DIR/docker-compose.yml" "$backup_dir/compose/docker-compose.yml"; fi
  if ! docker run --rm -v "$volume:/data:ro" -v "$backup_dir:/backup" --entrypoint sh "$image" \
    -c 'mkdir -p /backup/data && cp -a /data/. /backup/data/'; then
    echo "[ERROR] 数据卷备份失败，重新启动原版容器"
    docker start "$CONTAINER_NAME" >/dev/null 2>&1 || true
    return 1
  fi
  {
    echo "MODE=docker"
    echo "APP_DIR=$APP_DIR"
    echo "CONTAINER_NAME=$CONTAINER_NAME"
    echo "PROJECT_NAME=$PROJECT_NAME"
    echo "VOLUME=$volume"
    echo "OLD_IMAGE_REF=$old_image_ref"
    echo "OLD_IMAGE_TAG=forwardx-migration-backup:$stamp"
    echo "SOURCE_VERSION=$old_version"
    echo "NEX_IMAGE=$image"
    echo "CREATED_AT=$stamp"
  } > "$backup_dir/manifest"
  backup_forwardx_fwxm "$backup_dir"
  mkdir -p "$(dirname "$FORWARDX_MIGRATION_MARKER")"
  printf "%s\n" "$backup_dir" > "$FORWARDX_MIGRATION_MARKER"
  echo "[NEX] 原版已备份到 $backup_dir"

  # 3. 导数据（读备份里的原版数据库）、换 NEX 容器；失败就回退
  source_args=(--source-config /source/database.json --source-mysql-config /source/mysql.json
    --source-env-file /work/compose/.env --default-sqlite /source/forwardx.db --map-path /data=/source
    --jwt-secret-file /data/jwt.secret)
  if [ -n "$TARGET_DB_CONFIG" ]; then
    cp "$TARGET_DB_CONFIG" "$backup_dir/target-database.json"
    chmod 600 "$backup_dir/target-database.json" 2>/dev/null || true
    target_args=(--target-config /work/target-database.json)
  else
    target_args=(--target-sqlite /data/forwardx.db.nex-import)
  fi
  docker run --rm -v "$volume:/data" --entrypoint sh "$image" -c 'rm -f /data/forwardx.db.nex-import /data/forwardx.db.nex-import-wal /data/forwardx.db.nex-import-shm' || true
  echo "[NEX] 导入数据"
  if ! forwardx_docker_cli "$image" "$volume" "$backup_dir/data" "$backup_dir" import \
    "${source_args[@]}" "${target_args[@]}" --report /work/migration-report.json; then
    status=1
  fi
  if [ "$status" = 0 ]; then
    if [ -n "$TARGET_DB_CONFIG" ]; then
      target_arg='cp /work/target-database.json /data/database.json'
    else
      target_arg='rm -f /data/forwardx.db /data/forwardx.db-wal /data/forwardx.db-shm && mv /data/forwardx.db.nex-import /data/forwardx.db && printf "{\n  \"type\": \"sqlite\",\n  \"sqlite\": {\n    \"path\": \"/data/forwardx.db\"\n  }\n}\n" > /data/database.json'
    fi
    docker run --rm -v "$volume:/data" -v "$backup_dir:/work:ro" --entrypoint sh "$image" -c "$target_arg && chmod 600 /data/database.json" || status=1
  fi
  if [ "$status" = 0 ]; then
    # 镜像第 1 步已经拉好了。不走 start_panel：它重新拉镜像失败时直接 exit，会跳过下面的回退
    write_compose_file
    write_env "$image"
    remove_existing_panel_containers
    (cd "$APP_DIR" && compose_cmd --env-file "$APP_DIR/.env" -p "$PROJECT_NAME" up -d --remove-orphans forwardx) || status=1
  fi
  if [ "$status" = 0 ]; then
    wait_docker_panel_ready || status=1
  fi
  if [ "$status" != 0 ]; then
    echo "[ERROR] 迁移没有完成，自动回退到原版 ForwardX"
    rollback_forwardx_docker "$backup_dir" || true
    return 1
  fi
  install_panel_manager_from_github
  echo "[DONE] 已从原版 ForwardX ${old_version:-} 迁到 NEX（镜像 ${image}，$(elapsed_seconds)s）"
  echo "[INFO] 迁移报告：$backup_dir/migration-report.json"
  echo "[INFO] 原版备份：${backup_dir}（原版镜像标签 forwardx-migration-backup:${stamp}）；确认没问题后可以删掉。要退回原版：bash install-panel-docker.sh rollback-forwardx --backup-dir $backup_dir"
}

rollback_forwardx_docker_action() {
  local backup_dir="$ROLLBACK_BACKUP_DIR"
  require_root
  load_existing_env
  if [ -z "$backup_dir" ] && [ -f "$FORWARDX_MIGRATION_MARKER" ]; then
    backup_dir="$(head -1 "$FORWARDX_MIGRATION_MARKER")"
  fi
  if [ -z "$backup_dir" ] || [ ! -f "$backup_dir/manifest" ]; then
    echo "[ERROR] 找不到原版备份（用 --backup-dir 指定 ${APP_DIR}.forwardx-backup-时间 目录）"
    return 1
  fi
  echo "[WARN] 回退会删掉 NEX 容器，数据卷换回 $backup_dir 里的原版数据；迁移以后在 NEX 里新写的数据不会带回原版。"
  echo "[WARN] 已经换成 NEX Agent 的主机要在原版面板里重新执行一次安装命令，才会换回原版的 Agent。"
  if [ "$ASSUME_YES" != "true" ] && ! confirm_yes "确认回退到原版 ForwardX？[y/N] "; then
    echo "[INFO] 已取消"
    return 0
  fi
  rollback_forwardx_docker "$backup_dir"
  rm -f "$FORWARDX_MIGRATION_MARKER"
}

case "$ACTION" in
  install) install_panel ;;
  upgrade|update) upgrade_panel ;;
  uninstall|remove) uninstall_panel ;;
  reset-admin|reset-password) reset_admin_password ;;
  migrate-forwardx) migrate_forwardx_docker ;;
  rollback-forwardx) rollback_forwardx_docker_action ;;
  *)
    usage
    exit 1
    ;;
esac
