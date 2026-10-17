package main

import (
	"bytes"
	"fmt"
	"testing"
	"time"
)

// sendAndDrain writes count chunks of payload plus the end marker and returns
// what the far side reassembled.
func sendAndDrain(t *testing.T, pair *multipathTestPair, count int, payload []byte, midway func()) []byte {
	t.Helper()
	received := make(chan []byte, 1)
	go func() {
		data, _ := drainStream(pair.server)
		received <- data
	}()
	for i := 0; i < count; i++ {
		if i == count/2 && midway != nil {
			midway()
		}
		if err := pair.client.writeFrame(payload); err != nil {
			t.Fatalf("writeFrame %d: %v", i, err)
		}
	}
	if err := pair.client.writeFrame(nil); err != nil {
		t.Fatalf("fin: %v", err)
	}
	select {
	case got := <-received:
		return got
	case <-time.After(15 * time.Second):
		t.Fatal("stream did not complete")
		return nil
	}
}

func legBytesTotal(session *multipathSession) uint64 {
	var total uint64
	for _, n := range session.legBytes() {
		total += uint64(n)
	}
	return total
}

func TestMultipathReplicateQueuesASecondCopyOfEveryChunk(t *testing.T) {
	pair := newMultipathTestPair(t, 2, 128)
	pair.client.coalesceLimit = 0
	pair.client.setReplicate(true)
	payload := bytes.Repeat([]byte("r"), 2048)
	got := sendAndDrain(t, pair, 200, payload, nil)
	if !bytes.Equal(got, bytes.Repeat(payload, 200)) {
		t.Fatalf("stream corrupted: got %d bytes", len(got))
	}
	pair.client.mu.Lock()
	queued, sent := pair.client.replicasQueued, pair.client.replicasSent
	pair.client.mu.Unlock()
	// 每一片（加上结束标记）第一次写出后都要排一份副本；副本在对端按序交付前才发，
	// 内存管道上交付几乎是瞬间的，所以发出去的副本数不做硬性要求。
	if queued < 200 {
		t.Fatalf("replicas queued = %d, want one per chunk (200)", queued)
	}
	if sent > queued {
		t.Fatalf("sent %d replicas but only queued %d", sent, queued)
	}
}

func TestMultipathWithoutReplicateSendsOneCopy(t *testing.T) {
	pair := newMultipathTestPair(t, 2, 128)
	pair.client.coalesceLimit = 0
	payload := bytes.Repeat([]byte("s"), 2048)
	got := sendAndDrain(t, pair, 200, payload, nil)
	if !bytes.Equal(got, bytes.Repeat(payload, 200)) {
		t.Fatalf("stream corrupted: got %d bytes", len(got))
	}
	sent := legBytesTotal(pair.client)
	want := uint64(len(payload) * 200)
	if sent > want*13/10 {
		t.Fatalf("plain striping duplicated too much: sent %d for %d payload bytes", sent, want)
	}
}

func TestMultipathReplicateSurvivesLegLoss(t *testing.T) {
	pair := newMultipathTestPair(t, 2, 128)
	pair.client.setReplicate(true)
	var expected bytes.Buffer
	payloads := make([][]byte, 0, 100)
	for i := 0; i < 100; i++ {
		chunk := []byte(fmt.Sprintf("replicated-%03d;", i))
		payloads = append(payloads, chunk)
		expected.Write(chunk)
	}
	received := make(chan []byte, 1)
	go func() {
		data, _ := drainStream(pair.server)
		received <- data
	}()
	for i, chunk := range payloads {
		if i == 50 {
			pair.client.legs[0].sec.conn.Close()
			pair.server.legs[0].sec.conn.Close()
		}
		if err := pair.client.writeFrame(chunk); err != nil {
			t.Fatalf("writeFrame %d: %v", i, err)
		}
	}
	if err := pair.client.writeFrame(nil); err != nil {
		t.Fatalf("fin: %v", err)
	}
	select {
	case got := <-received:
		if !bytes.Equal(got, expected.Bytes()) {
			t.Fatalf("stream corrupted after leg loss: got %q", got)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("replicated stream did not complete after a leg died")
	}
}
