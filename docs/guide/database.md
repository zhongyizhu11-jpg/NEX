# 数据库

NEX 支持 SQLite、MySQL、PostgreSQL 三种数据库，功能完全一样，表结构由面板启动时自动建好、自动补列，不需要手动跑迁移。这一页讲怎么选、怎么配、怎么换、怎么备份。

## 怎么选

| 数据库 | 适合 | 要求 |
| --- | --- | --- |
| SQLite（默认） | 单台面板、几十到一两百台主机；不想多维护一个服务 | 不用准备，数据是一个文件 |
| MySQL | 已经有 MySQL，或者主机、规则、用户都很多，想把数据库放到单独的机器上 | **MySQL 8.0.13 或以上**（面板连上后会检查版本，太旧直接拒绝）；MariaDB 的版本号能过检查，但没有专门测过 |
| PostgreSQL | 已经有 PostgreSQL | 建议 12 或以上（面板不检查版本） |

拿不准就用 SQLite：面板对 SQLite 开了 WAL 模式，日常读写和备份都够用；以后需要时可以在面板里在线换成 MySQL / PostgreSQL，数据和 ID 都会带过去（见[切换数据库](#switch)）。

不管用哪种，连接池大小都按主机数自动调整，不需要配置。

## 怎么配置

### 初始化向导（推荐）

第一次打开面板时在[首次初始化](./first-setup.md)的第一步选数据库。选 MySQL / PostgreSQL 要填地址、端口、库名、用户名、密码和是否 SSL，先「测试连接」通过才能继续。本地部署的一键安装脚本在终端里也会问一次。

填好的连接信息保存在数据目录的 `database.json` 里（权限 600）：

| 部署方式 | 位置 |
| --- | --- |
| Docker | 数据卷里的 `/data/database.json` |
| 本地部署 | `/opt/forwardx-panel/data/database.json` |

```json
{
  "type": "mysql",
  "mysql": {
    "host": "10.0.0.5",
    "port": 3306,
    "user": "forwardx",
    "password": "……",
    "database": "forwardx",
    "ssl": false
  }
}
```

SQLite 是 `{"type": "sqlite", "sqlite": {"path": "/data/forwardx.db"}}`。

::: tip MySQL / PostgreSQL 要先建好库
面板只建表，不建库。先在数据库里建一个空库和一个对它有完整权限（建表、建索引、增删改查）的账号，字符集用 `utf8mb4`：

```sql
-- MySQL
CREATE DATABASE forwardx CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'forwardx'@'%' IDENTIFIED BY '强密码';
GRANT ALL PRIVILEGES ON forwardx.* TO 'forwardx'@'%';
```

```sql
-- PostgreSQL
CREATE USER forwardx WITH PASSWORD '强密码';
CREATE DATABASE forwardx OWNER forwardx;
```
:::

::: warning Docker 里别写 127.0.0.1
面板在容器里时，`127.0.0.1` 指的是容器自己。数据库在宿主机上就写宿主机的内网 IP 或 `host.docker.internal`（一键脚本生成的 compose 已经把它指到宿主机）；数据库也在 Docker 里就写它的服务名，并让两个容器在同一个网络。
:::

### 用环境变量指定

面板按这个顺序找数据库（`server/dbRuntime.ts`），先找到哪个用哪个：

1. `DATABASE_TYPE`（或 `DB_TYPE`）显式指定了类型，并且对应的连接变量齐全；
2. `POSTGRES_URL` / `POSTGRES_HOST` 等 PostgreSQL 变量；
3. `MYSQL_URL` / `MYSQL_HOST` 等 MySQL 变量；
4. `DATABASE_CONFIG_PATH` 指向的 `database.json`；
5. 老版本的 `MYSQL_CONFIG_PATH`（`mysql.json`）；
6. `SQLITE_PATH` 指向的文件已经存在时用 SQLite。

变量清单见[环境变量 → 数据库变量](./env-vars.md#数据库变量)。注意：

- 用环境变量配了数据库以后，面板里的「数据库在线切换」切完、重启时还是会回到环境变量指定的那个库。想用面板切换，就别用环境变量配。
- 一键脚本生成的 `docker-compose.yml` 只把 `POSTGRES_*` 传进容器，**不传 `MYSQL_*`**。Docker 部署用 MySQL 请走初始化向导（写进数据卷里的 `database.json`），或者自己在 compose 的 `environment` 里加。

## 切换数据库 {#switch}

在「系统设置 → 备份恢复 → 数据库在线切换」里，可以在 SQLite、MySQL、PostgreSQL 之间互相切换：

1. 先准备一个**空的**目标库（见上面的建库语句）。目标库里已经有业务数据时面板会拒绝，不会合并或覆盖。
2. 选目标类型、填连接信息，点「验证」：面板会测试连接，并实际建一张临时表试一遍写入权限。
3. 确认后开始切换。切换期间面板暂停写入，按表把当前数据（ID 不变）拷到目标库；目标是 PostgreSQL 时再同步序列、更新查询统计。
4. 完成后面板改用新库：同类型之间切换直接换连接；换了类型（比如 SQLite → MySQL）面板进程会退出重启一次，好按新类型加载 —— Docker 和 systemd 会自动拉起，OpenRC / SysV 部署没自动起来的话手动 `start` 一次。

原来的库不会被删除，SQLite 的旧文件也还在数据目录里，确认新库没问题后再自己清理。

从另一台 NEX 面板整体搬过来用「在线迁移面板」（[升级和备份 → 在线迁移面板](./upgrade-backup.md#在线迁移面板)）；从原版 ForwardX 搬过来见[从原版 ForwardX 迁移](./migrate-from-forwardx.md)。

## 备份

面板自己的「导出备份」和「异地自动备份」导出的是加密的业务数据（不含流量曲线、监控历史等流水），适合换机器恢复，见[升级和备份](./upgrade-backup.md)。想要一份完整的数据库，按类型备份：

### SQLite

SQLite 开着 WAL，最近的写入可能还在 `forwardx.db-wal` 里，**只拷 `forwardx.db` 一个文件可能拿到的是旧数据**。二选一：

```bash
# 1）停面板再拷（最简单）
systemctl stop forwardx-panel
cp -a /opt/forwardx-panel/data/forwardx.db /root/forwardx.db.bak
systemctl start forwardx-panel

# 2）不停面板，用 sqlite3 的在线备份（需要装 sqlite3）
sqlite3 /opt/forwardx-panel/data/forwardx.db ".backup '/root/forwardx.db.bak'"
```

Docker 部署的数据在数据卷里，整卷打包（先停容器）：

```bash
cd /opt/forwardx-docker && docker compose stop
docker run --rm -v forwardx_forwardx-data:/data -v /root:/backup alpine \
  tar czf /backup/forwardx-data.tgz -C /data .
docker compose start
```

数据卷里还有 `database.json`、`jwt.secret`（登录签名和密钥类设置的加密密钥，见下文）等文件，整卷备份最省事。

### MySQL / PostgreSQL

```bash
mysqldump --single-transaction -h 127.0.0.1 -u forwardx -p forwardx > forwardx.sql
pg_dump -h 127.0.0.1 -U forwardx forwardx > forwardx.sql
```

### 别忘了 JWT 密钥

系统设置里的密钥类内容（SMTP 密码、支付密钥、云账号凭据等）在库里是加密存的，密钥来自 `JWT_SECRET`，没设时是数据目录下自动生成的 `jwt.secret`。**只恢复数据库、不恢复这把密钥，这些设置会解不开**（设置页会提示「需要重新填写」）。备份数据库时把 `.env` 里的 `JWT_SECRET` 或 `jwt.secret` 一起留好。面板自己的「导出备份」导出的是解密后的值（备份文件另有备份口令加密），换机器恢复不受影响。

## 常见问题

- **启动日志里有 `Database type changed to …; server restart is required`**：`database.json` 改了类型但进程没重启。重启面板即可（在线切换会自动重启）。
- **MySQL 报版本太旧**：面板要求 8.0.13 以上，旧版本请升级或改用 PostgreSQL / SQLite。
- **数据库连不上时面板显示故障页**：面板会每隔一段时间重新探测，数据库恢复后自动回来；`/api/database-health` 可以看当前状态。
