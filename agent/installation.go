package main

// 同 Token 换机接管（面板那头见 server/agentInstallation.ts、shared/agentInstallation.ts）。
//
// 第一次启动时生成一个安装实例 ID（32 字节随机数的十六进制），存在配置文件旁边的 installation.json，
// 同时记下 token 的摘要：升级、同机重装只要这个文件还在，ID 就不变；换了 token 才重新生成。
// 每次经 /api/sync 通信都把 ID 放在加密信封里（和 path、payload 同一层），面板据此分辨
// 「同一台机器」和「拿着同一个 Token 在另一台机器上新装的 Agent」。
//
// 新机器接管之后，面板对这台旧机器回 409 + agentSuperseded（加密信封，验过 MAC 才认）：
// 这里记一个本地标记、只打一次日志，然后停止所有面板通信 —— 心跳、上报、事件流都不再发，
// 本机已经在跑的转发不动。标记按实例分文件存（retired-installations/<id>），重启后先试一次：
// 管理员在面板上解除了绑定就恢复同步，否则继续安静。

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	agentInstallationActive int32 = iota
	agentInstallationSuperseded
	// 本地标记说被接管过：启动后放行请求，看面板怎么回。
	agentInstallationRecheck
)

var errAgentSuperseded = errors.New("agent installation superseded by another machine; panel synchronization stopped")

type agentInstallationFile struct {
	ID        string `json:"id"`
	TokenHash string `json:"tokenHash"`
}

var agentInstallation = struct {
	sync.Mutex
	key       string
	id        string
	dir       string
	persisted bool
}{}

var agentInstallationStatus atomic.Int32

func agentInstallationTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func validAgentInstallationID(id string) bool {
	if len(id) != 64 || strings.ToLower(id) != id {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

func newAgentInstallationID() string {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return ""
	}
	return hex.EncodeToString(nonce)
}

func agentRetiredInstallationMarker(dir, id string) string {
	return filepath.Join(dir, "retired-installations", id)
}

// loadOrCreateAgentInstallation 读配置目录里的 installation.json；没有、坏了或者 token 换了就新生成一个并落盘。
// 落盘失败（只读文件系统之类）时仍返回一个只在内存里的 ID：这样这次运行期间身份稳定，
// 只是重启后会被当成新机器接管一次自己 —— 比不带 ID 被当成旧版 Agent 拒掉要好。
func loadOrCreateAgentInstallation(configPath, token string) (id string, persisted bool) {
	dir := filepath.Dir(configPath)
	path := filepath.Join(dir, "installation.json")
	tokenHash := agentInstallationTokenHash(token)
	if raw, err := os.ReadFile(path); err == nil {
		var state agentInstallationFile
		if json.Unmarshal(raw, &state) == nil && state.TokenHash == tokenHash && validAgentInstallationID(state.ID) {
			return state.ID, true
		}
	}
	id = newAgentInstallationID()
	if id == "" {
		return "", false
	}
	raw, _ := json.Marshal(agentInstallationFile{ID: id, TokenHash: tokenHash})
	if err := writeConfigFileAtomic(path, append(raw, '\n')); err != nil {
		logf("agent installation identity persist failed (using in-memory id): %v", err)
		return id, false
	}
	logf("agent installation identity created id=%s", id[:8])
	return id, true
}

// agentInstallationIDFor 返回这台 Agent 的安装实例 ID（第一次调用时初始化）。
// 没有配置文件路径（单元测试、-once-register 之外的特殊场景）时不带 ID，行为和旧版一样。
func agentInstallationIDFor(cfg Config) string {
	configPath := strings.TrimSpace(activeConfigPath)
	token := strings.TrimSpace(cfg.Token)
	if configPath == "" || token == "" {
		return ""
	}
	key := configPath + "\x00" + agentInstallationTokenHash(token)
	agentInstallation.Lock()
	defer agentInstallation.Unlock()
	if agentInstallation.key == key {
		return agentInstallation.id
	}
	id, persisted := loadOrCreateAgentInstallation(configPath, token)
	agentInstallation.key = key
	agentInstallation.id = id
	agentInstallation.dir = filepath.Dir(configPath)
	agentInstallation.persisted = persisted
	status := agentInstallationActive
	if id != "" {
		if _, err := os.Stat(agentRetiredInstallationMarker(agentInstallation.dir, id)); err == nil {
			status = agentInstallationRecheck
			logf("agent installation was superseded before; checking once with the panel")
		}
	}
	agentInstallationStatus.Store(status)
	return id
}

// agentInstallationBlocked：被接管下来以后，所有面板通信直接短路。
func agentInstallationBlocked() bool {
	return agentInstallationStatus.Load() == agentInstallationSuperseded
}

// markAgentSuperseded 只在验过 MAC 的面板回包说「已被接管」时调用。只打一次日志。
func markAgentSuperseded() {
	previous := agentInstallationStatus.Swap(agentInstallationSuperseded)
	if previous == agentInstallationSuperseded {
		return
	}
	agentInstallation.Lock()
	dir, id := agentInstallation.dir, agentInstallation.id
	agentInstallation.Unlock()
	if dir != "" && id != "" {
		if err := writeConfigFileAtomic(agentRetiredInstallationMarker(dir, id), []byte("superseded\n")); err != nil {
			logf("agent installation superseded marker persist failed: %v", err)
		}
	}
	if previous == agentInstallationRecheck {
		logf("agent installation is still superseded by another machine; panel synchronization stays stopped, existing forwarding preserved")
		return
	}
	logf("agent installation superseded: another machine installed with this token took over the host; panel synchronization stopped, existing forwarding preserved")
}

// noteAgentInstallationAccepted：面板正常接受了请求。重启后复查时用 —— 面板已经解除绑定，就清掉本地标记、恢复同步。
func noteAgentInstallationAccepted() {
	if !agentInstallationStatus.CompareAndSwap(agentInstallationRecheck, agentInstallationActive) {
		return
	}
	agentInstallation.Lock()
	dir, id := agentInstallation.dir, agentInstallation.id
	agentInstallation.Unlock()
	if dir != "" && id != "" {
		_ = os.Remove(agentRetiredInstallationMarker(dir, id))
	}
	logf("agent installation accepted by the panel again; panel synchronization resumed")
}

// panelResponseSupersedesAgent：解开的回包里是不是「已被接管」。
func panelResponseSupersedesAgent(statusCode int, decoded []byte) bool {
	if statusCode != 409 || len(decoded) == 0 {
		return false
	}
	var directive struct {
		Superseded bool `json:"agentSuperseded"`
	}
	return json.Unmarshal(decoded, &directive) == nil && directive.Superseded
}
