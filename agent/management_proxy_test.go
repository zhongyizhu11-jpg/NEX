package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestManagementProxyValidation(t *testing.T) {
	for _, raw := range []string{"http://host", "socks5://host:0", "socks5://host:65536", "ftp://host:21", "http://user:secret@host:80/path", "http://user:secret@host:80?x=1"} {
		_, err := parseAgentProxy(raw)
		if err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("expected redacted validation error: %v", err)
		}
	}
	u, err := parseAgentProxy("socks5://user:pass@localhost:1080")
	if err != nil || u.Scheme != "socks5h" {
		t.Fatalf("normalize: %v %v", u, err)
	}
}

func TestManagementHTTPProxyCoversEveryPanelClient(t *testing.T) {
	defer resetManagementProxyForTest()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Host != "panel.invalid" {
			t.Errorf("unexpected target: %s", r.URL.Host)
		}
		io.WriteString(w, "proxied")
	}))
	defer proxy.Close()
	if err := configureAgentManagementProxy(proxy.URL); err != nil {
		t.Fatal(err)
	}
	for _, client := range []*http.Client{agentSyncHTTPClient, agentPresenceHTTPClient, agentEventHTTPClient} {
		res, err := client.Get("http://panel.invalid/status")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if string(body) != "proxied" {
			t.Fatal(string(body))
		}
	}
	if agentPublicHTTPClient.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("public IP discovery must stay direct")
	}
}

// NEX 和上游不同的一点：没配 proxyUrl 时保持原来的行为（跟随进程环境变量），老部署升级上来
// 不会突然换一条路；公网 IP 探测则永远直连。
func TestManagementProxyEmptyConfigKeepsPreviousBehaviour(t *testing.T) {
	before := []any{}
	for _, client := range agentManagementHTTPClients() {
		before = append(before, fmt.Sprintf("%p", client.Transport.(*http.Transport).Proxy))
	}
	if err := configureAgentManagementProxy(""); err != nil {
		t.Fatal(err)
	}
	for index, client := range agentManagementHTTPClients() {
		if fmt.Sprintf("%p", client.Transport.(*http.Transport).Proxy) != before[index] {
			t.Fatal("an empty proxyUrl must not change the transport")
		}
	}
	if agentPublicHTTPClient.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("public IP discovery must stay direct")
	}
	if _, err := parseAgentProxy("http://user:secret@host:80/"); err != nil {
		t.Fatalf("a trailing slash is not a path: %v", err)
	}
	if redactedProxyEndpoint(mustParseProxy(t, "socks5://user:secret@10.0.0.1:1080")) != "socks5h://10.0.0.1:1080" {
		t.Fatal("logs must not contain credentials")
	}
}

func mustParseProxy(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := parseAgentProxy(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func resetManagementProxyForTest() {
	for _, client := range agentManagementHTTPClients() {
		transport := client.Transport.(*http.Transport)
		transport.CloseIdleConnections()
		transport.Proxy = http.ProxyFromEnvironment
	}
}

func TestManagementSOCKSProxyRemoteDNSAndAuthentication(t *testing.T) {
	defer resetManagementProxyForTest()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	result := make(chan error, 1)
	go func() {
		result <- func() error {
			c, err := listener.Accept()
			if err != nil {
				return err
			}
			defer c.Close()
			c.SetDeadline(time.Now().Add(5 * time.Second))
			read := func(n int) ([]byte, error) { b := make([]byte, n); _, err := io.ReadFull(c, b); return b, err }
			b, err := read(2)
			if err != nil {
				return err
			}
			if b[0] != 5 {
				return fmt.Errorf("not SOCKS5")
			}
			if _, err = read(int(b[1])); err != nil {
				return err
			}
			c.Write([]byte{5, 2})
			b, err = read(2)
			if err != nil {
				return err
			}
			user, err := read(int(b[1]))
			if err != nil {
				return err
			}
			b, err = read(1)
			if err != nil {
				return err
			}
			pass, err := read(int(b[0]))
			if err != nil {
				return err
			}
			if string(user) != "test" || string(pass) != "secret" {
				return fmt.Errorf("wrong authentication")
			}
			c.Write([]byte{1, 0})
			b, err = read(5)
			if err != nil {
				return err
			}
			if b[0] != 5 || b[1] != 1 || b[3] != 3 {
				return fmt.Errorf("expected remote DNS domain")
			}
			host, err := read(int(b[4]))
			if err != nil {
				return err
			}
			port, err := read(2)
			if err != nil {
				return err
			}
			if string(host) != "panel.invalid" || binary.BigEndian.Uint16(port) != 80 {
				return fmt.Errorf("wrong target")
			}
			c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 80})
			req, err := http.ReadRequest(bufio.NewReader(c))
			if err != nil {
				return err
			}
			req.Body.Close()
			_, err = io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
			return err
		}()
	}()
	if err := configureAgentManagementProxy("socks5://test:secret@" + listener.Addr().String()); err != nil {
		t.Fatal(err)
	}
	res, err := agentPresenceHTTPClient.Get("http://panel.invalid/status")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestUpgradeProxyReadsProtectedConfig(t *testing.T) {
	setup := agentUpgradeProxySetup("/etc/forwardx/agent/config.json")
	for _, expected := range []string{"jq -er", "proxyUrl", "unset http_proxy", "FORWARDX_AGENT_PROXY", "socks5h://", "upgrade cancelled", "grep -q '\"proxyUrl\"'"} {
		if !strings.Contains(setup, expected) {
			t.Fatalf("missing %s", expected)
		}
	}
}

// fwxm proxy off / --no-proxy 存的是 direct：服务管理器给了 HTTP_PROXY 之类的环境变量也不能再走它。
func TestManagementProxyDirectIgnoresEnvironmentProxy(t *testing.T) {
	defer resetManagementProxyForTest()
	if u, err := parseAgentProxy("direct"); err != nil || u != nil {
		t.Fatalf("direct must parse as no proxy: %v %v", u, err)
	}
	if err := configureAgentManagementProxy(" Direct "); err != nil {
		t.Fatal(err)
	}
	for _, client := range agentManagementHTTPClients() {
		if client.Transport.(*http.Transport).Proxy != nil {
			t.Fatal("direct must disable environment proxy lookup for panel traffic")
		}
	}
}

func TestUpgradeProxySetupHonoursDirect(t *testing.T) {
	dir := t.TempDir()
	config := dir + "/config.json"
	if err := os.WriteFile(config, []byte(`{"panelUrl":"https://p","proxyUrl":"direct"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := exec.LookPath("jq"); err != nil {
		t.Skip("jq not installed")
	}
	script := "upgrade_log() { echo \"log:$1\"; }; " + agentUpgradeProxySetup(config) + ` echo "env:[${HTTPS_PROXY:-}|${http_proxy:-}|${FORWARDX_AGENT_PROXY:-}]"`
	cmd := exec.Command("bash", "-c", script)
	cmd.Env = append(os.Environ(), "HTTPS_PROXY=http://broken:1", "http_proxy=http://broken:1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if !strings.Contains(string(out), "log:proxy-direct") || !strings.Contains(string(out), "env:[||direct]") {
		t.Fatalf("direct must clear inherited proxies during upgrade: %s", out)
	}
}
