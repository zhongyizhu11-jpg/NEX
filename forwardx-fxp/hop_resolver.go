package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

/*
下一跳地址的解析缓存。

面板把目标地址解析成 IP 再下发，但中转和出口的「连接地址」可以是域名（DDNS）。
以前每拨一次 TCP、每建一个 UDP 会话都现查一次 DNS —— 标准库不缓存，
每条连接每一跳都多一次 DNS 往返。这里按域名缓存 30 秒；过期后先接着用旧地址、
在后台刷新（DDNS 切换最多晚 30 秒被看到），解析失败时旧地址继续用到 5 分钟。
*/

const (
	fxpHopResolveTTL      = 30 * time.Second
	fxpHopResolveStaleMax = 5 * time.Minute
	fxpHopResolveTimeout  = 5 * time.Second
)

type hopResolveEntry struct {
	ips        []net.IP
	resolvedAt time.Time
	refreshing bool
	// invalidated：配置重载（面板 bump 了 DNSGeneration）之后这条结果不再算新鲜。
	// 拨 TCP 的先现查一次（查不到再退回旧地址）；UDP 读循环不能等，先接着用旧
	// 地址、同时在后台刷新 —— 以前重载直接清空缓存，重载之后每个新 UDP 会话的
	// 头一个包都要被丢掉（QUIC 这类协议因此多等一整个重传超时）。
	invalidated bool
}

var fxpHopResolver = struct {
	mu      sync.Mutex
	entries map[string]*hopResolveEntry
}{entries: map[string]*hopResolveEntry{}}

// resolveHopAddress 返回可直接拨号的 ip:port。已经是 IP 的原样返回。
func resolveHopAddress(host string, port int) (string, error) {
	return resolveHopAddressWithin(host, port, 0)
}

// resolveHopAddressWithin 和 resolveHopAddress 一样，只是现查 DNS 最多等 budget（≤ 0 表示按 fxpHopResolveTimeout）。
// 等不及时查询在后台接着跑，查到了照样进缓存，下一次就用得上。出口拨目标用它：解析算在拨目标的时限里。
func resolveHopAddressWithin(host string, port int, budget time.Duration) (string, error) {
	host = strings.TrimSpace(host)
	portText := strconv.Itoa(port)
	if host == "" || net.ParseIP(strings.Trim(host, "[]")) != nil {
		return net.JoinHostPort(strings.Trim(host, "[]"), portText), nil
	}
	ip, err := lookupHopIP(host, budget)
	if err != nil {
		return "", err
	}
	return net.JoinHostPort(ip.String(), portText), nil
}

func lookupHopIP(host string, budget time.Duration) (net.IP, error) {
	now := time.Now()
	fxpHopResolver.mu.Lock()
	entry := fxpHopResolver.entries[host]
	var stale net.IP
	if entry != nil && len(entry.ips) > 0 {
		age := now.Sub(entry.resolvedAt)
		if !entry.invalidated && age < fxpHopResolveTTL {
			ip := entry.ips[0]
			fxpHopResolver.mu.Unlock()
			return ip, nil
		}
		if !entry.invalidated && age < fxpHopResolveStaleMax {
			ip := entry.ips[0]
			if !entry.refreshing {
				entry.refreshing = true
				go refreshHopIP(host)
			}
			fxpHopResolver.mu.Unlock()
			return ip, nil
		}
		if age < fxpHopResolveStaleMax {
			stale = entry.ips[0]
		}
	}
	fxpHopResolver.mu.Unlock()
	ips, err := queryHopIPsWithin(host, budget)
	if err != nil {
		// 重载作废的结果：现查失败时旧地址照样用到 fxpHopResolveStaleMax，和到期
		// 刷新失败时一个口径。
		if stale != nil {
			// 之后的拨号不再每次现查（DNS 挂了的时候每条连接都要白等一个超时），
			// 回到「过期先用旧地址、后台刷新」的路子。
			fxpHopResolver.mu.Lock()
			if fxpHopResolver.entries[host] == entry {
				entry.invalidated = false
			}
			fxpHopResolver.mu.Unlock()
			return stale, nil
		}
		return nil, err
	}
	storeHopIPs(host, ips)
	return ips[0], nil
}

// errHopResolvePending：域名还没有可用的解析结果，已经在后台去查了。
var errHopResolvePending = errors.New("hop address resolution pending")

// resolveHopAddressNonBlocking 和 resolveHopAddress 一样，但绝不在调用方这里
// 等 DNS：缓存里有（哪怕过期不超过 fxpHopResolveStaleMax）就用，没有就在后台
// 查、先返回 errHopResolvePending。UDP 的读循环一个监听只有一个协程，在里面
// 现查一次慢 DNS（最长 fxpHopResolveTimeout）会让这个监听上所有 UDP 会话一起
// 停摆；丢掉新会话的头一两个包、等后台查完再建，代价小得多。
func resolveHopAddressNonBlocking(host string, port int) (string, error) {
	host = strings.TrimSpace(host)
	portText := strconv.Itoa(port)
	if host == "" || net.ParseIP(strings.Trim(host, "[]")) != nil {
		return net.JoinHostPort(strings.Trim(host, "[]"), portText), nil
	}
	ip, ok := lookupHopIPNonBlocking(host)
	if !ok {
		return "", fmt.Errorf("%w: %s", errHopResolvePending, host)
	}
	return net.JoinHostPort(ip.String(), portText), nil
}

func lookupHopIPNonBlocking(host string) (net.IP, bool) {
	now := time.Now()
	fxpHopResolver.mu.Lock()
	defer fxpHopResolver.mu.Unlock()
	entry := fxpHopResolver.entries[host]
	if entry != nil && len(entry.ips) > 0 {
		age := now.Sub(entry.resolvedAt)
		if !entry.invalidated && age < fxpHopResolveTTL {
			return entry.ips[0], true
		}
		if age < fxpHopResolveStaleMax {
			// 过期或被重载作废：先用旧地址，后台刷新。
			if !entry.refreshing {
				entry.refreshing = true
				go refreshHopIP(host)
			}
			return entry.ips[0], true
		}
	}
	if entry == nil {
		entry = &hopResolveEntry{}
		fxpHopResolver.entries[host] = entry
	}
	// 同一个域名同时只查一次；查失败了下一个包再触发一次。
	if !entry.refreshing {
		entry.refreshing = true
		go refreshHopIP(host)
	}
	return nil, false
}

func refreshHopIP(host string) {
	ips, err := queryHopIPs(host)
	fxpHopResolver.mu.Lock()
	defer fxpHopResolver.mu.Unlock()
	entry := fxpHopResolver.entries[host]
	if entry == nil {
		return
	}
	entry.refreshing = false
	if err == nil {
		entry.ips = ips
		entry.resolvedAt = time.Now()
		entry.invalidated = false
	}
}

func storeHopIPs(host string, ips []net.IP) {
	fxpHopResolver.mu.Lock()
	defer fxpHopResolver.mu.Unlock()
	fxpHopResolver.entries[host] = &hopResolveEntry{ips: ips, resolvedAt: time.Now()}
}

// queryHopIPsWithin：现查，最多等 budget（≤ 0 或不短于 fxpHopResolveTimeout 时就是 queryHopIPs）。等不及就先报超时，
// 查询在后台跑完，查到了存进缓存。
func queryHopIPsWithin(host string, budget time.Duration) ([]net.IP, error) {
	if budget <= 0 || budget >= fxpHopResolveTimeout {
		return queryHopIPs(host)
	}
	type result struct {
		ips []net.IP
		err error
	}
	done := make(chan result, 1)
	go func() {
		ips, err := queryHopIPs(host)
		if err == nil {
			storeHopIPs(host, ips)
		}
		done <- result{ips, err}
	}()
	timer := time.NewTimer(budget)
	defer timer.Stop()
	select {
	case r := <-done:
		return r.ips, r.err
	case <-timer.C:
		return nil, &net.DNSError{Err: fmt.Sprintf("no answer within %s", budget), Name: host, IsTimeout: true}
	}
}

// fxpHopLookupHook 只给测试用：非 nil 时代替系统解析器（后台刷新的协程可能正在读，所以是原子指针）。
var fxpHopLookupHook atomic.Pointer[func(ctx context.Context, host string) ([]net.IPAddr, error)]

func setHopLookupHook(hook func(ctx context.Context, host string) ([]net.IPAddr, error)) {
	if hook == nil {
		fxpHopLookupHook.Store(nil)
		return
	}
	fxpHopLookupHook.Store(&hook)
}

// queryHopIPs 优先 IPv4（和标准库拨号时的默认顺序一致），其次 IPv6。
func queryHopIPs(host string) ([]net.IP, error) {
	ctx, cancel := context.WithTimeout(context.Background(), fxpHopResolveTimeout)
	defer cancel()
	lookup := net.DefaultResolver.LookupIPAddr
	if hook := fxpHopLookupHook.Load(); hook != nil {
		lookup = *hook
	}
	addrs, err := lookup(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, addr := range addrs {
		if addr.IP.To4() != nil {
			ips = append(ips, addr.IP)
		}
	}
	for _, addr := range addrs {
		if addr.IP.To4() == nil {
			ips = append(ips, addr.IP)
		}
	}
	if len(ips) == 0 {
		return nil, &net.DNSError{Err: "no addresses", Name: host, IsNotFound: true}
	}
	return ips, nil
}

// invalidateHopResolverCache 在配置重载时调用：面板 bump DNSGeneration 的意思
// 就是「这些域名该重新解析了」。结果留着但标成作废（见 hopResolveEntry.invalidated）：
// TCP 拨号现查，UDP 读循环先用旧地址、后台刷新，不丢新会话的包。
func invalidateHopResolverCache() {
	fxpHopResolver.mu.Lock()
	for _, entry := range fxpHopResolver.entries {
		entry.invalidated = true
	}
	fxpHopResolver.mu.Unlock()
}

// flushHopResolverCache 整个清空缓存（测试用）。
func flushHopResolverCache() {
	fxpHopResolver.mu.Lock()
	fxpHopResolver.entries = map[string]*hopResolveEntry{}
	fxpHopResolver.mu.Unlock()
}
