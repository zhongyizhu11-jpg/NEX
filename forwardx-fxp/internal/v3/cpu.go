package v3

import (
	"runtime"
	"sync/atomic"

	"golang.org/x/sys/cpu"
)

// 本机有没有 AES-GCM 硬件加速：决定内层 AEAD 记录用 AES-GCM（模式 3）还是 ChaCha20-Poly1305
// （模式 5），协商见 inner.go 开头和 PROTOCOL.md。
//
// 判断方式和 Go 标准库 crypto/tls 的 hasAESGCMHardwareSupport（Go 1.24 cipher_suites.go）一致，
// 只是按 GOARCH 分开写，免得把别的架构的字段也算进去：
//
//   - amd64：AES-NI + PCLMULQDQ + SSE4.1 + SSSE3（标准库的 GCM 汇编要这四样）
//   - arm64：AES + PMULL（ARMv8 加密扩展）。darwin / ios 上 x/sys/cpu 读不到特性寄存器、一律报
//     没有，但苹果的 arm64 芯片都有加密扩展（Go 自己的 internal/cpu 也是这么写死的），当作有
//   - s390x：KM-AES + KMCTR-AES + KIMD-GHASH
//   - ppc64 / ppc64le：标准库无条件当作有（GCM 汇编要求的 POWER8 是 ppc64le 的最低要求）
//   - 其它（386、arm、riscv64、mips、loong64……）：Go 1.24 的 AES-GCM 在这些架构上没有汇编，
//     算没有。386 和标准库不同：标准库在 386 上只看 CPUID 也会报有，但 crypto/aes 在 386 上
//     走的是纯 Go 实现，这里按实际速度算没有。
//
// x/sys/cpu 和标准库一样认 GODEBUG（比如 GODEBUG=cpu.aes=off），所以在有 AES 的机器上也能让整个
// 进程模拟「没有 AES 硬件」：标准库的 AES 退回纯 Go 实现，这里也报没有、协商出 ChaCha20。
// android/arm64 上 x/sys/cpu 同样读不到特性，这里会报没有、选 ChaCha20：只影响速度，不影响互通。
var aesGCMHardware = detectAESGCMHardware()

func detectAESGCMHardware() bool {
	switch runtime.GOARCH {
	case "amd64":
		return cpu.X86.HasAES && cpu.X86.HasPCLMULQDQ && cpu.X86.HasSSE41 && cpu.X86.HasSSSE3
	case "arm64":
		if runtime.GOOS == "darwin" || runtime.GOOS == "ios" {
			return true
		}
		return cpu.ARM64.HasAES && cpu.ARM64.HasPMULL
	case "s390x":
		return cpu.S390X.HasAES && cpu.S390X.HasAESCTR && cpu.S390X.HasGHASH
	case "ppc64", "ppc64le":
		return true
	}
	return false
}

// aesOverride 是测试 / 基准用的钩子：0 按硬件，1 当作有，2 当作没有。
var aesOverride atomic.Int32

// HasAESHardware 报告内层握手会不会声称本机有 AES-GCM 硬件加速。
func HasAESHardware() bool {
	switch aesOverride.Load() {
	case 1:
		return true
	case 2:
		return false
	}
	return aesGCMHardware
}

// OverrideAESHardware 让本进程里之后的内层握手当作本机有 / 没有 AES 硬件（两端都在一个进程里
// 时两端一起变）。只给测试和基准用；返回的函数恢复成之前的设置。
func OverrideAESHardware(has bool) (restore func()) {
	value := int32(2)
	if has {
		value = 1
	}
	old := aesOverride.Swap(value)
	return func() { aesOverride.Store(old) }
}
