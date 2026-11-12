package v3

// 多路复用会话。帧头沿用上游（type u8、流号 u32 BE、长度 u16 BE），OPEN / CLOSE 后面跟一个
// 单独的填充帧也和上游一样。流控是 NEX 自己的（见 PROTOCOL.md「NEX 修订」）：
//
//   - 每条流有一个**隐含的初始窗口**（StreamBuffer，默认 128 KiB）：OPEN 之后不用等对端发
//     第一次额度就能直接写。移植版每条新流都要先等一个往返的额度，短连接因此多一个 RTT。
//   - 窗口**按需放大**：接收端发现「对端把额度全用完了、而本地读的一方已经把缓冲读空了」——
//     也就是卡住发送的是窗口、不是读得慢——就把这条流的窗口放大（1 MiB 以下 ×4，以上 ×2），
//     最大 MaxStreamWindow（默认 16 MiB）。读得慢的流缓冲是满的，不会触发放大。
//   - 放大的部分从会话的预算（SessionBuffer，默认 32 MiB）和整个进程的预算
//     （GlobalWindowBudget，默认 256 MiB）里扣，流结束时还回去：一条流再快也占不满内存，
//     最坏情况下的内存上限仍然是确定的。
//   - 额度只在攒够窗口的四分之一时才发，不是读一次发一次。
//
// 写路径：业务数据拷进池里的帧缓冲（帧头已经写好），写协程把排着的帧一次取一批，交给内层
// 一次封好、一次系统调用写出。读路径：帧内容读进池里的块，直接挂到流上，读空了还回池里。
import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"math/big"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

var (
	ErrStreamLimit    = errors.New("v3: stream limit reached")
	ErrWindowExceeded = errors.New("v3: peer exceeded receive window")
	ErrDraining       = errors.New("v3: session is draining")
	ErrIdle           = errors.New("v3: idle session expired")
)

// dataChunk 是一个 DATA 帧最多带多少业务字节（帧内容 = 1 字节标记 + 数据，长度字段 u16）。
// 帧可以跨内层记录：内层是字节流，会话自己按帧头切。
const dataChunk = MaxPayload - 1

// DefaultWriteTimeout 是一次物理写的上限。导出给调用方推健康阈值用。
const DefaultWriteTimeout = 10 * time.Second

const (
	DefaultStreamWindow    = 128 << 10
	DefaultMaxStreamWindow = 16 << 20
	DefaultSessionGrowth   = 32 << 20
	// maxCreditOutstanding：对端给的额度累计不能超过这个数（防伪造额度把计数撑爆）。
	maxCreditOutstanding = 64 << 20
	// writeBatchBytes / writeBatchFrames：写协程一批最多拼多少。
	writeBatchBytes  = 512 << 10
	writeBatchFrames = 64
)

// GlobalWindowBudget 是本进程所有会话放大窗口的总预算（字节）。
var GlobalWindowBudget int64 = 256 << 20

var globalWindowGrowth atomic.Int64

// DATA 帧内容的第一个字节：0 业务字节，1 额度（u32 BE），2 BLOCKED（发送端额度用完了，
// 没有别的内容）。BLOCKED 是 NEX 加的：接收端靠它知道卡住发送的是窗口还是读得慢。
const streamBytes byte = 0
const streamCredit byte = 1
const streamBlocked byte = 2

type SessionOptions struct {
	Client     bool
	MaxStreams int
	// StreamBuffer 是每条流的初始窗口（两端必须一样，它是隐含的）。
	StreamBuffer int
	// MaxStreamWindow 是一条流的窗口最多放大到多少；不大于 StreamBuffer 就是不放大。
	MaxStreamWindow int
	// SessionBuffer 是这个会话里所有流放大窗口的总预算。
	SessionBuffer int
	IdleTimeout   time.Duration
	WriteTimeout  time.Duration
}

// frameBufs 是写路径的帧缓冲池：帧头 7 + 标记 1 + 最多 dataChunk 字节。
var frameBufs = sync.Pool{New: func() any { b := make([]byte, HeaderSize+1+dataChunk); return &b }}

// rxBufs 是读路径的块：一个 DATA 帧的业务字节读进一块里。
var rxBufs = sync.Pool{New: func() any { b := make([]byte, 0, dataChunk); return &b }}

type writeRequest struct {
	frame  []byte  // 完整的线上帧（帧头已写好）
	pooled *[]byte // frame 来自 frameBufs 时，写完还回去
	open   uint32  // 非零：这是一个 OPEN（按到达顺序和数据同一条队列，保证先于数据上线）
	stream *Stream
	result chan error
}

type rxChunk struct {
	buf *[]byte
	off int
}

// Session 不管有多少条流，都只有三个协程。
type Session struct {
	conn         net.Conn
	out          buffersWriter
	opts         SessionOptions
	mu           sync.Mutex
	openMu       sync.Mutex
	streams      map[uint32]*Stream
	nextID       uint32
	lastRemoteID uint32
	buffered     int
	growth       int
	idleSince    time.Time
	// lastWrite 是上一次成功的物理写。对端悄悄没了的会话还会报「有空位」，池子拿它判断
	// 会话最近有没有证明过自己活着。
	lastWrite   time.Time
	draining    bool
	err         error
	done        chan struct{}
	accept      chan *Stream
	writes      chan writeRequest
	controls    chan []byte
	creditWake  chan struct{}
	creditQueue []*Stream
	wg          sync.WaitGroup
}

// buffersWriter 是能把几段一次写出的连接（InnerConn）。
type buffersWriter interface {
	WriteBuffers([][]byte) error
}

type plainBuffersWriter struct{ conn net.Conn }

func (w plainBuffersWriter) WriteBuffers(bufs [][]byte) error {
	if len(bufs) == 1 {
		return writeFull(w.conn, bufs[0])
	}
	total := 0
	for _, b := range bufs {
		total += len(b)
	}
	out := make([]byte, 0, total)
	for _, b := range bufs {
		out = append(out, b...)
	}
	return writeFull(w.conn, out)
}

func NewSession(conn net.Conn, opts SessionOptions) *Session {
	if opts.MaxStreams <= 0 || opts.MaxStreams > 128 {
		opts.MaxStreams = 128
	}
	if opts.StreamBuffer <= 0 || opts.StreamBuffer > 1<<20 {
		opts.StreamBuffer = DefaultStreamWindow
	}
	if opts.MaxStreamWindow == 0 {
		opts.MaxStreamWindow = DefaultMaxStreamWindow
	}
	if opts.MaxStreamWindow < opts.StreamBuffer {
		opts.MaxStreamWindow = opts.StreamBuffer
	}
	if opts.MaxStreamWindow > maxCreditOutstanding/2 {
		opts.MaxStreamWindow = maxCreditOutstanding / 2
	}
	if opts.SessionBuffer <= 0 {
		opts.SessionBuffer = DefaultSessionGrowth
	}
	if opts.IdleTimeout <= 0 {
		opts.IdleTimeout = 30 * time.Second
	}
	if opts.WriteTimeout <= 0 {
		opts.WriteTimeout = DefaultWriteTimeout
	}
	out, ok := conn.(buffersWriter)
	if !ok {
		out = plainBuffersWriter{conn}
	}
	s := &Session{conn: conn, out: out, opts: opts, streams: make(map[uint32]*Stream), nextID: 1,
		idleSince: time.Now(), lastWrite: time.Now(), done: make(chan struct{}),
		accept: make(chan *Stream, opts.MaxStreams),
		writes: make(chan writeRequest, 64), controls: make(chan []byte, 128), creditWake: make(chan struct{}, 1)}
	s.wg.Add(3)
	go func() { defer s.wg.Done(); s.readLoop() }()
	go func() { defer s.wg.Done(); s.writeLoop() }()
	go func() { defer s.wg.Done(); s.idleLoop() }()
	return s
}

func (s *Session) Done() <-chan struct{} { return s.done }
func (s *Session) Wait()                 { s.wg.Wait() }
func (s *Session) Err() error            { s.mu.Lock(); defer s.mu.Unlock(); return s.err }
func (s *Session) ActiveStreams() int    { s.mu.Lock(); defer s.mu.Unlock(); return len(s.streams) }
func (s *Session) BufferedBytes() int    { s.mu.Lock(); defer s.mu.Unlock(); return s.buffered }

// WindowGrowth 是这个会话现在放大了多少窗口（测试 / 诊断用）。
func (s *Session) WindowGrowth() int { s.mu.Lock(); defer s.mu.Unlock(); return s.growth }

// GlobalWindowGrowth 是整个进程现在放大了多少窗口（测试 / 诊断用）。
func GlobalWindowGrowth() int64 { return globalWindowGrowth.Load() }

func (s *Session) LastWrite() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastWrite
}

// Alive：会话能用、并且 maxAge 之内成功写过。对端悄悄没了的会话还会报有空位，
// 池子不能只看空位数。
func (s *Session) Alive(maxAge time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil || s.draining {
		return false
	}
	if maxAge <= 0 {
		return true
	}
	return time.Since(s.lastWrite) <= maxAge
}

// AgeLastWrite 把记录的成功写时间往回拨，给包外的测试走「半开会话」那条路。
func (s *Session) AgeLastWrite(d time.Duration) {
	s.mu.Lock()
	s.lastWrite = time.Now().Add(-d)
	s.mu.Unlock()
}

func (s *Session) OpenSlots() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil || s.draining {
		return 0
	}
	return s.opts.MaxStreams - len(s.streams)
}
func (s *Session) Close() error { s.fail(net.ErrClosed); return nil }

func (s *Session) fail(err error) {
	s.mu.Lock()
	if s.err != nil {
		s.mu.Unlock()
		return
	}
	s.err = err
	close(s.done)
	for _, st := range s.streams {
		s.finishLocked(st, err)
	}
	s.mu.Unlock()
	_ = s.conn.Close()
}

// Drain 不再接新流，已有的流照常跑完。
func (s *Session) Drain() {
	s.mu.Lock()
	s.draining = true
	empty := len(s.streams) == 0
	s.mu.Unlock()
	if empty {
		s.fail(ErrDraining)
	}
}

func (s *Session) newStreamLocked(id uint32) *Stream {
	w := s.opts.StreamBuffer
	st := &Stream{session: s, id: id, changed: make(chan struct{}), window: w, receiveCredit: w, sendCredit: w}
	s.streams[id] = st
	s.idleSince = time.Time{}
	return st
}

// Open 开一条流。OPEN 帧排进和数据同一条队列，不等它写出去就返回：这条流可以马上写
// （初始窗口是隐含的），会话要是已经坏了，第一次写会报错。
func (s *Session) Open() (*Stream, error) {
	s.openMu.Lock()
	defer s.openMu.Unlock()
	s.mu.Lock()
	if s.err != nil {
		err := s.err
		s.mu.Unlock()
		return nil, err
	}
	if !s.opts.Client || s.draining {
		s.mu.Unlock()
		return nil, ErrDraining
	}
	if len(s.streams) >= s.opts.MaxStreams {
		s.mu.Unlock()
		return nil, ErrStreamLimit
	}
	if s.nextID == 0 {
		s.draining = true
		s.mu.Unlock()
		return nil, ErrDraining
	}
	st := s.newStreamLocked(s.nextID)
	s.nextID++
	s.mu.Unlock()
	select {
	case s.writes <- writeRequest{open: st.id, stream: st}:
	case <-s.done:
		s.mu.Lock()
		s.finishLocked(st, net.ErrClosed)
		err := s.err
		s.mu.Unlock()
		return nil, err
	}
	return st, nil
}

func (s *Session) Accept() (*Stream, error) {
	for {
		select {
		case <-s.done:
			return nil, s.Err()
		case st := <-s.accept:
			s.mu.Lock()
			live := st.err == nil && s.err == nil
			s.mu.Unlock()
			if live {
				return st, nil
			}
		}
	}
}

func encodeControl(kind byte, id uint32) ([]byte, error) {
	total := 26
	if kind == FrameOpen {
		// 上游 0xa0bd20：crypto/rand.Int(max-min)+min，OpenStream 传 (20,100)。
		n, err := rand.Int(rand.Reader, big.NewInt(80))
		if err != nil {
			return nil, err
		}
		total = 20 + int(n.Int64())
	}
	buf := make([]byte, total)
	buf[0] = kind
	binary.BigEndian.PutUint32(buf[1:5], id)
	buf[HeaderSize] = FramePadding
	binary.BigEndian.PutUint16(buf[HeaderSize+5:HeaderSize+7], uint16(total-2*HeaderSize))
	return buf, nil
}

// control 排一个会话级控制帧（CLOSE）。队列满了不拆会话，等位置（受会话寿命约束）。
func (s *Session) control(kind byte, id uint32) {
	frame, err := encodeControl(kind, id)
	if err != nil {
		s.fail(err)
		return
	}
	select {
	case <-s.done:
	case s.controls <- frame:
	}
}

// tryControl 不阻塞地排一个控制帧，报告排上没有。
func (s *Session) tryControl(kind byte, id uint32) bool {
	frame, err := encodeControl(kind, id)
	if err != nil {
		return false
	}
	select {
	case <-s.done:
		return false
	case s.controls <- frame:
		return true
	default:
		return false
	}
}

func (s *Session) finishLocked(st *Stream, err error) {
	if st.err != nil {
		return
	}
	st.err = err
	s.buffered -= st.buffered
	st.buffered = 0
	for _, chunk := range st.chunks {
		*chunk.buf = (*chunk.buf)[:0]
		rxBufs.Put(chunk.buf)
	}
	st.chunks = nil
	if grown := st.window - s.opts.StreamBuffer; grown > 0 {
		s.growth -= grown
		globalWindowGrowth.Add(-int64(grown))
		st.window = s.opts.StreamBuffer
	}
	delete(s.streams, st.id)
	if len(s.streams) == 0 {
		s.idleSince = time.Now()
	}
	st.signalLocked()
}

// growOnBlockedLocked：对端报过 BLOCKED（额度用完了），而且本地的缓冲读到只剩不到四分之一
// 窗口 —— 收到 BLOCKED 时当场判断，或者等之后第一次把缓冲读下去时再判断。
//
// 读得慢的流：每还一次额度，对端马上补满，缓冲一直接近满，降不到四分之一。只有读的速度
// × 往返时延超过约 3/4 个窗口，缓冲才会在额度补回来之前读空 —— 这正是「卡住发送的是窗口」。
// 放大的部分直接记进要还的额度里，马上发。返回有没有放大。
func (s *Session) growOnBlockedLocked(st *Stream) bool {
	if !st.blockedSeen || st.buffered > st.window/4 {
		return false
	}
	st.blockedSeen = false
	if st.window >= s.opts.MaxStreamWindow {
		return false
	}
	grow := st.window
	if st.window < 1<<20 {
		grow = 3 * st.window
	}
	if st.window+grow > s.opts.MaxStreamWindow {
		grow = s.opts.MaxStreamWindow - st.window
	}
	if room := s.opts.SessionBuffer - s.growth; grow > room {
		grow = room
	}
	if room := GlobalWindowBudget - globalWindowGrowth.Load(); int64(grow) > room {
		grow = int(room)
	}
	if grow <= 0 {
		return false
	}
	if globalWindowGrowth.Add(int64(grow)) > GlobalWindowBudget {
		globalWindowGrowth.Add(-int64(grow))
		return false
	}
	st.window += grow
	s.growth += grow
	st.creditDue += grow
	return true
}

// queueCreditLocked：要还的额度攒到窗口的四分之一（force 时只要有），就交给写协程发。
func (s *Session) queueCreditLocked(st *Stream, force bool) {
	if st.creditQueued || st.creditDue == 0 || (!force && st.creditDue < st.window/4) {
		return
	}
	st.creditQueued = true
	s.creditQueue = append(s.creditQueue, st)
	select {
	case s.creditWake <- struct{}{}:
	default:
	}
}

// takeCreditsLocked 把排着的额度编成帧追加到 dst。
func (s *Session) takeCreditsLocked(dst [][]byte) [][]byte {
	for _, st := range s.creditQueue {
		st.creditQueued = false
		if st.err != nil || st.remoteEOF || st.creditDue == 0 {
			continue
		}
		frame := make([]byte, HeaderSize+5)
		frame[0] = FrameData
		binary.BigEndian.PutUint32(frame[1:5], st.id)
		binary.BigEndian.PutUint16(frame[5:7], 5)
		frame[HeaderSize] = streamCredit
		binary.BigEndian.PutUint32(frame[HeaderSize+1:], uint32(st.creditDue))
		st.receiveCredit += st.creditDue
		st.creditDue = 0
		dst = append(dst, frame)
	}
	s.creditQueue = s.creditQueue[:0]
	return dst
}

func (s *Session) readLoop() {
	var header [HeaderSize]byte
	var scratch []byte
	for {
		if _, err := io.ReadFull(s.conn, header[:]); err != nil {
			s.fail(err)
			return
		}
		kind, id := header[0], binary.BigEndian.Uint32(header[1:5])
		n := int(binary.BigEndian.Uint16(header[5:7]))
		if kind < FrameOpen || kind > FrameType5 {
			s.fail(ErrFrameType)
			return
		}
		if kind == FramePadding {
			if cap(scratch) < n {
				scratch = make([]byte, n)
			}
			if _, err := io.ReadFull(s.conn, scratch[:n]); err != nil {
				s.fail(err)
				return
			}
			continue
		}
		// 类型 5 在上游里没有核实过的语义，不发也不解释，收到就失败关闭。
		if kind == FrameType5 || id == 0 || ((kind == FrameOpen || kind == FrameClose) && n != 0) || (kind == FrameData && n < 1) {
			s.fail(errors.New("v3: invalid session control"))
			return
		}
		var tag byte
		var data *[]byte
		var credit [4]byte
		if kind == FrameData {
			var tagBuf [1]byte
			if _, err := io.ReadFull(s.conn, tagBuf[:]); err != nil {
				s.fail(err)
				return
			}
			tag = tagBuf[0]
			switch tag {
			case streamCredit:
				if n != 5 {
					s.fail(errors.New("v3: invalid credit frame"))
					return
				}
				if _, err := io.ReadFull(s.conn, credit[:]); err != nil {
					s.fail(err)
					return
				}
			case streamBlocked:
				if n != 1 {
					s.fail(errors.New("v3: invalid blocked frame"))
					return
				}
			case streamBytes:
				if n < 2 {
					s.fail(errors.New("v3: invalid stream data"))
					return
				}
				data = rxBufs.Get().(*[]byte)
				*data = (*data)[:n-1]
				if _, err := io.ReadFull(s.conn, *data); err != nil {
					rxBufs.Put(data)
					s.fail(err)
					return
				}
			default:
				s.fail(errors.New("v3: invalid stream data"))
				return
			}
		}
		s.mu.Lock()
		if s.err != nil {
			s.mu.Unlock()
			if data != nil {
				rxBufs.Put(data)
			}
			return
		}
		st := s.streams[id]
		closeStream := false
		switch kind {
		case FrameOpen:
			if s.opts.Client || id <= s.lastRemoteID {
				s.mu.Unlock()
				s.fail(errors.New("v3: invalid stream ID"))
				return
			}
			s.lastRemoteID = id
			if s.draining || len(s.streams) >= s.opts.MaxStreams {
				closeStream = true
			} else {
				st = s.newStreamLocked(id)
				select {
				case s.accept <- st:
				default:
					s.finishLocked(st, ErrStreamLimit)
					closeStream = true
				}
			}
		case FrameData:
			if st == nil || st.remoteEOF {
				break // 本地关掉之后还在路上的数据，丢掉就行。
			}
			if tag == streamCredit {
				grant := int(binary.BigEndian.Uint32(credit[:]))
				if grant <= 0 || st.sendCredit+grant > maxCreditOutstanding {
					s.finishLocked(st, errors.New("v3: invalid credit grant"))
					closeStream = true
				} else {
					st.sendCredit += grant
					st.blockedSent = false
					st.signalLocked()
				}
				break
			}
			if tag == streamBlocked {
				st.blockedSeen = true
				if s.growOnBlockedLocked(st) {
					s.queueCreditLocked(st, true)
				}
				break
			}
			size := len(*data)
			if size > st.receiveCredit {
				s.finishLocked(st, ErrWindowExceeded)
				closeStream = true
				break
			}
			st.receiveCredit -= size
			// 小帧（敲键、一问一答）并进上一块的空余里，一条流不会攒下成千上万的小块。
			if last := len(st.chunks) - 1; last >= 0 && cap(*st.chunks[last].buf)-len(*st.chunks[last].buf) >= size && size <= 4096 {
				*st.chunks[last].buf = append(*st.chunks[last].buf, *data...)
			} else {
				st.chunks = append(st.chunks, rxChunk{buf: data})
				data = nil
			}
			st.buffered += size
			s.buffered += size
			st.signalLocked()
		case FrameClose:
			if st != nil {
				// 槽位留到读到 EOF 或者本地 Close：这也给「没接受就关了、缓冲还没读」的流设了上限。
				st.remoteEOF = true
				st.signalLocked()
			}
		}
		drained := s.draining && len(s.streams) == 0
		s.mu.Unlock()
		if data != nil {
			*data = (*data)[:0]
			rxBufs.Put(data)
		}
		if closeStream {
			s.control(FrameClose, id)
		}
		if drained {
			s.fail(ErrDraining)
			return
		}
	}
}

// writeLoop 一次取一批：先拿所有排着的控制帧和额度，再拿数据 / OPEN，凑到上限或者
// 没有更多为止，一次写出。控制帧每一批都先拿，但不是绝对优先：每批里都有数据的份。
func (s *Session) writeLoop() {
	bufs := make([][]byte, 0, writeBatchFrames+16)
	reqs := make([]writeRequest, 0, writeBatchFrames)
	for {
		bufs, reqs = bufs[:0], reqs[:0]
		select {
		case <-s.done:
			return
		case frame := <-s.controls:
			bufs = append(bufs, frame)
		case req := <-s.writes:
			reqs = append(reqs, req)
		case <-s.creditWake:
		}
		size := 0
		for more := true; more && len(reqs) < writeBatchFrames && size < writeBatchBytes; {
			select {
			case frame := <-s.controls:
				bufs = append(bufs, frame)
				continue
			default:
			}
			select {
			case req := <-s.writes:
				reqs = append(reqs, req)
				size += len(req.frame)
			default:
				more = false
			}
		}
		s.mu.Lock()
		bufs = s.takeCreditsLocked(bufs)
		// 已经出错 / 超时的流的数据不写：对端会收到它的 CLOSE。
		live := reqs[:0]
		for _, req := range reqs {
			if req.stream != nil {
				if err := req.stream.writeErrorLocked(req.open != 0); err != nil {
					if req.result != nil {
						req.result <- err
					}
					if req.pooled != nil {
						frameBufs.Put(req.pooled)
					}
					continue
				}
			}
			live = append(live, req)
		}
		s.mu.Unlock()
		var err error
		for i := range live {
			if live[i].open != 0 {
				var frame []byte
				if frame, err = encodeControl(FrameOpen, live[i].open); err != nil {
					break
				}
				bufs = append(bufs, frame)
				continue
			}
			bufs = append(bufs, live[i].frame)
		}
		if len(bufs) > 0 && err == nil {
			err = s.conn.SetWriteDeadline(time.Now().Add(s.opts.WriteTimeout))
			if err == nil {
				err = s.out.WriteBuffers(bufs)
			}
		}
		for i := range bufs {
			bufs[i] = nil
		}
		if err == nil && len(bufs) > 0 {
			s.mu.Lock()
			s.lastWrite = time.Now()
			s.mu.Unlock()
		}
		for _, req := range live {
			if req.result != nil {
				req.result <- err
			}
			if req.pooled != nil {
				frameBufs.Put(req.pooled)
			}
		}
		if err != nil {
			s.fail(err)
			return
		}
	}
}

func (s *Session) idleLoop() {
	interval := s.opts.IdleTimeout / 2
	if interval > time.Second {
		interval = time.Second
	}
	if interval < time.Millisecond {
		interval = time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.mu.Lock()
			idle := len(s.streams) == 0 && time.Since(s.idleSince) >= s.opts.IdleTimeout
			s.mu.Unlock()
			if idle {
				s.fail(ErrIdle)
				return
			}
		}
	}
}

// Stream 是一条有界的 net.Conn。Close 关掉整条逻辑流（类型 3）。业务上的半关闭由 FXP
// 自己的 EOF 帧在流里带，不扩展上游的帧类型。
type Stream struct {
	session                     *Session
	id                          uint32
	writeMu                     sync.Mutex
	chunks                      []rxChunk
	buffered                    int
	err                         error
	remoteEOF                   bool
	sendCredit                  int
	window, receiveCredit       int
	creditDue                   int
	creditQueued                bool
	blockedSent                 bool
	blockedSeen                 bool
	readDeadline, writeDeadline time.Time
	changed                     chan struct{}
}

func (st *Stream) signalLocked() { close(st.changed); st.changed = make(chan struct{}) }

// writeErrorLocked：这条流还能不能写。open 为真时是它自己的 OPEN，对端关没关不影响。
func (st *Stream) writeErrorLocked(open bool) error {
	if st.err != nil {
		return st.err
	}
	if st.remoteEOF && !open {
		return io.ErrClosedPipe
	}
	if st.session.err != nil {
		return st.session.err
	}
	if !open && !st.writeDeadline.IsZero() && !time.Now().Before(st.writeDeadline) {
		return os.ErrDeadlineExceeded
	}
	return nil
}

func waitChange(ch, done <-chan struct{}, deadline time.Time) error {
	var timeout <-chan time.Time
	var timer *time.Timer
	if !deadline.IsZero() {
		timer = time.NewTimer(time.Until(deadline))
		timeout = timer.C
		defer timer.Stop()
	}
	select {
	case <-ch:
		return nil
	case <-done:
		return net.ErrClosed
	case <-timeout:
		return os.ErrDeadlineExceeded
	}
}

func (st *Stream) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	s := st.session
	for {
		s.mu.Lock()
		if st.err != nil {
			err := st.err
			s.mu.Unlock()
			return 0, err
		}
		if !st.readDeadline.IsZero() && !time.Now().Before(st.readDeadline) {
			s.mu.Unlock()
			return 0, os.ErrDeadlineExceeded
		}
		if len(st.chunks) > 0 {
			n := 0
			for n < len(p) && len(st.chunks) > 0 {
				chunk := &st.chunks[0]
				k := copy(p[n:], (*chunk.buf)[chunk.off:])
				chunk.off += k
				n += k
				if chunk.off >= len(*chunk.buf) {
					*chunk.buf = (*chunk.buf)[:0]
					rxBufs.Put(chunk.buf)
					st.chunks[0] = rxChunk{}
					st.chunks = st.chunks[1:]
				}
			}
			if len(st.chunks) == 0 {
				st.chunks = nil
			}
			st.buffered -= n
			s.buffered -= n
			st.creditDue += n
			s.queueCreditLocked(st, s.growOnBlockedLocked(st))
			s.mu.Unlock()
			return n, nil
		}
		if st.remoteEOF {
			s.finishLocked(st, io.EOF)
			drained := s.draining && len(s.streams) == 0
			s.mu.Unlock()
			if drained {
				s.fail(ErrDraining)
			}
			return 0, io.EOF
		}
		if s.err != nil {
			err := s.err
			s.mu.Unlock()
			return 0, err
		}
		ch, deadline := st.changed, st.readDeadline
		s.mu.Unlock()
		if err := waitChange(ch, s.done, deadline); err != nil {
			return 0, err
		}
	}
}

func (st *Stream) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	return st.writeBuffers([][]byte{p})
}

// WriteBuffers 把几段按顺序写进这条流：切成 DATA 帧（每帧受额度约束）、一起排进写队列，
// 全部写出去（或者出错）才返回。一次调用里的几帧能被写协程拼进同一次系统调用。
func (st *Stream) WriteBuffers(bufs [][]byte) error {
	_, err := st.writeBuffers(bufs)
	return err
}

// writeBuffers 返回确实写出去的字节数（出错时是出错之前那些帧的）。
func (st *Stream) writeBuffers(bufs [][]byte) (int, error) {
	st.writeMu.Lock()
	defer st.writeMu.Unlock()
	s := st.session
	total := 0
	for _, b := range bufs {
		total += len(b)
	}
	// 一次调用最多同时排 streamPipeline 帧；额度给得零碎、切出更多帧时，先等前面的写完。
	// 写协程按排队顺序回结果，sizes 记着每一帧多大，算得出写出去了多少。
	results := make(chan error, streamPipeline)
	var sizes [streamPipeline]int
	head, queued, written := 0, 0, 0
	var firstErr error
	waitOne := func() {
		var err error
		select {
		case err = <-results:
		case <-s.done:
			// 写协程退出了：还在队列里没被取走的请求不会再有结果。
			select {
			case err = <-results:
			default:
				err = s.Err()
				queued = 1
			}
		}
		if err == nil {
			written += sizes[head]
		}
		head = (head + 1) % streamPipeline
		queued--
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	bi, bo := 0, 0
	for total > 0 && firstErr == nil {
		if queued == streamPipeline {
			waitOne()
			continue
		}
		size, err := st.reserveCredit(min(total, dataChunk))
		if err != nil {
			firstErr = err
			break
		}
		pooled := frameBufs.Get().(*[]byte)
		frame := (*pooled)[:HeaderSize+1+size]
		frame[0] = FrameData
		binary.BigEndian.PutUint32(frame[1:5], st.id)
		binary.BigEndian.PutUint16(frame[5:7], uint16(size+1))
		frame[HeaderSize] = streamBytes
		for filled := 0; filled < size; {
			for bo >= len(bufs[bi]) {
				bi++
				bo = 0
			}
			k := copy(frame[HeaderSize+1+filled:], bufs[bi][bo:])
			bo += k
			filled += k
		}
		if err := st.enqueue(writeRequest{frame: frame, pooled: pooled, stream: st, result: results}); err != nil {
			frameBufs.Put(pooled)
			firstErr = err
			break
		}
		sizes[(head+queued)%streamPipeline] = size
		queued++
		total -= size
	}
	for queued > 0 {
		waitOne()
	}
	if firstErr != nil {
		// 排出去一半的数据不能留给下一条业务消息接着用：重置这条流，不动整个会话。
		_ = st.Close()
		return written, firstErr
	}
	return written, nil
}

// streamPipeline 是一条流一次写最多同时排几帧（4 × 64 KiB，正好是 FXP 一次读的大小）。
const streamPipeline = 4

func (st *Stream) enqueue(req writeRequest) error {
	s := st.session
	for {
		s.mu.Lock()
		err := st.writeErrorLocked(false)
		ch, deadline := st.changed, st.writeDeadline
		s.mu.Unlock()
		if err != nil {
			return err
		}
		var timer *time.Timer
		var timeout <-chan time.Time
		if !deadline.IsZero() {
			timer = time.NewTimer(time.Until(deadline))
			timeout = timer.C
		}
		select {
		case s.writes <- req:
		case <-s.done:
			err = net.ErrClosed
		case <-ch:
			err = errRetry
		case <-timeout:
			err = os.ErrDeadlineExceeded
		}
		if timer != nil {
			timer.Stop()
		}
		if err == errRetry {
			continue
		}
		return err
	}
}

var errRetry = errors.New("retry")

func (st *Stream) reserveCredit(size int) (int, error) {
	s := st.session
	for {
		s.mu.Lock()
		if err := st.writeErrorLocked(false); err != nil {
			s.mu.Unlock()
			return 0, err
		}
		if st.sendCredit > 0 {
			if size > st.sendCredit {
				size = st.sendCredit
			}
			st.sendCredit -= size
			s.mu.Unlock()
			return size, nil
		}
		// 额度用完了：告诉对端一次（直到再收到额度），对端据此判断要不要放大窗口。
		sendBlocked := !st.blockedSent
		st.blockedSent = true
		ch, deadline := st.changed, st.writeDeadline
		s.mu.Unlock()
		if sendBlocked {
			frame := make([]byte, HeaderSize+1)
			frame[0] = FrameData
			binary.BigEndian.PutUint32(frame[1:5], st.id)
			binary.BigEndian.PutUint16(frame[5:7], 1)
			frame[HeaderSize] = streamBlocked
			// 走数据的那条队列（先进先出），排在用完额度的那些数据后面：要是插到它们前面，
			// 对端收到 BLOCKED 时缓冲还是空的，会把一个根本不读的流的窗口也放大。
			select {
			case s.writes <- writeRequest{frame: frame}:
			default:
				// 队列满了就不报：对端读空缓冲照样会还额度，只是这一轮不放大。
			}
		}
		if err := waitChange(ch, s.done, deadline); err != nil {
			return 0, err
		}
	}
}

func (st *Stream) Close() error {
	s := st.session
	s.mu.Lock()
	already := st.err != nil
	remote := st.remoteEOF
	s.finishLocked(st, net.ErrClosed)
	drained := s.draining && len(s.streams) == 0
	s.mu.Unlock()
	if !already && !remote {
		s.control(FrameClose, st.id)
	}
	if drained {
		s.fail(ErrDraining)
	}
	return nil
}

func (st *Stream) LocalAddr() net.Addr  { return st.session.conn.LocalAddr() }
func (st *Stream) RemoteAddr() net.Addr { return st.session.conn.RemoteAddr() }
func (st *Stream) SetDeadline(t time.Time) error {
	s := st.session
	s.mu.Lock()
	st.readDeadline = t
	st.writeDeadline = t
	st.signalLocked()
	s.mu.Unlock()
	return nil
}
func (st *Stream) SetReadDeadline(t time.Time) error {
	s := st.session
	s.mu.Lock()
	st.readDeadline = t
	st.signalLocked()
	s.mu.Unlock()
	return nil
}
func (st *Stream) SetWriteDeadline(t time.Time) error {
	s := st.session
	s.mu.Lock()
	st.writeDeadline = t
	st.signalLocked()
	s.mu.Unlock()
	return nil
}
