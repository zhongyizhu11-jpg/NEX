# NEX V3 协议（NEX 修订）

这个目录最早移植自上游 ForwardX 2.3.299 的 `forwardx-fxp/internal/v3`（移植原样是提交
7d2460ce9）。NEX V3 在发布之前按 NEX 自己的需要重做了内层握手、记录层和多路复用的流控；
外层（HTTP / WS / TLS）和多路复用的帧头沿用上游。**NEX V3 和上游 V3、和移植原样都不互通**
（移植原样从没发布过，线上没有那样的对端）。V1 / V2 的线格式、握手、配置字段一个字节没动。

下面「V3 implementation evidence」那一大段是上游的英文原文，保留作实现依据；其中关于内层
握手、记录大小、额度和窗口的描述是移植原样的设计，**以本节为准**。性能对比见
`BENCHMARKS.md`。接入层在 `forwardx-fxp/v3_transport.go`、`v3_session.go`。

```
业务 TCP / UDP
  -> FXP 逻辑帧（4 字节长度 + 明文）
  -> （可选）多路复用帧：type u8、流号 u32 BE、长度 u16 BE、内容
  -> 内层：模式 3 是 AEAD 记录；模式 4 直通（外层 TLS 1.3 负责加密）
  -> 外层：HTTP 样式 / WS 样式 / TLS
  -> TCP
```

## 内层握手

第一条消息还是上游的形状：1 个模式字节 + 16 字节随机材料。模式字节就是协商：

| 模式 | 用在 | 线上 |
| --- | --- | --- |
| 3 | HTTP / WS 外层；或 TLS 但协商出的版本低于 1.3 | C→S `[3][c]`；S→C `[3][s][Ps]`；C→S `[Pc]`，紧跟记录 |
| 4 | TLS 1.3 外层 | C→S `[4][c][Pt]`，紧跟明文字节；服务端什么也不回 |
| 2 | 移植原样（上游形状） | **不再接受**，服务端报 `ErrInnerLegacyPeer` |

- `Ka = SHA-256("nex-v3 inner auth\0" ‖ PSK)`，证明是 `HMAC-SHA256(Ka, 角色 ‖ 模式 ‖ 各段（2 字节长度 + 内容）)` 取前 16 字节，
  `hmac.Equal` 比较。角色 `s` / `c` / `t` 让服务端、客户端、TLS 模式的证明两两不同，不能反射；
  模式字节在证明里，改不了模式。
  - `Ps = proof('s', 3, c, s)`，`Pc = proof('c', 3, c, s)`，`Pt = proof('t', 4, c, E)`。
  - `E` 是这条 TLS 连接的导出密钥：`ExportKeyingMaterial("EXPORTER-NEX-V3-inner-auth", nil, 32)`（RFC 8446 §7.5）。
- 模式 3：服务端收到 `[3][c]` 就把自己的材料和证明一起回；客户端验过 `Ps` 才发 `Pc`，发完不等，
  第一批记录紧跟在后面。服务端先验 `Pc`，验过之前不交出任何业务数据。内层握手一个往返
  （移植原样：两个往返——先交换材料，再交换证明）。
- 模式 4：客户端只发一条 33 字节的消息，内层握手不占往返；服务端验过 `Pt` 就直通。
- 服务端只在**自己**的外层是 TLS 1.3 时才接受模式 4（`v3TLSBinding` 拿不到导出密钥就是没有
  资格），否则拒绝——不会在没有 TLS 1.3 保护的连接上直通，也没有降级路径。客户端只在自己的
  外层协商出 TLS 1.3 时才发 4，否则发 3。

## 模式 4 的安全论证（TLS 外层不再套内层 AEAD）

要论证的是：去掉内层 AEAD 之后，机密性、完整性、双向认证、抗重放都不比「TLS + 内层 AEAD」差。

1. **服务端认证**：客户端钉死服务端证书的 Ed25519 公钥，这把私钥是
   `SHA-256("forwardx-v3 outer TLS certificate\0" ‖ PSK)` 派生的，只有知道隧道密钥的一方拿得出。
   TLS 1.3 的 CertificateVerify 用这把私钥签整个握手记录，所以和客户端握完 TLS 的一定是知道 PSK
   的一方。中间人要冒充服务端，等于要知道 PSK。
2. **机密性和完整性**：由 TLS 1.3 的 AEAD 记录层提供（Go 的 TLS 1.3 只有 AES-GCM 和
   ChaCha20-Poly1305 套件），密钥来自 ECDHE，有前向保密——这比内层 AEAD 还强：内层的密钥由
   PSK 和两份明文材料派生，PSK 泄露后录下来的流量能被解开，TLS 1.3 的不能。
   TLS 1.3 还对降级做了防护（ServerHello.random 里的降级哨兵 + 签名覆盖整个握手），中间人没法
   把双方压到 TLS 1.2 去，从而让客户端改发模式 3 也不构成削弱（模式 3 本身是完整的 AEAD）。
3. **客户端认证**：TLS 层不认证客户端，靠 `Pt`。`Pt` 是 PSK 派生的 HMAC，没有 PSK 算不出。
4. **抗重放 / 中继**：`Pt` 绑在这条 TLS 会话的导出密钥 `E` 上。`E` 由双方的随机数和 ECDHE 共享
   秘密导出，每条 TLS 连接都不同，攻击者也算不出（它不知道 TLS 的密钥）。所以把录下来的 `Pt`
   拿到另一条 TLS 连接上用，服务端算出来的期望值不同，拒绝（测试
   `TestInnerTLSProofDoesNotReplayAcrossSessions`）。攻击者自己和服务端开一条 TLS 连接，也只能拿到
   那条连接的 `E`，没有 PSK 算不出对应的 `Pt`。
5. **探测**：没有 PSK 的探测者能和出口完成 TLS（出口不要求客户端证书），之后发什么都过不了 `Pt`，
   出口延迟一会儿关连接（`probeDelay`），和以前一样，也和模式 3 下一样不回任何业务数据。
6. **域分隔**：TLS 证书密钥、内层证明密钥 `Ka`、模式 3 的记录密钥各自带不同的标签从 PSK 派生，
   任何一个泄露不会直接给出另外两个。

保留的东西：内层握手里的 HMAC 证明仍然在（第 3、4 条），所以 V3 照旧是双向认证；只是去掉了
在 TLS 1.3 里面再加密一遍的那层。排障时可以把 FXP 的 `v3TLSInnerAEAD` 打开，TLS 外层也走模式 3：
它只管客户端发哪个模式，服务端只要自己的外层是 TLS 1.3，两种都收。

## 记录层（模式 3）

- HKDF-SHA256（RFC 5869，自己实现，带 RFC 测试向量）：`IKM = SHA-256(PSK)`，`salt = c ‖ s`，
  `info = "nex-v3 records"`，导出四把 AES-128-GCM 密钥：两个方向 × 长度 / 内容，互不共用。
- 一条记录：2 字节长度单独封（18 字节）、内容单独封（n + 16 字节），`n ≤ 16384`。nonce 是
  `方向 ‖ 用途 ‖ 0 ‖ 0 ‖ 计数（u64 BE）`，计数到 2^62 就失败关闭。
- 写：一次 `WriteBuffers` 把几段明文按记录上限切开，**就地**封进一块借来的缓冲（明文只拷一次），
  一次系统调用写出。写失败之后这条连接作废。
- 读：64 KiB 级的读缓冲，一次系统调用带回好几条记录，就地解密，不再每条记录分配三块内存、
  做两次系统调用（移植原样每条记录 `ReadFull` 两次、分配 head / body / plain）。
- 记录上限从 16381 改成 16 KiB：更大的记录省下的 GCM 开销不到 3%，却让低速线路上的接收端要等
  一整条记录到齐才能解出第一个字节。

## 多路复用

帧头、OPEN / CLOSE 后跟单独填充帧（OPEN 填充 20..99 字节、CLOSE 26 字节）、类型 5 失败关闭，
都和上游一样。DATA 帧内容的第一个字节：

| 标记 | 内容 | 说明 |
| --- | --- | --- |
| 0 | 业务字节 | 一帧最多 65534 字节（移植原样 16374），帧可以跨内层记录 |
| 1 | 额度 u32 BE | 累计额度不得超过 64 MiB，否则只重置这一条流 |
| 2 | BLOCKED | NEX 新增：发送端额度用完了。整个帧内容就这 1 个字节 |

流控：

- **隐含的初始窗口**：每条流一开就有 `StreamBuffer`（128 KiB）的额度，两端约定一致，不用等
  对端发第一次额度。移植原样新流的额度是 0，开流后要等一个往返才能写——每条短连接多一个 RTT。
- **额度批量还**：读掉的字节攒够窗口的四分之一才还一次（移植原样读一次就还一次）。
- **窗口自适应**：发送端额度用完时发一次 BLOCKED（走和数据同一条先进先出的队列，排在用完额度
  的那些数据后面，不会插队）。接收端记下它，等缓冲读到只剩不到四分之一窗口时放大窗口
  （1 MiB 以下 ×4，以上 ×2，最大 `MaxStreamWindow` = 16 MiB），放大的部分立刻作为额度发出。
  - 读得慢的流：每还一次额度，对端马上补满，缓冲一直接近满，降不到四分之一，**不放大**。只有
    「读的速度 × 往返时延」超过约 3/4 个窗口，缓冲才会在额度补回来之前读空——这正是卡在窗口上
    的情况。不需要测往返时延。
  - 内存有界：放大的部分从会话预算（`SessionBuffer` = 32 MiB）和整个进程的预算
    （`GlobalWindowBudget` = 256 MiB）里扣，流结束时归还。最坏情况（每条流都卡在一个不读的
    消费者上）：每个会话 128 × 128 KiB = 16 MiB 初始窗口 + 32 MiB 放大，进程总的放大部分不超过
    256 MiB。移植原样是每会话 8 MiB、每流 64 KiB（200 ms 往返下单流约 2.6 Mbit/s）。
- **写**：业务数据拷进池里的帧缓冲（帧头预先写好），一条流一次 `WriteBuffers` 最多同时排 4 帧；
  写协程一次取一批（最多 64 帧 / 512 KiB），连同额度、控制帧一起交给内层一次写出。OPEN 和数据走
  同一条队列，保证 OPEN 先于这条流的数据上线；`Open` 不再等 OPEN 写出去。
- **读**：DATA 帧的业务字节直接读进池里的块挂到流上，读空了还回池里；小帧并进上一块的空余。

## 接入层（FXP）

- **出口按第一个字节分辨复用 / 不复用**：认证之后，不复用的连接第一个字节是逻辑帧长度的最高
  字节（逻辑帧不超过 `multipathMaxChunkPayload` + 64，一定是 0），复用的会话第一帧一定是 OPEN（1）。
  出口据此选，不再要求两端的 `v3Multiplex` 一致；等第一个字节的规矩和等 hello 一样（45 秒、监听
  停了就不等），所以预热连接照旧能在出口空等。
- **复用时预热**：端点活跃（规则刚起来，或最近 5 分钟有人用）时，保证有一条认证好、空位多于 16
  的会话；挑中的会话空位不多于 16 时后台再拨一条。入口一侧空闲会话 20 秒关（出口 30 秒），
  不会在出口正要关掉的会话上开流。
- **多路径走 V3**：中转叠加 / 热备 / 单连接多路并发的每条腿是一条自己的 V3 物理连接——入口拨腿、
  中转转发腿的下一跳都用 `v3LegConfig` 关掉复用，不会被并进同一个复用会话；腿用的端点状态
  按实际承载方式分份。
- HTTP / WS 外层：客户端的请求头和内层第一条消息拼成一个 TCP 段；出口的 101 / 200 回应和它的第一次
  写（内层回复）拼成一段——出口只在读到客户端的内层第一条消息之后才写，所以只发请求头就不说话的
  探测照旧收不到成功的回应。

## 和移植原样相比，其它仍然有效的差异

- **Host 头**：上游（和参考实现）的 HTTP / WS 样式请求不带 Host 头。NEX 在 `v3Host` 非空时带
  `Host:`；留空时请求字节和参考模板完全一样。出口不核对 Host。
- **SNI**：上游 `v3ServerName` 留空时发 `forwardx.invalid`；NEX 留空就不发 SNI。出口不看 SNI。
- **TLS 会话票据**：出口关掉了会话票据（`SessionTicketsDisabled`），因为入口的预热连接池靠偷看
  底层 TCP 判断空闲连接活没活，TLS 1.3 的 NewSessionTicket 会被误认成数据。
- **和 NEX 特性的组合**：抗丢包传输（KCP 承载，V3 的外层就没了）不能和 V3 同开，FXP 配置校验会拒，
  面板保存时就拦；内核直通只对 V2 有意义。其余（UDP 直连、UDP 抗丢包、mimic、链路整形、TCP Fast
  Open、多出口和出口策略、中转链、中转叠加 / 热备、单连接多路并发）都可以。
- `go test -race ./internal/v3/` 和 FXP 包里所有 V3 / 多路径测试在 NEX 的构建环境里跑过，通过。

# V3 implementation evidence / 实现依据

Status: **V3 inner handshake and record layer implemented; outer transports aligned
with the reference; multiplex sessions, pool health, endpoint failover and
backpressure wired into FXP. Panel selection still pending (separate change).**
V1/V2 are unchanged. This directory is built into the existing FXP module; it
does not introduce another executable.

Reference: user-supplied Linux amd64 node `zf-nc20260412`, SHA-256
`e432273ac9d7f29287989f6269ef5c9b8fc1080a365d2879a00973b60441f569`
(re-verified locally). Two independent analysis rounds are recorded in
`../nypass_temp/rea-analysis/`: the first used REA + Ghidra, the second
re-derived the wire facts with a self-written ELF/pclntab reader plus Capstone.
No sample code was executed.

## What V3 is now

```
business TCP/UDP
  -> FXP logical frame (4-byte length prefix)
  -> multiplex frame (type u8, stream ID u32 BE, length u16 BE)
  -> inner AEAD record (2-byte sealed length, sealed payload)
  -> outer transport (HTTP style / WS style / TLS)
  -> TCP
```

The inner record layer **replaces** the legacy FXP secure handshake on every V3
path, multiplexed or not. V3 no longer wraps the V1/V2 handshake.

## Implemented / 已实现

### Outer transport

- Request shape follows the recovered reference template
  `%s %s HTTP/1.1\r\nUser-Agent: %s\r\n` (literal at `0x104f501`). The reference
  sends **no Host header** on this path, so V3 does not either. A configurable
  `v3UserAgent` supplies the agent string.
- WS-style is a **real RFC 6455 handshake**: the client sends
  `Sec-WebSocket-Version: 13` and a `Sec-WebSocket-Key`, and the server answers
  with `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: <base64(HMAC-SHA1(key, GUID))>`,
  byte-for-byte matching the reference literal at `0x108480d`. The client
  verifies the accept value when the server sends it.
- Data framing after the WS handshake is **not** RFC 6455: the tunnel carries its
  own byte stream. This matches the reference, whose write path adds no opcode,
  mask or payload-length fields.
- The server response is withheld until the first `Read`, so a peer that sends a
  preface and then goes silent never receives a success status. The reference's
  own timing has not been recovered; this ordering is a ForwardX policy.
- TLS uses the standard library with the tunnel PSK pinning the self-signed
  certificate's Ed25519 public key. uTLS fingerprints are not implemented.

### Inner handshake

Two phases, mirroring the reference's "read 17 bytes, then compare a further 16":

1. Each side sends 17 bytes: a mode byte plus 16 bytes of random material. The
   reference reads exactly 17 bytes at `0xd00080`; the mode byte selects its
   crypto branch. ForwardX only implements an authenticated layer, so the byte is
   a fixed marker (`2`, the reference's AEAD branch) rather than a negotiation.
2. Each side sends a 16-byte proof. The reference compares 16 bytes with
   `runtime.memequal`; ForwardX sends
   `HMAC-SHA256(PSK, local_material || peer_material)[:16]` and compares it with
   `hmac.Equal`, which is constant time and not replayable.

Both materials are mixed into the key-derivation salt, so every session gets
fresh keys even with a fixed PSK.

### Inner record layer

- Key derivation: HKDF-SHA256 over the tunnel PSK with info `ss-neko-aead` — the
  reference's info literal, recovered from `0xbd71ee`/`0xbd71f8`. The reference
  picks SHA-1 at `0xbd7218`; ForwardX uses SHA-256. The HKDF is implemented in
  this package (RFC 5869) so the module stays dependency-free, and it is checked
  against the RFC 5869 SHA-256 test vector.
- Four independent keys are derived: length and data, per direction. **This is
  where ForwardX deliberately diverges.** The reference factory at `0xbd7140`
  stores the *same* 16-byte derived key into both direction objects
  (`0xbd74ba`-`0xbd74e4` and `0xbd760a`-`0xbd763c`) and initialises both nonces to
  zero, which is cross-direction keystream reuse. ForwardX uses a distinct key
  per direction and per purpose.
- Nonce: 12 bytes, `direction || kind || 0 || 0 || counter(u64 BE)`, incremented
  once per AEAD operation. The reference also increments once per operation
  (`0xbd694c` after the length, `0xbd6b1a` after the payload) but has no
  direction or kind byte.
- Record layout: the 2-byte big-endian length is sealed separately from the
  payload, so the length is confidential as well as authenticated. The reference
  does the same: it reads 18 bytes (2 + 16 tag) at `0xbd6872`, decrypts the
  length, then reads `length + 16`.
- Payload cap `InnerPayloadLimit = 16381`, derived from the reference's reader
  buffer `0x400f` (16399) minus the 2-byte length record and the 16-byte tag.
  An earlier reading of the reference as `0x3fff` (16383) was wrong; the writer
  buffer is `0x4021` (16417).
- The multiplex `dataChunk` is `InnerPayloadLimit - 7` so a full DATA frame always
  fits inside one inner record.

### Multiplex

- Wire header unchanged and matching the reference: type u8, stream ID u32 BE,
  length u16 BE, payload. Data sender `0xccae20`; receiver `0xcc8c60` reads
  7-byte headers.
- Open = 1, data = 2, close = 3, padding = 4. Type 5 exists in the reference but
  its lifecycle meaning is unverified, so it is neither sent nor interpreted;
  receiving it fails closed.
- Padded control layout matches `0xccb120`: a zero-length control frame followed
  by a separate type-4 frame. Open padding is `crypto/rand.Int(80) + 20` → 20..99
  total bytes, matching `Int(max-min)+min` at `0xa0bd20`. Close padding is 26
  total bytes.
- DATA payload tags (`0` = stream bytes, `1` = u32-BE window credit) and the
  credit scheme are **ForwardX additions**, not recovered reference semantics.

### Session lifetime, health and fairness

- 128 logical streams per physical session; 64 physical outbound sessions per
  process, growing on demand. Pool exhaustion returns an explicit capacity error.
- Pool identity includes tunnel ID, endpoint, key, transport, Host/path/SNI;
  rule-specific targets, quotas and PROXY flags stay in each business hello.
- **Session health**: each session records the time of its last successful
  physical write. A session whose peer vanished silently still reports free
  slots, so the pool skips any session that has not proven itself within
  `v3SessionStaleAge` (30s) and drains failed sessions out of its bucket. Before
  this, the pool kept selecting a dead session and the resulting write timeout
  failed the whole physical session, breaking every sibling stream on it.
- **Endpoint feedback**: the multiplexed dial path hands endpoint selection to the
  pool, which walks the selector's candidates, reports `markHealthy` /
  `markFailure`, and moves to another endpoint when a dial or handshake fails.
  Previously the pooled path returned as soon as any session existed, so the
  selector never learned an endpoint had died and `ExitStrategy: fallback`
  silently degraded to "keep using the dead endpoint".
- **Control backpressure**: a full control queue no longer fails the session. It
  used to `fail()` the whole physical session — and every sibling stream — once
  128 close frames piled up behind a slow physical write. Producers now wait for
  room, bounded by the session lifetime; `tryControl` offers a non-blocking
  variant.
- **Writer fairness**: control frames are still drained first when both queues
  have work, but no longer with absolute priority, so an unbounded run of control
  frames cannot starve DATA frames.
- Ten-second physical write timeout; logical read/write deadlines can be updated
  while blocked. Thirty-second idle expiry when no streams remain.
- Drain refuses new streams and lets existing ones finish. In-flight business
  bytes are never replayed after a transport failure.

## Inspected but deliberately not copied / 已分析但不照搬

| Reference behaviour | Evidence | Why not copied |
| --- | --- | --- |
| One derived key for both directions | `0xbd74ba`-`0xbd74e4`, `0xbd760a`-`0xbd763c` write the same key slice into both objects | Cross-direction keystream reuse |
| Both nonces start at zero | nonce buffers allocated and zero-filled, increment loops touch only 12 bytes | Same as above |
| AES-OFB branch | `0xbd7880`: `crypto/aes.NewCipher` + two `cipher.NewOFB` | Stream cipher with no integrity protection |
| `runtime.memequal` material compare | reported in round one, consistent with `0xd00651` | Not constant time; ForwardX uses `hmac.Equal` |
| HKDF-SHA1 | `0xbd7218` loads the `crypto/sha1.New` factory slot | SHA-256 is the stronger default |
| uTLS fingerprints | `0xc98642` calls `utls.UClient` | Not implemented; certificate pinning is used instead |

## Not implemented / 未实现

- Native UDP and UDP-over-TCP: neither analysis round recovered their data
  formats, so implementing them would mean inventing a protocol.
- Reverse tunnel control protocol.
- Multiplex type 5 lifecycle (no verified semantics).
- uTLS fingerprint profiles and custom HTTP templates.

## Verification

- `go vet ./...` clean; `gofmt` clean.
- `go test -count=1 ./...` passes for both `forwardx-fxp` and `internal/v3`.
- Inner layer tests cover: RFC 5869 HKDF vector, handshake round trip, wrong PSK,
  tampered proof in both directions, unsupported mode byte, per-session key
  separation, tampered record, oversized payload, multi-record writes, concurrent
  writes not interleaving, nonce exhaustion, and deadline propagation.
- Session tests cover: liveness ageing and refresh, a 512-frame control burst not
  killing the session, `tryControl` overflow being non-fatal, concurrent streams,
  slow-consumer isolation, half-close, flow control, and resource release.
- Integration tests cover: all three outer transports end to end, real TCP target
  echo, half-close, 140 logical streams over two physical sessions, multi-hop with
  per-hop keys, failed-exit fallback, reconnect after physical failure, and
  additive rule updates keeping existing TCP/UDP alive.
- **Not yet run**: `go test -race`. The local toolchain has no C compiler
  (`CGO_ENABLED=1` unavailable), so the race detector could not be built. This is
  the largest remaining verification gap given the session kernel and pool.
- Not yet done: long-duration and multi-host runs.
