package main

/*
扩展模块 "unlock"：流媒体 / AI 解锁检测（2.2.225 起），检测本身见 unlock_check.go，
面板那头见 server/ops/unlockAgent.ts。

指令（每轮重发，直到面板收到这个 runId 的 done 结果）：
  runs [{runId, family}]   family = auto / ipv4 / ipv6
上报：
  runs [{runId, family, status: running|done, startedAt, finishedAt, results: [...]}]

同一个 runId 只跑一次；几次检测排队一个一个跑（一轮要请求十来个第三方站点，不并排压）。
结果在内存里留 15 分钟、每轮都报，面板自己去重。Agent 重启丢了也没关系：面板还在等的话
会重发指令，再跑一次就是。
*/

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

const (
	unlockResultTTL = 15 * time.Minute
	unlockRunBudget = 2 * time.Minute
	unlockMaxRuns   = 8
)

type unlockRunDirective struct {
	RunID  string `json:"runId"`
	Family string `json:"family"`
}

type unlockDirective struct {
	Runs []unlockRunDirective `json:"runs"`
}

type unlockRunReport struct {
	RunID      string         `json:"runId"`
	Family     string         `json:"family"`
	Status     string         `json:"status"`
	StartedAt  int64          `json:"startedAt"`
	FinishedAt int64          `json:"finishedAt,omitempty"`
	Results    []unlockResult `json:"results,omitempty"`
}

type unlockReport struct {
	Runs []unlockRunReport `json:"runs"`
}

type unlockExtModule struct {
	mu    sync.Mutex
	runs  map[string]*unlockRunReport
	runMu sync.Mutex // 一次只跑一轮检测
	// run 由测试替换。
	run func(ctx context.Context, family string) []unlockResult
}

func newUnlockExtModule() *unlockExtModule {
	return &unlockExtModule{runs: map[string]*unlockRunReport{}, run: runUnlockForFamily}
}

func runUnlockForFamily(ctx context.Context, family string) []unlockResult {
	probe := newUnlockProbe(family, nil, nil)
	defer probe.close()
	return runUnlockChecks(ctx, probe, unlockServices)
}

func (m *unlockExtModule) Name() string { return "unlock" }

func unlockValidFamily(family string) bool {
	return family == "auto" || family == "ipv4" || family == "ipv6"
}

func (m *unlockExtModule) Report(cfg Config) any {
	m.mu.Lock()
	defer m.mu.Unlock()
	cutoff := time.Now().Add(-unlockResultTTL).Unix()
	report := unlockReport{}
	for id, r := range m.runs {
		if r.FinishedAt > 0 && r.FinishedAt < cutoff {
			delete(m.runs, id)
			continue
		}
		report.Runs = append(report.Runs, *r)
	}
	if len(report.Runs) == 0 {
		return nil
	}
	return report
}

func (m *unlockExtModule) Apply(cfg Config, directive json.RawMessage) {
	var d unlockDirective
	if err := json.Unmarshal(directive, &d); err != nil {
		logf("unlock directive invalid: %v", err)
		return
	}
	for _, run := range d.Runs {
		if opsValidID(run.RunID) && unlockValidFamily(run.Family) {
			m.start(run.RunID, run.Family)
		}
	}
}

func (m *unlockExtModule) start(runID, family string) {
	m.mu.Lock()
	if _, exists := m.runs[runID]; exists {
		m.mu.Unlock()
		return
	}
	if len(m.runs) >= unlockMaxRuns {
		m.mu.Unlock()
		return
	}
	report := &unlockRunReport{RunID: runID, Family: family, Status: "running", StartedAt: time.Now().Unix()}
	m.runs[runID] = report
	m.mu.Unlock()
	go func() {
		m.runMu.Lock()
		defer m.runMu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), unlockRunBudget)
		defer cancel()
		results := func() (results []unlockResult) {
			defer func() {
				if r := recover(); r != nil {
					logf("unlock run panic: %v", r)
					results = nil
				}
			}()
			return m.run(ctx, family)
		}()
		if results == nil {
			results = []unlockResult{}
		}
		m.mu.Lock()
		report.Results = results
		report.Status = "done"
		report.FinishedAt = time.Now().Unix()
		m.mu.Unlock()
		logf("unlock check run=%s family=%s done services=%d", runID, family, len(results))
		wakeAgentExt()
	}()
}

func init() {
	registerExtModule(newUnlockExtModule())
}
