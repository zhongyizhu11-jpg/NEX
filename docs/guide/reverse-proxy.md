# 反向代理（Nginx / Caddy）

生产环境建议让面板只在本机监听，用 Nginx 或 Caddy 反代出去并启用 HTTPS。这一页说清楚三件事：代理怎么配、面板怎么拿到访客的真实 IP、Agent 填什么地址。

## 先知道面板这一侧是什么样

| 项目 | 说明 |
| --- | --- |
| 面板端口 | 本地部署监听 `.env` 里的 `PORT`（默认 `9810`）；Docker 部署把宿主机的 `PORT` 映射到容器里的 `3000` |
| 长连接 | 面板**没有 WebSocket 接口**。Agent 的事件流是 SSE（`/api/agent/events`、`/api/stream`），一条连接挂很久，面板每 25 秒发一次保活 |
| 压缩 | 面板自己会压 JSON 和静态资源，SSE 不压；代理上不用再开 gzip，开了也要排除 `text/event-stream` |
| 请求体 | 默认 1MB；Agent 上报（`/api/agent/*`、`/api/sync`）和备份导入、插件 / 主题上传等登录后的请求最大 10MB，代理的上限要不小于 10MB |
| 路径 | 面板网页只能挂在域名根路径（`https://panel.example.com/`），不支持挂在子路径下 |

Agent 必须能访问的路径：`/api/agent/`、`/api/sync`、`/api/stream`。这几条不要加额外的登录、验证码或 WAF 挑战页，否则 Agent 会离线。

## 真实 IP：`FORWARDX_TRUST_PROXY`

面板记录登录 IP、做登录限流、审计日志、会话设备、面板防火墙用的都是同一个「请求方 IP」。它按 Express 的 trust proxy 规则从 `X-Forwarded-For` 里取 —— **只有直连面板的那一跳是受信代理时**才读这个头，否则就用 TCP 对端地址（谁都能在请求里写一个假的 `X-Forwarded-For`）。

受信代理由环境变量 `FORWARDX_TRUST_PROXY` 决定（`server/trustProxy.ts`）：

| 值 | 含义 |
| --- | --- |
| 不设 / `loopback` | 默认。只信本机回环地址（`127.0.0.1`、`::1`） |
| 网段或地址，逗号分隔 | 例如 `172.16.0.0/12` 或 `10.0.0.5,10.0.0.6`，只信这些地址来的代理 |
| 数字 | 信任最近的 N 跳代理（只在面板端口不会被直接访问时用） |
| `false` / `none` / `off` / `0` | 一律不信任，`X-Forwarded-*` 全部忽略 |

`true`、`all`、`*` 这类「全信」的写法会被当成 `false`：全信等于让任何人伪造来源 IP，登录限流就失效了。

同一个判断还管着另外几个头：

- `X-Forwarded-Proto` / Cloudflare 的 `cf-visitor`：判断访客是不是 HTTPS（登录 Cookie 的 `Secure`、面板生成的链接）；
- `X-Forwarded-Host`、`X-Forwarded-Port`、`X-Forwarded-Prefix`：只在「面板公开地址」没填时，用来猜 Agent 安装命令、支付回跳、订阅链接里的面板地址。

都只认受信代理传来的值。`CF-Connecting-IP`、`X-Real-IP` 面板不拿来当请求方 IP（只有「网络测试」页显示访客 IP 时会参考），套了 CDN 时要在 Nginx 里先把真实 IP 还原好，见下文。

### 什么时候要改

| 部署方式 | 代理在哪 | 要不要改 |
| --- | --- | --- |
| 本地部署（systemd） | 同一台机器，反代到 `127.0.0.1:9810` | 不用，默认 `loopback` 就对 |
| Docker 部署 | 宿主机上的 Nginx / Caddy，反代到 `127.0.0.1:9810` | **要改**：容器看到的对端是 Docker 网关地址，不是回环 |
| 任意 | 代理在另一台机器 | 要改成那台代理的内网地址 |

Docker 部署时查网关地址：

```bash
docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' forwardx-panel
```

然后在部署目录的 `.env` 里加一行（写网关所在的网段或网关地址都行），重启容器：

```bash
echo 'FORWARDX_TRUST_PROXY=172.16.0.0/12' >> /opt/forwardx-docker/.env
cd /opt/forwardx-docker && docker compose up -d
```

安装脚本升级时会保留这一行，并通过 `docker-compose.yml` 传进容器。本地部署同理写在 `/opt/forwardx-panel/.env`，再 `systemctl restart forwardx-panel`。

::: warning 信任了代理，就别让面板端口直接对外
信任了 Docker 网关以后，**直接访问宿主机 9810 端口的人在容器里也是从网关进来的**，他写的 `X-Forwarded-For` 也会被采信。用云厂商的安全组 / 防火墙只放行 80、443，不要放行面板端口。注意 Docker 发布的端口不受 ufw 管，要在安全组或 `DOCKER-USER` 链里拦。
:::

没配对的表现：登录日志、会话列表里所有人都是同一个 IP（`127.0.0.1` 或 `172.x.x.x`）；一个人输错几次密码，所有人都被限流。

## Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /etc/nginx/ssl/panel.example.com.pem;
    ssl_certificate_key /etc/nginx/ssl/panel.example.com.key;

    # 备份导入、插件和主题上传、Agent 上报最大 10MB
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:9810;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Forwarded-Port  $server_port;

        # Agent 的事件流是 SSE：不缓冲、长超时（面板每 25 秒发一次保活）
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}

server {
    listen 80;
    server_name panel.example.com;
    return 301 https://$host$request_uri;
}
```

- 面板给 SSE 响应加了 `X-Accel-Buffering: no`，Nginx 会自动不缓冲这条；上面 `proxy_buffering off` 是双保险。
- 不需要 `Upgrade` / `Connection "upgrade"` 这两行（面板没有 WebSocket），留着也没有坏处。
- `/metrics`（Prometheus 指标）靠 `Authorization` 头鉴权，Nginx 默认会原样转发，别在代理上把它去掉，见[指标导出](./metrics.md)。

### 前面还有 CDN（Cloudflare 等）

这时 Nginx 看到的 `$remote_addr` 是 CDN 节点。先用 realip 模块还原访客地址，再用 `$remote_addr` 覆盖 `X-Forwarded-For`：

```nginx
# Cloudflare 的回源网段，完整列表见 https://www.cloudflare.com/ips/
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
# ……其余网段照抄
real_ip_header CF-Connecting-IP;

location / {
    proxy_pass http://127.0.0.1:9810;
    proxy_set_header X-Forwarded-For $remote_addr;
    # 其余同上
}
```

Cloudflare 的免费套餐对空闲连接有约 100 秒的超时，面板 25 秒一次的保活够用；但 Agent 走 CDN 会多一跳、多一层可能被拦的地方，能直连的机器建议给它单独配一个不过 CDN 的地址（见下文「Agent 面板地址怎么填」）。

## Caddy

```text
panel.example.com {
    reverse_proxy 127.0.0.1:9810
}
```

Caddy 会自动申请证书、自动带上 `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host`，SSE 响应也会立即转发，不需要额外配置。请求体默认不限大小。Caddy 跑在宿主机、面板跑在 Docker 里时，同样要按上面设 `FORWARDX_TRUST_PROXY`。

Caddy 自己也在 Docker 里、和面板在同一个 Compose 网络时，把 `127.0.0.1:9810` 换成 `forwardx-panel:3000`，`FORWARDX_TRUST_PROXY` 写这个网络的网段。

## Agent 面板地址怎么填

1. **面板公开地址**：在「系统设置 → 系统配置 → 面板地址」（初始化向导第三步也会让你填）写访客和 Agent 实际访问的地址，例如 `https://panel.example.com`。Agent 安装命令、升级命令、心跳里下发给 Agent 的地址都用它。

   ::: warning 换了反代以后一定要改这里
   公开地址还是 `http://服务器IP:9810`、或者干脆没填时，面板会按请求头猜一个地址；换域名、关掉直连端口以后，已经装好的 Agent 还连着旧地址，就会离线。
   :::

2. **个别机器连不上公开地址**（国内线路、出站端口受限、要多绕一层代理）：在「编辑主机 → 其他配置 → Agent 连接与保护」给它单独填一个**反代到同一个面板**的地址，可以带端口和路径前缀，例如 `https://cn-relay.example.com:8443/nex`。路径前缀只对 Agent 有效（反代时把前缀去掉再转给面板），网页本身不能挂在子路径下。Agent 2.2.255 起会先用自己的 Token 探测新地址，通了才切换，详见[主机管理 → Agent 面板连接地址](./hosts.md#agent-panel-url)。

3. 只开了 HTTP 的面板：Agent 自升级时要校验安装脚本的签名，HTTP 面板对没签名的脚本一律拒绝执行。正常的 NEX 面板都会签名；建议还是上 HTTPS。

## 检查

```bash
# 面板本身（在面板机器上）
curl -s http://127.0.0.1:9810/api/database-health

# 经过代理
curl -s https://panel.example.com/api/database-health
```

两次都应该返回 `"state":"healthy"`。再用浏览器登录一次，到「个人资料 → 已登录设备」里看记录的 IP 是不是你自己的公网地址；不是的话回到上面检查 `FORWARDX_TRUST_PROXY`。
