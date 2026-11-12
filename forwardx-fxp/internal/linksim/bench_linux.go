//go:build linux

package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// bench 跑整套矩阵。每个链路设定 × 每种路径起一对新的 FXP 进程（出口在 nexsim-b、入口在
// nexsim-a），依次跑 bulk / fixed / rpc 三种负载，每条结果一行 JSON 追加进 -out。
//
// 路径：
//
//	direct     不经隧道，压测客户端直连 nexsim-b 里的目标服务（线路本身的参照）
//	v1         FXP V1（入口 → 出口一条 TCP 跑 FXP 加密帧，每条业务连接一条 TCP）
//	v2         NEX V2 的内核数据面：两端之间一条 WireGuard（-wg 指定的 agent/internal/wgsim，wireguard-go 驱动内核
//	           TUN），FXP 以 transportVersion=v2 跑在 WireGuard 地址上（明文帧）；隧道里是内核 TCP
//	v3-nomux   NEX V3，TLS 外层，不复用（每条业务连接一条物理连接）
//	v3-mux     NEX V3，TLS 外层，多路复用（业务连接是会话里的逻辑流）
//	v3ws-nomux / v3ws-mux  同上，WS 外层
//
// 负载（都是「下载」：数据从 nexsim-b 的目标服务经出口、线路、入口流到 nexsim-a 的客户端）：
//
//	bulk   N 条流一直下载，去掉前 -warm，报测量窗口里的总速率
//	fixed  每轮 N 条流同时各下载 -bytes，报每条流的完成时间（看多路复用的队头阻塞：
//	       一条 TCP 丢一个包，所有流都等重传）
//	rpc    1 条流一直下载，-warm 之后另开一条连接一问一答（64 字节），报往返分布（交互流量被
//	       已经在跑的大流量拖慢多少）
//	rpc-shared  先开一问一答的连接、紧接着开下载：复用时两者常常落在同一条物理会话上
//	       （按流量分流只管之后来的新流），量的是交互流量和大流量挤一条 TCP 的情况
type benchRecord struct {
	Label   string     `json:"label"`
	RTTms   int        `json:"rttMs"`
	LossPct float64    `json:"lossPct"`
	RateMb  float64    `json:"rateMbps"`
	Path    string     `json:"path"`
	Test    string     `json:"test"`
	Streams int        `json:"streams"`
	Run     int        `json:"run"`
	Result  loadResult `json:"result"`
	// 这一次负载期间线路上两个方向的丢包计数（核对实际丢包率）。
	LinkAB string `json:"linkAB"`
	LinkBA string `json:"linkBA"`
}

const (
	benchKey      = "linksim-bench-key"
	sinkPort      = 7001
	exitPort      = 9000
	entryPort     = 7100
	benchTunnelID = 41
	benchRuleID   = 9
)

func pathConfig(path string) (map[string]any, error) {
	switch path {
	case "direct", "v1":
		return map[string]any{}, nil
	case "v2":
		return map[string]any{"transportVersion": "v2"}, nil
	}
	mode, mux, ok := strings.Cut(path, "-")
	if !ok || (mux != "mux" && mux != "nomux") {
		return nil, fmt.Errorf("unknown path %q", path)
	}
	cfg := map[string]any{"transportVersion": "v3", "v3Multiplex": mux == "mux"}
	switch mode {
	case "v3":
		cfg["v3Transport"] = "tls"
	case "v3ws":
		cfg["v3Transport"] = "ws"
		cfg["v3Path"] = "/linksim"
		cfg["v3Host"] = "cdn.example.test"
	default:
		return nil, fmt.Errorf("unknown path %q", path)
	}
	return cfg, nil
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func waitListening(ns string, port int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		out, _ := exec.Command("ip", "netns", "exec", ns, "ss", "-Hltn", fmt.Sprintf("sport = :%d", port)).Output()
		if strings.TrimSpace(string(out)) != "" {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("%s: nothing listening on :%d after %s", ns, port, timeout)
}

type proc struct{ cmd *exec.Cmd }

func startIn(ns, logPath string, args ...string) (*proc, error) {
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command("ip", append([]string{"netns", "exec", ns}, args...)...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return nil, err
	}
	go func() { _ = cmd.Wait(); logFile.Close() }()
	return &proc{cmd: cmd}, nil
}

func (p *proc) stop() {
	if p == nil || p.cmd.Process == nil {
		return
	}
	_ = p.cmd.Process.Signal(syscall.SIGKILL)
	time.Sleep(100 * time.Millisecond)
}

// startTunnel 起出口和入口，等两边都在监听、预热做完。返回入口地址和关掉两端的函数。
func startTunnel(fxp, work, path string, extra map[string]any) (string, func(), error) {
	transport, err := pathConfig(path)
	if err != nil {
		return "", nil, err
	}
	exit := map[string]any{
		"role": "exit", "tunnelId": benchTunnelID, "listenPort": exitPort, "protocol": "tcp", "key": benchKey,
		"streamTargets": []map[string]any{{"ruleId": benchRuleID, "targetIp": "127.0.0.1", "targetPort": sinkPort}},
	}
	entry := map[string]any{
		"role": "entry", "tunnelId": benchTunnelID, "ruleId": benchRuleID, "listenPort": entryPort, "listenHost": "127.0.0.1",
		"protocol": "tcp", "exitHost": addrB, "exitPort": exitPort, "targetIp": "127.0.0.1", "targetPort": sinkPort, "key": benchKey,
	}
	for _, cfg := range []map[string]any{exit, entry} {
		for k, v := range transport {
			cfg[k] = v
		}
		for k, v := range extra {
			cfg[k] = v
		}
	}
	if path == "v2" {
		// 和 Agent 的内核直通一样：出口监听在自己的 WireGuard 地址上，入口直接拨对端的 WireGuard 地址。
		exit["listenHost"] = wgAddrB
		entry["exitHost"] = wgAddrB
	}
	exitPath := filepath.Join(work, "exit.json")
	entryPath := filepath.Join(work, "entry.json")
	if err := writeJSON(exitPath, exit); err != nil {
		return "", nil, err
	}
	if err := writeJSON(entryPath, entry); err != nil {
		return "", nil, err
	}
	exitProc, err := startIn(nsB, filepath.Join(work, "exit.log"), fxp, "-config", exitPath)
	if err != nil {
		return "", nil, err
	}
	if err := waitListening(nsB, exitPort, 5*time.Second); err != nil {
		exitProc.stop()
		return "", nil, err
	}
	entryProc, err := startIn(nsA, filepath.Join(work, "entry.log"), fxp, "-config", entryPath)
	if err != nil {
		exitProc.stop()
		return "", nil, err
	}
	stop := func() { entryProc.stop(); exitProc.stop() }
	if err := waitListening(nsA, entryPort, 5*time.Second); err != nil {
		stop()
		return "", nil, err
	}
	// 预热（不复用时的连接池、复用时的会话）在规则起来后的一两秒内做完。
	time.Sleep(2 * time.Second)
	return fmt.Sprintf("127.0.0.1:%d", entryPort), stop, nil
}

func runLoad(self string, args ...string) (loadResult, error) {
	var res loadResult
	cmd := exec.Command("ip", append([]string{"netns", "exec", nsA, self, "load"}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return res, fmt.Errorf("load %v: %v: %s", args, err, stderr.String())
	}
	if err := json.Unmarshal(out, &res); err != nil {
		return res, fmt.Errorf("load output %q: %w", out, err)
	}
	return res, nil
}

func splitInts(s string) ([]int, error) {
	var out []int
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part == "" {
			continue
		}
		v, err := strconv.Atoi(part)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func splitFloats(s string) ([]float64, error) {
	var out []float64
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part == "" {
			continue
		}
		v, err := strconv.ParseFloat(part, 64)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func cmdBench(args []string) error {
	fs := flag.NewFlagSet("bench", flag.ExitOnError)
	fxp := fs.String("fxp", "", "forwardx-fxp 可执行文件")
	label := fs.String("label", "run", "这一批结果的标签（比如 before / after）")
	out := fs.String("out", "linksim-results.jsonl", "结果追加到这个文件（每行一条 JSON）")
	work := fs.String("work", "", "FXP 配置和日志放哪（默认临时目录）")
	rtts := fs.String("rtts", "50,200", "往返延迟列表（毫秒）")
	losses := fs.String("losses", "0,0.5,2", "丢包率列表（百分比）")
	rate := fs.Float64("rate", 200, "瓶颈带宽 Mbit/s；0 不限")
	queue := fs.Duration("queue", 0, "瓶颈队列最多排多久；0 表示等于往返延迟（一个 BDP 的缓冲）")
	paths := fs.String("paths", "v1,v3-nomux,v3-mux", "路径列表（direct / v1 / v3-nomux / v3-mux / v3ws-nomux / v3ws-mux）")
	tests := fs.String("tests", "bulk,fixed,rpc,rpc-shared", "负载列表")
	bulkStreams := fs.String("bulk-streams", "1,4,16", "bulk 的并发流数")
	fixedStreams := fs.String("fixed-streams", "4,16", "fixed 的并发流数")
	fixedBytes := fs.Uint64("fixed-bytes", 2<<20, "fixed 每条流下载多少字节")
	runs := fs.Int("runs", 3, "每个点跑几次（fixed 是轮数）")
	warm := fs.Duration("warm", 3*time.Second, "bulk / rpc 开头不算的时间")
	measure := fs.Duration("measure", 7*time.Second, "bulk / rpc 的测量窗口")
	profile := fs.String("profile", "tuned", "命名空间的 TCP 设置：tuned / stock")
	extraJSON := fs.String("fxp-extra", "", "合进两端 FXP 配置的额外字段（JSON 对象），比如 {\"tcpCongestion\":\"off\"}")
	var sysctls sysctlList
	fs.Var(&sysctls, "sysctl", "在 profile 之后再设一项（key=value，可以写多次）")
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
	var extra map[string]any
	if *extraJSON != "" {
		if err := json.Unmarshal([]byte(*extraJSON), &extra); err != nil {
			return fmt.Errorf("-fxp-extra: %w", err)
		}
	}
	rttList, err := splitInts(*rtts)
	if err != nil {
		return err
	}
	lossList, err := splitFloats(*losses)
	if err != nil {
		return err
	}
	bulkList, err := splitInts(*bulkStreams)
	if err != nil {
		return err
	}
	fixedList, err := splitInts(*fixedStreams)
	if err != nil {
		return err
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

	l, cleanup, err := setupLink(linkParams{}, *profile, sysctls)
	if err != nil {
		return err
	}
	defer cleanup()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() { <-sig; cleanup(); os.Exit(130) }()

	sink, err := startIn(nsB, filepath.Join(workDir, "sink.log"), self, "sink", "-listen", fmt.Sprintf(":%d", sinkPort))
	if err != nil {
		return err
	}
	defer sink.stop()
	if err := waitListening(nsB, sinkPort, 5*time.Second); err != nil {
		return err
	}
	testSet := map[string]bool{}
	for _, t := range strings.Split(*tests, ",") {
		testSet[strings.TrimSpace(t)] = true
	}
	record := func(rec benchRecord) error {
		rec.LinkAB, rec.LinkBA = l.ab.report(), l.ba.report()
		data, err := json.Marshal(rec)
		if err != nil {
			return err
		}
		_, err = results.Write(append(data, '\n'))
		summary := ""
		switch rec.Test {
		case "bulk":
			summary = fmt.Sprintf("%.1f Mbit/s", rec.Result.Mbps)
		case "fixed":
			summary = fmt.Sprintf("p50 %.0f ms max %.0f ms", percentile(rec.Result.DoneMs, 0.5), percentile(rec.Result.DoneMs, 1))
		case "rpc", "rpc-shared":
			summary = fmt.Sprintf("rtt p50 %.0f p99 %.0f ms, bulk %.1f Mbit/s", percentile(rec.Result.RTTMs, 0.5), percentile(rec.Result.RTTMs, 0.99), rec.Result.Mbps)
		}
		fmt.Printf("[%s] rtt=%dms loss=%.1f%% %s %s streams=%d run=%d: %s errors=%d | %s\n", rec.Label, rec.RTTms, rec.LossPct, rec.Path, rec.Test, rec.Streams, rec.Run, summary, rec.Result.Errors, rec.LinkBA)
		return err
	}
	for _, rtt := range rttList {
		for _, loss := range lossList {
			params := linkParams{OneWay: time.Duration(rtt) * time.Millisecond / 2, Loss: loss / 100, Rate: *rate * 1e6, Queue: *queue}
			if params.Queue == 0 {
				params.Queue = time.Duration(rtt) * time.Millisecond
			}
			l.set(params)
			fmt.Printf("== %s\n", params)
			for _, path := range strings.Split(*paths, ",") {
				path = strings.TrimSpace(path)
				addr := fmt.Sprintf("%s:%d", addrB, sinkPort)
				stop := func() {}
				if path != "direct" {
					if addr, stop, err = startTunnel(fxpPath, workDir, path, extra); err != nil {
						return err
					}
				}
				base := benchRecord{Label: *label, RTTms: rtt, LossPct: loss, RateMb: *rate, Path: path}
				if testSet["bulk"] {
					for _, streams := range bulkList {
						for run := 1; run <= *runs; run++ {
							l.resetStats()
							res, err := runLoad(self, "-addr", addr, "-mode", "bulk", "-streams", strconv.Itoa(streams), "-warm", warm.String(), "-measure", measure.String())
							if err != nil {
								stop()
								return err
							}
							rec := base
							rec.Test, rec.Streams, rec.Run, rec.Result = "bulk", streams, run, res
							if err := record(rec); err != nil {
								stop()
								return err
							}
						}
					}
				}
				if testSet["fixed"] {
					for _, streams := range fixedList {
						l.resetStats()
						res, err := runLoad(self, "-addr", addr, "-mode", "fixed", "-streams", strconv.Itoa(streams), "-bytes", strconv.FormatUint(*fixedBytes, 10), "-rounds", strconv.Itoa(max(*runs, 3)+2))
						if err != nil {
							stop()
							return err
						}
						rec := base
						rec.Test, rec.Streams, rec.Result = "fixed", streams, res
						if err := record(rec); err != nil {
							stop()
							return err
						}
					}
				}
				for _, rpc := range []struct {
					test  string
					extra []string
				}{{"rpc", nil}, {"rpc-shared", []string{"-probe-first"}}} {
					if !testSet[rpc.test] {
						continue
					}
					for run := 1; run <= *runs; run++ {
						l.resetStats()
						args := append([]string{"-addr", addr, "-mode", "rpc", "-streams", "1", "-warm", warm.String(), "-measure", measure.String()}, rpc.extra...)
						res, err := runLoad(self, args...)
						if err != nil {
							stop()
							return err
						}
						rec := base
						rec.Test, rec.Streams, rec.Run, rec.Result = rpc.test, 1, run, res
						if err := record(rec); err != nil {
							stop()
							return err
						}
					}
				}
				stop()
			}
		}
	}
	return nil
}
