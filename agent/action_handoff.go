package main

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type actionJob struct {
	cfg              Config
	action           action
	previousRuntime  localActionRuntimeSnapshot
	done             chan struct{}
	result           *actionJobResult
	resultOK         bool
	resultReady      bool
	desiredKey       string
	desiredSignature string
	enqueuedAt       time.Time
	protectedPort    string
	prerequisites    []<-chan struct{}
	resultPrereqs    []*actionJobResult
}

type localActionRuntimeSnapshot struct {
	valid        bool
	tunnel       bool
	ruleID       int
	tunnelID     int
	forwardType  string
	protocol     string
	hasProtocol  bool
	handoffState *actionHandoffState
}

type actionHandoffState struct {
	mu                      sync.Mutex
	once                    sync.Once
	commit                  func()
	rollback                func()
	batch                   *actionHandoffBatch
	stoppedSharedServices   []string
	stoppedSharedServiceSet map[string]bool
}

type actionHandoffBatch struct {
	mu              sync.Mutex
	finalizerOnce   sync.Once
	participants    int
	resolved        int
	failed          bool
	cancelled       bool
	cfg             Config
	originals       map[string]fxpSpec
	selectors       []fxpRuntimeSelector
	selectorKeys    map[string]bool
	guardActions    []action
	finalizeForTest func(bool, Config, []fxpSpec, []fxpRuntimeSelector)
}

func newActionHandoffBatch() *actionHandoffBatch {
	return &actionHandoffBatch{
		originals:    map[string]fxpSpec{},
		selectorKeys: map[string]bool{},
	}
}

func (batch *actionHandoffBatch) addParticipant(guards ...action) {
	if batch == nil {
		return
	}
	batch.mu.Lock()
	batch.participants++
	batch.guardActions = append(batch.guardActions, guards...)
	batch.mu.Unlock()
}

func fxpHandoffSelectorKey(selector fxpRuntimeSelector) string {
	return fmt.Sprintf("%s:%d:%d:%d:%s", strings.TrimSpace(selector.role), selector.tunnelID, selector.ruleID, selector.listenPort, normalizeRuntimeProtocol(selector.protocol))
}

func (batch *actionHandoffBatch) registerSelector(selector fxpRuntimeSelector) {
	if batch == nil || !selector.valid() {
		return
	}
	batch.mu.Lock()
	defer batch.mu.Unlock()
	batch.registerSelectorLocked(selector)
}

func (batch *actionHandoffBatch) registerSelectorLocked(selector fxpRuntimeSelector) {
	selectorKey := fxpHandoffSelectorKey(selector)
	if batch.selectorKeys[selectorKey] {
		return
	}
	batch.selectorKeys[selectorKey] = true
	batch.selectors = append(batch.selectors, selector)
}

func (batch *actionHandoffBatch) prepareFXPTransition(cfg Config, originals []fxpSpec, selector fxpRuntimeSelector) bool {
	if batch == nil {
		return false
	}
	batch.mu.Lock()
	defer batch.mu.Unlock()
	batch.cfg = cfg
	batch.registerSelectorLocked(selector)
	for _, original := range originals {
		original = normalizeFXPSpec(original)
		id := fxpServerID(original)
		if _, exists := batch.originals[id]; exists {
			continue
		}
		if err := persistFXPSpec(original); err != nil {
			logf("fxp handoff batch recovery snapshot write failed runtime=%s: %v", id, err)
			return false
		}
		batch.originals[id] = original
	}
	return true
}

func (batch *actionHandoffBatch) resolve(ok bool) {
	if batch == nil {
		return
	}
	batch.mu.Lock()
	if batch.resolved >= batch.participants {
		batch.mu.Unlock()
		return
	}
	batch.resolved++
	if !ok {
		batch.failed = true
	}
	ready := batch.participants > 0 && batch.resolved == batch.participants
	failed := batch.failed
	cfg := batch.cfg
	originals := make([]fxpSpec, 0, len(batch.originals))
	for _, original := range batch.originals {
		originals = append(originals, original)
	}
	sort.Slice(originals, func(i, j int) bool {
		return fxpServerID(originals[i]) < fxpServerID(originals[j])
	})
	selectors := append([]fxpRuntimeSelector(nil), batch.selectors...)
	guardActions := append([]action(nil), batch.guardActions...)
	finalizeForTest := batch.finalizeForTest
	batch.mu.Unlock()
	if !ready {
		return
	}
	batch.finalizerOnce.Do(func() {
		unlock := acquireActionSerialLocks(actionSerialKeysForActions(guardActions))
		if unlock != nil {
			defer unlock()
		}
		for _, guard := range guardActions {
			if !isOlderAction(guard, false) {
				continue
			}
			batch.mu.Lock()
			batch.cancelled = true
			batch.mu.Unlock()
			logf("fxp handoff batch finalization cancelled by newer desired state %s", actionLogSummary(guard))
			return
		}
		if finalizeForTest != nil {
			finalizeForTest(!failed, cfg, originals, selectors)
			return
		}
		if !failed {
			commitFXPHandoffBatchPersistence(originals, selectors)
			return
		}
		fxpControlMu.Lock()
		defer fxpControlMu.Unlock()
		restoreFXPHandoffOriginalsLocked(cfg, originals)
	})
}

func (state *actionHandoffState) attachBatch(batch *actionHandoffBatch) {
	if state == nil || batch == nil {
		return
	}
	state.mu.Lock()
	state.batch = batch
	state.mu.Unlock()
}

func (state *actionHandoffState) handoffBatch() *actionHandoffBatch {
	if state == nil {
		return nil
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.batch
}

func (state *actionHandoffState) setFinalizers(commit, rollback func()) {
	if state == nil {
		return
	}
	state.mu.Lock()
	state.commit = commit
	state.rollback = rollback
	state.mu.Unlock()
}

func (state *actionHandoffState) managesFXPPersistence() bool {
	if state == nil {
		return false
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.batch != nil || state.commit != nil || state.rollback != nil
}

func (state *actionHandoffState) registerStoppedSharedService(name string) bool {
	if state == nil {
		return false
	}
	name = sanitizeServiceName(name)
	if name == "" {
		return false
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.stoppedSharedServiceSet == nil {
		state.stoppedSharedServiceSet = map[string]bool{}
	}
	if state.stoppedSharedServiceSet[name] {
		return false
	}
	state.stoppedSharedServiceSet[name] = true
	state.stoppedSharedServices = append(state.stoppedSharedServices, name)
	return true
}

func (state *actionHandoffState) runCommit() {
	if state == nil {
		return
	}
	state.mu.Lock()
	commit := state.commit
	batch := state.batch
	state.mu.Unlock()
	state.once.Do(func() {
		if batch != nil {
			batch.resolve(true)
			return
		}
		if commit != nil {
			commit()
		}
	})
}

func (state *actionHandoffState) finish() {
	if state == nil {
		return
	}
	state.mu.Lock()
	batch := state.batch
	state.mu.Unlock()
	state.once.Do(func() {
		if batch != nil {
			batch.resolve(true)
		}
	})
}

func (state *actionHandoffState) cancel() {
	if state == nil {
		return
	}
	state.once.Do(func() {})
}

func (state *actionHandoffState) runRollback() {
	if state == nil {
		return
	}
	state.mu.Lock()
	rollback := state.rollback
	batch := state.batch
	stoppedSharedServices := append([]string(nil), state.stoppedSharedServices...)
	state.mu.Unlock()
	state.once.Do(func() {
		if batch != nil {
			batch.resolve(false)
		} else if rollback != nil {
			rollback()
		}
		for _, service := range stoppedSharedServices {
			restartManagedServiceProcessForHandoff(service)
		}
		if len(stoppedSharedServices) > 0 {
			invalidateLocalRuntimeReadinessCache()
			requestLocalRuntimeStateUpload()
		}
	})
}

type actionJobResult struct {
	done            chan struct{}
	once            sync.Once
	ok              atomic.Bool
	finalizerMu     sync.Mutex
	finalizerOnce   sync.Once
	dependentCount  int
	dependentFailed bool
	commitFn        func()
	rollbackFn      func()
}

func newActionJobResult() *actionJobResult {
	return &actionJobResult{done: make(chan struct{})}
}

func (result *actionJobResult) complete(ok bool) {
	if result == nil {
		return
	}
	result.once.Do(func() {
		result.ok.Store(ok)
		close(result.done)
	})
}

func (result *actionJobResult) wait() bool {
	if result == nil {
		return true
	}
	<-result.done
	return result.ok.Load()
}

func (result *actionJobResult) setFinalizers(commit, rollback func()) {
	if result == nil {
		return
	}
	result.finalizerMu.Lock()
	result.commitFn = commit
	result.rollbackFn = rollback
	result.finalizerMu.Unlock()
}

func (result *actionJobResult) addDependent() {
	if result == nil {
		return
	}
	result.finalizerMu.Lock()
	result.dependentCount++
	result.finalizerMu.Unlock()
}

func (result *actionJobResult) hasDependents() bool {
	if result == nil {
		return false
	}
	result.finalizerMu.Lock()
	defer result.finalizerMu.Unlock()
	return result.dependentCount > 0
}

func (result *actionJobResult) resolveDependent(ok bool) {
	if result == nil {
		return
	}
	result.finalizerMu.Lock()
	if result.dependentCount <= 0 {
		result.finalizerMu.Unlock()
		return
	}
	if !ok {
		result.dependentFailed = true
	}
	result.dependentCount--
	ready := result.dependentCount == 0
	failed := result.dependentFailed
	commit := result.commitFn
	rollback := result.rollbackFn
	result.finalizerMu.Unlock()
	if !ready {
		return
	}
	result.finalizerOnce.Do(func() {
		if failed {
			if rollback != nil {
				rollback()
			}
			return
		}
		if commit != nil {
			commit()
		}
	})
}
