//go:build !linux

package main

import "errors"

func newWireGuardKernelPlane(spec wireGuardSpec) (wireGuardDataplane, error) {
	return nil, errors.New("kernel wireguard is only available on linux")
}
