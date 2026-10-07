//go:build !linux

package main

import (
	"errors"
	"os"
)

func mmapShared(_ *os.File, _ int) ([]byte, error) {
	return nil, errors.New("shared egress shaper is only available on linux")
}

func unmapShared(_ []byte) {}

func flockTry(_ *os.File) bool { return false }
