package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// recordingConn 录下客户端一侧收发的全部字节，模拟路径上的攻击者。
type recordingConn struct {
	net.Conn
	mu   sync.Mutex
	sent bytes.Buffer
	recv bytes.Buffer
}

func (c *recordingConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	c.mu.Lock()
	c.sent.Write(p[:n])
	c.mu.Unlock()
	return n, err
}

func (c *recordingConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.mu.Lock()
	c.recv.Write(p[:n])
	c.mu.Unlock()
	return n, err
}

func (c *recordingConn) snapshot() (sent, recv []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.sent.Bytes()...), append([]byte(nil), c.recv.Bytes()...)
}

// swapReplayCacheForTest 把全局重放缓存换成空的（在锁里改，不和别的协程抢），
// 模拟「缓存过期 / 进程重启 / 换了一台共用密钥的出口」。floor 是新的时间戳下限。
func swapReplayCacheForTest(t *testing.T, floor int64) {
	t.Helper()
	fxpReplaySeen.mu.Lock()
	savedSeen, savedExpiry, savedFloor := fxpReplaySeen.seen, fxpReplaySeen.expiry, fxpReplaySeen.floor
	fxpReplaySeen.seen, fxpReplaySeen.expiry, fxpReplaySeen.floor = map[string]time.Time{}, nil, floor
	fxpReplaySeen.mu.Unlock()
	t.Cleanup(func() {
		fxpReplaySeen.mu.Lock()
		fxpReplaySeen.seen, fxpReplaySeen.expiry, fxpReplaySeen.floor = savedSeen, savedExpiry, savedFloor
		fxpReplaySeen.mu.Unlock()
	})
}

// replayBytes 把录下的字节原样打给一个新连接的服务端，同时把服务端回的都读走。
func replayBytes(t *testing.T, recorded []byte) (net.Conn, net.Conn, <-chan []byte) {
	t.Helper()
	attacker, server := tcpLoopbackPair(t)
	go func() { _, _ = attacker.Write(recorded) }()
	replies := make(chan []byte, 1)
	go func() {
		_ = attacker.SetReadDeadline(time.Now().Add(3 * time.Second))
		got, _ := io.ReadAll(attacker)
		replies <- got
	}()
	return attacker, server, replies
}

func TestFxpRejectsReplaySalt(t *testing.T) {
	cfg := config{Role: "exit", TunnelID: 77, RuleID: 0, ListenPort: 12345, Key: "replay-key"}
	clientConn, serverConn := tcpLoopbackPair(t)
	serverErr := make(chan error, 1)
	go func() {
		sec, err := newServerSecureConn(serverConn, cfg)
		if err == nil {
			_, err = sec.readFrame()
		}
		serverErr <- err
	}()
	rec := &recordingConn{Conn: clientConn}
	client, err := newClientSecureConn(rec, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.writeFrame([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := <-serverErr; err != nil {
		t.Fatalf("first handshake failed: %v", err)
	}

	sent, _ := rec.snapshot()
	_, replayServer, _ := replayBytes(t, sent)
	if _, err := newServerSecureConn(replayServer, cfg); err == nil || !strings.Contains(err.Error(), "replay") {
		t.Fatalf("expected replayed salt to be rejected, got %v", err)
	}
}

// 录下一条完整的入口 → 出口会话，出口重启（重放缓存清空）之后原样重放：
// 以前出口会接受、照 hello 再拨一次目标、把录下的上行数据再发一遍，回程还用
// 原会话的密钥和 nonce 加密。现在启动前生成的握手一律不收，目标一次也不会被拨。
func TestFxpReplayedSessionAfterRestartIsNotDialled(t *testing.T) {
	targetPort, accepted := countingTCPTarget(t)
	cfg := config{Role: "exit", TunnelID: 78, Key: "replay-restart-key", StreamTargets: loopbackStreamTargets(79, targetPort)}
	hello := `{"network":"tcp","targetIp":"127.0.0.1","targetPort":` + strconv.Itoa(targetPort) + `,"tunnelId":78,"ruleId":79}`

	clientConn, serverConn := tcpLoopbackPair(t)
	go func() { _ = handleExitSession(serverConn, cfg) }()
	rec := &recordingConn{Conn: clientConn}
	sec, err := newPipelinedClientSecureConn(rec, cfg, fxpWireCurrent)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeSecureFramesWithDeadline(sec, []byte(hello), []byte("first-flight")); err != nil {
		t.Fatal(err)
	}
	_ = clientConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if reply, err := sec.readFrame(); err != nil || string(reply) != "first-flight" {
		t.Fatalf("original session: %q %v", reply, err)
	}
	if err := sec.writeFrame([]byte("after-ack")); err != nil {
		t.Fatal(err)
	}
	if reply, err := sec.readFrame(); err != nil || string(reply) != "after-ack" {
		t.Fatalf("original session after ack: %q %v", reply, err)
	}
	<-accepted
	_ = clientConn.Close()

	// 「重启」：缓存是空的，下限是现在。
	time.Sleep(5 * time.Millisecond)
	swapReplayCacheForTest(t, time.Now().UnixMilli())
	sent, _ := rec.snapshot()
	_, replayServer, replies := replayBytes(t, sent)
	if err := handleExitSession(replayServer, cfg); err == nil || !strings.Contains(err.Error(), "replay") {
		t.Fatalf("replay after restart should be rejected, got %v", err)
	}
	if got := <-replies; len(got) != 0 {
		t.Fatalf("出口不该给重放的握手回任何东西，回了 %d 字节", len(got))
	}
	expectNoDial(t, accepted, 150*time.Millisecond)
}

// 窗口之内、缓存里没有（另一台共用隧道密钥的出口）的重放：握手会被接受，这是
// 省掉一个往返的代价；但服务端 salt 是新的，回程密钥和原会话完全不同，不会
// 重用 nonce，确认之后录下的客户端帧也放不进去。
func TestFxpReplayWithinWindowGetsFreshSessionKeys(t *testing.T) {
	cfg := config{Role: "exit", TunnelID: 80, Key: "replay-fresh-keys"}
	clientConn, serverConn := tcpLoopbackPair(t)
	type serverResult struct {
		frames [][]byte
		err    error
	}
	originalResult := make(chan serverResult, 1)
	go func() {
		var result serverResult
		sec, err := newServerSecureConn(serverConn, cfg)
		for err == nil && len(result.frames) < 2 {
			var frame []byte
			if frame, err = sec.readFrame(); err == nil {
				// readFrame 返回的切片只在下一次读之前有效，留着比较要拷一份。
				result.frames = append(result.frames, append([]byte(nil), frame...))
				if len(result.frames) == 1 {
					err = sec.writeFrame([]byte("response"))
				}
			}
		}
		result.err = err
		originalResult <- result
	}()
	rec := &recordingConn{Conn: clientConn}
	sec, err := newPipelinedClientSecureConn(rec, cfg, fxpWireCurrent)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeSecureFramesWithDeadline(sec, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	_ = clientConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if reply, err := sec.readFrame(); err != nil || string(reply) != "response" {
		t.Fatalf("original response: %q %v", reply, err)
	}
	if err := sec.writeFrame([]byte("late")); err != nil {
		t.Fatal(err)
	}
	original := <-originalResult
	if original.err != nil || string(original.frames[0]) != "hello" || string(original.frames[1]) != "late" {
		t.Fatalf("original server: %q %v", original.frames, original.err)
	}
	sent, recv := rec.snapshot()

	swapReplayCacheForTest(t, 0)
	_, replayServer, replies := replayBytes(t, sent)
	replaySec, err := newServerSecureConn(replayServer, cfg)
	if err != nil {
		t.Fatalf("窗口内缓存未命中时握手本身会被接受：%v", err)
	}
	if frame, err := replaySec.readFrame(); err != nil || string(frame) != "hello" {
		t.Fatalf("首轮帧：%q %v", frame, err)
	}
	if frame, err := replaySec.readFrame(); err == nil {
		t.Fatalf("确认之后的客户端帧用的是原会话的密钥，重放时不该解得开：%q", frame)
	}
	_ = replayServer.Close()
	replayed := <-replies

	// 两次的服务端 salt 不同，回程密钥也就不同：拿原会话的回程密钥解不开重放
	// 那次的确认帧。
	if len(recv) < fxpSaltSize+20 || len(replayed) < fxpSaltSize+20 {
		t.Fatalf("没有录到服务端的确认：original=%d replayed=%d", len(recv), len(replayed))
	}
	originalSalt, replaySalt := recv[:fxpSaltSize], replayed[:fxpSaltSize]
	if bytes.Equal(originalSalt, replaySalt) {
		t.Fatal("服务端每次握手都应该换新 salt")
	}
	master := sha256.Sum256([]byte(cfg.Key))
	originalKeys, err := deriveFXPSessionAEADs(master[:], fxpFinalSessionSalt(sent[:fxpSaltSize], originalSalt), fxpFinalSessionInfo(fxpWireCurrent), fxpWireCurrent)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptFXPFrameLength(originalKeys.s2cLen, fxpExitToEntry, 0, recv[fxpSaltSize:fxpSaltSize+20], fxpLengthAD); err != nil {
		t.Fatalf("原会话的确认帧应该能用原会话密钥解开：%v", err)
	}
	if _, err := decryptFXPFrameLength(originalKeys.s2cLen, fxpExitToEntry, 0, replayed[fxpSaltSize:fxpSaltSize+20], fxpLengthAD); err == nil {
		t.Fatal("重放那次的回程用的还是原会话的密钥（nonce 重用）")
	}
}

// 握手的时间戳必须在窗口以内：录下来的握手过了窗口（缓存早就忘了它）照样被拒。
func TestFxpHandshakeOutsideWindowIsRejected(t *testing.T) {
	cfg := config{Role: "exit", TunnelID: 81, Key: "handshake-window-key"}
	for _, offset := range []time.Duration{-fxpHandshakeWindow - time.Second, fxpHandshakeWindow + time.Second} {
		salt := make([]byte, fxpSaltSize)
		if _, err := rand.Read(salt); err != nil {
			t.Fatal(err)
		}
		clientConn, serverConn := tcpLoopbackPair(t)
		client, err := newSessionSecureConn(clientConn, cfg.Key, salt, true)
		if err != nil {
			t.Fatal(err)
		}
		hs, _ := json.Marshal(fxpHandshake{V: fxpHandshakeVersion, TSMilli: time.Now().Add(offset).UnixMilli(), TunnelID: cfg.TunnelID})
		client.pendingPrefix = salt
		if err := client.writeFrame(hs); err != nil {
			t.Fatal(err)
		}
		if _, err := newServerSecureConn(serverConn, cfg); err == nil || !strings.Contains(err.Error(), "window") {
			t.Fatalf("offset %s: expected window rejection, got %v", offset, err)
		}
		fxpReplaySeen.mu.Lock()
		_, cached := fxpReplaySeen.seen[replayKey(cfg, salt)]
		fxpReplaySeen.mu.Unlock()
		if cached {
			t.Fatalf("offset %s: 被拒的握手不该进缓存", offset)
		}
	}
}

// 老版本（握手版本 2）的对端直接被拒，而不是解密失败得莫名其妙。
func TestFxpHandshakeRejectsOldVersion(t *testing.T) {
	cfg := config{Role: "exit", TunnelID: 82, Key: "handshake-version-key"}
	frame, _ := json.Marshal(map[string]any{"v": 2, "ts": time.Now().Unix(), "tunnelId": cfg.TunnelID})
	if _, err := validateServerHandshake(cfg, frame, time.Now()); err == nil {
		t.Fatal("version 2 handshake should be rejected")
	}
}

func TestStampedReplayCacheFloor(t *testing.T) {
	now := time.Unix(1000, 0)
	cache := newStampedReplayCache(time.Minute, 2, 100)
	if cache.addStampedAt("old", 100, now, true) {
		t.Fatal("下限（含）以下的时间戳应该被拒")
	}
	for index, key := range []string{"a", "b", "c"} {
		if !cache.addStampedAt(key, int64(200+index), now, true) {
			t.Fatalf("%s rejected", key)
		}
	}
	// 容量 2，a 被挤掉；缓存认不出 a 了，下限抬到 a 的时间戳挡住它。
	if cache.floor != 200 {
		t.Fatalf("floor=%d want 200", cache.floor)
	}
	if cache.addStampedAt("a", 200, now, true) {
		t.Fatal("被挤出缓存的记录重放时应该被下限挡住")
	}
	if !cache.addStampedAt("d", 300, now, true) {
		t.Fatal("新的时间戳应该照常接受")
	}
	// 不带时间戳的用法不受下限影响。
	if !cache.addAt("plain", now) {
		t.Fatal("plain add rejected")
	}
}
