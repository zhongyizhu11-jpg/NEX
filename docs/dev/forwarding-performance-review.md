# 转发性能与稳定性专项（2026-11-22）

> 范围：真正搬字节的代码 —— `forwardx-fxp/`（NEX 隧道的入口 / 中转 / 出口，TCP 帧流与 UDP 直连）、`agent/` 自己跑的转发（转发组 failover 代理的 TCP / UDP、协议防护代理、SNI 共享入口、管理中继）、`lbcore/`（出口 / 线路挑选）。iptables / nftables / realm / gost / nginx 这些由 Agent 配置但不经 Agent 进程搬字节的运行时不在本次代码审计范围内。
> 方法：按数据流逐函数读代码取证，先跑一遍基线基准再改，改完回归全部 Go 测试 / race / staticcheck 并重跑基准对比。本文所有数字都来自本机 4 核回环（`scripts/bench/dataplane.sh`），只用于同一台机器上的前后对比，不代表线上吞吐。

## 1. 转发架构与数据流

### 1.1 NEX 隧道 TCP（forwardx-fxp）

```
客户端 ──TCP──▶ 入口 handleEntryTCP ──加密帧流──▶ [中转 relayBidir/relayCopy]* ──▶ 出口 relayExitTCPToTarget ──TCP──▶ 目标
```

- **入口** `main.go:handleEntryTCP`：accept 后立刻从端点连接池取一条预热好的加密连接（`endpoint_pool.go` `take`），不等客户端首包；需要收 PROXY 头的规则例外。多出口时由 `exit_select.go` + `lbcore` 挑出口（主备 / 轮询 / 加权 / 最少负载 / 延迟 / 自动 / IP 哈希），挑中就记负载、拨不通 `unpick`。有多台会回报的出口时带 `TargetStatus`：出口连完目标先回一帧，连不上当场换下一台重放（`target_health.go`）。
- **帧层** `secureConn`：每帧 = 4 字节长度（AEAD 封装）+ 内容（AEAD 封装），AES-256-GCM 或 ChaCha20-Poly1305，nonce 由方向 + 计数器派生；`writeFrames` 把几帧封进一块缓冲一次 `write`；`fxpFrameReader` 一次 `read` 尽量把内核里攒的都搬进来，帧就地解密不拷贝（`frame_reader.go`、`main.go:readFrames/nextFrame`）。
- **双向拷贝** `copy_pipeline.go`：明文 → 隧道方向读协程与「封帧 + 写」协程分开（≥16 KiB 的块才交接，深度 2）；隧道 → 明文方向同理，小批就地 `writev`。半关闭语义：读到 EOF 写结束帧，对端收到结束帧 `CloseWrite` 明文侧；`waitBidirectionalWithLinger` 一边干净结束后另一边**无限等**（有测试钉住这一行为，见 §6 风险），对端异常断开才有 30 秒 linger。
- **缓冲池** `buffer_pool.go`：按尺寸分 11 档、每档 128 个槽位的有界 channel 池，超出槽位直接交给 GC。
- **出口** 拨目标超时按入口给的 `TargetDialTimeoutMs`（默认 4 秒、上限 10 秒）；目标连上后 `commitSession` 解除隧道连接上的 `TCP_USER_TIMEOUT`。
- **多路径 / 带宽叠加** `multipath*.go`：一条连接拆到多条腿上、出口按序重组；各中转用会话 id 的 rendezvous 哈希保证落到同一台出口（`exit_select.go:pickSessionAffinity`）。

### 1.2 NEX 隧道 UDP 直连（forwardx-fxp/udp_direct.go）

```
客户端 ──UDP──▶ 入口 serveEntryUDPDirect ──加密 UDP 包──▶ [中转 serveRelayUDPDirect]* ──▶ 出口 serveExitUDPDirect ──UDP──▶ 目标
```

- 每个访客（来源 `netip.AddrPort`）一条会话：`byClient` / `byID` 两张表 + 每 IP 计数；软 / 硬上限（512 / 1024 会话，每 IP 48 / 64）、规则自己的连接闸、队列字节预算（每规则）。
- 包的所有权链：读循环把明文拷进池里的缓冲 → 会话发送队列（有界环形队列，满了挤掉最老、超过 75 ms 还没发出去且后面有新包的丢）→ 发送协程封包、Linux 上 `sendmmsg`/GSO 一次发一批（`udp_batch_linux.go`、`udp_wire_batch.go`）。回程对称。
- 出口按（规则, 会话号）找会话、与来源地址无关；回程地址按「最新序号的包从新地址来」迁移（NAT 重映射）；重放窗口 + 时间戳新鲜度（`udp_replay_guard.go`）；可选 FEC 冗余（`udp_fec.go`）和分片重组（`udp_fragment.go`）。
- 会话清扫协程每 5 秒（或被唤醒、至少间隔 250 ms）：过期分片、空闲 5 分钟（有未完成分片时 10 分钟）的会话关掉，接近软上限时按压力回收最闲的。
- 出口健康对 UDP 单独判（UDP 探活包回过的以它为准；从没回过的跟 TCP 侧结论走），一直没回包的会话换出口（`repickReason`）。

### 1.3 Agent 进程内的转发

- **转发组 failover 代理** `failover_proxy.go` / `route_group_udp.go`：TCP 每条连接 `dialNextPathReserved` 挑路径（挑中先记在途，拨通转成连接），保护期内上游在回第一个字节前就关则换路重发（`failover_early_close.go`），之后 `tcp_relay.go:relayTCPBidirectional` 用 `io.Copy`（`*net.TCPConn` 之间走 **splice** 零拷贝）+ 半关闭 linger（30 秒，有数据续期）。UDP 按来源建会话（规则 4096 上限 + 进程全局上限），`recvmmsg` 收一批、同一来源连着的包一次 `sendmmsg`。
- **协议防护代理** `protocol_guard*.go`：检测阶段逐块拷贝，检测结束且无限速时切到 `io.Copy` splice，每 4 MiB 回头看一次限速是否热更新；UDP 同样批量。
- **SNI 共享入口** `sni_router.go`：解析 ClientHello 后按 SNI 分发。
- **管理中继** `ext_relay.go`：两头 `io.Copy` 带空闲超时。

### 1.4 挑选算法（lbcore）

`lbcore.Pick` 统一实现主备（First）、轮询、平滑加权轮询、最少负载（有效权重 ÷ 负载）、延迟优先（near 集合 + 滞回）、自动（peak-EWMA 延迟 + 抖动 + 丢包 + 利用率的成本）、IP 哈希（rendezvous，带负载上限）；`Candidates` 按健康分层（Dead / Cooling / DownstreamDown / Soft）并有摘除上限，全坏时恐慌模式轮着试。FXP 与 Agent 两边用同一份代码，`lbcore/testdata/conformance` 卡住一致性。

## 2. 发现的问题与严重程度

| # | 位置 | 问题 | 严重度 | 根因 |
| --- | --- | --- | --- | --- |
| **F0** | `forwardx-fxp/main.go:waitBidirectionalWithLinger` + `copyPlainToSecureWithPolicy` | **明文侧（客户端 / 目标）复位或写失败后，整条会话再挂 30 秒**：这类错误被 `isClosedErr` 归为「closed」，走 30 秒 linger 等另一个方向结束，而另一个方向正卡在读帧上、出口没有新数据就一直等。连接风暴（客户端大批中断重连、扫描）下句柄按「每秒连接数 × 30」积累：本机探针 2 秒 4000 条连接就把进程 20000 个 fd 占满，之后 20 多秒内入口拨不出去、出口接不进来、连 `/proc` 都读不了，所有新连接失败 | **高（可用性）** | linger 本意是「对端已关隧道、读缓冲里还有几帧没交出去」时别截断，但没有区分「隧道那头关了」和「明文这头没人收了」—— 后者多等一秒都是白占 |
| F1 | `forwardx-fxp/copy_pipeline.go` 读 → 封帧交接 | 每次交接向**进程级**缓冲池借一块 128 KiB 读缓冲、写出协程用完还回去。池每档只有 128 个槽位：几十条连接同时灌数据时槽位被在用的缓冲占满，每次交接都是一块新分配 —— 流量和分配 1:1，GC 压力随并发流数线性上涨 | 中（性能，多流场景） | 池是进程级有界池，没有每条连接的局部复用 |
| F2 | `forwardx-fxp/copy_pipeline.go` `fxpPlainPipeline.drain` | 大帧（多路径）要就地写之前等写出协程清空，用 `time.After(1ms)` 轮询：每轮一次定时器分配、最多 1 ms 的额外延迟 | 低（延迟 / 分配，多路径大帧路径） | 写出协程没有「清空了」的通知 |
| F3 | `forwardx-fxp/udp_direct.go` 各发送协程 | 每个包判断「是否过期且后面有更新的包」时先调 `queue.pending()` 拿队列锁、再看钟（`superseded(now, pending)` 参数求值顺序），一批里每个包都和读循环（入队方）抢一次锁、看一到两次钟；而绝大多数包根本没过期 | 中（UDP 高 PPS 热路径） | 判断顺序把廉价的时间比较放在了昂贵的加锁之后 |
| F4 | `forwardx-fxp/udp_direct.go` 入口 / 出口 / 中转的 `sweep` | 清扫协程持会话表锁的同时逐条给每条会话的分片重组器过期（每条再拿一把锁）：几千条会话时读循环每 5 秒被挡一次 O(n) | 低（尾延迟，大会话数） | 把两类工作放在同一把锁里 |
| F5 | `agent/actions.go:activeSharedRuntimeForwardType` | 判断端口被 nginx 还是 gost 占着的循环在第一轮就 `return`，只看了列表里第一条路径 | 中（功能 bug：共享运行时端口归属误判，可能把 nginx 的端口当 gost 处理） | 循环体写错（staticcheck SA4004 报出，CI 未拦） |
| F6 | `agent/ext_relay.go:relayCopyWithIdle` | 每条中转连接每个方向 `make([]byte, 32K)`，不走进程缓冲池 | 低 | 遗漏 |
| F7 | `forwardx-fxp/main.go:waitBidirectionalWithLinger` | 一边干净半关闭后另一边**无限等**：客户端 `shutdown(WR)` 后目标一直不关，这条连接和两个协程永远挂着；只有对端异常断开才有 30 秒 linger。有测试 `TestWaitBidirectionalKeepsCleanHalfClosedStreamsOpen` 钉住这一行为 | 中（资源：半关闭连接不回收）—— **未改**，见 §6 | 设计决定：优先保证半关闭后的长响应不被截断 |
| F9 | `agent/failover_early_close.go:guardedStart` | 转发组新连接的「保护期」（上游回第一个字节之前，最长 8 秒）里读客户端的协程**每次 Read 都 `make` 一块 32 KiB**再经 channel 交给主循环。上传型连接（POST 大请求体、服务端先等数据）整个保护期都在这条路上：本机基准每 GB 三万次分配，吞吐只有协议防护代理路径的 2/3 | 中（性能，上传场景） | 缓冲在两个协程之间单向流动，没有回收 |
| F8 | `agent/`、`forwardx-fxp/` staticcheck | 14 条 SA 级问题（含 F5），CI 里 staticcheck `continue-on-error` | 低（流程） | 门禁没开 |

未发现的问题（专门查过）：TCP 建连 / 半关闭 / EOF / RST 的处理路径完整；读写循环里没有多余的数据拷贝（帧就地解密、`writev`、splice）；`TCP_NODELAY` / keepalive / `TCP_USER_TIMEOUT` 都在；UDP 会话表用值类型键、不按包分配地址或字符串；队列有字节预算和过期丢弃，不会无限增长；会话 / fd / 协程生命周期都有 `done` + `closeOnce`，会话关闭沿途每条路都归还缓冲；出口健康、摘除、恢复、慢启动、恐慌模式、UDP / TCP 分侧判健康都有实现与测试；锁的粒度是每规则一把选择器锁 + 每会话表一把锁，没有全局热锁（端点注册表的全局锁只在拨号时碰一次）。

## 3. 修复内容

| 问题 | 改动 | 文件 |
| --- | --- | --- |
| F0 | 新增 `plainSideGoneError`：明文侧的读复位 / 写失败都包成它；`waitBidirectionalWithLinger` 遇到它立刻 `closeAll`，隧道那头的 closed 错误照旧 30 秒 linger（保留「最后几帧」的保护）。出口侧目标复位同样立刻收掉隧道腿，入口随即关客户端 | `forwardx-fxp/main.go` |
| F1 | 两条流水线各加一个每连接的 `spare`（容量 = 排队深度 + 1）：写出协程用完的缓冲先留给这条连接下一次交接，留不下才还进程池；协程退出时统一归还。进程池只在连接建立 / 结束时碰，稳态零分配 | `forwardx-fxp/copy_pipeline.go` |
| F2 | 写出协程在手里的活清空时点一下 `idle`，`drain` 靠它醒；定时器只做 50 ms 兜底 | `forwardx-fxp/copy_pipeline.go` |
| F3 | 新增 `supersededIn(now, queue)`：先看钟、过期了才问队列；一批包只看一次钟、记一次活动；不限速时省掉等限速之后那次复查（`waitDone` 当场返回，钟没变） | `forwardx-fxp/udp_tuning.go`、`udp_direct.go`（入口 / 出口 / 中转 8 处） |
| F4 | 清扫分两段：锁内只拍会话快照，锁外逐条过期分片，再锁内判空闲 / 回收；快照切片复用 | `forwardx-fxp/udp_direct.go`（三处 sweep） |
| F5 | 循环改为「任一路径是 nginx → nginx；否则有路径 → gost」 | `agent/actions.go` |
| F6 | 改用进程缓冲池 | `agent/ext_relay.go` |
| F9 | 保护期读客户端的缓冲在读协程和主循环之间循环使用（写给上游后归还，replay 里留的是副本） | `agent/failover_early_close.go` |
| F8 | 清掉 14 条，保留的写法用 `//lint:ignore` 注明原因；CI 开始拦截 | `agent/*`、`forwardx-fxp/*`、`.github/workflows/ci.yml` |

## 4. 新增 / 完善的测试与基准

- `forwardx-fxp/client_reset_test.go`
  - `TestClientResetTearsDownSessionImmediately`：客户端 RST 后 3 秒内出口到目标的连接必须关掉（旧代码 30 秒，测试失败 3.4 s）。
  - `TestTargetResetTearsDownSessionImmediately`：目标复位后客户端 3 秒内被关掉（旧代码失败，等满 5 秒超时）。
- `forwardx-fxp/copy_pipeline_reuse_test.go`
  - `TestSealPipelineReusesHandoffBuffers`：第二次交接拿到的就是第一次交出去、写出协程已用完的那块缓冲；结束后 spare 清空；字节顺序不变。
  - `TestPlainPipelineDrainsBeforeOversizedFrame`：几帧交给写出协程后来一帧装不进交接缓冲的大帧，就地写之前等清空，顺序不乱。
  - `TestSupersededInOnlyAsksQueueWhenExpired`：过期判断的四种组合。
- `forwardx-fxp/bench_dataplane_many_test.go`
  - `BenchmarkDataplaneTCPBulkMany`：32 条流同时灌（Gbps、cpu-ms/GB、allocs/GB）。
  - `BenchmarkDataplaneTCPConnRate`：32 个客户端连 → 1 字节往返 → 关（conns/s）。
  - `BenchmarkDataplaneUDPSessions`：256 个客户端套接字（各自不同的回环源地址）轮着发、100k pps（pps、丢包、cpu-ns/pkt）。第一版全从 127.0.0.1 发，撞上入口「每来源 IP 最多 64 条 UDP 会话」的硬上限，75% 的包被拒 —— 这是限额在起作用而不是数据面瓶颈，但也说明**大量用户共用一个出口 IP（运营商 NAT、前置转发）时这个默认值会拒掉真实用户**，见 §6。
- 原有基准：`BenchmarkDataplaneTCPBulk`（1 / 4 流）、`TCPRTT`、`UDPRate`（50k / 200k pps）、`UDPRTT`，Agent 侧同名基准含 `TCPConnRate`；负载均衡 / 故障切换由 `exit_pick_bench_test.go`、`target_health*_test.go`、`failover_*_test.go`、`lbcore` 一致性用例和 `e2e/scenario.ts`（真 Agent 三台中转的主备 / 人工指定 / 交回 / 挂掉自动切）覆盖。

## 5. 构建、测试与性能对比

（见下方由脚本填入的结果。）

## 6. 未解决的问题与风险

- **F7 半关闭后无限等**：建议加一个可配置的「半关闭后空闲超时」（默认关闭或给一个很长的值，如 1 小时），对齐 Agent 侧 `relayTCPBidirectional` 的做法；因为有测试明确钉住现状、且会改变长响应场景的语义，本次不改，留给产品决策。
- **UDP 会话上限**（1024 / 规则）对中大型集群偏小，是防护值而不是容量值；提高时要同步看每会话 128 KiB 目标套接字缓冲带来的内核内存。
- **缓冲池槽位**（每档 128）仍是进程级常数；F1 之后稳态不再依赖它，但连接建立 / 结束高峰仍会越过槽位。可按 `GOMAXPROCS` 或配置放大。
- 本机回环基准没有真实 RTT / 丢包，UDP 的 pps 上限受发送侧（基准本身）限制；真机长跑（soak）脚本仓库里还没有，建议补 `scripts/soak/`。

## 7. 后续优化建议

1. TCP 隧道方向的 `splice`：入口客户端 ↔ 出口目标之间有加密层，做不了；但中转的「解一层再封一层」可以研究 AEAD 密钥协商后的透传模式，省掉中转的两次加解密。
2. UDP 返程在入口对多个会话合并 `sendmmsg`（目前按会话各自的发送协程），高会话数、低每会话 PPS 场景能省系统调用。
3. 把 `fxpBytePoolSlots` 与 UDP 会话上限做成配置项，并在面板的「主机规格」里给出建议值。
4. 给 FXP 加 Prometheus 指标：每规则在途会话、队列丢包、过期丢包、池借用失败次数、交接次数 —— 这次改动的效果在线上才能持续看见。
