package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// multipathTestPair wires two multipath sessions together over in-memory pipes,
// one pipe per leg, so the striping and reassembly can be exercised without a
// network.
type multipathTestPair struct {
	client *multipathSession
	server *multipathSession
	pipes  []net.Conn
}

func (p *multipathTestPair) close() {
	p.client.closeTransport()
	p.server.closeTransport()
	for _, conn := range p.pipes {
		_ = conn.Close()
	}
}

func newMultipathTestPair(t *testing.T, legCount int, maxPending int) *multipathTestPair {
	t.Helper()
	salt := make([]byte, fxpSaltSize)
	for i := range salt {
		salt[i] = byte(i + 3)
	}
	clientConns := make([]*secureConn, 0, legCount)
	serverConns := make([]*secureConn, 0, legCount)
	pipes := make([]net.Conn, 0, legCount*2)
	labels := make([]string, 0, legCount)
	for i := 0; i < legCount; i++ {
		clientSide, serverSide := net.Pipe()
		pipes = append(pipes, clientSide, serverSide)
		key := "multipath-test-key"
		clientSec, err := newSessionSecureConn(clientSide, key, salt, true)
		if err != nil {
			t.Fatalf("client secure conn %d: %v", i, err)
		}
		serverSec, err := newSessionSecureConn(serverSide, key, salt, false)
		if err != nil {
			t.Fatalf("server secure conn %d: %v", i, err)
		}
		clientConns = append(clientConns, clientSec)
		serverConns = append(serverConns, serverSec)
		labels = append(labels, fmt.Sprintf("leg-%d", i))
	}
	pair := &multipathTestPair{
		client: newMultipathSession(multipathLegsFromSecureConns(clientConns, labels), maxPending),
		server: newMultipathSession(multipathLegsFromSecureConns(serverConns, labels), maxPending),
		pipes:  pipes,
	}
	t.Cleanup(pair.close)
	return pair
}

// drainStream reads a whole multipath stream until its end marker.
func drainStream(session *multipathSession) ([]byte, error) {
	var out bytes.Buffer
	for {
		frame, err := session.readFrame()
		if err != nil {
			return out.Bytes(), err
		}
		if len(frame) == 0 {
			return out.Bytes(), nil
		}
		out.Write(frame)
	}
}

func TestMultipathSessionPreservesStreamAcrossLegs(t *testing.T) {
	pair := newMultipathTestPair(t, 3, 64)

	chunks := make([][]byte, 0, 200)
	var expected bytes.Buffer
	for i := 0; i < 200; i++ {
		chunk := []byte(fmt.Sprintf("chunk-%04d;", i))
		chunks = append(chunks, chunk)
		expected.Write(chunk)
	}

	received := make(chan []byte, 1)
	errCh := make(chan error, 1)
	go func() {
		data, err := drainStream(pair.server)
		errCh <- err
		received <- data
	}()

	for _, chunk := range chunks {
		if err := pair.client.writeFrame(chunk); err != nil {
			t.Fatalf("writeFrame: %v", err)
		}
	}
	if err := pair.client.writeFrame(nil); err != nil {
		t.Fatalf("writeFrame fin: %v", err)
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("drain: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("stream did not complete")
	}
	got := <-received
	if !bytes.Equal(got, expected.Bytes()) {
		t.Fatalf("stream corrupted: got %d bytes, want %d", len(got), expected.Len())
	}
}

func TestMultipathSessionSpreadsBytesOverEveryLeg(t *testing.T) {
	pair := newMultipathTestPair(t, 3, 128)

	go func() { _, _ = drainStream(pair.server) }()
	payload := bytes.Repeat([]byte("x"), 4096)
	for i := 0; i < 300; i++ {
		if err := pair.client.writeFrame(payload); err != nil {
			t.Errorf("writeFrame: %v", err)
			return
		}
	}
	if err := pair.client.writeFrame(nil); err != nil {
		t.Fatalf("fin: %v", err)
	}

	perLeg := pair.client.legBytes()
	carried := 0
	for _, bytesOnLeg := range perLeg {
		if bytesOnLeg > 0 {
			carried++
		}
	}
	if carried < 2 {
		t.Fatalf("expected the load to spread over several legs, got %v", perLeg)
	}
}

func TestMultipathSessionCompletesAfterOneLegDies(t *testing.T) {
	pair := newMultipathTestPair(t, 3, 128)

	received := make(chan []byte, 1)
	go func() {
		data, _ := drainStream(pair.server)
		received <- data
	}()

	var expected bytes.Buffer
	// Send enough before the failure that legs are actively in use.
	for i := 0; i < 50; i++ {
		chunk := []byte(fmt.Sprintf("early-%03d;", i))
		expected.Write(chunk)
		if err := pair.client.writeFrame(chunk); err != nil {
			t.Fatalf("writeFrame: %v", err)
		}
	}
	// Drop one leg at both ends, as a dead relay would.
	pair.client.legs[1].sec.conn.Close()
	pair.server.legs[1].sec.conn.Close()

	for i := 0; i < 50; i++ {
		chunk := []byte(fmt.Sprintf("late-%03d;", i))
		expected.Write(chunk)
		if err := pair.client.writeFrame(chunk); err != nil {
			t.Fatalf("writeFrame after leg loss: %v", err)
		}
	}
	if err := pair.client.writeFrame(nil); err != nil {
		t.Fatalf("fin: %v", err)
	}

	select {
	case got := <-received:
		if !bytes.Equal(got, expected.Bytes()) {
			t.Fatalf("stream corrupted after leg loss: got %d bytes, want %d", len(got), expected.Len())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("stream did not complete after a leg was lost")
	}
	if pair.client.aliveLegCount() != 2 {
		t.Fatalf("expected 2 surviving legs, got %d", pair.client.aliveLegCount())
	}
}

func TestMultipathSessionFailsWhenEveryLegDies(t *testing.T) {
	pair := newMultipathTestPair(t, 2, 16)
	// 小写会并进同一片，这里要的是每次写都往死腿上递一片。
	pair.client.mu.Lock()
	pair.client.coalesceLimit = 0
	pair.client.mu.Unlock()
	for _, leg := range pair.client.legs {
		_ = leg.sec.conn.Close()
	}
	// Writing enough to reach a dead leg must surface the failure rather than
	// blocking forever.
	deadline := time.After(5 * time.Second)
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 1000; i++ {
			if err := pair.client.writeFrame([]byte("payload")); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected writing to a fully dead session to fail")
		}
	case <-deadline:
		t.Fatal("writing to a fully dead session should not block forever")
	}
	if pair.client.aliveLegCount() != 0 {
		t.Fatalf("expected no surviving legs, got %d", pair.client.aliveLegCount())
	}
}

func TestMultipathSessionEndMarkerSurvivesPartialLegLoss(t *testing.T) {
	pair := newMultipathTestPair(t, 3, 64)
	received := make(chan []byte, 1)
	go func() {
		data, _ := drainStream(pair.server)
		received <- data
	}()

	chunk := []byte("only-chunk")
	if err := pair.client.writeFrame(chunk); err != nil {
		t.Fatalf("writeFrame: %v", err)
	}
	// Kill two of three legs before the marker; the survivor must carry it.
	pair.client.legs[0].sec.conn.Close()
	pair.client.legs[2].sec.conn.Close()
	if err := pair.client.writeFrame(nil); err != nil {
		t.Fatalf("fin: %v", err)
	}

	select {
	case got := <-received:
		if !bytes.Equal(got, chunk) {
			t.Fatalf("expected %q, got %q", chunk, got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the end marker did not reach the far side")
	}
}

func TestMultipathSessionReportsClosureToBlockedReader(t *testing.T) {
	pair := newMultipathTestPair(t, 2, 8)
	blocked := make(chan error, 1)
	go func() {
		_, err := pair.server.readFrame()
		blocked <- err
	}()
	time.Sleep(30 * time.Millisecond)
	sentinel := errors.New("teardown")
	pair.server.closeWith(sentinel)

	select {
	case err := <-blocked:
		if err == nil {
			t.Fatal("expected a blocked reader to fail on teardown")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("teardown should wake a blocked reader")
	}
}

func TestMultipathSessionCopiesCallerBuffer(t *testing.T) {
	pair := newMultipathTestPair(t, 2, 16)
	received := make(chan []byte, 1)
	go func() {
		data, _ := drainStream(pair.server)
		received <- data
	}()

	// The FXP copy loops reuse one read buffer, so the session must not retain
	// a reference to the caller's slice.
	scratch := []byte("original")
	if err := pair.client.writeFrame(scratch); err != nil {
		t.Fatalf("writeFrame: %v", err)
	}
	copy(scratch, "OVERWROTE")
	if err := pair.client.writeFrame(nil); err != nil {
		t.Fatalf("fin: %v", err)
	}

	select {
	case got := <-received:
		if string(got) != "original" {
			t.Fatalf("expected the queued copy to survive buffer reuse, got %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not complete")
	}
}

func TestMultipathSessionRelaysConcurrentBidirectionalStreams(t *testing.T) {
	pair := newMultipathTestPair(t, 3, 64)

	var wg sync.WaitGroup
	var clientGot, serverGot []byte
	wg.Add(2)
	go func() {
		defer wg.Done()
		serverGot, _ = drainStream(pair.server)
	}()
	go func() {
		defer wg.Done()
		clientGot, _ = drainStream(pair.client)
	}()

	var wantToServer, wantToClient bytes.Buffer
	writeErr := make(chan error, 2)
	go func() {
		for i := 0; i < 100; i++ {
			chunk := []byte(fmt.Sprintf("c2s-%03d;", i))
			wantToServer.Write(chunk)
			if err := pair.client.writeFrame(chunk); err != nil {
				writeErr <- err
				return
			}
		}
		writeErr <- pair.client.writeFrame(nil)
	}()
	go func() {
		for i := 0; i < 100; i++ {
			chunk := []byte(fmt.Sprintf("s2c-%03d;", i))
			wantToClient.Write(chunk)
			if err := pair.server.writeFrame(chunk); err != nil {
				writeErr <- err
				return
			}
		}
		writeErr <- pair.server.writeFrame(nil)
	}()
	for i := 0; i < 2; i++ {
		if err := <-writeErr; err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("bidirectional streams did not complete")
	}
	if !bytes.Equal(serverGot, wantToServer.Bytes()) {
		t.Fatalf("client to server stream corrupted: %d vs %d bytes", len(serverGot), wantToServer.Len())
	}
	if !bytes.Equal(clientGot, wantToClient.Bytes()) {
		t.Fatalf("server to client stream corrupted: %d vs %d bytes", len(clientGot), wantToClient.Len())
	}
}

// TestMultipathSessionSatisfiesFrameConn keeps the session usable by the shared
// copy loops.
func TestMultipathSessionSatisfiesFrameConn(t *testing.T) {
	var _ frameConn = (*multipathSession)(nil)
	var _ frameConn = (*secureConn)(nil)
	_ = io.EOF
}
