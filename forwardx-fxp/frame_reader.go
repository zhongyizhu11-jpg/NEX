package main

import (
	"errors"
	"io"
)

/*
加密帧的读缓冲。

以前读一帧要两次系统调用：先 io.ReadFull 读 20 字节的帧长度，解开后再 io.ReadFull
读帧内容。千兆线路上每秒两千帧，就是四千次只搬 20 字节的 read。现在一次 read
尽量把内核里攒着的都搬进来（缓冲能装两个满帧），通常一次就有好几帧，帧内容还在
缓冲里就地解密，不再另外拷一份。

缓冲从池里借，分两档：从空闲状态醒来先借 4 KiB 的小缓冲 —— 等 hello 的预热连接
能有几百条，只跑小帧的会话（UDP 小包、交互式 TCP）也用不着大的；哪一帧装不下
了再换成两帧的大缓冲，之后一直用它，数据在流的时候缓冲本来就不会空。连接的读
出错（对端断开、超时，对这条连接来说都是终点）就把缓冲还回池里，握手确认之后
也先还回去（连接池里的连接要空等）。bufio.Reader 做不到这些，所以自己写一个，
只有 peek / discard / readFull 三个动作。
*/

// fxpFrameReaderIdleSize 是从空闲状态醒来时先借的小缓冲。
const fxpFrameReaderIdleSize = 4 * 1024

// errFXPFrameReaderOverflow：要求的字节数超过了大缓冲，调用方该走 readFull。
var errFXPFrameReaderOverflow = errors.New("fxp frame reader: request exceeds buffer")

type fxpFrameReader struct {
	src io.Reader
	// buf 是池里借来的缓冲，空闲时为 nil；buf[r:w] 是还没交出去的字节。
	buf  []byte
	r, w int
}

func newFXPFrameReader(src io.Reader) *fxpFrameReader {
	return &fxpFrameReader{src: src}
}

// buffered 是缓冲里还没交出去的字节数。
func (fr *fxpFrameReader) buffered() int {
	return fr.w - fr.r
}

// release 在没有未读字节时把缓冲还回池里。上一次 peek 交出的切片指向这块缓冲，
// 所以只能在调用方用完那些字节之后再调。
func (fr *fxpFrameReader) release() {
	if fr.buf != nil && fr.r == fr.w {
		fr.drop()
	}
}

// drop 不管有没有未读字节，都把缓冲还回池里。只给已经作废的连接用。
func (fr *fxpFrameReader) drop() {
	if fr.buf != nil {
		putFXPByteBuffer(fr.buf)
		fr.buf = nil
	}
	fr.r, fr.w = 0, 0
}

// peekBuffered 返回已经在缓冲里的前 n 个未读字节；不够就返回 nil，不去读连接，
// 也不挪动缓冲 —— 之前 peek 交出的切片仍然有效。
func (fr *fxpFrameReader) peekBuffered(n int) []byte {
	if n <= 0 || fr.w-fr.r < n {
		return nil
	}
	return fr.buf[fr.r : fr.r+n]
}

// peek 保证缓冲里至少有 n 个未读字节并返回它们，不前进。缓冲里不够就从连接读，
// 读到的往往比 n 多得多，后面的帧就不用再进内核了。n 不能超过大缓冲的容量。
//
// 出错的口径和 io.ReadFull 一样：一个字节都没有就是 io.EOF，有一部分是
// io.ErrUnexpectedEOF —— 上层靠这个区分「对端在帧边界上断开」和「帧断在半截」。
// 出错时缓冲还回池里：读出错的连接不会再读了。
func (fr *fxpFrameReader) peek(n int) ([]byte, error) {
	if n > fxpFrameReadBufferSize {
		return nil, errFXPFrameReaderOverflow
	}
	if n <= 0 {
		return fr.buf[fr.r:fr.r], nil
	}
	if fr.w-fr.r >= n {
		return fr.buf[fr.r : fr.r+n], nil
	}
	if fr.buf == nil {
		fr.buf = getFXPByteBuffer(fxpFrameReaderIdleSize)
		fr.r, fr.w = 0, 0
	}
	if n > len(fr.buf) {
		// 小缓冲装不下这一帧：换成两帧的大缓冲，已有的字节搬过去。
		big := getFXPByteBuffer(fxpFrameReadBufferSize)
		fr.w = copy(big, fr.buf[fr.r:fr.w])
		fr.r = 0
		putFXPByteBuffer(fr.buf)
		fr.buf = big
	} else if fr.r == fr.w {
		// 空了就从头开始，一次读能装得最多。
		fr.r, fr.w = 0, 0
	} else if fr.r+n > len(fr.buf) {
		// 这一帧放不进缓冲尾部了，把未读的挪到开头。大缓冲能装两个满帧，满帧
		// 的流上这种挪动基本碰不到；小帧的流上挪的也只是不到一帧的零头。
		fr.w = copy(fr.buf, fr.buf[fr.r:fr.w])
		fr.r = 0
	}
	for fr.w-fr.r < n {
		m, err := fr.src.Read(fr.buf[fr.w:])
		if m < 0 || m > len(fr.buf)-fr.w {
			fr.drop()
			return nil, errors.New("fxp frame reader: invalid read count")
		}
		fr.w += m
		if fr.w-fr.r >= n {
			break
		}
		if err != nil {
			if errors.Is(err, io.EOF) && fr.w > fr.r {
				err = io.ErrUnexpectedEOF
			}
			fr.drop()
			return nil, err
		}
		if m == 0 {
			fr.drop()
			return nil, io.ErrNoProgress
		}
	}
	return fr.buf[fr.r : fr.r+n], nil
}

// discard 把前 n 个未读字节标为已交出。
func (fr *fxpFrameReader) discard(n int) {
	if n < 0 || n > fr.w-fr.r {
		panic("fxp frame reader: discard beyond buffered bytes")
	}
	fr.r += n
}

// readFull 把 len(dst) 个字节读进 dst：缓冲里有的先搬过去，剩下的直接从连接读。
// 给超过缓冲容量的帧和握手阶段用，口径同 io.ReadFull；出错时缓冲同样还回池里。
func (fr *fxpFrameReader) readFull(dst []byte) error {
	n := copy(dst, fr.buf[fr.r:fr.w])
	fr.r += n
	if n == len(dst) {
		return nil
	}
	_, err := io.ReadFull(fr.src, dst[n:])
	if err != nil {
		if n > 0 && errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		fr.drop()
	}
	return err
}
