#!/usr/bin/env bash
# NEX 自编 gost 运行时：官方 go-gost/gost 源码 + go-gost/x 打上 nex-splice.patch。
#
# 官方 gost 的普通 TCP 转发在两条连接外面各包了几层（metrics、统计），io.Copy 认不出
# 底下是 *net.TCPConn，只能在用户态一块块拷。补丁在没开 metrics、没限速、没收 PROXY
# 头、没开嗅探时把空转的包装层剥掉，直接在两条原始 TCP 连接之间中继，Go 会走
# splice(2)，数据在内核里搬。限速、统计这些情况照旧走原来的路。
#
# 用法：gost-runtime/build.sh <输出目录>
# 产出：<输出目录>/forwardx-runtime-linux-amd64、forwardx-runtime-linux-arm64
#
# 版本号写成 ${GOST_VERSION}-${NEX_GOST_BUILD}（例如 3.2.6-nex1），装机脚本据此
# 区分 NEX 自编版和官方版。改了补丁就把 NEX_GOST_BUILD 加一。
set -euo pipefail

GOST_VERSION="${GOST_VERSION:-3.2.6}"
GOST_VERSION="${GOST_VERSION#v}"
GOST_X_VERSION="${GOST_X_VERSION:-0.8.1}"
GOST_X_VERSION="${GOST_X_VERSION#v}"
NEX_GOST_BUILD="${NEX_GOST_BUILD:-nex1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:?usage: build.sh <out-dir>}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 先 git clone 指定 tag；不行再下 GitHub 的源码包。
fetch_source() {
  local name="$1" repo="$2" tag="$3"
  echo "[gost-runtime] fetching ${repo} ${tag}"
  if git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "https://github.com/${repo}.git" "$WORK/$name" 2>/dev/null; then
    return 0
  fi
  rm -rf "$WORK/$name"
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 300 \
    -o "$WORK/$name.tgz" "https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz"
  mkdir -p "$WORK/$name"
  tar -xzf "$WORK/$name.tgz" -C "$WORK/$name" --strip-components=1
}

fetch_source gost go-gost/gost "v${GOST_VERSION}"
fetch_source x go-gost/x "v${GOST_X_VERSION}"

if ! grep -q "github.com/go-gost/x v${GOST_X_VERSION}\$" "$WORK/gost/go.mod"; then
  echo "[gost-runtime] gost v${GOST_VERSION} does not pin go-gost/x v${GOST_X_VERSION}; update GOST_X_VERSION" >&2
  exit 1
fi

echo "[gost-runtime] applying nex-splice.patch to go-gost/x v${GOST_X_VERSION}"
(cd "$WORK/x" && patch -p1 --forward --batch < "$SCRIPT_DIR/nex-splice.patch")

VERSION_FILE="$WORK/gost/cmd/gost/version.go"
if ! grep -q "version = \"${GOST_VERSION}\"" "$VERSION_FILE"; then
  echo "[gost-runtime] unexpected version line in $VERSION_FILE" >&2
  exit 1
fi
sed -i "s/version = \"${GOST_VERSION}\"/version = \"${GOST_VERSION}-${NEX_GOST_BUILD}\"/" "$VERSION_FILE"

(
  cd "$WORK/gost"
  go mod edit -replace=github.com/go-gost/x="$WORK/x"
  for goarch in amd64 arm64; do
    out="$OUT_DIR/forwardx-runtime-linux-${goarch}"
    echo "[gost-runtime] building gost ${GOST_VERSION}-${NEX_GOST_BUILD} linux/${goarch} -> ${out}"
    CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" \
      go build -trimpath -buildvcs=false -ldflags "-s -w" -o "$out" ./cmd/gost
  done
)
