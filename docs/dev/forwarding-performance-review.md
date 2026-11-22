# 转发性能与稳定性专项（2026-11-22）

> 状态：已完成。所有改动在分支 `claude/nice-goldberg-inty9l`，提交见 git log「转发专项」「FXP 封帧流水线」「Agent 转发组保护期」。
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
| F1 | `forwardx-fxp/copy_pipeline.go:writeChunk` | 每块明文（128 KiB）切帧时 `var frames [2][]byte` 作为变参传给接口方法 `writeFrames`，切片头数组逃逸到堆：**每块一次分配**，是 TCP 隧道稳态下每 GB 八千多次分配里的大头（基准 allocs/GB 8588，其中 ≈8192 来自这里） | 中（性能，GC） | 变参 + 接口调用的逃逸 |
| F1b | `forwardx-fxp/copy_pipeline.go` 读 → 封帧交接 | 每次交接向进程级缓冲池借 / 还一块 128 KiB 读缓冲，池每档 128 个槽位、所有连接共用。审计时怀疑多流下槽位耗尽会变成 1:1 分配；**A/B 实测 1 / 4 / 32 流下与改前持平（±5%）**，说明 32 流还没到槽位上限。改成每连接局部复用后不再依赖池的槽位数，收益要在更多并发大流时才看得到，本机未能验证 | 低 | 池是进程级有界池 |
| F2 | `forwardx-fxp/copy_pipeline.go` `fxpPlainPipeline.drain` | 大帧（多路径）要就地写之前等写出协程清空，用 `time.After(1ms)` 轮询：每轮一次定时器分配、最多 1 ms 的额外延迟 | 低（延迟 / 分配，多路径大帧路径） | 写出协程没有「清空了」的通知 |
| F3 | `forwardx-fxp/udp_direct.go` 各发送协程 | 每个包判断「是否过期且后面有更新的包」时先调 `queue.pending()` 拿队列锁、再看钟（`superseded(now, pending)` 参数求值顺序），一批里每个包都和读循环（入队方）抢一次锁、看一到两次钟；而绝大多数包根本没过期 | 低（本机 A/B 未测出差别，见 §5.4） | 判断顺序把廉价的时间比较放在了昂贵的加锁之后 |
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
| F1 | `writeChunk` 切帧用的切片头数组放到流水线结构体上（每连接一份），不再每块逃逸分配 | `forwardx-fxp/copy_pipeline.go` |
| F1b | 两条流水线各加一个每连接的 `spare`（容量 = 排队深度 + 1）：写出协程用完的缓冲先留给这条连接下一次交接，留不下才还进程池；协程退出时统一归还 | `forwardx-fxp/copy_pipeline.go` |
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
- `agent/failover_guard_upload_test.go`
  - `TestFailoverGuardUploadIntegrityWithSilentUpstream`：上游只收不回、3 MiB 不规则分块上传全程在保护期内，逐字节核对（保护期缓冲复用不能错位、不能耽搁数据）。
- `forwardx-fxp/bench_dataplane_many_test.go`
  - `BenchmarkDataplaneTCPBulkMany`：32 条流同时灌（Gbps、cpu-ms/GB、allocs/GB）。
  - `BenchmarkDataplaneTCPConnRate`：32 个客户端连 → 1 字节往返 → 关（conns/s）。
  - `BenchmarkDataplaneUDPSessions`：256 个客户端套接字（各自不同的回环源地址）轮着发、100k pps（pps、丢包、cpu-ns/pkt）。第一版全从 127.0.0.1 发，撞上入口「每来源 IP 最多 64 条 UDP 会话」的硬上限，75% 的包被拒 —— 这是限额在起作用而不是数据面瓶颈，但也说明**大量用户共用一个出口 IP（运营商 NAT、前置转发）时这个默认值会拒掉真实用户**，见 §6。
- 原有基准：`BenchmarkDataplaneTCPBulk`（1 / 4 流）、`TCPRTT`、`UDPRate`（50k / 200k pps）、`UDPRTT`，Agent 侧同名基准含 `TCPConnRate`；负载均衡 / 故障切换由 `exit_pick_bench_test.go`、`target_health*_test.go`、`failover_*_test.go`、`lbcore` 一致性用例和 `e2e/scenario.ts`（真 Agent 三台中转的主备 / 人工指定 / 交回 / 挂掉自动切）覆盖。

## 5. 构建、测试与性能对比

### 5.1 构建与测试

| 项目 | 结果 |
| --- | --- |
| `gofmt` / `go vet` / `staticcheck -checks SA*`（agent、forwardx-fxp、lbcore） | 通过，0 条 |
| `go test ./...` forwardx-fxp（修复后） | 通过，238 s |
| `go test ./...` agent（修复后，含保护期改动） | 通过，107 s |
| `go test -race` agent 子集（Failover / Guard / Relay / EarlyClose / Reroute） | 通过，43 s |
| `go test -race` forwardx-fxp 子集（UDP / 流水线 / 复位 / 会话 / 中转，共 225 s） | 通过。链式运行里第一次报了 FAIL 但日志只留了尾部、复跑通过，原因没抓到；建议把 race 子集放进 PR 必跑而不是每夜，攒到可复现 |
| 新增测试在**旧代码**上的表现 | `TestClientResetTearsDownSessionImmediately` 3.4 s 超时失败、`TestTargetResetTearsDownSessionImmediately` 5 s 超时失败（证明测的是真问题）；修复后两者 < 0.1 s |

### 5.2 连接风暴下的句柄（F0）

探针：32 个客户端连 → 1 字节往返 → `SetLinger(0)` 关，持续 2 秒，然后每秒读进程 fd 数。

| | 2 秒内完成的连接 | 失败 | 风暴结束时 fd | t+5 s | t+20 s | t+25 s | t+30 s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 修复前 | 3998 | 40 | 19969（上限 20000） | 读不出（EMFILE） | 读不出 | 155 | 49 |
| 修复后 | 9203 | 0 | 139 | 137 | 137 | 137 | 137 |

对应基准 `BenchmarkDataplaneTCPConnRate/aes`（32 客户端，conns/s；修复前括号内是失败次数）：

| 核数 | 修复前 | 修复后 |
| --- | --- | --- |
| 1 | 1009（失败 179） | 1885 |
| 4 | 180（失败 3129） | 5216 |

### 5.3 TCP 隧道吞吐（同一台机器、同一天、A/B 交替 3 遍取中位数，4 核；AES-256-GCM）

| 基准 | 指标 | 修改前 | 修改后 | 变化 |
| --- | --- | --- | --- | --- |
| TCPBulk/aes/streams=1 | Gbps | 9.00 | 9.40 | +4.4% |
| TCPBulk/aes/streams=1 | cpu-ms/GB | 2562 | 2492 | -2.7% |
| TCPBulk/aes/streams=1 | allocs/GB | 8588 | 1069 | **-87.6%** |
| TCPBulk/aes/streams=4 | Gbps | 12.43 | 13.23 | +6.4% |
| TCPBulk/aes/streams=4 | cpu-ms/GB | 2244 | 2175 | -3.1% |
| TCPBulk/aes/streams=4 | allocs/GB | 8825 | 1189 | **-86.5%** |
| TCPBulkMany/aes/streams=32 | Gbps | 12.37 | 13.56 | +9.6% |
| TCPBulkMany/aes/streams=32 | cpu-ms/GB | 2287 | 2208 | -3.5% |
| TCPBulkMany/aes/streams=32 | allocs/GB | 13334 | 5295 | **-60.3%** |

64 字节一问一答（TCPRTT/aes）p50 15.6 → 15.8 µs、p99 44 → 47 µs：在噪声内，没有变差。

### 5.4 UDP 直连（F3 / F4）：**没有测出收益，也没有测出退化**

两次独立的全量运行之间 UDP 数字差得很多（256 会话单核 pps 61k → 75k、丢包 39% → 25%；50k pps 丢包 0.03% → 0.33%），一开始看像是改进 / 退化。于是把 `udp_direct.go` / `udp_tuning.go` 换回旧版、和新版交替各跑 3 遍（A/B，同一台机器、同一时段）：

| 基准 | 指标 | 旧代码 | 新代码 | 变化 |
| --- | --- | --- | --- | --- |
| UDPSessions/udp/sessions=256（1 核） | pps | 75363 | 71381 | -5.3% |
| UDPSessions/udp/sessions=256（1 核） | 丢包 % | 24.5 | 28.5 | +4 个百分点 |
| UDPSessions/udp/sessions=256（4 核） | pps / 丢包 | 99990 / 0 | 99995 / 0 | 持平 |
| UDPRate/udp/rate=200k（1 核） | pps | 144024 | 139249 | -3.3% |
| UDPRate/udp/rate=200k（4 核） | pps / 丢包 % | 194443 / 2.76 | 194617 / 2.67 | 持平 |
| UDPRate/udp/rate=50k（1 / 4 核） | 丢包 % | 0.28 / 0.41 | 0.41 / 0.57 | 都在 1% 以内 |
| UDPRate/udp-nogro/rate=200k（1 核） | pps | 129815 | 145750 | +12.3% |
| UDPRate/udp-perpacket/rate=200k（1 核） | pps | 110201 | 97271 | -11.7% |

同一份改动在三条路径上一个 +12%、一个 −12%、一个 −3%，而这三条路径里 F3 / F4 改的代码是一样的：这台 4 核机器上 UDP 单核压测的运行间抖动就有 ±10%，改动的效果淹没在噪声里。**结论：F3（每包少一次队列锁）和 F4（清扫不持表锁）在本机回环上测不出差别**；它们省的是锁和 O(n) 持锁时间，要在真机、更多会话、读循环和清扫真正抢锁时才可能看见。改动本身很小、语义不变、有测试，保留；但本报告不把它们算作已证实的性能提升。全量运行里 UDP 那些看起来变好或变坏的数字同样按噪声处理。

### 5.5 Agent 转发组保护期（F9）

`BenchmarkDataplaneTCPBulk/routegroup`：上游是只收不回的目标，整段传输都在保护期内（和真实的大上传一样）。修复前是基线全量运行，修复后是单独跑的 3 遍中位数。协议防护代理路径（guard）没改，列出来做噪声参照。

| 基准 | 核数 | 指标 | 修复前 | 修复后 | 变化 |
| --- | --- | --- | --- | --- | --- |
| routegroup/streams=1 | 1 | Gbps | 7.24 | 14.67 | **+103%** |
| routegroup/streams=1 | 1 | cpu-ms/GB | 1095 | 531 | -51% |
| routegroup/streams=1 | 1 | allocs/GB | 30856 | 58 | **-99.8%** |
| routegroup/streams=1 | 4 | Gbps | 12.25 | 19.98 | +63% |
| routegroup/streams=1 | 4 | cpu-ms/GB | 1651 | 1023 | -38% |
| routegroup/streams=4 | 1 | Gbps | 6.20 | 11.55 | +86% |
| routegroup/streams=4 | 4 | Gbps | 15.18 | 36.56 | **+141%** |
| routegroup/streams=4 | 4 | cpu-ms/GB | 1484 | 823 | -45% |
| routegroup/streams=4 | 4 | allocs/GB | 30868 | 97 | -99.7% |
| guard/streams=1（参照） | 1 | Gbps | 10.9 | 11.1 | +1.8% |
| guard/streams=4（参照） | 4 | Gbps | 34.8 | 40.0 | +14.8%（噪声上限） |

保护期之外（上游回过第一个字节以后）的转发走 splice，本来就没有这项开销；受益的是上游迟迟不回话的上传型连接，以及保护期内的所有连接的 GC 压力。

## 6. 未解决的问题与风险

- **UDP 热路径改动（F3 / F4）未测出收益**：见 §5.4 的 A/B。要验证得在真机上压更多会话、并用 `perf` / pprof 看锁等待时间。
- **race 子集一次未复现的失败**：见 §5.1。
- **F7 半关闭后无限等**：建议加一个可配置的「半关闭后空闲超时」（默认关闭或给一个很长的值，如 1 小时），对齐 Agent 侧 `relayTCPBidirectional` 的做法；因为有测试明确钉住现状、且会改变长响应场景的语义，本次不改，留给产品决策。
- **UDP 会话上限**（1024 / 规则）对中大型集群偏小，是防护值而不是容量值；提高时要同步看每会话 128 KiB 目标套接字缓冲带来的内核内存。
- **缓冲池槽位**（每档 128）仍是进程级常数；F1 之后稳态不再依赖它，但连接建立 / 结束高峰仍会越过槽位。可按 `GOMAXPROCS` 或配置放大。
- 本机回环基准没有真实 RTT / 丢包，UDP 的 pps 上限受发送侧（基准本身）限制；真机长跑（soak）脚本仓库里还没有，建议补 `scripts/soak/`。

## 7. 后续优化建议

1. TCP 隧道方向的 `splice`：入口客户端 ↔ 出口目标之间有加密层，做不了；但中转的「解一层再封一层」可以研究 AEAD 密钥协商后的透传模式，省掉中转的两次加解密。
2. UDP 返程在入口对多个会话合并 `sendmmsg`（目前按会话各自的发送协程），高会话数、低每会话 PPS 场景能省系统调用。
3. 把 `fxpBytePoolSlots` 与 UDP 会话上限做成配置项，并在面板的「主机规格」里给出建议值。
4. 给 FXP 加 Prometheus 指标：每规则在途会话、队列丢包、过期丢包、池借用失败次数、交接次数 —— 这次改动的效果在线上才能持续看见。
