# ---------- 1. Build stage: install dependencies and build frontend/backend ----------
FROM node:22-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@10.28.1

RUN apk add --no-cache bash python3 make g++ curl ca-certificates

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --prod=false

COPY . .
RUN pnpm build

# ---------- 1b. Agent/runtime assets ----------
FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS agent-assets
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git patch \
  && rm -rf /var/lib/apt/lists/*
COPY . .
# 镜像只带 Agent 和 FXP；gost 运行时和 mita（约 90 MB）由面板第一次需要时按 SHA256SUMS 从发布页下到
# /data/agent-assets 缓存（server/agentAssets.ts），启动后也会先在后台预取。
RUN NEX_SKIP_RUNTIME=1 NEX_SKIP_MITA=1 bash scripts/build-agent-release.sh

# ---------- 2. Production dependencies ----------
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN npm install -g pnpm@10.28.1
RUN apk add --no-cache python3 make g++ git
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --prod

# ---------- 3. Runtime image ----------
FROM node:22-alpine AS runner
WORKDIR /app
ARG FORWARDX_VERSION=unknown
ENV NODE_ENV=production \
    PORT=3000 \
    FORWARDX_PORT_MANAGEMENT=docker \
    DATABASE_CONFIG_PATH=/data/database.json \
    SQLITE_PATH=/data/forwardx.db \
    MYSQL_CONFIG_PATH=/data/mysql.json \
    FORWARDX_IMAGE_VERSION=$FORWARDX_VERSION
LABEL org.opencontainers.image.version=$FORWARDX_VERSION \
      org.forwardx.version=$FORWARDX_VERSION

# 面板以非 root 用户 forwardx（uid/gid 10001，固定，方便宿主机 chown / 给 docker.sock 配属组）运行；
# 入口脚本以 root 起来修正老数据卷的属主后用 su-exec 降权，见 docker/panel/entrypoint.sh。
RUN apk add --no-cache tini su-exec git curl openssl docker-cli docker-cli-compose \
  && addgroup -S -g 10001 forwardx && adduser -S -D -H -u 10001 -G forwardx -h /app -s /sbin/nologin forwardx \
  && mkdir -p /data && chown forwardx:forwardx /data
VOLUME ["/data"]
# 日志、证书、jwt.secret 都放数据卷里（面板默认就按 /data 找，这里只是写明）。
ENV FORWARDX_LOG_DIR=/data/logs

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=agent-assets /app/dist/agent ./dist/agent
COPY --from=builder /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
# 许可证和致谢随镜像一起发（AGPL 要求随分发附带）。
COPY --from=builder /app/LICENSE /app/NOTICE ./
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts/install-mimic.sh ./scripts/install-mimic.sh
COPY --from=builder /app/package.json ./
COPY docker/panel/entrypoint.sh /usr/local/bin/panel-entrypoint.sh

EXPOSE 3000
# 存活探测：进程还在并且能回 HTTP 就算活。/api/database-health 不建登录上下文、不查库，
# 数据库故障时也返回 200（故障信息在 JSON 里），所以库挂了不会把容器标成 unhealthy 触发误重启。
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/database-health" >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/panel-entrypoint.sh"]
CMD ["node", "dist/index.js"]
