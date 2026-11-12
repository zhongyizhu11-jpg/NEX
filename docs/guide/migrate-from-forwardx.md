# 从原版 ForwardX 迁移

已经在用原版 ForwardX（[poouo/Forwardx](https://github.com/poouo/Forwardx)）的面板，可以用安装脚本的 `migrate-forwardx` 动作原地换成 NEX：数据导进一个全新的 NEX 数据库，原版的程序、配置和数据库整个留作备份，中途任何一步失败都会自动换回原版。已经接入的 Agent 会在之后的心跳里自动换成 NEX 的 Agent。

::: tip 适用范围
用原版一键脚本装的面板（本地部署在 `/opt/forwardx-panel`、Docker 部署在 `/opt/forwardx-docker`，服务 / 容器名 `forwardx-panel`）。改过目录或名字的，用下文的环境变量指过去。已经是 NEX 的面板直接 `upgrade`，脚本认得出来，会拒绝再迁一次。
:::

## 一条命令迁移

在**跑着原版面板的机器**上用 root 执行，按部署方式二选一：

```bash
# Docker 部署
curl -fsSL https://raw.githubusercontent.com/zhongyizhu11-jpg/NEX/main/scripts/install-panel-docker.sh | bash -s -- migrate-forwardx

# 本地部署（systemd / OpenRC / SysV）
curl -fsSL https://raw.githubusercontent.com/zhongyizhu11-jpg/NEX/main/scripts/install-panel-local.sh | bash -s -- migrate-forwardx
```

脚本先做不改动原版的准备，列出检测到的面板版本和数据量，**等你输入 `y` 确认**以后才动手：

| 步骤 | 本地部署 | Docker 部署 |
| --- | --- | --- |
| 1. 准备（不碰原版） | 把 NEX 下载到 `/opt/forwardx-panel.nex-staging` 并装好依赖 | 拉 NEX 镜像 |
| 2. 只读检查原版的库 | 用 NEX 的迁移命令读一遍，确认是原版 ForwardX 的库、统计用户 / 主机 / 规则数 | 同左（在 NEX 镜像里跑） |
| 3. 备份 | 停服务，把 `/opt/forwardx-panel` **整个挪成** `/opt/forwardx-panel.forwardx-backup-时间/app`，服务文件也拷一份 | 停容器；`.env`、`docker-compose.yml` 和**整个数据卷**拷到 `/opt/forwardx-docker.forwardx-backup-时间/`，原版镜像另打一个 `forwardx-migration-backup:时间` 标签 |
| 4. 导数据 | NEX 挪到原位，带上原版的 `.env`（端口、JWT 密钥）和 `data/` 里除数据库以外的文件，从备份里的原版数据库导进新库 | 从备份里的原版数据库导进数据卷里的新库 |
| 5. 启动并检查 | 写 NEX 的服务文件、启动，等 `/api/database-health` 报健康 | 换成 NEX 的 compose / `.env` 起容器，等数据库健康 |

第 3 步以后任何一步失败（导入报错、面板 90 秒内没起来），脚本都会**自动回退**：NEX 挪开（本地部署留在 `….nex-failed-时间`，方便查原因），原版目录 / 数据卷 / 配置放回原样，原版服务重新启动。

成功后终端会打印迁移报告（迁了多少、哪些没迁、丢了哪些原版独有的列），完整 JSON 在备份目录的 `migration-report.json`。

### 选项

| 选项 / 环境变量 | 说明 |
| --- | --- |
| `--yes` | 不问确认直接迁（自动化用）。默认没有终端时当作「不确认」，什么都不改 |
| `--target-db-config 文件` | 不导进新的 SQLite，而是导进这个文件描述的**空** MySQL / PostgreSQL 库，格式和 NEX 的 `database.json` 一样（见[数据库](./database.md)）。库里已有数据会拒绝 |
| `FORWARDX_PANEL_DIR` / `FORWARDX_SERVICE_NAME` | 本地部署的目录和服务名 |
| `FORWARDX_DOCKER_DIR` / `FORWARDX_CONTAINER_NAME` | Docker 部署的目录和容器名 |
| `--github-accelerator URL` | 和安装、升级一样，GitHub 下载走加速地址 |

例：原版用的是 MySQL，想迁完继续用 MySQL（先建一个空库 `nex`）：

```bash
cat > /root/nex-database.json <<'EOF'
{ "type": "mysql", "mysql": { "host": "10.0.0.5", "port": 3306, "user": "nex", "password": "强密码", "database": "nex", "ssl": false } }
EOF
curl -fsSL https://raw.githubusercontent.com/zhongyizhu11-jpg/NEX/main/scripts/install-panel-local.sh | bash -s -- migrate-forwardx --target-db-config /root/nex-database.json
```

Docker 部署时这个地址要从容器里能连上（别写 `127.0.0.1`）。不写 `--target-db-config` 时，不管原版用什么库，数据都导进新的 SQLite；以后需要可以在 NEX 面板里[在线切换](./database.md#switch)到 MySQL / PostgreSQL。

## 数据库怎么处理

- **原版的库只读，一个字节都不改。** SQLite 从备份里的那份文件读；MySQL / PostgreSQL 用只读会话读。迁坏了换回原版，原来的数据都在。
- 原版和 NEX 的表结构差得很多（对照原版 2.3.299：原版有 26 张 NEX 没有的表，NEX 有 60 多张原版没有的表，同名表里也各有对方没有的列），所以不在原库上升级，而是按 NEX 的表结构挑出能对上的数据，用 NEX 面板迁移现成的导入流程导进一个全新的库：主机、隧道、规则等的 ID 保留，关联照映射，运行状态清零，Agent 重连后按 NEX 的方式重新下发。
- 用户的 ID 可能重新编号（规则、订单、工单等里面的用户引用会一起改对）；登录状态不保留，所有人要重新登录一次，密码不变。
- JWT 密钥沿用原版的（`.env` 里的 `JWT_SECRET`，或者数据目录里的 `jwt.secret`），系统设置里的密钥类内容（SMTP、支付等）导入时用它重新加密。

## 能迁什么、不能迁什么

| 数据 | 结果 |
| --- | --- |
| 用户（含密码、两步验证、Telegram / Discord 绑定、余额、额度） | 迁移。原版的 Google 登录绑定（`googleSubject`）换算到 NEX 的 `googleSub` |
| 主机（含 Agent Token、计费、流量设置） | 迁移。ID 和 Token 不变，Agent 不用重新安装就能连上 NEX |
| 隧道、转发规则、转发组、入口 / 出口组、主机分组、权限 | 迁移 |
| 套餐、订阅、订单、余额流水、兑换码、折扣码、流量计费、公告 | 迁移 |
| 流量统计、延迟和监控历史、自测记录 | 迁移（数据多时这一步最慢） |
| 系统设置（站点名、面板公开地址、通知、支付等） | 迁移。运行时缓存、数据库配置、原版自己的面板迁移状态不带 |
| 工单 `support_tickets` / `support_ticket_messages` | **换算**成 NEX 工单：状态 `open`、`in_progress` → 待处理，`waiting_user` → 等用户，`resolved`、`closed` → 已关闭；优先级 `normal` → 中，`urgent` → 高。只迁公开回复 |
| 推广关系 `affiliate_referrals` | **换算**成 NEX 的邀请人（被推广的用户记上邀请人） |
| HTTP 探测、负载指标 | **换算**：原版的 `targetUrl` / `timeoutSeconds` / `expectedStatus`、`load1/5/15` 对到 NEX 对应的列 |
| 工单附件、内部备注、已读状态、快捷回复 | 不迁（NEX 工单没有这些） |
| 推广账户余额、推广码、佣金和提现记录 | 不迁。**还有未提现余额的，迁移前先结清**，或迁完手动给用户加余额（报告里会提示有几个账户） |
| 插件（及插件资源、Agent 上的插件状态、插件商店地址） | 不迁。原版的插件包和 NEX 的不通用，迁完在 NEX 插件商店重新安装 |
| 原版独有的功能数据：AI 工作流、MCP 令牌、运营统计、告警状态、在线率区间、换 IP 记录、Agent 实例绑定 | 不迁（NEX 没有对应功能，或会重新累计） |
| 原版隧道的 FXP v3 传输参数（`v3Transport` 等） | 丢弃。这些隧道按 NEX 的默认传输重新下发，**迁完请检查**（报告里会列出条数） |
| 原版独有的列（套餐的计费方向、主机的多地址 / 首选地址、单机告警阈值等） | 丢弃，报告里逐列列出原库里有值的行数 |

## Agent 怎么换成 NEX 的

迁移命令在新库里打开了「原版 Agent 自动换成 NEX」的开关（设置项 `forwardxAgentMigration`）。之后：

1. 原版 Agent 照常用原来的 Token 连到面板（地址没变，面板换成了 NEX）。
2. 面板从心跳认出它是原版的 Agent，给它排一次升级。**不看版本号**：原版和 NEX 的 Agent 版本号是同一条线往上数的，原版的号可能比 NEX 的还大。
3. Agent 从**面板**取安装脚本（`/api/agent/install.sh`），脚本里的下载地址是 NEX 的 GitHub Release，主机连不上 GitHub 时自动走面板转发（「优先连接面板安装 Agent」打开时先走面板），装上的就是 NEX 的 Agent。原来的配置、Token、转发规则都保留。
4. 新 Agent 心跳报上 `agentDistribution: nex` 后，这次升级才算完成。

怎么看换没换：

- 主机详情里 Agent 版本后面标着「原版 ForwardX」的还没换；
- 面板日志里搜 `[AgentMigration]`（排队）和 `distribution=forwardx -> nex`（换好了）；
- 在 Agent 机器上执行 `forwardx-agent -distribution`：NEX 的 Agent 打印 `nex`，原版的 Agent 不认这个参数、直接报错。

没换成功（机器离线、下载失败）时，面板 10 分钟后清掉这次升级请求，同一台机器至少隔 30 分钟再自动排一次。一直换不过来的，在 NEX 面板的主机页手动点升级（原版 Agent 不会被当成「已是最新」挡掉），或在那台机器上重新执行一次 NEX 的 Agent 安装命令。

::: warning 换 Agent 之前
原版 Agent 在换成 NEX 之前也连着 NEX 面板。两边的 Agent 协议同源，基本的转发能照常下发，但原版独有的功能（FXP v3 传输等）NEX 不会下发。迁完后尽快确认所有 Agent 都换好了。
:::

## 迁移后检查

1. 用原来的管理员账号登录 NEX（密码不变）。
2. 看主机列表：在线的主机数和原版差不多，Agent 陆续换成 NEX 的。
3. 抽查几条规则和隧道能通；用了 FXP v3 传输的隧道重点看。
4. 看一眼迁移报告里的「没有迁移」「丢弃的列」和「注意」几段。
5. 原版的 SSH 管理命令 `fwxm`（它会从原版仓库重装面板）已经挪进备份，换成了 NEX 的 `fwxm`。

都没问题后，备份目录（`/opt/forwardx-panel.forwardx-backup-时间` 或 `/opt/forwardx-docker.forwardx-backup-时间`）和 Docker 的 `forwardx-migration-backup:时间` 镜像标签可以删掉。

## 退回原版

迁完发现问题，想换回原版：

```bash
# Docker 部署
curl -fsSL https://raw.githubusercontent.com/zhongyizhu11-jpg/NEX/main/scripts/install-panel-docker.sh | bash -s -- rollback-forwardx

# 本地部署
curl -fsSL https://raw.githubusercontent.com/zhongyizhu11-jpg/NEX/main/scripts/install-panel-local.sh | bash -s -- rollback-forwardx
```

默认用最近一次迁移的备份（记在 `/etc/nex/forwardx-migration.last`），也可以用 `--backup-dir 备份目录` 指定。回退会：

- 本地部署：停 NEX、把 NEX 目录挪到 `….nex-failed-时间`、把原版目录和服务文件放回、启动原版；
- Docker 部署：删 NEX 容器、数据卷按备份还原、原版的 `.env` 和 compose 放回、用备份时打的镜像标签启动原版。

注意：

- 迁移以后在 NEX 里新写的数据（新规则、新订单等）**不会**带回原版；
- 已经换成 NEX Agent 的机器，在原版面板里重新执行一次原版的安装命令，才会换回原版的 Agent。

## 手动运行迁移命令

安装脚本里导数据用的是 NEX 自带的 `dist/migrate-forwardx.js`，也可以单独用（比如先在别的机器上试迁一份）：

```bash
cd /opt/forwardx-panel   # 或任何装了 NEX 的目录
# 只读检查
node dist/migrate-forwardx.js inspect --source-sqlite /path/to/原版/forwardx.db
# 导进一个新的 SQLite 文件（文件必须还不存在）
JWT_SECRET='和将来面板用的同一把' node dist/migrate-forwardx.js import \
  --source-sqlite /path/to/原版/forwardx.db --target-sqlite /tmp/nex-test.db --report /tmp/report.json
```

来源也可以用 `--source-config 原版的database.json`（MySQL / PostgreSQL）、`--source-env-file 原版的.env`；`node dist/migrate-forwardx.js help` 看全部参数。
