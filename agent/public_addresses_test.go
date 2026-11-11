package main

import (
	"fmt"
	"net"
	"reflect"
	"testing"
)

func TestPublicAddressFamilyClassification(t *testing.T) {
	cases := map[string]int{
		"8.8.8.8":                     4,
		"45.32.10.1":                  4,
		"10.0.0.5":                    0,
		"172.16.3.4":                  0,
		"192.168.1.1":                 0,
		"100.64.0.1":                  0, // CGNAT
		"100.127.255.254":             0,
		"169.254.10.1":                0,
		"127.0.0.1":                   0,
		"203.0.113.9":                 0, // 文档段
		"224.0.0.1":                   0,
		"240.0.0.1":                   0,
		"0.0.0.0":                     0,
		"2606:4700:4700::1111":        6,
		"2a01:4f8:c17:1::1":           6,
		"fd00::1":                     0, // ULA
		"fc12::1":                     0,
		"fe80::1":                     0, // 链路本地
		"::1":                         0,
		"::":                          0,
		"2001:db8::1":                 0, // 文档段
		"ff02::1":                     0,
		"64:ff9b::808:808":            0, // NAT64
		"::ffff:8.8.8.8":              4, // 映射地址按 IPv4 看
		"::ffff:192.168.1.1":          0,
		"2400:cb00:2048:1::c629:d7a2": 6,
	}
	for literal, want := range cases {
		if got := publicAddressFamily(net.ParseIP(literal)); got != want {
			t.Errorf("publicAddressFamily(%s) = %d, want %d", literal, got, want)
		}
	}
	if got := publicAddressFamily(nil); got != 0 {
		t.Fatalf("nil ip = %d", got)
	}
}

func TestIgnoredPublicAddressInterface(t *testing.T) {
	for _, name := range []string{"lo", "docker0", "br-1a2b3c", "veth12ab", "virbr0", "cni0", "flannel.1", "cali123", "kube-ipvs0", "tailscale0", "wg0", "tun0", ""} {
		if !ignoredPublicAddressInterface(name) {
			t.Errorf("%q should be ignored", name)
		}
	}
	for _, name := range []string{"eth0", "ens3", "enp1s0", "venet0", "bond0", "eth0.100", "he-ipv6"} {
		if ignoredPublicAddressInterface(name) {
			t.Errorf("%q should not be ignored", name)
		}
	}
}

const ipAddrFixture = `2: eth0    inet 45.32.10.1/23 brd 45.32.11.255 scope global dynamic eth0\       valid_lft 85000sec preferred_lft 85000sec
2: eth0    inet 45.32.10.2/32 scope global secondary eth0:1\       valid_lft forever preferred_lft forever
2: eth0    inet 10.8.0.2/24 scope global eth0\       valid_lft forever preferred_lft forever
3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\       valid_lft forever preferred_lft forever
4: br-9f0e    inet 66.66.66.66/24 scope global br-9f0e\       valid_lft forever preferred_lft forever
5: eth1    inet 149.28.1.5/24 scope global eth1\       valid_lft forever preferred_lft forever
6: veth1@if5    inet 77.77.77.77/32 scope global veth1\       valid_lft forever preferred_lft forever
2: eth0    inet6 2001:19f0:5:1::1/64 scope global dynamic mngtmpaddr noprefixroute \       valid_lft 2591000sec preferred_lft 604000sec
2: eth0    inet6 2001:19f0:5:1:aaaa:bbbb:cccc:dddd/64 scope global temporary dynamic \       valid_lft 600sec preferred_lft 300sec
2: eth0    inet6 2001:19f0:5:1::9/64 scope global deprecated \       valid_lft 600sec preferred_lft 0sec
2: eth0    inet6 2001:19f0:5:1::10/64 scope global tentative \       valid_lft forever preferred_lft forever
2: eth0    inet6 fd00::5/64 scope global \       valid_lft forever preferred_lft forever
5: eth1    inet6 2001:19f0:5:2::2/64 scope global \       valid_lft forever preferred_lft forever
2: eth0    inet 45.32.10.1/23 scope global eth0\       valid_lft forever preferred_lft forever
`

func TestParseAndCollectPublicAddresses(t *testing.T) {
	candidates := parseIPAddrOutput([]byte(ipAddrFixture))
	if len(candidates) != 14 {
		t.Fatalf("parsed %d candidates", len(candidates))
	}
	if candidates[6].Iface != "veth1" {
		t.Fatalf("veth peer suffix should be stripped, got %q", candidates[6].Iface)
	}
	// 默认路由在 eth1：它的地址排前面
	got := collectPublicAddresses(candidates, "eth1")
	want := publicAddressList{
		IPv4: []string{"149.28.1.5", "45.32.10.1", "45.32.10.2"},
		IPv6: []string{"2001:19f0:5:2::2", "2001:19f0:5:1::1"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("collect = %#v, want %#v", got, want)
	}
	// 别名 eth0:1 归到 eth0
	got = collectPublicAddresses(candidates, "eth0")
	if !reflect.DeepEqual(got.IPv4, []string{"45.32.10.1", "45.32.10.2", "149.28.1.5"}) {
		t.Fatalf("default eth0 order = %#v", got.IPv4)
	}
	if got.signature() != "45.32.10.1,45.32.10.2,149.28.1.5|2001:19f0:5:1::1,2001:19f0:5:2::2" {
		t.Fatalf("signature = %s", got.signature())
	}
}

func TestCollectPublicAddressesEmptyAndBounded(t *testing.T) {
	empty := collectPublicAddresses(nil, "")
	if empty.IPv4 == nil || empty.IPv6 == nil || len(empty.IPv4) != 0 || len(empty.IPv6) != 0 {
		t.Fatalf("empty list should be non-nil empty slices: %#v", empty)
	}
	candidates := []interfaceAddressCandidate{}
	for i := 1; i <= 40; i++ {
		candidates = append(candidates,
			interfaceAddressCandidate{Iface: "eth0", IP: fmt.Sprintf("45.33.%d.1", i)},
			interfaceAddressCandidate{Iface: "eth0", IP: fmt.Sprintf("2a01:4f8::%x", i)},
		)
	}
	list := collectPublicAddresses(candidates, "")
	if len(list.IPv4) != maxReportedPublicAddresses || len(list.IPv6) != maxReportedPublicAddresses {
		t.Fatalf("bounded = %d / %d", len(list.IPv4), len(list.IPv6))
	}
}

func TestAddPublicAddressReportOnlyWhenReadyAndStatic(t *testing.T) {
	publicIPMu.Lock()
	previousList, previousReady := publicAddressListCache, publicAddressListReady
	publicAddressListCache = publicAddressList{IPv4: []string{"45.32.10.1"}, IPv6: []string{}}
	publicAddressListReady = false
	publicIPMu.Unlock()
	defer func() {
		publicIPMu.Lock()
		publicAddressListCache, publicAddressListReady = previousList, previousReady
		publicIPMu.Unlock()
	}()

	payload := map[string]any{}
	addPublicAddressReport(payload, true, "45.32.10.1", "")
	if _, ok := payload["publicAddresses"]; ok {
		t.Fatal("not ready yet: must not report")
	}
	if publicAddressListSignature() != "" {
		t.Fatal("signature should be empty before the first refresh")
	}
	publicIPMu.Lock()
	publicAddressListReady = true
	publicIPMu.Unlock()
	addPublicAddressReport(payload, false, "45.32.10.1", "")
	if _, ok := payload["publicAddresses"]; ok {
		t.Fatal("non-static heartbeat must not report")
	}
	addPublicAddressReport(payload, true, "45.32.10.1", "")
	report, ok := payload["publicAddresses"].(map[string]any)
	if !ok || report["egressIpv4"] != "45.32.10.1" || !reflect.DeepEqual(report["ipv4"], []string{"45.32.10.1"}) {
		t.Fatalf("report = %#v", payload["publicAddresses"])
	}
}
