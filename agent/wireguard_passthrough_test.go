package main

import (
	"strings"
	"testing"
)

func testPassthroughPeers() []wireGuardPeerSpec {
	return []wireGuardPeerSpec{
		{ID: "7", Address: "10.77.0.2"},
		{ID: "9", Address: "10.77.0.3"},
	}
}

func TestNormalizeWireGuardPassthroughValidatesSortsAndDedupes(t *testing.T) {
	rules := []wireGuardPassthroughRule{
		{RuleID: 12, Role: "EXIT", PeerID: " 7 ", Port: 443, Protocol: "both", TargetIP: "1.2.3.4", TargetPort: 8443},
		{RuleID: 3, Role: "entry", PeerID: "9", Port: 80, Protocol: "tcp", TargetIP: "ignored", TargetPort: 99},
		{RuleID: 12, Role: "exit", PeerID: "7", Port: 443, Protocol: "both", TargetIP: "1.2.3.4", TargetPort: 8443},
	}
	got, err := normalizeWireGuardPassthrough(rules, testPassthroughPeers())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].RuleID != 3 || got[1].RuleID != 12 {
		t.Fatalf("normalized = %+v", got)
	}
	if got[0].TargetIP != "" || got[0].TargetPort != 0 {
		t.Fatalf("entry role kept a target: %+v", got[0])
	}
	if got[1].Role != "exit" || got[1].PeerID != "7" || got[1].TargetIP != "1.2.3.4" {
		t.Fatalf("exit rule = %+v", got[1])
	}
	for name, bad := range map[string]wireGuardPassthroughRule{
		"role":    {RuleID: 1, Role: "relay", PeerID: "7", Port: 1},
		"peer":    {RuleID: 1, Role: "exit", PeerID: "8", Port: 1, TargetIP: "1.1.1.1", TargetPort: 1},
		"port":    {RuleID: 1, Role: "exit", PeerID: "7", Port: 70000, TargetIP: "1.1.1.1", TargetPort: 1},
		"ipv6":    {RuleID: 1, Role: "exit", PeerID: "7", Port: 1, TargetIP: "2001:db8::1", TargetPort: 1},
		"tport":   {RuleID: 1, Role: "exit", PeerID: "7", Port: 1, TargetIP: "1.1.1.1", TargetPort: 0},
		"rule id": {RuleID: 0, Role: "entry", PeerID: "7", Port: 1},
	} {
		if _, err := normalizeWireGuardPassthrough([]wireGuardPassthroughRule{bad}, testPassthroughPeers()); err == nil {
			t.Fatalf("%s: invalid rule accepted", name)
		}
	}
	if empty, err := normalizeWireGuardPassthrough(nil, nil); err != nil || empty != nil {
		t.Fatalf("empty list = %v, %v", empty, err)
	}
}

func TestWireGuardPassthroughFirewallRulesCoverBothDirections(t *testing.T) {
	peers := map[string]string{"7": "10.77.0.2"}
	rules := wireGuardPassthroughFirewallRules("nexwg5", "10.77.0.1", peers, []wireGuardPassthroughRule{
		{RuleID: 12, Role: "exit", PeerID: "7", Port: 443, Protocol: "tcp", TargetIP: "1.2.3.4", TargetPort: 8443},
		{RuleID: 13, Role: "entry", PeerID: "7", Port: 444, Protocol: "tcp"},
		{RuleID: 14, Role: "exit", PeerID: "missing", Port: 445, Protocol: "tcp", TargetIP: "1.2.3.4", TargetPort: 8443},
	})
	if len(rules) != 4 {
		t.Fatalf("got %d rules, want 4 (DNAT, MASQUERADE, FORWARD in, FORWARD back): %+v", len(rules), rules)
	}
	joined := make([]string, 0, len(rules))
	for _, rule := range rules {
		if !strings.HasPrefix(rule.comment, "nex-pt-nexwg5-12-tcp-") || strings.HasSuffix(rule.comment, "-ret") != strings.Contains(strings.Join(rule.args, " "), "--sport") {
			t.Fatalf("comment %q does not carry interface, rule id and protocol", rule.comment)
		}
		joined = append(joined, rule.table+"/"+rule.chain+" "+strings.Join(rule.args, " "))
	}
	text := strings.Join(joined, "\n")
	for _, want := range []string{
		"nat/PREROUTING -i nexwg5 -s 10.77.0.2/32 -d 10.77.0.1/32 -p tcp --dport 443 -m comment --comment nex-pt-nexwg5-12-tcp-",
		"-j DNAT --to-destination 1.2.3.4:8443",
		"nat/POSTROUTING -s 10.77.0.2/32 -d 1.2.3.4/32 -p tcp --dport 8443",
		"-j MASQUERADE",
		"filter/FORWARD -i nexwg5 -s 10.77.0.2/32 -d 1.2.3.4/32 -p tcp --dport 8443",
		"filter/FORWARD -o nexwg5 -d 10.77.0.2/32 -s 1.2.3.4/32 -p tcp --sport 8443 -m conntrack --ctstate ESTABLISHED,RELATED",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("rules missing %q:\n%s", want, text)
		}
	}
	both := wireGuardPassthroughFirewallRules("nexwg5", "10.77.0.1", peers, []wireGuardPassthroughRule{
		{RuleID: 12, Role: "exit", PeerID: "7", Port: 443, Protocol: "both", TargetIP: "1.2.3.4", TargetPort: 8443},
	})
	if len(both) != 8 {
		t.Fatalf("protocol both produced %d rules, want 8", len(both))
	}
	if a, b := both[0].comment, both[4].comment; a == b || !strings.Contains(a, "-tcp-") || !strings.Contains(b, "-udp-") {
		t.Fatalf("tcp/udp comments = %q / %q", a, b)
	}
	// 同样的内容算出同样的注释，内容变了注释也变（同步靠注释判断规则还在不在）。
	again := wireGuardPassthroughFirewallRules("nexwg5", "10.77.0.1", peers, []wireGuardPassthroughRule{
		{RuleID: 12, Role: "exit", PeerID: "7", Port: 443, Protocol: "tcp", TargetIP: "1.2.3.4", TargetPort: 8443},
	})
	moved := wireGuardPassthroughFirewallRules("nexwg5", "10.77.0.1", peers, []wireGuardPassthroughRule{
		{RuleID: 12, Role: "exit", PeerID: "7", Port: 443, Protocol: "tcp", TargetIP: "1.2.3.5", TargetPort: 8443},
	})
	if again[0].comment != rules[0].comment || moved[0].comment == rules[0].comment {
		t.Fatalf("comment stability: same=%q again=%q moved=%q", rules[0].comment, again[0].comment, moved[0].comment)
	}
	mss := wireGuardPassthroughMSSRules("nexwg5")
	if len(mss) != 1 || mss[0].table != "mangle" || !strings.Contains(strings.Join(mss[0].args, " "), "-o nexwg5 -p tcp --tcp-flags SYN,RST SYN -m comment --comment nex-pt-nexwg5-mss -j TCPMSS --clamp-mss-to-pmtu") {
		t.Fatalf("mss rules = %+v", mss)
	}
}

func TestWireGuardPassthroughInstalledCommentsParsesListing(t *testing.T) {
	listing := strings.Join([]string{
		"-P PREROUTING ACCEPT",
		`-A PREROUTING -s 10.77.0.2/32 -d 10.77.0.1/32 -i nexwg5 -p tcp -m tcp --dport 443 -m comment --comment nex-pt-nexwg5-12-tcp-0a0b0c0d -j DNAT --to-destination 1.2.3.4:8443`,
		`-A PREROUTING -s 10.77.0.2/32 -i nexwg7 -p tcp -m tcp --dport 443 -m comment --comment nex-pt-nexwg7-12-tcp-0a0b0c0d -j DNAT --to-destination 1.2.3.4:8443`,
		`-A PREROUTING -p tcp -m tcp --dport 80 -m comment --comment "user rule" -j DNAT --to-destination 10.0.0.1:80`,
		`-A PREROUTING -o nexwg5 -p tcp -m tcp --tcp-flags SYN,RST SYN -m comment --comment "nex-pt-nexwg5-mss" -j TCPMSS --clamp-mss-to-pmtu`,
	}, "\n")
	got := wireGuardPassthroughInstalledComments(listing, "nexwg5")
	if len(got) != 2 {
		t.Fatalf("installed = %v", got)
	}
	args := got["nex-pt-nexwg5-12-tcp-0a0b0c0d"]
	if len(args) == 0 || args[0] != "-s" || args[len(args)-1] != "1.2.3.4:8443" {
		t.Fatalf("delete args = %v", args)
	}
	if _, ok := got["nex-pt-nexwg5-mss"]; !ok {
		t.Fatalf("quoted comment not parsed: %v", got)
	}
}
