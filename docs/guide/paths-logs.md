# 目录、数据与日志

排查问题、备份和迁移时要知道东西放在哪。下面是一键脚本安装时的默认位置；自定义过目录或容器名的，以自己的为准。

## 面板

| 内容 | Docker 部署 | 本地部署（systemd / OpenRC / SysV） |
| --- | --- | --- |
| 部署目录（`.env`、`docker-compose.yml` 或程序文件） | `/opt/forwardx-docker` | `/opt/forwardx-panel` |
| 数据目录 | Docker 数据卷 `forwardx_forwardx-data`，容器里是 `/data` | `/opt/forwardx-panel/data` |
| 数据库连接配置 | `/data/database.json` | `data/database.json` |
| SQLite 数据库 | `/data/forwardx.db` | `data/forwardx.db` |
| 面板运行日志（网页「面板日志」读的就是它） | `/data/logs/panel.jsonl` | `data/logs/panel.jsonl` |
| 进程标准输出 | `docker logs forwardx-panel` | `journalctl -u forwardx-panel`；OpenRC / SysV 是 `data/panel.log` |
| 服务 / 容器名 | 容器 `forwardx-panel` | 服务 `forwardx-panel` |
| SSH 管理命令 | `fwxm`（同机装了 Agent 时用 `fwxm panel`） | 同左 |

Docker 部署的数据**不在部署目录里**，在数据卷里：只备份 `/opt/forwardx-docker` 是不够的，备份方法见[升级和备份](./upgrade-backup.md)。

面板运行日志保留**今天和前两天**（按北京时间零点切），更早的自动清掉；需要留底的话在「系统设置 › 面板日志」导出。

已安装的界面主题包、插件、证书等都在数据库里，跟着数据库备份走。

## Agent

| 内容 | 位置 |
| --- | --- |
| 配置文件（面板地址、Token、代理） | `/etc/forwardx/agent/config.json` |
| 主日志 | `/var/log/forwardx-agent/agent-go.log` |
| 转发运行时配置 | `/etc/forwardx/runtime/`、`/etc/forwardx/nginx/` |
| 网络调优写的内核参数 | `/etc/sysctl.d/99-forwardx-network.conf` |
| 网络调优前的原值备份 | `/etc/forwardx-nettune/backup.json` |
| 服务名 | `forwardx-agent` |
| SSH 管理命令 | `fwxm`（`fwxm logs` 看日志，`fwxm info` 看关键信息） |

Agent 日志保留最近 72 小时，单个文件和整个目录都有大小上限，超出时从最旧的内容开始裁掉。

## 看日志的几种办法

```bash
# 面板
fwxm logs                       # 只装了面板时；同机有 Agent 用 fwxm panel logs
docker logs --tail 200 -f forwardx-panel
journalctl -u forwardx-panel -n 200 -f

# Agent
fwxm logs
tail -n 200 -F /var/log/forwardx-agent/agent-go.log
```

网页上也能看：「系统设置 › 面板日志」看面板的，「主机详情 › 实时日志」看某台主机 Agent 的（需要 Agent 2.2.230 起）。
