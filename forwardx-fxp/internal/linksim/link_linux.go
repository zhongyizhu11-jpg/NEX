//go:build linux

package main

import (
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// 命名空间、网卡、地址都带 nexsim 前缀 / 用一段不常见的网段，和机器上已有的联调环境
// （client / target / hostb 命名空间、vc0 / vt0 / vb0）互不相干。
const (
	nsA   = "nexsim-a"
	nsB   = "nexsim-b"
	devA  = "nexsim-ta"
	devB  = "nexsim-tb"
	addrA = "10.231.0.1"
	addrB = "10.231.0.2"
	mtu   = 1500
)

// linkParams 是一个方向的线路参数，跑着的时候可以整体换掉（bench 换链路设定不重建网卡）。
type linkParams struct {
	OneWay time.Duration // 单向传播延迟
	Loss   float64       // 随机丢包率（0..1），每个包独立
	Rate   float64       // 瓶颈带宽（bit/s），0 表示不限
	Queue  time.Duration // 瓶颈队列最多排多久（按 Rate 折算成字节），超了尾丢
}

func (p linkParams) String() string {
	rate := "unlimited"
	if p.Rate > 0 {
		rate = fmt.Sprintf("%.0fMbit", p.Rate/1e6)
	}
	return fmt.Sprintf("rtt=%s loss=%.2f%% rate=%s queue=%s", 2*p.OneWay, p.Loss*100, rate, p.Queue)
}

type linkStats struct {
	Packets, Bytes, LossDrops, QueueDrops, Overflow atomic.Int64
}

// pipe 是一个方向：从 in 读包、按参数处理、写到 out。
type pipe struct {
	name    string
	in, out int
	params  atomic.Pointer[linkParams]
	stats   linkStats
	queue   chan packet
	rng     *rand.Rand
	nextDep time.Time // 瓶颈上一个包发完的时刻
}

type packet struct {
	buf *[]byte
	n   int
	due time.Time
}

var packetBufs = sync.Pool{New: func() any { b := make([]byte, 65536); return &b }}

func newPipe(name string, in, out int, params linkParams, seed uint64) *pipe {
	p := &pipe{name: name, in: in, out: out, queue: make(chan packet, 1<<16), rng: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))}
	p.params.Store(&params)
	return p
}

func (p *pipe) run() {
	go p.writeLoop()
	for {
		buf := packetBufs.Get().(*[]byte)
		n, err := unix.Read(p.in, *buf)
		if err != nil {
			packetBufs.Put(buf)
			if err == unix.EINTR || err == unix.EAGAIN {
				continue
			}
			return
		}
		params := p.params.Load()
		now := time.Now()
		p.stats.Packets.Add(1)
		p.stats.Bytes.Add(int64(n))
		if params.Loss > 0 && p.rng.Float64() < params.Loss {
			p.stats.LossDrops.Add(1)
			packetBufs.Put(buf)
			continue
		}
		depart := now
		if params.Rate > 0 {
			if p.nextDep.Before(now) {
				p.nextDep = now
			}
			if params.Queue > 0 && p.nextDep.Sub(now) > params.Queue {
				p.stats.QueueDrops.Add(1)
				packetBufs.Put(buf)
				continue
			}
			// 线上的字节按 IP 包长算（以太网帧头那十几个字节忽略）。
			p.nextDep = p.nextDep.Add(time.Duration(float64(n*8) / params.Rate * float64(time.Second)))
			depart = p.nextDep
		}
		select {
		case p.queue <- packet{buf: buf, n: n, due: depart.Add(params.OneWay)}:
		default:
			p.stats.Overflow.Add(1)
			packetBufs.Put(buf)
		}
	}
}

// writeLoop 按到期时间依次写出。延迟是常数、出队时刻单调，所以先进先出就是按到期时间排序。
// Go 的睡眠精度在一毫秒上下，包会以一毫秒左右为一批放出去，不影响顺序。
func (p *pipe) writeLoop() {
	for pkt := range p.queue {
		if wait := time.Until(pkt.due); wait > 0 {
			time.Sleep(wait)
		}
		for {
			_, err := unix.Write(p.out, (*pkt.buf)[:pkt.n])
			if err == unix.EINTR {
				continue
			}
			break
		}
		packetBufs.Put(pkt.buf)
	}
}

func (p *pipe) report() string {
	s := &p.stats
	packets := s.Packets.Load()
	lossPct := 0.0
	if packets > 0 {
		lossPct = float64(s.LossDrops.Load()+s.QueueDrops.Load()+s.Overflow.Load()) / float64(packets) * 100
	}
	return fmt.Sprintf("%s: %d pkts %.1f MB, random-drop %d, queue-drop %d, overflow %d (%.2f%% dropped)",
		p.name, packets, float64(s.Bytes.Load())/1e6, s.LossDrops.Load(), s.QueueDrops.Load(), s.Overflow.Load(), lossPct)
}

// link 是两块 TUN 和两个方向。
type link struct {
	ab, ba *pipe
}

func (l *link) set(params linkParams) {
	a, b := params, params
	l.ab.params.Store(&a)
	l.ba.params.Store(&b)
}

func (l *link) resetStats() {
	for _, p := range []*pipe{l.ab, l.ba} {
		p.stats.Packets.Store(0)
		p.stats.Bytes.Store(0)
		p.stats.LossDrops.Store(0)
		p.stats.QueueDrops.Store(0)
		p.stats.Overflow.Store(0)
	}
}

// openTUNIn 在命名空间 ns 里建一块 TUN（不持久：fd 关了网卡就没了），返回 fd。
// 建网卡的线程临时切进那个命名空间，建完切回来再还给运行时；切不回来就不还（协程锁着线程
// 退出，线程随之结束）。
func openTUNIn(ns, dev string) (int, error) {
	type result struct {
		fd  int
		err error
	}
	done := make(chan result, 1)
	go func() {
		runtime.LockOSThread()
		home, err := unix.Open("/proc/thread-self/ns/net", unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			done <- result{-1, err}
			return
		}
		defer unix.Close(home)
		defer func() {
			if unix.Setns(home, unix.CLONE_NEWNET) == nil {
				runtime.UnlockOSThread()
			}
		}()
		nsfd, err := unix.Open("/run/netns/"+ns, unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			done <- result{-1, err}
			return
		}
		defer unix.Close(nsfd)
		if err := unix.Setns(nsfd, unix.CLONE_NEWNET); err != nil {
			done <- result{-1, fmt.Errorf("setns %s: %w", ns, err)}
			return
		}
		fd, err := unix.Open("/dev/net/tun", unix.O_RDWR|unix.O_CLOEXEC, 0)
		if err != nil {
			done <- result{-1, err}
			return
		}
		ifr, err := unix.NewIfreq(dev)
		if err != nil {
			unix.Close(fd)
			done <- result{-1, err}
			return
		}
		ifr.SetUint16(unix.IFF_TUN | unix.IFF_NO_PI)
		if err := unix.IoctlIfreq(fd, unix.TUNSETIFF, ifr); err != nil {
			unix.Close(fd)
			done <- result{-1, fmt.Errorf("TUNSETIFF %s: %w", dev, err)}
			return
		}
		done <- result{fd, nil}
	}()
	r := <-done
	return r.fd, r.err
}

func sh(args ...string) error {
	out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func nsSh(ns string, args ...string) error {
	return sh(append([]string{"ip", "netns", "exec", ns}, args...)...)
}

// sysctlProfile 是两个命名空间里的 TCP 设置。tuned 照着 Agent 安装脚本的网络调优
// （server/agentInstallScripts.ts apply_network_tuning），stock 是内核默认 + CUBIC。
// 这些 sysctl 都是每个网络命名空间各一份，不影响宿主和别的命名空间。
func sysctlProfile(profile string) ([]string, error) {
	switch profile {
	case "tuned":
		return []string{
			"net.ipv4.tcp_congestion_control=bbr",
			"net.ipv4.tcp_rmem=4096 131072 67108864",
			"net.ipv4.tcp_wmem=4096 16384 67108864",
			"net.ipv4.tcp_notsent_lowat=131072",
			"net.ipv4.tcp_slow_start_after_idle=0",
			"net.ipv4.tcp_no_metrics_save=1",
			"net.ipv4.tcp_mtu_probing=1",
		}, nil
	case "stock":
		return []string{
			"net.ipv4.tcp_congestion_control=cubic",
			"net.ipv4.tcp_rmem=4096 131072 6291456",
			"net.ipv4.tcp_wmem=4096 16384 4194304",
			"net.ipv4.tcp_notsent_lowat=4294967295",
			"net.ipv4.tcp_slow_start_after_idle=1",
			"net.ipv4.tcp_no_metrics_save=0",
		}, nil
	}
	return nil, fmt.Errorf("unknown sysctl profile %q (tuned / stock)", profile)
}

// teardown 删掉 nexsim 的命名空间（里面的 TUN 随之消失）。只删自己的两个名字。
func teardown() {
	for _, ns := range []string{nsA, nsB} {
		if _, err := os.Stat("/run/netns/" + ns); err == nil {
			// 先杀掉还在这个命名空间里的进程（只可能是 linksim 自己起的）。不杀自己：建 TUN 的
			// 线程临时进过这个命名空间，万一没切回来，ip netns pids 会把本进程也列出来。
			self := strconv.Itoa(os.Getpid())
			if out, err := exec.Command("ip", "netns", "pids", ns).Output(); err == nil {
				for _, pid := range strings.Fields(string(out)) {
					if pid != self {
						_ = exec.Command("kill", "-9", pid).Run()
					}
				}
			}
			_ = sh("ip", "netns", "del", ns)
		}
	}
}

// setupLink 建两个命名空间和线路，返回 link 和清理函数。extra 是追加在 profile 之后的
// sysctl（key=value），后写的覆盖先写的。
func setupLink(params linkParams, profile string, extra []string) (*link, func(), error) {
	settings, err := sysctlProfile(profile)
	if err != nil {
		return nil, nil, err
	}
	settings = append(settings, extra...)
	teardown()
	cleanup := func() { teardown() }
	for _, ns := range []string{nsA, nsB} {
		if err := sh("ip", "netns", "add", ns); err != nil {
			cleanup()
			return nil, nil, err
		}
		if err := nsSh(ns, "ip", "link", "set", "lo", "up"); err != nil {
			cleanup()
			return nil, nil, err
		}
		for _, kv := range settings {
			if err := nsSh(ns, "sysctl", "-q", "-w", kv); err != nil {
				cleanup()
				return nil, nil, err
			}
		}
	}
	fdA, err := openTUNIn(nsA, devA)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	fdB, err := openTUNIn(nsB, devB)
	if err != nil {
		unix.Close(fdA)
		cleanup()
		return nil, nil, err
	}
	for _, side := range []struct{ ns, dev, local, peer string }{{nsA, devA, addrA, addrB}, {nsB, devB, addrB, addrA}} {
		steps := [][]string{
			{"ip", "addr", "add", side.local, "peer", side.peer, "dev", side.dev},
			{"ip", "link", "set", side.dev, "mtu", fmt.Sprint(mtu), "txqueuelen", "10000", "up"},
		}
		if profile == "tuned" {
			// 安装脚本设 default_qdisc=fq（BBR 配 fq 按速率均匀发包）；fq 设不上就用默认的。
			steps = append(steps, []string{"tc", "qdisc", "replace", "dev", side.dev, "root", "fq"})
		}
		for i, step := range steps {
			if err := nsSh(side.ns, step...); err != nil {
				if i == 2 {
					fmt.Fprintln(os.Stderr, "linksim: 内核没有 fq，TUN 保持默认队列（BBR 自己会按速率发包）")
					continue
				}
				unix.Close(fdA)
				unix.Close(fdB)
				cleanup()
				return nil, nil, err
			}
		}
	}
	seed := uint64(time.Now().UnixNano())
	l := &link{ab: newPipe("a->b", fdA, fdB, params, seed), ba: newPipe("b->a", fdB, fdA, params, seed+1)}
	go l.ab.run()
	go l.ba.run()
	return l, func() {
		// 先删命名空间：网卡关掉之后读协程里的 read 才会返回。
		cleanup()
		unix.Close(fdA)
		unix.Close(fdB)
	}, nil
}

// sysctlList 是可以写多次的 -sysctl 参数。
type sysctlList []string

func (l *sysctlList) String() string     { return strings.Join(*l, ",") }
func (l *sysctlList) Set(v string) error { *l = append(*l, v); return nil }

func linkFlags(fs *flag.FlagSet) func() linkParams {
	rtt := fs.Duration("rtt", 50*time.Millisecond, "往返延迟（两个方向各一半）")
	loss := fs.Float64("loss", 0, "每个方向的随机丢包率，百分比（0.5 表示 0.5%）")
	rate := fs.Float64("rate", 200, "瓶颈带宽 Mbit/s，每个方向各自一份；0 不限")
	queue := fs.Duration("queue", 0, "瓶颈队列最多排多久，超了尾丢；0 表示等于往返延迟（一个 BDP 的缓冲）")
	return func() linkParams {
		q := *queue
		if q == 0 {
			q = *rtt
		}
		return linkParams{OneWay: *rtt / 2, Loss: *loss / 100, Rate: *rate * 1e6, Queue: q}
	}
}

func cmdUp(args []string) error {
	fs := flag.NewFlagSet("up", flag.ExitOnError)
	params := linkFlags(fs)
	profile := fs.String("profile", "tuned", "命名空间里的 TCP 设置：tuned（Agent 网络调优）/ stock（内核默认 + CUBIC）")
	var extra sysctlList
	fs.Var(&extra, "sysctl", "在 profile 之后再设一项（key=value，可以写多次），比如 net.ipv4.tcp_rmem=4096 4194304 67108864")
	_ = fs.Parse(args)
	p := params()
	l, cleanup, err := setupLink(p, *profile, extra)
	if err != nil {
		return err
	}
	defer cleanup()
	fmt.Printf("linksim up: %s %s(%s) <-> %s %s(%s), %s, profile=%s\n", nsA, devA, addrA, nsB, devB, addrB, p, *profile)
	fmt.Println("Ctrl-C 退出并清理；kill -USR1 打印计数")
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM, syscall.SIGUSR1)
	for s := range sig {
		fmt.Println(l.ab.report())
		fmt.Println(l.ba.report())
		if s != syscall.SIGUSR1 {
			return nil
		}
	}
	return nil
}

func cmdDown(args []string) error {
	teardown()
	return nil
}
