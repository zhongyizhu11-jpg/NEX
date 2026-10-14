//go:build linux

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"

	"golang.org/x/sys/unix"
)

// ctnetlink（NETLINK_NETFILTER 的 conntrack 子系统）只用到 dump 和 DESTROY 事件，自己解析属性，
// 不为这一点引入额外依赖。属性里的数值都是网络字节序。
const (
	nfnlSubsysCTNetlink     = 1
	ipctnlMsgCtNew          = 0
	ipctnlMsgCtGet          = 1
	ipctnlMsgCtDelete       = 2
	nfnlgrpConntrackDestroy = 3
	nfnetlinkV0             = 0

	ctaTupleOrig     = 1
	ctaStatus        = 3
	ctaCountersOrig  = 9
	ctaCountersReply = 10
	ctaID            = 12
	ctaZone          = 18

	ctaTupleProto   = 2
	ctaProtoNum     = 1
	ctaProtoDstPort = 3

	ctaCountersBytes   = 2
	ctaCounters32Bytes = 4

	netlinkAttrTypeMask  = 0x3fff
	conntrackEventRcvbuf = 8 << 20
	conntrackDumpBufSize = 1 << 20
)

type netlinkConntrackSource struct{}

func newSystemConntrackSource() conntrackSource { return netlinkConntrackSource{} }

func openConntrackNetlink(groups uint32) (int, error) {
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_RAW|unix.SOCK_CLOEXEC, unix.NETLINK_NETFILTER)
	if err != nil {
		return -1, os.NewSyscallError("socket", err)
	}
	if err := unix.Bind(fd, &unix.SockaddrNetlink{Family: unix.AF_NETLINK, Groups: groups}); err != nil {
		unix.Close(fd)
		return -1, os.NewSyscallError("bind", err)
	}
	return fd, nil
}

var conntrackDumpSeq atomic.Uint32

func (netlinkConntrackSource) dump() ([]conntrackFlow, error) {
	fd, err := openConntrackNetlink(0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	seq := conntrackDumpSeq.Add(1)
	request := make([]byte, unix.NLMSG_HDRLEN+4)
	binary.NativeEndian.PutUint32(request[0:4], uint32(len(request)))
	binary.NativeEndian.PutUint16(request[4:6], uint16(nfnlSubsysCTNetlink<<8|ipctnlMsgCtGet))
	binary.NativeEndian.PutUint16(request[6:8], uint16(unix.NLM_F_REQUEST|unix.NLM_F_DUMP))
	binary.NativeEndian.PutUint32(request[8:12], seq)
	// nfgenmsg：family AF_UNSPEC（IPv4 和 IPv6 都要）、version、res_id。
	request[unix.NLMSG_HDRLEN] = unix.AF_UNSPEC
	request[unix.NLMSG_HDRLEN+1] = nfnetlinkV0
	if err := unix.Sendto(fd, request, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return nil, os.NewSyscallError("sendto", err)
	}
	buf := make([]byte, conntrackDumpBufSize)
	flows := []conntrackFlow{}
	for {
		n, _, err := unix.Recvfrom(fd, buf, 0)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return nil, os.NewSyscallError("recvfrom", err)
		}
		done, err := parseConntrackNetlinkBatch(buf[:n], seq, func(msgType uint16, payload []byte) {
			if msgType&0xff != ipctnlMsgCtNew {
				return
			}
			if flow, ok := parseConntrackMessage(payload); ok {
				flows = append(flows, flow)
			}
		})
		if err != nil {
			return nil, err
		}
		if done {
			return flows, nil
		}
	}
}

func (netlinkConntrackSource) subscribe(onDestroy func(conntrackFlow), overflow func()) (func(), error) {
	fd, err := openConntrackNetlink(1 << (nfnlgrpConntrackDestroy - 1))
	if err != nil {
		return nil, err
	}
	// 忙的机器每秒几千条连接结束，缓冲给大一点；没有 CAP_NET_ADMIN 时退回普通的上限。
	if err := unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_RCVBUFFORCE, conntrackEventRcvbuf); err != nil {
		_ = unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_RCVBUF, conntrackEventRcvbuf)
	}
	var once sync.Once
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		buf := make([]byte, 256<<10)
		for {
			n, _, err := unix.Recvfrom(fd, buf, 0)
			if err != nil {
				switch {
				case errors.Is(err, unix.EINTR):
					continue
				case errors.Is(err, unix.ENOBUFS):
					overflow()
					continue
				default:
					return
				}
			}
			_, _ = parseConntrackNetlinkBatch(buf[:n], 0, func(msgType uint16, payload []byte) {
				if msgType&0xff != ipctnlMsgCtDelete {
					return
				}
				if flow, ok := parseConntrackMessage(payload); ok {
					onDestroy(flow)
				}
			})
		}
	}()
	stop := func() {
		once.Do(func() {
			// shutdown 让阻塞在 recvfrom 里的 goroutine 返回，再关 fd。
			_ = unix.Shutdown(fd, unix.SHUT_RDWR)
			unix.Close(fd)
		})
	}
	return stop, nil
}

// parseConntrackNetlinkBatch 逐条解析一次 recv 收到的 netlink 消息。seq 非 0 时只认这个序号
// （dump 的回复）；返回 done 表示 dump 结束。
func parseConntrackNetlinkBatch(data []byte, seq uint32, handle func(msgType uint16, payload []byte)) (bool, error) {
	for len(data) >= unix.NLMSG_HDRLEN {
		length := binary.NativeEndian.Uint32(data[0:4])
		msgType := binary.NativeEndian.Uint16(data[4:6])
		msgSeq := binary.NativeEndian.Uint32(data[8:12])
		if length < unix.NLMSG_HDRLEN || int(length) > len(data) {
			return false, fmt.Errorf("conntrack netlink: bad message length %d", length)
		}
		payload := data[unix.NLMSG_HDRLEN:length]
		aligned := (int(length) + unix.NLMSG_ALIGNTO - 1) &^ (unix.NLMSG_ALIGNTO - 1)
		if aligned > len(data) {
			aligned = len(data)
		}
		data = data[aligned:]
		if seq != 0 && msgSeq != seq {
			continue
		}
		switch msgType {
		case unix.NLMSG_DONE:
			return true, nil
		case unix.NLMSG_ERROR:
			if len(payload) >= 4 {
				if code := int32(binary.NativeEndian.Uint32(payload[0:4])); code != 0 {
					return false, fmt.Errorf("conntrack netlink: %w", unix.Errno(-code))
				}
			}
			return true, nil
		case unix.NLMSG_NOOP, unix.NLMSG_OVERRUN:
			continue
		}
		if msgType>>8 != nfnlSubsysCTNetlink {
			continue
		}
		handle(msgType, payload)
	}
	return false, nil
}

// parseConntrackMessage 解析一条 ctnetlink 消息（nfgenmsg 之后是属性）。
func parseConntrackMessage(payload []byte) (conntrackFlow, bool) {
	if len(payload) < 4 {
		return conntrackFlow{}, false
	}
	flow := conntrackFlow{}
	sawTuple := false
	walkNetlinkAttrs(payload[4:], func(typ uint16, value []byte) {
		switch typ {
		case ctaTupleOrig:
			walkNetlinkAttrs(value, func(typ uint16, value []byte) {
				if typ != ctaTupleProto {
					return
				}
				walkNetlinkAttrs(value, func(typ uint16, value []byte) {
					switch typ {
					case ctaProtoNum:
						if len(value) >= 1 {
							flow.Proto = value[0]
							sawTuple = true
						}
					case ctaProtoDstPort:
						if len(value) >= 2 {
							flow.OrigDstPort = binary.BigEndian.Uint16(value)
						}
					}
				})
			})
		case ctaStatus:
			if len(value) >= 4 {
				flow.Status = binary.BigEndian.Uint32(value)
			}
		case ctaCountersOrig:
			if bytes, ok := conntrackCounterBytes(value); ok {
				flow.InBytes = bytes
				flow.HasCounters = true
			}
		case ctaCountersReply:
			if bytes, ok := conntrackCounterBytes(value); ok {
				flow.OutBytes = bytes
				flow.HasCounters = true
			}
		case ctaID:
			if len(value) >= 4 {
				flow.ID = binary.BigEndian.Uint32(value)
			}
		case ctaZone:
			if len(value) >= 2 {
				flow.Zone = binary.BigEndian.Uint16(value)
			}
		}
	})
	return flow, sawTuple
}

func conntrackCounterBytes(value []byte) (uint64, bool) {
	var bytes uint64
	found := false
	walkNetlinkAttrs(value, func(typ uint16, value []byte) {
		switch typ {
		case ctaCountersBytes:
			if len(value) >= 8 {
				bytes = binary.BigEndian.Uint64(value)
				found = true
			}
		case ctaCounters32Bytes:
			if len(value) >= 4 && !found {
				bytes = uint64(binary.BigEndian.Uint32(value))
				found = true
			}
		}
	})
	return bytes, found
}

// walkNetlinkAttrs 遍历一层 netlink 属性（类型去掉 NESTED / BYTEORDER 标志位）。
func walkNetlinkAttrs(data []byte, fn func(typ uint16, value []byte)) {
	for len(data) >= unix.NLA_HDRLEN {
		length := int(binary.NativeEndian.Uint16(data[0:2]))
		typ := binary.NativeEndian.Uint16(data[2:4]) & netlinkAttrTypeMask
		if length < unix.NLA_HDRLEN || length > len(data) {
			return
		}
		fn(typ, data[unix.NLA_HDRLEN:length])
		aligned := (length + unix.NLA_ALIGNTO - 1) &^ (unix.NLA_ALIGNTO - 1)
		if aligned > len(data) {
			return
		}
		data = data[aligned:]
	}
}
