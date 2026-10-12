package main

// 扩展模块 "quota"：流量用尽、选了「立即断开」时，把内核转发（iptables / nftables）端口上
// 已经建立的连接从 conntrack 里清掉。面板那头见 server/ops/quotaAgent.ts。
//
// 为什么要清：规则停下时 Agent 只删 DNAT 和计数规则，conntrack 里已建立的连接照样转发，
// 一直跑到自己断开 —— 而且计数规则没了，这段流量谁也不算。进程类转发（realm / gost /
// ForwardX）没有这个问题：进程一停连接就断。
//
// 指令每轮都会重发，所以按 key 记住清过的：第一次看到清一次，30 秒后再清一次兜底
// （第一次可能赶在 DNAT 撤掉之前，新连接又建起来了），之后不再动。指令里没了的 key 就忘掉。

import (
	"encoding/json"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

const quotaSecondFlushDelay = 30 * time.Second

type quotaFlushItem struct {
	Key      string `json:"key"`
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
}

type quotaDirective struct {
	Mode  string           `json:"mode"`
	Flush []quotaFlushItem `json:"flush"`
}

type quotaFlushState struct {
	firstAt time.Time
	count   int
}

type quotaExtModule struct {
	mu      sync.Mutex
	state   map[string]*quotaFlushState
	flushed int
	// 测试里替换：真正执行 conntrack -D
	runDelete func(protocol string, port int)
	lookPath  func() bool
	now       func() time.Time
}

func newQuotaExtModule() *quotaExtModule {
	return &quotaExtModule{
		state:     map[string]*quotaFlushState{},
		runDelete: conntrackDeletePort,
		lookPath:  conntrackAvailable,
		now:       time.Now,
	}
}

func init() {
	registerExtModule(newQuotaExtModule())
}

func (m *quotaExtModule) Name() string { return "quota" }

func (m *quotaExtModule) Report(cfg Config) any {
	m.mu.Lock()
	defer m.mu.Unlock()
	return map[string]any{"conntrack": m.lookPath(), "flushed": m.flushed}
}

func (m *quotaExtModule) Apply(cfg Config, directive json.RawMessage) {
	var d quotaDirective
	if err := json.Unmarshal(directive, &d); err != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	wanted := make(map[string]bool, len(d.Flush))
	for _, item := range d.Flush {
		wanted[item.Key] = true
	}
	for key := range m.state {
		if !wanted[key] {
			delete(m.state, key)
		}
	}
	if d.Mode != "cut" || len(d.Flush) == 0 || !m.lookPath() {
		return
	}
	now := m.now()
	for _, item := range d.Flush {
		if item.Key == "" || item.Port <= 0 || item.Port > 65535 {
			continue
		}
		st := m.state[item.Key]
		if st == nil {
			st = &quotaFlushState{firstAt: now}
			m.state[item.Key] = st
		}
		due := st.count == 0 || (st.count == 1 && now.Sub(st.firstAt) >= quotaSecondFlushDelay)
		if !due {
			continue
		}
		for _, proto := range quotaProtocols(item.Protocol) {
			m.runDelete(proto, item.Port)
		}
		if st.count == 0 {
			m.flushed++
			logf("quota: cleared established connections on port %d (%s) key=%s", item.Port, item.Protocol, item.Key)
		}
		st.count++
	}
}

func quotaProtocols(protocol string) []string {
	switch protocol {
	case "tcp":
		return []string{"tcp"}
	case "udp":
		return []string{"udp"}
	default:
		return []string{"tcp", "udp"}
	}
}

func conntrackAvailable() bool {
	_, err := exec.LookPath("conntrack")
	return err == nil
}

// conntrack -D 没匹配到任何连接时退出码是 1，这是正常情况，不记错误。
func conntrackDeletePort(protocol string, port int) {
	_, _ = commandCombinedOutputWithTimeout(10*time.Second, "conntrack", "-D", "-p", protocol, "--orig-port-dst", strconv.Itoa(port))
}
