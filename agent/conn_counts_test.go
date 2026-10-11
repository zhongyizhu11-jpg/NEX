package main

import (
	"bufio"
	"strings"
	"testing"
)

const sampleProcNetTCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B0DF 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2076 2 000000001c60aa53 100 0 0 10 0
   1: 0100007F:1435 0100007F:C3A2 01 00000000:00000000 00:00000000 00000000     0        0 4460 1 000000008d96a352 100 0 0 10 0
   2: 0100007F:0BB8 0100007F:C3A4 06 00000000:00000000 03:00000F2A 00000000     0        0 0 3 000000000000000 
   3: 0100007F:0BB9 0100007F:C3A6 08 00000000:00000000 00:00000000 00000000     0        0 2393 1 00000000fe381942 20 4 30 10 -1
`

func TestCountProcNetSocketLinesSkipsHeaderListenAndTimeWait(t *testing.T) {
	got := countProcNetSocketLines(bufio.NewReader(strings.NewReader(sampleProcNetTCP)), tcpConnectionState)
	if got != 2 {
		t.Fatalf("tcp connections = %d, want 2 (ESTABLISHED + CLOSE_WAIT)", got)
	}
}

func TestCountProcNetSocketLinesCountsEveryUDPSocket(t *testing.T) {
	got := countProcNetSocketLines(bufio.NewReader(strings.NewReader(sampleProcNetTCP)), func(string) bool { return true })
	if got != 4 {
		t.Fatalf("udp sockets = %d, want 4", got)
	}
}

func TestCountProcNetSocketLinesEmptyAndMalformed(t *testing.T) {
	if got := countProcNetSocketLines(bufio.NewReader(strings.NewReader("")), tcpConnectionState); got != 0 {
		t.Fatalf("empty = %d, want 0", got)
	}
	short := "header\n   0: 0100007F:B0DF\n"
	if got := countProcNetSocketLines(bufio.NewReader(strings.NewReader(short)), tcpConnectionState); got != 0 {
		t.Fatalf("malformed = %d, want 0", got)
	}
}

func TestConnectionCountsDoesNotPanicWithoutProc(t *testing.T) {
	if got := countProcNetSockets("/nonexistent/proc/net/tcp", tcpConnectionState); got != 0 {
		t.Fatalf("missing file = %d, want 0", got)
	}
	tcp, udp := connectionCounts()
	if tcp < 0 || udp < 0 {
		t.Fatalf("negative counts tcp=%d udp=%d", tcp, udp)
	}
}
