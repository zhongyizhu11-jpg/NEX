// ss-egress-e2e：Shadowsocks 出口端到端测试用的目标服务和客户端（见同目录 README.md）。
//
// 目标服务（serve）跑在「落地之后」：UDP 回声、TCP 回声、DNS 应答器、QUIC 回声。
// 客户端子命令都打到入口机的 gost 端口上，流量经 ss / ssu 连接器 → sing-box 落地 → 目标服务。
// 每个子命令最后打一行 "RESULT <名字> k=v ..."，失败时退出码非 0。
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	mrand "math/rand"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/quic-go/quic-go"
	"golang.org/x/net/dns/dnsmessage"
)

const quicALPN = "nex-ss-egress-e2e"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: tool serve|udp|dns|quic|soak|flows|tcp [flags]")
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "serve":
		err = runServe(args)
	case "udp":
		err = runUDP(args)
	case "dns":
		err = runDNS(args)
	case "quic":
		err = runQUIC(args)
	case "soak":
		err = runSoak(args)
	case "flows":
		err = runFlows(args)
	case "tcp":
		err = runTCP(args)
	default:
		err = fmt.Errorf("unknown command %q", cmd)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "FAIL:", err)
		os.Exit(1)
	}
}

/* ── 目标服务 ─────────────────────────────────────────────────────── */

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	udpAddr := fs.String("udp-echo", "127.0.0.1:29501", "UDP echo listen address")
	tcpAddr := fs.String("tcp-echo", "127.0.0.1:29500", "TCP echo listen address")
	dnsAddr := fs.String("dns", "127.0.0.1:29553", "DNS responder listen address (UDP)")
	quicAddr := fs.String("quic", "127.0.0.1:29443", "QUIC echo listen address")
	fs.Parse(args)

	errc := make(chan error, 4)
	go func() { errc <- serveUDPEcho(*udpAddr) }()
	go func() { errc <- serveTCPEcho(*tcpAddr) }()
	go func() { errc <- serveDNS(*dnsAddr) }()
	go func() { errc <- serveQUIC(*quicAddr) }()
	fmt.Printf("serving udp-echo=%s tcp-echo=%s dns=%s quic=%s\n", *udpAddr, *tcpAddr, *dnsAddr, *quicAddr)
	return <-errc
}

func serveUDPEcho(addr string) error {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	if uc, ok := pc.(*net.UDPConn); ok {
		uc.SetReadBuffer(8 << 20)
		uc.SetWriteBuffer(8 << 20)
	}
	buf := make([]byte, 65535)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			return err
		}
		pc.WriteTo(buf[:n], from)
	}
}

func serveTCPEcho(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go func() {
			defer c.Close()
			io.Copy(c, c)
		}()
	}
}

// dnsAnswerIP 是 name 的确定性 A 记录，客户端据此校验回答没有串、没有坏。
func dnsAnswerIP(name string) [4]byte {
	sum := sha256.Sum256([]byte(strings.ToLower(name)))
	return [4]byte{10, sum[0], sum[1], sum[2] | 1}
}

func dnsBigTXT(name string) []string {
	sum := sha256.Sum256([]byte("txt:" + strings.ToLower(name)))
	seed := hex.EncodeToString(sum[:])
	var parts []string
	for i := 0; i < 5; i++ { // 5 × 240 字节 ≈ 1.2 KB 的回答，测大 UDP 回包
		parts = append(parts, strings.Repeat(seed[:60], 4))
	}
	return parts
}

func serveDNS(addr string) error {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	buf := make([]byte, 4096)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			return err
		}
		resp, err := dnsReply(buf[:n])
		if err != nil {
			continue
		}
		pc.WriteTo(resp, from)
	}
}

func dnsReply(req []byte) ([]byte, error) {
	var p dnsmessage.Parser
	h, err := p.Start(req)
	if err != nil {
		return nil, err
	}
	q, err := p.Question()
	if err != nil {
		return nil, err
	}
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: h.ID, Response: true, Authoritative: true, RecursionDesired: h.RecursionDesired})
	b.EnableCompression()
	name := strings.TrimSuffix(q.Name.String(), ".")
	known := strings.HasSuffix(strings.ToLower(name), ".e2e.test")
	if !known {
		b = dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: h.ID, Response: true, RCode: dnsmessage.RCodeNameError})
	}
	b.StartQuestions()
	b.Question(q)
	b.StartAnswers()
	if known {
		rh := dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 60}
		switch q.Type {
		case dnsmessage.TypeA:
			b.AResource(rh, dnsmessage.AResource{A: dnsAnswerIP(name)})
		case dnsmessage.TypeTXT:
			b.TXTResource(rh, dnsmessage.TXTResource{TXT: dnsBigTXT(name)})
		}
	}
	return b.Finish()
}

func selfSignedTLS() (*tls.Config, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		DNSNames:     []string{"e2e.test"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
		NextProtos:   []string{quicALPN},
	}, nil
}

func serveQUIC(addr string) error {
	tlsConf, err := selfSignedTLS()
	if err != nil {
		return err
	}
	ln, err := quic.ListenAddr(addr, tlsConf, &quic.Config{MaxIdleTimeout: 30 * time.Second})
	if err != nil {
		return err
	}
	for {
		conn, err := ln.Accept(context.Background())
		if err != nil {
			return err
		}
		go func() {
			for {
				st, err := conn.AcceptStream(context.Background())
				if err != nil {
					return
				}
				go func() {
					defer st.Close()
					io.Copy(st, st)
				}()
			}
		}()
	}
}

/* ── 统计 ──────────────────────────────────────────────────────────── */

type durations []time.Duration

func (d durations) pct(p float64) time.Duration {
	if len(d) == 0 {
		return 0
	}
	s := append(durations(nil), d...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	idx := int(float64(len(s)-1) * p)
	return s[idx]
}

func ms(d time.Duration) string {
	return strconv.FormatFloat(float64(d)/float64(time.Millisecond), 'f', 2, 64)
}

/* ── udp：多种包长的双向回声 ─────────────────────────────────────────── */

func runUDP(args []string) error {
	fs := flag.NewFlagSet("udp", flag.ExitOnError)
	addr := fs.String("addr", "", "entry address")
	sizesFlag := fs.String("sizes", "1,64,512,1200,1400,1472", "payload sizes")
	count := fs.Int("count", 200, "packets per size")
	timeout := fs.Duration("timeout", 2*time.Second, "per-packet timeout")
	label := fs.String("label", "udp", "result label")
	fs.Parse(args)

	conn, err := net.Dial("udp", *addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	var sent, ok, lost, corrupt int
	var rtts durations
	sizes := []string{}
	buf := make([]byte, 65535)
	for _, field := range strings.Split(*sizesFlag, ",") {
		size, err := strconv.Atoi(strings.TrimSpace(field))
		if err != nil || size <= 0 {
			return fmt.Errorf("bad size %q", field)
		}
		sizeOK := 0
		for i := 0; i < *count; i++ {
			payload := make([]byte, size)
			rand.Read(payload)
			if size >= 8 {
				binary.BigEndian.PutUint64(payload, uint64(i)<<16|uint64(size))
			}
			start := time.Now()
			sent++
			if _, err := conn.Write(payload); err != nil {
				return err
			}
			conn.SetReadDeadline(time.Now().Add(*timeout))
			for {
				n, err := conn.Read(buf)
				if err != nil {
					lost++
					break
				}
				if size >= 8 && n >= 8 && !bytes.Equal(buf[:8], payload[:8]) {
					continue // 迟到的上一个包
				}
				if n != size || !bytes.Equal(buf[:n], payload) {
					corrupt++
				} else {
					ok++
					sizeOK++
					rtts = append(rtts, time.Since(start))
				}
				break
			}
		}
		sizes = append(sizes, fmt.Sprintf("%d:%d/%d", size, sizeOK, *count))
	}
	fmt.Printf("RESULT %s sent=%d ok=%d lost=%d corrupt=%d rtt_p50_ms=%s rtt_p99_ms=%s sizes=%s\n",
		*label, sent, ok, lost, corrupt, ms(rtts.pct(0.5)), ms(rtts.pct(0.99)), strings.Join(sizes, ","))
	if corrupt > 0 || ok < sent*99/100 {
		return fmt.Errorf("udp echo: ok=%d of %d, corrupt=%d", ok, sent, corrupt)
	}
	return nil
}

/* ── dns：经出口解析 ────────────────────────────────────────────────── */

func runDNS(args []string) error {
	fs := flag.NewFlagSet("dns", flag.ExitOnError)
	addr := fs.String("addr", "", "entry address")
	n := fs.Int("n", 200, "A queries")
	timeout := fs.Duration("timeout", 2*time.Second, "per-query timeout")
	label := fs.String("label", "dns", "result label")
	fs.Parse(args)

	var ok, wrong, lost, txtOK, nxOK int
	var rtts durations
	query := func(name string, qtype dnsmessage.Type) (*dnsmessage.Message, time.Duration, error) {
		conn, err := net.Dial("udp", *addr) // 每个查询一个源端口，和真实解析器一样
		if err != nil {
			return nil, 0, err
		}
		defer conn.Close()
		id := uint16(mrand.Intn(65535))
		b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: id, RecursionDesired: true})
		b.StartQuestions()
		b.Question(dnsmessage.Question{Name: dnsmessage.MustNewName(name + "."), Type: qtype, Class: dnsmessage.ClassINET})
		req, _ := b.Finish()
		start := time.Now()
		conn.Write(req)
		conn.SetReadDeadline(time.Now().Add(*timeout))
		buf := make([]byte, 4096)
		nr, err := conn.Read(buf)
		if err != nil {
			return nil, 0, err
		}
		var m dnsmessage.Message
		if err := m.Unpack(buf[:nr]); err != nil {
			return nil, 0, err
		}
		if m.Header.ID != id {
			return nil, 0, errors.New("id mismatch")
		}
		return &m, time.Since(start), nil
	}
	for i := 0; i < *n; i++ {
		name := fmt.Sprintf("host-%d-%d.e2e.test", i, mrand.Intn(1<<30))
		m, rtt, err := query(name, dnsmessage.TypeA)
		if err != nil {
			lost++
			continue
		}
		want := dnsAnswerIP(name)
		if len(m.Answers) == 1 {
			if a, isA := m.Answers[0].Body.(*dnsmessage.AResource); isA && a.A == want {
				ok++
				rtts = append(rtts, rtt)
				continue
			}
		}
		wrong++
	}
	if m, _, err := query("big.e2e.test", dnsmessage.TypeTXT); err == nil && len(m.Answers) == 1 {
		if t, isTXT := m.Answers[0].Body.(*dnsmessage.TXTResource); isTXT && strings.Join(t.TXT, "") == strings.Join(dnsBigTXT("big.e2e.test"), "") {
			txtOK = 1
		}
	}
	if m, _, err := query("missing.example", dnsmessage.TypeA); err == nil && m.Header.RCode == dnsmessage.RCodeNameError {
		nxOK = 1
	}
	fmt.Printf("RESULT %s queries=%d ok=%d wrong=%d lost=%d big_txt_ok=%d nxdomain_ok=%d rtt_p50_ms=%s rtt_p99_ms=%s\n",
		*label, *n, ok, wrong, lost, txtOK, nxOK, ms(rtts.pct(0.5)), ms(rtts.pct(0.99)))
	if wrong > 0 || ok < *n*99/100 || txtOK != 1 || nxOK != 1 {
		return errors.New("dns through egress failed")
	}
	return nil
}

/* ── quic：完整握手 + 多流数据 ─────────────────────────────────────── */

func runQUIC(args []string) error {
	fs := flag.NewFlagSet("quic", flag.ExitOnError)
	addr := fs.String("addr", "", "entry address")
	streams := fs.Int("streams", 8, "concurrent streams")
	size := fs.Int("bytes", 1<<20, "bytes per stream")
	conns := fs.Int("conns", 3, "sequential QUIC connections")
	label := fs.String("label", "quic", "result label")
	fs.Parse(args)

	var handshakes durations
	var total int64
	start := time.Now()
	for c := 0; c < *conns; c++ {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		hsStart := time.Now()
		conn, err := quic.DialAddr(ctx, *addr, &tls.Config{InsecureSkipVerify: true, NextProtos: []string{quicALPN}, ServerName: "e2e.test"}, &quic.Config{MaxIdleTimeout: 20 * time.Second})
		if err != nil {
			cancel()
			return fmt.Errorf("quic handshake %d: %w", c, err)
		}
		handshakes = append(handshakes, time.Since(hsStart))
		if got := conn.ConnectionState().TLS.NegotiatedProtocol; got != quicALPN {
			cancel()
			return fmt.Errorf("unexpected ALPN %q", got)
		}
		var wg sync.WaitGroup
		errs := make(chan error, *streams)
		for s := 0; s < *streams; s++ {
			wg.Add(1)
			go func(s int) {
				defer wg.Done()
				st, err := conn.OpenStreamSync(ctx)
				if err != nil {
					errs <- err
					return
				}
				data := make([]byte, *size)
				rand.Read(data)
				want := sha256.Sum256(data)
				go func() {
					st.Write(data)
					st.Close()
				}()
				h := sha256.New()
				n, err := io.Copy(h, st)
				if err != nil {
					errs <- fmt.Errorf("stream %d read: %w", s, err)
					return
				}
				if n != int64(*size) || !bytes.Equal(h.Sum(nil), want[:]) {
					errs <- fmt.Errorf("stream %d: got %d bytes, hash mismatch=%v", s, n, !bytes.Equal(h.Sum(nil), want[:]))
					return
				}
				atomic.AddInt64(&total, n)
			}(s)
		}
		wg.Wait()
		conn.CloseWithError(0, "done")
		cancel()
		close(errs)
		for err := range errs {
			return err
		}
	}
	elapsed := time.Since(start)
	fmt.Printf("RESULT %s conns=%d streams=%d bytes_echoed=%d handshake_p50_ms=%s handshake_max_ms=%s mbit_s=%.1f\n",
		*label, *conns, *streams, total, ms(handshakes.pct(0.5)), ms(handshakes.pct(1)), float64(total*2*8)/elapsed.Seconds()/1e6)
	return nil
}

/* ── soak：长时间稳定性 + 进程资源采样 + 空闲后恢复 ─────────────────────── */

type procSample struct {
	at         time.Duration
	rssKB      int
	threads    int
	fds        int
	goroutines int
}

func sampleProc(pid int, pprofURL string) procSample {
	s := procSample{rssKB: -1, threads: -1, fds: -1, goroutines: -1}
	if pid > 0 {
		if raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid)); err == nil {
			sc := bufio.NewScanner(bytes.NewReader(raw))
			for sc.Scan() {
				f := strings.Fields(sc.Text())
				if len(f) >= 2 && f[0] == "VmRSS:" {
					s.rssKB, _ = strconv.Atoi(f[1])
				}
				if len(f) >= 2 && f[0] == "Threads:" {
					s.threads, _ = strconv.Atoi(f[1])
				}
			}
		}
		if entries, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid)); err == nil {
			s.fds = len(entries)
		}
	}
	if pprofURL != "" {
		client := http.Client{Timeout: 5 * time.Second}
		if resp, err := client.Get(pprofURL + "/debug/pprof/goroutine?debug=1"); err == nil {
			line, _ := bufio.NewReader(resp.Body).ReadString('\n')
			resp.Body.Close()
			// "goroutine profile: total 42"
			if i := strings.LastIndex(line, " "); i > 0 {
				s.goroutines, _ = strconv.Atoi(strings.TrimSpace(line[i+1:]))
			}
		}
	}
	return s
}

type soakFlow struct {
	conn    net.Conn
	sent    atomic.Int64
	recv    atomic.Int64
	dup     atomic.Int64
	reorder atomic.Int64
	bad     atomic.Int64
	mu      sync.Mutex
	rtts    durations
	seen    map[uint64]bool
	maxSeq  uint64
	flowID  uint32
}

func runSoak(args []string) error {
	fs := flag.NewFlagSet("soak", flag.ExitOnError)
	addr := fs.String("addr", "", "entry address")
	duration := fs.Duration("duration", 10*time.Minute, "sustained traffic duration")
	pps := fs.Int("pps", 200, "packets per second (all flows together)")
	flows := fs.Int("flows", 4, "parallel flows (source ports)")
	size := fs.Int("payload", 512, "payload bytes")
	pid := fs.Int("pid", 0, "gost runtime pid to sample")
	pprofURL := fs.String("pprof", "", "gost profiling base URL (http://127.0.0.1:port)")
	sampleEvery := fs.Duration("sample", 30*time.Second, "resource sample interval")
	idle := fs.Duration("idle", 45*time.Second, "idle gap before the resume check (0 = skip)")
	label := fs.String("label", "soak", "result label")
	fs.Parse(args)

	if *size < 24 {
		*size = 24
	}
	var fl []*soakFlow
	for i := 0; i < *flows; i++ {
		c, err := net.Dial("udp", *addr)
		if err != nil {
			return err
		}
		f := &soakFlow{conn: c, seen: map[uint64]bool{}, flowID: uint32(i + 1)}
		fl = append(fl, f)
		go func(f *soakFlow) {
			buf := make([]byte, 65535)
			for {
				n, err := f.conn.Read(buf)
				if err != nil {
					return
				}
				if n != *size || binary.BigEndian.Uint32(buf[16:20]) != f.flowID {
					f.bad.Add(1)
					continue
				}
				seq := binary.BigEndian.Uint64(buf[0:8])
				sentAt := time.Unix(0, int64(binary.BigEndian.Uint64(buf[8:16])))
				f.mu.Lock()
				if f.seen[seq] {
					f.dup.Add(1)
				} else {
					f.seen[seq] = true
					if seq < f.maxSeq {
						f.reorder.Add(1)
					} else {
						f.maxSeq = seq
					}
					f.recv.Add(1)
					f.rtts = append(f.rtts, time.Since(sentAt))
				}
				f.mu.Unlock()
			}
		}(f)
	}

	begin := time.Now()
	var samples []procSample
	takeSample := func() {
		s := sampleProc(*pid, *pprofURL)
		s.at = time.Since(begin)
		samples = append(samples, s)
		fmt.Printf("sample t=%5.0fs rss_kb=%d threads=%d fds=%d goroutines=%d sent=%d recv=%d\n",
			s.at.Seconds(), s.rssKB, s.threads, s.fds, s.goroutines, sumSent(fl), sumRecv(fl))
	}
	takeSample()
	interval := time.Second / time.Duration(*pps)
	tick := time.NewTicker(interval)
	sampleTick := time.NewTicker(*sampleEvery)
	payload := make([]byte, *size)
	var seq uint64
	deadline := time.After(*duration)
loop:
	for {
		select {
		case <-tick.C:
			f := fl[int(seq)%len(fl)]
			fseq := uint64(f.sent.Add(1))
			binary.BigEndian.PutUint64(payload[0:8], fseq)
			binary.BigEndian.PutUint64(payload[8:16], uint64(time.Now().UnixNano()))
			binary.BigEndian.PutUint32(payload[16:20], f.flowID)
			f.conn.Write(payload)
			seq++
		case <-sampleTick.C:
			takeSample()
		case <-deadline:
			break loop
		}
	}
	tick.Stop()
	time.Sleep(2 * time.Second) // 收尾在途的回包
	takeSample()

	var sent, recv, dup, reorder, bad int64
	var all durations
	for _, f := range fl {
		sent += f.sent.Load()
		recv += f.recv.Load()
		dup += f.dup.Load()
		reorder += f.reorder.Load()
		bad += f.bad.Load()
		f.mu.Lock()
		all = append(all, f.rtts...)
		f.mu.Unlock()
	}
	loss := 100 * float64(sent-recv) / float64(max64(sent, 1))
	first, last := samples[1], samples[len(samples)-1]
	if len(samples) < 3 {
		first = samples[0]
	}
	fmt.Printf("RESULT %s duration_s=%.0f flows=%d pps=%d sent=%d recv=%d loss_pct=%.3f dup=%d reorder=%d bad=%d rtt_p50_ms=%s rtt_p95_ms=%s rtt_p99_ms=%s rtt_max_ms=%s rss_kb=%d->%d threads=%d->%d fds=%d->%d goroutines=%d->%d\n",
		*label, duration.Seconds(), *flows, *pps, sent, recv, loss, dup, reorder, bad,
		ms(all.pct(0.5)), ms(all.pct(0.95)), ms(all.pct(0.99)), ms(all.pct(1)),
		first.rssKB, last.rssKB, first.threads, last.threads, first.fds, last.fds, first.goroutines, last.goroutines)

	var failures []string
	if loss > 1.0 {
		failures = append(failures, fmt.Sprintf("loss %.3f%%", loss))
	}
	if bad > 0 {
		failures = append(failures, fmt.Sprintf("%d misrouted/corrupt replies", bad))
	}
	// 资源不能随时间涨：拿开头稳定后的采样和结尾比，给一点余量。
	if first.fds > 0 && last.fds > first.fds+8 {
		failures = append(failures, fmt.Sprintf("fd growth %d -> %d", first.fds, last.fds))
	}
	if first.goroutines > 0 && last.goroutines > first.goroutines+20 {
		failures = append(failures, fmt.Sprintf("goroutine growth %d -> %d", first.goroutines, last.goroutines))
	}
	if first.rssKB > 0 && last.rssKB > first.rssKB*2+32*1024 {
		failures = append(failures, fmt.Sprintf("rss growth %d -> %d KB", first.rssKB, last.rssKB))
	}

	if *idle > 0 {
		// 空闲超过 gost UDP 监听的 ttl（面板下发 30s）：入口这一侧的会话应当被回收，
		// 恢复发包时同一个客户端源端口要能重新建会话、照常收到回包。
		fmt.Printf("idle %s ...\n", *idle)
		time.Sleep(*idle)
		idleSample := sampleProc(*pid, *pprofURL)
		resumed := 0
		var resumeRTT durations
		for _, f := range fl {
			before := f.recv.Load()
			for attempt := 0; attempt < 3; attempt++ {
				fseq := uint64(f.sent.Add(1))
				binary.BigEndian.PutUint64(payload[0:8], fseq)
				binary.BigEndian.PutUint64(payload[8:16], uint64(time.Now().UnixNano()))
				binary.BigEndian.PutUint32(payload[16:20], f.flowID)
				t := time.Now()
				f.conn.Write(payload)
				waitUntil := time.Now().Add(2 * time.Second)
				for time.Now().Before(waitUntil) && f.recv.Load() == before {
					time.Sleep(5 * time.Millisecond)
				}
				if f.recv.Load() > before {
					resumed++
					resumeRTT = append(resumeRTT, time.Since(t))
					break
				}
			}
		}
		after := sampleProc(*pid, *pprofURL)
		fmt.Printf("RESULT %s-idle-resume idle_s=%.0f flows_resumed=%d/%d first_reply_ms_max=%s fds_busy=%d fds_idle=%d fds_resumed=%d goroutines_busy=%d goroutines_idle=%d goroutines_resumed=%d\n",
			*label, idle.Seconds(), resumed, len(fl), ms(resumeRTT.pct(1)), last.fds, idleSample.fds, after.fds, last.goroutines, idleSample.goroutines, after.goroutines)
		if resumed != len(fl) {
			failures = append(failures, fmt.Sprintf("only %d/%d flows resumed after idle", resumed, len(fl)))
		}
	}
	for _, f := range fl {
		f.conn.Close()
	}
	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	return nil
}

func sumSent(fl []*soakFlow) (n int64) {
	for _, f := range fl {
		n += f.sent.Load()
	}
	return
}

func sumRecv(fl []*soakFlow) (n int64) {
	for _, f := range fl {
		n += f.recv.Load()
	}
	return
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

/* ── flows：大量并发 UDP 流的隔离 ──────────────────────────────────────── */

func runFlows(args []string) error {
	fs := flag.NewFlagSet("flows", flag.ExitOnError)
	addr := fs.String("addr", "", "entry address")
	n := fs.Int("flows", 200, "simultaneous UDP flows (one source port each)")
	rounds := fs.Int("rounds", 20, "packets per flow")
	size := fs.Int("payload", 256, "payload bytes")
	label := fs.String("label", "flows", "result label")
	fs.Parse(args)

	var ok, lost, foreign, corrupt atomic.Int64
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < *n; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			conn, err := net.Dial("udp", *addr)
			if err != nil {
				lost.Add(int64(*rounds))
				return
			}
			defer conn.Close()
			buf := make([]byte, 65535)
			for r := 0; r < *rounds; r++ {
				payload := make([]byte, *size)
				rand.Read(payload)
				binary.BigEndian.PutUint32(payload[0:4], uint32(id))
				binary.BigEndian.PutUint32(payload[4:8], uint32(r))
				got := false
				for attempt := 0; attempt < 3 && !got; attempt++ {
					conn.Write(payload)
					conn.SetReadDeadline(time.Now().Add(1500 * time.Millisecond))
					for {
						nr, err := conn.Read(buf)
						if err != nil {
							break
						}
						if nr < 8 || binary.BigEndian.Uint32(buf[0:4]) != uint32(id) {
							foreign.Add(1) // 别的流的回包串到了这个源端口
							continue
						}
						if binary.BigEndian.Uint32(buf[4:8]) != uint32(r) {
							continue // 本流迟到的重传回包
						}
						if nr != *size || !bytes.Equal(buf[:nr], payload) {
							corrupt.Add(1)
						} else {
							ok.Add(1)
						}
						got = true
						break
					}
				}
				if !got {
					lost.Add(1)
				}
			}
		}(i)
	}
	wg.Wait()
	total := int64(*n * *rounds)
	fmt.Printf("RESULT %s flows=%d packets=%d ok=%d lost=%d foreign=%d corrupt=%d elapsed_s=%.1f\n",
		*label, *n, total, ok.Load(), lost.Load(), foreign.Load(), corrupt.Load(), time.Since(start).Seconds())
	if foreign.Load() > 0 || corrupt.Load() > 0 || ok.Load() < total*99/100 {
		return errors.New("udp flow isolation failed")
	}
	return nil
}

/* ── tcp：并发 TCP 连接的字节级回声 ─────────────────────────────────── */

func runTCP(args []string) error {
	fs := flag.NewFlagSet("tcp", flag.ExitOnError)
	addr := fs.String("addr", "", "entry address")
	conns := fs.Int("conns", 32, "concurrent connections")
	size := fs.Int("bytes", 4<<20, "bytes per connection")
	label := fs.String("label", "tcp", "result label")
	// 默认不半关闭：gost 的 ss 连接器不支持 CloseWrite，客户端一半关，整条出口连接就被关掉
	// （上游行为，经 Shadowsocks 出口的 TCP 现在就是这样，见 README）。
	halfClose := fs.Bool("half-close", false, "CloseWrite after sending")
	fs.Parse(args)

	var ok, failed atomic.Int64
	var firstErr atomic.Value
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < *conns; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := func() error {
				c, err := net.DialTimeout("tcp", *addr, 10*time.Second)
				if err != nil {
					return err
				}
				defer c.Close()
				c.SetDeadline(time.Now().Add(120 * time.Second))
				data := make([]byte, *size)
				rand.Read(data)
				want := sha256.Sum256(data)
				go func() {
					c.Write(data)
					if tc, ok := c.(*net.TCPConn); ok && *halfClose {
						tc.CloseWrite()
					}
				}()
				h := sha256.New()
				n, err := io.CopyN(h, c, int64(*size))
				if err != nil {
					return fmt.Errorf("read %d/%d: %w", n, *size, err)
				}
				if !bytes.Equal(h.Sum(nil), want[:]) {
					return errors.New("hash mismatch")
				}
				return nil
			}()
			if err != nil {
				failed.Add(1)
				firstErr.CompareAndSwap(nil, err.Error())
				return
			}
			ok.Add(1)
		}()
	}
	wg.Wait()
	elapsed := time.Since(start)
	fmt.Printf("RESULT %s conns=%d ok=%d failed=%d bytes_each=%d mbit_s=%.1f\n",
		*label, *conns, ok.Load(), failed.Load(), *size, float64(int64(*conns)*int64(*size)*2*8)/elapsed.Seconds()/1e6)
	if failed.Load() > 0 {
		return fmt.Errorf("tcp echo failed: %v", firstErr.Load())
	}
	return nil
}
