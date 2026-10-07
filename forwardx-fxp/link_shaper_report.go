package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

/*
自动模式学到的限速点要记住：本机一份文件，面板一份记录。

本机文件在 /var/lib/forwardx-fxp（FORWARDX_FXP_STATE_DIR 可改），重启直接从它起步；
FXP 配置本身放在 /run 下重启就没了，所以不能写在配置旁边。面板那份由下面的上报
写进去，隧道页上能看到，面板也会把它作为提示值再发给 FXP（换机器、重装都不丢）。
*/

var linkShaperStateDir = func() string {
	if value := strings.TrimSpace(os.Getenv("FORWARDX_FXP_STATE_DIR")); value != "" {
		return value
	}
	return "/var/lib/forwardx-fxp"
}()

type linkShaperStateFile struct {
	LearnedMbps int    `json:"learnedMbps"`
	SavedAt     string `json:"savedAt"`
}

func linkShaperStatePath(key string) string {
	if linkShaperStateDir == "" {
		return ""
	}
	return filepath.Join(linkShaperStateDir, "link-shaper-"+strings.ReplaceAll(key, ":", "-")+".json")
}

// loadLinkShaperLearned 读本机记住的限速点（字节/秒），没有就是 0。
func loadLinkShaperLearned(key string) int64 {
	path := linkShaperStatePath(key)
	if path == "" {
		return 0
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	var state linkShaperStateFile
	if err := json.Unmarshal(raw, &state); err != nil || state.LearnedMbps <= 0 || state.LearnedMbps > linkShaperMaxMbps {
		return 0
	}
	return int64(state.LearnedMbps) * linkShaperBytesPerMbps
}

// saveLinkShaperLearned 原子地写本机文件（先写临时文件再改名）。写不了就算了，面板那份还在。
func saveLinkShaperLearned(key string, bytesPerSec int64) bool {
	path := linkShaperStatePath(key)
	if path == "" || bytesPerSec <= 0 {
		return false
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return false
	}
	raw, err := json.Marshal(linkShaperStateFile{LearnedMbps: int(bytesPerSec / linkShaperBytesPerMbps), SavedAt: time.Now().UTC().Format(time.RFC3339)})
	if err != nil {
		return false
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return false
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return false
	}
	return true
}

const (
	linkShaperReportPath     = "/api/agent/fxp-link-shaping"
	linkShaperReportInterval = 60 * time.Second
	linkShaperReportDebounce = 3 * time.Second
	linkShaperReportPoll     = time.Second
)

var linkShaperReporter struct {
	once sync.Once
	mu   sync.Mutex
	last time.Time
}

func startLinkShaperReporter() {
	linkShaperReporter.once.Do(func() {
		go func() {
			ticker := time.NewTicker(linkShaperReportPoll)
			defer ticker.Stop()
			var changedAt time.Time
			for now := range ticker.C {
				changed := false
				for _, s := range linkShapersSnapshot() {
					if s.changed.Load() {
						changed = true
					}
				}
				if changed && changedAt.IsZero() {
					changedAt = now
				}
				linkShaperReporter.mu.Lock()
				last := linkShaperReporter.last
				linkShaperReporter.mu.Unlock()
				due := (!changedAt.IsZero() && now.Sub(changedAt) >= linkShaperReportDebounce) || now.Sub(last) >= linkShaperReportInterval
				if !due {
					continue
				}
				changedAt = time.Time{}
				reportLinkShapers()
			}
		}()
	})
}

type linkShaperReportKey struct {
	panelURL, token, role string
	tunnelID              int
}

// reportLinkShapers 把每条隧道两个方向的状态报给面板，一条隧道一次请求。
func reportLinkShapers() {
	groups := map[linkShaperReportKey][]linkShaperStatus{}
	for _, s := range linkShapersSnapshot() {
		linkShapers.mu.Lock()
		panelURL, token, role := s.panelURL, s.token, s.role
		linkShapers.mu.Unlock()
		if panelURL == "" || token == "" {
			continue
		}
		s.changed.Store(false)
		key := linkShaperReportKey{panelURL: panelURL, token: token, role: role, tunnelID: s.tunnelID}
		groups[key] = append(groups[key], s.snapshot())
	}
	linkShaperReporter.mu.Lock()
	linkShaperReporter.last = time.Now()
	linkShaperReporter.mu.Unlock()
	for key, shapers := range groups {
		sort.Slice(shapers, func(i, j int) bool { return shapers[i].Direction < shapers[j].Direction })
		if err := postLinkShaperReport(key, shapers); err != nil {
			logTrafficDiagnostic("link-shaper:"+fmt.Sprint(key.tunnelID), "link shaper report failed tunnel=%d: %s", key.tunnelID, safeTrafficReportError(err, key.token))
		}
	}
}

func postLinkShaperReport(key linkShaperReportKey, shapers []linkShaperStatus) error {
	payload := map[string]any{
		"tunnelId":   key.tunnelID,
		"role":       key.role,
		"shapers":    shapers,
		"reportedAt": time.Now().UnixMilli(),
	}
	env, err := encryptEnvelope(payload, key.token)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(env)
	resp, err := postFXPEncryptedPanelRequest(trafficHTTPClient, key.panelURL, key.token, linkShaperReportPath, body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errors.New("panel returned " + resp.Status)
	}
	return nil
}
