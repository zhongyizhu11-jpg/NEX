package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFXPPanelRelayFollowsAgentState(t *testing.T) {
	oldPath := fxpPanelRelayStatePath
	fxpPanelRelayStatePath = filepath.Join(t.TempDir(), "panel-relay.json")
	t.Cleanup(func() { fxpPanelRelayStatePath = oldPath })

	cache := &fxpPanelRelayCache{}
	now := time.Unix(1_700_000_000, 0)
	if via := cache.route("panel.example.com:443", now); via != "" {
		t.Fatalf("no state file must dial directly, got %q", via)
	}
	write := func(body string, mod time.Time) {
		if err := os.WriteFile(fxpPanelRelayStatePath, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		_ = os.Chtimes(fxpPanelRelayStatePath, mod, mod)
	}
	write(`{"via":"198.51.100.7:20001","panelAddr":"Panel.Example.com:443","active":true}`, now)
	if via := cache.route("panel.example.com:443", now.Add(time.Second)); via != "" {
		t.Fatal("state must not be re-read before the recheck interval")
	}
	later := now.Add(fxpPanelRelayRecheck)
	if via := cache.route("panel.example.com:443", later); via != "198.51.100.7:20001" {
		t.Fatalf("active relay should be used, got %q", via)
	}
	if via := cache.route("api.ipify.org:443", later); via != "" {
		t.Fatal("non-panel address must dial directly")
	}
	write(`{"via":"198.51.100.7:20001","panelAddr":"panel.example.com:443","active":false}`, later.Add(time.Minute))
	if via := cache.route("panel.example.com:443", later.Add(fxpPanelRelayRecheck)); via != "" {
		t.Fatal("inactive (fallen back) relay must dial directly")
	}
	_ = os.Remove(fxpPanelRelayStatePath)
	if via := cache.route("panel.example.com:443", later.Add(2*fxpPanelRelayRecheck)); via != "" {
		t.Fatal("removed state must dial directly")
	}
}

// 中转拨不通时当场直拨，上报不因此失败。
func TestFXPPanelTransportFallsBackWhenRelayDown(t *testing.T) {
	oldPath, oldCache := fxpPanelRelayStatePath, fxpPanelRelay
	fxpPanelRelayStatePath = filepath.Join(t.TempDir(), "panel-relay.json")
	fxpPanelRelay = &fxpPanelRelayCache{}
	t.Cleanup(func() { fxpPanelRelayStatePath, fxpPanelRelay = oldPath, oldCache })

	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "ok") }))
	defer panel.Close()
	dead, _ := net.Listen("tcp", "127.0.0.1:0")
	deadAddr := dead.Addr().String()
	_ = dead.Close()
	state := `{"via":"` + deadAddr + `","panelAddr":"` + panel.Listener.Addr().String() + `","active":true}`
	if err := os.WriteFile(fxpPanelRelayStatePath, []byte(state), 0600); err != nil {
		t.Fatal(err)
	}
	transport := newFXPPanelTransport()
	transport.Proxy = nil
	client := &http.Client{Timeout: 5 * time.Second, Transport: transport}
	res, err := client.Get(panel.URL)
	if err != nil {
		t.Fatalf("request should fall back to direct: %v", err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if string(body) != "ok" {
		t.Fatalf("body = %q", body)
	}
}
