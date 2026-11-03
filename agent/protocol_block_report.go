package main

import (
	"strings"
	"sync"
	"time"
)

type protocolBlockReportEvent struct {
	cfg   Config
	rule  guardRule
	proto string
	key   string
}

type protocolBlockReportState struct {
	last    time.Time
	pending bool
}

// protocolBlockReporter keeps protocol-block reporting off the connection
// goroutines. A blocked connection is already handled locally, so a failed or
// slow panel request must never be allowed to create an unbounded backlog.
type protocolBlockReporter struct {
	mu        sync.Mutex
	queue     chan protocolBlockReportEvent
	stop      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
	closed    bool
	cooldown  time.Duration
	maxKeys   int
	states    map[string]*protocolBlockReportState
	report    func(Config, guardRule, string)
}

func newProtocolBlockReporter(queueSize int, cooldown time.Duration, maxKeys int, report func(Config, guardRule, string)) *protocolBlockReporter {
	if queueSize <= 0 {
		queueSize = 1
	}
	if cooldown < 0 {
		cooldown = 0
	}
	if maxKeys <= 0 {
		maxKeys = queueSize * 4
	}
	reporter := &protocolBlockReporter{
		queue:    make(chan protocolBlockReportEvent, queueSize),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
		cooldown: cooldown,
		maxKeys:  maxKeys,
		states:   make(map[string]*protocolBlockReportState),
		report:   report,
	}
	go reporter.run()
	return reporter
}

func protocolBlockReportKey(rule guardRule, proto string) string {
	// Include the route signature so a changed rule is not suppressed by a
	// cooldown entry left over from its previous target or policy.
	return guardRoutingSignature(rule) + "|" + strings.ToLower(strings.TrimSpace(proto))
}

func (r *protocolBlockReporter) pruneLocked(now time.Time) {
	for key, state := range r.states {
		if state == nil || state.pending || state.last.IsZero() {
			continue
		}
		if r.cooldown <= 0 || !now.Before(state.last.Add(r.cooldown)) {
			delete(r.states, key)
		}
	}
}

func (r *protocolBlockReporter) makeRoomLocked() bool {
	if len(r.states) < r.maxKeys {
		return true
	}
	oldestKey := ""
	var oldest time.Time
	for key, state := range r.states {
		if state == nil || state.pending {
			continue
		}
		if oldestKey == "" || state.last.Before(oldest) {
			oldestKey = key
			oldest = state.last
		}
	}
	if oldestKey == "" {
		return false
	}
	delete(r.states, oldestKey)
	return true
}

func (r *protocolBlockReporter) enqueue(cfg Config, rule guardRule, proto string) bool {
	if r == nil {
		return false
	}
	key := protocolBlockReportKey(rule, proto)
	now := time.Now()
	event := protocolBlockReportEvent{cfg: cfg, rule: rule, proto: strings.ToLower(strings.TrimSpace(proto)), key: key}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return false
	}
	r.pruneLocked(now)
	state := r.states[key]
	if state != nil && (state.pending || (r.cooldown > 0 && now.Before(state.last.Add(r.cooldown)))) {
		r.mu.Unlock()
		return false
	}
	if state == nil {
		if !r.makeRoomLocked() {
			r.mu.Unlock()
			return false
		}
		state = &protocolBlockReportState{}
		r.states[key] = state
	}
	state.last = now
	state.pending = true
	select {
	case r.queue <- event:
		r.mu.Unlock()
		return true
	default:
		// Keep the cooldown timestamp but release the pending flag. A later
		// connection can retry after the bounded cooldown without spinning.
		state.pending = false
		r.mu.Unlock()
		return false
	}
}

func (r *protocolBlockReporter) run() {
	defer close(r.done)
	for {
		select {
		case <-r.stop:
			return
		case event := <-r.queue:
			func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						logf("protocol block reporter panic: %v", recovered)
					}
					r.mu.Lock()
					if state := r.states[event.key]; state != nil {
						state.pending = false
						state.last = time.Now()
					}
					r.mu.Unlock()
				}()
				if r.report != nil {
					r.report(event.cfg, event.rule, event.proto)
				}
			}()
		}
	}
}

func (r *protocolBlockReporter) close() {
	if r == nil {
		return
	}
	r.closeOnce.Do(func() {
		r.mu.Lock()
		r.closed = true
		r.mu.Unlock()
		close(r.stop)
		<-r.done
	})
}

var protocolBlockReports = newProtocolBlockReporter(
	protocolBlockReportQueueSize,
	protocolBlockReportCooldown,
	protocolBlockReportStateMaxKeys,
	reportProtocolBlock,
)

func enqueueProtocolBlockReport(cfg Config, rule guardRule, proto string) {
	_ = protocolBlockReports.enqueue(cfg, rule, proto)
}

func reportProtocolBlock(cfg Config, rule guardRule, proto string) {
	payload := map[string]any{
		"ruleId":     rule.RuleID,
		"tunnelId":   rule.TunnelID,
		"sourcePort": rule.ListenPort,
		"protocol":   proto,
	}
	if err := post(cfg, "/api/agent/protocol-block", payload, &map[string]any{}); err != nil {
		if isTransientAgentCommError(err) {
			logAgentCommError("protocol-block", err)
		} else {
			logf("protocol block report failed rule=%d protocol=%s: %v", rule.RuleID, proto, err)
		}
	} else {
		logf("protocol block reported rule=%d tunnel=%d protocol=%s", rule.RuleID, rule.TunnelID, proto)
	}
}
