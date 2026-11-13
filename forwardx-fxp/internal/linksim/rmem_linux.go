//go:build linux

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// rmem 对比 net.ipv4.tcp_rmem 的中间值（每条 TCP 接收缓冲的起点）。Agent 的网络调优原来只抬上限，
// 中间值留着内核默认的 128 KiB；高延迟丢包线路上新连接的 BBR 启动阶段会被接收窗口卡住。
//
// 每个链路设定下：第 run 轮、每种路径，把几个候选值轮流（每轮换一个起点，抵消先后顺序和旁边
// 别的负载带来的噪声）设进两个命名空间，每个值都重起一对 FXP（新的 TCP、新的会话），依次跑：
//
//	ramp   一条新连接从拨号起下载 -ramp，每 500 ms 记一格速率：前 5 秒 / 前 15 秒的平均、
//	       最后一段的稳态、是否「塌了」（前 15 秒平均低于带宽的 30%）
//	rpc    一条下载跑着时另开一问一答（同 bench 的 rpc）
//	fixed  每轮 N 条流同时各下载 2 MiB 的完成时间（同 bench 的 fixed）
//
// tcp_rmem 是每个网络命名空间各一份，只改 nexsim-a / nexsim-b 里的，不影响宿主。
type rmemRecord struct {
	benchRecord
	RmemDefault int `json:"rmemDefault"`
	// ramp 快结束时出口那条（发数据的）TCP 的 ss -ti 摘要：被接收窗口卡住的时长等。
	SenderInfo string `json:"senderInfo,omitempty"`
}

const (
	wgAddrA = "10.232.0.1"
	wgAddrB = "10.232.0.2"
)

func setRmemDefault(value int) error {
	kv := fmt.Sprintf("net.ipv4.tcp_rmem=4096 %d 67108864", value)
	for _, ns := range []string{nsA, nsB} {
		if err := nsSh(ns, "sysctl", "-q", "-w", kv); err != nil {
			return err
		}
	}
	return nil
}

// startWG 在两个命名空间里各起一个 wgsim，等 WireGuard 通了（能 ping 通对端的 WireGuard 地址）。
func startWG(wg, work string) (func(), error) {
	a, err := startIn(nsA, filepath.Join(work, "wg-a.log"), wg, "-side", "a")
	if err != nil {
		return nil, err
	}
	b, err := startIn(nsB, filepath.Join(work, "wg-b.log"), wg, "-side", "b")
	if err != nil {
		a.stop()
		return nil, err
	}
	stop := func() { a.stop(); b.stop() }
	deadline := time.Now().Add(45 * time.Second) // 两端同时发起握手会撞车，WireGuard 5 秒后重试
	for {
		if exec.Command("ip", "netns", "exec", nsA, "ping", "-c", "1", "-W", "2", wgAddrB).Run() == nil {
			return stop, nil
		}
		if time.Now().After(deadline) {
			stop()
			return nil, fmt.Errorf("wireguard between %s and %s did not come up", wgAddrA, wgAddrB)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

var (
	ssBytesAcked   = regexp.MustCompile(`bytes_acked:(\d+)`)
	ssRwndLimited  = regexp.MustCompile(`rwnd_limited:(\d+)ms\(([\d.]+)%\)`)
	ssBBR          = regexp.MustCompile(`bbr:\([^)]*\)`)
	ssCwnd         = regexp.MustCompile(` cwnd:(\d+)`)
	ssDeliveryRate = regexp.MustCompile(`delivery_rate (\S+)`)
)

// senderInfo 取出口（nexsim-b）上源端口 exitPort、累计发得最多的那条 TCP 的摘要。
func senderInfo() string {
	out, err := exec.Command("ip", "netns", "exec", nsB, "ss", "-Htin", "state", "established", fmt.Sprintf("sport = :%d", exitPort)).Output()
	if err != nil {
		return ""
	}
	best, bestAcked := "", int64(-1)
	// ss -i 的输出是一行地址、下一行（缩进）详情；-H 去掉表头。
	lines := strings.Split(string(out), "\n")
	for i := 0; i+1 < len(lines); i++ {
		detail := lines[i+1]
		m := ssBytesAcked.FindStringSubmatch(detail)
		if m == nil {
			continue
		}
		acked, _ := strconv.ParseInt(m[1], 10, 64)
		if acked > bestAcked {
			bestAcked, best = acked, detail
		}
	}
	if best == "" {
		return ""
	}
	parts := []string{fmt.Sprintf("acked=%dMB", bestAcked>>20)}
	if m := ssRwndLimited.FindStringSubmatch(best); m != nil {
		parts = append(parts, "rwnd_limited="+m[1]+"ms("+m[2]+"%)")
	}
	if m := ssCwnd.FindStringSubmatch(best); m != nil {
		parts = append(parts, "cwnd="+m[1])
	}
	if m := ssDeliveryRate.FindStringSubmatch(best); m != nil {
		parts = append(parts, "delivery="+m[1])
	}
	if m := ssBBR.FindString(best); m != "" {
		parts = append(parts, m)
	}
	return strings.Join(parts, " ")
}

func cmdRmem(args []string) error {
	fs := flag.NewFlagSet("rmem", flag.ExitOnError)
	fxp := fs.String("fxp", "", "forwardx-fxp 可执行文件")
	wg := fs.String("wg", "", "wgsim 可执行文件（路径里有 v2 时要；cd agent && go build ./internal/wgsim）")
	label := fs.String("label", "rmem", "这一批结果的标签")
	out := fs.String("out", "linksim-rmem.jsonl", "结果追加到这个文件（每行一条 JSON）")
	work := fs.String("work", "", "FXP 配置和日志放哪（默认临时目录）")
	rmems := fs.String("rmems", "131072,1048576,4194304", "要比的 tcp_rmem 中间值（字节）")
	rtts := fs.String("rtts", "50,200", "往返延迟列表（毫秒）")
	losses := fs.String("losses", "0,0.5,2", "丢包率列表（百分比）")
	rate := fs.Float64("rate", 200, "瓶颈带宽 Mbit/s")
	paths := fs.String("paths", "v1,v2,v3-nomux,v3-mux", "路径列表")
	tests := fs.String("tests", "ramp,rpc,fixed", "负载列表")
	runs := fs.Int("runs", 5, "每个点跑几次")
	ramp := fs.Duration("ramp", 20*time.Second, "ramp：新连接下载多久")
	fixedStreams := fs.Int("fixed-streams", 16, "fixed 的并发流数")
	fixedRounds := fs.Int("fixed-rounds", 2, "fixed 每次跑几轮")
	_ = fs.Parse(args)
	if *fxp == "" {
		return fmt.Errorf("-fxp is required")
	}
	fxpPath, err := filepath.Abs(*fxp)
	if err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	rmemList, err := splitInts(*rmems)
	if err != nil {
		return err
	}
	rttList, err := splitInts(*rtts)
	if err != nil {
		return err
	}
	lossList, err := splitFloats(*losses)
	if err != nil {
		return err
	}
	var pathList []string
	needWG := false
	for _, p := range strings.Split(*paths, ",") {
		if p = strings.TrimSpace(p); p != "" {
			pathList = append(pathList, p)
			needWG = needWG || p == "v2"
		}
	}
	if needWG && *wg == "" {
		return fmt.Errorf("path v2 needs -wg")
	}
	testSet := map[string]bool{}
	for _, t := range strings.Split(*tests, ",") {
		testSet[strings.TrimSpace(t)] = true
	}
	workDir := *work
	if workDir == "" {
		if workDir, err = os.MkdirTemp("", "linksim-"); err != nil {
			return err
		}
	} else if err := os.MkdirAll(workDir, 0o700); err != nil {
		return err
	}
	results, err := os.OpenFile(*out, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer results.Close()

	l, cleanup, err := setupLink(linkParams{}, "tuned", nil)
	if err != nil {
		return err
	}
	defer cleanup()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() { <-sig; cleanup(); os.Exit(130) }()
	if needWG {
		stopWG, err := startWG(*wg, workDir)
		if err != nil {
			return err
		}
		defer stopWG()
	}
	sink, err := startIn(nsB, filepath.Join(workDir, "sink.log"), self, "sink", "-listen", fmt.Sprintf(":%d", sinkPort))
	if err != nil {
		return err
	}
	defer sink.stop()
	if err := waitListening(nsB, sinkPort, 5*time.Second); err != nil {
		return err
	}
	record := func(rec rmemRecord) error {
		rec.LinkAB, rec.LinkBA = l.ab.report(), l.ba.report()
		data, err := json.Marshal(rec)
		if err != nil {
			return err
		}
		_, err = results.Write(append(data, '\n'))
		summary := ""
		switch rec.Test {
		case "ramp":
			w := rampWindows(rec.Result, *rate)
			summary = fmt.Sprintf("0-5s %.0f 0-15s %.0f steady %.0f Mbit/s collapsed=%v | %s", w.first5, w.first15, w.steady, w.collapsed, rec.SenderInfo)
		case "fixed":
			summary = fmt.Sprintf("p50 %.0f ms max %.0f ms", percentile(rec.Result.DoneMs, 0.5), percentile(rec.Result.DoneMs, 1))
		case "rpc":
			summary = fmt.Sprintf("rtt p50 %.0f p99 %.0f ms, bulk %.1f Mbit/s", percentile(rec.Result.RTTMs, 0.5), percentile(rec.Result.RTTMs, 0.99), rec.Result.Mbps)
		}
		fmt.Printf("[%s] rtt=%dms loss=%.1f%% %s rmem=%dK %s run=%d: %s errors=%d\n", rec.Label, rec.RTTms, rec.LossPct, rec.Path, rec.RmemDefault>>10, rec.Test, rec.Run, summary, rec.Result.Errors)
		return err
	}
	for _, rtt := range rttList {
		for _, loss := range lossList {
			params := linkParams{OneWay: time.Duration(rtt) * time.Millisecond / 2, Loss: loss / 100, Rate: *rate * 1e6, Queue: time.Duration(rtt) * time.Millisecond}
			l.set(params)
			fmt.Printf("== %s\n", params)
			for run := 1; run <= *runs; run++ {
				for pi, path := range pathList {
					for k := range rmemList {
						rmem := rmemList[(k+run+pi)%len(rmemList)]
						if err := setRmemDefault(rmem); err != nil {
							return err
						}
						addr, stop, err := startTunnel(fxpPath, workDir, path, nil)
						if err != nil {
							return err
						}
						base := rmemRecord{benchRecord: benchRecord{Label: *label, RTTms: rtt, LossPct: loss, RateMb: *rate, Path: path, Run: run}, RmemDefault: rmem}
						fail := func(err error) error { stop(); return err }
						if testSet["ramp"] {
							l.resetStats()
							info := make(chan string, 1)
							go func() {
								time.Sleep(*ramp - time.Second)
								info <- senderInfo()
							}()
							res, err := runLoad(self, "-addr", addr, "-mode", "ramp", "-streams", "1", "-duration", ramp.String())
							if err != nil {
								return fail(err)
							}
							rec := base
							rec.Test, rec.Streams, rec.Result, rec.SenderInfo = "ramp", 1, res, <-info
							if err := record(rec); err != nil {
								return fail(err)
							}
						}
						if testSet["rpc"] {
							l.resetStats()
							res, err := runLoad(self, "-addr", addr, "-mode", "rpc", "-streams", "1", "-warm", "3s", "-measure", "7s")
							if err != nil {
								return fail(err)
							}
							rec := base
							rec.Test, rec.Streams, rec.Result = "rpc", 1, res
							if err := record(rec); err != nil {
								return fail(err)
							}
						}
						if testSet["fixed"] {
							l.resetStats()
							res, err := runLoad(self, "-addr", addr, "-mode", "fixed", "-streams", strconv.Itoa(*fixedStreams), "-bytes", strconv.Itoa(2<<20), "-rounds", strconv.Itoa(*fixedRounds))
							if err != nil {
								return fail(err)
							}
							rec := base
							rec.Test, rec.Streams, rec.Result = "fixed", *fixedStreams, res
							if err := record(rec); err != nil {
								return fail(err)
							}
						}
						stop()
					}
				}
			}
		}
	}
	return nil
}
