package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	trafficBatchInterval        = 10 * time.Second
	trafficDiagnosticInterval   = time.Minute
	trafficDiagnosticMaxEntries = 1024
)

type trafficBatchKey struct {
	panelURL   string
	token      string
	producerID string
	// side 是空（入口）或 trafficReportSideExit（出口按规则记的那份）。面板按它
	// 决定这份上报算不算：同一条规则只按一边记（见 exit_traffic.go）。
	side string
}

type trafficBatchValue struct {
	bytesIn     uint64
	bytesOut    uint64
	connections uint64
}

type pendingTrafficBatch struct {
	reportID string
	byRule   map[int]trafficBatchValue
}

var trafficBatchMu sync.Mutex
var trafficBatchFlushMu sync.Mutex
var trafficBatchWorkerOnce sync.Once
var trafficBatchWake = make(chan struct{}, 1)
var trafficBatches = map[trafficBatchKey]map[int]trafficBatchValue{}
var trafficPendingReports = map[trafficBatchKey]pendingTrafficBatch{}
var trafficReportSequence atomic.Uint64
var trafficHTTPClient = &http.Client{Timeout: 10 * time.Second}
var trafficDiagnostics = struct {
	sync.Mutex
	last map[string]time.Time
}{last: make(map[string]time.Time)}

func enqueueTraffic(cfg config, bytesIn, bytesOut uint64, connectionDeltas ...uint64) {
	enqueueTrafficForSide(cfg, "", bytesIn, bytesOut, connectionDeltas...)
}

func enqueueTrafficForSide(cfg config, side string, bytesIn, bytesOut uint64, connectionDeltas ...uint64) {
	panelURL := strings.TrimRight(strings.TrimSpace(cfg.PanelURL), "/")
	token := strings.TrimSpace(cfg.Token)
	connections := uint64(0)
	if len(connectionDeltas) > 0 {
		connections = connectionDeltas[0]
	}
	if bytesIn == 0 && bytesOut == 0 && connections == 0 {
		return
	}
	missing := make([]string, 0, 3)
	if panelURL == "" {
		missing = append(missing, "panelUrl")
	}
	if token == "" {
		missing = append(missing, "token")
	}
	if cfg.RuleID <= 0 {
		missing = append(missing, "ruleId")
	}
	if len(missing) > 0 {
		logTrafficDiagnostic(
			trafficConfigDiagnosticKey(cfg, missing),
			"traffic report skipped role=%q tunnel=%d rule=%d listen=%d missing=%s",
			strings.ToLower(strings.TrimSpace(cfg.Role)),
			cfg.TunnelID,
			cfg.RuleID,
			cfg.ListenPort,
			strings.Join(missing, ","),
		)
		return
	}
	producerID := fxpTrafficProducerID(cfg)
	if side == trafficReportSideExit {
		producerID = fxpExitTrafficProducerID(cfg)
	}
	key := trafficBatchKey{panelURL: panelURL, token: token, producerID: producerID, side: side}
	trafficBatchMu.Lock()
	byRule := trafficBatches[key]
	if byRule == nil {
		byRule = map[int]trafficBatchValue{}
		trafficBatches[key] = byRule
	}
	current := byRule[cfg.RuleID]
	current.bytesIn += bytesIn
	current.bytesOut += bytesOut
	current.connections += connections
	byRule[cfg.RuleID] = current
	trafficBatchMu.Unlock()
	startTrafficBatchWorker()
}

func trafficConfigDiagnosticKey(cfg config, missing []string) string {
	return fmt.Sprintf(
		"config:%s:%d:%d:%d:%s",
		strings.ToLower(strings.TrimSpace(cfg.Role)),
		cfg.TunnelID,
		cfg.RuleID,
		cfg.ListenPort,
		strings.Join(missing, ","),
	)
}

func logTrafficDiagnostic(key, format string, args ...any) {
	now := time.Now()
	trafficDiagnostics.Lock()
	last := trafficDiagnostics.last[key]
	if !last.IsZero() && now.Sub(last) < trafficDiagnosticInterval {
		trafficDiagnostics.Unlock()
		return
	}
	trafficDiagnostics.last[key] = now
	pruneTrafficDiagnosticsLocked(now, key)
	trafficDiagnostics.Unlock()
	log.Printf(format, args...)
}

// pruneTrafficDiagnosticsLocked keeps the rate-limit bookkeeping bounded even
// when malformed or changing runtime configurations generate fresh keys faster
// than the diagnostic interval. The caller must hold trafficDiagnostics.
func pruneTrafficDiagnosticsLocked(now time.Time, protectedKeys ...string) {
	protected := func(key string) bool {
		for _, candidate := range protectedKeys {
			if key == candidate {
				return true
			}
		}
		return false
	}
	for diagnosticKey, loggedAt := range trafficDiagnostics.last {
		if now.Sub(loggedAt) >= trafficDiagnosticInterval && !protected(diagnosticKey) {
			delete(trafficDiagnostics.last, diagnosticKey)
		}
	}
	for diagnosticKey := range trafficDiagnostics.last {
		if len(trafficDiagnostics.last) <= trafficDiagnosticMaxEntries {
			break
		}
		if protected(diagnosticKey) {
			continue
		}
		delete(trafficDiagnostics.last, diagnosticKey)
	}
}

func safeTrafficReportError(err error, token string) string {
	if err == nil {
		return "unknown error"
	}
	message := err.Error()
	if token = strings.TrimSpace(token); token != "" {
		message = strings.ReplaceAll(message, token, "[redacted]")
	}
	return message
}

func startTrafficBatchWorker() {
	trafficBatchWorkerOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(trafficBatchInterval)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
				case <-trafficBatchWake:
				}
				flushTrafficBatches()
			}
		}()
	})
}

func wakeTrafficBatchWorker() {
	startTrafficBatchWorker()
	select {
	case trafficBatchWake <- struct{}{}:
	default:
	}
}

func trafficBatchSnapshot() map[trafficBatchKey]map[int]trafficBatchValue {
	trafficBatchMu.Lock()
	defer trafficBatchMu.Unlock()
	snapshot := make(map[trafficBatchKey]map[int]trafficBatchValue, len(trafficBatches))
	for key, byRule := range trafficBatches {
		copied := make(map[int]trafficBatchValue, len(byRule))
		for ruleID, value := range byRule {
			if value.bytesIn > 0 || value.bytesOut > 0 || value.connections > 0 {
				copied[ruleID] = value
			}
		}
		if len(copied) > 0 {
			snapshot[key] = copied
		}
	}
	return snapshot
}

func acknowledgeTrafficBatch(key trafficBatchKey, sent map[int]trafficBatchValue) {
	trafficBatchMu.Lock()
	defer trafficBatchMu.Unlock()
	delete(trafficPendingReports, key)
	byRule := trafficBatches[key]
	for ruleID, value := range sent {
		current, ok := byRule[ruleID]
		if !ok {
			continue
		}
		if current.bytesIn >= value.bytesIn {
			current.bytesIn -= value.bytesIn
		} else {
			current.bytesIn = 0
		}
		if current.bytesOut >= value.bytesOut {
			current.bytesOut -= value.bytesOut
		} else {
			current.bytesOut = 0
		}
		if current.connections >= value.connections {
			current.connections -= value.connections
		} else {
			current.connections = 0
		}
		if current.bytesIn == 0 && current.bytesOut == 0 && current.connections == 0 {
			delete(byRule, ruleID)
		} else {
			byRule[ruleID] = current
		}
	}
	if len(byRule) == 0 {
		delete(trafficBatches, key)
	}
}

func newFXPTrafficReportID() string {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err == nil {
		return "fxp-" + hex.EncodeToString(nonce)
	}
	return fmt.Sprintf("fxp-%x-%x-%x", time.Now().UnixNano(), os.Getpid(), trafficReportSequence.Add(1))
}

func fxpTrafficProducerID(cfg config) string {
	identity := fmt.Sprintf(
		"%s\x00%s\x00%s\x00%d\x00%d\x00%d",
		strings.TrimRight(strings.TrimSpace(cfg.PanelURL), "/"),
		strings.TrimSpace(cfg.Token),
		strings.ToLower(strings.TrimSpace(cfg.Role)),
		cfg.TunnelID,
		cfg.RuleID,
		cfg.ListenPort,
	)
	hash := sha256.Sum256([]byte(identity))
	return "fxp-" + hex.EncodeToString(hash[:])
}

func postTrafficBatch(key trafficBatchKey, pending pendingTrafficBatch) bool {
	byRule := pending.byRule
	ruleIDs := make([]int, 0, len(byRule))
	for ruleID := range byRule {
		ruleIDs = append(ruleIDs, ruleID)
	}
	sort.Ints(ruleIDs)
	stats := make([]map[string]any, 0, len(ruleIDs))
	for _, ruleID := range ruleIDs {
		value := byRule[ruleID]
		stats = append(stats, map[string]any{
			"ruleId": ruleID, "bytesIn": value.bytesIn, "bytesOut": value.bytesOut, "connections": value.connections,
		})
	}
	payload := map[string]any{
		"stats":            stats,
		"reportId":         pending.reportID,
		"reportProducerId": key.producerID,
	}
	if key.side != "" {
		payload["reportSide"] = key.side
	}
	env, err := encryptEnvelope(payload, key.token)
	if err != nil {
		logTrafficDiagnostic(
			"encrypt:"+key.producerID,
			"traffic batch encrypt failed rules=%d: %s",
			len(stats),
			safeTrafficReportError(err, key.token),
		)
		return false
	}
	body, _ := json.Marshal(env)
	resp, err := postFXPEncryptedPanelRequest(
		trafficHTTPClient,
		key.panelURL,
		key.token,
		"/api/agent/traffic",
		body,
	)
	if err != nil {
		logTrafficDiagnostic(
			"request:"+key.producerID,
			"traffic batch report request failed firstRule=%d rules=%d: %s",
			firstTrafficRuleID(ruleIDs),
			len(stats),
			safeTrafficReportError(err, key.token),
		)
		return false
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		logTrafficDiagnostic(
			"status:"+key.producerID,
			"traffic batch report rejected firstRule=%d rules=%d status=%d",
			firstTrafficRuleID(ruleIDs),
			len(stats),
			resp.StatusCode,
		)
		return false
	}
	return true

}

func firstTrafficRuleID(ruleIDs []int) int {
	if len(ruleIDs) == 0 {
		return 0
	}
	return ruleIDs[0]
}

func flushTrafficBatches() {
	trafficBatchFlushMu.Lock()
	defer trafficBatchFlushMu.Unlock()
	for key, pending := range trafficBatchPendingSnapshot() {
		if postTrafficBatch(key, pending) {
			acknowledgeTrafficBatch(key, pending.byRule)
		}
	}
}

func trafficBatchPendingSnapshot() map[trafficBatchKey]pendingTrafficBatch {
	trafficBatchMu.Lock()
	defer trafficBatchMu.Unlock()
	keys := make(map[trafficBatchKey]struct{}, len(trafficBatches)+len(trafficPendingReports))
	for key := range trafficBatches {
		keys[key] = struct{}{}
	}
	for key := range trafficPendingReports {
		keys[key] = struct{}{}
	}
	out := make(map[trafficBatchKey]pendingTrafficBatch, len(keys))
	for key := range keys {
		if pending := trafficPendingReports[key]; len(pending.byRule) > 0 {
			copy := make(map[int]trafficBatchValue, len(pending.byRule))
			for ruleID, value := range pending.byRule {
				copy[ruleID] = value
			}
			out[key] = pendingTrafficBatch{reportID: pending.reportID, byRule: copy}
			continue
		}
		current := trafficBatches[key]
		if len(current) == 0 {
			continue
		}
		copy := make(map[int]trafficBatchValue, len(current))
		for ruleID, value := range current {
			if value.bytesIn > 0 || value.bytesOut > 0 || value.connections > 0 {
				copy[ruleID] = value
			}
		}
		if len(copy) > 0 {
			pending := pendingTrafficBatch{reportID: newFXPTrafficReportID(), byRule: copy}
			trafficPendingReports[key] = pending
			out[key] = pending
		}
	}
	return out
}

func startTrafficReporter(cfg config, counter *trafficCounter) func() {
	return startTrafficReporterWith(counter, func(bytesIn, bytesOut, connections uint64) {
		enqueueTraffic(cfg, bytesIn, bytesOut, connections)
	})
}

const trafficReportInterval = 10 * time.Second

/*
每条连接（以及每个 UDP 监听、每条规则的出口计数）都有一个上报器：每 10 秒把
计数器的增量交出去，停的时候再交最后一次。

以前每个上报器自己开一个协程、一个 10 秒的定时器，入口上一条 TCP 连接就是一个
协程加一个定时器，几万条连接就是几万个只为了每 10 秒醒一次的协程。现在所有
上报器登记在一张表里，由一个共用的协程每 10 秒挨个交一次增量。

交出去的东西不变：每次交的都是「当前值减上次交过的值」，停的时候交最后一次，
停了之后再也不交，所以每个上报器交出去的总数和以前一样。唯一不同的是中途那几次
的时刻按全局的节拍走，而不是按各自开始的时刻 —— 批量上报本来就按 10 秒攒一批，
面板看到的总量不变。
*/
type trafficReporter struct {
	counter *trafficCounter
	report  func(bytesIn, bytesOut, connections uint64)

	mu              sync.Mutex
	lastIn          uint64
	lastOut         uint64
	lastConnections uint64
	// stopped：最后一次已经交过了，共用协程手里就算还拿着它也不再交。
	stopped bool
}

var trafficReporters = struct {
	sync.Mutex
	active  map[*trafficReporter]struct{}
	started bool
	// scratch 是共用协程每次拍快照用的切片，反复用，不在锁外被别人碰。
	scratch []*trafficReporter
}{active: map[*trafficReporter]struct{}{}}

// reportDelta 交出自上次以来的增量。final 为 true 时这是最后一次，之后不再交。
func (r *trafficReporter) reportDelta(final bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped {
		return
	}
	if final {
		r.stopped = true
	}
	curIn := r.counter.in.Load()
	curOut := r.counter.out.Load()
	deltaIn := curIn - r.lastIn
	deltaOut := curOut - r.lastOut
	curConnections := r.counter.connections.Load()
	deltaConnections := curConnections - r.lastConnections
	if deltaIn > 0 || deltaOut > 0 || deltaConnections > 0 {
		r.report(deltaIn, deltaOut, deltaConnections)
		r.lastIn = curIn
		r.lastOut = curOut
		r.lastConnections = curConnections
	}
}

func registerTrafficReporter(r *trafficReporter) {
	trafficReporters.Lock()
	trafficReporters.active[r] = struct{}{}
	if !trafficReporters.started {
		trafficReporters.started = true
		go trafficReporterLoop()
	}
	trafficReporters.Unlock()
}

func unregisterTrafficReporter(r *trafficReporter) {
	trafficReporters.Lock()
	delete(trafficReporters.active, r)
	trafficReporters.Unlock()
}

func trafficReporterLoop() {
	ticker := time.NewTicker(trafficReportInterval)
	defer ticker.Stop()
	for range ticker.C {
		tickTrafficReporters()
	}
}

// tickTrafficReporters 让每个登记着的上报器交一次增量。上报器自己的锁在表的锁
// 外面拿：交增量会进批量上报的锁，不能让登记、注销跟着等。
func tickTrafficReporters() {
	trafficReporters.Lock()
	snapshot := trafficReporters.scratch[:0]
	for r := range trafficReporters.active {
		snapshot = append(snapshot, r)
	}
	trafficReporters.scratch = nil
	trafficReporters.Unlock()
	for _, r := range snapshot {
		r.reportDelta(false)
	}
	clear(snapshot)
	trafficReporters.Lock()
	trafficReporters.scratch = snapshot[:0]
	trafficReporters.Unlock()
}

// startTrafficReporterWith 每 10 秒把计数器的增量交给 report，停的时候再交最后一次。
func startTrafficReporterWith(counter *trafficCounter, report func(bytesIn, bytesOut, connections uint64)) func() {
	r := &trafficReporter{counter: counter, report: report}
	registerTrafficReporter(r)
	var once sync.Once
	return func() {
		once.Do(func() {
			unregisterTrafficReporter(r)
			r.reportDelta(true)
			wakeTrafficBatchWorker()
		})
	}
}
