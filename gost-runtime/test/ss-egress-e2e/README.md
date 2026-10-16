# Shadowsocks 出口端到端测试

规则走 Shadowsocks 出口时，入口机上的 gost 运行时（`forwardx-runtime`，gost-runtime/build.sh 编的）用
`ss` / `ssu` 连接器把流量交给落地上的 sing-box（面板的落地入站）。这里用真二进制把整条路跑一遍：

```text
tool 客户端 ──▶ gost 运行时（入口，面板生成的 gost.json）
                 └─ ss / ssu ──▶ sing-box 1.14.0（落地，面板生成的配置）──▶ tool serve（目标）
```

配置不是手写的：`gen-configs.mjs` 在临时 SQLite 库里用面板真实的接口建主机、落地 SS 入站
（`proxyInboundsRouter.create`）、带出口的规则（`rulesRouter.create`，保存时的校验全走一遍），
再给入口机、落地机各发一次真实心跳，从下发的 desiredState 里取出入口机的 `gost.json` 和落地机的
sing-box 配置。只改了两处：面板不允许出口服务器是 127.x，库里落地用文档地址 198.51.100.10，写文件时换成
127.0.0.1；面板的落地入站不提供 `chacha20-ietf-poly1305`，这个方法在 sing-box 配置里补一个同格式的入站、
规则走「外部 ss:// 链接」那条路。另外给 gost.json 加了一个 `profiling` 监听，只用来数 goroutine。

## 跑

```bash
# 先编运行时（只编 amd64 快一些）
GOARCHES=amd64 gost-runtime/build.sh /tmp/rt
# 跑全部（默认长稳 10 分钟）
gost-runtime/test/ss-egress-e2e/run.sh /tmp/rt/forwardx-runtime-linux-amd64
```

需要 Go（编 `tool/`，依赖 quic-go）、Node（仓库的 node_modules，用来跑面板代码）、curl。
sing-box 不给 `SING_BOX=` 时下载官方 1.14.0 release 到 `~/.cache/nex-ss-egress-e2e/`。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `SING_BOX` | 下载 | sing-box 二进制 |
| `SOAK_SECONDS` | 600 | 长稳时长，0 跳过 |
| `SOAK_PPS` | 200 | 长稳每个方法的包速（4 个流分摊） |
| `SOAK_METHODS` | `aes-256-gcm 2022-blake3-aes-128-gcm` | 长稳跑哪些方法（并行） |
| `IDLE_SECONDS` | 45 | 长稳之后空闲多久再恢复发包（要大于面板下发的 UDP 监听 ttl 30s） |
| `SKIP_SPLICE` | | 设了就跳过 `splice-check.sh` 回归 |
| `RESULTS` | 临时文件 | 结果行另存一份 |
| `KEEP_WORK` | | 设了就保留工作目录（配置、日志） |

每项测试打一行 `RESULT ...`，最后汇总；任何一项失败退出码非 0。

## 测了什么

每个方法（`aes-128-gcm`、`aes-256-gcm`、`chacha20-ietf-poly1305`、`2022-blake3-aes-128-gcm`、
`2022-blake3-aes-256-gcm`）都有四条规则：TCP+UDP 回声、只 UDP 的 DNS、只 UDP 的 QUIC、只 TCP 的出口。

| 测试 | 断言 |
| --- | --- |
| `udp-echo/<方法>` | 1、64、512、1200、1400、1472 字节各 200 个包，逐字节比对回包；≥99% 收到、0 损坏 |
| `dns/<方法>` | 200 个 A 查询（每个查询一个源端口），回答必须是目标给这个名字算出来的地址；外加约 1.2 KB 的 TXT 回答和 NXDOMAIN |
| `quic/<方法>` | quic-go 客户端经入口端口和 quic-go 服务端完整握手（ALPN 校验），3 条连接 × 8 条流 × 1 MiB 回声，SHA-256 比对 |
| `tcp-egress/<方法>`、`tcp-only-egress/<方法>` | 16 条 TCP 连接各 4 MiB 回声，SHA-256 比对 |
| `udp-echo/ss-link-*`、`tcp-egress/ss-link-*` | 外部 ss:// 链接（SS2022 base64 密钥）那条路 |
| `udp-plain-no-egress`、`tcp-plain-no-egress` | 不挂出口的普通 gost 规则，回归对照 |
| `flows-200/<方法>` + `concurrent-tcp/<方法>` | 200 个 UDP 源端口同时各发 20 个带流号的包，回包必须回到发它的那个源端口（`foreign=0`），同时跑 32 条 TCP |
| `gating` | 面板闸门：没能力的入口机（Agent 2.2.227 + 运行时 nex2）保存 UDP / SS2022 出口被拒；已经存在的 UDP 出口规则在它的 gost.json 里整条不出现（没有 ssu 链、UDP 不直连），卡片状态 `udp_runtime_upgrade`；经典 TCP 出口照旧 |
| `soak/<方法>` | 持续 UDP（默认 10 分钟、每方法 200 包/秒、4 个流），带序号和发送时间：丢包率、乱序、重复、RTT 分位；每 60 秒采样 gost 进程的 RSS、线程、fd、goroutine，结尾和第一个稳定样本比不能增长 |
| `soak/<方法>-idle-resume` | 停发超过 UDP 监听 ttl，入口一侧的会话应被回收（fd / goroutine 下降），同一个源端口恢复发包要立刻重新建会话收到回包 |
| `splice-check` | `gost-runtime/test/splice-check.sh`（含 echocheck）：TCP 隧道、PROXY 头、TLS 隧道的 splice 回归 |

## 已知

- 经 ss 连接器的 TCP 不支持半关闭（客户端 `shutdown(SHUT_WR)` 后整条连接被关），这是上游 gost 的行为，
  出口 TCP 在 nex2 上就是这样，nex3 没有改它；`tool tcp` 默认不半关闭（`-half-close` 可以打开看）。
- 上游 gost 3.2.6（nex2 的 Shadowsocks 部分和上游相同）跑同样的配置：经典 AEAD 的 TCP 通，所有 UDP 收不到回包，SS2022 的 TCP 回程解不出来、
  UDP 被 sing-box 拒（根因见 `gost-runtime/nex-ssu.patch`、`nex-shadowsocks2.patch` 开头）。
