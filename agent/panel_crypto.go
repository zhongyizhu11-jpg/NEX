package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

func encrypt(payload any, token string) (envelope, error) {
	return encryptAt(payload, token, time.Now().UnixMilli())
}

func encryptAt(payload any, token string, ts int64) (envelope, error) {
	plain, _ := json.Marshal(payload)
	keyEnc := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
	keyMac := sha256.Sum256([]byte(token + "|forwardx-agent-mac"))
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return envelope{}, err
	}
	block, err := aes.NewCipher(keyEnc[:])
	if err != nil {
		return envelope{}, err
	}
	ct := make([]byte, len(plain))
	cipher.NewCTR(block, iv).XORKeyStream(ct, plain)
	mac := calcMAC(keyMac[:], iv, ct, ts)
	return envelope{V: 1, IV: hex.EncodeToString(iv), CT: hex.EncodeToString(ct), MAC: hex.EncodeToString(mac), TS: ts}, nil
}

func decrypt(env envelope, token string) ([]byte, error) {
	return decryptForPanel(env, token, "", "")
}

// decryptForPanel authenticates the envelope before using the optional panel
// time header. This lets an Agent tolerate a bounded clock skew without
// allowing an unauthenticated response header to bypass the MAC check.
func decryptForPanel(env envelope, token, panelURL, serverTimeHeader string) ([]byte, error) {
	keyEnc := sha256.Sum256([]byte(token + "|forwardx-agent-v1"))
	keyMac := sha256.Sum256([]byte(token + "|forwardx-agent-mac"))
	iv, err := hex.DecodeString(env.IV)
	if err != nil {
		return nil, err
	}
	ct, err := hex.DecodeString(env.CT)
	if err != nil {
		return nil, err
	}
	got, _ := hex.DecodeString(env.MAC)
	want := calcMAC(keyMac[:], iv, ct, env.TS)
	if !hmac.Equal(got, want) {
		return nil, fmt.Errorf("mac verification failed")
	}
	if serverTime, ok := parseEncryptedResponseTime(serverTimeHeader); ok {
		observeEncryptedResponseClock(panelURL, serverTime)
	}
	now := encryptedResponseNow(panelURL)
	responseAge := now.Sub(time.UnixMilli(env.TS))
	if env.TS <= 0 || responseAge > encryptedResponseReplayWindow || responseAge < -encryptedResponseReplayWindow {
		return nil, fmt.Errorf("encrypted response timestamp out of window")
	}
	encryptedResponseReplayMu.Lock()
	for key, expiresAt := range encryptedResponseReplay {
		if expiresAt.Before(now) {
			delete(encryptedResponseReplay, key)
		}
	}
	if _, exists := encryptedResponseReplay[env.MAC]; exists {
		encryptedResponseReplayMu.Unlock()
		return nil, fmt.Errorf("encrypted response replay detected")
	}
	if len(encryptedResponseReplay) >= encryptedResponseReplayCacheLimit {
		var oldestKey string
		var oldestExpiry time.Time
		for key, expiresAt := range encryptedResponseReplay {
			if oldestKey == "" || expiresAt.Before(oldestExpiry) {
				oldestKey, oldestExpiry = key, expiresAt
			}
		}
		if oldestKey != "" {
			delete(encryptedResponseReplay, oldestKey)
		}
	}
	encryptedResponseReplay[env.MAC] = now.Add(encryptedResponseReplayWindow)
	encryptedResponseReplayMu.Unlock()
	block, err := aes.NewCipher(keyEnc[:])
	if err != nil {
		return nil, err
	}
	plain := make([]byte, len(ct))
	cipher.NewCTR(block, iv).XORKeyStream(plain, ct)
	return plain, nil
}

func parseEncryptedResponseTime(raw string) (time.Time, bool) {
	now := time.Now()
	offset, ok := parseEncryptedResponseClockOffsetAt(raw, now)
	if !ok {
		return time.Time{}, false
	}
	return now.Add(offset), true
}

func parseEncryptedResponseClockOffsetAt(raw string, now time.Time) (time.Duration, bool) {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value <= 0 {
		return 0, false
	}
	offset := time.UnixMilli(value).Sub(now)
	if absDuration(offset) > encryptedResponseClockMaxOffset {
		return 0, false
	}
	return offset, true
}

func encryptedResponseClockHeaderAt(offset time.Duration, now time.Time) string {
	return strconv.FormatInt(now.Add(offset).UnixMilli(), 10)
}

func observeEncryptedResponseClock(panelURL string, serverTime time.Time) {
	panelURL = normalizePanelURL(panelURL)
	if panelURL == "" || serverTime.IsZero() {
		return
	}
	offset := serverTime.Sub(time.Now())
	if absDuration(offset) > encryptedResponseClockMaxOffset {
		return
	}
	encryptedResponseClockMu.Lock()
	encryptedResponseClock[panelURL] = offset
	encryptedResponseClockMu.Unlock()
}

func encryptedResponseNow(panelURL string) time.Time {
	offset := time.Duration(0)
	if normalized := normalizePanelURL(panelURL); normalized != "" {
		encryptedResponseClockMu.RLock()
		offset = encryptedResponseClock[normalized]
		encryptedResponseClockMu.RUnlock()
	}
	return time.Now().Add(offset)
}

func hasEncryptedResponseClock(panelURL string) bool {
	normalized := normalizePanelURL(panelURL)
	if normalized == "" {
		return false
	}
	encryptedResponseClockMu.RLock()
	_, ok := encryptedResponseClock[normalized]
	encryptedResponseClockMu.RUnlock()
	return ok
}

func absDuration(value time.Duration) time.Duration {
	if value < 0 {
		return -value
	}
	return value
}

func resetEncryptedResponseStateForTests() {
	encryptedResponseReplayMu.Lock()
	encryptedResponseReplay = make(map[string]time.Time)
	encryptedResponseReplayMu.Unlock()
	encryptedResponseClockMu.Lock()
	encryptedResponseClock = make(map[string]time.Duration)
	encryptedResponseClockMu.Unlock()
}

func calcMAC(key, iv, ct []byte, ts int64) []byte {
	buf := bytes.NewBufferString("v1")
	buf.Write(iv)
	buf.Write(ct)
	tsb := make([]byte, 8)
	binary.BigEndian.PutUint64(tsb, uint64(ts))
	buf.Write(tsb)
	m := hmac.New(sha256.New, key)
	m.Write(buf.Bytes())
	return m.Sum(nil)
}
