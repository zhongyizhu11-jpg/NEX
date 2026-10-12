//go:build linux

package sockmap

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

/*
sockmap 中继数据面：Agent 自己做的 TCP 中继（线路组主备代理、内核 WireGuard 隧道
的本机回环代理）在判断阶段结束后，把两条连接交给内核直接对接，数据不再经过
Agent 进程 —— 没有 read/write 系统调用、没有用户态拷贝、没有协程唤醒。

机制（net/core/sock_map.c, skmsg.c）：

  · 两张 sockhash，键都是 socket cookie（SO_COOKIE）。
      targets：只作为重定向的目标，不挂程序。
      sources：挂着 sk_skb 判决程序；连接在这张表里时，它收到的每个 skb 都由程序
               处理 —— 查 pairs 表拿到对端 cookie，bpf_sk_redirect_hash 到 targets
               里的对端 socket 的发送队列。
    两条连接从对接到结束一直都在两张表里。中途把 socket 摘出 sources 不行：摘表不
    拿 socket 锁，和正在跑的判决有竞争，程序指针清空的一瞬间收到的 skb 会被内核
    当 SK_DROP 丢掉（sk_psock_verdict_recv 的默认判决），数据就少一段。
  · pairs：普通 hash，cookie → { 对端 cookie, 已重定向字节数, 已放行字节数,
    已切回的代次 }。只有判决程序写它。
  · ctrl：普通 hash，cookie → { 模式, 代次, 用户态已读走的放行字节数 }。只有
    用户态写它，程序只读。模式有三种：
      0 redirect：重定向到对端。
      1 pass：     SK_PASS，数据按序留在本连接的 ingress 队列里，并且仍占着它的
                   接收缓冲 —— 窗口自然关上，压力传回发送方。
      2 resume：   用户态正在把 ingress 里的数据按序拷给对端；程序看到「已放行 ==
                   用户态已读走」时自己切回重定向，并把 ctrl 里的代次记到 pairs，
                   之后的 skb 都走重定向。切换在判决程序里、拿着 socket 锁完成，
                   所以不会出现旧数据还在 ingress、新数据已经重定向过去的乱序。

内核不做的三件事由用户态补上：

  1. 背压。重定向走的是对端 psock 的后台队列，没有上限：源端窗口一直开着，对端
     写不动时积压会无限增长。积压（程序累计重定向的字节数 − 对端 TCP 已交给协议栈
     的字节数，后者 = TCP_INFO bytes_acked + SIOCOUTQ）超过 sockmapBacklogHigh
     就切到 pass 模式；等积压清零，再切到 resume 把 ingress 里攒下的数据拷过去，
     程序随即切回重定向。
  2. 半关闭。源端收到 FIN 只是接收队列读到头，对端发送队列里可能还有积压；要等
     积压清零再 shutdown(SHUT_WR) 对端，否则 FIN 会抢在数据前面。
  3. 插入前已经排队的数据。把 socket 放进 sources 不会处理接收队列里已有的数据，
     要等下一个包到达才会连同旧数据一起按序处理；对端如果在等回应就永远卡住。
     setsockopt(SO_RCVLOWAT) 会调用 tcp_data_ready → sk_data_ready，正好把判决程序
     跑一遍，拿它当「踢一下」。

能用的条件：Linux ≥ 5.13、root 或 CAP_BPF + CAP_NET_ADMIN。起不来、自检失败、某一
对连接对接失败，都退回原来的用户态中继，规则行为不变。NEX_SOCKMAP=0 可以整体关掉。
*/

const (
	sockmapEnvName = "NEX_SOCKMAP"

	// 5.13 起 sockhash 可以只挂判决程序（BPF_SK_SKB_VERDICT），不用 stream parser。
	// 更老的内核得走 parser + stream verdict，行为不一样，不支持：退回用户态中继。
	sockmapMinKernelMajor = 5
	sockmapMinKernelMinor = 13

	sockmapMapEntries = 65536

	// 积压超过这个值就切到 pass 模式。要盖住一个 tick 内 1Gbps 能送来的量
	//（25ms ≈ 3MB）。

	// 有数据在走时每 25ms 看一次积压；没数据时放慢到 200ms（一个空闲连接每秒
	// 十次 getsockopt，一千个连接也只是 1% 左右的核）。
	sockmapTickActive = 25 * time.Millisecond
	sockmapTickIdle   = 200 * time.Millisecond

	// 等对端积压清零的轮询间隔：有进展时 2ms，没进展时放慢到 50ms。
	sockmapDrainPoll    = 2 * time.Millisecond
	sockmapDrainPollMax = 50 * time.Millisecond

	sockmapSelfTestTimeout = 5 * time.Second
)

var sockmapBacklogHigh int64 = 4 << 20

const (
	sockmapModeRedirect = 0
	sockmapModePass     = 1
	sockmapModeResume   = 2
)

var (
	sockmapRelayOnce     sync.Once
	sockmapRelayInstance *sockmapRelay
	sockmapRelayReason   string
)

// sockmapRelay 持有 BPF 对象；进程内只有一份。
type sockmapRelay struct {
	targetsFD int
	sourcesFD int
	pairsFD   int
	ctrlFD    int
	verdictFD int

	active    atomic.Int64
	spliced   atomic.Uint64
	fallbacks atomic.Uint64
	throttles atomic.Uint64
}

// sockmapPairValue 是 pairs 表的值，布局和判决程序里的偏移一一对应。
type sockmapPairValue struct {
	Peer       uint64
	Redirected uint64
	Passed     uint64
	ResumedGen uint64
}

// sockmapCtrlValue 是 ctrl 表的值。
type sockmapCtrlValue struct {
	Mode    uint64
	Gen     uint64
	Drained uint64
}

// sockmapRelayGet 懒初始化：第一次需要时加载程序并自检，失败就记下原因，以后
// 不再尝试。
func sockmapRelayGet() *sockmapRelay {
	if forceOff.Load() {
		return nil
	}
	sockmapRelayOnce.Do(func() {
		relay, err := newSockmapRelay()
		if err != nil {
			sockmapRelayReason = err.Error()
			Logf("sockmap relay disabled: %v", err)
			return
		}
		sockmapRelayInstance = relay
		Logf("sockmap relay enabled")
	})
	return sockmapRelayInstance
}

// sockmapRelayStatus 给心跳 / 诊断用：enabled / disabled: <原因> / off。
func sockmapRelayStatus() string {
	if forceOff.Load() {
		return "off"
	}
	relay := sockmapRelayGet()
	if relay == nil {
		return "disabled: " + sockmapRelayReason
	}
	return "enabled"
}

func sockmapEnabledByEnv() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(sockmapEnvName)))
	switch value {
	case "0", "off", "false", "no", "disable", "disabled":
		return false
	}
	return true
}

func sockmapKernelSupported() error {
	var uts unix.Utsname
	if err := unix.Uname(&uts); err != nil {
		return fmt.Errorf("uname: %w", err)
	}
	release := unix.ByteSliceToString(uts.Release[:])
	major, minor, ok := parseKernelRelease(release)
	if !ok {
		return fmt.Errorf("unrecognized kernel release %q", release)
	}
	if major < sockmapMinKernelMajor || (major == sockmapMinKernelMajor && minor < sockmapMinKernelMinor) {
		return fmt.Errorf("kernel %s is older than %d.%d", release, sockmapMinKernelMajor, sockmapMinKernelMinor)
	}
	return nil
}

func parseKernelRelease(release string) (int, int, bool) {
	fields := strings.FieldsFunc(release, func(r rune) bool { return r == '.' || r == '-' || r == '_' || r == '+' })
	if len(fields) < 2 {
		return 0, 0, false
	}
	major, err := strconv.Atoi(fields[0])
	if err != nil {
		return 0, 0, false
	}
	minorText := fields[1]
	end := 0
	for end < len(minorText) && minorText[end] >= '0' && minorText[end] <= '9' {
		end++
	}
	minor, err := strconv.Atoi(minorText[:end])
	if err != nil {
		return 0, 0, false
	}
	return major, minor, true
}

func newSockmapRelay() (*sockmapRelay, error) {
	if !sockmapEnabledByEnv() {
		return nil, errors.New(sockmapEnvName + " is off")
	}
	if err := sockmapKernelSupported(); err != nil {
		return nil, err
	}
	relay := &sockmapRelay{targetsFD: -1, sourcesFD: -1, pairsFD: -1, ctrlFD: -1, verdictFD: -1}
	var err error
	if relay.targetsFD, err = bpfMapCreate(unix.BPF_MAP_TYPE_SOCKHASH, 8, 4, sockmapMapEntries, "nex_sm_targets"); err != nil {
		relay.close()
		return nil, fmt.Errorf("create targets sockhash: %w", err)
	}
	if relay.sourcesFD, err = bpfMapCreate(unix.BPF_MAP_TYPE_SOCKHASH, 8, 4, sockmapMapEntries, "nex_sm_sources"); err != nil {
		relay.close()
		return nil, fmt.Errorf("create sources sockhash: %w", err)
	}
	if relay.pairsFD, err = bpfMapCreate(unix.BPF_MAP_TYPE_HASH, 8, uint32(unsafe.Sizeof(sockmapPairValue{})), sockmapMapEntries, "nex_sm_pairs"); err != nil {
		relay.close()
		return nil, fmt.Errorf("create pairs map: %w", err)
	}
	if relay.ctrlFD, err = bpfMapCreate(unix.BPF_MAP_TYPE_HASH, 8, uint32(unsafe.Sizeof(sockmapCtrlValue{})), sockmapMapEntries, "nex_sm_ctrl"); err != nil {
		relay.close()
		return nil, fmt.Errorf("create ctrl map: %w", err)
	}
	verdict, err := bpfProgLoad(unix.BPF_PROG_TYPE_SK_SKB, sockmapVerdictProgram(relay.pairsFD, relay.ctrlFD, relay.targetsFD), "nex_sockmap_v")
	if err != nil {
		relay.close()
		return nil, fmt.Errorf("load verdict program: %w", err)
	}
	relay.verdictFD = verdict
	if err := bpfProgAttach(relay.sourcesFD, relay.verdictFD, unix.BPF_SK_SKB_VERDICT); err != nil {
		relay.close()
		return nil, fmt.Errorf("attach verdict program: %w", err)
	}
	if err := relay.selfTest(); err != nil {
		relay.close()
		return nil, fmt.Errorf("self test: %w", err)
	}
	return relay, nil
}

func (relay *sockmapRelay) close() {
	for _, fd := range []*int{&relay.verdictFD, &relay.sourcesFD, &relay.targetsFD, &relay.pairsFD, &relay.ctrlFD} {
		if *fd >= 0 {
			_ = unix.Close(*fd)
			*fd = -1
		}
	}
}

// ---- BPF 系统调用 ------------------------------------------------------------

type bpfInsn struct {
	Code uint8
	Regs uint8
	Off  int16
	Imm  int32
}

func bpfInsnRegs(dst, src uint8) uint8 { return dst | src<<4 }

func bpfMov64Reg(dst, src uint8) bpfInsn {
	return bpfInsn{Code: unix.BPF_ALU64 | unix.BPF_MOV | unix.BPF_X, Regs: bpfInsnRegs(dst, src)}
}

func bpfMov64Imm(dst uint8, imm int32) bpfInsn {
	return bpfInsn{Code: unix.BPF_ALU64 | unix.BPF_MOV | unix.BPF_K, Regs: bpfInsnRegs(dst, 0), Imm: imm}
}

func bpfAdd64Imm(dst uint8, imm int32) bpfInsn {
	return bpfInsn{Code: unix.BPF_ALU64 | unix.BPF_ADD | unix.BPF_K, Regs: bpfInsnRegs(dst, 0), Imm: imm}
}

func bpfLdxMem(size uint8, dst, src uint8, off int16) bpfInsn {
	return bpfInsn{Code: unix.BPF_LDX | unix.BPF_MEM | size, Regs: bpfInsnRegs(dst, src), Off: off}
}

func bpfStxMem(size uint8, dst, src uint8, off int16) bpfInsn {
	return bpfInsn{Code: unix.BPF_STX | unix.BPF_MEM | size, Regs: bpfInsnRegs(dst, src), Off: off}
}

// bpfAtomicAdd64 是 lock *(u64*)(dst+off) += src：BPF_ATOMIC 和老内核的 BPF_XADD
// 同一个操作码，imm=BPF_ADD(0) 时语义一样。
func bpfAtomicAdd64(dst, src uint8, off int16) bpfInsn {
	return bpfInsn{Code: unix.BPF_STX | unix.BPF_ATOMIC | unix.BPF_DW, Regs: bpfInsnRegs(dst, src), Off: off, Imm: unix.BPF_ADD}
}

func bpfJmpImm(op uint8, dst uint8, imm int32, off int16) bpfInsn {
	return bpfInsn{Code: unix.BPF_JMP | op | unix.BPF_K, Regs: bpfInsnRegs(dst, 0), Off: off, Imm: imm}
}

func bpfJmpReg(op uint8, dst, src uint8, off int16) bpfInsn {
	return bpfInsn{Code: unix.BPF_JMP | op | unix.BPF_X, Regs: bpfInsnRegs(dst, src), Off: off}
}

func bpfCall(fn int32) bpfInsn {
	return bpfInsn{Code: unix.BPF_JMP | unix.BPF_CALL, Imm: fn}
}

func bpfExit() bpfInsn {
	return bpfInsn{Code: unix.BPF_JMP | unix.BPF_EXIT}
}

// bpfLdMapFD 是两条指令的 ld_imm64，src=BPF_PSEUDO_MAP_FD 让加载器把 fd 换成 map 指针。
func bpfLdMapFD(dst uint8, fd int) []bpfInsn {
	return []bpfInsn{
		{Code: unix.BPF_LD | unix.BPF_DW | unix.BPF_IMM, Regs: bpfInsnRegs(dst, unix.BPF_PSEUDO_MAP_FD), Imm: int32(fd)},
		{},
	}
}

const (
	bpfReg0  = 0
	bpfReg1  = 1
	bpfReg2  = 2
	bpfReg3  = 3
	bpfReg4  = 4
	bpfReg6  = 6
	bpfReg7  = 7
	bpfReg8  = 8
	bpfReg9  = 9
	bpfReg10 = 10

	bpfSkDrop = 0
	bpfSkPass = 1

	// __sk_buff.len 在 ctx 的偏移 0。
	bpfSkBuffLenOffset = 0
	// 辅助函数编号（include/uapi/linux/bpf.h），x/sys 没有导出。
	bpfFuncMapLookupElem   = 1
	bpfFuncGetSocketCookie = 46
	bpfFuncSkRedirectHash  = 72
)

// bpfAssembler 拼指令，跳转用标签，最后再算偏移。
type bpfAssembler struct {
	insns  []bpfInsn
	labels map[string]int
	fixups []bpfFixup
}

type bpfFixup struct {
	index int
	label string
}

func (a *bpfAssembler) emit(insns ...bpfInsn) {
	a.insns = append(a.insns, insns...)
}

func (a *bpfAssembler) label(name string) {
	if a.labels == nil {
		a.labels = map[string]int{}
	}
	a.labels[name] = len(a.insns)
}

// jump 记一条带标签的跳转，偏移在 finish 时回填。
func (a *bpfAssembler) jump(insn bpfInsn, label string) {
	a.fixups = append(a.fixups, bpfFixup{index: len(a.insns), label: label})
	a.insns = append(a.insns, insn)
}

func (a *bpfAssembler) finish() []bpfInsn {
	for _, fix := range a.fixups {
		target, ok := a.labels[fix.label]
		if !ok {
			panic("bpf assembler: unknown label " + fix.label)
		}
		a.insns[fix.index].Off = int16(target - fix.index - 1)
	}
	return a.insns
}

// sockmapVerdictProgram（r6 = skb，r7 = pairs 值，r8 = ctrl 值，r9 = skb->len）：
//
//	if (skb->len == 0) return SK_DROP
//	cookie = get_socket_cookie(skb)
//	pair   = pairs[cookie];              if (!pair) return SK_PASS
//	ctrl   = ctrl[cookie];               if (!ctrl) goto redirect
//	if (ctrl->mode == redirect)          goto redirect
//	if (ctrl->mode == pass)              goto pass_count
//	// resume
//	if (pair->resumedGen == ctrl->gen)   goto redirect
//	if (pair->passed != ctrl->drained)   goto pass_count
//	pair->resumedGen = ctrl->gen
//	redirect:
//	  if (sk_redirect_hash(skb, targets, &pair->peer, 0) == SK_PASS) pair->redirected += len
//	  return SK_PASS
//	pass_count:
//	  pair->passed += len
//	  return SK_PASS
//
// 对端不在 targets 里（已经关了）时重定向失败，数据按 SK_PASS 进本连接的 ingress
// 队列但不计入 passed，用户态在 redirect 模式下读到它就知道对端没了。
func sockmapVerdictProgram(pairsFD, ctrlFD, targetsFD int) []bpfInsn {
	a := &bpfAssembler{}
	a.emit(bpfMov64Reg(bpfReg6, bpfReg1))
	// 5.19 起纯 FIN 的空 skb 也会送进判决程序；重定向一个 0 字节的 skb 会让对端
	// psock 的后台发送把它当硬错误（EPIPE）并停掉发送。空的直接丢：FIN 本身在
	// 入队时就已经处理过了，这个 skb 只是个占位。
	a.emit(bpfLdxMem(unix.BPF_W, bpfReg9, bpfReg6, bpfSkBuffLenOffset))
	a.jump(bpfJmpImm(unix.BPF_JEQ, bpfReg9, 0, 0), "drop")
	a.emit(
		bpfMov64Reg(bpfReg1, bpfReg6),
		bpfCall(bpfFuncGetSocketCookie),
		bpfStxMem(unix.BPF_DW, bpfReg10, bpfReg0, -8),
	)
	a.emit(bpfLdMapFD(bpfReg1, pairsFD)...)
	a.emit(
		bpfMov64Reg(bpfReg2, bpfReg10),
		bpfAdd64Imm(bpfReg2, -8),
		bpfCall(bpfFuncMapLookupElem),
	)
	a.jump(bpfJmpImm(unix.BPF_JEQ, bpfReg0, 0, 0), "pass")
	a.emit(bpfMov64Reg(bpfReg7, bpfReg0))
	a.emit(bpfLdMapFD(bpfReg1, ctrlFD)...)
	a.emit(
		bpfMov64Reg(bpfReg2, bpfReg10),
		bpfAdd64Imm(bpfReg2, -8),
		bpfCall(bpfFuncMapLookupElem),
	)
	a.jump(bpfJmpImm(unix.BPF_JEQ, bpfReg0, 0, 0), "redirect")
	a.emit(
		bpfMov64Reg(bpfReg8, bpfReg0),
		bpfLdxMem(unix.BPF_DW, bpfReg1, bpfReg8, 0), // ctrl->mode
	)
	a.jump(bpfJmpImm(unix.BPF_JEQ, bpfReg1, sockmapModeRedirect, 0), "redirect")
	a.jump(bpfJmpImm(unix.BPF_JEQ, bpfReg1, sockmapModePass, 0), "pass_count")
	a.emit(
		bpfLdxMem(unix.BPF_DW, bpfReg1, bpfReg8, 8),  // ctrl->gen
		bpfLdxMem(unix.BPF_DW, bpfReg2, bpfReg7, 24), // pair->resumedGen
	)
	a.jump(bpfJmpReg(unix.BPF_JEQ, bpfReg1, bpfReg2, 0), "redirect")
	a.emit(
		bpfLdxMem(unix.BPF_DW, bpfReg2, bpfReg7, 16), // pair->passed
		bpfLdxMem(unix.BPF_DW, bpfReg3, bpfReg8, 16), // ctrl->drained
	)
	a.jump(bpfJmpReg(unix.BPF_JNE, bpfReg2, bpfReg3, 0), "pass_count")
	a.emit(bpfStxMem(unix.BPF_DW, bpfReg7, bpfReg1, 24)) // pair->resumedGen = ctrl->gen

	a.label("redirect")
	a.emit(
		bpfLdxMem(unix.BPF_DW, bpfReg3, bpfReg7, 0), // pair->peer
		bpfStxMem(unix.BPF_DW, bpfReg10, bpfReg3, -16),
		bpfMov64Reg(bpfReg1, bpfReg6),
	)
	a.emit(bpfLdMapFD(bpfReg2, targetsFD)...)
	a.emit(
		bpfMov64Reg(bpfReg3, bpfReg10),
		bpfAdd64Imm(bpfReg3, -16),
		bpfMov64Imm(bpfReg4, 0),
		bpfCall(bpfFuncSkRedirectHash),
	)
	a.jump(bpfJmpImm(unix.BPF_JEQ, bpfReg0, bpfSkDrop, 0), "pass")
	a.emit(bpfAtomicAdd64(bpfReg7, bpfReg9, 8)) // pair->redirected += len
	a.jump(bpfJmpImm(unix.BPF_JA, 0, 0, 0), "pass")

	a.label("pass_count")
	a.emit(bpfAtomicAdd64(bpfReg7, bpfReg9, 16)) // pair->passed += len

	a.label("pass")
	a.emit(bpfMov64Imm(bpfReg0, bpfSkPass), bpfExit())

	a.label("drop")
	a.emit(bpfMov64Imm(bpfReg0, bpfSkDrop), bpfExit())
	return a.finish()
}

type bpfMapCreateAttr struct {
	MapType    uint32
	KeySize    uint32
	ValueSize  uint32
	MaxEntries uint32
	MapFlags   uint32
	InnerMapFD uint32
	NumaNode   uint32
	MapName    [16]byte
}

type bpfMapElemAttr struct {
	MapFD uint32
	_     uint32
	Key   uint64
	Value uint64
	Flags uint64
}

type bpfProgLoadAttr struct {
	ProgType           uint32
	InsnCnt            uint32
	Insns              uint64
	License            uint64
	LogLevel           uint32
	LogSize            uint32
	LogBuf             uint64
	KernVersion        uint32
	ProgFlags          uint32
	ProgName           [16]byte
	ProgIfindex        uint32
	ExpectedAttachType uint32
}

type bpfProgAttachAttr struct {
	TargetFD    uint32
	AttachBPFFD uint32
	AttachType  uint32
	AttachFlags uint32
}

func bpfSyscall(cmd int, attr unsafe.Pointer, size uintptr) (int, error) {
	r, _, errno := unix.Syscall(unix.SYS_BPF, uintptr(cmd), uintptr(attr), size)
	if errno != 0 {
		return -1, errno
	}
	return int(r), nil
}

func bpfObjectName(name string) [16]byte {
	var out [16]byte
	copy(out[:15], name)
	return out
}

func bpfMapCreate(mapType, keySize, valueSize, maxEntries uint32, name string) (int, error) {
	attr := bpfMapCreateAttr{MapType: mapType, KeySize: keySize, ValueSize: valueSize, MaxEntries: maxEntries, MapName: bpfObjectName(name)}
	return bpfSyscall(unix.BPF_MAP_CREATE, unsafe.Pointer(&attr), unsafe.Sizeof(attr))
}

func bpfMapUpdate(fd int, key, value unsafe.Pointer, flags uint64) error {
	attr := bpfMapElemAttr{MapFD: uint32(fd), Key: uint64(uintptr(key)), Value: uint64(uintptr(value)), Flags: flags}
	_, err := bpfSyscall(unix.BPF_MAP_UPDATE_ELEM, unsafe.Pointer(&attr), unsafe.Sizeof(attr))
	return err
}

func bpfMapLookup(fd int, key, value unsafe.Pointer) error {
	attr := bpfMapElemAttr{MapFD: uint32(fd), Key: uint64(uintptr(key)), Value: uint64(uintptr(value))}
	_, err := bpfSyscall(unix.BPF_MAP_LOOKUP_ELEM, unsafe.Pointer(&attr), unsafe.Sizeof(attr))
	return err
}

func bpfMapDelete(fd int, key unsafe.Pointer) error {
	attr := bpfMapElemAttr{MapFD: uint32(fd), Key: uint64(uintptr(key))}
	_, err := bpfSyscall(unix.BPF_MAP_DELETE_ELEM, unsafe.Pointer(&attr), unsafe.Sizeof(attr))
	return err
}

func bpfProgLoad(progType uint32, insns []bpfInsn, name string) (int, error) {
	license := []byte("GPL\x00")
	logBuf := make([]byte, 64*1024)
	attr := bpfProgLoadAttr{
		ProgType: progType,
		InsnCnt:  uint32(len(insns)),
		Insns:    uint64(uintptr(unsafe.Pointer(&insns[0]))),
		License:  uint64(uintptr(unsafe.Pointer(&license[0]))),
		LogLevel: 1,
		LogSize:  uint32(len(logBuf)),
		LogBuf:   uint64(uintptr(unsafe.Pointer(&logBuf[0]))),
		ProgName: bpfObjectName(name),
	}
	fd, err := bpfSyscall(unix.BPF_PROG_LOAD, unsafe.Pointer(&attr), unsafe.Sizeof(attr))
	if err != nil {
		text := strings.TrimSpace(unix.ByteSliceToString(logBuf))
		if len(text) > 600 {
			text = text[len(text)-600:]
		}
		if text != "" {
			return -1, fmt.Errorf("%w: %s", err, text)
		}
		return -1, err
	}
	return fd, nil
}

func bpfProgAttach(targetFD, progFD int, attachType uint32) error {
	attr := bpfProgAttachAttr{TargetFD: uint32(targetFD), AttachBPFFD: uint32(progFD), AttachType: attachType}
	_, err := bpfSyscall(unix.BPF_PROG_ATTACH, unsafe.Pointer(&attr), unsafe.Sizeof(attr))
	return err
}

// ---- map 操作 ------------------------------------------------------------------

// setPair 只在对接前调用一次：socket 进了 sources 以后 pairs 的值归判决程序写。
func (relay *sockmapRelay) setPair(cookie, peer uint64) error {
	key := cookie
	value := sockmapPairValue{Peer: peer}
	return bpfMapUpdate(relay.pairsFD, unsafe.Pointer(&key), unsafe.Pointer(&value), unix.BPF_ANY)
}

func (relay *sockmapRelay) deletePair(cookie uint64) {
	key := cookie
	_ = bpfMapDelete(relay.pairsFD, unsafe.Pointer(&key))
}

func (relay *sockmapRelay) pairStats(cookie uint64) (sockmapPairValue, error) {
	key := cookie
	var value sockmapPairValue
	if err := bpfMapLookup(relay.pairsFD, unsafe.Pointer(&key), unsafe.Pointer(&value)); err != nil {
		return sockmapPairValue{}, err
	}
	return value, nil
}

func (relay *sockmapRelay) setCtrl(cookie uint64, value sockmapCtrlValue) error {
	key := cookie
	return bpfMapUpdate(relay.ctrlFD, unsafe.Pointer(&key), unsafe.Pointer(&value), unix.BPF_ANY)
}

func (relay *sockmapRelay) deleteCtrl(cookie uint64) {
	key := cookie
	_ = bpfMapDelete(relay.ctrlFD, unsafe.Pointer(&key))
}

func (relay *sockmapRelay) addSocket(mapFD int, cookie uint64, fd int) error {
	key := cookie
	value := uint32(fd)
	return bpfMapUpdate(mapFD, unsafe.Pointer(&key), unsafe.Pointer(&value), unix.BPF_ANY)
}

func (relay *sockmapRelay) removeSocket(mapFD int, cookie uint64) error {
	key := cookie
	err := bpfMapDelete(mapFD, unsafe.Pointer(&key))
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	return err
}

// ---- socket 辅助 ----------------------------------------------------------------

func withConnFD(conn *net.TCPConn, fn func(fd int) error) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var inner error
	if err := raw.Control(func(fd uintptr) { inner = fn(int(fd)) }); err != nil {
		return err
	}
	return inner
}

func socketCookie(conn *net.TCPConn) (uint64, error) {
	var cookie uint64
	err := withConnFD(conn, func(fd int) error {
		value, err := unix.GetsockoptUint64(fd, unix.SOL_SOCKET, unix.SO_COOKIE)
		cookie = value
		return err
	})
	return cookie, err
}

// sockmapKick 让内核把接收队列里已经排着的数据过一遍判决程序（见文件头 3）。
func sockmapKick(fd int) error {
	return unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_RCVLOWAT, 1)
}

// tcpHandedBytes 是这个 socket 已经交给 TCP 协议栈的数据字节数（已确认 + 发送队列）。
// 先读 bytes_acked 再读 SIOCOUTQ：中间来了 ACK 只会把结果算小，不会算大 ——
// 半关闭和切回要等「积压为零」，宁可多等一轮也不能提前。
func tcpHandedBytes(fd int) (uint64, error) {
	info, err := unix.GetsockoptTCPInfo(fd, unix.SOL_TCP, unix.TCP_INFO)
	if err != nil {
		return 0, err
	}
	outq, err := unix.IoctlGetInt(fd, unix.SIOCOUTQ)
	if err != nil {
		return 0, err
	}
	return info.Bytes_acked + uint64(outq), nil
}

// sockmapPeek 不取走地看一眼：n=0 且 err=nil 是 EOF，EAGAIN 是没数据。
func sockmapPeek(fd int) (int, error) {
	var buf [1]byte
	n, _, err := unix.Recvfrom(fd, buf[:], unix.MSG_PEEK|unix.MSG_DONTWAIT)
	return n, err
}

// sockmapSocketBroken 看 socket 有没有出错 / 被对端整个关掉（RST、本端 close）。
func sockmapSocketBroken(fd int) bool {
	fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLRDHUP}}
	n, err := unix.Poll(fds, 0)
	if err != nil || n <= 0 {
		return false
	}
	return fds[0].Revents&(unix.POLLERR|unix.POLLHUP|unix.POLLNVAL) != 0
}

// ---- 一对连接 --------------------------------------------------------------------

type sockmapPair struct {
	relay *sockmapRelay
	ab    sockmapDirection
	ba    sockmapDirection
}

type sockmapDirection struct {
	name      string
	pair      *sockmapPair
	src, dst  *net.TCPConn
	srcCookie uint64
	dstCookie uint64
	// baseline 是对接前 dst 已经交给协议栈的字节数（之前用户态写进去的那些）。
	baseline uint64
	// userBytes 是本方向在用户态写进 dst 的字节数（resume 阶段拷过去的）。
	userBytes uint64
	// ingressRead 是从 src 的 ingress 队列读走的放行字节数，和 pairs.passed 对账。
	ingressRead uint64
	// gen 是 resume 的代次，每次切回加一。
	gen uint64
}

var (
	errSockmapPeerGone = errors.New("sockmap peer socket is gone")
	errSockmapIdle     = errors.New("sockmap direction idle")
)

// splice 把两条已建立的 TCP 连接交给内核对接。accepted 是本端 accept 下来的
// （可能已经排着对方先发的数据），dialed 是本端拨出去的。失败时两条连接保持
// 原样可用，调用方走用户态中继。
func (relay *sockmapRelay) splice(accepted, dialed *net.TCPConn) (*sockmapPair, error) {
	cookieA, err := socketCookie(accepted)
	if err != nil {
		return nil, fmt.Errorf("accepted cookie: %w", err)
	}
	cookieB, err := socketCookie(dialed)
	if err != nil {
		return nil, fmt.Errorf("dialed cookie: %w", err)
	}
	pair := &sockmapPair{relay: relay}
	pair.ab = sockmapDirection{name: "accepted->dialed", pair: pair, src: accepted, dst: dialed, srcCookie: cookieA, dstCookie: cookieB}
	pair.ba = sockmapDirection{name: "dialed->accepted", pair: pair, src: dialed, dst: accepted, srcCookie: cookieB, dstCookie: cookieA}
	if err := pair.ab.calibrate(); err != nil {
		return nil, err
	}
	if err := pair.ba.calibrate(); err != nil {
		return nil, err
	}
	cleanup := func() {
		_ = relay.removeSocket(relay.sourcesFD, cookieA)
		_ = relay.removeSocket(relay.sourcesFD, cookieB)
		_ = relay.removeSocket(relay.targetsFD, cookieA)
		_ = relay.removeSocket(relay.targetsFD, cookieB)
		relay.deletePair(cookieA)
		relay.deletePair(cookieB)
		relay.deleteCtrl(cookieA)
		relay.deleteCtrl(cookieB)
	}
	if err := relay.setPair(cookieA, cookieB); err != nil {
		cleanup()
		return nil, fmt.Errorf("pairs: %w", err)
	}
	if err := relay.setPair(cookieB, cookieA); err != nil {
		cleanup()
		return nil, fmt.Errorf("pairs: %w", err)
	}
	if err := pair.ab.setMode(sockmapModeRedirect); err != nil {
		cleanup()
		return nil, fmt.Errorf("ctrl: %w", err)
	}
	if err := pair.ba.setMode(sockmapModeRedirect); err != nil {
		cleanup()
		return nil, fmt.Errorf("ctrl: %w", err)
	}
	// 先进 targets（没有程序，只是让它们能被找到），再进 sources。拨出去的那条
	// 先进 sources：它这时几乎不可能已经收到数据；accept 下来的那条进去以后踢一下，
	// 把它排队的数据按序送走。
	if err := withConnFD(accepted, func(fd int) error { return relay.addSocket(relay.targetsFD, cookieA, fd) }); err != nil {
		cleanup()
		return nil, fmt.Errorf("targets add accepted: %w", err)
	}
	if err := withConnFD(dialed, func(fd int) error { return relay.addSocket(relay.targetsFD, cookieB, fd) }); err != nil {
		cleanup()
		return nil, fmt.Errorf("targets add dialed: %w", err)
	}
	if err := pair.ba.attach(); err != nil {
		cleanup()
		return nil, fmt.Errorf("sources add dialed: %w", err)
	}
	if err := pair.ab.attach(); err != nil {
		// 对方可能已经往 accepted 的发送队列里送了数据，要等它写完再拆，不然随
		// psock 一起丢掉。
		_ = pair.ba.waitDrained(time.Second, nil)
		cleanup()
		return nil, fmt.Errorf("sources add accepted: %w", err)
	}
	relay.active.Add(1)
	relay.spliced.Add(1)
	return pair, nil
}

func (d *sockmapDirection) calibrate() error {
	return withConnFD(d.dst, func(fd int) error {
		handed, err := tcpHandedBytes(fd)
		d.baseline = handed
		return err
	})
}

// attach 把 src 放进 sources 并踢一下。
func (d *sockmapDirection) attach() error {
	return withConnFD(d.src, func(fd int) error {
		if err := d.pair.relay.addSocket(d.pair.relay.sourcesFD, d.srcCookie, fd); err != nil {
			return err
		}
		return sockmapKick(fd)
	})
}

func (d *sockmapDirection) setMode(mode uint64) error {
	return d.pair.relay.setCtrl(d.srcCookie, sockmapCtrlValue{Mode: mode, Gen: d.gen, Drained: d.ingressRead})
}

func (d *sockmapDirection) stats() (sockmapPairValue, error) {
	return d.pair.relay.pairStats(d.srcCookie)
}

// submitted 是本方向交给 dst 的总字节数：程序重定向的加用户态写的。
func (d *sockmapDirection) submitted() (uint64, error) {
	stats, err := d.stats()
	if err != nil {
		return 0, err
	}
	return stats.Redirected + d.userBytes, nil
}

func (d *sockmapDirection) handed() (uint64, error) {
	var handed uint64
	err := withConnFD(d.dst, func(fd int) error {
		value, err := tcpHandedBytes(fd)
		handed = value
		return err
	})
	if err != nil {
		return 0, err
	}
	if handed < d.baseline {
		return 0, nil
	}
	return handed - d.baseline, nil
}

// backlog 是内核里还没写进 dst 的字节数。
func (d *sockmapDirection) backlog() (submitted uint64, backlog int64, err error) {
	submitted, err = d.submitted()
	if err != nil {
		return 0, 0, err
	}
	handed, err := d.handed()
	if err != nil {
		return 0, 0, err
	}
	return submitted, int64(submitted) - int64(handed), nil
}

func (d *sockmapDirection) dstBroken() bool {
	broken := true
	_ = withConnFD(d.dst, func(fd int) error {
		broken = sockmapSocketBroken(fd)
		return nil
	})
	return broken
}

func (d *sockmapDirection) srcBroken() bool {
	broken := true
	_ = withConnFD(d.src, func(fd int) error {
		broken = sockmapSocketBroken(fd)
		return nil
	})
	return broken
}

// waitDrained 等 dst 的积压清零。dst 坏掉返回 errSockmapPeerGone；stall 内没有
// 任何进展就放弃（stall ≤ 0 表示一直等）；lingering 置位且空闲超过 stall 返回
// errSockmapIdle。
func (d *sockmapDirection) waitDrained(stall time.Duration, lingering *atomic.Bool) error {
	lastProgress := time.Now()
	var lastHanded uint64
	poll := sockmapDrainPoll
	for {
		submitted, err := d.submitted()
		if err != nil {
			return err
		}
		handed, err := d.handed()
		if err != nil {
			return err
		}
		if handed >= submitted {
			return nil
		}
		if handed != lastHanded {
			lastHanded = handed
			lastProgress = time.Now()
			poll = sockmapDrainPoll
		} else if poll < sockmapDrainPollMax {
			poll *= 2
			if poll > sockmapDrainPollMax {
				poll = sockmapDrainPollMax
			}
		}
		if d.dstBroken() {
			return errSockmapPeerGone
		}
		if stall > 0 && time.Since(lastProgress) > stall {
			if lingering != nil && lingering.Load() {
				return errSockmapIdle
			}
			return fmt.Errorf("sockmap drain timeout: %d bytes still queued", submitted-handed)
		}
		time.Sleep(poll)
	}
}

type sockmapWaitOutcome int

const (
	sockmapWaitTick sockmapWaitOutcome = iota
	sockmapWaitEOF
	sockmapWaitIngress
)

// waitSrc 在 redirect 模式下等 src 上发生点什么：EOF、ingress 里出现数据（重定向
// 失败，对端没了），或者到了看积压的时间。
func (d *sockmapDirection) waitSrc(deadline time.Time) (sockmapWaitOutcome, error) {
	if err := d.src.SetReadDeadline(deadline); err != nil {
		return sockmapWaitTick, err
	}
	raw, err := d.src.SyscallConn()
	if err != nil {
		return sockmapWaitTick, err
	}
	outcome := sockmapWaitTick
	var inner error
	err = raw.Read(func(fd uintptr) bool {
		n, perr := sockmapPeek(int(fd))
		if perr != nil {
			if errors.Is(perr, unix.EAGAIN) || errors.Is(perr, unix.EINTR) {
				return false
			}
			inner = perr
			return true
		}
		if n == 0 {
			outcome = sockmapWaitEOF
			return true
		}
		outcome = sockmapWaitIngress
		return true
	})
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return sockmapWaitTick, nil
		}
		return sockmapWaitTick, err
	}
	return outcome, inner
}

// run 跑一个方向直到它结束：EOF 时等积压清零再半关闭对端，返回 nil；出错返回
// 错误（调用方立刻关两边）。lingering 由另一个方向先结束时置位：之后本方向
// 空闲超过 linger 就结束。
func (d *sockmapDirection) run(linger time.Duration, lingering *atomic.Bool) error {
	var lastSubmitted uint64
	lastProgress := time.Now()
	tick := sockmapTickActive
	for {
		outcome, err := d.waitSrc(time.Now().Add(tick))
		if err != nil {
			return fmt.Errorf("wait: %w", err)
		}
		switch outcome {
		case sockmapWaitEOF:
			return d.finishEOF(linger, lingering)
		case sockmapWaitIngress:
			// redirect 模式下只有重定向失败才会有数据落到 ingress：对端 socket 已经
			// 不在了。
			return errSockmapPeerGone
		}
		submitted, backlog, err := d.backlog()
		if err != nil {
			return fmt.Errorf("backlog: %w", err)
		}
		if submitted != lastSubmitted {
			lastSubmitted = submitted
			lastProgress = time.Now()
			tick = sockmapTickActive
		} else if tick < sockmapTickIdle {
			tick *= 2
			if tick > sockmapTickIdle {
				tick = sockmapTickIdle
			}
		}
		if backlog >= sockmapBacklogHigh {
			done, err := d.throttleAndResume(linger, lingering)
			if err != nil || done {
				return err
			}
			lastProgress = time.Now()
			tick = sockmapTickActive
			continue
		}
		if lingering.Load() && time.Since(lastProgress) > linger {
			return nil
		}
	}
}

// finishEOF 处理 src 的 EOF：等 dst 积压清零再半关闭它。
func (d *sockmapDirection) finishEOF(linger time.Duration, lingering *atomic.Bool) error {
	if err := d.waitDrained(linger, lingering); err != nil {
		if errors.Is(err, errSockmapIdle) {
			return nil
		}
		return fmt.Errorf("drain before half close: %w", err)
	}
	closeWrite(d.dst)
	return nil
}

// throttleAndResume 是背压的一个来回：切到 pass 模式让窗口关上，等 dst 的积压
// 清零，再把 ingress 里攒下的数据按序拷过去，程序随即自己切回重定向。返回
// done=true 表示本方向已经结束（EOF 或 lingering 空闲）。
func (d *sockmapDirection) throttleAndResume(linger time.Duration, lingering *atomic.Bool) (bool, error) {
	if err := d.setMode(sockmapModePass); err != nil {
		return false, fmt.Errorf("throttle: %w", err)
	}
	d.pair.relay.throttles.Add(1)
	// 积压清零才能在用户态往 dst 写，否则会抢在内核后台队列里的数据前面。
	// lingering 时空闲超过 linger 就结束；否则一直等，和用户态中继里一个写不动的
	// Write 一样。
	stall := time.Duration(0)
	if lingering.Load() {
		stall = linger
	}
	if err := d.waitDrained(stall, lingering); err != nil {
		if errors.Is(err, errSockmapIdle) {
			return true, nil
		}
		return false, fmt.Errorf("drain before resume: %w", err)
	}
	d.gen++
	if err := d.setMode(sockmapModeResume); err != nil {
		return false, fmt.Errorf("resume: %w", err)
	}
	buf := getBuffer()
	defer putBuffer(buf)
	lastProgress := time.Now()
	for {
		if err := d.src.SetReadDeadline(time.Now().Add(sockmapTickActive)); err != nil {
			return false, err
		}
		// 不用 io.Copy：*net.TCPConn 之间它会走 splice(2)，绕过 recvmsg，看不见
		// psock 的 ingress 队列。
		n, err := d.src.Read(buf)
		if n > 0 {
			if _, werr := d.dst.Write(buf[:n]); werr != nil {
				return false, fmt.Errorf("resume write: %w", werr)
			}
			d.userBytes += uint64(n)
			d.ingressRead += uint64(n)
			lastProgress = time.Now()
			if err := d.setMode(sockmapModeResume); err != nil {
				return false, fmt.Errorf("resume: %w", err)
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return true, d.finishEOF(linger, lingering)
			}
			if !isTimeout(err) {
				return false, fmt.Errorf("resume read: %w", err)
			}
		}
		stats, serr := d.stats()
		if serr != nil {
			return false, serr
		}
		// 程序已经切回，或者放行的都读完了（下一个 skb 到达时程序会切回）：回到
		// redirect 模式的监视循环。
		if stats.ResumedGen == d.gen || stats.Passed == d.ingressRead {
			return false, nil
		}
		if n == 0 {
			if d.srcBroken() || d.dstBroken() {
				return false, errSockmapPeerGone
			}
			if lingering.Load() && time.Since(lastProgress) > linger {
				return true, nil
			}
		}
	}
}

func (d *sockmapDirection) runNamed(linger time.Duration, lingering *atomic.Bool) error {
	err := d.run(linger, lingering)
	if err != nil {
		return fmt.Errorf("%s: %w", d.name, err)
	}
	return nil
}

// run 等两个方向都结束，语义和 relayTCPBidirectional 一致：先结束的方向出错就
// 立刻关两边；正常 EOF 则半关闭对端，另一个方向进入 linger。返回前两端都已关闭。
func (pair *sockmapPair) run(linger time.Duration) (result Result) {
	relay := pair.relay
	defer relay.active.Add(-1)
	defer func() {
		if sockmapDebug {
			for _, d := range []*sockmapDirection{&pair.ab, &pair.ba} {
				st, _ := d.stats()
				handed, herr := d.handed()
				Logf("sockmap %s end: redirected=%d passed=%d user=%d handed=%d (%v)", d.name, st.Redirected, st.Passed, d.userBytes, handed, herr)
			}
		}
		if sent, err := pair.ab.submitted(); err == nil {
			result.AcceptedToDialed = sent
		}
		if sent, err := pair.ba.submitted(); err == nil {
			result.DialedToAccepted = sent
		}
		_ = pair.ab.src.Close()
		_ = pair.ba.src.Close()
		relay.deletePair(pair.ab.srcCookie)
		relay.deletePair(pair.ba.srcCookie)
		relay.deleteCtrl(pair.ab.srcCookie)
		relay.deleteCtrl(pair.ba.srcCookie)
	}()
	if linger <= 0 {
		linger = DefaultLinger
	}
	var lingering atomic.Bool
	results := make(chan error, 2)
	go func() { results <- pair.ab.runNamed(linger, &lingering) }()
	go func() { results <- pair.ba.runNamed(linger, &lingering) }()
	first := <-results
	if first != nil {
		if sockmapDebug {
			Logf("sockmap pair ended with error: %v", first)
		}
		_ = pair.ab.src.Close()
		_ = pair.ba.src.Close()
		<-results
		return result
	}
	lingering.Store(true)
	if second := <-results; second != nil && sockmapDebug {
		Logf("sockmap pair second direction ended with error: %v", second)
	}
	return result
}

// sockmapDebug 打印每对连接结束的原因；只在排查时打开。
var sockmapDebug = os.Getenv("NEX_SOCKMAP_DEBUG") != ""

// Relay 尝试用 sockmap 对接两条连接。accepted 是本端 accept 下来的（可能已经排着
// 对方先发的数据），dialed 是本端拨出去的。返回 ok=true 表示已经接管并跑完（两端
// 已关闭），Result 是两个方向各送了多少字节；ok=false 表示没动过连接，调用方走
// 自己的用户态中继。两条连接都必须是 *net.TCPConn，被任何包装过的连接都不接管
// —— 包装层（限速、统计、PROXY 头）在内核对接后会被绕过。
func Relay(accepted, dialed net.Conn, linger time.Duration) (Result, bool) {
	a, ok := accepted.(*net.TCPConn)
	if !ok {
		return Result{}, false
	}
	b, ok := dialed.(*net.TCPConn)
	if !ok {
		return Result{}, false
	}
	relay := sockmapRelayGet()
	if relay == nil {
		return Result{}, false
	}
	pair, err := relay.splice(a, b)
	if err != nil {
		relay.fallbacks.Add(1)
		if spliceFailLog.allow() {
			Logf("sockmap splice failed, using userspace relay: %v", err)
		}
		return Result{}, false
	}
	return pair.run(linger), true
}

// Status 给心跳 / 诊断用：enabled / disabled: <原因> / off。
func Status() string { return sockmapRelayStatus() }

// Snapshot 返回进程内的计数。
func Snapshot() Stats {
	relay := sockmapRelayGet()
	if relay == nil {
		return Stats{}
	}
	return Stats{
		Active:    relay.active.Load(),
		Spliced:   relay.spliced.Load(),
		Fallbacks: relay.fallbacks.Load(),
		Throttles: relay.throttles.Load(),
	}
}

// ---- 自检 ---------------------------------------------------------------------

// selfTest 在回环上走一遍完整流程：插入前排队的数据、双向数据、半关闭顺序、一
// 段够大的传输（让背压逻辑真的触发）。任何一步不对就不启用。
func (relay *sockmapRelay) selfTest() error {
	listenA, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listenA.Close()
	listenB, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listenB.Close()
	client, err := net.DialTimeout("tcp", listenA.Addr().String(), sockmapSelfTestTimeout)
	if err != nil {
		return err
	}
	defer client.Close()
	accepted, err := listenA.Accept()
	if err != nil {
		return err
	}
	dialed, err := net.DialTimeout("tcp", listenB.Addr().String(), sockmapSelfTestTimeout)
	if err != nil {
		_ = accepted.Close()
		return err
	}
	server, err := listenB.Accept()
	if err != nil {
		_ = accepted.Close()
		_ = dialed.Close()
		return err
	}
	defer server.Close()
	// 对接之前客户端就先说话：这是最常见的形态（协议握手），也是踢一下要解决的。
	if _, err := client.Write([]byte("pre-splice")); err != nil {
		return err
	}
	time.Sleep(5 * time.Millisecond)
	pair, err := relay.splice(accepted.(*net.TCPConn), dialed.(*net.TCPConn))
	if err != nil {
		_ = accepted.Close()
		_ = dialed.Close()
		return err
	}
	done := make(chan struct{})
	go func() {
		pair.run(2 * time.Second)
		close(done)
	}()
	deadline := time.Now().Add(sockmapSelfTestTimeout)
	_ = client.SetDeadline(deadline)
	_ = server.SetDeadline(deadline)
	readExact := func(conn net.Conn, want string) error {
		buf := make([]byte, len(want))
		if _, err := readFull(conn, buf); err != nil {
			return fmt.Errorf("read %q: %w", want, err)
		}
		if string(buf) != want {
			return fmt.Errorf("read %q, want %q", string(buf), want)
		}
		return nil
	}
	if err := readExact(server, "pre-splice"); err != nil {
		return err
	}
	if _, err := server.Write([]byte("pong")); err != nil {
		return err
	}
	if err := readExact(client, "pong"); err != nil {
		return err
	}
	// 一段 12MB：比积压上限大，服务端故意晚一点再读，让背压的来回真的走一遍。
	const bulk = 12 << 20
	payload := make([]byte, bulk)
	for i := range payload {
		payload[i] = byte(i*7 + i>>8)
	}
	writeErr := make(chan error, 1)
	go func() {
		_, err := client.Write(payload)
		writeErr <- err
	}()
	time.Sleep(60 * time.Millisecond)
	got := make([]byte, bulk)
	if _, err := readFull(server, got); err != nil {
		return fmt.Errorf("bulk read: %w", err)
	}
	for i := range got {
		if got[i] != payload[i] {
			return fmt.Errorf("bulk payload corrupted at byte %d", i)
		}
	}
	if err := <-writeErr; err != nil {
		return fmt.Errorf("bulk write: %w", err)
	}
	// 半关闭：客户端最后一段数据 + FIN，服务端必须先读到数据再读到 EOF。
	if _, err := client.Write([]byte("tail")); err != nil {
		return err
	}
	closeWrite(client)
	if err := readExact(server, "tail"); err != nil {
		return err
	}
	if n, err := server.Read(make([]byte, 1)); err == nil || n != 0 {
		return fmt.Errorf("expected EOF after half close, got n=%d err=%v", n, err)
	}
	// 半关闭后另一个方向还活着。
	if _, err := server.Write([]byte("after-fin")); err != nil {
		return err
	}
	if err := readExact(client, "after-fin"); err != nil {
		return err
	}
	_ = server.Close()
	if n, err := client.Read(make([]byte, 1)); err == nil || n != 0 {
		return fmt.Errorf("expected EOF after server close, got n=%d err=%v", n, err)
	}
	select {
	case <-done:
	case <-time.After(sockmapSelfTestTimeout):
		return errors.New("relay did not finish after both ends closed")
	}
	return nil
}

func readFull(conn net.Conn, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := conn.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}
