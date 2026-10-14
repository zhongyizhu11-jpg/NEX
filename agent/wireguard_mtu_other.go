//go:build !linux

package main

import "context"

// probeWireGuardMTU 只在 Linux 上实现（依赖 IP_MTU_DISCOVER / IP_MTU 套接字选项），
// 其他平台原样返回面板下发的值。
func probeWireGuardMTU(ctx context.Context, endpointHost string, endpointPort int, configured int) int {
	return configured
}
