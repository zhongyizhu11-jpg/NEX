package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type protocolGuardRateDirection string

const (
	protocolGuardRateIn  protocolGuardRateDirection = "in"
	protocolGuardRateOut protocolGuardRateDirection = "out"
)

type protocolGuardRateKey struct {
	scope     string
	direction protocolGuardRateDirection
}

// protocolGuardSharedRateLimiter is shared by all guards using the same
// scope and direction. rate.Limiter is safe for concurrent use; the mutex
// protects the small amount of configuration metadata used for hot updates.
type protocolGuardSharedRateLimiter struct {
	mu             sync.Mutex
	limiter        *rate.Limiter
	changed        chan struct{}
	bytesPerSecond int64
	burst          int
	refs           int
}

var errProtocolGuardRateLimiterChanged = errors.New("protocol guard rate limiter changed")

func normalizeProtocolGuardRateLimit(value int64) int64 {
	if value <= 0 {
		return 0
	}
	return value
}

func protocolGuardRateBurst(bytesPerSecond int64) int {
	bytesPerSecond = normalizeProtocolGuardRateLimit(bytesPerSecond)
	if bytesPerSecond <= 0 {
		return protocolGuardRateBurstMin
	}
	// A 100 ms burst keeps the limiter smooth at normal rates while the
	// minimum still admits one maximum-sized UDP datagram or copy chunk.
	burst := bytesPerSecond / 10
	if burst < protocolGuardRateBurstMin {
		burst = protocolGuardRateBurstMin
	}
	if burst > protocolGuardRateBurstMax {
		burst = protocolGuardRateBurstMax
	}
	return int(burst)
}

func normalizeProtocolGuardRateLimitScope(scope string, ruleID, listenPort int) string {
	scope = strings.ToLower(strings.TrimSpace(scope))
	if scope != "" {
		return scope
	}
	// Empty scopes must not accidentally pool unrelated rules. Rule IDs are
	// stable across heartbeats and therefore provide a deterministic fallback.
	return fmt.Sprintf("guard:%d:%d", ruleID, listenPort)
}

// setRateWithBurst：burstBytes > 0 时用它当桶深（「先放一段突发、跑久了再降速」那一级），
// 否则按速率取 100 ms 的默认桶深。
func (l *protocolGuardSharedRateLimiter) setRateWithBurst(bytesPerSecond, burstBytes int64) {
	if l == nil {
		return
	}
	bytesPerSecond = normalizeProtocolGuardRateLimit(bytesPerSecond)
	burst := protocolGuardRateBurstFor(bytesPerSecond, burstBytes)
	l.mu.Lock()
	if l.bytesPerSecond == bytesPerSecond && l.burst == burst {
		l.mu.Unlock()
		return
	}
	now := time.Now()
	// SetBurstAt before SetLimitAt preserves accumulated tokens as much as
	// possible when a user changes the value while traffic is flowing.
	l.limiter.SetBurstAt(now, burst)
	l.limiter.SetLimitAt(now, rate.Limit(bytesPerSecond))
	l.bytesPerSecond = bytesPerSecond
	l.burst = burst
	oldChanged := l.changed
	l.changed = make(chan struct{})
	l.mu.Unlock()
	if oldChanged != nil {
		// Cancel reservations made against the previous configuration. Waiters
		// retry against the new rate without tearing down their TCP connection.
		close(oldChanged)
	}
}

func acquireProtocolGuardRateLimiter(scope string, direction protocolGuardRateDirection, bytesPerSecond int64) *protocolGuardSharedRateLimiter {
	return acquireProtocolGuardRateLimiterWithBurst(scope, direction, bytesPerSecond, 0)
}

// protocolGuardRateBurstFor：给了桶深就用（不小于一次等待的块、不大于 64 GiB），否则按速率算默认值。
func protocolGuardRateBurstFor(bytesPerSecond, burstBytes int64) int {
	if burstBytes <= 0 {
		return protocolGuardRateBurst(bytesPerSecond)
	}
	if burstBytes < protocolGuardRateBurstMin {
		burstBytes = protocolGuardRateBurstMin
	}
	if burstBytes > protocolGuardRateBurstOverrideMax {
		burstBytes = protocolGuardRateBurstOverrideMax
	}
	return int(burstBytes)
}

func acquireProtocolGuardRateLimiterWithBurst(scope string, direction protocolGuardRateDirection, bytesPerSecond, burstBytes int64) *protocolGuardSharedRateLimiter {
	bytesPerSecond = normalizeProtocolGuardRateLimit(bytesPerSecond)
	if bytesPerSecond <= 0 {
		return nil
	}
	key := protocolGuardRateKey{scope: scope, direction: direction}
	protocolGuardRateMu.Lock()
	defer protocolGuardRateMu.Unlock()
	limiter := protocolGuardRates[key]
	if limiter == nil {
		burst := protocolGuardRateBurstFor(bytesPerSecond, burstBytes)
		limiter = &protocolGuardSharedRateLimiter{
			limiter:        rate.NewLimiter(rate.Limit(bytesPerSecond), burst),
			changed:        make(chan struct{}),
			bytesPerSecond: bytesPerSecond,
			burst:          burst,
		}
		protocolGuardRates[key] = limiter
	} else {
		limiter.setRateWithBurst(bytesPerSecond, burstBytes)
	}
	limiter.refs++
	return limiter
}

func releaseProtocolGuardRateLimiter(scope string, direction protocolGuardRateDirection, limiter *protocolGuardSharedRateLimiter) {
	if limiter == nil {
		return
	}
	key := protocolGuardRateKey{scope: scope, direction: direction}
	protocolGuardRateMu.Lock()
	current := protocolGuardRates[key]
	if current != limiter {
		protocolGuardRateMu.Unlock()
		return
	}
	if limiter.refs > 0 {
		limiter.refs--
	}
	if limiter.refs == 0 {
		delete(protocolGuardRates, key)
	}
	shouldCancel := limiter.refs == 0
	protocolGuardRateMu.Unlock()
	if shouldCancel {
		limiter.cancelWaiters()
	}
}

func (l *protocolGuardSharedRateLimiter) cancelWaiters() {
	if l == nil {
		return
	}
	l.mu.Lock()
	changed := l.changed
	l.changed = nil
	l.mu.Unlock()
	if changed != nil {
		close(changed)
	}
}

func (l *protocolGuardSharedRateLimiter) wait(ctx context.Context, guardChanged <-chan struct{}, bytes int) error {
	if l == nil || bytes <= 0 {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	// The configured burst is intentionally at least the largest payload we
	// pass here. Keep a defensive split for future callers with larger chunks.
	for bytes > 0 {
		n := bytes
		// Every configured bucket has at least this burst. Using the stable
		// minimum prevents a concurrent burst decrease from invalidating a
		// WaitN request that was sized using stale configuration.
		if n > protocolGuardRateWaitChunk {
			n = protocolGuardRateWaitChunk
		}
		for {
			l.mu.Lock()
			limiter, limiterChanged := l.limiter, l.changed
			l.mu.Unlock()
			if limiter == nil || limiterChanged == nil {
				return errProtocolGuardRateLimiterChanged
			}
			now := time.Now()
			reservation := limiter.ReserveN(now, n)
			if !reservation.OK() {
				return fmt.Errorf("protocol guard rate reservation exceeds burst: bytes=%d", n)
			}
			delay := reservation.DelayFrom(now)
			if delay <= 0 {
				break
			}
			readyAt := now.Add(delay)
			timer := time.NewTimer(delay)
			select {
			case <-timer.C:
				break
			case <-ctx.Done():
				stopProtocolGuardRateTimer(timer)
				reservation.CancelAt(time.Now())
				return ctx.Err()
			case <-guardChanged:
				now = time.Now()
				stopProtocolGuardRateTimer(timer)
				if !now.Before(readyAt) {
					break
				}
				reservation.CancelAt(now)
				return errProtocolGuardRateLimiterChanged
			case <-limiterChanged:
				now = time.Now()
				stopProtocolGuardRateTimer(timer)
				if !now.Before(readyAt) {
					break
				}
				reservation.CancelAt(now)
				continue
			}
			break
		}
		bytes -= n
	}
	return nil
}

func stopProtocolGuardRateTimer(timer *time.Timer) {
	if timer == nil || timer.Stop() {
		return
	}
	select {
	case <-timer.C:
	default:
	}
}

type guardRateTier struct {
	Scope string `json:"scope"`
	In    int64  `json:"in"`
	Out   int64  `json:"out"`
	// BurstIn / BurstOut：这一级的桶深（字节），0 = 默认 100 ms。
	BurstIn  int64 `json:"burstIn,omitempty"`
	BurstOut int64 `json:"burstOut,omitempty"`
}

// protocolGuardRateHandle 是一级限速在这台 guard 上借到的两个共享桶。
type protocolGuardRateHandle struct {
	scope string
	in    *protocolGuardSharedRateLimiter
	out   *protocolGuardSharedRateLimiter
}

func (h protocolGuardRateHandle) release() {
	releaseProtocolGuardRateLimiter(h.scope, protocolGuardRateIn, h.in)
	releaseProtocolGuardRateLimiter(h.scope, protocolGuardRateOut, h.out)
}

// protocolGuardRateTiers 把规则上的限速整理成若干级：有 RateLimits 用它（去掉空的、重复的 scope，
// 最多 protocolGuardMaxRateTiers 级），没有就是旧的那一级。
func protocolGuardRateTiers(rule guardRule) []guardRateTier {
	if len(rule.RateLimits) == 0 {
		return []guardRateTier{{
			Scope: normalizeProtocolGuardRateLimitScope(rule.RateLimitScope, rule.RuleID, rule.ListenPort),
			In:    normalizeProtocolGuardRateLimit(rule.LimitIn),
			Out:   normalizeProtocolGuardRateLimit(rule.LimitOut),
		}}
	}
	tiers := make([]guardRateTier, 0, len(rule.RateLimits))
	seen := map[string]bool{}
	for _, tier := range rule.RateLimits {
		scope := strings.ToLower(strings.TrimSpace(tier.Scope))
		in := normalizeProtocolGuardRateLimit(tier.In)
		out := normalizeProtocolGuardRateLimit(tier.Out)
		if scope == "" || seen[scope] || (in <= 0 && out <= 0) {
			continue
		}
		seen[scope] = true
		tiers = append(tiers, guardRateTier{Scope: scope, In: in, Out: out, BurstIn: tier.BurstIn, BurstOut: tier.BurstOut})
		if len(tiers) >= protocolGuardMaxRateTiers {
			break
		}
	}
	if len(tiers) == 0 {
		return []guardRateTier{{Scope: normalizeProtocolGuardRateLimitScope("", rule.RuleID, rule.ListenPort)}}
	}
	return tiers
}

func (s *protocolGuardServer) updateRateLimits(rule guardRule) {
	if s == nil {
		return
	}
	tiers := protocolGuardRateTiers(rule)
	handles := make([]protocolGuardRateHandle, 0, len(tiers))
	for _, tier := range tiers {
		handles = append(handles, protocolGuardRateHandle{
			scope: tier.Scope,
			in:    acquireProtocolGuardRateLimiterWithBurst(tier.Scope, protocolGuardRateIn, tier.In, tier.BurstIn),
			out:   acquireProtocolGuardRateLimiterWithBurst(tier.Scope, protocolGuardRateOut, tier.Out, tier.BurstOut),
		})
	}
	primary := handles[0]
	extra := handles[1:]
	s.rateMu.Lock()
	if s.closed {
		s.rateMu.Unlock()
		for _, handle := range handles {
			handle.release()
		}
		return
	}
	oldPrimary := protocolGuardRateHandle{scope: s.rateScope, in: s.rateIn, out: s.rateOut}
	oldExtra := s.rateExtra
	changed := oldPrimary != primary || !sameProtocolGuardRateHandles(oldExtra, extra)
	var oldRateChanged chan struct{}
	if changed {
		oldRateChanged = s.rateChanged
		s.rateChanged = make(chan struct{})
	}
	s.rateScope, s.rateIn, s.rateOut = primary.scope, primary.in, primary.out
	s.rateExtra = extra
	s.rateMu.Unlock()
	if oldRateChanged != nil {
		close(oldRateChanged)
	}
	oldPrimary.release()
	for _, handle := range oldExtra {
		handle.release()
	}
}

func sameProtocolGuardRateHandles(a, b []protocolGuardRateHandle) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// rateLimitersLocked：这个方向上要过的所有桶，第一级在前。调用方持有 rateMu。
func (s *protocolGuardServer) rateLimitersLocked(direction protocolGuardRateDirection) []*protocolGuardSharedRateLimiter {
	var out []*protocolGuardSharedRateLimiter
	pick := func(in, outLimiter *protocolGuardSharedRateLimiter) {
		limiter := in
		if direction == protocolGuardRateOut {
			limiter = outLimiter
		}
		if limiter != nil {
			out = append(out, limiter)
		}
	}
	pick(s.rateIn, s.rateOut)
	for _, handle := range s.rateExtra {
		pick(handle.in, handle.out)
	}
	return out
}

// rateLimiter 返回这个方向上的第一个桶（没有任何限速时是 nil）：调用方用它判断「这个方向限不限速」。
func (s *protocolGuardServer) rateLimiter(direction protocolGuardRateDirection) *protocolGuardSharedRateLimiter {
	limiter, _ := s.rateWaitState(direction)
	return limiter
}

func (s *protocolGuardServer) rateWaitState(direction protocolGuardRateDirection) (*protocolGuardSharedRateLimiter, <-chan struct{}) {
	if s == nil {
		return nil, nil
	}
	s.rateMu.RLock()
	defer s.rateMu.RUnlock()
	limiters := s.rateLimitersLocked(direction)
	if len(limiters) == 0 {
		return nil, s.rateChanged
	}
	return limiters[0], s.rateChanged
}

func (s *protocolGuardServer) rateWaitChain(direction protocolGuardRateDirection) ([]*protocolGuardSharedRateLimiter, <-chan struct{}) {
	if s == nil {
		return nil, nil
	}
	s.rateMu.RLock()
	defer s.rateMu.RUnlock()
	return s.rateLimitersLocked(direction), s.rateChanged
}

// waitRate 让这一块数据依次过这个方向上的每一级桶：多级叠加时实际速度不会超过其中最严的那一级，
// 而每一级都是按 scope 共享的，开多少条连接、多少条规则都绕不过去。
func (s *protocolGuardServer) waitRate(ctx context.Context, direction protocolGuardRateDirection, bytes int) error {
	if s == nil || bytes <= 0 {
		return nil
	}
	if ctx == nil {
		ctx = s.ctx
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for bytes > 0 {
		n := bytes
		if n > protocolGuardRateWaitChunk {
			n = protocolGuardRateWaitChunk
		}
		// 已经过了第几级：热更新只重试没过的那几级，过了的桶不再扣第二次。
		passed := 0
		for {
			if s.ctx != nil {
				if serverErr := s.ctx.Err(); serverErr != nil {
					return serverErr
				}
			}
			limiters, rateChanged := s.rateWaitChain(direction)
			if passed >= len(limiters) {
				break
			}
			err := limiters[passed].wait(ctx, rateChanged, n)
			if err == nil {
				passed++
				continue
			}
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			if s.ctx != nil {
				if serverErr := s.ctx.Err(); serverErr != nil {
					return serverErr
				}
			}
			if errors.Is(err, errProtocolGuardRateLimiterChanged) {
				// The guard switched scope, enabled/disabled a direction, or changed
				// rate. Fetch the current limiters and retry only this unfinished chunk.
				continue
			}
			return err
		}
		bytes -= n
	}
	return nil
}
