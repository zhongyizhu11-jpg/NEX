//go:build linux

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

func mmapShared(file *os.File, size int) ([]byte, error) {
	return unix.Mmap(int(file.Fd()), 0, size, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_SHARED)
}

func unmapShared(buf []byte) {
	if buf != nil {
		_ = unix.Munmap(buf)
	}
}

// flockTry 试着拿排他锁，拿不到立刻返回 false。锁跟着文件描述符走，进程退出自动释放。
func flockTry(file *os.File) bool {
	return unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB) == nil
}
