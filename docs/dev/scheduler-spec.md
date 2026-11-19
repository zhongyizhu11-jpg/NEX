# 调度规格（按代码写）

负载均衡整治（`docs/dev/load-balancing-roadmap.md`）之后的现状：谁在哪一层做什么决定、用什么算法、数是多少。
数字都引自代码（`文件:行`，以本文提交时为准），改了常数请同步改这里。算法本身的「为什么」写在各文件开头，
这里只写「是什么」。

## 1. 分层：谁决定什么

| 层 | 决定什么 | 谁决定、在哪 | 切换的颗粒 |
|---|---|---|---|
| 入口 DNS 组（转发组 / 入口组） | 域名解析到哪几台入口 | 面板的评估引擎：成员自报 + 外部观察（`server/forwardGroups/evaluate.ts` 的 `decideExternalHealth`、`entryMemberInclusion`、`planEntryGroupRecordSet`），写解析走按账号的发布队列（`server/forwardGroups/publish.ts`） | 新解析；已经解析到的客户端等 TTL |
| 线路组（规则的几条路径） | 一条新连接 / 新 UDP 会话走哪条路径 | 入口机 Agent 的本机代理 `failoverProxy`（`agent/failover_pick*.go`、`failover_selection.go`、`route_group_balance.go`） | 每条新连接 / 新会话 |
| 隧道出口组（一条隧道的几台出口） | 一条新连接 / 新 UDP 会话走哪台出口 | NEX 隧道：入口机的 FXP（`forwardx-fxp/exit_select.go`）；GOST 隧道：入口机 Agent 的本机代理，和线路组同一个 `failoverProxy`（`agent/failover_exit_group.go`，规格由 `server/gostBalancePlan.ts` 生成）；Nginx 隧道：入口机 nginx 的 upstream（基础支持，见 §6.4） | 每条新连接 / 新会话 |
| 会话表 | 已经开始的连接 / 会话留在哪 | 同上各自的运行时。TCP 连接挑定以后不搬（线路组的「快速 / 强制切换」只是在切换时断开旧连接让客户端重连）；UDP 会话见 §7 | — |

面板在这三层之下只做三件事：生成规格（下发）、把别处探到的情况作为提示（hint）带给入口（下游不通、下游延迟、
沿途主机负载、出口到目标不通）、收入口报上来的真实状态给人看（`server/balanceLive.ts`、`agent/balance_report.go`、
`forwardx-fxp/balance_report.go`）。**面板不替入口挑**：以前给 gost 排节点顺序、摘节点的那一套已经删了。

## 2. lbcore：唯一一份挑选算法

`lbcore/`（Go 模块，零依赖，纯函数，不读时钟）。线路组、GOST 出口组（同一个 `failoverProxy`）和 NEX 出口组（FXP）都从
`lbcore.Pick`（`lbcore/strategy.go:81`）进，主备用 `lbcore.First`（`lbcore/tier.go:166`），主备里的择优用
`lbcore.SwitchPolicy`（`lbcore/switch.go`）。三处由同一批一致性用例卡住：`lbcore/testdata/conformance/*.json`，
`lbcore/conformance_test.go`、`agent/lbcore_conformance_test.go`、`forwardx-fxp/lbcore_conformance_test.go`。

| API | 用途 |
|---|---|
| `Member{Weight, Share, Active, InFlight, Quality}`（`member.go`） | 一个候选此刻的样子，调用方每次填 |
| `Quality{Latency, Jitter, Loss, Success, Utilisation}` | 「有多好」的唯一定义；0 = 不知道，按中性处理 |
| `Candidates(dst, health, skip, EjectPolicy)`（`tier.go:76`） | 在哪些成员里挑（§4） |
| `First(health, skip)`（`tier.go:166`） | 主备挑第一个 |
| `Pick(strategy, State, members, keys, candidates, key, now, rnd, Options)` | 七种「分」的方式 |
| `QualityCost`、`SwitchPolicy.Better / HoldFor`、`Challenger`（`switch.go`） | 主备里「B 好到值得换过去吗」 |
| `DisplayScore`（`switch.go:129`） | 给人看的 0–100，从 `QualityCost` 换算，不参与决定 |
| `PeakEWMA`、`NearSet`（`latency.go`） | 自动用的延迟读数；延迟优先「一样快」的那一组 |
| `SlowStart`（`slowstart.go`）、`FlapDamper`（`flap.go`） | 慢启动；抖动抑制 |

成本（`load.go:47` `costOf`）：

    自动    成本 = (Latency + Jitter) × Penalty × (Active + InFlight + 1) ÷ (Weight × Share × Headroom)
    按负载  成本 =                        (Active + InFlight + 1) ÷ (Weight × Share × Headroom)
    质量    QualityCost = (Latency + Jitter) × Penalty ÷ Headroom              （主备择优、显示分）

    Penalty  = (1 + 10 × 丢包率) × (1 + 10 × 拨号失败率)      LossPenaltySlope = 10（member.go:45）
    Headroom = 1 − 利用率，利用率最多按 0.95               MaxUtilisation = 0.95（member.go:48）

不知道延迟的成员按候选里最快的算；`Weight` 全 ≤ 0 时一律当 1；`Share` 全 ≤ 0 时不看 `Share`（`member.go` 的 `modeOf`）。
候选 ≤ 3 个全算取最小（成本一样时从轮转起点往后数）；> 3 个按有效分量随机抽两个不同的比（`load.go:103`）。

## 3. 八种分配方式

名字在 `lbcore/strategy.go:21`，界面上的一句话在 `shared/loadBalance.ts` 的 `BALANCE_STRATEGY_LABELS`（唯一一份）。
库里老的 `none` / `least_conn` 只在 `normalizeBalanceStrategy`（`shared/loadBalance.ts`）认成主备 / 按负载。

| 方式 | 算法 | 参数 / 默认 | TCP | UDP |
|---|---|---|---|---|
| 自动 `auto` | `Auto`：上面的自动成本取最小，P2C | 延迟填 PeakEWMA 读数（时间常数 `DefaultPeakDecay` 10 s，`latency.go:30`） | 每条新连接挑 | 每个新会话挑 |
| 主备 `fallback` | 不走 `Pick`。线路组：`activeIndex` 状态机（§5）；FXP：每次 `First`；GOST 出口组：同线路组 | 切过去至少 `minHoldSeconds`（GOST 出口组 60 s，`BALANCE_MIN_HOLD_SECONDS`，`shared/loadBalance.ts:161`） | 新连接走在用的那条 | 同；TCP+UDP 规格的 UDP 那一侧另判 |
| 按访客固定 `ip_hash` | `Rendezvous`：加权 rendezvous（FNV-1a + 终混）+ 有界负载 | `DefaultHashLoadFactor` 1.25（`rendezvous.go:68`）；FXP 叠加连接按会话固定用不设上限的（`LoadFactor: -1`）；不乘慢启动；不知道访客时按轮流 | 访客 = PROXY 头里的地址（gost 先发的头；SNI 分流器在 GOST 负载均衡规则上发 v2 头，`server/tlsInboundRuntime.ts` 的 `visitorHeaderRuleIds`） | 访客 = 每个新会话第一个只有 v2 头的包（`agent/route_group_udp_visitor.go`）；FXP 用 UDP 访客地址包（类型 5，`forwardx-fxp/udp_ping.go:38`） |
| 延迟优先 `latency` | `NearSet.Select`（`latency.go:113`）圈出「一样快」的一组，组里 `Auto` | 门槛：线路组 `DefaultLatencyMargin` 50 ms（`latency.go:91`）；GOST / NEX 出口组用「检测与切换」里的 `latencyMarginMs`（默认 50）；进组至少留 `DefaultNearHold` 1 分钟（`latency.go:94`），出组不等；比的是普通平均延迟 + 抖动 | 同自动 | 同自动 |
| 按负载 `least_load` | `LeastLoad`：负载那一半成本，P2C | 线路组 `Utilisation` = 面板给的沿途主机负载；FXP `Utilisation` = 流量 ÷ 线路带宽（`exit_select.go:164`，只在配了线路带宽时），`Weight` = 线路带宽（有一台不知道就都一样大，`exitGroupCapacities`）；GOST `Weight` = 线路带宽份数（`exitGroupWeights`） | 在途 + 活动连接 | 活动会话一起算 |
| 按权重 `weighted` | `SmoothWRR.Pick`（`wrr.go:22`），随机起步 | 权重：线路组每条路径的权重；出口组手填份数，否则线路带宽 | | |
| 轮流 `round_robin` | `RoundRobin`（`wrr.go:123`），随机起步，刚恢复的按几成收 | | | |
| 随机 `random` | `Random`（`wrr.go:143`），按 `Share` 抽 | | | |

慢启动（除按访客固定、主备外都乘）：`DefaultSlowStart` 60 s，从 10% 线性到满份（`slowstart.go:20`）。

## 4. 候选分层、摘除上限、恐慌

`lbcore.Candidates`（`tier.go:76`）每次挑选前算：

1. 管理上排除的（暂停、维护）永远不挑。
2. 正常：连得上、下游也通的；带软信号的最多摘掉 `DefaultMaxSoftEject` = 一半（向下取整，至少留一个，`tier.go:52`）。
3. 恐慌：正常的一个都不剩（`PanicBelow` 默认 1）→ 在所有连得上的里分（带软信号的、下游不通的都算）。
4. 一个连得上的都没有 → 在所有没被排除的里分。

`First` 的先后：稳的 → 带软信号的 → 下游不通的 → 连不上但冷却到期的 → 还在冷却的；同一类按配置顺序。

各运行时填哪些信号：

| 信号 | 线路组 / GOST 出口组（Agent） | NEX 出口组（FXP，`exit_select.go:87` `healthLocked`） |
|---|---|---|
| Dead | 本机探测判坏（§6）、面板提示 `Down`、经出口复核判坏 | 出口本身连不上（握手 / 探测），UDP 会话看 UDP 那一侧 |
| DownstreamDown | —（面板的「出口到目标不通」直接当 `Down`） | 出口回报的「出口到目标不通」 |
| Soft | — | UDP 会话：从没回过 UDP 探活包的出口；主备：到目标不稳（动作不是「不管」）或到目标恢复不到 5 分钟（`fxpTargetFailbackStable`，`target_health.go:145`）；分着用：到目标不稳且动作是「切走」 |
| Cooling | — | 连不上、还在退避里 |

「不稳、动作是少分」不是软信号：它照常参与，`Share` × 0.25（`fxpTargetReducedShare`，`target_health.go:141`）；
自动 / 延迟优先不乘这一项（抖动丢包已经在成本里）。

## 5. 主备、切换、切回（线路组和 GOST 出口组的 `failoverProxy`）

`updateFallbackActiveAtLocked`（`agent/failover_selection.go:237`）每轮探测后跑：

- **在走的这条挂了**：按优先级换第一条能用的，**不受驻留和抖动抑制限制**；同样够格的候选里优先出口 IP 一样的
  （`escapePickLocked`，`failover_exit_ip.go:43`：同一层、`QualityCost` 和最低的差不到「一样快」的门槛）。
- **在走的这条好着**：首选来源依次是人工指定 → 时段表 → 择优（`fastestIndexLocked`）→ 数组顺序。
  - 切回（数组顺序）：要 `autoFailback`，要过 `holdingLocked`（`failover_selection.go:146`：最短驻留和抖动抑制取长），
    开了择优时同一层两条健康的之间不按顺序切回（`orderFailbackYieldsToScoreLocked`，`:328`）。
  - 时段表 / 切回前若配了预热，先预检（`precheckIssueLocked`：延迟 ≥ 400 ms 或丢包 ≥ 4% 不切，`route_group.go:30`）。
- **择优**（主备 + `preferFastest`，即「智能择优 / 混合策略」；`fastestIndexLocked`，`failover_selection.go:29`）：
  在健康的最优一层里挑 `QualityCost` 最低的候选 B，和在走的 A 比 —— `SwitchPolicy.Better`（`lbcore/switch.go:73`）：
  `A − B > 门槛`（`latencyMarginLocked`：规格 `latencyMarginMs`，线路组不带 → 50 ms）**且** `B ≤ A × 0.8`
  （`DefaultSwitchRatio`，`switch.go:41`）；同一个 B 要连着领先 `scoreHoldSeconds`（默认 180 s，`agent/main.go:1387`；
  智能择优模板 30 s，`shared/routeGroupPolicy.ts:92`）；B < A / 2 且差出 2 × 门槛时只等 10 s（`DefaultSwitchFastHold`，
  `switch.go:43`）。质量里的延迟是探测延迟的指数平均（α = 0.3，`route_group.go:257`）+ 面板给的下游延迟，抖动是探测窗口里
  「比最低高出多少」的 90 分位（≥ 10 个样本，`route_group_balance.go:120`），丢包是 10 分钟窗口，拨号成功率要 ≥ 5 次
  （`route_group_balance.go:165`），利用率是沿途最忙主机的负载。`TestFailoverPreferFastestDoesNotFightAutoFailback`
  （300 ms vs 30 ms 一小时只切一次）钉着。
- 给人看的分：`scoreLocked`（`agent/route_group.go:408`）= `DisplayScore(qualityLocked(…, false))`，40 ms 满分、400 ms 零分
  （`switch.go:146`）；探不通 0，没量过「等评分」。面板只显示（`shared/routeScore.ts` 的等级），不再自己算。

## 6. 健康信号和时间

### 6.1 档位（出口组 / 链路负载均衡的「检测与切换」）

`shared/loadBalance.ts`：均衡 = 默认（`:124`），灵敏 `:140`，稳定 `:150`。

| 档 | 间隔 | 几次不通算坏 | 恢复连续通 | 一样快门槛 | 抖动门槛 / 持续 | 界面「约 N 秒内切走」 = ⌈间隔 × (次数 + 0.5)⌉（`:211`） |
|---|---|---|---|---|---|---|
| 灵敏 | 1 s | 2 | 3 | 30 ms | 20 ms / 15 s | 3 s |
| 均衡 | 2 s | 2 | 3 | 50 ms | 30 ms / 30 s | 5 s |
| 稳定 | 5 s | 3 | 5 | 80 ms | 50 ms / 60 s | 18 s |

线路组没有这三档：用模式模板（`shared/routeGroupPolicy.ts:72`：连续 2 次、异常 3 秒切、恢复观察 300 s、最短驻留
600 s；智能择优驻留 60 s、择优持续 30 s），不套模板时 `ROUTE_GUARD_DEFAULTS`（`shared/routeGroupModel.ts:165`：3 次 / 60 s /
120 s / 驻留 0 / 择优持续 180 s）。

### 6.2 GOST 出口组（入口机 Agent）

规格：`gostBalanceProbeTiming`（`server/gostBalancePlan.ts:90`）—— 固定节拍每 `间隔` 一轮，探测超时 1000 ms（间隔 ≤ 2 s）
否则 2000 ms；`failoverSeconds = 间隔 × (次数 − 1)`，`recoverSeconds = 间隔 × (恢复次数 − 1)`；固定节拍下「持续够久」
留 15% 余量（`agent/failover_health.go:126`）。判坏 = 连续失败够次数 **且** 持续够久（`:212`）。

信号：
1. 直接探出口机的隧道监听（`probeExitGroupTargets`，`agent/failover_exit_group.go:188`）。tcp / mtcp 隧道带 `probeRelay`：
   连上后发 8 个 0 字节、等 gost 断开（`failoverProbeRelay`，`:229`），进程卡死也判得出来。多跳（`viaRelay`）不探，每轮算通。
2. 真实连接「本机 gost 端口拨通、出口一个字节没回就被关」→ 当场换下一台重发（`failover_early_close.go`），并经出口复核
   （等 4 s，`exitConfirmWindow`，`failover_exit_group.go:74`）：又被关就当场判坏，之后恢复要经出口探通（1.5 s 窗口，`:77`）。
3. 面板提示：出口机探规则目标的结果（`server/exitTargetHealth.ts` 的 `exitTargetExcludedHostIds`：有别的已知好的才摘）→ `Down`；
   出口到目标的中位数 → `ExtraLatencyMs`。

| 档 | 黑洞最坏摘掉 | 回来放回 | 实测（`gost-runtime/test/balance-proxy/run.sh`，路线图阶段 2） |
|---|---|---|---|
| 灵敏 | 间隔 + (次数 − 1) × 间隔 + 超时 ≈ 3 s | (恢复 − 1) × 间隔 ≈ 2 s（+ 不到一轮） | 3.3 s / 2.1 s |
| 均衡 | ≈ 5 s | ≈ 4 s（+ 不到一轮） | 5.0 s / 4.0 s |
| 稳定 | 5 + 10 + 2 ≈ 17 s | ≈ 20 s（+ 不到一轮） | — |

出口进程死掉（拒绝连接）：第一条撞上去的连接被换走并复核，约 0.1 s 摘掉。

### 6.3 线路组（入口机 Agent）

探测间隔 = `failoverSeconds ÷ 2`，夹在 1–5 s，±10% 抖动（`agent/failover_health.go:12`）。判坏：探测连续失败
≥ `failureThreshold` 且持续 ≥ `failoverSeconds`；或者真实拨号连续 `failureThreshold` 次各自独立的失败当场判坏
（`markDialFailure`，本机的 fd / 端口耗尽不算）。恢复：连着通满 `recoverSeconds`。中转挂了靠面板从中转机的探测下发 `Down`。
面板算的「N 秒内切走」：`routeSwitchWithinSeconds`（`shared/routeGroupPolicy.ts`）。样本窗口 120 个（10 分钟）、可用率 720 个
（`agent/route_group.go:41`）。

### 6.4 NEX 出口组（入口机 FXP）

- 出口本身：连续 `几次不通` 次失败（真实连接的握手失败也算）判死；被盯着的健康出口 10 s 内没有任何东西证明它活着就主动探
  一次（`fxpHealthyProbeEvery`，`forwardx-fxp/endpoint_pool.go:47`）；恢复要连着 `恢复连续通` 次、每次间隔一个 `间隔`
  （均衡 3 次 × 2 s ≈ 4 s）。隧道连接在池里、握手中、等出口回结果时设着 30 s 的 `TCP_USER_TIMEOUT`（对端黑洞就判死，
  `fxpTunnelUserTimeout`）；会话提交（入口）/ 目标或下一跳接上（出口、中转）之后清掉（`secureConn.commitSession`）——
  Linux 5.11 起零窗口探测也算进它，访客暂停不读超过 30 s 会被复位；跑起来的会话靠保活发现对端没了。
- 出口到目标：出口回报「连上目标没有」（入口当场换出口重放，`selected_transport.go`）；按「出口 + 目标」记最近 30 次
  （`fxpTargetWindow`，`target_health.go:140`）的延迟、抖动、丢包；丢包 ≥ 10% 或抖动超门槛并持续够久算不稳。
  入口等这一帧最多等 `fxpTargetStatusWait` = 出口拨目标的时限 4 s（`fxpTargetDialTimeoutDefault`，出口解析目标域名也算在里面，
  `exit_targets.go` 的 `dialExitTarget`）+ 2 s 余量（`fxpTargetProbeReplyGrace`），再加量到的到这台出口的握手耗时（指数平均，
  封顶 4 s，`targetStatusWaitFor`）；现拨的流水线连接从握手确认那一刻起至少再等 6 s。等不到：这条连接换下一台重放（见 §10），
  这台出口记一次「可疑」—— 和后台探测失败同一套计数，连着 `几次不通` 次才判坏，不当场判坏（结果帧可能只是晚到了）。
- UDP 那一侧：探活包（类型 3/4），有会话时 1 s 一轮、闲着 5 s（`fxpUDPProbeActiveEvery` / `fxpUDPProbeEvery`，`endpoint_pool.go`）。
  一轮最多等 1 s，这 1 s 里最多发 3 个包：每隔 1/3 s 没等到应答就再发一个，最后一个等到这一轮结束（`fxpUDPPingAttempts`、
  `fxpUDPPingWait`，`udp_ping.go`）；正常的出口第一个包就回了。一轮没回紧接着再来一轮，连着 `几次不通` 轮没回判 UDP 不通，
  判坏后每 `间隔` 一轮、连着 `恢复连续通` 轮回了才恢复（和 TCP 那一侧同一套计数，`sideHealth`，但各记各的）。地址和数据走同一套
  解析（`resolveHopAddress`）。从没回过的 30 s 再问、问过 2 轮还没回就报 `udpState: "unverified"`、`peerOutdated`；这种出口只在
  有别的验证过、UDP 通的出口时才算软信号（§4）。
- 实测（`forwardx-fxp/lb_stage2_test.go`，路线图阶段 2）：UDP 会话所在出口黑洞 → 2.2 s 换走；出口恢复 → 4 s 放回、UDP 5 s。

### 6.5 Nginx 隧道（基础支持）

`server/agentHeartbeatNginx.ts`：`zone` 共享状态；`max_fails=2 fail_timeout=10s`；多出口时 `proxy_connect_timeout 3s`
（`NGINX_MULTI_EXIT_CONNECT_TIMEOUT_SECONDS`，`:69`）、`proxy_next_upstream_tries` = 台数；主备用 backup 权重 10000 / 100 / 1；
按负载、自动、延迟优先都是 `least_conn` + 带宽权重；按访客固定 `hash $remote_addr consistent`；随机 `random`。
只看出口机连不连得上；检测档位、手动指定不起作用（`nginxBalanceBasicSupportNote`）。

### 6.6 DNS 组

成员健康 = 成员自报 + 外部观察（至少 2 个观察点持续「异常多久切」连不上才判不可用，`decideExternalHealth`）；观察结果
150 s 过期（`PEER_OBSERVATION_TTL_MS`，`server/forwardGroups/peerObservations.ts:12`）；面板刚启动 / 数据库刚恢复有就绪宽限
（`readiness.ts`）；一小时切 3 次起暂缓 5 分钟、翻倍、最多 1 小时（`server/forwardGroupFlapHold.ts:13`）。转发组只能主备
（DNS 指向当前一台）；入口组按权重解析写服务商的记录权重（`server/ddnsWeightedRecords.ts`）。

## 7. 会话表

- Agent UDP 会话：一个访客端口一个会话；空闲 2 分钟回收（`failoverUDPIdleTimeout`，`agent/route_group_udp.go:41`），上限 4096；
  一条路径 / 出口判坏的那一刻它上面的 UDP 会话全部关掉，下一个包重挑（`route_group_path_down.go`）；之后还落在坏路径上的：
  发了 ≥ 8 个包、≥ 10 s 没回包、且路径 UDP 那一侧此刻是坏的 → 丢掉重挑（`:83`）。
- FXP UDP 会话（`udp_direct.go`）：入口在访客的下一个包到来时看一眼（每条会话最多每 250 ms 看一次，`fxpUDPRepickCheckEvery`），
  只在还有别的 UDP 连得上的出口时换；换 = 关掉旧会话、当场按同样的规则重挑一台（先不考虑旧出口，别的都不行才再用它），
  建一条新会话（新会话号；访客那边的套接字不变）：
  1. 出口 UDP 那一侧被判成不通了（`repickReason` 的 `exit unhealthy`）；
  2. 出口回过探活包：上一次回包之后访客连着发了 ≥ 4 个包、过了 ≥ 2 s 一个回包都没有（`fxpUDPSilentMinDatagrams` /
     `fxpUDPSilentMinAge`），**而且**这期间有一轮探活没回、一次应答都没收到（`no replies`）。这期间探活回过就不换（应用协议本来就单向）；
  3. 出口从没回过探活包（没法验证）：从头到尾没收到过回包、发了 ≥ 8 个、建了 ≥ 5 s、最近 25 s 没有别的东西证明它活着
     （`fxpUDPRepickMinDatagrams` / `fxpUDPRepickMinAge` / `fxpUDPRepickConfirmedWithin`），只换一次。
  中转（`serveRelayUDPDirect`）只按第 1 条换下一跳（`exitUnhealthy`；会话号是入口定的，不变，挑选键沿用上一跳告诉的访客地址）。
- TCP：挑定不搬。线路组「快速切换」在故障切换时断旧连接、「强制」每次切换都断（`switchMode`）；GOST / NEX 出口组的 TCP 不断。

## 8. 抖动抑制（`lbcore.FlapDamper`）

| 谁 | 记什么 | 窗口 / 门槛 / 驻留 | 出处 |
|---|---|---|---|
| 线路组、GOST 出口组 | 自动切换（人工指定、演练、开机 90 s 预热期内的不记） | 1 h 内第 3 次起压 5 min，每多一次翻倍，最多 1 h；挂了逃生不受限 | `agent/failover_selection.go:103-120` |
| FXP 出口本身 | 断开（TCP 那一侧、UDP 那一侧各记各的：一次两侧一起断的中断每侧各记一次，不是两次） | 每一侧 1 h 内第 4 次断开起，下一次恢复要从断开算坏满 30 s，翻倍，最多 5 min | `forwardx-fxp/endpoint_pool.go` 的 `fxpEndpointFlapPolicy`、`sideHealth` |
| FXP 出口到目标 | 中断（好 → 坏） | 1 h 内第 4 次起，恢复要坏满 5 min（不翻倍） | `forwardx-fxp/target_health.go:295` |
| DNS 组 | 自动切换 / 拿掉加回 | 1 h 内 3 次起 5 min，翻倍，最多 1 h | `server/forwardGroupFlapHold.ts:13` |

## 9. 版本门槛

只有一处：`UNIFIED_BALANCE_AGENT_VERSION = "2.2.264"`（`shared/loadBalance.ts:278`），判断只用 `agentSupportsUnifiedBalance`（`:281`）。
入口机 Agent 更老时 GOST 链路只下发主出口一台、标「需要升级 Agent」（`server/tunnelBalanceAgent.ts`）。没有老路可退。
FXP 另有两个功能门槛（出口回报目标 `FXP_TARGET_AWARE_VERSION` 2.2.142、入口上报真实状态 `FXP_BALANCE_REPORT_VERSION` 2.2.145，
`shared/loadBalance.ts:263-266`），只决定那两个功能开不开。

## 10. 明确不支持 / 已知局限

- **多跳 GOST 链路上空闲或只转 UDP 的规则**：入口探不到中转后面的出口机，出口死了要等面板提示（出口机自己探目标，出口机
  整台死了靠主机离线）。要做到 ≤ 10 s：让最后一跳中转按出口组节拍探它链到的每台出口（现在的 `tunnelProbes` 只探主出口、
  节拍是延迟图用的），结果走一条「一变就报」的上报（像转发组外部观察 `forward_group_peer_probe.go` 那样带 `healthStatus`），
  面板收到后并进 `exitTargetExcludedHostIds` 并 `pushAgentRefresh` 给入口。需要新的探测种类（Agent 的 tcping 任务现在只对
  `kind = forwardGroup` 做「一变就报」）和面板的存储 / 下发，阶段 4 做。
- tls / wss 隧道出口进程卡死：直接探测只看 TCP 连得上；真实连接 3 s 握手超时后按「没回就被关」换走并复核。
- GOST 出口组不用「抖动」三项（抖动门槛、持续、动作）：抖动、丢包算在自动 / 延迟优先的成本里；出口到目标只有中位数延迟
  （`ExtraLatencyMs`）进成本，抖动丢包没有。
- 线路组没有灵敏 / 均衡 / 稳定三档，用模式模板；线路组的延迟优先门槛固定 50 ms。
- Nginx 隧道只有基础支持（§6.5）。
- 0–100 分只给人看，不参与任何决定。
- 一条 TCP 连接不会在途中换路径 / 出口（FXP 在目标回报之前的重放除外）。
- **FXP 等不到「连上目标没有」时的重放不保证至多一次**：只有出口一个字节都没回过才重放，可出口也许已经连上目标、把发过去的
  首包转出去了，只是结果帧丢了或者晚过了等待（§6.4）。这时目标会从另一台出口再收到一份同样的开头。出口回「连不上」、
  握手没确认这两种情况内容没到过目标，重放是安全的。
- DNS 组：只有主备（转发组）和按权重解析（入口组，服务商支持时）；外部观察不覆盖落地池直连域名、共享 TLS 入站的规则、
  还没有规则在用的主备组；多面板实例时没有租约（路线图 P15）。
