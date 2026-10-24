package main

import (
	"context"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxPendingDNSChanges        = 512
	dnsChangeConfirmations      = 3
	dnsChangeConfirmationWindow = 10 * time.Second
	dnsRollbackHoldDown         = 5 * time.Minute
	dnsWatchIdlePollInterval    = 30 * time.Second
	dnsWatchConfirmPollInterval = 2 * time.Second
	// 轮换型 DNS（每次返回池子里不同的子集）永远凑不齐 3 次相同答案，以前会一直停在
	// “待确认”并每 2 秒全量查询一次。同一主机连续变化这么多次仍不稳定，就在确认窗口过后直接上报。
	dnsChangeMaxConfirmationAttempts = 5
	// 并发解析的上限：主机多时逐个串行查询，一轮扫描可能远超轮询间隔。
	dnsWatchLookupConcurrency = 8
)

var dnsWatchScanMu sync.Mutex
var agentDNSWatchWakeCh = make(chan struct{}, 1)

type dnsWatchCandidate struct {
	IPs           []string
	Confirmations int
	FirstSeen     time.Time
	// 与当前快照不同的连续答案次数（不要求彼此相同）及其起点，用于给轮换型 DNS 设上限。
	Attempts      int
	DeviatedSince time.Time
}

type dnsWatchRetiredSnapshot struct {
	IPs        []string
	ReplacedAt time.Time
}

func takePendingDNSChanges() []dnsChangeReport {
	dnsWatchMu.Lock()
	defer dnsWatchMu.Unlock()
	if len(pendingDNSChanges) == 0 {
		return nil
	}
	changes := compactDNSChangeReports(pendingDNSChanges)
	pendingDNSChanges = nil
	return changes
}

func queuePendingDNSChanges(changes []dnsChangeReport) {
	if len(changes) == 0 {
		return
	}
	dnsWatchMu.Lock()
	appendPendingDNSChangesLocked(changes)
	dnsWatchMu.Unlock()
}

func preserveDNSChangesAfterHeartbeat(changes []dnsChangeReport, reconciliationCoalesced bool) {
	if !reconciliationCoalesced {
		return
	}
	queuePendingDNSChanges(changes)
}

func hasPendingDNSChanges() bool {
	dnsWatchMu.Lock()
	defer dnsWatchMu.Unlock()
	return len(pendingDNSChanges) > 0
}

func wakeAgentDNSWatchScheduler() {
	select {
	case agentDNSWatchWakeCh <- struct{}{}:
	default:
	}
}

func agentDNSWatchScheduler() {
	nextScanAt := time.Now().Add(dnsWatchIdlePollInterval)
	lastWatchSignature := ""
	for {
		delay := time.Until(nextScanAt)
		if delay < 0 {
			delay = 0
		}
		timer := time.NewTimer(delay)
		woke := false
		select {
		case <-timer.C:
		case <-agentDNSWatchWakeCh:
			woke = true
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		state := heartbeatStateSnapshotCopy()
		watchSignature := dnsWatchItemsSignature(state.DNSWatch)
		now := time.Now()
		if woke && !dnsWatchWakeNeedsScan(watchSignature, lastWatchSignature, now, nextScanAt) {
			continue
		}
		needsConfirmation := updateDNSWatch(state.DNSWatch)
		lastWatchSignature = watchSignature
		wakeHeartbeatForPendingDNS()
		if needsConfirmation {
			nextScanAt = time.Now().Add(dnsWatchConfirmPollInterval)
		} else {
			nextScanAt = time.Now().Add(dnsWatchIdlePollInterval)
		}
	}
}

func dnsWatchWakeNeedsScan(currentSignature string, lastSignature string, now time.Time, nextScanAt time.Time) bool {
	return currentSignature != lastSignature || !now.Before(nextScanAt)
}

func dnsWatchItemsSignature(items []dnsWatchItem) string {
	keys := make([]string, 0, len(items))
	for _, item := range items {
		host := normalizeDNSWatchHost(item.Host)
		if host == "" {
			continue
		}
		keys = append(keys, strings.ToLower(host)+"\x00"+strings.TrimSpace(item.Scope)+"\x00"+strconv.Itoa(item.RefID))
	}
	sort.Strings(keys)
	return strings.Join(keys, "\x01")
}

func wakeHeartbeatForPendingDNS() bool {
	if !hasPendingDNSChanges() {
		return false
	}
	wakeHeartbeat()
	return true
}

func updateDNSWatch(items []dnsWatchItem) bool {
	return updateDNSWatchWithLookupAt(items, lookupDNSWatchIPs, time.Now())
}

func updateDNSWatchWithLookupAt(items []dnsWatchItem, lookup func(string) []string, now time.Time) bool {
	dnsWatchScanMu.Lock()
	defer dnsWatchScanMu.Unlock()

	watched := map[string]string{}
	watchedItems := map[string][]dnsWatchItem{}
	for _, item := range items {
		host := normalizeDNSWatchHost(item.Host)
		if host == "" {
			continue
		}
		item.Host = host
		key := strings.ToLower(host)
		watched[key] = host
		watchedItems[key] = append(watchedItems[key], item)
	}

	resolved := resolveDNSWatchHosts(watched, lookup)

	dnsWatchMu.Lock()
	defer dnsWatchMu.Unlock()

	nextSnapshot := map[string][]string{}
	for key, oldIPs := range dnsWatchSnapshot {
		if _, ok := watched[key]; ok && len(oldIPs) > 0 {
			nextSnapshot[key] = append([]string(nil), oldIPs...)
		}
	}
	nextRetiredSnapshots := map[string]dnsWatchRetiredSnapshot{}
	for key, retired := range dnsWatchRetiredSnapshots {
		if _, ok := watched[key]; ok && len(retired.IPs) > 0 && now.Sub(retired.ReplacedAt) < dnsRollbackHoldDown {
			nextRetiredSnapshots[key] = dnsWatchRetiredSnapshot{
				IPs:        append([]string(nil), retired.IPs...),
				ReplacedAt: retired.ReplacedAt,
			}
		}
	}

	nextCandidates := map[string]dnsWatchCandidate{}
	var reports []dnsChangeReport
	pendingConfirmation := false
	for key, host := range watched {
		ips := resolved[key]
		if len(ips) == 0 {
			continue
		}
		oldIPs, hadOld := dnsWatchSnapshot[key]
		if !hadOld || len(oldIPs) == 0 {
			nextSnapshot[key] = append([]string(nil), ips...)
			continue
		}
		// 与快照在每个地址族上都有交集，视为同一组地址的轮换（负载均衡池每次返回不同子集），不算变化。
		if sameStringSlice(oldIPs, ips) || dnsAnswerSetsOverlap(oldIPs, ips) {
			nextSnapshot[key] = append([]string(nil), oldIPs...)
			continue
		}
		if retired, ok := nextRetiredSnapshots[key]; ok && sameStringSlice(retired.IPs, ips) {
			nextSnapshot[key] = append([]string(nil), oldIPs...)
			continue
		}

		// Recursive DNS caches can briefly alternate between the retired and
		// current DDNS value. Keep serving the stable snapshot until the new
		// answer has remained consistent across both polls and elapsed time.
		candidate, hadCandidate := dnsWatchCandidates[key]
		if hadCandidate && (sameStringSlice(candidate.IPs, ips) || dnsAnswerSetsOverlap(candidate.IPs, ips)) {
			// 与候选相同或同属一组轮换地址：算一次确认，候选更新为最新答案。
			candidate.Confirmations++
			candidate.Attempts++
			candidate.IPs = append([]string(nil), ips...)
		} else if hadCandidate {
			candidate = dnsWatchCandidate{
				IPs:           append([]string(nil), ips...),
				Confirmations: 1,
				FirstSeen:     now,
				Attempts:      candidate.Attempts + 1,
				DeviatedSince: candidate.DeviatedSince,
			}
		} else {
			candidate = dnsWatchCandidate{
				IPs:           append([]string(nil), ips...),
				Confirmations: 1,
				FirstSeen:     now,
				Attempts:      1,
				DeviatedSince: now,
			}
		}
		confirmed := candidate.Confirmations >= dnsChangeConfirmations && now.Sub(candidate.FirstSeen) >= dnsChangeConfirmationWindow
		capped := candidate.Attempts >= dnsChangeMaxConfirmationAttempts && now.Sub(candidate.DeviatedSince) >= dnsChangeConfirmationWindow
		if !confirmed && !capped {
			nextCandidates[key] = candidate
			// 达到尝试上限后只等确认窗口过去，按常规节奏轮询即可，不再每 2 秒查一次。
			if candidate.Attempts < dnsChangeMaxConfirmationAttempts {
				pendingConfirmation = true
			}
			nextSnapshot[key] = append([]string(nil), oldIPs...)
			continue
		}

		nextSnapshot[key] = append([]string(nil), ips...)
		nextRetiredSnapshots[key] = dnsWatchRetiredSnapshot{
			IPs:        append([]string(nil), oldIPs...),
			ReplacedAt: now,
		}
		refs := watchedItems[key]
		if len(refs) == 0 {
			refs = []dnsWatchItem{{Host: host}}
		}
		for _, item := range refs {
			reports = append(reports, dnsChangeReport{
				Host:  host,
				Scope: item.Scope,
				RefID: item.RefID,
				Old:   append([]string(nil), oldIPs...),
				New:   append([]string(nil), ips...),
			})
		}
	}

	dnsWatchSnapshot = nextSnapshot
	dnsWatchCandidates = nextCandidates
	dnsWatchRetiredSnapshots = nextRetiredSnapshots
	if len(reports) > 0 {
		appendPendingDNSChangesLocked(reports)
	}
	return pendingConfirmation || len(reports) > 0
}

// resolveDNSWatchHosts 以有限并发解析所有主机，解析失败的主机不出现在结果里。
func resolveDNSWatchHosts(watched map[string]string, lookup func(string) []string) map[string][]string {
	resolved := make(map[string][]string, len(watched))
	if len(watched) == 0 {
		return resolved
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	slots := make(chan struct{}, dnsWatchLookupConcurrency)
	for key, host := range watched {
		wg.Add(1)
		slots <- struct{}{}
		go func(key string, host string) {
			defer wg.Done()
			defer func() { <-slots }()
			ips := lookup(host)
			if len(ips) == 0 {
				return
			}
			mu.Lock()
			resolved[key] = ips
			mu.Unlock()
		}(key, host)
	}
	wg.Wait()
	return resolved
}

// dnsAnswerSetsOverlap 判断两组答案是否属于同一组轮换地址：两边都有的每个地址族（IPv4 / IPv6）
// 至少共享一个地址。按地址族分别判断，是为了双栈 DDNS 只换了 IPv6 前缀时仍能识别为变化。
func dnsAnswerSetsOverlap(a []string, b []string) bool {
	familyOf := func(value string) string {
		if strings.Contains(value, ":") {
			return "6"
		}
		return "4"
	}
	aByFamily := map[string]map[string]bool{}
	for _, ip := range a {
		family := familyOf(ip)
		if aByFamily[family] == nil {
			aByFamily[family] = map[string]bool{}
		}
		aByFamily[family][ip] = true
	}
	bFamilies := map[string]bool{}
	shared := map[string]bool{}
	for _, ip := range b {
		family := familyOf(ip)
		bFamilies[family] = true
		if aByFamily[family][ip] {
			shared[family] = true
		}
	}
	compared := 0
	for family := range bFamilies {
		if aByFamily[family] == nil {
			continue
		}
		compared++
		if !shared[family] {
			return false
		}
	}
	return compared > 0
}

func appendPendingDNSChangesLocked(changes []dnsChangeReport) {
	if len(changes) == 0 {
		return
	}
	pendingDNSChanges = compactDNSChangeReports(append(pendingDNSChanges, changes...))
}

func compactDNSChangeReports(changes []dnsChangeReport) []dnsChangeReport {
	if len(changes) == 0 {
		return nil
	}
	seen := map[string]bool{}
	reversed := make([]dnsChangeReport, 0, minInt(len(changes), maxPendingDNSChanges))
	for i := len(changes) - 1; i >= 0 && len(reversed) < maxPendingDNSChanges; i-- {
		key := dnsChangeReportKey(changes[i])
		if seen[key] {
			continue
		}
		seen[key] = true
		reversed = append(reversed, changes[i])
	}
	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	return reversed
}

func dnsChangeReportKey(change dnsChangeReport) string {
	return strings.ToLower(strings.TrimSpace(change.Host)) + "\x00" + strings.TrimSpace(change.Scope) + "\x00" + strconv.Itoa(change.RefID)
}

func normalizeDNSWatchHost(raw string) string {
	host := strings.TrimSpace(raw)
	if host == "" || len(host) > 253 || net.ParseIP(host) != nil {
		return ""
	}
	host = strings.TrimSuffix(host, ".")
	if host == "" || !dnsWatchHostPattern.MatchString(host) {
		return ""
	}
	return host
}

func lookupDNSWatchIPs(host string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return nil
	}
	values := make([]string, 0, len(ips))
	seen := map[string]bool{}
	for _, ip := range ips {
		if ip == nil {
			continue
		}
		value := ip.String()
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		values = append(values, value)
	}
	sort.Strings(values)
	return values
}

func sameStringSlice(a, b []string) bool {
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
