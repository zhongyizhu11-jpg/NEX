package main

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

// accessLimitWaitArg 容忍面板在二进制名后面插入的锁等待参数（`$FWX_IPT_WAIT`、`-w`、`-w 5`）。
const accessLimitWaitArg = `(?:\s+(?:\$\{?FWX_IPT_WAIT\}?|-w(?:\s+[0-9]+)?))?`

var accessLimitRejectPattern = regexp.MustCompile(`(?i)(iptables|ip6tables)` + accessLimitWaitArg + ` -A (FWX_LIMIT_[A-Za-z0-9_]+) -p tcp -m connlimit --connlimit-above ([0-9]+) --connlimit-mask ([0-9]+) -j REJECT --reject-with tcp-reset`)

var accessLimitReturnPattern = regexp.MustCompile(`(?i)(iptables|ip6tables)` + accessLimitWaitArg + ` -A (FWX_LIMIT_[A-Za-z0-9_]+) -j RETURN`)

var accessLimitJumpPattern = regexp.MustCompile(`(?i)(iptables|ip6tables)` + accessLimitWaitArg + ` -C (INPUT|FORWARD) -p tcp --dport ([0-9]+) -j (FWX_LIMIT_[A-Za-z0-9_]+)`)

var accessLimitChainPattern = regexp.MustCompile(`\bFWX_LIMIT_[A-Za-z0-9_]+\b`)

type accessLimitRuleExpectation struct {
	binary string
	chain  string
	args   string
}

type accessLimitJumpExpectation struct {
	binary string
	base   string
	port   string
	chain  string
}

const accessLimitMaintenanceInterval = 30 * time.Minute

// accessLimitMaintenanceWaitTimeout 是访问限制维护等待本批动作完成的上限（单条 shell 最长 90 秒）。
const accessLimitMaintenanceWaitTimeout = 10 * time.Minute

var (
	accessLimitMaintenanceMu    sync.Mutex
	accessLimitMaintenanceLast  = map[string]time.Time{}
	accessLimitMaintenanceRunMu sync.Mutex
)

func accessLimitCommands(a action) []string {
	commands := make([]string, 0)
	for _, command := range append(append(append([]string{}, a.PreCommands...), a.Commands...), a.PostCommands...) {
		if strings.Contains(command, "FWX_LIMIT_") {
			commands = append(commands, command)
		}
	}
	return commands
}

func accessLimitActionSerialKeys(a action) []string {
	seen := map[string]bool{}
	keys := make([]string, 0)
	for _, command := range accessLimitCommands(a) {
		for _, chain := range accessLimitChainPattern.FindAllString(command, -1) {
			key := "access-limit:" + chain
			if seen[key] {
				continue
			}
			seen[key] = true
			keys = append(keys, key)
		}
	}
	return keys
}

func hasConfiguredAccessLimits(a action) bool {
	for _, command := range accessLimitCommands(a) {
		if strings.Contains(command, "--connlimit-above") {
			return true
		}
	}
	return false
}

func needsAccessLimitMaintenance(a action) bool {
	return len(accessLimitCommands(a)) > 0
}

func claimAccessLimitMaintenance(a action, now time.Time) bool {
	actionKey := desiredActionKey(a)
	if actionKey == "" {
		return false
	}
	key := actionKey + ":" + desiredActionSignature(a)
	accessLimitMaintenanceMu.Lock()
	defer accessLimitMaintenanceMu.Unlock()
	if previous := accessLimitMaintenanceLast[key]; !previous.IsZero() && now.Sub(previous) < accessLimitMaintenanceInterval {
		return false
	}
	accessLimitMaintenanceLast[key] = now
	if len(accessLimitMaintenanceLast) > 4096 {
		cutoff := now.Add(-2 * accessLimitMaintenanceInterval)
		for existingKey, checkedAt := range accessLimitMaintenanceLast {
			if checkedAt.Before(cutoff) {
				delete(accessLimitMaintenanceLast, existingKey)
			}
		}
	}
	return true
}

func maintainAccessLimitAction(
	a action,
	now time.Time,
	ready func(action) bool,
	run func([]string) bool,
) (attempted bool, ok bool) {
	unlock, current := acquireCurrentActionSerialLocks(a)
	if !current {
		return false, true
	}
	if unlock != nil {
		defer unlock()
	}
	if !desiredActionRecordIsCurrent(a) || !claimAccessLimitMaintenance(a, now) || ready(a) {
		return false, true
	}
	commands := accessLimitCommands(a)
	runOK := run(commands)
	return true, runOK && ready(a)
}

func scheduleAccessLimitMaintenance(actions []action, completed []<-chan struct{}) {
	candidates := make([]action, 0)
	for _, a := range actions {
		if strings.TrimSpace(a.Op) == "apply" && needsAccessLimitMaintenance(a) {
			candidates = append(candidates, a)
		}
	}
	if len(candidates) == 0 {
		return
	}
	waits := append([]<-chan struct{}(nil), completed...)
	go func() {
		// 等本批动作跑完再做维护；某个动作卡死（done 永远不关）时以前这个协程会永久泄漏，
		// 现在最多等 accessLimitMaintenanceWaitTimeout，超时就放弃这一轮（下一批动作会再安排）。
		deadline := time.NewTimer(accessLimitMaintenanceWaitTimeout)
		defer deadline.Stop()
		for _, done := range waits {
			if done == nil {
				continue
			}
			select {
			case <-done:
			case <-deadline.C:
				if shouldLogAgentReport("access-limit-maintenance-wait-timeout", accessLimitMaintenanceInterval) {
					logf("optional access limit maintenance skipped: actions still running after %s", accessLimitMaintenanceWaitTimeout)
				}
				return
			}
		}
		accessLimitMaintenanceRunMu.Lock()
		defer accessLimitMaintenanceRunMu.Unlock()
		for _, a := range candidates {
			commands := accessLimitCommands(a)
			attempted, ok := maintainAccessLimitAction(a, time.Now(), accessLimitActionReady, runShellBatch)
			if attempted && !ok && shouldLogAgentReport("access-limit-maintenance:"+desiredActionKey(a), accessLimitMaintenanceInterval) {
				logf("optional access limit maintenance incomplete rule=%d tunnel=%d port=%d commands=%d; forwarding runtime remains active", a.RuleID, a.TunnelID, a.SourcePort, len(commands))
			}
		}
	}()
}

// accessLimitActionReady verifies only the auxiliary FWX_LIMIT rules emitted
// by the panel. It intentionally uses -C checks and never flushes or rewrites
// a chain, so existing iptables counters remain intact during recovery.
func accessLimitActionReady(a action) bool {
	commands := strings.Join(append(append(append([]string{}, a.PreCommands...), a.Commands...), a.PostCommands...), "\n")
	if !strings.Contains(commands, "FWX_LIMIT_") {
		return true
	}

	ruleExpectations := map[string]accessLimitRuleExpectation{}
	for _, match := range accessLimitRejectPattern.FindAllStringSubmatch(commands, -1) {
		if len(match) != 5 {
			continue
		}
		expectation := accessLimitRuleExpectation{
			binary: match[1],
			chain:  match[2],
			args:   fmt.Sprintf("-p tcp -m connlimit --connlimit-above %s --connlimit-mask %s -j REJECT --reject-with tcp-reset", match[3], match[4]),
		}
		key := expectation.binary + "|" + expectation.chain + "|" + expectation.args
		ruleExpectations[key] = expectation
	}
	for _, match := range accessLimitReturnPattern.FindAllStringSubmatch(commands, -1) {
		if len(match) != 3 {
			continue
		}
		expectation := accessLimitRuleExpectation{binary: match[1], chain: match[2], args: "-j RETURN"}
		key := expectation.binary + "|" + expectation.chain + "|" + expectation.args
		ruleExpectations[key] = expectation
	}

	jumps := map[string]accessLimitJumpExpectation{}
	for _, match := range accessLimitJumpPattern.FindAllStringSubmatch(commands, -1) {
		if len(match) != 5 {
			continue
		}
		expectation := accessLimitJumpExpectation{binary: match[1], base: match[2], port: match[3], chain: match[4]}
		key := expectation.binary + "|" + expectation.base + "|" + expectation.port + "|" + expectation.chain
		jumps[key] = expectation
	}

	// A cleanup-only action has no expected chain rules and must leave all
	// matching jumps absent. Apply actions, in contrast, expect every emitted
	// reject/RETURN rule and jump to be present.
	for _, expectation := range ruleExpectations {
		if !commandExists(expectation.binary) {
			continue
		}
		if !runIptablesShellQuiet(iptablesAgentBin(expectation.binary) + " -C " + expectation.chain + " " + expectation.args + " 2>/dev/null") {
			return false
		}
	}
	for _, expectation := range jumps {
		if !commandExists(expectation.binary) {
			continue
		}
		command := iptablesAgentBin(expectation.binary) + " -C " + expectation.base + " -p tcp --dport " + expectation.port + " -j " + expectation.chain + " 2>/dev/null"
		hasJump := runIptablesShellQuiet(command)
		if len(ruleExpectations) > 0 {
			if !hasJump {
				return false
			}
		} else if hasJump {
			return false
		}
	}
	return true
}
