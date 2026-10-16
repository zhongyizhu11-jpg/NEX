#!/usr/bin/env bash
# NEX 自编 gost 运行时：官方 go-gost/gost 源码 + go-gost/x 打上 nex-splice.patch、nex-ssu.patch，
# go-gost/go-shadowsocks2 打上 nex-shadowsocks2.patch。
#
# 官方 gost 在两条连接外面各包了几层（metrics、统计），io.Copy 认不出底下是
# *net.TCPConn，只能在用户态一块块拷。补丁在没开 metrics、没限速、没收 PROXY 头、
# 没开嗅探时把空转的包装层剥掉，直接在两条原始 TCP 连接之间中继，Go 会走 splice(2)，
# 数据在内核里搬。限速、统计这些情况照旧走原来的路。
#
# 覆盖面（nex2）：
#   - 普通端口转发（forward/local），包括发 PROXY 头的：头先同步写进目标连接，再中继；
#   - 「TCP」模式隧道入口（forward/local + chain，relay 连接器 nodelay 握手完后链路就是裸 TCP）；
#   - 「TCP」模式隧道出口和 TCP 监听的中间跳（relay handler 的 CONNECT：握手读写完、目标是 TCP）。
#   TLS / WSS / MTLS / MWSS 模式必须在用户态加解密，隧道两端都改不了；UDP、嗅探、限速、
#   PROXY 头接收、开 metrics 时照旧用户态拷贝。日志里 "splice":true 表示这条连接走了内核中继。
#   回归：gost-runtime/test/splice-check.sh <二进制>。
#
# nex3：Shadowsocks 出口（规则经 ss / ssu 连接器去落地）和 sing-box 真正互通：
#   - nex-ssu.patch（go-gost/x）：经典 AEAD 的 UDP 回包一个都收不到（会话存取用了两个不同的键），
#     回包里的 SOCKS 地址没剥；修好后 UDP 双向通。
#   - nex-shadowsocks2.patch（go-gost/go-shadowsocks2）：SS2022 的 UDP 会话子密钥字节序错、TCP 回程头
#     解析错，只能 gost 对 gost；修好后和 sing-box 的 TCP / UDP 都通。经典 AEAD 的防重放 Bloom 过滤器
#     哈希取得不对，误判率远高于设定（UDP 每个包都进过滤器，长跑会持续丢回包），一并修好。
#   每个补丁开头写了根因。回归：gost-runtime/test/ss-egress-e2e/run.sh <二进制>。
#
# 用法：gost-runtime/build.sh <输出目录>
# 产出：<输出目录>/forwardx-runtime-linux-amd64、forwardx-runtime-linux-arm64
#
# 版本号写成 ${GOST_VERSION}-${NEX_GOST_BUILD}（例如 3.2.6-nex3），装机脚本据此
# 区分 NEX 自编版和官方版，Agent 据此判断运行时能力（nex3 起才有 Shadowsocks UDP / SS2022 出口）。
# 改了补丁就把 NEX_GOST_BUILD 加一。
# GOARCHES 可以只编一部分架构（例如 GOARCHES=amd64），默认 amd64 arm64。
set -euo pipefail

GOST_VERSION="${GOST_VERSION:-3.2.6}"
GOST_VERSION="${GOST_VERSION#v}"
GOST_X_VERSION="${GOST_X_VERSION:-0.8.1}"
GOST_X_VERSION="${GOST_X_VERSION#v}"
GOST_SS2_VERSION="${GOST_SS2_VERSION:-0.1.1}"
GOST_SS2_VERSION="${GOST_SS2_VERSION#v}"
NEX_GOST_BUILD="${NEX_GOST_BUILD:-nex3}"
GOARCHES="${GOARCHES:-amd64 arm64}"
# gost 3.2.6 的 go.mod 要求 Go >= 1.24，而 Agent 和发布流程用的是 1.23（GOTOOLCHAIN=local）。
# 只给 gost 这一步指定工具链，go 命令会从 proxy.golang.org 自动下载。和官方发布包同一版本。
GOST_GO_TOOLCHAIN="${GOST_GO_TOOLCHAIN:-go1.25.4}"

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
fetch_source ss2 go-gost/go-shadowsocks2 "v${GOST_SS2_VERSION}"

if ! grep -q "github.com/go-gost/x v${GOST_X_VERSION}\$" "$WORK/gost/go.mod"; then
  echo "[gost-runtime] gost v${GOST_VERSION} does not pin go-gost/x v${GOST_X_VERSION}; update GOST_X_VERSION" >&2
  exit 1
fi

echo "[gost-runtime] applying nex-splice.patch to go-gost/x v${GOST_X_VERSION}"
(cd "$WORK/x" && patch -p1 --forward --batch < "$SCRIPT_DIR/nex-splice.patch")
echo "[gost-runtime] applying nex-ssu.patch to go-gost/x v${GOST_X_VERSION}"
(cd "$WORK/x" && patch -p1 --forward --batch < "$SCRIPT_DIR/nex-ssu.patch")

if ! grep -q "github.com/go-gost/go-shadowsocks2 v${GOST_SS2_VERSION}\$" "$WORK/x/go.mod"; then
  echo "[gost-runtime] go-gost/x v${GOST_X_VERSION} does not pin go-shadowsocks2 v${GOST_SS2_VERSION}; update GOST_SS2_VERSION" >&2
  exit 1
fi
echo "[gost-runtime] applying nex-shadowsocks2.patch to go-gost/go-shadowsocks2 v${GOST_SS2_VERSION}"
(cd "$WORK/ss2" && patch -p1 --forward --batch < "$SCRIPT_DIR/nex-shadowsocks2.patch")

VERSION_FILE="$WORK/gost/cmd/gost/version.go"
if ! grep -q "version = \"${GOST_VERSION}\"" "$VERSION_FILE"; then
  echo "[gost-runtime] unexpected version line in $VERSION_FILE" >&2
  exit 1
fi
sed -i "s/version = \"${GOST_VERSION}\"/version = \"${GOST_VERSION}-${NEX_GOST_BUILD}\"/" "$VERSION_FILE"

(
  cd "$WORK/gost"
  export GOTOOLCHAIN="$GOST_GO_TOOLCHAIN"
  go mod edit -replace=github.com/go-gost/x="$WORK/x"
  go mod edit -replace=github.com/go-gost/go-shadowsocks2="$WORK/ss2"
  for goarch in $GOARCHES; do
    out="$OUT_DIR/forwardx-runtime-linux-${goarch}"
    echo "[gost-runtime] building gost ${GOST_VERSION}-${NEX_GOST_BUILD} linux/${goarch} -> ${out}"
    CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" \
      go build -trimpath -buildvcs=false -ldflags "-s -w" -o "$out" ./cmd/gost
  done
)
