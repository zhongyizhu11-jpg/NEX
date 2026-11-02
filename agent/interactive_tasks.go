package main

import (
	"context"
	"strings"
	"sync"
	"time"
)

/*
交互任务（Looking Glass、一键诊断、规则连接清单、iperf3 服务端）跟着心跳下来，原来每个任务直接
开一个 goroutine，只靠面板去重。面板异常或重复下发时，Agent 会同时跑一堆 iperf3 / mtr，占满机器。

这里照插件任务那套收一道：

	按「种类 + 任务 ID」去重：同一个任务还在排队或在跑，再来一次直接忽略（结果会照常回报）。
	全局最多同时跑 interactiveTaskMaxRunning 个，再多的排队，队列最多 interactiveTaskQueueCapacity 个；
	  队列也满了就立刻给面板回一条「任务太多」的失败结果，不再悄悄丢掉。
	排队超过 interactiveTaskQueueWait 还没轮到，也回一条失败结果。
	每个任务带一个总时限的 context，各执行函数在它到期时收尾。
*/

const (
	interactiveTaskMaxRunning          = 4
	interactiveTaskQueueCapacity       = 16
	interactiveTaskQueueWait           = 2 * time.Minute
	interactiveTaskBusyMessage         = "Agent 上同时在跑的测试太多，请稍后再试"
	interactiveTaskQueueTimeoutMessage = "Agent 上排队等待太久，已放弃，请稍后再试"
)

// 各类交互任务的总时限（拿到执行名额之后算起）。都比任务自己的时限宽一些，只用来兜底。
const (
	lookingGlassTaskMaxDuration    = 2 * time.Minute
	diagnosticsTaskHardTimeout     = diagnosticsMaxTaskDuration + 15*time.Second
	ruleConnectionsTaskHardTimeout = ruleConnectionsMaxDuration + 7*time.Second
	iperf3TaskHardTimeout          = 30 * time.Second
)

type interactiveTaskLimiter struct {
	maxRunning int
	maxQueued  int
	queueWait  time.Duration

	slots chan struct{}

	mu      sync.Mutex
	pending map[string]bool // 排队或在跑的任务
	queued  int
}

func newInteractiveTaskLimiter(maxRunning, maxQueued int, queueWait time.Duration) *interactiveTaskLimiter {
	if maxRunning < 1 {
		maxRunning = 1
	}
	if maxQueued < 0 {
		maxQueued = 0
	}
	return &interactiveTaskLimiter{
		maxRunning: maxRunning,
		maxQueued:  maxQueued,
		queueWait:  queueWait,
		slots:      make(chan struct{}, maxRunning),
		pending:    map[string]bool{},
	}
}

var interactiveTasks = newInteractiveTaskLimiter(interactiveTaskMaxRunning, interactiveTaskQueueCapacity, interactiveTaskQueueWait)

// interactiveTaskDispatch 描述一个要跑的交互任务。
type interactiveTaskDispatch struct {
	kind    string
	taskID  string
	timeout time.Duration
	// run 在拿到执行名额后调用，ctx 带总时限。run 自己负责把结果回报给面板。
	run func(ctx context.Context)
	// reject 在任务被拒（队列满、排队超时）时调用，用来给面板回一条失败结果。
	reject func(reason string)
}

// dispatch 是非阻塞的：返回值说明任务是被接下（true）、还是因为重复被忽略或因为太多被拒（false）。
func (l *interactiveTaskLimiter) dispatch(job interactiveTaskDispatch) bool {
	key := ""
	if id := strings.TrimSpace(job.taskID); id != "" {
		key = job.kind + ":" + id
	}
	l.mu.Lock()
	if key != "" && l.pending[key] {
		l.mu.Unlock()
		return false
	}
	// 能立刻拿到名额就直接跑；拿不到再看队列还有没有位置。
	immediate := false
	select {
	case l.slots <- struct{}{}:
		immediate = true
	default:
	}
	if !immediate && l.queued >= l.maxQueued {
		l.mu.Unlock()
		if job.reject != nil {
			go job.reject(interactiveTaskBusyMessage)
		}
		return false
	}
	if key != "" {
		l.pending[key] = true
	}
	if !immediate {
		l.queued++
	}
	l.mu.Unlock()

	go func() {
		defer func() {
			if key != "" {
				l.mu.Lock()
				delete(l.pending, key)
				l.mu.Unlock()
			}
		}()
		if !immediate {
			timer := time.NewTimer(l.queueWait)
			acquired := false
			select {
			case l.slots <- struct{}{}:
				acquired = true
			case <-timer.C:
			}
			timer.Stop()
			l.mu.Lock()
			l.queued--
			l.mu.Unlock()
			if !acquired {
				if job.reject != nil {
					job.reject(interactiveTaskQueueTimeoutMessage)
				}
				return
			}
		}
		defer func() { <-l.slots }()
		timeout := job.timeout
		if timeout <= 0 {
			timeout = lookingGlassTaskMaxDuration
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		job.run(ctx)
	}()
	return true
}

// stats 给测试用：当前在跑和排队的数量。
func (l *interactiveTaskLimiter) stats() (running int, queued int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.slots), l.queued
}

func dispatchLookingGlassTask(cfg Config, task lookingGlassTask) {
	interactiveTasks.dispatch(interactiveTaskDispatch{
		kind:    "looking-glass",
		taskID:  task.TaskID,
		timeout: lookingGlassTaskMaxDuration,
		run:     func(ctx context.Context) { handleLookingGlassTask(ctx, cfg, task) },
		reject: func(reason string) {
			reportLookingGlassFinal(cfg, task, lookingGlassRejectedResult(task, reason))
		},
	})
}

func dispatchDiagnosticsTask(cfg Config, task diagnosticsTask) {
	if strings.TrimSpace(task.TaskID) == "" {
		return
	}
	interactiveTasks.dispatch(interactiveTaskDispatch{
		kind:    "diagnostics",
		taskID:  task.TaskID,
		timeout: diagnosticsTaskHardTimeout,
		run:     func(ctx context.Context) { handleDiagnosticsTask(ctx, cfg, task) },
		reject: func(reason string) {
			now := time.Now().Format(time.RFC3339Nano)
			reportDiagnosticsResult(cfg, task, diagnosticsResult{TaskID: task.TaskID, Results: []diagnosticsCheckResult{}, StartedAt: now, FinishedAt: now, Error: reason})
		},
	})
}

func dispatchRuleConnectionsTask(cfg Config, task ruleConnectionsTask) {
	if strings.TrimSpace(task.TaskID) == "" {
		return
	}
	interactiveTasks.dispatch(interactiveTaskDispatch{
		kind:    "rule-connections",
		taskID:  task.TaskID,
		timeout: ruleConnectionsTaskHardTimeout,
		run:     func(ctx context.Context) { handleRuleConnectionsTask(ctx, cfg, task) },
		reject: func(reason string) {
			reportRuleConnectionsResult(cfg, task, ruleConnectionsResult{TaskID: task.TaskID, Rows: []ruleConnectionRow{}, Error: reason})
		},
	})
}

func dispatchIperf3Task(cfg Config, task iperf3Task) {
	interactiveTasks.dispatch(interactiveTaskDispatch{
		kind:    "iperf3",
		taskID:  task.TaskID,
		timeout: iperf3TaskHardTimeout,
		run:     func(ctx context.Context) { handleIperf3Task(ctx, cfg, task) },
		reject: func(reason string) {
			reportIperf3Result(cfg, iperf3RejectedResult(task, reason))
		},
	})
}

func lookingGlassRejectedResult(task lookingGlassTask, reason string) lookingGlassResult {
	now := time.Now().Format(time.RFC3339Nano)
	code := 1
	return lookingGlassResult{
		TaskID:            task.TaskID,
		Method:            task.Method,
		Target:            task.Target,
		ResolvedAddress:   task.ResolvedAddress,
		ResolvedAddresses: task.ResolvedAddresses,
		Output:            reason,
		ExitCode:          &code,
		StartedAt:         now,
		FinishedAt:        now,
		Error:             reason,
	}
}

func iperf3RejectedResult(task iperf3Task, reason string) iperf3Result {
	return iperf3Result{
		TaskID:    task.TaskID,
		Op:        task.Op,
		Port:      task.Port,
		Status:    "error",
		Output:    reason,
		Error:     reason,
		UpdatedAt: time.Now().Format(time.RFC3339Nano),
	}
}
