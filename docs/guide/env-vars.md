# 环境变量

NEX 大多数设置都可以在后台页面中配置。环境变量主要用于容器启动、数据库连接、登录密钥、Telegram Token 和升级命令这类“启动前就要确定”的配置。

Docker 部署时，环境变量通常写在部署目录的 `.env` 文件中。本地 systemd 部署时，可以写入 systemd 服务的环境配置，或由安装脚本生成的服务配置管理。

::: warning 修改后要重启
环境变量只会在面板进程启动时读取。修改 `.env` 或 systemd 环境配置后，需要重启面板容器或 `forwardx-panel.service`。
:::

## 基础变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `9810` | 面板对外访问端口。本地部署时是面板监听端口；Docker Compose 中通常是宿主机端口，容器内仍监听 `3000`。 |
| `NODE_ENV` | `production` | 运行模式，正式部署保持 `production`。 |
| `JWT_SECRET` | 自动生成或示例值 | 登录签名密钥。生产环境建议使用 32 位以上随机字符串，并长期保持不变。 |
| `FORWARDX_JWT_SECRET_PATH` | 空 | 未配置 `JWT_SECRET` 时，面板保存自动生成登录密钥的路径。 |
| `DATABASE_CONFIG_PATH` / `DB_CONFIG_PATH` | `/data/database.json` | 面板保存数据库连接配置的位置。 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 数据文件路径。 |
| `FORWARDX_PANEL_TIME_SYNC` | `true` | 启动并定期校准旧版 Agent/FXP 加密协议使用的面板时钟；不会修改宿主机或 Docker 的系统时间。 |
| `FORWARDX_PANEL_TIME_SOURCES` | 内置多个 HTTPS 来源 | 可选，使用逗号分隔的可信 HTTPS 地址覆盖默认校时来源。 |
| `FORWARDX_PANEL_TIME_ALLOW_SINGLE_SOURCE` | `false` | 是否允许仅一个 HTTPS 来源可用时校准；单源无法交叉验证，仅建议在可信内网时间服务场景开启。 |

::: tip JWT_SECRET 为什么重要
`JWT_SECRET` 变化后，已登录用户会需要重新登录。建议 Docker 首次部署时就在 `.env` 中固定一个随机值，后续升级不要更换。
:::

::: tip 管理员密码不由环境变量设置
管理员邮箱和密码在首次初始化向导中创建。`ADMIN_PASSWORD` 不是有效配置，也不会在容器重启或重装时重置管理员密码；需要保留数据时使用原管理员凭据，需要全新初始化时必须确认旧 Docker 数据卷已删除。
:::

::: tip Docker 与时间校准
Docker 容器与宿主机共享系统时钟，不能独立运行一套时间。NEX 会使用多个 HTTPS 来源校准旧版 Agent/FXP 加密协议的时间基准；新版 Agent 与 NEX FXP 面板上报使用一次性挑战认证，不再依赖双方系统时间。宿主机仍建议开启 NTP。外网受限时，可通过 `FORWARDX_PANEL_TIME_SOURCES` 指向部署方可信且会返回标准 `Date` 响应头的 HTTPS 服务。

官方 Docker 部署默认只有一个面板进程。自行横向扩容面板时（见下面的 `FORWARDX_SHARED_STATE`），仍要为 `/api/agent/*`、`/api/sync` 和 `/api/stream` 配置粘性路由，确保 Agent 的一次性挑战由同一面板进程签发和消费。
:::

## 多个面板实例

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FORWARDX_SHARED_STATE` | `auto` | 登录失败锁定、登录 / 2FA / 找回密码的限频、验证码挑战和接口限流的计数放哪：`auto` = 库是 MySQL / PostgreSQL 并且检测到别的面板实例（`panel_leases` 里的实例登记）时放库里共享，否则放本进程内存；`db` = 一直放库里（单实例上提前验证、或者前面的负载均衡让实例互相看不见时）；`memory` = 一直放内存（明知多实例也各算各的，比如负载均衡已经按来源 IP 粘性）。SQLite 只支持单实例，这一项对它没有意义。改了要重启 |

放库里之后判断仍然是同步的、看本进程的缓存：每次计数同步记进缓存、异步写库，库回来的总数（全体实例的）覆盖缓存，判断时顺手异步刷新一次。所以同一个键每个实例最多比阈值「多放一次」（另一个实例刚计满的那一刻本实例还没收到），锁定阈值 8 次、限流每分钟上千次，多一次无妨。接口限流每放行一次请求多一条库的 upsert（已经超额的客户端不再碰库）；登录相关的计数本来就低频。库写不进去时按本进程的计数继续，不影响登录和接口。多实例的部署说明见[部署面板](./deploy-panel.md#docker-部署)。


## 数据库变量

首次进入面板可以在初始化向导中选择数据库。你也可以用环境变量提前指定数据库连接。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_TYPE` / `DB_TYPE` | 空 | 可选，强制指定 `sqlite`、`mysql` 或 `postgresql`。设置后后台切换数据库不会在重启后生效，除非移除该变量。 |
| `MYSQL_URL` | 空 | MySQL 连接串。配置后优先于分项配置。 |
| `MYSQL_HOST` | 空 | MySQL 地址。Docker 内不要把宿主机数据库写成 `127.0.0.1`。 |
| `MYSQL_PORT` | `3306` | MySQL 端口。 |
| `MYSQL_USER` | 空 | MySQL 用户名。 |
| `MYSQL_PASSWORD` | 空 | MySQL 密码。 |
| `MYSQL_DATABASE` | 空 | MySQL 数据库名。 |
| `MYSQL_SSL` | `false` | MySQL 是否启用 SSL。 |
| `MYSQL_CONFIG_PATH` | `/data/mysql.json` | 兼容旧版本的 MySQL 配置文件路径。 |
| `POSTGRES_URL` / `POSTGRESQL_URL` / `PG_URL` | 空 | PostgreSQL 连接串。配置后优先于分项配置。 |
| `POSTGRES_HOST` / `POSTGRESQL_HOST` / `PGHOST` | 空 | PostgreSQL 地址。 |
| `POSTGRES_PORT` / `POSTGRESQL_PORT` / `PGPORT` | `5432` | PostgreSQL 端口。 |
| `POSTGRES_USER` / `POSTGRESQL_USER` / `PGUSER` | 空 | PostgreSQL 用户名。 |
| `POSTGRES_PASSWORD` / `POSTGRESQL_PASSWORD` / `PGPASSWORD` | 空 | PostgreSQL 密码。 |
| `POSTGRES_DATABASE` / `POSTGRESQL_DATABASE` / `PGDATABASE` | 空 | PostgreSQL 数据库名。 |
| `POSTGRES_SSL` / `POSTGRESQL_SSL` / `PGSSL` | `false` | PostgreSQL 是否启用 SSL。 |

Docker 场景下数据库地址可以按下面判断：

| 场景 | 推荐填写 |
| --- | --- |
| 数据库和面板在同一个 Compose 项目 | 数据库服务名，例如 `postgres`、`mysql` |
| 数据库在宿主机 | `host.docker.internal` 或宿主机内网 IP |
| 数据库在另一台服务器 | 面板容器能访问到的内网 IP、公网 IP 或域名 |

## 反向代理

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FORWARDX_TRUST_PROXY` | `loopback` | 信任哪些反向代理传来的 `X-Forwarded-For` / `X-Forwarded-Proto` 等头：`loopback`（只信本机）、网段或地址（逗号分隔，如 `172.16.0.0/12`）、跳数（数字），或 `false` 一律不信。`true` / `*` 这类「全信」的写法按 `false` 处理。Docker 部署前面有宿主机上的 Nginx / Caddy 时要改，见[反向代理](./reverse-proxy.md)。安装脚本升级时会保留这一项 |
| `FORWARDX_RUN_AS_ROOT` | 空 | Docker 镜像默认以 `forwardx`（uid 10001）运行；设为 `1` 让容器保持 root（挂了 `/var/run/docker.sock` 时自动保持 root，见[部署面板](./deploy-panel.md)） |
| `FORWARDX_AGENT_ASSET_CACHE_DIR` | 数据目录下的 `agent-assets` | 面板替主机缓存 Agent 二进制（含按需下载的 gost 运行时、mita）的目录；默认跟数据库同一个数据目录，Docker 里是 `/data/agent-assets`。见[部署面板](./deploy-panel.md#agent-二进制默认按需下载离线用完整包) |
| `FORWARDX_SQLITE_WAL_AUTOCHECKPOINT` | `10000` | SQLite 的 WAL 累积多少页做一次检查点（页 4 KB）。默认 10000 页（WAL 最多约 40 MB）比 SQLite 自带的 1000 页少约四分之一的磁盘写入；机器磁盘特别小可以调低 |
| `FORWARDX_TRAFFIC_BATCH_MS` | `500` | Agent 流量上报攒批提交的窗口（毫秒）：窗口内到达的上报合成一个事务写库，100 台主机时磁盘写入约少 30%，代价是上报回包慢至多一个窗口（Agent 端异步上报，不影响转发）。`0` 关掉，每份单独提交；上限 5000。 |
| `FORWARDX_PROXY_SUB_CACHE_MAX_BYTES` | `134217728`（128 MB） | 订阅渲染结果缓存的内存上限（含压缩副本），超出按先进先出淘汰；小于 1 MB 的值忽略。 |
| `FORWARDX_TRUSTED_ORIGINS` | 空 | 跨站写操作防护（CSRF）额外放行的浏览器来源，逗号分隔，可写完整来源（`https://ops.example.com`）或裸主机名。面板自己的域名（按请求 Host / 反代传来的 `X-Forwarded-Host` 比主机名）和手机 App 的固定源默认就放行；只有把面板 API 嵌进别的站点时才需要填。用 API 令牌（Bearer）认证的请求不受此限制 |

## 数据库连接池

MySQL 和 PostgreSQL 连接池由面板自动管理，不需要配置连接数。面板会按主机数量在 `16/24/32` 的最大连接档位间自动调整。连接按实际并发按需创建，并保留已经建立的池内连接供下一轮心跳复用，避免并发突发后反复建连产生大量 `TIME-WAIT`；MySQL 使用有限等待队列，PostgreSQL 的连接与排队等待最多为 6 秒。

## Telegram 和通知

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 空 | Telegram Bot Token。也可以在后台“系统设置 -> Telegram”中填写。 |
| `TELEGRAM_BOT_POLLING` | `true` | 是否启用 Telegram 长轮询。一般保持默认，不需要配置 webhook。 |

如果通过环境变量配置 `TELEGRAM_BOT_TOKEN`，后台会显示 Token 来源为环境变量，普通页面中不能直接删除该 Token。需要停用时请移除环境变量并重启面板。

## AI 助手配置

AI 助手目前建议在后台页面配置：

```text
系统设置 -> Telegram -> AI 助手模型
```

可配置内容包括：

- 供应商：DeepSeek、SiliconFlow 或自定义 OpenAI 兼容接口。
- API Key。
- Base URL。
- 模型名称。
- 最大输出 Tokens。
- 温度。
- 普通用户是否可用 AI 管理。
- AI 相关机器人消息是否自动撤回。

::: tip
AI API Key 不建议写入 Docker `.env`。后台保存后会做脱敏展示，也方便管理员切换供应商和模型。
:::

## 升级和镜像

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FORWARDX_IMAGE` | `ghcr.io/zhongyizhu11-jpg/forwardx:latest` | Docker 部署使用的镜像。 |
| `FORWARDX_IMAGE_REPO` | `ghcr.io/zhongyizhu11-jpg/forwardx` | Docker 一键脚本解析版本镜像时使用的镜像仓库。 |
| `FORWARDX_GITHUB_ACCELERATOR_URL` | 空 | 面板安装或升级使用的 GitHub 加速站，例如 `https://mirror.example.com`。一键脚本通过 `--github-accelerator` 接收后会写入部署 `.env`。 |
| `FORWARDX_TARGET_VERSION` | 空 | 本地部署可指定安装或升级到某个版本，例如 `v2.3.222`。Docker 脚本也会用它校验目标镜像是否已经构建完成。 |
| `FORWARDX_UPGRADE_COMMAND` | 空 | 后台一键升级命令。为空时只能检查更新，不能在后台直接执行升级。 |
| `FORWARDX_REPO_URL` | 自动注入 | 升级任务执行时使用的仓库地址，通常不需要手动配置。 |
| `FORWARDX_CURRENT_VERSION` | 自动注入 | 升级任务执行时的当前版本，通常不需要手动配置。 |

`FORWARDX_GITHUB_ACCELERATOR_URL` 使用 `加速站地址/原始 GitHub URL` 的代理格式，供安装和升级脚本读取。面板内的更新功能需另行在「系统设置 -> 系统信息 -> GitHub 下载加速」填写地址并开启「面板更新使用加速站」；开启后，版本检查、Release 信息、安装包检测、回退和升级命令会优先使用该地址，失败时自动回退直连 GitHub。

该变量不加速 `ghcr.io` 镜像拉取。Docker 镜像地址仍由 `FORWARDX_IMAGE` 或 `FORWARDX_IMAGE_REPO` 控制。

## Agent 安装脚本相关变量

这些变量主要在执行 Agent 安装或升级脚本时使用：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FORWARDX_AGENT_RELEASE_VERSION` | 面板版本对应的 Agent 版本 | 指定 Agent 安装脚本下载的 Agent Release 版本。 |
| `FORWARDX_AGENT_PANEL_FIRST` | 面板设置决定 | 优先从面板内置资产下载 Agent 运行时，失败再回退到 GitHub。 |
| `FORWARDX_CURL_CONNECT_TIMEOUT` | `15` | 下载连接超时时间。 |
| `FORWARDX_CURL_LOW_SPEED_LIMIT` | `1024` | 下载低速判断阈值。 |
| `FORWARDX_CURL_ASSET_LOW_SPEED_TIME` | `180` | 下载资产允许低速持续的时间。 |

普通用户通常不需要配置这些变量。只有在 GitHub 访问不稳定、内网镜像分发或排查 Agent 升级问题时才会用到。

## 调试日志变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FORWARDX_VERBOSE_AGENT_EVENTS` | 空 | 开启更详细的 Agent 事件日志。 |
| `FORWARDX_VERBOSE_AGENT_ACTIONS` | 空 | 开启更详细的 Agent 动作下发日志。 |
| `FORWARDX_VERBOSE_AGENT_REPORTS` | 空 | 开启更详细的 Agent 上报日志。 |
| `FORWARDX_LOG_DIR` | 默认日志目录 | 指定面板日志文件目录。 |

这些变量会增加日志量。排查完成后建议关闭，避免长期刷大量无效日志。
