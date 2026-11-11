#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist/agent"
GO_CACHE_ROOT="${GOCACHE:-}"
GO_HOME_ROOT="${HOME:-}"
XDG_CACHE_ROOT="${XDG_CACHE_HOME:-}"
REQUESTED_TAG="${1:-}"
MIN_GO_MAJOR=1
MIN_GO_MINOR=24
GOST_VERSION="${GOST_VERSION:-3.2.6}"
GOST_VERSION="${GOST_VERSION#v}"
AGENT_VERSION="$(sed -nE "s/.*AGENT_VERSION[[:space:]]*=[[:space:]]*['\"]([^'\"]+)['\"].*/\1/p" "$ROOT_DIR/shared/versions.ts" | head -n 1)"
if [ -z "$AGENT_VERSION" ]; then
  echo "[agent] AGENT_VERSION not found in shared/versions.ts" >&2
  exit 1
fi
VERSION="${AGENT_VERSION#v}"
if [ -n "$REQUESTED_TAG" ] && [ "${REQUESTED_TAG#v}" != "$VERSION" ]; then
  echo "[agent] release tag ${REQUESTED_TAG} detected; building Agent version ${VERSION} from shared/versions.ts"
fi

go_version_number() {
  go version 2>/dev/null | awk '{print $3}' | sed -E 's/^go//; s/[^0-9.].*$//'
}

go_version_supported() {
  local version="$1"
  local major minor patch
  IFS=. read -r major minor patch <<EOF
$version
EOF
  major="${major:-0}"
  minor="${minor:-0}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  [[ "$minor" =~ ^[0-9]+$ ]] || minor=0
  if [ "$major" -gt "$MIN_GO_MAJOR" ]; then
    return 0
  fi
  [ "$major" -eq "$MIN_GO_MAJOR" ] && [ "$minor" -ge "$MIN_GO_MINOR" ]
}

if ! command -v go >/dev/null 2>&1; then
  echo "[agent] Go ${MIN_GO_MAJOR}.${MIN_GO_MINOR}+ is required to build Agent/FXP, but go was not found" >&2
  exit 1
fi
GO_VERSION="$(go_version_number)"
if ! go_version_supported "$GO_VERSION"; then
  echo "[agent] Go ${MIN_GO_MAJOR}.${MIN_GO_MINOR}+ is required to build Agent/FXP; current version is ${GO_VERSION:-unknown}" >&2
  echo "[agent] Run scripts/install-panel-local.sh again or install a newer Go under /usr/local/go" >&2
  exit 1
fi
echo "[agent] using Go $GO_VERSION ($(command -v go))"

mkdir -p "$OUT_DIR"
if [ -z "$GO_CACHE_ROOT" ]; then GO_CACHE_ROOT="$ROOT_DIR/.cache/go-build"; fi
if [ -z "$GO_HOME_ROOT" ]; then GO_HOME_ROOT="$ROOT_DIR/.cache/home"; fi
if [ -z "$XDG_CACHE_ROOT" ]; then XDG_CACHE_ROOT="$ROOT_DIR/.cache"; fi
mkdir -p "$GO_CACHE_ROOT" "$GO_HOME_ROOT" "$XDG_CACHE_ROOT"
export GOCACHE="$GO_CACHE_ROOT"
export HOME="$GO_HOME_ROOT"
export XDG_CACHE_HOME="$XDG_CACHE_ROOT"

build_one() {
  local goarch="$1"
  local out="$2"
  echo "[agent] building linux/$goarch -> $out"
  (
    cd "$ROOT_DIR/agent"
    CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" \
      go build -trimpath -buildvcs=false -ldflags "-s -w -X main.Version=$VERSION" -o "$OUT_DIR/$out" .
  )
}

build_one amd64 forwardx-agent-linux-amd64
build_one arm64 forwardx-agent-linux-arm64

build_fxp() {
  local goarch="$1"
  local out="$2"
  echo "[fxp] building linux/$goarch -> $out"
  (
    cd "$ROOT_DIR/forwardx-fxp"
    CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" \
      go build -trimpath -buildvcs=false -ldflags "-s -w" -o "$OUT_DIR/$out" .
  )
}

build_fxp amd64 forwardx-fxp-linux-amd64
build_fxp arm64 forwardx-fxp-linux-arm64

download_gost_runtime() {
  local gost_arch="$1"
  local out="$2"
  local tmp url gost_bin
  echo "[runtime] downloading go-gost v${GOST_VERSION} linux/${gost_arch} -> ${out}"
  tmp="$(mktemp -d)"
  url="https://github.com/go-gost/gost/releases/download/v${GOST_VERSION}/gost_${GOST_VERSION}_linux_${gost_arch}.tar.gz"
  rm -f "$OUT_DIR/$out"
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 -o "$tmp/gost.tgz" "$url"
  tar -xzf "$tmp/gost.tgz" -C "$tmp"
  gost_bin="$(find "$tmp" -type f -name gost | head -n1)"
  if [ -z "$gost_bin" ]; then
    echo "[runtime] gost binary not found in ${url}" >&2
    rm -rf "$tmp"
    exit 1
  fi
  install -m 0755 "$gost_bin" "$OUT_DIR/$out"
  rm -rf "$tmp"
}

# gost runtime 优先用 NEX 自编版（gost-runtime/build.sh：普通 TCP 转发走 splice），
# 编不出来（Go 太老、拉不到源码）就退回官方成品，装机脚本两种都认。
# NEX_GOST_SOURCE=upstream 可以强制用官方成品。
if [ "${NEX_GOST_SOURCE:-nex}" != "upstream" ] && "$ROOT_DIR/gost-runtime/build.sh" "$OUT_DIR"; then
  echo "[runtime] using NEX-built gost runtime"
else
  echo "[runtime] NEX gost build unavailable, falling back to official go-gost v${GOST_VERSION}" >&2
  # 在 GitHub Actions 的运行摘要里留个黄色提示，免得退回官方版没人发现。
  if [ -n "${GITHUB_ACTIONS:-}" ] && [ "${NEX_GOST_SOURCE:-nex}" != "upstream" ]; then
    echo "::warning title=gost runtime::NEX gost build failed; this release bundles official go-gost v${GOST_VERSION} (no splice)"
  fi
  download_gost_runtime amd64 forwardx-runtime-linux-amd64
  download_gost_runtime arm64 forwardx-runtime-linux-arm64
fi

# mita（Mieru 的服务端，GPLv3，作为独立程序随发布包分发，不链接）：从上游发布页下官方静态构建，
# 发布包和包里二进制的 SHA-256 都按 shared/mitaAssets.ts 钉死的值校验，对不上就整个构建失败 ——
# 面板会把它转发给落地机以 root 跑，宁可这一版发不出去，也不能带上一个没核对过的程序。
MITA_ASSETS_FILE="$ROOT_DIR/shared/mitaAssets.ts"
MITA_VERSION="$(sed -nE 's/^export const MITA_VERSION = "([0-9]+\.[0-9]+\.[0-9]+)";.*/\1/p' "$MITA_ASSETS_FILE" | head -n 1)"
MITA_REPO="$(sed -nE 's/^export const MITA_RELEASE_REPO = "([^"]+)";.*/\1/p' "$MITA_ASSETS_FILE" | head -n 1)"
if [ -z "$MITA_VERSION" ] || [ -z "$MITA_REPO" ]; then
  echo "[mita] MITA_VERSION / MITA_RELEASE_REPO not found in shared/mitaAssets.ts" >&2
  exit 1
fi

mita_pinned_sha256() {
  # 取 "<版本>/<名字>": "<64 位十六进制>" 那一行的哈希。键里带 /，所以 sed 用 | 作分隔符。
  local key="$1"
  sed -nE "s|^[[:space:]]*\"${key//./\\.}\":[[:space:]]*\"([0-9a-f]{64})\".*|\1|p" "$MITA_ASSETS_FILE" | head -n 1
}

download_mita_runtime() {
  local arch="$1"
  local out="forwardx-mita-linux-${arch}"
  local tarball="mita_${MITA_VERSION}_linux_${arch}.tar.gz"
  local url="https://github.com/${MITA_REPO}/releases/download/v${MITA_VERSION}/${tarball}"
  local want_tarball want_binary got tmp mita_bin
  want_tarball="$(mita_pinned_sha256 "${MITA_VERSION}/${tarball}")"
  want_binary="$(mita_pinned_sha256 "${MITA_VERSION}/${out}")"
  if [ -z "$want_tarball" ] || [ -z "$want_binary" ]; then
    echo "[mita] no pinned SHA-256 for ${tarball} / ${out} in shared/mitaAssets.ts" >&2
    exit 1
  fi
  echo "[mita] downloading mita v${MITA_VERSION} linux/${arch} -> ${out}"
  tmp="$(mktemp -d)"
  rm -f "$OUT_DIR/$out"
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 180 -o "$tmp/$tarball" "$url"
  got="$(sha256sum "$tmp/$tarball" | awk '{print $1}')"
  if [ "$got" != "$want_tarball" ]; then
    echo "[mita] ${tarball} SHA-256 mismatch: got ${got}, pinned ${want_tarball}" >&2
    rm -rf "$tmp"
    exit 1
  fi
  tar -xzf "$tmp/$tarball" -C "$tmp"
  mita_bin="$(find "$tmp" -type f -name mita | head -n1)"
  if [ -z "$mita_bin" ]; then
    echo "[mita] mita binary not found in ${tarball}" >&2
    rm -rf "$tmp"
    exit 1
  fi
  got="$(sha256sum "$mita_bin" | awk '{print $1}')"
  if [ "$got" != "$want_binary" ]; then
    echo "[mita] extracted mita SHA-256 mismatch: got ${got}, pinned ${want_binary}" >&2
    rm -rf "$tmp"
    exit 1
  fi
  install -m 0755 "$mita_bin" "$OUT_DIR/$out"
  rm -rf "$tmp"
}

# NEX_SKIP_MITA=1 只给离线开发用（不打 Mieru 的二进制）；正式发布不要设，面板会退回去从上游下。
if [ "${NEX_SKIP_MITA:-0}" != "1" ]; then
  download_mita_runtime amd64
  download_mita_runtime arm64
fi

NOTICE_FILE="$ROOT_DIR/THIRD_PARTY_NOTICES.md"
if [ ! -f "$NOTICE_FILE" ]; then
  echo "[agent] missing third-party notices: $NOTICE_FILE" >&2
  exit 1
fi
cp "$NOTICE_FILE" "$OUT_DIR/THIRD_PARTY_NOTICES.md"

artifacts=("$OUT_DIR"/forwardx-agent-linux-*)
if compgen -G "$OUT_DIR/forwardx-fxp-linux-*" >/dev/null; then
  artifacts+=("$OUT_DIR"/forwardx-fxp-linux-*)
fi
if compgen -G "$OUT_DIR/forwardx-runtime-linux-*" >/dev/null; then
  artifacts+=("$OUT_DIR"/forwardx-runtime-linux-*)
fi
if compgen -G "$OUT_DIR/forwardx-mita-linux-*" >/dev/null; then
  artifacts+=("$OUT_DIR"/forwardx-mita-linux-*)
fi
# 只写文件名：SHA256SUMS 是给装机脚本和面板按资产名查的，带上 CI 机器上的绝对路径就对不上了。
(cd "$OUT_DIR" && sha256sum "${artifacts[@]##*/}") > "$OUT_DIR"/SHA256SUMS

echo "[agent] release artifacts:"
ls -lh "$OUT_DIR"
