package main

// Entry and exit wiring for single-connection multipath aggregation.
//
// The entry opens one leg per configured path — typically one straight to the
// exit plus one through each relay front — and stripes a single client
// connection over all of them. The exit groups the legs that share a session id
// back into one stream and hands it to the target as if it had arrived over a
// single link.
//
// Relays need no changes: they forward secure frames verbatim, so a leg routed
// through a relay looks exactly like a direct leg to both ends.
//
// 两端都**不等齐**：入口第一条腿握手完成就开始送数据，出口第一条腿到了就去连
// 目标，其余的腿什么时候好、什么时候加进来。原来两端都要等所有腿到齐 —— 一个
// 挂掉的中转能让每条新连接都干等满拨号超时（出口那边最多再等 10 秒）。

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

// multipathEndedTTL is how long the exit remembers a finished session, so a
// leg that shows up after the end is refused instead of starting the whole
// session over with a fresh connection to the target.
const multipathEndedTTL = 2 * time.Minute

// newMultipathSessionID mints the identifier that ties an entry's legs together
// at the exit.
func newMultipathSessionID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// multipathEnabled reports whether this runtime should stripe sessions.
func multipathEnabled(cfg config) bool {
	return cfg.MultipathEnabled && len(cfg.MultipathLegs) >= multipathMinLegs
}

// multipathPendingLimit is the reorder bound for a session, defaulting when the
// panel does not pin one.
//
// A pinned value is floored: the panel has no way to know how many chunks a
// given link keeps in flight, and a bound below that makes the receiver
// overdraw on nearly every chunk for no memory saved.
func multipathPendingLimit(cfg config) int {
	if cfg.MultipathMaxPending <= 0 {
		return multipathMaxPendingChunks
	}
	if cfg.MultipathMaxPending < multipathMinPendingChunks {
		return multipathMinPendingChunks
	}
	return cfg.MultipathMaxPending
}

func multipathLegLabel(leg multipathLeg) string {
	if via := strings.TrimSpace(leg.Via); via != "" {
		return via
	}
	return fmt.Sprintf("%s:%d", leg.Host, leg.Port)
}

// multipathLegHealthKey names the endpoint a leg dials, for the health memory.
func multipathLegHealthKey(leg multipathLeg) string {
	return fmt.Sprintf("%s:%d", strings.TrimSpace(leg.Host), leg.Port)
}

// multipathLegCandidates picks the configured legs a new session should dial:
// all of them except those that failed recently. If every leg is in backoff,
// all of them are dialled anyway — the memory saves effort, it must never be
// the reason a connection cannot be made.
func multipathLegCandidates(cfg config) []int {
	candidates := make([]int, 0, len(cfg.MultipathLegs))
	for index, leg := range cfg.MultipathLegs {
		if multipathLegHealthMemory.allow(multipathLegHealthKey(leg)) {
			candidates = append(candidates, index)
		} else {
			fxpVerbosef("multipath leg %d (%s) failed recently, skipping it for this session", index, multipathLegLabel(leg))
		}
	}
	if len(candidates) == 0 {
		for index := range cfg.MultipathLegs {
			candidates = append(candidates, index)
		}
	}
	// 出口一个会话最多收 multipathMaxLegs 条腿，多拨的只会被拒。
	if len(candidates) > multipathMaxLegs {
		candidates = candidates[:multipathMaxLegs]
	}
	return candidates
}

// multipathDialResult is one leg that finished dialling, or why it did not.
type multipathDialResult struct {
	leg      *multipathLegConn
	key      string
	cfgIndex int
	err      error
}

// dialMultipathLegs starts dialling the chosen legs in parallel, announcing the
// shared session on each, and hands back the results as they come in. Nothing
// here waits for the slowest leg: the caller starts on the first one.
func dialMultipathLegs(cfg config, hello helloFrame, sessionID string, indexes []int) <-chan multipathDialResult {
	results := make(chan multipathDialResult, len(indexes))
	for _, index := range indexes {
		go func(index int) {
			results <- dialMultipathLeg(cfg, hello, sessionID, index, index)
		}(index)
	}
	return results
}

// dialMultipathLeg 拨配置里第 cfgIndex 路，在线上用 wireIndex 这个编号报到。开局时两者相同；
// 中途重拨的那一路要换一个没用过的编号（出口按编号记每一路的字节数，旧编号会被拒）。
func dialMultipathLeg(cfg config, hello helloFrame, sessionID string, cfgIndex, wireIndex int) multipathDialResult {
	legCfg := cfg.MultipathLegs[cfgIndex]
	dialCfg := cfg
	if strings.TrimSpace(legCfg.Key) != "" {
		dialCfg.Key = legCfg.Key
	}
	label := multipathLegLabel(legCfg)
	key := multipathLegHealthKey(legCfg)
	dialStarted := time.Now()
	conn, sec, err := dialSecureTCP(legCfg.Host, legCfg.Port, dialCfg)
	if err != nil {
		recordMultipathLegDial(cfg, legCfg, time.Since(dialStarted), err)
		return multipathDialResult{key: key, cfgIndex: cfgIndex, err: fmt.Errorf("leg %d (%s): %w", wireIndex, label, err)}
	}
	legHello := hello
	legHello.MultipathSessionID = sessionID
	legHello.MultipathLegIndex = wireIndex
	legHello.MultipathLegCount = len(cfg.MultipathLegs)
	legHello.MultipathReplicate = cfg.MultipathReplicate
	legHello.MultipathLegCapacityMbps = legCfg.CapacityMbps
	legHello.MultipathLegStandby = legCfg.Standby
	frame, err := json.Marshal(legHello)
	if err == nil {
		err = writeSecureHello(sec, frame)
	}
	recordMultipathLegDial(cfg, legCfg, time.Since(dialStarted), err)
	if err != nil {
		_ = conn.Close()
		return multipathDialResult{key: key, cfgIndex: cfgIndex, err: fmt.Errorf("leg %d (%s) hello: %w", wireIndex, label, err)}
	}
	leg := newMultipathLeg(wireIndex, sec, label)
	leg.traffic = newMultipathLegTraffic(cfg, legCfg)
	leg.healthKey = key
	leg.cfgIndex = cfgIndex
	leg.standby = legCfg.Standby
	leg.pace.seedCapacity(legCfg.CapacityMbps)
	return multipathDialResult{leg: leg, key: key, cfgIndex: cfgIndex}
}

// closeMultipathLegs tears down legs that will not be used.
func closeMultipathLegs(legs []*multipathLegConn) {
	for _, leg := range legs {
		if leg != nil && leg.sec != nil {
			_ = leg.sec.conn.Close()
		}
		if leg != nil {
			leg.retire()
		}
	}
}

// multipathExitSessionKey 是出口登记会话用的键：隧道号 + 会话号。会话号是入口
// 随机生成的，但出口进程里的登记表是全局的，不带隧道号的话，别的隧道上一个
// 知道（或撞上）这个会话号的腿也能挂进来。
func multipathExitSessionKey(tunnelID int, sessionID string) string {
	return fmt.Sprintf("%d/%s", tunnelID, sessionID)
}

// multipathExitRegistry groups arriving legs by session key (tunnel + session id).
type multipathExitRegistry struct {
	mu       sync.Mutex
	sessions map[string]*multipathSession
	// ended remembers recently finished sessions, see multipathEndedTTL.
	ended     map[string]time.Time
	lastPrune time.Time
}

var exitMultipathSessions = newMultipathExitRegistry()

func newMultipathExitRegistry() *multipathExitRegistry {
	return &multipathExitRegistry{
		sessions: map[string]*multipathSession{},
		ended:    map[string]time.Time{},
	}
}

// join adds one leg to its session, starting the session if this is the first
// leg to arrive, and reports whether this caller leads it.
func (r *multipathExitRegistry) join(sessionID string, leg *multipathLegConn, maxPending int) (*multipathSession, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, over := r.ended[sessionID]; over {
		return nil, false, errors.New("multipath leg arrived after its session ended")
	}
	if session, ok := r.sessions[sessionID]; ok {
		if !session.addLeg(leg) {
			return nil, false, fmt.Errorf("multipath leg %d refused: session over, leg already joined or leg limit reached", leg.index)
		}
		return session, false, nil
	}
	session := newMultipathSession([]*multipathLegConn{leg}, maxPending)
	r.sessions[sessionID] = session
	return session, true, nil
}

// finish forgets a session and refuses its stragglers for a while.
func (r *multipathExitRegistry) finish(sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, sessionID)
	now := time.Now()
	r.ended[sessionID] = now
	if now.Sub(r.lastPrune) < multipathEndedTTL/2 {
		return
	}
	r.lastPrune = now
	for id, at := range r.ended {
		if now.Sub(at) > multipathEndedTTL {
			delete(r.ended, id)
		}
	}
}

// pendingCount reports how many sessions are still running, for tests.
func (r *multipathExitRegistry) pendingCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sessions)
}

// handleExitMultipath routes one arriving leg into its session.
//
// The first leg to arrive leads: it starts the session and dials the target
// right away, without waiting for its siblings, and relays for the whole
// session. Later legs join the running session and park until their leg is
// done, because returning would close the connection it rides on.
func handleExitMultipath(sec *secureConn, hello helloFrame, cfg config) error {
	sessionID := strings.TrimSpace(hello.MultipathSessionID)
	if sessionID == "" {
		return errors.New("multipath leg is missing its session id")
	}
	if hello.MultipathLegIndex < 0 || hello.MultipathLegIndex > multipathMaxLegIndex {
		return fmt.Errorf("multipath leg index %d out of range", hello.MultipathLegIndex)
	}
	sessionKey := multipathExitSessionKey(cfg.TunnelID, sessionID)
	leg := newMultipathLeg(hello.MultipathLegIndex, sec, fmt.Sprintf("peer-%s", sec.conn.RemoteAddr()))
	// 回程（下载）是出口在分：按入口带过来的这一路线路带宽定初值。
	leg.pace.seedCapacity(hello.MultipathLegCapacityMbps)
	leg.standby = hello.MultipathLegStandby
	session, leader, err := exitMultipathSessions.join(sessionKey, leg, multipathPendingLimit(cfg))
	if err != nil {
		return err
	}
	if hello.MultipathReplicate {
		session.setReplicate(true)
	}
	if !leader {
		<-leg.dead
		return nil
	}
	defer exitMultipathSessions.finish(sessionKey)
	defer session.closeTransport()
	fxpVerbosef(
		"exit multipath session=%s first-leg=%d configured=%d target=%s:%d",
		sessionID,
		hello.MultipathLegIndex,
		hello.MultipathLegCount,
		hello.TargetIP,
		hello.TargetPort,
	)
	return relayExitTCPToTarget(session, hello, cfg)
}

// dialEntryMultipath brings up the legs for one client connection and wraps
// them in a session.
//
// The session starts as soon as the first leg is up; the rest join as they
// come. A leg that fails to dial is skipped and remembered, so the session
// degrades to the paths that are up rather than failing outright, and the next
// sessions do not wait on it either.
func dialEntryMultipath(cfg config, hello helloFrame, client net.Conn) (*multipathSession, error) {
	sessionID, err := newMultipathSessionID()
	if err != nil {
		return nil, err
	}
	candidates := multipathLegCandidates(cfg)
	results := dialMultipathLegs(cfg, hello, sessionID, candidates)
	remaining := len(candidates)
	var firstErr error
	var session *multipathSession
	var first *multipathLegConn
	// 开局就没拨通、或者在冷却里没去拨的那几路，会话起来以后交给重拨器慢慢补。
	missing := multipathMissingLegs(cfg, candidates)
	for session == nil && remaining > 0 {
		result := <-results
		remaining--
		if result.err != nil {
			multipathLegHealthMemory.failed(result.key)
			fxpVerbosef("multipath leg dial failed: %v", result.err)
			if firstErr == nil {
				firstErr = result.err
			}
			missing = append(missing, result.cfgIndex)
			continue
		}
		multipathLegHealthMemory.dialed(result.key)
		first = result.leg
		session = newMultipathSession([]*multipathLegConn{first}, multipathPendingLimit(cfg))
		session.setReplicate(cfg.MultipathReplicate)
	}
	if session == nil {
		if firstErr == nil {
			firstErr = errMultipathNoLegs
		}
		return nil, firstErr
	}
	redialer := startMultipathRedialer(cfg, hello, sessionID, session)
	for _, cfgIndex := range missing {
		redialer.schedule(cfgIndex)
	}
	if remaining > 0 {
		go joinLateMultipathLegs(session, results, remaining, redialer)
	}
	fxpVerbosef(
		"entry multipath tunnel=%d rule=%d client=%s session=%s first=%s dialing=%d/%d target=%s:%d",
		cfg.TunnelID,
		cfg.RuleID,
		client.RemoteAddr(),
		sessionID,
		first.label,
		len(candidates),
		len(cfg.MultipathLegs),
		cfg.TargetIP,
		cfg.TargetPort,
	)
	return session, nil
}

// joinLateMultipathLegs adds the legs that finish dialling after the session
// started.
func joinLateMultipathLegs(session *multipathSession, results <-chan multipathDialResult, remaining int, redialer *multipathRedialer) {
	for ; remaining > 0; remaining-- {
		result := <-results
		if result.err != nil {
			multipathLegHealthMemory.failed(result.key)
			fxpVerbosef("multipath leg dial failed: %v", result.err)
			redialer.schedule(result.cfgIndex)
			continue
		}
		multipathLegHealthMemory.dialed(result.key)
		if !session.addLeg(result.leg) {
			closeMultipathLegs([]*multipathLegConn{result.leg})
			continue
		}
		fxpVerbosef("multipath leg %d (%s) joined, %d live", result.leg.index, result.leg.label, session.aliveLegCount())
	}
}
