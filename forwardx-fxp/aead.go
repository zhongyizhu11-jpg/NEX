package main

import (
	"crypto/cipher"
	"crypto/rand"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/chacha20poly1305"
)

/*
帧加密算法的协商。

FXP 的每一帧都过一遍 AEAD，入口、出口各算一次，中转还要解一次再封一次。
AES-256-GCM 在有 AES-NI / ARMv8 加密扩展的机器上每核每秒几个 GB，瓶颈不在它；
可不少 VPS 的虚拟 CPU 不露这些指令（QEMU 的 qemu64 / kvm64 机型、一些嵌套虚拟
化、老机器），Go 只能走纯软件的 AES + GHASH，每核只有几十到一百多 MB/s ——
一条千兆线路在这种入口上只能跑出几百兆，中转上再减半。这正是「带宽跑不满、
换别的转发工具却可以」的一种典型原因：别的工具不加密，或者用了 ChaCha20。

ChaCha20-Poly1305 不需要专用指令，SSSE3 / AVX2 / NEON 上的汇编实现每核也有
一两个 GB/s。所以这里按 TLS 1.3 和 WireGuard 的做法：两端握手时各报一声自己
能用、偏好什么，没有 AES 硬件的一端偏好 ChaCha20，另一端只要会就跟着用。

偏好不看 CPU 标志位，而是进程启动后各封解几兆实测一次（标志位有时在但指令
很慢，有时没有但实现很快），差距明显才换 —— 相近时保留 AES-GCM。

线上格式：客户端的握手帧多一个 aeads（能用的算法，偏好在前），服务端的确认
多一个 aead（选定的算法，AES-256-GCM 时省略）。两个字段都在认证过的帧里，
路上改不了；旧版本不认识这两个字段，照旧 AES-256-GCM，和新版本互通。
确认帧本身仍用 AES-256-GCM 的会话密钥加密（客户端读到确认之前不知道选了哪
个），确认之后两个方向才换成选定算法、用单独派生的密钥。
*/

const (
	fxpAEADAESGCM   = "aes-256-gcm"
	fxpAEADChaCha20 = "chacha20-poly1305"
)

// fxpSupportedAEADs 是这个版本能用的算法。
var fxpSupportedAEADs = []string{fxpAEADAESGCM, fxpAEADChaCha20}

// newAEADNamed 按名字造 AEAD。空名就是 AES-256-GCM：旧版本只会它。
func newAEADNamed(name string, key []byte) (cipher.AEAD, error) {
	switch name {
	case "", fxpAEADAESGCM:
		return newAEAD(key)
	case fxpAEADChaCha20:
		return chacha20poly1305.New(key)
	}
	return nil, fmt.Errorf("unsupported fxp aead %q", name)
}

// normalizeAEADConfig 把配置里的写法收敛成算法名；空表示 auto（实测决定）。
// 不认识的写法当 auto：配置写错不该让隧道起不来。
func normalizeAEADConfig(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "aes", "aes-gcm", "aesgcm", "aes-256-gcm", "aes256gcm", "aes256-gcm":
		return fxpAEADAESGCM
	case "chacha", "chacha20", "chacha20-poly1305", "chacha20poly1305", "chacha-poly":
		return fxpAEADChaCha20
	}
	return ""
}

// fxpAEADMeasurement 是启动后实测的封解速度。
type fxpAEADMeasurement struct {
	aesBytesPerSecond    float64
	chachaBytesPerSecond float64
	preferred            string
}

// fxpAEADPreferChaChaRatio：ChaCha20 比 AES-GCM 快到这个倍数才换。
// 两者相近说明 AES 有硬件加速，留着 AES-GCM，和旧版本的行为一致。
const fxpAEADPreferChaChaRatio = 1.25

var (
	fxpAEADMeasureOnce sync.Once
	fxpAEADMeasured    fxpAEADMeasurement
	// fxpAEADPreferredOverride 让测试指定偏好，不跑实测。
	fxpAEADPreferredOverride string
	fxpAEADOverrideMu        sync.Mutex
)

// measureAEADThroughput 用 size 字节的帧封一次解一次，跑 rounds 轮，取三次里
// 最快的一次，返回每秒处理的明文字节数。几兆的数据量，总共几毫秒。
func measureAEADThroughput(name string, size, rounds int) float64 {
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	aead, err := newAEADNamed(name, key)
	if err != nil {
		return 0
	}
	plain := make([]byte, size)
	_, _ = rand.Read(plain)
	nonce := make([]byte, aead.NonceSize())
	sealed := make([]byte, 0, size+aead.Overhead())
	opened := make([]byte, 0, size)
	var best float64
	for attempt := 0; attempt < 3; attempt++ {
		start := time.Now()
		for i := 0; i < rounds; i++ {
			nonce[0] = byte(i)
			sealed = aead.Seal(sealed[:0], nonce, plain, nil)
			if opened, err = aead.Open(opened[:0], nonce, sealed, nil); err != nil {
				return 0
			}
		}
		if elapsed := time.Since(start).Seconds(); elapsed > 0 {
			if rate := float64(size*rounds) / elapsed; rate > best {
				best = rate
			}
		}
	}
	return best
}

func measureAEADPreference() fxpAEADMeasurement {
	const size = fxpCopyChunkSize
	const rounds = 16
	out := fxpAEADMeasurement{
		aesBytesPerSecond:    measureAEADThroughput(fxpAEADAESGCM, size, rounds),
		chachaBytesPerSecond: measureAEADThroughput(fxpAEADChaCha20, size, rounds),
		preferred:            fxpAEADAESGCM,
	}
	if out.chachaBytesPerSecond > out.aesBytesPerSecond*fxpAEADPreferChaChaRatio {
		out.preferred = fxpAEADChaCha20
	}
	return out
}

// preferredAEAD 是这台机器按实测偏好的算法，进程里只测一次。
func preferredAEAD() string {
	fxpAEADOverrideMu.Lock()
	override := fxpAEADPreferredOverride
	fxpAEADOverrideMu.Unlock()
	if override != "" {
		return override
	}
	fxpAEADMeasureOnce.Do(func() {
		fxpAEADMeasured = measureAEADPreference()
		log.Printf(
			"fxp aead preference=%s measured aes-256-gcm=%.0f MB/s chacha20-poly1305=%.0f MB/s",
			fxpAEADMeasured.preferred,
			fxpAEADMeasured.aesBytesPerSecond/1e6,
			fxpAEADMeasured.chachaBytesPerSecond/1e6,
		)
	})
	return fxpAEADMeasured.preferred
}

// localAEADPreference 是这一端的偏好：配置写了就按配置，否则按实测。
func localAEADPreference(cfg config) string {
	if configured := normalizeAEADConfig(cfg.AEAD); configured != "" {
		return configured
	}
	return preferredAEAD()
}

// offeredAEADs 是客户端握手时报出去的列表：两种都会，偏好的排前面。
func offeredAEADs(cfg config) []string {
	if localAEADPreference(cfg) == fxpAEADChaCha20 {
		return []string{fxpAEADChaCha20, fxpAEADAESGCM}
	}
	return []string{fxpAEADAESGCM, fxpAEADChaCha20}
}

// fxpOfferedAEADs 是客户端实际用的那份，测试可以换掉它来模拟旧版本客户端。
var fxpOfferedAEADs = offeredAEADs

func containsAEAD(list []string, name string) bool {
	for _, item := range list {
		if item == name {
			return true
		}
	}
	return false
}

// chooseAEAD 是服务端的决定。offered 是客户端报的列表，旧版本客户端没有。
//
//   - 客户端一个都没报（旧版本）或报的全不认识：AES-256-GCM，确认里不写 aead。
//   - 服务端配置里写死了算法：按配置，前提是客户端会。
//   - 否则任一端偏好 ChaCha20 就用 ChaCha20：偏好它的那一端正是没有 AES 硬件的
//     那一端，它才是瓶颈；两端都偏好 AES 就 AES。
func chooseAEAD(cfg config, offered []string) string {
	known := make([]string, 0, len(offered))
	for _, name := range offered {
		if containsAEAD(fxpSupportedAEADs, name) && !containsAEAD(known, name) {
			known = append(known, name)
		}
	}
	if len(known) == 0 {
		return fxpAEADAESGCM
	}
	if configured := normalizeAEADConfig(cfg.AEAD); configured != "" {
		if containsAEAD(known, configured) {
			return configured
		}
		return fxpAEADAESGCM
	}
	if known[0] == fxpAEADChaCha20 || (preferredAEAD() == fxpAEADChaCha20 && containsAEAD(known, fxpAEADChaCha20)) {
		return fxpAEADChaCha20
	}
	return fxpAEADAESGCM
}

// fxpNegotiatedSessionInfo 给选定算法的会话密钥一个独立的派生上下文：确认帧
// 用的 AES-256-GCM 会话密钥和之后 ChaCha20 用的密钥从结构上就分开。
func fxpNegotiatedSessionInfo(wire fxpWireContext, aead string) []byte {
	base := fxpFinalSessionInfo(wire)
	if aead == "" || aead == fxpAEADAESGCM {
		return base
	}
	out := make([]byte, 0, len(base)+1+len(aead))
	out = append(out, base...)
	out = append(out, ' ')
	return append(out, aead...)
}

var fxpAEADNegotiatedLogOnce sync.Once

// noteNegotiatedAEAD 第一次协商出非默认算法时记一行日志，之后只在 verbose 里记。
func noteNegotiatedAEAD(role string, cfg config, aead string) {
	if aead == "" || aead == fxpAEADAESGCM {
		return
	}
	fxpAEADNegotiatedLogOnce.Do(func() {
		log.Printf("fxp %s tunnel=%d using %s for session frames (negotiated with the peer)", role, cfg.TunnelID, aead)
	})
	fxpVerbosef("fxp %s tunnel=%d session aead=%s", role, cfg.TunnelID, aead)
}
