package main

import (
	"net"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

/*
明文 → 隧道这个方向（入口的上传、出口的下载）的流水线：读明文的协程和「封帧 + 写进隧道」的
协程分开跑。

以前一条连接的一个方向就一个协程：读一块明文（内核拷一遍）→ AES-GCM 封帧 → 写进隧道
（内核再拷一遍），三件事排着做，一条流最快就是一个核串着干完这三步的速度。真机上单流只有
线路的三成左右，这是主要原因之一。现在读到大块数据时把这块交给写出协程，读协程马上去读
下一块：读和「封 + 写」落在两个核上同时进行。

  - 只在大块（≥ fxpSealPipelineMinChunk）或者写出协程还有活的时候才交接。交互式的小写
    （SSH 敲键、一问一答）写出协程是空着的，就地封帧写出，和以前一样没有任何多出来的唤醒。
  - 顺序：只有读协程往写出协程交活；读协程自己写之前先确认写出协程手里没有活（inFlight 为 0），
    所以帧的先后和读到的先后完全一致，计数、nonce 都不会乱。
  - 限速、协议拦截都还在读协程里、交出去之前做，和以前一样「拦截在任何字节写出之前」。
  - 写出失败：写出协程记下错误，把明文侧的读超时设到现在，叫醒还卡在 Read 里的读协程，
    读协程马上返回这个错误（和以前写失败当场返回一样，代理随即关掉两头）。
  - 读到 EOF：等手里的活都写完，再写结束帧。读出错（不是 EOF）直接返回，不等写出协程：
    它要是正卡在写隧道上，等它就会把代理关连接的那一步也卡住。
  - 内存：写出协程用完就把缓冲还回池里；空闲的连接只占读协程手里那一块，和以前一样。
    同一时刻最多 fxpSealPipelineDepth 块在排队。
*/

const (
	// 一次读到这么多以上才交给写出协程；再小就就地写（交接的唤醒比省下的时间还多）。
	fxpSealPipelineMinChunk = 16 * 1024
	// 排队等写的块数上限（另有一块正在写、一块正在读）。
	fxpSealPipelineDepth = 2
)

// fxpCopyPipelineEnabled 在测试里关掉它对比老的串行路径。
var fxpCopyPipelineEnabled = true

// fxpCopyPipelineUseful：只有一个核（GOMAXPROCS=1）时两段没法同时跑，交接和隧道那一侧
// 多出来的那次拷贝只是白花的（本机实测单核时明文帧慢约 5%），这时走串行路径。
func fxpCopyPipelineUseful() bool {
	return fxpCopyPipelineEnabled && runtime.GOMAXPROCS(0) > 1
}

type fxpSealJob struct {
	buf []byte
	n   int
	end bool
}

type fxpSealPipeline struct {
	dst     frameConn
	src     net.Conn
	counter *atomic.Uint64

	started  bool
	closed   bool
	jobs     chan fxpSealJob
	exited   chan struct{}
	inFlight atomic.Int32

	failOnce sync.Once
	failed   chan struct{}
	err      error
}

func newFXPSealPipeline(dst frameConn, src net.Conn, counter *atomic.Uint64) *fxpSealPipeline {
	return &fxpSealPipeline{dst: dst, src: src, counter: counter, failed: make(chan struct{})}
}

// failure 是写出协程记下的错误；没有失败为 nil。
func (p *fxpSealPipeline) failure() error {
	select {
	case <-p.failed:
		return p.err
	default:
		return nil
	}
}

func (p *fxpSealPipeline) fail(err error) {
	p.failOnce.Do(func() {
		p.err = err
		close(p.failed)
		// 读协程可能正卡在 Read 里：叫醒它，让它马上带着这个错误返回。
		if p.src != nil {
			_ = p.src.SetReadDeadline(time.Now())
		}
	})
}

// writeChunk 把一块明文切成帧、合成一次写。
func (p *fxpSealPipeline) writeChunk(chunk []byte) error {
	var frames [fxpCopyBatchFrames][]byte
	batch := frames[:0]
	for len(chunk) > fxpCopyChunkSize {
		batch = append(batch, chunk[:fxpCopyChunkSize])
		chunk = chunk[fxpCopyChunkSize:]
	}
	batch = append(batch, chunk)
	return p.dst.writeFrames(batch...)
}

// write 写出 buf 的前 n 个字节：小块、写出协程空着就就地写；否则把 buf 交给写出协程，
// 返回一块新的缓冲给读协程接着读。
func (p *fxpSealPipeline) write(buf []byte, n int) ([]byte, error) {
	if err := p.failure(); err != nil {
		return buf, err
	}
	if !fxpCopyPipelineUseful() || (n < fxpSealPipelineMinChunk && p.inFlight.Load() == 0) {
		if err := p.writeChunk(buf[:n]); err != nil {
			return buf, err
		}
		if p.counter != nil {
			p.counter.Add(uint64(n))
		}
		return buf, nil
	}
	p.start()
	p.inFlight.Add(1)
	select {
	case p.jobs <- fxpSealJob{buf: buf, n: n}:
	case <-p.failed:
		p.inFlight.Add(-1)
		return buf, p.err
	}
	return getFXPByteBuffer(fxpCopyReadSize), nil
}

func (p *fxpSealPipeline) start() {
	if p.started {
		return
	}
	p.started = true
	p.jobs = make(chan fxpSealJob, fxpSealPipelineDepth)
	p.exited = make(chan struct{})
	go p.run()
}

func (p *fxpSealPipeline) run() {
	defer close(p.exited)
	for job := range p.jobs {
		var err error
		if p.failure() == nil {
			if job.end {
				err = p.dst.writeFrame(nil)
			} else {
				err = p.writeChunk(job.buf[:job.n])
				if err == nil && p.counter != nil {
					p.counter.Add(uint64(job.n))
				}
			}
		}
		if job.buf != nil {
			putFXPByteBuffer(job.buf)
		}
		p.inFlight.Add(-1)
		if err != nil {
			p.fail(err)
		}
	}
}

// finish 在明文侧读到 EOF 时调用：手里的活写完以后写结束帧，返回第一个写出错误。
func (p *fxpSealPipeline) finish() error {
	if err := p.failure(); err != nil {
		p.abandon()
		return err
	}
	if !p.started {
		return p.dst.writeFrame(nil)
	}
	p.inFlight.Add(1)
	select {
	case p.jobs <- fxpSealJob{end: true}:
	case <-p.failed:
		p.inFlight.Add(-1)
	}
	p.closed = true
	close(p.jobs)
	<-p.exited
	return p.failure()
}

// abandon 在出错返回时调用：不再交活，也不等写出协程（它可能正卡在写隧道上）。它写完或
// 写失败（代理会关掉隧道）后自己退出，缓冲自己还。
func (p *fxpSealPipeline) abandon() {
	if p.started && !p.closed {
		p.closed = true
		close(p.jobs)
	}
}

/*
隧道 → 明文这个方向（入口的下载、出口往目标写）同样分两段：读协程收帧、解密，写出协程往明文
侧写。readFrames 交出的明文指着隧道连接的读缓冲、下一次读之前有效，所以交接时拷进一块池里的
缓冲（一次内存拷贝，比内核里的那两次便宜得多），写出协程一次 write 写完、把缓冲还回去。

  - 小批（< fxpSealPipelineMinChunk）且写出协程空着：就地 writev，和以前一样。
  - 限速、主机出口整形在读协程里、交接之前等。
  - 写出失败：写出协程记下错误并关掉隧道这一头（代理拿到错误以后本来也要关），叫醒卡在
    readFrames 里的读协程，读协程返回这个错误。
  - 读到结束帧：等手里的活写完，再半关明文侧。
*/

type fxpPlainPipeline struct {
	dst     net.Conn
	src     frameConn
	counter *atomic.Uint64

	started  bool
	closed   bool
	jobs     chan []byte
	exited   chan struct{}
	inFlight atomic.Int32
	buffers  net.Buffers

	failOnce sync.Once
	failed   chan struct{}
	err      error
}

func newFXPPlainPipeline(dst net.Conn, src frameConn, counter *atomic.Uint64) *fxpPlainPipeline {
	return &fxpPlainPipeline{dst: dst, src: src, counter: counter, failed: make(chan struct{})}
}

func (p *fxpPlainPipeline) failure() error {
	select {
	case <-p.failed:
		return p.err
	default:
		return nil
	}
}

func (p *fxpPlainPipeline) fail(err error) {
	p.failOnce.Do(func() {
		p.err = err
		close(p.failed)
		if p.src != nil {
			p.src.closeTransport()
		}
	})
}

// write 写出一批明文帧（总长 total）：小批、写出协程空着就就地写，否则拷一份交给写出协程。
func (p *fxpPlainPipeline) write(frames [][]byte, total int) error {
	if err := p.failure(); err != nil {
		return err
	}
	if !fxpCopyPipelineUseful() || total > fxpFrameReadBufferSize || (total < fxpSealPipelineMinChunk && p.inFlight.Load() == 0) {
		if p.inFlight.Load() != 0 {
			// 大帧（多路径的大帧）装不进池里那一档：等写出协程手里的写完再就地写，顺序不乱。
			if err := p.drain(); err != nil {
				return err
			}
		}
		if err := p.writeFrames(frames); err != nil {
			return err
		}
		if p.counter != nil {
			p.counter.Add(uint64(total))
		}
		return nil
	}
	buf := getFXPByteBuffer(total)
	offset := 0
	for _, frame := range frames {
		offset += copy(buf[offset:], frame)
	}
	p.start()
	p.inFlight.Add(1)
	select {
	case p.jobs <- buf[:offset]:
		return nil
	case <-p.failed:
		p.inFlight.Add(-1)
		putFXPByteBuffer(buf)
		return p.err
	}
}

func (p *fxpPlainPipeline) writeFrames(frames [][]byte) error {
	if len(frames) == 1 {
		_, err := p.dst.Write(frames[0])
		return err
	}
	// p.buffers 挂在结构体上：WriteTo 取它的地址，不再每批在堆上分配一个切片头。
	p.buffers = net.Buffers(frames)
	_, err := p.buffers.WriteTo(p.dst)
	p.buffers = nil
	return err
}

// drain 等写出协程手里的活都写完（大帧要就地写之前用）。
func (p *fxpPlainPipeline) drain() error {
	for p.inFlight.Load() != 0 {
		select {
		case <-p.failed:
			return p.err
		case <-time.After(time.Millisecond):
		}
	}
	return p.failure()
}

func (p *fxpPlainPipeline) start() {
	if p.started {
		return
	}
	p.started = true
	p.jobs = make(chan []byte, fxpSealPipelineDepth)
	p.exited = make(chan struct{})
	go p.run()
}

func (p *fxpPlainPipeline) run() {
	defer close(p.exited)
	for buf := range p.jobs {
		var err error
		if p.failure() == nil {
			_, err = p.dst.Write(buf)
			if err == nil && p.counter != nil {
				p.counter.Add(uint64(len(buf)))
			}
		}
		putFXPByteBuffer(buf)
		p.inFlight.Add(-1)
		if err != nil {
			p.fail(err)
		}
	}
}

// finish 在读到结束帧时调用：手里的活写完再返回（调用方随后半关明文侧）。
func (p *fxpPlainPipeline) finish() error {
	if !p.started {
		return p.failure()
	}
	if !p.closed {
		p.closed = true
		close(p.jobs)
	}
	<-p.exited
	return p.failure()
}

// abandon 出错返回时调用：不等写出协程。
func (p *fxpPlainPipeline) abandon() {
	if p.started && !p.closed {
		p.closed = true
		close(p.jobs)
	}
}
