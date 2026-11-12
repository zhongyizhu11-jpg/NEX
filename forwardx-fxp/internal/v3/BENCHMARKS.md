# NEX V3 性能对比

基线是**移植原样**：提交 18ebfe861 的 FXP（它和移植提交 7d2460ce9 相比，FXP 只改了版本号和
「改 V3 外层选项不重启 UDP 直连监听」，数据面一个字节没动，基本就是上游的实现）。优化后是本分支
的 FXP。两边跑的是同一份 `forwardx-fxp/bench_v3_test.go`（只用 config 字段起隧道，原样拷到基线
提交上就能跑）。

## 怎么跑

```sh
cd forwardx-fxp
# 回环吞吐：三种外层 × 复用开 / 关，和 V1 对照
go test -run '^$' -bench 'BenchmarkV3Bulk$' -benchtime 300x -count 3 .
# 带往返延迟（延迟代理 50ms / 200ms）、短连接、首连；每个子项跑 V3BENCH_SECONDS 秒（默认 4）
go test -run '^$' -bench 'BenchmarkV3(BulkRTT|ConnRate)' -benchtime 1x -count 2 .
go test -run '^$' -bench 'BenchmarkV3FirstConn' -benchtime 5x .
# V1 / V2 的数据面回归（bench_dataplane_test.go，改动前后各跑一遍）
go test -run '^$' -bench 'BenchmarkDataplaneTCP(Bulk|RTT)' -count 3 .
# 内层 AEAD 两种算法（模式 3 AES-128-GCM / 模式 5 ChaCha20-Poly1305）：只测算法、整条隧道
go test -run '^$' -bench 'BenchmarkInnerAEAD' -count 3 ./internal/v3/
go test -run '^$' -bench 'BenchmarkV3InnerCipher' -benchtime 300x -count 3 .
# 同样两条命令前面加 GODEBUG=cpu.aes=off：模拟没有 AES 硬件（标准库 AES 退回纯 Go 实现）
```

测基线：`git worktree add /tmp/base 18ebfe861`，把 `bench_v3_test.go` 拷进
`/tmp/base/forwardx-fxp/`，同样的命令跑一遍。

## 环境和怎么读

- 4 vCPU 的 Xeon 2.1 GHz 虚拟机（共享宿主），Go 1.24.7，全部在本机回环上，入口、出口（和延迟代理）
  在同一个进程里。cpu-ms/GB 是整个进程（两端 + 夹具）的 CPU。
- 这台机器有噪声：同一份 V1 代码两次运行能差 20% 以上（见下面每张表里的 V1 行）。所以吞吐表
  另给了「相对同一次运行里的 V1」一列，这一列不受机器快慢影响。
- **延迟代理**（`v3BenchDelayProxy`）：每个方向读到的字节过 RTT/2 再写给对面，补上 TCP 三次握手
  那一个往返；不限带宽，每个方向最多 32 MiB 在路上。所以：
  - 不复用、单连接、200ms 往返时，上限是 32 MiB / 100 ms ≈ 2.68 Gbit/s（链路本身的上限，不是
    隧道的）；
  - 2 Gbit/s 以上的读数基本是代理（同一个进程里的拷贝）在吃 CPU，看的是数量级；
  - 复用时卡住吞吐的是每条流的窗口：窗口 / 往返时延。移植原样每流 64 KiB，50ms 下 ≈10 Mbit/s、
    200ms 下 ≈2.6 Mbit/s，实测一致。
- 短连接：16 个并发客户端，每个循环「拨号 → 发 64 字节 → 等回声 → 关」，p50 / p99 是从拨号到收到
  回声。首连：隧道起来 1.5 秒后（还没有任何用户连接）的第一条连接。

## 做了什么（按贡献从大到小）

| 改动 | 主要影响 |
| --- | --- |
| 复用的每流窗口自适应（BLOCKED 信号，128 KiB → 16 MiB，会话 / 进程预算） | 高延迟线路上复用单流 2.5 → 480 Mbit/s（200ms） |
| 隐含初始窗口（开流不等额度） | 复用短连接、首连少一个往返 |
| 内层记录层：读缓冲 + 就地解密，一批一次封、一次系统调用 | 不复用吞吐 1.8–2.6×，分配降 75–90% |
| 多路复用写协程批量写、帧缓冲 / 收包块走池、帧 64 KiB、额度攒够才发 | 复用吞吐 3.8–5.6×，分配降 90% 以上 |
| TLS 1.3 外层时内层直通（模式 4） | TLS 的 CPU/GB 再降一截，内层握手不占往返 |
| 内层握手一个往返（服务端证明随材料一起回） | 不复用、预热池没命中时少一个往返 |
| 复用时预热会话、快满时后台再备一条 | 复用首连 310 → 54 ms（50ms 往返） |
| HTTP / WS 请求头、回应和内层第一条消息拼段 | 少几个 TCP 段 |

## 结果

### 回环单连接 / 4 连接灌数据（BenchmarkV3Bulk，-benchtime 300x -count 3，中位数）

| 路径 | 连接 | Gbps 基线 | Gbps 优化后 | 倍数 | 相对同次 V1（基线 → 优化后） | cpu-ms/GB 基线 → 优化后 | allocs/GB 基线 → 优化后 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v1 | 1 | 10.2 | 10.2 | 1.0× | - | 2,317 → 2,270 | 9,419 → 9,928 |
| v1 | 4 | 14.8 | 15.1 | 1.0× | - | 2,057 → 1,993 | 14,426 → 14,369 |
| v3-tls-nomux | 1 | 3.78 | 8.95 | 2.4× | 37% → 87% | 5,751 → 2,607 | 828,597 → 83,599 |
| v3-tls-nomux | 4 | 5.11 | 13.1 | 2.6× | 34% → 86% | 4,800 → 2,368 | 847,384 → 105,130 |
| v3-tls-mux | 1 | 1.48 | 7.66 | 5.2× | 15% → 75% | 11,829 → 3,134 | 3,458,958 → 168,209 |
| v3-tls-mux | 4 | 2.03 | 9.20 | 4.5× | 14% → 61% | 10,614 → 2,772 | 3,524,981 → 179,208 |
| v3-ws-nomux | 1 | 4.50 | 9.91 | 2.2× | 44% → 97% | 4,708 → 2,337 | 782,019 → 194,054 |
| v3-ws-nomux | 4 | 5.72 | 15.1 | 2.6× | 39% → 100% | 4,139 → 2,019 | 788,024 → 201,050 |
| v3-ws-mux | 1 | 1.67 | 9.25 | 5.5× | 16% → 90% | 10,535 → 2,708 | 3,351,952 → 283,918 |
| v3-ws-mux | 4 | 2.44 | 9.36 | 3.8× | 16% → 62% | 9,069 → 2,823 | 3,473,193 → 301,053 |
| v3-http-nomux | 1 | 4.82 | 8.71 | 1.8× | 47% → 85% | 4,552 → 2,546 | 782,423 → 193,036 |
| v3-http-nomux | 4 | 5.52 | 14.1 | 2.6× | 37% → 93% | 4,333 → 2,136 | 787,652 → 200,240 |
| v3-http-mux | 1 | 1.64 | 9.22 | 5.6× | 16% → 90% | 11,190 → 2,737 | 3,344,866 → 284,405 |
| v3-http-mux | 4 | 2.39 | 9.29 | 3.9× | 16% → 61% | 9,419 → 2,632 | 3,473,301 → 294,059 |

### 带往返延迟（BenchmarkV3BulkRTT，稳态 Mbit/s，-count 2 中位数）

| 往返 | 路径 | 连接 | 基线 | 优化后 | 倍数 |
| --- | --- | --- | --- | --- | --- |
| 50ms | v1 | 1 | 8,116 | 8,439 | 1.0× |
| 50ms | v1 | 4 | 9,546 | 8,784 | -8% |
| 50ms | v3-tls-nomux | 1 | 4,210 | 7,708 | 1.8× |
| 50ms | v3-tls-nomux | 4 | 5,225 | 9,295 | 1.8× |
| 50ms | v3-tls-mux | 1 | 10.1 | 1,909 | 188.4× |
| 50ms | v3-tls-mux | 4 | 40.2 | 4,058 | 101.0× |
| 50ms | v3-ws-nomux | 1 | 5,098 | 8,244 | 1.6× |
| 50ms | v3-ws-nomux | 4 | 6,226 | 9,974 | 1.6× |
| 50ms | v3-ws-mux | 1 | 10.1 | 1,978 | 195.2× |
| 50ms | v3-ws-mux | 4 | 40.5 | 4,092 | 100.9× |
| 200ms | v1 | 1 | 2,664 | 2,680 | 1.0× |
| 200ms | v1 | 4 | 9,444 | 9,706 | 1.0× |
| 200ms | v3-tls-nomux | 1 | 2,632 | 2,678 | 1.0× |
| 200ms | v3-tls-nomux | 4 | 5,955 | 9,586 | 1.6× |
| 200ms | v3-tls-mux | 1 | 2.53 | 484 | 191.6× |
| 200ms | v3-tls-mux | 4 | 10.1 | 1,055 | 104.4× |
| 200ms | v3-ws-nomux | 1 | 2,652 | 2,631 | -1% |
| 200ms | v3-ws-nomux | 4 | 6,354 | 10,006 | 1.6× |
| 200ms | v3-ws-mux | 1 | 2.70 | 505 | 186.7× |
| 200ms | v3-ws-mux | 4 | 10.8 | 1,055 | 97.8× |

### 短连接（BenchmarkV3ConnRate，16 个并发客户端，建连 → 64 字节一问一答 → 关；-count 2 中位数）

| 往返 | 路径 | 连接/秒 基线 → 优化后 | p50 ms 基线 → 优化后 | p99 ms 基线 → 优化后 | 失败 |
| --- | --- | --- | --- | --- | --- |
| 0ms | v1 | 4,338 → 4,358 (1.0×) | 3.24 → 3.24 | 9.57 → 9.42 | 0 / 0 |
| 0ms | v3-tls-nomux | 2,365 → 2,436 (1.0×) | 6.22 → 6.09 | 15.5 → 15.2 | 0 / 0 |
| 0ms | v3-tls-mux | 3,823 → 6,416 (1.7×) | 3.77 → 2.04 | 9.35 → 6.72 | 0 / 0 |
| 0ms | v3-http-nomux | 4,258 → 4,460 (1.0×) | 3.01 → 2.90 | 10.5 → 10.4 | 0 / 0 |
| 0ms | v3-http-mux | 4,083 → 6,552 (1.6×) | 3.47 → 2.00 | 8.95 → 7.13 | 0 / 0 |
| 50ms | v1 | 289 → 288 (-0%) | 52.1 → 52.0 | 108 → 109 | 0 / 0 |
| 50ms | v3-tls-nomux | 255 → 291 (1.1×) | 51.9 → 52.0 | 262 → 158 | 0 / 0 |
| 50ms | v3-tls-mux | 152 → 303 (2.0×) | 105 → 52.7 | 108 → 55.4 | 0 / 0 |
| 50ms | v3-http-nomux | 275 → 290 (1.1×) | 52.0 → 52.1 | 208 → 156 | 0 / 0 |
| 50ms | v3-http-mux | 152 → 302 (2.0×) | 105 → 52.7 | 111 → 56.1 | 0 / 0 |

### 隧道起来 1.5 秒后的第一条连接（BenchmarkV3FirstConn，50ms 往返，5 次）

| 路径 | p50 ms 基线 → 优化后 | p99 ms 基线 → 优化后 |
| --- | --- | --- |
| v1 | 52.6 → 52.4 | 52.9 → 54.7 |
| v3-tls-nomux | 52.7 → 53.0 | 53.1 → 54.4 |
| v3-tls-mux | 310 → 54.3 | 311 → 55.9 |
| v3-http-nomux | 52.6 → 52.8 | 52.8 → 53.3 |
| v3-http-mux | 258 → 53.1 | 262 → 59.4 |

### V1 / V2 回归（bench_dataplane_test.go，改动前后各跑两轮，-count 3 中位数）

动过的 V1 / V2 共用代码：中转转发 hello 的那一段（多路径腿时调 v3LegConfig，对非 V3 配置原样返回）、多路径拨腿（同上）、端点预热的 ensureFill（条件顺序调整，V1 走的分支不变）、配置校验里去掉一条只对 V3 生效的检查。线上字节、握手、配置字段都没动。两轮的先后顺序相反，变化的正负跟着先后翻转，而且不经隧道的 direct 路径（夹具本身）也有同样幅度的波动：这是机器噪声，不是回归。p50 时延两轮都不变。

#### 第一轮：先跑基线、再跑改动后

| 基准 | 基线 | 改动后 | 变化 |
| --- | --- | --- | --- |
| TCPBulk/direct/streams=1 Gbps | 22.3 | 21.4 | -4% |
| TCPBulk/direct/streams=1 cpu-ms/GB | 524 | 548 | +5% |
| TCPBulk/direct/streams=4 Gbps | 77.2 | 68.7 | -11% |
| TCPBulk/direct/streams=4 cpu-ms/GB | 385 | 406 | +6% |
| TCPBulk/aes/streams=1 Gbps | 10.5 | 10.4 | -2% |
| TCPBulk/aes/streams=1 cpu-ms/GB | 2,201 | 2,254 | +2% |
| TCPBulk/aes/streams=4 Gbps | 15.5 | 15.3 | -1% |
| TCPBulk/aes/streams=4 cpu-ms/GB | 2,025 | 2,017 | -0% |
| TCPBulk/chacha/streams=1 Gbps | 7.99 | 7.53 | -6% |
| TCPBulk/chacha/streams=1 cpu-ms/GB | 2,847 | 2,959 | +4% |
| TCPBulk/chacha/streams=4 Gbps | 12.0 | 11.7 | -2% |
| TCPBulk/chacha/streams=4 cpu-ms/GB | 2,550 | 2,633 | +3% |
| TCPBulk/v2plain/streams=1 Gbps | 12.9 | 13.2 | +2% |
| TCPBulk/v2plain/streams=1 cpu-ms/GB | 1,848 | 1,792 | -3% |
| TCPBulk/v2plain/streams=4 Gbps | 19.2 | 19.0 | -1% |
| TCPBulk/v2plain/streams=4 cpu-ms/GB | 1,621 | 1,651 | +2% |
| TCPBulk/aes-serial/streams=1 Gbps | 9.01 | 8.36 | -7% |
| TCPBulk/aes-serial/streams=1 cpu-ms/GB | 2,206 | 2,412 | +9% |
| TCPBulk/aes-serial/streams=4 Gbps | 16.2 | 15.4 | -5% |
| TCPBulk/aes-serial/streams=4 cpu-ms/GB | 1,900 | 2,025 | +7% |
| TCPRTT/direct p50-us | 5.44 | 5.62 | +3% |
| TCPRTT/direct p99-us | 19.6 | 23.4 | +19% |
| TCPRTT/aes p50-us | 18.3 | 18.5 | +1% |
| TCPRTT/aes p99-us | 52.2 | 63.5 | +22% |
| TCPRTT/chacha p50-us | 19.1 | 19.0 | -0% |
| TCPRTT/chacha p99-us | 59.8 | 70.7 | +18% |
| TCPRTT/v2plain p50-us | 17.5 | 17.6 | +1% |
| TCPRTT/v2plain p99-us | 49.3 | 56.1 | +14% |
| TCPRTT/aes-serial p50-us | 18.3 | 18.5 | +1% |
| TCPRTT/aes-serial p99-us | 57.5 | 63.1 | +10% |

#### 第二轮：先跑改动后、再跑基线

| 基准 | 基线 | 改动后 | 变化 |
| --- | --- | --- | --- |
| TCPBulk/direct/streams=1 Gbps | 21.1 | 20.3 | -4% |
| TCPBulk/direct/streams=1 cpu-ms/GB | 542 | 556 | +3% |
| TCPBulk/direct/streams=4 Gbps | 64.4 | 62.5 | -3% |
| TCPBulk/direct/streams=4 cpu-ms/GB | 429 | 426 | -1% |
| TCPBulk/aes/streams=1 Gbps | 9.36 | 10.1 | +8% |
| TCPBulk/aes/streams=1 cpu-ms/GB | 2,478 | 2,296 | -7% |
| TCPBulk/aes/streams=4 Gbps | 14.7 | 15.2 | +3% |
| TCPBulk/aes/streams=4 cpu-ms/GB | 2,115 | 2,047 | -3% |
| TCPBulk/chacha/streams=1 Gbps | 6.57 | 6.72 | +2% |
| TCPBulk/chacha/streams=1 cpu-ms/GB | 3,318 | 3,218 | -3% |
| TCPBulk/chacha/streams=4 Gbps | 11.4 | 11.2 | -2% |
| TCPBulk/chacha/streams=4 cpu-ms/GB | 2,679 | 2,697 | +1% |
| TCPBulk/v2plain/streams=1 Gbps | 12.3 | 12.4 | +0% |
| TCPBulk/v2plain/streams=1 cpu-ms/GB | 1,920 | 1,939 | +1% |
| TCPBulk/v2plain/streams=4 Gbps | 17.9 | 18.5 | +3% |
| TCPBulk/v2plain/streams=4 cpu-ms/GB | 1,703 | 1,686 | -1% |
| TCPBulk/aes-serial/streams=1 Gbps | 8.41 | 8.70 | +3% |
| TCPBulk/aes-serial/streams=1 cpu-ms/GB | 2,346 | 2,314 | -1% |
| TCPBulk/aes-serial/streams=4 Gbps | 16.4 | 15.7 | -5% |
| TCPBulk/aes-serial/streams=4 cpu-ms/GB | 1,903 | 1,948 | +2% |
| TCPRTT/direct p50-us | 5.42 | 5.43 | +0% |
| TCPRTT/direct p99-us | 19.9 | 19.3 | -3% |
| TCPRTT/aes p50-us | 18.3 | 18.3 | +0% |
| TCPRTT/aes p99-us | 53.3 | 51.5 | -3% |
| TCPRTT/chacha p50-us | 18.9 | 19.0 | +0% |
| TCPRTT/chacha p99-us | 55.3 | 58.4 | +6% |
| TCPRTT/v2plain p50-us | 17.6 | 17.5 | -0% |
| TCPRTT/v2plain p99-us | 58.6 | 51.3 | -13% |
| TCPRTT/aes-serial p50-us | 18.2 | 18.2 | -0% |
| TCPRTT/aes-serial p99-us | 52.5 | 52.0 | -1% |

### 内层 AEAD 算法：AES-128-GCM vs ChaCha20-Poly1305（模式 3 / 5）

模式 3 / 5 按两端有没有 AES 硬件自动选（协商见 `PROTOCOL.md`「内层算法协商」）；这里比两种算法的
代价。这台机器有 AES-NI，「没有 AES 硬件」用 `GODEBUG=cpu.aes=off` 模拟：标准库的 AES 退回纯 Go
的查表实现（和没有加密扩展的 ARM 上 Go 走的是同一份代码），ChaCha20 的汇编不受影响。
`BenchmarkV3InnerCipher` 用 `v3.OverrideAESHardware` 让两端都当作有 / 没有 AES 硬件，从而强制协商出
某一种算法；TLS 外层是模式 4（内层直通），不在这张表里。

只测算法（`BenchmarkInnerAEAD`：单核把一条 16 KiB 的记录封好再解开，含 2 字节长度的那次密封，
-count 3 中位数；cpu-ms/GB 是「封 + 解」1 GB 明文的单核 CPU）：

| 本机 | AES-128-GCM | ChaCha20-Poly1305 | ChaCha20 / AES 的 CPU |
| --- | --- | --- | --- |
| 有 AES-NI | 2,698 MB/s · 370 cpu-ms/GB | 877 MB/s · 1,141 cpu-ms/GB | 3.1×（ChaCha20 更贵） |
| `cpu.aes=off`（没有 AES 硬件） | 58 MB/s · 17,232 cpu-ms/GB | 947 MB/s · 1,056 cpu-ms/GB | 0.061×（AES-GCM 贵 16×） |

整条隧道（`BenchmarkV3InnerCipher`，回环、入口和出口在一个进程里，cpu-ms/GB 是整个进程；
有 AES 时 -benchtime 300x，`cpu.aes=off` 时只跑不复用、-benchtime 100x，都是 -count 3 中位数）：

| 路径 | 连接 | 有 AES-NI：AES-GCM | 有 AES-NI：ChaCha20 | 没有 AES：AES-GCM | 没有 AES：ChaCha20 |
| --- | --- | --- | --- | --- | --- |
| v3-ws-nomux | 1 | 9.74 Gbps · 2,365 | 6.44 Gbps · 3,366 | 0.70 Gbps · 25,110 | 5.20 Gbps · 3,700 |
| v3-ws-nomux | 4 | 13.7 Gbps · 2,152 | 11.1 Gbps · 2,797 | 1.37 Gbps · 20,680 | 8.83 Gbps · 2,890 |
| v3-http-nomux | 1 | 9.73 Gbps · 2,279 | 5.49 Gbps · 3,586 | 0.65 Gbps · 25,440 | 5.30 Gbps · 3,614 |
| v3-http-nomux | 4 | 15.7 Gbps · 1,961 | 10.8 Gbps · 2,893 | 1.18 Gbps · 23,400 | 8.07 Gbps · 3,033 |
| v3-ws-mux | 1 | 8.18 Gbps · 2,937 | 6.54 Gbps · 3,573 | - | - |
| v3-ws-mux | 4 | 10.0 Gbps · 2,629 | 6.70 Gbps · 3,599 | - | - |
| v3-http-mux | 1 | 8.86 Gbps · 2,686 | 6.21 Gbps · 3,688 | - | - |
| v3-http-mux | 4 | 10.3 Gbps · 2,667 | 6.78 Gbps · 3,716 | - | - |

怎么读：

- 有 AES 硬件时 ChaCha20 整条隧道的 CPU/GB 多 20–60%（每 GB 多约 0.6–1.3 秒 CPU，和只测算法时「封 + 解」
  一次的差 0.77 秒同一个量级），吞吐低 20–45%。所以两端都有 AES 硬件时仍用 AES-GCM。
- 没有 AES 硬件时纯 Go 的 AES-GCM 是瓶颈：整条隧道 CPU/GB 是 ChaCha20 的 6.8–7.7 倍，吞吐只有
  ChaCha20 的 12–16%。选 ChaCha20 后，「没有 AES」的机器上 V3 的 HTTP / WS 外层吞吐接近有 AES-NI 时
  用 ChaCha20 的水平（单连接 5.2 vs 6.4 Gbps）。
- 只要有一端没有 AES 硬件就用 ChaCha20：有硬件的那端多花的是上面第一条的那 20–60%，没有硬件的那端
  省下的是 6–7 倍。

ARM 上的预期（**没有在 ARM 上实测**）：

- 带 ARMv8 加密扩展的 ARM（AWS Graviton、Ampere Altra、苹果 M 系列、多数云厂商的 ARM 实例，以及
  Cortex-A53 / A55 / A72 等带加密选项的芯片）：x/sys/cpu 报有 AES + PMULL，照旧用 AES-GCM，表现和
  上面「有 AES-NI」那两列同一类。
- 没有加密扩展的 ARM（树莓派 3 / 4 的 BCM2837 / BCM2711、一些便宜的 ARM 小鸡、32 位 ARM）：Go 的
  AES-GCM 走纯 Go 查表实现，和这里 `cpu.aes=off` 的 AES-GCM 列是同一份代码；ChaCha20 在 arm64 上有
  NEON 汇编（Poly1305 是纯 Go），在 32 位 arm 上两者都是纯 Go。按 x86 上软件实现的比例（只测算法 16×、
  整条隧道 6–7×）和这类小核的特点，预期 ChaCha20 的吞吐是 AES-GCM 的数倍，绝对值受限于单核速度，
  通常远低于这里的 Gbps 级数字。要实测：在那台机器上跑上面两条基准命令（不用 GODEBUG）。
- 32 位 arm、386、riscv64 等架构这里一律当作没有 AES 硬件（Go 1.24 的 AES-GCM 在这些架构上没有汇编）。

## 结论和局限

- 回环吞吐：不复用的 V3 从同次 V1 的 34–47% 提到 85–100%，复用的从 14–16% 提到 61–90%（4 条流共用一条
  物理连接时，上限是一条 TCP 的写协程）。CPU/GB 降 44–76%，分配降 75–95%。TLS 外层直通之后，
  TLS 不再比 WS / HTTP 贵。
- 高延迟：复用的单条流 200ms 往返下 2.5 → 约 490 Mbit/s（16 MiB 窗口的理论上限是 671 Mbit/s，
  测量窗口里还带着几个往返的爬坡），50ms 下 10 → 约 1.9 Gbit/s。不复用的单连接本来就只受 TCP
  限制，和 V1 一样贴着延迟代理的上限。
- 短连接：复用时每条新连接少一个往返（50ms 往返下 p50 105 → 53 ms，每秒连接数翻倍）；不复用时
  预热池命中时本来就只要一个往返，没命中时（p99）少一个往返：TLS p99 262 → 158 ms。
- 首连：复用时规则一起来就预热好会话，310 / 258 → 约 54 ms（和不复用、V1 一样只剩一个往返）。
- 内层 AEAD 按两端 AES 硬件选算法：两端都有 AES 硬件时不变（AES-GCM）；任意一端没有时改用
  ChaCha20-Poly1305，模拟没有 AES 硬件时整条隧道（HTTP / WS 外层、不复用）吞吐约 6–8 倍、CPU/GB 降 85%
  以上。ARM 上的数字没有实测。
- 延迟代理是进程内的、不丢包、不限带宽；真实线路的丢包、乱序、带宽上限没有模拟，窗口自适应在
  丢包线路上的表现（尤其是复用时一条 TCP 的队头阻塞）没有量过。没有做多机、长时间的压测。
