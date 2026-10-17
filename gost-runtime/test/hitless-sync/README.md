# 增删改规则不断连接（hitless sync）压测

面板改一条 gost 规则时，Agent 通过 gost 的本机 Unix 套接字 API 增量同步（`agent/gost_api_sync.go`），
不再重启共享的 gost 进程。这个压测证明：增、改、删别的规则的时候，**没动的规则上的流量一点不受影响**。

```bash
GOARCHES=amd64 gost-runtime/build.sh /tmp/rt           # 编出 3.2.6-nex5 起的运行时
sudo gost-runtime/test/hitless-sync/run.sh /tmp/rt/forwardx-runtime-linux-amd64
```

要 root（API 套接字目录必须是 root 的；流量计数是 nft 规则）、Go、sing-box（不给就下载）。

## 测了什么

真 gost 运行时上挂四条「不动的规则」，整个过程一直有流量：

| 规则 | 流量 |
|---|---|
| 普通 TCP 转发 | 32 条长连接，双向不停写 16KB 随机块、读回逐字节比对 |
| 普通 UDP 转发 | 64 个并发流，带序号一问一答，1 秒没回算丢 |
| 限速 TCP 转发（服务级限速 2 MB/s） | 一条流全速灌，每 2 秒量一次吞吐 |
| Shadowsocks 出口（aes-256-gcm，落地是真 sing-box） | 4 条 TCP 长连接 + 8 个 UDP 流 |

同时用 Agent 真正的同步代码（`applyManagedConfigs` + `gostAPISync`，和心跳下发走同一段）一轮一轮地：
加一条 TCP + 一条 UDP 规则 → 改 TCP 规则的目标 → 改限速器的值 → 把 TCP 规则改成 UDP → 删掉这些规则。

断言：

- 没动的规则：TCP 0 断开、0 数据错；UDP 0 丢包、0 错包；限速一直在 0.5×–1.3× 限速值之间；gost 进程 PID 不变；
- 被改 / 被删的规则：上面开着的连接被关掉（只有这些）；
- 流量计数（Agent 给 gost 这类进程转发装的 nft 计数，和上报流量读同一份）：不倒退、不清零，
  增量 ÷ 压测实际收发的字节在 1.0–1.25 之间（多出来的是包头）。

运行时低于 nex5（官方 gost、nex4）时这个测试跳过：那些运行时上改 / 删 TCP 规则仍然走重启。
