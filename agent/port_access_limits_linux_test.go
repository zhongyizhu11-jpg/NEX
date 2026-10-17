//go:build linux

package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func bringLoopbackUpForTest() error {
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	var ifr [40]byte
	copy(ifr[:], "lo")
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), syscall.SIOCGIFFLAGS, uintptr(unsafe.Pointer(&ifr[0]))); errno != 0 {
		return errno
	}
	flags := (*uint16)(unsafe.Pointer(&ifr[16]))
	*flags |= syscall.IFF_UP
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), syscall.SIOCSIFFLAGS, uintptr(unsafe.Pointer(&ifr[0]))); errno != 0 {
		return errno
	}
	return nil
}

// Run with FORWARDX_TEST_PORT_LIMITS=1 as root. All firewall operations are
// isolated in a fresh network namespace; never alter the runner/host ruleset.
func TestPortAccessLimitsNetworkNamespace(t *testing.T) {
	if os.Getenv("FORWARDX_TEST_PORT_LIMITS") != "1" {
		t.Skip("requires explicit isolated Linux firewall test")
	}
	if os.Geteuid() != 0 {
		t.Fatal("run the isolated firewall test as root")
	}
	if os.Getenv("FORWARDX_PORT_LIMIT_NETNS_CHILD") != "1" {
		cmd := exec.Command("unshare", "--net", os.Args[0], "-test.run=^TestPortAccessLimitsNetworkNamespace$", "-test.v", "-test.timeout=60s")
		parentNS, err := os.Readlink("/proc/self/ns/net")
		if err != nil || parentNS == "" {
			t.Fatal("cannot identify the runner network namespace")
		}
		cmd.Env = append(os.Environ(), "FORWARDX_PORT_LIMIT_NETNS_CHILD=1", "FORWARDX_PORT_LIMIT_PARENT_NETNS="+parentNS)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated firewall test failed: %v\n%s", err, out)
		}
		t.Log(string(out))
		return
	}
	ours, err := os.Readlink("/proc/self/ns/net")
	if err != nil {
		t.Fatal(err)
	}
	// /proc/1 may be hidden inside sandboxes; the parent's namespace identity is
	// passed explicitly and must differ from ours (and from PID 1's when visible).
	parent := os.Getenv("FORWARDX_PORT_LIMIT_PARENT_NETNS")
	if parent == "" || ours == parent {
		t.Fatal("refusing to modify the host network namespace")
	}
	if host, err := os.Readlink("/proc/1/ns/net"); err == nil && ours == host {
		t.Fatal("refusing to modify the host network namespace")
	}
	families := []bool{false, true}
	if _, err := exec.LookPath("ip"); err != nil {
		// Minimal containers lack iproute2: bring lo up directly, and skip the
		// IPv6 case, which needs a second loopback source address.
		if err := bringLoopbackUpForTest(); err != nil {
			t.Fatalf("loopback: %v", err)
		}
		families = []bool{false}
	} else if out, err := exec.Command("ip", "link", "set", "lo", "up").CombinedOutput(); err != nil {
		t.Fatalf("loopback: %v %s", err, out)
	}
	for _, ipv6 := range families {
		t.Run(fmt.Sprintf("ipv6=%v", ipv6), func(t *testing.T) { testPortAccessLimitTraffic(t, ipv6) })
	}
	t.Run("connection-cap", testPortAccessConnectionCapTraffic)
}

// A user's total connection cap is shared by every source address and port.
func testPortAccessConnectionCapTraffic(t *testing.T) {
	listen := func() int {
		ln, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ln.Close() })
		go func() {
			for {
				conn, err := ln.Accept()
				if err != nil {
					return
				}
				go func() { defer conn.Close(); io.Copy(conn, conn) }()
			}
		}()
		return ln.Addr().(*net.TCPAddr).Port
	}
	portA, portB := listen(), listen()
	specs := []portAccessLimitSpec{{UserID: 3, MaxConnections: 2, Ports: []int{portA, portB}}}
	if err := syncPortAccessLimits(systemPortLimitFirewall{}, specs, false); err != nil {
		t.Fatal(err)
	}
	dial := func(port int, source string) (net.Conn, error) {
		d := net.Dialer{Timeout: 250 * time.Millisecond, LocalAddr: &net.TCPAddr{IP: net.ParseIP(source)}}
		return d.Dial("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	}
	for i, source := range []string{"127.0.0.1", "127.0.0.2"} {
		conn, err := dial([]int{portA, portB}[i], source)
		if err != nil {
			t.Fatalf("connection %d under the cap rejected: %v", i, err)
		}
		t.Cleanup(func() { conn.Close() })
	}
	if conn, err := dial(portA, "127.0.0.3"); err == nil {
		conn.Close()
		t.Fatal("total connection cap ignored a new source address")
	}
	if err := syncPortAccessLimits(systemPortLimitFirewall{}, nil, false); err != nil {
		t.Fatal(err)
	}
	conn, err := dial(portA, "127.0.0.3")
	if err != nil {
		t.Fatalf("removing the cap did not release new connections: %v", err)
	}
	conn.Close()
}

func testPortAccessLimitTraffic(t *testing.T, ipv6 bool) {
	t.Helper()
	host, otherSource, binary, network := "127.0.0.1", "127.0.0.2", "iptables", "tcp4"
	if ipv6 {
		host, otherSource, binary, network = "::1", "::2", "ip6tables", "tcp6"
		if out, err := exec.Command("ip", "-6", "addr", "add", "::2/128", "dev", "lo", "nodad").CombinedOutput(); err != nil {
			t.Fatalf("IPv6 source: %v %s", err, out)
		}
	}
	listen := func() (net.Listener, int) {
		ln, err := net.Listen(network, net.JoinHostPort(host, "0"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ln.Close() })
		go func() {
			for {
				conn, err := ln.Accept()
				if err != nil {
					return
				}
				go func() { defer conn.Close(); io.Copy(conn, conn) }()
			}
		}()
		return ln, ln.Addr().(*net.TCPAddr).Port
	}
	_, portA := listen()
	_, portB := listen()
	_, portC := listen()
	_, portOtherUser := listen()
	free, natEntry := listen()
	free.Close()
	// The destination port is changed after mangle OUTPUT, simulating the same
	// pre-DNAT port identity as a kernel forwarding entry.
	natArgs := []string{"-w", "5", "-t", "nat", "-A", "OUTPUT", "-p", "tcp", "-d", host, "--dport", strconv.Itoa(natEntry), "-j", "DNAT", "--to-destination", net.JoinHostPort(host, strconv.Itoa(portC))}
	if out, err := exec.Command(binary, natArgs...).CombinedOutput(); err != nil {
		t.Fatalf("DNAT fixture: %v %s", err, out)
	}
	fw := systemPortLimitFirewall{}
	specs := []portAccessLimitSpec{{UserID: 1, MaxIPs: 2, Ports: []int{portA, portB, natEntry}}, {UserID: 2, MaxIPs: 2, Ports: []int{portOtherUser}}}
	apply := func() {
		if err := syncPortAccessLimits(fw, specs, false); err != nil {
			t.Fatal(err)
		}
		if err := syncPortAccessLimits(fw, specs, true); err != nil {
			t.Fatal(err)
		}
	}
	apply()
	dial := func(port int, source string) (net.Conn, error) {
		d := net.Dialer{Timeout: 250 * time.Millisecond, LocalAddr: &net.TCPAddr{IP: net.ParseIP(source)}}
		return d.Dial(network, net.JoinHostPort(host, strconv.Itoa(port)))
	}
	connect := func(port int, source string) net.Conn {
		conn, err := dial(port, source)
		if err != nil {
			t.Fatalf("connect %d source=%s: %v", port, source, err)
		}
		t.Cleanup(func() { conn.Close() })
		return conn
	}
	echo := func(conn net.Conn) {
		conn.SetDeadline(time.Now().Add(time.Second))
		if _, err := conn.Write([]byte("payload")); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 7)
		if _, err := io.ReadFull(conn, buf); err != nil || string(buf) != "payload" {
			t.Fatalf("existing connection interrupted: %s %v", buf, err)
		}
	}
	first, second := connect(portA, host), connect(portB, host)
	echo(first)
	echo(second)
	if conn, err := dial(natEntry, host); err == nil {
		conn.Close()
		t.Fatal("shared single-IP limit did not reject the third connection")
	}
	echo(connect(natEntry, otherSource)) // Another source IP is independent, including DNAT.
	echo(connect(portOtherUser, host))   // Another user is independent.
	_, addedPort := listen()
	specs[0].Ports = append(specs[0].Ports, addedPort)
	apply()
	if conn, err := dial(addedPort, host); err == nil {
		conn.Close()
		t.Fatal("adding a rule reset active connection counts")
	}
	echo(first)
	echo(second)
	second.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		conn, err := dial(addedPort, host)
		if err == nil {
			echo(conn)
			conn.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("closed connections did not release the per-IP limit")
		}
		time.Sleep(100 * time.Millisecond)
	}
	specs = nil
	apply()
	echo(first)
	echo(connect(addedPort, host))
	// The independent DNAT rule must survive limit removal.
	out, err := exec.Command(binary, "-t", "nat", "-S", "OUTPUT").CombinedOutput()
	if err != nil || !strings.Contains(string(out), "--dport "+strconv.Itoa(natEntry)) {
		t.Fatal("limit cleanup altered DNAT")
	}
}
