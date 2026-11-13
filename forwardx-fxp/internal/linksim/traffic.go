package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// 目标服务和压测客户端之间的小协议：客户端连上先发一个字节的命令。
//
//	'D' + u64 BE n：服务端发 n 字节然后关（n=0 一直发到对端关）。模拟下载。
//	'E'：服务端把收到的原样回过来。模拟交互（一问一答）。
const (
	cmdDownload = 'D'
	cmdEcho     = 'E'
)

func cmdSink(args []string) error {
	fs := flag.NewFlagSet("sink", flag.ExitOnError)
	listen := fs.String("listen", ":7001", "监听地址")
	_ = fs.Parse(args)
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	payload := make([]byte, 256<<10)
	for i := range payload {
		payload[i] = byte(i * 31)
	}
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		go func(conn net.Conn) {
			defer conn.Close()
			var cmd [9]byte
			if _, err := io.ReadFull(conn, cmd[:1]); err != nil {
				return
			}
			switch cmd[0] {
			case cmdDownload:
				if _, err := io.ReadFull(conn, cmd[1:9]); err != nil {
					return
				}
				left := binary.BigEndian.Uint64(cmd[1:9])
				// 对端关了就停（读到 EOF / 出错）。
				go func() { _, _ = io.Copy(io.Discard, conn); _ = conn.Close() }()
				for unlimited := left == 0; unlimited || left > 0; {
					chunk := payload
					if !unlimited && uint64(len(chunk)) > left {
						chunk = chunk[:left]
					}
					n, err := conn.Write(chunk)
					if err != nil {
						return
					}
					if !unlimited {
						left -= uint64(n)
					}
				}
				if tcp, ok := conn.(*net.TCPConn); ok {
					_ = tcp.CloseWrite()
				}
			case cmdEcho:
				_, _ = io.Copy(conn, conn)
			}
		}(conn)
	}
}

// loadResult 是一次 load 的输出（一行 JSON），bench 收起来写进结果文件。
type loadResult struct {
	Mode    string `json:"mode"`
	Streams int    `json:"streams"`
	// bulk：测量窗口里的总速率和每条流的速率（Mbit/s）。
	Mbps       float64   `json:"mbps,omitempty"`
	StreamMbps []float64 `json:"streamMbps,omitempty"`
	// fixed：每条流从拨号到收完的时长（毫秒），所有轮次摊平；每轮的总时长。
	DoneMs  []float64 `json:"doneMs,omitempty"`
	RoundMs []float64 `json:"roundMs,omitempty"`
	// rpc：一问一答的往返（毫秒），以及同时跑着的下载的速率。
	RTTMs []float64 `json:"rttMs,omitempty"`
	// ramp：新连接从拨号起每 SeriesStepMs 毫秒一格的速率（Mbit/s），看启动阶段爬得多快。
	SeriesMbps   []float64 `json:"seriesMbps,omitempty"`
	SeriesStepMs int       `json:"seriesStepMs,omitempty"`
	// 失败的流（拨号、读写出错、没收完）。
	Errors int `json:"errors"`
}

func dialDownload(addr string, size uint64) (net.Conn, error) {
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return nil, err
	}
	var req [9]byte
	req[0] = cmdDownload
	binary.BigEndian.PutUint64(req[1:], size)
	if _, err := conn.Write(req[:]); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}

// countingReader 把一条连接上读到的字节数累加到 counter，直到出错。
func countingReader(conn net.Conn, counter *atomic.Int64) {
	buf := make([]byte, 256<<10)
	for {
		n, err := conn.Read(buf)
		counter.Add(int64(n))
		if err != nil {
			return
		}
	}
}

// runBulk：streams 条流一直下载，前 warm 不算，之后 measure 里的总速率。
func runBulk(addr string, streams int, warm, measure time.Duration) loadResult {
	res := loadResult{Mode: "bulk", Streams: streams}
	counters := make([]atomic.Int64, streams)
	conns := make([]net.Conn, streams)
	var wg sync.WaitGroup
	var errs atomic.Int64
	for i := 0; i < streams; i++ {
		conn, err := dialDownload(addr, 0)
		if err != nil {
			errs.Add(1)
			continue
		}
		conns[i] = conn
		wg.Add(1)
		go func(i int) { defer wg.Done(); countingReader(conn, &counters[i]) }(i)
	}
	time.Sleep(warm)
	start := make([]int64, streams)
	for i := range counters {
		start[i] = counters[i].Load()
	}
	began := time.Now()
	time.Sleep(measure)
	elapsed := time.Since(began).Seconds()
	total := int64(0)
	for i := range counters {
		got := counters[i].Load() - start[i]
		total += got
		res.StreamMbps = append(res.StreamMbps, float64(got)*8/elapsed/1e6)
		if got == 0 {
			errs.Add(1) // 测量窗口里一个字节都没收到：流卡死了
		}
	}
	res.Mbps = float64(total) * 8 / elapsed / 1e6
	for _, conn := range conns {
		if conn != nil {
			_ = conn.Close()
		}
	}
	wg.Wait()
	res.Errors = int(errs.Load())
	return res
}

// runRamp：streams 条新连接从拨号起一直下载 duration，每 step 记一次这段时间的总速率。
// 和 bulk 不同，开头不扔：量的就是新连接的启动阶段（BBR 爬坡、接收窗口从 tcp_rmem 的中间值长起来）。
func runRamp(addr string, streams int, duration, step time.Duration) loadResult {
	res := loadResult{Mode: "ramp", Streams: streams, SeriesStepMs: int(step / time.Millisecond)}
	var counter atomic.Int64
	var wg sync.WaitGroup
	var conns []net.Conn
	began := time.Now()
	for i := 0; i < streams; i++ {
		conn, err := dialDownload(addr, 0)
		if err != nil {
			res.Errors++
			continue
		}
		conns = append(conns, conn)
		wg.Add(1)
		go func() { defer wg.Done(); countingReader(conn, &counter) }()
	}
	last := int64(0)
	for i := 1; time.Duration(i)*step <= duration; i++ {
		time.Sleep(time.Until(began.Add(time.Duration(i) * step)))
		now := counter.Load()
		res.SeriesMbps = append(res.SeriesMbps, float64(now-last)*8/step.Seconds()/1e6)
		last = now
	}
	res.Mbps = float64(last) * 8 / time.Since(began).Seconds() / 1e6
	for _, conn := range conns {
		_ = conn.Close()
	}
	wg.Wait()
	return res
}

// runHold：streams 条下载连上以后一个字节都不读，撑 duration（看「对端读得慢」时接收端每条连接
// 最多攒多少数据：没有读，接收缓冲不会自动放大，攒到 tcp_rmem 的起点为止）。
func runHold(addr string, streams int, duration time.Duration) loadResult {
	res := loadResult{Mode: "hold", Streams: streams}
	var conns []net.Conn
	for i := 0; i < streams; i++ {
		conn, err := dialDownload(addr, 0)
		if err != nil {
			res.Errors++
			continue
		}
		conns = append(conns, conn)
	}
	time.Sleep(duration)
	for _, conn := range conns {
		_ = conn.Close()
	}
	return res
}

// runFixed：每轮 streams 条流同时各下载 size 字节，记每条流的完成时间。
func runFixed(addr string, streams int, size uint64, rounds int, gap time.Duration) loadResult {
	res := loadResult{Mode: "fixed", Streams: streams}
	var mu sync.Mutex
	for r := 0; r < rounds; r++ {
		start := time.Now()
		var wg sync.WaitGroup
		for i := 0; i < streams; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				conn, err := dialDownload(addr, size)
				ok := err == nil
				if ok {
					_ = conn.SetDeadline(time.Now().Add(120 * time.Second))
					n, _ := io.Copy(io.Discard, conn)
					ok = uint64(n) == size
					_ = conn.Close()
				}
				d := float64(time.Since(start).Microseconds()) / 1e3
				mu.Lock()
				if ok {
					res.DoneMs = append(res.DoneMs, d)
				} else {
					res.Errors++
				}
				mu.Unlock()
			}()
		}
		wg.Wait()
		res.RoundMs = append(res.RoundMs, float64(time.Since(start).Microseconds())/1e3)
		time.Sleep(gap)
	}
	return res
}

// runRPC：bulkStreams 条下载跑着（0 就是空载），另开一条连接每 interval 发 64 字节等回声，
// 记 measure 里每次的往返。
//
//   - 默认先开下载，等 warm（下载已经跑起来了）再开一问一答的连接：交互流量来的时候大流量
//     已经在跑（复用时池子按流量分流，该把它放到别的会话上）。
//   - probeFirst：先开一问一答的连接、走通一次，紧接着开下载，前 warm 不算：两条几乎同时开，
//     复用时常常落在同一条物理会话上（分流只管之后来的新流），量的是挤在一起时的情况。
func runRPC(addr string, bulkStreams int, probeFirst bool, interval, warm, measure time.Duration) loadResult {
	res := loadResult{Mode: "rpc", Streams: bulkStreams}
	var counter atomic.Int64
	var conns []net.Conn
	var wg sync.WaitGroup
	startBulk := func() {
		for i := 0; i < bulkStreams; i++ {
			conn, err := dialDownload(addr, 0)
			if err != nil {
				res.Errors++
				continue
			}
			conns = append(conns, conn)
			wg.Add(1)
			go func() { defer wg.Done(); countingReader(conn, &counter) }()
		}
	}
	defer func() {
		for _, conn := range conns {
			_ = conn.Close()
		}
		wg.Wait()
	}()
	if !probeFirst {
		startBulk()
		time.Sleep(warm)
	}
	probe, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		res.Errors++
		return res
	}
	defer probe.Close()
	if _, err := probe.Write([]byte{cmdEcho}); err != nil {
		res.Errors++
		return res
	}
	msg := make([]byte, 64)
	reply := make([]byte, 64)
	ping := func() (time.Duration, error) {
		began := time.Now()
		_ = probe.SetDeadline(began.Add(30 * time.Second))
		if _, err := probe.Write(msg); err != nil {
			return 0, err
		}
		if _, err := io.ReadFull(probe, reply); err != nil {
			return 0, err
		}
		return time.Since(began), nil
	}
	// 先走通一次（这条流已经在会话上了）。
	if _, err := ping(); err != nil {
		res.Errors++
		return res
	}
	warmUntil := time.Now()
	if probeFirst {
		startBulk()
		warmUntil = warmUntil.Add(warm)
	}
	for time.Now().Before(warmUntil) {
		if _, err := ping(); err != nil {
			res.Errors++
			return res
		}
		time.Sleep(interval)
	}
	startBytes, began := counter.Load(), time.Now()
	for time.Since(began) < measure {
		d, err := ping()
		if err != nil {
			res.Errors++
			break
		}
		res.RTTMs = append(res.RTTMs, float64(d.Microseconds())/1e3)
		time.Sleep(interval)
	}
	res.Mbps = float64(counter.Load()-startBytes) * 8 / time.Since(began).Seconds() / 1e6
	return res
}

func cmdLoad(args []string) error {
	fs := flag.NewFlagSet("load", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:7100", "入口地址（或直连时目标服务的地址）")
	mode := fs.String("mode", "bulk", "bulk / fixed / rpc / ramp / hold")
	streams := fs.Int("streams", 1, "并发流数（rpc：同时跑的下载流数）")
	warm := fs.Duration("warm", 3*time.Second, "bulk / rpc：开头这么久不算（建连、爬坡）")
	measure := fs.Duration("measure", 7*time.Second, "bulk / rpc：测量窗口")
	size := fs.Uint64("bytes", 2<<20, "fixed：每条流下载多少字节")
	rounds := fs.Int("rounds", 5, "fixed：跑几轮")
	gap := fs.Duration("gap", 500*time.Millisecond, "fixed：轮与轮之间歇多久")
	interval := fs.Duration("interval", 20*time.Millisecond, "rpc：两次一问一答之间歇多久")
	probeFirst := fs.Bool("probe-first", false, "rpc：先开一问一答的连接再开下载（复用时两者在同一条会话上）")
	duration := fs.Duration("duration", 20*time.Second, "ramp：从拨号起下载多久；hold：连着不读多久")
	step := fs.Duration("step", 500*time.Millisecond, "ramp：多久记一格速率")
	_ = fs.Parse(args)
	var res loadResult
	switch *mode {
	case "bulk":
		res = runBulk(*addr, *streams, *warm, *measure)
	case "fixed":
		res = runFixed(*addr, *streams, *size, *rounds, *gap)
	case "rpc":
		res = runRPC(*addr, *streams, *probeFirst, *interval, *warm, *measure)
	case "ramp":
		res = runRamp(*addr, *streams, *duration, *step)
	case "hold":
		res = runHold(*addr, *streams, *duration)
	default:
		return errors.New("unknown -mode")
	}
	return json.NewEncoder(os.Stdout).Encode(res)
}
