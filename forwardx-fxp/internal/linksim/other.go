//go:build !linux

package main

import "errors"

// 线路模拟要 TUN 和网络命名空间，只在 Linux 上有；sink / load / report 哪儿都能跑。
var errLinuxOnly = errors.New("up / down / bench need Linux (TUN + network namespaces)")

func cmdUp([]string) error    { return errLinuxOnly }
func cmdDown([]string) error  { return errLinuxOnly }
func cmdBench([]string) error { return errLinuxOnly }
