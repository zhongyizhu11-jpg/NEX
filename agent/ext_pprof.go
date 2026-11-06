package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"runtime"
	"runtime/pprof"
	runtimetrace "runtime/trace"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
扩展模块 "pprof"：Agent 自己的性能剖析接口，默认关。

面板上（主机详情「Agent 运行状态」，管理员）点开启，指令里带一个截止时间；Agent 在
127.0.0.1:6060（被占用就换一个随机端口）开 Go 的 pprof 接口，到点自己关。只绑本机回环，
不对外：要用的人 ssh 到这台机器上执行

	go tool pprof http://127.0.0.1:6060/debug/pprof/profile?seconds=30

或者 ssh -L 6060:127.0.0.1:6060 把它转到自己电脑上。

几条保护：
  - 截止时间由 Agent 自己计时，面板失联、指令丢了也会按时关；最长 agentPprofMaxDuration。
  - 状态只在内存里：Agent 重启后是关的，面板的指令还在有效期内才会再开。
  - 不引 net/http/pprof：那个包在 init 里往 http.DefaultServeMux 注册路由，哪天有人用默认
    mux 开了个对外的服务就把剖析接口一起暴露了。这里用 runtime/pprof 自己写几个处理函数，
    挂在只属于这个监听的 mux 上。
  - 开着的时候顺带打开互斥锁 / 阻塞采样（很低的采样率），关的时候恢复成 0。

上报：{running, addr, until, error}；心跳的 agentRuntime.pprof 里也带一份（开着的时候）。
*/

const (
	agentPprofPreferredAddr = "127.0.0.1:6060"
	agentPprofMaxDuration   = 2 * time.Hour
	agentPprofMaxSeconds    = 120
	// 互斥锁采样：每 100 次争用记一次；阻塞采样：每阻塞 1 ms 记一次。只在开着的时候生效。
	agentPprofMutexFraction = 100
	agentPprofBlockRateNs   = 1_000_000
)

type agentPprofDirective struct {
	Enabled bool `json:"enabled"`
	// Until 是面板给的截止时间（Unix 秒）。
	Until int64 `json:"until"`
}

type agentPprofStatusReport struct {
	Running bool   `json:"running"`
	Addr    string `json:"addr,omitempty"`
	Until   int64  `json:"until,omitempty"`
	Error   string `json:"error,omitempty"`
}

type agentPprofServer struct {
	mu      sync.Mutex
	server  *http.Server
	addr    string
	until   time.Time
	timer   *time.Timer
	lastErr string
	// listen 在测试里换掉。
	listen func(addr string) (net.Listener, error)
	now    func() time.Time
}

var agentPprof = &agentPprofServer{
	listen: func(addr string) (net.Listener, error) { return net.Listen("tcp", addr) },
	now:    time.Now,
}

type pprofExtModule struct{}

func init() { registerExtModule(pprofExtModule{}) }

func (pprofExtModule) Name() string { return "pprof" }

func (pprofExtModule) Report(Config) any { return agentPprofStatus() }

func (pprofExtModule) Apply(_ Config, raw json.RawMessage) {
	var directive agentPprofDirective
	if err := json.Unmarshal(raw, &directive); err != nil {
		return
	}
	agentPprof.apply(directive)
}

func agentPprofStatus() agentPprofStatusReport { return agentPprof.status() }

func (s *agentPprofServer) status() agentPprofStatusReport {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.server == nil {
		return agentPprofStatusReport{Error: s.lastErr}
	}
	return agentPprofStatusReport{Running: true, Addr: s.addr, Until: s.until.Unix()}
}

func (s *agentPprofServer) apply(directive agentPprofDirective) {
	now := s.now()
	until := time.Unix(directive.Until, 0)
	if !directive.Enabled || directive.Until <= 0 || !until.After(now) {
		s.stop()
		return
	}
	if limit := now.Add(agentPprofMaxDuration); until.After(limit) {
		until = limit
	}
	s.start(until)
}

func (s *agentPprofServer) start(until time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.server != nil {
		// 已经开着：只挪截止时间。
		s.until = until
		s.resetTimerLocked()
		return
	}
	ln, err := s.listen(agentPprofPreferredAddr)
	if err != nil {
		// 6060 被别的程序占了：换一个随机端口，地址照样报给面板。
		ln, err = s.listen("127.0.0.1:0")
	}
	if err != nil {
		s.lastErr = err.Error()
		logf("agent pprof listen failed: %v", err)
		return
	}
	server := &http.Server{
		Handler:           agentPprofMux(),
		ReadHeaderTimeout: 10 * time.Second,
		// 不设 WriteTimeout：CPU 剖析和 trace 要写好几十秒。
	}
	s.server = server
	s.addr = ln.Addr().String()
	s.until = until
	s.lastErr = ""
	runtime.SetMutexProfileFraction(agentPprofMutexFraction)
	runtime.SetBlockProfileRate(agentPprofBlockRateNs)
	s.resetTimerLocked()
	go func() {
		if err := server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logf("agent pprof server stopped: %v", err)
		}
	}()
	logf("agent pprof listening on %s until %s", s.addr, until.Format(time.RFC3339))
}

func (s *agentPprofServer) resetTimerLocked() {
	if s.timer != nil {
		s.timer.Stop()
	}
	server := s.server
	s.timer = time.AfterFunc(time.Until(s.until), func() { s.stopIf(server) })
}

func (s *agentPprofServer) stop() { s.stopIf(nil) }

// stopIf 关掉剖析接口。only 不为 nil 时只关那一个（定时器到点时，期间可能已经关了又开了新的）。
func (s *agentPprofServer) stopIf(only *http.Server) {
	s.mu.Lock()
	server := s.server
	if server == nil || (only != nil && only != server) {
		s.mu.Unlock()
		return
	}
	s.server = nil
	s.addr = ""
	s.until = time.Time{}
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.mu.Unlock()
	runtime.SetMutexProfileFraction(0)
	runtime.SetBlockProfileRate(0)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		_ = server.Close()
	}
	logf("agent pprof stopped")
}

func agentPprofMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", agentPprofHandler)
	return mux
}

func agentPprofSeconds(r *http.Request, fallback int) int {
	seconds, err := strconv.Atoi(r.FormValue("seconds"))
	if err != nil || seconds <= 0 {
		seconds = fallback
	}
	return min(seconds, agentPprofMaxSeconds)
}

func agentPprofHandler(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/debug/pprof/")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	switch name {
	case "":
		profiles := pprof.Profiles()
		names := make([]string, 0, len(profiles)+2)
		for _, profile := range profiles {
			names = append(names, fmt.Sprintf("%s (%d)", profile.Name(), profile.Count()))
		}
		names = append(names, "profile?seconds=30 (CPU)", "trace?seconds=5")
		sort.Strings(names)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = fmt.Fprintf(w, "forwardx-agent pprof\n\n%s\n", strings.Join(names, "\n"))
	case "profile":
		seconds := agentPprofSeconds(r, 30)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", `attachment; filename="profile"`)
		if err := pprof.StartCPUProfile(w); err != nil {
			http.Error(w, "cpu profile: "+err.Error(), http.StatusInternalServerError)
			return
		}
		agentPprofSleep(r, seconds)
		pprof.StopCPUProfile()
	case "trace":
		seconds := agentPprofSeconds(r, 1)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", `attachment; filename="trace"`)
		if err := runtimetrace.Start(w); err != nil {
			http.Error(w, "trace: "+err.Error(), http.StatusInternalServerError)
			return
		}
		agentPprofSleep(r, seconds)
		runtimetrace.Stop()
	default:
		profile := pprof.Lookup(name)
		if profile == nil {
			http.NotFound(w, r)
			return
		}
		debug, _ := strconv.Atoi(r.FormValue("debug"))
		if name == "heap" && r.FormValue("gc") != "" {
			runtime.GC()
		}
		if debug > 0 {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		} else {
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
		}
		_ = profile.WriteTo(w, debug)
	}
}

func agentPprofSleep(r *http.Request, seconds int) {
	timer := time.NewTimer(time.Duration(seconds) * time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-r.Context().Done():
	}
}
