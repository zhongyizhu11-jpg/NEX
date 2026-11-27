package main

import (
	"net"
	"testing"
	"time"
)

/*
2026-11-27 用户：「打开网页时会停顿一下才秒开」。入口到出口的预热连接，5 分钟没人取就整个清空、也不再补；
隔一阵再打开网页，浏览器那一批连接每条都要现拨（多一个往返），网页打开后池子又补上了，所以是「停一下才秒开」。
现在：还有运行中的规则在用的端点（retain），空闲后也保底 fxpPoolIdleFloor 条；快到期的提前换新，不在到期那一下空着。
*/

func keepWarmState(now time.Time) *fxpEndpointState {
	return &fxpEndpointState{
		id:           fxpEndpointID{host: "127.0.0.1", port: 1, key: "keepwarm"},
		dialCfgKnown: true,
		lastTake:     now.Add(-6 * time.Minute), // 6 分钟没人取过
	}
}

func pipeConn(t *testing.T) net.Conn {
	t.Helper()
	conn, peer := net.Pipe()
	t.Cleanup(func() { _ = conn.Close(); _ = peer.Close() })
	return conn
}

func TestEndpointPoolKeepsWarmFloorAfterIdleWhileInUse(t *testing.T) {
	now := time.Now()
	state := keepWarmState(now)
	release := state.retain()
	defer release()
	state.idle = []pooledSecureConn{{conn: pipeConn(t), createdAt: now.Add(-time.Second)}}
	state.mu.Lock()
	need := state.fillNeedLocked(now)
	state.mu.Unlock()
	if need != fxpPoolIdleFloor-1 {
		t.Fatalf("规则还在用：空闲后要补到保底 %d 条，还差 %d，算出来 %d", fxpPoolIdleFloor, fxpPoolIdleFloor-1, need)
	}
	// 维护循环：不清掉，并且去补（补的那几条正在拨）
	state.maintain(now)
	state.mu.Lock()
	kept, dialing := len(state.idle), state.dialing
	state.mu.Unlock()
	if kept != 1 {
		t.Fatalf("规则还在用：空闲 6 分钟后池里的连接不该被清掉，剩 %d 条", kept)
	}
	if kept+dialing < fxpPoolIdleFloor && dialing == 0 {
		t.Fatalf("规则还在用：维护循环要去补到保底，现有 %d 条、在拨 %d 条", kept, dialing)
	}
}

func TestEndpointPoolDrainsAfterIdleWhenNoRuleUsesIt(t *testing.T) {
	now := time.Now()
	state := keepWarmState(now)
	state.idle = []pooledSecureConn{{conn: pipeConn(t), createdAt: now.Add(-time.Second)}}
	state.maintain(now)
	state.mu.Lock()
	kept := len(state.idle)
	need := state.fillNeedLocked(now)
	state.mu.Unlock()
	if kept != 0 || need > 0 {
		t.Fatalf("没有规则在用的端点照旧空闲后清空、不补：剩 %d 条，还要补 %d 条", kept, need)
	}
}

func TestEndpointPoolNeverTakenBackupIsNotKeptWarm(t *testing.T) {
	now := time.Now()
	state := keepWarmState(now)
	state.lastTake = time.Time{} // 备用出口：没预热过、没人取过
	release := state.retain()
	defer release()
	state.mu.Lock()
	need := state.fillNeedLocked(now)
	state.mu.Unlock()
	if need > 0 {
		t.Fatalf("从没用过的备用出口不该一直挂着预热连接，却要补 %d 条", need)
	}
}

func TestEndpointPoolRefreshesBeforeExpiry(t *testing.T) {
	now := time.Now()
	state := keepWarmState(now)
	state.lastTake = now // 正在用
	release := state.retain()
	defer release()
	// 保底那么多条，全都快到期了（同一时间建的，会同一时间过期）
	for i := 0; i < fxpPoolIdleFloor; i++ {
		state.idle = append(state.idle, pooledSecureConn{conn: pipeConn(t), createdAt: now.Add(-(fxpPoolMaxIdleAge - fxpPoolRefreshLead + time.Second))})
	}
	state.mu.Lock()
	need := state.fillNeedLocked(now)
	state.mu.Unlock()
	if need != fxpPoolIdleFloor {
		t.Fatalf("快到期的连接要提前换新（先建后拆），应补 %d 条，算出来 %d", fxpPoolIdleFloor, need)
	}
	// 旧的在真正到期之前还留着能用
	state.maintain(now)
	state.mu.Lock()
	kept := len(state.idle)
	state.mu.Unlock()
	if kept != fxpPoolIdleFloor {
		t.Fatalf("换新的那几秒里旧连接照常可取，剩 %d 条", kept)
	}
}

func TestEndpointPoolIdleAgeStaysBelowServerHelloWait(t *testing.T) {
	if fxpPoolMaxIdleAge+5*time.Second > fxpServerHelloWait {
		t.Fatalf("池里连接的寿命 %v 要比对端等 hello 的 %v 至少短 5 秒", fxpPoolMaxIdleAge, fxpServerHelloWait)
	}
}
