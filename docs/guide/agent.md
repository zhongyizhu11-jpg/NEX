# 安装 Agent

Agent 是安装在被管理服务器上的程序，负责执行转发规则、上报主机状态、统计流量和执行链路测试。

当前版本：Agent 2.2.181

---

## 创建 Agent Token

进入：

```
主机管理 → Token 管理
```

点击"添加主机"创建新的 Agent Token。Token 用于允许服务器注册到当前面板。

**建议一个 Token 只绑定一台被控主机。** Token 泄露后，请在 Token 管理中删除或禁用旧 Token，再重新创建。

![在 Token 管理中创建 Token 并获取 Agent 安装命令](./images/agent-token-management.png)

---

## 安装 Agent

在 Token 管理中点击对应 Token 的"安装命令"，复制面板生成的命令，在被控 Linux 主机上以 root 权限执行。

```bash
curl -fsSL http://你的面板地址:9810/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

如果面板使用 HTTPS 域名：

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

> **关于地址选择：** 如果系统设置里配置了面板公开域名，安装命令弹窗会默认使用公开域名。需要让 Agent 通过 IP + 端口直连时，可以先用 IP + 端口打开面板，再在弹窗里选择"当前访问地址"后复制命令。

安装完成后，进入**主机管理**，主机状态显示为绿色在线，说明 Agent 已正常连接面板。

### 支持的系统 {#系统}

| 系统 | 服务管理 | 说明 |
|------|----------|------|
| Debian、Ubuntu、CentOS、Rocky、Fedora、openSUSE、Arch | systemd | 最常见的 VPS 系统 |
| Alpine | OpenRC | |
| OpenWrt、iStoreOS、ImmortalWrt（2.3.461 起） | procd | 软路由、家里当叠加入口的机器 |
| 任何装了 Docker 的系统（2.3.461 起） | 容器 | NAS、Unraid 等，见下面 [Docker](#docker) |

CPU 架构只支持 **amd64（x86_64）** 和 **arm64（aarch64）**。路由器上执行 `uname -m` 看一下：`x86_64` 或 `aarch64` 能装；`mips`、`armv7l` 这类老硬路由装不了。

### OpenWrt / iStoreOS {#openwrt}

复制安装命令弹窗里「OpenWrt / iStoreOS」那一行，SSH 登录路由器后执行。它和普通安装命令一样，只是最前面先用 opkg 装上 bash、curl（OpenWrt 默认没有），所以路由器要能连上 OpenWrt 的软件源。卸载、升级用普通的那两条命令就行（这时 bash、curl 已经有了）。

安装脚本在 OpenWrt 上会：

- 用 opkg 一个个装依赖（jq、socat、ss、ip-full、iptables-nft，以及 busybox 没带的 nohup、timeout、base64 等），哪个源里没有不影响别的；
- Agent 和它管理的转发服务都写成 procd 服务：开机自启（`/etc/rc.d/S99forwardx-agent`），进程崩了 procd 自动拉起；
- SSH 管理命令 `fwxm` 链到 `/usr/bin`，登录上去直接能用。

要注意：

- OpenWrt 的 `/var` 在内存里，日志（`/var/log/forwardx-agent/`）重启后清空，配置在 `/etc/forwardx/agent/`，不受影响。
- 查看状态：`/etc/init.d/forwardx-agent status`；重启：`/etc/init.d/forwardx-agent restart`。
- 卸载用面板给的卸载命令，开机链接一起删掉。

### Docker（NAS、iStoreOS、Unraid）{#docker}

装了 Docker 的设备（群晖、威联通、飞牛、Unraid、带 Docker 的 iStoreOS / OpenWrt）可以用 Docker 版。安装命令弹窗里「Docker」那一行就是现成的命令：

```bash
docker run -d --name nex-agent --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  --restart unless-stopped -v nex-agent:/etc/forwardx \
  -e PANEL_URL='http://你的面板地址:9810' -e AGENT_TOKEN='面板里的 Token' \
  ghcr.io/zhongyizhu11-jpg/nex-agent:latest
```

- 必须用宿主机网络（`--network host`）：转发要监听的是这台机器的端口。
- 镜像只带依赖，Agent 第一次启动时从面板装，版本和面板一致；面板里升级 Agent 照常可用（容器里换好二进制自动重启 Agent）。
- 配置在卷 `nex-agent` 里：删掉容器重新 `docker run`（换镜像、改参数）不用再给 Token，会按原配置重新装好。
- 看日志：`docker logs -f nex-agent`；卸载：`docker rm -f nex-agent && docker volume rm nex-agent`，再到面板里删主机。
- NAS 的图形界面里建容器时，对应填：网络选 host，环境变量填 `PANEL_URL` 和 `AGENT_TOKEN`，挂一个卷到 `/etc/forwardx`，权限里加 `NET_ADMIN`、`NET_RAW`。

### mimic UDP 混淆（可选）

安装脚本执行过程中会询问是否安装 mimic UDP 混淆环境：

```
是否安装 mimic UDP 混淆环境？[Y/n]
```

- 默认安装（2.3.440 起；`curl | bash` 这种没有终端的方式也按默认安装），装不上只提示、不影响 Agent 安装和正常转发。
- 输入 `n`，或设置 `FORWARDX_INSTALL_MIMIC=no`，跳过。
- 之后随时可以在面板 **主机管理 › 主机详情 › mimic UDP 混淆** 里一键安装 / 修复（Agent 2.2.223 起），隧道编辑里开 mimic 时也会列出参与主机并提供同样的按钮。
- 目标版本为 **mimic v0.7.1**；已安装旧版时会提示升级，已满足目标版本时直接复用。
- 对于不提供预编译二进制包的系统，脚本会询问是否从源码编译（面板一键安装时按「是」）。

**mimic 说明：**

| 项目 | 内容 |
|------|------|
| 来源 | [hack3ric/mimic](https://github.com/hack3ric/mimic) |
| 版本 | v0.7.1 |
| 许可证 | GPL-2.0-only |
| 内核要求 | Linux 6.1+（XDP ingress + TC egress；XDP `native`/`skb` 自动回退） |

---

## 升级 Agent

可在面板**主机管理**中点击"升级"按钮，也可复制升级命令到服务器执行：

```bash
curl -fsSL http://你的面板地址:9810/api/agent/install.sh | bash -s -- upgrade YOUR_AGENT_TOKEN
```

> 如果面板地址变化导致 Agent 离线，重新执行带正确面板地址的安装或升级命令即可恢复连接。

---

## 卸载 Agent

卸载命令可在 Token 管理的安装命令弹窗中获取，通用卸载命令如下：

```bash
curl -fsSL https://raw.githubusercontent.com/zhongyizhu11-jpg/NEX/main/scripts/install-agent.sh | bash -s -- uninstall
```

---

## 安装后文件位置

| 用途 | 路径 |
|------|------|
| Agent 通讯配置 | `/etc/forwardx/agent/config.json` |
| Agent 日志 | `/var/log/forwardx-agent/agent-go.log` |
| Agent 本地状态 | `/var/lib/forwardx-agent/` |
| NEX FXP 运行时（Go 实现） | `/usr/local/bin/forwardx-fxp` |
| GOST / 隧道运行时配置 | `/etc/forwardx/runtime/` |

**历史路径说明：** 旧版本留下的 `/etc/forwardx-agent`、`/etc/forwardx-runtime`、`/etc/forwardx-tunnel-runtime`、`/etc/forwardx-gost`、`/etc/forwardx-tunnels` 属于历史路径，升级时会优先迁移到 `/etc/forwardx` 下，后续不再新增这些分散目录。

---

## 常用运维命令

### 查看运行状态

```bash
systemctl status forwardx-agent
```

### 查看日志

```bash
tail -n 300 /var/log/forwardx-agent/agent-go.log
```

### 重启 Agent

```bash
systemctl restart forwardx-agent
```

### 查看配置

```bash
cat /etc/forwardx/agent/config.json
```

### 检查磁盘占用

Agent 会限制单个日志文件及 `/var/log/forwardx-agent` 的总占用。如发现磁盘异常增长，可用以下命令定位实际占用来源：

```bash
du -ak /var/log/forwardx-agent /var/lib/forwardx-agent 2>/dev/null | sort -n | tail -n 30
journalctl --disk-usage 2>/dev/null || true
du -sh /var/lib/systemd/coredump /var/crash 2>/dev/null || true
```

> **注意：** 环境变量 `FORWARDX_FXP_VERBOSE_LOG=1` 会记录每个 TCP/UDP 会话明细，仅应在短时间排障时启用，常规运行不建议开启。

---

## 常见问题

**Agent 安装后显示离线？**

- 检查面板地址是否正确，是否仍然是旧 IP。
- 如果面板已改为 HTTPS 域名，确认 Agent 配置也使用了 HTTPS 域名。
- 执行 `systemctl status forwardx-agent` 并查看日志，确认具体连接错误。
- 重新执行带正确面板地址的安装或升级命令，Agent 会自动更新配置并重连。
