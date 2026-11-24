# 控制面压测（2026-11-24）

用 `scripts/bench/heartbeat-load.mjs` 模拟真实 Agent（协议、节奏、加密信封、SSE 都照 Go 代码），打一个本机 SQLite 面板。机器 4 核，面板和模拟器同机，CPU 数字按「占一个核的百分比」看。

## 一、结果

| | 100 台 / 2000 规则（5 分钟，统计后 4 分钟） | 300 台 / 6000 规则（6 分钟，统计后 4.5 分钟） |
|---|---|---|
| 面板 CPU（一个核） | 15.5% | 24% |
| 内存 RSS | 286 MB（峰值 368） | 554 MB（峰值 560） |
| 事件循环延迟 p50 / p99 / 最大 | 10 / 14 / 42 ms | 10 / 15 / 122 ms |
| 心跳 p50 / p95 | 20 / 56 ms | 21 / 52 ms |
| presence p50 / p99 | 2.7 / 9.9 ms（21/s） | 1.9 / 16.8 ms（63/s） |
| 流量上报 p50 / p99 | 5.8 / 21 ms | 4.8 / 25 ms |
| 库读 / 写语句 | 43 / 24 每秒 | 148 / 71 每秒 |
| 库耗时 | 6.8 ms 每秒 | 20 ms 每秒 |
| 进程磁盘写入 | 1.9～2.4 GB/小时 | 6.8 GB/小时 |
| 库文件增长 | 25 MB/小时 | — |

CPU、延迟、内存按主机数接近线性，100 → 300 台 CPU 只从 15% 到 24%；按这个曲线一个核能撑到千台量级，内存约每台 1 MB。错误 0。

## 二、CPU 都花在哪（100 台，cpu-prof，忙时 33 秒 / 300 秒）

| 占忙时 | 位置 |
|---|---|
| 15～20% | drizzle 拼 SQL（`is`、`buildQueryFromSourceParams`、`sql`、`buildSelection`） |
| 9% | SQLite 语句包装（`createSqliteDrizzleDatabase` 回调、预编译缓存、计时） |
| 8% | GC |
| 5% | Agent 信封加解密（AES-CTR + HMAC，`encryptPayload`、`agentEncryptionMiddleware`） |
| 其余 | express 路由、JSON 序列化 |

最频繁的一条 SQL 是 presence 每次查一行主机（`select ... from hosts where id = ? limit ?`，21 次 / 秒）。CPU 整体不紧张，这里没动。

## 三、磁盘写入：找到一处，改了默认值

写入量和写语句数（24 / 秒）相比明显偏大：流量上报每份报告在一个事务里改十来张表（`traffic_stats`、`traffic_stat_buckets`、各类 counters），每条写都要把整页（4 KB）写进 WAL；WAL 每 1000 页（4 MB）就做一次检查点，把同一批被反复改写的计数页再复制回主库一次。

A/B（100 台，3 分钟窗口，各跑一次；默认值跑了两次）：

| wal_autocheckpoint | 进程磁盘写入 | CPU |
|---|---|---|
| 1000 页（SQLite 默认） | 2427 / 1984 MB/小时 | 9.3% / 8.4% |
| 10000 页 | 1647 MB/小时 | 7.2% |

默认值改成 10000（WAL 最多约 40 MB），`FORWARDX_SQLITE_WAL_AUTOCHECKPOINT` 可调。剩下的写入主要是每份报告自己的页写入；要再降只能把多台主机的报告攒成一个事务写（同一页只写一次），牵涉流量计费的用户行锁，这一轮没动。

## 四、一处不一致，记着

perf 采样里 `eventLoopUtilization` 读数 0.66～0.68，但 CPU 只有 15～24%，cpu-prof 也只算出 11% 忙时。ELU 的「活跃」包括事件循环有待处理任务时的轮询时间，更像是有定时器一直醒着而不是在干活；没有找到 250 ms 以下的 setInterval。暂时按 CPU 和剖析数据为准，ELU 不作结论。

## 五、还能做的

1. 流量上报跨主机攒批写（见三），预计再降一半磁盘写入，要先理清 `withTrafficAccountingUserLocks` 的锁顺序。
2. presence 那条热 SQL 换成预编译的裸语句，省掉 drizzle 拼接（CPU 里 drizzle 占 15～20%）。
3. 千台规模再压一次，看内存和心跳 p99 的拐点。

量法：`node --import tsx scripts/bench/heartbeat-load.mjs provision --hosts N --rules 20 ...`，面板带 `FORWARDX_PERF_SAMPLE_FILE` 和 `node --cpu-prof` 起，`run --duration 300 --warmup 60`，`profile-top` 看剖析。
