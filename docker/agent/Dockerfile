# NEX Agent 的 Docker 版：给有 Docker 的 NAS、iStoreOS、Unraid 用。
# 只带依赖和入口脚本，Agent 第一次启动时从面板装（见 entrypoint.sh）。要用宿主机网络运行：
#   docker run -d --name nex-agent --network host --cap-add NET_ADMIN --cap-add NET_RAW \
#     --restart unless-stopped -v nex-agent:/etc/forwardx \
#     -e PANEL_URL=http://面板地址:9810 -e AGENT_TOKEN=面板里复制的Token ghcr.io/zhongyizhu11-jpg/nex-agent
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    FORWARDX_AGENT_CONTAINER=1 \
    FORWARDX_INSTALL_MIMIC=n

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl jq socat iptables nftables iproute2 procps psmisc coreutils openssl \
      conntrack iperf3 tini \
 && rm -rf /var/lib/apt/lists/*

COPY docker/agent/entrypoint.sh /usr/local/sbin/nex-agent-entrypoint

VOLUME ["/etc/forwardx"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/sbin/nex-agent-entrypoint"]
