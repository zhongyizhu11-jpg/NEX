package main

import "net"

// listenTCPForRelay 是进程内转发（协议守护、线路组）开 TCP 监听的唯一入口，监听方式
// 的调整都放在这里。
//
// SO_REUSEPORT（同一端口开 min(核数, 4) 个监听）量过，没有采用：本机回环 32 个客户端并发建连
// （BenchmarkDataplaneTCPConnRate），开和不开的建连速率在噪声以内——Go 一个 accept 协程每秒能接
// 几万条，瓶颈在每条连接之后的拨上游和拷数据。它还会改掉「绑不上 = 端口被占」这条规矩：同一个
// 用户的别的进程只要也带 SO_REUSEPORT（nginx 的 UDP 监听就带）就能绑上同一端口、悄悄分走连接。
// UDP 也保持一个套接字：会话表挂在一个监听上，多套接字时流会在套接字增减时换路，回包对不上。
func listenTCPForRelay(addr string) (net.Listener, error) {
	return net.Listen("tcp", addr)
}
