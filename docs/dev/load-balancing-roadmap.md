# 负载均衡整治路线图（立项）

> 维护者内部文档，不进公开文档站（`docs/.vitepress/config.mts` 的 `srcExclude` 排除了 `dev/**`）。
> 立项日期 2026-11-18。来源：对面板 2.3.539 / Agent 2.2.262 / FXP 2.2.145 的负载均衡专项审计
> （三路读码 + 一次性测试复现；GOST 行为按 `go-gost/x@v0.8.1` 源码核对）。
> 「已复现」= 用测试跑出来了；「读码」= 代码路径确定但没跑；「待实测」= 要真实流量确认。

## 现状：五套机制，只有两套按连接调度

| 机制 | 流量在哪里分 | 连接级调度 |
|---|---|---|
| 线路组（一条规则多条出站，`agent/failover_*.go`、`route_group*.go`） | 入口 Agent 逐连接挑 | 是 |
| 隧道出口组（`forwardx-fxp` 选择器；GOST 选择器；nginx upstream） | FXP / GOST / nginx | 是，三种运行时算法不同 |
| 转发组·故障转移 | DNS 单条记录切换 | 否（主备） |
| 入口组 | DNS 多条记录 | 否（解析器轮流，权重不起作用） |
| 落地池 | 底层是线路组 + 可选直连域名 | 是 |

节点池是中转候选清单；订阅里的负载均衡组由客户端执行；多路聚合是单连接捆绑。

## 问题清单（按 2.3.539 现行代码）

### 一、会让流量走错

| 编号 | 问题 | 位置 | 状态 |
|---|---|---|---|
| G1 | GOST 多出口：出口全被摘除时选择器返回空，路由为空，连接由入口机（多跳时是中转机）直连目标 | gost `selector/filter.go:27`、`chain/route.go:129`；`server/agentHeartbeatGostPlan.ts:332,359,382` | 读码，待实测 |
| G2 | 2.3.539 的「GOST 由入口 Agent 自己切」从未启用：`entryNeedsTarget` 恒为真，所有规则被跳过；直接去掉判断会断流（每出口的本机服务没有目标） | `server/agentHeartbeatRoute.ts:3172`；`server/gostTunnelProtocol.ts:61` | 读码 |
| X1 | FXP 主备：主出口连不上、备用「不稳 / 刚恢复不满 5 分钟」时仍挑主出口；UDP 新会话终身钉在死出口上 | `forwardx-fxp/main.go:687-705` | 已复现 |
| X2 | V2（用户态 WireGuard）：出口都被改写成 `127.0.0.1:端口`，负载按主机名分桶，自动 / 按负载 / 按访客固定全压一台 | `forwardx-fxp/main.go:483` | 已复现 |
| X3 | FXP 的 UDP：不计负载、没有健康信号、不切换、不感知目标；会话终身固定出口 | `forwardx-fxp/udp_direct.go:597,2007-2048` | 读码 + 已复现（按负载全去最大的出口） |
| A1 | 线路组「自动择优 + 恢复后切回」来回切 | `agent/failover_selection.go:251-294` | 已复现 |
| A2 | 成功拨号清零探测失败计数，探测目标已死的线路不被判坏 | `agent/route_group.go:180-183` | 已复现 |
| A3 | 线路级「按访客固定」TCP：只有整组策略是 ip_hash 才带 / 解析 PROXY 头，所有访客落到一个落地 | `server/agentHeartbeatRoute.ts:3266`；`agent/route_group_udp.go:596` | 已复现 |
| E1 | 「上游没回就断开时换路重发」：上游已回复又关闭、客户端还在上传时，丢掉回复并把请求重发给另一条线路 | `agent/failover_early_close.go:125-135` | 已复现（198/300） |
| C1 | 手动指定出口后那台掉线：下发不更新，流量黑洞最长约 5 分钟；指定从不清理；nginx / 多跳隧道上不生效 | `server/agentHeartbeatRoute.ts:2658,3138,4214`；`server/routers/tunnels.ts:853-868` | 读码 |

### 二、行为不符合预期

- A4 拨号失败判坏没有时间门槛，并发失败各算一次；本机错误（fd / 端口耗尽）算线路失败。
- A5 没有健康候选时退回全部线路，包括暂停 / 维护的。
- A6 非主备策略下线路判坏后，已有 TCP 连接和 UDP 会话不迁移；UDP 黑洞流不重选。
- A7 UDP 域名目标解析缓存过期时线路被临时排除，新会话钉到别的线路上。
- A8 / X5 「按负载」在拨号成功后才记数，突发连接全压一条；FXP 的成本不含活动连接数（界面写的是连接数）。
- A11 面板提示恢复和 UDP 侧恢复没有慢启动；重建时慢启动和加权状态不重映射。
- A12 读锁下调用会重分配切片的函数（出站数变化后的并发拨号可触发竞争）。
- A14 FXP 出口事件正则对不上日志格式，事件一直是空的。
- X4 轮询 / 加权每条规则从固定位置起步。
- X6 FXP「按访客固定」不认 PROXY 头里的来源，SNI 共享入口的访客都是 `127.0.0.1`。
- X7 未探测的选择器（中转 UDP、纯 UDP 规则）会把共享健康状态改回健康。
- X8 目标本身挂了时，每条连接仍挨个出口重放（3 个出口 = 3 次目标拨号，超时时客户端等 N×4 秒）。
- X9 一次中断被数成 4 次翻转，直接进「抖动放慢」；恢复后还要再不稳 92 秒。
- X10 「延迟优先 / 自动」的入口到出口那一段延迟不衰减、探测被目标探测顶掉，一次慢握手能让一台出口长期没流量。
- X11 状态帧等待没有超时；预热池里的黑洞连接没有反馈。
- H1 下一跳快速探测：16 路并发卡住整轮（96 个黑洞目标时健康目标 8 秒只探 4 次）；翻转上报失败要等 30 秒；按规则不按目标去重。
- H2 被动重传率不衰减，流量停了以后出口一直「不稳」。
- P3 成员 Agent 重启后第一个正常样本立刻算健康，DNS 立即切回；面板的 DNS 切换没有冷却 / 最短驻留。
- P4 定时启停、节点池同步改成员后不重新评估；P5 定时启停不走编辑锁、成员替换不在事务里。
- P6 删除转发组不清 DNS 记录。
- P9 / P14 保存检测灵敏度、调出口顺序、多出口里掉线一台，都会把整条隧道的规则标成未运行（还会让出口探测停掉）。
- P10 落地池直连域名：流量暂停的主机仍发布、没有迟滞、写失败 10 分钟不重试。
- P11 健康检查关着时任何保存都重置成员健康。
- C2 出口状态翻转的紧急推送不防抖；延迟领先者的记录在三种情况下冻结，之后每次上报都推一次。
- C3 面板重启后已知有问题的出口被放回轮转最长约 5 分钟；老 GOST 下发方式下，面板不可用期间恢复的出口一直被排除；文档写的防抖（`BALANCE_ANTI_FLAP`）没有任何代码引用。
- P1 入口组「按带宽排序解析」只改记录顺序，DNS 层无效；文档说法不符。
- N1 nginx：主备 3 个以上出口不是按顺序；各 worker 各算各的；旧 `least_conn` 丢权重；新机制（目标感知、检测参数、手动指定）都没有。

### 三、规模

- P7 面板评估单条串行队列、DNS 调用内联；每成员重复查库；健康上报触发整组评估。
- P8 每次完整心跳加载全部组拓扑；新增：每次上报全字段查规则、内存表线性扫描且不清理、出口 × 规则的探测量没有上限。
- X12 FXP 挑选路径开销涨了约 13 倍（目标感知时每次 59 次分配，全在规则锁里）。
- A13 Agent 每次心跳对每条规则规格落盘；探测没有抖动。
- P15 面板只支持单实例：锁、队列、在线状态、新加的出口健康表都在进程内。

## 阶段

1. **修会让流量走错的和最容易踩的**（G1、X1–X3、A1–A8、E1、C1–C3、P3–P6、P9–P11、H1–H2、X4–X11、A11–A14），每条配回归测试；本机网络命名空间实验室里用真实流量做故障注入验证。GOST：先给运行时打补丁（过滤后为空时返回全部节点），绕过隧道的路径直接堵死。
2. **调度统一**：GOST 出口组真正交给入口 Agent 的本机代理（补上每出口服务的目标、访客地址、UDP），nginx 出口组同样处理或明确标成基础支持；线路组和 FXP 的挑选规则对齐并跑同一套一致性测试；UDP 补齐健康、切换、负载统计。
3. **DNS 层的组**：外部观察点探测、切换冷却、成员变化即时评估、入口组权重（按服务商的记录权重实现，做不到的服务商在界面写明）。
4. **控制面与规模**：评估批量加载、按服务商分队列、心跳拓扑缓存、内存表清理、数据库租约（多实例时只有一个跑评估和 DNS 写入）、转发方式分级标注、界面显示实际算法。

## 实施记录

### 阶段 1（2026-11-19，面板 2.3.540 / Agent 2.2.263 / FXP 2.2.146 / gost nex6）

| 范围 | 落点 |
|---|---|
| G1 | `gost-runtime/nex-selector-noempty.patch`（过滤后为空返回全部；选不出节点时路由报错而不是直连；按规则故意直连的 bypass 不受影响）；回归 `gost-runtime/test/bypass-check/run.sh` |
| GOST 权重 | `server/agentHeartbeatRoute.ts`：`metadata.weight` 写成字符串（数字被 gost 当成 1） |
| A1–A14、E1、H1、H2 | `agent/failover_*.go`、`route_group*.go`、`failover_early_close.go`、`route_hop_probe.go`、`passive_rtt.go`、`fxp_endpoint_events.go` |
| X1–X12、F13 | `forwardx-fxp/main.go`、`exit_load.go`、`target_health.go`、`endpoint_pool.go`、`selected_transport.go`、`udp_direct.go`，新增 `udp_ping.go`（UDP 探活包 3/4、访客地址包 5，老版本忽略）、`tcp_user_timeout_linux.go` |
| A3、P3–P6、P9–P11、P14、C1–C3、P1 | `server/repositories/forwardGroupRepository.ts`、`forwardGroupFlapHold.ts`、`exitTargetPush.ts`、`tunnelExitPin.ts`、`landingPools.ts`、`routeGroupStats.ts`（限额提示） |
| N1 | `server/agentHeartbeatNginx.ts`：`zone`、主备权重 10000/100/1、多出口 3 秒换下一台 |

验证：tsc、lint 基线内、`pnpm test:all` 4650 项（4645 过 / 0 失败 / 5 跳过）、Agent 与 FXP `go test ./...` 全过、相关用例 `-race` 无竞争。

本机网络命名空间实验室（1 入口 + 3 出口 + 1 中转 + 目标 + 访客，真实 Agent / FXP / gost）实测：

| 场景 | 修之前（2.3.539） | 修之后 |
|---|---|---|
| GOST 三台出口全部拒绝连接，新开 12 条 TCP | 11 条由入口机直连目标 | 12 条全部失败，0 条到达目标；恢复后立即走出口，约 15 秒后三台均分 |
| NEX V1 黑洞一台出口，新开 30 条 TCP | 9 条里 3 条挂住 | 0 失败，1 条等 6 秒后换出口，其余毫秒级；之后只在另两台间分 |
| NEX V1 一条 UDP 会话，中途黑洞所在出口 | 一直无回包 | 约 16 秒后自动换到另一台出口 |
| 线路组一条 UDP 会话，中途黑洞中转 | — | 约 3 秒后换到直连线路 |
| NEX V3 黑洞一台出口，新开 30 条 TCP | — | 29 条成功、1 条失败、1 条等 3 秒 |
| GOST 一条 UDP 会话，中途黑洞所在出口 | 一直无回包 | 仍然一直无回包（GOST 的 UDP 还在 gost 自己的选择器上，阶段 2 处理） |

遗留到阶段 2：GOST 出口组交给入口 Agent（含 UDP）；NEX UDP 掉线发现从约 16 秒压到 5 秒以内；V3 多路复用下的状态帧超时；同一规则 TCP+UDP 时 UDP 单独被封发现不了；主出口换位 / 重新上线时规则仍会短暂显示未运行。

### 阶段 2 · GOST 出口组交给入口 Agent（2026-11-19，Agent 2.2.264）

| 范围 | 落点 |
|---|---|
| G2：出口组真正由入口机的本机代理挑（TCP + UDP） | 面板 `server/gostBalancePlan.ts`（规格）、`agentHeartbeatRoute.ts` 的 `gostBalancePlans`、`agentHeartbeatGostPlan.ts`（公网端口 → 代理 → 每出口一个带目标的本机端口 → 单节点链）；Agent `failover_exit_group.go` |
| 不留老路 | 删掉 gost 节点选择器那一套：`gostExitSelector`、防绕过兜底节点、面板排「延迟优先」节点顺序 / 摘节点。门槛只有 `shared/loadBalance.ts` 的 `UNIFIED_BALANCE_AGENT_VERSION` + `agentSupportsUnifiedBalance`；入口机 Agent 更老时只下发主出口，链路上写「需要升级 Agent」（`server/tunnelBalanceAgent.ts`） |
| 健康 | 直接探出口机（固定节拍，`probeIntervalSeconds` / `probeTimeoutMs`）+ 真实连接「没回就被关」后经出口复核 + 面板提示；多跳（`viaRelay`）没有第一条 |
| 访客地址 | 公网 gost 监听总是先发 PROXY 头（UDP 是每个新会话先发一个只有 v2 头的包，`route_group_udp_visitor.go`）；「入口接收 / 入口发送」的规则不再排除 |
| 手动指定 | 原样交给代理：指定的那台能用只走它，坏了当场不理它（所有分法） |
| 上报 | `balance_report.go`：picks 是累计分配数，share 是最近一分钟的比例 |
| Nginx 隧道 | 留在 nginx 自己的 upstream 上，界面标「基础支持」（`nginxBalanceBasicSupportNote`）。要接进来还差：只转 UDP 的规则出口上没有 TCP 监听可探；nginx 给 UDP 加的 PROXY 头和数据在同一个包里（要另写解析）；入口有协议守卫 / 共享 TLS 入站时代理要插在守卫后端和 nginx 之间 |

端到端（`gost-runtime/test/balance-proxy/run.sh`：真实心跳生成的下发 + 真实 gost 3.2.6-nex6 + 真实 failoverProxy，回环上 1 入口 + 3 出口，目标记录谁拨来的）：

| 场景 | 结果 |
|---|---|
| 八种分配方式，TCP 64 条 / UDP 32 个会话 | 轮流 22/21/21、10/11/11；按权重（8:5:3）32/20/12、16/10/6；按负载 32/20/12；按访客固定 16 个访客各不换出口、TCP 和 UDP 同一台；主备全走一台；延迟优先：面板说一台到目标慢 200 ms（门槛 50 ms）时它 0 条，另外两台一起分 |
| 出口进程死掉（拒绝连接） | 0.1 秒摘掉（第一条撞上去的连接被换走 + 复核），新连接 0 失败；回来 5.6 秒放回 |
| 出口被黑洞（均衡档 2 秒一轮） | 5.0 秒摘掉，期间 65 条新连接 0 失败（16 条等了约 3 秒被换走）；回来 4.0 秒放回 |
| 出口被黑洞（灵敏档 1 秒一轮） | 3.3 秒摘掉；回来 2.1 秒放回 |
| 一个 UDP 会话，所在出口被黑洞 | 4.8 秒后同一个套接字换到另一台出口并恢复回包 |
| 单台出口到目标被拒（出口机本身通） | 没流量时不判；第一批连接 0 失败，约 1 秒后经出口复核判坏；目标恢复约 9.5 秒后放回（经出口连着探通 2 次、每次 4 秒） |
| 手动指定的出口死掉 | 7 秒里 0 失败，另外两台各分一半；回来后又只走它 |
| 多跳（入口 → 中转 → 三台出口）黑洞一台出口 | 0 失败，撞上去的约 3 秒后换走，第一条连接后约 7 秒判坏；回来约 7.5 秒放回 |
| 全部场景 | 目标收到入口机 / 中转机直连的连接：0 条 |

跑出来并修掉的：固定节拍下「持续够久」门槛不留余量（黑洞 7 秒才摘）；线路组的 rendezvous 哈希在出口组上几乎全压到份数最大的一台（出口组改用加终混、按主机号的哈希；`route_group_balance.go` 里那个哈希在「同一个落地经不同中转」的线路组上有同样的偏，待改）；上报的 share 在代理重建后基准不对。

遗留：多跳链路上入口探不到出口机，没有 TCP 流量（空闲、只转 UDP 的规则）时出口死了要等面板提示；出口进程卡死而链路是不加密的 tcp / mtcp 时判不出来；Nginx 隧道（见上）；入口组、共享 TLS 入站上的规则已经走本机代理但没有端到端验证过（共享 TLS 入站时访客地址是分流器的本机地址，按访客固定会全落一台）。
### 阶段 3（2026-11-19，DNS 层的组 + 评估引擎；要求 Agent 2.2.264）

| 范围 | 落点 |
|---|---|
| 外部观察（成员健康不再只听自己的 Agent） | 判定 `server/forwardGroups/evaluate.ts` 的 `decideExternalHealth`（纯函数）；观察结果表 `peerObservations.ts`；安排谁探谁 `topology.ts` 的 `planPeerObservers` + `forwardGroupRepository.ts` 的 `buildForwardGroupPeerTopology`；下发走原来的转发组探测（`forwardGroupProbes`，`probeType = "peer"`），Agent 只加了 `agent/forward_group_peer_probe.go`（间隔收紧、每分钟报全量） |
| P3 的入口组版：恢复后稳够久才加回、频繁进出暂缓、全挂保留整组、没有健康入口时直接加回 | `entryMemberInclusion` / `planEntryGroupRecordSet`（纯函数）+ `syncEntryGroupDefaultDdns`、`holdEntryGroupDdns` |
| P1 入口组权重 | `shared/ddnsWeights.ts`、`server/ddnsWeightedRecords.ts`（DNSPod 记录 Weight；阿里云 SetDNSSLBStatus + UpdateDNSSLBWeight；华为云记录集 weight）；Cloudflare / Webhook 界面置灰 |
| 面板重启 / 数据库恢复后第一个回来的成员抢解析 | `server/forwardGroups/readiness.ts` + `readinessGrace` + `holdForwardGroupForReadiness`；`databaseHealthState.ts` 加了恢复通知 |
| P7 评估串行、DNS 内联、每成员重复查库 | 评估作用域批量读（20 成员入口组 65 → 5 次查询，主备组 90 → 10 次）；要写服务商的组交给 `server/forwardGroups/publish.ts` 的按账号发布队列 |
| P8 每次心跳加载全部组拓扑 | `TopologyCache`（改组 / 成员 / 主机地址时作废，30 秒 TTL 兜底），按主机取 0 次查询（原来每次 3 次） |
| P16 节点池比组的上限大 | `server/nodePoolGroups.ts` 的 `assertPoolFitsFollowingGroups`（保存前拦），节点池卡片 `followerWarnings` |
| P12 线路的主机在线提示 | `server/routeNodeHealth.ts`：快速存活状态 + 读库失败保留上一份 |

没做 / 留给阶段 4：数据库租约（多实例只有一个跑评估和 DNS 写入，P15，已做，见阶段 4）；外部观察不覆盖落地池直连域名、共享 TLS 入站的规则、还没有规则在用的主备组；分线路记录不带权重；没有快速存活状态的主机（从没连过面板的）仍走按库里心跳算在线的老分支。

### 阶段 2 · 挑选算法统一 + FXP 遗留项（2026-11-19）

**一份算法**：仓库根目录新增 Go 模块 `lbcore/`（没有第三方依赖，纯函数 / 小结构体，不做 I/O、不拿锁、不读时钟）。线路组（`agent/route_group_balance.go`、`failover_pick_strategies.go`、`route_group_line_spread.go`、`failover_pick_candidates.go`、`failover_selection.go` 的抖动抑制）和 NEX 出口选择器（`forwardx-fxp/exit_select.go`，原来散在 `main.go` / `exit_load.go` / `target_health.go` 里的那一份删了）都从 `lbcore.Pick` 进。两个 `go.mod` 用 `replace … => ../lbcore`。每个算法做什么、为什么选它、参数和默认值写在 `lbcore` 各文件开头，总览在 `lbcore/doc.go`。

| 分配方式 | 算法（两边一样） |
|---|---|
| 自动 | P2C + peak EWMA：成本 = (延迟 + 抖动) × (1 + 10×丢包) × (1 + 10×拨号失败率) × (在途 + 活动 + 1) ÷ (分量 × 慢启动 × (1 − 利用率，最多按 95%))；候选 ≤ 3 全算，> 3 抽两个比 |
| 按负载 | 同一个成本只留负载那一半 |
| 延迟优先 | 先圈出和最快的差不到门槛（50ms）的一组（进组至少留 1 分钟），组里用自动的成本 |
| 按权重 / 轮流 / 随机 | 平滑加权轮询、轮流、随机；都随机起步，刚恢复的 60 秒内从 10% 加到满份 |
| 按访客固定 | 加权 rendezvous（FNV-1a 后再搅一遍），不设负载上限（原来带 1.25 倍的有界负载，端到端里一个访客连 4 次就换了出口，2026-11-19 去掉）；不知道访客是谁时按轮流 |
| 主备 | 稳的 → 不稳 / 刚恢复的 → 到目标不通的 → 连不上但冷却到期的 → 还在冷却的 |

候选（`lbcore.Candidates`）：连不上的只要还有别的就不挑；软信号（不稳按「切走」、UDP 没验证过）最多摘一半、至少留一个；正常的一个都不剩就在所有连得上的里分，再不行在所有没被排除的里分；管理上排除的永远不挑。抖动抑制两边是同一个 `FlapDamper`（参数不同）。

一致性用例 `lbcore/testdata/conformance/*.json`（42 个；其中 6 个用到线路组没有的信号 —— 不稳、下游不通、冷却 —— 只给 lbcore 和 FXP 跑）三处各跑一遍：`lbcore`、`agent/lbcore_conformance_test.go`（拿 `pickTargetForKeyProto` / `pickReserved`）、`forwardx-fxp/lbcore_conformance_test.go`（拿 `selector.pick`）。

**FXP 遗留项**（实测见 `forwardx-fxp/lb_stage2_test.go`，「之前」是同一批用例在阶段 1 的代码上跑出来的）：

| 项 | 之前 | 之后 |
|---|---|---|
| UDP 会话所在的出口变黑洞，访客的包换到另一台 | 整台出口黑洞约 16 秒（实验室）；TCP+UDP 规则只有 UDP 被拦时 60 秒也不换（只跑 TCP 探测） | 2.2 秒（会话没回包 + 一轮探活没回）；出口 2.5～3 秒判成 UDP 不通 |
| 同一规则 TCP+UDP、只有 UDP 被拦 | 发现不了 | UDP 那一侧单独记：UDP 新会话换出口，TCP 照常用它 |
| V3 等「连上目标没有」 | 没有截止时间，一直等 | 逻辑流自己的读超时（6 秒），超时换出口重放 |
| 一台出口黑洞后开 30 条 TCP | V1 0 失败；V3 不复用 2 条失败；V3 复用 10 条失败 | 三种都是 0 失败，第一条等 6 秒，其余立刻 |
| 出口恢复后重新认回来（轮流 / 自动） | 12 秒起（黑洞越久退避越长，最长 2 分钟） | 4 秒（连着 3 次探通、间隔 2 秒）；UDP 那一侧 5 秒；来回断的由抖动抑制压着 |
| `TestMultipathEntryToExitHandlesManyConcurrentSessions` 偶发红 | 测试端口在临时端口范围里，关掉到重新监听之间会被往外拨的连接抢走 / 自连 | 测试端口从临时端口范围之外挑 |

不回 UDP 探活包的对端（版本过旧 / UDP 一直不通）不再悄悄退回去探 TCP 端口：打一条日志，出口状态上报里带 `udpState: "unverified"`、`peerOutdated: true`，UDP 新会话优先给验证过的出口。

还没做的：GOST 出口组交给入口 Agent；线路评分（0–100）仍然是主备「整链最优」比分差的依据，和 `lbcore` 的成本用同一批探测结果但不是同一个数（要统一得连 `shared/routeScore.ts` 一起改）。

### 阶段 2 收尾 · 一个决策公式（2026-11-19）

规格按代码写在 `docs/dev/scheduler-spec.md`（每个数带出处）。

| 项 | 落点 |
|---|---|
| 主备择优不再比 0–100 分 | `lbcore/switch.go`（`QualityCost`、`SwitchPolicy`、`Challenger`、`DisplayScore`）；`agent/failover_selection.go` 的 `fastestIndexLocked`；同出口 IP 的平手也按成本 + 门槛（`failover_exit_ip.go`）。门槛就是延迟优先的「一样快」（50ms，规格 `latencyMarginMs`）+ 低两成；分数只给人看。规格去掉 `scoreMargin`（面板的编辑框、下发、漂移比对、Agent 规格都删了；库里 `routeScoreMargin` 列不再读写） |
| GOST 出口组的延迟优先 | 不再借「主备 + 择优」，直接按 lbcore 的延迟优先分，门槛来自「检测与切换」 |
| 线路组能选延迟优先 | `shared/routeGroupModel.ts` 的 `ROUTE_SPREADS` |
| FXP 的 `udpState` / `peerOutdated` | `server/balanceLive.ts` → `exitTargetHealth.ts` 的每台出口摘要 → 负载均衡弹窗（`client/src/lib/tunnelDisplay.ts` 的 `exitUdpText`） |
| 老值 / 重复 | `shared/exitStrategy.ts` 并进 `shared/loadBalance.ts`；`none` 只在 `normalizeBalanceStrategy` 认成主备，16 处「只用第一个出口」分支删掉；策略说明只留 `BALANCE_STRATEGY_LABELS` 一份 |
| 共享 TLS 入站 + 按访客固定（GOST） | SNI 分流器给这种规则发 PROXY v2（`server/tlsInboundRuntime.ts` 的 `visitorHeaderRuleIds`），规则的回环 gost 监听收下（`agentHeartbeatGostPlan.ts`），访客地址一路传到本机代理 |
| tcp / mtcp 出口进程卡死 | 直接探出口机时发一个坏请求等 gost 断开（`agent/failover_exit_group.go` 的 `failoverProbeRelay`，规格 `probeRelay`） |
| 多跳 GOST 空闲 / 只转 UDP | 没做，缺的东西写在规格 §10 |
### 阶段 4 · 控制面：后台任务租约、拆仓库、去掉老的在线判断（2026-11-19）

| 范围 | 落点 |
|---|---|
| P15 多实例：只有一个实例跑后台任务 | `server/panelLease.ts`：表 `panel_leases`（name 上一个唯一索引、holder、expiresAt、updatedAt，毫秒，按数据库的时钟）。带条件的 UPDATE（自己拿着或已过期，过期按库的时钟判断）+ 唯一索引冲突即放弃的 INSERT，三种库上原子；TTL 30 秒、约每 10 秒续（慢的续约之后按有效期提前续，有效期到点马上报丢失），持有者只信到「续约开始 + TTL − 5 秒」，续不上先自己停手；正常退出放掉；接手最迟 TTL + 一个续约间隔（40 秒）。每个实例另续一行 `instance:<id>` 作登记。哪些任务只由持有者跑的表在文件开头 |
| 定时任务 | `scheduler.ts` 里写共享状态的任务都带 `shouldRun: leaseHolderOnly`（`scheduledTask.ts` 原有的放行条件）；状态页采样、异地备份、解锁排期、用户流量日历史、流量异常检测、Telegram 轮询同样；自测超时清扫（逐行条件更新）、更新检查、连接池、SQLite optimize 每个实例照跑 |
| 非持有者上的评估 | `server/panelWorkRequests.ts`：表 `panel_work_requests`，非持有者写「哪个组、带什么选项」、收到的外部观察结果（同一件事只留一行，时刻按库的时钟），持有者每 2 秒先认领、处理成功后按 requestedAt 条件删，失败按 2 秒起翻倍（最多 1 分钟）退避重试，放了 10 分钟没跑成的丢掉；`forwardGroups/evaluateDriver.ts` 的 `runForwardGroupFailoverByIds` 在非持有者上直接转过去，发布队列跑之前丢了租约的同样 |
| 在线状态跨实例 | 非持有者不把主机写成离线、不发上下线通知（`hostStatusNotifier.ts`）；有别的实例时 `server/agentPresenceElsewhere.ts` 每 10 秒读 `hosts.lastHeartbeat`（连着 Agent 的实例约每 90 秒写一次），`agentFastLiveness.ts` 只认比本进程看到的更晚的时刻：沉默期限按库里的时刻放宽到 200 秒，判了离线后库里出现更晚的时刻就当它回来了。Agent 连在本实例上时仍是 90 秒 |
| 落地池直连域名 | 只由持有者写（`landingPools.ts` 的 `refreshLandingDns`），非持有者保存池时不写，持有者一分钟一轮补上 |
| 接手 | 中途拿到租约时给转发组一段就绪宽限（上一任内存里的存活状态带不过来）并补一轮巡检 |
| 看得到 | `/api/database-health` 带 `backgroundTasks`；系统设置 → 面板日志一行「后台任务由本实例执行 / 由另一实例 xxx 执行」 |
| 拆 `forwardGroupRepository.ts`（7535 → 1460 行，不改行为） | `server/forwardGroups/`：`evaluateDriver.ts`、`evaluateScope.ts`、`liveness.ts`（评估）、`ddnsPublish.ts`、`ddnsEntryGroup.ts`（记录写入 / 入口组记录集合）、`health.ts`（健康上报）、`probeTopology.ts`（探测拓扑）、`ruleSync.ts`、`runtime.ts`、`portPolicy.ts`（子规则 / 运行时 / 端口）、`common.ts`（共用）。`server/db.ts` 按名字再导出原来的公开函数 |
| 老的在线判断分支 | `forwardGroups/liveness.ts` 只认快速存活状态，没有的算离线（不再按库里心跳另算 150 秒）；预热完成前就绪宽限里挂起评估 |

验证：tsc、lint（no-explicit-any 7203 → 7202）、`pnpm test:all`；租约在 SQLite（同一进程两个实例：只有一个跑巡检、非持有者的评估交给持有者、接手在 40 秒内、DNS 不重复写）、PostgreSQL 16、MariaDB 10.11（`panelLease.external.test.ts`，并发 8 个抢同一个租约只有 1 个成功、过期后并发接手也只有 1 个）上跑过。

限制：SQLite 部署不支持多实例（租约照常续）。各实例时钟要同步（NTP），偏差吃掉 5 秒余量。Agent 推送（`pushAgentRefresh`）、稳定心跳计划缓存、外部观察结果表都还在进程内：改了配置，连在别的实例上的 Agent 最迟在下一次完整对账（约 5 分钟）拿到；观察点连在非持有实例上时，它的观察结果持有者看不到。非持有者上点「立即同步」立刻返回，结果几秒后在界面上刷新出来。

### 验收（2026-11-19，面板 2.3.540 / Agent 2.2.264 / FXP 2.2.147 / gost nex6，全部合并后的构建）

本机网络命名空间实验室（1 入口 + 3 出口 + 1 中转 + 目标 + 访客，真实 Agent / FXP / gost，`scenarios.sh 1–5`）：

| 场景 | 结果 |
|---|---|
| 三台出口全黑洞，GOST / V1 / V3 各开 12 条 TCP | 36 条全部失败、都在 1 秒内；0 条由入口直连目标 |
| 紧接着只黑洞 exit2，各开 30 条 TCP | GOST 16/14、V1 15/15、V3 16/14（exit1/exit3），0 失败 |
| exit2 恢复后重新分到它（单独计时） | GOST 9.8 秒、V1 3.1 秒；同一台一小时内断过 4 次起由抖动抑制压着（30 秒起翻倍），实验室反复注入后 V1 等了 60–120 秒，是设计如此 |
| UDP 会话所在出口黑洞 | V1、V3 约 2 秒、GOST 约 4 秒后同一会话换到另一台继续回包 |
| 线路组 UDP 会话所在中转黑洞 | 约 3 秒换到直连线路 |
| 目标本身挂了 | 每条连接几十毫秒内失败，不挨个出口重试 |
| 平时分配（轮流，三台各 10 条） | 10/10/10 |

验收中发现并修掉的：几台出口一起断过以后，面板拿出口在退避期间报的旧「连不上目标」把好着的出口摘掉（exit3 在 exit2 单独断时 0 条），恢复的出口要等 25–30 秒才放回。修法：Agent 到目标的探测只在目标主动拒绝（RST）时退避到 60 秒，超时 / 不可达最多两倍节拍（`agent/route_hop_probe.go` 的 `routeHopDialRejected`），上报带 `ageMs` / `intervalMs`；面板不用旧的「连不上」摘出口（`server/exitTargetHealth.ts` 的 `exitTargetDownStale`：早于「全部出口都连不上」结束、或超过两倍上报间隔 + 40 秒的算未知）；摘掉后第一次恢复立即推送，30 秒的防反复只对 30 秒内又断的生效。

最终检查：tsc、lint（基线内）、`pnpm test:all` 4760 项（4753 过 / 0 失败 / 7 跳过）、lbcore / Agent / FXP `go test ./...` 与 `-race`、`gost-runtime/test/balance-proxy/run.sh` 全部场景通过（连跑两遍）。

没做：全部出口恢复时让其他出口立即重探（目前靠各自下一次探测，超时类约 4 秒、被拒类最长约 60 秒，期间入口的「没回就换」兜着）。

### 2.3.541 跟进（2026-11-20，Agent 2.2.265 / FXP 2.2.148）

用户实机（NEX 隧道 3 出口、延迟优先、目标为高防）反馈「每台机器都正常，一台出口却一直显示连不上目标」，顺着查出来并修掉的：

| 项 | 落点 |
|---|---|
| 经出口判坏的出口靠真实连接试探放回（不说话的恢复探测对高防不可靠：对某台出口 IP 的「连上不说话」连接关得特别快，永远探不通） | `agent/failover_exit_group.go` 的 `exitCanaryIndexLocked` / `exitCanaryRepliedLocked`（`pickReserved` 里只在新连接第一次挑），面板提示「连不上目标」的出口同样试，提示带 `downAt`（`server/gostBalancePlan.ts`），试探放回后同一份提示不按下去 |
| 探出口机和探目标分成两个节拍 | `BalanceDetect.targetProbeSeconds`（灵敏 5 / 均衡 10 / 稳定 30 秒，2–300 可填）；面板 `exitTargetProbeSpec`、FXP `targetProbeInterval`；Agent 退避上限 `max(60 s, 节拍)`，Passive 规格间隔上限 300 s；界面 `SecondsPicker` |
| 出口到目标的延迟缺了按 0 算（延迟优先 / 自动偏向信息最少的那台） | 提示 `extraLatencyUnknown`，Agent 按这条规则已知的最大值算（`extraLatencyLocked`），上报 `targetLatencyUnknown` |
| 规则卡延迟一个口径（扛流量最多那台的整链延迟，两段分开报） | `agent/balance_report.go` 报 `exitMs` / `targetMs`（平滑值）、`server/exitTargetHealth.ts` 的 `liveCarryingExit` / `latestLatencyLive`、规则卡提示 |
| 诊断把「隧道到主出口」的旧样本和「在用出口到目标」拼成一条链 | `server/selfTestViaExit.ts`：从在用出口测时入口段用入口实时报的 `exitMs`，节点名按它写 |

实验室（`scenarios.sh 1–5` + `fixhints/readmit.sh` + 高防场景）：

| 场景 | 结果 |
|---|---|
| 目标只把 exit2 的「连上不说话」连接 1 秒就关 | 修前：exit2 4 秒内判「到目标不行」，2 分钟不放回；修后：判坏后第一条正常连接（7 秒）放回，之后三台一起分 |
| 三台出口全黑洞 | 36 条全部失败、0 条绕过 |
| 只黑洞 exit2，各 30 条 | GOST 16/14、V1 16/14、V3 15/15，0 失败 |
| exit2 恢复后放回（单独计时） | GOST 6.0 秒（探目标节奏放慢后一度 36 秒，靠真实连接覆盖面板提示修回），V1 4.7 秒 |
| UDP 会话所在出口 / 中转黑洞 | V1、V3 约 2 秒、GOST 约 4 秒换出口；线路组约 3 秒换路 |
| 目标本身挂了 | 每条连接几十毫秒内失败 |

检查：tsc、lint、`pnpm test:all` 4768 项 0 失败、Agent / FXP / lbcore `go test ./...` 与 `-race`、`gost-runtime/test/balance-proxy/run.sh` 全过（含新加的高防场景）。
