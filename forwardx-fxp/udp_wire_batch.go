package main

import (
	"net"
	"net/netip"
	"sync"
	"unsafe"
)

// fxpUDPWireBatch 给往隧道发线上包的协程（入口发往出口、出口回给入口）攒包用：每个包直接封在
// 一块 slab 里、首尾相接（ws.wire 指向 slab 里的下一格，sealPacketInto 就地封），攒够一批或者
// 手里没有更多包时一次发出去；等长的一串在 Linux 上合成一条 GSO 消息（udp_batch_linux.go）。
// 不支持批量发（非 Linux、关了批量）时 newFXPUDPWireBatch 返回 nil，调用方逐包发。
//
// slab 第一次真要攒包时才从池里借，release 时还回去；不发包的会话不占。
type fxpUDPWireBatch struct {
	sender *fxpUDPBatchSender
	slab   []byte
	off    int
	wires  [][]byte
}

var fxpUDPWireSlabPool = sync.Pool{New: func() any {
	slab := make([]byte, fxpUDPBatchSize*fxpUDPMaxWirePacketSize)
	return &slab
}}

func newFXPUDPWireBatch(conn *net.UDPConn) *fxpUDPWireBatch {
	sender := newFXPUDPBatchSender(conn)
	if sender == nil {
		return nil
	}
	return &fxpUDPWireBatch{sender: sender, wires: make([][]byte, 0, fxpUDPBatchSize)}
}

// prepare 让 ws.wire 指向 slab 里的下一格。批次满了返回 false（调用方先 flush 再 prepare）。
func (b *fxpUDPWireBatch) prepare(ws *fxpUDPWorkspace) bool {
	if b.slab == nil {
		b.slab = *fxpUDPWireSlabPool.Get().(*[]byte)
	}
	if len(b.wires) >= fxpUDPBatchSize || len(b.slab)-b.off < fxpUDPMaxWirePacketSize {
		return false
	}
	ws.wire = b.slab[b.off : b.off : b.off+fxpUDPMaxWirePacketSize]
	return true
}

// add 记下刚封好的线上包。正常情况下它就封在 prepare 给的那一格里；不是的话（封装时换了缓冲）
// 拷进来，保证批次里的包首尾相接。
func (b *fxpUDPWireBatch) add(wire []byte) {
	if len(wire) == 0 {
		return
	}
	slot := b.slab[b.off : b.off+len(wire)]
	if unsafe.SliceData(wire) != unsafe.SliceData(slot) {
		copy(slot, wire)
	}
	b.wires = append(b.wires, slot)
	b.off += len(wire)
	b.sender.add(slot)
}

func (b *fxpUDPWireBatch) pending() int { return len(b.wires) }

// flushTo 把攒下的包发给 dst；发出去以后每个包调一次 onSent（抗丢包要把线上包拷走）。
func (b *fxpUDPWireBatch) flushTo(dst netip.AddrPort, onSent func([]byte)) error {
	if len(b.wires) == 0 {
		return nil
	}
	err := b.sender.flushTo(dst)
	if err == nil && onSent != nil {
		for _, wire := range b.wires {
			onSent(wire)
		}
	}
	clear(b.wires)
	b.wires = b.wires[:0]
	b.off = 0
	return err
}

// release 还掉 slab，并让 ws.wire 不再指着它。
func (b *fxpUDPWireBatch) release(ws *fxpUDPWorkspace) {
	if b == nil {
		return
	}
	if b.slab != nil {
		slab := b.slab
		b.slab = nil
		fxpUDPWireSlabPool.Put(&slab)
	}
	clear(b.wires)
	b.wires = b.wires[:0]
	b.off = 0
	if ws != nil {
		ws.wire = make([]byte, 0, fxpUDPMaxWirePacketSize)
	}
}
