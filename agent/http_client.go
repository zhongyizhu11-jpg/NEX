package main

import (
	"crypto/tls"
	"net/http"
	"time"
)

var agentSyncHTTPClient = &http.Client{
	Timeout:   60 * time.Second,
	Transport: newAgentHTTPTransport(true),
}

// Presence must fail fast enough to retry before the panel's online TTL even
// when a full reconciliation request is still stuck behind a slow proxy.
var agentPresenceHTTPClient = &http.Client{
	Timeout:   8 * time.Second,
	Transport: newAgentHTTPTransport(true),
}

var agentEventHTTPClient = &http.Client{
	Transport: newAgentEventHTTPTransport(),
}

// 公网 IP 探测：永远直连。走了代理量到的是代理的出口 IP，不是这台机器的。
var agentPublicHTTPClient = &http.Client{
	Timeout:   5 * time.Second,
	Transport: newAgentDirectHTTPTransport(true),
}

func newAgentDirectHTTPTransport(enableHTTP2 bool) *http.Transport {
	transport := newAgentHTTPTransport(enableHTTP2)
	transport.Proxy = nil
	return transport
}

func newAgentHTTPTransport(enableHTTP2 bool) *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = 64
	transport.MaxIdleConnsPerHost = 32
	transport.MaxConnsPerHost = 64
	transport.IdleConnTimeout = 90 * time.Second
	transport.TLSHandshakeTimeout = 10 * time.Second
	transport.ExpectContinueTimeout = time.Second
	transport.ForceAttemptHTTP2 = enableHTTP2
	// 拨面板地址时可能改拨中转主机（见 panel_dial.go）；拨别的地址原样直拨。
	transport.DialContext = agentPanelDialContext
	if transport.TLSClientConfig == nil {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	} else {
		transport.TLSClientConfig = transport.TLSClientConfig.Clone()
		transport.TLSClientConfig.MinVersion = tls.VersionTLS12
	}
	return transport
}

func newAgentEventHTTPTransport() *http.Transport {
	transport := newAgentHTTPTransport(true)
	transport.ResponseHeaderTimeout = 30 * time.Second
	return transport
}
