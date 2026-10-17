package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

/*
真运行时回归：NEX_GOST_RUNTIME_BIN=<gost-runtime/build.sh 编出来的 forwardx-runtime-linux-amd64> go test -run GostRealRuntime -v .
（要 root：套接字目录必须是 root 的。）证明：
  - 自编运行时的 Unix 套接字 API 能用、套接字是 0600；
  - 通过 API 增量加服务 / 链（含 Shadowsocks 出口链）/ 限速器后，进程 PID 不变，经另一条服务的长连接
    （TCP、UDP）一个字节都没断，新服务马上能用；
  - 增量后的线上状态和「用新配置重启」得到的状态完全相同；
  - 端口被占导致 POST 失败时，这次加的限速器也被删掉，线上状态回到旧配置；事务回滚同样只删新对象；
  - 删除规则不走 API（交给重启）；作为对照，真重启会断掉那条长连接。
*/

func freeUDPPort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

func startTCPEcho(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	return l.Addr().String()
}

func startUDPEcho(t *testing.T) string {
	t.Helper()
	c, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := c.ReadFrom(buf)
			if err != nil {
				return
			}
			c.WriteTo(buf[:n], addr)
		}
	}()
	return c.LocalAddr().String()
}

type realGostRuntime struct {
	t      *testing.T
	bin    string
	dir    string
	socket string
	cmd    *exec.Cmd
	exited chan struct{}
}

// start 和面板下发的 ExecStart 包装一样：0700 目录、删残留套接字、umask 177、exec gost。
func (r *realGostRuntime) start(configPath string) {
	r.t.Helper()
	script := fmt.Sprintf("mkdir -p -m 700 %s && chmod 700 %s && rm -f %s && umask 177 && exec %s -C %s",
		shellQuote(filepath.Dir(r.socket)), shellQuote(filepath.Dir(r.socket)), shellQuote(r.socket), shellQuote(r.bin), shellQuote(configPath))
	cmd := exec.Command("/bin/sh", "-c", script)
	logFile, err := os.OpenFile(filepath.Join(r.dir, "gost.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		r.t.Fatal(err)
	}
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		r.t.Fatal(err)
	}
	r.cmd = cmd
	r.exited = make(chan struct{})
	go func() { cmd.Wait(); logFile.Close(); close(r.exited) }()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if c, err := net.Dial("unix", r.socket); err == nil {
			c.Close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	log, _ := os.ReadFile(filepath.Join(r.dir, "gost.log"))
	r.t.Fatalf("gost API socket never came up:\n%s", log)
}

func (r *realGostRuntime) alive() bool {
	select {
	case <-r.exited:
		return false
	default:
		return r.cmd != nil && r.cmd.Process.Signal(syscall.Signal(0)) == nil
	}
}

func (r *realGostRuntime) stop() {
	if r.cmd == nil {
		return
	}
	// 只按 PID 停，绝不按名字 / 模式杀进程。
	_ = r.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-r.exited:
	case <-time.After(5 * time.Second):
		_ = r.cmd.Process.Kill()
		<-r.exited
	}
	r.cmd = nil
}

func (r *realGostRuntime) live() map[string]any {
	r.t.Helper()
	live, err := newGostAPIClient(r.socket).liveConfig(context.Background())
	if err != nil {
		r.t.Fatal(err)
	}
	return live
}

type echoConn struct {
	t      *testing.T
	conn   net.Conn
	reader *bufio.Reader
	n      int
}

func (e *echoConn) check(label string) {
	e.t.Helper()
	e.n++
	msg := fmt.Sprintf("%s-%d\n", label, e.n)
	_ = e.conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := e.conn.Write([]byte(msg)); err != nil {
		e.t.Fatalf("%s: write on long-lived connection failed: %v", label, err)
	}
	var got string
	var err error
	if e.reader != nil {
		got, err = e.reader.ReadString('\n')
	} else {
		buf := make([]byte, 256)
		var n int
		n, err = e.conn.Read(buf)
		got = string(buf[:n])
	}
	if err != nil || got != msg {
		e.t.Fatalf("%s: long-lived connection broken: got %q err=%v", label, got, err)
	}
}

func dialEcho(t *testing.T, network, addr string) *echoConn {
	t.Helper()
	c, err := net.DialTimeout(network, addr, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	e := &echoConn{t: t, conn: c}
	if network == "tcp" {
		e.reader = bufio.NewReader(c)
	}
	return e
}

func writeRealGostConfig(t *testing.T, path string, config map[string]any) (*managedConfigTransaction, []byte) {
	t.Helper()
	raw, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := applyManagedConfigs([]managedConfigSpec{{Path: path, Format: "json", ContentBase64: base64.StdEncoding.EncodeToString(raw)}})
	if err != nil {
		t.Fatal(err)
	}
	for i := range tx.backups {
		tx.backups[i].spec.ServiceName = "nex-test-runtime"
	}
	return tx, raw
}

// rollbackFileOnly：回滚事务但不去重启（测试的服务名不是真服务；需要 API 恢复的步骤不走这里）。
func rollbackFileOnly(t *testing.T, tx *managedConfigTransaction) {
	t.Helper()
	for i := range tx.backups {
		tx.backups[i].spec.ServiceName = ""
	}
	if !tx.rollback() {
		t.Fatal("transaction rollback failed")
	}
}

func cloneGostConfig(t *testing.T, config map[string]any) map[string]any {
	out, _ := gostTestJSON(t, config)
	return out
}

func TestGostRealRuntimeAPISyncKeepsEstablishedConnections(t *testing.T) {
	bin := os.Getenv("NEX_GOST_RUNTIME_BIN")
	if bin == "" {
		t.Skip("set NEX_GOST_RUNTIME_BIN to a forwardx-runtime binary built by gost-runtime/build.sh")
	}
	if os.Geteuid() != 0 {
		t.Skip("needs root: the API socket directory must be root-owned")
	}
	if !gostShellHashAvailable() {
		t.Skip("sha256sum not available")
	}
	version, _ := exec.Command(bin, "-V").CombinedOutput()
	t.Logf("runtime: %s", strings.TrimSpace(string(version)))

	dir, err := os.MkdirTemp("", "nex-gost-api-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "gost.json")
	socket := filepath.Join(dir, "gost-api", "nex-test-runtime.sock")
	rt := &realGostRuntime{t: t, bin: bin, dir: dir, socket: socket}
	defer rt.stop()

	echo1, echo2, udpEcho := startTCPEcho(t), startTCPEcho(t), startUDPEcho(t)
	port1, port2, port3, udpPort := freeTCPPort(t), freeTCPPort(t), freeTCPPort(t), freeUDPPort(t)
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()

	forward := func(name string, port int, target string) map[string]any {
		return map[string]any{
			"name": name, "addr": fmt.Sprintf("127.0.0.1:%d", port),
			"handler": map[string]any{"type": "tcp"}, "listener": map[string]any{"type": "tcp"},
			"forwarder": map[string]any{"nodes": []any{map[string]any{"name": "target-" + name, "addr": target,
				"connector": map[string]any{"type": "tcp"}, "dialer": map[string]any{"type": "tcp"}}}},
		}
	}
	// 和面板生成的 gost.json 同一个形状：限速器、隧道链（relay 连接器、selector 时长字符串）、
	// Shadowsocks 出口链、UDP 监听元数据（字符串整数）、服务元数据 dialTimeout。
	svc1 := forward("fwx-1-tcp", port1, echo1)
	svc1["limiter"] = "fwx-user-1-host-1-1000"
	udp := map[string]any{
		"name": "fwx-1-udp", "addr": fmt.Sprintf("127.0.0.1:%d", udpPort),
		"handler":  map[string]any{"type": "udp"},
		"listener": map[string]any{"type": "udp", "metadata": map[string]any{"keepalive": true, "ttl": "30s", "readBufferSize": "8192", "readQueueSize": "256", "backlog": "128"}},
		"forwarder": map[string]any{"nodes": []any{map[string]any{"name": "target-udp", "addr": udpEcho,
			"connector": map[string]any{"type": "udp"}, "dialer": map[string]any{"type": "udp"}}}},
	}
	tunnelSvc := map[string]any{
		"name": "fwx-2-tcp", "addr": "127.0.0.1:0",
		"handler":  map[string]any{"type": "tcp", "chain": "chain-tunnel-2", "retries": 1},
		"listener": map[string]any{"type": "tcp"}, "metadata": map[string]any{"dialTimeout": "3s"},
	}
	tunnelChain := map[string]any{"name": "chain-tunnel-2", "hops": []any{map[string]any{
		"name": "hop-tunnel-2", "selector": map[string]any{"strategy": "round", "maxFails": 1, "failTimeout": "15s"},
		"nodes": []any{
			map[string]any{"name": "exit-2-0", "addr": "127.0.0.1:9", "connector": map[string]any{"type": "relay", "auth": map[string]any{"username": "fwx-hop-2", "password": "p"}, "metadata": map[string]any{"nodelay": true}}, "dialer": map[string]any{"type": "tcp"}},
			map[string]any{"name": "exit-2-1", "addr": "127.0.0.1:10", "connector": map[string]any{"type": "relay", "auth": map[string]any{"username": "fwx-hop-2", "password": "p"}, "metadata": map[string]any{"nodelay": true}}, "dialer": map[string]any{"type": "tcp"}},
		},
	}}}
	limiter1 := map[string]any{"name": "fwx-user-1-host-1-1000", "limits": []any{"$ 125000000B 125000000B"}}
	api := map[string]any{"addr": "unix://" + socket}
	configA := map[string]any{"services": []any{svc1, udp, tunnelSvc}, "chains": []any{tunnelChain}, "limiters": []any{limiter1}, "api": api}

	// 新增：一条普通转发（带新限速器）+ 一条走 Shadowsocks 出口链的规则（链和服务都是新的）。
	svc3 := forward("fwx-3-tcp", port2, echo2)
	svc3["limiter"] = "fwx-user-2-host-1-500"
	egressChain := map[string]any{"name": "chain-egress-4-tcp", "hops": []any{map[string]any{"name": "hop-egress-4-tcp", "nodes": []any{map[string]any{
		"name": "egress-4-tcp", "addr": "127.0.0.1:8388",
		"connector": map[string]any{"type": "ss", "auth": map[string]any{"username": "aes-256-gcm", "password": "secret"}, "metadata": map[string]any{"nodelay": true}},
		"dialer":    map[string]any{"type": "tcp"},
	}}}}}
	svc4 := forward("fwx-4-tcp", port3, "127.0.0.1:9")
	svc4["handler"] = map[string]any{"type": "tcp", "chain": "chain-egress-4-tcp"}
	configB := cloneGostConfig(t, configA)
	// 新规则插在中间：文件里的顺序和 API 追加的顺序不同，比较要按名字。
	configB["services"] = []any{configB["services"].([]any)[0], svc3, configB["services"].([]any)[1], configB["services"].([]any)[2], svc4}
	configB["chains"] = append(configB["chains"].([]any), egressChain)
	configB["limiters"] = append(configB["limiters"].([]any), map[string]any{"name": "fwx-user-2-host-1-500", "limits": []any{"$ 62500000B 62500000B"}})
	configB = cloneGostConfig(t, configB)

	// 旧配置起进程（相当于 shell 那条重启命令跑完：配置 + .sha256）。
	_, rawA := writeRealGostConfig(t, path, configA)
	if err := os.WriteFile(path+".sha256", []byte(gostShellHash(rawA)), 0o644); err != nil {
		t.Fatal(err)
	}
	rt.start(path)
	info, err := os.Stat(socket)
	if err != nil || info.Mode().Perm() != 0o600 || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("API socket mode = %v err=%v, want 0600 socket", info.Mode(), err)
	}
	if dirInfo, _ := os.Stat(filepath.Dir(socket)); dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("API socket directory mode = %v", dirInfo.Mode())
	}
	pid := rt.cmd.Process.Pid
	t.Logf("gost started pid=%d socket=%s mode=%v", pid, socket, info.Mode().Perm())

	oldActive := gostAPISyncServiceActive
	gostAPISyncServiceActive = func(string) bool { return rt.alive() }
	defer func() { gostAPISyncServiceActive = oldActive }()
	target := gostAPISyncTarget{service: "nex-test-runtime", path: path, socket: socket, binary: bin}

	long := dialEcho(t, "tcp", fmt.Sprintf("127.0.0.1:%d", port1))
	longUDP := dialEcho(t, "udp", fmt.Sprintf("127.0.0.1:%d", udpPort))
	long.check("before-add")
	longUDP.check("udp-before-add")
	canonA, err := canonicalGostConfig(bin, rawA)
	if err != nil {
		t.Fatal(err)
	}
	if drift, err := gostConfigsEquivalent(rt.live(), canonA, true, false); err != nil || drift != "" {
		t.Fatalf("live state differs from `-O json` of the file it was started with: %q %v", drift, err)
	}

	// 1. 增量加：PID 不变，长连接不断，新服务能用。
	tx, rawB := writeRealGostConfig(t, path, configB)
	started := time.Now()
	handled, reason := gostAPISync(target, tx)
	if !handled {
		log, _ := os.ReadFile(filepath.Join(dir, "gost.log"))
		t.Fatalf("additive sync fell back reason=%s\n%s", reason, log)
	}
	t.Logf("additive sync applied in %s (limiter + ss egress chain + 2 services)", time.Since(started).Round(time.Millisecond))
	if !rt.alive() || rt.cmd.Process.Pid != pid {
		t.Fatal("runtime process was restarted")
	}
	long.check("after-add")
	longUDP.check("udp-after-add")
	dialEcho(t, "tcp", fmt.Sprintf("127.0.0.1:%d", port2)).check("new-service")
	canonB, err := canonicalGostConfig(bin, rawB)
	if err != nil {
		t.Fatal(err)
	}
	if drift, _ := gostConfigsEquivalent(rt.live(), canonB, true, false); drift != "" {
		t.Fatalf("live state after additive sync differs from new config: %s", drift)
	}

	// 2. 提交。（事务回滚要撤掉刚加的 TCP 服务，也就要断它已经接进来的连接，这一版做不到，回滚走重启成旧配置；
	//    这条路径在单元测试里测。）
	tx.commit()
	long.check("after-commit")

	// 4. 端口被占：POST 失败，这次加的限速器也删掉，线上状态回到 B，哈希记录被清掉（后面那条重启命令必须真重启）。
	configC := cloneGostConfig(t, configB)
	bad := forward("fwx-5-tcp", occupied.Addr().(*net.TCPAddr).Port, echo2)
	bad["limiter"] = "fwx-user-5-host-1-10"
	configC["services"] = append(configC["services"].([]any), bad)
	configC["limiters"] = append(configC["limiters"].([]any), map[string]any{"name": "fwx-user-5-host-1-10", "limits": []any{"$ 1250000B 1250000B"}})
	tx, _ = writeRealGostConfig(t, path, cloneGostConfig(t, configC))
	handled, reason = gostAPISync(target, tx)
	if handled || reason != "api-step-failed" {
		t.Fatalf("port conflict: handled=%v reason=%s", handled, reason)
	}
	if drift, _ := gostConfigsEquivalent(rt.live(), canonB, true, false); drift != "" {
		t.Fatalf("failed addition left objects behind: %s", drift)
	}
	if _, err := os.Stat(path + ".sha256"); !os.IsNotExist(err) {
		t.Fatal("hash record kept after failed addition")
	}
	long.check("after-failed-add")
	rollbackFileOnly(t, tx)
	// 回滚恢复了 B 的文件（运行状态也是 B）；补上哈希记录，相当于后面的重启命令跑完了。
	if err := os.WriteFile(path+".sha256", []byte(gostShellHash(rawB)), 0o644); err != nil {
		t.Fatal(err)
	}

	// 5. 删除 TCP 规则：已经接进来的连接要和重启一样断开，这一版做不到单条断开，所以不碰 API、交给重启。
	configD := cloneGostConfig(t, configB)
	configD["services"] = configD["services"].([]any)[:4]
	tx, _ = writeRealGostConfig(t, path, configD)
	if handled, reason := gostAPISync(target, tx); handled || reason != "connection-cut-unavailable" {
		t.Fatalf("tcp removal: handled=%v reason=%s", handled, reason)
	}
	if drift, _ := gostConfigsEquivalent(rt.live(), canonB, true, false); drift != "" {
		t.Fatalf("removal plan touched the runtime: %s", drift)
	}
	rollbackFileOnly(t, tx)

	// 6. 对照：用 B 真重启。线上状态和增量后的完全相同；那条长连接被重启断掉（这正是增量要避免的）。
	incremental := rt.live()
	long.check("before-restart")
	rt.stop()
	rt.start(path)
	restarted := rt.live()
	if drift, err := gostConfigsEquivalent(incremental, restarted, true, true); err != nil || drift != "" {
		t.Fatalf("incremental state differs from a restart with the full config: %q %v", drift, err)
	}
	_ = long.conn.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = long.conn.Write([]byte("after-restart\n"))
	if _, err := long.reader.ReadString('\n'); err == nil {
		t.Fatal("expected the restart to drop the long-lived connection")
	} else {
		t.Logf("control: full restart dropped the long-lived connection (%v)", err)
	}
	t.Logf("long-lived TCP connection survived %d echo round trips across 1 additive sync, 1 failed add (rolled back via API) and 1 removal that fell back", long.n-1)
}
